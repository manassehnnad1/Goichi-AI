import "./load-env.mjs";
// check-finalised.mjs
//
// Diagnostic only — pulls /api/scores/snapshot for a fixture and dumps the
// game_finalised record, since it's confirmed present there (via the Action
// histogram from check-lineups.mjs) but wasn't captured in the local
// stream log (session likely ended before full-time).
//
// Usage: node check-finalised.mjs [fixtureId]
//   Defaults to fixture 18241006 if no fixtureId is passed.

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

  const record = records.find((r) => r.Action === "game_finalised");
  if (!record) {
    console.log("No game_finalised record found in this snapshot. Try a different fixtureId, or the match may not be finalised yet.");
    return;
  }

  console.log("\nFull game_finalised record:");
  console.log(JSON.stringify(record, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err.response?.data ?? err.message);
  process.exit(1);
});
