// Maintenance's markup: data in, string out. ./maint decides what a fact means, ./maintui owns the
// clicks. Every attribute here is data-mt* (dispatch.test.ts holds the two halves), so a card can
// sit on the fleet and on the dashboard without joining either pane's own contract.

import { esc, escAttr, fmtDay, relTime } from "./format";
import { sk } from "./dashview"; // the one shimmer; ./dashview declares it, .db-sk styles it
import {
  advFix, boardDoor, CI_STRIP as CI_RUNS, coverFirst, FACET_TAB, findingTarget, MAINT_TABS, needsCount, peekNames, rtName, span, type AdvRow, type Band,
  type BoardCol, type BoardId, type Boards, type Cell, type CiBoardRow, type CiStatus, type CoverGroup, type CoverRow, type Door, type Finding, type FlowRow, type HygCount,
  type Level, type MaintSnap, type MaintTab, type ProbeRow, type RelRow, type RunDot, type SevBucket, type SnapFinding, type TabModel, type Verb,
} from "./maint";
import { BRANCH_FILTERS } from "./branches";
import { disclosure, FACETS, facetDef, findSource, type Facet, type MaintCap } from "./maintsources";
import type { DeployCfg } from "./deploy";
import { icon } from "./svgicons";

export const MAINT_CHIPS = ["all", "needs", "drifting", "quiet"] as const;
export type MaintChip = (typeof MAINT_CHIPS)[number];
export const MAINT_SUBS = ["overview", ...MAINT_TABS] as const;
export type MaintSub = (typeof MAINT_SUBS)[number];

/** One project's card. `sub` is the host's wording (where it lives, or why nothing is known). */
export interface MaintCard {
  path: string; name: string; accent: string; icon: string | null; sub: string;
  cells: Cell[]; findings: Finding[]; band: Band;
  reading: boolean; // a read is still out: only then is an unread cell a shimmer rather than a dash
  stale: boolean; // drawn from an earlier answer while it is re-read: dimmed until the new one lands
  err: string | null;
  past?: MaintSnap; // drawn from the last boot's snapshot: muted, as of then, its lines verb-less
}
export interface MaintTally { needs: number; drifting: number; quiet: number; unread: number; cantCheck: number }
export interface MaintSoon { name: string; what: string; at: number } // at: unix secs
/** A host row: `[deploy] host` joined to every project that names it. */
export interface MaintHostRow { host: string; projects: { root: string; name: string }[]; level: Level; text: string }
/** What *Check prod* would ask: projects with an address in `[deploy]`, and whether a check is out. */
export interface MaintProd { projects: number; checking: boolean }
/** A tab as the fleet and a project's dashboard both draw it: ./maint's TabModel and its host's chrome. */
export interface MaintTabView extends TabModel {
  sub: MaintSub;
  filter: { root: string; name: string } | null; // a tab narrowed to one project, from a cell or the picker
  hosts: MaintHostRow[]; // hostRows' order, over the filter
  prod: MaintProd;
  sev: SevBucket | null; // the Security strip's pick
  names: Record<string, string>; // every root's project name
  dash?: MaintDashExtra; // the dashboard's: one project for good, so no picker, and its own reads
}
/** What only the dashboard knows: its dependency read, which no Maintenance source carries. */
export interface MaintDashExtra {
  outdated: string | null; // ./maint outdatedText: drawn beside the ⤢ that runs it
  deps: boolean; // the dependency read has something to say, so Security carries the overlay's ⤢
  fixes: Record<string, string>; // an advisory id's fix verdict, upper-case keys
}
export interface MaintView extends MaintTabView {
  cards: MaintCard[]; // rankMaint's order
  chip: MaintChip; quietOpen: boolean;
  checked: number; // the last finished sweep this session (ms), 0 for none
  kept: number; // the newest of the last session's scans painted at boot (ms), 0 for none
  scanning: boolean;
  tally: MaintTally;
  sees: MaintCap[]; blind: MaintCap[]; // what the sources that answered can and cannot see
  soon: MaintSoon[];
}

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
  "sec.runtime": "runtimes at their end of life",
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
  if (v.scanning) return `<span class="fl-when mono">${v.cards.some((c) => c.stale) ? "refreshing every project…" : "checking every project…"}</span>`;
  if (!v.checked) {
    return `<span class="fl-when mono">${v.kept ? `as of ${esc(relTime(v.kept))}` : "Not checked this session"}</span>
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
  const t = v.tally, known = v.checked > 0 || v.cards.some((c) => !c.past);
  const n = (x: number) => known ? String(x) : DASH;
  // A zero over unread projects is not an all-clear, the rule `allClear` keeps below.
  const unread = t.unread ? `${plural(t.unread, "project")} not checked` : "";
  return `<div class="fl-tiles">`
    + tile("Needs you", n(t.needs), t.needs ? "something is broken" : unread || "nothing broken", t.needs ? "s-bad" : "")
    + tile("Drifting", n(t.drifting), t.drifting ? "going stale" : unread || "nothing going stale", t.drifting ? "s-warn" : "")
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
  fix: ["Fix ↗", "agent"], patch: ["Patch ↗", "agent"], rotate: ["Rotate ↗", "agent"], upgrade: ["Upgrade ↗", "agent"],
  release: ["Draft release ↗", "agent"],
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

const verbText = (f: Finding): [string, string, string] => f.verb === "run" ? runText(f) : [...VERB[f.verb], f.detail];
// `why` says what the verb covers where a row shows less than its line does.
function verbHtml(f: Finding, why = ""): string {
  const [label, tip] = verbText(f), said = tip === "agent" ? AGENT_TIP : tip;
  return f.busy ? `<span class="fl-when mono">running…</span>` : `<button class="mt-verb" data-mtverb="${escAttr(f.key)}"
      data-mtroot="${escAttr(f.root)}" data-tip="${escAttr(why ? `${why}
${said}` : said)}">${esc(label)}</button>`;
}

// A project's name is its door, wherever it is drawn.
const projHtml = (root: string, name: string) =>
  `<span class="mt-rn" data-mtproj="${escAttr(root)}" data-mtname="${escAttr(name)}" data-tip="${escAttr(`Open ${name}`)}">${esc(name)}</span>`;

// A card line opens what it summarises: its tab, narrowed to the project, at the board that counts it.
const goAttrs = (facet: Facet, key: string, root: string) =>
  ` data-mtfind="${facet}" data-mtkey="${escAttr(key)}" data-mtroot="${escAttr(root)}"`
  + ` data-tip="${escAttr(`Open in ${TAB_TEXT[findingTarget({ facet, key }).tab][0]}`)}"`;

// A tab's row names its project, and the name is that project's door, as a card's is.
function findingHtml(f: Finding, name?: string, go = false): string {
  const detail = verbText(f)[2];
  const who = name === undefined ? "" : projHtml(f.root, name);
  return `<div class="mt-find l-${f.level}${go ? " go" : ""}"${go ? goAttrs(f.facet, f.key, f.root) : ""}><i class="mt-sev"></i>${who}
    <span class="t"${go ? ` tabindex="0" role="button"` : ""}>${esc(f.text)}</span><span class="d mono">${esc(detail)}</span>
    ${verbHtml(f)}</div>`;
}

// A fix is the command itself, copied rather than retyped; a forge switch is its settings page.
const copyHtml = (fix: string) => `<code class="mt-fix">${esc(fix)}</code><button class="aslink" data-mtcopy="${escAttr(fix)}"`
  + ` data-tip="Copy the command">Copy</button>`;
const settingsHtml = (url: string, label = "Settings ↗") =>
  `<button class="aslink" data-mturl="${escAttr(url)}" data-tip="${escAttr(`Open ${url}`)}">${esc(label)}</button>`;

// Across projects a name is that project's door, or its settings page when the fix is a forge switch.
const SHOWN = 8;
function namesHtml(v: MaintTabView, g: CoverGroup): string {
  const urls = g.action?.kind === "settings" ? g.action.urls : {};
  const one = (r: string) => urls[r] ? settingsHtml(urls[r], `${nameOf(v, r)} ↗`) : projHtml(r, nameOf(v, r));
  const rest = g.roots.slice(SHOWN).map((r) => nameOf(v, r));
  return g.roots.slice(0, SHOWN).map(one).join(", ")
    + (rest.length ? ` <span class="dim" data-tip="${escAttr(rest.join(", "))}">+${rest.length}</span>` : "");
}

// Offers and forge switches are not findings: one row per reason, however many projects share it.
// Across projects a click-only source only counts, since nine audits at once is not a click to offer.
const OFFER_TIP = "Runs only when asked, one project at a time: from its Coverage card, or this tab narrowed to it";
// What a [maintenance] key would answer: an agent proposes it, or a person edits the file.
const setupHtml = (root: string) => [["propose", "Propose with an agent",
  "Claude reads the repository in the background, read-only, and proposes [maintenance]'s trunk, tag pattern, SARIF paths and bots for you to apply or discard"],
["file", "Open file", "Open .episko/episko.toml"]].map(([what, label, tip]) =>
  `<button class="aslink" data-mtcfg="${what}" data-mtroot="${escAttr(root)}" data-tip="${escAttr(tip)}">${esc(label)}</button>`).join(" · ");

function coverHtml(v: MaintTabView): string {
  if (!v.cover.length) return "";
  const one = !!v.filter;
  const rows = v.cover.map((g) => {
    const a = g.action, offer = a?.kind === "run" ? v.offers.find((o) => o.source === a.source) : undefined;
    const d = a?.kind === "run" ? findSource(a.source) : undefined, said = d && disclosure(d);
    const setup = one && g.source ? v.setups.find((x) => x.source === g.source) : undefined;
    const act = (a?.kind === "fix" ? copyHtml(a.fix)
      : a?.kind === "settings" && one ? settingsHtml(Object.values(a.urls)[0])
      : offer && one ? verbHtml(offer) : "")
      + (setup ? verbHtml(setup) : "") + (one && v.dash && g.cfg ? setupHtml(g.roots[0]) : "");
    const where = one ? "" : `<span class="p">${esc(plural(g.roots.length, "project"))}: ${namesHtml(v, g)}</span>`;
    const tip = [g.detail, a?.kind === "run" && !one ? OFFER_TIP : "", said ?? ""].filter(Boolean).join("\n");
    return `<div class="mt-cv${g.quiet ? " quiet" : ""}"><span class="fk">${esc(facetDef(g.facet).label)}</span>`
      + `<span class="t" data-tip="${escAttr(tip)}">${esc(g.what)} <em>${esc(g.why)}</em></span>${where}`
      + `<span class="d mono">${esc(one ? g.detail : "")}</span><span class="a">${act}</span></div>`;
  }).join("");
  return `<section class="mt-sec mt-cover" tabindex="-1"><div class="mt-sec-h label">Coverage</div><div class="mt-finds">${rows}</div></section>`;
}

// A snapshot's line has no verb: a verb acts on facts, and this session has read none of them.
const pastHtml = (f: SnapFinding, root: string): string =>
  `<div class="mt-find past go"${goAttrs(f.facet, f.key, root)}><i class="mt-sev"></i><span class="t">${esc(f.text)}</span></div>`;

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
  const finds = compact ? ""
    : c.findings.length ? `<div class="mt-finds">${c.findings.map((f) => findingHtml(f, undefined, true)).join("")}</div>`
    : c.past?.findings.length ? `<div class="mt-finds">${c.past.findings.map((f) => pastHtml(f, c.path)).join("")}</div>` : "";
  return `<article class="mt-card b-${c.band}${compact ? " quiet" : ""}${c.stale ? " stale" : ""}"${c.stale ? ` aria-busy="true"` : ""}>${id}${cells}${finds}</article>`;
}

// ---------- hosts ----------

// No host fact is read yet (that is ssh, later), so a row is its projects' Prod cells, the worst one.
function hostsHtml(hosts: readonly MaintHostRow[]): string {
  if (!hosts.length) return "";
  const rows = hosts.map((h) => {
    const v = h.level === "ok" && !h.text ? `<i class="mt-dot" aria-label="healthy"></i>` : esc(h.text);
    const runs = h.projects.map((p) => projHtml(p.root, p.name)).join(", ");
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
  security: ["Security", "Advisories, scanner findings, runtimes at their end of life and update pull requests, across every project"],
  delivery: ["Delivery", "CI on the default branch and unreleased work, across every project"],
  code: ["Code", "Unpushed work, branches to tidy and stale fetches, across every project"],
  servers: ["Servers", "Where the projects run and whether it answers, across every project"],
  work: ["Work", "Open issues, pull requests and reviews waiting on you, across every project"],
};
export const tabName = (s: MaintSub): string => TAB_TEXT[s][0];
// On a project's dashboard a tab is about that project alone.
const tabTip = (v: MaintTabView, s: MaintSub) => !v.dash ? TAB_TEXT[s][1]
  : s === "overview" ? "What needs you here, where it runs, and what could be read" : `${TAB_TEXT[s][1].replace(/, across every project$/, "")}, in this project`;
const SECTION: Record<Facet, string> = {
  ci: "CI on the default branch", release: "Unreleased work", security: "Advisories and findings",
  deps: "Update pull requests", git: "Branches and pushes", prod: "Endpoints", work: "Open work",
};

// Only red and amber light a count; everything else stays muted, as on the cards.
function tabsHtml(v: MaintTabView): string {
  return `<div class="bvtabs mt-tabs"><div class="mt-tablist" role="tablist">` + MAINT_SUBS.map((id) => {
    const c = id === "overview" ? null : v.tabs[id];
    const n = c?.n ? `<span class="n${c.level === "bad" ? " l-bad" : c.level === "warn" ? " l-warn" : ""}">${c.n}</span>` : "";
    return `<button class="bvtab${id === v.sub ? " on" : ""}" role="tab" aria-selected="${id === v.sub}" data-mttab="${id}"`
      + ` data-tip="${escAttr(tabTip(v, id))}">${esc(TAB_TEXT[id][0])}${n}</button>`;
  }).join("") + `</div>` + (v.sub === "overview" ? "" : `<span class="mt-grow"></span>${pickHtml(v, v.sub)}`) + `</div>`;
}

// ---------- the tabs' boards: colour only where a value needs you, a zero is the grey dot ----------

const DOT = `<i class="mt-dot" aria-label="none"></i>`;
const nameOf = (v: MaintTabView, root: string) => v.names[root] ?? root;
const ageOf = (sec: number | null) => sec === null ? DASH : esc(span(sec));

// A number is a door to where what it counts is acted on (./maint boardDoor); a zero or an unknown is not.
type DoorAt = { [B in BoardId]: [board: B, col: BoardCol<B>, root: string] }[BoardId];
const chipName = (f: string) => BRANCH_FILTERS.find((x) => x.id === f)?.label ?? f;
function doorText(d: Door): string {
  switch (d.to) {
    case "branches": return `Click: Branches with ${chipName(d.filter)} picked, where they are swept`;
    case "checkouts": return "Click: Branches › Checkouts, where a worktree is removed";
    case "queue": return `Click: Today's queue, ${d.filter === "iss" ? "issues" : "pull requests"}`;
    case "landed": return "Click: Today's Landed, the commits since";
    case "deps": return "Click: every update pull request, in the dependency view";
    case "fetch": return "Click: git fetch here, then check this project again";
    case "url": return `Click: open ${d.url}`;
  }
}
function doorHtml(inner: string, cls: string, at: DoorAt | undefined, v: number | string | null, tip = ""): string {
  const d = at && boardDoor(at[0], at[1], v), said = [tip, d ? doorText(d) : ""].filter(Boolean).join("\n");
  const tipAttr = said ? ` data-tip="${escAttr(said)}"` : "";
  if (!d || !at) return `<span class="${cls}"${tipAttr}>${inner}</span>`;
  const to = d.to === "url" ? `data-mturl="${escAttr(d.url)}"` : `data-mtdoor="${at[0]}.${escAttr(at[1])}" data-mtroot="${escAttr(at[2])}"`;
  return `<button class="${cls} mt-door" ${to}${tipAttr}>${inner}</button>`;
}
const num = (n: number, level: Level, tip = "", at?: DoorAt) => !n ? DOT
  : at ? doorHtml(String(n), `mt-n ${LEVEL_CLS[level]}`, at, n, tip)
  : `<span class="mt-n ${LEVEL_CLS[level]}"${tip ? ` data-tip="${escAttr(tip)}"` : ""}>${n}</span>`;
// `what` is the column's question, and its tip the first names it counts.
const countHtml = (c: HygCount, what: string, at: DoorAt, unknown = "") => c.n === null
  ? `<span class="dim" data-tip="${escAttr(unknown)}">?</span>`
  : num(c.n, c.level, c.names.length ? `${what}: ${peekNames(c.names)}` : what, at);
const barHtml = (ratio: number, level: Level) =>
  `<span class="mt-bar ${LEVEL_CLS[level]}" aria-hidden="true"><i style="width:${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%"></i></span>`;
const RUN_CLS: Partial<Record<CiStatus, string>> = { fail: "l-bad", pass: "l-ok", running: "l-run" };
// Oldest to newest; each dot opens its run's page, its tip the workflow, the word and when.
function runsHtml(runs: readonly RunDot[], root: string): string {
  return `<span class="mt-runs">` + runs.map((x) => {
    const tip = [x.workflow, x.status, x.at ? relTime(x.at * 1000) : ""].filter(Boolean).join(" · ");
    return x.url ? doorHtml("", RUN_CLS[x.status] ?? "", ["ci", "run", root], x.url, tip)
      : `<i class="${RUN_CLS[x.status] ?? ""}" data-tip="${escAttr(tip)}"></i>`;
  }).join("") + `</span>`;
}

// A board is a card of its own; its note says what it covers and how many projects were read. Its
// id is where a card line opens (./maint findingTarget); `extra` is a host's door in its head.
const board = (id: BoardId, title: string, note: string, body: string, extra = "") =>
  `<section class="mt-sec mt-board" id="mtb-${id}" tabindex="-1"><div class="mt-sec-h"><span class="label">${esc(title)}</span>`
  + `<span class="mt-note mono">${esc(note)}</span>${extra}</div>${body}</section>`;
const empty = (text: string) => `<p class="fl-none">${esc(text)}</p>`;
const table = (cols: string[], rows: string[]) => `<div class="mt-scroll"><table class="mt-tbl"><thead><tr>`
  + cols.map((c) => `<th${c.startsWith(">") ? ` class="r"` : ""}>${esc(c.replace(/^>/, ""))}</th>`).join("")
  + `</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const td = (html: string, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${html}</td>`;
const readNote = (n: number | undefined) => `${plural(n ?? 0, "project")} read`;
const verbTd = (f: Finding | null) => td(f ? verbHtml(f) : "", "a");
// Narrowed to one project, a Project column would only repeat its name, so the board drops it.
const projCol = (b: Boards): string[] => b.one ? [] : ["Project"];
const projTd = (v: MaintTabView, b: Boards, root: string) => b.one ? "" : td(projHtml(root, nameOf(v, root)));
const grow = (view: "deps" | "branches", tip: string) => `<button class="xb" data-mtview="${view}" data-tip="${escAttr(tip)}">⤢</button>`;

const SEV_TEXT: Record<SevBucket, string> = { secret: "secret", critical: "critical", high: "high", medium: "medium", low: "low", unknown: "unknown" };
function stripHtml(v: MaintTabView, b: Boards): string {
  return `<div class="mt-sevs" role="group" aria-label="Severity">` + b.strip.map((c) => {
    const on = v.sev === c.bucket, off = !c.n && !on;
    const tip = on ? "Every severity again" : c.n ? `Only the ${SEV_TEXT[c.bucket]} rows` : `No ${SEV_TEXT[c.bucket]} row`;
    return `<button class="mt-sevb${on ? " on" : ""}${c.n ? ` ${LEVEL_CLS[c.level]}` : ""}"${off ? ` aria-disabled="true"` : ""} aria-pressed="${on}"`
      + ` data-mtsev="${c.bucket}" data-tip="${escAttr(tip)}"><b>${c.n}${c.n && b.capped ? "+" : ""}</b><span>${SEV_TEXT[c.bucket]}</span></button>`;
  }).join("") + `</div>`;
}

const KIND_WORD: Record<AdvRow["kind"], string> = { dependency: "advisory", code: "code finding", config: "misconfiguration", secret: "secret" };
function advHtml(v: MaintTabView, b: Boards, r: AdvRow): string {
  const ver = r.kind === "dependency" ? `${r.installed.join(", ") || "?"} → ${r.fixed.join(", ") || "no fix published"}` : "";
  const fix = v.dash ? advFix(r, v.dash.fixes) : null; // the dashboard's own read knows what the fix takes
  const id = r.url ? settingsHtml(r.url, r.id) : `<span>${esc(r.id)}</span>`;
  const chips = r.projects.map((p) => {
    // The verb is the project's line for this kind, so its brief covers every row of it there.
    const why = p.verb ? `${nameOf(v, p.root)}: one brief for every ${KIND_WORD[r.kind]} there` : "";
    return b.one ? (p.verb ? `<span class="mt-pc solo">${verbHtml(p.verb, why)}</span>` : "")
      : `<span class="mt-pc">${projHtml(p.root, nameOf(v, p.root))}${p.verb ? verbHtml(p.verb, why) : ""}</span>`;
  }).join("");
  const tip = [r.summary, r.aliases.length ? `also ${r.aliases.join(", ")}` : ""].filter(Boolean).join("\n");
  const sub = [ver, fix].filter(Boolean).map((x) => `${esc(x!)} · `).join("");
  return `<div class="mt-adv"><span class="mt-sevl ${LEVEL_CLS[r.level]}">${esc(SEV_TEXT[r.bucket])}</span>`
    + `<span class="m"><span class="t" data-tip="${escAttr(tip)}"><b>${esc(r.what || r.id)}</b> ${esc(r.summary)}</span>`
    + `<span class="s mono">${sub}${id}</span></span><span class="mt-pcs">${chips}</span></div>`;
}

const DEPS_TIP = "Every advisory, update pull request and out-of-date package";
function securityHtml(v: MaintTabView, b: Boards): string {
  const all = b.strip.reduce((k, c) => k + c.n, 0);
  const rows = b.adv.length ? `<div class="mt-advs">${b.adv.map((r) => advHtml(v, b, r)).join("")}</div>`
    : empty(all ? "No row of that severity. Click it again for every one." : "No open advisory or finding.");
  // The overlay's ⤢ sits once, on the first board drawn; with none, Packages is drawn to carry it.
  const door = v.dash?.deps ? grow("deps", DEPS_TIP) : "", hasAdv = !!(b.advRead || all), hasPrs = !!(b.prs.length || b.read.deps);
  const adv = hasAdv ? board("advisories", "Advisories and findings", `one row each · ${readNote(b.advRead)}`, stripHtml(v, b) + rows, door) : "";
  const prs = b.prs.length ? table([...projCol(b), "Bot", ">Open", ">Green", ">Red", ">Oldest", ""], b.prs.map((r) => `<tr>${projTd(v, b, r.root)}`
    + td(esc(r.bot), "mono") + td(num(r.open, r.level === "warn" && !r.red ? "warn" : "info", "", ["update-prs", "open", r.root]) + (r.capped ? "+" : ""), "r")
    + td(num(r.green, "info", "checks pass and not a draft", ["update-prs", "green", r.root]), "r")
    + td(num(r.red, "warn", "update pull requests whose checks fail", ["update-prs", "red", r.root]), "r")
    + td(ageOf(r.oldest), "r mono") + verbTd(r.verb) + `</tr>`))
    : empty("No open update pull request.");
  const out = v.dash?.outdated, first = !hasAdv && !hasPrs;
  const pkgs = out || (door && first) ? board("packages", "Packages", "this project's package manager", out
    ? `<div class="mt-kv"><span>Out of date</span><span class="mono">${esc(out)}</span></div>`
    : empty("Every advisory and update pull request the dependency read found is behind ⤢."), first ? door : "") : "";
  const eol = b.eol.length ? board("runtimes", "Runtime end-of-life",
    `as each project declares it · ${readNote(new Set(b.eol.map((r) => r.root)).size)}`, eolHtml(v, b)) : "";
  return adv + eol + (hasPrs ? board("update-prs", "Update pull requests", readNote(b.read.deps), prs, hasAdv ? "" : door) : "") + pkgs;
}

// One row per runtime cycle a project declares; its end opens the page that dates it, muted unless it needs you.
function eolHtml(v: MaintTabView, b: Boards): string {
  return table([...projCol(b), "Runtime", "Declared", ">Ends", "From", ""], b.eol.map((r) => {
    const on = typeof r.eol === "number" ? `${(r.left ?? 0) <= 0 ? "ended" : "ends"} ${fmtDay(r.eol * 1000)}`
      : r.eol === true ? "ended, no date listed" : r.eol === false ? "no end date listed" : "";
    const tip = [on, r.latest && `latest in this cycle ${r.latest}`, r.newest && `newest cycle ${r.newest}`].filter(Boolean).join("\n");
    const declared = [...new Set(r.decls.map((d) => d.declared))].join(", ");
    return `<tr>${projTd(v, b, r.root)}` + td(esc(rtName(r)), "mono")
      + td(esc(declared), "mono") + td(doorHtml(esc(r.text), `mt-n ${LEVEL_CLS[r.level]}`, ["runtimes", "ends", r.root], r.url, tip), "r")
      + td(`<span class="dim">${esc(r.decls.map((d) => d.file).join(", "))}</span>`, "mono") + verbTd(r.verb) + `</tr>`;
  }));
}

const FLOW_TEXT: Partial<Record<FlowRow["status"], string>> = { pass: "✓", skip: "skipped" };
// Only a pass or a skip reads as fine; a cancelled, running or unknown run is unverified, so muted.
const flowCls = (w: FlowRow) => w.red !== null ? "l-bad" : w.status === "pass" || w.status === "skip" ? "l-ok" : "l-muted";
// One project's CI is its workflows, each with its own strip; the Fix covers every red one, so it sits once.
function flowsHtml(r: CiBoardRow): string {
  let verb = r.verb;
  return r.flows.map((w) => {
    const ago = w.at ? relTime(w.at * 1000) : "", mine = w.red !== null ? verb : null;
    if (mine) verb = null;
    const text = w.red !== null ? `failing ${w.red}`.trim() : `${FLOW_TEXT[w.status] ?? w.status} ${ago}`.trim();
    return `<div class="mt-ci wf"><span class="wn">${esc(w.workflow)}</span>`
      + `<span class="mt-v ${flowCls(w)}">${esc(text)}</span><span class="w mono"></span>${runsHtml(w.runs, r.root)}`
      + `<span class="a">${mine ? verbHtml(mine) : ""}</span></div>`;
  }).join("");
}

const untagged = (b: Boards, r: RelRow) => {
  const on = `no release tag on ${r.trunk ?? "the trunk"}`;
  return `<span class="dim" data-tip="${escAttr(on)}">${esc(b.one ? on : "never tagged")}</span>`;
};
function deliveryHtml(v: MaintTabView, b: Boards): string {
  const ci = b.ci.map((r) => b.one && r.flows.length ? flowsHtml(r)
    : `<div class="mt-ci">${b.one ? `<span class="wn">${esc(r.branch ?? "")}</span>` : projHtml(r.root, nameOf(v, r.root))}`
    + `<span class="mt-v ${LEVEL_CLS[r.level]}">${r.level === "ok" && !r.text ? DOT : esc(r.text)}</span>`
    + `<span class="w mono">${esc(r.why)}</span>${runsHtml(r.runs, r.root)}<span class="a">${r.verb ? verbHtml(r.verb) : ""}</span></div>`).join("");
  const on = b.one && b.ci[0]?.branch ? `on ${b.ci[0].branch} · ` : "";
  const rel = table([...projCol(b), "Last tag", "Unreleased", ">Oldest", "Published", ">Changelog", ""], b.releases.map((r) => {
    const tag = !r.tagRead ? DASH : r.tag ? `${esc(r.tag)}${r.tagAge !== null ? ` <span class="dim">· ${esc(span(r.tagAge))}</span>` : ""}` : untagged(b, r);
    const asOf = r.fetched === null ? "" : ` data-tip="${escAttr(`as of the last fetch, ${span(r.fetched)} ago`)}"`;
    const pub = !r.published ? DASH : r.published.tag
      ? `${esc(r.published.tag)}${r.published.age !== null ? ` <span class="dim">· ${esc(span(r.published.age))}</span>` : ""}` : `<span class="dim">none</span>`;
    return `<tr>${projTd(v, b, r.root)}` + td(tag, "mono")
      + td(r.tag ? `<span class="mt-barc"${asOf}>${barHtml(r.ratio, r.level)}${num(r.since, r.level === "warn" ? "warn" : "info",
        `commits on ${r.trunk ?? "the trunk"} since ${r.tag}`, ["releases", "since", r.root])}</span>` : DASH)
      + td(ageOf(r.oldest), "r mono") + td(pub, "mono")
      + td(r.changelog === null ? DASH : num(r.changelog, "info", "entries under Unreleased in CHANGELOG.md"), "r") + verbTd(r.verb) + `</tr>`;
  }));
  return (b.ci.length ? board("ci", "CI on the default branch", `${on}last ${CI_RUNS} runs · ${readNote(b.read.ci)}`, `<div class="mt-cis">${ci}</div>`) : "")
    + (b.releases.length ? board("releases", "Releases", `since the last tag · ${readNote(b.read.release)}`, rel) : "");
}

function codeHtml(v: MaintTabView, b: Boards): string {
  if (!b.hygiene.length) return "";
  const rows = b.hygiene.map((r) => {
    const at = (col: BoardCol<"hygiene">): DoorAt => ["hygiene", col, r.root];
    return `<tr>${projTd(v, b, r.root)}`
      + td(countHtml(r.unpushed, "commits on no remote", at("unpushed"), "no remote, so what is unpushed is unknown"), "r")
      + td(countHtml(r.localOnly, "branches only on this machine", at("localOnly")), "r")
      + td(countHtml(r.merged, `merged into ${r.trunk ?? "the trunk"}`, at("merged"), r.trunk
        ? "the protect list in .episko/episko.toml is unreadable, so merged branches were not read" : "no trunk, so nothing counts as merged"), "r")
      + td(countHtml(r.gone, "remote branch deleted", at("gone")), "r")
      + td(countHtml(r.stale, `branches only here, untouched ${r.staleDays}d+`, at("stale")), "r")
      + td(countHtml(r.idle, `worktrees idle ${r.staleDays}d+`, at("idle")), "r")
      + td(r.fetched.age === null ? DASH : doorHtml(esc(span(r.fetched.age)), `mt-n ${LEVEL_CLS[r.fetched.level]}`, at("fetched"), r.fetched.age,
        `last fetched ${span(r.fetched.age)} ago`), "r mono")
      + td(r.verbs.map((f) => verbHtml(f)).join(""), "a") + `</tr>`;
  });
  const against = b.one && b.hygiene[0].trunk ? `against ${b.hygiene[0].trunk} · ` : "";
  return board("hygiene", "Git hygiene", `${against}as of each repo's last fetch · ${readNote(b.read.git)}`,
    table([...projCol(b), ">Unpushed", ">Only here", ">Merged", ">Gone", ">Untouched", ">Idle worktrees", ">Fetched", ""], rows),
    v.dash ? grow("branches", "Open Branches, where merged branches are swept") : "");
}

function workHtml(v: MaintTabView, b: Boards): string {
  if (!b.work.length) return "";
  const rows = b.work.map((r) => {
    // A forge whose threads the queue cannot list keeps plain numbers: a door to an empty chip is none.
    const at = (col: BoardCol<"work">): DoorAt | undefined => r.queue ? ["work", col, r.root] : undefined;
    return `<tr>${projTd(v, b, r.root)}`
      + td(r.review === null ? `<span class="dim" data-tip="the review search failed">?</span>`
        : r.reviewPartial ? doorHtml(`${r.review}+`, `mt-n${r.review ? ` ${LEVEL_CLS.warn}` : ""}`, at("review"), r.review,
          "a review search failed, so there may be more")
        : num(r.review, "warn", "reviews requested of you", at("review")), "r")
      + td(`<span class="mt-barc">${barHtml(r.issuesRatio, "info")}${num(r.issues, "info", "open issues", at("issues"))}</span>`)
      + td(`<span class="mt-barc">${barHtml(r.prsRatio, "info")}${num(r.prs, "info", "open pull requests", at("prs"))}</span>`)
      + verbTd(r.verbs[0] ?? null) + `</tr>`;
  });
  return board("work", "Open work", `reviews waiting on you first · ${readNote(b.read.work)}`,
    table([...projCol(b), ">Review requested", "Issues", "Pull requests", ""], rows));
}

function serversHtml(v: MaintTabView, b: Boards): string {
  if (!b.probes.length) {
    return b.unchecked ? board("addresses", "Addresses", "from [deploy]", empty("Not checked yet: nothing connects until you ask.")
      + `<p class="fl-none">${prodHtml(v.prod, v.filter?.root)}</p>`) : "";
  }
  const rows = b.probes.map((r) => `<tr data-tip="${escAttr([r.url, r.err].filter(Boolean).join("\n"))}">${projTd(v, b, r.root)}`
    + td(`${esc(r.name)} ${doorHtml(esc(r.url), "dim", ["addresses", "address", r.root], r.url)}`, "mono u")
    + td(`<span class="mt-n ${LEVEL_CLS[r.level]}">${esc(r.code === null ? "no answer" : String(r.code))}</span>`, "r mono")
    + td(r.ms === null ? DASH : esc(`${r.ms}ms`), "r mono")
    + td(r.cert ? `<span class="mt-n ${LEVEL_CLS[r.certLevel]}">${esc(r.cert)}</span>` : DASH, "r mono") + verbTd(r.verb) + `</tr>`);
  return board("addresses", "Addresses", `as last checked · ${readNote(b.read.prod)}`,
    table([...projCol(b), "Address", ">Status", ">Latency", ">Certificate", ""], rows));
}

const BOARDS: Record<MaintTab, (v: MaintTabView, b: Boards) => string> = {
  security: securityHtml, delivery: deliveryHtml, code: codeHtml, servers: serversHtml, work: workHtml,
};

// The dashboard's way across: the fleet's tab, narrowed to this project, so its picker widens it.
const across = (sub: MaintSub, name?: string) => `<button class="aslink mt-across" data-mtacross="${sub}" data-tip="${escAttr(sub === "overview"
  ? "Every project's card" : `${TAB_TEXT[sub][0]} across every project, starting at ${name ?? "this one"}`)}">all projects</button>`;

// The project picker at the tab bar's end: ./maintui opens the menu, and the root it carries is the one ticked.
const pickHtml = (v: MaintTabView, tab: MaintTab) => v.dash ? across(tab, v.filter?.name)
  : `<button class="mt-pick${v.filter ? " on" : ""}" data-mtpick="${tab}" data-mtroot="${escAttr(v.filter?.root ?? "")}"`
  + ` aria-haspopup="menu" data-tip="${escAttr(v.filter ? "Show another project, or every one (Esc)" : "Show one project only")}">`
  + `<span>Project</span><b>${esc(v.filter?.name ?? "All projects")}</b>${icon("down", "car")}</button>`;

function tabHtml(v: MaintTabView, tab: MaintTab): string {
  const label = TAB_TEXT[tab][0];
  const boards = v.boards ? BOARDS[tab](v, v.boards) : "";
  // What no board carries (a facet nobody set up, a stale fetch with no git read) is still a line with its verb.
  const rest = FACETS.filter((f) => FACET_TAB[f] === tab).flatMap((f) => {
    const rows = v.rows.filter((r) => r.facet === f);
    const head = boards ? `Also · ${SECTION[f]}` : SECTION[f]; // a board above already wears the bare name
    return rows.length ? [`<section class="mt-sec"><div class="mt-sec-h label">${esc(head)}</div>`
      + `<div class="mt-finds">${rows.map((r) => findingHtml(r, v.filter ? undefined : nameOf(v, r.root))).join("")}</div></section>`] : [];
  }).join("");
  const none = v.read ? (v.filter ? `Nothing to do in ${label} for ${v.filter.name}.` : `Nothing to do in ${label}: ${plural(v.read, "project")} read.`)
    : v.unset ? (v.filter ? `${v.filter.name} has nothing in ${label} set up.` : `Nothing to check in ${label}: ${plural(v.unset, "project")} with none set up.`)
    : `Nothing in ${label} could be read${v.filter ? ` for ${v.filter.name}` : ""}.`;
  return (tab === "servers" ? hostsHtml(v.hosts) : "")
    + (boards + rest || `<p class="fl-none">${esc(none)}</p>`) + coverHtml(v);
}

export function maintBodyHtml(v: MaintView): string {
  const bar = tabsHtml(v);
  if (!v.cards.length) {
    const why = v.scanning ? "Reading every project…"
      : "Not checked this session. Check reads every project once; nothing runs in them, and the answer stays until you check again.";
    return `<div class="mt-body">${bar}<p class="fl-none">${esc(why)}</p>${v.scanning ? ""
      : `<button class="aslink" data-mtscan="check">Check every project</button>`}</div>`;
  }
  // A tab mixes projects, so it dims whole while any of its answers is an earlier one being re-read.
  if (v.sub !== "overview") return `<div class="mt-body${v.cards.some((c) => c.stale) ? " stale" : ""}">${bar}${tabHtml(v, v.sub)}</div>`;
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

export interface MaintDash {
  card: MaintCard; // the strip is the fleet card's cells: two zoom levels of one scan
  rows: Finding[]; // the card's lines and the rows only a tab shows
  offers: Finding[]; // click-only sources nobody ran: Coverage's buttons, never To do's rows
  setups: Finding[]; // Coverage rows an agent could set up (`coverSetups`)
  checked: number; // this project's last finished scan (ms), 0 for none
  tab: MaintTabView; // the sub-tabs: the fleet's boards, narrowed to this project for good
  cover: CoverRow[]; forge: string; unreadable: boolean;
  deploy: DeployCfg | null; detected: boolean; // `[deploy]`, once detection has answered
  probes: { at: number | null; rows: ProbeRow[] } | null; // null until Check prod answered
}

const dcard = (id: string, title: string, n: string, extra: string, body: string) =>
  `<section class="ac mt-dc" id="mtc-${id}"><div class="ac-h"><span class="t">${esc(title)}</span>`
  + `<span class="n">${esc(n)}</span>${extra}</div><div class="ac-b">${body}</div></section>`;
const kv = (k: string, v: string, cls = "") =>
  `<div class="mt-kv"><span>${esc(k)}</span><span class="mono${cls ? " " + cls : ""}">${esc(v)}</span></div>`;

// Each row is a door to the sub-tab and board that carry it, as a fleet card's line is.
function todoCard(v: MaintDash): string {
  const read = v.card.cells.filter((c) => c.state === "read" && c.level !== "muted").length;
  const none = v.card.band === "unread" ? (v.card.reading ? "Reading this project…" : "Not checked yet.")
    : `Nothing to do in the ${plural(read, "facet")} that could be read${read < FACETS.length ? "; Coverage says what could not" : ""}.`;
  const body = v.rows.length
    ? `<div class="mt-finds">${v.rows.map((f) => findingHtml(f, undefined, true)).join("")}</div>` : `<p class="ac-empty">${esc(none)}</p>`;
  const n = needsCount(v.rows); // red and amber only, as the tab badges
  return dcard("todo", "To do", n ? String(n) : "", across("overview"), body);
}

// The doors are the project settings row's: an agent proposes, a person applies, the file is git's.
function runsCard(v: MaintDash): string {
  const d = v.deploy, name = v.card.name;
  const door = (what: "propose" | "file", label: string, tip: string) =>
    `<button class="aslink" data-mtdeploy="${what}" data-mtroot="${escAttr(v.card.path)}" data-tip="${escAttr(tip)}">${esc(label)}</button>`;
  const ask = door("propose", d ? "Re-check…" : "Propose with an agent",
    "Claude reads the deploy scripts, compose files and CI in the background, read-only, and proposes [deploy] for you to apply or discard");
  // A failed detection is not a loading one: say so, and keep the door the card exists for.
  if (!v.detected) {
    return dcard("runs", "Runs on", "", across("servers", name), v.card.err && !v.card.reading
      ? `<p class="ac-empty">Could not read this project, so its [deploy] table is unknown.</p><p class="ac-empty">${ask}</p>`
      : `<p class="ac-empty">${sk("62%", 9)}</p>`);
  }
  if (!d) {
    return dcard("runs", "Runs on", "", across("servers", name),
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
  const prod = v.tab.prod;
  const checked = !prod.projects ? "" : prod.checking ? "" : v.probes?.at ? ` · checked ${relTime(v.probes.at * 1000)}` : " · never checked";
  const doors = [prodHtml(prod, v.card.path), door("file", "Open file", "Open .episko/episko.toml"), ask].filter(Boolean).join(" · ");
  return dcard("runs", "Runs on", "from [deploy]", across("servers", name),
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
  const rows = v.cover.map((r) => {
    // A never-run source is offered here, on its own row; a public one says what leaves the machine.
    const o = r.state === "notRun" ? v.offers.find((x) => x.source === r.source) : undefined;
    const up = r.state === "off" ? v.setups.find((x) => x.source === r.source) : undefined;
    const d = o && findSource(o.source), said = d && disclosure(d);
    return `<div class="mt-cov"><span class="fk">${esc(facetDef(r.facet).label)}</span><span class="s">${esc(r.label)}</span>`
      + `<span class="mt-v ${COVER_CLS[r.state] ?? "l-muted"}">${esc(r.text)}</span>${o ? verbHtml(o) : ""}${up ? verbHtml(up) : ""}`
      + `${r.url ? settingsHtml(r.url) : ""}</div>`
      + (r.fix ? `<div class="mt-fixrow">${copyHtml(r.fix)}</div>` : "")
      + (r.cfg ? `<div class="mt-fixrow">${setupHtml(v.card.path)}</div>` : "") + (said ? `<p class="mt-said">${esc(said)}</p>` : "");
  }).join("");
  return dcard("cover", "Coverage", v.forge, "", head + (rows || `<p class="ac-empty">${sk("62%", 9)}</p>`));
}

/** The dashboard's Maintenance tab: the fleet card's strip, then the fleet's sub-tabs for this project. */
export function maintDashHtml(v: MaintDash): string {
  const go = (c: Cell) => `Click: ${tabName(FACET_TAB[c.facet])}${coverFirst(c) ? ", at its Coverage" : ""}`;
  const when = v.card.reading ? `<span class="fl-when mono">reading this project…</span>`
    : v.checked ? `<span class="fl-when mono">checked ${esc(relTime(v.checked))}</span>`
      + `<button class="aslink" data-mtscan="force" data-tip="Check this project again, past every cache">⟳</button>`
    : `<span class="fl-when mono">Not checked yet</span>`
      + `<button class="aslink" data-mtscan="check" data-tip="Read this project once. Nothing runs in it">Check</button>`;
  const err = v.card.err ? `<p class="fl-none">Could not read: ${esc(v.card.err)}</p>` : "";
  const body = v.tab.sub === "overview"
    ? `<div class="mt-dgrid"><div class="mt-dcol">${todoCard(v)}</div><div class="mt-dcol">${runsCard(v)}${coverCard(v)}</div></div>`
    : tabHtml(v.tab, v.tab.sub);
  return `<div class="mt-dhead"><div class="mt-cells">${v.card.cells.map((c) => cellHtml(c, v.card, go(c))).join("")}</div>`
    + `<div class="mt-dwhen">${when}</div></div>${err}${tabsHtml(v.tab)}${body}`;
}
