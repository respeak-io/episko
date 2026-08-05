#!/usr/bin/env node
// CHANGELOG.md's three consumers, in one file.
//
//   draft            — write the Unreleased section from the commits since the last tag,
//                      through `claude -p`. Writes a draft and stops; never commits.
//   check            — the CI gate: fail if Unreleased is missing or empty.
//   section <ver>    — print one release's markdown, for release.yml's body.
//   release <ver>    — rename Unreleased to <ver> and stamp today's date.
//
// No dependencies: this runs on a CI runner before `pnpm install` has necessarily
// produced anything, and a release script that can fail on a registry hiccup is a
// release script that will.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "CHANGELOG.md");

const read = () => readFileSync(FILE, "utf8");

/// Split the file into its `## …` sections, keeping the preamble separate. Deliberately
/// the same heading grammar as src/changelog.ts — a prose heading is not a release.
function sections(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let cur = null;
  let preamble = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    const ver = m ? headingVersion(m[1]) : null;
    if (ver) {
      cur = { version: ver, heading: line, body: [] };
      out.push(cur);
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, out };
}

function headingVersion(h) {
  const m = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*(?:[—–-].*)?$/.exec(h);
  if (m) return m[1];
  return /^unreleased$/i.test(h) ? "Unreleased" : null;
}

const bodyText = (s) => s.body.join("\n").trim();
/// A section "has content" only if it carries at least one marker line. A lede alone is
/// somebody starting to write and stopping, which is exactly what the gate is for.
const hasEntries = (s) => s.body.some((l) => /^\s*[+~!]\s+\S/.test(l));

// ---------- draft ----------

function lastTag() {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function facts(since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  // Merge commits carry the PR title, which is usually the best one-line summary of a
  // change; the non-merge subjects carry the detail. Both, deduped by the reader.
  const merges = git(["log", "--merges", "--pretty=%s%n%b", range]);
  const subjects = git(["log", "--no-merges", "--pretty=%s", range]);
  return `MERGED PULL REQUESTS\n${merges}\n\nCOMMIT SUBJECTS\n${subjects}`.slice(0, 24000);
}

const PROMPT = `You are writing the Unreleased section of a changelog for Episko, a desktop app
that runs many Claude Code sessions at once.

Below are the merged pull requests and commit subjects since the last release. Write the
section body — do NOT write the "## Unreleased" heading itself.

Format:
- One short opening sentence saying what this release is ABOUT. No bullet, no heading.
- Then one line per user-visible change, each starting with a marker:
    +  something new
    ~  something that changed
    !  something fixed
- Use **bold** for the name of a feature, and \`code\` for a file or flag.
- Wrap lines at about 88 characters; continuation lines are indented two spaces.

Rules:
- Write for someone who uses the app, not someone who wrote it. "The sidebar only lists
  checkouts something is running in" — not "refactored groupBody".
- Omit anything with no user-visible effect: refactors, tests, CI, docs, dependency bumps.
- Do not invent anything that is not in the facts below.
- At most 12 lines. If there are more changes than that, merge the small ones.
- Output only the section body. No preamble, no code fence.

FACTS
`;

function draft() {
  const tag = lastTag();
  const f = facts(tag);
  process.stderr.write(`drafting from ${tag || "the beginning"}…\n`);
  let text;
  try {
    text = execFileSync("claude", ["-p", PROMPT + f, "--model", "haiku"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 120_000,
    }).trim();
  } catch (e) {
    console.error("claude failed — write the section by hand:", e.message);
    process.exit(1);
  }
  // Strip a code fence if the model added one despite being told not to.
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  if (!text) {
    console.error("claude returned nothing — write the section by hand");
    process.exit(1);
  }

  const md = read();
  const { preamble, out } = sections(md);
  const unrel = out.find((s) => s.version === "Unreleased");
  if (unrel && hasEntries(unrel)) {
    console.error("Unreleased already has entries — edit them, or clear the section first.");
    process.exit(1);
  }
  const rest = out.filter((s) => s.version !== "Unreleased");
  const rebuilt =
    preamble.join("\n").replace(/\s+$/, "") +
    `\n\n## Unreleased\n\n${text}\n\n` +
    rest.map((s) => `${s.heading}\n${bodyText(s)}\n`).join("\n");
  writeFileSync(FILE, rebuilt.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  process.stderr.write("wrote CHANGELOG.md — read it before committing.\n");
}

// ---------- check ----------

function check() {
  const { out } = sections(read());
  const unrel = out.find((s) => s.version === "Unreleased");
  if (!unrel) {
    fail("CHANGELOG.md has no `## Unreleased` section.");
  }
  if (!hasEntries(unrel)) {
    fail("`## Unreleased` in CHANGELOG.md has no entries.");
  }
  console.log(`CHANGELOG.md: Unreleased has ${unrel.body.filter((l) => /^\s*[+~!]\s/.test(l)).length} entries.`);
}

function fail(msg) {
  // The gate exists to be *actionable*: say what is wrong and exactly how to fix it,
  // because the person who hits it is trying to ship and has no interest in archaeology.
  console.error(`\n✗ ${msg}\n`);
  console.error("Every release describes itself. Add the section, then push:\n");
  console.error("    pnpm changelog draft     # draft it from the commits since the last tag");
  console.error("    $EDITOR CHANGELOG.md     # read it — this is what users will see\n");
  console.error("Markers: + new · ~ changed · ! fixed\n");
  process.exit(1);
}

// ---------- section / release ----------

function section(version) {
  const v = String(version || "").replace(/^v/, "");
  const { out } = sections(read());
  const s = out.find((x) => x.version === v);
  if (!s) {
    console.error(`CHANGELOG.md has no section for ${v}`);
    process.exit(1);
  }
  process.stdout.write(bodyText(s) + "\n");
}

function release(version) {
  const v = String(version || "").replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+/.test(v)) {
    console.error(`not a version: ${version}`);
    process.exit(1);
  }
  const md = read();
  const { preamble, out } = sections(md);
  const unrel = out.find((s) => s.version === "Unreleased");
  if (!unrel || !hasEntries(unrel)) fail("`## Unreleased` is empty — nothing to release.");
  if (out.some((s) => s.version === v)) {
    console.error(`CHANGELOG.md already has a section for ${v}`);
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const rest = out.filter((s) => s.version !== "Unreleased");
  const rebuilt =
    preamble.join("\n").replace(/\s+$/, "") +
    `\n\n## Unreleased\n\n` +
    `## ${v} — ${today}\n\n${bodyText(unrel)}\n\n` +
    rest.map((s) => `${s.heading}\n${bodyText(s)}\n`).join("\n");
  writeFileSync(FILE, rebuilt.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  process.stderr.write(`CHANGELOG.md: Unreleased → ${v} (${today})\n`);
  // Two things this command cannot do for you, said where they are still cheap.
  //
  // It has just EMPTIED `## Unreleased`, which is precisely what the dev → main gate
  // refuses — so run on the wrong branch it does not fail here, it fails on the pull
  // request, after a push. And the heading it wrote carries no lede, while *What's new*
  // renders that line as the release's headline. Both are one edit away at this moment
  // and an awkward revert five minutes later. See RELEASE.md § Cutting it.
  process.stderr.write(
    `\n  next:  add the one-line lede under "## ${v}" — What's new shows it as the headline\n`
    + `         bump "version" in package.json AND src-tauri/tauri.conf.json to ${v}\n`
    + `         this belongs on main, AFTER the dev → main merge: it empties Unreleased,\n`
    + `         which is what the PR gate refuses\n`
    + `  check: node scripts/changelog.mjs section ${v} | head -3\n`,
  );
}

// ---------- main ----------
const [cmd, arg] = process.argv.slice(2);
if (cmd === "draft") draft();
else if (cmd === "check") check();
else if (cmd === "section") section(arg);
else if (cmd === "release") release(arg);
else {
  console.error("usage: changelog.mjs draft | check | section <version> | release <version>");
  process.exit(2);
}
