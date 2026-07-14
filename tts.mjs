// tts.mjs
//
// TTS via OpenAI's gpt-4o-mini-tts, using the `instructions` parameter to
// steer delivery toward live-commentator energy rather than relying on a
// fixed voice preset. Plain fetch, no SDK — one less dependency to audit
// for something this simple (same reasoning as load-env.mjs).
//
// Requests `response_format: "opus"` directly, which OpenAI documents as
// intended for internet streaming/communication — the same Ogg/Opus
// container Telegram's sendVoice needs for the compact voice-message
// bubble, no local audio conversion required.

const VOICE = "onyx"; // deep, authoritative — reads well as a commentator base
const INSTRUCTIONS =
  "Deliver this like a live sports commentator reacting to a dramatic, " +
  "high-stakes moment in a match — energetic, urgent, natural pacing, " +
  "with emphasis on the key moment. Not robotic, not overly formal.";

export async function synthesizeVoice(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in .env (see .env.example)."
    );
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: VOICE,
      input: text,
      instructions: INSTRUCTIONS,
      response_format: "opus",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI TTS error ${res.status}: ${errBody}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
