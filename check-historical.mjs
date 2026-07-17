import "./load-env.mjs";
// check-historical.mjs
//
// Diagnostic only — confirms the real field casing on /api/scores/historical
// before building anything on top of it. The docs' own example uses
// lowercase (update.seq, update.ts, update.gameState), inconsistent with
// every other endpoint we've confirmed (all PascalCase) — worth checking
// for real rather than assuming either way.
//
// Usage: node check-historical.mjs [fixtureId]
//   Defaults to fixture 18241006 if no fixtureId is passed.

import fs from "fs";
import axios from "axios";
import { parseSseBlock, parseSseData } from "./sse-reader.mjs";

const SESSION_PATH = new URL("./.txline-session.json", import.meta.url);
if (!fs.existsSync(SESSION_PATH)) {
  console.error("Missing .txline-session.json — run `node test-connection.mjs` once first.");
  process.exit(1);
}
const { jwt, apiToken } = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

const API_ORIGIN = "https://txline-dev.txodds.com";
const fixtureId = process.argv[2] ?? "18241006";

async function main() {
  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    timeout: 60000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  console.log(`Fetching /api/scores/historical/${fixtureId}...`);
  const res = await httpClient.get(`/api/scores/historical/${fixtureId}`, { responseType: "text" });
  console.log("Content-Type:", res.headers["content-type"], "— confirmed SSE format, not a JSON array.");

  // Same shape as the live stream, just delivered as one complete string
  // instead of chunk-by-chunk — split on the blank-line block separator and
  // reuse the exact same block parser the live streams already use.
  const blocks = res.data.split(/\r?\n\r?\n/);
  const records = blocks
    .map((block) => parseSseBlock(block))
    .filter(Boolean)
    .map((msg) => parseSseData(msg.data))
    .filter((d) => d && typeof d === "object");

  console.log(`\nParsed ${records.length} real records out of ${blocks.length} raw blocks.`);
  console.log("Keys on the first record:", Object.keys(records[0] ?? {}));
  console.log("\nFull first record:");
  console.log(JSON.stringify(records[0], null, 2));

  const actionCounts = {};
  for (const r of records) actionCounts[r.Action ?? "(none)"] = (actionCounts[r.Action ?? "(none)"] ?? 0) + 1;
  console.log("\nAction type counts:", JSON.stringify(actionCounts, null, 2));

  const goalRecord = records.find((r) => r.Action === "goal" && r.Data?.PlayerId != null);
  if (goalRecord) {
    console.log("\nA goal record WITH PlayerId (confirms the same Data/PlayerId shape holds here):");
    console.log(JSON.stringify(goalRecord, null, 2));
  } else {
    console.log("\nNo goal record with PlayerId found — checking any goal record instead:");
    console.log(JSON.stringify(records.find((r) => r.Action === "goal"), null, 2));
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.response?.data ?? err.message);
  process.exit(1);
});
