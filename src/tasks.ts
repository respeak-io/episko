// The frontend half of Runnables: what may run, what only a human can answer, and the
// dependency chain (here because only the side that owns the panes can wait on an exit
// code). Discovery is tasks.rs's and only parses. Design notes: docs/tasks.md.

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import type { Runnable } from "./types";
import { readList, readObj } from "./store";
import { FAVORITES } from "./state";

// `discoveredIn` is where discovery ran, which tells a declared cwd from an inherited one.
export interface TaskLaunchOpts {
  colorKey?: string; worktree?: string | null; branch?: string; discoveredIn?: string;
  focus?: boolean;     // false for a run nobody clicked: it must not take the stage
  forSession?: string; // the session whose turn this run verifies (run-on-stop)
  groupId?: string;    // one dependsOn chain's sidebar group; set only by launchWithDeps
  groupLabel?: string;
  groupRoot?: string;
}

// Pane, log, toast and repaint belong to main.ts and arrive as settable hooks.
let taskLaunch: (r: Runnable, project: string, opts: TaskLaunchOpts) => Promise<string | null> =
  async () => null; // unwired (and in tests): launch nothing, report failure
export function setTaskLauncher(fn: (r: Runnable, project: string, opts: TaskLaunchOpts) => Promise<string | null>) { taskLaunch = fn; }
let taskLog: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setTaskLogger(fn: (lvl: "info" | "warn" | "error", msg: string) => void) { taskLog = fn; }
let taskToast: (msg: string) => void = () => {};
export function setTaskToast(fn: (msg: string) => void) { taskToast = fn; }
let taskRepaint: () => void = () => {};
export function setTaskRepaint(fn: () => void) { taskRepaint = fn; }

// ---------- package-runner override ----------
// The lockfile picks the runner in Rust (`package_runner`); this is the personal escape
// hatch for a repo that lies, applied after discovery so the cache never learns of it.
export const RUNNERS = ["auto", "npm", "pnpm", "yarn", "bun"] as const;
export type Runner = (typeof RUNNERS)[number];
export const taskRunner: Record<string, Runner> = readObj<Runner>("cc-task-runner");
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
// Keyed per project + task + input. A password is never stored.
export const taskInputs: Record<string, string> = readObj<string>("cc-task-inputs");
const inputKey = (project: string, taskId: string, inputId: string) => `${project}␟${taskId}␟${inputId}`;
export function rememberInput(project: string, taskId: string, inputId: string, val: string) {
  taskInputs[inputKey(project, taskId, inputId)] = val;
  localStorage.setItem("cc-task-inputs", JSON.stringify(taskInputs));
}
export function rememberedInput(project: string, taskId: string, inputId: string): string | undefined {
  return taskInputs[inputKey(project, taskId, inputId)];
}

// Why this task can't be a run-on-stop rule, or "" if it can. An input that answers
// itself (a default, or optional) is not a prompt, so it is not a reason.
export function stopRuleBlocked(r: Runnable): string {
  if (r.blocked) return r.blocked;
  if (r.background) return "a long-running task never finishes a turn";
  if (r.inputs.some((i) => !i.optional && i.default == null)) return "it asks for input, which needs someone there";
  // A compound task has no pane and its dependencies lose `forSession`: nowhere to report.
  if (r.compound) return "it only runs other tasks, so a failure has no pane to report to";
  return "";
}

export function execCmd(r: Runnable): string {
  return r.exec.mode === "shell" ? r.exec.line : [r.exec.program, ...r.exec.args].join(" ");
}

export function applyInputs(r: Runnable, vals: Record<string, string>): Runnable {
  const fill = (s: string) => s.replace(/\$\{input:([^}]+)\}/g, (m, id) => (id in vals ? vals[id] : m));
  const exec = r.exec.mode === "shell"
    ? { mode: "shell" as const, line: fill(r.exec.line) }
    : { mode: "argv" as const, program: fill(r.exec.program), args: r.exec.args.map(fill) };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.env)) env[k] = fill(v);
  return { ...r, exec, cwd: fill(r.cwd), env, inputs: [] };
}

// Start without asking when every input has an answer (last typed, else the default,
// else empty if optional); `null` means one has none, the one case worth a dialog.
export function prefillInputs(r: Runnable, project: string): Runnable | null {
  if (!r.inputs.length) return r;
  const vals: Record<string, string> = {};
  for (const i of r.inputs) {
    const v = (i.password ? undefined : rememberedInput(project, r.id, i.id))
      ?? i.default ?? (i.optional ? "" : undefined);
    if (v === undefined) return null;
    vals[i.id] = v;
  }
  return applyInputs(r, vals);
}

// Shared first step of Run and re-run: `withParams` always asks; `null` means open the prompt.
export function resolveRunInputs(r: Runnable, project: string, withParams = false): Runnable | null {
  return withParams && r.inputs.length ? null : prefillInputs(r, project);
}

// Discovery root → its last discovery, so a re-run needs no picker. Keyed by root because an id is
// only unique inside one: every JS project has an `npm:dev`, and an unscoped lookup ran another's.
export const runnablesByRoot = new Map<string, Map<string, Runnable>>();
export const runnableIn = (root: string, id: string): Runnable | undefined => runnablesByRoot.get(root)?.get(id);

// ---------- dependsOn ----------

export const exitWaiters = new Map<string, (code: number) => void>();
export function waitForExit(sessionId: string): Promise<number> {
  return new Promise((resolve) => exitWaiters.set(sessionId, resolve));
}

// VS Code names dependencies by label, which can collide across providers: same provider wins.
// Only the dependant's own root is searched; another project's `build` is never a dependency.
export function findDep(label: string, source: string, root: string): Runnable | undefined {
  const all = [...runnablesByRoot.get(root)?.values() ?? []];
  return all.find((x) => x.label === label && x.source === source) ?? all.find((x) => x.label === label);
}

// `null` (a dependency is unresolvable) must stay distinct from `[]` (none declared).
export function resolveDeps(r: Runnable, seen: Set<string>, root: string): Runnable[] | null {
  const out: Runnable[] = [];
  for (const label of r.dependsOn) {
    const dep = findDep(label, r.source, root);
    if (!dep) { taskToast(`${r.label}: no task named “${label}”, so it will not run`); return null; }
    if (seen.has(dep.id)) { taskToast(`${r.label}: dependency cycle at “${label}”, so it will not run`); return null; }
    out.push(dep);
  }
  return out;
}

// The first cycle reachable from `r`, as the labels around it. Walked before anything
// launches: the per-path check fires with half the stack running, and with memoised
// dependencies two branches awaiting each other would deadlock instead of erroring.
export function findDepCycle(r: Runnable, root: string): string[] | null {
  const stack: Runnable[] = [];
  const clean = new Set<string>();          // fully explored, provably cycle-free
  const walk = (t: Runnable): string[] | null => {
    const at = stack.findIndex((x) => x.id === t.id);
    if (at >= 0) return [...stack.slice(at), t].map((x) => x.label);
    if (clean.has(t.id)) return null;       // a diamond, not a cycle — don't re-walk it
    stack.push(t);
    for (const label of t.dependsOn) {
      const dep = findDep(label, t.source, root); // unresolvable is resolveDeps's error to report
      const cyc = dep && walk(dep);
      if (cyc) return cyc;
    }
    stack.pop();
    clean.add(t.id);
    return null;
  };
  return walk(r);
}

// `ok` and `id` are independent: a compound task succeeds while launching no pane.
export interface LaunchResult { ok: boolean; id: string | null }
const FAILED: LaunchResult = { ok: false, id: null };

// The task's own pane, or nothing: a compound task is complete once its dependencies ran.
async function own(r: Runnable, project: string, opts: TaskLaunchOpts): Promise<LaunchResult> {
  if (r.compound) {
    taskLog("info", `task ${r.id} · compound, dependencies done`);
    return { ok: true, id: null };
  }
  const id = await taskLaunch(r, project, opts);
  return { ok: !!id, id };
}

// Task id → "did it succeed" for one launch, so each distinct task starts once however
// many dependents name it (`dependsOn` is a DAG). The whole outcome is memoised, since
// `exitWaiters` holds one resolver per session and two waiters would clobber each other.
type DepRuns = Map<string, Promise<boolean>>;

// Run a task's dependencies, then the task. A failed dependency stops the chain.
export async function launchWithDeps(
  r: Runnable, project: string, opts: TaskLaunchOpts,
  seen = new Set<string>(), started: DepRuns = new Map(),
): Promise<LaunchResult> {
  // The same fallback as the pane's `run.root`, so a re-run looks where this launch looked.
  const root = opts.discoveredIn ?? opts.colorKey ?? "";
  // Outermost call only: check the whole graph before a single pane starts.
  if (!seen.size) {
    const cyc = findDepCycle(r, root);
    if (cyc) {
      taskToast(`${r.label}: dependency cycle · ${cyc.join(" → ")}`);
      taskLog("warn", `task ${r.id} skipped: cycle ${cyc.join(" -> ")}`);
      return FAILED;
    }
  }
  const deps = resolveDeps(r, seen, root);
  // Unresolved is failed, not absent; resolveDeps has already said which label and why.
  if (!deps) { taskLog("warn", `task ${r.id} skipped: dependency unresolved`); return FAILED; }
  if (!deps.length) return own(r, project, opts);
  seen.add(r.id);

  const sequence = r.dependsOrder === "sequence";
  taskLog("info", `task ${r.id} · ${deps.length} dep${deps.length === 1 ? "" : "s"} (${sequence ? "sequence" : "parallel"})`);

  // One group per launch: `opts.groupId` is only set by this recursion, so `??` makes outermost win.
  const groupId = opts.groupId ?? crypto.randomUUID();
  const groupLabel = opts.groupLabel ?? r.label;
  const groupRoot = opts.groupRoot ?? r.id;

  // A dependency keeps `focus`, the group and `discoveredIn` (it came out of that same
  // discovery, and `declaredOwnCwd` compares against it), not the rule pane's `forSession`.
  const depOpts: TaskLaunchOpts = { ...opts, forSession: undefined, groupId, groupLabel, groupRoot };
  opts = { ...opts, groupId, groupLabel, groupRoot }; // the chain's own pane joins the group too
  // The memo is claimed synchronously, before the first await, so racing branches can't both start it.
  const runDep = (d: Runnable): Promise<boolean> => {
    const already = started.get(d.id);
    if (already) return already;
    const p = (async () => {
      const res = await launchWithDeps(d, project, depOpts, new Set(seen), started);
      if (!res.ok) return false;
      // A background dependency (a dev server) never exits; it is satisfied once started, as in VS Code.
      if (d.background || !res.id) return true;
      return (await waitForExit(res.id)) === 0;
    })();
    started.set(d.id, p);
    return p;
  };

  const ok = sequence
    ? await deps.reduce<Promise<boolean>>(async (prev, d) => (await prev) && runDep(d), Promise.resolve(true))
    : (await Promise.all(deps.map(runDep))).every(Boolean);

  if (!ok) {
    taskToast(`${r.label}: a dependency failed, so it will not run`);
    taskLog("warn", `task ${r.id} skipped: dependency failed`);
    return FAILED;
  }
  return own(r, project, opts);
}

// ---------- preferences: personal, per-project, all localStorage ----------
// Project-shaped facts (command, cwd, env) belong in the committable .episko/tasks.toml
// instead, so a colleague who never opens Episko still has them.

// Must list every `source` tasks.rs `discover` emits; a missing one is silently filtered from the picker.
export const ALL_PROVIDERS = ["episko", "vscode", "launch", "npm", "just", "taskfile", "mise", "make", "cargo"] as const;
export type Provider = (typeof ALL_PROVIDERS)[number];
// The three that run the project to enumerate it, and so sit behind the trust gate.
export const INTROSPECTING: readonly Provider[] = ["just", "taskfile", "mise"];
export const PROVIDER_LABEL: Record<Provider, string> = {
  episko: ".episko", vscode: "tasks.json", launch: "launch.json", npm: "package.json",
  just: "justfile", taskfile: "Taskfile", mise: "mise", make: "Makefile", cargo: "cargo",
};

export interface TaskPrefs {
  providers: Provider[];
  known: Provider[];          // providers at last save, so a new one isn't read as switched off
  introspect: boolean;        // may a trusted project be *run* to enumerate itself?
  cwd: "session" | "root";    // which directory a run inherits
  dismissMs: number;          // 0 = never auto-dismiss a green run
  attention: boolean;         // does a failed run raise the badge?
}
export const DEFAULT_TASK_PREFS: TaskPrefs = {
  providers: [...ALL_PROVIDERS], known: [...ALL_PROVIDERS], introspect: true, cwd: "session", dismissMs: 20000, attention: true,
};
export const taskPrefs: TaskPrefs = { ...DEFAULT_TASK_PREFS, ...readObj<unknown>("cc-task-prefs") as Partial<TaskPrefs> };
// Both list fields are read on the next lines, so a hand-edited scalar there would throw at import.
if (!Array.isArray(taskPrefs.providers)) taskPrefs.providers = [...DEFAULT_TASK_PREFS.providers];
if (!Array.isArray(taskPrefs.known)) taskPrefs.known = [];
for (const p of ALL_PROVIDERS) {
  if (!taskPrefs.known.includes(p)) taskPrefs.providers = [...taskPrefs.providers, p];
}
taskPrefs.known = [...ALL_PROVIDERS];
export function saveTaskPrefs() { localStorage.setItem("cc-task-prefs", JSON.stringify(taskPrefs)); taskRepaint(); }

// Folders Episko may introspect: adding a project counts as yes; merely holding a session does not.
const trustedPaths: string[] = readList<unknown>("cc-trusted").filter((x): x is string => typeof x === "string");
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
// Only hand-trusted projects can be revoked here; a favourite is trusted by being one.
export function explicitlyTrusted(): string[] { return [...trustedPaths]; }

// Keyed project root → Runnable ids, which discovery keeps stable across a rescan.
const taskPins: Record<string, string[]> = readObj<string[]>("cc-task-pins");
function saveTaskPins() { localStorage.setItem("cc-task-pins", JSON.stringify(taskPins)); }
export function pinnedIds(key: string): string[] { return taskPins[key] || []; }
export function togglePin(key: string, id: string) {
  const cur = pinnedIds(key);
  taskPins[key] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (!taskPins[key].length) delete taskPins[key];
  saveTaskPins();
  taskRepaint();
}

// Run on stop: Claude's `Stop` hook already reaches Episko, so a project can run its
// tests after every turn. One rule per project; the label lets Settings list rules
// without running discovery first.
export type StopRule = { id: string; label: string };
export const stopRules: Record<string, StopRule> = readObj<StopRule>("cc-task-onstop");
function saveStopRules() { localStorage.setItem("cc-task-onstop", JSON.stringify(stopRules)); }
export function toggleStopRule(key: string, r: Runnable) {
  if (stopRules[key]?.id === r.id) delete stopRules[key];
  else stopRules[key] = { id: r.id, label: r.label };
  saveStopRules();
  taskRepaint();
}
export function clearStopRule(key: string) { delete stopRules[key]; saveStopRules(); taskRepaint(); }

// Hiding is a preference, never an edit: a discovered VS Code task or justfile belongs to another tool.

const taskHidden: Record<string, string[]> = readObj<string[]>("cc-task-hidden");
function saveHidden() { localStorage.setItem("cc-task-hidden", JSON.stringify(taskHidden)); }
export function hiddenIds(key: string): string[] { return taskHidden[key] || []; }
export function toggleHidden(key: string, id: string) {
  const cur = hiddenIds(key);
  taskHidden[key] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  if (!taskHidden[key].length) delete taskHidden[key];
  saveHidden();
}

// ---------- discovery ----------
// `trusted` lets the backend run `just --dump`, which evaluates the justfile; all three switches gate it.
export async function discoverTasks(workdir: string, colorKey = workdir, includeHidden = false): Promise<Runnable[]> {
  // Any introspecting provider opens the gate, not `just` alone: the backend takes one bool
  // for all three, and gating on `just` left `task`/`mise` reporting withheld rows (docs/tasks.md).
  const wantsIntrospection = INTROSPECTING.some((p) => taskPrefs.providers.includes(p));
  const trusted = taskPrefs.introspect && wantsIntrospection && (isTrusted(workdir) || isTrusted(colorKey));
  try {
    const raw = (await invoke<Runnable[]>("discover_runnables", { workdir, trusted }))
      .filter((r) => taskPrefs.providers.includes(r.source as Provider));
    // The runner override goes in before the result is cached, so a re-run gets what the picker showed.
    const all = applyRunner(raw, colorKey);
    // Replaced whole, so a task deleted from its file is gone here too; hidden ones stay for their dependants.
    runnablesByRoot.set(workdir, new Map(all.map((r) => [r.id, r])));
    const hid = hiddenIds(colorKey);
    return includeHidden ? all : all.filter((r) => !hid.includes(r.id));
  } catch (e) {
    dlog("warn", `discover failed (${workdir}): ${e}`);
    return [];
  }
}

// Drop the backend's cached parse; the stamp misses a file an introspector imports itself.
export async function rescanTasks(workdir: string) {
  await invoke("rescan_runnables", { workdir }).catch((e) => dlog("warn", `rescan: ${e}`));
}

// ---------- where a task is defined (the picker's ⓘ view) ----------
// Every provider keys a task by its label verbatim, so this is a text search, not a parse.
// It answers null rather than guess: the view then shows the file with nothing marked.

export interface DefSpan { start: number; end: number }  // 0-based, inclusive line indices

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indentOf = (l: string) => l.length - l.trimStart().length;
const blank = (l: string) => !l.trim();

// From `i` while `keep` holds, trailing blank lines given back.
function runWhile(lines: string[], i: number, keep: (l: string) => boolean): number {
  let end = i;
  for (let j = i + 1; j < lines.length && keep(lines[j]); j++) end = j;
  while (end > i && blank(lines[end])) end--;
  return end;
}

// The JSON object enclosing column `col` of line `i`, brace-counted with strings blanked out.
function jsonObject(lines: string[], i: number, col: number): DefSpan {
  const braces = (l: string) => l.replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length));
  let depth = 0, start = -1, from = 0;
  for (let j = i; j >= 0 && start < 0; j--) {
    const l = braces(lines[j]);
    for (let k = (j === i ? col : l.length) - 1; k >= 0; k--) {
      if (l[k] === "}") depth++;
      else if (l[k] === "{" && --depth < 0) { start = j; from = k; break; }
    }
  }
  if (start < 0) return { start: i, end: i };
  depth = 0;
  for (let j = start; j < lines.length; j++) {
    const l = braces(lines[j]);
    for (let k = j === start ? from : 0; k < l.length; k++) {
      if (l[k] === "{") depth++;
      else if (l[k] === "}" && --depth === 0) return { start, end: j };
    }
  }
  return { start: i, end: i };
}

export function defSpan(source: string, text: string, label: string): DefSpan | null {
  const lines = text.split(/\r?\n/);
  const find = (re: RegExp, from = 0) => {
    for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  const key = reEsc(label);
  const json = reEsc(JSON.stringify(label));
  const tomlStr = `(?:"${key}"|'${key}')`;
  // String.raw throughout: the patterns are spliced from escaped labels.
  const re = (s: string) => new RegExp(s);
  switch (source) {
    case "npm": {
      const i = find(re(String.raw`^\s*${json}\s*:`), Math.max(0, find(/"scripts"\s*:/)));
      return i < 0 ? null : { start: i, end: i };
    }
    case "vscode": case "launch": {
      const prop = source === "vscode" ? `"(?:label|taskName)"` : `"name"`;
      const at = re(String.raw`${prop}\s*:\s*${json}`);
      const i = find(at);
      return i < 0 ? null : jsonObject(lines, i, lines[i].search(at));
    }
    case "episko": {
      const i = find(re(String.raw`^\s*label\s*=\s*${tomlStr}\s*(#.*)?$`));
      if (i < 0) return null;
      let start = i;
      while (start > 0 && !/^\s*\[\[task\]\]/.test(lines[start])) start--;
      return { start, end: runWhile(lines, i, (l) => !/^\s*\[/.test(l)) };
    }
    case "mise": {
      const h = find(re(String.raw`^\s*\[tasks\.(?:${key}|"${key}")\]`));
      if (h >= 0) return { start: h, end: runWhile(lines, h, (l) => !/^\s*\[/.test(l)) };
      const i = find(re(String.raw`^\s*(?:${key}|"${key}")\s*=`), Math.max(0, find(/^\s*\[tasks\]/)));
      return i < 0 ? null : { start: i, end: i };
    }
    case "taskfile": {
      const i = find(re(String.raw`^\s+(?:${key}|"${key}"|'${key}')\s*:`), Math.max(0, find(/^tasks\s*:/)));
      if (i < 0) return null;
      const ind = indentOf(lines[i]);
      return { start: i, end: runWhile(lines, i, (l) => blank(l) || indentOf(l) > ind) };
    }
    case "just": case "make": {
      // A recipe line starts at column 0; `@` is just's quiet marker, and both take a doc comment above.
      const head = source === "just" ? re(String.raw`^@?${key}(?=[\s:])`) : re(String.raw`^${key}\s*:(?!=)`);
      const i = find(head);
      if (i < 0) return null;
      let start = i;
      while (start > 0 && /^(#|\[)/.test(lines[start - 1])) start--;
      return { start, end: runWhile(lines, i, (l) => blank(l) || /^[ \t]/.test(l)) };
    }
    default: return null;
  }
}
