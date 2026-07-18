# Goichi AI — Technical Documentation

## Core Idea

Goichi AI is a live World Cup pundit that lives in Telegram. It watches TxLINE's
real-time match and odds data, and the moment something significant happens —
a goal, a card, a real swing in the market — it explains what happened *and*
what it means for the odds, in the voice of a real commentator (text, a
branded image, and a spoken voice note), rather than a plain score
notification.

## Highlights

**Technical**
- Full on-chain subscription flow to TxLINE on Solana devnet (guest JWT →
  on-chain `subscribe` transaction → signed activation → API token).
- Dual live SSE streams (scores + odds) processed concurrently, correlated
  in real time — an event and the market's reaction to it are reported
  together, not as separate signals.
- Player-level attribution: goal/card events are resolved against real
  fixture lineups, including disambiguating same-surname players on the
  same squad.
- A dedicated Replay feature powered by TxLINE's historical endpoint —
  works for any completed match in the last two weeks, not just a single
  captured recording.
- Every piece of this was built and corrected against real captured data,
  not assumptions about the API's documented shape (several real
  discrepancies between docs and live behavior were found and fixed during
  development).

**Business**
- Free tier (text alerts + market context) and a Pro tier (adds voice
  commentary, match replay, and group deployment) — a believable
  monetization path for a mainstream, non-technical fan.
- Distribution via a public Telegram channel plus a "bring the bot into
  your own group" flow, rather than requiring users to leave the app they
  already use during a match.

## How to Use

1. **Add the bot** — [t.me/goichiaibot](https://t.me/goichiaibot), tap Start.

   <img width="827" height="1280" alt="image" src="https://github.com/user-attachments/assets/eba5f62b-fcb8-4d36-b507-872b17d09f29" />

2. **`/start`** brings up the main menu: add Goichi to your own group, replay
   a recent match, or get help.

  <img width="2205" height="947" alt="image" src="https://github.com/user-attachments/assets/e3f72664-ec5e-46a6-8d2f-41e38a1f6420" />

   
3. **Just sit in the channel or your group chat** — no setup needed. Every significant match
   moment arrives automatically, as it happens:


   <img width="1080" height="176" alt="image" src="https://github.com/user-attachments/assets/fb4522ff-3c94-4a14-bb27-6d9940411cfa" />

   
   A goal alert — image, text commentary, and a voice note, all tied to what it did to the score and the market. 

   
   <img width="2205" height="1100" alt="image" src="https://github.com/user-attachments/assets/b3d06e25-3722-43e8-9b36-d9dd5c776085" />

   A market-move alert — fires even without a goal, when the odds themselves are the story. 

    <img width="1080" height="244" alt="image" src="https://github.com/user-attachments/assets/ea47c12a-cfed-48c6-a5a0-7b287450f4c3" />

   
   A pre-match reminder, sent ahead of kickoff so fans know what's coming up. 

## TxLINE Endpoints Used

Verified against every file in the codebase that makes a TxLINE call —
not a list from memory.

| Endpoint | Purpose |
|---|---|
| `POST /auth/guest/start` | Guest JWT for authentication |
| `subscribe(serviceLevelId, weeks)` (on-chain, Solana) | Free World Cup tier subscription |
| `POST /api/token/activate` | Exchanges the on-chain subscription + signed message for an API token |
| `GET /api/fixtures/snapshot` | Upcoming fixtures (filtered to World Cup, `competitionId=72`) — team names, kickoff times |
| `GET /api/scores/stream` (SSE) | Live match events — goals, cards, and other in-play actions |
| `GET /api/odds/stream` (SSE) | Live odds across all markets — filtered to the 1X2 market for win-probability commentary |
| `GET /api/scores/snapshot/{fixtureId}` | Fixture lineups (player names/IDs) and match-finalisation data |
| `GET /api/scores/historical/{fixtureId}` (SSE) | Complete score history for a finished match — powers the Replay feature |

## Pipeline

TxLINE (live/historical data) → event detection & odds correlation → Claude
(commentary generation) → OpenAI TTS (voice) + custom graphics → Telegram
(text, image, voice note).
