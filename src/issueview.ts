// The thread reader's markup: the list it was opened from on the left, the thread on the right.
// Data in, string out, like every other *view module — ./issue owns the rules, ./dashboard owns
// the fetch and the events. See docs/dashboard.md.

import { overlayHtml } from "./dashview";
import { esc, escAttr, nameHue } from "./format";
import type { GhThread, Holder } from "./ghwork";
import { ago, mdHtml, stateWord, threadLine, type GhIssueRead } from "./issue";

// A thread with three hundred comments is a browser's problem, not a side panel's; the tail
// is one line saying where the rest is.
const SHOWN_COMMENTS = 20;

export type RailFrom = "queue" | "work" | "triage";

export interface RailRow { t: GhThread; held: Holder | null; why?: string; triage?: boolean }

export interface IssueView {
  rail: { from: RailFrom; rows: RailRow[]; open: boolean };
  number: number;
  kind: string;
  slug: string;
  data: GhIssueRead | null;
  loading: boolean;
  held: Holder | null;
  now: number;
}

const KIND_WORD = (k: string): string => (k === "pr" ? "Pull request" : "Issue");

const labels = (names: string[]): string =>
  names.map((l) => `<span class="lbl" style="--lc:${nameHue(l)}">${esc(l)}</span>`).join("");

// The two verbs the row already had, at the size the decision is: start an agent on it (the
// same sheet, so a claim is still shown before it is written) and open it on GitHub.
function verbs(i: GhIssueRead, held: Holder | null): string {
  const go = held
    ? `▶ Start anyway${held.mine ? "" : ` · ${esc(held.who)} is on it`}`
    : i.kind === "pr" ? "▶ Review it" : "▶ Start an agent";
  const tip = held
    ? `${held.who}${held.mine ? " (you)" : ""} already has this. A claim is a hint, so you can start anyway.`
    : "Start an agent on this, through the sheet that shows what would be claimed";
  return `<div class="iss-b">
    <button class="act primary" data-dashwork="${i.number}" data-tip="${escAttr(tip)}">${go}</button>
    ${i.url ? `<button class="act" data-dashurl="${escAttr(i.url)}"
      data-tip="Open it on github.com in your browser">↗ On GitHub</button>` : ""}</div>`;
}

function comment(who: string, when: string, body: string, mark: string): string {
  // An empty body is said in our own voice, never rendered as if somebody typed it.
  const md = body.trim() ? mdHtml(body) : `<p class="iss-none">No description.</p>`;
  return `<div class="iss-c${mark}"><div class="iss-ch"><span class="who">${esc(who || "someone")}</span>
      <span class="when">${esc(when)}</span></div>
    <div class="md">${md}</div></div>`;
}

const RAIL_LABEL: Record<RailFrom, string> = { queue: "What's next", work: "Open work", triage: "Still needed?" };
const KIND = (t: GhThread): string => (t.kind === "pr" ? "pr" : "iss");

// One row per thread, the same facts the list it came from showed, at rail width. Only a quiet
// issue carries verbs here: deciding a backlog is the one job worth doing without leaving.
function railRow(r: RailRow, at: number): string {
  const { t, held } = r;
  const claim = held ? `<span class="clm${held.mine ? " mine" : ""}${held.stale ? " stale" : ""}">◍ ${esc(held.mine ? "you" : held.who)}</span>` : "";
  const sub = r.why ? `<span class="w">${esc(r.why)}</span>` : "";
  const acts = r.triage
    ? `<span class="rr-b"><button class="tb yes" data-dashclose="${t.number}" data-tip="Close it on GitHub, with a comment">✓</button>`
      + `<button class="tb no" data-dashkeep="${t.number}" data-tip="Keep it, so nobody on the team is asked again">✕</button></span>`
    : "";
  return `<div class="rr${t.number === at ? " on" : ""}" data-dashissue="${t.number}">
    <span class="k ${KIND(t)}">${KIND(t)} ${t.number}</span>${acts}
    <span class="ti">${esc(t.title)}</span>
    ${claim || sub ? `<span class="rr-s">${claim}${sub}</span>` : ""}</div>`;
}

function rail(v: IssueView): string {
  const { from, rows } = v.rail;
  // The full table is still one click away, with the filters it had; the queue has none.
  const table = from === "queue" ? ""
    : `<button class="aslink" data-dashopen-view="${from}" data-tip="Back to the full table">⤢ Table</button>`;
  return `<aside class="rd-rail" data-keep-scroll="rail">
    <div class="rd-rh"><span class="t">${esc(RAIL_LABEL[from])}</span><span class="n">${rows.length}</span>${table}</div>
    ${rows.length ? rows.map((r) => railRow(r, v.number)).join("")
      : `<div class="ac-empty">Nothing else is listed here.</div>`}
    <div class="rd-hint">↑ ↓ to move between threads</div></aside>`;
}

function reader(v: IssueView): string {
  const toggle = `<button class="act rd-tog" data-dashrail data-tip="Show the list">☰ ${esc(RAIL_LABEL[v.rail.from])}</button>`;
  if (v.loading) {
    return `<div class="iss">${toggle}<div class="iss-wait"><span class="u-spin"></span>Reading it from GitHub…</div></div>`;
  }
  const i = v.data;
  if (!i || !i.available) {
    // The shape the board's own failure takes: one quiet panel naming the reason and the
    // way out, never an error dialog over a pane you were reading.
    return `<div class="iss">${toggle}<div class="ac-empty">${esc(i?.reason || "gh could not be reached")}</div>
        ${i?.url ? `<div class="iss-b"><button class="act" data-dashurl="${escAttr(i.url)}"
          data-tip="Open it on github.com in your browser">↗ Open it on GitHub</button></div>` : ""}</div>`;
  }
  const rest = i.comments.length - SHOWN_COMMENTS;
  return `<div class="iss">${toggle}
    <div class="iss-t"><span class="st ${esc(stateWord(i))}">${esc(stateWord(i))}</span>
      <h3>${esc(i.title)}</h3></div>
    <div class="iss-line">${esc(threadLine(i, v.now))}</div>
    ${i.labels.length ? `<div class="iss-lbl">${labels(i.labels)}</div>` : ""}
    ${verbs(i, v.held)}
    ${comment(i.author || "", ago(i.created_at, v.now), i.body, " own")}
    ${i.comments.slice(0, SHOWN_COMMENTS).map((c) => comment(c.who, ago(c.at, v.now), c.body, "")).join("")}
    ${rest > 0
      ? `<div class="iss-more">…and ${rest} more comment${rest === 1 ? "" : "s"}
          <button class="aslink" data-dashurl="${escAttr(i.url)}"
            data-tip="Open the whole thread on github.com">Read the rest on GitHub ↗</button></div>`
      : ""}</div>`;
}

// The rail is on the RIGHT, where the queue is: opened from the queue, the reader covers the
// other two columns and the queue itself is the list, so no list ever jumps across the pane.
// The reader's scroll is keyed by thread, so the next one starts at its top.
export function issueOverlay(v: IssueView): string {
  return overlayHtml(`${KIND_WORD(v.kind)} #${v.number}`, v.slug,
    `<div class="rd${v.rail.open ? " rail-open" : ""}">
      <div class="rd-main" data-keep-scroll="main-${v.number}">${reader(v)}</div>${rail(v)}</div>`,
    `Read here, acted on here — but nothing is written to GitHub from this panel. <b>▶</b> opens the same sheet the queue does, which shows exactly what a claim would post before it posts it.`);
}
