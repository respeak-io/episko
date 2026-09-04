// Run on stop: the Stop hook runs the project's rule (./tasks) after every turn, plus the
// task inspector's actions. Three rules: never two runs at once, never twice per turn,
// never anything that would need a person (stopRuleBlocked, then prefillInputs).

import { invoke } from "@tauri-apps/api/core";
import { toast } from "./dom";
import { dlog } from "./debug";
import { hasSessionState, type Runnable, type Sess } from "./types";
import { sessions } from "./state";
import { openInputPrompt } from "./taskui";
import {
  discoverTasks, lastRunnableById, launchWithDeps, prefillInputs, resolveRunInputs, stopRuleBlocked,
  stopRules, type TaskLaunchOpts,
} from "./tasks";

let setActive: (id: string) => void = () => {};
export function setTaskRunSetActive(fn: typeof setActive) { setActive = fn; }
let closeSession: (id: string) => void = () => {};
export function setTaskRunCloseSession(fn: typeof closeSession) { closeSession = fn; }
let launchTask: (r: Runnable, project: string, opts?: TaskLaunchOpts) => Promise<string | null> =
  async () => null;
export function setTaskRunLaunchTask(fn: typeof launchTask) { launchTask = fn; }

const stopRunAt = new Map<string, number>();
const STOP_RUN_FLOOR = 5000; // swallows a double-fired Stop; not a ration
// A rule with `dependsOn` has no pane of its own until its deps have run, so the pane
// scan in maybeRunOnStop cannot see a chain that is still starting; this marks it.
const stopInFlight = new Set<string>();

export async function maybeRunOnStop(s: Sess) {
  const rule = stopRules[s.colorKey];
  if (!rule || !hasSessionState(s)) return;
  if (Date.now() - (stopRunAt.get(s.colorKey) ?? 0) < STOP_RUN_FLOOR) return;
  if (stopInFlight.has(s.colorKey)) {
    dlog("info", `run-on-stop ${rule.id} skipped: a chain is already starting`);
    return;
  }
  if ([...sessions.values()].some((x) => x.kind === "task" && x.colorKey === s.colorKey && x.run?.id === rule.id && x.run.exitCode == null)) {
    dlog("info", `run-on-stop ${rule.id} skipped: still running`);
    return;
  }
  // Both claimed before the first await, or two Stops in one tick both get past.
  stopRunAt.set(s.colorKey, Date.now());
  stopInFlight.add(s.colorKey);
  try {
    // The session's own workdir, so the run verifies the worktree the agent edited;
    // hidden tasks count, since hiding is about the picker.
    const spec = (await discoverTasks(s.workdir, s.colorKey, true)).find((r) => r.id === rule.id);
    if (!spec) {
      dlog("warn", `run-on-stop ${rule.id} gone from ${s.project}`);
      toast(`Run after a turn: “${rule.label}” isn’t in ${s.project} any more`);
      return;
    }
    const why = stopRuleBlocked(spec);
    if (why) { dlog("warn", `run-on-stop ${rule.id} skipped: ${why}`); return; }
    const ready = prefillInputs(spec, s.project);
    if (!ready) { dlog("warn", `run-on-stop ${rule.id} skipped: an input has no value`); return; }
    dlog("info", `run-on-stop ${rule.id} · ${s.project} · ${s.id.slice(0, 8)} finished a turn`);
    await launchWithDeps(ready, s.project, {
      colorKey: s.colorKey, worktree: s.worktree, branch: s.branch,
      discoveredIn: spec.cwd, forSession: s.id, focus: false,
    });
  } finally {
    stopInFlight.delete(s.colorKey);
  }
}

// A fresh pane replaces the old one, so the sidebar doesn't grow a row per attempt.
export async function rerunTask(s: Sess, withParams = false) {
  const r = s.run; if (!r) return;
  const spec = lastRunnableById.get(r.id);
  if (!spec) { toast("Task definition is gone. Rescan"); return; }
  // Reuses the last values silently; ⋯ Parameters is how you change them.
  const ready = resolveRunInputs(spec, s.project, withParams);
  if (!ready) { openInputPrompt(spec, s.project, { colorKey: s.colorKey, worktree: s.worktree, branch: s.branch, discoveredIn: spec.cwd }); return; }
  const project = s.project, colorKey = s.colorKey, worktree = s.worktree, branch = s.branch;
  closeSession(s.id);
  await launchTask(ready, project, { colorKey, worktree, branch });
}

// No trailing newline: Episko prefills, the human presses Enter (same contract as handToTerminal).
export function sendOutputToSession(task: Sess, targetId: string) {
  const t = sessions.get(targetId);
  if (!t?.term) { toast("That session is gone"); return; }
  const r = task.run!;
  const tail = r.tail.join("\n").trim();
  const msg = `\`${r.cmd}\` failed with exit ${r.exitCode}:\n\n${tail}\n\nPlease fix it.`;
  setActive(targetId);
  invoke("write_pty", { sessionId: targetId, data: msg.replace(/\n/g, "\r") })
    .then(() => toast("Pasted into the session. Press Enter to send"))
    .catch((e) => toast("send failed: " + e));
}

// `root` is the directory discovery ran in, so the repo-relative `sourceFile` resolves.
export function revealSource(root: string, sourceFile: string) {
  invoke("reveal_path", { dir: root, rel: sourceFile }).catch((e) => toast("reveal failed: " + e));
}
