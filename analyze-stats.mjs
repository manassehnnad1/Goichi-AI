// analyze-stats.mjs
//
// Empirically figures out what each numbered Stats key means by watching
// which keys change at the moment each Action fires, across the whole
// captured log. More reliable than guessing from documentation — this
// reads directly from what TxLINE actually sent.
//
// Usage: node analyze-stats.mjs

import fs from "fs";
import readline from "readline";

async function loadRecords(path) {
  const rl = readline.createInterface({ input: fs.createReadStream(path) });
  const records = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.event === "heartbeat" || !parsed.data?.Action) continue;
      records.push(parsed.data);
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}

function diffStats(prev, curr) {
  const changes = {};
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(curr ?? {})]);
  for (const key of keys) {
    const before = prev?.[key] ?? 0;
    const after = curr?.[key] ?? 0;
    if (after !== before) changes[key] = after - before;
  }
  return changes;
}

async function main() {
  const records = await loadRecords(new URL("./stream-log-scores.jsonl", import.meta.url));
  console.log(`Loaded ${records.length} action records.\n`);

  if (records.length === 0) {
    console.log("No action records found — is stream-log-scores.jsonl in this folder?");
    return;
  }

  const lastStats = new Map(); // fixtureId -> last seen Stats object
  const actionDeltas = new Map(); // Action -> array of {key: delta, ...}

  for (const record of records) {
    const fixtureId = record.FixtureId;
    const prev = lastStats.get(fixtureId);
    const curr = record.Stats;

    if (prev && curr) {
      const changes = diffStats(prev, curr);
      const positiveChanges = Object.entries(changes).filter(([, d]) => d > 0);
      if (positiveChanges.length > 0) {
        if (!actionDeltas.has(record.Action)) actionDeltas.set(record.Action, []);
        actionDeltas.get(record.Action).push(Object.fromEntries(positiveChanges));
      }
    }
    if (curr) lastStats.set(fixtureId, curr);
  }

  if (actionDeltas.size === 0) {
    console.log("No stat changes detected between consecutive messages for any action.");
    console.log("This can happen early in a match with few events — capture more and re-run.");
  } else {
    console.log("Which Stats keys incremented at the moment each Action fired:\n");
    for (const [action, deltasList] of actionDeltas) {
      console.log(`Action: "${action}" (${deltasList.length} instance(s) with a stat change)`);
      const keyCounts = {};
      for (const changes of deltasList) {
        for (const key of Object.keys(changes)) keyCounts[key] = (keyCounts[key] ?? 0) + 1;
      }
      const sorted = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
      for (const [key, count] of sorted.slice(0, 5)) {
        console.log(`  key "${key}" incremented in ${count}/${deltasList.length} instance(s)`);
      }
      console.log("");
    }
  }

  const allActions = [...new Set(records.map((r) => r.Action))];
  console.log("All Action values seen in the log:", allActions.join(", "));
}

main().catch(console.error);
