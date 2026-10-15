// The frontend half of the Episko MCP server: answers each `mcp-call` the backend holds open,
// launching a task through the same path ▶ Run takes and following its pane to the exit.
// What the answers say is ./mcptools'; docs/mcp.md.

import { invoke } from "@tauri-apps/api/core";
import { dlog } from "./debug";
import { sessions } from "./state";
import type { Sess, WtHead } from "./types";
import { discoverTasks, execCmd, launchWithDeps, rememberedInput } from "./tasks";
import {
  appendOutput, fillInputs, missingText, refuseRun, reportText, runnablesText, waitSeconds,
} from "./mcptools";

interface McpCall { id: string; sessionId: string; tool: string; args: Record<string, unknown> }

interface Watch {
  caller: string; taskId: string; cmd: string; startedAt: number;
  output: string; cut: boolean; exit: number | null; endedAt: number;
  waiters: Set<() => void>;
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
  const w: Watch = {
    caller: s.id, taskId: spec.id, cmd: execCmd(filled.ready), startedAt: Date.now(),
    output: "", cut: false, exit: null, endedAt: 0, waiters: new Set(),
  };
  launching.set(tag, w);
  dlog("info", `mcp run_task ${spec.id} · for ${s.id.slice(0, 8)}`);
  try {
    const res = await launchWithDeps(filled.ready, s.project, {
      colorKey: s.colorKey, worktree: place.worktree, branch: place.branch,
      discoveredIn: place.dir, forSession: s.id, tag, focus: false,
    });
    if (!res.ok || !res.id) {
      return answer(call.id, `${spec.id} did not start${spec.dependsOn.length ? " (a dependency failed; its pane says why)" : ""}.`, true);
    }
    runs.set(res.id, w);
    await report(call, res.id, w, waitSeconds(call.args.wait_seconds));
  } finally {
    launching.delete(tag);
  }
}

async function taskStatus(call: McpCall) {
  const handle = typeof call.args.handle === "string" ? call.args.handle : "";
  const w = runs.get(handle);
  if (!w || w.caller !== call.sessionId) return answer(call.id, `No run with handle "${handle}" for this session.`, true);
  await report(call, handle, w, waitSeconds(call.args.wait_seconds));
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
    if (call.tool === "task_status") return await taskStatus(call);
    answer(call.id, `Unknown tool "${call.tool}".`, true);
  } catch (e) {
    dlog("error", `mcp ${call.tool} failed: ${e}`);
    answer(call.id, `Episko failed: ${e}`, true);
  }
}
