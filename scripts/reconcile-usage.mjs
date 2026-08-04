#!/usr/bin/env node
// Rebuild the `cc-usage` daily rollup from Claude's own transcripts.
//
// WHY THIS EXISTS. Until the costDelta fix, every `--resume` double-counted: Claude's
// `total_cost_usd` keeps running across a relaunch, but the new pane started from
// `cost: null`, so its first statusLine booked the whole carried-over total again. A
// drift `Move session` on 2026-08-01 put ~$28 into the day twice — the day read $68
// beside the session that had earned all of it reading $39. Every day containing a
// restore, a History reopen or a Move session is inflated, by an amount nothing in
// localStorage records. So the stored numbers cannot be *repaired*; they can only be
// **replaced** by recomputing from the one source that was never wrong — the token
// usage Claude writes into ~/.claude/projects/*/*.jsonl.
//
// HOW ACCURATE IT IS. Costs are token counts at published list prices. Checked against
// five live readings taken from two running sessions on 2026-08-01 (the figures the
// panes themselves displayed):
//
//   Opus 5 (1M context), three readings   →  +0.01%, -0.32%, +2.18%
//   Opus 5, two readings                  →  -15%, and -1.9% on the increment between
//                                            them, so its *baseline* carries ~$6 this
//                                            model does not explain
//
// The residual is real and unexplained — a server-side tool, or a window that starts
// earlier than assumed. Treat the output as accurate to a few percent and occasionally
// low, which is still a great deal closer than a figure inflated by a whole resumed
// session. It is a better estimate, not an audit.
//
// USAGE
//   node scripts/reconcile-usage.mjs              # dry run: stored vs rebuilt, per day
//   node scripts/reconcile-usage.mjs --write      # back up, then apply
//   node scripts/reconcile-usage.mjs --write --detail   # also rebuild cc-usage-detail
//   node scripts/reconcile-usage.mjs --backfill   # also add days Episko never recorded
//   node scripts/reconcile-usage.mjs --db <path>  # operate on a copy, for a rehearsal
//
// It targets the **installed app's** store and nothing else. A dev build keeps its own
// separate localStorage, so correcting one leaves the other untouched; --db if you want
// to point somewhere else on purpose.
//
// By default only days the rollup already knows about are rewritten. The transcripts go
// back further than Episko does, and a day it never watched is not a day it got wrong —
// backfilling one silently turns "we didn't keep this" into a figure, which is the same
// mistake the per-project strip avoids by showing a dash rather than $0.00. `--backfill`
// if you want the longer history anyway.
//
// QUIT EPISKO FIRST. `usage.ts` reads the rollup into memory once at module load and
// rewrites the whole key on every statusLine, so anything written underneath a running
// app is overwritten by its stale copy within seconds. The script refuses to run while
// it can see the process.

import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

// Published list prices, $ per million tokens. Cache writes are the 1-hour TTL rate
// (2x input) because that is the TTL Claude Code uses — the 5-minute rate (1.25x)
// under-predicted every reading tested. Add a family here if a new tier shows up in
// the transcripts; `UNKNOWN` is reported separately rather than silently priced.
// Cache read is 0.1x input, cache write 2x. Leaving a tier out is not a small error:
// `claude-fable-5` was missing from the first draft and took 837M cache-read tokens —
// several hundred dollars — out of the rebuild, which then read as if the old rollup
// had been more inflated than it was. Check the skip count in the output; anything
// non-zero with tokens behind it means a tier belongs here.
const PRICES = {
  fable:  { in: 10,   out: 50,   read: 1,     write: 20   },  // and mythos, same price
  opus:   { in: 5,    out: 25,   read: 0.5,   write: 10   },
  sonnet: { in: 3,    out: 15,   read: 0.3,   write: 6    },
  haiku:  { in: 1,    out: 5,    read: 0.1,   write: 2    },
};
const family = (m) => {
  const s = (m || "").toLowerCase();
  if (s.includes("fable") || s.includes("mythos")) return "fable";
  return s.includes("opus") ? "opus" : s.includes("sonnet") ? "sonnet" : s.includes("haiku") ? "haiku" : null;
};

const argv = process.argv.slice(2);
const args = new Set(argv);
const WRITE = args.has("--write");
const DETAIL = args.has("--detail");
const BACKFILL = args.has("--backfill");
// `indexOf` returns -1 when the flag is absent, and argv[-1 + 1] is argv[0] — so the
// bare `--write` form silently took its own flag as the database path. Guard the -1.
const dbFlag = argv.indexOf("--db");
const DB_ARG = dbFlag >= 0 ? argv[dbFlag + 1] : undefined;
if (dbFlag >= 0 && !DB_ARG) { console.error("--db needs a path."); process.exit(1); }

// ---------- locate the store ----------
// The installed app, always. A dev build is a *different* store: `pnpm tauri dev` runs
// the bare `episko` binary, so WebKit keys its localStorage under ~/Library/WebKit/
// episko rather than the bundle id — separate file, separate rollup (this machine's
// held $1.11 across one day, against five weeks in the installed one). An earlier draft
// picked whichever store was written most recently, which meant a dev run an hour before
// pointed the repair at the wrong history and reported it as a success. One identifier,
// no guessing; --db overrides.
const APP_ID = "io.respeak.episko";
// WebKit hashes the origin into the path, so the file is found by walking rather than
// constructed. Several origins can exist under one app; newest write wins among them.
function findStore() {
  const roots = [join(homedir(), "Library/WebKit", APP_ID)];
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === "localstorage.sqlite3") {
        // The WAL is where a recently-running app's writes actually live; its mtime
        // is the honest "last touched", not the main file's.
        const t = Math.max(...["", "-wal"].map((s) => { try { return statSync(p + s).mtimeMs; } catch { return 0; } }));
        hits.push({ path: p, mtime: t });
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r, 0);
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0]?.path;
}

// sqlite3(1) ships with macOS, which is one fewer dependency than a node driver — and
// the values are UTF-16LE blobs, so they move as hex in both directions.
const sql = (db, q) => execFileSync("sqlite3", [db, q], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const readKey = (db, key) => {
  const hex = sql(db, `SELECT hex(value) FROM ItemTable WHERE key='${key}';`);
  if (!hex) return null;
  return JSON.parse(Buffer.from(hex, "hex").toString("utf16le"));
};
// INSERT OR REPLACE, not UPDATE. A bare `UPDATE ... WHERE key='x'` against a key with
// no row matches nothing and *succeeds*, so the script would print "wrote cc-usage-detail"
// having written nothing at all. That is reachable rather than theoretical: the detail
// split records forward from when it shipped, so an install older than it legitimately
// has a `cc-usage` row and no detail row. `changes()` is the belt to that braces — it
// reports what the statement actually touched, and anything but one row is a failure
// however it came about.
const writeKey = (db, key, value) => {
  const hex = Buffer.from(JSON.stringify(value), "utf16le").toString("hex");
  const n = sql(db, `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${key}', x'${hex}'); SELECT changes();`);
  if (n !== "1") throw new Error(`writing ${key} affected ${n || 0} row(s), expected 1 — nothing was saved.`);
};

// ---------- rebuild from transcripts ----------
const dayKey = (iso) => {
  // Local calendar day, because that is what todayKey() files a cost under. A UTC
  // key would shift every evening's spend onto the next day for anyone east of GMT.
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function scan() {
  const root = join(homedir(), ".claude", "projects");
  const days = new Map();  // dayKey -> { cost, models:{}, projects:{}, sessions:Set, unpriced }
  let files = 0, unpriced = 0;
  const unknown = new Set();
  const bump = (k) => {
    let d = days.get(k);
    if (!d) days.set(k, (d = { cost: 0, models: {}, projects: {}, sessions: new Set(), unpriced: 0 }));
    return d;
  };
  for (const proj of readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const f of readdirSync(join(root, proj.name))) {
      if (!f.endsWith(".jsonl")) continue;
      files++;
      const path = join(root, proj.name, f);
      const sid = f.replace(/\.jsonl$/, "");
      // One id per assistant message. A transcript line is not a request — the same
      // message.id can appear more than once, and counting each occurrence inflates
      // exactly the figure this script exists to deflate.
      const seen = new Set();
      let cwd = "";
      const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
        const u = r.message?.usage;
        if (!u || !r.timestamp) continue;
        const id = r.message?.id;
        if (id) { if (seen.has(id)) continue; seen.add(id); }
        // A record carrying no tokens costs nothing whatever model it names, so it can
        // never move a total and must not hold a day back from being rebuilt. Not a
        // tidy-up: Claude Code writes its own notices — "You've hit your session limit",
        // "API Error: Connection closed mid-response" — as assistant records with
        // `model: "<synthetic>"` and an all-zero usage block. Counting those as unpriced
        // withheld the single most inflated day in the corpus this script exists to
        // repair, which is precisely backwards. Only a *token-bearing* record with a
        // model we cannot price is a real gap.
        const toks = (u.input_tokens || 0) + (u.output_tokens || 0) +
                     (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!toks) continue;
        const fam = family(r.message?.model);
        if (!fam) {
          // Attribute the skip to its *day*, not just to a global tally. A day that
          // lost records cannot be rebuilt, and the run below has to be able to tell
          // it apart from a day this script correctly deflated — by total alone the
          // two are identical, and both wear the same "inflated" mark.
          unpriced++;
          unknown.add(r.message?.model || "(no model on the record)");
          bump(dayKey(r.timestamp)).unpriced++;
          continue;
        }
        const p = PRICES[fam];
        const cost =
          ((u.input_tokens || 0) * p.in +
           (u.output_tokens || 0) * p.out +
           (u.cache_read_input_tokens || 0) * p.read +
           (u.cache_creation_input_tokens || 0) * p.write) / 1e6;
        const d = bump(dayKey(r.timestamp));
        d.cost += cost;
        const label = fam[0].toUpperCase() + fam.slice(1);
        d.models[label] = (d.models[label] || 0) + cost;
        const project = cwd ? cwd.split("/").filter(Boolean).pop() : "unknown";
        d.projects[project] = (d.projects[project] || 0) + cost;
        d.sessions.add(sid);
      }
    }
  }
  return { days, files, unpriced, unknown };
}

// ---------- run ----------
// `ps`, not `pgrep`: pgrep returns nothing for a running Episko under a sandboxed or
// restricted shell (verified — `ps -Ao comm` lists it in the same shell where every
// pgrep spelling exits 1), and a process guard that silently never fires is worse than
// no guard, because it reads as a check that passed.
const running = (() => {
  try {
    return execFileSync("ps", ["-Ao", "pid=,comm="], { encoding: "utf8" })
      .split("\n").map((l) => l.trim())
      .filter((l) => /episko/i.test(l) && !l.startsWith(`${process.pid} `))
      .join("\n");
  } catch { return ""; }
})();
const appStore = findStore();
const db = DB_ARG || appStore;
if (!db) {
  console.error(`No installed-app localStorage found under ~/Library/WebKit/${APP_ID}.`);
  const dev = join(homedir(), "Library/WebKit/episko");
  if (existsSync(dev)) {
    console.error(`\nThere is a dev-build store at ${dev}, which this script will not`);
    console.error("touch by default — it is a different rollup, not the installed app's.");
    console.error("Pass --db <path to its localstorage.sqlite3> if you really mean that one.");
  }
  process.exit(1);
}
console.log(`store    ${db}${DB_ARG ? "  (--db override)" : `  (installed app, ${APP_ID})`}`);

// The running guard belongs *here*, after the store is known, and not before it. A live
// Episko holds the rollup in memory and rewrites the whole key on every statusLine, so
// anything written underneath it is gone within seconds — but that is only true of the
// store the app is actually using. `--db` pointed at a copy is the rehearsal this
// script's own usage text recommends, and checked earlier the guard refused exactly
// that: it taught the one safe way to try this that it was the dangerous one. Compare
// resolved paths, so `--db` aimed at the real store is still caught.
const samePath = (a, b) => {
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  return !!a && !!b && real(a) === real(b);
};
if (WRITE && running && samePath(db, appStore)) {
  console.error("\nEpisko looks like it is running:\n  " + running.split("\n").join("\n  "));
  console.error("\nQuit it first — it holds the rollup in memory and rewrites the key on every");
  console.error("statusLine, so anything written now is overwritten within seconds.");
  console.error("(To rehearse against a copy while it runs, pass --db <copy>.)");
  process.exit(1);
}

const stored = readKey(db, "cc-usage") || {};
const { days, files, unpriced, unknown } = await scan();
console.log(`scanned  ${files} transcripts${unpriced ? `, ${unpriced} records skipped (unrecognised model)` : ""}\n`);

const all = [...new Set([...Object.keys(stored), ...(BACKFILL ? days.keys() : [])])].sort();
const rebuilt = {};
const kept = new Set();
let sOld = 0, sNew = 0;
console.log("day           stored     rebuilt        delta");
console.log("─".repeat(48));
for (const k of all) {
  const oldV = stored[k] ?? 0;
  const d = days.get(k);
  // Two ways a day cannot be rebuilt, and by total alone neither is distinguishable
  // from a day this script correctly deflated — all three are simply a smaller number,
  // duly marked "inflated". So neither is written: the day keeps what it had and says
  // why, because replacing a real figure with a partial one is the failure that cannot
  // be undone once the backup is gone.
  //
  //   * skipped records — a family missing from PRICES. `claude-fable-5` was missing
  //     from the first draft and took 837M cache-read tokens out of the rebuild, which
  //     then read as if the old rollup had been more inflated than it was.
  //   * nothing scanned at all — the transcripts have been pruned or deleted, so there
  //     is no longer anything to recompute *from*.
  const why = d?.unpriced ? `${d.unpriced} unpriced record(s)` : (!d && oldV > 0 ? "no transcripts found" : "");
  if (why) {
    rebuilt[k] = oldV;
    kept.add(k);
    sOld += oldV; sNew += oldV;
    console.log(`${k}  ${oldV.toFixed(2).padStart(9)}  ${"kept".padStart(10)}  ${"—".padEnd(7)}← ${why}`);
    continue;
  }
  const newV = d?.cost ?? 0;
  rebuilt[k] = newV;
  sOld += oldV; sNew += newV;
  const delta = newV - oldV;
  const flag = oldV > 0 && newV < oldV * 0.75 ? "  ← inflated" : "";
  console.log(`${k}  ${oldV.toFixed(2).padStart(9)}  ${newV.toFixed(2).padStart(10)}  ${(delta >= 0 ? "+" : "") + delta.toFixed(2)}${flag}`);
}
console.log("─".repeat(48));
console.log(`total     ${sOld.toFixed(2).padStart(9)}  ${sNew.toFixed(2).padStart(10)}  ${(sNew - sOld >= 0 ? "+" : "") + (sNew - sOld).toFixed(2)}`);

if (kept.size) {
  console.log(`\n${kept.size} day(s) kept their stored value — marked above. A day whose records could not`);
  console.log("all be priced is not a day this script can correct, so it is left alone rather than");
  console.log("replaced by a partial total.");
}
if (unknown.size) {
  console.log(`\nUnrecognised model(s): ${[...unknown].sort().join(", ")}`);
  console.log("Add the tier to PRICES at the top of this script and re-run; until then every day");
  console.log("those records fall in is kept rather than rebuilt.");
}

const extra = [...days.keys()].filter((k) => !(k in stored));
if (extra.length && !BACKFILL) {
  console.log(`\n${extra.length} day(s) in the transcripts predate the rollup and were left out; --backfill adds them.`);
}
if (!WRITE) {
  console.log("\nDry run — nothing written. Re-run with --write to apply (and --detail to");
  console.log("rebuild the per-model / per-project split too).");
  process.exit(0);
}

const backup = `${db}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(db, backup);
for (const ext of ["-wal", "-shm"]) if (existsSync(db + ext)) copyFileSync(db + ext, backup + ext);
console.log(`\nbackup   ${backup}`);

writeKey(db, "cc-usage", rebuilt);
console.log("wrote    cc-usage");

if (DETAIL) {
  // The telemetry-fed split carries the same inflation, and leaving it while the totals
  // are corrected would make the Usage panel disagree with itself. Rebuilt from the same
  // records, which also backfills days that predate the split shipping — except for the
  // days kept above, which keep their stored split for the same reason they kept their
  // stored total. Rebuilding one half of a day we declined to rebuild would put the two
  // numbers into exactly the disagreement this clause exists to avoid.
  const storedDetail = readKey(db, "cc-usage-detail") || {};
  const detail = {};
  for (const k of all) {
    if (kept.has(k)) { if (storedDetail[k]) detail[k] = storedDetail[k]; continue; }
    const d = days.get(k);
    if (d) detail[k] = { models: d.models, projects: d.projects, sessions: [...d.sessions] };
  }
  writeKey(db, "cc-usage-detail", detail);
  console.log("wrote    cc-usage-detail");
}
console.log("\nDone. Start Episko — it reads the rollup at load.");
