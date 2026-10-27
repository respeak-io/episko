// Maintenance's markup: data in, string out. ./maint decides what a fact means, ./maintui owns the
// clicks. Every attribute here is data-mt* (dispatch.test.ts holds the two halves), so a card can
// sit on the fleet and on the dashboard without joining either pane's own contract.

import { esc, escAttr, fmtDay, relTime } from "./format";
import { sk } from "./dashview"; // the one shimmer; ./dashview declares it, .db-sk styles it
import {
  FACET_TAB, MAINT_TABS, type Band, type Cell, type CoverRow, type Finding, type FlowRow, type Hygiene, type Kv, type Level,
  type MaintTab, type ProbeRow, type TabCount, type Verb,
} from "./maint";
import { disclosure, FACETS, facetDef, findSource, type Facet, type MaintCap } from "./maintsources";
import { checkState, FIX_TEXT, type Advisory as DepAdvisory, type DepPr, type DepTally } from "./deps";
import type { DeployCfg } from "./deploy";

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
/** A host row: `[deploy] host` joined to every project that names it. */
export interface MaintHostRow { host: string; projects: { root: string; name: string }[]; level: Level; text: string }
/** What *Check prod* would ask: projects with an address in `[deploy]`, and whether a check is out. */
export interface MaintProd { projects: number; checking: boolean }
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
  hosts: MaintHostRow[]; // hostRows' order, over the filter
  prod: MaintProd;
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
  "prod.status": "whether each [deploy] address answers", "prod.cert": "when its certificate expires",
  "prod.host": "the host itself: disk, updates, containers",
};

// Remote, so never part of a scan: the button names what leaves this machine (docs/maintenance.md).
const PROD_TIP = "Request each [deploy] address once, from this machine, and read its certificate. Nothing else connects";
function prodHtml(p: MaintProd, root?: string): string {
  if (!p.projects) return "";
  if (p.checking) return `<span class="fl-when mono">checking prod…</span>`;
  const n = root === undefined ? ` of ${plural(p.projects, "project")}` : "";
  return `<button class="aslink" data-mtprod="${escAttr(root ?? "")}" data-tip="${escAttr(PROD_TIP.replace("address", `address${n}`))}">Check prod</button>`;
}

// ---------- the head ----------

/** The fleet head's right-hand note: when this was last asked, and the one way to ask again. */
export function maintWhenHtml(v: MaintView): string {
  if (v.scanning) return `<span class="fl-when mono">checking every project…</span>`;
  if (!v.checked) {
    return `<span class="fl-when mono">Not checked this session</span>
      <button class="aslink" data-mtscan="check" data-tip="Read every project once. Nothing runs in them">Check</button>`;
  }
  return `<span class="fl-when mono">checked ${esc(relTime(v.checked))}</span>
    <button class="aslink" data-mtscan="force" data-tip="Check every project again, past every cache">⟳</button>${prodHtml(v.prod)}`;
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

// `go` is what a click does here: the fleet opens a tab, the dashboard scrolls to a card.
function cellHtml(c: Cell, card: MaintCard, go = `Click: ${TAB_TEXT[FACET_TAB[c.facet]][0]} for ${card.name}`): string {
  const label = facetDef(c.facet).label;
  const v = c.level === "unread"
    ? card.reading ? sk("54px", 9) : DASH
    : c.level === "ok" && !c.text ? `<i class="mt-dot" aria-label="healthy"></i>` : esc(c.text);
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

// A click-only check names what it runs, and a public one says what leaves the machine, on the row.
function runText(f: Finding): [string, string, string] {
  const d = findSource(f.source), said = d && disclosure(d);
  if (said) return [`Check with ${d.label}`, `${said} Asked once, now`, said];
  if (d?.cost === "tool") return [`Run ${d.label}`, `Run ${d.label} in this project once, on this machine`, f.detail];
  return [...VERB.run, f.detail];
}

// A tab's row names its project, and the name is that project's door, as a card's is.
function findingHtml(f: Finding, name?: string): string {
  const [label, tip, detail] = f.verb === "run" ? runText(f) : [...VERB[f.verb], f.detail];
  const who = name === undefined ? ""
    : `<span class="mt-rn" data-mtproj="${escAttr(f.root)}" data-mtname="${escAttr(name)}" data-tip="${escAttr(`Open ${name}`)}">${esc(name)}</span>`;
  return `<div class="mt-find l-${f.level}"><i class="mt-sev"></i>${who}
    <span class="t">${esc(f.text)}</span><span class="d mono">${esc(detail)}</span>
    ${f.busy ? `<span class="fl-when mono">running…</span>` : `<button class="mt-verb" data-mtverb="${escAttr(f.key)}"
      data-mtroot="${escAttr(f.root)}" data-tip="${escAttr(tip === "agent" ? AGENT_TIP : tip)}">${esc(label)}</button>`}</div>`;
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

// ---------- hosts ----------

// No host fact is read yet (that is ssh, later), so a row is its projects' Prod cells, the worst one.
function hostsHtml(hosts: readonly MaintHostRow[]): string {
  if (!hosts.length) return "";
  const rows = hosts.map((h) => {
    const v = h.level === "ok" && !h.text ? `<i class="mt-dot" aria-label="healthy"></i>` : esc(h.text);
    const runs = h.projects.map((p) => `<span class="mt-rn" data-mtproj="${escAttr(p.root)}" data-mtname="${escAttr(p.name)}"`
      + ` data-tip="${escAttr(`Open ${p.name}`)}">${esc(p.name)}</span>`).join(", ");
    const tip = `${h.host}: the worst Prod cell of the projects it runs. Disk, updates and containers are not read yet`;
    return `<div class="mt-host"><span class="hn mono" data-tip="${escAttr(tip)}">${esc(h.host)}</span>`
      + `<span class="hl">runs ${runs}</span><span class="mt-v ${LEVEL_CLS[h.level]}">${v}</span></div>`;
  }).join("");
  return `<section class="mt-sec mt-hosts"><div class="mt-sec-h label">Hosts</div>${rows}</section>`;
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
    + (sections || `<p class="fl-none">${esc(none)}</p>`) + (tab === "servers" ? hostsHtml(v.hosts) : "") + gaps;
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
    + `<div class="mt-cards">${html || `<p class="fl-none">Nothing in this group.</p>`}</div>`
    + (v.chip === "all" ? hostsHtml(v.hosts) : "") + `</div>`;
}

// ---------- the project dashboard's tab ----------

/** The Dependencies card: the dashboard's own deps read, which its ⤢ overlay shares. */
export interface MaintDeps {
  adv: DepAdvisory[]; prs: DepPr[]; tally: DepTally;
  scanned: boolean; // a package manager answered this visit
  tool: string | null; // what ⤢ would offer to run while nothing has been asked
  loading: boolean; reason: string;
}
export interface MaintDash {
  card: MaintCard; // the strip is the fleet card's cells: two zoom levels of one scan
  rows: Finding[]; // the card's lines and the rows only a tab shows
  checked: number; // this project's last finished scan (ms), 0 for none
  flows: { branch: string | null; rows: FlowRow[] }; release: Kv[];
  deps: MaintDeps | null; // null: nothing to say and nothing to offer (depSilent)
  hygiene: Hygiene | null; staleDays: number;
  cover: CoverRow[]; forge: string; unreadable: boolean;
  deploy: DeployCfg | null; detected: boolean; // `[deploy]`, once detection has answered
  probes: { at: number | null; rows: ProbeRow[] } | null; // null until Check prod answered
  prod: MaintProd;
}

/** Which card a cell scrolls to on the dashboard: its fleet tab's, by the same map. */
export const DASH_CARD: Record<MaintTab, [string, string]> = {
  delivery: ["delivery", "Delivery"], security: ["deps", "Dependencies"], code: ["git", "Git hygiene"],
  servers: ["runs", "Runs on"], work: ["todo", "To do"],
};

const across = (sub: MaintSub) => `<button class="aslink mt-across" data-mtacross="${sub}"`
  + ` data-tip="${escAttr(`${TAB_TEXT[sub][0]} across every project`)}">all projects</button>`;
const grow = (view: "deps" | "branches", tip: string) => `<button class="xb" data-mtview="${view}" data-tip="${escAttr(tip)}">⤢</button>`;
const dcard = (id: string, title: string, n: string, extra: string, body: string) =>
  `<section class="ac mt-dc" id="mtc-${id}"><div class="ac-h"><span class="t">${esc(title)}</span>`
  + `<span class="n">${esc(n)}</span>${extra}</div><div class="ac-b">${body}</div></section>`;
const kv = (k: string, v: string, cls = "") =>
  `<div class="mt-kv"><span>${esc(k)}</span><span class="mono${cls ? " " + cls : ""}">${esc(v)}</span></div>`;
// A card with nothing of its own to draw still says why, in its cell's words.
const said = (c: Cell | undefined) => c && c.level !== "unread"
  ? `<p class="ac-empty">${esc(c.text || (c.level === "ok" ? "nothing to report" : "not read"))}</p>`
  : `<p class="ac-empty">${sk("62%", 9)}</p>`;
const cellOf = (v: MaintDash, f: Facet) => v.card.cells.find((c) => c.facet === f);

function todoCard(v: MaintDash): string {
  const read = v.card.cells.filter((c) => c.state === "read" && c.level !== "muted").length;
  const none = v.card.band === "unread" ? (v.card.reading ? "Reading this project…" : "Not checked yet.")
    : `Nothing to do in the ${plural(read, "facet")} that could be read${read < FACETS.length ? "; Coverage says what could not" : ""}.`;
  const body = v.rows.length
    ? `<div class="mt-finds">${v.rows.map((f) => findingHtml(f)).join("")}</div>` : `<p class="ac-empty">${esc(none)}</p>`;
  return dcard("todo", "To do", v.rows.length ? String(v.rows.length) : "", across("overview"), body);
}

const FLOW_TEXT: Partial<Record<FlowRow["status"], string>> = { pass: "✓", skip: "skipped" };
function flowHtml(r: FlowRow): string {
  const ago = r.at ? relTime(r.at * 1000) : "";
  const v = r.red !== null ? `✕ ${r.red}`.trim() : `${FLOW_TEXT[r.status] ?? r.status} ${ago}`.trim();
  const strip = r.runs.map((x) => `<i class="${x === "fail" ? "l-bad" : x === "pass" ? "l-ok" : ""}"></i>`).join("");
  return `<div class="mt-flow"><span class="w">${esc(r.workflow)}</span>`
    + `<span class="mt-v ${r.red !== null ? "l-bad" : "l-ok"}">${esc(v)}</span><span class="mt-runs" aria-hidden="true">${strip}</span></div>`;
}

function deliveryCard(v: MaintDash): string {
  const ci = v.flows.rows.length ? v.flows.rows.map(flowHtml).join("") : said(cellOf(v, "ci"));
  const rel = v.release.length ? v.release.map((x) => kv(x.k, x.v)).join("") : said(cellOf(v, "release"));
  return dcard("delivery", "Delivery", v.flows.branch ? `on ${v.flows.branch}` : "", across("delivery"), ci + rel);
}

const SEV_CLS: Record<string, string> = { critical: "l-bad", high: "l-bad", medium: "l-warn" };
function depsCard(d: MaintDeps): string {
  const t = d.tally;
  const n = t.critical || t.high ? [t.critical && `${t.critical} critical`, t.high && `${t.high} high`].filter(Boolean).join(" · ")
    : t.vulns ? plural(t.vulns, "advisory", "advisories") : t.prs ? plural(t.prs, "update PR")
    : d.scanned ? `${t.outdated} out of date` : "nothing open";
  const advs = d.adv.slice(0, 4).map((a) => {
    const pkgs = a.alerts.map((x) => x.pkg);
    return `<div class="mt-li"><i class="mt-sev ${SEV_CLS[a.severity] ?? ""}"></i>`
      + `<span class="t">${esc(pkgs.slice(0, 2).join(", "))}${pkgs.length > 2 ? ` +${pkgs.length - 2}` : ""}</span>`
      + `<span class="d mono">${esc([FIX_TEXT[a.worst], a.summary].join(" · "))}</span></div>`;
  }).join("") + (d.adv.length > 4 ? `<p class="ac-empty">+ ${esc(plural(d.adv.length - 4, "more advisory", "more advisories"))}</p>` : "");
  const red = d.prs.filter((p) => checkState(p) === "failing").length;
  const prs = d.prs.length
    ? kv("Update pull requests", [`${d.prs.length} open`, t.ready && `${t.ready} ready`, red && `${red} failing`].filter(Boolean).join(" · "), red ? "l-warn" : "")
    : "";
  const out = d.scanned ? kv("Out of date", String(t.outdated)) : d.tool ? kv("Out of date", `not checked · ⤢ runs ${d.tool}`) : "";
  const why = d.reason ? `<p class="ac-empty">${esc(d.reason)}</p>` : "";
  const body = d.loading && !d.adv.length && !d.prs.length ? `<p class="ac-empty">${sk("70%", 9)}</p>` : advs + prs + out + why;
  return dcard("deps", "Dependencies", n, grow("deps", "Every advisory, update pull request and out-of-date package") + across("security"), body);
}

function gitCard(v: MaintDash): string {
  const h = v.hygiene;
  const body = !h ? said(cellOf(v, "git")) : [
    kv("Commits only on this machine", h.unpushed === null ? "unknown: no remote" : String(h.unpushed), h.unpushed ? "l-warn" : ""),
    kv("Branches only here", String(h.localOnly.length), h.localOnly.length ? "l-warn" : ""),
    kv(`Merged into ${h.trunk ?? "the trunk"}`, String(h.merged.length)),
    kv("Upstream gone", String(h.gone.length)),
    kv(`Untouched ${v.staleDays}d+`, String(h.stale.length)),
    kv(`Worktrees idle ${v.staleDays}d+`, String(h.idle)),
    h.fetchedAt ? kv("Last fetch", relTime(h.fetchedAt * 1000)) : "",
  ].join("");
  return dcard("git", "Git hygiene", h?.trunk ? `against ${h.trunk}` : "",
    grow("branches", "Open Branches, where merged branches are swept") + across("code"), body);
}

// The doors are the project settings row's: an agent proposes, a person applies, the file is git's.
function runsCard(v: MaintDash): string {
  const d = v.deploy;
  const door = (what: "propose" | "file", label: string, tip: string) =>
    `<button class="aslink" data-mtdeploy="${what}" data-mtroot="${escAttr(v.card.path)}" data-tip="${escAttr(tip)}">${esc(label)}</button>`;
  const ask = door("propose", d ? "Re-check…" : "Propose with an agent",
    "Claude reads the deploy scripts, compose files and CI in the background, read-only, and proposes [deploy] for you to apply or discard");
  // A failed detection is not a loading one: say so, and keep the door the card exists for.
  if (!v.detected) {
    return dcard("runs", "Runs on", "", across("servers"), v.card.err && !v.card.reading
      ? `<p class="ac-empty">Could not read this project, so its [deploy] table is unknown.</p><p class="ac-empty">${ask}</p>`
      : said(undefined));
  }
  if (!d) {
    return dcard("runs", "Runs on", "", across("servers"),
      `<p class="ac-empty">No [deploy] table, so Episko does not know where this project runs.</p><p class="ac-empty">${ask}</p>`);
  }
  // An address shows its last answer once one exists; until then it is the table's value.
  const probe = (n: string | null, u: string) => v.probes?.rows.find((r) => (n === null || r.name === n) && r.url === u);
  const addr = (n: string | null, u: string, label = n ?? u) => {
    const p = probe(n, u);
    return p ? probeHtml(label, p) : kv(label, u);
  };
  const named = Object.entries(d.urls);
  // DeployConfig::targets asks a version_url that is also a named url once, under that name.
  const versionName = named.some(([, u]) => u === d.versionUrl) ? null : named.some(([n]) => n === "version") ? "version_url" : "version";
  const rows = [
    d.host ? kv("Host", `${d.host} · ssh alias`) : "",
    d.compose.length ? kv("Compose", d.compose.join(", ")) : "",
    ...named.map(([n, u]) => addr(n, u)),
    d.sentry ? kv("Errors", d.sentry) : "",
    d.versionUrl ? addr(versionName, d.versionUrl, "Version from") : "",
  ].join("");
  const checked = !v.prod.projects ? "" : v.prod.checking ? "" : v.probes?.at ? ` · checked ${relTime(v.probes.at * 1000)}` : " · never checked";
  const doors = [prodHtml(v.prod, v.card.path), door("file", "Open file", "Open .episko/episko.toml"), ask].filter(Boolean).join(" · ");
  return dcard("runs", "Runs on", "from [deploy]", across("servers"),
    rows + `<p class="ac-empty">Nothing connects until you ask${esc(checked)}. ${doors}</p>`);
}

function probeHtml(label: string, p: ProbeRow): string {
  const tip = [p.url, p.err].filter(Boolean).join("\n");
  return `<div class="mt-probe" data-tip="${escAttr(tip)}"><span class="k">${esc(label)}</span><span class="u mono">${esc(p.url)}</span>`
    + `<span class="mt-v ${LEVEL_CLS[p.level]}">${esc(p.status)}</span>`
    + `<span class="mt-v ${LEVEL_CLS[p.certLevel]}">${esc(p.cert)}</span></div>`;
}

// Amber only where a fix exists or a read broke; every other state is a fact, muted.
const COVER_CLS: Partial<Record<CoverRow["state"], string>> = { noAccess: "l-warn", noTool: "l-warn", error: "l-warn" };
function coverCard(v: MaintDash): string {
  const head = v.unreadable
    ? `<p class="ac-empty">.episko/episko.toml does not parse, so its [maintenance] settings are not applied.</p>` : "";
  const rows = v.cover.map((r) => `<div class="mt-cov"><span class="fk">${esc(facetDef(r.facet).label)}</span><span class="s">${esc(r.label)}</span>`
    + `<span class="mt-v ${COVER_CLS[r.state] ?? "l-muted"}">${esc(r.state === "ok" ? "read" : r.text)}</span></div>`
    + (r.fix ? `<code class="mt-fix">${esc(r.fix)}</code>` : "")).join("");
  return dcard("cover", "Coverage", v.forge, "", head + (rows || said(undefined)));
}

/** The dashboard's Maintenance tab: the fleet card's strip, its lines, and a card per question. */
export function maintDashHtml(v: MaintDash): string {
  const go = (c: Cell) => `Click: the ${DASH_CARD[FACET_TAB[c.facet]][1]} card`;
  const when = v.card.reading ? `<span class="fl-when mono">reading this project…</span>`
    : v.checked ? `<span class="fl-when mono">checked ${esc(relTime(v.checked))}</span>`
      + `<button class="aslink" data-mtscan="force" data-tip="Check this project again, past every cache">⟳</button>`
    : `<span class="fl-when mono">Not checked yet</span>`
      + `<button class="aslink" data-mtscan="check" data-tip="Read this project once. Nothing runs in it">Check</button>`;
  const err = v.card.err ? `<p class="fl-none">Could not read: ${esc(v.card.err)}</p>` : "";
  return `<div class="mt-dhead"><div class="mt-cells">${v.card.cells.map((c) => cellHtml(c, v.card, go(c))).join("")}</div>`
    + `<div class="mt-dwhen">${when}</div></div>${err}`
    + `<div class="mt-dgrid"><div class="mt-dcol">${todoCard(v)}${deliveryCard(v)}${v.deps ? depsCard(v.deps) : ""}</div>`
    + `<div class="mt-dcol">${runsCard(v)}${gitCard(v)}${coverCard(v)}</div></div>`;
}
