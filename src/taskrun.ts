// Run on stop, and the three things you can do with a run afterwards.
//
// This is the part a plain terminal can't do, and the reason tasks live inside Episko
// at all: the `Stop` hook already arrives here, so a project can say "when an agent
// finishes a turn in this folder, run this" and every turn becomes a verified turn.
// One rule per project, kept in ./tasks alongside the other task preferences.
//
// Three invariants, all of them about *not* running:
//   • never two at once — a run of the rule still in flight wins
//   • never twice per turn — STOP_RUN_FLOOR swallows a double-fired Stop, and the
//     in-flight marker covers the window a `dependsOn` chain leaves open, before its
//     own pane exists for the scan to find
//   • never unattended-hostile — stopRuleBlocked (./tasks) refuses a background task,
//     one with ${input:…}, and a blocked one
//
// The rest is the task inspector's actions: re-run, reveal the source file, and hand a
// failure back to the session whose turn it was checking.

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./dom";
import { dlog } from "./debug";
import { isAgent, type Runnable, type Sess } from "./types";
import { sessions } from "./state";
import { openInputPrompt } from "./taskui";
import {
  discoverTasks, lastRunnableById, launchWithDeps, stopRuleBlocked, stopRules,
  type TaskLaunchOpts,
} from "./tasks";

// Three callees in the pane layer: putting a pane on the stage, closing one, and
// opening one for a task. Per-callee setters, per PLAN's seam rule 2.
let setActive: (id: string) => void = () => {};
export function setTaskRunSetActive(fn: typeof setActive) { setActive = fn; }
let closeSession: (id: string) => void = () => {};
export function setTaskRunCloseSession(fn: typeof closeSession) { closeSession = fn; }
let launchTask: (r: Runnable, project: string, opts?: TaskLaunchOpts) => Promise<string | null> =
  async () => null;
export function setTaskRunLaunchTask(fn: typeof launchTask) { launchTask = fn; }

// A Stop fires at the end of *every* turn — that's the point — but two can land in
// quick succession, and a slow suite must never race a second copy of itself in
// the same worktree. The floor is deliberately short: it exists to swallow a
// double-fire, not to ration runs.
const stopRunAt = new Map<string, number>();
const STOP_RUN_FLOOR = 5000;
// A run-on-stop launch is only visible as a pane *after* its dependency chain has
// run — so a rule with `dependsOn` has no `run.id === rule.id` pane during the whole
// dep phase, and the 5s floor alone can't stop a turn that lands mid-build from
// racing a second chain. This marks "a chain for this project is starting", claimed
// synchronously before the first await and cleared once the launch settles; by then
// the rule pane exists and the in-flight scan below takes over.
const stopInFlight = new Set<string>();

export async function maybeRunOnStop(s: Sess) {
  const rule = stopRules[s.colorKey];
  if (!rule || !isAgent(s)) return;
  // Claimed before the first await: discovery is async, so two Stops in the same
  // tick would otherwise both get past this.
  if (Date.now() - (stopRunAt.get(s.colorKey) ?? 0) < STOP_RUN_FLOOR) return;
  // A chain still starting (deps running, rule pane not created yet) wins — the pane
  // scan below can't see it, so this covers the window the floor can't.
  if (stopInFlight.has(s.colorKey)) {
    dlog("info", `run-on-stop ${rule.id} skipped — a chain is already starting`);
    return;
  }
  // A run of this rule still in flight wins. Restarting the suite from the top
  // mid-flight tells you nothing and doubles the load on the machine.
  if ([...sessions.values()].some((x) => x.kind === "task" && x.colorKey === s.colorKey && x.run?.id === rule.id && x.run.exitCode == null)) {
    dlog("info", `run-on-stop ${rule.id} skipped — still running`);
    return;
  }
  stopRunAt.set(s.colorKey, Date.now());
  stopInFlight.add(s.colorKey);
  try {
    // Discover in the *session's* workdir, so with several worktrees of one repo
    // open the run verifies the checkout the agent actually just edited. Hidden
    // tasks count — hiding is about the picker, not about what may run.
    const spec = (await discoverTasks(s.workdir, s.colorKey, true)).find((r) => r.id === rule.id);
    if (!spec) {
      dlog("warn", `run-on-stop ${rule.id} gone from ${s.project}`);
      toast(`Run after a turn: “${rule.label}” isn’t in ${s.project} any more`);
      return;
    }
    const why = stopRuleBlocked(spec);
    if (why) { dlog("warn", `run-on-stop ${rule.id} skipped: ${why}`); return; }
    dlog("info", `run-on-stop ${rule.id} · ${s.project} · ${s.id.slice(0, 8)} finished a turn`);
    await launchWithDeps(spec, s.project, {
      colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
      discoveredIn: spec.cwd, forSession: s.id, focus: false,
    });
  } finally {
    stopInFlight.delete(s.colorKey);
  }
}

// Re-running reuses nothing — it opens a fresh pane and closes the old one, so the
// sidebar doesn't accumulate a row per attempt while the scrollback stays honest
// about which attempt you're reading.
export async function rerunTask(s: Sess) {
  const r = s.run; if (!r) return;
  const spec = lastRunnableById.get(r.id);
  if (!spec) { toast("Task definition is gone — rescan"); return; }
  if (spec.inputs.length) { openInputPrompt(spec, s.project, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch, discoveredIn: spec.cwd }); return; }
  const project = s.project, colorKey = s.colorKey, worktree = s.worktree, branch = s.branch;
  closeSession(s.id);
  await launchTask(spec, project, { colorKey, worktree, branch });
}

// Type the failure into a Claude session's stdin — deliberately *without* a
// trailing newline, so you read what's about to be sent and press Enter yourself.
// Same contract as handToTerminal: Episko prefills, the human commits.
export function sendOutputToSession(task: Sess, targetId: string) {
  const t = sessions.get(targetId);
  if (!t?.term) { toast("That session is gone"); return; }
  const r = task.run!;
  const tail = r.tail.join("\n").trim();
  const msg = `\`${r.cmd}\` failed with exit ${r.exitCode}:\n\n${tail}\n\nPlease fix it.`;
  setActive(targetId);
  invoke("write_pty", { sessionId: targetId, data: msg.replace(/\n/g, "\r") })
    .then(() => toast("Pasted into the session — press Enter to send"))
    .catch((e) => toast("send failed: " + e));
}

// ↗ Reveal source — where a task came from, selected in the OS file manager. `root`
// is the directory discovery ran in, so the repo-relative `sourceFile` resolves; a
// blocked/synthetic row has no real file and shows nothing to reveal.
export function revealSource(root: string, sourceFile: string) {
  invoke("reveal_path", { dir: root, rel: sourceFile }).catch((e) => toast("reveal failed: " + e));
}

