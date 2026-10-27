// Maintenance's markup: data in, string out. ./maint decides what a fact means, ./maintui owns the
// clicks. Every attribute here is data-mt* (dispatch.test.ts holds the two halves), so a card can
// sit on the fleet and on the dashboard without joining either pane's own contract.

import { esc, escAttr, fmtDay, relTime } from "./format";
import { sk } from "./dashview"; // the one shimmer; ./dashview declares it, .db-sk styles it
import { FACET_TAB, MAINT_TABS, type Band, type Cell, type Finding, type Level, type MaintTab, type TabCount, type Verb } from "./maint";
import { FACETS, facetDef, type Facet, type MaintCap } from "./maintsources";

export const MAINT_CHIPS = ["all", "needs", "drifting", "quiet"] as const;
export type MaintChip = (typeof MAINT_CHIPS)[number];
export const MAINT_SUBS = ["overview", ...MAINT_TABS] as const;
export type MaintSub = (typeof MAINT_SUBS)[number];

/** One project's card. `sub` is the host's wording (where it lives, or why nothing is known). */
export interface MaintCard {
  path: string; name: string; accent: string; icon: string | null; sub: string;
  cells: Cell[]; findings: Finding[]; band: Band;
  reading: boolean; // a read is still out: only then is an unread cell a shimmer rather than a dash
  err: string | null;
}
export interface MaintTally { needs: number; drifting: number; quiet: number; unread: number; cantCheck: number }
export interface MaintSoon { name: string; what: string; at: number } // at: unix secs
export interface MaintView {
  cards: MaintCard[]; // rankMaint's order
  chip: MaintChip; quietOpen: boolean;
  checked: number; // the last finished sweep this session (ms), 0 for none
  scanning: boolean;
  tally: MaintTally;
  sees: MaintCap[]; blind: MaintCap[]; // what the sources that answered can and cannot see
  soon: MaintSoon[];
  sub: MaintSub;
  filter: { root: string; name: string } | null; // a tab narrowed to one project, from a cell
  tabs: Record<MaintTab, TabCount>; // over the filter, so a narrowed tab bar says where that project stands
  rows: MaintRow[]; // the open tab's, in tabRows' order
  read: number; // projects the open tab reached a verdict on
  unset: number; // projects with none of it set up: a fact, not a gap
  gaps: MaintGap[]; // its cells that do not know, so an empty tab never reads as clear
}
export type MaintRow = Finding & { name: string };
export interface MaintGap { name: string; facet: Facet; text: string }

const DASH = `<span class="dim">—</span>`;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// A record over the closed vocabulary, so a new capability fails to compile until it has words.
const CAP_TEXT: Record<MaintCap, string> = {
  "ci.default-branch": "CI on the default branch", "ci.per-workflow": "each workflow's newest run",
  "ci.failing-since": "how long a workflow has been failing", "ci.disabled": "disabled workflows",
  "ci.external": "statuses other CIs report", "ci.other-branches": "CI on other branches",
  "git.unpushed": "unpushed commits", "git.local-only": "branches only on this machine",
  "git.merged": "merged branches", "git.gone": "branches whose upstream is gone", "git.branch-age": "branch ages",
  "git.worktree-age": "idle worktrees", "git.squash-merged": "squash-merged branches",
  "rel.unreleased": "unreleased commits", "rel.last": "the last release tag", "rel.published": "published releases",
  "rel.changelog": "the changelog's Unreleased section",
  "sec.dependency": "advisories in dependencies", "sec.code": "code scanning findings", "sec.secret": "committed secrets",
  "deps.update-prs": "open update pull requests", "deps.pr-checks": "the checks on each update pull request",
  "work.issues": "open issues", "work.prs": "open pull requests", "work.review-requested": "reviews requested of you",
};

// ---------- the head ----------

/** The fleet head's right-hand note: when this was last asked, and the one way to ask again. */
export function maintWhenHtml(v: MaintView): string {
  if (v.scanning) return `<span class="fl-when mono">checking every project…</span>`;
  if (!v.checked) {
    return `<span class="fl-when mono">Not checked this session</span>
      <button class="aslink" data-mtscan="check" data-tip="Read every project once. Nothing runs in them">Check</button>`;
  }
  return `<span class="fl-when mono">checked ${esc(relTime(v.checked))}</span>
    <button class="aslink" data-mtscan="force" data-tip="Check every project again, past every cache">⟳</button>`;
}

const tile = (label: string, value: string, sub: string, cls = "") =>
  `<div class="fl-tile"><span class="label">${esc(label)}</span>
    <span class="v${cls ? " " + cls : ""}">${value}</span><span class="sub">${esc(sub)}</span></div>`;

// Colour only for what needs you: red and amber are the two tiles allowed to light.
export function maintTilesHtml(v: MaintView): string {
  const t = v.tally, known = v.checked > 0 || v.cards.length > 0;
  const n = (x: number) => known ? String(x) : DASH;
  return `<div class="fl-tiles">`
    + tile("Needs you", n(t.needs), t.needs ? "something is broken" : "nothing broken", t.needs ? "s-bad" : "")
    + tile("Drifting", n(t.drifting), t.drifting ? "going stale" : "nothing going stale", t.drifting ? "s-warn" : "")
    + tile("Quiet", n(t.quiet), "nothing to do")
    + tile("Can't check", n(t.cantCheck), "facets nothing here can read yet")
    + `</div>`;
}

// ---------- a card ----------

const LEVEL_CLS: Record<Level, string> = { bad: "l-bad", warn: "l-warn", info: "l-info", ok: "l-ok", muted: "l-muted", unread: "l-unread" };

function cellHtml(c: Cell, card: MaintCard): string {
  const label = facetDef(c.facet).label;
  const v = c.level === "unread"
    ? card.reading ? sk("54px", 9) : DASH
    : c.level === "ok" && !c.text ? `<i class="mt-dot" aria-label="healthy"></i>` : esc(c.text);
  const go = `Click: ${TAB_TEXT[FACET_TAB[c.facet]][0]} for ${card.name}`;
  const tip = [label, ...c.tip, ...(c.fix ? [`fix: ${c.fix}`] : []), go].join("\n");
  return `<button class="mt-cell" data-mtcell="${c.facet}" data-mtroot="${escAttr(card.path)}" data-tip="${escAttr(tip)}">`
    + `<span class="fk">${esc(label)}</span><span class="mt-v ${LEVEL_CLS[c.level]}">${v}</span></button>`;
}

const VERB: Record<Verb, [string, string]> = {
  fix: ["Fix ↗", "agent"], patch: ["Patch ↗", "agent"], rotate: ["Rotate ↗", "agent"], release: ["Draft release ↗", "agent"],
  push: ["Push ↗", "agent"], tidy: ["Tidy ↗", "agent"], setup: ["Set up ↗", "agent"],
  review: ["Review", "Open this project to review them"],
  fetch: ["Fetch", "git fetch here, then check this project again"],
  run: ["Run", "Run this check once, on this machine"],
};
const AGENT_TIP = "Start an agent with a brief written from these facts. It is prefilled, never sent: you press Enter";

// A tab's row names its project, and the name is that project's door, as a card's is.
function findingHtml(f: Finding, name?: string): string {
  const [label, tip] = VERB[f.verb];
  const who = name === undefined ? ""
    : `<span class="mt-rn" data-mtproj="${escAttr(f.root)}" data-mtname="${escAttr(name)}" data-tip="${escAttr(`Open ${name}`)}">${esc(name)}</span>`;
  return `<div class="mt-find l-${f.level}"><i class="mt-sev"></i>${who}
    <span class="t">${esc(f.text)}</span><span class="d mono">${esc(f.detail)}</span>
    <button class="mt-verb" data-mtverb="${escAttr(f.key)}" data-mtroot="${escAttr(f.root)}"
      data-tip="${escAttr(tip === "agent" ? AGENT_TIP : tip)}">${esc(label)}</button></div>`;
}

const avatar = (c: MaintCard) => c.icon
  ? `<span class="fc-av"><img class="picon" src="${escAttr(c.icon)}" alt="" /></span>`
  : `<span class="fc-av" style="background:${escAttr(c.accent)}">${esc(c.name.slice(0, 1))}</span>`;

// The name opens the project; a cell opens its facet's tab narrowed to this project.
function cardHtml(c: MaintCard, compact: boolean): string {
  const sub = c.err ? `could not read: ${c.err}` : c.sub;
  const id = `<div class="mt-id" data-mtproj="${escAttr(c.path)}" data-mtname="${escAttr(c.name)}"
      data-tip="${escAttr(`Open ${c.name}`)}">${avatar(c)}<span class="mt-nm">${esc(c.name)}</span>
      <span class="mt-sub mono">${esc(sub)}</span></div>`;
  const cells = `<div class="mt-cells">${c.cells.map((x) => cellHtml(x, c)).join("")}</div>`;
  const finds = !compact && c.findings.length
    ? `<div class="mt-finds">${c.findings.map((f) => findingHtml(f)).join("")}</div>` : "";
  return `<article class="mt-card b-${c.band}${compact ? " quiet" : ""}">${id}${cells}${finds}</article>`;
}

// ---------- the body ----------

const CHIP_TEXT: Record<MaintChip, [string, string]> = {
  all: ["All", "Every project"], needs: ["Needs you", "Something is broken"],
  drifting: ["Drifting", "Going stale, nothing broken yet"], quiet: ["Quiet", "Nothing to do"],
};
function chipsHtml(v: MaintView): string {
  const count: Record<MaintChip, number> = { all: v.cards.length, needs: v.tally.needs, drifting: v.tally.drifting, quiet: v.tally.quiet };
  return `<div class="qchips">` + MAINT_CHIPS.map((id) => {
    const off = id !== "all" && !count[id];
    const dot = id === "needs" || id === "drifting" ? `<i class="mt-sev ${id === "needs" ? "l-bad" : "l-warn"}"></i>` : "";
    return `<button class="qchip mt-chip${id === v.chip ? " on" : ""}${off ? " off" : ""}"${off ? ` aria-disabled="true"` : ""}`
      + ` data-mtchip="${id}" data-tip="${escAttr(CHIP_TEXT[id][1])}">${dot}${esc(CHIP_TEXT[id][0])} ${count[id]}</button>`;
  }).join("") + `</div>`;
}

// What was covered says as much as what was found: an all-clear over two facets is not one over seven.
function clearHtml(v: MaintView): string {
  const soon = v.soon.length
    ? v.soon.map((s) => `<span>${esc(s.what)} · ${esc(s.name)} <em class="mono">${esc(fmtDay(s.at * 1000))}</em></span>`).join("")
    : `<span>nothing in the next 30 days</span>`;
  const list = (caps: MaintCap[]) => caps.map((k) => CAP_TEXT[k]).join(", ");
  return `<div class="mt-clear"><div class="mt-clear-h"><span class="mt-ring">✓</span><div>
      <b>Nothing needs you</b><p>${esc(plural(v.cards.length, "project"))} checked ${esc(relTime(v.checked))}.</p></div></div>
    ${v.sees.length ? `<div class="mt-soon"><span class="label">Covered</span><span>${esc(list(v.sees))}</span></div>` : ""}
    ${v.blind.length ? `<div class="mt-soon"><span class="label">Not covered</span><span>${esc(list(v.blind))}</span></div>` : ""}
    <div class="mt-soon"><span class="label">Coming up</span>${soon}</div></div>`;
}

// ---------- the tabs ----------

const TAB_TEXT: Record<MaintSub, [string, string]> = {
  overview: ["Overview", "One card per project, worst first"],
  security: ["Security", "Advisories, scanner findings and update pull requests, across every project"],
  delivery: ["Delivery", "CI on the default branch and unreleased work, across every project"],
  code: ["Code", "Unpushed work, branches to tidy and stale fetches, across every project"],
  servers: ["Servers", "Where the projects run and whether it answers, across every project"],
  work: ["Work", "Open issues, pull requests and reviews waiting on you, across every project"],
};
const SECTION: Record<Facet, string> = {
  ci: "CI on the default branch", release: "Unreleased work", security: "Advisories and findings",
  deps: "Update pull requests", git: "Branches and pushes", prod: "Endpoints", work: "Open work",
};

// Only red and amber light a count; everything else stays muted, as on the cards.
function tabsHtml(v: MaintView): string {
  return `<div class="bvtabs mt-tabs" role="tablist">` + MAINT_SUBS.map((id) => {
    const c = id === "overview" ? null : v.tabs[id];
    const n = c?.n ? `<span class="n${c.level === "bad" ? " l-bad" : c.level === "warn" ? " l-warn" : ""}">${c.n}</span>` : "";
    return `<button class="bvtab${id === v.sub ? " on" : ""}" role="tab" aria-selected="${id === v.sub}" data-mttab="${id}"`
      + ` data-tip="${escAttr(TAB_TEXT[id][1])}">${esc(TAB_TEXT[id][0])}${n}</button>`;
  }).join("") + `</div>`;
}

function tabHtml(v: MaintView, tab: MaintTab): string {
  const label = TAB_TEXT[tab][0];
  const only = v.filter
    ? `<span class="mt-only">only <b>${esc(v.filter.name)}</b><button class="mt-x" data-mtclear="${tab}"`
      + ` data-tip="Every project again (Esc)" aria-label="Show every project">✕</button></span>` : "";
  const sections = FACETS.filter((f) => FACET_TAB[f] === tab).flatMap((f) => {
    const rows = v.rows.filter((r) => r.facet === f);
    return rows.length ? [`<section class="mt-sec"><div class="mt-sec-h label">${esc(SECTION[f])}</div>`
      + `<div class="mt-finds">${rows.map((r) => findingHtml(r, v.filter ? undefined : r.name)).join("")}</div></section>`] : [];
  }).join("");
  const none = v.read ? (v.filter ? `Nothing to do in ${label} for ${v.filter.name}.` : `Nothing to do in ${label}: ${plural(v.read, "project")} read.`)
    : v.unset ? (v.filter ? `${v.filter.name} has nothing in ${label} set up.` : `Nothing to check in ${label}: ${plural(v.unset, "project")} with none set up.`)
    : `Nothing in ${label} could be read${v.filter ? ` for ${v.filter.name}` : ""}.`;
  const gaps = v.gaps.length
    ? `<div class="mt-soon mt-gaps"><span class="label">Not read</span>${v.gaps.map((g) =>
      `<span>${esc(v.filter ? facetDef(g.facet).label : `${g.name} · ${facetDef(g.facet).label}`)} <em class="mono">${esc(g.text)}</em></span>`).join("")}</div>` : "";
  return (only ? `<div class="mt-top">${only}</div>` : "")
    + (sections || `<p class="fl-none">${esc(none)}</p>`) + gaps;
}

export function maintBodyHtml(v: MaintView): string {
  const bar = tabsHtml(v);
  if (!v.cards.length) {
    const why = v.scanning ? "Reading every project…"
      : "Not checked this session. Check reads every project once; nothing runs in them, and the answer stays until you check again.";
    return `<div class="mt-body">${bar}<p class="fl-none">${esc(why)}</p>${v.scanning ? ""
      : `<button class="aslink" data-mtscan="check">Check every project</button>`}</div>`;
  }
  if (v.sub !== "overview") return `<div class="mt-body">${bar}${tabHtml(v, v.sub)}</div>`;
  const quiet = v.cards.filter((c) => c.band === "quiet");
  const shown = v.chip === "all" ? v.cards.filter((c) => c.band !== "quiet")
    : v.chip === "quiet" ? quiet : v.cards.filter((c) => c.band === v.chip);
  const allClear = !v.scanning && v.checked > 0 && !v.tally.needs && !v.tally.drifting && !v.tally.unread;
  let html = shown.map((c) => cardHtml(c, c.band === "quiet")).join("");
  if (v.chip === "all" && quiet.length) {
    const names = quiet.slice(0, 5).map((c) => c.name).join(", ") + (quiet.length > 5 ? " …" : "");
    html += v.quietOpen
      ? quiet.map((c) => cardHtml(c, true)).join("")
        + `<button class="mt-fold" data-mtfold="0">Fold the ${esc(plural(quiet.length, "quiet project"))}</button>`
      : `<button class="mt-fold" data-mtfold="1">+ ${esc(plural(quiet.length, "quiet project"))}, nothing to do · ${esc(names)}</button>`;
  }
  return `<div class="mt-body">${bar}<div class="mt-top">${chipsHtml(v)}</div>`
    + (allClear && v.chip === "all" ? clearHtml(v) : "")
    + `<div class="mt-cards">${html || `<p class="fl-none">Nothing in this group.</p>`}</div></div>`;
}
