// The status bar's engine picker, shortcut sheet and the quick-open icon every footer popover
// carries, as pure markup. Kept out of ./footer (which owns the elements and their timers) so
// Settings › Footer can preview them with the real renderer.

import type { EnvRow, EnvSection } from "./envs";
import { esc, escAttr, relTime } from "./format";
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
    popGoHtml({ go: "launching", label: "Session defaults", sub: "which agent, and how it starts" })
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

// ---- the environment picker ----
// One section per environment: a checkout has one, a monorepo has one per package, and the
// header of each is the target it switches. Pure, so Settings previews it with this renderer.

export interface EnvPopView {
  /** The checkout the picker is about: the chip is per-checkout, so it has to say which. */
  where: string;
  sections: EnvSection[];
  /** The project's own `.episko/episko.toml` does not parse, so its rules are not in force. */
  broken: boolean;
  /** Where environments are looked for, named rather than left a mystery: it is the targets
   *  that find nothing when a project's layout is not the one Episko guessed. */
  targets: string[];
}

function envRowHtml(r: EnvRow, target: string): string {
  const { preset: p, mark: m } = r;
  const sub = `${p.path} · ${p.vars} vars · ${relTime(p.mtimeMs)}`;
  const why = m.rule ? ` · matched by /${m.rule}/i` : "";
  return `<button class="mp-item ev-item ev-${m.tone}${p.active ? " on" : ""}" type="button" role="option"`
    + ` aria-selected="${p.active}" data-envpick="${escAttr(p.path)}" data-envtarget="${escAttr(target)}"`
    + ` title="${escAttr(`Point ${target} at ${p.path}${why}`)}">`
    + `<span class="mp-ic ev-d"></span><span class="mp-main"><span class="mp-l">${esc(m.label)}</span>`
    + `<span class="mp-s">${esc(sub)}</span></span><span class="mp-check">✓</span></button>`;
}

// The one state that destroys something irreplaceable gets an answer rather than a warning:
// the content is offered a name of its own before anything is allowed to overwrite it.
function envSaveHtml(target: string): string {
  return `<div class="ev-mod"><div class="ev-modh"><code>${esc(target)}</code> matches no preset — it holds`
    + ` changes nothing else has a copy of.</div><div class="ev-modr">`
    + `<input class="ev-name" data-envname="${escAttr(target)}" spellcheck="false" autocomplete="off"`
    + ` placeholder="name it" aria-label="Preset name" />`
    + `<button class="ev-save" type="button" data-envsave="${escAttr(target)}">Save as a preset</button></div></div>`;
}

function envSectionHtml(s: EnvSection, only: boolean): string {
  const g = s.group;
  // With one environment the picker's own header already names it; with several, each says
  // which file it switches, or two identical lists of "prod / dev" mean nothing.
  const head = only ? "" : `<div class="ev-sech ev-${s.chip.tone}"><span class="ev-d"></span>`
    + `<span class="ev-sect mono">${esc(g.target)}</span><span class="ev-secs">${esc(s.chip.text)}</span></div>`;
  const rows = s.rows.map((r) => envRowHtml(r, g.target)).join("");
  return head + rows + (g.state === "modified" ? envSaveHtml(g.target) : "");
}

export function envPopHtml(v: EnvPopView): string {
  const n = v.sections.length;
  const go = `<button class="pgo" data-envrules="1" title="Environment rules · targets, patterns and tones, kept with the project"`
    + ` aria-label="Environment rules">↗</button>`;
  const head = `<div class="up-h">${esc(v.where)}${n > 1 ? ` · ${n} environments` : ""}${go}</div>`;
  const broken = v.broken
    ? `<div class="ev-broken">This project's <code>.episko/episko.toml</code> does not parse, so its own rules are not in force.</div>`
    : "";
  const body = n
    ? v.sections.map((s) => envSectionHtml(s, n === 1)).join("")
    : `<div class="ev-none">No environments here. Episko looked for <code>${esc(v.targets.join("</code>, <code>"))}</code>`
      + ` — <button class="ev-link" type="button" data-envrules="1">look somewhere else</button>.</div>`;
  return head + broken + body;
}
