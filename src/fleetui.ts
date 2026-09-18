// The fleet screen: the pane, its reads and its delegated clicks. ./fleet owns the rules and
// ./fleetview the markup. It is the home stage, reached from the Episko logo. See docs/dashboard.md.

import { invoke } from "@tauri-apps/api/core";
import { $, clearStageBadges, setHeadPath, takeStage } from "./dom";
import { dlog } from "./debug";
import { openExternal, refreshDirtyStates } from "./mirror";
import { basename, fmtDay, fmtDayLong, relTime } from "./format";
import { projectCost } from "./dash";
import {
  FLEET_RANGES, fleetCards, fleetSorted, fleetTally, needsSplit,
  type FleetCard, type FleetSort, type NeedKind,
} from "./fleet";
import {
  fleetBodyHtml, fleetHeadHtml,
  type FleetExtra, type FleetLayout, type FleetModel, type FleetResume, type FleetRow,
  type FleetSpendRow, type FleetUsage, type FleetView,
} from "./fleetview";
import {
  allProjects, attnPending, needsYouSessions, orderedSessions, reactorState, urgencyRank, type ProjGroup,
} from "./grouping";
import type { HistEntry } from "./history";
import { forecast5h, forecast7d } from "./rl";
import { extWorking, GCLASS, GLYPH } from "./sidebarview";
import {
  accentFor, activeId, dirtyByFolder, dormants, externals, fleetMirror, sessions, setActiveId, setMirror,
} from "./state";
import type { TrailCommit } from "./trail";
import { phaseText, statusKey, type ExtSession, type Sess, type WtHead } from "./types";
import { modelSeries, uDkey, uModels, usage, usageDetail, usageWindow, uSum, type UDay } from "./usage";

// What this pane does but does not own; one host object rather than six setters, so nothing
// here imports main.ts or ./panes (the DashHost precedent).
export interface FleetHost {
  setActive: (id: string) => void;
  closeSession: (id: string) => void;
  openDashboard: (project: string, path: string) => void;
  openUsage: () => void;
  openHistory: () => void;
  // The machine-wide token scan. It lives behind the Usage window, which is where it used to
  // be triggered from — so until one was opened, this screen's token half was blank.
  refreshUsage: () => void;
  renderAll: () => void;
}
let host: FleetHost = {
  setActive: () => {}, closeSession: () => {}, openDashboard: () => {},
  openUsage: () => {}, openHistory: () => {}, refreshUsage: () => {}, renderAll: () => {},
};
export function setFleetHost(h: FleetHost) { host = h; }

const HIST_LIMIT = 400;  // the machine-global transcript scan, as ./dashboard reads it
// This screen is the home stage, so it is arrived at on every session close and every step
// out of a mirror. A return home is not a refresh: inside this window the reads are skipped.
const FLEET_FRESH_MS = 15_000;
const COST_ROWS = 6;     // the view caps nothing; the costliest few are the whole point

// ---------- preferences ----------
const SORTS: FleetSort[] = ["attention", "recent", "name"];
const storedSort = localStorage.getItem("cc-fleet-sort");
export let fleetSort: FleetSort = SORTS.includes(storedSort as FleetSort) ? storedSort as FleetSort : "attention";
export function setFleetSort(s: FleetSort) {
  fleetSort = SORTS.includes(s) ? s : "attention";
  localStorage.setItem("cc-fleet-sort", fleetSort);
  renderFleet();
}
const storedLayout = localStorage.getItem("cc-fleet-layout");
export let fleetLayout: FleetLayout = storedLayout === "list" ? "list" : "cards";
export function setFleetLayout(l: FleetLayout) {
  fleetLayout = l === "list" ? "list" : "cards";
  localStorage.setItem("cc-fleet-layout", fleetLayout);
  renderFleet();
}
// One window for every figure on the screen, so "last 7 days" means one thing across it.
const storedRange = Number(localStorage.getItem("cc-fleet-range"));
export let fleetRange: number = FLEET_RANGES.includes(storedRange as 7 | 14 | 30) ? storedRange : 7;
export function setFleetRange(n: number) {
  if (!FLEET_RANGES.includes(n as 7 | 14 | 30) || n === fleetRange) return;
  fleetRange = n;
  localStorage.setItem("cc-fleet-range", String(n));
  void loadFleet();   // the commit scan is the range's, so it is re-read rather than re-sliced
}

// ---------- what the reads left behind ----------
let commits: TrailCommit[] = [];
let hist: HistEntry[] = [];
let heads = new Map<string, WtHead[]>();
let fetchedAt = 0;
let loading = false;
// Which load owns `loading`. A range change starts a second one over the first, and only the
// newest may clear the flag: an abandoned load that cleared it would take the spinner off a
// screen that is still reading (./dashboard guards the same way, on the root it asked about).
let loadSeq = 0;

async function loadFleet(): Promise<void> {
  const seq = ++loadSeq;
  const roots = [...new Set(allProjects().map((p) => p.repoRoot ?? p.path))];
  const days = fleetRange;
  loading = true;
  renderFleet();
  // `worktree_heads` spawns no git (it reads .git/), so a branch chip per project is a file
  // read each rather than a process each; a folder that is not a repo answers with nothing.
  const [c, h, hd] = await Promise.all([
    invoke<TrailCommit[]>("git_log_days", { roots, days }).catch((e) => {
      dlog("warn", `fleet: commit scan failed: ${e}`);
      return [] as TrailCommit[];
    }),
    invoke<HistEntry[]>("list_session_history", { limit: HIST_LIMIT }).catch((e) => {
      dlog("warn", `fleet: history scan failed: ${e}`);
      return [] as HistEntry[];
    }),
    Promise.all(roots.map(async (r) =>
      [r, await invoke<WtHead[]>("worktree_heads", { dir: r }).catch(() => [] as WtHead[])] as const)),
  ]);
  // A newer load has taken the flag (the range changed mid-flight): it will clear it and paint
  // its own answer, so this one drops its result and leaves `loading` alone.
  if (seq !== loadSeq) return;
  // Cleared BEFORE the stage guard below, or leaving the screen mid-load strands the flag and
  // the fleet says "reading every project…" for the whole of `FLEET_FRESH_MS` on the next open,
  // which short-circuits the reload that would have fixed it.
  loading = false;
  // The stage is the guard, as `root() !== r` is on the dashboard: an answer that outlived
  // the screen must not repaint it, and the next open reloads anyway — `fetchedAt` is left
  // unset here, which is what makes that reload happen rather than read as fresh.
  if (!fleetMirror()) return;
  commits = c;
  hist = h;
  heads = new Map(hd);
  fetchedAt = Date.now();
  renderFleet();
}

// ---------- building the view ----------
// One pass over every project's commits rather than one per card: this runs on renderAll's
// coalesced path. Bucketed by day KEY, so a DST boundary cannot shift a commit a bin over.
function sparks(now: number, days: number): Map<string, number[]> {
  const idx = new Map<string, number>();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(midnight); d.setDate(d.getDate() - i);
    idx.set(uDkey(d), days - 1 - i);
  }
  const out = new Map<string, number[]>();
  for (const c of commits) {
    const i = idx.get(uDkey(new Date(c.when * 1000)));
    if (i === undefined) continue;
    let bins = out.get(c.root);
    if (!bins) { bins = new Array<number>(days).fill(0); out.set(c.root, bins); }
    bins[i]++;
  }
  return out;
}

// `note` is this module's wording: the view invents no sentence, so a provider with no phase
// says only what it has.
const rowOf = (s: Sess, note: string, since: number): FleetRow => ({
  id: s.id, project: s.project, accent: accentFor(s.colorKey),
  label: s.title || s.branch || "session",
  glyph: GLYPH[statusKey(s)] ?? "○", cls: GCLASS[statusKey(s)] ?? "g-idle",
  note, since,
});
const liveNote = (s: Sess) =>
  s.ctxPct != null ? `${phaseText(s)} · ${Math.round(s.ctxPct)}% ctx` : phaseText(s);

// A session running in somebody else's terminal. There is no phase behind it — the registry
// says working or not and nothing more — so the row invents none, exactly as the sidebar's does.
const extRowOf = (e: ExtSession, project: string): FleetRow => ({
  id: e.session_id, project, accent: accentFor(e.repo_root || e.cwd),
  label: e.name || basename(e.cwd),
  glyph: extWorking(e) ? "●" : "○", cls: extWorking(e) ? "g-work" : "g-idle",
  note: `outside Episko · claude v${e.version}`, since: (e.status_updated_at ?? 0) * 1000,
  ext: true,
});
const extGlyph = (e: ExtSession) => ({
  id: e.session_id, glyph: extWorking(e) ? "●" : "○", cls: extWorking(e) ? "g-work" : "g-idle",
  title: `${e.name || basename(e.cwd)} · running outside Episko`,
});

// Spend is recorded by project NAME, so two roots of one basename sum into one figure that
// cannot be un-merged afterwards. Naming them is what lets the card's tooltip say so.
function sharedNames(projects: ProjGroup[]): string[] {
  const roots = new Map<string, Set<string>>();
  for (const p of projects) {
    let s = roots.get(p.name);
    if (!s) { s = new Set(); roots.set(p.name, s); }
    s.add(p.path);
  }
  return [...roots].filter(([, s]) => s.size > 1).map(([n]) => n);
}

// Tokens come from the token days and money from `cc-usage-detail`, both keyed by the same
// display name, so the mix and the bill on one row are the same model.
function fleetModels(win: UDay[]): FleetModel[] {
  const cost: Record<string, number> = {};
  for (const d of win) {
    for (const [k, v] of Object.entries(usageDetail[d.key]?.models ?? {})) cost[k] = (cost[k] || 0) + v;
  }
  return modelSeries(uModels(win)).map((r) => ({ ...r, cost: cost[r.name] ?? 0 }));
}

// The newest day the ledger holds anything for, whatever the window is. An empty column with
// two months of records behind it is a different answer from one with no records at all.
function lastSpendDay(): string {
  const days = Object.keys(usage).filter((k) => usage[k] > 0).sort();
  const last = days[days.length - 1];
  return last ? fmtDay(new Date(last + "T00:00:00").getTime()) : "";
}

function fleetUsage(cards: FleetCard[], win: UDay[], days: number): FleetUsage {
  // One row per NAME, and the figure is taken once rather than summed: `costFor` already
  // merged every card of that basename, so a second row would print the same money twice.
  const byName = new Map<string, FleetSpendRow>();
  for (const c of cards) {
    if (c.spend > 0 && !byName.has(c.name)) byName.set(c.name, { name: c.name, accent: c.accent, spend: c.spend });
  }
  const projects: FleetSpendRow[] = [...byName.values()]
    .sort((a, b) => b.spend - a.spend).slice(0, COST_ROWS);
  return {
    days, spend: uSum(win, (d) => d.cost), today: win[win.length - 1]?.cost ?? 0,
    tokens: uSum(win, (d) => d.tok), cached: uSum(win, (d) => d.u?.cache_read ?? 0),
    daily: win.map((d) => d.cost),
    first: win.length ? fmtDay(new Date(win[0].key + "T00:00:00").getTime()) : "",
    lastSpend: lastSpendDay(),
    models: fleetModels(win), projects,
  };
}

function buildView(now: number): FleetView {
  // `allProjects`, not `projectList`: the fleet is one card per project, and the toplevel
  // grouping splits a repo per worktree while `git_log_days` dedupes it back to one root.
  const projects = allProjects();
  const days = fleetRange;
  const win = usageWindow(days);
  const cost = new Map<string, number>();
  const costFor = (name: string): number => {
    let v = cost.get(name);
    if (v === undefined) { v = uSum(win, (d) => projectCost(usageDetail, d.key, name)); cost.set(name, v); }
    return v;
  };
  // `dirtyByFolder` itself, never `folderDirty`: an unswept folder must read as unread.
  const cards = fleetSorted(fleetCards({
    projects, commits, hist, heads, dirty: dirtyByFolder, costFor,
    attnPending, urgency: urgencyRank, days, now,
  }), fleetSort);
  const spark = sparks(now, days);
  const projectOf = new Map(projects.map((p) => [p.path, p.name]));
  const extra: Record<string, FleetExtra> = {};
  for (const p of projects) {
    extra[p.path] = {
      glyphs: [
        ...p.sessions.map((s) => ({
          id: s.id, glyph: GLYPH[statusKey(s)] ?? "○", cls: GCLASS[statusKey(s)] ?? "g-idle",
          title: `${s.title || s.branch || "session"} · ${phaseText(s)}`,
        })),
        ...p.externals.map(extGlyph),
      ],
      spark: spark.get(p.repoRoot ?? p.path) ?? [],
    };
  }
  const resume: FleetResume[] = [...dormants]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((d) => ({
      path: d.colorKey, name: d.project, accent: accentFor(d.colorKey),
      label: d.title || d.branch || "session", when: d.lastActivity,
    }));
  // `syncAttn` is main.ts's, once a paint: this only reads the set it stamped.
  const waiting = needsYouSessions();
  return {
    cards, extra, shared: sharedNames(projects),
    sort: fleetSort, layout: fleetLayout, range: days,
    today: fmtDayLong(now),
    when: loading ? "reading every project…" : fetchedAt ? `refreshed ${relTime(fetchedAt)}` : "",
    tally: fleetTally(cards),
    needsNote: needsSplit(waiting.map((s) => reactorState(s) as NeedKind)),
    needs: waiting.map((s) => rowOf(s, s.attention || phaseText(s), s.attnAt)),
    live: [
      ...orderedSessions().map((s) => rowOf(s, liveNote(s), s.phaseSince)),
      // Ours first: a pane you can drive outranks a terminal you can only look into.
      ...externals.map((e) => extRowOf(e, projectOf.get(e.repo_root || e.cwd) ?? basename(e.cwd))),
    ],
    resume,
    usage: fleetUsage(cards, win, days),
    limits: { h5: forecast5h(), d7: forecast7d() },
  };
}

// ---------- render ----------
// Assign only when the markup changed: `renderFleet` is on `renderAll`'s path, and an
// `innerHTML` assignment destroys the node under the pointer (docs/architecture.md).
const painted = new Map<string, string>();
function paint(id: string, html: string): void {
  if (painted.get(id) === html) return;
  painted.set(id, html);
  $(id).innerHTML = html;
}

export function renderFleet(): void {
  if (!fleetMirror()) return;
  const view = buildView(Date.now());
  // One `forecast7d()` for the head tile and the limits meter, so the two cannot disagree.
  paint("fleetHead", fleetHeadHtml(view));
  paint("fleetBody", fleetBodyHtml(view));
  $("fleetPane").setAttribute("aria-busy", loading ? "true" : "false");
}

// Every stage taker owns the whole top bar, or the previous stage's survives under this one:
// ✕ closes the fleet (main.ts's btnClose arm), ⇩ is a session verb, and the fleet names no
// project, branch or folder of its own.
export function renderFleetHeader(): void {
  clearStageBadges();
  const xb = $("btnClose") as HTMLButtonElement;
  xb.hidden = !backTo();
  xb.title = "Back to the session you left";
  ($("btnShelve") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = "All projects";
  const hb = $("hBranch");
  hb.classList.remove("ext-chip", "drifted"); hb.title = ""; hb.hidden = true;
  $("hTitle").textContent = "";
  setHeadPath("");
}

// ---------- open / close ----------
// The pane this screen was opened from, so ✕ is a way back rather than a way out. It is
// `activeId` at the moment of opening, which is null whenever the fleet is the home stage.
let cameFrom: string | null = null;
function backTo(): string | null {
  if (cameFrom && sessions.has(cameFrom)) return cameFrom;
  return orderedSessions()[0]?.id ?? null;
}

export function openFleet(force = false): void {
  cameFrom = activeId;
  setMirror({ kind: "fleet" });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("fleet");
  host.renderAll();   // paints the header too, as openDashboard's does
  if (!force && fetchedAt && Date.now() - fetchedAt < FLEET_FRESH_MS) return;
  void loadFleet();
  host.refreshUsage();   // throttled to ten minutes of its own; the column paints meanwhile
  // Forced: most of these folders are cached from an earlier sweep and would be skipped,
  // so the dirty column would sit at "not read" until the 15s gate opened.
  void refreshDirtyStates(true);
}

// ✕ and Escape, and neither can empty the stage: with no session to go back to this screen
// IS the home stage, so it stays and `renderFleetHeader` offers no ✕ at all.
export function closeFleet(): void {
  if (!fleetMirror()) return;
  const back = backTo();
  if (!back) return;
  setMirror(null);
  host.setActive(back);
}

// ---------- events ----------
// One delegated listener, bound once: the markup is rebuilt wholesale on every change.
export function wireFleet(): void {
  $("fleetPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>("[data-flsort]");
    if (sort) { setFleetSort(sort.dataset.flsort as FleetSort); return; }
    const range = t.closest<HTMLElement>("[data-flrange]");
    if (range) { setFleetRange(Number(range.dataset.flrange)); return; }
    const layout = t.closest<HTMLElement>("[data-fllayout]");
    if (layout) { setFleetLayout(layout.dataset.fllayout as FleetLayout); return; }
    const open = t.closest<HTMLElement>("[data-flopen]");
    if (open) { open.dataset.flopen === "usage" ? host.openUsage() : host.openHistory(); return; }

    // The ✕ is a child of the row carrying data-flsel, so it is probed first or the row
    // swallows it; the project card is its own whole background, so it is probed last.
    const close = t.closest<HTMLElement>("[data-flclose]");
    if (close) { host.closeSession(close.dataset.flclose!); return; }
    const sel = t.closest<HTMLElement>("[data-flsel]");
    if (sel) { host.setActive(sel.dataset.flsel!); return; }
    const ext = t.closest<HTMLElement>("[data-flext]");
    if (ext) { openExternal(ext.dataset.flext!); host.renderAll(); return; }
    const proj = t.closest<HTMLElement>("[data-flproj]");
    if (proj) { host.openDashboard(proj.dataset.flname!, proj.dataset.flproj!); return; }
  });
}
