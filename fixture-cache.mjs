// fixture-cache.mjs
//


import fs from "fs";

const CACHE_PATH = new URL("./known-fixtures.json", import.meta.url);

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return {};
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function recordFixtures(fixtures) {
  const cache = loadCache();
  for (const f of fixtures) {
    cache[f.FixtureId] = {
      fixtureId: f.FixtureId,
      home: f.Participant1IsHome ? f.Participant1 : f.Participant2,
      away: f.Participant1IsHome ? f.Participant2 : f.Participant1,
      participant1IsHome: f.Participant1IsHome,
      startTime: f.StartTime,
      competitionId: f.CompetitionId,
    };
  }
  saveCache(cache);
}

export function getCachedFixtures() {
  return Object.values(loadCache());
}
