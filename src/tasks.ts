// The frontend half of Runnables: the decisions a task run makes before and around
// the pane. Discovery lives in Rust (src-tauri/src/tasks.rs) and only ever *parses*
// a project; this side chooses what may run, fills in what only a human can answer,
// and sequences a dependency chain — which is here rather than in Rust because only
// the side that owns the panes can wait on an exit code.
//
// Everything here is data-in, data-out over `Runnable`. Three callees genuinely
// belong upstairs and arrive as settable hooks, per PLAN.md's seam rule 2: starting
// a pane (`setTaskLauncher`), the debug console (`setTaskLogger`, same shape as
// rl.ts's `setRlLogger`) and the toast (`setTaskToast`). Until main.ts wires them —
// and in tests — a chain runs against no-ops. See test/tasks.test.ts.
//
// Note for tests: the two localStorage-backed maps below are read at *module scope*,
// so `import { store } from "./localstorage"` must sit on the line above this
// module's import (see test/localstorage.ts).

import type { Runnable } from "./types";

// `discoveredIn` is the directory discovery ran in, which is how we tell a task
// that declared its own cwd from one that merely inherited the default.
export interface TaskLaunchOpts {
  colorKey?: string; worktree?: string | null; branch?: string; discoveredIn?: string;
  /// `false` for a run nobody clicked — a run-on-stop pane must not yank the stage
  /// away from the session you were reading. It still appears in the sidebar.
  focus?: boolean;
  /// The session whose turn this run is verifying (see run-on-stop).
  forSession?: string;
}

// Starting a run means a PTY, an xterm and a pane, so the launcher itself stays in
// main.ts and is wired in at startup. A chain that hasn't been wired launches
// nothing and reports it as a failure, which is the safe direction.
let taskLaunch: (r: Runnable, project: string, opts: TaskLaunchOpts) => Promise<string | null> =
  async () => null;
export function setTaskLauncher(fn: (r: Runnable, project: string, opts: TaskLaunchOpts) => Promise<string | null>) { taskLaunch = fn; }
let taskLog: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setTaskLogger(fn: (lvl: "info" | "warn" | "error", msg: string) => void) { taskLog = fn; }
let taskToast: (msg: string) => void = () => {};
export function setTaskToast(fn: (msg: string) => void) { taskToast = fn; }

// ---------- package-runner override ----------
// The lockfile decides the runner in Rust (`package_runner`), and it's right for
// essentially every repo. This is the escape hatch for one that lies — a stray
// pnpm-lock in an npm project. It's a *personal* per-project fact, so localStorage,
// and it's applied here rather than in Rust: an npm task's exec is already
// `{program:<runner>, args:["run", name]}`, so swapping the program after discovery
// is the whole change — the discovery cache never has to learn about it.
export const RUNNERS = ["auto", "npm", "pnpm", "yarn", "bun"] as const;
export type Runner = (typeof RUNNERS)[number];
export const taskRunner: Record<string, Runner> = JSON.parse(localStorage.getItem("cc-task-runner") || "{}");
export function runnerFor(key: string): Runner { return taskRunner[key] || "auto"; }
export function applyRunner(list: Runnable[], key: string): Runnable[] {
  const r = runnerFor(key);
  if (r === "auto") return list;
  return list.map((t) => t.source === "npm" && t.exec.mode === "argv"
    ? { ...t, exec: { ...t.exec, program: r } } : t);
}

// ---------- remembered ${input:…} values ----------
// A task with an input prompt shouldn't ask cold every time. Values are remembered
// per project + task + input, so next run pre-fills what you typed last. Passwords
// are never stored — the whole point of `password:true` is that it doesn't linger.
export const taskInputs: Record<string, string> = JSON.parse(localStorage.getItem("cc-task-inputs") || "{}");
const inputKey = (project: string, taskId: string, inputId: string) => `${project}␟${taskId}␟${inputId}`;
export function rememberInput(project: string, taskId: string, inputId: string, val: string) {
  taskInputs[inputKey(project, taskId, inputId)] = val;
  localStorage.setItem("cc-task-inputs", JSON.stringify(taskInputs));
}
export function rememberedInput(project: string, taskId: string, inputId: string): string | undefined {
  return taskInputs[inputKey(project, taskId, inputId)];
}

/// Why this task can't be a rule, or "" if it can. Unattended means unattended: an
/// `${input:…}` prompt would block on a dialog nobody opened, a background task
/// never exits so it could only pile up one dev server per turn, and a blocked one
/// can't run at all.
export function stopRuleBlocked(r: Runnable): string {
  if (r.blocked) return r.blocked;
  if (r.background) return "a long-running task never finishes a turn";
  if (r.inputs.length) return "it asks for input, which needs someone there";
  return "";
}

/// The command as a human reads it — the picker's subtitle and the inspector's
/// "command" row both show exactly what will run.
export function execCmd(r: Runnable): string {
  return r.exec.mode === "shell" ? r.exec.line : [r.exec.program, ...r.exec.args].join(" ");
}

/// Substitute collected values into every string that reaches the command line.
export function applyInputs(r: Runnable, vals: Record<string, string>): Runnable {
  const fill = (s: string) => s.replace(/\$\{input:([^}]+)\}/g, (m, id) => (id in vals ? vals[id] : m));
  const exec = r.exec.mode === "shell"
    ? { mode: "shell" as const, line: fill(r.exec.line) }
    : { mode: "argv" as const, program: fill(r.exec.program), args: r.exec.args.map(fill) };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.env)) env[k] = fill(v);
  return { ...r, exec, cwd: fill(r.cwd), env, inputs: [] };
}

// The most recent discovery result, so a re-run doesn't need the picker open.
export const lastRunnableById = new Map<string, Runnable>();

// ---------- dependsOn ----------
// The frontend owns the panes, so it's the only side that can wait on an exit code
// and decide whether the next thing should start at all.

export const exitWaiters = new Map<string, (code: number) => void>();
export function waitForExit(sessionId: string): Promise<number> {
  return new Promise((resolve) => exitWaiters.set(sessionId, resolve));
}

/// Resolve `dependsOn` labels against the last discovery. VS Code names dependencies
/// by label, not id, so this matches on label within the same project.
///
/// `null` means a dependency could not be resolved, and is deliberately distinct
/// from `[]`, which means the task declares none. Returning `[]` for both is what
/// let a task whose dependency had been renamed away run anyway — see the caller.
export function resolveDeps(r: Runnable, seen: Set<string>): Runnable[] | null {
  const out: Runnable[] = [];
  for (const label of r.dependsOn) {
    const dep = [...lastRunnableById.values()].find((x) => x.label === label && x.source === r.source)
      ?? [...lastRunnableById.values()].find((x) => x.label === label);
    if (!dep) { taskToast(`${r.label}: no task named “${label}” — not running it`); return null; }
    // A cycle would otherwise recurse until the stack gives out.
    if (seen.has(dep.id)) { taskToast(`${r.label}: dependency cycle at “${label}” — not running it`); return null; }
    out.push(dep);
  }
  return out;
}

// Run a task's dependencies, then the task. A failed dependency stops the chain —
// "build then test" must not test a build that didn't happen.
export async function launchWithDeps(r: Runnable, project: string, opts: TaskLaunchOpts, seen = new Set<string>()): Promise<string | null> {
  const deps = resolveDeps(r, seen);
  // A dependency that can't be resolved is a *failed* dependency, not an absent
  // one. resolveDeps has already said which label and why; all that's left is to
  // not run the task — same outcome as a dependency that ran and exited non-zero.
  if (!deps) { taskLog("warn", `task ${r.id} skipped: dependency unresolved`); return null; }
  if (!deps.length) return taskLaunch(r, project, opts);
  seen.add(r.id);

  const sequence = r.dependsOrder === "sequence";
  taskLog("info", `task ${r.id} · ${deps.length} dep${deps.length === 1 ? "" : "s"} (${sequence ? "sequence" : "parallel"})`);

  // A dependency inherits the stage behaviour (`focus`) but not the identity of the
  // run that pulled it in: `forSession` belongs to the rule pane, not its build step,
  // and `discoveredIn` is the parent's cwd, wrong for the dep's own *reveal source*.
  // Let the dep resolve its own root (falls back to the project root).
  const depOpts: TaskLaunchOpts = { ...opts, forSession: undefined, discoveredIn: undefined };
  const runDep = async (d: Runnable): Promise<boolean> => {
    const id = await launchWithDeps(d, project, depOpts, new Set(seen));
    if (!id) return false;
    return (await waitForExit(id)) === 0;
  };

  const ok = sequence
    // Sequential: stop at the first failure rather than running the rest.
    ? await deps.reduce<Promise<boolean>>(async (prev, d) => (await prev) && runDep(d), Promise.resolve(true))
    : (await Promise.all(deps.map(runDep))).every(Boolean);

  if (!ok) {
    taskToast(`${r.label}: a dependency failed — not running it`);
    taskLog("warn", `task ${r.id} skipped: dependency failed`);
    return null;
  }
  return taskLaunch(r, project, opts);
}
