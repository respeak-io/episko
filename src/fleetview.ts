// The fleet screen's markup: data in, string out, like every other *view module. ./fleet owns
// the rules and ./fleetui owns the pane, its two invokes and its events. Every attribute here
// is data-fl*, which is what keeps this file out of dispatch.test.ts's dashboard sweep.

import { esc, escAttr, fmtUntil, relTime, sparkline, tilde, uTok, uUsd, uUsd2 } from "./format";
import type { FleetCard, FleetSort, FleetTally } from "./fleet";
import type { Forecast } from "./rl";
import type { DiffStat } from "./types";
import type { ModelSeries } from "./usage";
import { usageRow } from "./usageview";

/** One live session's glyph on a project card: identity only, never a click target. */
export interface FleetGlyph { id: string; glyph: string; cls: string; title: string }
/** What a card needs that ./fleet's rules do not carry: who is running, and the 14-day shape. */
export interface FleetExtra { glyphs: FleetGlyph[]; spark: number[] }
// One row of the left column. `note` is the host's own wording (why it wants you, what it is
// doing): the view chooses no sentence, so a provider with no phase invents none here either.
export interface FleetRow {
  id: string; project: string; accent: string; label: string;
  glyph: string; cls: string; note: string; since: number;
}
/** A shelved or dormant session: it opens its project, since restoring lives on that dashboard. */
export interface FleetResume { path: string; name: string; accent: string; label: string; when: number }
export interface FleetSpendRow { name: string; accent: string; spend: number }
export interface FleetUsage {
  days: number; spend: number; tokens: number;
  daily: number[];          // cost per day over the window, oldest first
  models: ModelSeries[];    // modelSeries' order, so the mix reads like every other model surface
  projects: FleetSpendRow[]; // costliest first, already capped by the host
}
export interface FleetView {
  cards: FleetCard[];              // fleetSorted's output, in the order it is drawn
  extra: Record<string, FleetExtra>; // keyed by FleetCard.path; a missing entry draws no spark
  shared: string[];                // project names whose spend is merged with another basename
  needs: FleetRow[]; live: FleetRow[]; resume: FleetResume[];
  usage: FleetUsage;
  limits: { h5: Forecast; d7: Forecast };
}

const SORTS: [FleetSort, string, string][] = [
  ["attention", "Urgent", "most urgent first"],
  ["recent", "Recent", "last moved first"],
  ["name", "Name", "A to Z"],
];
// `v` carries markup (a dim dash, a formatted figure), so the caller escapes it — ./dashview's
// deleted tile did the same, and `.sb-fig`'s .k/.v/.d typography is that tile's, verbatim.
const fig = (k: string, v: string, d = "") =>
  `<div class="sb-fig"><span class="k">${esc(k)}</span><span class="v">${v}</span>`
  + (d ? `<span class="d">${esc(d)}</span>` : "") + `</div>`;
const DASH = `<span class="dim">—</span>`;

export function fleetHeadHtml(
  t: FleetTally, sort: FleetSort, when: string, u: FleetUsage, week: Forecast,
): string {
  const seg = SORTS.map(([id, label, tip]) =>
    `<button${id === sort ? ` class="on"` : ""} data-flsort="${id}" title="${escAttr(tip)}">${esc(label)}</button>`).join("");
  const wk = week.used == null ? DASH : Math.round(week.used) + "%";
  const wkSub = week.resetTs != null ? `resets in ${fmtUntil(week.resetTs)}` : "no active window";
  const figs = fig("Live", String(t.live), `${t.projects} project${t.projects === 1 ? "" : "s"}`)
    + fig("Needs you", String(t.needs), t.needs ? "waiting on you" : "nothing waiting")
    + fig("Spend", u.spend > 0 ? esc(uUsd(u.spend)) : DASH, `last ${u.days} days`)
    + fig("Tokens", u.tokens > 0 ? esc(uTok(u.tokens)) : DASH, `last ${u.days} days`)
    + fig("Week used", wk, wkSub);
  return `<div class="sb-h"><span class="t">All projects</span>`
    + (when ? `<span class="dim">${esc(when)}</span>` : "")
    + `<span class="db-seg">${seg}</span></div><div class="sb-figs">${figs}</div>`;
}

// A card says what it has and says the blank in words otherwise: an empty panel reads as
// breakage, not as an honest nothing.
function acCard(title: string, count: string, body: string, empty: string): string {
  return `<div class="ac"><div class="ac-h"><span class="t">${esc(title)}</span>`
    + `<span class="n">${esc(count)}</span></div>`
    + (body ? `<div class="ac-b">${body}</div>` : `<div class="ac-empty">${esc(empty)}</div>`)
    + `</div>`;
}

// The ✕ is nested inside the row, so ./fleetui must probe data-flclose BEFORE data-flsel or
// the row swallows the close — the same ordering every nested control in the dash chain has.
function rowHtml(r: FleetRow, close: boolean): string {
  const tip = `${r.project} · ${r.label}${r.note ? ` · ${r.note}` : ""}`;
  return `<div class="srow o3" data-flsel="${escAttr(r.id)}" title="${escAttr(tip)}">
    <span class="sglyph ${esc(r.cls)}">${esc(r.glyph)}</span>
    <span class="sbranch"><b style="color:${escAttr(r.accent)}">${esc(r.project)}</b> ${esc(r.label)}</span>
    <span class="stags">${r.note ? `<span class="tag">${esc(r.note)}</span>` : ""}</span>
    <span class="sctx">${r.since ? esc(relTime(r.since)) : ""}</span>`
    + (close ? `<span class="sclose" data-flclose="${escAttr(r.id)}" title="Close this session">✕</span>` : "")
    + `</div>`;
}

const resumeHtml = (r: FleetResume) =>
  `<div class="cr" data-flproj="${escAttr(r.path)}" data-flname="${escAttr(r.name)}"
    title="${escAttr(`${tilde(r.path)} · open this project to pick it back up`)}">
    <span class="k" style="color:${escAttr(r.accent)}">◷</span>
    <span class="ti">${esc(r.label)}</span>
    <span class="rt"><span class="sctx">${r.when ? esc(relTime(r.when)) : ""}</span></span></div>`;

// `undefined` is a folder nothing has swept — the map is only filled for folders in play — and
// it must never read as clean. Three states, exactly as ./fleet and ./dashview keep them.
function dirtyTag(g: DiffStat | null | undefined): string {
  if (g === undefined) return `<span class="tag" title="Not read yet">—</span>`;
  if (!g || !g.dirty) return `<span class="tag ok">clean</span>`;
  return `<span class="tag warn" title="${g.dirty} uncommitted">${g.dirty}</span>`;
}
// Every count here is as old as the last fetch, so the chip says so rather than implying live.
function syncTag(g: DiffStat | null | undefined): string {
  if (!g || !g.upstream || (!g.ahead && !g.behind)) return "";
  const txt = (g.ahead ? `↑${g.ahead}` : "") + (g.ahead && g.behind ? " " : "") + (g.behind ? `↓${g.behind}` : "");
  return `<span class="tag" title="${escAttr(`${g.upstream} · as of the last fetch`)}">${txt}</span>`;
}

function projRow(c: FleetCard, x: FleetExtra | undefined, shared: boolean): string {
  const glyphs = (x?.glyphs ?? []).map((g) =>
    `<span class="sglyph ${esc(g.cls)}" data-flsid="${escAttr(g.id)}" title="${escAttr(g.title)}">${esc(g.glyph)}</span>`).join("");
  const spark = x && x.spark.length > 1 ? sparkline(x.spark) : "";
  const touched = Math.max(c.lastCommit, c.lastSession);
  // Spend is recorded by project NAME, so two repos of one basename sum and cannot be told
  // apart afterwards; the figure says which of the two it is rather than pretending.
  const spendTip = shared
    ? `${uUsd2(c.spend)} — shared with another project of this name: the record is kept by name`
    : `${uUsd2(c.spend)} over the window`;
  const needs = c.needs ? `<span class="tag acc" title="${c.needs} waiting on you">${c.needs} ◆</span>` : "";
  return `<div class="cr" data-flproj="${escAttr(c.path)}" data-flname="${escAttr(c.name)}"
    title="${escAttr(tilde(c.path))}">
    <span class="k" style="color:${escAttr(c.accent)}">▪</span>
    <span class="ti">${esc(c.name)}</span>
    <span class="rt">${glyphs}${spark}${needs}${dirtyTag(c.dirty)}${syncTag(c.dirty)}
      <span class="sctx" title="${escAttr(spendTip)}">${c.spend > 0 ? esc(uUsd2(c.spend)) : DASH}</span>
      <span class="sctx">${touched ? esc(relTime(touched)) : DASH}</span></span></div>`;
}

function projectsCard(v: FleetView): string {
  const dirty = v.cards.filter((c) => !!c.dirty && c.dirty.dirty > 0).length;
  const count = `${v.cards.length}${dirty ? ` · ${dirty} uncommitted` : ""}`;
  const rows = v.cards.map((c) => projRow(c, v.extra[c.path], v.shared.includes(c.name))).join("");
  return acCard("Projects", count, rows, "No projects yet. Add a folder from the sidebar.");
}

// The family hues and the shade ladder ./usageview paints the Usage window with, so a model
// wears one colour on every surface. A provider we ship no hue for lands on --m-other.
const M_VAR: Record<string, string> = {
  opus: "--m-opus", sonnet: "--m-sonnet", haiku: "--m-haiku", fable: "--m-fable",
  gpt: "--m-gpt", codex: "--m-codex",
};
const M_SHADE = [100, 74, 54, 40];
function modelHue(r: ModelSeries): string {
  const v = M_VAR[r.kin] ?? "--m-other";
  const pct = M_SHADE[r.shade] ?? M_SHADE[M_SHADE.length - 1];
  return pct === 100 ? `var(${v})` : `color-mix(in srgb, var(${v}) ${pct}%, var(--m-fade))`;
}

function spendCard(u: FleetUsage): string {
  const rib = u.daily.length > 1 ? `<span class="sb-rib">${sparkline(u.daily)}</span>` : "";
  const figs = fig("Total", u.spend > 0 ? esc(uUsd(u.spend)) : DASH, `last ${u.days} days`)
    + fig("Per day", u.days && u.spend > 0 ? esc(uUsd2(u.spend / u.days)) : DASH, "average")
    + fig("Tokens", u.tokens > 0 ? esc(uTok(u.tokens)) : DASH, "in range");
  return `<section class="u-card"><div class="label">Spend by day</div>
    <div class="sb-figs" style="margin:9px 0">${figs}</div>${rib}</section>`;
}

function modelCard(models: ModelSeries[]): string {
  const total = models.reduce((n, r) => n + r.total, 0);
  const rows = models.map((r) => {
    const c = modelHue(r), pct = total ? r.total / total * 100 : 0;
    return `<div class="u-srow"><div class="u-stop"><span class="u-sw" style="background:${c}"></span>`
      + `<span class="u-snm">${esc(r.name)}</span><span class="u-susd mono">${esc(uTok(r.total))}</span></div>`
      + `<div class="u-strack"><i style="width:${pct.toFixed(1)}%;background:${c}"></i></div></div>`;
  }).join("");
  const body = total > 0 ? `<div class="u-share">${rows}</div>` : `<p class="u-hint">No token data in range yet.</p>`;
  return `<section class="u-card"><div class="label">Model mix <span class="u-byline">· by tokens</span></div>${body}</section>`;
}

function costCard(rows: FleetSpendRow[]): string {
  if (!rows.length) return "";
  const max = rows[0].spend || 1;
  const body = rows.map((r) =>
    `<tr><td><span class="u-pj"><span class="u-dot" style="background:${escAttr(r.accent)}"></span>${esc(r.name)}</span></td>`
    + `<td class="u-num"><span class="u-pjbar"><i style="width:${(r.spend / max * 100).toFixed(0)}%"></i></span></td>`
    + `<td class="u-num"><span class="u-usd mono">${esc(uUsd2(r.spend))}</span></td></tr>`).join("");
  return `<section class="u-card"><div class="label">Costliest projects</div>
    <table class="u-tbl" style="margin-top:9px"><thead><tr><th>Project</th><th class="u-num">Share</th><th class="u-num">Spend</th></tr></thead>
    <tbody>${body}</tbody></table></section>`;
}

// `.usagepop` is where every `.up-*` rule in the file is scoped, so the wrapper is what makes
// the shared forecast rows render here — the same borrowing Settings' popover previews do.
const limitsCard = (l: { h5: Forecast; d7: Forecast }) =>
  `<section class="u-card"><div class="label">Claude usage limits</div>
    <div class="usagepop">${usageRow("Session", "5-hour window", l.h5)}${usageRow("Weekly", "7-day window", l.d7)}</div></section>`;

export function fleetBodyHtml(v: FleetView): string {
  const colA = acCard("Needs you", String(v.needs.length), v.needs.map((r) => rowHtml(r, true)).join(""), "Nothing is waiting on you.")
    + acCard("Live now", String(v.live.length), v.live.map((r) => rowHtml(r, true)).join(""), "No sessions running.")
    + acCard("Pick back up", String(v.resume.length), v.resume.map(resumeHtml).join(""), "Nothing left open.");
  const colC = spendCard(v.usage) + modelCard(v.usage.models) + costCard(v.usage.projects) + limitsCard(v.limits);
  return `<div class="db-cols">
    <div class="db-col db-col-a">${colA}</div>
    <div class="db-col db-col-b">${projectsCard(v)}</div>
    <div class="db-col db-col-c">${colC}</div></div>`;
}
