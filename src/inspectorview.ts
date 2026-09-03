// The inspector's markup: every card the right-hand panel shows about an agent session.
// Every function takes a Sess (or a plain value) and returns a string; no DOM, no renderer.
// It owns `gitBusy` because the git buttons are its only reader.

import { basename, elidePath, esc, escAttr, fmtDwell, fmtLatency, sparkline, tilde } from "./format";
import { FILE_MANAGER } from "./dom";
import { fileLabel, GROUP_ORDER, groupTouches, otherTools, shortTool } from "./files";
import {
  actKey, apiErrText, bgWaiting, fanoutTally, fanoutText, hasSessionState,
  liveCount, liveFanout, orphanAgents, statusKey,
  type Act, type DiffStat, type FileTouch, type Prompt, type Risk, type Sess, type TouchKind,
} from "./types";
import { OUTLINE_SHOW, promptLabel, type OutlinePrefs } from "./outline";
import { sessions } from "./state";

export let gitBusy: string | null = null; // session with a fetch/pull/push in flight; its buttons grey out
export function setGitBusy(id: string | null) { gitBusy = id; }
// ---- inspector: shared helpers for the redesigned modules ----
const TOOL_VERB: Record<string, string> = { Read: "Reading", Edit: "Editing", Write: "Writing", Bash: "Running", Grep: "Searching", Glob: "Searching", WebFetch: "Browsing", WebSearch: "Searching", TodoWrite: "Planning" };
function toolVerb(tool: string): string {
  if (!tool) return "Working";
  if (tool.startsWith("Task")) return "Delegating";
  if (tool.startsWith("mcp__")) return "Calling tool";
  return TOOL_VERB[tool] || "Working";
}
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
  // Before the phase checks: a fleet still running leaves the phase at "done".
  if (bgWaiting(s)) return fanoutText(s);
  if (s.phase === "thinking") return "Thinking";
  if (s.phase === "working") return toolVerb(s.curTool);
  if (s.phase === "done") return "Your turn";
  if (s.phase === "error") return s.apiErr ? apiErrText(s.apiErr) : "Error";
  if (s.phase === "ended") return "Ended";
  return "Idle";
}
// Patched into #iDwell once a second by tickDwell; never part of the compared markup.
export function dwellText(s: Sess): string {
  if (s.phase === "ended") return "session ended";
  // The fan-out's own clock: `phaseSince` is when the turn ended, i.e. when the fleet started.
  const f = bgWaiting(s) ? liveFanout(s) : null;
  if (f) return `${fmtDwell(Date.now() - f.since)} in background`;
  const d = fmtDwell(Date.now() - s.phaseSince);
  if (s.phase === "done") return `waiting ${d}`;
  if (s.phase === "idle") return `idle ${d}`;
  if (s.phase === "error") return `${d} ago`;
  return `${d} in state`;
}
// The "your turn" session that has waited longest; only meaningful when several are waiting.
// A session whose fleet still runs is not blocked on you, so it is not in the queue.
function isLongestWaiting(s: Sess): boolean {
  const waiting = [...sessions.values()].filter((x) => x.phase === "done" && hasSessionState(x) && !x.attention && !bgWaiting(x));
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
  // The heartbeat means "something is happening here", so a live fleet beats too.
  const live = (s.phase === "working" || s.phase === "thinking" || bgWaiting(s)) && !s.attention;
  const verb = s.attention ? "Needs you" : verbFor(s);
  const tcls = (!s.attention && s.phase === "working") ? toolClass(s.curTool) : "";
  const doing = (!s.attention && s.phase === "working" && s.curTool)
    ? `<div class="doing"><span class="tk ${toolClass(s.curTool)}">${esc(s.curTool)}</span>${s.curArg ? `<code>${esc(s.curArg)}</code>` : ""}</div>` : "";
  const chips = [s.model ? esc(s.model) : "", ...(fan ? [`${fan.done} done`, `${liveCount(s)} running`] : [])]
    .filter(Boolean).map((c) => `<span class="chip-s">${c}</span>`).join("");
  const longest = s.phase === "done" && !bgWaiting(s) && isLongestWaiting(s) ? `<span class="chip-s hot">longest waiting</span>` : "";
  const meta = chips || longest ? `<div class="vmeta">${chips}${longest}</div>` : "";
  return `<div class="vital st-${sk}">
    <div class="vrow">
      <div class="vmain">
        <div class="vtop"><span class="heart ${live ? "" : "still"}"></span><span class="vstate ${tcls}">${verb}</span><span class="dwell" id="iDwell"></span></div>
        ${doing}${meta}
      </div>
      ${ctxRingHtml(s)}
    </div>
    ${ctxFootHtml(s)}</div>`;
}
// The background fleet card, directly under the vital. No clock in this markup: the
// elapsed lives in #iDwell, patched by textContent, or paintInspector's guard never bites.
// Phases are listed, never ticked off; no hook says which one a workflow has reached.
export function fanoutHtml(s: Sess): string {
  const f = liveFanout(s), t = fanoutTally(s);
  if (!f || !t) return "";
  const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const name = f.name || "Background agents";
  const detail = f.detail ? `<div class="fo-detail">${esc(f.detail)}</div>` : "";
  const phases = f.phases.length
    ? `<div class="fo-phases">${f.phases.map((p) => `<span class="fo-ph">${esc(p)}</span>`).join("")}</div>` : "";
  // Agents a newer fan-out inherited are counted in the total but named apart, so "34 / 36"
  // says whose they are; they leave the card when they expire (docs/architecture.md).
  const orph = orphanAgents(s);
  const kinds = [...new Set(orph.map((a) => a.type).filter(Boolean))].slice(0, 3).join(", ");
  const carried = orph.length
    ? `<div class="fo-orph"><span class="fo-og">↩</span>${orph.length} still up from an earlier run${kinds ? ` · ${esc(kinds)}` : ""}</div>` : "";
  return `<div class="fanout">
    <div class="fo-h"><span class="fo-g">◐</span><span class="fo-name" title="${esc(name)}">${esc(name)}</span><span class="fo-frac">${t.done} / ${t.total}</span></div>
    ${detail}
    <div class="fo-bar"><i style="width:${pct}%"></i></div>
    ${carried}${phases}</div>`;
}
// Context rides in the vital card rather than a card of its own: state, model and how full
// the window is are one glance, and three stacked boxes pushed everything else below the fold.
// Spend and limits describe the account and stay in the footer.
function ctxRingHtml(s: Sess): string {
  const ctx = s.ctxPct;
  const tokTxt = s.ctxTokens != null ? `${Math.round(s.ctxTokens / 1000)}k` : "ctx";
  return `<div class="vgauge" title="Context window used${s.ctxTokens != null ? ` — ${s.ctxTokens.toLocaleString()} tokens` : ""}">
    <svg class="mini-ring" viewBox="0 0 40 40"><circle class="trk" cx="20" cy="20" r="15"></circle><circle class="fil" cx="20" cy="20" r="15" pathLength="100" stroke-dasharray="${Math.max(0, Math.min(100, ctx ?? 0))} 100"></circle></svg>
    <div class="gnum">${ctx != null ? Math.round(ctx) + "%" : "–"}</div><div class="glab">${tokTxt}</div></div>`;
}
// The warning wins over the sparkline: "auto-compact imminent" is the one thing the ring
// alone cannot say, and both together would wrap the card.
function ctxFootHtml(s: Sess): string {
  const warn = compactWarn(s.ctxPct);
  if (warn) return `<div class="warn-line ${warn.cls}">${warn.txt}</div>`;
  const spark = sparkline(s.ctxHist, { lo: 0, hi: 100 });
  return spark ? `<div class="gspark">${spark}</div>` : "";
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
// "This session is somewhere else": sits above every figure that reads the launch folder.
// Copy and button differ by `via`: a cwd drift is Episko being behind (follow, free); a
// write drift is a relocation only Episko can perform (move). See docs/worktrees.md.
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
// The clickable half of the working-set card; ./mirror paints the same block for an
// external session's folder. No churn, no split bar. Count everything git calls dirty,
// not only numstat's tracked files, and drop the `+N −M` pair rather than print `+0 −0`.
export function wpeekHtml(dir: string, title: string, g: DiffStat): string {
  const churn = g.added + g.removed;
  const aw = churn ? Math.round((g.added / churn) * 100) : 0;
  // git's porcelain count covers what numstat misses; the sum is for a stat that predates it.
  const touched = g.dirty || g.files + g.untracked;
  const plural = touched === 1 ? "" : "s";
  // When every dirty entry is new, say so instead of "1 file · 1 new".
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
  // Only draw the diff half when something is uncommitted; the branch row is always needed.
  const diff = dirty ? wpeekHtml(s.workdir, s.project + (s.branch ? " · " + s.branch : ""), g) : "";
  const sync = g.upstream
    ? `<span class="sync${g.ahead || g.behind ? "" : " even"}" title="${esc(g.upstream)} · as of the last fetch">${
        g.ahead || g.behind ? `${g.ahead ? `<span class="ah">↑${g.ahead}</span>` : ""}${g.behind ? `<span class="bh">↓${g.behind}</span>` : ""}` : "in sync"
      }</span>`
    : `<span class="sync none" title="This branch tracks no upstream">no upstream</span>`;
  // The branch row is about the branch only; file counts belong in wpeekHtml.
  return `<div class="wset">${diff}
    <div class="branch"><span>${s.worktree ? "⑃ " : ""}<span class="b">${esc(s.branch || "—")}</span>${sync}</span></div>
    ${gitBtnsHtml(s, g)}</div>`;
}
// Fetch / pull / push. Only grey a button when there is nothing to do, never for the
// awkward states: diverged or no-upstream keeps it live, since the backend then refuses
// with a suggestion and hands over a prefilled terminal. "Nothing to do" needs an upstream.
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

// ---------- the conversation outline: what you asked, and where ----------
// Newest first, like the tool timeline: the jump you want is usually a recent one, and the
// number carries the chronology the order drops. A row is a click target back into the
// pane's scrollback, so `anchored` decides which ones can still keep that promise.

const promptClock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function outlineRow(s: Sess, p: Prompt, n: number, anchored: boolean, lines: number): string {
  const label = promptLabel(p.text);
  const tip = anchored ? `${label}\nJump to it in the terminal` : `${label}\nScrolled out of the terminal`;
  return `<div class="ol-row${anchored ? "" : " gone"}" data-oljump="${escAttr(p.id)}" data-olsid="${escAttr(s.id)}" title="${escAttr(tip)}">`
    + `<span class="ol-n">${n}</span>`
    + `<div class="ol-txt" style="--ol-lines:${lines}">${esc(p.text)}</div>`
    + `<span class="ol-t">${promptClock(p.at)}</span></div>`;
}

export function outlineHtml(s: Sess, prefs: OutlinePrefs, anchored: ReadonlySet<string>, all: boolean): string {
  const head = `<div class="fx-head"><span class="label">Your questions</span><span class="fx-sub">${s.prompts.length || ""}</span></div>`;
  if (!s.prompts.length) {
    return `<div class="outline">${head}<div class="insp-empty" style="padding:14px 0">Nothing asked yet.</div></div>`;
  }
  const total = s.prompts.length;
  const shown = all ? total : Math.min(OUTLINE_SHOW, total);
  const rest = total - shown;
  const more = rest > 0 ? `<button class="fx-more" data-olmore="1">+${rest} earlier</button>`
    : all && total > OUTLINE_SHOW ? `<button class="fx-more" data-olmore="1">Show fewer</button>` : "";
  // Newest first, but numbered from the start of the conversation, so #1 is the first thing asked.
  const rows = s.prompts.slice(total - shown).reverse()
    .map((p, i) => outlineRow(s, p, total - i, anchored.has(p.id), prefs.lines)).join("");
  return `<div class="outline">${head}<div class="ol">${rows}</div>${more}</div>`;
}

// ---------- context: what the session has been into ----------
// The default card; the tool timeline is one click away under `Tools` (./files for why).

const KIND_META: Record<TouchKind, { label: string; glyph: string }> = {
  created: { label: "Created", glyph: "✦" },
  edited: { label: "Edited", glyph: "◆" },
  read: { label: "Read", glyph: "○" },
};
// Rows a group shows before it folds. Read is routinely hundreds of files; the others are the point.
const GROUP_SHOW: Record<TouchKind, number> = { created: 10, edited: 10, read: 6 };

// The row is the open target and ⌂ a target inside it, so main.ts must test `freveal` before `fopen`.
function fileRow(f: FileTouch, workdir: string): string {
  const { name, dir, outside } = fileLabel(f.path, workdir);
  // An outside path is shortened here, not by CSS: `text-overflow` drops the tail (the half
  // that identifies it) and `direction: rtl` reorders the separators at the edges.
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
  // "Show fewer" only on a group that was folded, so a group of four never offers to collapse.
  const more = rest > 0 ? `<button class="fx-more" data-fgroup="${kind}">+${rest} more</button>`
    : open && files.length > lim ? `<button class="fx-more" data-fgroup="${kind}">Show fewer</button>` : "";
  return `<div class="fx-grp k-${kind}">`
    + `<div class="fx-gh"><span class="fx-gg">${m.glyph}</span><span class="fx-gn">${m.label}</span><span class="fx-gc">${files.length}</span></div>`
    + shown.map((f) => fileRow(f, workdir)).join("") + more + `</div>`;
}

// Both modes share one header so the toggle sits still. `hint` says what a row does (both
// lists are click targets that don't look it); empty when there is nothing to click.
function ctxHead(mode: CtxMode, sub: string, hint: string): string {
  const tab = (m: CtxMode, t: string) => `<button class="${m === mode ? "on" : ""}" data-fmode="${m}">${t}</button>`;
  return `<div class="fx-head"><span class="label">Context</span><span class="fx-sub">${esc(sub)}</span>`
    + `<span class="fx-seg">${tab("files", "Files")}${tab("tools", "Tools")}</span></div>`
    + (hint ? `<p class="fx-note">${esc(hint)}</p>` : "");
}

export type CtxMode = "files" | "tools";

// The Context card. `open` is the unfolded Files groups, view state owned by ./inspector
// and passed in so this stays a pure function. A Tools row opens ./callsheet; no fold.
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
    // Tools but no files (a Bash sweep, a research turn) is a real state: say so, keep the tally.
    const note = others.length ? "No files opened yet." : "Nothing touched yet.";
    return ctxHead(mode, "", "") + `<div class="insp-empty" style="padding:14px 0">${note}</div>` + foot;
  }
  const body = GROUP_ORDER.map((k) => fileGroup(k, g[k], s.workdir, open.has(k))).join("");
  return ctxHead(mode, "", "Click a file to open it.") + `<div class="fx">${body}</div>` + foot;
}

// The first line of a failure's reason: the one payload put on the row unasked, since it
// has no other surface in the app. The rest wants the sheet's width.
function failLine(a: Act): string {
  const first = (a.out || "").split("\n").find((l) => l.trim()) || "";
  return first.length > 84 ? `${first.slice(0, 84)}…` : first;
}

// The Tools timeline: the last eight calls, one line each, opening ./callsheet. A row
// never expands in place; a 296px rail cannot hold a payload (CLAUDE.md, Context card).
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
    // The sid rides on the row: markup outlives the `activeId` that produced it.
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
