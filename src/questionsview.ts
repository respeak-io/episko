// The Questions sheet's markup: every question in a conversation with the agent's closing
// answer beside it, oldest first, for when the REPL has compacted the scrollback away.
// Data in, string out; ./questions owns #qDlg and hands in the rendered answers.

import { esc, escAttr } from "./format";
import { joinPath, renderMarkdown } from "./markdown";
import { outlineItems, promptLabel } from "./outline";
import { promptHtml, relayIcon } from "./inspectorview";
import { icon } from "./svgicons";
import type { Prompt } from "./types";

const clock = (at: number) => at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export interface QEntry { p: Prompt; n: number } // n is 0 for a relay or a compaction, neither yours to number

/** Every row, oldest first: relays stay in line, unfolded, since the sheet has the room. */
export function qEntries(prompts: readonly Prompt[]): QEntry[] {
  return outlineItems(prompts).flatMap((it) =>
    it.kind === "ask" ? [{ p: it.p, n: it.n }] : it.kind === "relays" ? it.ps.map((p) => ({ p, n: 0 })) : [{ p: it.p, n: 0 }]);
}

export function qSubText(entries: readonly QEntry[]): string {
  const asks = entries.filter((e) => e.n);
  const answered = asks.filter((e) => e.p.answer).length;
  return asks.length ? `${asks.length} asked · ${answered} answered` : "";
}

export function qIndexHtml(entries: readonly QEntry[], sel: string | null): string {
  return entries.map(({ p, n }) => p.compact
    ? `<button class="q-row cmp${p.id === sel ? " on" : ""}" type="button" data-qsel="${escAttr(p.id)}" title="Claude summarised the conversation up to here">`
      + `<span class="q-rn">${icon("chevronsDownUp")}</span><span class="q-rt">Context compacted</span><span class="q-rc"></span></button>`
    : `<button class="q-row${p.relay ? " relay" : ""}${p.id === sel ? " on" : ""}" type="button" data-qsel="${escAttr(p.id)}" title="${escAttr(promptLabel(p.text))}">`
    + `<span class="q-rn">${n || relayIcon(p.relay?.kind ?? "")}</span>`
    + `<span class="q-rt">${esc(promptLabel(p.text))}</span>`
    + `<span class="q-rc">${p.answer ? "" : "·"}</span></button>`).join("");
}

// Why there is no answer, in the one case that is not a gap: the turn is still running.
function noAnswer(running: boolean, last: boolean): string {
  if (last && running) return `<div class="q-none run">Working on it…</div>`;
  return `<div class="q-none">No closing answer was recorded for this one.</div>`;
}

/** An answer as prose: links resolve against the session's folder, and nothing is fetched. */
export const answerMd = (workdir: string, text: string): string =>
  renderMarkdown(text, { docPath: joinPath(workdir, "answer.md"), root: workdir, images: false, remote: false }).html;

/** Markdown rendered by the caller, which caches it: `key` is the prompt's id, plus `#s` for a summary. */
export type QMd = (key: string, text: string) => string;

const copyBtn = (p: Prompt, what: string) =>
  `<button class="q-act" type="button" data-qcopy="${escAttr(p.id)}" title="Copy ${what}">Copy</button>`;

// A compaction is a band between questions, its summary folded: a reader wants to know it
// happened and where, and only sometimes what Claude kept of everything above it.
function compactHtml(p: Prompt, md: QMd, back: string): string {
  const head = `<div class="q-h"><span class="q-cw">${icon("chevronsDownUp")}Context compacted</span>`
    + `<span class="q-t">${back}${clock(p.at)}</span>${p.text ? copyBtn(p, "the summary") : ""}</div>`;
  const sum = p.text
    ? `<details class="q-cmp" data-qcmp="${escAttr(p.id)}"><summary>${icon("chevronRight")}The summary Claude carried on from</summary>`
      + `<div class="q-cmpb mdr">${md(`${p.id}#s`, p.text)}</div></details>`
    : "";
  const ans = p.answer ? `<div class="q-ans mdr">${md(p.id, p.answer)}</div>` : "";
  return `<section class="q-ent cmp" data-qent="${escAttr(p.id)}">${head}${sum}${ans}</section>`;
}

/** `live`: a pane holds the conversation, so a question can be found in it and the restored mark means something. */
export function qThreadHtml(entries: readonly QEntry[], md: QMd, at: { running: boolean; live: boolean }): string {
  if (!entries.length) return `<div class="call-empty">Nothing asked yet.</div>`;
  return entries.map(({ p, n }, i) => {
    const back = at.live && p.restored ? `<span class="q-b" title="From before this pane was resumed">${icon("history", "solo")}</span>` : "";
    if (p.compact) return compactHtml(p, md, back);
    const r = p.relay;
    const who = r ? `<span class="q-who">${relayIcon(r.kind)} ${esc(r.name)} · ${r.report ? "report" : "message"}</span>` : `<span class="q-n">#${n}</span>`;
    const find = at.live ? `<button class="q-act" type="button" data-qjump="${escAttr(p.id)}" title="Close this and find the question in the terminal">Find in terminal</button>` : "";
    const head = `<div class="q-h">${who}<span class="q-t">${back}${clock(p.at)}</span>${find}${copyBtn(p, "the question and its answer")}</div>`;
    const ans = p.answer ? `<div class="q-ans mdr">${md(p.id, p.answer)}</div>` : noAnswer(at.running, i === entries.length - 1);
    return `<section class="q-ent${r ? " relay" : ""}" data-qent="${escAttr(p.id)}">${head}<div class="q-ask">${promptHtml(p.text, p.id)}</div>${ans}</section>`;
  }).join("");
}

export const copiedWhat = (entries: readonly QEntry[]) => entries[0]?.p.compact ? "Summary copied" : "Question and answer copied";

/** What Copy puts on the clipboard: plain markdown, for pasting into a session or a note. */
export function qClipText(entries: readonly QEntry[]): string {
  // A compaction's own Copy is for its summary; Copy all keeps to the questions and marks the spot.
  const one = entries.length === 1;
  return entries.map(({ p, n }) => {
    if (p.compact) {
      const head = one ? `## Context compacted\n\n${p.text}` : "_Context compacted here._";
      return p.answer ? `${head}\n\n**Answer**\n\n${p.answer}` : head;
    }
    const head = p.relay ? `## From ${p.relay.name}` : `## ${n}. You asked`;
    return `${head}\n\n${p.text}\n\n${p.answer ? `**Answer**\n\n${p.answer}` : "_(no answer recorded)_"}`;
  }).join("\n\n---\n\n");
}
