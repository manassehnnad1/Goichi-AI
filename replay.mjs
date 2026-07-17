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
//   node replay.mjs                    (compressed pacing, full match, default)
//   node replay.mjs --realtime         (original timing, full match length)
//   node replay.mjs --maxgap=5000      (custom pacing cap in ms, full-match modes)
//   node replay.mjs --highlights       (goals/cards only, no odds, fixed gap between moments)
//   node replay.mjs --highlights --gap=6000   (custom gap between highlight moments, ms)

import fs from "fs";
import readline from "readline";
import axios from "axios";
import { registerFixtureMeta, registerFixtureLineup, processScoreMessage, processOddsMessage, isMatchWinnerMarket } from "./event-detector.mjs";
import { fetchFixtureLineups } from "./lineups.mjs";
import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { renderEventCard } from "./graphics.mjs";
import { synthesizeVoice } from "./tts.mjs";
import { broadcast } from "./telegram-bot.mjs";

const args = process.argv.slice(2);
const REALTIME = args.includes("--realtime");
const MAX_GAP_MS = Number(args.find((a) => a.startsWith("--maxgap="))?.split("=")[1] ?? 6000);
const MIN_GAP_MS = 1200;
const HIGHLIGHTS = args.includes("--highlights") || args.includes("--manual");
const HIGHLIGHTS_ACTIONS = new Set(["goal", "red_card", "yellow_card"]);
const FIXED_GAP_ARG = args.find((a) => a.startsWith("--gap="));
const FIXED_GAP_MS = FIXED_GAP_ARG ? Number(FIXED_GAP_ARG.split("=")[1]) : null;
const MANUAL = args.includes("--manual");

// Confirmed fixture details (fixture 18241006, England v Argentina —
// Participant1Id 1888 = England = home, Participant2Id 1489 = Argentina).
const REPLAY_FIXTURE_ID = 18241006;
registerFixtureMeta(REPLAY_FIXTURE_ID, "England", "Argentina", true);

// Lineups aren't in the captured logs (confirmed — no "lineups" action ever
// showed up in stream-log-scores.jsonl), so this is the one piece of the
// replay that still needs a live call, using the same session credentials
// as everything else. Everything else replays purely from local log data.
async function loadReplayLineups() {
  const sessionPath = new URL("./.txline-session.json", import.meta.url);
  if (!fs.existsSync(sessionPath)) {
    console.error("No .txline-session.json — skipping lineup load, player names won't resolve. Run test-connection.mjs first if you want them.");
    return;
  }
  const { jwt, apiToken } = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  const httpClient = axios.create({
    baseURL: "https://txline-dev.txodds.com",
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  try {
    const lookup = await fetchFixtureLineups(REPLAY_FIXTURE_ID, httpClient);
    registerFixtureLineup(REPLAY_FIXTURE_ID, lookup);
    console.log(`Loaded ${lookup.size / 2} player names for the replay.`);
  } catch (err) {
    console.error("Lineup load failed, continuing without player names:", err.message);
  }
}

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
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
    const imageBuffer = renderEventCard(event);
    let voiceBuffer = null;
    try {
      voiceBuffer = await synthesizeVoice(text);
    } catch (err) {
      console.error("TTS failed, sending without voice:", err.message);
    }
    await broadcast(message, { imageBuffer, voiceBuffer });
    log("delivery", "Sent to channel.");
  } catch (err) {
    console.error("[event] Failed to handle event:", err.message);
  }
}

async function main() {
  await loadReplayLineups();

  const scoresPath = new URL("./stream-log-scores.jsonl", import.meta.url);
  const oddsPath = new URL("./stream-log-odds.jsonl", import.meta.url);
  const [scoreRecords, rawOddsRecords] = await Promise.all([loadJsonl(scoresPath), loadJsonl(oddsPath)]);

  // Pre-filter to the 1X2 market only — every other market type (Asian
  // handicap, over/under, all their different lines) never produces an
  // alert anyway (isMatchWinnerMarket already excludes them at detection
  // time), so they were always just dead weight in the timeline, consuming
  // a wait-slot for nothing. This is the actual fix for "ran an hour, only
  // 6 odds fired" — that wasn't a bug, it was this exact volume problem.
  const oddsRecords = rawOddsRecords.filter((r) => isMatchWinnerMarket(r.data?.SuperOddsType));
  const droppedCount = rawOddsRecords.length - oddsRecords.length;

  if (scoreRecords.length === 0 && oddsRecords.length === 0) {
    console.error("No captured data found — run stream-logger.mjs during a live match first.");
    process.exit(1);
  }

  if (droppedCount > 0) {
    log("setup", `Dropped ${droppedCount} non-1X2 odds records (Asian handicap, over/under, etc.) — never produced alerts anyway.`);
  }

  let timeline = [
    ...scoreRecords.map((r) => ({ ...r, kind: "score" })),
    ...oddsRecords.map((r) => ({ ...r, kind: "odds" })),
  ]
    .filter((r) => r.event !== "heartbeat" && r.data?.FixtureId === REPLAY_FIXTURE_ID)
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));

  if (HIGHLIGHTS) {
    const seenIds = new Set();
    timeline = timeline.filter((r) => {
      if (r.kind !== "score") return false; // odds excluded entirely in highlights mode
      const d = r.data;
      if (!HIGHLIGHTS_ACTIONS.has(d?.Action) || d?.Confirmed !== true) return false;
      // Goals/cards commonly arrive as two separate Confirmed:true messages
      // for the same Id (one bare, one with extra Data like PlayerId) — keep
      // only the first so we don't waste a gap on a message that fires
      // nothing (the detector dedupes by Id and would skip the second anyway).
      if (seenIds.has(d.Id)) return false;
      seenIds.add(d.Id);
      return true;
    });
  }

  log("setup", `Loaded ${scoreRecords.length} score + ${oddsRecords.length} odds records — replaying ${timeline.length} real messages.`);
  log(
    "setup",
    MANUAL
      ? "Mode: manual (goals/cards only — press Enter to send each, 'q' to quit)"
      : HIGHLIGHTS
        ? FIXED_GAP_MS
          ? `Mode: highlights only (goals/cards, fixed ${FIXED_GAP_MS}ms between moments)`
          : `Mode: highlights only (goals/cards, real relative pacing, max gap ${MAX_GAP_MS}ms)`
        : REALTIME
          ? "Mode: realtime (original pacing, full length)"
          : `Mode: compressed (max gap ${MAX_GAP_MS}ms)`
  );

  let lastTs = null;
  for (const record of timeline) {
    if (!MANUAL) {
      // Waits per RECORD, unconditionally — including ones that produce zero
      // events — so pacing in full/realtime modes still reflects real
      // message spacing, not just the rare moments that fire an alert.
      const ts = new Date(record.receivedAt).getTime();
      if (lastTs !== null) {
        const waitMs =
          HIGHLIGHTS && FIXED_GAP_MS
            ? FIXED_GAP_MS // explicit flat-gap override
            : REALTIME
              ? Math.max(ts - lastTs, 0)
              : Math.min(Math.max(ts - lastTs, MIN_GAP_MS), MAX_GAP_MS); // compressed real pacing — used for both default mode and highlights-without-override
        await new Promise((r) => setTimeout(r, waitMs));
      }
      lastTs = ts;
    }

    const events = record.kind === "score" ? processScoreMessage(record.data) : processOddsMessage(record.data);

    for (const event of events) {
      if (MANUAL) {
        const preview = event.player
          ? `${event.type.toUpperCase()} — ${event.player} (${event.team}) — ${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam}`
          : `${event.type.toUpperCase()} — ${event.team} — ${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam}`;
        const answer = await waitForEnter(`\nNext: ${preview}\nPress Enter to send, or 'q' to quit: `);
        if (answer === "q") {
          log("setup", "Stopped by user.");
          return;
        }
      }

      await handleEvent(event);
    }
  }

  log("setup", "Replay complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
