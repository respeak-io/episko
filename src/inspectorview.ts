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

import { basename, esc, fmtDur, fmtDwell, fmtLatency, fmtMb, fmtRate, sparkline, tilde } from "./format";
import type { DiffHunk } from "./diff";
import { apiErrText, isAgent, statusKey, type DiffStat, type Risk, type Sess } from "./types";
import { ioAll, ioInfoAt, ioScope, sessions, type IoScope } from "./state";
import { dayIo, ioDayCount, ioSameNote, ioTotal, todayKey } from "./usage";

// Which session has a fetch/pull/push in flight, if any — the git buttons are
// disabled while one is.
export let gitBusy: string | null = null;
export function setGitBusy(id: string | null) { gitBusy = id; }
// Shared by the resource bars and the shell inspector: colour a 0–100 meter.
const mc = (v: number) => (v >= 80 ? "hot" : v >= 55 ? "warn" : "");

// ---- inspector: shared helpers for the redesigned modules ----
const TOOL_VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Browsing", WebSearch: "Searching", TodoWrite: "Planning" };
function toolVerb(tool: string): string {
  if (!tool) return "Working";
  if (tool.startsWith("Task")) return "Delegating";
  if (tool.startsWith("mcp__")) return "Calling tool";
  return TOOL_VERB[tool] || "Working";
}
// Maps a tool to the CSS colour class that tints its dot / name / verb.
function toolClass(tool: string): string {
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
  if (s.phase === "error") return s.apiErr ? apiErrText(s.apiErr) : "Error";
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
    <div class="vtop"><span class="heart ${live ? "" : "still"}"></span><span class="vstate ${tcls}">${verb}</span><span class="dwell" id="iDwell"></span></div>
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
// "This session is somewhere else." Sits at the top of the inspector because it
// reframes every figure below it: the working set, the branch and the fetch/pull/push
// buttons all read the *launch* folder, and while a drift is showing, that is not where
// the work is going.
//
// The copy and the button differ by `via`, because the two drifts are genuinely
// different situations rather than one situation with two causes — one is Episko being
// behind (free to fix), the other is a relocation only Episko can perform. Saying
// "move" for the first would overstate what happens; saying "follow" for the second
// would understate it.
export function driftHtml(s: Sess): string {
  const d = s.drift!;
  const here = esc(s.branch || basename(s.workdir));
  const cwdMove = d.via === "cwd";
  const note = cwdMove
    ? `Claude moved this session itself, so its conversation is already there. Episko is still showing <span class="b">${here}</span>; following it costs nothing and interrupts nothing.`
    : `The session is still running in <span class="b">${here}</span>, so its branch, working set and git buttons read that checkout. Moving it takes the conversation along.`;
  return `<div class="drift">
    <div class="drift-h"><span class="drift-g">⤳</span>Working in <span class="b">${esc(d.branch)}</span></div>
    <div class="drift-path" title="${esc(d.dir)}">${esc(tilde(d.dir))}</div>
    <div class="drift-note">${note}</div>
    <div class="drift-btns"><button data-driftfollow="${esc(s.id)}">${cwdMove ? "Follow it here" : "Move session here"}</button></div>
  </div>`;
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
    ? `<span class="sync${g.ahead || g.behind ? "" : " even"}" title="${esc(g.upstream)} · as of the last fetch">${
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
function gitBtnsHtml(s: Sess, g: DiffStat): string {
  const busy = gitBusy === s.id;
  const up = !!g.upstream;
  const btn = (op: string, label: string, off: string, hint: string) =>
    `<button class="gitb" data-git="${op}" data-gitsid="${s.id}"${busy || off ? " disabled" : ""} title="${esc(off || hint)}">${label}</button>`;
  const pullHint = !up ? "No upstream; opens a terminal to set one"
    : g.ahead && g.behind ? `Diverged; opens a terminal to rebase`
    : `git pull --ff-only (${g.behind} behind)`;
  const pushHint = !up ? "No upstream; opens a terminal to publish the branch"
    : g.behind ? "Behind; opens a terminal to pull first"
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
// Disk I/O for the session's `claude` process. Replaced cpu/mem, which measured the one
// thing a Claude session is never short of: this is an I/O-bound workload — it reads
// your tree and writes files — and a runaway agent shows up as sustained throughput
// long before it shows up as CPU.
//
// The bar is log-scaled against a 32 MiB/s reference rather than linear: real rates span
// idle-KiB/s to burst-MiB/s, and a linear bar would sit at zero for everything short of a
// pathological write storm, which is precisely the case it needs to show.
const IO_REF_BPS = 32 * 1024 * 1024;
function ioPct(bps: number): number {
  if (bps <= 0) return 0;
  return Math.max(2, Math.min(100, (Math.log10(bps / 1024 + 1) / Math.log10(IO_REF_BPS / 1024 + 1)) * 100));
}
// App-wide, not per-session: `ioAll` sums every claude process Episko owns, so this
// block reads the same on whichever pane you happen to have open — like the rate
// limits, and labelled so nobody mistakes it for the session in front of them.
/// The three windows the total row can show, and what each honestly covers. `run` is
/// the raw reading; the other two come from the `cc-io` rollup, which only starts the
/// day it shipped — so a machine that has just updated has a `today` smaller than its
/// `run`, which is correct rather than a bug.
const IO_SCOPE_LABEL: Record<IoScope, string> = { today: "today", run: "this run", all: "recorded" };
function ioFigures(scope: IoScope): { r: number; w: number; known: boolean } {
  if (scope === "run") return { r: ioAll.readMb, w: ioAll.writtenMb, known: true };
  const v = scope === "today" ? dayIo[todayKey()] : ioTotal();
  return { r: v?.r ?? 0, w: v?.w ?? 0, known: !!v };
}
/// What one scope reads as. The note below compares these strings rather than the
/// floats, because two figures that round to the same text are the same figure to
/// whoever is looking at the row.
function ioText(scope: IoScope): string {
  const f = ioFigures(scope);
  return f.known ? `${fmtMb(f.r)} read · ${fmtMb(f.w)} written` : "not recorded";
}
/// Why the figures in this box look the way they do.
///
/// Every number here is **physical** disk I/O — what the kernel's per-process counters
/// (`proc_pid_rusage` on macOS, and its equivalents elsewhere, via sysinfo) actually
/// charged the claude processes Episko spawned. Three things about that surprise people
/// enough to be worth a panel, and all three were measured on this machine rather than
/// reasoned about:
///
/// - Writes ran ~32× the transcript's own growth (3.11 MiB of physical writes against
///   0.10 MiB of transcript in 90s). Claude Code appends and fsyncs after every message,
///   and a flush commits whole blocks; that is its journalling, not Episko's overhead
///   and not something Episko can batch away.
/// - Reads ran far *below* what the agents obviously read, because a page-cache hit
///   never reaches the disk — a hot repo re-read costs nothing here.
/// - Children are absent, and not by omission: a child that wrote 120 MiB moved its
///   parent's counter by exactly 0.00 MiB. The OS never adds an exited child's bytes to
///   its parent, so walking the process tree would still miss every sub-second `rg` or
///   `git` that lives and dies between two four-second polls.
///
/// Kept as data rather than one blob of markup so the shape stays obvious and the strings
/// stay greppable.
///
/// The panel expands rather than appearing, and getting that to happen at all is the
/// interesting part — see `ioInfoAnim`.
const IO_INFO: Array<[string, string]> = [
  ["Writes run far above the conversation",
    "Claude Code appends to its transcript and fsyncs after every message, and each flush commits whole blocks, measured here at ~32× the transcript's own growth. That is Claude Code's own journalling; Episko only reports it."],
  ["Reads look small",
    "Anything already in the page cache never reaches the disk, so re-reading a warm repo costs nothing on this meter."],
  ["Child processes are not counted",
    "The git, ripgrep and node work an agent spawns churns invisibly: the OS never adds a child's bytes to its parent when it exits."],
];
/// How long the expander takes. Mirrored in styles.css (`rinfo-open`) — the two have to
/// agree, because this file decides when the animation is *over*.
const IO_INFO_MS = 220;
/// The inline `style` that makes the expander survive this app's render model.
///
/// A CSS **transition** is useless here: `#inspector` is rebuilt by `innerHTML` on every
/// pass, so the node that would transition is a brand-new one already in its final state
/// — which is why `.pfbody`'s transition in the sidebar never actually plays either. A
/// keyframes **animation** does run on a freshly-inserted node, so that is what this uses.
///
/// But that trades one bug for another: the inspector repaints on telemetry, so a repaint
/// landing 80ms into the animation would insert *another* fresh node and play the whole
/// expansion again — the panel would visibly collapse and re-open under a busy fleet.
/// A negative `animation-delay` fixes it: it starts an animation partway through, so each
/// replacement node *resumes* where its predecessor was instead of restarting. Once the
/// run is over the animation is switched off outright, which also settles the markup
/// string so ./inspector's guard can go back to skipping repaints.
function ioInfoAnim(): string {
  const el = Date.now() - ioInfoAt;
  return el >= IO_INFO_MS ? ` style="animation:none"` : ` style="animation-delay:-${el}ms"`;
}
export function resHtml(): string {
  const r = ioAll;
  const info = ioInfoAt > 0;
  // Before the second sample there is no window to average over, so the rate is unknown
  // rather than zero — say so instead of showing a confident "0 B/s".
  const rd = r.primed ? fmtRate(r.readBps) : "—";
  const wr = r.primed ? fmtRate(r.writeBps) : "—";
  const rp = r.primed ? ioPct(r.readBps) : 0, wp = r.primed ? ioPct(r.writeBps) : 0;
  const n = [...sessions.values()].filter((x) => isAgent(x) && !x.external).length;
  // The total is a *window*, and which window was never stated — it said "total" while
  // showing the current run, so it read as a lifetime figure that reset overnight. The
  // scope is now named on the row and the whole row cycles it.
  const tot = ioText(ioScope);
  // The `⟳` is permanent, not a hover reveal. This row sits directly under two static
  // ones it is pixel-identical to at rest, so the only thing that said "clickable" was
  // a hover highlight — which nobody finds, because nobody hovers a label. A cycling
  // control has to look like one before it is touched.
  //
  // The note below it is the other half: the three windows legitimately coincide on a
  // machine's first day (see `ioSameNote`), and a click that visibly changes nothing is
  // indistinguishable from a broken one unless the row says why.
  const note = ioSameNote(ioText("today"), ioText("run"), ioText("all"), ioDayCount());
  return `<div class="res" title="Disk I/O across every claude session Episko is running (${n}) · ${fmtMb(r.readMb)} read, ${fmtMb(r.writtenMb)} written this run">
    <div class="rr rall"><span class="rk">all sessions</span><span class="rvall">${n} running</span><button class="rinfob${info ? " on" : ""}" data-ioinfo="1" aria-expanded="${info}" title="${info ? "Hide" : "Why these figures look the way they do"}">i</button></div>
    <div class="rr"><span class="rk">read</span><span class="rbar ${mc(rp)}"><i style="width:${rp}%"></i></span><span class="rv">${rd}</span></div>
    <div class="rr"><span class="rk">write</span><span class="rbar ${mc(wp)}"><i style="width:${wp}%"></i></span><span class="rv">${wr}</span></div>
    <button class="rr rtot" data-ioscope="1" title="${esc(IO_SCOPE_TITLE[ioScope])}"><span class="rk">${IO_SCOPE_LABEL[ioScope]}</span><span class="rcyc">⟳</span><span class="rvtot">${tot}</span></button>
    ${note ? `<p class="rnote">${esc(note)}</p>` : ""}
    ${info ? `<div class="rinfo"${ioInfoAnim()}><div class="rinfo-in"><p class="rinfo-lead">Physical disk I/O charged to the claude processes Episko launched, rather than their logical reads and writes.</p>${
      IO_INFO.map(([h, b]) => `<p><b>${esc(h)}</b>${esc(b)}</p>`).join("")
    }</div></div>` : ""}</div>`;
}
/// Spelled out per scope rather than one generic hint, because the difference between
/// them is the whole point and two of the three have a caveat worth one sentence.
const IO_SCOPE_TITLE: Record<IoScope, string> = {
  today: "Disk I/O by Episko's claude sessions today. Click for this run",
  run: "Disk I/O since Episko started: the processes' own counters, which reset with the app. Click for everything recorded",
  all: "Disk I/O across every day Episko has recorded one. It starts when this rollup shipped, so it is not a lifetime figure. Click for today",
};
