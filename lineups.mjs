// lineups mjs
//
// Fetches fixture lineups and builds a PlayerId -> name lookup. Hedges on
// the one thing we couldn't confirm from real data: whether goal/card
// events' PlayerId refers to the fixture-scoped fixturePlayerId or the
// player's global normativeId. Keys the lookup by BOTH, so whichever it
// turns out to be, resolution works.
//


function formatPlayerName(preferredName) {
  if (!preferredName) return null;
  // Strip disambiguating suffixes like "(1999)" — e.g. two Reece Jameses
  // in football; commentary doesn't need the birth-year tiebreaker.
  const cleaned = preferredName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const commaIdx = cleaned.indexOf(",");
  if (commaIdx === -1) return cleaned;
  const surname = cleaned.slice(0, commaIdx).trim();
  const rest = cleaned.slice(commaIdx + 1).trim();
  return `${rest} ${surname}`.trim();
}

function extractPlayerLookup(record) {
  const lookup = new Map();

  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      if (Array.isArray(node.lineups)) {
        for (const entry of node.lineups) {
          const name = formatPlayerName(entry.player?.preferredName);
          if (!name) continue;
          if (entry.fixturePlayerId != null) lookup.set(entry.fixturePlayerId, name);
          if (entry.player?.normativeId != null) lookup.set(entry.player.normativeId, name);
        }
      }
      for (const value of Object.values(node)) walk(value);
    }
  }

  walk(record);
  return lookup;
}

// httpClient must already carry the Authorization/X-Api-Token headers
// (same axios instance pattern used elsewhere, e.g. bot-live.mjs).
export async function fetchFixtureLineups(fixtureId, httpClient) {
  const res = await httpClient.get(`/api/scores/snapshot/${fixtureId}`);
  const records = Array.isArray(res.data) ? res.data : [];

  const lineupRecord = records.find((r) => String(r.Action ?? "").toLowerCase().includes("lineup"));
  if (!lineupRecord) return new Map(); // no lineup data available for this fixture — resolution just falls back gracefully

  return extractPlayerLookup(lineupRecord);
}

export { formatPlayerName, extractPlayerLookup };
