// commentary.mjs — the "brain." Takes a normalized match event and returns
// short pundit-voice commentary via Claude. Doesn't know or care about
// TxLINE's wire format — that's event-detector.mjs's job. This only deals
// with the clean event shape defined below, so it's fully testable without
// a live match or even TxLINE credentials, just an Anthropic API key.
//
// Normalized event shape (produced by event-detector.mjs):
// {
//   type: "goal" | "red_card" | "yellow_card" | "odds_swing",
//   minute: number,               // match minute, e.g. 78
//   period: "H1" | "H2" | "ET1" | "ET2" | "PE",
//   team: string,                 // team the event happened for/to
//   opponent: string,
//   scoreHome: number, scoreAway: number,
//   homeTeam: string, awayTeam: string,
//   oddsBefore: { home: number, draw: number, away: number } | null,
//   oddsAfter:  { home: number, draw: number, away: number } | null,
//   recentEvents: string[],       // short descriptions of the last 1-2 events, for continuity
// }

import fs from "fs";

const API_KEY_PATH = new URL("./anthropic-key.txt", import.meta.url);

function loadApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  if (fs.existsSync(API_KEY_PATH)) return fs.readFileSync(API_KEY_PATH, "utf8").trim();
  throw new Error(
    "No Anthropic API key found. Set ANTHROPIC_API_KEY as an environment variable, " +
      "or put the key alone in anthropic-key.txt (git-ignored, same treatment as the other credential files)."
  );
}

const SYSTEM_PROMPT = `You are Goichi, a live World Cup pundit on Telegram.

Style:
- Casual, reactive, a little dramatic — like a good co-commentator, not a formal broadcaster.
- 1-2 sentences. This is a push notification, not a match report.
- Always connect the event to what it means for the match odds, not just what happened on the pitch.
- No hashtags, no emoji in the text itself (the delivery layer adds one emoji prefix separately).
- Never invent a quote and attribute it to a real player — narrate the event, don't put words in anyone's mouth.
- Don't sign off or self-reference by name ("Goichi says...") — the channel branding already carries that. Occasional first-person flavor ("didn't see that coming") is fine.
- Vary your openings. Don't start every message the same way.`;

const PERIOD_PHRASES = {
  NS: "before kickoff", H1: "the first half", HT: "half-time", H2: "the second half",
  F: "full-time", WET: "the break before extra time", ET1: "the first half of extra time",
  HTET: "half-time in extra time", ET2: "the second half of extra time",
  FET: "full-time after extra time", WPE: "the break before penalties",
  PE: "the penalty shootout", FPE: "after the penalty shootout",
};

function buildUserPrompt(event) {
  const periodPhrase = PERIOD_PHRASES[event.period] ?? event.period;
  const scoreLine =
    typeof event.minute === "number"
      ? `${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam}, ${event.minute}' — ${periodPhrase}`
      : `${event.homeTeam} ${event.scoreHome}-${event.scoreAway} ${event.awayTeam} — ${periodPhrase}`;

  const oddsLine =
    event.oddsBefore && event.oddsAfter
      ? `Win probability shift — ${event.homeTeam}: ${event.oddsBefore.home}% → ${event.oddsAfter.home}%, ` +
        `Draw: ${event.oddsBefore.draw}% → ${event.oddsAfter.draw}%, ` +
        `${event.awayTeam}: ${event.oddsBefore.away}% → ${event.oddsAfter.away}%`
      : "Odds movement not available for this event.";

  const contextLine = event.recentEvents?.length
    ? `Recent match context: ${event.recentEvents.join("; ")}`
    : "";

  const eventLabel = { goal: "GOAL", red_card: "RED CARD", yellow_card: "YELLOW CARD", odds_swing: "MARKET MOVE" }[event.type] ?? event.type.toUpperCase();

  return [
    `Event: ${eventLabel}, scored/awarded to ${event.team} (opponent: ${event.opponent}).`,
    `Score: ${scoreLine}`,
    oddsLine,
    contextLine,
    "",
    "Write the pundit alert for this moment.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateCommentary(event) {
  const apiKey = loadApiKey();

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(event) }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in Claude response: " + JSON.stringify(data));
  return textBlock.text.trim();
}

// Prefixes the model's text with an emoji appropriate to the event type —
// kept out of the prompt so it's exact/consistent rather than model-chosen.
export function formatForDelivery(event, commentaryText) {
  const prefix = { goal: "⚽", red_card: "🟥", yellow_card: "🟨", odds_swing: "📊" }[event.type] ?? "🎙️";
  return `${prefix} ${commentaryText}`;
}
