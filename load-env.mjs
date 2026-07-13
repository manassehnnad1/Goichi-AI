// load-env.mjs — tiny .env loader, no dependency needed for something this
// simple (and one less package to audit, given the care already put into
// the dependency list). Import this first in any entry-point script that
// needs environment-based secrets:
//
//   import "./load-env.mjs";
//
// Reads .env in this folder and sets process.env from it. Existing
// environment variables are never overwritten.

import fs from "fs";

const envPath = new URL("./.env", import.meta.url);

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip matching surrounding quotes, if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}
