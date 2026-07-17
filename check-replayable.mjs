import "./load-env.mjs";
// check-replayable.mjs
//
// Diagnostic — listReplayableFixtures() came back empty, and there are a
// few plausible reasons (finished matches might drop out of
// fixtures/snapshot entirely, GameState might not behave as documented,
// the timing window might be wrong). Dumping every fixture's raw
// GameState/StartTime/computed-age rather than guessing which one it is.

import fs from "fs";
import axios from "axios";

const SESSION_PATH = new URL("./.txline-session.json", import.meta.url);
if (!fs.existsSync(SESSION_PATH)) {
  console.error("Missing .txline-session.json — run `node test-connection.mjs` once first.");
  process.exit(1);
}
const { jwt, apiToken } = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));

const API_ORIGIN = "https://txline-dev.txodds.com";

async function main() {
  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    timeout: 30000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  const res = await httpClient.get("/api/fixtures/snapshot");
  const now = Date.now();

  console.log(`Total fixtures returned: ${res.data.length}\n`);

  for (const f of res.data) {
    const ageHours = ((now - f.StartTime) / (60 * 60 * 1000)).toFixed(1);
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    console.log(
      `[${f.FixtureId}] ${home} vs ${away} — GameState: ${JSON.stringify(f.GameState)} (${typeof f.GameState}) — ` +
        `StartTime: ${new Date(f.StartTime).toISOString()} — age: ${ageHours}h`
    );
  }

  // Specifically check whether our known fixture (18241006) is in there at all.
  const known = res.data.find((f) => f.FixtureId === 18241006);
  console.log("\nFixture 18241006 present in this snapshot?", !!known);
  if (known) console.log(JSON.stringify(known, null, 2));
}

main().catch((err) => {
  console.error("Fatal error:", err.response?.data ?? err.message);
  process.exit(1);
});
