// The project dashboard's markup: data in, string out, like every other *view module.
// ./dash owns the rules and ./dashboard owns the pane, the IPC and the events.

import { basename, esc, relTime, sparkline, tilde, uUsd2 } from "./format";
import { FILE_MANAGER } from "./dom"; // a constant, not DOM access: the *view rule allows it
import { syncState, type Pulse, type ProjectFacts, type ProjectTier, type SyncOp } from "./dash";
import type { Note, SharedNote } from "./notes";
import type { TrailCommit, TrailDay, TrailSession } from "./trail";
import type { DiffStat, WtHead } from "./types";
import type { ClaimAllow, ClaimPolicy } from "./claim";
import { ghPickable, type GhAccount, type GhThread, type GhWho, type Holder, type KeptIssue } from "./ghwork";
import {
  localStanding, orderCands, standing, type CleanCand, type MergedPrs, type SweepResult,
} from "./branches";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// The provenance mark on anything a model wrote. Just the word, no glyph: it has to be
// findable, not loud. The caller passes the whole label, since the inline mark needs a `·`
// before it and the cornered one does not.
const aiMark = (text: string, cls = "") =>
  `<span class="ai${cls ? " " + cls : ""}">${text}</span>`;
const AI_MARK = aiMark("ai", "ai-cnr"); // cornered, not inline: inline it read as part of the sentence

// ---------- the pulse strip ----------
// Which tiles exist depends on the tier: a permanent zero would read as "nothing happened".

function tile(k: string, v: string, d = ""): string {
  return `<div class="db-tile"><span class="k">${esc(k)}</span><span class="v">${v}</span>`
    + (d ? `<span class="d">${d}</span>` : "") + `</div>`;
}

// A preference, not data, so the skeleton below shows it too.
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
  // A dash rather than $0.00: per-project spend only exists from the day the detail
  // rollup started, and "not kept" is not the same fact as "free".
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
// Each is drawn in the geometry of what replaces it, so the answer arriving is a
// substitution rather than a jump. The bars carry no text; ./dashboard marks the pane
// aria-busy. The shimmer (.db-sk) and spinner (.u-spin) are the usage screen's own.

const sk = (w: string, h = 9) => `<i class="db-sk" style="width:${w};height:${h}px"></i>`;

/** The strip before it knows anything. Labels are bars too: which tiles exist depends on the tier. */
export function pulseSkeleton(range: number): string {
  const tiles = [["52px", "44px"], ["48px", "62px"], ["62px", "38px"], ["58px", "54px"]]
    .map(([k, v]) => `<div class="db-tile"><span class="k">${sk(k, 7)}</span>`
      + `<span class="v">${sk(v, 15)}</span><span class="d">${sk("40px", 7)}</span></div>`).join("");
  return `<div class="db-pulse">${tiles}${rangeTile(range)}</div>`;
}

// Three rows in the real .db-day geometry, and only three: the window is a preference
// this doesn't read, so a skeleton that runs to the fold promises a length it can't know.
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

// For the local reads and for the GitHub half, which fires after the rest and needs one
// most: an absent Open work card reads as gh being broken rather than slow.
export function cardSkeleton(rows = 3): string {
  const body = ["78%", "62%", "88%", "70%"].slice(0, rows).map((w) =>
    `<div class="cr">${sk("13px", 13)}<span class="ti">${sk(w, 9)}</span>`
    + `<span class="rt">${sk("30px", 9)}</span></div>`).join("");
  return `<div class="ac sk"><div class="ac-h">${sk("58px", 8)}<span class="n">${sk("24px", 8)}</span></div>
    <div class="ac-b">${body}</div></div>`;
}

// ---------- the timeline ----------

// A generated sentence is always marked: the mark is the only difference between a log
// and a claim. `summary` is your day; `team` is the project's, in a box of its own, and
// arrives already gated by `sharedDay`: the caller decides whether to show it, this only how.
export interface DayPending {
  mine?: boolean; // your own line, dayFacts → summarize_day
  team?: boolean; // the project's line, the shared box
}

export function dayHtml(
  d: TrailDay, summary: string | null, headline: string, open: boolean,
  team: string | null = null, authors: string[] = [], pend: DayPending = {},
): string {
  const dt = new Date(d.when);
  const rows = dayRows(d);
  const hidden = rows.length;
  // Your pending line is a mark beside the headline, which already reads fine; the shared
  // box has no stand-in, so only its sentence is a bar. The paragraph is not clamped and
  // must not be: `prompt_for` caps it at 22 words, so a fold could never fire honestly.
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

// Sessions and commits in one time order, not sessions then commits: a session and the
// commit it produced are cause and effect (the rule ./trail's `dayItems` follows).
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
  return `<div class="db-item" data-dashsha="${esc(c.sha)}" title="${esc(`${c.subject} · ${c.author}`)}">`
    + `<span class="db-kind">commit</span>`
    + `<span class="db-t">${esc(c.subject)}</span>`
    + `<span class="db-r">${clock(c.when * 1000)}</span></div>`;
}

// ---------- the aside ----------
// A card appears when it has something to say and is absent otherwise: an empty panel
// reads as breakage, not as an honest blank.

function card(id: string, title: string, count: string, body: string, enlarge = true): string {
  return `<div class="ac"><div class="ac-h"><span class="t">${esc(title)}</span>`
    + `<span class="n">${esc(count)}</span>`
    + (enlarge ? `<button class="xb" data-dashopen-view="${id}" title="See all">⤢</button>` : "")
    + `</div><div class="ac-b">${body}</div></div>`;
}

// Branch and one piece of state only: anything more costs a git process per checkout.
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

// ---------- the Repository card ----------
// The main checkout's git state and the verbs that act on it. It carries state because
// a row of buttons with no branch and no counts above them answers nothing.

/** The main checkout's last-known upstream state, behind the Repository card's verbs. */
export interface DashSync {
  branch: string;     // HEAD's branch; the only place this pane names it
  g: DiffStat | null; // as of the last fetch; null until the probe answers or if git can't read the folder
  busy: SyncOp | "";  // the op in flight; greys both verbs, since the lock is one per app
}

// ⇣ Pull's tooltip. Every wording says how fresh its numbers are, since nothing on this
// pane makes them live.
function pullSub(p: DashSync): string {
  if (p.busy === "pull") return "fetching, then fast-forwarding…";
  const g = p.g;
  const b = p.branch || "the main checkout";
  switch (syncState(g)) {
    case "no-upstream": return `${b} tracks no upstream`;
    case "diverged": return `diverged · ${g!.ahead} ahead, ${g!.behind} behind`;
    case "behind": return `${g!.behind} behind ${g!.upstream} at the last fetch`;
    // "level" alone would drop the one number the button beside it exists for.
    case "ahead": return `nothing to pull at the last fetch · ${g!.ahead} unpushed`;
    case "level": return `level with ${g!.upstream} at the last fetch`;
    default: return `fetch, then fast-forward ${b}`;
  }
}

// ⇡ Push's tooltip. Behind with nothing of our own is nothing to send (the backend runs
// no git); behind with our own commits is diverged, refused with a prefilled terminal.
function pushSub(p: DashSync): string {
  if (p.busy === "push") return "fetching, then pushing…";
  const g = p.g;
  const b = p.branch || "the main checkout";
  switch (syncState(g)) {
    case "no-upstream": return `${b} tracks no upstream`;
    case "diverged": return `diverged · ${g!.ahead} ahead, ${g!.behind} behind`;
    case "behind": return `nothing to push · ${g!.behind} behind ${g!.upstream}`;
    case "ahead": return `${g!.ahead} unpushed to ${g!.upstream} at the last fetch`;
    case "level": return "nothing to push at the last fetch";
    default: return `fetch, then push ${b}`;
  }
}

// ⇄ Switch's tooltip. A dirty tree is named because it turns the click into a terminal
// rather than a switch: git would carry uncommitted changes across, so Episko declines.
function switchSub(p: DashSync): string {
  const dirty = p.g && p.g.dirty > 0 ? p.g.dirty : 0;
  if (dirty) {
    return `${dirty} uncommitted file${dirty === 1 ? "" : "s"} here, so this hands you a terminal`;
  }
  return p.branch
    ? `on ${p.branch} · every worktree keeps its own`
    : "move the main checkout to another branch";
}

// Trims the branch's own name off the tracking ref (`main` on `origin/main` reads "origin");
// the header already says the branch. A differently named upstream stays in full.
function upName(g: DiffStat, branch: string): string {
  const u = g.upstream ?? "";
  const tail = `/${branch}`;
  return branch && u.endsWith(tail) ? u.slice(0, -tail.length) : u;
}

// States the position once; each button's tooltip says what it would do with it. The
// staleness is part of the sentence, not a footnote.
function syncLine(p: DashSync): string {
  if (p.busy) return p.busy === "pull" ? "fetching, then fast-forwarding…" : "fetching, then pushing…";
  const g = p.g;
  const up = g ? esc(upName(g, p.branch)) : "";
  const old = ` <span class="dim">as of the last fetch</span>`;
  // Uncommitted work is on this line because it changes what a click does: ⇄ Switch is
  // refused on a dirty tree, and git refuses ⇣ Pull's fast-forward when it would clobber.
  const un = g && g.dirty > 0 ? ` <span class="un">· ${g.dirty} uncommitted</span>` : "";
  const ah = `<span class="ah">↑${g?.ahead}</span>`, bh = `<span class="bh">↓${g?.behind}</span>`;
  switch (syncState(g)) {
    case "no-upstream": return `${esc(p.branch || "the main checkout")} tracks no upstream${un}`;
    case "diverged": return `${ah} ${bh} diverged from ${up}${old}${un}`;
    case "behind": return `${bh} behind ${up}${old}${un}`;
    case "ahead": return `${ah} unpushed to ${up}${old}${un}`;
    case "level": return `in sync with ${up}${old}${un}`;
    // Not read yet, or not a repo: every verb fetches first, so this is unknown, not wrong.
    default: return `<span class="dim">not read yet · every verb here fetches first</span>`;
  }
}

// `known` is `factsKnown`. Three states, never merged: unknown gets a skeleton, a folder
// that is no repo gets nothing (`missingCard` says why), a repo gets the card.
export function repoCard(sync: DashSync | null, known = true): string {
  if (!known) return cardSkeleton(2);
  if (!sync) return "";
  const busy = !!sync.busy;
  const gb = (a: string, label: string, title: string, wide = false, off = false) =>
    `<button class="gitb${wide ? " wide" : ""}" data-dashact="${a}"${off ? " disabled" : ""}`
    + ` title="${esc(title)}">${label}</button>`;
  const body = `<div class="gsub">${syncLine(sync)}</div>
    <div class="gbts">
      ${gb("pull", sync.busy === "pull" ? "⇣ Pulling…" : "⇣ Pull", pullSub(sync), false, busy)}
      ${gb("push", sync.busy === "push" ? "⇡ Pushing…" : "⇡ Push", pushSub(sync), false, busy)}
      ${gb("switch", "⇄ Switch branch…", switchSub(sync), true)}
      ${gb("graph", "⑂ Commit graph…", "history, branches, merges")}
      ${gb("cleanup", "⌥ Branches…", "clean up merged and orphaned ones")}
    </div>`;
  // The branch takes the count slot: with no worktrees this card is the only place it is named.
  return card("repo", "Repository", sync.branch ? `⌂ ${sync.branch}` : "", body, false);
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

// The one-time offer to start a shared work log, under the sentences it talks about.
// Absent once the project has a digest: from then on every closed day is contributed
// automatically. `n` counts the project's lines, the only ones that go in.
export function workLogOffer(n: number): string {
  if (!n) return "";
  return `<div class="miss db-share"><span class="t">Not written down anywhere</span>
    <p>Episko has read ${n === 1 ? "one day" : `${n} days`} of this project's history and can keep the
       result in <code>.episko/digest.md</code>. Committed, everyone who pulls gets the same account of
       what the project did, instead of re-deriving, and paying for, their own.</p>
    <p>Only the commits and pull requests go in. Your own sessions and spend stay on this machine.</p>
    <button class="act" data-dashworklog>↑ Start the work log</button></div>`;
}

// What this folder can't do, said once, in place of the cards it replaces.
export function missingCard(tier: ProjectTier, f: ProjectFacts | null): string {
  if (tier === "github") return "";
  if (tier === "git") {
    const where = f?.host ? `<code>${esc(f.host)}</code>` : "no remote at all";
    return `<div class="miss"><span class="t">Not on GitHub</span>
      <p>Issues, pull requests and claims need a GitHub remote. This project's origin is ${where}.
         Those cards are absent rather than empty.</p>
      <p><b>Sharing still works.</b> <code>.episko/</code> is committed like any other file, so the
         work log reaches whoever pulls. GitHub was never what made it shared.</p></div>`;
  }
  return `<div class="miss"><span class="t">Not a repository</span>
    <p>The timeline is still real: sessions and spend come from Claude's own transcripts, which never
       needed git. What's missing is the commit half: no checkouts, no contributors, no work log.</p>
    <p>Notes stay on this machine: there is nothing to commit <code>.episko/</code> into.</p></div>`;
}

// ---------- the inspector: the project's context menu, standing open ----------

// `known`: whether `project_facts` has answered for this project; until it has, `tier`
// reads `none` and must not be read alone. Not "is anything loading": a range change
// reloads the timeline without putting the tier in doubt.
export function dashInspector(
  root: string, tier: ProjectTier, f: ProjectFacts | null,
  live: { id: string; label: string; glyph: string; cls: string; ctx: string }[],
  shared: boolean, known = true,
): string {
  const act = (a: string, ic: string, lb: string, sb = "", cls = "", off = false) =>
    `<button class="ia ${cls}" data-dashact="${a}"${off ? " disabled" : ""}><span class="ic">${ic}</span>`
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
      ${act("history", "◷", "History…", "reopen a session you closed")}
      ${act("folder", "⌂", "Open project folder", `reveal it in ${FILE_MANAGER}`)}
      ${act("copypath", "⧉", "Copy path", "the full path, to the clipboard")}
      ${repo && !shared
        ? act("worklog", "↑", "Share the work log…", "commit each day's summary to .episko/") : ""}
    </div></div>
    ${chips ? `<div><span class="label">Repository</span><div class="db-chips">${chips}</div></div>` : ""}
    <p class="ihint">${esc(tilde(root))}</p>`;
}

// The 44px rail ⌘I collapses to. The inspector holds the only copy of History /
// Terminal / Run here, so collapsing to nothing would hide real verbs.
export function dashStrip(
  accent: string, initial: string, tier: ProjectTier,
  live: { id: string; glyph: string; cls: string; label: string }[], known = true,
): string {
  const b = (a: string, ic: string, t: string, cls = "", off = false) =>
    `<button class="isb ${cls}" data-dashact="${a}" title="${esc(t)}"${off ? " disabled" : ""}>${ic}</button>`;
  // Same `known` gate as the inspector: the two surfaces must offer the same verbs.
  const repo = known && tier !== "none";
  return `<span class="sglyphs">
      <span class="pglyph" style="background:${esc(accent)}">${esc(initial)}</span>
      ${live.map((s) => `<button class="isb live ${s.cls}" data-sel="${esc(s.id)}" title="${esc(s.label)}">${s.glyph}</button>`).join("")}
    </span>
    ${b("launch", "＋", repo ? "New session…" : "New session")}
    ${b("terminal", "❯", "Open terminal here")}
    ${b("run", "▶", "Run a task…")}
    <span class="isep"></span>
    ${b("history", "◷", "History…")}
    ${b("folder", "⌂", "Open project folder")}
    ${b("copypath", "⧉", "Copy path")}`;
}

// ---------- the enlarge overlay ----------
// One component, N contents. It covers the dashboard rather than replacing it; Esc steps
// out one layer, as in the commit graph's message overlay.

export function overlayHtml(title: string, sub: string, body: string, foot: string): string {
  return `<div class="ovl-h"><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span>
      <span class="rt"><button class="act" data-dashclose-view>✕<span class="txt"> Close</span></button></span></div>
    <div class="ovl-b">${body}</div>
    ${foot ? `<div class="ovl-f">${foot}</div>` : ""}`;
}

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

// Branches, enlarged; the rules are ./branches, this only draws them. The two halves are
// not interchangeable (local deletes refs here, remote changes what everyone sees), so
// each keeps its own count, selection and button.
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
      ? `<div class="dbbr-note warn">No pull-request data: ${esc(o.prs.reason || "gh unavailable")}. `
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

  const localWarn = `<div class="dbbr-note">Local refs only. Nothing on any remote is touched. `
    + `Episko runs git's safe <b>delete</b>, and what it refuses is kept and listed with git's own words.</div>`;
  const remoteWarn = `<div class="dbbr-note warn"><b>git push ${esc(o.remoteName)} --delete</b> removes the branch for everyone, not just here. `
    + `Only branches already contained in ${esc(o.trunk || "the trunk")}, or whose pull request merged, can be picked, and each deleted branch's sha comes back so it can be restored.</div>`;

  const body = gh
    + block("On this machine", `${o.local.length} cleanable`, o.local, o.picked,
      "local", (n) => (n ? `Delete ${n}` : "Delete"), "Nothing here is merged, and nothing has lost its remote.", localWarn)
    + block(`On ${o.remoteName}`, `${o.remote.length} branch${o.remote.length === 1 ? "" : "es"}`, o.remote, o.rpicked,
      "remote", (n) => (n ? `Delete ${n} on ${o.remoteName}` : `Delete on ${o.remoteName}`),
      "No remote-only branches to clean up.", remoteWarn,
      // The trunk control sits in the header of the half measured against it.
      `<button class="bk-cmp" data-dashbrtrunk title="Every branch here is measured against this&#10;Click to compare against another">vs ${esc(o.trunk || "nothing")}</button>`);

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
      + r.swept.kept.map((k) => line(k.branch, `<span class="warn">${esc(k.reason)}</span>`, `${k.branch}: ${k.reason}`)).join("")
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
  // A colleague's note is dispatchable but not editable here: this is a read of their file.
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
      ? `A note is yours alone until you flip <b>shared</b>, which writes it to <code>.episko/notes.toml</code>: committable, and readable by a colleague who never opens Episko. Flipping it back removes it from the file.`
      : `Notes stay on this machine. There is no repository to commit them into.`);
}

// ---------- the GitHub half ----------
// Issues and pull requests in one list; a kind chip separates them more cheaply than a heading.

const KIND = (t: GhThread) => (t.kind === "pr" ? "pr" : "iss");

// A claimed row turns its ▶ into a ◍ in the same slot; a name in the row made the column
// ragged. The enlarged view says who and for how long.
function workRow(t: GhThread, h: Holder | null): string {
  const act = h
    ? `<button class="go held${h.stale ? " stale" : ""}" data-dashwork="${t.number}"
        title="${esc(`${h.who}${h.mine ? " (you)" : ""} ${h.stale ? "claimed a while ago, probably stale" : "is on this"}. Start one anyway?`)}">◍</button>`
    : `<button class="go" data-dashwork="${t.number}" title="Start an agent on this">▶</button>`;
  return `<div class="cr${h ? " claimed" : ""}" data-dashurl="${esc(t.url)}" title="${esc(t.title)}">
    <span class="k ${KIND(t)}">${KIND(t)}</span>
    <span class="ti">${esc(t.title)}</span>
    <span class="rt"><span class="age">${esc(shortAge(t.updated_at))}</span>${act}</span></div>`;
}

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

// gh missing, logged out, or signed in as the wrong account: one quiet row, never an
// error dialog. The account picker is offered here because here is where you find out;
// it is absent for anybody with one account, where it could not change the answer.
export function ghUnavailable(reason: string, accounts: GhAccount[], who: GhWho): string {
  return `<div class="miss"><span class="t">GitHub</span><p>${esc(reason)}.</p>
    <p>Everything else on this dashboard still works.</p>${ghPicker(accounts, who)}</div>`;
}

// One button per account gh holds, the effective one marked; the label underneath says
// whether that is gh's default or a pin, which only matters the day the default changes.
export function ghPicker(accounts: GhAccount[], who: GhWho): string {
  if (!ghPickable(accounts)) return "";
  const btn = (login: string, on: boolean) =>
    `<button class="act${on ? " on" : ""}" data-dashact="ghacct:${esc(login)}">${esc(login)}</button>`;
  const rows = accounts.map((a) => btn(a.login, a.login === who.login)).join("");
  // A pin gh has forgotten still holds (the backend refuses rather than answering as
  // somebody else), so it is shown, marked and inert; the way out is another account or clear.
  const gone = who.source === "pinned" && !who.known && who.login
    ? `<button class="act on" disabled>${esc(who.login)}</button>` : "";
  const sub = who.source === "pinned"
    ? (who.known ? "set for this project" : `gh is not logged in as ${esc(who.login ?? "")} any more`)
    : "gh's default account, for every project that sets none";
  return `<div class="ghpick"><span class="lb">Read this project as</span>
    <div class="row">${gone}${rows}${who.source === "pinned"
      ? `<button class="act" data-dashact="ghacctclear">Follow gh's default</button>` : ""}</div>
    <span class="sb">${sub}</span></div>`;
}

// ---------- the enlarged views ----------
// One fixed column geometry per view, declared once in CSS: an `auto` trailing track
// would let each row size to its own button label and the columns stagger.

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

// A stable hue per label name; GitHub's own colour would cost a wider query for decoration.
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
    `<b>◍</b> is a claim: somebody dispatched an agent at it. It is a hint rather than a lock, so you can always start anyway, and a claim older than 30 minutes reads as stale.`);
}

// ---------- triage ----------

export function triageCard(rows: { t: GhThread; why: string }[], total: number): string {
  if (!rows.length) return "";
  const body = rows.map(({ t, why }) => `<div class="tr" data-dashurl="${esc(t.url)}">
    <span class="mid"><span class="ti">${esc(t.title)}</span>
      <span class="sub">#${t.number} · ${esc(why)}</span></span>
    <span class="tr-b">
      <button class="tb yes" data-dashclose="${t.number}" title="Close it on GitHub, with a comment">✓</button>
      <button class="tb no" data-dashkeep="${t.number}" title="Keep it, so nobody on the team is asked again">✕</button>
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
    // The keep list is committed, so it has to be reviewable here.
    + (kept.length ? `<div class="bk"><div class="bk-h"><span class="t">Kept · never suggested again</span>
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
// Closing and claiming are public writes one click from a dashboard you open constantly;
// neither happens without showing exactly what will be written.

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
      ${holder ? `<p class="warn-line">◍ ${esc(holder.who)} ${holder.stale ? "claimed this a while ago, probably stale" : "is already on this"}. Starting a second agent is allowed; a claim is only ever a hint.</p>` : ""}
      <p>A session in this project, and <b>the prompt is sent</b>, so the agent starts working without waiting for you.</p>
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
