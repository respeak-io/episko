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

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import type { Runnable } from "./types";
import { FAVORITES } from "./state";

// `discoveredIn` is the directory discovery ran in, which is how we tell a task
// that declared its own cwd from one that merely inherited the default.
export interface TaskLaunchOpts {
  colorKey?: string; worktree?: string | null; branch?: string; discoveredIn?: string;
  /// `false` for a run nobody clicked — a run-on-stop pane must not yank the stage
  /// away from the session you were reading. It still appears in the sidebar.
  focus?: boolean;
  /// The session whose turn this run is verifying (see run-on-stop).
  forSession?: string;
  /// Shared by every pane of one `dependsOn` chain — see `Sess.run.groupId`. Set by
  /// `launchWithDeps` and inherited by the dependencies, so all of them land in the
  /// same sidebar group. Nothing else sets it.
  groupId?: string;
  groupLabel?: string;
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
// Changing a preference below changes what the sidebar, picker and settings window
// show, and every one of them is repainted from scratch — so the toggles keep the
// renderAll() they always had, reached the same way as the three hooks above.
let taskRepaint: () => void = () => {};
export function setTaskRepaint(fn: () => void) { taskRepaint = fn; }

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
export function setRunner(key: string, r: Runner) {
  if (r === "auto") delete taskRunner[key]; else taskRunner[key] = r;
  localStorage.setItem("cc-task-runner", JSON.stringify(taskRunner));
  taskRepaint();
}
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
///
/// An input that can answer *itself* — a default, or a just `*name` that is happy
/// empty — is not a prompt and so is not a reason. Saying it was would refuse the
/// rule while naming a dialog that never opens.
export function stopRuleBlocked(r: Runnable): string {
  if (r.blocked) return r.blocked;
  if (r.background) return "a long-running task never finishes a turn";
  if (r.inputs.some((i) => !i.optional && i.default == null)) return "it asks for input, which needs someone there";
  // A compound task has no pane of its own, and `forSession` is deliberately cleared
  // for dependencies — so a failure would have nowhere to be handed back to, and a
  // "Dev: …" compound is usually a stack of servers, which is the pile-up above by
  // another route. Withheld with a reason rather than silently misbehaving.
  if (r.compound) return "it only runs other tasks, so a failure has no pane to report to";
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

/// What a task can be started with *without* asking: what you typed last for this
/// exact input, else the definition's own default, else empty for an input that is
/// allowed to be empty. `null` means at least one input has no answer anywhere, so
/// running blind could only fail — and that is the one case still worth a dialog.
///
/// This is what makes Run and *Run with parameters…* two verbs rather than one:
/// running a task is the common case and should not cost a dialog, while changing
/// what it runs with is a deliberate act that gets its own button.
export function prefillInputs(r: Runnable, project: string): Runnable | null {
  if (!r.inputs.length) return r;
  const vals: Record<string, string> = {};
  for (const i of r.inputs) {
    // A password is never remembered, so it is never prefilled either.
    const v = (i.password ? undefined : rememberedInput(project, r.id, i.id))
      ?? i.default ?? (i.optional ? "" : undefined);
    if (v === undefined) return null;
    vals[i.id] = v;
  }
  return applyInputs(r, vals);
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
/// One dependency label → the Runnable it names. VS Code resolves by label, and a
/// label can collide across providers, so a match from the *same* provider wins.
export function findDep(label: string, source: string): Runnable | undefined {
  return [...lastRunnableById.values()].find((x) => x.label === label && x.source === source)
    ?? [...lastRunnableById.values()].find((x) => x.label === label);
}

export function resolveDeps(r: Runnable, seen: Set<string>): Runnable[] | null {
  const out: Runnable[] = [];
  for (const label of r.dependsOn) {
    const dep = findDep(label, r.source);
    if (!dep) { taskToast(`${r.label}: no task named “${label}” — not running it`); return null; }
    // A cycle would otherwise recurse until the stack gives out.
    if (seen.has(dep.id)) { taskToast(`${r.label}: dependency cycle at “${label}” — not running it`); return null; }
    out.push(dep);
  }
  return out;
}

/// The first dependency cycle reachable from `r`, as the labels around it, or `null`.
///
/// Walked **before anything launches**, which is a real improvement on its own — the
/// per-path check inside `launchWithDeps` only fires once part of the chain is already
/// running, so a cycle used to leave half a stack started behind it.
///
/// It also became load-bearing when shared dependencies started being memoised (see
/// `launchWithDeps`). Memoising is what stops a diamond launching `pnpm install` four
/// times, but it also means a branch can *await* a task instead of descending into it —
/// and two branches awaiting each other is a deadlock where the per-path check would
/// have raised an error. This runs the whole graph first so that can't arise.
export function findDepCycle(r: Runnable): string[] | null {
  const stack: Runnable[] = [];
  const clean = new Set<string>();          // fully explored, provably cycle-free
  const walk = (t: Runnable): string[] | null => {
    const at = stack.findIndex((x) => x.id === t.id);
    if (at >= 0) return [...stack.slice(at), t].map((x) => x.label);
    if (clean.has(t.id)) return null;       // a diamond, not a cycle — don't re-walk it
    stack.push(t);
    for (const label of t.dependsOn) {
      // An unresolvable label is `resolveDeps`'s error to report, not this one's.
      const dep = findDep(label, t.source);
      const cyc = dep && walk(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    clean.add(t.id);
    return null;
  };
  return walk(r);
}

/// What a launch attempt produced. `ok` and `id` are genuinely independent, which is
/// why this isn't just `string | null`: a **compound** task succeeds while launching no
/// pane at all (its dependencies were the work), and reading that absence as failure is
/// what would stop a nested compound from ever satisfying its parent.
export interface LaunchResult { ok: boolean; id: string | null }
const FAILED: LaunchResult = { ok: false, id: null };

/// Launch the task's *own* pane — or nothing at all, if it hasn't got one.
///
/// A VS Code compound task (`dependsOn` with no `command`) is complete once its
/// dependencies have run. There is nothing to spawn, and asking `spawn_task` to run an
/// empty command line would only produce "task has no command" for a task that is
/// perfectly well formed.
async function own(r: Runnable, project: string, opts: TaskLaunchOpts): Promise<LaunchResult> {
  if (r.compound) {
    taskLog("info", `task ${r.id} · compound, dependencies done`);
    return { ok: true, id: null };
  }
  const id = await taskLaunch(r, project, opts);
  return { ok: !!id, id };
}

/// Every dependency of one launch, by task id → "did it succeed". Threaded through the
/// whole recursion so each distinct task starts **once per launch**, however many
/// dependents name it.
///
/// `dependsOn` is a DAG, not a tree, and walking it as a tree is quadratic in the worst
/// case and wrong in every case: one ⌘⇧B on a real `"Dev: Frontend + Backend"` launched
/// **27 panes for 11 tasks** — `Backend (uv sync)` six times, `pnpm install` and
/// `docker compose up` four times each — because every path to a shared dependency
/// started it again. VS Code runs each task once per invocation; so does this now.
///
/// It memoises the *whole* outcome, not just the launch, which also closes a second
/// bug: `exitWaiters` holds one resolver per session id, so two dependents awaiting the
/// same dependency's exit would clobber each other's resolver and one would hang for
/// ever. Now they await one shared promise.
type DepRuns = Map<string, Promise<boolean>>;

// Run a task's dependencies, then the task. A failed dependency stops the chain —
// "build then test" must not test a build that didn't happen.
export async function launchWithDeps(
  r: Runnable, project: string, opts: TaskLaunchOpts,
  seen = new Set<string>(), started: DepRuns = new Map(),
): Promise<LaunchResult> {
  // Outermost call only: check the whole graph before a single pane starts. Cheap, and
  // the alternative is discovering a cycle with half the stack already running.
  if (!seen.size) {
    const cyc = findDepCycle(r);
    if (cyc) {
      taskToast(`${r.label}: dependency cycle — ${cyc.join(" → ")}`);
      taskLog("warn", `task ${r.id} skipped: cycle ${cyc.join(" -> ")}`);
      return FAILED;
    }
  }
  const deps = resolveDeps(r, seen);
  // A dependency that can't be resolved is a *failed* dependency, not an absent
  // one. resolveDeps has already said which label and why; all that's left is to
  // not run the task — same outcome as a dependency that ran and exited non-zero.
  if (!deps) { taskLog("warn", `task ${r.id} skipped: dependency unresolved`); return FAILED; }
  if (!deps.length) return own(r, project, opts);
  seen.add(r.id);

  const sequence = r.dependsOrder === "sequence";
  taskLog("info", `task ${r.id} · ${deps.length} dep${deps.length === 1 ? "" : "s"} (${sequence ? "sequence" : "parallel"})`);

  // One group per *launch*, minted at the outermost chain and inherited from there
  // down: a nested dependency belongs to the same group as the task that pulled it
  // in, however deep. `opts.groupId` is only ever set by this line's recursion, so
  // the `??` is what makes "outermost wins" true without threading a depth counter.
  const groupId = opts.groupId ?? crypto.randomUUID();
  const groupLabel = opts.groupLabel ?? r.label;

  // A dependency inherits the stage behaviour (`focus`), the group and the discovery
  // directory, but not the *identity* of the run that pulled it in: `forSession`
  // belongs to the rule pane, not to its build step.
  //
  // `discoveredIn` is deliberately kept. It was cleared here on the theory that it
  // was "the parent's cwd", but it is the directory *discovery ran in* — and a
  // dependency is resolved out of that very same discovery result, so it is right for
  // the dep too. Clearing it broke three things at once: `run.root` fell back to the
  // repo root, which put reveal-source in the wrong folder, made a task pane cluster
  // under the wrong checkout, and — because `declaredOwnCwd` compares against it —
  // let the "run in repo root" preference override a dependency's *declared* cwd, so
  // `Frontend (vite dev)` ran outside `01_frontend`.
  const depOpts: TaskLaunchOpts = { ...opts, forSession: undefined, groupId, groupLabel };
  // The chain's own pane joins the group too, or the root of "build → test" would
  // sit outside the group it created.
  opts = { ...opts, groupId, groupLabel };
  // Start each distinct dependency at most once per launch and let every dependent
  // await the same promise. The memo is claimed *synchronously*, before the first
  // await, so two branches racing for the same dependency can't both start it.
  const runDep = (d: Runnable): Promise<boolean> => {
    const already = started.get(d.id);
    if (already) return already;
    const p = (async () => {
      const res = await launchWithDeps(d, project, depOpts, new Set(seen), started);
      if (!res.ok) return false;
      // A **background** dependency is satisfied the moment it starts. Waiting for its
      // exit is waiting forever: "Dev: Frontend + Backend" depends on a vite dev server
      // and a uvicorn --reload, neither of which ever exits, so awaiting them hung the
      // whole chain and nothing downstream ever ran. VS Code does the same — it starts
      // a background dependency and moves on.
      if (d.background || !res.id) return true;
      return (await waitForExit(res.id)) === 0;
    })();
    started.set(d.id, p);
    return p;
  };

  const ok = sequence
    // Sequential: stop at the first failure rather than running the rest.
    ? await deps.reduce<Promise<boolean>>(async (prev, d) => (await prev) && runDep(d), Promise.resolve(true))
    : (await Promise.all(deps.map(runDep))).every(Boolean);

  if (!ok) {
    taskToast(`${r.label}: a dependency failed — not running it`);
    taskLog("warn", `task ${r.id} skipped: dependency failed`);
    return FAILED;
  }
  return own(r, project, opts);
}

// ---------- preferences: personal, per-project, all localStorage ----------
// Project-shaped facts (what a task runs, its cwd, its env) belong in
// .episko/tasks.toml instead, which is committable — that split is what keeps a
// shared repo working for a colleague who never opens Episko.
// Everything here is *personal* preference and lives in localStorage beside
// cc-favorites. Project-shaped facts (what a task runs, its cwd, its env) belong
// in .episko/tasks.toml, which is committable — the split is what keeps a shared
// repo working for a colleague who never opens Episko.

// Must list every `source` the backend can emit (see tasks.rs `discover`): anything
// missing here is discovered and then silently filtered out of the picker.
export const ALL_PROVIDERS = ["episko", "vscode", "launch", "npm", "just", "taskfile", "mise", "make", "cargo"] as const;
export type Provider = (typeof ALL_PROVIDERS)[number];
export const PROVIDER_LABEL: Record<Provider, string> = {
  episko: ".episko", vscode: "tasks.json", launch: "launch.json", npm: "package.json",
  just: "justfile", taskfile: "Taskfile", mise: "mise", make: "Makefile", cargo: "cargo",
};

export interface TaskPrefs {
  providers: Provider[];
  /// Providers that existed when this was last saved. One added later isn't in the
  /// stored `providers` array either, and without this we couldn't tell "the user
  /// switched it off" from "it didn't exist yet".
  known: Provider[];
  introspect: boolean;        // may a trusted project be *run* to enumerate itself?
  cwd: "session" | "root";    // which directory a run inherits
  dismissMs: number;          // 0 = never auto-dismiss a green run
  attention: boolean;         // does a failed run raise the badge?
}
const DEFAULT_TASK_PREFS: TaskPrefs = {
  providers: [...ALL_PROVIDERS], known: [...ALL_PROVIDERS], introspect: true, cwd: "session", dismissMs: 20000, attention: true,
};
export const taskPrefs: TaskPrefs = { ...DEFAULT_TASK_PREFS, ...JSON.parse(localStorage.getItem("cc-task-prefs") || "{}") };
for (const p of ALL_PROVIDERS) {
  if (!taskPrefs.known.includes(p)) taskPrefs.providers = [...taskPrefs.providers, p];
}
taskPrefs.known = [...ALL_PROVIDERS];
export function saveTaskPrefs() { localStorage.setItem("cc-task-prefs", JSON.stringify(taskPrefs)); taskRepaint(); }

// Folders the user has explicitly allowed Episko to introspect. Adding a folder as
// a project counts as saying yes — you chose it deliberately; a directory that
// merely happens to hold a session does not.
const trustedPaths: string[] = JSON.parse(localStorage.getItem("cc-trusted") || "[]");
function saveTrusted() { localStorage.setItem("cc-trusted", JSON.stringify(trustedPaths)); }
function isTrusted(path: string): boolean {
  return FAVORITES.some((f) => f.path === path) || trustedPaths.includes(path);
}
export function trustProject(path: string) {
  if (!trustedPaths.includes(path)) { trustedPaths.push(path); saveTrusted(); }
}
export function untrustProject(path: string) {
  const i = trustedPaths.indexOf(path);
  if (i >= 0) { trustedPaths.splice(i, 1); saveTrusted(); }
  taskRepaint();
}
// Only projects the user opted in by hand can be revoked here — a favourite is
// trusted *because* it's a favourite, and removing it is how you undo that.
export function explicitlyTrusted(): string[] { return [...trustedPaths]; }

// Pins are personal, not project state, so they sit in localStorage beside
// cc-favorites rather than in the repo. Keyed by project root → Runnable ids,
// which discovery guarantees are stable across a rescan.
const taskPins: Record<string, string[]> = JSON.parse(localStorage.getItem("cc-task-pins") || "{}");
function saveTaskPins() { localStorage.setItem("cc-task-pins", JSON.stringify(taskPins)); }
export function pinnedIds(key: string): string[] { return taskPins[key] || []; }
export function togglePin(key: string, id: string) {
  const cur = pinnedIds(key);
  taskPins[key] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (!taskPins[key].length) delete taskPins[key];
  saveTaskPins();
  taskRepaint();
}

// The part a plain terminal can't do. Episko already receives Claude's `Stop`
// hook, so a project can say "when an agent finishes a turn here, run the tests" —
// and every turn becomes a verified turn. A green run auto-dismisses like any
// other; a red one persists, raises the same badge a blocked session does, and
// offers its output back to the very session that caused it.
//
// One rule per project, keyed like pins (project root → task). The label is stored
// beside the id only so Settings can list the rules without running discovery for
// every project first.
export type StopRule = { id: string; label: string };
export const stopRules: Record<string, StopRule> = JSON.parse(localStorage.getItem("cc-task-onstop") || "{}");
function saveStopRules() { localStorage.setItem("cc-task-onstop", JSON.stringify(stopRules)); }
export function toggleStopRule(key: string, r: Runnable) {
  if (stopRules[key]?.id === r.id) delete stopRules[key];
  else stopRules[key] = { id: r.id, label: r.label };
  saveStopRules();
  taskRepaint();
}
export function clearStopRule(key: string) { delete stopRules[key]; saveStopRules(); taskRepaint(); }

// Episko's own file is ever written — a discovered VS Code task or justfile
// belongs to another tool and stays read-only.

const taskHidden: Record<string, string[]> = JSON.parse(localStorage.getItem("cc-task-hidden") || "{}");
function saveHidden() { localStorage.setItem("cc-task-hidden", JSON.stringify(taskHidden)); }
export function hiddenIds(key: string): string[] { return taskHidden[key] || []; }
export function toggleHidden(key: string, id: string) {
  const cur = hiddenIds(key);
  taskHidden[key] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (!taskHidden[key].length) delete taskHidden[key];
  saveHidden();
}

// ---------- discovery ----------
// `trusted` is what lets the backend shell out to `just --dump` — which evaluates
// the justfile. It takes all three of: the global toggle, the provider being on,
// and this specific folder being one the user chose.
export async function discoverTasks(workdir: string, colorKey = workdir, includeHidden = false): Promise<Runnable[]> {
  const trusted = taskPrefs.introspect && taskPrefs.providers.includes("just") && (isTrusted(workdir) || isTrusted(colorKey));
  try {
    const raw = (await invoke<Runnable[]>("discover_runnables", { workdir, trusted }))
      .filter((r) => taskPrefs.providers.includes(r.source as Provider));
    // Swap in the project's runner override before anything caches the result, so a
    // re-run months later uses the same runner the picker showed.
    const all = applyRunner(raw, colorKey);
    // Resolve dependsOn against everything discovered, hidden or not — hiding a
    // task from the picker shouldn't quietly break another task that needs it.
    for (const r of all) lastRunnableById.set(r.id, r);
    const hid = hiddenIds(colorKey);
    return includeHidden ? all : all.filter((r) => !hid.includes(r.id));
  } catch (e) {
    dlog("warn", `discover failed (${workdir}): ${e}`);
    return [];
  }
}

// Drop the backend's cached parse for this project so the next discover re-reads
// from disk. The stamp already catches edits to files Episko reads; this is the
// escape hatch for what it can't see — a file an introspector imports itself.
export async function rescanTasks(workdir: string) {
  await invoke("rescan_runnables", { workdir }).catch((e) => dlog("warn", `rescan: ${e}`));
}
