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

export interface QEntry { p: Prompt; n: number } // n is 0 for a relay, which is not yours to number

/** Every row, oldest first: relays stay in line, unfolded, since the sheet has the room. */
export function qEntries(prompts: readonly Prompt[]): QEntry[] {
  return outlineItems(prompts).flatMap((it) =>
    it.kind === "ask" ? [{ p: it.p, n: it.n }] : it.kind === "relay" ? [{ p: it.p, n: 0 }] : it.ps.map((p) => ({ p, n: 0 })));
}

export function qSubText(entries: readonly QEntry[]): string {
  const asks = entries.filter((e) => e.n);
  const answered = asks.filter((e) => e.p.answer).length;
  return asks.length ? `${asks.length} asked · ${answered} answered` : "";
}

export function qIndexHtml(entries: readonly QEntry[], sel: string | null): string {
  return entries.map(({ p, n }) =>
    `<button class="q-row${p.relay ? " relay" : ""}${p.id === sel ? " on" : ""}" type="button" data-qsel="${escAttr(p.id)}" title="${escAttr(promptLabel(p.text))}">`
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

/** `live`: a pane holds the conversation, so a question can be found in it and the restored mark means something. */
export function qThreadHtml(entries: readonly QEntry[], answerHtml: (p: Prompt) => string, at: { running: boolean; live: boolean }): string {
  if (!entries.length) return `<div class="call-empty">Nothing asked yet.</div>`;
  return entries.map(({ p, n }, i) => {
    const r = p.relay;
    const who = r ? `<span class="q-who">${relayIcon(r.kind)} ${esc(r.name)} · ${r.report ? "report" : "message"}</span>` : `<span class="q-n">#${n}</span>`;
    const back = at.live && p.restored ? `<span class="q-b" title="From before this pane was resumed">${icon("history", "solo")}</span>` : "";
    const find = at.live ? `<button class="q-act" type="button" data-qjump="${escAttr(p.id)}" title="Close this and find the question in the terminal">Find in terminal</button>` : "";
    const head = `<div class="q-h">${who}<span class="q-t">${back}${clock(p.at)}</span>${find}`
      + `<button class="q-act" type="button" data-qcopy="${escAttr(p.id)}" title="Copy the question and its answer">Copy</button></div>`;
    const ans = p.answer ? `<div class="q-ans mdr">${answerHtml(p)}</div>` : noAnswer(at.running, i === entries.length - 1);
    return `<section class="q-ent${r ? " relay" : ""}" data-qent="${escAttr(p.id)}">${head}<div class="q-ask">${promptHtml(p.text, p.id)}</div>${ans}</section>`;
  }).join("");
}

/** What Copy puts on the clipboard: plain markdown, for pasting into a session or a note. */
export function qClipText(entries: readonly QEntry[]): string {
  return entries.map(({ p, n }) => {
    const head = p.relay ? `## From ${p.relay.name}` : `## ${n}. You asked`;
    return `${head}\n\n${p.text}\n\n${p.answer ? `**Answer**\n\n${p.answer}` : "_(no answer recorded)_"}`;
  }).join("\n\n---\n\n");
}
