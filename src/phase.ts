// Telemetry → session state: applyHook and applyStatusline turn Claude's hooks and
// statusLines into what the cockpit displays. No DOM, no renderAll; see test/phase.test.ts.

import { liveCount, liveFanout, ORPHAN_DEAD_MS, type Agent, type Fanout, type Phase, type Prompt, type Risk, type Sess } from "./types";
import { applyTouch, bumpTally } from "./files";
import { clearsOutline, notePrompt } from "./outline";
import { applyBg } from "./servers";
import { addUsage, costDelta } from "./usage";
import { descText, inputText, outputText } from "./toolio";
import { mergeRl, onRlUpdate, rl } from "./rl";
import { resolveProviderPermission } from "./providers/control";
import { clearPermissionState, pendingPermissionIds } from "./permissions";

// Run-on-stop needs task discovery and panes (main.ts), so it arrives as a seam.
let onTurnEnd: (s: Sess) => void = () => {};
export function setOnTurnEnd(fn: (s: Sess) => void) { onTurnEnd = fn; }

// Wired by main.ts like onTurnEnd. The whole payload travels, never single fields: the git
// half reads `tool_input.command`, the drift half `file_path` and `cwd` (see ./gitwatch).
let onSessionTouched: (s: Sess, tool: string, data: any) => void = () => {};
export function setOnSessionTouched(fn: typeof onSessionTouched) { onSessionTouched = fn; }

// The outline's anchor is a marker in the pane's scrollback, which only ./terminal can
// register; wired by main.ts like the two seams above.
let onPrompt: (s: Sess, p: Prompt) => void = () => {};
export function setOnPrompt(fn: typeof onPrompt) { onPrompt = fn; }

// Every provider's prompts enter here, so the anchor is taken at the one moment the pane
// is showing the question; adapters reach it through ./agents rather than pushing directly.
export function recordPrompt(s: Sess, raw: unknown) {
  const p = notePrompt(s.prompts, raw, Date.now());
  if (p) onPrompt(s, p);
}

// A tool hook this soon after `Stop` is the ended turn's straggler, not the next turn:
// hooks are unwaited curls, so a turn's last PostToolUse can land after its Stop.
export const STRAGGLER_MS = 2_000;

export function setPhase(s: Sess, p: Phase) { if (s.phase !== p) { s.phase = p; s.phaseSince = Date.now(); } }
export function toolArg(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? input.description;
  if (typeof v !== "string" || !v.trim()) return "";
  if ((tool === "Read" || tool === "Edit" || tool === "Write") && /[/\\]/.test(v)) return v.split(/[/\\]/).pop() || v;
  return abbr(v, 64);
}
export const ACT_CAP = 12; // timeline rows kept per session; bounds the call sheet's memory
// Pre/Post pair by `tool_use_id`; the name match is only the fallback for a payload with no id (CLAUDE.md).
export function openActivity(s: Sess, tool: string, arg: string, id: string, inp: string, desc: string) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  s.activity.unshift({ tool, arg, time, startMs: Date.now(), durMs: null, id, inp, desc, out: "", failed: false });
  if (s.activity.length > ACT_CAP) s.activity.length = ACT_CAP;
}
export function closeActivity(s: Sess, tool: string, id: string, inp: string, desc: string, out: string, failed: boolean) {
  // A ternary, never `||`: an unmatched id must not fall through to the name match.
  const a = id
    ? s.activity.find((x) => x.id === id)
    : s.activity.find((x) => x.tool === tool && x.durMs == null);
  if (!a) return;
  a.durMs = Date.now() - a.startMs;
  a.out = out;
  a.failed = failed;
  // Post repeats `tool_input`: fill a row that had none, never overwrite the Pre hook's.
  if (!a.inp && inp) a.inp = inp;
  if (!a.desc && desc) a.desc = desc;
}
export function applyTodos(s: Sess, input: any) {
  const arr = input?.todos;
  if (!Array.isArray(arr)) return;
  s.todos = arr
    .map((t: any) => ({ content: String(t?.content ?? t?.activeForm ?? ""), status: String(t?.status ?? "pending") }))
    .filter((t) => t.content);
}
// ExitPlanMode's plan is freeform markdown; every step is "pending" until a TodoWrite takes over.
export function applyPlan(s: Sess, input: any) {
  const md: string = typeof input?.plan === "string" ? input.plan : "";
  if (!md.trim()) return;
  const lines = md.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let steps = lines
    .map((l) => l.match(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1])
    .filter((x): x is string => !!x);
  if (!steps.length) steps = lines.filter((l) => !/^#{1,6}\s/.test(l)); // prose fallback
  const todos = steps
    .slice(0, 12)
    .map((c) => ({ content: c.replace(/\*\*/g, "").replace(/`/g, "").trim(), status: "pending" }))
    .filter((t) => t.content);
  if (todos.length) s.todos = todos;
}
// ---------- background fan-outs ----------
// The leading `meta` literal (pure by contract) names the run. Regex, never eval: this is
// arbitrary JS from a tool call. An unparseable script still starts a fan-out, just unnamed.
const META_WINDOW = 4000;
export function parseWorkflowMeta(script: string): { name: string; detail: string; phases: string[] } {
  const at = script.indexOf("export const meta");
  const head = at < 0 ? script.slice(0, META_WINDOW) : script.slice(at, at + META_WINDOW);
  // Bound the literal at the first column-0 `}`: `title:` and `name:` recur in the prompts below.
  const end = head.search(/^\}/m);
  const meta = end > 0 ? head.slice(0, end) : head;
  const unquote = (v: string) => v.replace(/\\(['"`\\])/g, "$1").replace(/\s+/g, " ").trim();
  const one = (key: string) => {
    const m = new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(meta);
    return m ? unquote(m[2]) : "";
  };
  const phases: string[] = [];
  for (const m of meta.matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const t = unquote(m[2]);
    if (t) phases.push(abbr(t, 32));
    if (phases.length === 8) break;
  }
  // Bounded here rather than at the views that draw it: a Fanout is state.
  return { name: abbr(one("name"), 56), detail: abbr(one("description"), 120), phases };
}
// A resumed run (`scriptPath`, no script text) is named from the persisted
// `<meta.name>-<runId>.js` basename; the record this pane holds wins when the two agree.
export function startFanout(s: Sess, input: any) {
  const script = typeof input?.script === "string" ? input.script : "";
  let meta = parseWorkflowMeta(script);
  if (!script) {
    const base = (typeof input?.scriptPath === "string" ? input.scriptPath : "").split(/[\\/]/).pop() ?? "";
    const name = abbr(base.replace(/\.[^.]*$/, "").replace(/-wf_[a-z0-9-]+$/, ""), 56);
    const prev = s.fanout;
    meta = prev?.name && (!name || prev.name === name)
      ? { name: prev.name, detail: prev.detail, phases: prev.phases }
      : { ...meta, name };
  }
  const now = Date.now();
  // Agents the last run left up stay counted but age on ORPHAN_DEAD_MS, not on the new
  // run's lastAt, which never expires while it is alive (docs/architecture.md, "34 / 36").
  for (const a of s.agents.values()) if (!a.orphanedAt) a.orphanedAt = now;
  s.fanout = { ...meta, since: now, started: 0, done: 0, lastAt: now };
}
// A retried Start must not add a second entry under one id.
let anonSeq = 0;
function startAgent(s: Sess, data: any) {
  const id = typeof data.agent_id === "string" && data.agent_id ? data.agent_id : `anon-${++anonSeq}`;
  const type = typeof data.agent_type === "string" ? abbr(data.agent_type, 32) : "";
  if (!s.agents.has(id)) s.agents.set(id, { type, since: Date.now(), orphanedAt: 0 });
}
// Without an id, retire the oldest outstanding agent, preferring the running fan-out's.
function stopAgent(s: Sess, data: any): Agent | null {
  const id = typeof data.agent_id === "string" ? data.agent_id : "";
  const known = id ? s.agents.get(id) : undefined;
  if (known) { s.agents.delete(id); return known; }
  let pick: [string, Agent] | null = null;
  for (const e of s.agents) { if (!e[1].orphanedAt) { pick = e; break; } pick ??= e; }
  if (!pick) return null;
  s.agents.delete(pick[0]);
  return pick[1];
}
// A plain Task burst has no Workflow script; its first SubagentStart mints an unnamed record.
function fanoutOf(s: Sess): Fanout {
  const now = Date.now();
  return (s.fanout ??= { name: "", detail: "", phases: [], since: now, started: 0, done: 0, lastAt: now });
}

export function abbr(s: string, n = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
export function permCmd(data: any): string {
  const inp = data.tool_input || {};
  const detail = inp.command ?? inp.file_path ?? inp.path ?? inp.url ?? inp.pattern ??
    inp.prompt ?? inp.question ?? inp.query ?? inp.description;
  if (typeof detail === "string" && detail.trim()) return abbr(detail);
  if (typeof data.message === "string" && data.message.trim()) return abbr(data.message);
  return "";
}
// Heuristic risk for a pending permission — informs the badge, not the decision.
export function riskLevel(tool: string, input: any): Risk {
  const cmd = typeof input?.command === "string" ? input.command : "";
  if (tool === "Bash") {
    // `-[rf]+`, not `-[rf]`: with one letter the \b lands inside `rm -rf` and it never matches.
    if (/(^|\s)(sudo|rm\s+-[rf]+|rmdir|mkfs|dd|shutdown|reboot|kill(all)?)\b|git\s+clean|--force\b|--hard\b|-fdx\b|>\s*\/dev\/|:\(\)\s*\{|chmod\s+-R|curl[^|]*\|\s*(sh|bash)|npm\s+publish|git\s+push/i.test(cmd)) return "high";
    return "med";
  }
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") return "med";
  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "WebFetch" || tool === "WebSearch") return "low";
  return "med";
}
// The answer may have come in the CLI, so a request still held server-side is released, not leaked.
export function clearPending(s: Sess) {
  for (const id of pendingPermissionIds(s)) {
    resolveProviderPermission(s, id, "terminal").catch(() => {});
  }
  clearPermissionState(s);
}

// Decides done vs. error in one place: the idle Notification fires after a 529 too. A clean end
// clears the revive counter here, never in newTurn, or a watchdog continue resets the ladder.
function endTurn(s: Sess) {
  if (s.apiErr) { setPhase(s, "error"); return; }
  s.revive = null;
  // A prompt queued behind this turn means the session is about to work again with no
  // UserPromptSubmit of its own; consumed here only, so one queued prompt excuses one Stop.
  if (s.queuedPrompt) { s.queuedPrompt = false; setPhase(s, "thinking"); return; }
  setPhase(s, "done");
}
// Also from PreToolUse: a /resume or a queued message has no prompt. s.revive survives (see endTurn).
function newTurn(s: Sess) { s.apiErr = null; }

// The lifecycle verbs provider adapters use instead of forging Claude payloads.
export function beginAgentTurn(s: Sess) {
  clearPending(s); newTurn(s); s.curTool = ""; s.curArg = ""; setPhase(s, "thinking");
}
export function finishAgentTurn(s: Sess, failed = false, detail = "") {
  if (failed) s.apiErr = { kind: "unknown", detail: abbr(detail), at: Date.now() };
  setPhase(s, failed ? "error" : "done");
  clearPending(s); s.curTool = ""; s.curArg = "";
  onSessionTouched(s, "", {});
  onTurnEnd(s);
}
export function noteAgentTouch(s: Sess, tool: string, data: any) { onSessionTouched(s, tool, data); }

export function applyHook(s: Sess, data: any) {
  const ev: string = data.hook_event_name ?? "?";
  s.lastEvent = ev;
  s.lastActivity = Date.now(); // a lifecycle hook = the session did something (drives "sort by activity")
  // Drop what no SubagentStop will ever retire, or the ghosts poison bg() and the next
  // fleet's total. Hygiene only: `liveAgents` applies the same windows on the read side.
  const nowMs = Date.now();
  for (const [id, a] of s.agents) if (a.orphanedAt && nowMs - a.orphanedAt >= ORPHAN_DEAD_MS) s.agents.delete(id);
  if (s.agents.size && !liveFanout(s)) s.agents.clear();
  // A tool hook must not drive the phase while a fleet is up (its agents' hooks arrive
  // under the PARENT's id) or as a straggler of the ended turn. Bounded on purpose: a bare
  // `phase === "done"` made done absorbing, since most next turns open with a tool call.
  const bg = () => liveCount(s) > 0 || (s.phase === "done" && nowMs - s.phaseSince < STRAGGLER_MS);
  switch (ev) {
    // A fresh REPL loses everything in flight, including the SubagentStops still owed.
    case "SessionStart":
      setPhase(s, "idle"); clearPending(s); newTurn(s); s.agents.clear(); s.fanout = null; s.queuedPrompt = false;
      if (clearsOutline(data.source)) s.prompts = [];
      break;
    // A prompt typed mid-turn is queued, so the next Stop is the old turn's; read before setPhase.
    case "UserPromptSubmit":
      if (s.phase === "working") s.queuedPrompt = true;
      recordPrompt(s, data.prompt);
      setPhase(s, "thinking"); clearPending(s); newTurn(s); s.curTool = ""; s.curArg = ""; break;
    case "PreToolUse": {
      const tool = data.tool_name || "tool";
      const arg = toolArg(tool, data.tool_input);
      if (tool === "TodoWrite") applyTodos(s, data.tool_input);
      else if (tool === "ExitPlanMode") applyPlan(s, data.tool_input);
      else openActivity(s, tool, arg, String(data.tool_use_id ?? ""), inputText(tool, data.tool_input), descText(tool, data.tool_input));
      // Workflow returns ~2s before Stop, so the record exists before Stop would paint done.
      if (tool === "Workflow") startFanout(s, data.tool_input);
      if (!bg()) { setPhase(s, "working"); clearPending(s); newTurn(s); s.curTool = tool; s.curArg = arg; }
      break;
    }
    // A failure counts as touched too: a compound command may have run its git half first.
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = data.tool_name || "";
      // A failure carries no tool_response; its reason is in `error`, so both go to ./toolio.
      closeActivity(s, data.tool_name, String(data.tool_use_id ?? ""),
        inputText(tool, data.tool_input), descText(tool, data.tool_input),
        outputText(data.tool_response, data.error),
        ev === "PostToolUseFailure");
      // Fed from Post: the file set needs `tool_response` (create vs. update) and the tally
      // would double-count on Pre. A failed call counts as a call but adds no file.
      bumpTally(s.tally, tool);
      if (ev === "PostToolUse") applyTouch(s.files, tool, data.tool_input, data.tool_response, Date.now());
      // `transcript_path` rides the record: /clear, /compact and /resume mint a new session dir (BgServer).
      if (ev === "PostToolUse") applyBg(s.servers, tool, data.tool_input, data.tool_response, data.transcript_path, Date.now());
      onSessionTouched(s, tool, data);
      if (!bg()) setPhase(s, ev === "PostToolUse" ? "working" : "error");
      break;
    }
    case "Stop": {
      const queued = s.queuedPrompt;   // endTurn consumes it; run-on-stop still needs it
      endTurn(s); clearPending(s); s.curTool = ""; s.curArg = "";
      // Touched on Stop too: the working set must reflect the whole turn, not just its last tool.
      onSessionTouched(s, "Stop", data);
      // Not after a cut-short turn (half-written files) or with a prompt queued (work about to change).
      if (!s.apiErr && !queued) onTurnEnd(s);
      break;
    }
    // The only hook that says why the API killed the turn: `error` is an enum, `error_details` the message.
    case "StopFailure":
      s.apiErr = { kind: String(data.error ?? "unknown"), detail: abbr(String(data.error_details ?? data.message ?? "")), at: Date.now() };
      // Left set, the flag would excuse the next turn's honest Stop; the phase stays error regardless.
      s.queuedPrompt = false;
      setPhase(s, "error"); clearPending(s); s.curTool = ""; s.curArg = "";
      break;
    case "SessionEnd": setPhase(s, "ended"); clearPending(s); newTurn(s); s.curTool = ""; s.curArg = ""; s.agents.clear(); s.fanout = null; s.queuedPrompt = false; break;
    case "Notification": {
      const nt: string = data.notification_type ?? "";
      const msg: string = typeof data.message === "string" ? data.message : "";
      if (nt.includes("permission") || /permission/i.test(msg)) { s.attention = "permission needed"; if (msg) s.pendingCmd = abbr(msg); }
      // Idle means over, not succeeded (endTurn decides). It also proves nothing is queued,
      // which repairs a queued prompt cancelled with Esc: that fires no Stop.
      else if (nt === "idle_prompt") { s.queuedPrompt = false; endTurn(s); clearPending(s); }
      else { s.attention = nt || msg || "notification"; if (msg) s.pendingCmd = abbr(msg); }
      break;
    }
    case "PermissionRequest": s.attention = `permission: ${data.tool_name ?? ""}`; s.pendingCmd = permCmd(data); s.pendRisk = riskLevel(data.tool_name, data.tool_input); break;
    // Subagent hooks fire on the PARENT session. A record `liveFanout` has written off is
    // history: resuming it would put a finished run's counters under a fresh fleet.
    case "SubagentStart": {
      if (!liveFanout(s)) s.fanout = null;
      startAgent(s, data); const f = fanoutOf(s); f.started++; f.lastAt = Date.now(); break;
    }
    // An inherited agent's Stop belongs to the run that spawned it, so it does not count
    // here; the clamp keeps `done` under `started` when a Start was dropped.
    case "SubagentStop": {
      const a = stopAgent(s, data);
      if (!s.fanout) break;
      if (a && !a.orphanedAt) s.fanout.done = Math.min(s.fanout.started, s.fanout.done + 1);
      s.fanout.lastAt = Date.now();
      break;
    }
  }
}
export function pushHist(arr: number[], v: number, cap = 24) { arr.push(v); if (arr.length > cap) arr.splice(0, arr.length - cap); }
export function applyStatusline(s: Sess, data: any) {
  // A statusLine only fires from a live REPL, so it un-ends a pane SessionEnd marked on /clear or /compact.
  if (s.phase === "ended") setPhase(s, "idle");
  if (data.model?.display_name) s.model = data.model.display_name;
  const ctx = data.context_window?.used_percentage;
  if (typeof ctx === "number") { s.ctxPct = ctx; pushHist(s.ctxHist, ctx); }
  const tok = data.context_window?.used_tokens ?? data.context_window?.tokens;
  if (typeof tok === "number") s.ctxTokens = tok;
  const cost = data.cost?.total_cost_usd;
  // Banked against the conversation's baseline, per pane: a resumed session inherits
  // Claude's running total, and one conversation can have two live panes (see costDelta).
  if (typeof cost === "number") { addUsage(costDelta(s.resumeId || s.id, cost, true, s.id), s); s.cost = cost; pushHist(s.costHist, cost); }
  const dur = data.cost?.total_duration_ms; if (typeof dur === "number") s.durMs = dur;
  const r5 = data.rate_limits?.five_hour;
  if (r5) {
    const p = rl.h5, pr = rl.h5Reset;
    [rl.h5, rl.h5Reset] = mergeRl(rl.h5, rl.h5Reset, r5.used_percentage, r5.resets_at);
    onRlUpdate("h5", p, pr, rl.h5Reset);
  }
  const r7 = data.rate_limits?.seven_day;
  if (r7) {
    const p = rl.d7, pr = rl.d7Reset;
    [rl.d7, rl.d7Reset] = mergeRl(rl.d7, rl.d7Reset, r7.used_percentage, r7.resets_at);
    onRlUpdate("d7", p, pr, rl.d7Reset);
  }
  // The per-session shape shared surfaces read; global `rl` stays the account-wide authority.
  s.rateLimits = [
    ...(rl.h5 == null ? [] : [{ usedPercent: rl.h5, resetsAt: rl.h5Reset, windowMins: 300 }]),
    ...(rl.d7 == null ? [] : [{ usedPercent: rl.d7, resetsAt: rl.d7Reset, windowMins: 10080 }]),
  ];
  // The branch label comes from the git HEAD poll (refreshBranches), not from here, or the two flicker.
  const wt = data.workspace?.git_worktree; if (wt) s.worktree = wt;
}
