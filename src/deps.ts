// Dependency work: advisories, the bots' pull requests, and what is simply out of date.
// The rules only — no DOM, no Tauri. ./depsview draws them, ./dashboard fetches and
// dispatches. See docs/dependencies.md.

import type { GhThread } from "./ghwork";

// ---------- what the backend answers ----------

/// One Dependabot alert, flattened. Mirrors the Rust struct; the advisory's long
/// description is deliberately absent — it is a whole page, and `url` reaches it.
export interface DepAlert {
  number: number;
  state: string; // open | dismissed | auto_dismissed | fixed
  pkg: string;
  ecosystem: string; // GitHub's spelling: npm, rust, pip, go, maven…
  manifest: string; // the file GitHub found it in, often the LOCKFILE
  scope: string; // runtime | development | ""
  relationship: string; // direct | transitive | ""
  severity: string; // low | medium | high | critical
  ghsa: string;
  cve: string | null;
  summary: string;
  cvss: number; // 0 where GitHub has no score; never rank on this alone
  epss: number; // 0..1, the chance of exploitation in the wild
  range: string; // the vulnerable version range, as written
  patched: string | null; // first patched version; null means there is no fix yet
  url: string;
  createdAt: string;
  updatedAt: string;
}

/// One pull request a dependency bot opened. `checks` is the rollup reduced in Rust:
/// the whole array is a page of JSON per PR and nothing here reads an individual run.
export interface DepPr {
  number: number;
  title: string;
  url: string;
  author: string;
  branch: string;
  labels: string[];
  draft: boolean;
  updatedAt: string;
  mergeable: string; // MERGEABLE | CONFLICTING | UNKNOWN
  mergeState: string; // CLEAN | BLOCKED | DIRTY | BEHIND | UNSTABLE | HAS_HOOKS | UNKNOWN
  checks: { total: number; passed: number; failed: number; pending: number; skipped: number };
  bot: string; // dependabot | renovate | ""; "" never reaches this list
}

/// What one manifest declares, read off disk without running anything. `ranges` is
/// package name → the range as written, which is what a manifest edit would change.
export interface DepManifest {
  path: string; // repo-relative
  ecosystem: string; // npm | cargo | pip | go
  ranges: Record<string, string>;
  dev: string[]; // names declared as dev/build-only, for the scope join
}

/// A package manager this project could be asked about. `blocked` is a reason rather than
/// an absence: a tool that is simply missing from the list reads as "not applicable here".
export interface DepTool {
  id: string; // npm | pnpm | yarn | cargo | pip | go
  label: string;
  cmd: string; // what it would run, shown before it runs
  blocked: string | null;
}

/// One row of a package manager's own answer.
export interface Outdated {
  pkg: string;
  current: string;
  wanted: string; // the newest the declared range allows
  latest: string;
  kind: string; // dependencies | devDependencies | …, as the tool spells it
  deprecated: boolean;
}

export interface OutdatedRun {
  tool: string;
  ok: boolean;
  reason: string | null;
  rows: Outdated[];
}

export interface DepReport {
  available: boolean;
  reason: string | null;
  alerts: DepAlert[];
  prs: DepPr[];
  enabled: boolean; // whether Dependabot alerts are switched on for the repo at all
}

// ---------- versions ----------
// A narrow, honest semver: anything it cannot read answers `null`, never a guess. That
// null is what stops a verdict being invented for a range shape nobody modelled.

export interface Ver { major: number; minor: number; patch: number; pre: string }

export function parseVer(s: string): Ver | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?\s*$/.exec(s || "");
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] ?? 0), patch: +(m[3] ?? 0), pre: m[4] ?? "" };
}

/** Numeric where both identifiers are numeric, else lexical; a prerelease sorts BELOW its release. */
export function cmpVer(a: Ver, b: Ver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const x = a.pre.split("."), y = b.pre.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q);
    if (np && nq) { if (+p !== +q) return +p - +q; continue; }
    if (np !== nq) return np ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export const verCmpStr = (a: string, b: string): number => {
  const x = parseVer(a), y = parseVer(b);
  return x && y ? cmpVer(x, y) : 0;
};

/** major / minor / patch, for a row that says how far an upgrade reaches. */
export function bumpKind(from: string, to: string): "major" | "minor" | "patch" | "none" | "unknown" {
  const a = parseVer(from), b = parseVer(to);
  if (!a || !b) return "unknown";
  if (cmpVer(a, b) >= 0) return "none";
  if (a.major !== b.major) return "major";
  // Below 1.0.0 the minor is where semver puts breaking changes, and callers act on that word.
  if (a.major === 0 && a.minor !== b.minor) return "major";
  return a.minor !== b.minor ? "minor" : "patch";
}

// ---------- ranges ----------

// Cargo reads a bare `1.2` as `^1.2`; npm reads it as that exact version. The ecosystem is
// therefore part of the question, and guessing it wrong inverts the verdict.
const CARET_BY_DEFAULT = new Set(["cargo", "rust"]);

/** The upper bound `^` implies: 1.x → 2.0.0, 0.2.x → 0.3.0, 0.0.x → 0.0.(x+1). */
function caretMax(v: Ver): Ver {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, pre: "" };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, pre: "" };
  return { major: 0, minor: 0, patch: v.patch + 1, pre: "" };
}

function tildeMax(v: Ver, hadMinor: boolean): Ver {
  return hadMinor
    ? { major: v.major, minor: v.minor + 1, patch: 0, pre: "" }
    : { major: v.major + 1, minor: 0, patch: 0, pre: "" };
}

/** One comparator against one version. `null` = this clause was not understood. */
function clauseHolds(v: Ver, raw: string, eco: string): boolean | null {
  const c = raw.trim();
  if (!c || c === "*" || c === "x" || c === "X" || c === "latest") return true;
  const m = /^(\^|~=|~|>=|<=|>|<|=|==)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? "";
  const lit = m[2].trim();
  // A wildcard in the literal is a range of its own, so it is read before the number is.
  const wild = /^(\d+)(?:\.(\d+))?\.(?:x|X|\*)$/.exec(lit) ?? /^(\d+)\.(?:x|X|\*)$/.exec(lit);
  if (wild && !op) {
    const lo = parseVer(`${wild[1]}.${wild[2] ?? 0}.0`);
    if (!lo) return null;
    const hi = wild[2] === undefined
      ? { major: lo.major + 1, minor: 0, patch: 0, pre: "" }
      : { major: lo.major, minor: lo.minor + 1, patch: 0, pre: "" };
    return cmpVer(v, lo) >= 0 && cmpVer(v, hi) < 0;
  }
  const base = parseVer(lit);
  if (!base) return null;
  const hadMinor = /^\s*v?\d+\.\d+/.test(lit);
  switch (op) {
    case ">": return cmpVer(v, base) > 0;
    case ">=": return cmpVer(v, base) >= 0;
    case "<": return cmpVer(v, base) < 0;
    case "<=": return cmpVer(v, base) <= 0;
    case "^": return cmpVer(v, base) >= 0 && cmpVer(v, caretMax(base)) < 0;
    case "~":
    case "~=": return cmpVer(v, base) >= 0 && cmpVer(v, tildeMax(base, hadMinor)) < 0;
    case "=":
    case "==": return cmpVer(v, base) === 0;
    default:
      return CARET_BY_DEFAULT.has(eco)
        ? cmpVer(v, base) >= 0 && cmpVer(v, caretMax(base)) < 0
        : cmpVer(v, base) === 0;
  }
}

/**
 * Whether `version` is allowed by `range`. `||` is OR, spaces and commas are AND
 * (GitHub writes advisory ranges as `>= 2.1.0, < 4.1.11`), and a hyphen range is read
 * as its two bounds. `null` means the shape was not understood — never assume either way.
 */
export function satisfies(version: string, range: string, eco = "npm"): boolean | null {
  const v = parseVer(version);
  if (!v) return null;
  const text = (range || "").trim();
  if (!text || text === "*" || text === "x") return true;
  let anyOr = false;
  for (const alt of text.split("||")) {
    const hyphen = /^\s*([0-9][^\s]*)\s+-\s+([0-9][^\s]*)\s*$/.exec(alt);
    // GitHub writes `>= 2.1.0, < 4.1.11` — a space between the operator and its version, so
    // the operator has to be reattached before a split on whitespace tears the two apart.
    const parts = hyphen
      ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`]
      : alt.replace(/(>=|<=|==|~=|>|<|=|\^|~)\s+/g, "$1").split(/[,\s]+/).filter(Boolean);
    if (!parts.length) continue;
    let all = true;
    for (const p of parts) {
      const held = clauseHolds(v, p, eco);
      if (held === null) return null;
      if (!held) { all = false; break; }
    }
    if (all) anyOr = true;
  }
  return anyOr;
}

// ---------- the compatibility verdict ----------

// What an upgrade would actually cost, decided from three facts we can see: what the
// manifest declares, what clears the advisory, and whether we depend on it at all.
export type Fix =
  | "lockfile"   // the fix is inside the declared range: a lock bump, no manifest edit
  | "manifest"   // the range has to widen, but the major stays
  | "major"      // it crosses a major boundary; breaking until somebody reads the notes
  | "transitive" // nothing declares it; it arrives through a parent
  | "none"       // there is no patched version yet
  | "unknown";   // not in any manifest we read, or a range shape we do not model

export const FIX_TEXT: Record<Fix, string> = {
  lockfile: "lockfile bump",
  manifest: "widen the range",
  major: "major upgrade",
  transitive: "via a parent",
  none: "no fix published",
  unknown: "needs a look",
};

/// Where a package is declared, and as what. `null` for a package no manifest names.
export interface Declared { path: string; range: string; ecosystem: string; dev: boolean }

export function declaredIn(manifests: DepManifest[], pkg: string): Declared | null {
  for (const m of manifests) {
    const range = m.ranges[pkg];
    if (range !== undefined) {
      return { path: m.path, range, ecosystem: m.ecosystem, dev: m.dev.includes(pkg) };
    }
  }
  return null;
}

export function fixKind(a: DepAlert, d: Declared | null): Fix {
  if (!a.patched) return "none";
  if (!d) return a.relationship === "transitive" ? "transitive" : "unknown";
  const inRange = satisfies(a.patched, d.range, d.ecosystem);
  if (inRange === null) return "unknown";
  if (inRange) return "lockfile";
  // Outside the declared range: the only question left is how far the edit reaches, and
  // the range's own floor is the honest comparison point when it has one.
  const floor = /(\d+[\d.]*)/.exec(d.range)?.[1] ?? "";
  const kind = floor ? bumpKind(floor, a.patched) : "unknown";
  return kind === "major" || kind === "unknown" ? "major" : "manifest";
}

// ---------- grouping and order ----------

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const sevRank = (s: string): number => {
  const i = (SEVERITIES as readonly string[]).indexOf((s || "").toLowerCase());
  return i < 0 ? SEVERITIES.length : i;
};

/// One advisory, however many packages it hits. GitHub files an alert per package, so
/// `vitest` and `@vitest/mocker` under one GHSA are one piece of work, not two.
export interface Advisory {
  ghsa: string;
  cve: string | null;
  severity: string;
  summary: string;
  url: string;
  epss: number;
  alerts: DepAlert[];
  worst: Fix; // the costliest fix among its packages: what the work will actually take
  runtime: boolean; // anything outside dev/build, which is what ships
}

// The costliest verdict wins the group: a lockfile bump beside a major upgrade is a major
// upgrade's worth of work, and saying "lockfile bump" would understate every group.
// `transitive` is NOT on this ladder — it locates a package rather than pricing it, and one
// advisory's transitive package is almost always fixed by bumping the declared parent beside
// it. It is the group's answer only when no package in it has a concrete verdict at all.
const FIX_COST: Fix[] = ["unknown", "none", "major", "manifest", "lockfile"];

export function groupAdvisories(alerts: DepAlert[], manifests: DepManifest[]): Advisory[] {
  const by = new Map<string, DepAlert[]>();
  for (const a of alerts) {
    const key = a.ghsa || `#${a.number}`;
    const bucket = by.get(key);
    if (bucket) bucket.push(a); else by.set(key, [a]);
  }
  const out: Advisory[] = [];
  for (const [ghsa, rows] of by) {
    const head = rows[0];
    let priced: Fix | null = null;
    let viaParent = false;
    for (const r of rows) {
      const k = fixKind(r, declaredIn(manifests, r.pkg));
      if (k === "transitive") { viaParent = true; continue; }
      if (priced === null || FIX_COST.indexOf(k) < FIX_COST.indexOf(priced)) priced = k;
    }
    const worst: Fix = priced ?? (viaParent ? "transitive" : "unknown");
    out.push({
      ghsa,
      cve: head.cve,
      severity: head.severity,
      summary: head.summary,
      url: head.url,
      epss: Math.max(...rows.map((r) => r.epss)),
      alerts: [...rows].sort((x, y) => x.pkg.localeCompare(y.pkg)),
      worst,
      runtime: rows.some((r) => r.scope !== "development"),
    });
  }
  return out.sort(cmpAdvisory);
}

// Severity, then what ships before what only builds, then likelihood, then age. EPSS is
// third rather than first: it moves daily, and a critical is a critical regardless.
export function cmpAdvisory(a: Advisory, b: Advisory): number {
  return sevRank(a.severity) - sevRank(b.severity)
    || Number(b.runtime) - Number(a.runtime)
    || b.epss - a.epss
    || (Date.parse(a.alerts[0]?.createdAt ?? "") || 0) - (Date.parse(b.alerts[0]?.createdAt ?? "") || 0)
    || a.ghsa.localeCompare(b.ghsa);
}

export const CARD_ROWS = 4;
export const cardAdvisories = (list: Advisory[]): Advisory[] => list.slice(0, CARD_ROWS);

// ---------- the bots' pull requests ----------

export type CheckState = "passing" | "failing" | "pending" | "none";

export function checkState(p: DepPr): CheckState {
  if (p.checks.failed > 0) return "failing";
  if (p.checks.pending > 0) return "pending";
  return p.checks.passed > 0 ? "passing" : "none";
}

/** Why this PR is not simply mergeable, in the order a person would hit them. */
export function prBlockers(p: DepPr): string[] {
  const out: string[] = [];
  if (p.draft) out.push("draft");
  if (p.mergeable === "CONFLICTING" || p.mergeState === "DIRTY") out.push("conflicts with the base branch");
  if (p.checks.failed > 0) out.push(`${p.checks.failed} check${p.checks.failed === 1 ? "" : "s"} failing`);
  if (p.checks.pending > 0) out.push("checks still running");
  if (p.mergeState === "BEHIND") out.push("behind the base branch");
  if (p.mergeState === "BLOCKED") out.push("blocked by a branch rule or a missing review");
  return out;
}

/** Ready when nothing blocks it and something actually ran: a PR no CI touched is not evidence. */
export const prReady = (p: DepPr): boolean => !prBlockers(p).length && checkState(p) === "passing";

// A bot names its branch after the package: `dependabot/npm_and_yarn/vitest-4.1.11`,
// `renovate/vitest-4.x`. The title is the fallback, and both may legitimately answer "".
// A grouped run ("all non-major dependencies", "lock file maintenance") names no single
// package, and a PR that claims one it does not touch would hide an advisory as handled.
const NOT_A_PACKAGE = /^(all|all-minor|all-minor-patch|all-major|all-patch|dependencies|deps|lock-file-maintenance|lockfile|major|minor|patch|non-major)$/;

export function prPackages(p: DepPr): string[] {
  const tail = p.branch.replace(/^(dependabot|renovate)\//, "").split("/").pop() ?? "";
  let fromBranch = tail
    .replace(/^(and|npm_and_yarn|cargo|pip|go_modules|github_actions)-/, "")
    .replace(/-\d+(\.\d+)*(\.x)?$/, "");
  // Repeatedly: renovate stacks them, as in `all-minor-patch`.
  let prev = "";
  while (prev !== fromBranch) {
    prev = fromBranch;
    fromBranch = fromBranch.replace(/-(major|minor|patch|digest)$/, "");
  }
  const named = new Set<string>();
  const keep = (n: string) => { if (n && !NOT_A_PACKAGE.test(n)) named.add(n); };
  keep(fromBranch.replace(/--/g, "/"));
  // "Bump vitest from 4.1.0 to 4.1.11", "Update dependency vitest to v4"
  const t = /(?:bump|update(?: dependency)?)\s+([@\w./-]+)/i.exec(p.title);
  if (t) keep(t[1].toLowerCase());
  return [...named];
}

/** The open bot PR that already covers an advisory, so nobody dispatches at solved work. */
export function prFor(adv: Advisory, prs: DepPr[]): DepPr | null {
  const pkgs = new Set(adv.alerts.map((a) => a.pkg.toLowerCase()));
  return prs.find((p) => prPackages(p).some((n) => pkgs.has(n.toLowerCase())))
    ?? prs.find((p) => [...pkgs].some((n) => p.title.toLowerCase().includes(n))) ?? null;
}

// Renovate keeps one issue as its control panel; it is already in the board's own issue
// list, so finding it costs nothing and linking to it is the whole integration.
export function renovateDashboard(threads: GhThread[]): GhThread | null {
  return threads.find((t) =>
    t.kind === "issue"
    && /dependency dashboard/i.test(t.title)
    && (t.author ?? "").toLowerCase().startsWith("renovate")) ?? null;
}

export const isBotPr = (login: string): string => {
  const l = (login || "").toLowerCase().replace(/\[bot\]$/, "").replace(/^app\//, "");
  if (l === "dependabot" || l === "dependabot-preview") return "dependabot";
  return l === "renovate" || l === "renovate-bot" ? "renovate" : "";
};

// ---------- what is merely out of date ----------

export interface OutRow extends Outdated {
  bump: ReturnType<typeof bumpKind>;
  safe: boolean; // `wanted` already clears it: the declared range allows the newer one
  dev: boolean;
}

export function outRows(run: OutdatedRun | null, manifests: DepManifest[]): OutRow[] {
  if (!run?.ok) return [];
  return run.rows
    .map((r) => ({
      ...r,
      bump: bumpKind(r.current, r.latest),
      safe: !!r.wanted && verCmpStr(r.wanted, r.current) > 0,
      dev: /dev|build/i.test(r.kind) || (declaredIn(manifests, r.pkg)?.dev ?? false),
    }))
    .sort((a, b) => Number(b.safe) - Number(a.safe)
      || Number(a.dev) - Number(b.dev)
      || a.pkg.localeCompare(b.pkg));
}

// ---------- the tally the card and the header say ----------

export interface DepTally {
  critical: number;
  high: number;
  vulns: number; // advisories, not alerts: one GHSA is one piece of work
  prs: number;
  ready: number; // bot PRs that are green and unblocked
  outdated: number;
}

export function depTally(adv: Advisory[], prs: DepPr[], out: OutRow[]): DepTally {
  return {
    critical: adv.filter((a) => a.severity === "critical").length,
    high: adv.filter((a) => a.severity === "high").length,
    vulns: adv.length,
    prs: prs.length,
    ready: prs.filter(prReady).length,
    outdated: out.length,
  };
}

/** Nothing to say and nothing to offer: the card is absent rather than empty. */
export const depSilent = (t: DepTally, tools: DepTool[]): boolean =>
  !t.vulns && !t.prs && !t.outdated && !tools.some((x) => !x.blocked);

// ---------- the brief ----------
// The product: an agent is only as good as what it was told, and the sheet shows this
// text before it is sent, so it is written to be read by a person first.

export interface BriefCtx {
  project: string;
  slug: string;
  manifests: DepManifest[];
  verify: string[]; // the project's own test/check commands, from its runnables
}

const bullet = (s: string) => `- ${s}`;

function advisoryLines(a: Advisory, m: DepManifest[]): string[] {
  const head = `### ${a.ghsa}${a.cve ? ` (${a.cve})` : ""} · ${a.severity}`;
  const rows = a.alerts.map((x) => {
    const d = declaredIn(m, x.pkg);
    const where = d ? `declared "${d.range}" in ${d.path}` : `not declared directly (${x.manifest})`;
    const fix = x.patched ? `first patched ${x.patched}` : "no patched version published";
    return bullet(`${x.pkg} — ${x.relationship || "?"}, ${x.scope || "?"}; vulnerable ${x.range}; ${fix}; ${where}`);
  });
  return [head, a.summary, ...rows, bullet(`verdict: ${FIX_TEXT[a.worst]}`), a.url, ""];
}

export function advisoryBrief(picked: Advisory[], ctx: BriefCtx): string {
  const n = picked.length;
  return [
    `Work through ${n} Dependabot ${n === 1 ? "advisory" : "advisories"} in ${ctx.slug || ctx.project}.`,
    "",
    ...picked.flatMap((a) => advisoryLines(a, ctx.manifests)),
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ].join("\n");
}

export function outdatedBrief(picked: OutRow[], ctx: BriefCtx): string {
  const rows = picked.map((r) =>
    bullet(`${r.pkg} ${r.current} → ${r.latest}${r.wanted && r.wanted !== r.latest ? ` (in-range: ${r.wanted})` : ""}`
      + ` · ${r.bump}${r.dev ? " · dev only" : ""}${r.deprecated ? " · DEPRECATED" : ""}`));
  return [
    `Update ${picked.length} out-of-date ${picked.length === 1 ? "dependency" : "dependencies"} in ${ctx.slug || ctx.project}.`,
    "",
    ...rows,
    "",
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ].join("\n");
}

export function prBrief(p: DepPr, ctx: BriefCtx): string {
  const blockers = prBlockers(p);
  return [
    `Review and land ${p.bot} PR #${p.number} in ${ctx.slug || ctx.project}: ${p.title}`,
    p.url,
    "",
    bullet(`branch ${p.branch}`),
    bullet(`checks: ${p.checks.passed} passed, ${p.checks.failed} failed, ${p.checks.pending} running`),
    bullet(blockers.length ? `blocked by: ${blockers.join("; ")}` : "nothing is blocking it"),
    "",
    `Check the PR out locally, read the diff and the upstream release notes between the two`,
    `versions, and decide whether it is safe. If checks are failing, fix them on the branch.`,
    "",
    ...compatBlock(),
    ...verifyBlock(ctx.verify),
  ].join("\n");
}

// The half that makes this worth dispatching at all: an agent that only edits a manifest
// has done the easy third of the job.
function compatBlock(): string[] {
  return [
    "## Before you change anything",
    bullet("Read each advisory and the package's own release notes between the installed and the target version. Say what breaks, not just that it built."),
    bullet("Treat a major bump as breaking until you have read the changelog AND grepped this repo for the package's API at every call site."),
    bullet("Prefer the smallest upgrade that clears the problem; note it when the smallest one is not the latest."),
    bullet("A transitive package is fixed through its parent — find the parent rather than pinning an override, and say so if an override is the only way."),
    bullet("Check peer dependencies and the engines/toolchain floor before you commit to a version."),
    "",
  ];
}

function verifyBlock(verify: string[]): string[] {
  return [
    "## Verify",
    ...(verify.length
      ? [`Run this project's own checks and paste the real output:`, ...verify.map((c) => `    ${c}`)]
      : [`This project declares no test or check task, so say how you verified it instead.`]),
    "",
    "Report per item: what you changed, what you read, what you ran, and anything you could",
    "not verify. Commit nothing and push nothing.",
  ];
}

// The runnables worth naming in a brief, most decisive first. The COMMAND, not the id:
// `npm:test` is not something an agent or a person can type.
export const VERIFY_GROUPS = ["test", "check", "build"];
export function verifyCommands(
  tasks: { cmd: string; group: string | null; blocked: string | null }[],
  limit = 4,
): string[] {
  const seen = new Set<string>();
  return tasks
    .filter((t) => !t.blocked && t.cmd && t.group && VERIFY_GROUPS.includes(t.group))
    .sort((x, y) => VERIFY_GROUPS.indexOf(x.group!) - VERIFY_GROUPS.indexOf(y.group!) || x.cmd.localeCompare(y.cmd))
    .filter((t) => !seen.has(t.cmd) && seen.add(t.cmd))
    .slice(0, limit)
    .map((t) => t.cmd);
}
