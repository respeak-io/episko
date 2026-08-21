// The two status-bar popovers whose markup is pure: the launch-engine picker and the
// keyboard cheat sheet.
//
// Both were built inline in ./footer, which is a DOM-owning module. That was fine while
// the footer was their only caller — and stopped being fine when Settings › Footer grew
// previews of what each segment opens, because **./footer imports ./settings**
// (`renderSettings`, to surface the token scan) so a settings→footer import would be a
// cycle. Moving the markup out is the fix the boundary rule prescribes anyway: a
// `*view.ts` takes data and returns a string, and the `render*` that paints it stays
// with whoever owns the element.
//
// Same shape as ./usageview's `costPopHtml` and `ioPopHtml`, and for the same payoff:
// the settings preview is the real renderer rather than a drawing of one, so it cannot
// drift from the popover it previews.

import { esc } from "./format";
import { engineDef } from "./state";
import type { Engine } from "./types";

/// The launch-engine picker. `available` is what this OS actually has — the footer
/// passes `availEngines`, which is probed at startup.
export function enginePopHtml(available: readonly Engine[], current: Engine): string {
  return available.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === current ? "on" : ""}" data-engine="${id}">`
      + `<span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span>`
      + `<span class="mp-check">✓</span></button>`;
  }).join("");
}

/// One row of the cheat sheet: a description and the chord(s) that run it.
export interface ShortcutRow { label: string; chords: string[][] }

/// The cheat sheet. `off` is the master switch being down — with it off there are no
/// rows but the clipboard one, so the popover says why rather than showing a near-empty
/// box that reads like a bug.
export function shortPopHtml(rows: readonly ShortcutRow[], off: boolean): string {
  const list = rows.map((s) => {
    const keys = s.chords
      .map((c) => `<span class="sc-chord">${c.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>`)
      .join(`<span class="sc-or">/</span>`);
    return `<div class="sc-row"><span class="sc-desc">${esc(s.label)}</span><span class="sc-keys">${keys}</span></div>`;
  }).join("");
  const note = off
    ? `<div class="sc-off">Switched off in Settings › Keys. Esc still closes what is open, and a terminal keeps its own copy/paste.</div>`
    : "";
  return `<div class="sc-h">Keyboard shortcuts</div>${note}${list}`;
}
