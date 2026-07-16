import "./load-env.mjs";
// bot-live.mjs
//
// The actual basic-feature loop: TxLINE streams -> event detector ->
// Claude commentary -> Telegram channel. This is what "the bot working
// in the channel" means end to end.
//
// Prerequisites before running this for real:
//   1. node test-connection.mjs        (confirms TxLINE auth still valid)
//   2. telegram-config.json created    (bot token + channel id)
//   3. anthropic-key.txt created, OR ANTHROPIC_API_KEY set in the environment
//   4. Ideally: run stream-logger.mjs once during a live match first and
//      confirm/fix the field-name guesses in event-detector.mjs — see the
//      caveat at the top of that file. Running this without that step
//      means detection may silently miss events until calibrated.
//
// Usage: node bot-live.mjs

import fs from "fs";
import axios from "axios";
import { readSseMessages, parseSseData } from "./sse-reader.mjs";
import { registerFixtureMeta, processScoreMessage, processOddsMessage } from "./event-detector.mjs";
import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { renderEventCard } from "./graphics.mjs";
import { synthesizeVoice } from "./tts.mjs";
import { broadcast } from "./telegram-bot.mjs";

const SESSION_PATH = new URL("./.txline-session.json", import.meta.url);
if (!fs.existsSync(SESSION_PATH)) {
  console.error("Missing .txline-session.json — run `node test-connection.mjs` once first to authenticate.");
  process.exit(1);
}
const { jwt, apiToken } = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

const API_ORIGIN = "https://txline-dev.txodds.com"; // devnet for now — see README for the mainnet swap before recording
const API_BASE = `${API_ORIGIN}/api`;

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

// --- Load today's fixtures so team names resolve correctly ---------------

async function loadFixtureMeta() {
  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  const res = await httpClient.get("/api/fixtures/snapshot");
  for (const f of res.data) {
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    registerFixtureMeta(f.FixtureId, home, away, f.Participant1IsHome);
  }
  log("setup", `Loaded ${res.data.length} fixtures.`);
}

// --- Handle a detected event: generate commentary, send it ---------------

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
    console.error(`[event] Failed to handle event:`, err.message);
  }
}

// --- Stream connections ----------------------------------------------------

async function connectStream(path, onMessage, label) {
  while (true) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          "X-Api-Token": apiToken,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
      if (!res.ok) throw new Error(`Stream failed: ${res.status}`);
      log(label, "Connected.");

      for await (const message of readSseMessages(res)) {
        if (message.event === "heartbeat") continue;
        const parsed = parseSseData(message.data);
        onMessage(parsed);
      }
      log(label, "Stream ended, reconnecting in 5s...");
    } catch (err) {
      console.error(`[${label}] Stream error: ${err.message}. Reconnecting in 5s...`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  await loadFixtureMeta();

  log("setup", "Starting live loop. Ctrl+C to stop.");

  await Promise.all([
    connectStream("/scores/stream", (raw) => {
      const events = processScoreMessage(raw);
      events.forEach(handleEvent);
    }, "scores"),
    connectStream("/odds/stream", (raw) => {
      const events = processOddsMessage(raw);
      events.forEach(handleEvent);
    }, "odds"),
  ]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
