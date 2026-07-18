// historical-replay.mjs
//
// Powers the Telegram Replay button: given a fixtureId, pulls that match's
// complete score history from TxLINE directly (not local logs — works for
// any recently-finished match, not just ones we happened to be logging),
// and replays its goals/cards to one specific chat (the requesting user's
// DM), reusing the same detection/commentary/graphics/TTS pipeline as
// everything else.
//


import fs from "fs";
import axios from "axios";
import { parseSseBlock, parseSseData } from "./sse-reader.mjs";
import {
  registerFixtureMeta,
  registerFixtureLineup,
  processScoreMessage,
  mergeAlertableDuplicates,
  ALERTABLE_ACTIONS,
} from "./event-detector.mjs";
import { fetchFixtureLineups } from "./lineups.mjs";
import { generateCommentary, formatForDelivery } from "./commentary.mjs";
import { renderEventCard } from "./graphics.mjs";
import { synthesizeVoice } from "./tts.mjs";
// sendToChat is passed in by the caller (dependency injection) rather than
// imported directly — telegram-bot.mjs needs to call INTO this module, so
// importing sendToChat FROM telegram-bot.mjs here would create a circular
// import between the two files. ES modules can sometimes tolerate that, but
// it's fragile (exports can resolve as undefined depending on evaluation
// order) and not worth risking here.

const API_ORIGIN = "https://txline-dev.txodds.com"; // devnet — per the decision to stay here
const MAX_GAP_MS = 6000;
const MIN_GAP_MS = 1200;

function loadSession() {
  const sessionPath = new URL("./.txline-session.json", import.meta.url);
  if (!fs.existsSync(sessionPath)) {
    throw new Error("Missing .txline-session.json — run test-connection.mjs once first.");
  }
  return JSON.parse(fs.readFileSync(sessionPath, "utf8"));
}

import { getCachedFixtures } from "./fixture-cache.mjs";

const WORLD_CUP_COMPETITION_ID = 72; // confirmed from every fixture captured this project — the free tier bundle also includes International Friendlies, which this excludes

// fixtures/snapshot only returns UPCOMING fixtures (confirmed empirically —
// see fixture-cache.mjs), so there's no live endpoint to list past matches
// from. This reads our local cache instead: plausibly finished (kicked off
// more than ~2.5h ago) and within the historical endpoint's supported
// window (started within the last 2 weeks).
export async function listReplayableFixtures() {
  const now = Date.now();
  const FINISHED_BUFFER_MS = 2.5 * 60 * 60 * 1000;
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

  return getCachedFixtures()
    .filter((f) => f.competitionId === WORLD_CUP_COMPETITION_ID)
    .filter((f) => {
      const age = now - f.startTime;
      return age > FINISHED_BUFFER_MS && age < TWO_WEEKS_MS;
    })
    .sort((a, b) => b.startTime - a.startTime); // most recent first
}

async function fetchHistoricalRecords(fixtureId, httpClient) {
  const res = await httpClient.get(`/api/scores/historical/${fixtureId}`, { responseType: "text" });
  const blocks = res.data.split(/\r?\n\r?\n/);
  return blocks
    .map((block) => parseSseBlock(block))
    .filter(Boolean)
    .map((msg) => parseSseData(msg.data))
    .filter((d) => d && typeof d === "object");
}

export async function runHistoricalReplay(fixtureId, targetChatId, sendToChat, { onStatus = () => {} } = {}) {
  const { jwt, apiToken } = loadSession();
  const httpClient = axios.create({
    baseURL: API_ORIGIN,
    timeout: 60000,
    headers: { Authorization: `Bearer ${jwt}`, "X-Api-Token": apiToken },
  });

  onStatus("Pulling up the match data...");

  const cached = getCachedFixtures().find((f) => f.fixtureId === Number(fixtureId));
  if (!cached) throw new Error(`Fixture ${fixtureId} not found in the local fixture cache.`);

  const historicalRecords = await fetchHistoricalRecords(fixtureId, httpClient);

  registerFixtureMeta(cached.fixtureId, cached.home, cached.away, cached.participant1IsHome);
  const { home, away } = cached;

  try {
    const lookup = await fetchFixtureLineups(cached.fixtureId, httpClient);
    registerFixtureLineup(cached.fixtureId, lookup);
  } catch (err) {
    console.error("[historical-replay] Lineup load failed, continuing without player names:", err.message);
  }

  // Wrap as { data: ... } to match mergeAlertableDuplicates' expected shape
  // (the same shape replay.mjs's log-derived records use).
  const wrapped = historicalRecords.map((d) => ({ data: d }));
  const merged = mergeAlertableDuplicates(wrapped);

  const timeline = merged
    .filter((r) => ALERTABLE_ACTIONS.has(r.data?.Action) && r.data?.Confirmed === true)
    .sort((a, b) => a.data.Ts - b.data.Ts);

  if (timeline.length === 0) {
    await sendToChat(targetChatId, `No goals or cards found for ${home} vs ${away} — nothing to replay.`);
    return;
  }

  onStatus(`Found ${timeline.length} moments. Starting replay of ${home} vs ${away}...`);
  await sendToChat(targetChatId, `🔁 Replaying ${home} vs ${away}...`);

  let lastTs = null;
  for (const record of timeline) {
    const ts = record.data.Ts;
    if (lastTs !== null) {
      const waitMs = Math.min(Math.max(ts - lastTs, MIN_GAP_MS), MAX_GAP_MS);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    lastTs = ts;

    const events = processScoreMessage(record.data, { immediate: true });
    for (const event of events) {
      try {
        const text = await generateCommentary(event);
        const message = formatForDelivery(event, text);
        const imageBuffer = renderEventCard(event);
        let voiceBuffer = null;
        try {
          voiceBuffer = await synthesizeVoice(text);
        } catch (err) {
          console.error("[historical-replay] TTS failed, sending without voice:", err.message);
        }
        await sendToChat(targetChatId, message, { imageBuffer, voiceBuffer });
      } catch (err) {
        console.error("[historical-replay] Failed to send an event:", err.message);
      }
    }
  }

  await sendToChat(targetChatId, "🏁 Replay complete.");
}
