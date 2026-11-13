// How far a Maintenance scan has got, and what the header's Maintenance chip says: data in, data out.
// ./maintscan measures, ./maintpop paints the chip and its popover, ./fleetui and ./dashboard draw the
// same progress. Like every Maintenance surface it reads what scans left and never asks (docs/maintenance.md).

import { findSource } from "./maintsources";
import { needsCount, rankMaint, type Band, type Cell, type Finding, type Level } from "./maint";

/** What holds a scan's slot while `maint_detect` runs: no source id is empty. */
export const DETECT = "";

/** One project's scan as ./maintscan holds it. */
export interface ScanState { root: string; detecting: boolean; total: number; out: number; live: ReadonlySet<string> }

export interface ScanProgress {
  projects: number; // asked in this scan
  done: number; // every read landed, or the detection failed
  looking: number; // still being detected, so their reads are not counted yet
  reads: number; // reads known so far
  readsDone: number;
  frac: number; // 0..1: each project weighs the same, so one with forty sources never stalls the bar
  live: { root: string; source: string }[]; // holding a slot now; DETECT while a project is looked at
}

/** `projects` may exceed `rows`: a project whose entry was forgotten counts as not started. */
export function scanProgress(rows: readonly ScanState[], projects = rows.length): ScanProgress {
  let done = 0, looking = 0, reads = 0, readsDone = 0, sum = 0;
  const live: ScanProgress["live"] = [];
  for (const e of rows) {
    if (e.detecting) looking++;
    else if (e.out === 0) done++;
    reads += e.total;
    readsDone += e.total - e.out;
    // Detection is a step of its own, so a project with no source still moves the bar.
    sum += e.detecting ? 0 : (1 + e.total - e.out) / (1 + e.total);
    for (const s of e.live) live.push({ root: e.root, source: s });
  }
  const n = Math.max(projects, rows.length);
  return { projects: n, done, looking: looking + n - rows.length, reads, readsDone, frac: n ? sum / n : 1, live };
}

/** A look at a view inside this re-reads nothing for that project; ⟳ always does. */
export const MAINT_FRESH_MS = 10 * 60_000;

/** Whether a look at a view should read this project again. Per project, so going between the fleet and
 *  one project's tab re-reads nothing just read; a read already out is its own answer, a failed detection none. */
export function scanStale(e: (Pick<ScanState, "detecting" | "out"> & { at: number; err: string | null }) | undefined, now: number): boolean {
  if (!e) return true;
  if (e.detecting || e.out > 0) return false;
  return !!e.err || now - e.at > MAINT_FRESH_MS;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
export const pct = (p: ScanProgress): number => Math.round(Math.min(1, Math.max(0, p.frac)) * 100);

/** The bar's sentence: projects for a sweep, sources for one project. A total still growing carries a `+`. */
export function progressText(p: ScanProgress, one: boolean): string {
  if (one) return p.looking ? "Looking at the project" : `Reading ${p.readsDone} of ${plural(p.reads, "source")}`;
  const more = p.looking ? "+" : "";
  return `${p.done} of ${plural(p.projects, "project")} done · ${p.readsDone} of ${p.reads}${more} sources read`;
}

const label = (id: string) => id === DETECT ? "looking at it" : findSource(id)?.label ?? id;

/** What is being read this moment, `max` of them and how many more; `nameOf` adds whose, across projects. */
export function readingNow(p: ScanProgress, nameOf?: (root: string) => string, max = 2): string {
  const said = [...new Set(p.live.map((l) => nameOf ? `${label(l.source)} · ${nameOf(l.root)}` : label(l.source)))];
  if (!said.length) return "";
  return said.slice(0, max).join(", ") + (said.length > max ? ` +${said.length - max}` : "");
}

/** A card's sub while it is read: how far, and as of when its earlier answer is. */
export function readingSub(p: ScanProgress, asOf: string | null): string {
  const how = p.looking ? "looking at the project" : `reading ${p.readsDone} of ${p.reads}`;
  return asOf ? `${how} · as of ${asOf}` : `${how}…`;
}

// ---------- the header chip ----------

export type ChipTone = "bad" | "warn" | "ok" | "muted";

export interface ChipModel {
  tone: ChipTone;
  dots: Level[] | null; // a project's facets in card order; null for the fleet, which counts instead
  count: number | null; // red and amber lines (a project) or projects needing you (the fleet); null at 0
  busy: string | null; // what the spinner says while a scan of this scope is out
  frac: number | null; // its share done, for the ring
  tip: string[];
}

export interface ProjectChipIn {
  name: string; cells: readonly Cell[]; findings: readonly Finding[]; band: Band;
  past: boolean; // only the last boot's snapshot is known: muted, as of then
  when: string | null; // "checked 4m ago", "as of 2d ago"; null when nothing was ever read
  progress: ScanProgress | null;
}
export interface FleetTally { needs: number; drifting: number; quiet: number; unread: number }
export interface FleetChipIn { projects: number; tally: FleetTally | null; when: string | null; progress: ScanProgress | null }

const BAND_TONE: Record<Band, ChipTone> = { needs: "bad", drifting: "warn", quiet: "ok", unread: "muted" };
const OPEN = "Click for an overview";

/** A project on the stage: its seven facets as dots, the count of what needs you, or how far its scan is. */
export function projectChip(c: ProjectChipIn): ChipModel {
  const n = needsCount(c.findings);
  const tone: ChipTone = c.past ? "muted" : BAND_TONE[c.band];
  const busy = c.progress ? (c.progress.looking ? "…" : `${c.progress.readsDone}/${c.progress.reads}`) : null;
  const said = c.progress ? progressText(c.progress, true)
    : c.band === "unread" && !c.past && !c.when ? "not checked yet"
    : n ? `${plural(n, "thing")} ${n === 1 ? "needs" : "need"} you: ${c.findings.filter((f) => f.level !== "info").slice(0, 3).map((f) => f.text).join("; ")}`
    : c.band === "unread" ? "partly read" : "nothing needs you";
  return {
    tone, dots: c.cells.map((x) => x.level), count: n || null, busy, frac: c.progress ? c.progress.frac : null,
    tip: [`Maintenance · ${c.name}`, said, c.when ?? "", OPEN].filter(Boolean),
  };
}

/** No project on the stage: how many projects need you, or how far the sweep is. */
export function fleetChip(c: FleetChipIn): ChipModel {
  const t = c.tally;
  const tone: ChipTone = !t ? "muted" : t.needs ? "bad" : t.drifting ? "warn" : t.unread ? "muted" : "ok";
  const count = !t ? null : t.needs || t.drifting || null;
  const said = c.progress ? progressText(c.progress, false)
    : !t ? "not checked this session"
    : [t.needs && `${t.needs} need you`, t.drifting && `${t.drifting} drifting`, t.quiet && `${t.quiet} quiet`, t.unread && `${t.unread} not checked`]
      .filter(Boolean).join(" · ") || "no project";
  return {
    tone, dots: null, count, busy: c.progress ? `${c.progress.done}/${c.progress.projects}` : null, frac: c.progress ? c.progress.frac : null,
    tip: [`Maintenance · ${plural(c.projects, "project")}`, said, c.when ?? "", OPEN].filter(Boolean),
  };
}

// ---------- the popover ----------

export interface PopProject { root: string; name: string; band: Band; findings: readonly Finding[] }

/** The projects worth naming across the fleet: what needs you, then what drifts, worst first. */
export function worstProjects(rows: readonly PopProject[], max: number): { root: string; name: string; band: Band; line: string; more: number }[] {
  return rankMaint(rows.map((r) => ({ ...r, path: r.root })))
    .filter((r) => r.band === "needs" || r.band === "drifting")
    .slice(0, max)
    .map((r) => {
      const loud = r.findings.filter((f) => f.level !== "info");
      return { root: r.root, name: r.name, band: r.band, line: loud[0]?.text ?? "", more: Math.max(0, loud.length - 1) };
    });
}

/** The lines a project's popover lists: worst first (./maint's own order), `max` of them and how many more. */
export function popLines<T>(fs: readonly T[], max: number): { shown: T[]; more: number } {
  return { shown: fs.slice(0, max), more: Math.max(0, fs.length - max) };
}
