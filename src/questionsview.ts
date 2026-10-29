// The Questions sheet's markup: every question in a conversation with the agent's closing
// answer beside it, oldest first, for when the REPL has compacted the scrollback away.
// Data in, string out; ./questions owns #qDlg and hands in the rendered answers.

import { esc, escAttr } from "./format";
import { outlineItems, promptLabel } from "./outline";
import type { Prompt, Sess } from "./types";

const clock = (at: number) => at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export interface QEntry { p: Prompt; n: number } // n is 0 for a relay, which is not yours to number

/** Every row, oldest first: relays stay in line, unfolded, since the sheet has the room. */
export function qEntries(s: Sess): QEntry[] {
  return outlineItems(s.prompts).flatMap((it) =>
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
    + `<span class="q-rn">${n || (p.relay?.kind === "agent" ? "◇" : "⇄")}</span>`
    + `<span class="q-rt">${esc(promptLabel(p.text))}</span>`
    + `<span class="q-rc">${p.answer ? "" : "·"}</span></button>`).join("");
}

// Why there is no answer, in the one case that is not a gap: the turn is still running.
function noAnswer(s: Sess, last: boolean): string {
  if (last && (s.phase === "thinking" || s.phase === "working")) return `<div class="q-none run">Working on it…</div>`;
  return `<div class="q-none">No closing answer was recorded for this one.</div>`;
}

export function qThreadHtml(s: Sess, entries: readonly QEntry[], answerHtml: (p: Prompt) => string): string {
  if (!entries.length) return `<div class="call-empty">Nothing asked yet.</div>`;
  return entries.map(({ p, n }, i) => {
    const r = p.relay;
    const who = r ? `<span class="q-who">${r.kind === "agent" ? "◇" : "⇄"} ${esc(r.name)} · ${r.report ? "report" : "message"}</span>` : `<span class="q-n">#${n}</span>`;
    const back = p.restored ? `<span class="q-b" title="From before this pane was resumed">↩</span>` : "";
    const head = `<div class="q-h">${who}<span class="q-t">${back}${clock(p.at)}</span>`
      + `<button class="q-act" type="button" data-qjump="${escAttr(p.id)}" title="Close this and find the question in the terminal">Find in terminal</button>`
      + `<button class="q-act" type="button" data-qcopy="${escAttr(p.id)}" title="Copy the question and its answer">Copy</button></div>`;
    const ans = p.answer ? `<div class="q-ans mdr">${answerHtml(p)}</div>` : noAnswer(s, i === entries.length - 1);
    return `<section class="q-ent${r ? " relay" : ""}" data-qent="${escAttr(p.id)}">${head}<div class="q-ask">${esc(p.text)}</div>${ans}</section>`;
  }).join("");
}

/** What Copy puts on the clipboard: plain markdown, for pasting into a session or a note. */
export function qClipText(entries: readonly QEntry[]): string {
  return entries.map(({ p, n }) => {
    const head = p.relay ? `## From ${p.relay.name}` : `## ${n}. You asked`;
    return `${head}\n\n${p.text}\n\n${p.answer ? `**Answer**\n\n${p.answer}` : "_(no answer recorded)_"}`;
  }).join("\n\n---\n\n");
}
