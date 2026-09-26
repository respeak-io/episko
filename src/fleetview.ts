// The fleet screen's markup: data in, string out, like every other *view module. ./fleet owns
// the rules and ./fleetui owns the pane, its reads and its events. Every attribute here is
// data-fl*, which is what keeps this file out of dispatch.test.ts's dashboard sweep.

import { barRow, esc, escAttr, fmtUntil, relTime, tilde, uTok, uUsd, uUsd2 } from "./format";
import { chord } from "./dom"; // a platform-spelled chord, not DOM access: the *view rule allows it
import { FLEET_RANGES, type FleetCard, type FleetSection, type FleetSort, type FleetTally } from "./fleet";
import type { Forecast } from "./rl";
import type { DiffStat } from "./types";
import type { ModelSeries } from "./usage";
import type { TeamRow } from "./sync";
import { GCLASS, GLYPH } from "./sidebarview";
import { foreText } from "./usageview";
import { sk } from "./dashview"; // the one shimmer; ./dashview declares it, .db-sk styles it

/** One live session's glyph on a project card: identity only, never a click target. */
export interface FleetGlyph { id: string; glyph: string; cls: string; title: string }
/** What a card needs that ./fleet's rules do not carry: who is running, the window's shape,
 * and the project's own glyph — ./icons' store, so a card wears what the sidebar does. */
export interface FleetExtra { glyphs: FleetGlyph[]; spark: number[]; icon: string | null }
// One row of the left column. `note` is the host's own wording (why it wants you, what it is
// doing): the view chooses no sentence, so a provider with no phase invents none here either.
export interface FleetRow {
  id: string; project: string; accent: string; label: string;
  glyph: string; cls: string; note: string; since: number;
  ext?: boolean;  // somebody else's terminal: Episko can show it and jump to it, not drive it
}
/** A shelved or dormant session: it opens its project, since restoring lives on that dashboard. */
export interface FleetResume { path: string; name: string; accent: string; label: string; when: number }
export interface FleetSpendRow { name: string; accent: string; spend: number }
/** A model's tokens (the mix) and what they cost (the money), joined on its display name. */
export interface FleetModel extends ModelSeries { cost: number }
export interface FleetUsage {
  days: number; spend: number; today: number; tokens: number; cached: number;
  daily: number[]; first: string;   // cost per day over the window, oldest first, and its first day
  lastSpend: string;                // the newest day the ledger has at all, "" when it has none
  models: FleetModel[];             // modelSeries' order, so the mix reads like every other model surface
  projects: FleetSpendRow[];        // costliest first, already capped by the host
}
export type FleetLayout = "cards" | "list";
export interface FleetView {
  sections: FleetSection[];          // fleetSorted's output, in the order it is drawn; one run when flat
  extra: Record<string, FleetExtra>; // keyed by FleetCard.path; a missing entry draws no spark
  shared: string[];                  // project names whose spend is merged with another basename
  sort: FleetSort; layout: FleetLayout; range: number;
  grouped: boolean; canGroup: boolean; // the switch, and whether there is anything to group by
  // A skeleton stands in for what is NOT KNOWN YET, never for what is on screen: a reload over
  // real figures keeps them and says so in the head instead. Everything not named here — the
  // live rows, the money, the limits — is local state or a `cc-` rollup and never waits.
  firstLoad: boolean;  // the project scan has never answered: commits, branches, last-touched
  tokenWait: boolean;  // the transcript scan is running and has never answered: tokens + the mix
  // The roster is still being reconciled against each provider's history. It gates the project
  // list as well as Pick back up: `allProjects` counts a project a dormant session names, so a
  // fleet whose projects are all restorable ones is genuinely EMPTY until this answers.
  resumeWait: boolean;
  today: string; when: string; tally: FleetTally; needsNote: string;
  needs: FleetRow[]; live: FleetRow[]; resume: FleetResume[];
  usage: FleetUsage;
  limits: { h5: Forecast; d7: Forecast };
  team: TeamRow[] | null;            // null: sync is not set up, so the section is not drawn
}

const DASH = `<span class="dim">—</span>`;
// To the cent while a figure is small enough to have cents worth reading; `uUsd` past that,
// because four digits and a decimal in a 25px face is a number nobody parses at a glance.
const money = (n: number) => (n >= 1000 ? uUsd(n) : uUsd2(n));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// ---------- the head: what this screen is, and the two controls that change it ----------

// Every data-fl* here is spelled out where it is written: test/dispatch.test.ts reads these
// calls as source, so an attribute built from a variable would be invisible to it.
const segBtn = (attr: string, on: boolean, label: string, tip: string) =>
  `<button${on ? ` class="on"` : ""} ${attr} data-tip="${escAttr(tip)}">${esc(label)}</button>`;
const rangeSeg = (cur: number) => `<div class="db-seg">` + FLEET_RANGES.map((n) =>
  segBtn(`data-flrange="${n}"`, n === cur, `${n}d`, `The last ${n} days`)).join("") + `</div>`;
const SORTS: [FleetSort, string, string][] = [
  ["attention", "Urgent", "Most urgent first"],
  ["recent", "Recent", "Last moved first"],
  ["name", "Name", "A to Z"],
];
const sortSeg = (cur: FleetSort) => `<div class="db-seg">` + SORTS.map(([id, label, tip]) =>
  segBtn(`data-flsort="${id}"`, id === cur, label, tip)).join("") + `</div>`;
const layoutSeg = (cur: FleetLayout) => `<div class="db-seg">`
  + segBtn(`data-fllayout="cards"`, cur === "cards", "▦", "One card per project")
  + segBtn(`data-fllayout="list"`, cur === "list", "☰", "One row per project") + `</div>`;
// One button, because it is a switch. Offered only where there is something to group BY: the
// groups are made and named in the sidebar, and a lit toggle over none would do nothing.
const groupSeg = (on: boolean) => `<div class="db-seg">`
  + segBtn(`data-flgroup="1"`, on, "Group", "Group projects under the sidebar's own headings") + `</div>`;

// Value then label, with the sub under both: the band answers "how much" before "of what".
const tile = (label: string, value: string, sub: string, cls = "") =>
  `<div class="fl-tile"><span class="label">${esc(label)}</span>
    <span class="v${cls ? " " + cls : ""}">${value}</span>
    <span class="sub">${esc(sub)}</span></div>`;

export function fleetHeadHtml(v: FleetView): string {
  const u = v.usage, t = v.tally, wk = v.limits.d7;
  const sub = v.resumeWait && !t.projects
    ? v.today
    : `${v.today} · ${plural(t.projects, "project")} · ${plural(t.checkouts, "checkout")}`;
  const pct = wk.used == null ? DASH : `${Math.round(wk.used)}%`;
  const tiles = tile("Live sessions", String(t.live),
      t.live ? `across ${plural(t.liveProjects, "project")}` : "nothing running")
    + tile("Needs you", String(t.needs), v.needsNote, t.needs ? "s-attn" : "")
    + tile(`Spend · ${u.days} days`, u.spend > 0 ? esc(money(u.spend)) : DASH,
      u.today > 0 ? `${uUsd2(u.today)} today` : "nothing today")
    + tile(`Tokens · ${u.days} days`,
      v.tokenWait ? sk("92px", 22) : u.tokens > 0 ? esc(uTok(u.tokens)) : DASH,
      v.tokenWait ? "scanning agent history…"
        : u.cached > 0 ? `${uTok(u.cached)} cached` : "no token data yet")
    + tile("Week used", pct,
      wk.resetTs != null ? `resets in ${fmtUntil(wk.resetTs)}` : "no active window",
      wk.used == null ? "" : `s-${wk.status}`);
  return `<div class="fl-top"><span class="t">All projects</span>
      <span class="fl-sub mono">${esc(sub)}</span><span class="sp"></span>
      ${v.when ? `<span class="fl-when mono">${esc(v.when)}</span>` : ""}
      ${rangeSeg(v.range)}
    </div>
    <div class="fl-tiles">${tiles}</div>`;
}

// ---------- the left column: who wants something ----------

// A section is a label and its rows, never a card: the artboard's left column has no chrome,
// and three boxed headings over four rows each is what made this screen read as a form.
function sec(label: string, count: string, link: string, body: string, empty: string, cls = ""): string {
  return `<section class="fl-sec${cls ? " " + cls : ""}">
    <div class="fl-sh"><span class="label">${esc(label)}</span>
      ${count ? `<span class="n">${esc(count)}</span>` : ""}<span class="sp"></span>${link}</div>`
    + (body ? `<div class="fl-rows">${body}</div>` : `<p class="fl-none">${esc(empty)}</p>`)
    + `</section>`;
}

const closeBtn = (id: string) =>
  `<span class="sclose" data-flclose="${escAttr(id)}" data-tip="Close this session">✕</span>`;

// Two lines, because "which session" and "what it wants" are different questions and the
// second is the one you came for. The row's tint follows its glyph, so an ask reads as urgent.
function needRow(r: FleetRow): string {
  const tip = `${r.project} · ${r.label}${r.note ? ` · ${r.note}` : ""}`;
  return `<div class="fl-need ${esc(r.cls)}" data-flsel="${escAttr(r.id)}" data-tip="${escAttr(tip)}">
    <span class="sglyph ${esc(r.cls)}">${esc(r.glyph)}</span>
    <span class="fl-nt"><span class="t"><b style="color:${escAttr(r.accent)}">${esc(r.project)}</b>
      · ${esc(r.label)}</span><span class="w">${esc(r.note)}</span></span>
    <span class="fl-age mono">${r.since ? esc(relTime(r.since)) : ""}</span>${closeBtn(r.id)}</div>`;
}

// An external session opens its read-only mirror rather than a pane, and carries no ✕: the
// terminal it runs in is not ours to close. `ext` is the whole difference between the two.
function liveRow(r: FleetRow): string {
  const tip = `${r.project} · ${r.label}${r.note ? ` · ${r.note}` : ""}`;
  const open = r.ext ? `data-flext="${escAttr(r.id)}"` : `data-flsel="${escAttr(r.id)}"`;
  return `<div class="fl-row" ${open} data-tip="${escAttr(tip)}">
    <span class="sglyph ${esc(r.cls)}">${esc(r.glyph)}</span>
    <span class="ti">${esc(r.label)}</span>`
    + (r.ext ? `<span class="ext-tag">ext</span>` : "")
    + `<span class="pj mono">${esc(r.project)}</span>${r.ext ? "" : closeBtn(r.id)}</div>`;
}

// Another device's session: nothing to open or close from here, so the row is only a fact.
function teamRow(r: TeamRow): string {
  const who = r.mine ? `${r.user} · another machine` : r.user;
  const tip = `${who} · ${r.project}${r.branch ? ` on ${r.branch}` : ""}`;
  return `<div class="fl-row fl-team" data-tip="${escAttr(tip)}">
    <span class="sglyph ${esc(GCLASS[r.state] ?? "")}">${esc(GLYPH[r.state] ?? "·")}</span>
    <span class="ti">${esc(who)}</span><span class="pj mono">${esc(r.project)}${r.branch ? ` · ${esc(r.branch)}` : ""}</span></div>`;
}

// Nothing left open and not read yet are different answers, and the row list is where the
// difference shows: an empty section under a roster still being reconciled says the wrong one.
const resumeSkel = () => [62, 48, 55].map((w) =>
  `<div class="fl-row sk"><span class="sglyph">${sk("12px", 12)}</span>
    <span class="ti">${sk(`${w}%`, 9)}</span><span class="pj">${sk("36px", 9)}</span></div>`).join("");

const resumeRow = (r: FleetResume) =>
  `<div class="fl-row" data-flproj="${escAttr(r.path)}" data-flname="${escAttr(r.name)}"
    data-tip="${escAttr(`${tilde(r.path)} · open this project to pick it back up`)}">
    <span class="sglyph g-ended">◷</span><span class="ti">${esc(r.label)}</span>
    <span class="pj mono">${r.when ? esc(relTime(r.when)) : ""}</span></div>`;

// ---------- the centre: one card per project ----------

// `undefined` is a folder nothing has swept — the map is only filled for folders in play — and
// it must never read as clean. Three states, exactly as ./fleet and ./dashview keep them.
function dirtyTag(g: DiffStat | null | undefined): string {
  if (g === undefined) return `<span class="tag" data-tip="Not read yet">—</span>`;
  if (!g || !g.dirty) return `<span class="tag ok">clean</span>`;
  return `<span class="tag warn">${g.dirty} uncommitted</span>`;
}
// Every count here is as old as the last fetch, so the tip says so rather than implying live.
function syncTag(g: DiffStat | null | undefined): string {
  if (!g || !g.upstream) return "";
  const txt = (g.ahead ? `↑${g.ahead}` : "") + (g.ahead && g.behind ? " " : "") + (g.behind ? `↓${g.behind}` : "");
  return `<span class="tag" data-tip="${escAttr(`${g.upstream} · as of the last fetch`)}">${txt || "in sync"}</span>`;
}
function branchChip(c: FleetCard): string {
  if (c.branch) return `<span class="fc-br mono">${esc(c.branch)}</span>`;
  return c.dirty === null ? `<span class="fc-br mono dim">not a repo</span>` : "";
}

// Spend is recorded by project NAME, so two repos of one basename sum and cannot be told
// apart afterwards; the figure says which of the two it is rather than pretending.
const spendTip = (c: FleetCard, shared: boolean) => shared
  ? `${uUsd2(c.spend)} — shared with another project of this name: the record is kept by name`
  : `${uUsd2(c.spend)} over the window`;

// What this project has had done to it in the window. Commits and sessions are what this
// screen already read; issues are the project dashboard's, and it buys them when you open it.
function workText(c: FleetCard, days: number): string {
  const parts: string[] = [];
  if (c.commits) parts.push(plural(c.commits, "commit"));
  if (c.sessions) parts.push(plural(c.sessions, "session"));
  return parts.length ? parts.join(" · ") : `quiet ${days} days`;
}

// The project's logo where it has one, as the sidebar and the project header wear it; the
// coloured initial is the fallback for a folder nothing was found in.
const avatar = (c: FleetCard, icon: string | null | undefined) => icon
  ? `<span class="fc-av"><img class="picon" src="${escAttr(icon)}" alt="" /></span>`
  : `<span class="fc-av" style="background:${escAttr(c.accent)}">${esc(c.name.slice(0, 1))}</span>`;
const rowMark = (c: FleetCard, icon: string | null | undefined) => icon
  ? `<img class="picon k" src="${escAttr(icon)}" alt="" />`
  : `<span class="k" style="color:${escAttr(c.accent)}">▪</span>`;

const glyphRow = (x: FleetExtra | undefined) => (x?.glyphs ?? []).map((g) =>
  `<span class="sglyph ${esc(g.cls)}" data-flsid="${escAttr(g.id)}" data-tip="${escAttr(g.title)}">${esc(g.glyph)}</span>`).join("");

// One bar a day, in the project's own colour: a line between two counts invents the days in
// between (./format's `barRow` is the geometry, ./dashview's ribbon the precedent).
function sparkBars(x: FleetExtra | undefined, accent: string, cap = 22): string {
  if (!x || x.spark.length < 2) return `<div class="fc-bars"></div>`;
  const bars = barRow(x.spark, 0, cap).map((b, i) =>
    `<i class="fc-b${b.cls ? " " + b.cls : ""}" style="height:${b.h}px"
      data-tip="${escAttr(`${plural(x.spark[i], "commit")}`)}"></i>`).join("");
  return `<div class="fc-bars" style="--c:${escAttr(accent)}">${bars}</div>`;
}

// The name, the icon, the live glyphs and the money are local and paint at once; the bars, the
// branch and what has been done here are the scan's, so those are what shimmer. A card whose
// head went blank while it loaded would be a worse answer than the one it replaced.
function projCard(c: FleetCard, x: FleetExtra | undefined, shared: boolean, days: number, wait: boolean): string {
  const touched = Math.max(c.lastCommit, c.lastSession);
  return `<div class="fl-card" data-flproj="${escAttr(c.path)}" data-flname="${escAttr(c.name)}"
    data-tip="${escAttr(`${tilde(c.path)} · open this project`)}">
    <div class="fc-h">${avatar(c, x?.icon)}
      <span class="fc-nm">${esc(c.name)}</span><span class="fc-gl">${glyphRow(x)}</span></div>
    ${wait ? `<div class="fc-bars">${sk("100%", 22)}</div>` : sparkBars(x, c.accent)}
    <div class="fc-git">${wait
      ? sk("62px", 14) + sk("74px", 14)
      : branchChip(c) + dirtyTag(c.dirty) + syncTag(c.dirty)}</div>
    <div class="fc-foot">
      <span class="fc-spend mono" data-tip="${escAttr(spendTip(c, shared))}">${c.spend > 0 ? esc(uUsd2(c.spend)) : DASH}</span>
      <span class="fc-work">${wait ? sk("78px", 9) : esc(workText(c, days))}</span><span class="sp"></span>
      <span class="fc-age mono">${wait ? sk("34px", 9) : touched ? esc(relTime(touched)) : DASH}</span></div>
  </div>`;
}

// The same facts on one line, for a fleet too long to scan as cards. Nothing is dropped: the
// spark and the glyphs ride the row, which is what keeps the toggle a layout and not a filter.
function projRow(c: FleetCard, x: FleetExtra | undefined, shared: boolean, days: number, wait: boolean): string {
  const touched = Math.max(c.lastCommit, c.lastSession);
  const mid = wait
    ? `<div class="fc-bars">${sk("100%", 16)}</div>${sk("54px", 13)}${sk("62px", 13)}
      <span class="fc-work">${sk("70px", 9)}</span>`
    : `${sparkBars(x, c.accent, 16)}${branchChip(c)}${dirtyTag(c.dirty)}${syncTag(c.dirty)}
      <span class="fc-work">${esc(workText(c, days))}</span>`;
  return `<div class="fl-prow" data-flproj="${escAttr(c.path)}" data-flname="${escAttr(c.name)}"
    data-tip="${escAttr(`${tilde(c.path)} · open this project`)}">
    ${rowMark(c, x?.icon)}
    <span class="ti">${esc(c.name)}</span>
    <span class="rt">${glyphRow(x)}${mid}
      <span class="fc-spend mono" data-tip="${escAttr(spendTip(c, shared))}">${c.spend > 0 ? esc(uUsd2(c.spend)) : DASH}</span>
      <span class="fc-age mono">${wait ? sk("34px", 9) : touched ? esc(relTime(touched)) : DASH}</span></span></div>`;
}

// A heading only where one was asked for: flat, the single run is nameless and the column
// looks exactly as it did before the switch existed.
function projectsRun(s: FleetSection, v: FleetView): string {
  const draw = v.layout === "cards" ? projCard : projRow;
  const head = v.grouped
    ? `<div class="fl-gh"><span class="label">${esc(s.name)}</span>
        <span class="n">${s.cards.length}</span><span class="ln"></span></div>`
    : "";
  const body = s.cards.map((c) =>
    draw(c, v.extra[c.path], v.shared.includes(c.name), v.usage.days, v.firstLoad)).join("");
  return `<div class="fl-gsec">${head}
    <div class="${v.layout === "cards" ? "fl-grid" : "fl-rows"}">${body}</div></div>`;
}

// A card with nothing known about it at all, for the window before the list itself has
// answered. `projCard(…, wait)` is the other half: that one keeps the name it already has.
const cardSkel = () => `<div class="fl-card sk">
  <div class="fc-h">${sk("22px", 22)}<span class="fc-nm">${sk("58%", 11)}</span></div>
  <div class="fc-bars">${sk("100%", 22)}</div>
  <div class="fc-git">${sk("62px", 14)}${sk("74px", 14)}</div>
  <div class="fc-foot">${sk("46px", 13)}<span class="fc-work">${sk("78px", 9)}</span>
    <span class="sp"></span>${sk("34px", 9)}</div></div>`;
const rowSkel = () => `<div class="fl-prow sk">${sk("15px", 15)}
  <span class="ti">${sk("38%", 9)}</span>
  <span class="rt"><div class="fc-bars">${sk("100%", 16)}</div>${sk("54px", 13)}${sk("62px", 13)}
    <span class="fc-work">${sk("70px", 9)}</span>${sk("44px", 11)}${sk("34px", 9)}</span></div>`;
// Enough to fill the fold at either layout; the real count replaces them within a frame or two.
const BLIND_SKELS = 6;

function projectsSec(v: FleetView): string {
  const t = v.tally;
  // The same fact as the body, so it cannot assert a zero the body is drawing a skeleton for.
  const count = v.resumeWait && !t.projects
    ? "" : `${t.projects}${t.dirty ? ` · ${t.dirty} uncommitted` : ""}`;
  const controls = sortSeg(v.sort) + (v.canGroup ? groupSeg(v.grouped) : "") + layoutSeg(v.layout);
  return `<section class="fl-sec">
    <div class="fl-sh"><span class="label">Projects</span>${count ? `<span class="n">${esc(count)}</span>` : ""}
      <span class="sp"></span>${controls}</div>`
    + (t.projects ? v.sections.map((s) => projectsRun(s, v)).join("")
      // An empty list is only "you have no projects" once the read that could still FILL it has
      // answered — the roster, not the project scan, which adds figures and never a project.
      // The first-run sentence flashing in front of a fleet about to paint is the same lie
      // Pick back up told, and on a machine whose projects are all restorable it flashed on
      // every boot.
      : v.resumeWait || v.firstLoad
        ? `<div class="${v.layout === "cards" ? "fl-grid" : "fl-rows"}">${
          Array.from({ length: BLIND_SKELS }, v.layout === "cards" ? cardSkel : rowSkel).join("")}</div>`
        : `<p class="fl-none">No projects yet. Add a folder from the sidebar, or press ${esc(chord("K"))}.</p>`)
    + `</section>`;
}

// ---------- the right: what it all cost ----------

function spendSec(u: FleetUsage): string {
  const lit = Math.min(7, u.daily.length);
  // Nothing spent draws no chart: a row of stubs under a "today $0.00" reads as a broken
  // chart rather than as an honest nothing, which is what the sentence is for.
  const bars = u.spend > 0 && u.daily.length > 1
    ? barRow(u.daily, lit, 62).map((b, i) =>
      `<i class="fl-bar${b.cls ? " " + b.cls : ""}" style="height:${b.h}px"
        data-tip="${escAttr(uUsd2(u.daily[i]))}"></i>`).join("")
    : "";
  const link = `<button class="aslink" data-flopen="usage" data-tip="Open Usage &amp; spend">Usage &amp; spend ⤢</button>`;
  const body = bars ? `<div class="fl-bars">${bars}</div>
    <div class="fl-bfoot"><span class="mono">${esc(u.first)}</span>
      <span class="mono">today ${u.today > 0 ? esc(uUsd2(u.today)) : esc(uUsd2(0))}</span></div>` : "";
  // "Nothing here" and "nothing anywhere" are different facts: a ledger whose newest day is
  // outside the window reads as a broken figure unless the card says where its data went.
  const none = u.lastSpend
    ? `Nothing in this window. The last spend recorded here was ${u.lastSpend} — widen the range above.`
    : "Nothing recorded yet. The money figures count what Episko's own sessions spend.";
  return sec("Spend", "", link, body, none);
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

// In the geometry of the stack and its rows. The empty sentence stays for a window that
// genuinely holds nothing: only a scan with no answer yet earns this.
const modelSkel = () => `<div class="fl-stack">${sk("100%", 10)}</div>
  <div class="fl-rows">${["46%", "34%", "28%"].map((w) =>
    `<div class="fl-mrow"><span class="msw db-sk"></span><span class="nm">${sk(w, 9)}</span>
      <span class="tk">${sk("40px", 9)}</span><span class="usd">${sk("34px", 9)}</span></div>`).join("")}</div>`;

function modelSec(u: FleetUsage, wait: boolean): string {
  const total = u.models.reduce((n, r) => n + r.total, 0);
  const stack = u.models.map((r) =>
    `<i style="width:${(r.total / total * 100).toFixed(1)}%;background:${modelHue(r)}"></i>`).join("");
  const rows = u.models.map((r) =>
    `<div class="fl-mrow"><span class="msw" style="background:${modelHue(r)}"></span>
      <span class="nm">${esc(r.name)}</span>
      <span class="tk mono">${esc(uTok(r.total))}</span>
      <span class="usd mono">${r.cost > 0 ? esc(uUsd2(r.cost)) : DASH}</span></div>`).join("");
  const body = total > 0
    ? `<div class="fl-stack">${stack}</div><div class="fl-rows">${rows}</div>`
    : wait ? modelSkel() : "";
  return sec(`Where it went · ${u.days} days`, "", "", body, "No token data in range yet.");
}

function costSec(rows: FleetSpendRow[]): string {
  const max = rows[0]?.spend || 1;
  const body = rows.map((r) =>
    `<div class="fl-crow"><span class="nm">${esc(r.name)}</span>
      <span class="track"><i style="width:${(r.spend / max * 100).toFixed(0)}%;background:${escAttr(r.accent)}"></i></span>
      <span class="usd mono">${esc(uUsd2(r.spend))}</span></div>`).join("");
  return sec("Costliest projects", "", "", body, "Nothing recorded per project yet.");
}

// The meter, its reset and one sentence — the weekly forecast, which is the one that decides
// whether today's plan survives. ./usageview's `foreText` writes it, so there is one wording.
function limitRow(label: string, f: Forecast): string {
  const cls = f.used == null ? "" : ` s-${f.status}`;
  const w = f.used == null ? 0 : Math.min(100, Math.max(0, f.used));
  return `<div class="fl-lim"><div class="fl-lh"><span class="nm">${esc(label)}</span>
      <span class="pct mono${cls}">${f.used == null ? "–" : `${Math.round(f.used)}%`}</span></div>
    <div class="fl-track${cls}"><i style="width:${w}%"></i></div>
    <span class="rs mono">${f.resetTs != null ? `resets in ${esc(fmtUntil(f.resetTs))}` : "no active window"}</span></div>`;
}
const limitsSec = (l: { h5: Forecast; d7: Forecast }) =>
  sec("Account limits", "", "", limitRow("5-hour window", l.h5) + limitRow("Week", l.d7)
    + `<p class="fl-fore${l.d7.used == null ? "" : ` s-${l.d7.status}`}">${esc(foreText(l.d7))}</p>`, "");

export function fleetBodyHtml(v: FleetView): string {
  const history = `<button class="aslink" data-flopen="history" data-tip="Every session this machine has had">History ⤢</button>`;
  const colA = sec("Needs you", String(v.needs.length), "", v.needs.map(needRow).join(""),
      "Nothing is waiting on you.", v.needs.length ? "waiting" : "")
    + sec("Live now", String(v.live.length), "", v.live.map(liveRow).join(""), "No sessions running.")
    + (v.team ? sec("Team now", String(v.team.length), "", v.team.map(teamRow).join(""), "Nobody else has a session open.") : "")
    + sec("Pick back up", v.resumeWait ? "" : String(v.resume.length), history,
      v.resumeWait ? resumeSkel() : v.resume.map(resumeRow).join(""), "Nothing left open.");
  const colC = spendSec(v.usage) + modelSec(v.usage, v.tokenWait)
    + costSec(v.usage.projects) + limitsSec(v.limits);
  return `<div class="fl-cols">
    <div class="fl-col fl-col-a">${colA}</div>
    <div class="fl-col fl-col-b">${projectsSec(v)}</div>
    <div class="fl-col fl-col-c">${colC}</div></div>`;
}
