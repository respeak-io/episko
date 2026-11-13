// Copies the agent-protocol extensions Episko ships from an episko-integrations checkout
// into src-tauri/integrations/, which protocol.rs compiles in. One file per manifest entry
// with a `protocol` block, and the commit they came from, so a diff names its source.
//   node scripts/vendor-integrations.mjs [path/to/episko-integrations]   (default: ../episko-integrations)

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const from = resolve(process.argv[2] ?? "../episko-integrations");
const git = (...args) => execFileSync("git", ["-C", from, ...args], { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) {
  console.error(`${from} has uncommitted changes; vendor a commit, not a working tree`);
  process.exit(1);
}
const sha = git("rev-parse", "HEAD");
const manifest = JSON.parse(readFileSync(new URL("../src/providers/manifest.json", import.meta.url), "utf8"));
const ids = Object.keys(manifest).filter((id) => manifest[id].protocol);
for (const id of ids) {
  copyFileSync(resolve(from, id, "episko.ts"), new URL(`../src-tauri/integrations/${id}.ts`, import.meta.url));
  console.log(`src-tauri/integrations/${id}.ts <- ${id}/episko.ts`);
}
writeFileSync(new URL("../src-tauri/integrations/SOURCE", import.meta.url), `respeak-io/episko-integrations@${sha}\n`);
console.log(`from ${sha}`);
