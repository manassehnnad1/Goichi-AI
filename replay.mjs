import "./load-env.mjs";
// replay.mjs
//
// Demo safety net: replays previously captured REAL match data (from
// stream-logger.mjs's JSONL logs) through the exact same detector ->
// commentary -> broadcast pipeline bot-live.mjs uses live. Nothing here is
// fabricated or reordered — it's genuine TxLINE data from a real, completed
// match. Only the PACING between messages is compressed by default, so a
// full 90+ minute match doesn't require a 90+ minute recording.
//
// Requires stream-log-scores.jsonl / stream-log-odds.jsonl to already exist
// (produced by running stream-logger.mjs during a live match).
//
// Usage:
//   node replay.mjs                 (compressed pacing, default — good for recording)
//   node replay.mjs --realtime      (original timing, full match length)
//   node replay.mjs --maxgap=5000   (custom pacing cap in ms)

import fs from "fs";
import readline from "readline";
import { registerFixtureMeta, processScoreMessage, processOddsMessage } from "./event-detector.mjs";
import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { broadcast } from "./telegram-bot.mjs";

const args = process.argv.slice(2);
const REALTIME = args.includes("--realtime");
const MAX_GAP_MS = Number(args.find((a) => a.startsWith("--maxgap="))?.split("=")[1] ?? 6000);
const MIN_GAP_MS = 1200;

// ACTION NEEDED: fill in the fixture being replayed so commentary shows real
// team names instead of falling back to "Home"/"Away". Get the fixtureId
// from a line in stream-log-scores.jsonl (it's whatever field the calibration
// step confirms — see event-detector.mjs's caveat).
// registerFixtureMeta(<fixtureId>, "Norway", "England", <participant1IsHome true/false>);

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

async function loadJsonl(url) {
  if (!fs.existsSync(url)) return [];
  const rl = readline.createInterface({ input: fs.createReadStream(url) });
  const records = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}

async function handleEvent(event) {
  log("event", `${event.type} — ${event.team} — ${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam}`);
  try {
    const text = await generateCommentary(event);
    const message = formatForDelivery(event, text);
    log("commentary", message);
    await broadcast(message);
    log("delivery", "Sent to channel.");
  } catch (err) {
    console.error("[event] Failed to handle event:", err.message);
  }
}

async function main() {
  const scoresPath = new URL("./stream-log-scores.jsonl", import.meta.url);
  const oddsPath = new URL("./stream-log-odds.jsonl", import.meta.url);
  const [scoreRecords, oddsRecords] = await Promise.all([loadJsonl(scoresPath), loadJsonl(oddsPath)]);

  if (scoreRecords.length === 0 && oddsRecords.length === 0) {
    console.error("No captured data found — run stream-logger.mjs during a live match first.");
    process.exit(1);
  }

  const timeline = [
    ...scoreRecords.map((r) => ({ ...r, kind: "score" })),
    ...oddsRecords.map((r) => ({ ...r, kind: "odds" })),
  ]
    .filter((r) => r.event !== "heartbeat")
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

  log("setup", `Loaded ${scoreRecords.length} score + ${oddsRecords.length} odds records — replaying ${timeline.length} real messages.`);
  log("setup", REALTIME ? "Mode: realtime (original pacing, full length)" : `Mode: compressed (max gap ${MAX_GAP_MS}ms)`);

  let lastTs = null;
  for (const record of timeline) {
    const ts = new Date(record.receivedAt).getTime();
    if (lastTs !== null) {
      const gap = ts - lastTs;
      const waitMs = REALTIME ? Math.max(gap, 0) : Math.min(Math.max(gap, MIN_GAP_MS), MAX_GAP_MS);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastTs = ts;

    const events = record.kind === "score" ? processScoreMessage(record.data) : processOddsMessage(record.data);
    for (const event of events) await handleEvent(event);
  }

  log("setup", "Replay complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
