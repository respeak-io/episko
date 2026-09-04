// The status bar's engine picker and shortcut sheet as pure markup. Kept out of ./footer
// (which imports ./settings) so Settings › Footer can preview them with the real renderer.

import { esc } from "./format";
import { engineDef } from "./state";
import type { Engine } from "./types";

// `available` is what this OS has (the footer's `availEngines`, probed at startup).
export function enginePopHtml(available: readonly Engine[], current: Engine): string {
  return available.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === current ? "on" : ""}" data-engine="${id}">`
      + `<span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span>`
      + `<span class="mp-check">✓</span></button>`;
  }).join("");
}

export interface ShortcutRow { label: string; chords: string[][] }

// `off` is the master switch being down: say why the sheet is near-empty, or it reads like a bug.
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
