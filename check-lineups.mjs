import "./load-env.mjs";
// check-lineups.mjs
//
// Diagnostic only — pulls /api/scores/snapshot for a fixture and dumps any
// record whose Action looks lineup-related, so we can see the REAL field
// shape before building PlayerId -> name resolution around it. Per the
// Discord tip: lineups come from /api/scores/snapshot filtered to
// action=lineups — unconfirmed until we actually see one.
//
// Usage: node check-lineups.mjs [fixtureId]
//   Defaults to fixture 18241006 (the most recent one we have real data for)
//   if no fixtureId is passed.

import fs from "fs";
import axios from "axios";

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
    timeout: 30000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  console.log(`Fetching /api/scores/snapshot/${fixtureId}...`);
  const res = await httpClient.get(`/api/scores/snapshot/${fixtureId}`);
  const records = res.data;
  console.log(`Retrieved ${records.length} score records.\n`);

  const actionCounts = {};
  for (const r of records) {
    const a = r.Action ?? "(none)";
    actionCounts[a] = (actionCounts[a] ?? 0) + 1;
  }
  console.log("All Action types seen in this snapshot:", JSON.stringify(actionCounts, null, 2));

  const lineupRecords = records.filter((r) => String(r.Action ?? "").toLowerCase().includes("lineup"));
  console.log(`\nRecords matching "lineup": ${lineupRecords.length}`);

  if (lineupRecords.length > 0) {
    console.log("\nFull first lineup record (this is the shape we need):");
    console.log(JSON.stringify(lineupRecords[0], null, 2));
  } else {
    console.log("\nNo lineup-labeled record found in this snapshot. Worth trying a different/more recent fixtureId,");
    console.log("or checking whether lineups only appear in the live stream near kickoff rather than in the snapshot.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.response?.data ?? err.message);
  process.exit(1);
});
