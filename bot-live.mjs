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
import { registerFixtureMeta, registerFixtureLineup, processScoreMessage, processOddsMessage, setAlertableEventHandler } from "./event-detector.mjs";
import { fetchFixtureLineups } from "./lineups.mjs";
import { recordFixtures } from "./fixture-cache.mjs";
import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { renderEventCard } from "./graphics.mjs";
import { synthesizeVoice } from "./tts.mjs";
import { broadcast, pollLoop } from "./telegram-bot.mjs";
import { startFixtureReminderLoop } from "./fixture-reminders.mjs";
import { getFreshSession } from "./txline-session.mjs";

// Set at startup by main() — a fresh JWT every time this process starts,
// rather than trusting a possibly-stale static file. See txline-session.mjs
// for why this matters for something meant to keep running, not just a
// one-off script.
let jwt, apiToken;

const API_ORIGIN = "https://txline-dev.txodds.com"; // devnet for now — see README for the mainnet swap before recording
const API_BASE = `${API_ORIGIN}/api`;

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

// --- Load today's fixtures so team names resolve correctly ---------------

const LINEUP_RELEVANT_WINDOW_MS = 3 * 60 * 60 * 1000; // fetch lineups for fixtures within +/- 3h of kickoff
const WORLD_CUP_COMPETITION_ID = 72; // confirmed from every fixture captured this project — excludes the International Friendlies also in the free-tier bundle

async function loadFixtureMeta() {
  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });
  const res = await httpClient.get("/api/fixtures/snapshot", { params: { competitionId: WORLD_CUP_COMPETITION_ID } });
  const now = Date.now();

  recordFixtures(res.data); // keeps the local cache current — fixtures/snapshot only shows upcoming matches, so this is how Replay finds ones that have since finished

  for (const f of res.data) {
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    registerFixtureMeta(f.FixtureId, home, away, f.Participant1IsHome);

    // Only bother fetching lineups for fixtures actually relevant right now —
    // matches days away won't have published rosters yet, and this is one
    // extra API call per fixture.
    if (Math.abs(f.StartTime - now) <= LINEUP_RELEVANT_WINDOW_MS) {
      fetchFixtureLineups(f.FixtureId, httpClient)
        .then((lookup) => {
          registerFixtureLineup(f.FixtureId, lookup);
          log("setup", `Loaded ${lookup.size / 2} player names for fixture ${f.FixtureId}.`); // /2: dual-keyed by fixturePlayerId + normativeId
        })
        .catch((err) => console.error(`[setup] Lineup load failed for fixture ${f.FixtureId}:`, err.message));
    }
  }
  log("setup", `Loaded ${res.data.length} fixtures.`);
}

// --- Handle a detected event: generate commentary, send it ---------------

async function handleEvent(event) {
  log("event", `${event.type} — ${event.player ?? "(no player resolved)"} — ${event.team} — ${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam}`);
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
  ({ jwt, apiToken } = await getFreshSession());
  log("setup", "Got a fresh TxLINE session.");

  // Refresh periodically, not just once at startup — this process is meant
  // to run for days/weeks, and the JWT's exact lifetime isn't documented.
  // An hourly refresh is cheap insurance against it expiring mid-run.
  setInterval(async () => {
    try {
      ({ jwt, apiToken } = await getFreshSession());
      log("setup", "Refreshed TxLINE session.");
    } catch (err) {
      console.error("[setup] Session refresh failed, keeping the old one for now:", err.message);
    }
  }, 60 * 60 * 1000);

  await loadFixtureMeta();

  log("setup", "Starting live loop. Ctrl+C to stop.");

  // Goals/cards now fire via this callback after a short debounce (catches
  // PlayerId arriving in a follow-up confirmed message) instead of through
  // processScoreMessage's return value.
  setAlertableEventHandler(handleEvent);

  // Non-blocking — does one immediate check, then keeps polling on its own
  // interval. Started here rather than awaited so it doesn't block the
  // stream connections below.
  startFixtureReminderLoop().catch((err) => console.error("[reminders] Failed to start:", err.message));

  await Promise.all([
    connectStream("/scores/stream", (raw) => {
      const events = processScoreMessage(raw);
      events.forEach(handleEvent);
    }, "scores"),
    connectStream("/odds/stream", (raw) => {
      const events = processOddsMessage(raw);
      events.forEach(handleEvent);
    }, "odds"),
    pollLoop(), // handles /start and group-add detection — same process now, not a separate terminal
  ]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
