// The one prober of data-mt*: fleetui's and the dashboard's listeners call `maintClick` first,
// and a card never sits inside an fl*/dash* row, or one click fires both.
// A verb prefills an agent and never sends it: Episko presses Enter in two places only.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./dom";
import { dlog } from "./debug";
import { verifyCommands } from "./deps";
import { clampMaint, covText, FACET_TAB, offers, prodChecks, tabFindings } from "./maint";
import { briefFor } from "./maintbrief";
import { askingFor, maintInput, runSource, scanProject } from "./maintscan";
import { FACETS, findSource, type Facet } from "./maintsources";
import { MAINT_CHIPS, MAINT_SUBS, type MaintChip, type MaintSub } from "./maintview";
import { discoverTasks, execCmd } from "./tasks";
import type { GitActionResult } from "./types";

/** What a pane hosting Maintenance does on its behalf; one object, the DashHost precedent. */
export interface MaintHost {
  scan: (force: boolean) => void; // the fleet's every project, the dashboard's one
  nameOf: (root: string) => string;
  prefill: (project: string, path: string, text: string) => void;
  openDashboard: (name: string, path: string, tab?: "today" | "maint") => void;
  // `root` undefined keeps the project filter, null clears it; the host owns both, never a nav field.
  openTab: (sub: MaintSub, root?: string | null) => void;
  render: () => void;
  openView?: (view: "deps" | "branches") => void; // a dashboard card's ⤢; the fleet draws none
  openAcross?: (sub: MaintSub) => void; // a dashboard card's way to the fleet's tab
  deploy?: (root: string, what: "propose" | "file") => void; // the Runs on card's two doors
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
  const tab = t.closest<HTMLElement>("[data-mttab]");
  if (tab) { host.openTab(subOf(tab.dataset.mttab)); return true; }
  const clear = t.closest<HTMLElement>("[data-mtclear]");
  if (clear) { host.openTab(subOf(clear.dataset.mtclear), null); return true; }
  const view = t.closest<HTMLElement>("[data-mtview]");
  if (view) { host.openView?.(view.dataset.mtview === "branches" ? "branches" : "deps"); return true; }
  const across = t.closest<HTMLElement>("[data-mtacross]");
  if (across) { host.openAcross?.(subOf(across.dataset.mtacross)); return true; }
  const dep = t.closest<HTMLElement>("[data-mtdeploy]");
  if (dep) { host.deploy?.(dep.dataset.mtroot!, dep.dataset.mtdeploy === "file" ? "file" : "propose"); return true; }
  const verb = t.closest<HTMLElement>("[data-mtverb]");
  if (verb) { void runVerb(verb.dataset.mtroot!, verb.dataset.mtverb!, host); return true; }
  const cell = t.closest<HTMLElement>("[data-mtcell]");
  if (cell) {
    const facet = cell.dataset.mtcell as Facet;
    if (FACETS.includes(facet)) host.openTab(FACET_TAB[facet], cell.dataset.mtroot!);
    return true;
  }
  const proj = t.closest<HTMLElement>("[data-mtproj]");
  if (proj) { host.openDashboard(proj.dataset.mtname!, proj.dataset.mtproj!, "maint"); return true; }
  return false;
}
