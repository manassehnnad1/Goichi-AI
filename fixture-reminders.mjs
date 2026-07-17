import "./load-env.mjs";
// fixture-reminders.mjs
//
// Polls /api/fixtures/snapshot and sends Telegram reminders before kickoff,
// two tiers: "today" (a casual same-day heads-up, hours out) and "soon"
// (kickoff under an hour away). Each fixture gets each tier at most once.
//
// "Today" is computed in Africa/Lagos time, not UTC or the server's local
// time — matters near midnight, and this is who the channel is for.
//
// Usage:
//   node fixture-reminders.mjs              — real loop, checks every 15 min
//   node fixture-reminders.mjs --test        — sends one "today"-tier reminder
//                                              right now, for the soonest
//                                              scheduled fixture
//   node fixture-reminders.mjs --test=soon   — same, but the "soon"-tier message

import fs from "fs";
import axios from "axios";
import { generatePreMatchHype } from "./commentary.mjs";
import { broadcast } from "./telegram-bot.mjs";
import { recordFixtures } from "./fixture-cache.mjs";

const SESSION_PATH = new URL("./.txline-session.json", import.meta.url);
const REMINDED_PATH = new URL("./reminded-fixtures.json", import.meta.url);

const REMINDER_WINDOW_MS = 60 * 60 * 1000; // "soon" tier: kickoff within 1 hour
const POLL_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes
const API_ORIGIN = "https://txline-dev.txodds.com"; // devnet — per the decision to stay here
const TIMEZONE = "Africa/Lagos";
const WORLD_CUP_COMPETITION_ID = 72; // confirmed from every fixture captured this project — excludes the International Friendlies also in the free-tier bundle

const testArg = process.argv.find((a) => a.startsWith("--test"));
const TEST_MODE = !!testArg;
const TEST_TIER = testArg === "--test=soon" ? "soon" : "today";

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

function localDateString(timestampMs) {
  return new Date(timestampMs).toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}
function isToday(timestampMs) {
  return localDateString(timestampMs) === localDateString(Date.now());
}
function localTimeString(timestampMs) {
  return new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
}

function loadReminded() {
  if (!fs.existsSync(REMINDED_PATH)) return {};
  return JSON.parse(fs.readFileSync(REMINDED_PATH, "utf8"));
}
function saveReminded(obj) {
  fs.writeFileSync(REMINDED_PATH, JSON.stringify(obj, null, 2));
}

async function sendReminder(fixture, tier) {
  const home = fixture.Participant1IsHome ? fixture.Participant1 : fixture.Participant2;
  const away = fixture.Participant1IsHome ? fixture.Participant2 : fixture.Participant1;
  const kickoffTime = localTimeString(fixture.StartTime);

  log("reminder", `[${tier}] ${home} vs ${away} at ${kickoffTime} WAT (fixture ${fixture.FixtureId})`);
  try {
    const message = await generatePreMatchHype(home, away, kickoffTime, tier);
    log("commentary", message);
    await broadcast(message);
    log("delivery", "Sent to channel.");
  } catch (err) {
    console.error("Failed to send reminder:", err.message);
  }
}

async function checkFixtures() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error("Missing .txline-session.json — run `node test-connection.mjs` once first.");
    return;
  }
  const { jwt, apiToken } = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    timeout: 30000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  const res = await httpClient.get("/api/fixtures/snapshot", { params: { competitionId: WORLD_CUP_COMPETITION_ID } });
  const fixtures = res.data;
  const now = Date.now();

  recordFixtures(fixtures); // keeps the local cache current for Replay — see fixture-cache.mjs

  log("check", `Scanning ${fixtures.length} fixtures (test mode: ${TEST_MODE ? TEST_TIER : "off"}).`);

  if (TEST_MODE) {
    const upcoming = fixtures
      .filter((f) => f.GameState === 1 && f.StartTime > now)
      .sort((a, b) => a.StartTime - b.StartTime)[0];

    if (!upcoming) {
      log("check", "No upcoming scheduled fixtures found to test with.");
      return;
    }
    await sendReminder(upcoming, TEST_TIER);
    return;
  }

  const reminded = loadReminded();
  for (const fixture of fixtures) {
    if (fixture.GameState !== 1) continue;
    const msUntilKickoff = fixture.StartTime - now;
    if (msUntilKickoff <= 0) continue; // already kicked off

    const record = reminded[fixture.FixtureId] ?? { today: false, soon: false };
    let changed = false;

    if (!record.today && isToday(fixture.StartTime)) {
      await sendReminder(fixture, "today");
      record.today = true;
      changed = true;
    }

    if (!record.soon && msUntilKickoff <= REMINDER_WINDOW_MS) {
      await sendReminder(fixture, "soon");
      record.soon = true;
      changed = true;
    }

    if (changed) {
      reminded[fixture.FixtureId] = record;
      saveReminded(reminded);
    }
  }
}

// Callable from another process (bot-live.mjs) to start the real, ongoing
// reminder loop — no CLI flags, no --test behavior, just the real thing.
export async function startFixtureReminderLoop() {
  log("setup", "Starting fixture reminder loop.");
  await checkFixtures();
  setInterval(checkFixtures, POLL_INTERVAL_MS);
}

async function main() {
  log("setup", TEST_MODE ? `Running once in test mode (${TEST_TIER} tier).` : "Starting fixture reminder loop. Ctrl+C to stop.");
  await checkFixtures();
  if (!TEST_MODE) setInterval(checkFixtures, POLL_INTERVAL_MS);
}

// Only auto-runs when this file is executed directly (node fixture-reminders.mjs),
// not when imported by bot-live.mjs — otherwise importing it would immediately
// inspect bot-live.mjs's own argv and fire main() unintentionally.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
