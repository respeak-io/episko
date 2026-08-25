// Telemetry → session state. Every hook and statusLine the instrumented Claude
// posts to us lands in one of these two functions, and what they leave behind on
// the `Sess` is the whole of what the cockpit displays: the phase glyph, the
// attention badge, the vital header, the timeline, the plan, the cost and context
// meters. The heart of the display, and therefore the thing most worth testing.
//
// Everything here reads and writes a `Sess` and nothing else — no DOM, no
// `renderAll()`. The caller renders; this decides *what* to render. Two things it
// needs live upstairs and reach it the way PLAN.md's seam rules prescribe:
// provider permission routing (through the control-plane boundary) and the run-on-stop
// rule, which owns panes and task discovery and so arrives as the
// settable `setOnTurnEnd` hook. See test/phase.test.ts.

import { liveFanout, type Fanout, type Phase, type Risk, type Sess } from "./types";
import { applyTouch, bumpTally } from "./files";
import { addUsage, costDelta } from "./usage";
import { descText, inputText, outputText } from "./toolio";
import { mergeRl, onRlUpdate, rl } from "./rl";
import { resolveProviderPermission } from "./providers/control";
import { clearPermissionState, pendingPermissionIds } from "./permissions";

// A turn ending is exactly when a project's run-on-stop rule gets to check the
// agent's work — but launching that run means task discovery, dependency chains and
// panes, all of which live in main.ts. It wires this at startup; until then, and in
// tests, the end of a turn is just the end of a turn.
let onTurnEnd: (s: Sess) => void = () => {};
export function setOnTurnEnd(fn: (s: Sess) => void) { onTurnEnd = fn; }

// A tool call settled, or a turn ended: this session may have moved HEAD, added a
// worktree, dirtied its working tree, or written into a checkout it wasn't launched in
// — and this is the app's *only* warning that it did. Nothing watches the filesystem,
// so without a nudge from here the sidebar waits for the next poll to notice a branch
// switch and never notices a new checkout at all.
//
// The whole payload travels, not a field or two: the git half reads `tool_input.command`,
// and the drift half needs BOTH `tool_input.file_path` and `cwd` — the two ways an agent
// changes checkout are invisible to each other's signal (see ./gitwatch). Passing `data`
// rather than growing the parameter list keeps that from happening a third time.
//
// A seam rather than a direct call for the same reason as `onTurnEnd`: acting on it
// means git commands, the roster and a repaint, none of which belong in the phase state
// machine. main.ts wires it; in a test a settled tool is just a settled tool.
let onSessionTouched: (s: Sess, tool: string, data: any) => void = () => {};
export function setOnSessionTouched(fn: typeof onSessionTouched) { onSessionTouched = fn; }

// Set the phase and, when it actually changes, stamp phaseSince — the anchor for
// the inspector's dwell timer ("0:42 in state") and the "your turn" wait clock.
export function setPhase(s: Sess, p: Phase) { if (s.phase !== p) { s.phase = p; s.phaseSince = Date.now(); } }
// The most meaningful field of a tool call, for the vital header + timeline. Paths
// collapse to a basename; commands/prompts keep a short preview.
export function toolArg(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? input.description;
  if (typeof v !== "string" || !v.trim()) return "";
  if ((tool === "Read" || tool === "Edit" || tool === "Write") && /[/\\]/.test(v)) return v.split(/[/\\]/).pop() || v;
  return abbr(v, 64);
}
/// How many calls one session rings. The ceiling on what the detail view can cost:
/// twelve rows × the two sides ./toolio caps, and none of it persisted.
export const ACT_CAP = 12;
// Open a timeline entry on PreToolUse; closeActivity fills in its latency and its
// output on the matching PostToolUse.
//
// **The two are paired by `tool_use_id`**, which Claude Code puts on both payloads of a
// call. Matching on the tool name instead — the most recent open call so named — was
// what this did, and it is wrong whenever two calls of one tool overlap, which is the
// normal state of affairs under parallel subagents. That only ever misplaced a latency
// bar, so nobody noticed; attaching a command's *output* to the wrong row is a lie the
// card states plainly, so the name match is now only the fallback for a payload with no
// id (an older CLI, a hook variant that omits it), where a mispairing is no worse than
// what the name match always did.
export function openActivity(s: Sess, tool: string, arg: string, id: string, inp: string, desc: string) {
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  s.activity.unshift({ tool, arg, time, startMs: Date.now(), durMs: null, id, inp, desc, out: "", failed: false });
  if (s.activity.length > ACT_CAP) s.activity.length = ACT_CAP;
}
export function closeActivity(s: Sess, tool: string, id: string, inp: string, desc: string, out: string, failed: boolean) {
  // A ternary, never `||`: with an id that matches nothing — its Pre row aged out past
  // ACT_CAP, or never opened — falling through to the name match closes the oldest
  // *other* open call of the same tool and staples this output onto it. Under parallel
  // subagents that is routine, and a row that says it ran something it didn't is worse
  // than a row with no output. The name match exists for a payload carrying no id.
  const a = id
    ? s.activity.find((x) => x.id === id)
    : s.activity.find((x) => x.tool === tool && x.durMs == null);
  if (!a) return;
  a.durMs = Date.now() - a.startMs;
  a.out = out;
  a.failed = failed;
  // The Post payload repeats `tool_input`, so a row whose Pre hook arrived without one
  // can still be filled — but it never *overwrites*, because an empty repeat is not a
  // correction and the Pre hook is the one that saw the call as it was submitted.
  if (!a.inp && inp) a.inp = inp;
  if (!a.desc && desc) a.desc = desc;
}
// Claude keeps its own to-do list via the TodoWrite tool; the payload rides the
// PreToolUse hook we already receive. Capture it as the session's live plan.
export function applyTodos(s: Sess, input: any) {
  const arr = input?.todos;
  if (!Array.isArray(arr)) return;
  s.todos = arr
    .map((t: any) => ({ content: String(t?.content ?? t?.activeForm ?? ""), status: String(t?.status ?? "pending") }))
    .filter((t) => t.content);
}
// Plan mode surfaces its plan via ExitPlanMode, not TodoWrite — the payload is
// freeform markdown (`tool_input.plan`), not structured items. Parse its list/steps
// into the same plan module so plan-mode plans show up too. Every step is "pending":
// it's a proposal, not yet in flight; a later TodoWrite takes over with live status.
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
// A `Workflow` call hands us its whole script as `tool_input.script`, and the script's
// first statement is a `meta` object literal the tool contract requires to be pure — no
// variables, no interpolation. So the run's name, its one-line description and its phase
// titles are sitting in the hook payload, and the alternative (Claude Code's own
// run-state JSON) is written when the run *ends*, which is exactly too late.
//
// Parsed with regexes rather than evaluated, for the obvious reason: this is arbitrary
// JavaScript arriving from a tool call. Everything is optional — an unparseable script
// still starts a fan-out, just an unnamed one, because the counts are what the sidebar
// needs and they come from the hooks either way.
const META_WINDOW = 4000;
export function parseWorkflowMeta(script: string): { name: string; detail: string; phases: string[] } {
  const at = script.indexOf("export const meta");
  const head = at < 0 ? script.slice(0, META_WINDOW) : script.slice(at, at + META_WINDOW);
  // The literal's closing brace is the first `}` at column 0 — the shape every workflow
  // script is written in. Bounding it matters: `title:` and `name:` occur all over the
  // agent prompts below, and an unbounded match would pick a phase title out of one.
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
  // Bounded here rather than at the surfaces that draw it: a `Fanout` is state, and a
  // 4kB description reaching a sidebar tooltip is not something a view should have to
  // defend against one caller at a time.
  return { name: abbr(one("name"), 56), detail: abbr(one("description"), 120), phases };
}
// A fresh fleet, replacing whatever the last one left behind. The counters restart even
// if the previous fan-out still has agents up — `fanoutTally` is what keeps that from
// showing as a bar past its own end.
//
// Takes the whole tool_input, not the script: a resumed run (`scriptPath` +
// `resumeFromRunId`) carries no script text at all, and parsing the empty string made
// every resumed workflow an unnamed one. The persisted script is named
// `<meta.name>-<runId>.js`, so the basename recovers the name; the record this pane
// already holds wins when the two agree, because it also carries the description and
// the phases a filename cannot.
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
  s.fanout = { ...meta, since: now, started: 0, done: 0, lastAt: now };
}
// The first `SubagentStart` of a plain `Task` burst mints an unnamed record, so the
// counts and the elapsed work for a fan-out nobody wrote a script for.
function fanoutOf(s: Sess): Fanout {
  const now = Date.now();
  return (s.fanout ??= { name: "", detail: "", phases: [], since: now, started: 0, done: 0, lastAt: now });
}

export function abbr(s: string, n = 160): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
// The abbreviated "what is it asking?" preview shown under the attention header.
// Pulls the most meaningful field from the tool input (command, file, url, the
// question/prompt itself…), falling back to the notification message.
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
    // `-[rf]+`, not `-[rf]`: with a single letter the following \b falls between the
    // r and the f of `rm -rf`, so the combined form — the one people actually type —
    // never matched, while the rarer `rm -r` did.
    if (/(^|\s)(sudo|rm\s+-[rf]+|rmdir|mkfs|dd|shutdown|reboot|kill(all)?)\b|git\s+clean|--force\b|--hard\b|-fdx\b|>\s*\/dev\/|:\(\)\s*\{|chmod\s+-R|curl[^|]*\|\s*(sh|bash)|npm\s+publish|git\s+push/i.test(cmd)) return "high";
    return "med";
  }
  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") return "med";
  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "WebFetch" || tool === "WebSearch") return "low";
  return "med";
}
// Fully clear a session's pending-permission/attention state — used both when the
// user answers via Episko's buttons and when they answer directly in the CLI (in
// which case a later lifecycle event, not a button, is our signal to reset). If a
// blocking request is still held server-side, release it so it doesn't leak.
export function clearPending(s: Sess) {
  for (const id of pendingPermissionIds(s)) {
    resolveProviderPermission(s, id, "terminal").catch(() => {});
  }
  clearPermissionState(s);
}

// The one place that decides how a turn ended, because two events reach it and only
// one of them knows anything: `Stop` fires when the turn completed, and Claude Code
// fires the *same* 60-second idle Notification whether the turn completed or died on
// an API error. Unguarded, that idle nudge turned the red ✕ a 529 had just earned
// back into a green "your turn" a minute later — the pane still showing "API Error:
// 529 Overloaded", the sidebar claiming the agent was waiting on the human. So a
// known-failed turn (`apiErr`, set by StopFailure and cleared only when the session
// genuinely starts another one) stays failed until it does.
function endTurn(s: Sess) { setPhase(s, s.apiErr ? "error" : "done"); }
// A new turn is under way, so whatever killed the last one is history. Both signals
// count: a retry the user typed (UserPromptSubmit) and one the model started on its
// own (PreToolUse) — after `/resume` or a queued message there may be no prompt.
function newTurn(s: Sess) { s.apiErr = null; }

// Provider adapters enter the same state machine through these small lifecycle
// verbs. Claude's hooks still use the detailed switch below; App Server-style
// providers do not have to forge Claude payloads merely to earn the same UI state.
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
  // The live count's one repair. `subagents` is differenced from fire-and-forget
  // hooks, so a `SubagentStop` that never arrives leaves it high forever — and past
  // `FANOUT_DEAD_MS` of silence `liveFanout` already answers "no fleet". Believe that
  // answer in the state too, or the ghost count would poison `bg()` below and the
  // *next* fleet's tally, whose total is `done + subagents`.
  if (s.subagents > 0 && !liveFanout(s)) s.subagents = 0;
  const bg = () => s.subagents > 0 || s.phase === "done";
  switch (ev) {
    // Lifecycle events past the permission point → the ask was answered (button
    // OR directly in the CLI), so reset the pending/attention state either way.
    // A fresh REPL — `/clear`, `/compact`, a resume. Nothing the old conversation had
    // in flight survives it, and a `SubagentStop` we will now never see would otherwise
    // leave the count stuck above zero forever, which reads as a fleet that never
    // finishes. The one place either field is reset without a matching event.
    case "SessionStart": setPhase(s, "idle"); clearPending(s); newTurn(s); s.subagents = 0; s.fanout = null; break;
    case "UserPromptSubmit": setPhase(s, "thinking"); clearPending(s); newTurn(s); s.curTool = ""; s.curArg = ""; break;
    case "PreToolUse": {
      const tool = data.tool_name || "tool";
      const arg = toolArg(tool, data.tool_input);
      if (tool === "TodoWrite") applyTodos(s, data.tool_input);
      else if (tool === "ExitPlanMode") applyPlan(s, data.tool_input);
      // The plan is its own module; keep it off the timeline. Everything else opens a
      // row carrying the whole of what was submitted, capped by ./toolio as it lands.
      else openActivity(s, tool, arg, String(data.tool_use_id ?? ""), inputText(tool, data.tool_input), descText(tool, data.tool_input));
      // The one hook that names a fan-out. It fires ~2s before the turn ends, so the
      // record is already in place when `Stop` would otherwise have painted a green ✓.
      if (tool === "Workflow") startFanout(s, data.tool_input);
      if (!bg()) { setPhase(s, "working"); clearPending(s); newTurn(s); s.curTool = tool; s.curArg = arg; }
      break;
    }
    // Failure counts as "touched" too: a compound shell command whose tail failed may
    // still have run the git half, and a failed Edit may have written before it failed.
    case "PostToolUse":
    case "PostToolUseFailure": {
      const tool = data.tool_name || "";
      // What came back, onto the row its `tool_use_id` opened. A failure carries no
      // `tool_response` whatsoever — the reason is in `error` — so both are handed over
      // and ./toolio decides which one it is looking at.
      closeActivity(s, data.tool_name, String(data.tool_use_id ?? ""),
        inputText(tool, data.tool_input), descText(tool, data.tool_input),
        outputText(data.tool_response, data.error),
        ev === "PostToolUseFailure");
      // The Context card's two inputs. Both are fed from the *Post* hook rather than
      // the Pre one the timeline opens on, and for opposite reasons: the file set needs
      // `tool_response` (it is what says create vs. update), and the tally would
      // double-count if it also ran on Pre. A failed call still counts in the tally —
      // it ran — but contributes no file, because "the agent read this" should not
      // appear on the strength of a Read that errored.
      bumpTally(s.tally, tool);
      if (ev === "PostToolUse") applyTouch(s.files, tool, data.tool_input, data.tool_response, Date.now());
      onSessionTouched(s, tool, data);
      if (!bg()) setPhase(s, ev === "PostToolUse" ? "working" : "error");
      break;
    }
    // The turn is over — which is exactly when a project's run-on-stop rule, if it
    // has one, gets to check the agent's work.
    case "Stop": endTurn(s); clearPending(s); s.curTool = ""; s.curArg = "";
      // Reconcile the working set even if the last tool looked read-only, so the state
      // you come back to read is the state after the whole turn.
      onSessionTouched(s, "Stop", data);
      // Only a turn that really ended gets its work checked: an unattended run
      // against a turn the API cut short would be verifying half-written files.
      if (!s.apiErr) onTurnEnd(s);
      break;
    // "The turn ended because the API failed" — the only hook that says so, and the
    // only place the reason exists. `error` is an enum (overloaded, rate_limit,
    // authentication_failed, max_output_tokens…), `error_details` the message the
    // pane shows; both are worth far more than a bare red glyph, since they are the
    // difference between "retry in a minute" and "go re-authenticate".
    case "StopFailure":
      s.apiErr = { kind: String(data.error ?? "unknown"), detail: abbr(String(data.error_details ?? data.message ?? "")), at: Date.now() };
      setPhase(s, "error"); clearPending(s); s.curTool = ""; s.curArg = "";
      break;
    case "SessionEnd": setPhase(s, "ended"); clearPending(s); newTurn(s); s.curTool = ""; s.curArg = ""; s.subagents = 0; s.fanout = null; break;
    case "Notification": {
      const nt: string = data.notification_type ?? "";
      const msg: string = typeof data.message === "string" ? data.message : "";
      if (nt.includes("permission") || /permission/i.test(msg)) { s.attention = "permission needed"; if (msg) s.pendingCmd = abbr(msg); }
      // The REPL has been sitting at the prompt for a minute. That is the turn being
      // over, not the turn having succeeded — endTurn is what knows the difference.
      else if (nt === "idle_prompt") { endTurn(s); clearPending(s); }
      else { s.attention = nt || msg || "notification"; if (msg) s.pendingCmd = abbr(msg); }
      break;
    }
    case "PermissionRequest": s.attention = `permission: ${data.tool_name ?? ""}`; s.pendingCmd = permCmd(data); s.pendRisk = riskLevel(data.tool_name, data.tool_input); break;
    // Every agent a fan-out spawns fires these on the PARENT, workflow fleets included
    // — which is what makes the whole background readout possible without a byte of
    // disk. `subagents` stays the live count; the cumulative pair rides the record.
    // A record `liveFanout` has already written off is history, not the burst starting
    // now: resuming it would put a finished run's counters under a fresh fleet ("12 of
    // 14 done" for two agents that just launched). Within the grace lull it is the
    // same run, and the record — with its name and phases — carries on.
    case "SubagentStart": {
      if (!liveFanout(s)) s.fanout = null;
      s.subagents++; const f = fanoutOf(s); f.started++; f.lastAt = Date.now(); break;
    }
    // No record means a Stop whose Start we never saw (a fan-out that predates the
    // pane, a rotated session). Counting it would invent a completion.
    case "SubagentStop":
      s.subagents = Math.max(0, s.subagents - 1);
      if (s.fanout) { s.fanout.done = Math.min(s.fanout.started, s.fanout.done + 1); s.fanout.lastAt = Date.now(); }
      break;
  }
}
export function pushHist(arr: number[], v: number, cap = 24) { arr.push(v); if (arr.length > cap) arr.splice(0, arr.length - cap); }
export function applyStatusline(s: Sess, data: any) {
  // A statusLine only fires from a live, interactive session. If this one was
  // marked "ended" (e.g. a SessionEnd fired on /clear or /compact while the REPL
  // kept running), the continuing statusLine proves it's alive — clear the stale
  // ended state. A genuine exit stops statusLines and pty-exit re-ends it.
  if (s.phase === "ended") setPhase(s, "idle");
  if (data.model?.display_name) s.model = data.model.display_name;
  const ctx = data.context_window?.used_percentage;
  if (typeof ctx === "number") { s.ctxPct = ctx; pushHist(s.ctxHist, ctx); }
  const tok = data.context_window?.used_tokens ?? data.context_window?.tokens;
  if (typeof tok === "number") s.ctxTokens = tok;
  const cost = data.cost?.total_cost_usd;
  // The day's increment comes from the conversation's own baseline, not from this
  // pane's last reading — a resumed session inherits Claude's running total, and a
  // pane that started at `cost: null` would book the whole of it again. See costDelta.
  if (typeof cost === "number") { addUsage(costDelta(s.resumeId || s.id, cost), s); s.cost = cost; pushHist(s.costHist, cost); }
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
  // Feed the same normalized per-session shape every control-plane adapter uses. The
  // global Claude copy remains the account-wide merge/forecast authority, while this
  // makes shared inspector/footer surfaces independent of statusLine field names.
  s.rateLimits = [
    ...(rl.h5 == null ? [] : [{ usedPercent: rl.h5, resetsAt: rl.h5Reset, windowMins: 300 }]),
    ...(rl.d7 == null ? [] : [{ usedPercent: rl.d7, resetsAt: rl.d7Reset, windowMins: 10080 }]),
  ];
  // Keep the worktree flag if the statusline reports one, but the branch label
  // itself comes from the live git HEAD poll (refreshBranches), not this field —
  // otherwise the two fight and the label flickers.
  const wt = data.workspace?.git_worktree; if (wt) s.worktree = wt;
}
