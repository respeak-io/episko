// The fleet screen: the pane, its two reads and its delegated clicks. ./fleet owns the rules
// and ./fleetview the markup. Nothing here runs until ▦ is clicked. See docs/dashboard.md.

import { invoke } from "@tauri-apps/api/core";
import { $, clearStageBadges, setHeadPath, takeStage } from "./dom";
import { dlog } from "./debug";
import { refreshDirtyStates } from "./mirror";
import { relTime } from "./format";
import { projectCost } from "./dash";
import {
  fleetCards, fleetSorted, fleetTally,
  type FleetCard, type FleetSort, type FleetTally,
} from "./fleet";
import {
  fleetBodyHtml, fleetHeadHtml,
  type FleetExtra, type FleetResume, type FleetRow, type FleetSpendRow, type FleetUsage, type FleetView,
} from "./fleetview";
import { allProjects, attnPending, needsYouSessions, orderedSessions, urgencyRank, type ProjGroup } from "./grouping";
import type { HistEntry } from "./history";
import { forecast5h, forecast7d } from "./rl";
import { GCLASS, GLYPH } from "./sidebarview";
import { accentFor, dirtyByFolder, dormants, fleetMirror, sessions, setActiveId, setMirror } from "./state";
import type { TrailCommit } from "./trail";
import { phaseText, statusKey, type Sess } from "./types";
import { modelSeries, uDkey, uModels, usageDetail, usageWindow, uSum, type UDay } from "./usage";

// What this pane does but does not own; one host object rather than four setters, so nothing
// here imports main.ts or ./panes (the DashHost precedent).
export interface FleetHost {
  setActive: (id: string) => void;
  closeSession: (id: string) => void;
  openDashboard: (project: string, path: string) => void;
  renderAll: () => void;
}
let host: FleetHost = { setActive: () => {}, closeSession: () => {}, openDashboard: () => {}, renderAll: () => {} };
export function setFleetHost(h: FleetHost) { host = h; }

const FLEET_DAYS = 30;   // one window for both halves, so "last 30 days" means one thing here
const SPARK_DAYS = 14;   // the shape on a project card
const HIST_LIMIT = 400;  // the machine-global transcript scan, as ./dashboard reads it
const COST_ROWS = 6;     // the view caps nothing; the costliest few are the whole point

// ---------- preferences ----------
const SORTS: FleetSort[] = ["attention", "recent", "name"];
const stored = localStorage.getItem("cc-fleet-sort");
export let fleetSort: FleetSort = SORTS.includes(stored as FleetSort) ? stored as FleetSort : "attention";
export function setFleetSort(s: FleetSort) {
  fleetSort = SORTS.includes(s) ? s : "attention";
  localStorage.setItem("cc-fleet-sort", fleetSort);
  renderFleet();
}

// ---------- what the two reads left behind ----------
let commits: TrailCommit[] = [];
let hist: HistEntry[] = [];
let fetchedAt = 0;
let loading = false;

async function loadFleet(): Promise<void> {
  const roots = [...new Set(allProjects().map((p) => p.repoRoot ?? p.path))];
  loading = true;
  renderFleet();
  const [c, h] = await Promise.all([
    invoke<TrailCommit[]>("git_log_days", { roots, days: FLEET_DAYS }).catch((e) => {
      dlog("warn", `fleet: commit scan failed: ${e}`);
      return [] as TrailCommit[];
    }),
    invoke<HistEntry[]>("list_session_history", { limit: HIST_LIMIT }).catch((e) => {
      dlog("warn", `fleet: history scan failed: ${e}`);
      return [] as HistEntry[];
    }),
  ]);
  // The stage is the guard, as `root() !== r` is on the dashboard: an answer that outlived
  // the screen must not repaint it, and the next open reloads anyway.
  if (!fleetMirror()) return;
  commits = c;
  hist = h;
  fetchedAt = Date.now();
  loading = false;
  renderFleet();
}

// ---------- building the view ----------
// One pass over every project's commits rather than one per card: this runs on renderAll's
// coalesced path. Bucketed by day KEY, so a DST boundary cannot shift a commit a bin over.
function sparks(now: number): Map<string, number[]> {
  const idx = new Map<string, number>();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  for (let i = SPARK_DAYS - 1; i >= 0; i--) {
    const d = new Date(midnight); d.setDate(d.getDate() - i);
    idx.set(uDkey(d), SPARK_DAYS - 1 - i);
  }
  const out = new Map<string, number[]>();
  for (const c of commits) {
    const i = idx.get(uDkey(new Date(c.when * 1000)));
    if (i === undefined) continue;
    let bins = out.get(c.root);
    if (!bins) { bins = new Array<number>(SPARK_DAYS).fill(0); out.set(c.root, bins); }
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

function fleetUsage(cards: FleetCard[], win: UDay[]): FleetUsage {
  // One row per NAME, and the figure is taken once rather than summed: `costFor` already
  // merged every card of that basename, so a second row would print the same money twice.
  const byName = new Map<string, FleetSpendRow>();
  for (const c of cards) {
    if (c.spend > 0 && !byName.has(c.name)) byName.set(c.name, { name: c.name, accent: c.accent, spend: c.spend });
  }
  const projects: FleetSpendRow[] = [...byName.values()]
    .sort((a, b) => b.spend - a.spend).slice(0, COST_ROWS);
  return {
    days: FLEET_DAYS, spend: uSum(win, (d) => d.cost), tokens: uSum(win, (d) => d.tok),
    daily: win.map((d) => d.cost), models: modelSeries(uModels(win)), projects,
  };
}

function buildView(now: number): { view: FleetView; tally: FleetTally } {
  // `allProjects`, not `projectList`: the fleet is one card per project, and the toplevel
  // grouping splits a repo per worktree while `git_log_days` dedupes it back to one root.
  const projects = allProjects();
  const win = usageWindow(FLEET_DAYS);
  const cost = new Map<string, number>();
  const costFor = (name: string): number => {
    let v = cost.get(name);
    if (v === undefined) { v = uSum(win, (d) => projectCost(usageDetail, d.key, name)); cost.set(name, v); }
    return v;
  };
  // `dirtyByFolder` itself, never `folderDirty`: an unswept folder must read as unread.
  const cards = fleetSorted(fleetCards({
    projects, commits, hist, dirty: dirtyByFolder, costFor,
    attnPending, urgency: urgencyRank, now,
  }), fleetSort);
  const spark = sparks(now);
  const extra: Record<string, FleetExtra> = {};
  for (const p of projects) {
    extra[p.path] = {
      glyphs: p.sessions.map((s) => ({
        id: s.id, glyph: GLYPH[statusKey(s)] ?? "○", cls: GCLASS[statusKey(s)] ?? "g-idle",
        title: `${s.title || s.branch || "session"} · ${phaseText(s)}`,
      })),
      spark: spark.get(p.repoRoot ?? p.path) ?? [],
    };
  }
  const resume: FleetResume[] = [...dormants]
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .map((d) => ({
      path: d.colorKey, name: d.project, accent: accentFor(d.colorKey),
      label: d.title || d.branch || "session", when: d.lastActivity,
    }));
  const view: FleetView = {
    cards, extra, shared: sharedNames(projects),
    // `syncAttn` is main.ts's, once a paint: this only reads the set it stamped.
    needs: needsYouSessions().map((s) => rowOf(s, s.attention || phaseText(s), s.attnAt)),
    live: orderedSessions().map((s) => rowOf(s, liveNote(s), s.phaseSince)),
    resume,
    usage: fleetUsage(cards, win),
    limits: { h5: forecast5h(), d7: forecast7d() },
  };
  return { view, tally: fleetTally(cards) };
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
  const { view, tally } = buildView(Date.now());
  const when = loading ? "reading every project…"
    : fetchedAt ? `commits read ${relTime(fetchedAt)}` : "";
  // One `forecast7d()` for the head figure and the weekly bar, so the two cannot disagree.
  paint("fleetHead", fleetHeadHtml(tally, fleetSort, when, view.usage, view.limits.d7));
  paint("fleetBody", fleetBodyHtml(view));
  $("fleetPane").setAttribute("aria-busy", loading ? "true" : "false");
}

// Every stage taker owns the whole top bar, or the previous stage's survives under this one:
// ✕ closes the fleet (main.ts's btnClose arm), ⇩ is a session verb, and the fleet names no
// project, branch or folder of its own.
export function renderFleetHeader(): void {
  clearStageBadges();
  ($("btnClose") as HTMLButtonElement).hidden = false;
  ($("btnShelve") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = "All projects";
  const hb = $("hBranch");
  hb.classList.remove("ext-chip", "drifted"); hb.title = ""; hb.hidden = true;
  $("hTitle").textContent = "";
  setHeadPath("");
}

// ---------- open / close ----------
export function openFleet(): void {
  setMirror({ kind: "fleet" });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("fleet");
  host.renderAll();   // paints the header too, as openDashboard's does
  void loadFleet();
  // Forced: most of these folders are cached from an earlier sweep and would be skipped,
  // so the dirty column would sit at "not read" until the 15s gate opened.
  void refreshDirtyStates(true);
}

export function closeFleet(): void {
  if (!fleetMirror()) return;
  setMirror(null);
  takeStage("none");
}

// ---------- events ----------
// One delegated listener, bound once: the markup is rebuilt wholesale on every change.
export function wireFleet(): void {
  $("fleetPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const sort = t.closest<HTMLElement>("[data-flsort]");
    if (sort) { setFleetSort(sort.dataset.flsort as FleetSort); return; }

    // The ✕ is a child of the row carrying data-flsel, so it is probed first or the row
    // swallows it; the project card is its own whole background, so it is probed last.
    const close = t.closest<HTMLElement>("[data-flclose]");
    if (close) { host.closeSession(close.dataset.flclose!); return; }
    const sel = t.closest<HTMLElement>("[data-flsel]");
    if (sel) { host.setActive(sel.dataset.flsel!); return; }
    const proj = t.closest<HTMLElement>("[data-flproj]");
    if (proj) { host.openDashboard(proj.dataset.flname!, proj.dataset.flproj!); return; }
  });
}
