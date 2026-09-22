// The project dashboard's markup: data in, string out, like every other *view module.
// ./dash owns the rules and ./dashboard owns the pane, the IPC and the events.

import { barRow, basename, esc, escAttr, fmtDay, fmtSince, nameHue, relTime, tilde, uUsd2 } from "./format";
import { FILE_MANAGER } from "./dom"; // a constant, not DOM access: the *view rule allows it
import {
  syncState,
  type ProjectFacts, type ProjectTier, type RibbonDay, type SinceFacts, type SyncOp,
} from "./dash";
import type { Note, SharedNote } from "./notes";
import type { DiffStat, StatusFile, WorkingSet, WtHead } from "./types";
import { wpeekHtml } from "./inspectorview";
import { fileSetHtml } from "./patchview";
import type { ClaimAllow, ClaimPolicy } from "./claim";
import { ghPickable, type GhAccount, type GhThread, type GhWho, type Holder, type KeptIssue } from "./ghwork";
import { type QueueFilter, type QueueFold, type QueueItem, type QueueRow } from "./queue";
import {
  anyDeletable, BRANCH_FILTERS, chosenCheckouts, filterCounts, filterRows, localPicks, lockText,
  orderRows, remoteOf, remotePicks, syncText, trunkText, type BranchFilter, type BranchRow,
  type CheckoutRow, type MergedPrs, type ProtectCtx, type SweepResult,
} from "./branches";
import type { PickKind, PickState } from "./pick";

// The provenance mark on anything a model wrote. Just the word, no glyph: it has to be
// findable, not loud. The caller passes the whole label, since the inline mark needs a `·`
// before it and the cornered one does not.
const aiMark = (text: string, cls = "") =>
  `<span class="ai${cls ? " " + cls : ""}">${text}</span>`;
const AI_MARK = aiMark("ai", "ai-cnr"); // cornered, not inline: inline it read as part of the sentence

// ---------- skeletons ----------
// Each is drawn in the geometry of what replaces it, so the answer arriving is a
// substitution rather than a jump. The bars carry no text; ./dashboard marks the pane
// aria-busy. The shimmer (.db-sk) and spinner (.u-spin) are the usage screen's own.

const sk = (w: string, h = 9) => `<i class="db-sk" style="width:${w};height:${h}px"></i>`;

// For the local reads and for the GitHub half, which fires after the rest and needs one
// most: an absent Open work card reads as gh being broken rather than slow.
export function cardSkeleton(rows = 3): string {
  const body = ["78%", "62%", "88%", "70%"].slice(0, rows).map((w) =>
    `<div class="cr">${sk("13px", 13)}<span class="ti">${sk(w, 9)}</span>`
    + `<span class="rt">${sk("30px", 9)}</span></div>`).join("");
  return `<div class="ac sk"><div class="ac-h">${sk("58px", 8)}<span class="n">${sk("24px", 8)}</span></div>
    <div class="ac-b">${body}</div></div>`;
}

// ---------- what is running here ----------

// `data-sel` is deliberately not dash-prefixed: it belongs to main.ts's document dispatcher,
// so the click falls through this pane's own chain and lands on the session rail's handler.
export interface LiveRow {
  id: string; label: string; glyph: string; cls: string; ctx: string; branch: string;
  ext?: boolean;   // somebody else's terminal: Episko can show it and jump to it, not drive it
}

// `data-sel` is deliberately not dash-prefixed: it belongs to main.ts's document dispatcher,
// so the click falls through this pane's own chain and lands on the session rail's handler.
export function liveHereCard(live: LiveRow[]): string {
  // The one verb this section offers, and only when it has nothing else to say. Through a
  // helper named `act`, like every other surface, so test/dispatch.test.ts can see it.
  const act = (a: string, label: string, tip: string) =>
    `<button class="lh-new" data-dashact="${a}" data-tip="${escAttr(tip)}">${label}</button>`;
  if (!live.length) {
    return `<div class="asec"><div class="asec-h"><span class="label">Running here</span></div>
      <div class="lh-none"><span>Nothing running in this project.</span>
        ${act("launch", "＋ Start a session", "Pick the repo, a worktree, or a branch")}</div></div>`;
  }
  const rows = live.map((s) =>
    `<button class="srow${s.ext ? " ext" : ""}" data-sel="${escAttr(s.id)}"`
    + ` data-tip="${escAttr(s.ext ? `${s.label} · outside Episko${s.branch ? ` · ${s.branch}` : ""}` : s.branch ? `${s.label} · ${s.branch}` : s.label)}">`
    + `<span class="sglyph ${escAttr(s.cls)}">${esc(s.glyph)}</span>`
    + `<span class="sbranch">${esc(s.label)}</span>`
    + `<span class="sctx">${s.ext ? `<span class="tag">ext</span>` : esc(s.ctx)}</span></button>`).join("");
  return `<div class="asec"><div class="asec-h"><span class="label">Running here</span>
      <span class="tag warn">${live.length} live</span></div>
    <div class="ip-live">${rows}</div></div>`;
}

// ---------- the project's verbs ----------

export function verbTiles(): string {
  // One helper writes every data-dashact on this surface: test/dispatch.test.ts reads the verbs
  // off these calls, so an attribute spelled inline here would be invisible to it.
  const act = (a: string, ic: string, lb: string, tip: string) =>
    `<button class="vt" data-dashact="${a}" data-tip="${escAttr(tip)}">`
    + `<span class="vt-ic">${ic}</span><span class="vt-lb">${esc(lb)}</span></button>`;
  // `known`: whether `project_facts` has answered. Until it has, `tier` reads `none` and must
  // not be read alone, or a repo is offered the folder-only wording for its first frame.
  // No ＋ here: the stage header's ＋ Session already acts on this project, and two of the same
  // verb a hand's width apart is how the old twelve-row menu grew in the first place.
  return `<div class="vt-grid">
      ${act("terminal", "❯", "Terminal", "Open a terminal here, with no Claude in it")}
      ${act("run", "▶", "Run", "Run one of the scripts this project already ships")}
      ${act("history", "◷", "History", "Reopen a session you closed here")}
      ${act("folder", "⌂", "Reveal", `Reveal the project folder in ${FILE_MANAGER}`)}
      ${act("copypath", "⧉", "Copy", "Copy the full path to the clipboard")}
    </div>`;
}

/** The column's foot: what this project is set up to run as. Each chip IS its own control. */
export function projectFoot(agent: string, gh: string, claims: boolean, ghPick: boolean): string {
  const act = (a: string, inner: string, tip: string) =>
    `<button class="pfc pfc-b" data-dashact="${a}" data-tip="${escAttr(tip)}">${inner}</button>`;
  // Claims are the one fact here with no picker of its own: the preference is Settings', and the
  // project's `[claim]` table can veto it, so the chip explains rather than pretends to toggle.
  const claimTip = claims
    ? "Dispatching from here marks the issue as taken. Set in Settings; a project's [claim] table can veto it"
    : "Dispatching from here writes nothing to GitHub. Set in Settings; a project's [claim] table can veto it";
  return `<div class="pfoot"><span class="label">Set up for</span>
    <div class="pfc-row">
      ${act("agent", esc(agent), `Runs ${agent} here · pick another for this project`)}
      ${gh && ghPick ? act("ghpick", `gh: ${esc(gh)}`, `Reads GitHub as ${gh} · pin another account to this project`)
        : gh ? `<span class="pfc mono" data-tip="${escAttr(`Reads GitHub as ${gh}`)}">gh: ${esc(gh)}</span>` : ""}
      <span class="pfc" data-tip="${escAttr(claimTip)}">${claims ? "claims on" : "claims off"}</span>
    </div></div>`;
}

// ---------- since you were last here ----------

// A preference, not data, so the skeleton below draws the real picker rather than a bar.
// Value then label, on one baseline: "12 commits" reads as a sentence where a stacked caps
// label reads as a dashboard tile, and four of them fit a column this narrow.
// `v` and `d` are raw so a figure can carry markup — the em dash, a mark. Never user text.
const fig = (v: string, k: string, d = "") =>
  `<span class="sb-fig"><span class="v">${v}</span><span class="k">${esc(k)}</span>`
  + (d ? `<span class="d">${d}</span>` : "") + `</span>`;

const whoText = (authors: string[]): string => authors.length
  ? esc(authors.slice(0, 2).map((a) => a.split(/\s+/)[0]).join(", "))
    + (authors.length > 2 ? ` +${authors.length - 2}` : "")
  : `<span class="dim">—</span>`;

/** One day's already-generated sentence. The caller picks which; this only says how. */
export interface BandLine { key: string; text: string; team: boolean; writing: boolean }

// A generated sentence is always marked: the mark is the only difference between a log and a
// claim. The shared line says whose day it is, since it is the project's and not yours.
function bandLine(l: BandLine): string {
  const cnr = l.team && !l.writing ? AI_MARK : ""; // floats right, so it leads the source order
  const inline = l.writing ? aiMark("· writing", "wr") : l.team ? "" : aiMark("· ai");
  return `<p class="sb-line" title="${escAttr(l.key)}">${cnr}`
    + (l.team ? `<span class="dim">shared · </span>` : "") + `${esc(l.text)}${inline}</p>`;
}

// The band's one door out, in both states. `history` is a verb `verbTiles` already offers, so
// the if-chain needs nothing new — but test/dispatch.test.ts reads this surface too.
const TRAIL = `<button class="sb-trail" data-dashact="history"`
  + ` title="Every session and commit this project has had">Full trail ⤢</button>`;

// Thirty days of commits, one bar a day: a line between two counts invents the days in
// between (./format's `barRow` is the geometry). The ribbon is a repo's fact, so a plain
// folder gets none rather than a flat row of zeroes.
// The hoverable, clickable day is the full-height `.sb-b` column, never the bar inside it:
// a quiet day's bar is a 3px sliver and the quiet days are what the strip exists to show.
function ribbonHtml(ribbon: RibbonDay[], range: number, repo: boolean): string {
  if (!repo || ribbon.length < 2) return "";
  const bars = barRow(ribbon.map((d) => d.n), Math.min(7, ribbon.length));
  const cols = ribbon.map((d, i) => {
    const tip = `${fmtDay(d.when)} · ${d.n} commit${d.n === 1 ? "" : "s"}`;
    return `<button class="sb-b" data-dashday="${escAttr(d.key)}" data-tip="${escAttr(tip)}"`
      + ` aria-label="${escAttr(tip)}">`
      + `<i class="sb-bar ${bars[i].cls}" style="height:${bars[i].h}px"></i></button>`;
  }).join("");
  return `<div class="sb-rib"><div class="sb-bars">${cols}</div>
    <div class="sb-foot"><span class="sb-rl">${range} days · from ${esc(fmtDay(ribbon[0].when))}</span>
    ${TRAIL}</div></div>`;
}

// The window's number comes from `range`, never from `f.days`: `days` is the true age of the
// stamp and outruns the window whenever you were last here longer ago than the ribbon reaches.
export function sinceBand(
  f: SinceFacts, lines: BandLine[], ribbon: RibbonDay[], range: number,
  tier: ProjectTier, known: boolean, offer: number,
): string {
  const repo = known && tier !== "none";
  // Four wordings, never interchangeable: no stamp at all, a stamp older than anything read,
  // a visit nothing has happened since, and a gap with something in it. The first three all
  // count the window (`f.window`), so none of them may be told as "since you were last here".
  const head = f.first ? "First look here"
    : f.window ? `In the last ${range} days`
    : "Since you were last here";
  // Never a repeat of the head: with the window named above, this slot carries the visit,
  // which is the fact that explains why the figures are the window's and not yours.
  const ago = f.first ? `${range} days`
    : f.capped ? `last here ${fmtSince(f.since)}`
    : f.quiet ? `nothing new since ${fmtSince(f.since)}`
    : `${fmtSince(f.since)} → now` + (f.days >= 1 ? ` · ${f.days} day${f.days === 1 ? "" : "s"}` : "");
  const plural = (n: number, one: string) => (n === 1 ? one : `${one}s`);
  const figs = (repo ? fig(String(f.commits), plural(f.commits, "commit")) : "")
    + fig(String(f.sessions), plural(f.sessions, "session"))
    + fig(f.spend > 0 ? esc(uUsd2(f.spend)) : `<span class="dim">—</span>`, "spend")
    + (repo ? fig(String(f.authors.length), plural(f.authors.length, "contributor"), whoText(f.authors)) : "");
  // Only when there is a gap with something in it: with no stamp, a stamp older than the
  // window, or nothing since the last visit, there is nothing left to catch up on.
  const read = f.window
    ? "" : `<button class="sb-read" data-dashseen title="Treat everything above as read">Mark read</button>`;
  return `<div class="sinceb">
    <div class="sb-h"><span class="t">${esc(head)}</span><span class="sb-ago">${esc(ago)}</span>${read}</div>
    <div class="sb-figs">${figs}</div>
    ${lines.map(bandLine).join("")}
    ${ribbonHtml(ribbon, range, repo)}
    ${workLogOffer(offer)}</div>`;
}

// Substitution rather than a jump, so the figure count is the tier's, exactly as the band
// derives it. `tier` is optional only because the very first read has not answered yet.
export function bandSkeleton(tier: ProjectTier = "github"): string {
  const bars = (tier === "none"
    ? [["48px", "62px"], ["62px", "38px"]]
    : [["52px", "44px"], ["48px", "62px"], ["62px", "38px"], ["58px", "54px"]])
    .map(([k, v]) => `<div class="sb-fig"><span class="k">${sk(k, 7)}</span>`
      + `<span class="v">${sk(v, 15)}</span><span class="d">${sk("40px", 7)}</span></div>`).join("");
  return `<div class="sinceb">
    <div class="sb-h"><span class="t">${sk("124px", 8)}</span></div>
    <div class="sb-figs">${bars}</div>
    <div class="sb-rib">${sk("100%", 26)}</div>
    <p class="db-skhint"><span class="u-spin"></span>Reading this project's history…</p></div>`;
}

// ---------- the aside ----------
// A card appears when it has something to say and is absent otherwise: an empty panel
// reads as breakage, not as an honest blank.


// `undefined` is a folder nothing has measured yet, and it must never read as clean: the
// map is only filled for folders in play. Live and dirty are both shown — they answer
// different questions, and a checkout can be either without the other.
function checkoutTag(g: DiffStat | null | undefined): string {
  if (g === undefined) return `<span class="tag" data-tip="Nobody has read this folder yet — not the same as clean">—</span>`;
  if (!g || !g.dirty) return `<span class="tag ok">clean</span>`;
  return `<span class="tag warn">${g.dirty} uncommitted</span>`;
}
// A row is a door only when there is something behind it; `.cr[data-dashwt]` is the cursor.
function checkoutRow(w: WtHead, live: number, g: DiffStat | null | undefined, main: boolean): string {
  const open = !!g && g.dirty > 0 ? ` data-dashwt="${esc(w.path)}"` : "";
  const tip = open ? `${tilde(w.path)} · click to review its uncommitted work` : tilde(w.path);
  return `<div class="cr"${open} data-tip="${escAttr(tip)}">`
    + `<span class="k">${main ? "⌂" : "⑃"}</span>`
    + `<span class="ti mono">${esc(w.branch || basename(w.path))}</span>`
    + `<span class="rt">${live ? `<span class="tag acc">${live} live</span>` : ""}${checkoutTag(g)}</span></div>`;
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
  // Uncommitted work is the Working set card's, directly above: this line is about the
  // remote, and `switchSub` still names the dirty-tree refusal on the button it refuses.
  const ah = `<span class="ah">↑${g?.ahead}</span>`, bh = `<span class="bh">↓${g?.behind}</span>`;
  switch (syncState(g)) {
    case "no-upstream": return `${esc(p.branch || "the main checkout")} tracks no upstream`;
    case "diverged": return `${ah} ${bh} diverged from ${up}${old}`;
    case "behind": return `${bh} behind ${up}${old}`;
    case "ahead": return `${ah} unpushed to ${up}${old}`;
    case "level": return `in sync with ${up}${old}`;
    // Not read yet, or not a repo: every verb fetches first, so this is unknown, not wrong.
    default: return `<span class="dim">not read yet · every verb here fetches first</span>`;
  }
}

const DASH_FILES_SHOWN = 5;   // the aside is a card, not a diff viewer; the rest is a click away

// What is uncommitted in the main checkout, and in which files: the peek every other host
// draws over ./patchview's rows, so a working set is spelled the same wherever it is asked
// about. Each row is a door onto that file. No `⤢` — this card's enlargement is the diff
// overlay, and `data-dashopen-view` must keep meaning one mechanism (`#dashOverlay`).
export function worksetCard(
  dir: string, title: string, g: WorkingSet | null | undefined, known: boolean,
): string {
  if (!known || !dir) return "";
  if (g === undefined) return cardSkeleton(2);   // in flight: pending is not clean
  if (!g || !g.dirty) return "";                 // a card with nothing to say is absent, not empty
  const door = (f: StatusFile) =>
    ` data-diff="${escAttr(dir)}" data-difftitle="${escAttr(title)}" data-difffocus="${escAttr(f.path)}"`;
  const body = `<div class="wsb">${wpeekHtml(dir, title, g)}`
    + `${fileSetHtml(g.entries, DASH_FILES_SHOWN, g.dirty, door)}</div>`;
  const n = g.dirty === 1 ? "1 file" : `${g.dirty} files`;
  // The review button is the card's enlargement, so it says what it opens rather than wearing
  // the bare ⤢ every other card uses — this is the one people came here to click.
  return `<div class="ac"><div class="ac-h"><span class="t">Working set</span>`
    + `<span class="n" title="${escAttr(tilde(dir))}">${esc(title)} · uncommitted</span>`
    + `<button class="aslink" data-diff="${escAttr(dir)}" data-difftitle="${escAttr(title)}"`
    + ` title="Review every uncommitted change">Review ${esc(n)} ⤢</button></div>`
    + `<div class="ac-b">${body}</div></div>`;
}

// `known` is `factsKnown`. Three states, never merged: unknown gets a skeleton, a folder
// that is no repo gets nothing (`missingCard` says why), a repo gets the card.
export function checkoutCard(
  sync: DashSync | null, known: boolean,
  heads: WtHead[], liveFor: (path: string) => number, statFor: (path: string) => DiffStat | null | undefined,
): string {
  if (!known) return cardSkeleton(2);
  if (!sync) return "";
  const busy = !!sync.busy;
  const gb = (a: string, label: string, tip: string, cls = "gitb", off = false) =>
    `<button class="${cls}" data-dashact="${a}"${off ? " disabled" : ""}`
    + ` data-tip="${escAttr(tip)}">${label}</button>`;
  // A dropdown, not a door into another dialog: every guard is behind the pick itself.
  const pick = `<button class="brpick" data-dashswitch aria-haspopup="listbox"`
    + ` data-tip="${escAttr(`Switch this checkout to another branch · ${switchSub(sync)}`)}"><span class="g">⑃</span>`
    + `<span class="v mono">${esc(sync.branch || "—")}</span><span class="c">▾</span></button>`;
  // One checkout is not a list; the enlarge only earns its place once there are folders to compare.
  const many = heads.length > 1;
  const rows = many
    ? heads.map((w) => checkoutRow(w, liveFor(w.path), statFor(w.path), w.is_main)).join("")
    : "";
  return `<div class="asec"><div class="asec-h"><span class="label">Checkout</span>
      ${many ? `<span class="tag">${heads.length}</span>
        <button class="xb" data-dashopen-view="checkouts" aria-label="Every checkout" data-tip="Every checkout and every branch, in one table">⤢</button>` : ""}</div>
    ${pick}
    <p class="gsub">${syncLine(sync)}</p>
    <div class="gbts">
      ${gb("pull", sync.busy === "pull" ? "⇣ Pulling…" : "⇣ Pull", pullSub(sync), "gitb", busy)}
      ${gb("push", sync.busy === "push" ? "⇡ Pushing…" : "⇡ Push", pushSub(sync), "gitb", busy)}
    </div>
    ${rows ? `<div class="cos">${rows}</div>` : ""}
    ${gb("cleanup", "⌥ Branches &amp; cleanup…", "merged, orphaned and remote-only branches", "aslink")}</div>`;
}

// ---------- the queue: one ranked list where four cards used to be ----------
// ./queue ranks; this only draws. Every row keeps the attributes the card it came from
// already had, so no probe here is new and the overlays still answer the same clicks.

const QFILTERS: { id: QueueFilter; label: string; tip: string }[] = [
  { id: "all", label: "All", tip: "Everything waiting on this project" },
  { id: "iss", label: "Issues", tip: "Open issues only" },
  { id: "pr", label: "PRs", tip: "Open pull requests only" },
  { id: "deps", label: "Deps", tip: "Advisories, bot pull requests and out-of-date packages" },
  { id: "note", label: "Notes", tip: "Your notes and the ones committed to this repo" },
  { id: "quiet", label: "Quiet", tip: "Issues nothing has happened to in a while — a facet, so these are counted as issues too" },
];

// Which enlargement the ⤢ opens. "triage" has no chip of its own — a suggestion is open work
// carrying a reason — so its own ⤢ rides the rows that have one. "All" is not here: it has no
// board, so `enlarge` below picks one that can hold rows.
const QVIEW: Record<QueueFilter, string> = {
  all: "work", iss: "work", pr: "work", deps: "deps", note: "notes", quiet: "triage",
};

function qrow(cls: string, attrs: string, lead: string, i: QueueItem, right: string, tip = ""): string {
  return `<div class="qrow ${cls}"${attrs} data-tip="${escAttr(tip || i.title)}">${lead}
    <span class="mid"><span class="ti">${esc(i.title)}</span>`
    + (i.sub ? `<span class="sub">${esc(i.sub)}</span>` : "") + `</span>
    <span class="rt">${right}</span></div>`;
}

// The row's SECOND verbs, collapsed until the row is under the pointer. ▶ is never in here:
// it is what the row is for, and a list whose one verb appears only on hover is a list you
// have to hunt across to see what you can do with.
const qacts = (html: string): string => (html ? `<span class="qacts">${html}</span>` : "");

// A claimed row turns its ▶ into a ◍ in the same slot; a name in the row made the column
// ragged. The enlarged view says who and for how long.
function qWorkRow(i: QueueItem): string {
  const t = i.thread!;
  const h = i.held ?? null;
  const go = h
    ? `<button class="go held${h.stale ? " stale" : ""}" data-dashwork="${t.number}"
        data-tip="${escAttr(`${h.who}${h.mine ? " (you)" : ""} ${h.stale ? "claimed a while ago, probably stale" : "is on this"}. Start one anyway?`)}">◍</button>`
    : `<button class="go" data-dashwork="${t.number}" data-tip="Start an agent on this">▶</button>`;
  // The row's own ⤢ reads the thread HERE rather than opening a list of its neighbours; the
  // header's enlarge link is what still opens Still needed? (the Quiet chip picks it).
  const read = `<button class="tb" data-dashissue="${t.number}" data-tip="Read the whole thread here">⤢</button>`;
  const triage = i.triage
    ? `<button class="tb yes" data-dashclose="${t.number}" data-tip="Close it on GitHub, with a comment">✓</button>`
      + `<button class="tb no" data-dashkeep="${t.number}" data-tip="Keep it, so nobody on the team is asked again">✕</button>`
    : "";
  return qrow(`q-work${h ? " claimed" : ""}`, ` data-dashurl="${escAttr(t.url)}"`,
    `<span class="k ${KIND(t)}">${KIND(t)} ${t.number}</span>`, i,
    qacts(`${triage}${read}`) + go);
}

// An advisory's whole row opens GitHub, as the Dependencies card's did. A bot PR cannot: its
// ▶ is nested, and `data-dashdepopen` is probed above everything, so the row would eat it.
function qDepsRow(i: QueueItem): string {
  if (i.advisory) {
    return qrow("q-deps", ` data-dashdepopen="${escAttr(i.advisory.url)}"`,
      `<span class="k adv">adv</span>`, i, `<span class="age">${esc(i.advisory.ghsa)}</span>`,
      `${i.advisory.summary || i.advisory.ghsa} — open it on GitHub`);
  }
  if (i.pr) {
    return qrow("q-deps", "", `<span class="k pr">pr</span>`, i,
      `<span class="age">${esc(shortAge(i.pr.updatedAt))}</span>`
      + qacts(`<button class="tb" data-dashdepopen="${escAttr(i.pr.url)}" data-tip="Open this pull request on GitHub">↗</button>`)
      + `<button class="go" data-dashdeppr="${i.pr.number}" data-tip="Read it, then start an agent on it">▶</button>`);
  }
  // The row opens the table rather than ticking it: the overlay's tick attribute mutates a pick
  // set this card draws no tick for, so the state was invisible and a second click silently undid
  // the first. (Spelling that attribute here would also put it in dispatch.test's emitted set.)
  return qrow("q-deps", ` data-dashopen-view="deps"`, `<span class="k">pkg</span>`, i,
    "", `Open the Dependencies view, where this upgrade is briefed and dispatched`);
}

// A colleague's note is dispatchable but not editable here: this is a read of their file.
function qNoteRow(i: QueueItem): string {
  if (i.shared) {
    return qrow("q-note", "", `<span class="k">note</span>`, i,
      `<button class="nb" data-dashdispatchtext="${escAttr(i.shared.text)}" data-tip="Start an agent on this note">▶</button>`);
  }
  const n = i.note!;
  return qrow("q-note", ` data-dashnote="${escAttr(n.id)}"`, `<span class="k">note</span>`, i,
    `<span class="age">${esc(relTime(n.created))}</span>`
    + qacts(`<button class="nb" data-dashdrop="${escAttr(n.id)}" data-tip="Delete this note">✕</button>`)
    + `<button class="nb" data-dashdispatch="${escAttr(n.id)}" data-tip="Start an agent on this note">▶</button>`);
}

const qRow = (i: QueueItem): string =>
  i.kind === "work" ? qWorkRow(i) : i.kind === "deps" ? qDepsRow(i) : qNoteRow(i);

// The whole row toggles, so the chevron says the state rather than being a second control
// beside it. An open fold keeps its head: that head is how you close it again.
function qFoldRow(f: QueueFold): string {
  const lead = f.items[0].pr ? `<span class="k pr">pr</span>` : `<span class="k">pkg</span>`;
  return `<div class="qrow qfold${f.open ? " open" : ""}" data-dashqfold="${escAttr(f.key)}"
    role="button" aria-expanded="${f.open}"
    data-tip="${escAttr(f.open ? "Fold these back into one row" : `Show all ${f.items.length}`)}">${lead}
    <span class="mid"><span class="ti">${esc(f.title)}</span><span class="sub">${esc(f.sub)}</span></span>
    <span class="rt"><span class="qchev">${f.open ? "⌃" : "⌄"}</span></span></div>`;
}

// One box for an open fold's rows, so the indent and the rule down their left are one rule
// rather than a class every child has to remember to carry.
const drawRow = (r: QueueRow): string =>
  r.kind === "item" ? qRow(r.item)
  : qFoldRow(r.fold) + (r.fold.open ? `<div class="qkids">${r.fold.items.map(qRow).join("")}</div>` : "");

export function queueCard(
  rows: QueueRow[], tally: Record<QueueFilter, number>, filter: QueueFilter, query: string,
  ghKnown: boolean, depKnown: boolean,
): string {
  // A count of nought is not a filter worth arming: the chip stays, greyed, so the list's
  // shape is still readable — "no PRs open" is an answer.
  const chips = QFILTERS.map((c) => {
    const off = c.id !== "all" && !tally[c.id];
    return `<button class="qchip${c.id === filter ? " on" : ""}${c.id === "quiet" ? " facet" : ""}`
      + `${off ? " off" : ""}"${off ? ` aria-disabled="true"` : ""} data-dashqfilter="${c.id}"`
      + ` data-tip="${escAttr(off ? `Nothing here: ${c.tip.toLowerCase()}` : c.tip)}">`
      + `${esc(c.label)} ${tally[c.id]}</button>`;
  }).join("");
  // "All" spans every kind, so its ⤢ opens one that can hold a row: a project with no GitHub
  // has an Open work board that can never fill. A half still in flight keeps its place.
  const enlarge = filter !== "all" ? QVIEW[filter]
    : tally.iss + tally.pr || !ghKnown ? "work"
    : tally.deps || !depKnown ? "deps"
    : "notes";
  // The notes are local and never wait for GitHub, so the half that has answered is drawn
  // and only the half still in flight is a skeleton.
  const waiting = (!ghKnown && filter !== "deps" && filter !== "note")
    || (!depKnown && filter !== "iss" && filter !== "note");
  // Every row, because the column is a scroller with a sticky head and a pinned foot: a cap
  // plus "…and 14 more" made a list that ended in an apology where there was room to read.
  const html = rows.map(drawRow).join("") + (waiting ? cardSkeleton(2) : "");
  // A search that matches nothing says so against the words you typed; the empty queue
  // says the other thing, and the two must not be one sentence.
  const body = html
    || (query
      ? `<div class="ac-empty">Nothing here matches <b>${esc(query)}</b>.</div>`
      : `<div class="ac-empty">Nothing open, nothing out of date, nothing jotted.</div>`);
  // The head stays on screen while the list scrolls under it: the search and the chips are
  // how you get back out of a narrowed list.
  return `<div class="qsec"><div class="qhead"><div class="asec-h"><span class="label">What&#39;s next</span>
      <button class="aslink" data-dashopen-view="${enlarge}"
        data-tip="${escAttr(`Open ${QLABEL[enlarge] ?? "all of it"} in full`)}">${esc(QLABEL[enlarge] ?? "All")} ⤢</button></div>
    <div class="qfind"><input class="qq" id="dashQ" type="search" spellcheck="false" autocomplete="off"
      placeholder="Search what&#39;s next…" aria-label="Search what's next"
      data-tip="Narrow the list: a number, a package, a word in a title" value="${escAttr(query)}" />`
    + (query ? `<button class="qqx" data-dashqclear data-tip="Clear the search">✕</button>` : "")
    + `</div>
    <div class="qchips">${chips}</div></div>
    <div class="qlist">${body}</div></div>`;
}

const QLABEL: Record<string, string> = {
  work: "Open work", deps: "Dependencies", notes: "Notes", triage: "Triage",
};

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

// ---------- the enlarge overlay ----------
// One component, N contents. It covers the dashboard rather than replacing it; Esc steps
// out one layer, as in the commit graph's message overlay.

export function overlayHtml(title: string, sub: string, body: string, foot: string): string {
  return `<div class="ovl-h"><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span>
      <span class="rt"><button class="act" data-dashclose-view data-tip="Close this view (Esc)">✕<span class="txt"> Close</span></button></span></div>
    <div class="ovl-b">${body}</div>
    ${foot ? `<div class="ovl-f">${foot}</div>` : ""}`;
}

// ---------- the selection controls every tick-box table shares ----------
// Four tables tick rows (Branches, Checkouts, Advisories, Out of date). They had three
// different answers to "select everything" in two different places, and shift-click in
// exactly one of them. ./pick owns the rule; these two draw it, and `kind` is what routes
// a click back to the right table.

const PICK_MARK: Record<PickState, string> = { none: "", some: "–", all: "✓" };

/** The tri-state tick in a table header's own tick column: the select-all, where the ticks are. */
export function pickHead(kind: PickKind, st: PickState): string {
  const title = st === "all" ? "Clear every row shown" : "Tick every row shown";
  return `<span class="ck"><span class="brck pk ${st}" role="checkbox" aria-checked="${st === "all"}"
    data-dashpickall="${escAttr(kind)}" title="${escAttr(title)}">${PICK_MARK[st]}</span></span>`;
}

/** The same verbs spelled out, in the action bar where the count and the verb already are. */
export function pickButtons(kind: PickKind): string {
  return `<button class="act" data-dashpickall="${escAttr(kind)}" title="Tick every row shown">All</button>`
    + `<button class="act" data-dashpicknone="${escAttr(kind)}">None</button>`;
}

// ---------- Branches & checkouts ----------
// One overlay, two tabs, one row per thing. The rules are ./branches; this only draws them.
// A branch lives in one row wherever its refs are, and the scope toggles in the action bar
// say where a delete lands — never which rows may be ticked, or a repo whose work all sits
// on the remote would open with every row inert.

export interface CleanReport {
  wts: { label: string; ok: boolean; note: string }[];
  local: SweepResult | null;
  remote: { swept: SweepResult; remote: string } | null;
  summary: string;
}

export interface BranchesView {
  tab: "branches" | "checkouts";
  root: string;     // the project's own folder
  project: string;  // and what the rail calls it; both only so a row can name its menu's target
  rows: BranchRow[];
  checkouts: CheckoutRow[];
  picked: ReadonlySet<string>;
  cpicked: ReadonlySet<string>;
  filter: BranchFilter;
  query: string;
  now: number;
  scopes: { local: boolean; remote: boolean };
  trunk: string;
  remoteName: string;
  protect: ProtectCtx;
  prs: MergedPrs | null;
  prsLoading: boolean;
  busy: boolean;
  loading: boolean;
  result: CleanReport | null;
  // What the header tick shows for each tab; ./pick decides, this only draws it.
  headState: PickState;
  coHeadState: PickState;
}

const brHead = (st: PickState) => `<div class="dbbr-hd">${pickHead("branches", st)}<span>Branch</span><span>Where</span>`
  + `<span>Why it's here</span><span>Vs the trunk</span><span>Author</span>`
  + `<span>Last commit</span><span></span></div>`;

export function branchesOverlay(o: BranchesView): string {
  if (o.result) return overlayHtml("Cleaned up", esc(o.result.summary), cleanResultHtml(o.result), "");
  const tabs = `<div class="bvtabs">`
    + tab("branches", "Branches", o.loading ? "" : String(o.rows.length), o.tab)
    + tab("checkouts", "Checkouts", o.loading ? "" : String(o.checkouts.length), o.tab)
    + `<span class="sp"></span>`
    + (o.tab === "branches"
      ? `<input class="bvq" id="dashBrQ" spellcheck="false" autocomplete="off" placeholder="Filter branches…"`
        + ` aria-label="Filter branches" value="${escAttr(o.query)}" />`
        + `<button class="bk-cmp" data-dashbrtrunk title="Every row is measured against this&#10;Click to compare against another">vs ${esc(o.trunk || "nothing")}</button>`
      : "")
    + `</div>`;
  const body = o.tab === "checkouts" ? checkoutsBody(o) : branchesBody(o);
  return overlayHtml("Branches", subFor(o), tabs + body, "");
}

const subFor = (o: BranchesView) => o.loading ? "reading the repo…"
  : o.tab === "checkouts" ? `${o.checkouts.length} checkout${o.checkouts.length === 1 ? "" : "s"}`
  : `${o.rows.filter((r) => r.hasLocal).length} local · ${o.rows.filter((r) => r.hasRemote).length} on a remote`;

const tab = (id: string, label: string, n: string, on: string) =>
  `<button class="bvtab${id === on ? " on" : ""}" data-dashbrtab="${id}">${label}`
  + (n ? `<span class="n">${esc(n)}</span>` : "") + `</button>`;

function branchesBody(o: BranchesView): string {
  if (o.loading) return brHead("none") + skeletonRows();
  const gh = o.prsLoading ? `<div class="dbbr-note">Reading merged pull requests…</div>`
    : o.prs && !o.prs.available
      ? `<div class="dbbr-note warn">No pull-request data: ${esc(o.prs.reason || "gh unavailable")}. `
        + `A squash-merged branch is contained in nothing, so without this it can't be identified and isn't offered.</div>`
      : "";
  // A file that does not parse protects nothing, and silence would read as "nothing is
  // protected here" — the `prs.available` rule, one list along.
  const lock = o.protect.readable ? "" : `<div class="dbbr-note warn">`
    + `<b>.episko/episko.toml</b> could not be parsed, so no branch here is protected. `
    + `Fix the file and reopen this view.</div>`;
  const counts = filterCounts(o.rows, o.now);
  const chips = `<div class="bvchips">`
    + BRANCH_FILTERS.map((f) => `<button class="bvchip${f.id === o.filter ? " on" : ""}" data-dashbrfilter="${f.id}">`
      + `${esc(f.label)}<span class="n">${counts[f.id]}</span></button>`).join("")
    + `</div>`;
  const shown = orderRows(filterRows(o.rows, o.filter, o.query, o.now));
  const list = shown.length
    ? brHead(o.headState) + shown.map((r) => branchRow(r, o)).join("")
    : `<div class="ac-empty">${o.rows.length ? "No branch matches that." : "No branches here yet."}</div>`;
  return gh + lock + chips + list + actionBar(o);
}

// A row is one branch. The Where cell is the whole reason there is one row and not two: each
// half says whether it exists, whether it may go, and — once ticked — whether it is going.
function branchRow(r: BranchRow, o: BranchesView): string {
  const on = o.picked.has(r.name);
  const off = !anyDeletable(r);
  const b = r.br;
  const tag = r.pr ? `<span class="tag ok" title="${esc(r.pr.title)}">#${r.pr.number} merged</span>`
    : b.gone ? `<span class="tag">gone</span>`
    : b.merged ? `<span class="tag ok">merged</span>`
    : "";
  // The refusal is only worth a column when nothing at all can go; otherwise the Where cell
  // carries it per half, where the answer actually differs.
  // A lock is something someone decided, so it is a tag rather than the warn-coloured
  // refusal every other blocked row carries; the evidence tag still rides beside it.
  const lockTag = r.lock
    ? `<span class="tag lock" title="${esc(lockText(r.lock))} — right-click the row to change it">🔒 protected</span>`
    : "";
  const why = r.lock ? lockTag + tag
    : off
    ? `<span class="warn">${esc(r.local.block || r.remote.block || "nothing says it has landed")}</span>`
    : tag
      + (r.wt ? `<span class="tag" title="Its checkout at ${esc(r.wt.path)} is removed with it">⑃ ${esc(basename(r.wt.path))}/</span>` : "")
      // `-D` rather than "forced": it is the command the row earns, and it is two characters
      // wide beside an evidence tag that already fills the column.
      + (r.local.force ? `<span class="tag warn" title="Its pull request merged, so a squash is why git branch -d refuses it and this one needs -D">-D</span>` : "");
  // The whole row is the target; the box is inside it and carries the same attribute, so
  // `closest` answers the same name whichever half of the row the pointer landed on.
  return `<div class="dbbr${off ? " off" : ""}${on ? " on" : ""}" data-dashbr="${escAttr(r.name)}">
    <span class="ck"><span class="brck${on ? " on" : ""}" role="checkbox"
      aria-checked="${on}" aria-disabled="${off}"
      title="${esc(off ? (r.local.block || r.remote.block) : "Pick this branch")}"></span></span>
    <span class="bn mono" title="${esc(syncText(b))}">${b.current ? "⌂ " : ""}${esc(r.name)}</span>
    <span class="wh">${whereCell(r, o, on)}</span>
    <span class="why">${why}</span>
    <span class="st mono" title="${esc(b.base ? `versus ${b.base}` : "no trunk to compare against")}">${esc(trunkText(b))}</span>
    <span class="au mono">${esc(b.author)}</span>
    <span class="ag mono">${esc(b.rel)}</span>
    <span class="ra"><button class="act" data-dashbrsw="${esc(r.name)}"
      title="Switch ${esc(basename(o.root))}/ — the project's own folder — to ${esc(r.name)}">⇄</button><button class="act"
      data-dashbrmenu="${escAttr(r.name)}" title="Start a session, protect it, more…">⋯</button></span>
  </div>`;
}

function whereCell(r: BranchRow, o: BranchesView, on: boolean): string {
  const half = (label: string, sc: { ok: boolean; block: string }, armed: boolean) => {
    const going = on && armed && sc.ok;
    const title = sc.block || (sc.ok ? (armed ? "this half goes" : "deletable — arm the toggle below") : "");
    return `<span class="hf${sc.ok ? "" : " no"}${going ? " go" : ""}" title="${esc(title)}">${esc(label)}</span>`;
  };
  const out: string[] = [];
  if (r.hasLocal) out.push(half("local", r.local, o.scopes.local));
  if (r.hasRemote) out.push(half(remoteOf(r.br) || "remote", r.remote, o.scopes.remote));
  if (!out.length) out.push(`<span class="hf no" title="its remote branch was deleted">local</span>`);
  return out.join("");
}

// What is ticked, where a delete would land, and what that actually runs. The counts are the
// honest ones: a ticked row whose only half is unarmed contributes nothing and says so.
function actionBar(o: BranchesView): string {
  const nLocal = localPicks(o.rows, o.picked).length;
  const nRemote = remotePicks(o.rows, o.picked).length;
  const picked = o.rows.filter((r) => o.picked.has(r.name)).length;
  const going = (o.scopes.local ? nLocal : 0) + (o.scopes.remote ? nRemote : 0);
  const rows = o.rows.filter((r) => o.picked.has(r.name)
    && ((o.scopes.local && r.local.ok) || (o.scopes.remote && r.remote.ok))).length;
  const what = [
    o.scopes.local ? `${nLocal} local ref${nLocal === 1 ? "" : "s"}` : "nothing locally",
    o.scopes.remote ? `${nRemote} on ${esc(o.remoteName)}` : `nothing on ${esc(o.remoteName)}`,
  ].join(" · ");
  const hint = picked && !going
    ? `<span class="hint">${o.scopes.local && !o.scopes.remote
      ? `nothing ticked lives here — tick <b>on ${esc(o.remoteName)}</b>`
      : "nothing ticked can go where the toggles point"}</span>`
    : "";
  // The note rides INSIDE the bar. Above the table it scrolled out of view exactly when it
  // mattered: the bar is sticky, so a warning about a write everyone sees has to be too.
  const warn = o.scopes.remote
    ? `<div class="note warn"><b>git push ${esc(o.remoteName)} --delete</b> removes the branch for everyone, not just here. `
      + `Only branches already contained in ${esc(o.trunk || "the trunk")}, or whose pull request merged, are offered, `
      + `and each deleted branch's sha comes back so it can be restored.</div>`
    : `<div class="note">Local refs only. Nothing on any remote is touched. Episko runs git's safe `
      + `<b>delete</b>, and what it refuses is kept and listed with git's own words.</div>`;
  return `<div class="bvbar${picked ? " on" : ""}${o.scopes.remote ? " sharing" : ""}">
    <span class="sel">${picked} selected</span>
    <span class="scopes">Delete:
      ${scopeSw("local", "locally", o.scopes.local)}
      ${scopeSw("remote", `on ${o.remoteName}`, o.scopes.remote)}
    </span>${hint}<span class="sp"></span>
    <span class="what">${what}</span>
    ${pickButtons("branches")}
    <button class="brgo" data-dashbrrun${going && !o.busy ? "" : " disabled"}>
      ${o.busy ? "Working…" : rows ? `Delete ${rows} branch${rows === 1 ? "" : "es"}` : "Delete"}</button>
    ${warn}
  </div>`;
}

const scopeSw = (id: string, label: string, on: boolean) =>
  `<button class="bvsw${on ? " on" : ""}" type="button" role="switch" aria-checked="${on}"`
  + ` data-dashbrscope="${id}"><i></i>${esc(label)}</button>`;

// The folder as the rail names it: a worktree lives two levels down a path nobody reads,
// and the whole thing truncated from the left says only which drive it is on.
const twoDeep = (p: string) => p.split(/[/\\]/).filter(Boolean).slice(-2).join("/") + "/";

const coHead = (st: PickState) => `<div class="dbwt-hd">${pickHead("checkouts", st)}<span>Branch</span><span>Folder</span>`
  + `<span>State</span><span>Sessions</span><span></span></div>`;

// The checkouts half: the same table keyed by folder, for the rows a branch cannot carry.
function checkoutsBody(o: BranchesView): string {
  if (o.loading) return coHead("none") + skeletonRows();
  if (!o.checkouts.length) return `<div class="ac-empty">No checkouts here.</div>`;
  const rows = o.checkouts.map((c) => {
    const on = o.cpicked.has(c.wt.path);
    // `data-wt` and its four companions are ./projmenu's contract for the ⑃ cluster menu: the
    // row a checkout has here is the same checkout the rail's header opens a menu on.
    const menu = `data-wt="${escAttr(c.wt.path)}" data-root="${escAttr(o.root)}" `
      + `data-proj="${escAttr(o.project)}" data-branch="${escAttr(c.wt.branch)}"`
      + (c.wt.is_main ? ` data-main="1"` : "");
    return `<div class="dbwt${c.ok ? "" : " off"}${on ? " on" : ""}" data-dashco="${escAttr(c.wt.path)}" ${menu}>
      <span class="ck"><span class="brck${on ? " on" : ""}" role="checkbox"
        aria-checked="${on}" aria-disabled="${!c.ok}"
        title="${esc(c.block || "Pick this checkout")}"></span></span>
      <span class="bn mono">${c.wt.is_main ? "⌂" : "⑃"} ${esc(c.wt.branch || c.label)}</span>
      <span class="pt mono" title="${esc(c.wt.path)}">${esc(twoDeep(c.wt.path))}</span>
      <span class="tags">${c.block ? `<span class="warn">${esc(c.block)}</span>` : `<span class="dim">${esc(c.note)}</span>`}</span>
      <span class="tags">${c.live ? `<span class="tag acc">${c.live} live</span>` : ""}</span>
      <span class="acts"><button class="act" data-dashwtadd="${escAttr(c.wt.path)}" title="New session here">＋</button>
        <button class="act" data-dashwtterm="${escAttr(c.wt.path)}" title="Open a terminal here">❯</button></span>
    </div>`;
  }).join("");
  const n = chosenCheckouts(o.checkouts, o.cpicked).length;
  const bar = `<div class="dbbr-note">Removing a checkout takes its folder and, when the branch is fully `
    + `merged, the branch with it. A folder git records but disk has lost is only unregistered — nothing is lost.</div>`
    + `<div class="bvbar${n ? " on" : ""}"><span class="sel">${n} selected</span>
      <span class="sp"></span>
      ${pickButtons("checkouts")}
      <button class="brgo" data-dashcorun${n && !o.busy ? "" : " disabled"}>
        ${o.busy ? "Working…" : n ? `Remove ${n} checkout${n === 1 ? "" : "s"}` : "Remove"}</button></div>`;
  return coHead(o.coHeadState) + rows + bar;
}

const skeletonRows = () => [72, 54, 63, 48].map((w) =>
  `<div class="dbbr sk"><span></span><span>${sk(`${w}%`, 9)}</span><span>${sk("60%", 8)}</span>`
  + `<span>${sk("70%", 8)}</span><span>${sk("50%", 8)}</span><span>${sk("60%", 8)}</span>`
  + `<span>${sk("40%", 8)}</span><span></span></div>`).join("");

function cleanResultHtml(r: CleanReport): string {
  const line = (n: string, right: string, title = "") =>
    `<div class="dbbr res"${title ? ` title="${esc(title)}"` : ""}><span class="bn mono">${esc(n)}</span>`
    + `<span class="rr mono">${right}</span></div>`;
  const swept = (s: SweepResult, remote: string) => `${s.deleted.length
      ? `<div class="bk"><div class="bk-h"><span class="t">Deleted${remote ? ` on ${esc(remote)}` : ""}</span>
          <span class="n">${remote
            ? `git push ${esc(remote)} &lt;sha&gt;:refs/heads/&lt;name&gt; restores one`
            : `git branch &lt;name&gt; &lt;sha&gt; puts one back`}</span></div>`
        + s.deleted.map((d) => line(d.branch, `<span class="sha">${esc(d.sha)}</span>${d.forced ? ` <span class="warn">forced</span>` : ""}`)).join("")
        + `</div>` : ""}
    ${s.kept.length ? `<div class="bk"><div class="bk-h"><span class="t">Kept${remote ? ` on ${esc(remote)}` : ""}</span></div>`
        + s.kept.map((k) => line(k.branch, `<span class="warn">${esc(k.reason)}</span>`, `${k.branch}: ${k.reason}`)).join("")
        + `</div>` : ""}`;
  return `${r.wts.length ? `<div class="bk"><div class="bk-h"><span class="t">Checkouts</span></div>`
      + r.wts.map((w) => line(`${w.label}/`, w.ok ? `<span class="ok">removed</span>` : `<span class="warn">${esc(w.note)}</span>`)).join("")
      + `</div>` : ""}
    ${r.local ? swept(r.local, "") : ""}
    ${r.remote ? swept(r.remote.swept, r.remote.remote) : ""}
    <div class="dbbr-act">
      ${r.local?.suggest ? `<button class="act" data-dashbrterm>Open a terminal with <b>-D</b> ready</button>` : ""}
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

export function shortAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Date.now() - t) / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  const d = Math.round(m / 1440);
  return d < 14 ? `${d}d` : `${Math.round(d / 7)}w`;
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
    `<span class="lbl" style="--lc:${nameHue(l)}">${esc(l)}</span>`).join("");
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

export function workOverlay(
  groups: { bucket: string; rows: GhThread[] }[], slug: string, total: number,
  holder: (t: GhThread) => Holder | null,
): string {
  if (!total) return overlayHtml("Open work", `${esc(slug)} · nothing open`,
    `<div class="ac-empty">Nothing is open here.</div>`, "");
  const body = `<div class="lst-hd"><span>Kind</span><span class="r">#</span><span>Title</span>
      <span class="r">Age</span><span class="r">Action</span></div>`
    + groups.map((g) => `<div class="bk">
        <div class="bk-h"><span class="t">${esc(BUCKET_LABEL[g.bucket] ?? g.bucket)}</span><span class="n">${g.rows.length}</span></div>
        ${g.rows.map((t) => workBigRow(t, holder(t))).join("")}</div>`).join("");
  return overlayHtml("Open work", `${esc(slug)} · ${total} open`, body,
    `<b>◍</b> is a claim: somebody dispatched an agent at it. It is a hint rather than a lock, so you can always start anyway, and a claim older than 30 minutes reads as stale.`);
}

// ---------- triage ----------

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
