// txline-session.mjs
//
// Shared session handling for anything that actually runs in the deployed
// process (bot-live.mjs and whatever it calls into — fixture-reminders,
// historical-replay). The guest JWT expires and needs periodic renewal;
// the docs are explicit that the API token itself does NOT need
// reactivating when that happens, just a fresh JWT paired with the same
// token. A static .txline-session.json file works fine for a script you
// run once locally, but not for something meant to stay running.
//
// Credential source, in priority order: environment variables first (how
// you'd configure this on a host like Render), falling back to the local
// .txline-session.json file (how it's worked everywhere else in this
// project so far) — so this doesn't break local dev.

import fs from "fs";

const API_ORIGIN = "https://txline-dev.txodds.com";

function loadApiToken() {
  if (process.env.TXLINE_API_TOKEN) return process.env.TXLINE_API_TOKEN;

  const sessionPath = new URL("./.txline-session.json", import.meta.url);
  if (fs.existsSync(sessionPath)) {
    return JSON.parse(fs.readFileSync(sessionPath, "utf8")).apiToken;
  }
  throw new Error(
    "No TxLINE API token found. Set TXLINE_API_TOKEN as an environment variable, " +
      "or run test-connection.mjs once locally to generate .txline-session.json."
  );
}

let cachedSession = null;

// Always fetches a fresh guest JWT rather than trusting a cached/stored one
// past its lifetime. Caches in memory for the process's life — cheap enough
// to just call this at startup and again on any 401, rather than trying to
// track the JWT's actual expiry time ourselves.
export async function getFreshSession() {
  const apiToken = loadApiToken();
  const res = await fetch(`${API_ORIGIN}/auth/guest/start`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to get a fresh guest JWT: ${res.status}`);
  const { token: jwt } = await res.json();
  cachedSession = { jwt, apiToken };
  return cachedSession;
}

export function getCachedSession() {
  return cachedSession;
}
