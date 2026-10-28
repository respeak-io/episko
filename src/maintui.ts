// The one prober of data-mt*: fleetui's and the dashboard's listeners call `maintClick` first,
// and a card never sits inside an fl*/dash* row, or one click fires both.
// A verb prefills an agent and never sends it: Episko presses Enter in two places only.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "./dom";
import { dlog } from "./debug";
import { verifyCommands } from "./deps";
import {
  clampMaint, coverFirst, covText, FACET_TAB, facetCell, findingTarget, offers, prodChecks, SEV_BUCKETS, tabFindings,
  type BoardId, type MaintTab, type ProjectPick, type SevBucket,
} from "./maint";
import { briefFor } from "./maintbrief";
import { askingFor, maintInput, runSource, scanProject } from "./maintscan";
import { FACETS, findSource, type Facet } from "./maintsources";
import { MAINT_CHIPS, MAINT_SUBS, tabName, type MaintChip, type MaintSub } from "./maintview";
import { openMenu } from "./menu";
import { discoverTasks, execCmd } from "./tasks";
import type { GitActionResult } from "./types";

/** What a pane hosting Maintenance does on its behalf; one object, the DashHost precedent. */
export interface MaintHost {
  scan: (force: boolean) => void; // the fleet's every project, the dashboard's one
  nameOf: (root: string) => string;
  prefill: (project: string, path: string, text: string) => void;
  openDashboard: (name: string, path: string, tab?: "today" | "maint") => void;
  // `root` undefined keeps the project filter, null clears it; the host owns both, never a nav field.
  // `board` set scrolls to that board once painted, null to the tab's top.
  openTab: (sub: MaintSub, root?: string | null, board?: BoardId | null) => void;
  picks?: (tab: MaintTab) => ProjectPick[]; // the fleet's project picker; the dashboard is one project
  render: () => void;
  openView?: (view: "deps" | "branches") => void; // a dashboard card's ⤢; the fleet draws none
  openAcross?: (sub: MaintSub) => void; // a dashboard card's way to the fleet's tab
  deploy?: (root: string, what: "propose" | "file") => void; // the Runs on card's two doors
  openCover?: () => void; // the dashboard's Coverage card, where a cell that cannot check says why
  roots: () => string[]; // the projects this pane shows: what the fleet head's Check prod asks
}

const stored = localStorage.getItem("cc-maint-chip");
export let maintChip: MaintChip = MAINT_CHIPS.includes(stored as MaintChip) ? stored as MaintChip : "all";
function setMaintChip(c: MaintChip) {
  maintChip = MAINT_CHIPS.includes(c) ? c : "all";
  localStorage.setItem("cc-maint-chip", maintChip);
}
// Not persisted: a fold you opened is a glance, and the next visit starts with the loud cards.
export let quietOpen = false;
// The Security strip's bucket, a glance like the fold: a second click on it shows every row again.
export let maintSev: SevBucket | null = null;

// Facts first: a finding whose facts have since changed is gone, and says so rather than guessing.
async function runVerb(root: string, key: string, host: MaintHost): Promise<void> {
  const inp = maintInput(root);
  const f = inp && [...tabFindings(root, inp, clampMaint(inp.det?.config.thresholds)), ...offers(root, inp)].find((x) => x.key === key);
  if (!inp || !f) { toast("That has changed since the last check. Check again"); return; }
  const name = host.nameOf(root);
  if (f.verb === "fetch") {
    try {
      const r = await invoke<GitActionResult>("git_action", { workdir: root, op: "fetch" });
      toast(r.ok ? `${name}: fetched` : `${name}: ${r.summary}`);
    } catch (e) { toast(`${name}: fetch failed: ${e}`); }
    void scanProject(root, true);
    return;
  }
  if (f.verb === "run") {
    if (askingFor(root, [f.source])) return; // already out: two audits would share one folder
    const label = findSource(f.source)?.label ?? f.source;
    toast(`${label} for ${name}…`);
    const r = await runSource(root, f.source);
    if (r.coverage.state !== "ok") toast(`${name}: ${label}: ${covText(r.coverage)}`);
    return;
  }
  // Open work lives in Today's queue; the rest of what Review means is the Maintenance tab's.
  if (f.verb === "review") { host.openDashboard(name, root, f.facet === "work" ? "today" : "maint"); return; }
  const tasks = await discoverTasks(root).catch((e) => { dlog("warn", `maint: tasks for ${root}: ${e}`); return []; });
  const verify = verifyCommands(tasks.map((x) => ({ cmd: execCmd(x), group: x.group, blocked: x.blocked })));
  const text = briefFor(f, inp, { project: name, verify });
  if (!text) { toast("That has changed since the last check. Check again"); return; }
  host.prefill(name, root, text);
}

// Every address of every project asked, each project's checks as one click-only read per source.
async function checkProd(roots: readonly string[]): Promise<void> {
  const jobs = roots.flatMap((r) => { const inp = maintInput(r); return inp ? prodChecks(inp).map((id) => [r, id] as const) : []; });
  if (!jobs.length) { toast("No project here names an address in [deploy]"); return; }
  const reps = await Promise.all(jobs.map(([r, id]) => runSource(r, id)));
  const failed = reps.filter((x) => x.coverage.state !== "ok").length;
  if (failed) toast(`Prod: ${failed} of ${reps.length} checks could not run. The Prod cell says why`);
}

const subOf = (v: string | undefined): MaintSub => MAINT_SUBS.includes(v as MaintSub) ? v as MaintSub : "overview";

const ALL = "*"; // the menu's "All projects": a root is an absolute path, never this
function pickProject(at: HTMLElement, sub: MaintSub, host: MaintHost): void {
  if (sub === "overview" || !host.picks) return;
  const cur = at.dataset.mtroot || null, picks = host.picks(sub);
  const needs = (n: number) => n ? `${n} need${n === 1 ? "s" : ""} you` : undefined;
  const tone = (p: ProjectPick) => p.level === "bad" || p.level === "warn" ? p.level : undefined;
  openMenu(at, {
    title: tabName(sub), sub: "show one project's rows",
    groups: [
      { items: [{ id: ALL, label: "All projects", mark: cur ? "" : "✓" }] },
      { label: "Projects", items: picks.map((p) => ({ id: p.root, label: p.name, mark: p.root === cur ? "✓" : "", sub: needs(p.n), tone: tone(p) })) },
    ],
    onPick: (id) => host.openTab(sub, id === ALL ? null : id),
  });
}

/** True when the click was Maintenance's. Nested controls are probed before the row holding them. */
export function maintClick(t: HTMLElement, host: MaintHost): boolean {
  const scan = t.closest<HTMLElement>("[data-mtscan]");
  if (scan) { host.scan(scan.dataset.mtscan === "force"); return true; }
  const prod = t.closest<HTMLElement>("[data-mtprod]");
  if (prod) { void checkProd(prod.dataset.mtprod ? [prod.dataset.mtprod] : host.roots()); return true; }
  const chip = t.closest<HTMLElement>("[data-mtchip]");
  if (chip) {
    if (chip.getAttribute("aria-disabled") !== "true") { setMaintChip(chip.dataset.mtchip as MaintChip); host.render(); }
    return true;
  }
  const fold = t.closest<HTMLElement>("[data-mtfold]");
  if (fold) { quietOpen = fold.dataset.mtfold === "1"; host.render(); return true; }
  const sev = t.closest<HTMLElement>("[data-mtsev]");
  if (sev) {
    const b = sev.dataset.mtsev as SevBucket;
    if (maintSev === b || !SEV_BUCKETS.includes(b)) maintSev = null;
    else if (sev.getAttribute("aria-disabled") !== "true") maintSev = b;
    host.render();
    return true;
  }
  const tab = t.closest<HTMLElement>("[data-mttab]");
  if (tab) { host.openTab(subOf(tab.dataset.mttab)); return true; }
  const pick = t.closest<HTMLElement>("[data-mtpick]");
  if (pick) { pickProject(pick, subOf(pick.dataset.mtpick), host); return true; }
  const view = t.closest<HTMLElement>("[data-mtview]");
  if (view) { host.openView?.(view.dataset.mtview === "branches" ? "branches" : "deps"); return true; }
  const across = t.closest<HTMLElement>("[data-mtacross]");
  if (across) { host.openAcross?.(subOf(across.dataset.mtacross)); return true; }
  const dep = t.closest<HTMLElement>("[data-mtdeploy]");
  if (dep) { host.deploy?.(dep.dataset.mtroot!, dep.dataset.mtdeploy === "file" ? "file" : "propose"); return true; }
  const url = t.closest<HTMLElement>("[data-mturl]");
  if (url) { void openUrl(url.dataset.mturl!).catch((e) => toast(`open failed: ${e}`)); return true; }
  const copy = t.closest<HTMLElement>("[data-mtcopy]");
  if (copy) {
    // Tauri's clipboard, never navigator.clipboard, which raises an OS permission prompt.
    const text = copy.dataset.mtcopy!;
    void writeText(text).then(() => toast("Copied")).catch(() => toast(text));
    return true;
  }
  const verb = t.closest<HTMLElement>("[data-mtverb]");
  if (verb) { void runVerb(verb.dataset.mtroot!, verb.dataset.mtverb!, host); return true; }
  // A card line, after its verb so Patch only prefills: the tab and board that line summarises.
  const find = t.closest<HTMLElement>("[data-mtfind]");
  if (find) {
    const facet = find.dataset.mtfind as Facet;
    if (!FACETS.includes(facet)) return true;
    const to = findingTarget({ facet, key: find.dataset.mtkey ?? "" });
    maintSev = null; // a severity picked earlier could hide the very rows this line counts
    host.openTab(to.tab, find.dataset.mtroot!, to.board);
    return true;
  }
  const cell = t.closest<HTMLElement>("[data-mtcell]");
  if (cell) {
    const facet = cell.dataset.mtcell as Facet, root = cell.dataset.mtroot!, inp = maintInput(root);
    if (!FACETS.includes(facet)) return true;
    if (host.openCover && inp && coverFirst(facetCell(facet, inp, clampMaint(inp.det?.config.thresholds)))) host.openCover();
    else host.openTab(FACET_TAB[facet], root);
    return true;
  }
  const proj = t.closest<HTMLElement>("[data-mtproj]");
  if (proj) { host.openDashboard(proj.dataset.mtname!, proj.dataset.mtproj!, "maint"); return true; }
  return false;
}

/** Enter or Space on a card line's text opens it as a click would; its verb is a button of its own. */
export function maintKey(e: KeyboardEvent, host: MaintHost): boolean {
  const t = e.target;
  if ((e.key !== "Enter" && e.key !== " ") || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  if (!(t instanceof HTMLElement) || !t.matches("[data-mtfind] > .t")) return false;
  e.preventDefault();
  return maintClick(t, host);
}
