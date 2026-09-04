// The status bar's engine picker, shortcut sheet and the quick-open icon every footer popover
// carries, as pure markup. Kept out of ./footer (which owns the elements and their timers) so
// Settings › Footer can preview them with the real renderer.

import { esc, escAttr } from "./format";
import { engineDef } from "./state";
import type { Engine } from "./types";

// A popover's quick open: the panel that answers the question the popover only summarises.
// One icon in the header's right corner, never a row of its own — these are menus, and a
// full-width button at the foot read as the main event rather than the way out.
// `go` is what main.ts's dispatcher routes on: "usage" is the Usage & spend window and
// anything else a Settings tab id (test/dispatch.test.ts holds that join).
export interface PopGo { go: string; label: string; sub: string }

// The name an icon owes you lives in its tooltip. Rendered inside Settings › Footer's
// previews too, which are inert (`.fpv-pop` kills pointer events).
export function popGoHtml(l: PopGo): string {
  return `<button class="pgo" data-fgo="${esc(l.go)}" title="${escAttr(`${l.label} · ${l.sub}`)}"`
    + ` aria-label="${escAttr(l.label)}">↗</button>`;
}

// `available` is what this OS has (the footer's `availEngines`, probed at startup).
export function enginePopHtml(available: readonly Engine[], current: Engine): string {
  const items = available.map((id) => {
    const d = engineDef(id);
    return `<button class="mp-item ${id === current ? "on" : ""}" data-engine="${id}">`
      + `<span class="mp-ic">${id === "embedded" ? "▤" : "⧉"}</span>`
      + `<span class="mp-main"><span class="mp-l">${esc(d.label)}</span><span class="mp-s">${esc(d.sub)}</span></span>`
      + `<span class="mp-check">✓</span></button>`;
  }).join("");
  // The one popover in the family that named nothing, which left its quick open no corner
  // to sit in. Where the terminal opens is one of three facts a launch resolves; the other
  // two are only settable in Settings, so the picker says where the rest of the answer lives.
  return `<div class="up-h">New sessions open in${
    popGoHtml({ go: "sessions", label: "Session defaults", sub: "which agent, and how it starts" })
  }</div>${items}`;
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
  const go = popGoHtml({ go: "keys", label: "Rebind these", sub: off ? "and turn them back on" : "or turn one off" });
  return `<div class="sc-h">Keyboard shortcuts${go}</div>${note}${list}`;
}
