// The thread reader's markup: the queue's ⤢ opened in full, inside the pane. Data in, string
// out, like every other *view module — ./issue owns the rules, ./dashboard owns the fetch and
// the events. See docs/dashboard.md.

import { overlayHtml } from "./dashview";
import { esc, escAttr, nameHue } from "./format";
import type { Holder } from "./ghwork";
import { ago, mdHtml, stateWord, threadLine, type GhIssueRead } from "./issue";

// A thread with three hundred comments is a browser's problem, not a side panel's; the tail
// is one line saying where the rest is.
const SHOWN_COMMENTS = 20;

export interface IssueView {
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

export function issueOverlay(v: IssueView): string {
  const head = `${KIND_WORD(v.kind)} #${v.number}`;
  if (v.loading) {
    return overlayHtml(head, v.slug,
      `<div class="iss"><div class="iss-wait"><span class="u-spin"></span>Reading it from GitHub…</div></div>`, "");
  }
  const i = v.data;
  if (!i || !i.available) {
    // The shape the board's own failure takes: one quiet panel naming the reason and the
    // way out, never an error dialog over a pane you were reading.
    return overlayHtml(head, v.slug,
      `<div class="iss"><div class="ac-empty">${esc(i?.reason || "gh could not be reached")}</div>
        ${i?.url ? `<div class="iss-b"><button class="act" data-dashurl="${escAttr(i.url)}"
          data-tip="Open it on github.com in your browser">↗ Open it on GitHub</button></div>` : ""}</div>`,
      "");
  }
  const rest = i.comments.length - SHOWN_COMMENTS;
  const body = `<div class="iss">
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
  // The head says which thread; the line under the title says everything else about it,
  // and saying it twice on one screen is how the two start disagreeing.
  return overlayHtml(head, v.slug, body,
    `Read here, acted on here — but nothing is written to GitHub from this panel. <b>▶</b> opens the same sheet the queue does, which shows exactly what a claim would post before it posts it.`);
}
