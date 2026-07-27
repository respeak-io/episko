#!/usr/bin/env node
// Stamp a version into the marketing site's baked-in version labels.
//
// site/index.html fetches the real version from the GitHub releases API at runtime
// and rewrites every [data-ver] span. The markup's own value is the fallback — what
// you see with JS off, or when the unauthenticated API is rate-limited (60 req/h per
// IP). It is therefore load-bearing but easy to forget, which is what this exists for.
//
//   node scripts/stamp-site-version.mjs           # version from package.json
//   node scripts/stamp-site-version.mjs v0.12.0   # explicit (a release tag)
//
// Exits non-zero if it matched nothing, so a markup change can't silently turn the
// stamp into a no-op and let the site drift back to a stale version.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sitePath = join(root, "site", "index.html");

const raw = process.argv[2] || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const version = String(raw).trim().replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`stamp-site-version: "${raw}" is not a version (expected 1.2.3 or v1.2.3)`);
  process.exit(1);
}

// Matches <span data-ver>v0.11.0</span> and <span class="fver" data-ver>…</span> alike.
const SPAN = /(<span[^>]*\bdata-ver\b[^>]*>)v?\d+\.\d+\.\d+(?:-[\w.]+)?(<\/span>)/g;

const before = readFileSync(sitePath, "utf8");
let matches = 0;
const after = before.replace(SPAN, (_, open, close) => {
  matches++;
  return `${open}v${version}${close}`;
});

if (matches === 0) {
  console.error(
    "stamp-site-version: no [data-ver] spans matched in site/index.html.\n" +
      "The markup changed — fix the SPAN pattern in this script, or the site will\n" +
      "keep serving whatever version is baked in now.",
  );
  process.exit(1);
}

if (after === before) {
  console.log(`site/index.html already at v${version} (${matches} labels)`);
  process.exit(0);
}

writeFileSync(sitePath, after);
console.log(`site/index.html stamped to v${version} (${matches} labels)`);
