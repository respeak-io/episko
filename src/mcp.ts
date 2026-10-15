// The frontend half of the Episko MCP server: answers each `mcp-call` the backend holds open,
// launching a task through the same path ▶ Run takes and following its pane to the exit.
// What the answers say is ./mcptools'; docs/mcp.md.

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import { sessions, worktreesByRepo } from "./state";
import { currentStacks, refreshStacksNow } from "./serversui";
import type { Stack } from "./stack";
import type { Sess, WtHead } from "./types";
import { discoverTasks, execCmd, launchWithDeps, rememberedInput } from "./tasks";
import {
  appendOutput, fillInputs, missingText, refuseRun, reportText, runnablesText, runsOn, stacksText, upText, waitSeconds,
} from "./mcptools";

interface McpCall { id: string; sessionId: string; tool: string; args: Record<string, unknown> }

interface Watch {
  caller: string; taskId: string; cmd: string; startedAt: number;
  output: string; cut: boolean; exit: number | null; endedAt: number;
  waiters: Set<() => void>;
  upKey?: string; // a server or app: the stack key its "up" is judged on, so task_status asks the same
}

// Task pane id → what its caller is told. Kept after the exit so a late task_status still answers.
const runs = new Map<string, Watch>();
const KEEP_MS = 60 * 60_000;
// Call tag → the launch in flight, so output that beats launchTask's return is not lost. Keyed
// per call, not per task: fifty agents may run the same task at once, and each gets its own.
const launching = new Map<string, Watch>();

function answer(id: string, text: string, isError = false) {
  invoke("resolve_mcp", { id, text, isError }).catch((e) => dlog("warn", `mcp answer ${id}: ${e}`));
}

function prune(now = Date.now()) {
  for (const [id, w] of runs) if (w.exit != null && now - w.endedAt > KEEP_MS) runs.delete(id);
}

function watchFor(paneId: string): Watch | undefined {
  const known = runs.get(paneId);
  if (known) return known;
  const tag = sessions.get(paneId)?.run?.tag;
  const w = tag ? launching.get(tag) : undefined;
  if (w) runs.set(paneId, w);
  return w;
}

/** main.ts's pty-output listener, for every task pane. */
export function mcpOutput(paneId: string, text: string) {
  const w = watchFor(paneId);
  if (!w) return;
  const next = appendOutput(w.output, text);
  w.output = next.text;
  w.cut ||= next.cut;
}

/** main.ts's pty-exit listener, before its early return like the dependsOn waiters. */
export function mcpExit(paneId: string, code: number) {
  const w = runs.get(paneId);
  if (!w || w.exit != null) return;
  w.exit = code;
  w.endedAt = Date.now();
  for (const wake of w.waiters) wake();
}

// The stack a run belongs to: its run group when it launched one, else its own pane.
const stackOf = (key: string, paneId: string): Stack | undefined =>
  currentStacks().find((st) => st.key === key || st.members.some((m) => m.sid === paneId));

// A server or app: wait until its stack says ready or failed, or the time runs out. Polled,
// since "up" is a judgement over ports, output and containers rather than one event.
async function reportUp(call: McpCall, handle: string, key: string, w: Watch, secs: number) {
  const until = Date.now() + secs * 1000;
  let st = stackOf(key, handle);
  while (Date.now() < until && w.exit == null && st?.state !== "ready" && st?.state !== "failed") {
    await new Promise((r) => setTimeout(r, 750));
    st = stackOf(key, handle);
  }
  if (w.exit != null && !st) return report(call, handle, w, 0); // it exited: a plain report says how
  answer(call.id, upText(w.taskId, w.cmd, handle, Date.now() - w.startedAt, st, w.output), st?.state === "failed");
}

async function report(call: McpCall, handle: string, w: Watch, secs: number) {
  if (w.exit == null && secs > 0) {
    await new Promise<void>((resolve) => {
      const wake = () => { clearTimeout(timer); w.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, secs * 1000);
      w.waiters.add(wake);
    });
  }
  answer(call.id, reportText({
    id: w.taskId, cmd: w.cmd, handle, exit: w.exit, output: w.output, cut: w.cut,
    elapsedMs: (w.exit == null ? Date.now() : w.endedAt) - w.startedAt,
  }), w.exit != null && w.exit !== 0);
}

// Where a call runs. Subagents share their parent's MCP connection, so a worktree-isolated one
// names its checkout in `cwd`; only a checkout of this repo is accepted (docs/mcp.md).
async function placeOf(s: Sess, cwd: unknown): Promise<{ dir: string; worktree: string | null; branch: string } | string> {
  if (typeof cwd !== "string" || !cwd.trim()) return { dir: s.workdir, worktree: s.worktree, branch: s.branch };
  const want = cwd.trim().replace(/[\\/]+$/, "");
  const heads = await invoke<WtHead[]>("worktree_heads", { dir: s.workdir }).catch(() => [] as WtHead[]);
  const inside = (root: string) => want === root || want.startsWith(root + "/") || want.startsWith(root + "\\");
  const h = heads.filter((x) => x.exists && inside(x.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!h) return `${cwd} is not a checkout of this session's repository, so Episko will not run tasks there.`;
  return { dir: h.path, worktree: h.is_main ? null : h.branch, branch: h.branch };
}

async function runTask(call: McpCall) {
  const s = sessions.get(call.sessionId)!;
  const taskId = typeof call.args.id === "string" ? call.args.id : "";
  const place = await placeOf(s, call.args.cwd);
  if (typeof place === "string") return answer(call.id, place, true);
  const all = await discoverTasks(place.dir, s.colorKey, true);
  const spec = all.find((r) => r.id === taskId);
  if (!spec) return answer(call.id, `No task "${taskId}" in ${place.dir}.\n\n${runnablesText(all)}`, true);
  const why = refuseRun(spec);
  if (why) return answer(call.id, why, true);
  const filled = fillInputs(spec, call.args.inputs, (inp) => rememberedInput(s.project, spec.id, inp));
  if ("missing" in filled) return answer(call.id, missingText(spec, filled.missing), true);

  prune();
  const tag = call.id; // unique per tools/call, minted by the backend
  const long = runsOn(spec);
  // A server already up in this checkout is reported, not started twice; `again` starts another.
  const live = long && call.args.again !== true
    ? [...sessions.values()].find((x) => x.kind === "task" && (x.run?.id === spec.id || x.run?.groupRoot === spec.id) && x.run.root === place.dir && x.run.exitCode == null)
    : undefined;
  if (live) {
    const st = stackOf(live.run!.groupId ?? live.id, live.id);
    return answer(call.id, `${spec.id} is already running in this checkout (handle "${live.id}"); it was not started again. Pass again: true to start another.\n\n${upText(spec.id, live.run!.cmd, live.id, Date.now() - live.run!.startedAt, st, "")}`);
  }
  const w: Watch = {
    caller: s.id, taskId: spec.id, cmd: execCmd(filled.ready), startedAt: Date.now(),
    output: "", cut: false, exit: null, endedAt: 0, waiters: new Set(),
  };
  launching.set(tag, w);
  dlog("info", `mcp run_task ${spec.id} · for ${s.id.slice(0, 8)}`);
  try {
    // A compound's panes are its dependencies; minting the group id is how its stack is found.
    const res = await launchWithDeps(filled.ready, s.project, {
      colorKey: s.colorKey, worktree: place.worktree, branch: place.branch,
      discoveredIn: place.dir, forSession: s.id, tag, focus: false, ...(spec.compound ? { groupId: tag } : {}),
    });
    if (!res.ok || (!res.id && !spec.compound)) {
      return answer(call.id, `${spec.id} did not start${spec.dependsOn.length ? " (a dependency failed; its pane says why)" : ""}.`, true);
    }
    const handle = res.id ?? tag;
    if (long) w.upKey = spec.compound ? tag : handle;
    runs.set(handle, w);
    if (w.upKey) await reportUp(call, handle, w.upKey, w, waitSeconds(call.args.wait_seconds, true));
    else await report(call, handle, w, waitSeconds(call.args.wait_seconds));
  } finally {
    launching.delete(tag);
  }
}

async function taskStatus(call: McpCall) {
  const handle = typeof call.args.handle === "string" ? call.args.handle : "";
  const w = runs.get(handle);
  if (!w || w.caller !== call.sessionId) return answer(call.id, `No run with handle "${handle}" for this session.`, true);
  if (w.upKey) await reportUp(call, handle, w.upKey, w, waitSeconds(call.args.wait_seconds, true));
  else await report(call, handle, w, waitSeconds(call.args.wait_seconds));
}

export async function onMcpCall(call: McpCall) {
  const s = sessions.get(call.sessionId);
  if (!s) return answer(call.id, "This session is not open in Episko any more.", true);
  try {
    if (call.tool === "list_runnables") {
      const place = await placeOf(s, call.args.cwd);
      if (typeof place === "string") return answer(call.id, place, true);
      return answer(call.id, runnablesText(await discoverTasks(place.dir, s.colorKey, true)));
    }
    if (call.tool === "run_task") return await runTask(call);
    if (call.tool === "stack_status") {
      // This repository only, across every checkout of it: what the user would see in the popover.
      const repo = new Set([s.colorKey, ...(worktreesByRepo.get(s.colorKey) ?? []).map((h) => h.path)]);
      const mine = (await refreshStacksNow()).filter((st) => repo.has(st.checkout) || st.checkout.startsWith(s.colorKey + "/"));
      return answer(call.id, stacksText(mine, s.workdir));
    }
    if (call.tool === "task_status") return await taskStatus(call);
    answer(call.id, `Unknown tool "${call.tool}".`, true);
  } catch (e) {
    dlog("error", `mcp ${call.tool} failed: ${e}`);
    answer(call.id, `Episko failed: ${e}`, true);
  }
}
