// The inspector's markup: everything the right-hand panel shows about an agent
// session — the vital header, the context/cost gauges, the plan, the working set
// and its git buttons, the activity timeline — plus the diff viewer's hunk rows.
//
// The disk-I/O card used to be pinned to the bottom of this panel and is now a footer
// segment (./usageview's `ioPopHtml`): it was app-wide rather than per-session, so it
// read identically whichever pane was on stage while costing ~120px of a 296px column.
//
// Same boundary as ./usageview: every function here takes a Sess (or a plain
// value) and returns a string. It touches no DOM and calls no renderer, so it
// needs no seam back into main.ts. renderInspector itself stays there, because
// its job is to decide which of these to paint and to put the result in the page.
//
// It owns `gitBusy` for the same reason it owns the buttons: which session has a
// git operation in flight is only ever read to grey them out. main.ts's runGit
// sets it through setGitBusy — the state.ts convention, a live binding to read.

import { basename, elidePath, esc, escAttr, fmtDur, fmtDwell, fmtLatency, sparkline, tilde } from "./format";
import { FILE_MANAGER } from "./dom";
import { fileLabel, GROUP_ORDER, groupTouches, otherTools, shortTool } from "./files";
import {
  actKey, apiErrText, bgWaiting, fanoutTally, fanoutText, isAgent, liveFanout, statusKey,
  type Act, type DiffStat, type FileTouch, type Risk, type Sess, type TouchKind,
} from "./types";
import { sessions } from "./state";

// Which session has a fetch/pull/push in flight, if any — the git buttons are
// disabled while one is.
export let gitBusy: string | null = null;
export function setGitBusy(id: string | null) { gitBusy = id; }
// ---- inspector: shared helpers for the redesigned modules ----
const TOOL_VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Browsing", WebSearch: "Searching", TodoWrite: "Planning" };
function toolVerb(tool: string): string {
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
  // Ahead of the phase, because the phase is `done` and saying so is the bug.
  if (bgWaiting(s)) return fanoutText(s);
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
  // The fan-out's clock, not the phase's: `phaseSince` was stamped when the turn ended,
  // which is the moment the fleet *started* and therefore says nothing about the wait.
  // It is also the only live clock the fan-out has — the card below carries no time, so
  // that the inspector's innerHTML guard keeps biting (see paintInspector).
  const f = bgWaiting(s) ? liveFanout(s) : null;
  if (f) return `${fmtDwell(Date.now() - f.since)} in background`;
  const d = fmtDwell(Date.now() - s.phaseSince);
  if (s.phase === "done") return `waiting ${d}`;
  if (s.phase === "idle") return `idle ${d}`;
  if (s.phase === "error") return `${d} ago`;
  return `${d} in state`;
}
// True when this is the "your turn" session that's been blocked longest — the one
// to jump to first. Only meaningful when several are waiting.
// A session whose fleet is still running is not in the queue at all — it is not blocked
// on you, so crowning it "longest waiting" would point you at the one row with nothing
// to answer.
function isLongestWaiting(s: Sess): boolean {
  const waiting = [...sessions.values()].filter((x) => x.phase === "done" && isAgent(x) && !x.attention && !bgWaiting(x));
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
  const fan = fanoutTally(s);
  // The heartbeat is "something is happening here", not "the model is talking" — a fleet
  // of thirteen agents is the busiest this app ever gets, and a still heart over it read
  // as an idle session.
  const live = (s.phase === "working" || s.phase === "thinking" || bgWaiting(s)) && !s.attention;
  const verb = s.attention ? "Needs you" : verbFor(s);
  const tcls = (!s.attention && s.phase === "working") ? toolClass(s.curTool) : "";
  const doing = (!s.attention && s.phase === "working" && s.curTool)
    ? `<div class="doing"><span class="tk ${toolClass(s.curTool)}">${esc(s.curTool)}</span>${s.curArg ? `<code>${esc(s.curArg)}</code>` : ""}</div>` : "";
  // While a fleet is up, the split of it — done vs still running — says more than the
  // bare "N subagents" chip this replaces, which only ever showed the live half.
  const chips = [s.model ? esc(s.model) : "", ...(fan ? [`${fan.done} done`, `${s.subagents} running`] : [])]
    .filter(Boolean).map((c) => `<span class="chip-s">${c}</span>`).join("");
  const longest = s.phase === "done" && !bgWaiting(s) && isLongestWaiting(s) ? `<span class="chip-s hot">longest waiting</span>` : "";
  const meta = chips || longest ? `<div class="vmeta">${chips}${longest}</div>` : "";
  return `<div class="vital st-${sk}">
    <div class="vtop"><span class="heart ${live ? "" : "still"}"></span><span class="vstate ${tcls}">${verb}</span><span class="dwell" id="iDwell"></span></div>
    ${doing}${meta}</div>`;
}
/// The background fleet: what it is, how much of it has landed, and what it set out to
/// do. Sits directly under the vital, because while it is up it *is* the state of the
/// session — the gauges below it describe a conversation that stopped talking.
///
/// **No clock in this markup.** The elapsed lives in `#iDwell`, which main.ts patches by
/// `textContent` once a second; a time in here would make the string differ on every
/// repaint and permanently defeat `paintInspector`'s guard, on the surface that guard
/// exists to protect (see its comment — a lost *Allow* is how that was learned).
///
/// The phases are listed, never ticked off. No hook says which phase a workflow has
/// reached, and a progress bar drawn over the agent counts is the only claim the
/// telemetry actually supports.
export function fanoutHtml(s: Sess): string {
  const f = liveFanout(s), t = fanoutTally(s);
  if (!f || !t) return "";
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const name = f.name || "Background agents";
  const detail = f.detail ? `<div class="fo-detail">${esc(f.detail)}</div>` : "";
  const phases = f.phases.length
    ? `<div class="fo-phases">${f.phases.map((p) => `<span class="fo-ph">${esc(p)}</span>`).join("")}</div>` : "";
  return `<div class="fanout">
    <div class="fo-h"><span class="fo-g">◐</span><span class="fo-name" title="${esc(name)}">${esc(name)}</span><span class="fo-frac">${t.done} / ${t.total}</span></div>
    ${detail}
    <div class="fo-bar"><i style="width:${pct}%"></i></div>
    ${phases}</div>`;
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
/// The clickable half of the working-set card — the counts, the churn bar, and the cue
/// saying that both of them open the diff. Exported because ./mirror paints the same
/// block for an external session's folder: the two were copies, and copies of a card
/// this small drift in exactly the way the two bugs below did.
///
/// Two things it must never do again, both of which shipped:
///
/// - **Never split the bar when there is no churn.** `added + removed || 1` gave the
///   deletion half 100% of the width whenever both were zero, so a tree whose only
///   change is one new file drew a full-width red bar: the loudest possible rendering
///   of nothing having been deleted. No churn, no split — the empty track says it.
/// - **Never count only the tracked files.** `files` comes from `diff --numstat HEAD`,
///   which a never-committed file is not in, so the card read `0 files` directly above
///   a `1 new` chip and the two argued with each other. There is now one count, of
///   everything git calls dirty, with the new ones named as a share of it rather than
///   as a separate figure somewhere else in the card.
///
/// The `+N −M` pair is dropped entirely when nothing tracked changed, rather than
/// printed as `+0 −0`: an untracked file has no line counts until it is added, and a
/// pair of zeroes reads as "nothing happened" beside a count saying something did.
export function wpeekHtml(dir: string, title: string, g: DiffStat): string {
  const churn = g.added + g.removed;
  const aw = churn ? Math.round((g.added / churn) * 100) : 0;
  // `dirty` is git's own porcelain line count, so it covers the entries numstat misses
  // (untracked, unmerged, mode-only); the sum is the fallback for a stat that predates it.
  const touched = g.dirty || g.files + g.untracked;
  const plural = touched === 1 ? "" : "s";
  // "1 file · 1 new" is true and still silly. When every dirty entry is a new file there
  // is no share to name, so the count says what they are instead of what they aren't.
  const count = g.untracked >= touched
    ? `${touched} new file${plural}`
    : `${touched} file${plural}${g.untracked ? ` · ${g.untracked} new` : ""}`;
  const lines = churn ? `<span class="add">+${g.added}</span><span class="del">−${g.removed}</span>` : "";
  const bar = churn
    ? `<div class="stackbar"><span class="sa" style="width:${aw}%"></span><span class="sd" style="width:${100 - aw}%"></span></div>`
    : `<div class="stackbar flat"></div>`;
  return `<div class="wpeek" data-diff="${escAttr(dir)}" data-difftitle="${escAttr(title)}" title="Review the working set — ${escAttr(count)}">
      <div class="wtop">${lines}<span class="files${lines ? "" : " lone"}">${count}</span><span class="wpeek-cue">⤢</span></div>
      ${bar}</div>`;
}
export function wsetHtml(s: Sess): string {
  const g = s.git!;
  const dirty = g.files || g.untracked;
  // The diff half is only worth drawing when something is actually uncommitted —
  // a clean tree that's 5 behind still needs the branch/sync row below.
  const diff = dirty ? wpeekHtml(s.workdir, s.project + (s.branch ? " · " + s.branch : ""), g) : "";
  const sync = g.upstream
    ? `<span class="sync${g.ahead || g.behind ? "" : " even"}" title="${esc(g.upstream)} · as of the last fetch">${
        g.ahead || g.behind ? `${g.ahead ? `<span class="ah">↑${g.ahead}</span>` : ""}${g.behind ? `<span class="bh">↓${g.behind}</span>` : ""}` : "in sync"
      }</span>`
    : `<span class="sync none" title="This branch tracks no upstream">no upstream</span>`;
  // The branch row is about the branch and nothing else. The untracked count used to
  // sit on its right, where "1 new" a few pixels from a branch name and an ahead/behind
  // pair reads as a new *commit* or a new *branch*; it belongs with the other file
  // counts, and that is where `wpeekHtml` now puts it.
  return `<div class="wset">${diff}
    <div class="branch"><span>${s.worktree ? "⑃ " : ""}<span class="b">${esc(s.branch || "—")}</span>${sync}</span></div>
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

// ---------- context: what the session has been into ----------
//
// The card that replaced the activity timeline as the inspector's default. The timeline
// is still here, one click away under `Tools`, because the two answer different
// questions and only one of them is worth the space by default — see ./files for why
// a set of files beats a log of tool calls, and `contextHtml` for the split.

const KIND_META: Record<TouchKind, { label: string; glyph: string }> = {
  created: { label: "Created", glyph: "✦" },
  edited: { label: "Edited", glyph: "◆" },
  read: { label: "Read", glyph: "○" },
};
/// Rows a group shows before it folds. Created and Edited are the answer to "what did
/// this agent change", they are short in practice, and folding them would hide the
/// point of the card; Read is routinely hundreds of files and gets the tight fold.
const GROUP_SHOW: Record<TouchKind, number> = { created: 10, edited: 10, read: 6 };

/// One file. The whole row is the open target and the ⌂ is a target inside it, which is
/// why main.ts's if-chain has to test `freveal` **before** `fopen` — same inner-wins
/// rule as the run group's twisty.
function fileRow(f: FileTouch, workdir: string): string {
  const { name, dir, outside } = fileLabel(f.path, workdir);
  // An in-project folder is a couple of segments and shows whole. An outside one is a
  // full absolute path, and it is shortened *here* rather than by CSS: `text-overflow`
  // can only drop the tail, which is the half that identifies it — and the obvious
  // fix (`direction: rtl`, so the ellipsis lands at the front) reorders the neutral
  // separators at the string's edges, printing `/Users/Tim/.claude` as
  // `Users/Tim/.claude/`. `elidePath` is the house answer to the same problem.
  const where = outside ? elidePath(tilde(dir), 34) : dir;
  const times = f.n > 1 ? `<i class="fx-x">×${f.n}</i>` : "";
  const tip = `${tilde(f.path)}\nOpen it · ⌂ reveals it in ${FILE_MANAGER}`;
  return `<div class="fx-row${outside ? " out" : ""}" data-fopen="${escAttr(f.path)}" title="${escAttr(tip)}">`
    + `<span class="fx-f">${esc(name)}</span>`
    + `<span class="fx-p">${esc(where)}</span>${times}`
    + `<button class="fx-r" data-freveal="${escAttr(f.path)}" title="Reveal in ${FILE_MANAGER}">⌂</button></div>`;
}

function fileGroup(kind: TouchKind, files: FileTouch[], workdir: string, open: boolean): string {
  if (!files.length) return "";
  const m = KIND_META[kind];
  const lim = GROUP_SHOW[kind];
  const shown = open ? files : files.slice(0, lim);
  const rest = files.length - shown.length;
  // "Show fewer" only appears on a group that was folded in the first place — an
  // expanded group of four would otherwise offer to collapse itself to four.
  const more = rest > 0 ? `<button class="fx-more" data-fgroup="${kind}">+${rest} more</button>`
    : open && files.length > lim ? `<button class="fx-more" data-fgroup="${kind}">Show fewer</button>` : "";
  return `<div class="fx-grp k-${kind}">`
    + `<div class="fx-gh"><span class="fx-gg">${m.glyph}</span><span class="fx-gn">${m.label}</span><span class="fx-gc">${files.length}</span></div>`
    + shown.map((f) => fileRow(f, workdir)).join("") + more + `</div>`;
}

/// The card's two modes share one header, so the toggle sits still when you flip it.
/// The Files mode carries no count line: every group already states its own, and the
/// two together only competed for the width the toggle needs.
///
/// `hint` is the line under it — what a row in this mode *does*, in the same small grey
/// the I/O panel's note uses. Both modes are lists of unremarkable-looking rows that are
/// all click targets, and neither said so: Files opens a file in your editor, and since
/// the Tools row stopped unfolding it has no disclosure chevron left to imply anything
/// either. Passed empty when there is nothing to click, because a card whose body says
/// "No tool calls yet" should not also be offering advice about clicking one.
function ctxHead(mode: CtxMode, sub: string, hint: string): string {
  const tab = (m: CtxMode, t: string) => `<button class="${m === mode ? "on" : ""}" data-fmode="${m}">${t}</button>`;
  return `<div class="fx-head"><span class="label">Context</span><span class="fx-sub">${esc(sub)}</span>`
    + `<span class="fx-seg">${tab("files", "Files")}${tab("tools", "Tools")}</span></div>`
    + (hint ? `<p class="fx-note">${esc(hint)}</p>` : "");
}

export type CtxMode = "files" | "tools";

/// The inspector's Context card: every file the session has touched, grouped by what it
/// did to them, plus a one-line tally of everything that touched no file.
///
/// `open` is which of the Files groups is unfolded — ephemeral view state owned by
/// ./inspector and passed in rather than read, so this stays a pure function of its
/// arguments like every other card here. Tools has no fold of its own any more: a row
/// opens ./callsheet instead of unfolding, which is what retired the second set this
/// used to need.
export function contextHtml(s: Sess, open: ReadonlySet<string>, mode: CtxMode): string {
  if (mode === "tools") {
    const hint = s.activity.length ? "Click a row to see what ran and what came back." : "";
    return ctxHead(mode, "last 8 calls", hint) + timelineHtml(s);
  }

  const g = groupTouches(s.files);
  const others = otherTools(s.tally);
  const foot = others.length
    ? `<div class="fx-foot">${others.map((o) => `<span class="fx-t ${toolClass(o.tool)}">${esc(shortTool(o.tool))}<i>×${o.n}</i></span>`).join("")}</div>`
    : "";
  if (!s.files.length) {
    // A session that has run tools but opened no file is a real and readable state
    // (a long `Bash` sweep, a research turn) — say so, and still show what it did run.
    const note = others.length ? "No files opened yet." : "Nothing touched yet.";
    return ctxHead(mode, "", "") + `<div class="insp-empty" style="padding:14px 0">${note}</div>` + foot;
  }
  const body = GROUP_ORDER.map((k) => fileGroup(k, g[k], s.workdir, open.has(k))).join("");
  return ctxHead(mode, "", "Click a file to open it.") + `<div class="fx">${body}</div>` + foot;
}

/// The one line of a failure worth putting on a collapsed row.
///
/// A `PostToolUseFailure` reason is the single highest-value thing this card carries and
/// it has no surface anywhere else in the app, so it is the one payload that does not
/// wait to be asked for. Only the first line, though: the rest is a stack trace or a
/// compiler's second opinion, and both want the sheet's width rather than the rail's.
function failLine(a: Act): string {
  const first = (a.out || "").split("\n").find((l) => l.trim()) || "";
  return first.length > 84 ? `${first.slice(0, 84)}…` : first;
}

/// The Tools timeline: the last eight calls, one line each, opening the call sheet.
///
/// **A row no longer expands in place.** It used to unfold two `<pre>` blocks into a
/// 296px column, which is ~38 characters of 10.5px mono — so a diff hunk arrived with
/// its `+`/`-` markers broken off the lines they belong to, a `Read` response was a
/// whole file rendered a third of a line at a time, and the block pushed everything
/// under it down the panel while it was open. ./callsheet holds all of that now, at
/// ~1120px, and what stays here is the summary a rail is actually good at: which call,
/// how long, and whether it failed.
export function timelineHtml(s: Sess): string {
  const acts = s.activity.slice(0, 8);
  if (!acts.length) return `<div class="insp-empty" style="padding:14px 0">No tool calls yet.</div>`;
  const maxDur = Math.max(1, ...acts.map((a) => a.durMs ?? 0));
  const rows = acts.map((a) => {
    const cls = toolClass(a.tool);
    const running = a.durMs == null;
    const w = running ? 100 : Math.max(6, Math.round(((a.durMs ?? 0) / maxDur) * 100));
    const ms = running ? "···" : fmtLatency(a.durMs!);
    const why = a.failed ? failLine(a) : "";
    // `data-tlsid` rides along rather than being looked up from `activeId` at the click:
    // the row is markup, and markup outlives the state that produced it by however long
    // it takes somebody to move the pointer.
    return `<div class="tl2i${a.failed ? " bad" : ""}">`
      + `<div class="row" data-tlrow="${escAttr(actKey(a))}" data-tlsid="${escAttr(s.id)}" title="${escAttr(`${a.tool} · ${a.arg}\nOpen what ran and what came back`)}">`
      + `<span class="dot ${cls}"></span><span class="nm ${cls}">${esc(a.tool)}</span>`
      + `<span class="arg">${esc(a.arg)}</span>`
      + `<span class="lat"><span class="latbar ${running ? "run" : ""}" style="width:${w}%"></span><span class="ms">${ms}</span></span></div>`
      + (why ? `<div class="tl2f">${esc(why)}</div>` : "")
      + `</div>`;
  }).join("");
  return `<div class="tl2">${rows}</div>`;
}
