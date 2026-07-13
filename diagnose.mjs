// diagnose.mjs — run this and paste the full output back.
// It doesn't touch the network or Solana at all — just checks what's
// actually installed and being loaded for @solana/spl-token.

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("Node version:", process.version);
console.log("Platform:", process.platform, process.arch);
console.log("Running from:", __dirname);

let resolvedPath;
try {
  resolvedPath = require.resolve("@solana/spl-token");
  console.log("\n@solana/spl-token resolved to file:\n ", resolvedPath);
} catch (e) {
  console.log("\nCould NOT resolve @solana/spl-token at all:", e.message);
  process.exit(1);
}

// Walk up from the resolved file to find spl-token's own package.json
let dir = path.dirname(resolvedPath);
let found = false;
for (let i = 0; i < 6; i++) {
  const candidate = path.join(dir, "package.json");
  if (fs.existsSync(candidate)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (pkg.name === "@solana/spl-token") {
        console.log("\nInstalled version:", pkg.version, "(expected: 0.4.15)");
        found = true;
        break;
      }
    } catch {}
  }
  dir = path.dirname(dir);
}
if (!found) console.log("\nCould not find @solana/spl-token's own package.json by walking up from the resolved file.");

const splToken = require("@solana/spl-token");
const needed = ["TOKEN_2022_PROGRAM_ID", "ASSOCIATED_TOKEN_PROGRAM_ID", "getAssociatedTokenAddressSync"];
console.log("\nExport check:");
for (const name of needed) {
  const val = splToken[name];
  const status = typeof val === "function" ? "function — OK" : val !== undefined ? `present (${typeof val})` : "MISSING";
  console.log(` ${name}: ${status}`);
}

const keys = Object.keys(splToken);
console.log("\nTotal exported keys on the module:", keys.length);
console.log("First 20 keys:", keys.slice(0, 20));
