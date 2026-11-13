// The header's Maintenance chip and its popover: the project on the stage (with none, every project)
// as the last scans left it, one click from its board. ./maintbadge decides what it says; this paints
// and owns the clicks. It reads ./maintscan's cache and never asks: its one scan is the popover's
// Check, a person's click (docs/maintenance.md).

import { $ } from "./dom";
import { basename, esc, escAttr, relTime } from "./format";
import { allProjects } from "./grouping";
import {
  clampMaint, facetCells, FACET_TAB, findings, findingTarget, pastCells, projectBand,
  type Band, type BoardId, type Cell, type Finding, type Level, type MaintInput,
} from "./maint";
import {
  fleetChip, popLines, progressText, projectChip, readingNow, worstProjects, type ChipModel, type FleetTally, type ScanProgress,
} from "./maintbadge";
import { fleetCheckedAt, fleetProgress, maintGen, maintInput, maintOf, maintSnap, projectProgress, scanProject } from "./maintscan";
import { facetDef, type Facet } from "./maintsources";
import { progressHtml, tabName, type MaintSub } from "./maintview";
import { activeId, dashMirror, dormants, externals, extMirrorId, pastMirrorId, reviewMirror, sessions } from "./state";
import { icon } from "./svgicons";

/** What a click here opens, which this module does not own (CLAUDE.md's host-object seam). */
export interface MaintPopHost {
  openProject: (name: string, root: string, sub?: MaintSub, board?: BoardId | null) => void; // its dashboard's Maintenance tab
  openBoard: () => void; // the fleet's Maintenance overview; choosing it is the fleet's ask
  closeMenus: () => void; // one floating menu at a time
}
let host: MaintPopHost = { openProject: () => {}, openBoard: () => {}, closeMenus: () => {} };
export function setMaintPopHost(h: MaintPopHost) { host = h; }

const LINES = 5, PROJECTS = 4;
const EMPTY: MaintInput = { det: null, reports: {}, skip: [] };

interface Row { facet: Facet; key: string; level: Level; text: string; detail: string }
interface ProjRead {
  root: string; name: string; cells: Cell[]; findings: Finding[]; band: Band;
  past: Row[] | null; // the snapshot's lines when only the last boot's words are known
  when: string | null;
}

// The project the stage is about, whatever holds it; null on the fleet and with nothing open.
function stageProject(): { root: string; name: string } | null {
  const d = dashMirror() ?? reviewMirror();
  if (d) return { root: d.root, name: d.name };
  const s = activeId ? sessions.get(activeId) : undefined;
  const ext = externals.find((x) => x.session_id === extMirrorId());
  const key = s?.colorKey ?? dormants.find((x) => x.id === pastMirrorId())?.colorKey ?? (ext ? ext.repo_root || ext.cwd : undefined);
  if (!key) return null;
  const p = allProjects().find((x) => x.path === key);
  return { root: p?.repoRoot ?? key, name: p?.name ?? s?.project ?? basename(key) };
}

// The fleet's own rule (./fleetui buildMaint): a live answer, else the last boot's snapshot, else unread.
function readProject(root: string, name: string, now: number, always: boolean): ProjRead | null {
  const e = maintOf(root), snap = e ? undefined : maintSnap(root);
  const inp = maintInput(root) ?? (always || snap ? EMPTY : null);
  if (!inp) return null;
  const th = clampMaint(inp.det?.config.thresholds);
  const cells = snap ? pastCells(snap, now) : facetCells(inp, th, now);
  const when = e?.at ? `${e.kept ? "as of" : "checked"} ${relTime(e.at)}` : snap ? `as of ${relTime(snap.at)}` : null;
  return {
    root, name, cells, band: projectBand(cells), when,
    findings: snap ? [] : findings(root, inp, th, now),
    past: snap ? snap.findings.map((f) => ({ ...f, detail: "" })) : null,
  };
}

interface Model {
  proj: ProjRead | null; projProg: ScanProgress | null;
  fleet: { projects: number; rows: ProjRead[]; tally: FleetTally | null; when: string | null; prog: ScanProgress | null };
  chip: ChipModel;
}

// renderAll runs every frame something lands, so the fleet's seven cells a project are read only when
// the cache, the stage's project, the project list or the minute changed.
let memo: { key: string; m: Model } | null = null;
function current(now: number): Model | null {
  const at = stageProject(), projects = allProjects();
  if (!projects.length && !at) return null;
  const key = [maintGen, at?.root ?? "", projects.length, fleetCheckedAt, Math.floor(now / 60_000)].join("\n");
  if (memo?.key === key) return memo.m;
  const names = new Map<string, string>();
  for (const p of projects) if (!names.has(p.repoRoot ?? p.path)) names.set(p.repoRoot ?? p.path, p.name);
  const asked = fleetCheckedAt > 0 || [...names.keys()].some((r) => maintOf(r));
  const rows = [...names].flatMap(([r, n]) => { const x = readProject(r, n, now, asked); return x ? [x] : []; });
  const count = (b: Band) => rows.filter((r) => r.band === b).length;
  const kept = Math.max(0, ...rows.map((r) => maintOf(r.root)?.kept ? maintOf(r.root)!.at : 0));
  const fleet: Model["fleet"] = {
    projects: names.size, rows, prog: fleetProgress(),
    tally: rows.length ? { needs: count("needs"), drifting: count("drifting"), quiet: count("quiet"), unread: count("unread") } : null,
    when: fleetCheckedAt ? `checked ${relTime(fleetCheckedAt)}` : kept ? `as of ${relTime(kept)}` : null,
  };
  const proj = at && readProject(at.root, at.name, now, true), projProg = at && projectProgress(at.root);
  const chip = proj
    ? projectChip({ name: proj.name, cells: proj.cells, findings: proj.findings, band: proj.band, past: !!proj.past, when: proj.when, progress: projProg })
    : fleetChip({ projects: fleet.projects, tally: fleet.tally, when: fleet.when, progress: fleet.prog });
  memo = { key, m: { proj, projProg, fleet, chip } };
  return memo.m;
}

// ---------- the chip ----------

let lastChip = "";
function chipHtml(c: ChipModel): string {
  if (c.busy) return `<span class="u-spin"></span><span class="mb-n mono">${esc(c.busy)}</span>`;
  const dots = c.dots ? `<span class="mb-dots">${c.dots.map((l) => `<i class="l-${l}"></i>`).join("")}</span>` : "";
  return `<span class="mb-ic">${icon("wrench", "solo")}</span>${dots}${c.count ? `<span class="mb-n">${c.count}</span>` : ""}`;
}

/** On renderAll's path: guarded, so an unchanged chip is never rewritten under the pointer. */
export function renderMaintBadge(): void {
  const el = $("mtBadge"), m = current(Date.now());
  if (!m) { el.className = "mt-badge"; closeMaintPop(); return; }
  const c = m.chip, cls = `mt-badge show t-${c.tone}${c.busy ? " busy" : ""}`, tip = c.tip.join("\n");
  if (el.className !== cls) el.className = cls;
  if (el.title !== tip) el.title = tip;
  const html = chipHtml(c);
  if (html !== lastChip) { lastChip = html; el.innerHTML = html; }
  if (open) paintPop(m);
}

// ---------- the popover ----------

let open = false;
let lastPop = "";
export const maintPopOpen = (): boolean => open;

const ON = (root: string, name: string) => `data-mbroot="${escAttr(root)}" data-mbname="${escAttr(name)}"`;
const goHtml = (attr: string, label: string) =>
  `<button class="pgo" ${attr} title="${escAttr(label)}" aria-label="${escAttr(label)}">${icon("externalLink", "solo")}</button>`;
const progHtml = (p: ScanProgress, one: boolean, nameOf?: (r: string) => string) =>
  progressHtml({ frac: p.frac, text: progressText(p, one), now: readingNow(p, nameOf, 1) });

function cellHtml(c: Cell, p: ProjRead, reading: boolean): string {
  const label = facetDef(c.facet).label;
  const v = c.level === "unread" ? (reading ? "…" : "—")
    : c.level === "ok" && !c.text ? `<i class="mt-dot" aria-label="healthy"></i>` : esc(c.text);
  const tip = [label, ...c.tip, `Click: ${tabName(FACET_TAB[c.facet])} for ${p.name}`].join("\n");
  return `<button class="mb-cell" data-mbfacet="${c.facet}" ${ON(p.root, p.name)} title="${escAttr(tip)}">`
    + `<span class="fk">${esc(label)}</span><span class="mt-v l-${c.level}">${v}</span></button>`;
}

function lineHtml(r: Row, p: ProjRead): string {
  return `<button class="mb-line l-${r.level}${p.past ? " past" : ""}" data-mbline="${r.facet}" data-mbkey="${escAttr(r.key)}" ${ON(p.root, p.name)}`
    + ` title="${escAttr(`Open in ${tabName(findingTarget(r).tab)}`)}"><i class="mt-sev"></i><span class="t">${esc(r.text)}</span>`
    + `<span class="d mono">${esc(r.detail)}</span></button>`;
}

function projectHtml(p: ProjRead, prog: ScanProgress | null): string {
  const rows: Row[] = p.past ?? p.findings;
  const { shown, more } = popLines(rows, LINES);
  const loud = rows.filter((r) => r.level === "bad" || r.level === "warn").length;
  const said = prog ? "" : !p.when ? "Not checked yet. Check reads it once; nothing runs in it."
    : !rows.length ? (p.band === "quiet" ? "Nothing needs you here." : "Nothing to do in what could be read.") : "";
  const lines = shown.length
    ? `<div class="mb-h">${p.past ? "As of the last check" : "To do"}${loud ? `<span class="n">${loud}</span>` : ""}</div>`
      + shown.map((r) => lineHtml(r, p)).join("")
      + (more ? `<button class="mb-more" data-mbopen="${escAttr(p.root)}" data-mbname="${escAttr(p.name)}">+${more} more in its Maintenance tab</button>` : "")
    : said ? `<p class="mb-said">${esc(said)}</p>` : "";
  const check = prog ? "" : `<button class="aslink" data-mbcheck="${escAttr(p.root)}" title="${escAttr(p.when
    ? "Check this project again, past every cache. Nothing runs in it" : "Read this project once. Nothing runs in it")}">${p.when ? "Check again" : "Check"}</button>`;
  return `<div class="up-h"><span class="mb-t">Maintenance · ${esc(p.name)}</span>`
    + goHtml(`data-mbopen="${escAttr(p.root)}" data-mbname="${escAttr(p.name)}"`, `Open ${p.name}'s Maintenance tab`) + `</div>`
    + (prog ? progHtml(prog, true) : "")
    + `<div class="mb-cells">${p.cells.map((c) => cellHtml(c, p, !!prog)).join("")}</div>`
    + lines
    + `<div class="mb-foot"><span class="mono">${esc(prog ? "reading…" : p.when ?? "never checked")}</span>${check}</div>`;
}

function fleetHtml(f: Model["fleet"], head: boolean): string {
  const t = f.tally, nameOf = (r: string) => f.rows.find((x) => x.root === r)?.name ?? basename(r);
  const top = head
    ? `<div class="up-h"><span class="mb-t">Maintenance · all projects</span>${goHtml(`data-mbboard="1"`, "Open the Maintenance board")}</div>`
    : `<div class="mb-h mb-h2">All projects<span class="w mono">${esc(f.when ?? "")}</span></div>`;
  const tally = !t ? `<p class="mb-said">Not checked this session. The board reads every project once; nothing runs in them.</p>`
    : `<div class="mb-tally">${[["needs", t.needs, "need you", "l-bad"], ["drifting", t.drifting, "drifting", "l-warn"], ["quiet", t.quiet, "quiet", ""], ["unread", t.unread, "not checked", ""]]
      .filter(([, n]) => n).map(([, n, w, cls]) => `<span class="${cls}"><b>${n}</b> ${w}</span>`).join("")}${head && f.when ? `<span class="w mono">${esc(f.when)}</span>` : ""}</div>`;
  const worst = worstProjects(f.rows, PROJECTS).map((w) => `<button class="mb-proj" data-mbproj="${escAttr(w.root)}" data-mbname="${escAttr(w.name)}"`
    + ` title="${escAttr(`Open ${w.name}'s Maintenance tab`)}"><i class="mt-sev ${w.band === "needs" ? "l-bad" : "l-warn"}"></i>`
    + `<span class="nm">${esc(w.name)}</span><span class="t">${esc(w.line)}</span>${w.more ? `<span class="d mono">+${w.more}</span>` : ""}</button>`).join("");
  return top + (f.prog ? progHtml(f.prog, false, nameOf) : "") + tally + worst
    + `<button class="mb-board" data-mbboard="1">${icon("layoutGrid")}Open the Maintenance board</button>`;
}

function paintPop(m: Model): void {
  const html = (m.proj ? projectHtml(m.proj, m.projProg) : "") + fleetHtml(m.fleet, !m.proj);
  // innerHTML guard: an assignment between mousedown and mouseup drops the click (docs/architecture.md).
  if (html === lastPop) return;
  lastPop = html;
  const pop = $("mtPop"), at = pop.scrollTop;
  pop.innerHTML = html;
  pop.scrollTop = at;
}

export function openMaintPop(): void {
  const m = current(Date.now());
  if (!m) return;
  host.closeMenus();
  open = true;
  lastPop = ""; // a fresh open always paints
  paintPop(m);
  const r = $("mtBadge").getBoundingClientRect(), pop = $("mtPop");
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  pop.style.left = "auto";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
export function closeMaintPop(): void { open = false; $("mtPop").classList.remove("show"); }

/** main.ts, once: the chip's toggle and the popover's own listener. */
export function wireMaintPop(): void {
  $("mtBadge").addEventListener("click", (e) => {
    e.stopPropagation();
    if (open) closeMaintPop(); else openMaintPop();
  });
  // Check stays: you watch it read. Everything else goes somewhere, so the popover closes behind it.
  $("mtPop").addEventListener("click", popClick);
}

function popClick(e: MouseEvent): void {
  const t = e.target as HTMLElement;
  const chk = t.closest<HTMLElement>("[data-mbcheck]");
  if (chk) { e.stopPropagation(); const r = chk.dataset.mbcheck!; void scanProject(r, !!maintOf(r)?.at); return; }
  const go = t.closest<HTMLElement>("[data-mbopen]");
  if (go) { closeMaintPop(); host.openProject(go.dataset.mbname!, go.dataset.mbopen!); return; }
  const line = t.closest<HTMLElement>("[data-mbline]");
  if (line) {
    const to = findingTarget({ facet: line.dataset.mbline as Facet, key: line.dataset.mbkey! });
    closeMaintPop();
    host.openProject(line.dataset.mbname!, line.dataset.mbroot!, to.tab, to.board);
    return;
  }
  const cell = t.closest<HTMLElement>("[data-mbfacet]");
  if (cell) { closeMaintPop(); host.openProject(cell.dataset.mbname!, cell.dataset.mbroot!, FACET_TAB[cell.dataset.mbfacet as Facet]); return; }
  const proj = t.closest<HTMLElement>("[data-mbproj]");
  if (proj) { closeMaintPop(); host.openProject(proj.dataset.mbname!, proj.dataset.mbproj!); return; }
  const board = t.closest<HTMLElement>("[data-mbboard]");
  if (board) { closeMaintPop(); host.openBoard(); }
}
