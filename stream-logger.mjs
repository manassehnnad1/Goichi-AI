// stream-logger.mjs
//
// Run this DURING TONIGHT'S MATCH (Norway v England, 22:00 WAT) to capture
// real score/odds messages. This is the calibration step — compare a real
// logged message against the field-name GUESSes in event-detector.mjs and
// fix any mismatches before trusting it for live detection.
//
// Requires the same telegram-config-style credential pattern: reads
// txline-session.json (written by test-connection.mjs's successful run —
// it already saves jwt/apiToken/txSig there). If that file's stale, rerun
// test-connection.mjs once first to refresh it.
//
// Usage: node stream-logger.mjs

import fs from "fs";
import { readSseMessages, parseSseData } from "./sse-reader.mjs";

const SESSION_PATH = new URL("./.txline-session.json", import.meta.url);
if (!fs.existsSync(SESSION_PATH)) {
  console.error("Missing .txline-session.json — run `node test-connection.mjs` once first to authenticate.");
  process.exit(1);
}
const { jwt, apiToken } = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

const API_BASE = "https://txline-dev.txodds.com/api"; // devnet, per current phase — swap for mainnet later

const scoresLog = fs.createWriteStream(new URL("./stream-log-scores.jsonl", import.meta.url), { flags: "a" });
const oddsLog = fs.createWriteStream(new URL("./stream-log-odds.jsonl", import.meta.url), { flags: "a" });

async function streamTo(path, logStream, label) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`[${label}] Stream failed: ${res.status}`);

  console.log(`[${label}] Connected, logging to disk...`);
  for await (const message of readSseMessages(res)) {
    const parsed = parseSseData(message.data);
    const line = JSON.stringify({ receivedAt: new Date().toISOString(), event: message.event ?? null, data: parsed });
    logStream.write(line + "\n");

    if (message.event === "heartbeat") {
      process.stdout.write(".");
    } else {
      console.log(`\n[${label}] ${JSON.stringify(parsed).slice(0, 300)}`);
    }
  }
}

console.log("Logging both streams. Ctrl+C to stop. '.' = heartbeat, full lines = real data.\n");
await Promise.all([
  streamTo("/scores/stream", scoresLog, "scores").catch((e) => console.error("[scores] stopped:", e.message)),
  streamTo("/odds/stream", oddsLog, "odds").catch((e) => console.error("[odds] stopped:", e.message)),
]);
