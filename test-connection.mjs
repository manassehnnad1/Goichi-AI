// test-connection.mjs
//
// End-to-end smoke test for the TxLINE World Cup free tier:
//   1. Creates/reuses a devnet-only Solana wallet and airdrops devnet SOL
//   2. Calls the TxLINE `subscribe` instruction (free tier, service level 1)
//   3. Gets a guest JWT and activates an API token
//   4. Fetches the current fixtures snapshot and flags anything that looks live
//   5. Opens the live scores SSE stream for ~20s and logs whatever comes through
//
// Run: npm install && node test-connection.mjs

import fs from "fs";
import { createRequire } from "module";
import axios from "axios";
import nacl from "tweetnacl";

// @coral-xyz/anchor, @solana/web3.js, and @solana/spl-token are all
// CommonJS packages with no "exports" map. `import { X } from ...` and even
// `import * as ns from ...` both rely on Node statically *guessing* their
// named exports (via cjs-module-lexer) — a guess that has already proven
// unreliable across Node versions/OSes for this exact dependency set (it's
// what broke on the last run). require(), even called from an ESM file via
// createRequire, uses Node's original CommonJS loader instead: it runs the
// module for real and hands back its actual module.exports object, so there's
// no guessing involved and nothing to be wrong about.
const require = createRequire(import.meta.url);
const anchor = require("@coral-xyz/anchor");
const solanaWeb3 = require("@solana/web3.js");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram } = solanaWeb3;
const splToken = require("@solana/spl-token");
const { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = splToken;

// ---------------------------------------------------------------------------
// Config — devnet + free tier. Swap these for the real build (see README).
// ---------------------------------------------------------------------------
const RPC_URL = "https://api.devnet.solana.com";
const API_ORIGIN = "https://txline-dev.txodds.com";
const API_BASE = `${API_ORIGIN}/api`;
const PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

const SERVICE_LEVEL_ID = 1; // World Cup + Int'l Friendlies, free, 60s delay
const DURATION_WEEKS = 4;
const SELECTED_LEAGUES = []; // empty = standard bundle

const KEYPAIR_PATH = new URL("./devnet-keypair.json", import.meta.url);
const IDL_PATH = new URL("./idl/txoracle-devnet.json", import.meta.url);

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function main() {
  // 1. Wallet -----------------------------------------------------------
  let keypair;
  if (fs.existsSync(KEYPAIR_PATH)) {
    const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8"));
    keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
    log("wallet", `Loaded existing devnet wallet: ${keypair.publicKey.toBase58()}`);
  } else {
    keypair = Keypair.generate();
    fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(keypair.secretKey)));
    log("wallet", `Generated new devnet wallet: ${keypair.publicKey.toBase58()}`);
  }

  const connection = new Connection(RPC_URL, "confirmed");
  const balance = await connection.getBalance(keypair.publicKey);
  log("wallet", `Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.05 * LAMPORTS_PER_SOL) {
    log("wallet", "Requesting devnet SOL airdrop...");
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      log("wallet", "Airdrop confirmed.");
    } catch (err) {
      console.error(`\nAirdrop failed (devnet faucet is often rate-limited): ${err.message}`);
      console.error(`Fund manually at https://faucet.solana.com -> ${keypair.publicKey.toBase58()}`);
      process.exit(1);
    }
  }

  // 2. Anchor program -----------------------------------------------------
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const program = new anchor.Program(idl, provider);

  if (!program.programId.equals(PROGRAM_ID)) {
    throw new Error(`IDL program ${program.programId.toBase58()} does not match expected ${PROGRAM_ID.toBase58()}`);
  }

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    TXL_MINT, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    TXL_MINT, keypair.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // The subscribe instruction expects userTokenAccount to already exist —
  // it does NOT create it for you (confirmed by an AccountNotInitialized
  // error on a live run). Idempotent = safe to include even if it's already
  // been created by a prior run; it's just a no-op in that case.
  const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    keypair.publicKey,   // payer
    userTokenAccount,    // the ATA address being created
    keypair.publicKey,   // owner
    TXL_MINT,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // 3. Subscribe on-chain (free tier) -------------------------------------
  log("subscribe", `Subscribing to service level ${SERVICE_LEVEL_ID} for ${DURATION_WEEKS} weeks...`);
  let txSig;
  try {
    txSig = await program.methods
      .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
      .accounts({
        user: keypair.publicKey,
        pricingMatrix: pricingMatrixPda,
        tokenMint: TXL_MINT,
        userTokenAccount,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .preInstructions([createUserAtaIx])
      .rpc();
    log("subscribe", `Subscribed. Tx: ${txSig}`);
    log("subscribe", `Explorer: https://explorer.solana.com/tx/${txSig}?cluster=devnet`);
  } catch (err) {
    console.error(`\nSubscribe failed: ${err.message}`);
    if (String(err.message).includes("ActiveSubscription") || String(err.message).includes("6016")) {
      console.error(
        "This wallet already has an active subscription. That's fine for future runs — " +
        "delete devnet-keypair.json to test from scratch, or adapt this script to skip " +
        "straight to activation if you've saved a prior txSig."
      );
    }
    process.exit(1);
  }

  // 4. Guest JWT + API token activation -----------------------------------
  log("auth", "Requesting guest JWT...");
  const authResponse = await axios.post(`${API_ORIGIN}/auth/guest/start`);
  const jwt = authResponse.data.token;
  log("auth", "Guest JWT acquired.");

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, keypair.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  log("auth", "Activating API token...");
  const activationResponse = await axios.post(
    `${API_BASE}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );
  const apiToken = activationResponse.data.token || activationResponse.data;
  log("auth", "API token activated. You're authenticated against TxLINE.");

  fs.writeFileSync(
    new URL("./.txline-session.json", import.meta.url),
    JSON.stringify({ jwt, apiToken, txSig, savedAt: new Date().toISOString() }, null, 2)
  );

  // 5. Fixtures snapshot ----------------------------------------------------
  const httpClient = axios.create({
    timeout: 30000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "X-Api-Token": apiToken,
    },
    baseURL: API_ORIGIN,
  });

  log("data", "Fetching current fixtures snapshot...");
  const fixturesRes = await httpClient.get("/api/fixtures/snapshot");
  const fixtures = fixturesRes.data;
  log("data", `Retrieved ${fixtures.length} fixtures.`);

  const now = Date.now();
  const recentlyStarted = fixtures.filter((f) => {
    const start = new Date(f.StartTime).getTime();
    return start <= now && start > now - 3 * 60 * 60 * 1000; // rough "might be live" window
  });
  console.log(`${recentlyStarted.length} fixture(s) started in the last 3 hours (likely live or just finished):`);
  recentlyStarted.slice(0, 5).forEach((f) => {
    const home = f.Participant1IsHome ? f.Participant1 : f.Participant2;
    const away = f.Participant1IsHome ? f.Participant2 : f.Participant1;
    console.log(`  - [${f.FixtureId}] ${home} vs ${away} (kickoff ${f.StartTime})`);
  });

  // 6. Live scores stream, ~20s window --------------------------------------
  log("stream", "Opening live scores stream for 20 seconds...");
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 20000);
  let eventCount = 0;

  try {
    const streamResponse = await fetch(`${API_BASE}/scores/stream`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        "X-Api-Token": apiToken,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
      signal: controller.signal,
    });

    if (!streamResponse.ok) {
      throw new Error(`Stream request failed: ${streamResponse.status}`);
    }

    console.log("Stream connected. Listening...");
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (const block of blocks) {
        if (!block.trim()) continue;
        eventCount++;
        console.log(`  event ${eventCount}: ${block.slice(0, 300)}`);
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(`Stream error: ${err.message}`);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  console.log(`\nReceived ${eventCount} score event(s) in the listening window.`);
  if (eventCount === 0) {
    console.log(
      "Zero events isn't a failure by itself — score events only fire when something happens " +
      "in a live match. Try the odds stream instead (moves far more often), or re-run this " +
      "during your recording window / an active match."
    );
  }

  console.log("\nDone. If you got this far with no thrown errors, the TxLINE pipe is live and ready to build on.");
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
