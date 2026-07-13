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

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) return {};
  return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
}
function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --- Sending -------------------------------------------------------------

async function sendText(chatId, text) {
  await api.post("/sendMessage", { chat_id: chatId, text });
}

// The event pipeline calls this. Fans an alert out to the public channel
// plus every registered group; voice notes only go where the tier allows.
export async function broadcast(text, { voiceBuffer = null } = {}) {
  const store = loadStore();
  const targets = [channelId, ...Object.keys(store)];

  for (const chatId of targets) {
    try {
      await sendText(chatId, text);
      const tier = store[chatId]?.tier;
      if (voiceBuffer && (chatId === channelId || tier === "pro")) {
        // sendVoice wiring goes here once TTS is hooked up (multipart upload).
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
      "👋 Thanks for adding me! You're on the free Basic tier — live text commentary on every " +
        "significant match event. Pro adds voice commentary plus pre/post-match breakdowns. " +
        "Message the channel admin to upgrade."
    );
  } else if (!isIn && store[chat.id]) {
    delete store[chat.id];
    saveStore(store);
    console.log(`[groups] Removed from "${chat.title}" (${chat.id}) — deregistered.`);
  }
  return store;
}

async function handleCommand(update) {
  const msg = update.message;
  if (!msg?.text?.startsWith("/")) return;
  const command = msg.text.split(" ")[0].split("@")[0];

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

async function pollLoop() {
  let offset = 0;
  console.log("[bot] Polling for updates (Ctrl+C to stop)...");
  while (true) {
    try {
      const res = await api.get("/getUpdates", {
        // my_chat_member is excluded by default — must be requested explicitly.
        params: { offset, timeout: 30, allowed_updates: ["message", "my_chat_member"] },
      });
      for (const update of res.data.result) {
        offset = update.update_id + 1;
        if (update.my_chat_member) await handleMyChatMember(update);
        if (update.message) await handleCommand(update);
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
