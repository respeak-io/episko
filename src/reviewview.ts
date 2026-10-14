// The pull-request review's markup: data in, string out. ./review owns the rules, ./reviewui the
// stage, its reads and its clicks; the diff itself is ./patchview's, shared with the working-set
// viewer. Every attribute here is `data-rv*` and is probed by ./reviewui's one listener
// (test/dispatch.test.ts holds the two together).

import { esc, escAttr } from "./format";
import { ago, mdHtml } from "./issue";
import {
  checkTally, decisionWord, openThreads, sortChecks, timeline,
  type CheckTally, type DraftComment, type PrCheck, type PrReview, type PrThread, type Side,
} from "./review";
import type { DiffMode } from "./diff";
import { icon } from "./svgicons";

export type RvTab = "files" | "conversation" | "checks";

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const short = (oid: string) => oid.slice(0, 7);

function stateChip(pr: PrReview): string {
  const k = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open";
  return `<span class="rv-st ${k}">${k}</span>`;
}

export function checksChip(t: CheckTally): string {
  if (!t.total) return "";
  const tone = t.fail ? "bad" : t.pending ? "wait" : "ok";
  const word = t.fail ? `${t.fail} failing` : t.pending ? `${t.pending} running` : "checks pass";
  return `<button class="rv-chip ${tone}" data-rvtab="checks" title="${t.pass} passed · ${t.fail} failed · ${t.pending} running · ${t.skip} skipped">${tone === "ok" ? "✓" : tone === "bad" ? "✕" : "◌"} ${word}</button>`;
}

/** The title block and the verbs that act on the whole pull request. */
export function reviewHeadHtml(pr: PrReview, now: number, busy: string | null): string {
  const d = decisionWord(pr);
  const open = openThreads(pr);
  const conflict = pr.mergeable === "CONFLICTING" ? `<span class="rv-chip bad" title="Resolve the conflicts before it can merge">conflicts</span>` : "";
  const live = pr.state === "OPEN";
  const btn = (act: string, label: string, tip: string, cls = "act") =>
    `<button class="${cls}" data-rvact="${act}" title="${escAttr(tip)}"${busy ? " disabled" : ""}>${label}</button>`;
  return `<div class="rv-h1">${stateChip(pr)}<h2>${esc(pr.title)} <span class="rv-num">#${pr.number}</span></h2>
      <div class="rv-verbs">
        ${busy ? `<span class="rv-busy"><span class="u-spin"></span>${esc(busy)}</span>` : ""}
        ${btn("refresh", icon("refresh", "solo"), "Read it from GitHub again", "act icon")}
        <button class="act" data-rvurl="${escAttr(pr.url)}" title="Open it on github.com">${icon("external")}GitHub</button>
        ${btn("session", `${icon("terminal")}Session`, `Start a session on ${pr.head_ref}, in its own worktree`)}
        ${live ? btn(pr.draft ? "ready" : "draft", pr.draft ? `${icon("ready")}Ready for review` : `${icon("draft")}To draft`,
          pr.draft ? "Mark it ready for review" : "Convert it back to a draft") : ""}
        ${live ? btn("merge", `${icon("merge")}Merge ▾`, "Merge it on GitHub", "act primary") : ""}
      </div></div>
    <div class="rv-h2">
      <span class="rv-who">${esc(pr.author || "someone")}</span> wants to merge ${plural(pr.commits.length, "commit")} into
      <span class="chip mono">${esc(pr.base_ref)}</span> from <span class="chip mono">${esc(pr.head_ref)}</span>
      ${pr.same_repo ? "" : `<span class="rv-chip" title="The branch lives in a fork">fork</span>`}
      <span class="dim">· opened ${esc(ago(pr.created_at, now))}</span>
      ${checksChip(checkTally(pr.checks))}
      ${d.text ? `<span class="rv-chip ${d.tone}">${esc(d.text)}</span>` : ""}
      ${open ? `<span class="rv-chip wait" title="Review threads nobody has resolved">${plural(open, "open thread")}</span>` : ""}
      ${conflict}
    </div>`;
}

export interface BarModel {
  tab: RvTab; pr: PrReview;
  rangeLabel: string; since: { oid: string; n: number | null } | null; showingSince: boolean;
  ws: boolean; mode: DiffMode; allOpen: boolean;
  files: number; add: number; del: number; viewed: number; truncated: boolean;
}

/** The tabs, and on Files the controls over which diff and how it is drawn. */
export function reviewBarHtml(m: BarModel): string {
  const tab = (t: RvTab, label: string, n: number | string) =>
    `<button class="gseg-b${m.tab === t ? " on" : ""}" data-rvtab="${t}">${icon(t === "files" ? "files" : t === "conversation" ? "comment" : "checks")}${label}${n !== "" ? ` <span class="n">${n}</span>` : ""}</button>`;
  const tabs = `<div class="gseg rv-tabs">${tab("files", "Files", m.files)}${tab("conversation", "Conversation", m.pr.comments.length + m.pr.reviews.filter((r) => r.body.trim()).length)}${tab("checks", "Checks", m.pr.checks.length || "")}</div>`;
  if (m.tab !== "files") return tabs;
  const since = m.since && !m.showingSince
    ? `<button class="rv-since" data-rvsince title="Only what changed after the head your last review saw (${short(m.since.oid)})">${icon("since")}${m.since.n === null
      ? "The branch was rewritten since your review" : `${plural(m.since.n, "new commit")} since your review`} · show</button>`
    : "";
  return `${tabs}
    <button class="diff-fold rv-range" data-rvrange title="Which changes to show: the whole pull request, one commit, or what is new since your review">${icon(m.showingSince ? "since" : m.rangeLabel.startsWith("Commit") ? "commit" : "files")}${esc(m.rangeLabel)} ▾</button>
    ${since}
    <span class="rv-sum"><span class="add">+${m.add}</span> <span class="del">−${m.del}</span> · ${m.viewed}/${m.files} viewed</span>
    <span class="rv-sp"></span>
    <button class="diff-fold${m.ws ? " on" : ""}" data-rvws title="Hide changes that only move whitespace">${icon("pilcrow")}${m.ws ? "whitespace hidden" : "hide whitespace"}</button>
    <button class="diff-fold" data-rvmode>${m.mode === "split" ? `${icon("unified")}unified` : `${icon("split")}side by side`}</button>
    <button class="diff-fold" data-rvfold>${m.allOpen ? `${icon("fold")}collapse all` : `${icon("unfold")}expand all`}</button>`;
}

// ---------- the line-level pieces ----------

/** Where a line sits in the selected range: its ends carry the `+`, the lines between a rail joining them. */
export type RangePos = "" | "one" | "first" | "mid" | "last";
export function rangePos(n: number, lo: number, hi: number): RangePos {
  if (n < lo || n > hi) return "";
  return lo === hi ? "one" : n === lo ? "first" : n === hi ? "last" : "mid";
}

export const addBtn = (fi: number, side: Side, line: number, pos: RangePos) =>
  `<button class="rv-add${pos ? ` on ${pos}` : ""}" data-rvadd="${fi}:${side}:${line}" title="Comment on this line · drag, or shift-click another, to take a range">+</button>`;

function commentHtml(who: string, at: string, body: string, now: number, url = ""): string {
  const md = body.trim() ? mdHtml(body) : `<p class="iss-none">No text.</p>`;
  return `<div class="rv-c"><div class="rv-ch"><span class="who">${esc(who || "someone")}</span>
    <span class="when">${esc(ago(at, now))}</span>${url ? `<button class="aslink" data-rvurl="${escAttr(url)}" title="Open this comment on github.com">↗</button>` : ""}</div>
    <div class="md">${md}</div></div>`;
}

function where(t: PrThread): string {
  if (t.subject === "FILE") return "on the file";
  const n = t.line ?? t.original_line;
  const s = t.start_line ?? t.original_start_line;
  const lines = n ? (s && s !== n ? `lines ${s}–${n}` : `line ${n}`) : "";
  return `${lines}${t.side === "LEFT" ? " (removed)" : ""}`;
}

export interface ThreadOpts { now: number; loose: boolean; open: boolean; reply: string; busy: boolean; showPath: boolean }

/** A review thread: the conversation, a reply box, and resolve. A resolved one opens folded. */
export function threadHtml(t: PrThread, o: ThreadOpts): string {
  const id = escAttr(t.id);
  const first = t.comments[0];
  const tags = (t.resolved ? `<span class="rv-tag ok">resolved</span>` : "")
    + (t.outdated ? `<span class="rv-tag">outdated</span>` : "");
  const loc = `<span class="rv-loc">${o.showPath ? `${esc(t.path)} · ` : ""}${esc(where(t))}</span>`;
  const head = `<div class="rv-th-h" data-rvthfold="${id}"><span class="dchev">▾</span>${tags}${loc}
      ${o.open ? "" : `<span class="rv-gist">${esc(first?.author ?? "")}: ${esc((first?.body ?? "").split("\n")[0].slice(0, 120))}</span>`}
      <span class="rv-sp"></span>
      <button class="rv-mini" data-rvthagent="${id}" title="Hand this thread to an agent on the PR's branch">${icon("agent")}agent</button>
      <button class="rv-mini" data-rvresolve="${id}" title="${t.resolved ? "Open it again" : "Mark the conversation resolved"}"${o.busy ? " disabled" : ""}>${t.resolved ? `${icon("reopen")}Unresolve` : `${icon("ready")}Resolve`}</button></div>`;
  if (!o.open) return `<div class="rv-thread folded${t.resolved ? " resolved" : ""}" data-rvt="${id}">${head}</div>`;
  const last = t.comments[t.comments.length - 1];
  return `<div class="rv-thread${t.resolved ? " resolved" : ""}${t.outdated ? " outdated" : ""}" data-rvt="${id}">${head}
    ${o.loose && first?.diff_hunk ? `<pre class="rv-hunk">${esc(first.diff_hunk.split("\n").slice(-4).join("\n"))}</pre>` : ""}
    ${t.comments.map((c) => commentHtml(c.author, c.at, c.body, o.now, c.url)).join("")}
    ${last ? `<div class="rv-reply"><textarea data-rvreplytext="${id}" rows="1" placeholder="Reply…" spellcheck="true">${esc(o.reply)}</textarea>
      <button class="diff-go" data-rvreply="${id}" title="Reply to this thread"${o.busy ? " disabled" : ""}>Reply</button></div>` : ""}
  </div>`;
}

/** A comment of yours that is part of the pending review: sent with it, editable until then. */
export function draftHtml(d: DraftComment, showWhere: boolean): string {
  const lines = d.line ? (d.start && d.start !== d.line ? `lines ${Math.min(d.start, d.line)}–${Math.max(d.start, d.line)}` : `line ${d.line}`) : "the file";
  return `<div class="rv-draft" data-rvd="${escAttr(d.id)}"><div class="rv-ch"><span class="rv-tag wait">pending</span>
      ${showWhere ? `<span class="rv-loc">${esc(lines)}${d.side === "LEFT" ? " (removed)" : ""}</span>` : ""}
      <span class="rv-sp"></span>
      <button class="rv-mini" data-rvdedit="${escAttr(d.id)}">${icon("pencil")}Edit</button>
      <button class="rv-mini danger" data-rvddel="${escAttr(d.id)}">${icon("trash")}Delete</button></div>
    <div class="md">${mdHtml(d.body)}</div></div>`;
}

export interface ComposeModel {
  side: Side | null; line: number | null; start: number | null;
  text: string; preview: boolean; editing: boolean; canSuggest: boolean;
}

/** The one comment being written. Its textarea is the only `#rvCompText`; ./reviewui keeps its text. */
export function composeHtml(c: ComposeModel): string {
  const lo = c.start && c.line ? Math.min(c.start, c.line) : c.line;
  const what = !c.line ? "Comment on this file" : lo !== c.line ? `Comment on lines ${lo}–${c.line}` : `Comment on line ${c.line}`;
  const tab = (p: boolean, label: string) => `<button class="gseg-b${c.preview === p ? " on" : ""}" data-rvpreview="${p ? "1" : "0"}">${label}</button>`;
  return `<div class="rv-compose"><div class="rv-ch"><b>${what}${c.side === "LEFT" ? " (removed)" : ""}</b>
      <span class="rv-sp"></span><div class="gseg">${tab(false, `${icon("pencil")}Write`)}${tab(true, `${icon("eye")}Preview`)}</div></div>
    ${c.preview
      ? `<div class="md rv-prev">${c.text.trim() ? mdHtml(c.text) : `<p class="iss-none">Nothing to preview.</p>`}</div>`
      : `<textarea id="rvCompText" rows="3" placeholder="Leave a comment · markdown · ⌘↵ adds it to your review" spellcheck="true">${esc(c.text)}</textarea>`}
    <div class="rv-cb">
      ${c.canSuggest ? `<button class="rv-mini" data-rvsuggest title="Propose the replacement text inline, as GitHub's suggestion block">${icon("suggest")}Suggest a change</button>` : ""}
      <span class="rv-sp"></span>
      <button class="diff-fold" data-rvcancel>Cancel</button>
      <button class="diff-go" data-rvsave>${icon("comment")}${c.editing ? "Update comment" : "Add to review"}</button></div></div>`;
}

/** A file header's own controls: its open threads, a comment on the whole file, and Viewed. */
export function fileBtnsHtml(fi: number, viewed: boolean, threads: number, canFile: boolean): string {
  return `<span class="dfx rv-fx">${threads ? `<span class="rv-tc" title="${plural(threads, "open thread")}">${threads}</span>` : ""}`
    + (canFile ? `<button data-rvfilec="${fi}" title="Comment on the whole file">${icon("comment", "solo")}</button>` : "")
    + `<button class="rv-viewed${viewed ? " on" : ""}" data-rvviewed="${fi}" title="Fold it away until it changes again">${icon(viewed ? "boxCheck" : "box")}Viewed</button></span>`;
}

export const railMark = (viewed: boolean, threads: number) =>
  (threads ? `<span class="rv-tc">${threads}</span>` : "") + (viewed ? `<span class="rv-vw" title="Viewed">✓</span>` : "");

export const expandBtn = (fi: number, hi: number, gap: number) =>
  `<button class="dhx rv-exp" data-rvexp="${fi}:${hi}" title="Show ${Math.min(gap, 20)} more unchanged lines">${icon("unfold")}${Math.min(gap, 20)} more</button>`;

export const tailBtn = (fi: number, hi: number) =>
  `<div class="rv-tailx"><button class="dhx rv-exp" data-rvexp="${fi}:${hi}" title="Show the unchanged lines after the last change">${icon("down")}more</button></div>`;

/** Threads on files the current view leaves out: still open business, so still on screen. */
export function elsewhereHtml(items: string[]): string {
  if (!items.length) return "";
  return `<section class="rv-else"><div class="rv-else-h">${plural(items.length, "thread")} on files this view does not show</div>${items.join("")}</section>`;
}

// ---------- the other two tabs ----------

export function conversationHtml(pr: PrReview, now: number, text: string, busy: boolean): string {
  const items = timeline(pr).map((it) => {
    if (it.kind === "commit") {
      return `<div class="rv-tl commit"><span class="mono dim">${short(it.oid)}</span> ${esc(it.headline)} <span class="dim">· ${esc(it.who)} · ${esc(ago(it.at, now))}</span></div>`;
    }
    if (it.kind === "review") {
      const word = it.state === "APPROVED" ? "approved" : it.state === "CHANGES_REQUESTED" ? "requested changes" : it.state === "DISMISSED" ? "review dismissed" : "reviewed";
      const tone = it.state === "APPROVED" ? "ok" : it.state === "CHANGES_REQUESTED" ? "bad" : "";
      const head = `<div class="rv-tl review"><span class="rv-tag ${tone}">${word}</span> <b>${esc(it.who)}</b> <span class="dim">${esc(ago(it.at, now))}</span></div>`;
      return it.body.trim() ? head + `<div class="rv-c"><div class="md">${mdHtml(it.body)}</div></div>` : head;
    }
    return commentHtml(it.who, it.at, it.body, now);
  }).join("");
  return `<div class="rv-conv">
    ${commentHtml(pr.author || "", pr.created_at, pr.body, now)}
    ${items}
    <div class="rv-reply conv"><textarea id="rvConvText" rows="3" placeholder="Add to the conversation · markdown" spellcheck="true">${esc(text)}</textarea>
      <button class="diff-go" data-rvconv${busy ? " disabled" : ""}>${icon("comment")}Comment</button></div></div>`;
}

const CHECK_GLYPH: Record<string, string> = { pass: "✓", fail: "✕", pending: "◌", skip: "–", neutral: "–" };

export function checksHtml(checks: PrCheck[]): string {
  if (!checks.length) return `<div class="diff-empty">No checks ran on the head commit.</div>`;
  return `<div class="rv-checks">${sortChecks(checks).map((c) => `<div class="rv-ck ${esc(c.state)}">
      <span class="g">${CHECK_GLYPH[c.state] ?? "–"}</span><span class="nm">${esc(c.name)}</span>
      ${c.workflow ? `<span class="dim">${esc(c.workflow)}</span>` : ""}<span class="rv-sp"></span>
      ${c.url ? `<button class="aslink" data-rvurl="${escAttr(c.url)}" title="Open the run's log">details ↗</button>` : ""}</div>`).join("")}</div>`;
}

export function failHtml(reason: string, url: string): string {
  return `<div class="diff-empty">${esc(reason)}${url ? `<br><button class="aslink" data-rvurl="${escAttr(url)}">Open it on GitHub ↗</button>` : ""}</div>`;
}
