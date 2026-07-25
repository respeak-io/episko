// The inspector's markup: everything the right-hand panel shows about an agent
// session — the vital header, the context/cost gauges, the plan, the working set
// and its git buttons, the activity timeline, the resource bars — plus the diff
// viewer's hunk rows.
//
// Same boundary as ./usageview: every function here takes a Sess (or a plain
// value) and returns a string. It touches no DOM and calls no renderer, so it
// needs no seam back into main.ts. renderInspector itself stays there, because
// its job is to decide which of these to paint and to put the result in the page.
//
// It owns `gitBusy` for the same reason it owns the buttons: which session has a
// git operation in flight is only ever read to grey them out. main.ts's runGit
// sets it through setGitBusy — the state.ts convention, a live binding to read.

import { esc, fmtDur, fmtDwell, fmtLatency, sparkline } from "./format";
import type { DiffHunk } from "./diff";
import { isAgent, statusKey, type DiffStat, type Risk, type Sess } from "./types";
import { sessions } from "./state";

// Which session has a fetch/pull/push in flight, if any — the git buttons are
// disabled while one is.
export let gitBusy: string | null = null;
export function setGitBusy(id: string | null) { gitBusy = id; }
// Shared by the resource bars and the shell inspector: colour a 0–100 meter.
export const mc = (v: number) => (v >= 80 ? "hot" : v >= 55 ? "warn" : "");

// ---- inspector: shared helpers for the redesigned modules ----
const TOOL_VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Browsing", WebSearch: "Searching", TodoWrite: "Planning" };
export function toolVerb(tool: string): string {
  if (!tool) return "Working";
  if (tool.startsWith("Task")) return "Delegating";
  if (tool.startsWith("mcp__")) return "Calling tool";
  return TOOL_VERB[tool] || "Working";
}
// Maps a tool to the CSS colour class that tints its dot / name / verb.
export function toolClass(tool: string): string {
  if (!tool) return "";
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return "t-read";
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit") return "t-edit";
  if (tool === "Bash") return "t-bash";
  if (tool.startsWith("Task")) return "t-task";
  if (tool === "WebFetch" || tool === "WebSearch") return "t-web";
  return "t-mcp";
}
export const RISK_LABEL: Record<Risk, string> = { low: "low risk", med: "review", high: "high risk" };
export function verbFor(s: Sess): string {
  if (s.phase === "thinking") return "Thinking";
  if (s.phase === "working") return toolVerb(s.curTool);
  if (s.phase === "done") return "Your turn";
  if (s.phase === "error") return "Error";
  if (s.phase === "ended") return "Ended";
  return "Idle";
}
// Live text under the state name — recomputed each second by tickTimers().
export function dwellText(s: Sess): string {
  if (s.phase === "ended") return "session ended";
  const d = fmtDwell(Date.now() - s.phaseSince);
  if (s.phase === "done") return `waiting ${d}`;
  if (s.phase === "idle") return `idle ${d}`;
  if (s.phase === "error") return `${d} ago`;
  return `${d} in state`;
}
// True when this is the "your turn" session that's been blocked longest — the one
// to jump to first. Only meaningful when several are waiting.
function isLongestWaiting(s: Sess): boolean {
  const waiting = [...sessions.values()].filter((x) => x.phase === "done" && isAgent(x) && !x.attention);
  return waiting.length > 1 && waiting.every((x) => x.id === s.id || x.phaseSince >= s.phaseSince);
}
function compactWarn(pct: number | null): { txt: string; cls: string } | null {
  if (pct == null) return null;
  if (pct >= 90) return { txt: "auto-compact imminent", cls: "hot" };
  if (pct >= 78) return { txt: "approaching auto-compact", cls: "warn" };
  return null;
}

// ---- inspector: per-module HTML builders (act → track → reference) ----
export function vitalHtml(s: Sess): string {
  const sk = statusKey(s);
  const live = (s.phase === "working" || s.phase === "thinking") && !s.attention;
  const verb = s.attention ? "Needs you" : verbFor(s);
  const tcls = (!s.attention && s.phase === "working") ? toolClass(s.curTool) : "";
  const doing = (!s.attention && s.phase === "working" && s.curTool)
    ? `<div class="doing"><span class="tk ${toolClass(s.curTool)}">${esc(s.curTool)}</span>${s.curArg ? `<code>${esc(s.curArg)}</code>` : ""}</div>` : "";
  const chips = [s.model ? esc(s.model) : "", s.subagents ? `${s.subagents} subagent${s.subagents > 1 ? "s" : ""}` : ""]
    .filter(Boolean).map((c) => `<span class="chip-s">${c}</span>`).join("");
  const longest = s.phase === "done" && isLongestWaiting(s) ? `<span class="chip-s hot">longest waiting</span>` : "";
  const meta = chips || longest ? `<div class="vmeta">${chips}${longest}</div>` : "";
  return `<div class="vital st-${sk}">
    <div class="vtop"><span class="heart ${live ? "" : "still"}"></span><span class="vstate ${tcls}">${verb}</span><span class="dwell" id="iDwell">${esc(dwellText(s))}</span></div>
    ${doing}${meta}</div>`;
}
export function gaugesHtml(s: Sess): string {
  const ctx = s.ctxPct;
  const warn = compactWarn(ctx);
  const ctxSpark = sparkline(s.ctxHist, { lo: 0, hi: 100 });
  const costSpark = sparkline(s.costHist, { lo: 0 });
  const tokTxt = s.ctxTokens != null ? `${Math.round(s.ctxTokens / 1000)}k tokens` : "context";
  const ctxFoot = warn ? `<div class="warn-line ${warn.cls}">${warn.txt}</div>` : (ctxSpark ? `<div class="gspark">${ctxSpark}</div>` : "");
  const costFoot = costSpark ? `<div class="gspark">${costSpark}</div>` : "";
  return `<div class="gauges">
    <div class="gauge">
      <div class="grow"><svg class="mini-ring" viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="15"></circle><circle class="fil" cx="20" cy="20" r="15" pathLength="100" stroke-dasharray="${Math.max(0, Math.min(100, ctx ?? 0))} 100"></circle></svg><div><div class="gnum">${ctx != null ? Math.round(ctx) + "%" : "–"}</div><div class="glab">${tokTxt}</div></div></div>
      ${ctxFoot}
    </div>
    <div class="gauge">
      <div class="grow"><div><div class="gnum">${s.cost != null ? "$" + s.cost.toFixed(2) : "–"}</div><div class="glab">${s.durMs != null ? fmtDur(s.durMs) : "cost"}</div></div></div>
      ${costFoot}
    </div>
  </div>`;
}
export function planHtml(s: Sess): string {
  const done = s.todos.filter((t) => t.status === "completed").length, total = s.todos.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rows = s.todos.slice(0, 5).map((t) => {
    const cls = t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "";
    return `<div class="todo ${cls}"><span class="bx"></span><span class="tx">${esc(t.content)}</span></div>`;
  }).join("");
  const more = total > 5 ? `<div class="todo-more">+${total - 5} more</div>` : "";
  return `<div class="plan"><div class="ph"><span class="lab">Plan</span><span class="frac">${done} / ${total}</span></div><div class="pbar"><i style="width:${pct}%"></i></div>${rows}${more}</div>`;
}
export function wsetHtml(s: Sess): string {
  const g = s.git!;
  const tot = g.added + g.removed || 1;
  const aw = Math.round((g.added / tot) * 100);
  const newBadge = g.untracked ? `<span class="unc">${g.untracked} new</span>` : "";
  const dirty = g.files || g.untracked;
  // The diff half is only worth drawing when something is actually uncommitted —
  // a clean tree that's 5 behind still needs the branch/sync row below.
  const diff = dirty
    ? `<div class="wpeek" data-diff="${esc(s.workdir)}" data-difftitle="${esc(s.project + (s.branch ? " · " + s.branch : ""))}" title="Open the uncommitted diff">
      <div class="wtop"><span class="add">+${g.added}</span><span class="del">−${g.removed}</span><span class="files">${g.files} file${g.files === 1 ? "" : "s"}</span><span class="wpeek-cue">⤢</span></div>
      <div class="stackbar"><span class="sa" style="width:${aw}%"></span><span class="sd" style="width:${100 - aw}%"></span></div></div>`
    : "";
  const sync = g.upstream
    ? `<span class="sync${g.ahead || g.behind ? "" : " even"}" title="${esc(g.upstream)} — as of the last fetch">${
        g.ahead || g.behind ? `${g.ahead ? `<span class="ah">↑${g.ahead}</span>` : ""}${g.behind ? `<span class="bh">↓${g.behind}</span>` : ""}` : "in sync"
      }</span>`
    : `<span class="sync none" title="This branch tracks no upstream">no upstream</span>`;
  return `<div class="wset">${diff}
    <div class="branch"><span>${s.worktree ? "⑃ " : ""}<span class="b">${esc(s.branch || "—")}</span>${sync}</span>${newBadge}</div>
    ${gitBtnsHtml(s, g)}</div>`;
}
// Fetch / pull / push for the session's workdir.
//
// A button is only greyed out when there is genuinely *nothing to do* — never for
// the awkward states. A diverged branch, or one with no upstream, keeps its button
// live precisely because that's where the backend refuses with a suggestion and we
// hand the user a prefilled terminal; disabling those would amputate the useful
// half. "Nothing to do" needs a known upstream, since without one ahead/behind are
// both 0 and would otherwise read as "nothing to push".
export function gitBtnsHtml(s: Sess, g: DiffStat): string {
  const busy = gitBusy === s.id;
  const up = !!g.upstream;
  const btn = (op: string, label: string, off: string, hint: string) =>
    `<button class="gitb" data-git="${op}" data-gitsid="${s.id}"${busy || off ? " disabled" : ""} title="${esc(off || hint)}">${label}</button>`;
  const pullHint = !up ? "No upstream — opens a terminal to set one"
    : g.ahead && g.behind ? `Diverged — opens a terminal to rebase`
    : `git pull --ff-only (${g.behind} behind)`;
  const pushHint = !up ? "No upstream — opens a terminal to publish the branch"
    : g.behind ? "Behind — opens a terminal to pull first"
    : `git push (${g.ahead} ahead)`;
  return `<div class="gitrow${busy ? " busy" : ""}">
    ${btn("fetch", "fetch", "", "git fetch --prune")}
    ${btn("pull", "pull", up && !g.behind ? "Nothing to pull" : "", pullHint)}
    ${btn("push", "push", up && !g.ahead ? "Nothing to push" : "", pushHint)}
  </div>`;
}

export function hunkHtml(h: DiffHunk): string {
  const rows = h.lines.map((l) => {
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : "";
    return `<div class="dline ${l.kind}"><span class="ln">${l.oldNo ?? ""}</span><span class="ln">${l.newNo ?? ""}</span><span class="dsign">${sign}</span><span class="lc">${esc(l.text)}</span></div>`;
  }).join("");
  const ctx = h.header ? `<span class="dhh-ctx">${esc(h.header)}</span>` : "";
  return `<div class="dhunk"><div class="dhh">⋯${ctx}</div>${rows}</div>`;
}

export function timelineHtml(s: Sess): string {
  const acts = s.activity.slice(0, 8);
  if (!acts.length) return `<div><div class="lab" style="margin-bottom:6px">Activity</div><div class="insp-empty" style="padding:12px 0">No activity yet.</div></div>`;
  const maxDur = Math.max(1, ...acts.map((a) => a.durMs ?? 0));
  const rows = acts.map((a) => {
    const cls = toolClass(a.tool);
    const running = a.durMs == null;
    const w = running ? 100 : Math.max(6, Math.round(((a.durMs ?? 0) / maxDur) * 100));
    const ms = running ? "···" : fmtLatency(a.durMs!);
    return `<div class="row"><span class="dot ${cls}"></span><span class="nm ${cls}">${esc(a.tool)}</span><span class="arg">${esc(a.arg)}</span><span class="lat"><span class="latbar ${running ? "run" : ""}" style="width:${w}%"></span><span class="ms">${ms}</span></span></div>`;
  }).join("");
  return `<div><div class="lab" style="margin-bottom:6px">Activity · by tool</div><div class="tl2">${rows}</div></div>`;
}
export function resHtml(s: Sess): string {
  const r = s.res!;
  const cpu = Math.min(100, r.cpu), memPct = Math.min(100, (r.memMb / 2048) * 100);
  return `<div class="res">
    <div class="rr"><span class="rk">cpu</span><span class="rbar ${mc(cpu)}"><i style="width:${cpu}%"></i></span><span class="rv">${r.cpu.toFixed(0)}%</span></div>
    <div class="rr"><span class="rk">mem</span><span class="rbar ${mc(memPct)}"><i style="width:${memPct}%"></i></span><span class="rv">${r.memMb.toFixed(0)} MB</span></div></div>`;
}
