// The one prober of data-mt*: fleetui's listener (and, from slice 8, the dashboard's) calls
// `maintClick` first, and a card never sits inside an fl*/dash* row, or one click fires both.
// A verb prefills an agent and never sends it: Episko presses Enter in two places only.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./dom";
import { dlog } from "./debug";
import { verifyCommands } from "./deps";
import { clampMaint, findings } from "./maint";
import { briefFor } from "./maintbrief";
import { maintInput, runSource, scanProject } from "./maintscan";
import { MAINT_CHIPS, type MaintChip } from "./maintview";
import { discoverTasks, execCmd } from "./tasks";
import type { GitActionResult } from "./types";

/** What a pane hosting Maintenance does on its behalf; one object, the DashHost precedent. */
export interface MaintHost {
  scan: (force: boolean) => void; // the fleet's every project, the dashboard's one
  nameOf: (root: string) => string;
  prefill: (project: string, path: string, text: string) => void;
  openDashboard: (name: string, path: string, tab?: "today" | "maint") => void;
  render: () => void;
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
  const f = inp && findings(root, inp, clampMaint(inp.det?.config.thresholds)).find((x) => x.key === key);
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
  if (f.verb === "run") { void runSource(root, f.source); return; }
  if (f.verb === "review") { host.openDashboard(name, root, "maint"); return; }
  const tasks = await discoverTasks(root).catch((e) => { dlog("warn", `maint: tasks for ${root}: ${e}`); return []; });
  const verify = verifyCommands(tasks.map((x) => ({ cmd: execCmd(x), group: x.group, blocked: x.blocked })));
  const text = briefFor(f, inp, { project: name, verify });
  if (!text) { toast("That has changed since the last check. Check again"); return; }
  host.prefill(name, root, text);
}

/** True when the click was Maintenance's. Nested controls are probed before the row holding them. */
export function maintClick(t: HTMLElement, host: MaintHost): boolean {
  const scan = t.closest<HTMLElement>("[data-mtscan]");
  if (scan) { host.scan(scan.dataset.mtscan === "force"); return true; }
  const chip = t.closest<HTMLElement>("[data-mtchip]");
  if (chip) {
    if (chip.getAttribute("aria-disabled") !== "true") { setMaintChip(chip.dataset.mtchip as MaintChip); host.render(); }
    return true;
  }
  const fold = t.closest<HTMLElement>("[data-mtfold]");
  if (fold) { quietOpen = fold.dataset.mtfold === "1"; host.render(); return true; }
  const verb = t.closest<HTMLElement>("[data-mtverb]");
  if (verb) { void runVerb(verb.dataset.mtroot!, verb.dataset.mtverb!, host); return true; }
  const proj = t.closest<HTMLElement>("[data-mtproj]");
  if (proj) { host.openDashboard(proj.dataset.mtname!, proj.dataset.mtproj!, "maint"); return true; }
  return false;
}
