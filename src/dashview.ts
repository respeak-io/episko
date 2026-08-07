// The project dashboard's markup. Data in, string out — no `$()`, no `innerHTML`, no
// renderer call, the same contract as ./sidebarview, ./inspectorview and ./usageview.
// ./dash owns the rules and ./dashboard owns the pane, the IPC and the events.
//
// Untested by design, like every other *view module: snapshotting template literals
// mostly re-asserts itself.

import { basename, esc, relTime, sparkline, tilde, uUsd2 } from "./format";
// A platform *constant*, not DOM access — the `*view` rule bars `$()`, `innerHTML` and
// renderer calls, and ./dom is the shared leaf everything may import (it touches no DOM
// at module scope, which is what keeps it safe in vitest's node environment).
import { FILE_MANAGER } from "./dom";
import type { Pulse, ProjectFacts, ProjectTier } from "./dash";
import type { Note, SharedNote } from "./notes";
import type { TrailCommit, TrailDay, TrailSession } from "./trail";
import type { WtHead } from "./types";
import type { ClaimAllow, ClaimPolicy } from "./claim";
import type { GhThread, Holder, KeptIssue } from "./ghwork";
import {
  localStanding, orderCands, standing, type CleanCand, type MergedPrs, type SweepResult,
} from "./branches";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// The provenance mark on anything a model wrote — on your line, on the project's, and
/// on both of their waiting states. Declared once because a reader learns "a model wrote
/// this" from the *shape* long before the word, so the shape must not vary.
///
/// **Deliberately just the word.** A ✨ was tried here and pulled the eye straight to the
/// least important thing on the row: the mark exists so a reader can tell an observation
/// from a generated sentence, which needs it to be *findable*, not *loud*.
///
/// The caller passes the whole label, because the two placements need different ones: an
/// inline mark takes a `·` to separate it from the sentence it follows, and the cornered
/// one is already separated by being in the corner — a `·` there points at nothing.
const aiMark = (text: string, cls = "") =>
  `<span class="ai${cls ? " " + cls : ""}">${text}</span>`;
/// The shared box's copy, in its own bottom-right corner rather than trailing the
/// sentence — inline it read as the last words of the sentence it labels.
const AI_MARK = aiMark("ai", "ai-cnr");

// ---------- the pulse strip ----------
// Five numbers before any detail, so the window answers itself at a glance. Which five
// depends on the tier: a folder with no git has no commits to count, and showing a
// permanent zero there would read as "nothing happened" rather than "not applicable".

function tile(k: string, v: string, d = ""): string {
  return `<div class="db-tile"><span class="k">${esc(k)}</span><span class="v">${v}</span>`
    + (d ? `<span class="d">${d}</span>` : "") + `</div>`;
}

/// The range picker is not data — it is a preference, and it answers instantly whether
/// or not anything else has. So it is shared with the skeleton below, where every tile
/// beside it is a bar.
const rangeTile = (range: number) => `<div class="db-tile win"><span class="db-seg">
      ${[7, 14, 30].map((r) => `<button${r === range ? ` class="on"` : ""} data-dashrange="${r}">${r}d</button>`).join("")}
    </span></div>`;

export function pulseHtml(p: Pulse, tier: ProjectTier, range: number, dense: number[]): string {
  const tiles: string[] = [];
  if (tier !== "none") {
    // `sparkline` returns an inline SVG, not text — escaping it printed the markup.
    tiles.push(`<div class="db-tile"><span class="k">Commits</span><span class="v">${p.commits}</span>`
      + `<span class="db-spark" aria-hidden="true">${sparkline(dense)}</span></div>`);
  }
  tiles.push(tile("Sessions", String(p.sessions), `${range} days`));
  // Spend is per-project and only exists from the day the detail rollup started. A
  // dash rather than $0.00 — "we didn't keep this" and "it was free" are different
  // facts and the strip must not conflate them.
  tiles.push(tile("Agent spend", p.spend > 0 ? esc(uUsd2(p.spend)) : `<span class="dim">—</span>`));
  if (tier !== "none") {
    const who = p.authors.length
      ? esc(p.authors.slice(0, 2).map((a) => a.split(/\s+/)[0]).join(", ")) + (p.authors.length > 2 ? ` +${p.authors.length - 2}` : "")
      : `<span class="dim">—</span>`;
    tiles.push(tile("Contributors", String(p.authors.length), who));
  }
  return `<div class="db-pulse">${tiles.join("")}${rangeTile(range)}</div>`;
}

// ---------- skeletons ----------
//
// WHY THESE EXIST. Opening a project costs a `git` process for the facts, a scan of
// every transcript on the machine, a `git log`, a worktree probe and a digest read —
// and then, on a GitHub repo, two `gh` calls *after* all of that, plus a model call per
// day for the sentences. Every one of those used to land in silence: the strip showed a
// confident row of zeros, the aside was simply short a card or two, and nothing on
// screen told "there is nothing here" apart from "this has not been read yet". Those
// are opposite answers, and they looked identical.
//
// Each skeleton is drawn in the geometry of what replaces it, so the answer arriving is
// a substitution rather than a jump. The bars carry no text and `./dashboard` marks the
// pane `aria-busy` instead — grey rectangles are decoration, and a reader who isn't
// looking at them wants the sentence at the foot of the timeline.
//
// The shimmer (`.db-sk`) and the spinner (`.u-spin`) are the usage screen's own. A
// second loading vocabulary would only be a second thing to keep in step.

const sk = (w: string, h = 9) => `<i class="db-sk" style="width:${w};height:${h}px"></i>`;

/**
 * The strip, before it knows anything.
 *
 * The tile *labels* are bars too, not the real words. Which tiles exist depends on the
 * tier — a folder with no git has neither Commits nor Contributors — and `project_facts`
 * is one of the calls still out, so naming them here would be a guess the answer then
 * contradicts by removing two tiles.
 */
export function pulseSkeleton(range: number): string {
  const tiles = [["52px", "44px"], ["48px", "62px"], ["62px", "38px"], ["58px", "54px"]]
    .map(([k, v]) => `<div class="db-tile"><span class="k">${sk(k, 7)}</span>`
      + `<span class="v">${sk(v, 15)}</span><span class="d">${sk("40px", 7)}</span></div>`).join("");
  return `<div class="db-pulse">${tiles}${rangeTile(range)}</div>`;
}

/**
 * The timeline, before it has any days.
 *
 * Three rows in the real `.db-day` geometry — gutter, spine dot, summary line, facts —
 * so the first real day lands where the first bar was. Three, and not enough to fill the
 * column, because the window is a preference this doesn't read: a skeleton that runs to
 * the fold promises a length it has no way to know.
 *
 * The sentence underneath is the part a skeleton can't say. It is the usage screen's
 * spinner-and-line pattern, for the same reason it has one.
 */
export function spineSkeleton(): string {
  const row = (w: string) => `<div class="db-day">
      <div class="db-gut">${sk("30px", 8)}</div>
      <div class="db-dbody">
        <p class="db-sum">${sk(w, 11)}</p>
        <div class="db-facts">${sk("54px", 8)}${sk("60px", 8)}</div>
      </div></div>`;
  return ["88%", "72%", "80%"].map(row).join("")
    + `<p class="db-skhint"><span class="u-spin"></span>Reading this project's history…</p>`;
}

/**
 * One aside card, before its rows exist.
 *
 * Used for two different waits. The local reads get one because the aside would
 * otherwise be a lone Notes box; the GitHub half gets one because it fires *after* the
 * rest and was the most silent wait of the lot — the Open work card was simply not
 * there, which on a repo whose issues are the point reads as `gh` being broken rather
 * than as `gh` being slow.
 */
export function cardSkeleton(rows = 3): string {
  const body = ["78%", "62%", "88%", "70%"].slice(0, rows).map((w) =>
    `<div class="cr">${sk("13px", 13)}<span class="ti">${sk(w, 9)}</span>`
    + `<span class="rt">${sk("30px", 9)}</span></div>`).join("");
  return `<div class="ac sk"><div class="ac-h">${sk("58px", 8)}<span class="n">${sk("24px", 8)}</span></div>
    <div class="ac-b">${body}</div></div>`;
}

// ---------- the timeline ----------

/**
 * A generated sentence is marked, always. The reader has to be able to tell what the
 * app observed from what a model wrote about it, and the mark is the only difference
 * between a log and a claim.
 *
 * `summary` is **your** day and is the headline; `team` is the **project's**, and sits
 * above it in a box of its own. The box is contained rather than plain because it is the
 * one thing on the timeline that came out of the repo rather than out of this machine —
 * a colleague's copy of Episko produced the same sentence, and it is the same sentence
 * they are reading. `team` arrives already gated (see `sharedDay`): the caller decides
 * whether it is worth showing, this only decides how.
 */
export interface DayPending {
  /// Your own line, `dayFacts` → `summarize_day`.
  mine?: boolean;
  /// The project's line — the shared box, which on this day will exist.
  team?: boolean;
}

export function dayHtml(
  d: TrailDay, summary: string | null, headline: string, open: boolean,
  team: string | null = null, authors: string[] = [], pend: DayPending = {},
): string {
  const dt = new Date(d.when);
  const rows = dayRows(d);
  const hidden = rows.length;
  // A pending line is not an absent one, and the two want opposite treatments. Your own
  // sentence has a deterministic headline standing in for it that is already correct and
  // already readable, so waiting is a mark *beside* it — replacing a sentence somebody
  // can read with a grey bar to promise a nicer one is a bad trade. The shared box has no
  // such stand-in: it is a block that would otherwise appear out of nothing, and its
  // heading is known (this day has more than one human committer, and who they were) long
  // before its sentence is, so only the sentence is a bar.
  // The `ai` mark sits in the box's own bottom-right rather than trailing the last word:
  // inline it read as part of the sentence, which is the one thing a provenance mark must
  // never do, and it landed wherever the text happened to wrap.
  //
  // **The paragraph is not clamped, and must not be.** A three-line clamp with a
  // click-to-expand lived here briefly and was pure loss: `prompt_for` caps this sentence
  // at 22 words, so it cannot reach three lines at this width — the fold could never fire
  // for the reason it existed, while the measurement behind its "· more" was wrong often
  // enough to advertise a fold on every box on screen. A length the generator guarantees
  // does not need a length control.
  const teamBox = (body: string, cls = "", mark = "") => `<div class="db-team${cls}">
        <span class="tl"><span class="sh">shared</span>The project${
          authors.length ? `<span class="au">${esc(authors.join(" · "))}</span>` : ""}</span>
        <p>${body}</p>${mark}
      </div>`;
  return `<div class="db-day${open ? " open" : ""}" data-dashday="${esc(d.key)}">
    <div class="db-gut">
      <span class="dd">${WEEKDAY[dt.getDay()]} ${dt.getDate()}</span>
      ${d.cost > 0 ? `<span class="cc">${esc(uUsd2(d.cost))}</span>` : ""}
    </div>
    <div class="db-dbody">
      ${team ? teamBox(esc(team), "", AI_MARK)
        : pend.team ? teamBox(sk("84%", 10), " sk") : ""}
      <p class="db-sum">${esc(summary || headline)}${
        summary ? aiMark("· ai")
        : pend.mine ? aiMark("· writing", "wr") : ""}</p>
      <div class="db-facts">
        ${d.commits.length ? `<span>${d.commits.length} commit${d.commits.length === 1 ? "" : "s"}</span>` : ""}
        ${d.commits.length && d.sessions.length ? `<span class="dot">·</span>` : ""}
        ${d.sessions.length ? `<span>${d.sessions.length} session${d.sessions.length === 1 ? "" : "s"}</span>` : ""}
        ${authorsOf(d)}
        ${hidden ? `<button class="db-more" data-dashopen="${esc(d.key)}">${hidden} more <span class="cv">⌄</span></button>` : ""}
      </div>
      ${hidden ? `<div class="db-detail"><div><div class="db-rows">${rows.join("")}</div></div></div>` : ""}
    </div>
  </div>`;
}

function authorsOf(d: TrailDay): string {
  const who = [...new Set(d.commits.map((c) => c.author.split(/\s+/)[0]))];
  if (!who.length) return "";
  return `<span class="dot">·</span><span class="who">${esc(who.slice(0, 3).join(", "))}</span>`;
}

/// One time-ordered list, sessions and commits mixed. Not sessions-then-commits: a
/// session at 09:00 and the commit it produced at 09:05 are a cause and its effect,
/// and listing all the causes then all the effects breaks the only ordering that
/// explains the day. (Same rule as ./trail's `dayItems`, restated per project.)
function dayRows(d: TrailDay): string[] {
  const items: { when: number; html: string }[] = [
    ...d.sessions.map((s) => ({ when: s.when, html: sessionRow(s) })),
    ...d.commits.map((c) => ({ when: c.when * 1000, html: commitRow(c) })),
  ];
  return items.sort((a, b) => b.when - a.when).map((i) => i.html);
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function sessionRow(s: TrailSession): string {
  return `<div class="db-item"><span class="db-kind sess">session</span>`
    + `<span class="db-t" title="${esc(s.title)}">${esc(s.title)}</span>`
    + `<span class="db-r">${clock(s.when)}</span></div>`;
}
function commitRow(c: TrailCommit): string {
  return `<div class="db-item" data-dashsha="${esc(c.sha)}" title="${esc(`${c.subject} — ${c.author}`)}">`
    + `<span class="db-kind">commit</span>`
    + `<span class="db-t">${esc(c.subject)}</span>`
    + `<span class="db-r">${clock(c.when * 1000)}</span></div>`;
}

// ---------- the aside ----------
// Four compact cards at most, each one line per row and each with a ⤢ that opens the
// same detail overlay. A card appears when it has something to say and is absent
// otherwise: an empty panel reads as breakage, not as an honest blank.

function card(id: string, title: string, count: string, body: string, enlarge = true): string {
  return `<div class="ac"><div class="ac-h"><span class="t">${esc(title)}</span>`
    + `<span class="n">${esc(count)}</span>`
    + (enlarge ? `<button class="xb" data-dashopen-view="${id}" title="See all">⤢</button>` : "")
    + `</div><div class="ac-b">${body}</div></div>`;
}

/// A checkout row. Branch and one piece of state — anything more (ahead/behind,
/// merged) costs a `git` process per checkout, which is what the ⑃ dialog is for.
function checkoutRow(w: WtHead, live: number, dirty: boolean, main: boolean): string {
  const tag = live ? `<span class="tag acc">${live} live</span>`
    : dirty ? `<span class="tag warn">dirty</span>`
    : `<span class="tag ok">clean</span>`;
  return `<div class="cr" data-dashwt="${esc(w.path)}" title="${esc(tilde(w.path))}">`
    + `<span class="k">${main ? "⌂" : "⑃"}</span>`
    + `<span class="ti mono">${esc(w.branch || basename(w.path))}</span>`
    + `<span class="rt">${tag}</span></div>`;
}

export function checkoutsCard(
  heads: WtHead[],
  liveFor: (path: string) => number,
  dirtyFor: (path: string) => boolean,
): string {
  if (heads.length < 2) return ""; // one checkout is not a list worth a card
  const rows = heads.map((w) => checkoutRow(w, liveFor(w.path), dirtyFor(w.path), w.is_main)).join("");
  return card("checkouts", "Checkouts", String(heads.length), rows);
}

function noteRow(n: Note): string {
  return `<div class="nt" data-dashnote="${esc(n.id)}">
    <span class="ntx"><span class="tx">${esc(n.text)}</span>
      <span class="mt"><span>${esc(relTime(n.created))}</span></span></span>
    <span class="nt-b">
      <button class="nb" data-dashdispatch="${esc(n.id)}" title="Start an agent on this">▶</button>
      <button class="nb" data-dashdrop="${esc(n.id)}" title="Delete">✕</button>
    </span></div>`;
}

export function notesCard(notes: Note[]): string {
  const body = notes.length
    ? notes.slice(0, 3).map(noteRow).join("")
    : `<div class="ac-empty">Nothing queued. Jot the next thing above.</div>`;
  return `<div class="ac"><div class="ac-h"><span class="t">Notes</span>
      <span class="n">${notes.length}</span>
      <button class="xb" data-dashopen-view="notes" title="Open the notes board">⤢</button></div>
    <form class="nt-form" id="dashJot">
      <input id="dashNote" placeholder="What's next here?" autocomplete="off" />
      <button type="submit" title="Add">＋</button>
    </form>
    <div class="ac-b">${body}</div></div>`;
}

/**
 * The one-time offer to start a shared work log, at the foot of the timeline.
 *
 * It lives *here*, under the sentences it is talking about, because that is the only
 * place the offer explains itself. It was reachable from nowhere before this, which for
 * a feature whose whole point is *sharing* meant nobody used it.
 *
 * Absent once the project has a digest: from then on every closed day is contributed
 * automatically, because whoever committed the file already made the decision. `n` is
 * how many days the first write would carry, so the offer never proposes to commit
 * nothing — and it counts the **project's** lines, which are the only ones that go in.
 */
export function workLogOffer(n: number): string {
  if (!n) return "";
  return `<div class="miss db-share"><span class="t">Not written down anywhere</span>
    <p>Episko has read ${n === 1 ? "one day" : `${n} days`} of this project's history and can keep the
       result in <code>.episko/digest.md</code>. Committed, everyone who pulls gets the same account of
       what the project did — instead of re-deriving, and paying for, their own.</p>
    <p>Only the commits and pull requests go in. Your own sessions and spend stay on this machine.</p>
    <button class="act" data-dashworklog>↑ Start the work log</button></div>`;
}

/// What this folder can't do, said once and plainly. Rendered *instead of* the cards
/// it replaces, never alongside empty ones.
export function missingCard(tier: ProjectTier, f: ProjectFacts | null): string {
  if (tier === "github") return "";
  if (tier === "git") {
    const where = f?.host ? `<code>${esc(f.host)}</code>` : "no remote at all";
    return `<div class="miss"><span class="t">Not on GitHub</span>
      <p>Issues, pull requests and claims need a GitHub remote — this project's origin is ${where}.
         Those cards are absent rather than empty.</p>
      <p><b>Sharing still works.</b> <code>.episko/</code> is committed like any other file, so the
         work log reaches whoever pulls. GitHub was never what made it shared.</p></div>`;
  }
  return `<div class="miss"><span class="t">Not a repository</span>
    <p>The timeline is still real — sessions and spend come from Claude's own transcripts, which never
       needed git. What's missing is the commit half: no checkouts, no contributors, no work log.</p>
    <p>Notes stay on this machine: there is nothing to commit <code>.episko/</code> into.</p></div>`;
}

// ---------- the inspector: the project's context menu, standing open ----------

/// `known` is whether `project_facts` has answered *for this project yet*. It is not the
/// same question as "is anything loading": a range change reloads the timeline without
/// putting the tier back in doubt, and blanking the repo verbs for it would be a flicker
/// that says nothing. False only between clicking a new project and its facts landing —
/// during which `tier` reads `none`, which is an assertion, not an absence.
export function dashInspector(
  root: string, tier: ProjectTier, f: ProjectFacts | null,
  live: { id: string; label: string; glyph: string; cls: string; ctx: string }[],
  shared: boolean, known = true,
): string {
  const act = (a: string, ic: string, lb: string, sb = "", cls = "") =>
    `<button class="ia ${cls}" data-dashact="${a}"><span class="ic">${ic}</span>`
    + `<span><span class="lb">${esc(lb)}</span>${sb ? `<span class="sb">${esc(sb)}</span>` : ""}</span></button>`;
  const repo = known && tier !== "none";
  const chips = [
    f?.slug ? `<span class="chip">${esc(f.slug)}</span>` : "",
    f?.host && !f.slug ? `<span class="chip">${esc(f.host)}</span>` : "",
    !known ? `<span class="chip sk">${sk("62px", 8)}</span>`
      : tier === "none" ? `<span class="chip warn">not a repo</span>` : "",
    shared ? `<span class="chip acc" title="This project has a committed .episko/digest.md">.episko/ shared</span>` : "",
  ].filter(Boolean).join("");
  return `
    ${live.length ? `<div><span class="label">Running here</span><div class="ip-live">${live.map((s) =>
      `<div class="srow" data-sel="${esc(s.id)}"><span class="sglyph ${s.cls}">${s.glyph}</span>`
      + `<span class="sbranch">${esc(s.label)}</span><span class="sctx">${esc(s.ctx)}</span></div>`).join("")}</div></div>` : ""}
    <div><span class="label">Do something here</span><div class="ip-acts">
      ${act("launch", "＋", repo ? "New session…" : "New session",
        live.length ? `${live.length} already running here`
          : repo ? "here, or on a branch of its own" : "start Claude Code in this folder")}
      ${act("terminal", "❯", "Open terminal here", "a plain shell, no Claude")}
      ${act("run", "▶", "Run a task…", "the scripts this project already ships")}
      <div class="ip-sep"></div>
      ${repo ? act("graph", "⑂", "Commit graph…", "history, branches, merges") : ""}
      ${repo ? act("cleanup", "⌥", "Branches…", "clean up merged and orphaned ones") : ""}
      ${act("history", "◷", "History…", "reopen a session you closed")}
      ${act("folder", "⌂", "Open project folder", `reveal it in ${FILE_MANAGER}`)}
      ${act("copypath", "⧉", "Copy path", "the full path, to the clipboard")}
      ${repo && !shared
        ? act("worklog", "↑", "Share the work log…", "commit each day's summary to .episko/") : ""}
    </div></div>
    ${chips ? `<div><span class="label">Repository</span><div class="db-chips">${chips}</div></div>` : ""}
    <p class="ihint">${esc(tilde(root))}</p>`;
}

/// The 44px rail ⌘I collapses to on this view. It exists because the inspector holds
/// the ONLY copy of History / Terminal / Run here — the dashboard header gave them up
/// — so collapsing to nothing would hide real verbs. The live-session glyphs stay at
/// the top, so the one thing the lighter header gave up (noticing something needs you)
/// survives the collapse.
export function dashStrip(
  accent: string, initial: string, tier: ProjectTier,
  live: { id: string; glyph: string; cls: string; label: string }[], known = true,
): string {
  const b = (a: string, ic: string, t: string, cls = "") =>
    `<button class="isb ${cls}" data-dashact="${a}" title="${esc(t)}">${ic}</button>`;
  // Same `known` gate as the inspector: the rail is the *same* verbs, and two surfaces
  // offering a different set of them for a second is worse than either alone.
  const repo = known && tier !== "none";
  return `<span class="sglyphs">
      <span class="pglyph" style="background:${esc(accent)}">${esc(initial)}</span>
      ${live.map((s) => `<button class="isb live ${s.cls}" data-sel="${esc(s.id)}" title="${esc(s.label)}">${s.glyph}</button>`).join("")}
    </span>
    ${b("launch", "＋", repo ? "New session…" : "New session")}
    ${b("terminal", "❯", "Open terminal here")}
    ${b("run", "▶", "Run a task…")}
    <span class="isep"></span>
    ${repo ? b("graph", "⑂", "Commit graph…") : ""}
    ${repo ? b("cleanup", "⌥", "Branches…") : ""}
    ${b("history", "◷", "History…")}
    ${b("folder", "⌂", "Open project folder")}
    ${b("copypath", "⧉", "Copy path")}`;
}

// ---------- the enlarge overlay ----------
// One component, N contents — title, subtitle, ✕ Close, and a footer stating the one
// non-obvious rule. It covers the dashboard rather than replacing it, and Esc steps
// out one layer, the same as the commit graph's message overlay.

export function overlayHtml(title: string, sub: string, body: string, foot: string): string {
  return `<div class="ovl-h"><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span>
      <span class="rt"><button class="act" data-dashclose-view>✕<span class="txt"> Close</span></button></span></div>
    <div class="ovl-b">${body}</div>
    ${foot ? `<div class="ovl-f">${foot}</div>` : ""}`;
}

/// Checkouts, enlarged: the ⑃ dialog's facts without the dialog. One fixed column
/// geometry for every row — `auto` would let each row size to its own tag and the
/// columns would stagger, which is the trap the commit graph's row grid documents.
export function checkoutsOverlay(
  heads: WtHead[], liveFor: (p: string) => number, dirtyFor: (p: string) => boolean,
): string {
  const rows = heads.map((w) => {
    const live = liveFor(w.path), dirty = dirtyFor(w.path);
    return `<div class="dbwt" data-dashwt="${esc(w.path)}">
      <span class="gl">${w.is_main ? "⌂" : "⑃"}</span>
      <span class="bn mono">${esc(w.branch || basename(w.path))}</span>
      <span class="pt mono">${esc(tilde(w.path))}</span>
      <span class="tags">${live ? `<span class="tag acc">${live} live</span>` : ""}${dirty ? `<span class="tag warn">uncommitted</span>` : `<span class="tag ok">clean</span>`}</span>
      <span class="acts"><button class="act" data-dashwtadd="${esc(w.path)}" title="New session here">＋</button>
        <button class="act" data-dashwtterm="${esc(w.path)}" title="Open a terminal here">❯</button></span>
    </div>`;
  }).join("");
  return overlayHtml("Checkouts", `${heads.length} · ${heads.filter((w) => liveFor(w.path)).length} with sessions`,
    `<div class="dbwt-hd"><span></span><span>Branch</span><span>Folder</span><span>State</span><span class="r">Actions</span></div>${rows}`,
    `Creating a worktree, pruning a stale one and every warning about a locked or detached checkout stay in the <b>⑃ dialog</b>, which already does all of that. This is a status board.`);
}

/// Branches, enlarged: the full-screen cleanup that used to be squeezed into the ⑃
/// dialog's detail column beside a second list. A table, one row per branch, checkboxes
/// down the side — the shape the decision actually has, which the dialog could not give
/// it. The rules are ./branches (pure, tested); this only draws them.
///
/// Two blocks in one view rather than two views, because they are one question asked in
/// two places — and they are NOT interchangeable: the local half deletes refs on this
/// machine, the remote half changes what everyone else sees, so each keeps its own count,
/// its own selection and its own button.
export function branchesOverlay(o: {
  local: CleanCand[]; remote: CleanCand[];
  picked: ReadonlySet<string>; rpicked: ReadonlySet<string>;
  trunk: string; remoteName: string;
  prs: MergedPrs | null; prsLoading: boolean;
  busy: boolean; loading: boolean;
  result: { swept: SweepResult; wts: { label: string; ok: boolean; note: string }[]; remote?: string } | null;
}): string {
  if (o.result) return overlayHtml("Cleaned up", esc(o.result.swept.summary),
    cleanResultHtml(o.result), "");
  if (o.loading) {
    return overlayHtml("Branches", "reading the repo…",
      `<div class="dbbr-hd"><span></span><span>Branch</span><span>Why it's here</span><span>Standing</span><span>Author</span><span class="r">Last commit</span></div>`
      + [72, 54, 63, 48].map((w) => `<div class="dbbr sk"><span></span><span>${sk(`${w}%`, 9)}</span>`
        + `<span>${sk("70%", 8)}</span><span>${sk("50%", 8)}</span><span>${sk("60%", 8)}</span><span>${sk("40%", 8)}</span></div>`).join(""),
      "");
  }

  const gh = o.prsLoading ? `<div class="dbbr-note">Reading merged pull requests…</div>`
    : o.prs && !o.prs.available
      ? `<div class="dbbr-note warn">No pull-request data — ${esc(o.prs.reason || "gh unavailable")}. `
        + `A squash-merged branch is contained in nothing, so without this it can't be identified and isn't offered.</div>`
      : "";

  // `half` rides in the attribute rather than being inferred from where the row sits:
  // the two halves run different commands, and a click must never arm the other side.
  const row = (c: CleanCand, on: boolean, half: string) => {
    const b = c.br;
    const tag = c.pr ? `<span class="tag ok" title="${esc(c.pr.title)}">#${c.pr.number} merged</span>`
      : b.gone ? `<span class="tag">gone</span>`
      : `<span class="tag ok">merged</span>`;
    return `<div class="dbbr${c.block ? " off" : ""}${on ? " on" : ""}" data-dashbr="${esc(b.name)}">
      <span class="ck"><button class="brck${on ? " on" : ""}" type="button" role="checkbox"
        aria-checked="${on}"${c.block ? " disabled" : ""} data-dashbrpick="${esc(half)}:${esc(b.name)}"
        title="${esc(c.block || c.why)}"></button></span>
      <span class="bn mono">${esc(b.name)}</span>
      <span class="why">${c.block ? `<span class="warn">${esc(c.block)}</span>` : tag}
        ${c.wt && !c.block ? `<span class="tag" title="Its checkout at ${esc(c.wt.path)} is removed with it">⑃ ${esc(basename(c.wt.path))}/</span>` : ""}
        ${c.force && !c.block ? `<span class="tag warn" title="Its pull request merged, so a squash is why -d refuses">forced</span>` : ""}</span>
      <span class="st mono">${esc(half === "remote" ? standing(b) : localStanding(b))}</span>
      <span class="au mono">${esc(b.author)}</span>
      <span class="ag mono r">${esc(b.rel)}</span>
    </div>`;
  };

  const block = (
    title: string, sub: string, cands: CleanCand[], picked: ReadonlySet<string>,
    act: string, label: (n: number) => string, empty: string, warn = "", extra = "",
  ) => {
    const pickable = cands.filter((c) => !c.block);
    const n = pickable.filter((c) => picked.has(c.br.name)).length;
    return `<div class="bk">
      <div class="bk-h"><span class="t">${esc(title)}</span><span class="n">${esc(sub)}</span>
        ${extra}
        ${pickable.length ? `<span class="bk-sel">${n} of ${pickable.length} selected</span>
          <button class="act" data-dashbrall="${esc(act)}">All</button>
          <button class="act" data-dashbrnone="${esc(act)}">None</button>` : ""}</div>
      ${warn}
      ${cands.length
        ? `<div class="dbbr-hd"><span></span><span>Branch</span><span>Why it's here</span>`
          + `<span>${act === "remote" ? "Versus the trunk" : "Its remote"}</span>`
          + `<span>Author</span><span class="r">Last commit</span></div>`
          + orderCands(cands).map((c) => row(c, !c.block && picked.has(c.br.name), act)).join("")
          + `<div class="dbbr-act"><button class="brgo" data-dashbrrun="${esc(act)}"${n && !o.busy ? "" : " disabled"}>`
          + `${o.busy ? "Working…" : esc(label(n))}</button></div>`
        : `<div class="ac-empty">${esc(empty)}</div>`}
    </div>`;
  };

  const localWarn = `<div class="dbbr-note">Local refs only — nothing on any remote is touched. `
    + `Episko runs git's safe <b>delete</b>, and what it refuses is kept and listed with git's own words.</div>`;
  const remoteWarn = `<div class="dbbr-note warn"><b>git push ${esc(o.remoteName)} --delete</b> removes the branch for everyone, not just here. `
    + `Only branches already contained in ${esc(o.trunk || "the trunk")} — or whose pull request merged — can be picked, and each deleted branch's sha comes back so it can be restored.</div>`;

  const body = gh
    + block("On this machine", `${o.local.length} cleanable`, o.local, o.picked,
      "local", (n) => (n ? `Delete ${n}` : "Delete"), "Nothing here is merged, and nothing has lost its remote.", localWarn)
    + block(`On ${o.remoteName}`, `${o.remote.length} branch${o.remote.length === 1 ? "" : "es"}`, o.remote, o.rpicked,
      "remote", (n) => (n ? `Delete ${n} on ${o.remoteName}` : `Delete on ${o.remoteName}`),
      "No remote-only branches to clean up.", remoteWarn,
      // The trunk sits with the numbers it decides, in the header of the half whose whole
      // Standing column is measured against it — not in a footer under two tables.
      `<button class="bk-cmp" data-dashbrtrunk title="Every branch here is measured against this&#10;Click to compare against another">vs ${esc(o.trunk || "nothing")}</button>`);

  // No footer: what it used to say (the trunk) is a control now, and it lives with the
  // column it governs.
  return overlayHtml("Branches", `${o.local.length} local · ${o.remote.length} remote`, body, "");
}

function cleanResultHtml(r: {
  swept: SweepResult; wts: { label: string; ok: boolean; note: string }[]; remote?: string;
}): string {
  const line = (n: string, right: string, title = "") =>
    `<div class="dbbr res"${title ? ` title="${esc(title)}"` : ""}><span class="bn mono">${esc(n)}</span>`
    + `<span class="rr mono">${right}</span></div>`;
  return `${r.wts.length ? `<div class="bk"><div class="bk-h"><span class="t">Checkouts</span></div>`
      + r.wts.map((w) => line(`${w.label}/`, w.ok ? `<span class="ok">removed</span>` : `<span class="warn">${esc(w.note)}</span>`)).join("")
      + `</div>` : ""}
    ${r.swept.deleted.length ? `<div class="bk"><div class="bk-h"><span class="t">Deleted</span>
        <span class="n">${r.remote
          ? `git push ${esc(r.remote)} &lt;sha&gt;:refs/heads/&lt;name&gt; restores one`
          : `git branch &lt;name&gt; &lt;sha&gt; puts one back`}</span></div>`
      + r.swept.deleted.map((d) => line(d.branch, `<span class="sha">${esc(d.sha)}</span>${d.forced ? ` <span class="warn">forced</span>` : ""}`)).join("")
      + `</div>` : ""}
    ${r.swept.kept.length ? `<div class="bk"><div class="bk-h"><span class="t">Kept</span></div>`
      + r.swept.kept.map((k) => line(k.branch, `<span class="warn">${esc(k.reason)}</span>`, `${k.branch} — ${k.reason}`)).join("")
      + `</div>` : ""}
    <div class="dbbr-act">
      ${r.swept.suggest ? `<button class="act" data-dashbrterm>Open a terminal with <b>-D</b> ready</button>` : ""}
      <button class="brgo" data-dashbrdone>Done</button></div>`;
}

export function notesOverlay(
  notes: Note[], shared: SharedNote[], sharedIds: Set<string>, canShare: boolean,
): string {
  const mine = notes.length
    ? `<div class="ncol">${notes.map((n) => `<div class="ncard" data-dashnote="${esc(n.id)}">
        <span class="tx">${esc(n.text)}</span>
        <span class="mt"><span>${esc(relTime(n.created))}</span></span>
        <span class="bar"><button class="act" data-dashdispatch="${esc(n.id)}">▶ Start an agent</button>
          <button class="act" data-dashdrop="${esc(n.id)}">✕</button>
          ${canShare ? `<span class="dsw${sharedIds.has(n.id) ? " on" : ""}" data-dashshare="${esc(n.id)}"
            title="Write this into .episko/notes.toml so the team can read it"><i></i>shared</span>` : ""}
        </span></div>`).join("")}</div>`
    : `<div class="ac-empty">Nothing queued yet.</div>`;
  // A colleague's note is theirs: dispatchable, but not editable or deletable from
  // here — this is a read of their file, not a shared mutable list.
  const theirs = shared.length
    ? `<div class="bk"><div class="bk-h"><span class="t">From the repo</span><span class="n">${shared.length}</span></div>
        <div class="ncol">${shared.map((n) => `<div class="ncard">
          <span class="tx">${esc(n.text)}</span>
          <span class="mt"><span class="clm">◍ ${esc(n.who || "someone")}</span><span>${esc(n.at)}</span></span>
          <span class="bar"><button class="act" data-dashdispatchtext="${esc(n.text)}">▶ Start an agent</button></span>
        </div>`).join("")}</div></div>`
    : "";
  const body = `<div class="bk"><div class="bk-h"><span class="t">Yours</span><span class="n">${notes.length}</span></div>${mine}</div>${theirs}`;
  return overlayHtml("Notes", `${notes.length} yours · ${shared.length} from the repo`, body,
    canShare
      ? `A note is yours alone until you flip <b>shared</b>, which writes it to <code>.episko/notes.toml</code> — committable, and readable by a colleague who never opens Episko. Flipping it back removes it from the file.`
      : `Notes stay on this machine — there is no repository to commit them into.`);
}

// ---------- the GitHub half ----------
// Issues and pull requests in one list: they were competing for the same four rows,
// the enlarged view already showed them together, and a kind chip separates them more
// cheaply than a heading does.

const KIND = (t: GhThread) => (t.kind === "pr" ? "pr" : "iss");

/// A claimed row turns its ▶ into a green ◍ **in the same slot**. Putting the name in
/// the row is what made this column ragged: the compact card says *that* it is taken,
/// the enlarged view says who and for how long.
function workRow(t: GhThread, h: Holder | null): string {
  const act = h
    ? `<button class="go held${h.stale ? " stale" : ""}" data-dashwork="${t.number}"
        title="${esc(`${h.who}${h.mine ? " (you)" : ""} — ${h.stale ? "claimed a while ago, probably stale" : "is on this"}. Start one anyway?`)}">◍</button>`
    : `<button class="go" data-dashwork="${t.number}" title="Start an agent on this">▶</button>`;
  return `<div class="cr${h ? " claimed" : ""}" data-dashurl="${esc(t.url)}" title="${esc(t.title)}">
    <span class="k ${KIND(t)}">${KIND(t)}</span>
    <span class="ti">${esc(t.title)}</span>
    <span class="rt"><span class="age">${esc(shortAge(t.updated_at))}</span>${act}</span></div>`;
}

/// Compact ages, tabular so the column lines up: 2h, 3d, 5w.
function shortAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Date.now() - t) / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const d = Math.round(m / 1440);
  return d < 14 ? `${d}d` : `${Math.round(d / 7)}w`;
}

export function workCard(rows: GhThread[], total: number, prs: number, holder: (t: GhThread) => Holder | null): string {
  if (!rows.length) return "";
  return `<div class="ac"><div class="ac-h"><span class="t">Open work</span>
      <span class="n">${total - prs} · ${prs} PR</span>
      <button class="xb" data-dashopen-view="work" title="See all issues and pull requests">⤢</button></div>
    <div class="ac-b">${rows.map((t) => workRow(t, holder(t))).join("")}</div></div>`;
}

/// gh missing, logged out, or pointed at a non-GitHub folder. One quiet row, never an
/// error dialog — the same stance a blocked runnable takes.
export function ghUnavailable(reason: string): string {
  return `<div class="miss"><span class="t">GitHub</span><p>${esc(reason)}.</p>
    <p>Everything else on this dashboard still works.</p></div>`;
}

// ---------- the enlarged views ----------
// One fixed column geometry per view, declared once in CSS and inherited by every row:
// an `auto` trailing track lets each row size to its own button label and the columns
// stagger, which is the trap the commit graph's row grid documents.

const BUCKET_LABEL: Record<string, string> = { today: "Today", week: "This week", older: "Older" };

function workBigRow(t: GhThread, h: Holder | null): string {
  const labels = t.labels.slice(0, 3).map((l) =>
    `<span class="lbl" style="--lc:${labelHue(l)}">${esc(l)}</span>`).join("");
  const claim = h
    ? `<span class="clm${h.mine ? " mine" : ""}${h.stale ? " stale" : ""}">◍ ${esc(h.mine ? "you" : h.who)}</span>` : "";
  const verb = h ? (h.mine ? "◍ Yours" : "▶ Anyway") : t.kind === "pr" ? "▶ Review" : "▶ Start";
  return `<div class="br" data-dashurl="${esc(t.url)}">
    <span class="k ${KIND(t)}">${t.kind === "pr" ? "pr" : "issue"}</span>
    <span class="num">${t.number}</span>
    <span class="mid"><span class="ti">${esc(t.title)}</span>
      ${labels || claim ? `<span class="sub">${labels}${claim}</span>` : ""}</span>
    <span class="age">${esc(shortAge(t.updated_at))}</span>
    <span class="go-slot"><button class="go${h ? " busy" : ""}" data-dashwork="${t.number}">${verb}</button></span>
  </div>`;
}

/// A stable hue per label name. GitHub's own colour is not in the payload we ask for,
/// and asking for it would cost a wider query for decoration.
function labelHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 62% 68%)`;
}

export function workOverlay(
  groups: { bucket: string; rows: GhThread[] }[], slug: string, total: number,
  holder: (t: GhThread) => Holder | null,
): string {
  const body = `<div class="lst-hd"><span>Kind</span><span class="r">#</span><span>Title</span>
      <span class="r">Age</span><span class="r">Action</span></div>`
    + groups.map((g) => `<div class="bk">
        <div class="bk-h"><span class="t">${esc(BUCKET_LABEL[g.bucket] ?? g.bucket)}</span><span class="n">${g.rows.length}</span></div>
        ${g.rows.map((t) => workBigRow(t, holder(t))).join("")}</div>`).join("");
  return overlayHtml("Open work", `${esc(slug)} · ${total} open`, body,
    `<b>◍</b> is a claim — somebody dispatched an agent at it. A hint, never a lock: you can always start anyway, and a claim older than 30 minutes reads as stale.`);
}

// ---------- triage ----------

export function triageCard(rows: { t: GhThread; why: string }[], total: number): string {
  if (!rows.length) return "";
  const body = rows.map(({ t, why }) => `<div class="tr" data-dashurl="${esc(t.url)}">
    <span class="mid"><span class="ti">${esc(t.title)}</span>
      <span class="sub">#${t.number} · ${esc(why)}</span></span>
    <span class="tr-b">
      <button class="tb yes" data-dashclose="${t.number}" title="Close it on GitHub, with a comment">✓</button>
      <button class="tb no" data-dashkeep="${t.number}" title="Keep it — nobody on the team is asked again">✕</button>
    </span></div>`).join("");
  return `<div class="ac"><div class="ac-h"><span class="t">Still needed?</span>
      <span class="n">${rows.length} of ${total}</span>
      <button class="xb" data-dashopen-view="triage" title="Review every quiet issue">⤢</button></div>
    <div class="ac-b">${body}</div></div>`;
}

export function triageOverlay(
  rows: { t: GhThread; why: string }[], kept: KeptIssue[], canWrite: boolean,
): string {
  const body = `<div class="lst-hd"><span class="r">#</span><span>Title &amp; why it's suggested</span><span class="r">Decide</span></div>`
    + `<div class="bk"><div class="bk-h"><span class="t">Suggested for closing</span><span class="n">${rows.length}</span></div>`
    + (rows.length ? rows.map(({ t, why }) => `<div class="tg" data-dashurl="${esc(t.url)}">
        <span class="num">${t.number}</span>
        <span class="mid"><span class="ti">${esc(t.title)}</span><span class="sub"><span>${esc(why)}</span></span></span>
        <span class="tg-b"><button class="act go-close" data-dashclose="${t.number}">✓ Close</button>
          <button class="act go-keep" data-dashkeep="${t.number}">✕ Keep</button></span></div>`).join("")
        : `<div class="ac-empty">Nothing has gone quiet. Triage has nothing to ask about.</div>`)
    + `</div>`
    // The keep list is committed, so it has to be reviewable: a decision nobody can
    // see is worse than no decision.
    + (kept.length ? `<div class="bk"><div class="bk-h"><span class="t">Kept — never suggested again</span>
        <span class="n">${kept.length}</span></div>`
      + kept.map((k) => `<div class="kept"><span class="num">${k.number}</span>
          <span class="ti">kept by ${esc(k.who || "someone")}</span>
          <span class="who">${esc(k.at)} <a href="#" data-dashunkeep="${k.number}">undo</a></span></div>`).join("")
      + `</div>` : "");
  return overlayHtml("Still needed?", `${rows.length} quiet · ${kept.length} kept`, body,
    canWrite
      ? `The keep list lives in <code>.episko/episko.toml</code> and is <b>committed</b>, so a colleague is never asked about an issue you both already decided to keep. That is also why it is reviewable and undoable here.`
      : `Keeping an issue needs a repository to commit the decision into.`);
}

// ---------- the confirm sheets ----------
// Closing an issue and claiming one are both public writes, one click from a dashboard
// you open constantly. Neither happens without showing exactly what will be written.

export function closeSheet(t: GhThread, comment: string, slug: string): string {
  return `<h4>Close #${t.number} on GitHub?</h4>
    <div class="body">
      <p>This posts a comment and closes the issue in <b>${esc(slug)}</b>. Everyone watching the repo sees it.</p>
      <p class="sheet-ti">${esc(t.title)}</p>
      <textarea id="dashCloseText" rows="4">${esc(comment)}</textarea>
    </div>
    <div class="foot"><button class="act" data-dashsheet="cancel">Cancel</button><span class="sp"></span>
      <button class="act primary" data-dashsheet="close">✓ Comment &amp; close</button></div>`;
}

export function dispatchSheet(t: GhThread, p: ClaimPolicy, allow: ClaimAllow, mode: string, holder: Holder | null): string {
  const sw = (k: string, on: boolean, permitted: boolean, label: string) =>
    `<span class="dsw${on && permitted ? " on" : ""}${permitted ? "" : " off"}" data-dashclaim="${k}"
      ${permitted ? "" : `title="This project's .episko/episko.toml switches it off for everyone"`}><i></i>${label}</span>`;
  return `<h4>Start an agent on #${t.number}</h4>
    <div class="body">
      <p class="sheet-ti">${esc(t.title)}</p>
      ${holder ? `<p class="warn-line">◍ ${esc(holder.who)} ${holder.stale ? "claimed this a while ago — probably stale" : "is already on this"}. Starting a second agent is allowed; a claim is a hint, not a lock.</p>` : ""}
      <p>A session in this project, and <b>the prompt is sent</b> — the agent starts working without waiting for you.</p>
      <div class="opts">
        ${sw("assign", p.assign, allow.assign, "assign the issue to me")}
        ${sw("comment", p.comment, allow.comment, "comment that my agent is on it")}
        ${sw("label", !!p.label, allow.label, `label <code>${esc(p.label || "agent: running")}</code>`)}
      </div>
      <p class="dim-line">Permission mode: <b>${esc(mode)}</b>. Anything that doesn't ask before acting will act unattended.</p>
    </div>
    <div class="foot"><button class="act" data-dashsheet="cancel">Cancel</button><span class="sp"></span>
      <button class="act primary" data-dashsheet="dispatch">▶ Claim &amp; start</button></div>`;
}
