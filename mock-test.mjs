import "./load-env.mjs";
// mock-test.mjs
//
// Proves the commentary + delivery half of the pipeline works, right now,
// with zero dependency on any live match or captured TxLINE data. Bypasses
// event-detector.mjs entirely by constructing normalized events directly —
// this only exercises commentary.mjs (Claude) and telegram-bot.mjs
// (channel delivery), which don't depend on TxLINE's unconfirmed field
// names at all.
//
// This does NOT test event-detector.mjs's TxLINE field-mapping — that
// genuinely needs real captured data (stream-logger.mjs + replay.mjs, or a
// live match) to calibrate. This just proves everything downstream of
// detection is solid.
//
// Usage: node mock-test.mjs

import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { broadcast } from "./telegram-bot.mjs";

const mockEvents = [
  {
    type: "goal", minute: 23, period: "H1", team: "Argentina", opponent: "Switzerland",
    scoreHome: 1, scoreAway: 0, homeTeam: "Argentina", awayTeam: "Switzerland",
    oddsBefore: { home: 58, draw: 24, away: 18 },
    oddsAfter: { home: 71, draw: 18, away: 11 },
    recentEvents: [],
  },
  {
    type: "yellow_card", minute: 41, period: "H1", team: "Switzerland", opponent: "Argentina",
    scoreHome: 1, scoreAway: 0, homeTeam: "Argentina", awayTeam: "Switzerland",
    oddsBefore: null, oddsAfter: null,
    recentEvents: ["Goal, Argentina, 23'"],
  },
  {
    type: "odds_swing", minute: 76, period: "H2", team: "Switzerland", opponent: "Argentina",
    scoreHome: 1, scoreAway: 1, homeTeam: "Argentina", awayTeam: "Switzerland",
    oddsBefore: { home: 55, draw: 22, away: 23 },
    oddsAfter: { home: 40, draw: 24, away: 36 },
    recentEvents: ["Goal, Argentina, 23'", "Yellow card, Switzerland, 41'"],
  },
  {
    type: "red_card", minute: 84, period: "H2", team: "Switzerland", opponent: "Argentina",
    scoreHome: 1, scoreAway: 1, homeTeam: "Argentina", awayTeam: "Switzerland",
    oddsBefore: null, oddsAfter: null,
    recentEvents: ["Odds swing toward Switzerland"],
  },
];

function log(label, msg) {
  console.log(`[${new Date().toISOString()}] [${label}] ${msg}`);
}

async function main() {
  log("setup", `Running ${mockEvents.length} synthetic events through Claude + Telegram (no TxLINE involved).`);

  for (const event of mockEvents) {
    log("event", `${event.type} — ${event.team}`);
    try {
      const text = await generateCommentary(event);
      const message = formatForDelivery(event, text);
      log("commentary", message);
      await broadcast(message);
      log("delivery", "Sent to channel.");
    } catch (err) {
      console.error("Failed on this event:", err.message);
      // Keep going so one failure doesn't hide results for the rest.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  log("setup", "Done. Check your channel — you should see 4 messages covering goal/card/odds-swing/card.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
