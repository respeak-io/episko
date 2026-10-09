// The project settings panel's markup: data in, string out. ./projsettings owns the dialog,
// assembles the rows and routes every `data-ps` click; Settings' row classes are reused so a
// project row reads exactly like the global one it overrides (docs/settings.md).
import { esc, escAttr } from "./format";

export interface PsSeg { value: string; label: string; sub?: string; off?: string }

/** One row. `overridden` is the accent bar and the ⟲: this project answers for itself. */
export interface PsRow {
  id: string; label: string; hint: string;
  cur?: string;
  overridden?: boolean;
  ctl: string;
  note?: string;
}

/** A row of buttons; `off` disables an option and is the tooltip saying why. */
export function segCtl(verb: string, label: string, opts: PsSeg[], active: string): string {
  return `<div class="set-seg" role="radiogroup" aria-label="${escAttr(label)}">${opts.map((o) =>
    `<button class="set-segb${o.value === active ? " on" : ""}" data-ps="${verb}|${escAttr(o.value)}"`
    + ` title="${escAttr(o.off ?? o.sub ?? o.label)}" aria-pressed="${o.value === active}"${o.off ? " disabled" : ""}>${esc(o.label)}</button>`).join("")}</div>`;
}

export const btnCtl = (verb: string, label: string, tip = ""): string =>
  `<button class="set-abtn" data-ps="${verb}"${tip ? ` title="${escAttr(tip)}"` : ""}>${esc(label)}</button>`;

export const nilCtl = (text: string): string => `<span class="set-nil">${esc(text)}</span>`;

function rowHtml(r: PsRow): string {
  const reset = r.overridden
    ? `<button class="set-reset" data-ps="reset|${r.id}" title="Follow Settings again" aria-label="Follow Settings for ${escAttr(r.label)}">⟲</button>` : "";
  return `<div class="set-row${r.overridden ? " set-chg" : ""}" data-psrow="${r.id}">
    <div class="set-inline"><div class="set-itxt">
      <div class="set-glabel">${esc(r.label)}</div>
      <div class="set-hint">${esc(r.hint)}</div>
      ${r.cur ? `<div class="set-cur">${esc(r.cur)}</div>` : ""}
      ${r.note ? `<div class="set-empty">${esc(r.note)}</div>` : ""}
    </div><div class="set-ctl">${reset}${r.ctl}</div></div></div>`;
}

export interface PsPanel {
  name: string; path: string; accent: string;
  mine: PsRow[]; team: PsRow[];
  teamNote: string;
}

// Two headed groups on purpose: a team setting changed in the belief it was personal is
// the one mistake this panel exists to make impossible.
export function projSettingsHtml(p: PsPanel): string {
  const n = p.mine.filter((r) => r.overridden).length;
  const lead = n ? `${n} setting${n === 1 ? "" : "s"} set for this project; everything else follows Settings.`
    : "Nothing set for this project yet; everything follows Settings.";
  return `<header class="ps-head"><span class="ps-sw" style="background:${escAttr(p.accent)}"></span>
      <div class="ps-ht"><h2>${esc(p.name)}</h2><div class="ps-path mono">${esc(p.path)}</div></div></header>
    <div class="ps-body">
      <section class="ps-sec"><div class="set-sech"><h3>Yours</h3><span class="ps-sub">on this machine, for you alone</span></div>
        <div class="ps-lead">${esc(lead)}</div>
        ${p.mine.map(rowHtml).join("")}</section>
      <section class="ps-sec"><div class="set-sech"><h3>The team's</h3><span class="ps-sub">everyone working on this project</span></div>
        ${p.team.map(rowHtml).join("")}
        <div class="ps-foot">${esc(p.teamNote)}</div></section>
    </div>`;
}
