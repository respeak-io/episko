// Maintenance's one cache, shared by the fleet and the project dashboard, and the only
// code that asks `maint_detect`/`maint_read`. Nothing here decides what a report means
// (./maint) or draws it (./maintview); a scan starts only on a person's ask (docs/maintenance.md).

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import { narrowDetection, narrowMaint, type Detection, type MaintInput, type SourceReport } from "./maint";
import { findSource, MAINT_PREFS_DEFAULT, type MaintPrefs, type Mode } from "./maintsources";
import { ghAccountFor } from "./state";
import { readObj } from "./store";

/** One project's answers so far, keyed by `repoRoot ?? path`. */
export interface ProjectMaint {
  root: string;
  det: Detection | null;
  reports: Record<string, SourceReport>; // the last answer per source; a rescan replaces, never empties
  detecting: boolean;
  out: number; // reads still in flight
  at: number; // when its last scan finished (ms), 0 if none has
  err: string | null; // detection itself failed
}

/** A switch to the view inside this window re-reads nothing; ⟳ always does. */
export const MAINT_FRESH_MS = 10 * 60_000;
const IN_FLIGHT = 6; // maint_detect and maint_read share it: one slow `gh` never queues the rest

const cache = new Map<string, ProjectMaint>();
export const maintOf = (root: string): ProjectMaint | undefined => cache.get(root);

// Copied from ./fleetui's loadSeq: only the newest fleet scan may clear the flag or stamp the time.
let maintSeq = 0;
export let fleetScanning = false;
export let fleetCheckedAt = 0; // 0: not checked this session, whatever an earlier one left in Rust

let paint: () => void = () => {};
/** Who repaints when an answer lands; main.ts wires it, so nothing here imports a pane. */
export function setMaintRender(f: () => void) { paint = f; }

// Which public sources this machine may call and which it skips. Never synced: it changes what runs.
const strs = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const stored = readObj<unknown>("cc-maint-prefs");
export let maintPrefs: MaintPrefs = { ...MAINT_PREFS_DEFAULT, public: strs(stored.public), off: strs(stored.off) };

/** Settings' switch for one public source. The next scan reads it; nothing is asked now. */
export function setMaintPublic(id: string, on: boolean): void {
  const rest = maintPrefs.public.filter((x) => x !== id);
  maintPrefs = { ...maintPrefs, public: on ? [...rest, id] : rest };
  localStorage.setItem("cc-maint-prefs", JSON.stringify(maintPrefs));
}

/** What ./maint's rules take for one project, or null before anything was asked. */
export function maintInput(root: string): MaintInput | null {
  const e = cache.get(root);
  return e ? { det: e.det, reports: e.reports, skip: maintPrefs.off, asking: askingIds(root) } : null;
}

let running = 0;
const waiting: (() => void)[] = [];
// A release hands its slot straight to the next waiter, so no caller can slip in between.
async function slot<T>(job: () => Promise<T>): Promise<T> {
  if (running >= IN_FLIGHT) await new Promise<void>((go) => waiting.push(go));
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
    root, source: id, mode, public: maintPrefs.public.includes(id), force, account: ghAccountFor(root),
  }).then((raw) => narrowMaint(raw, id), (e) => failed(id, String(e)));
}

// Every detected source is asked, skipped ones aside: Rust's cost gate answers `notRun`, or the
// result a click left, for what a scan may not run, so no facet waits on a read nobody makes.
async function scanOne(root: string, force: boolean): Promise<void> {
  const prev = cache.get(root);
  const e: ProjectMaint = {
    root, det: prev?.det ?? null, reports: { ...prev?.reports }, detecting: true, out: 0,
    at: prev?.at ?? 0, err: null,
  };
  cache.set(root, e);
  // Identity, not a counter: a forgotten entry restarts any count, and its old scan must stay dead.
  const live = () => cache.get(root) === e;
  paint();
  const det = await slot(() => invoke<unknown>("maint_detect", { root, force }))
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
  e.out = ids.length;
  paint();
  await Promise.all(ids.map((id) => slot(async () => live() ? readOne(root, id, "scan", force) : null).then((r) => {
    if (!r || !live()) return;
    e.reports[id] = r;
    e.out--;
    paint();
  })));
  if (live()) { e.at = Date.now(); paint(); }
}

/** One project, as the dashboard's tab and a finding's Fetch ask for it. */
export const scanProject = (root: string, force: boolean): Promise<void> => scanOne(root, force);

/** Every project; at most six reads in flight across all of them. */
export async function scanFleet(roots: readonly string[], force: boolean): Promise<void> {
  const seq = ++maintSeq;
  fleetScanning = true;
  paint();
  await Promise.all([...new Set(roots)].map((r) => scanOne(r, force)));
  if (seq !== maintSeq) return; // a newer sweep took the flag; it clears it and stamps its own time
  fleetScanning = false;
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
  paint();
  try {
    const r = await slot(() => readOne(root, id, "explicit", true));
    const e = cache.get(root);
    if (e && (forgotten.get(root) ?? 0) === g) e.reports[id] = r;
    return r;
  } finally {
    asking.set(k, (asking.get(k) ?? 1) - 1);
    paint();
  }
}

const forgotten = new Map<string, number>(); // per root: an answer asked before a forget is the other identity's

/** An account switch: what the other identity answered must not be drawn as this one's. */
export function forgetMaint(root: string): void {
  cache.delete(root);
  forgotten.set(root, (forgotten.get(root) ?? 0) + 1);
  paint();
}
