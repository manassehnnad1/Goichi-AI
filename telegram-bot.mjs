// telegram-bot.mjs
//
// The "add to groups" layer: detects when the bot gets added to (or removed
// from) a Telegram group, tracks it in a local store, and exposes a
// broadcast() function the event pipeline calls to fan alerts out to the
// public channel plus every registered group.
//
// Uses long-polling (getUpdates), not a webhook — no public server needed,
// which is the right call for a hackathon timeline. A webhook is a fine
// upgrade later, but adds a deployment/SSL dependency this doesn't need yet.
//
// Run standalone to test: node telegram-bot.mjs
// Requires telegram-config.json (see telegram-config.example.json).

import fs from "fs";
import axios from "axios";

const CONFIG_PATH = new URL("./telegram-config.json", import.meta.url);
const STORE_PATH = new URL("./subscribed-destinations.json", import.meta.url);

if (!fs.existsSync(CONFIG_PATH)) {
  console.error("Missing telegram-config.json — copy telegram-config.example.json and fill in botToken + channelId.");
  process.exit(1);
}
const { botToken, channelId } = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const api = axios.create({ baseURL: `https://api.telegram.org/bot${botToken}`, timeout: 40000 });

// Used to build the "Add to Group" URL button — Telegram's own deep-link
// scheme (?startgroup=) opens the native "choose a group" picker, no
// callback handling needed on our end for that one.
const BOT_USERNAME = "goichiaibot";

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}
function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --- Sending -------------------------------------------------------------

const TELEGRAM_API = `https://api.telegram.org/bot${botToken}`;

async function sendText(chatId, text, extra = {}) {
  await api.post("/sendMessage", { chat_id: chatId, text, ...extra });
}

// Native fetch + FormData for multipart uploads — no new dependency needed
// for something this simple (same reasoning as the .env loader).
function detectImageType(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { ext: "jpg", mime: "image/jpeg" };
  return { ext: "png", mime: "image/png" };
}

async function sendPhoto(chatId, imageBuffer, caption) {
  const { ext, mime } = detectImageType(imageBuffer);
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption);
  form.append("photo", new Blob([imageBuffer], { type: mime }), `event.${ext}`);

  const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`sendPhoto failed: ${res.status} ${await res.text()}`);
}

// Telegram only renders the compact voice-message bubble (waveform, inline
// play button) for OGG/Opus specifically — other formats get delivered as
// a plain audio file attachment instead. audioBuffer must already be
// OGG/Opus by the time it reaches this function (see tts.mjs).
async function sendVoice(chatId, audioBuffer) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("voice", new Blob([audioBuffer], { type: "audio/ogg" }), "commentary.ogg");

  const res = await fetch(`${TELEGRAM_API}/sendVoice`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`sendVoice failed: ${res.status} ${await res.text()}`);
}

// Acknowledges a button tap. Required — without this, the button shows a
// loading spinner that never resolves. show_alert=true pops a native modal
// (good for a short "coming soon" notice); false just clears the spinner
// silently (used when we're sending a real message instead, e.g. Help).
async function answerCallbackQuery(callbackQueryId, { text = "", showAlert = false } = {}) {
  await api.post("/answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

// The event pipeline calls this. Fans an alert out to the public channel
// plus every registered group; image cards go everywhere, voice notes only
// where the tier allows (channel always counts as the "full" experience).
export async function broadcast(text, { imageBuffer = null, voiceBuffer = null } = {}) {
  const store = loadStore();
  const targets = [channelId, ...Object.keys(store)];

  for (const chatId of targets) {
    try {
      if (imageBuffer) {
        await sendPhoto(chatId, imageBuffer, text);
      } else {
        await sendText(chatId, text);
      }

      const tier = store[chatId]?.tier;
      if (voiceBuffer && (chatId === channelId || tier === "pro")) {
        await sendVoice(chatId, voiceBuffer);
      }
    } catch (err) {
      console.error(`[broadcast] Failed to send to ${chatId}:`, err.response?.data?.description || err.message);
    }
  }
}

// --- Handling incoming updates --------------------------------------------

export async function handleMyChatMember(update, store = loadStore()) {
  const { chat, old_chat_member, new_chat_member } = update.my_chat_member;
  if (chat.type !== "group" && chat.type !== "supergroup") return store; // the public channel is set up manually, not through this path

  const wasOut = ["left", "kicked"].includes(old_chat_member.status);
  const isIn = ["member", "administrator"].includes(new_chat_member.status);

  if (wasOut && isIn) {
    store[chat.id] = { title: chat.title, tier: "basic", addedAt: new Date().toISOString() };
    saveStore(store);
    console.log(`[groups] Added to "${chat.title}" (${chat.id}) — registered as basic tier.`);
    await sendText(
  chat.id,
  "Super excited to be here! 😊\n\nI'm Goichi and you're on the Free tier — live text commentary on every significant match event.\n\nPro adds voice commentary plus pre/post-match breakdowns.\n\nUse /Upgrade to go Pro."
);
  } else if (!isIn && store[chat.id]) {
    delete store[chat.id];
    saveStore(store);
    console.log(`[groups] Removed from "${chat.title}" (${chat.id}) — deregistered.`);
  }
  return store;
}

// Row 1: full-width Add to Group (URL button — opens Telegram's native
// "choose a group" picker, no callback handling needed).
// Row 2: Replay + Subscribe, side by side (both placeholders for now).
// Row 3: Help, full width.
const START_KEYBOARD = {
  inline_keyboard: [
    [{ text: "➕ Add me to your Group", url: `https://t.me/${BOT_USERNAME}?startgroup=true` }],
    [
      { text: "🔁 Replay", callback_data: "replay" },
      { text: "🔔 Subscribe", callback_data: "subscribe" },
    ],
    [{ text: "❓ Help", callback_data: "help" }],
  ],
};

const HELP_TEXT =
  "Here's what these do:\n\n" +
  "➕ Add me to your Group — brings me into your own Telegram group, so everyone there gets the same live commentary, no need to also follow the channel.\n\n" +
  "🔁 Replay — a recap of the last big match, delivered like it's happening live. Not live yet — coming soon.\n\n" +
  "🔔 Subscribe — filter alerts to just the teams you care about, instead of every match. Not live yet — coming soon.";

async function handleCallbackQuery(update) {
  const query = update.callback_query;
  const chatId = query.message?.chat?.id;

  if (query.data === "replay" || query.data === "subscribe") {
    await answerCallbackQuery(query.id, { text: "🚧 Coming soon!", showAlert: true });
    return;
  }

  if (query.data === "help") {
    await answerCallbackQuery(query.id); // silent ack — the real response is the message below
    if (chatId) await sendText(chatId, HELP_TEXT);
    return;
  }

  // Unknown callback_data — still ack it so the button doesn't hang.
  await answerCallbackQuery(query.id);
}

async function handleCommand(update) {
  const msg = update.message;
  if (!msg?.text?.startsWith("/")) return;
  const command = msg.text.split(" ")[0].split("@")[0];

  if (command === "/start") {
    await sendText(
      msg.chat.id,
      "👋 Hey, I'm Goichi, your World Cup pundit. \n\nI let you know when something significant happens " +
        `in a match: goals, red cards, big swings in the odds, so you don't miss it nor watch alone. 😉 \n\nJoin the channel here: ${channelId}\n\n` +
        "or Add me to your own group to get the same alerts there. \n\nUse /help for more info.",
      { reply_markup: START_KEYBOARD }
    );
  }

  if (command === "/help") {
    await sendText(msg.chat.id, HELP_TEXT);
  }

  if (command === "/upgrade") {
    // Demo-only stand-in for real payment/token-gating — flips this chat to pro.
    const store = loadStore();
    if (store[msg.chat.id]) {
      store[msg.chat.id].tier = "pro";
      saveStore(store);
      await sendText(msg.chat.id, "🔓 This group is now on Pro — voice commentary and match breakdowns incoming.");
    }
  }
}

// --- Polling loop ----------------------------------------------------------

export async function pollLoop() {
  let offset = 0;
  console.log("[bot] Polling for updates (Ctrl+C to stop)...");
  while (true) {
    try {
      const res = await api.get("/getUpdates", {
        // my_chat_member and callback_query are excluded by default — must
        // be requested explicitly.
        params: { offset, timeout: 30, allowed_updates: ["message", "my_chat_member", "callback_query"] },
      });
      for (const update of res.data.result) {
        offset = update.update_id + 1;
        if (update.my_chat_member) await handleMyChatMember(update);
        if (update.message) await handleCommand(update);
        if (update.callback_query) await handleCallbackQuery(update);
      }
    } catch (err) {
      console.error("[bot] Poll error:", err.response?.data?.description || err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pollLoop();
}
