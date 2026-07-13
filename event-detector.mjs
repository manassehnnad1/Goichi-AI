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

// Official Status Id table, from the spec.
const STATUS_NAMES = {
  1: "NS", 2: "H1", 3: "HT", 4: "H2", 5: "F", 6: "WET", 7: "ET1", 8: "HTET",
  9: "ET2", 10: "FET", 11: "WPE", 12: "PE", 13: "FPE", 14: "I", 15: "A",
  16: "C", 17: "TXCC", 18: "TXCS",
};

// Action values worth alerting on. Corners are real and documented too, but
// happen too often (dozens/match) to alert on individually — tracked as
// context, not pushed as their own alert.
const ALERTABLE_ACTIONS = new Set(["goal", "red_card", "yellow_card"]);

const fixtureState = new Map();

function getState(fixtureId) {
  if (!fixtureState.has(fixtureId)) {
    fixtureState.set(fixtureId, {
      scoreHome: 0,
      scoreAway: 0,
      lastOdds: null,
      recentEvents: [],
      seenActionIds: new Set(), // dedup: unconfirmed + confirmed messages share an Id
      meta: null, // { homeTeam, awayTeam, participant1IsHome }, from the fixtures snapshot
    });
  }
  return fixtureState.get(fixtureId);
}

export function registerFixtureMeta(fixtureId, homeTeam, awayTeam, participant1IsHome = true) {
  const state = getState(fixtureId);
  state.meta = { homeTeam, awayTeam, participant1IsHome };
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

// Returns an array of normalized events (usually 0 or 1) for this raw message.
export function processScoreMessage(raw) {
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

  // Safety-net dedup in case a confirmed message somehow arrives twice.
  if (raw.Id != null) {
    if (state.seenActionIds.has(raw.Id)) return events;
    state.seenActionIds.add(raw.Id);
  }

  const team = getTeamName(state, raw.Participant);
  const opponent = team === state.meta?.homeTeam ? state.meta?.awayTeam : state.meta?.homeTeam;
  const period = STATUS_NAMES[raw.StatusId] ?? String(raw.StatusId ?? "?");

  // Deliberately NOT computing an exact minute from Clock.Seconds. The spec
  // describes it as counting down from the period's full duration (2700s
  // for a 45-min half), but the one real captured value we've seen (2937,
  // during H2) doesn't cleanly fit that model. Rather than risk stating a
  // confidently wrong minute in a public channel, this falls back to period
  // phrasing only ("early in the second half") until enough real Clock
  // values have been checked against known real match minutes to confirm
  // the actual semantics.
  const minute = null;

  // Score comes pre-computed on relevant actions — Participant1/2 mapped to
  // home/away via participant1IsHome, no diffing needed on our end.
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

  events.push({
    type: action, // "goal" | "red_card" | "yellow_card"
    minute,
    period,
    team,
    opponent,
    scoreHome,
    scoreAway,
    homeTeam: state.meta?.homeTeam ?? "Home",
    awayTeam: state.meta?.awayTeam ?? "Away",
    oddsBefore: null,
    oddsAfter: null,
    recentEvents: [...state.recentEvents],
  });
  pushRecent(state, `${action}, ${team}, ${period}`);

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

function isMatchWinnerMarket(marketType) {
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

  if (state.lastOdds) {
    const delta = Math.abs(newOdds.home - state.lastOdds.home);
    if (delta >= ODDS_SWING_THRESHOLD) {
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
