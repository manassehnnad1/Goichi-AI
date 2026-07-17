// event-detector.mjs
//
// Turns raw TxLINE score/odds stream messages into the normalized event
// shape commentary.mjs expects, and decides what counts as "significant."
//
// SCORES SIDE: built directly against TxODDS's official Scores Product API
// spec (txodds.github.io/tx-on-chain/assets/txodds-soccer-feed-v1.1.pdf),
// confirmed to match a real captured message field-for-field (Action,
// Participant, Clock, Data, StatusId all present exactly as documented).
// No more guessing on this side.
//
// ODDS SIDE: already confirmed correct against real captured data in an
// earlier pass (FixtureId, SuperOddsType, PriceNames, Prices all verified).
// The one remaining unconfirmed piece is the exact PriceNames values for
// the 1X2 market specifically (home/draw/away labels) — see the regex
// comment below.

const ODDS_SWING_THRESHOLD = 8; // percentage points of implied win probability
const MAX_ODDS_ALERTS_PER_FIXTURE = 6;
const ODDS_ALERT_MIN_GAP_MS = 12 * 60 * 1000; // spreads the 6 alerts across the match instead of letting them cluster

// Official Status Id table, from the spec.
const STATUS_NAMES = {
  1: "NS", 2: "H1", 3: "HT", 4: "H2", 5: "F", 6: "WET", 7: "ET1", 8: "HTET",
  9: "ET2", 10: "FET", 11: "WPE", 12: "PE", 13: "FPE", 14: "I", 15: "A",
  16: "C", 17: "TXCC", 18: "TXCS",
};

// Action values worth alerting on. Corners are real and documented too, but
// happen too often (dozens/match) to alert on individually — tracked as
// context, not pushed as their own alert.
export const ALERTABLE_ACTIONS = new Set(["goal", "red_card", "yellow_card"]);

// Goals/cards arrive as multiple Confirmed:true messages sharing the same
// Id — the first always lacks Data.PlayerId, a later one adds it (confirmed
// against real data from three separate sources now: live capture, the
// snapshot endpoint, and the historical endpoint — all show the identical
// pattern). Any caller working from a complete, already-fetched dataset
// (replay.mjs, historical-replay.mjs) should merge duplicates with this
// before processing, rather than relying on the live debounce mechanism
// (which needs a registered handler and real elapsed wall-clock time).
//
// Expects records shaped as { data: <raw TxLINE object>, ...anything else },
// e.g. { data: {...}, receivedAt: "..." } — the wrapper's other fields pass
// through untouched, only .data gets merged/deduped.
export function mergeAlertableDuplicates(records) {
  const byKey = new Map();
  const result = [];

  for (const record of records) {
    const d = record.data;
    const isAlertable = ALERTABLE_ACTIONS.has(d?.Action) && d?.Confirmed === true && d?.Id != null && d?.FixtureId != null;
    if (!isAlertable) {
      result.push(record);
      continue;
    }
    const key = `${d.FixtureId}:${d.Id}`;
    if (byKey.has(key)) {
      const existing = byKey.get(key).data;
      existing.Data = { ...existing.Data, ...d.Data };
      if (d.Score) existing.Score = d.Score;
      continue;
    }
    const clone = { ...record, data: { ...d, Data: { ...d.Data } } };
    byKey.set(key, clone);
    result.push(clone);
  }
  return result;
}

// Goals/cards reliably arrive as TWO separate Confirmed:true messages for
// the same Id, a few seconds apart — the first is bare, the second adds
// Data fields like PlayerId (confirmed from real captured data: ~2.8s gap
// between them). Firing immediately on the first message means firing on
// the exact one missing the player's name. 3.5s covers that gap with
// margin, while still being effectively instant for a live alert.
const ALERT_DEBOUNCE_MS = 3500;

// Registered once by the caller (bot-live.mjs, replay.mjs, mock-test.mjs)
// to receive goal/card events once the debounce window closes — these no
// longer come back through processScoreMessage's return value.
let onAlertableEvent = null;
export function setAlertableEventHandler(fn) {
  onAlertableEvent = fn;
}

const fixtureState = new Map();

function getState(fixtureId) {
  if (!fixtureState.has(fixtureId)) {
    fixtureState.set(fixtureId, {
      scoreHome: 0,
      scoreAway: 0,
      lastOdds: null,
      oddsAlertCount: 0,
      lastOddsAlertTs: null,
      recentEvents: [],
      seenActionIds: new Set(), // dedup: unconfirmed + confirmed messages share an Id
      pendingAlerts: new Map(), // Id -> { raw, timer } — goals/cards debounce briefly to catch late-arriving Data (e.g. PlayerId)
      meta: null, // { homeTeam, awayTeam, participant1IsHome }, from the fixtures snapshot
      players: null, // Map<normativeId, "Given Surname">, from player-lookup.mjs (confirmed: PlayerId matches normativeId, not fixturePlayerId)
    });
  }
  return fixtureState.get(fixtureId);
}

export function registerFixtureMeta(fixtureId, homeTeam, awayTeam, participant1IsHome = true) {
  const state = getState(fixtureId);
  state.meta = { homeTeam, awayTeam, participant1IsHome };
}

export function registerFixtureLineup(fixtureId, playerLookup) {
  const state = getState(fixtureId);
  state.players = playerLookup;
}

function pushRecent(state, text) {
  state.recentEvents.push(text);
  if (state.recentEvents.length > 3) state.recentEvents.shift();
}

function getTeamName(state, participant) {
  const { homeTeam = "Home", awayTeam = "Away", participant1IsHome = true } = state.meta ?? {};
  const participant1IsThisTeam = participant === 1;
  const isHome = participant1IsThisTeam ? participant1IsHome : !participant1IsHome;
  return isHome ? homeTeam : awayTeam;
}

// --- Scores ----------------------------------------------------------------

function extractScore(state, raw) {
  let { scoreHome, scoreAway } = state;
  if (raw.Score) {
    const p1Goals = raw.Score.Participant1?.Total?.Goals ?? scoreHome;
    const p2Goals = raw.Score.Participant2?.Total?.Goals ?? scoreAway;
    const isP1Home = state.meta?.participant1IsHome ?? true;
    scoreHome = isP1Home ? p1Goals : p2Goals;
    scoreAway = isP1Home ? p2Goals : p1Goals;
    state.scoreHome = scoreHome;
    state.scoreAway = scoreAway;
  }
  return { scoreHome, scoreAway };
}

// Builds the final normalized event from a (possibly merged) raw message.
// Shared by both the debounced live path and the immediate/pre-merged path.
function buildAlertableEvent(fixtureId, raw) {
  const state = getState(fixtureId);

  const team = getTeamName(state, raw.Participant);
  const opponent = team === state.meta?.homeTeam ? state.meta?.awayTeam : state.meta?.homeTeam;
  const period = STATUS_NAMES[raw.StatusId] ?? String(raw.StatusId ?? "?");
  const minute = null; // see the note in the module header on why this is deliberate

  const { scoreHome, scoreAway } = extractScore(state, raw);

  const playerId = raw.Data?.PlayerId;
  const player = playerId != null ? state.players?.get(playerId) ?? null : null;

  const event = {
    type: raw.Action, // "goal" | "red_card" | "yellow_card"
    minute,
    period,
    team,
    opponent,
    player,
    scoreHome,
    scoreAway,
    homeTeam: state.meta?.homeTeam ?? "Home",
    awayTeam: state.meta?.awayTeam ?? "Away",
    oddsBefore: null,
    oddsAfter: null,
    recentEvents: [...state.recentEvents],
  };
  pushRecent(state, `${raw.Action}, ${player ?? team}, ${period}`);
  return event;
}

// Returns an array of normalized events. For LIVE data (default), goals/
// cards always return empty here and fire later via the registered
// callback (see setAlertableEventHandler) after a short debounce that
// catches late-arriving Data like PlayerId. For callers that already have
// complete, deduped/merged data up front — replay.mjs, working from a fully
// loaded log rather than a live stream — pass { immediate: true } to fire
// synchronously with no artificial delay, since there's nothing to wait for.
export function processScoreMessage(raw, { immediate = false } = {}) {
  const events = [];
  const action = raw.Action;
  const fixtureId = raw.FixtureId;
  if (!fixtureId || !ALERTABLE_ACTIONS.has(action)) return events;

  const state = getState(fixtureId);

  // Goals/cards can arrive unconfirmed first (fast, but can be discarded)
  // then confirmed later with the same Id. Skip unconfirmed ones outright —
  // posting one that later gets reversed is worse than a few seconds of
  // extra latency waiting for confirmation.
  if (raw.Confirmed === false) return events;

  if (immediate) {
    // Caller guarantees this is already deduped and Data-merged — still
    // dedupe defensively against seenActionIds in case it isn't.
    if (raw.Id != null) {
      if (state.seenActionIds.has(raw.Id)) return events;
      state.seenActionIds.add(raw.Id);
    }
    events.push(buildAlertableEvent(fixtureId, raw));
    return events;
  }

  if (raw.Id == null) return events; // can't dedupe/merge without an Id — shouldn't happen in practice

  if (state.pendingAlerts.has(raw.Id)) {
    // A later confirmed message for the same Id — merge its Data/Score in
    // (this is specifically how PlayerId shows up) rather than firing again
    // or resetting the timer.
    const pending = state.pendingAlerts.get(raw.Id);
    pending.raw.Data = { ...pending.raw.Data, ...raw.Data };
    if (raw.Score) pending.raw.Score = raw.Score;
    return events;
  }

  if (state.seenActionIds.has(raw.Id)) return events; // already fired and cleaned up
  state.seenActionIds.add(raw.Id);

  const pending = { raw: { ...raw } };
  pending.timer = setTimeout(() => {
    state.pendingAlerts.delete(raw.Id);
    const event = buildAlertableEvent(fixtureId, pending.raw);
    if (onAlertableEvent) onAlertableEvent(event);
  }, ALERT_DEBOUNCE_MS);
  state.pendingAlerts.set(raw.Id, pending);

  return events;
}

// --- Odds ----------------------------------------------------------------

// GUESS: translating the on-chain Odds struct (fixture_id, market_period,
// price_names[], prices[], bookmaker, super_odds_type) to what's likely the
// PascalCase JSON shape (FixtureId, MarketPeriod, PriceNames, Prices, ...).
// Also unconfirmed: the numeric encoding of `prices` — assumed here to be a
// direct implied-probability percentage (0-100). Calibrate against a real
// message before trusting the threshold comparison.
function extractOddsFields(raw) {
  const fixtureId = raw.FixtureId ?? raw.fixture_id;
  const marketType = raw.SuperOddsType ?? raw.super_odds_type ?? raw.MarketType;
  const priceNames = raw.PriceNames ?? raw.price_names;
  const prices = raw.Prices ?? raw.prices;
  return { fixtureId, marketType, priceNames, prices };
}

export function isMatchWinnerMarket(marketType) {
  if (!marketType) return false;
  const m = String(marketType).toLowerCase();
  return m.includes("1x2") || m.includes("match") || m.includes("winner") || m.includes("moneyline");
}

export function processOddsMessage(raw) {
  const events = [];
  const { fixtureId, marketType, priceNames, prices } = extractOddsFields(raw);
  if (!fixtureId || !isMatchWinnerMarket(marketType) || !Array.isArray(priceNames) || !Array.isArray(prices)) {
    return events;
  }

  const state = getState(fixtureId);
  const homeTeam = state.meta?.homeTeam ?? "Home";
  const awayTeam = state.meta?.awayTeam ?? "Away";

  const homeIdx = priceNames.findIndex((n) => /home|1(?!x)/i.test(n));
  const drawIdx = priceNames.findIndex((n) => /draw|x/i.test(n));
  const awayIdx = priceNames.findIndex((n) => /away|2/i.test(n));
  if (homeIdx === -1 || awayIdx === -1) return events;

  const newOdds = { home: prices[homeIdx], draw: prices[drawIdx] ?? null, away: prices[awayIdx] };
  const messageTs = raw.Ts ?? Date.now();

  const underCap = state.oddsAlertCount < MAX_ODDS_ALERTS_PER_FIXTURE;
  const gapOk = state.lastOddsAlertTs === null || messageTs - state.lastOddsAlertTs >= ODDS_ALERT_MIN_GAP_MS;

  if (state.lastOdds && underCap && gapOk) {
    const delta = Math.abs(newOdds.home - state.lastOdds.home);
    if (delta >= ODDS_SWING_THRESHOLD) {
      state.oddsAlertCount++;
      state.lastOddsAlertTs = messageTs;
      events.push({
        type: "odds_swing",
        minute: null,
        period: "?",
        team: newOdds.home > state.lastOdds.home ? homeTeam : awayTeam,
        opponent: newOdds.home > state.lastOdds.home ? awayTeam : homeTeam,
        scoreHome: state.scoreHome,
        scoreAway: state.scoreAway,
        homeTeam,
        awayTeam,
        oddsBefore: state.lastOdds,
        oddsAfter: newOdds,
        recentEvents: [...state.recentEvents],
      });
      pushRecent(state, `Odds swing toward ${newOdds.home > state.lastOdds.home ? homeTeam : awayTeam}`);
    }
  }
  state.lastOdds = newOdds;

  return events;
}
