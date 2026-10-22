#!/usr/bin/env node
// Bake the release data into the marketing site: the version labels, the direct
// .dmg/.msi links, the release strip, its heading and the three newest release cards.
//
// The page itself asks nobody for any of this (the privacy page promises no
// third-party requests), so whatever this writes is what visitors see until the
// next release runs it again. site.yml runs it on every release and commits the result.
//
//   node scripts/stamp-site-version.mjs           # the newest published release
//   node scripts/stamp-site-version.mjs v0.12.0   # the same, but fail unless it is v0.12.0
//
// Reads GH_TOKEN or GITHUB_TOKEN when set (CI); without one the API allows 60 calls/h.
// Exits non-zero if any anchor in the markup went missing, so a markup change can't
// silently turn the stamp into a no-op and let the site drift.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "respeak-io/episko";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sitePath = join(root, "site", "index.html");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fail(msg) {
  console.error(`stamp-site-version: ${msg}`);
  process.exit(1);
}

const want = process.argv[2] ? String(process.argv[2]).trim().replace(/^v/, "") : null;
if (want && !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(want)) fail(`"${process.argv[2]}" is not a version (expected 1.2.3 or v1.2.3)`);

async function releases() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "episko-site-stamp" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const all = [];
  for (let page = 1; page < 20; page++) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, { headers });
    if (!r.ok) fail(`the releases API answered ${r.status} ${r.statusText}`);
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all
    .filter((r) => !r.draft && !r.prerelease && r.published_at)
    .map((r) => ({ ...r, v: r.tag_name.replace(/^v/, ""), day: r.published_at.slice(0, 10) }))
    .filter((r) => /^\d+\.\d+\.\d+$/.test(r.v));
}

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (day) => { const d = new Date(`${day}T12:00:00Z`); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };

// The paragraph a release's notes open with, up to the first list line or heading.
function intro(body) {
  const out = [];
  for (const line of (body || "").split(/\r?\n/)) {
    if (!line.trim() || /^[+~!*#-]\s/.test(line)) break;
    out.push(line.trim());
  }
  return out.join(" ").replace(/[*_`]/g, "");
}

const list = await releases();
if (!list.length) fail("the API listed no published releases");
const latest = list[0];
if (want && latest.v !== want) fail(`v${want} is not the newest published release yet (the API's newest is v${latest.v})`);

const asset = (re) => (latest.assets || []).find((a) => re.test(a.name))?.browser_download_url;
const mac = asset(/\.dmg$/i);
const win = asset(/\.msi$/i) || asset(/-setup\.exe$/i);
if (!mac) console.warn(`::warning::v${latest.v} has no .dmg; the macOS buttons keep their old link`);
if (!win) console.warn(`::warning::v${latest.v} has no .msi or -setup.exe; the Windows button keeps its old link`);

const t0 = Date.parse(`${list.at(-1).day}T12:00:00Z`), t1 = Date.parse(`${latest.day}T12:00:00Z`);
const heading = `${list.length} releases in ${Math.round((t1 - t0) / 864e5 / 7)} weeks`;
const strip = list.map((r) => `${r.v} ${r.day}`).join("|");
const cards = list.slice(0, 3).map((r) =>
  `        <li><a href="${esc(r.html_url)}"><p class="rv"><b>${esc(r.v)}</b><span>${short(r.day)}</span></p><p class="rn">${esc(intro(r.body))}</p></a></li>\n`,
).join("");

const before = readFileSync(sitePath, "utf8");
let html = before;
function swap(name, re, fn, many = false) {
  let n = 0;
  html = html.replace(re, (...m) => { n++; return fn(...m); });
  if (n === 0 || (!many && n > 1)) fail(`expected ${many ? "at least one" : "exactly one"} ${name} in site/index.html, found ${n}; fix the pattern in this script`);
  return n;
}

const labels = swap("[data-ver] label", /(<span[^>]*\bdata-ver\b[^>]*>)v?\d+\.\d+\.\d+(?:-[\w.]+)?(<\/span>)/g, (_, a, b) => `${a}v${latest.v}${b}`, true);
swap("release strip", /var REL0='[^']*'/g, () => `var REL0='${strip}'`);
swap("release heading", /(<h2 id="relHead">)[^<]*(<\/h2>)/g, (_, a, b) => `${a}${heading}${b}`);
swap("release cards", /(<ol class="rel-latest" id="relCards">\n)[\s\S]*?(\s*<\/ol>)/g, (_, a, b) => `${a}${cards.trimEnd()}${b}`);
if (mac) {
  swap("dlPrimary link", /(id="dlPrimary" href=")[^"]*/g, (_, a) => a + mac);
  swap("dlMac link", /(id="dlMac" href=")[^"]*/g, (_, a) => a + mac);
}
if (win) {
  swap("dlWin link", /(id="dlWin" href=")[^"]*/g, (_, a) => a + win);
  swap("dlWinSub", /(<span id="dlWinSub">)[^<]*/g, (_, a) => `${a}${/\.exe$/i.test(win) ? ".exe" : ".msi"} · Windows 10 &amp; 11`);
}

if (html === before) {
  console.log(`site/index.html already at v${latest.v} (${labels} labels, ${list.length} releases)`);
  process.exit(0);
}
writeFileSync(sitePath, html);
console.log(`site/index.html stamped to v${latest.v} (${labels} labels, ${list.length} releases)`);
