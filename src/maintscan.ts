// Maintenance's one cache, shared by the fleet and the project dashboard, and the only
// code that asks `maint_detect`/`maint_read`. Nothing here decides what a report means
// (./maint) or draws it (./maintview); a scan starts only on a person's ask (docs/maintenance.md).

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import {
  clampKept, clampSnaps, currentReports, hostSkips, snapWithout, narrowDetection, narrowMaint, narrowSweep, narrowSweepCheck, narrowSweepFacts, packKept, readsHost, snapFor, takeSnap,
  addMark, clampWeek, leavesMark, packWeek, takeMark, weekPair,
  type Detection, type KeptScans, type MaintInput, type MaintSnap, type SourceReport, type SweepAdvisory, type SweepAgent,
  type SweepFacts, type SweepState, type WeekMark, type WeekMarks,
} from "./maint";
import { DETECT, scanProgress, scanStale, type ScanProgress } from "./maintbadge";
import { findSource, MAINT_PREFS_DEFAULT, SOURCES, type MaintPrefs, type Mode } from "./maintsources";
import { ghAccountFor } from "./state";
import { readObj } from "./store";

/** One project's answers so far, keyed by `repoRoot ?? path`. */
export interface ProjectMaint {
  root: string;
  det: Detection | null;
  reports: Record<string, SourceReport>; // the last answer per source; a rescan replaces, never empties
  detecting: boolean;
  out: number; // reads still in flight
  total: number; // reads this scan asked, 0 until its detection answered
  live: Set<string>; // what holds a slot right now: source ids, DETECT while maint_detect runs
  at: number; // when its last scan finished (ms), 0 if none has
  err: string | null; // detection itself failed
  kept?: boolean; // the last session's scan, painted at boot; no read of this session has replaced it
}

const IN_FLIGHT = 6; // maint_detect and maint_read share it: one slow `gh` never queues the rest

const cache = new Map<string, ProjectMaint>();
export const maintOf = (root: string): ProjectMaint | undefined => cache.get(root);
/** Whether a look at a view should read this project again (./maintbadge scanStale). */
export const maintStale = (root: string, now = Date.now()): boolean => scanStale(cache.get(root), now);

// Copied from ./fleetui's loadSeq: only the newest fleet scan may clear the flag or stamp the time.
let maintSeq = 0;
export let fleetScanning = false;
export let fleetCheckedAt = 0; // 0: not checked this session, whatever an earlier one left in Rust
let fleetRoots: string[] = []; // the newest sweep's projects, which its progress is measured over

let repaint: () => void = () => {};
/** Who repaints when an answer lands; main.ts wires it, so nothing here imports a pane. */
export function setMaintRender(f: () => void) { repaint = f; }
/** Bumped on every change to what this module holds, so a summary drawn every frame can be memoised. */
export let maintGen = 0;
const paint = () => { maintGen++; repaint(); };

/** How far the running fleet sweep has got, or null when none is out (./maintbadge). */
export const fleetProgress = (): ScanProgress | null =>
  fleetScanning ? scanProgress(fleetRoots.flatMap((r) => { const e = cache.get(r); return e ? [e] : []; }), fleetRoots.length) : null;
/** One project's scan while it runs, whichever surface asked for it. */
export function projectProgress(root: string): ScanProgress | null {
  const e = cache.get(root);
  return e && (e.detecting || e.out > 0) ? scanProgress([e], 1) : null;
}

// Which public sources this machine may call and which it skips. Never synced: it changes what runs.
const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const stored = readObj<unknown>("cc-maint-prefs");
export let maintPrefs: MaintPrefs = { ...MAINT_PREFS_DEFAULT, public: strs(stored.public), off: strs(stored.off), hosts: strs(stored.hosts) };

/** Settings' switch for one public source. The next scan reads it; nothing is asked now. */
export function setMaintPublic(id: string, on: boolean): void {
  const rest = maintPrefs.public.filter((x) => x !== id);
  maintPrefs = { ...maintPrefs, public: on ? [...rest, id] : rest };
  localStorage.setItem("cc-maint-prefs", JSON.stringify(maintPrefs));
}

/** Allow or Disallow one `[deploy] host` on this machine. Nothing connects: Check prod still asks. */
export function setMaintHost(alias: string, on: boolean): void {
  const rest = maintPrefs.hosts.filter((x) => x !== alias);
  maintPrefs = { ...maintPrefs, hosts: on ? [...rest, alias] : rest };
  localStorage.setItem("cc-maint-prefs", JSON.stringify(maintPrefs));
  paint();
}

// The last finished scan per root in words, for a root whose whole scan did not fit `cc-maint-scan`
// and for Today. Local: another machine's checkout is not this one's; drawn muted and as of then.
let snaps = clampSnaps(readObj<unknown>("cc-maint"));
export const maintSnap = (root: string): MaintSnap | undefined => snapFor(snaps, root, ghAccountFor(root));
function keepSnap(e: ProjectMaint): void {
  const inp = maintInput(e.root), account = ghAccountFor(e.root);
  if (inp) snaps = clampSnaps({ ...snaps, [e.root]: takeSnap(e.root, inp, e.at, maintSnap(e.root), account) });
  if (e.det) kept = { ...kept, [e.root]: { at: e.at, account: ghAccountFor(e.root), det: e.det, reports: { ...e.reports } } };
  if (inp && leavesMark(inp)) weeks = { ...weeks, [e.root]: addMark(weeks[e.root] ?? [], takeMark(inp, e.at, account)) };
}
const saveSnaps = () => {
  try { localStorage.setItem("cc-maint", JSON.stringify(snaps)); } catch (err) { dlog("warn", `maint: snapshot not kept: ${err}`); }
  try { localStorage.setItem("cc-maint-scan", JSON.stringify(packKept(kept))); } catch (err) { dlog("warn", `maint: last scan not kept: ${err}`); }
  try { localStorage.setItem("cc-maint-week", JSON.stringify(packWeek(weeks))); } catch (err) { dlog("warn", `maint: week's marks not kept: ${err}`); }
};

// The same scans whole, so a boot paints the boards as they were rather than an empty view.
// Loading them reads storage only; an answer another account gave is not this one's.
let kept: KeptScans = clampKept(readObj<unknown>("cc-maint-scan"));
// Each root's marks for *Since last week*: identities only, one a local day, a week and its baseline.
let weeks: WeekMarks = clampWeek(readObj<unknown>("cc-maint-week"));
let weeksHeld: WeekMarks | null = null; // the marks as a fleet sweep found them, until it finishes
/** This account's latest mark and one a week older (./maint weekPair), as they stood before a running
 *  fleet sweep. Storage only: it never scans. */
export const maintWeek = (root: string): { now: WeekMark; base: WeekMark | null } | null =>
  weekPair((weeksHeld ?? weeks)[root] ?? [], ghAccountFor(root));
for (const [root, k] of Object.entries(kept)) {
  if (k.account !== ghAccountFor(root)) continue;
  cache.set(root, { root, det: k.det, reports: k.reports, detecting: false, out: 0, total: 0, live: new Set(), at: k.at, err: null, kept: true });
}

/** What ./maint's rules take for one project, or null before anything was asked. A host this machine
 *  has not allowed is skipped like an `off` source, so no click can reach it. */
export function maintInput(root: string): MaintInput | null {
  const e = cache.get(root);
  if (!e) return null;
  const skip = [...maintPrefs.off, ...hostSkips(e.det, maintPrefs.hosts)];
  return { det: e.det, ...currentReports(e.det, e.reports), skip, asking: askingIds(root), clicked: [...clicked.get(root) ?? []], hosts: maintPrefs.hosts };
}

// Per root, the click-only sources a click asked this session, so Coverage keeps saying what came back. Never a cc- key.
const clicked = new Map<string, Set<string>>();
/** Coverage's Clear: those projects' answers stay on their boards, and leave the row. */
export function forgetClicked(id: string, roots: readonly string[]): void {
  for (const r of roots) clicked.get(r)?.delete(id);
  paint();
}

let running = 0;
const waiting: (() => void)[] = [];
// A release hands its slot straight to the next waiter, so no caller can slip in between.
// `first`: a person's click goes ahead of a whole scan's queue rather than behind it.
async function slot<T>(job: () => Promise<T>, first = false): Promise<T> {
  if (running >= IN_FLIGHT) await new Promise<void>((go) => { if (first) waiting.unshift(go); else waiting.push(go); });
  else running++;
  try { return await job(); } finally {
    const next = waiting.shift();
    if (next) next(); else running--;
  }
}

const failed = (id: string, reason: string): SourceReport => ({
  source: id, facet: findSource(id)?.facet ?? null, cost: findSource(id)?.cost ?? null,
  coverage: { state: "error", reason }, at: null, truncated: false, gaps: [], facts: null,
});

function readOne(root: string, id: string, mode: Mode, force: boolean): Promise<SourceReport> {
  return invoke<unknown>("maint_read", {
    root, source: id, mode, public: maintPrefs.public.includes(id), force, account: ghAccountFor(root), hosts: maintPrefs.hosts,
  }).then((raw) => narrowMaint(raw, id), (e) => failed(id, String(e)));
}

// Every detected source is asked, skipped ones aside: Rust's cost gate answers `notRun`, or the
// result a click left, for what a scan may not run, so no facet waits on a read nobody makes.
// A host not allowed here is asked too (the gate connects nowhere), so Allow offers it at once.
// `save` false: a fleet sweep writes the snapshot once, when the last of its projects is in.
async function scanOne(root: string, force: boolean, save = true): Promise<void> {
  const prev = cache.get(root);
  const e: ProjectMaint = {
    root, det: prev?.det ?? null, reports: { ...prev?.reports }, detecting: true, out: 0, total: 0, live: new Set(),
    at: prev?.at ?? 0, err: null,
  };
  cache.set(root, e);
  // Identity, not a counter: a forgotten entry restarts any count, and its old scan must stay dead.
  const live = () => cache.get(root) === e;
  // A read is "live" while it holds a slot, so progress can say what is being read rather than queued.
  const holding = async <T>(id: string, job: () => Promise<T>): Promise<T> => {
    e.live.add(id);
    paint();
    try { return await job(); } finally { e.live.delete(id); }
  };
  paint();
  const det = await slot(() => holding(DETECT, () => invoke<unknown>("maint_detect", { root, force })))
    .then(narrowDetection, (err) => { e.err = String(err); return null; });
  if (!live()) return;
  e.detecting = false;
  e.det = det;
  if (!det) {
    e.err ??= "the detection had the wrong shape";
    dlog("warn", `maint: ${root}: ${e.err}`);
    paint();
    return;
  }
  const ids = det.sources.filter((id) => !maintPrefs.off.includes(id));
  e.out = e.total = ids.length;
  paint();
  await Promise.all(ids.map((id) => slot(async () => live() ? holding(id, () => readOne(root, id, "scan", force)) : null).then((r) => {
    if (!r || !live()) return;
    e.reports[id] = r;
    e.out--;
    paint();
  })));
  if (!live()) return;
  e.at = Date.now();
  keepSnap(e);
  if (save) saveSnaps();
  paint();
}

/** One project, as the dashboard's tab and a finding's Fetch ask for it. */
export const scanProject = (root: string, force: boolean): Promise<void> => scanOne(root, force);

/** Every project; at most six reads in flight across all of them. */
export async function scanFleet(roots: readonly string[], force: boolean): Promise<void> {
  const seq = ++maintSeq;
  fleetRoots = [...new Set(roots)];
  // The band compares finished sweeps: marks landing one project at a time would count it up mid-check.
  weeksHeld ??= weeks;
  fleetScanning = true;
  paint();
  await Promise.all(fleetRoots.map((r) => scanOne(r, force, false)));
  if (seq !== maintSeq) return; // a newer sweep took the flag; it clears it and stamps its own time
  saveSnaps();
  fleetScanning = false;
  weeksHeld = null;
  fleetCheckedAt = Date.now();
  paint();
}

const asking = new Map<string, number>(); // per root and source: click-only reads still out
const askKey = (root: string, id: string) => `${root}\n${id}`;
/** Whether a click-only read of this project (of these sources, if named) is still out, so its button can say so. */
const askingIds = (root: string): string[] =>
  [...asking].filter(([k, n]) => n > 0 && k.startsWith(`${root}\n`)).map(([k]) => k.slice(root.length + 1));
export const askingFor = (root: string, ids?: readonly string[]): boolean =>
  askingIds(root).some((id) => !ids || ids.includes(id));

/** A click-only source, run once on a person's ask (`explicit`, the class that may execute). */
export async function runSource(root: string, id: string): Promise<SourceReport> {
  const g = forgotten.get(root) ?? 0;
  const k = askKey(root, id);
  asking.set(k, (asking.get(k) ?? 0) + 1);
  clicked.set(root, (clicked.get(root) ?? new Set()).add(id));
  paint();
  try {
    const r = await slot(() => readOne(root, id, "explicit", true), true);
    const e = cache.get(root);
    if (e && (forgotten.get(root) ?? 0) === g) e.reports[id] = r;
    // A click reaches Rust only past the tick, so this is [deploy] naming another host than this detection said.
    if (r.coverage.state === "notRun" && readsHost(id)) {
      const det = await slot(() => invoke<unknown>("maint_detect", { root, force: true }), true).then(narrowDetection, () => null);
      const now = cache.get(root);
      if (now && det && (forgotten.get(root) ?? 0) === g) now.det = det;
    }
    return r;
  } finally {
    asking.set(k, (asking.get(k) ?? 1) - 1);
    paint();
  }
}

const forgotten = new Map<string, number>(); // per root: an answer asked before a forget is the other identity's

/** A token saved or forgotten: what that kind read is unasked again, as maint.rs's forget_token_reads left it,
 *  here and in what the next boot paints (the kept scans, and the snapshots' lines). */
export function forgetTokenReads(kind: string): void {
  const unask = (reports: Record<string, SourceReport>): boolean => {
    let hit = false;
    for (const [id, r] of Object.entries(reports)) {
      if (findSource(id)?.token?.id !== kind || r.coverage.state === "notRun") continue;
      reports[id] = { ...r, coverage: { state: "notRun" }, at: null, truncated: false, gaps: [], facts: null };
      hit = true;
    }
    return hit;
  };
  // The kept scans first, and copied: a boot hands the cache their very report maps.
  let hit = false;
  for (const [root, k] of Object.entries(kept)) {
    const reports = { ...k.reports };
    if (unask(reports)) { kept = { ...kept, [root]: { ...k, reports } }; hit = true; }
  }
  for (const e of cache.values()) unask(e.reports);
  const caps = new Set(SOURCES.filter((s) => s.token?.id === kind).flatMap((s) => s.sees));
  for (const [root, s] of Object.entries(snaps)) {
    const left = snapWithout(s, caps);
    if (left !== s) { snaps = { ...snaps, [root]: left }; hit = true; }
  }
  if (hit) saveSnaps();
  paint();
}

/** An account switch: what the other identity answered must not be drawn as this one's. */
export function forgetMaint(root: string): void {
  cache.delete(root);
  clicked.delete(root);
  if (weeksHeld?.[root]) weeksHeld = Object.fromEntries(Object.entries(weeksHeld).filter(([r]) => r !== root));
  if (snaps[root] || kept[root] || weeks[root]) { delete snaps[root]; delete kept[root]; delete weeks[root]; saveSnaps(); }
  forgotten.set(root, (forgotten.get(root) ?? 0) + 1);
  paint();
}

// ---------- the advisory sweep: this session only, never a cc- key (docs/maintenance.md) ----------

export interface SweepRun {
  n: number; query: string; at: number; // ms
  roots: string[]; // every project asked: one the read answered nothing for is drawn unsure
  state: SweepState; err: string | null;
  adv: SweepAdvisory | null; facts: SweepFacts[];
  agents: Record<string, SweepAgent>; // per root: the read-only agent asked about an unsure project
}
const SWEEPS_KEPT = 6;
let sweepN = 0;
export let sweeps: SweepRun[] = []; // newest first
let sweepShown = 0; // the run the board draws
export const shownSweep = (): SweepRun | null => sweeps.find((s) => s.n === sweepShown) ?? null;
export function showSweep(n: number): void { sweepShown = n; paint(); }

/** A person's submit: an id is looked up (that id is all that leaves), then every lockfile is read here. */
export async function runSweep(query: string, roots: readonly string[]): Promise<void> {
  const s: SweepRun = {
    n: ++sweepN, query, at: Date.now(), roots: [...new Set(roots)], state: "resolving", err: null, adv: null, facts: [], agents: {},
  };
  sweeps = [s, ...sweeps].slice(0, SWEEPS_KEPT);
  sweepShown = s.n;
  paint();
  try {
    const adv = narrowSweep(await invoke<unknown>("sweep_advisory", { query }));
    if (!adv) throw new Error("the advisory came back in the wrong shape");
    s.adv = adv;
    s.state = "matching";
    paint();
    const packages = adv.packages.map((p) => ({ ecosystem: p.ecosystem, name: p.name }));
    s.facts = narrowSweepFacts(await invoke<unknown>("sweep_match", { roots: s.roots, packages }));
    s.state = "done";
  } catch (e) {
    s.state = "error";
    s.err = e instanceof Error ? e.message : String(e);
  }
  paint();
}

/** One unsure project, asked of the read-only agent; a second click while it reads is ignored. */
export async function checkSweep(n: number, root: string, prompt: string): Promise<void> {
  const s = sweeps.find((x) => x.n === n);
  if (!s || s.agents[root]?.state === "running") return;
  s.agents[root] = { state: "running" };
  paint();
  try {
    const check = narrowSweepCheck(await invoke<unknown>("sweep_check", { dir: root, prompt }));
    s.agents[root] = check ? { state: "done", check } : { state: "error", err: "the answer came back in the wrong shape" };
  } catch (e) {
    s.agents[root] = { state: "error", err: String(e) };
  }
  paint();
}
