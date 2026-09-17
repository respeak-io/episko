// The dependency card, its overlay and its dispatch sheet: data in, string out, like every
// other *view module. ./deps owns the rules and ./dashboard owns the pane, the IPC and the
// events. See docs/dependencies.md.

import { esc, escAttr } from "./format";
import { shortAge, overlayHtml, pickButtons, pickHead } from "./dashview";
import type { PickKind, PickState } from "./pick";
import {
  checkState, FIX_TEXT, declaredIn, prBlockers, prFor, prReady,
  type Advisory, type DepManifest, type DepPr, type DepTally, type DepTool, type OutRow,
} from "./deps";
import type { GhThread } from "./ghwork";

// A severity is a colour and a word everywhere it appears; one table, four values.
const SEV_CLS: Record<string, string> = {
  critical: "sv-crit", high: "sv-high", medium: "sv-med", low: "sv-low",
};
const sevDot = (s: string) =>
  `<span class="sv ${SEV_CLS[s] ?? "sv-low"}" title="${escAttr(s || "unrated")}">●</span>`;

// The verdict chip. `unknown` and `none` are deliberately NOT dressed as good news: a file
// we could not read and a vulnerability with no fix are both things a person has to look at.
const FIX_CLS: Record<string, string> = {
  lockfile: "fx-easy", manifest: "fx-mid", major: "fx-hard",
  transitive: "fx-mid", none: "fx-hard", unknown: "fx-unk",
};
const fixChip = (f: keyof typeof FIX_TEXT) =>
  `<span class="dfix ${FIX_CLS[f] ?? "fx-unk"}">${esc(FIX_TEXT[f])}</span>`;

const CHECK_GLYPH: Record<string, string> = { passing: "✓", failing: "✕", pending: "◐", none: "·" };

/** A probability worth a column only when it is not vanishing; EPSS is mostly noise near zero. */
function epssText(p: number): string {
  if (!(p > 0.001)) return "";
  return `<span class="depss" title="EPSS: the chance of exploitation in the wild this year">${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%</span>`;
}

// ---------- the card ----------

export function depsCard(
  adv: Advisory[], t: DepTally, prs: DepPr[], manifests: DepManifest[], scanned: boolean,
): string {
  const head = t.critical || t.high
    ? `${t.critical ? `${t.critical} critical` : ""}${t.critical && t.high ? " · " : ""}${t.high ? `${t.high} high` : ""}`
    : t.vulns ? `${t.vulns} advisor${t.vulns === 1 ? "y" : "ies"}`
    : t.prs ? `${t.prs} bot PR${t.prs === 1 ? "" : "s"}`
    : scanned ? `${t.outdated} out of date` : "nothing open";
  const rows = adv.length
    ? adv.map((a) => advRow(a, prs, manifests)).join("")
    : prs.length ? prs.slice(0, 4).map(prCardRow).join("")
    : `<div class="ac-empty">No advisory and no bot pull request. ⤢ to check what is merely out of date.</div>`;
  return `<div class="ac"><div class="ac-h"><span class="t">Dependencies</span>
      <span class="n">${esc(head)}</span>
      <button class="xb" data-dashopen-view="deps" title="Every advisory, bot PR and out-of-date package">⤢</button></div>
    <div class="ac-b">${rows}</div></div>`;
}

function advRow(a: Advisory, prs: DepPr[], manifests: DepManifest[]): string {
  const names = a.alerts.map((x) => x.pkg);
  const pr = prFor(a, prs);
  const d = declaredIn(manifests, a.alerts[0]?.pkg ?? "");
  return `<div class="dep" data-dashdepopen="${escAttr(a.url)}" title="${escAttr(a.summary)}">
    ${sevDot(a.severity)}
    <span class="mid"><span class="ti">${esc(names.slice(0, 2).join(", "))}${names.length > 2 ? ` +${names.length - 2}` : ""}</span>
      <span class="sub">${a.alerts[0]?.patched ? `→ ${esc(a.alerts[0].patched)}` : "no fix yet"}
        ${d ? `<span class="dim">${esc(d.range)}</span>` : ""}</span></span>
    ${pr ? `<span class="dpr" title="${escAttr(`${pr.bot} #${pr.number} is already open for this`)}">#${pr.number}</span>` : ""}
    ${fixChip(a.worst)}</div>`;
}

function prCardRow(p: DepPr): string {
  const st = checkState(p);
  return `<div class="dep" data-dashdepopen="${escAttr(p.url)}">
    <span class="dck ${st}">${CHECK_GLYPH[st]}</span>
    <span class="mid"><span class="ti">${esc(p.title)}</span>
      <span class="sub">${esc(p.bot)} · #${p.number} · ${esc(shortAge(p.updatedAt))}</span></span>
    ${prReady(p) ? `<span class="dfix fx-easy">ready</span>` : ""}</div>`;
}

// ---------- the overlay ----------

export type DepTab = "vulns" | "prs" | "stale";

export interface DepsView {
  tab: DepTab;
  adv: Advisory[];
  prs: DepPr[];
  out: OutRow[];
  manifests: DepManifest[];
  tools: DepTool[];
  tally: DepTally;
  picked: Set<string>;   // advisories, by GHSA
  outPicked: Set<string>; // out-of-date rows, by package name
  // The header tick's three states, one per table; ./pick decides them.
  headState: PickState;
  outHeadState: PickState;
  slug: string;
  loading: boolean;
  scanning: string;      // the tool id running right now, "" for none
  scanned: string;       // the tool id whose answer is on screen
  scanError: string;
  reason: string;        // why the GitHub half is unavailable, if it is
  dashboard: GhThread | null; // renovate's own control issue
}

const TAB_LABEL: Record<DepTab, string> = {
  vulns: "Advisories", prs: "Bot pull requests", stale: "Out of date",
};

export function depsOverlay(v: DepsView): string {
  const tab = (k: DepTab, n: number) =>
    `<button class="bvtab${v.tab === k ? " on" : ""}" data-dashdeptab="${k}">${esc(TAB_LABEL[k])}<span class="n">${n}</span></button>`;
  const body = `<div class="bvtabs">${tab("vulns", v.tally.vulns)}${tab("prs", v.tally.prs)}${tab("stale", v.out.length)}</div>`
    + (v.reason ? `<div class="dep-note">${esc(v.reason)}</div>` : "")
    + (v.tab === "vulns" ? vulnsTab(v) : v.tab === "prs" ? prsTab(v) : staleTab(v));
  return overlayHtml("Dependencies", `${esc(v.slug)} · ${v.tally.vulns} open · ${v.tally.prs} bot PR${v.tally.prs === 1 ? "" : "s"}`,
    body,
    `Every verb here starts an <b>agent</b> with the advisory, the declared range and this project's own checks in its brief — nothing is merged, dismissed or commented on your behalf. <b>${esc(FIX_TEXT.lockfile)}</b> means the fix already sits inside what your manifest declares; <b>${esc(FIX_TEXT.major)}</b> means somebody has to read a changelog.`);
}

function actionBar(count: number, kind: PickKind, verb: string): string {
  return `<div class="bvbar${count ? " on" : ""}"><span class="sel">${count ? `${count} selected` : "Nothing selected"}</span>
    <span class="sp"></span>
    ${pickButtons(kind)}
    <button class="act primary" data-dashdeprun="${escAttr(verb)}"${count ? "" : " disabled"}>▶ Start an agent${count > 1 ? ` on ${count}` : ""}</button></div>`;
}

function vulnsTab(v: DepsView): string {
  if (v.loading) return `<div class="ac-empty"><span class="u-spin"></span> Reading GitHub…</div>`;
  // "nothing is open" and "nothing could be read" are different facts, and only one of
  // them is good news; the reason row above has already said which this is.
  if (!v.adv.length) {
    return `<div class="ac-empty">${v.reason
      ? "No advisory to show."
      : "No open Dependabot advisory. That is the whole answer, not a missing read."}</div>`;
  }
  const head = `<div class="lst-hd dep-hd">${pickHead("advisories", v.headState)}<span>Advisory</span><span>Packages</span>
    <span class="r">Fix</span><span class="r">Age</span><span class="r">Open</span></div>`;
  const rows = v.adv.map((a) => advBigRow(a, v)).join("");
  return `<div class="bk">${head}${rows}</div>` + actionBar(v.picked.size, "advisories", "vulns");
}

function advBigRow(a: Advisory, v: DepsView): string {
  const on = v.picked.has(a.ghsa);
  const pr = prFor(a, v.prs);
  const pkgs = a.alerts.map((x) => {
    const d = declaredIn(v.manifests, x.pkg);
    const where = d ? `${d.path}: "${d.range}"` : `${x.relationship || "?"} in ${x.manifest}`;
    return `<span class="dpkg" title="${escAttr(where)}">${esc(x.pkg)}
      <i>${esc(x.relationship || "?")}${x.scope === "development" ? " · dev" : ""}</i></span>`;
  }).join("");
  return `<div class="dbr${on ? " on" : ""}" data-dashdep="${escAttr(a.ghsa)}">
    <span class="ck">${sevDot(a.severity)}<span class="brck${on ? " on" : ""}" role="checkbox" aria-checked="${on}"></span></span>
    <span class="mid"><span class="ti">${esc(a.summary || a.ghsa)}</span>
      <span class="sub"><span class="mono">${esc(a.ghsa)}</span>${a.cve ? `<span class="mono">${esc(a.cve)}</span>` : ""}
        ${epssText(a.epss)}${a.runtime ? `<span class="dship">ships</span>` : `<span class="dim">dev only</span>`}
        ${pr ? `<span class="dpr">${esc(pr.bot)} #${pr.number} open</span>` : ""}</span></span>
    <span class="dpkgs">${pkgs}</span>
    <span class="r">${fixChip(a.worst)}</span>
    <span class="age">${esc(shortAge(a.alerts[0]?.createdAt ?? ""))}</span>
    <span class="r"><button class="gx" data-dashdepopen="${escAttr(a.url)}" title="Open on GitHub">↗</button></span>
  </div>`;
}

function prsTab(v: DepsView): string {
  if (!v.prs.length) {
    return `<div class="ac-empty">No open pull request from Dependabot or Renovate.</div>`
      + (v.dashboard ? dashboardRow(v.dashboard) : "");
  }
  const head = `<div class="lst-hd dep-hd prs"><span class="r">#</span><span>Title</span><span>Checks</span>
    <span>Standing</span><span class="r">Age</span><span class="r">Action</span></div>`;
  const rows = v.prs.map((p) => {
    const st = checkState(p);
    const blockers = prBlockers(p);
    return `<div class="dbr prs">
      <span class="num">${p.number}</span>
      <span class="mid"><span class="ti">${esc(p.title)}</span>
        <span class="sub"><span class="mono">${esc(p.bot)}</span><span class="dim">${esc(p.branch)}</span></span></span>
      <span class="dck ${st}">${CHECK_GLYPH[st]} ${p.checks.passed}/${Math.max(1, p.checks.total - p.checks.skipped)}</span>
      <span class="dstand">${blockers.length ? esc(blockers[0]) : `<span class="ok">ready to land</span>`}</span>
      <span class="age">${esc(shortAge(p.updatedAt))}</span>
      <span class="r"><button class="go" data-dashdeppr="${p.number}">▶ Review</button></span>
    </div>`;
  }).join("");
  return `<div class="bk">${head}${rows}</div>` + (v.dashboard ? dashboardRow(v.dashboard) : "");
}

// Renovate's dashboard issue is its control panel, and it is already on the board — so this
// links to it rather than reimplementing a checklist we cannot tick.
function dashboardRow(t: GhThread): string {
  return `<div class="dep-note"><b>Renovate keeps a dashboard</b> in issue #${t.number}. Its checkboxes are how
    you ask Renovate for a PR; Episko links to it rather than tacking on a second control panel.
    <button class="act" data-dashdepopen="${escAttr(t.url)}">Open #${t.number} ↗</button></div>`;
}

function staleTab(v: DepsView): string {
  const tools = v.tools.length
    ? v.tools.map((t) => t.blocked
      ? `<button class="act" disabled title="${escAttr(t.blocked)}">${esc(t.label)}</button>`
      : `<button class="act${v.scanned === t.id ? " on" : ""}" data-dashdeptool="${escAttr(t.id)}"
          title="${escAttr(`Runs: ${t.cmd}`)}"${v.scanning ? " disabled" : ""}>${esc(t.label)}</button>`).join("")
    : `<span class="dim">No manifest here that Episko knows how to ask about.</span>`;
  const blocked = v.tools.filter((t) => t.blocked);
  const bar = `<div class="dep-scan">
      <span class="lb">Ask the package manager</span>
      <div class="row">${tools}</div>
      <span class="sb">${v.scanning
        ? `<span class="u-spin"></span> running ${esc(v.scanning)} — it resolves against the registry, so give it a moment`
        : blocked.length ? esc(blocked.map((t) => t.blocked).join(" · "))
        : "This runs your project's own package manager. Nothing is written."}</span></div>`;
  if (v.scanError) return bar + `<div class="dep-note">${esc(v.scanError)}</div>`;
  if (!v.scanned) {
    return bar + `<div class="ac-empty">Nothing has been asked yet. This is the one thing on the dashboard
      that runs a command, so it waits to be told.</div>`;
  }
  if (!v.out.length) return bar + `<div class="ac-empty">${esc(v.scanned)} reports everything up to date.</div>`;
  const head = `<div class="lst-hd dep-hd stale">${pickHead("stale", v.outHeadState)}<span>Package</span><span class="r">Have</span>
    <span class="r">In range</span><span class="r">Latest</span><span class="r">Jump</span></div>`;
  const rows = v.out.map((r) => {
    const on = v.outPicked.has(r.pkg);
    return `<div class="dbr stale${on ? " on" : ""}" data-dashdepout="${escAttr(r.pkg)}">
      <span class="ck"><span class="brck${on ? " on" : ""}" role="checkbox" aria-checked="${on}"></span></span>
      <span class="mid"><span class="ti">${esc(r.pkg)}</span>
        <span class="sub">${r.dev ? `<span class="dim">dev only</span>` : ""}
          ${r.deprecated ? `<span class="ddep">deprecated</span>` : ""}
          ${r.safe ? `<span class="dim">already allowed by your range</span>` : ""}</span></span>
      <span class="r mono">${esc(r.current || "—")}</span>
      <span class="r mono">${esc(r.wanted && r.wanted !== r.current ? r.wanted : "—")}</span>
      <span class="r mono">${esc(r.latest)}</span>
      <span class="r"><span class="dfix ${r.bump === "major" ? "fx-hard" : r.bump === "minor" ? "fx-mid" : "fx-easy"}">${esc(r.bump)}</span></span>
    </div>`;
  }).join("");
  return bar + `<div class="bk">${head}${rows}</div>` + actionBar(v.outPicked.size, "stale", "stale");
}

// ---------- the dispatch sheet ----------
// The prompt is SENT, so this sheet is the reading: the whole brief is here, editable,
// before anything starts. Same rule as the issue dispatch it sits beside.

export function depSheet(title: string, brief: string, mode: string, lines: number): string {
  return `<h4>${esc(title)}</h4>
    <div class="body">
      <p>A session in this project, and <b>the prompt is sent</b>. It is long on purpose:
        the brief carries the advisory, what your manifest declares, and the checks to verify with.</p>
      <textarea id="dashDepText" rows="${Math.min(18, Math.max(8, lines))}" spellcheck="false">${esc(brief)}</textarea>
      <p class="dim-line">Permission mode: <b>${esc(mode)}</b>. Anything that doesn't ask before acting will act unattended.</p>
    </div>
    <div class="foot"><button class="act" data-dashsheet="cancel">Cancel</button><span class="sp"></span>
      <button class="act primary" data-dashsheet="deps">▶ Start the agent</button></div>`;
}
