<img width="483" height="483" alt="image" src="https://github.com/user-attachments/assets/532d555f-612e-4aad-ae5d-25db6f88a8e1" />


_AI World Cup Pundit in your pocket_

_powered by TxODDS_




---








# Goichi AI — World Cup Pundit

A live World Cup pundit bot for Telegram. Goichi watches TxLINE's real-time
match and odds data, and the moment something significant happens — a goal,
a card, a real swing in the market — it explains what happened *and* what it
means for the odds, as text, a branded image, and a spoken voice note.

See [`DOCUMENTATION.md`](./DOCUMENTATION.md) for the full technical writeup
(TxLINE endpoints used, architecture, business highlights).

## Setup

1. **Install dependencies**
   ```bash
   npm ci --ignore-scripts
   ```

2. **Telegram bot** — message `@BotFather`, `/newbot`, get a token. Create a
   public Telegram channel, add the bot as admin with "Post Messages"
   permission. Copy `telegram-config.example.json` to `telegram-config.json`
   and fill in your bot token + channel username.

3. **API keys** — copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — powers the commentary generation (Claude)
   - `OPENAI_API_KEY` — powers the voice notes (TTS)

4. **TxLINE connection** — run once to authenticate and confirm the pipe
   works:
   ```bash
   node test-connection.mjs
   ```
   This creates a devnet-only Solana wallet (`devnet-keypair.json`),
   airdrops itself devnet SOL, subscribes to TxLINE's free World Cup tier
   on-chain, and confirms both the scores and odds streams are live.

## Running the bot

```bash
node bot-live.mjs
```

This is the whole product in one process: live scores + odds streams,
event detection, Claude commentary, images, TTS, and Telegram delivery
(channel + any groups the bot's been added to), plus the pre-match reminder
loop and the `/start` button menu (including Replay) — all running together,
not as separate scripts.

## Other scripts

| Script | Purpose |
|---|---|
| `replay.mjs` | Replays a previously captured real match through the live pipeline (`--highlights`, `--manual`, `--realtime` modes) — used to produce the demo recording |
| `stream-logger.mjs` | Captures raw TxLINE stream data to disk during a live match, for `replay.mjs` to use later |
| `fixture-reminders.mjs` | Standalone pre-match reminder loop (`--test` for an immediate one-off test) — already included in `bot-live.mjs`, useful to run in isolation |


## Deployment
 
Deployable as a Render **Background Worker** (not a Web Service — this
doesn't listen on a port):
 
- Build command: `npm ci --ignore-scripts`
- Start command: `npm start` (runs `bot-live.mjs`)
- Environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TXLINE_API_TOKEN` — pull the
  real values from your local `.env`/`telegram-config.json`/
  `.txline-session.json` after completing local setup once.
The TxLINE session (`txline-session.mjs`) fetches a fresh JWT on startup and
hourly thereafter automatically — no manual refresh needed once deployed.
 
One limitation worth knowing: Render's default filesystem is ephemeral, so
`known-fixtures.json` (Replay's fixture cache) resets to whatever's committed
on every redeploy, rather than accumulating new matches indefinitely.


## Network

This runs entirely on **Solana devnet**. 
The free World Cup tier works identically on devnet and
mainnet; devnet just means no real funds are needed for the on-chain
subscription. There's no plan to move this to mainnet for this project.

## Devnet config used throughout

- Program ID: `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`
- TxL mint: `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`
- API base: `https://txline-dev.txodds.com/api/`
