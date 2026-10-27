// Maintenance's rules (docs/maintenance.md): the wire narrowed rather than trusted, and what it
// means — a facet's cell, the findings under a card, a project's band and the order cards stand
// in. Facts in, words out: no DOM, no Tauri, and no vendor named, so the next adapter needs none.

import { FACETS, COSTS, facetDef, findSource, permitted, type Cost, type Facet } from "./maintsources";
import { narrowDeploy, type DeployCfg } from "./deploy";

// ---------- the wire (maint.rs; pinned by test/fixtures/maint-wire.json) ----------

export const COV_STATES = ["ok", "off", "noAccess", "noTool", "unsupported", "notRun", "error"] as const;
export type CovState = (typeof COV_STATES)[number];
export type Coverage =
  | { state: "ok" }
  | { state: "off"; reason: string }
  | { state: "noAccess"; reason: string; fix: string | null }
  | { state: "noTool"; tool: string; fix: string | null }
  | { state: "unsupported"; reason: string }
  | { state: "notRun" }
  | { state: "error"; reason: string };

export const CI_STATUSES = ["pass", "fail", "running", "cancelled", "skip", "neutral", "unknown"] as const;
export type CiStatus = (typeof CI_STATUSES)[number];
export const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const ADVISORY_KINDS = ["dependency", "code", "secret", "config"] as const;
export type AdvisoryKind = (typeof ADVISORY_KINDS)[number];

export interface CiRun { workflow: string; status: CiStatus; raw: string; sha: string; at: number | null; url: string | null }
export interface Advisory {
  id: string; aliases: string[]; kind: AdvisoryKind; pkg: string | null; ecosystem: string | null;
  version: string | null; severity: Severity; rawSeverity: string; summary: string;
  fixed: string | null; location: string | null; url: string | null; tool: string;
}
export interface UpdatePr { number: number; title: string; url: string; branch: string; draft: boolean; at: number | null; checks: CiStatus }
export interface ForgeRelease { tag: string; name: string; at: number | null; url: string | null }
export interface Probe { name: string; url: string; code: number | null; ms: number | null; certNotAfter: number | null; err: string | null }
export interface BranchAge { name: string; at: number }
export interface WtAge { path: string; branch: string; at: number | null }

// Every time is unix seconds, as the wire carries it.
export type Facts =
  | { kind: "ciRuns"; branch: string; runs: CiRun[] }
  | { kind: "advisories"; items: Advisory[] }
  | { kind: "updatePrs"; bot: string; configured: boolean; prs: UpdatePr[]; dashboard: number | null }
  | { kind: "release"; trunk: string | null; tag: string | null; tagAt: number | null; since: number;
      oldestUnreleasedAt: number | null; tagsSeen: number; fetchedAt: number | null }
  | { kind: "releases"; latest: ForgeRelease | null; count: number }
  | { kind: "changelog"; unreleased: number | null; latest: string | null; latestAt: number | null }
  | { kind: "hygiene"; trunk: string | null; unpushed: number | null; localOnly: string[]; merged: string[];
      gone: string[]; branches: BranchAge[]; worktrees: WtAge[]; fetchedAt: number | null }
  | { kind: "work"; issues: number; prs: number; reviewRequested: number | null } // null: the search failed
  | { kind: "probes"; items: Probe[] };
export type FactKind = Facts["kind"];
type FactsOf<K extends FactKind> = Extract<Facts, { kind: K }>;

/** The one facet each kind may answer (`Facts::facet`); a record, so a new kind fails to compile here. */
export const FACT_FACET: Record<FactKind, Facet> = {
  ciRuns: "ci", advisories: "security", updatePrs: "deps", release: "release", releases: "release",
  changelog: "release", hygiene: "git", work: "work", probes: "prod",
};
export const FACT_KINDS = Object.keys(FACT_FACET) as FactKind[];

export interface SourceReport {
  source: string; facet: Facet | null; cost: Cost | null; coverage: Coverage;
  at: number | null; truncated: boolean; gaps: string[]; facts: Facts | null;
}

export const FORGE_BY = ["pin", "table", "name", "none"] as const;
export interface Forge { kind: string; host: string | null; path: string | null; by: (typeof FORGE_BY)[number] }
export interface Marker { facet: Facet; label: string; found: string[] }
export interface MaintConfig {
  readable: boolean; forge: string | null; off: string[]; sources: Record<string, string[]>; bots: string[];
  trunk: string | null; tagPattern: string | null; sarif: string[]; params: Record<string, string>;
  thresholds: Record<string, number>;
}
/** `deploy` is `[deploy]` with its unsafe values dropped, or null without one. */
export interface Detection { repoRoot: string; forge: Forge; sources: string[]; markers: Marker[]; config: MaintConfig; deploy: DeployCfg | null }

// ---------- narrowing ----------

type Is = (v: unknown) => boolean;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str: Is = (v) => typeof v === "string";
const num: Is = (v) => typeof v === "number" && Number.isFinite(v);
const bool: Is = (v) => typeof v === "boolean";
const opt = (f: Is): Is => (v) => v === null || f(v);
const list = (f: Is): Is => (v) => Array.isArray(v) && v.every(f);
const oneOf = (all: readonly string[]): Is => (v) => typeof v === "string" && all.includes(v);
const shape = (spec: Record<string, Is>): Is => (v) => isObj(v) && Object.entries(spec).every(([k, f]) => f(v[k]));

const isCiRun = shape({ workflow: str, status: oneOf(CI_STATUSES), raw: str, sha: str, at: opt(num), url: opt(str) });
const isAdvisory = shape({
  id: str, aliases: list(str), kind: oneOf(ADVISORY_KINDS), pkg: opt(str), ecosystem: opt(str), version: opt(str),
  severity: oneOf(SEVERITIES), rawSeverity: str, summary: str, fixed: opt(str), location: opt(str), url: opt(str), tool: str,
});
const isPr = shape({ number: num, title: str, url: str, branch: str, draft: bool, at: opt(num), checks: oneOf(CI_STATUSES) });
const isProbe = shape({ name: str, url: str, code: opt(num), ms: opt(num), certNotAfter: opt(num), err: opt(str) });

const FACT_SHAPES: Record<FactKind, Is> = {
  ciRuns: shape({ branch: str, runs: list(isCiRun) }),
  advisories: shape({ items: list(isAdvisory) }),
  updatePrs: shape({ bot: str, configured: bool, prs: list(isPr), dashboard: opt(num) }),
  release: shape({ trunk: opt(str), tag: opt(str), tagAt: opt(num), since: num, oldestUnreleasedAt: opt(num), tagsSeen: num, fetchedAt: opt(num) }),
  releases: shape({ latest: opt(shape({ tag: str, name: str, at: opt(num), url: opt(str) })), count: num }),
  changelog: shape({ unreleased: opt(num), latest: opt(str), latestAt: opt(num) }),
  hygiene: shape({
    trunk: opt(str), unpushed: opt(num), localOnly: list(str), merged: list(str), gone: list(str),
    branches: list(shape({ name: str, at: num })), worktrees: list(shape({ path: str, branch: str, at: opt(num) })), fetchedAt: opt(num),
  }),
  work: shape({ issues: num, prs: num, reviewRequested: opt(num) }),
  probes: shape({ items: list(isProbe) }),
};

const COV_SHAPES: Record<CovState, Is> = {
  ok: () => true, notRun: () => true,
  off: shape({ reason: str }), unsupported: shape({ reason: str }), error: shape({ reason: str }),
  noAccess: shape({ reason: str, fix: opt(str) }), noTool: shape({ tool: str, fix: opt(str) }),
};
const isCoverage = (v: unknown): v is Coverage =>
  isObj(v) && oneOf(COV_STATES)(v.state) && COV_SHAPES[v.state as CovState](v);
const isFacts = (v: unknown): v is Facts =>
  isObj(v) && oneOf(FACT_KINDS)(v.kind) && FACT_SHAPES[v.kind as FactKind](v);

// Filed under the facet it claimed when this build does not know the id, so its cell can say so.
function broken(source: string, reason: string, raw?: Obj): SourceReport {
  const d = findSource(source);
  const facet = d?.facet ?? (oneOf(FACETS)(raw?.facet) ? raw!.facet as Facet : null);
  return {
    source, facet, cost: d?.cost ?? null, coverage: { state: "error", reason },
    at: null, truncated: false, gaps: [], facts: null,
  };
}

/** One `maint_read` answer for `source`. A wrong shape is an `error` for that source alone. */
export function narrowMaint(raw: unknown, source: string): SourceReport {
  if (!isObj(raw) || raw.source !== source) return broken(source, "the report had the wrong shape");
  if (!isCoverage(raw.coverage)) return broken(source, "the report's coverage had the wrong shape", raw);
  const facet = oneOf(FACETS)(raw.facet) ? raw.facet as Facet : null;
  const ok = raw.coverage.state === "ok";
  if (ok && (!isFacts(raw.facts) || FACT_FACET[raw.facts.kind] !== facet)) return broken(source, "the report's facts had the wrong shape", raw);
  return {
    source, facet, cost: oneOf(COSTS)(raw.cost) ? raw.cost as Cost : null, coverage: raw.coverage,
    at: num(raw.at) ? raw.at as number : null, truncated: raw.truncated === true,
    gaps: Array.isArray(raw.gaps) ? raw.gaps.filter((g): g is string => typeof g === "string") : [],
    facts: ok ? raw.facts as Facts : null,
  };
}

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const strOr = (v: unknown): string | null => typeof v === "string" ? v : null;
function record<T>(v: unknown, ok: Is): Record<string, T> {
  return isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<string, T> : {};
}

/** A `maint_detect` answer, or null: a detection we cannot read leaves every cell unread. */
export function narrowDetection(raw: unknown): Detection | null {
  if (!isObj(raw) || !str(raw.repoRoot) || !isObj(raw.forge) || !isObj(raw.config)) return null;
  const f = raw.forge, c = raw.config;
  return {
    repoRoot: raw.repoRoot as string,
    forge: { kind: strOr(f.kind) ?? "unknown", host: strOr(f.host), path: strOr(f.path), by: oneOf(FORGE_BY)(f.by) ? f.by as Forge["by"] : "none" },
    sources: strs(raw.sources),
    markers: Array.isArray(raw.markers) ? raw.markers.filter(shape({ facet: oneOf(FACETS), label: str, found: list(str) })) as Marker[] : [],
    config: {
      readable: c.readable !== false, forge: strOr(c.forge), off: strs(c.off), sources: record(c.sources, list(str)),
      bots: strs(c.bots), trunk: strOr(c.trunk), tagPattern: strOr(c.tagPattern), sarif: strs(c.sarif),
      params: record(c.params, str), thresholds: record(c.thresholds, num),
    },
    deploy: narrowDeploy(raw.deploy),
  };
}

// ---------- thresholds ----------

export interface MaintThresholds {
  unreleasedCommits: number;
  unreleasedDays: number; // the oldest unreleased commit's age
  staleBranchDays: number;
  certWarnDays: number;
  botSilentDays: number; // a configured bot whose newest open PR is older says nothing about itself
  botPrBacklog: number; // open update PRs that count as a pile
  fetchStaleDays: number; // release and git counts are as old as the last fetch
}
export const MAINT_DEFAULTS: MaintThresholds = {
  unreleasedCommits: 30, unreleasedDays: 21, staleBranchDays: 30,
  certWarnDays: 21, botSilentDays: 30, botPrBacklog: 5, fetchStaleDays: 7,
};
const RAW_KEYS: Record<keyof MaintThresholds, string> = {
  unreleasedCommits: "unreleased_commits", unreleasedDays: "unreleased_days",
  staleBranchDays: "stale_branch_days", certWarnDays: "cert_warn_days", botSilentDays: "bot_silent_days",
  botPrBacklog: "bot_pr_backlog", fetchStaleDays: "fetch_stale_days",
};

/** `[maintenance.thresholds]` over the defaults. Non-positive is refused: a 0 would fire on every project. */
export function clampMaint(raw: unknown): MaintThresholds {
  const o = isObj(raw) ? raw : {};
  const out = { ...MAINT_DEFAULTS };
  for (const k of Object.keys(RAW_KEYS) as (keyof MaintThresholds)[]) {
    const v = o[RAW_KEYS[k]];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

// ---------- a facet's cell ----------

export type Level = "bad" | "warn" | "info" | "ok" | "muted" | "unread";
export type CellState = "off" | "unread" | "none" | "markers" | "cantCheck" | "read" | "past"; // past: the snapshot's
export interface Cell {
  facet: Facet; state: CellState; level: Level;
  text: string; // the few words a card shows; "" with level ok is the grey dot
  tip: string[]; // the whole story, a line each: what was read, what was not and why
  fix: string | null; // the command that would let a source answer
  asOf: number | null; // the last fetch these counts are as old as (unix secs)
}

/** What the cells are made from: one project's detection and the reports that have landed. */
export interface MaintInput {
  det: Detection | null;
  reports: Readonly<Record<string, SourceReport>>;
  skip?: readonly string[]; // sources this machine skips (`MaintPrefs.off`)
  asking?: readonly string[]; // click-only sources whose read is still out
}

const DAY = 86_400, HOUR = 3_600;
/** A cell-sized age: 12m, 4h, 3d. */
export function span(sec: number): string {
  const s = Math.max(0, sec);
  if (s < HOUR) return `${Math.max(1, Math.round(s / 60))}m`;
  return s < DAY ? `${Math.floor(s / HOUR)}h` : `${Math.floor(s / DAY)}d`;
}
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// The tip's order: a coverage that carries a fix first, then the ones that only explain.
const COV_RANK: CovState[] = ["noAccess", "noTool", "off", "error", "unsupported", "notRun", "ok"];
export function covText(c: Coverage): string {
  switch (c.state) {
    case "ok": return "read";
    case "off": return `off: ${c.reason}`;
    case "noAccess": return `no access: ${c.reason}`;
    case "noTool": return `${c.tool} not available`;
    case "unsupported": return c.reason;
    case "notRun": return "never run";
    case "error": return `failed: ${c.reason}`;
  }
}
const fixOf = (c: Coverage): string | null => c.state === "noAccess" || c.state === "noTool" ? c.fix : null;
const labelOf = (id: string) => findSource(id)?.label ?? id;

interface Judged { level: Level; text: string; tip: string[]; asOf?: number | null }
interface Ctx { th: MaintThresholds; now: number; trunc: boolean; reps: SourceReport[] }
type Rule = (facts: Facts[], c: Ctx) => Judged;

const kinds = <K extends FactKind>(facts: Facts[], k: K): FactsOf<K>[] =>
  facts.filter((f): f is FactsOf<K> => f.kind === k);
const count = (n: number, c: Ctx) => `${n}${c.trunc ? "+" : ""}`;

// `since` and `sha` are the first red run's, null from a source blind to ci.failing-since; `floor`
// marks a streak that ran off a capped page.
export interface CiFailure { workflow: string; since: number | null; floor: boolean; sha: string | null; url: string | null; branch: string }
type CiReport = Pick<SourceReport, "source" | "truncated" | "facts">;

/** Workflows whose newest run failed, each with the oldest of its unbroken run of failures. */
export function ciFailures(reps: CiReport[]): CiFailure[] {
  const out: CiFailure[] = [];
  for (const { source, truncated, facts: f } of reps) {
    if (f?.kind !== "ciRuns") continue;
    const dated = !!findSource(source)?.sees.includes("ci.failing-since");
    const by = new Map<string, CiRun[]>();
    for (const r of f.runs) by.set(r.workflow, [...(by.get(r.workflow) ?? []), r]);
    for (const [workflow, runs] of by) {
      let i = 0;
      while (i < runs.length && runs[i].status === "fail") i++;
      if (!i) continue;
      const first = runs[i - 1];
      out.push({ workflow, since: dated ? first.at : null, floor: dated && truncated && i === runs.length,
        sha: dated ? first.sha : null, url: runs[0].url, branch: f.branch });
    }
  }
  return out.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.workflow.localeCompare(b.workflow));
}
/** How long a failure has been red ("3d", a floor "3d+"), or null when its source cannot say. */
export const redFor = (x: CiFailure, sec: number): string | null =>
  x.since === null ? null : `${span(sec - x.since)}${x.floor ? "+" : ""}`;

// Positive evidence only: zero runs is "never ran", and skips alone are not a pass.
const ciRule: Rule = (facts, c) => {
  const all = kinds(facts, "ciRuns");
  const runs = all.flatMap((f) => f.runs);
  const branch = [...new Set(all.map((f) => f.branch))].join(", ");
  if (!runs.length) return { level: "muted", text: "never ran", tip: [`no run on ${branch} yet, so no pass either`] };
  const fail = ciFailures(c.reps), sec = c.now / 1000;
  if (fail.length) {
    const age = (x: CiFailure) => redFor(x, sec) ?? "";
    const tip = fail.map((x) => [`${x.workflow}: failing ${age(x)}`.trim(), x.sha && `first red at ${x.sha.slice(0, 7)}`].filter(Boolean).join(", "));
    return { level: "bad", text: `failing ${age(fail[0])}`.trim(), tip };
  }
  const latest = new Map<string, CiRun>();
  for (const r of runs) if (!latest.has(r.workflow)) latest.set(r.workflow, r);
  const st = [...latest.values()].map((r) => r.status);
  // `neutral` hides why (a pipeline held at a manual job, say); the raw word says it.
  const tip = [...latest].map(([w, r]) => `${w}: ${r.status}${r.status === "neutral" && r.raw && r.raw !== r.status ? ` (${r.raw})` : ""}`);
  if (st.includes("running")) return { level: "info", text: "running", tip };
  if (!st.includes("pass")) return { level: "muted", text: "no passing run", tip };
  // One workflow's pass never vouches for another whose newest run was cancelled or unknown.
  const odd = st.filter((s) => s !== "pass" && s !== "skip");
  if (!odd.length) return { level: "ok", text: "", tip: [`${plural(latest.size, "workflow")} on ${branch}`, ...tip] };
  return { level: "muted", text: `${odd.length} ${new Set(odd).size === 1 ? odd[0] : "not passing"}`, tip };
};

const SEV_LEVEL: Record<Severity, Level> = { critical: "bad", high: "bad", medium: "warn", low: "info", unknown: "info" };
const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

const securityRule: Rule = (facts, c) => {
  const merged = mergeAdvisories(kinds(facts, "advisories").map((f) => f.items));
  if (!merged.length) return { level: "ok", text: "", tip: ["no open advisories"] };
  const tip = merged.map((a) => [a.severity, a.id, a.pkgs.join(", ") || a.items[0]?.location].filter(Boolean).join(" · "));
  const secrets = merged.filter((a) => a.kind === "secret").length;
  if (secrets) return { level: "bad", text: `${count(secrets, c)} secret${secrets === 1 ? "" : "s"}`, tip };
  const worst = merged[0].severity;
  return { level: SEV_LEVEL[worst], text: `${count(merged.filter((a) => a.severity === worst).length, c)} ${worst}`, tip };
};

// A bot nothing shows to be alive is silent, not healthy: open PRs are the only trace it leaves.
const depsRule: Rule = (facts, c) => {
  const ups = kinds(facts, "updatePrs");
  const prs = ups.flatMap((u) => u.prs);
  if (!prs.length && !ups.some((u) => u.configured)) return { level: "muted", text: facetDef("deps").none, tip: [] };
  const red = prs.filter((p) => p.checks === "fail").length;
  // An undated PR still shows the bot ran; only a known date can say it has gone quiet.
  const dated = prs.flatMap((p) => p.at !== null ? [p.at] : []);
  const age = dated.length ? c.now / 1000 - Math.max(...dated) : null;
  const silent = prs.length ? age !== null && age > c.th.botSilentDays * DAY : !ups.some((u) => u.dashboard !== null);
  const quiet = age !== null ? `newest PR ${span(age)} old` : "configured, but no open PR shows it has run";
  const tip = [...prs.map((p) => `#${p.number} ${p.title} · checks ${p.checks}`), ...(silent ? [quiet] : [])];
  if (red) return { level: "warn", text: `${count(red, c)} red`, tip };
  if (prs.length >= c.th.botPrBacklog) return { level: "warn", text: `${count(prs.length, c)} PRs`, tip };
  if (silent) return { level: "muted", text: "silent", tip };
  return prs.length ? { level: "info", text: `${count(prs.length, c)} PR${prs.length === 1 ? "" : "s"}`, tip } : { level: "ok", text: "", tip };
};

const releaseRule: Rule = (facts, c) => {
  const [rel] = kinds(facts, "release"), [pub] = kinds(facts, "releases"), [log] = kinds(facts, "changelog");
  const now = c.now / 1000, tip: string[] = [];
  if (log?.unreleased) tip.push(`CHANGELOG.md: ${plural(log.unreleased, "entry", "entries")} under Unreleased`);
  if (pub?.latest) tip.push(`last published ${pub.latest.tag}${pub.latest.at ? `, ${span(now - pub.latest.at)} ago` : ""}`);
  const asOf = rel?.fetchedAt ?? null;
  if (rel?.tag) {
    const at = rel.tagAt ? `, ${span(now - rel.tagAt)}` : "";
    if (!rel.since) return { level: "ok", text: `${rel.tag}${at}`, tip, asOf };
    const old = rel.oldestUnreleasedAt ? now - rel.oldestUnreleasedAt : 0;
    const drift = rel.since >= c.th.unreleasedCommits || old >= c.th.unreleasedDays * DAY;
    tip.unshift(`${plural(rel.since, "commit")} since ${rel.tag}${old ? `, oldest ${span(old)}` : ""}`);
    return { level: drift ? "warn" : "info", text: `${rel.since} unreleased`, tip, asOf };
  }
  if (rel) tip.unshift(`no release tag on ${rel.trunk ?? "the trunk"}`);
  if (pub?.latest) return { level: "ok", text: `${pub.latest.tag}${pub.latest.at ? `, ${span(now - pub.latest.at)}` : ""}`, tip, asOf };
  if (log?.unreleased) return { level: "info", text: `${log.unreleased} in Unreleased`, tip, asOf };
  if (log?.latest) return { level: "ok", text: `${log.latest}${log.latestAt ? `, ${span(now - log.latestAt)}` : ""}`, tip, asOf };
  return { level: "muted", text: rel ? "no tags" : facetDef("release").none, tip, asOf };
};

type HygieneFacts = FactsOf<"hygiene">;
// Untouched past the threshold: a branch that lives only here, and a worktree nobody opened.
function aged(h: HygieneFacts, th: MaintThresholds, sec: number): { stale: BranchAge[]; idle: WtAge[] } {
  const old = th.staleBranchDays * DAY;
  return {
    stale: h.branches.filter((b) => h.localOnly.includes(b.name) && sec - b.at > old),
    idle: h.worktrees.filter((w) => w.at !== null && sec - w.at > old),
  };
}

const gitRule: Rule = (facts, c) => {
  const [h] = kinds(facts, "hygiene");
  if (!h) return { level: "muted", text: "", tip: [] };
  const tidy = h.merged.length + h.gone.length;
  const { stale, idle } = aged(h, c.th, c.now / 1000);
  const tip = [
    h.unpushed === null ? "no remote, so what is unpushed is unknown" : `${plural(h.unpushed, "commit")} on no remote`,
    ...(h.localOnly.length ? [`only here: ${h.localOnly.join(", ")}`] : []),
    ...(h.merged.length ? [`merged into ${h.trunk ?? "the trunk"}: ${h.merged.join(", ")}`] : []),
    ...(h.gone.length ? [`upstream gone: ${h.gone.join(", ")}`] : []),
    ...(stale.length ? [`untouched ${c.th.staleBranchDays}d+: ${stale.map((b) => b.name).join(", ")}`] : []),
    ...(idle.length ? [`${plural(idle.length, "worktree")} idle ${c.th.staleBranchDays}d+`] : []),
  ];
  const j = (level: Level, text: string): Judged => ({ level, text, tip, asOf: h.fetchedAt });
  if (h.unpushed) return j("warn", `${h.unpushed} unpushed`);
  if (h.localOnly.length) return j("warn", `${h.localOnly.length} local-only`);
  if (tidy || stale.length || idle.length) return j("info", `${tidy + stale.length + idle.length} to tidy`);
  return h.unpushed === null ? j("muted", "no remote") : j("ok", "");
};

// A certificate nobody could read is unknown, never fine.
const prodRule: Rule = (facts, c) => {
  const items = kinds(facts, "probes").flatMap((f) => f.items);
  if (!items.length) return { level: "muted", text: facetDef("prod").none, tip: [] };
  const now = c.now / 1000;
  const cert = (at: number) => at <= now ? `cert expired ${span(now - at)} ago` : `cert ${span(at - now)}`;
  const tip = items.map((p) => `${p.name}: ${p.err ?? p.code ?? "no answer"}${p.certNotAfter ? ` · ${cert(p.certNotAfter)}` : ""}`);
  const down = items.filter((p) => p.err !== null || p.code === null || p.code >= 500);
  if (down.length) return { level: "bad", text: down.length === 1 ? `${down[0].name} ${down[0].code ?? "down"}` : `${down.length} down`, tip };
  if (items.some((p) => p.certNotAfter !== null && p.certNotAfter <= now)) return { level: "bad", text: "cert expired", tip };
  const client = items.find((p) => p.code !== null && p.code >= 400);
  if (client) return { level: "warn", text: `${client.name} ${client.code}`, tip };
  const soon = items.filter((p) => p.certNotAfter !== null).sort((a, b) => a.certNotAfter! - b.certNotAfter!)[0];
  if (soon && soon.certNotAfter! - now < c.th.certWarnDays * DAY) return { level: "warn", text: `cert ${span(soon.certNotAfter! - now)}`, tip };
  if (items.some((p) => p.url.startsWith("https:") && p.certNotAfter === null)) return { level: "muted", text: "cert unknown", tip };
  return { level: "ok", text: "", tip };
};

const workRule: Rule = (facts, c) => {
  const w = kinds(facts, "work");
  const sum = (k: "issues" | "prs" | "reviewRequested") => w.reduce((n, x) => n + (x[k] ?? 0), 0);
  const tip = [`${plural(sum("issues"), "open issue")}`, `${plural(sum("prs"), "open pull request")}`];
  if (sum("reviewRequested")) return { level: "warn", text: `${count(sum("reviewRequested"), c)} to review`, tip };
  if (sum("issues")) return { level: "info", text: `${count(sum("issues"), c)} open`, tip };
  // The one figure that turns this amber was never read, so nothing here may be grey.
  return w.some((x) => x.reviewRequested === null) ? { level: "muted", text: "reviews unknown", tip } : { level: "ok", text: "", tip };
};

const RULES: Record<Facet, Rule> = {
  ci: ciRule, security: securityRule, deps: depsRule, release: releaseRule, git: gitRule, prod: prodRule, work: workRule,
};

const skipped = (id: string): SourceReport => ({
  source: id, facet: findSource(id)?.facet ?? null, cost: findSource(id)?.cost ?? null,
  coverage: { state: "off", reason: "skipped on this machine" }, at: null, truncated: false, gaps: [], facts: null,
});

/** The facet's reports in detection order, or null while any is still out. An id this build does not
 *  know files under its report's own facet. */
function facetReports(facet: Facet, inp: MaintInput): SourceReport[] | null {
  const out: SourceReport[] = [];
  for (const id of inp.det?.sources ?? []) {
    if ((findSource(id)?.facet ?? inp.reports[id]?.facet) !== facet) continue;
    const r = inp.skip?.includes(id) ? skipped(id) : inp.reports[id];
    if (!r) return null;
    out.push(r);
  }
  return out;
}

/** docs/maintenance.md's ladder, top-down. Only its last step may draw the grey dot. */
export function facetCell(facet: Facet, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Cell {
  const cell = (state: CellState, level: Level, text: string, tip: string[] = [], fix: string | null = null, asOf: number | null = null): Cell =>
    ({ facet, state, level, text, tip, fix, asOf });
  const det = inp.det;
  if (det?.config.off.includes(facet)) return cell("off", "muted", "not tracked", ["switched off in .episko/episko.toml"]);
  const reps = det ? facetReports(facet, inp) : null;
  if (!det || !reps) return cell("unread", "unread", "");
  const head = det.config.readable ? [] : ["episko.toml unreadable: its settings are not applied"];
  const markers = det.markers.filter((m) => m.facet === facet);
  const found = markers.map((m) => `${m.label}: found ${m.found.length ? m.found.join(", ") : "on this forge"}, nothing reads it yet`);
  if (!reps.length && !markers.length) return cell("none", "muted", facetDef(facet).none, head);
  if (!reps.length) return cell("markers", "muted", `can't check (${markers.map((m) => m.label).join(", ")})`, [...head, ...found]);
  const ranked = [...reps].sort((a, b) => COV_RANK.indexOf(a.coverage.state) - COV_RANK.indexOf(b.coverage.state));
  const notes = ranked.filter((r) => r.coverage.state !== "ok").map((r) => `${labelOf(r.source)}: ${covText(r.coverage)}`);
  const fix = ranked.map((r) => fixOf(r.coverage)).find((f) => f) ?? null;
  const ok = reps.filter((r) => r.coverage.state === "ok" && r.facts);
  // A click-only source nobody clicked is not one that cannot answer: one click reads it.
  const unasked = reps.every((r) => r.coverage.state === "notRun");
  if (!ok.length) return cell("cantCheck", "muted", unasked ? "not checked" : "can't check", [...head, ...notes, ...found], fix);
  const trunc = ok.some((r) => r.truncated);
  const j = RULES[facet](ok.map((r) => r.facts!), { th, now, trunc, reps: ok });
  const asOf = j.asOf ?? null;
  let { level, text } = j;
  const age = asOf !== null ? now / 1000 - asOf : null;
  if (age !== null && age > th.fetchStaleDays * DAY && (level === "ok" || level === "info")) {
    level = "warn";
    text ||= `fetched ${span(age)} ago`; // amber is never the empty grey dot's text
  }
  const fetched = age !== null ? [`as of last fetch ${span(age)} ago`] : [];
  const gaps = ok.flatMap((r) => r.gaps.map((g) => `${labelOf(r.source)}: ${g}`));
  const capped = trunc ? ["a list hit its page cap, so counts are floors"] : [];
  return cell("read", level, text, [...head, ...fetched, ...j.tip, ...notes, ...gaps, ...capped, ...found], fix, asOf);
}

export const facetCells = (inp: MaintInput, th = MAINT_DEFAULTS, now = Date.now()): Cell[] =>
  FACETS.map((f) => facetCell(f, inp, th, now));

// ---------- advisories, one row per vulnerability ----------

export interface MergedAdvisory {
  key: string; // the row's identity: the id, and for a finding in code also where it is
  id: string; aliases: string[]; kind: AdvisoryKind; severity: Severity; summary: string;
  url: string | null; pkgs: string[]; tools: string[];
  fixed: string | null; // only when the row is one package: another package's fix is not this one's
  items: Advisory[]; // every report behind the row, as reported
}

// A dependency advisory is one vulnerability wherever it lands; a rule firing in two files is two findings.
const placeOf = (a: Advisory) => a.kind === "dependency" ? "" : `@${a.location ?? ""}`;
const keysOf = (a: Advisory) => [a.id, ...a.aliases].map((k) => k.toUpperCase() + placeOf(a));

/** Every reporter's rows, folded where any id or alias is shared (case-blind, so `cve-` meets `CVE-`),
 *  one row per vulnerability at its worst severity. */
export function mergeAdvisories(lists: readonly (readonly Advisory[])[]): MergedAdvisory[] {
  const groups: { keys: Set<string>; items: Advisory[] }[] = [];
  for (const a of lists.flat()) {
    const keys = keysOf(a);
    const hits = groups.filter((g) => keys.some((k) => g.keys.has(k)));
    const into = hits[0] ?? { keys: new Set<string>(), items: [] };
    if (!hits.length) groups.push(into);
    for (const g of hits.slice(1)) {
      into.items.push(...g.items);
      for (const k of g.keys) into.keys.add(k);
      groups.splice(groups.indexOf(g), 1);
    }
    into.items.push(a);
    for (const k of keys) into.keys.add(k);
  }
  return groups.map(({ items }) => {
    const worst = [...items].sort((a, b) => sevRank(a.severity) - sevRank(b.severity))[0];
    const ids = [...new Set(items.map((x) => x.id))].sort();
    const spelled = new Map<string, string>(); // one spelling per name, the first reported
    for (const k of items.flatMap((x) => [x.id, ...x.aliases])) if (!spelled.has(k.toUpperCase())) spelled.set(k.toUpperCase(), k);
    spelled.delete(ids[0].toUpperCase());
    const pkgs = [...new Set(items.flatMap((x) => x.pkg ? [`${x.ecosystem ?? ""}:${x.pkg}`] : []))];
    return {
      key: ids[0] + placeOf(worst),
      id: ids[0], aliases: [...spelled.values()].sort(), kind: worst.kind, severity: worst.severity,
      summary: worst.summary || (items.find((x) => x.summary)?.summary ?? ""),
      url: items.find((x) => x.url)?.url ?? null, fixed: pkgs.length === 1 ? items.find((x) => x.fixed)?.fixed ?? null : null,
      pkgs: [...new Set(items.flatMap((x) => x.pkg ? [x.pkg] : []))].sort(),
      tools: [...new Set(items.map((x) => x.tool))].sort(), items,
    };
  }).sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.key.localeCompare(b.key));
}

const FINDING_TEXT: Record<AdvisoryKind, string> = { dependency: "advisory", code: "code finding", config: "misconfiguration", secret: "secret" };

// ---------- findings, the lines under a card ----------

export type Verb = "fix" | "patch" | "rotate" | "release" | "push" | "tidy" | "review" | "fetch" | "run" | "setup";
export interface Finding {
  root: string; facet: Facet; key: string; level: "bad" | "warn" | "info";
  text: string; detail: string; verb: Verb;
  source: string; // the report it came from
  ref: string | null; // what in that report: a workflow, an advisory id, a bot, a tag, a probe
  busy?: boolean; // a Run row whose read is out, so a second click cannot start it again
}

const okFacts = (inp: MaintInput, facet: Facet): { source: string; truncated: boolean; facts: Facts }[] =>
  inp.det?.config.off.includes(facet) ? [] : (inp.det?.sources ?? [])
    .map((id) => inp.reports[id])
    .filter((r): r is SourceReport => !!r && r.coverage.state === "ok" && !!r.facts && FACT_FACET[r.facts.kind] === facet && !inp.skip?.includes(r.source))
    .map((r) => ({ source: r.source, truncated: r.truncated, facts: r.facts! }));

const LEVEL_RANK = { bad: 0, warn: 1, info: 2 } as const;
const workFacts = (inp: MaintInput) => okFacts(inp, "work")
  .flatMap((r) => r.facts.kind === "work" ? [{ source: r.source, facts: r.facts }] : []);

/** Every finding for one project, worst first. Each carries the verb that answers it. */
export function findings(root: string, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const add = (facet: Facet, f: Omit<Finding, "root" | "facet">) => out.push({ root, facet, ...f });
  const sec = now / 1000;
  for (const r of okFacts(inp, "ci")) {
    for (const x of ciFailures([r])) {
      const age = redFor(x, sec);
      add("ci", { key: `ci:${x.workflow}`, level: "bad", text: `CI failing${age ? ` ${age}` : ""}`,
        detail: `${x.workflow} on ${x.branch}${x.sha ? ` · first red at ${x.sha.slice(0, 7)}` : ""}`, verb: "fix", source: r.source, ref: x.workflow });
    }
  }
  const advs = okFacts(inp, "security");
  for (const a of mergeAdvisories(advs.map((r) => r.facts.kind === "advisories" ? r.facts.items : []))) {
    const secret = a.kind === "secret", dep = a.kind === "dependency";
    const lvl = secret ? "bad" : SEV_LEVEL[a.severity];
    const source = advs.find((r) => r.facts.kind === "advisories" && r.facts.items.some((i) => a.items.includes(i)))?.source ?? "";
    // Only a dependency has a published fix to name; code is fixed in place, and a secret is rotated.
    const fix = !dep ? "" : a.fixed ? `fixed in ${a.fixed}` : a.items.some((x) => x.fixed) ? "" : "no fix published";
    add("security", { key: `security:${a.key}`, level: lvl === "bad" ? "bad" : lvl === "warn" ? "warn" : "info",
      text: secret ? "secret reported" : `${a.severity === "unknown" ? "" : `${a.severity} `}${FINDING_TEXT[a.kind]}`,
      detail: [a.pkgs.join(", ") || a.items[0]?.location, fix, a.summary].filter(Boolean).join(" · "),
      verb: secret ? "rotate" : dep ? "patch" : "fix", source, ref: a.key });
  }
  for (const { source, facts } of okFacts(inp, "deps")) {
    if (facts.kind !== "updatePrs" || !facts.prs.length) continue;
    const red = facts.prs.filter((p) => p.checks === "fail").length;
    const pile = facts.prs.length >= th.botPrBacklog;
    add("deps", { key: `deps:${facts.bot}`, level: red || pile ? "warn" : "info",
      text: red ? `${plural(red, "update PR")} red` : `${plural(facts.prs.length, "update PR")} open`,
      detail: facts.prs.slice(0, 3).map((p) => `#${p.number} ${p.title}`).join(" · "), verb: "review", source, ref: facts.bot });
  }
  for (const { source, facts } of okFacts(inp, "release")) {
    if (facts.kind !== "release" || !facts.tag || !facts.since) continue;
    const old = facts.oldestUnreleasedAt ? sec - facts.oldestUnreleasedAt : 0;
    const drift = facts.since >= th.unreleasedCommits || old >= th.unreleasedDays * DAY;
    add("release", { key: "release", level: drift ? "warn" : "info", text: `${plural(facts.since, "commit")} since ${facts.tag}`,
      detail: old ? `oldest unreleased ${span(old)}` : "", verb: "release", source, ref: facts.tag });
  }
  for (const { source, facts } of okFacts(inp, "git")) {
    if (facts.kind !== "hygiene") continue;
    if (facts.unpushed) add("git", { key: "git:unpushed", level: "warn", text: `${plural(facts.unpushed, "commit")} only on this machine`,
      detail: facts.localOnly.length ? `never pushed: ${facts.localOnly.join(", ")}` : "ahead of every remote", verb: "push", source, ref: null });
    const tidy = [...facts.merged, ...facts.gone];
    if (tidy.length) add("git", { key: "git:tidy", level: "info", text: `${plural(tidy.length, "branch", "branches")} to tidy`,
      detail: tidy.slice(0, 4).join(", ") + (tidy.length > 4 ? " …" : ""), verb: "tidy", source, ref: null });
  }
  // One line for the amber a stale fetch lifts onto the Git and Release cells, so it never goes unexplained.
  const fetched = [...okFacts(inp, "git"), ...okFacts(inp, "release")]
    .flatMap(({ source, facts }) => "fetchedAt" in facts && facts.fetchedAt !== null ? [{ source, at: facts.fetchedAt }] : [])
    .sort((a, b) => b.at - a.at)[0];
  if (fetched && sec - fetched.at > th.fetchStaleDays * DAY) {
    add("git", { key: "git:fetch", level: "warn", text: `last fetch ${span(sec - fetched.at)} ago`,
      detail: "release and branch counts are as old as it", verb: "fetch", source: fetched.source, ref: null });
  }
  // The Work cell's amber, so it has a line under it like every other.
  const work = workFacts(inp);
  const asked = work.reduce((n, w) => n + (w.facts.reviewRequested ?? 0), 0);
  if (asked) add("work", { key: "work:review", level: "warn", text: `${plural(asked, "review")} requested of you`,
    detail: "pull requests waiting on your review", verb: "review", source: work[0].source, ref: null });
  for (const { source, facts } of okFacts(inp, "prod")) {
    if (facts.kind !== "probes") continue;
    for (const p of facts.items) {
      if (p.err !== null || p.code === null || p.code >= 400) {
        add("prod", { key: `prod:${p.name}`, level: p.code !== null && p.code < 500 && p.err === null ? "warn" : "bad",
          text: `${p.name} ${p.code ?? "down"}`, detail: [p.url, p.err].filter(Boolean).join(" · "), verb: "fix", source, ref: p.name });
      } else if (p.certNotAfter !== null && p.certNotAfter - sec < th.certWarnDays * DAY) {
        const left = p.certNotAfter - sec;
        add("prod", { key: `prod:cert:${p.name}`, level: left <= 0 ? "bad" : "warn",
          text: left <= 0 ? "certificate expired" : `certificate expires in ${span(left)}`, detail: p.url, verb: "fix", source, ref: p.name });
      }
    }
  }
  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet) || a.key.localeCompare(b.key));
}

// ---------- a project's band and the order cards stand in ----------

export type Band = "needs" | "drifting" | "unread" | "quiet";
export const BANDS: readonly Band[] = ["needs", "drifting", "unread", "quiet"];

/** Colour only for what needs you; a card still being read, or only known from the last boot, is not quiet yet. */
export function projectBand(cells: readonly Cell[]): Band {
  if (cells.some((c) => c.level === "bad")) return "needs";
  if (cells.some((c) => c.level === "warn")) return "drifting";
  return cells.some((c) => c.level === "unread" || c.state === "past") ? "unread" : "quiet";
}

/** Worst first, ending on the path, so a repaint never reorders two equal cards. */
export function rankMaint<T extends { path: string; band: Band; findings: readonly Finding[] }>(rows: readonly T[]): T[] {
  const n = (r: T, l: Finding["level"]) => r.findings.filter((f) => f.level === l).length;
  return [...rows].sort((a, b) => BANDS.indexOf(a.band) - BANDS.indexOf(b.band)
    || n(b, "bad") - n(a, "bad") || n(b, "warn") - n(a, "warn") || a.path.localeCompare(b.path));
}

// ---------- the cross-project tabs ----------

export const MAINT_TABS = ["security", "delivery", "code", "servers", "work"] as const;
export type MaintTab = (typeof MAINT_TABS)[number];
/** Which cross-project tab a cell opens: a tab is a kind of work you batch in one sitting. */
export const FACET_TAB: Record<Facet, MaintTab> = {
  ci: "delivery", release: "delivery", security: "security", deps: "security", git: "code", prod: "servers", work: "work",
};

// A facet nothing could ever have read: no remote, or a bot nobody configured and that opened nothing.
function wantsSetup(facet: "ci" | "deps", inp: MaintInput, th: MaintThresholds, now: number): boolean {
  const forge = inp.det?.forge.kind;
  if (!forge || forge === "none" || inp.det!.markers.some((m) => m.facet === facet)) return false;
  const state = facetCell(facet, inp, th, now).state;
  if (state === "none") return true;
  const ups = okFacts(inp, "deps").flatMap((r) => r.facts.kind === "updatePrs" ? [r.facts] : []);
  return facet === "deps" && state === "read" && ups.length > 0 && ups.every((u) => !u.prs.length && !u.configured);
}

const SETUP_DETAIL = { ci: "nothing runs the checks on the default branch", deps: "nothing opens dependency updates" };

/** What *Check prod* runs here: the prod sources a scan may never run, so only a click asks them. */
export function prodChecks(inp: MaintInput): string[] {
  if (inp.det?.config.off.includes("prod")) return [];
  return (inp.det?.sources ?? []).filter((id) => {
    const d = findSource(id);
    return d?.facet === "prod" && !permitted(d.cost, "scan", false) && !inp.skip?.includes(id);
  });
}

/** What a tab lists beyond a card's lines: open work, and a facet nobody set up. Each has its verb. */
export function tabExtras(root: string, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const work = workFacts(inp);
  const issues = work.reduce((n, w) => n + w.facts.issues, 0), prs = work.reduce((n, w) => n + w.facts.prs, 0);
  if (issues + prs) {
    out.push({ root, facet: "work", key: "work:open", level: "info", verb: "review", source: work[0].source, ref: null,
      text: [issues && plural(issues, "open issue"), prs && plural(prs, "open pull request")].filter(Boolean).join(" · "), detail: "" });
  }
  for (const facet of ["ci", "deps"] as const) {
    if (!wantsSetup(facet, inp, th, now)) continue;
    out.push({ root, facet, key: `${facet}:setup`, level: "info", text: facetDef(facet).none, detail: SETUP_DETAIL[facet],
      verb: "setup", source: "", ref: null });
  }
  // A source only a click runs, which nobody has clicked here: Run is that click.
  for (const id of inp.det?.sources ?? []) {
    const r = inp.reports[id], facet = findSource(id)?.facet;
    if (!facet || r?.coverage.state !== "notRun" || inp.skip?.includes(id) || inp.det!.config.off.includes(facet)) continue;
    out.push({ root, facet, key: `run:${id}`, level: "info", text: `${labelOf(id)}: not checked`,
      detail: "runs only when asked, never in a scan", verb: "run", source: id, ref: null, ...(inp.asking?.includes(id) ? { busy: true } : {}) });
  }
  return out;
}

/** Every row a verb can be asked of: the card's lines and the tabs' own. */
export const tabFindings = (root: string, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Finding[] =>
  [...findings(root, inp, th, now), ...tabExtras(root, inp, th, now)];

/** One tab's rows across projects, `root` narrowing it to one: worst first, ending on the path and
 *  the key, so a repaint never reorders. */
export function tabRows<T extends Finding>(tab: MaintTab, rows: readonly T[], root: string | null = null): T[] {
  return rows.filter((f) => FACET_TAB[f.facet] === tab && (root === null || f.root === root))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet)
      || a.root.localeCompare(b.root) || a.key.localeCompare(b.key));
}

export interface TabCount { n: number; level: Finding["level"] | null } // level: the worst row's
export function tabTally(rows: readonly Finding[], root: string | null = null): Record<MaintTab, TabCount> {
  return Object.fromEntries(MAINT_TABS.map((t) => {
    const r = tabRows(t, rows, root);
    return [t, { n: r.length, level: r[0]?.level ?? null }];
  })) as Record<MaintTab, TabCount>;
}

export interface TabGap { path: string; facet: Facet; text: string }
// Muted is unknown ("never ran", "reviews unknown"), except a read that found the facet's none.
const isNone = (x: Cell) => x.state === "none" || x.state === "off" || (x.state === "read" && x.level === "muted" && x.text === facetDef(x.facet).none);
const isVerdict = (x: Cell) => x.state === "read" && x.level !== "muted" && x.level !== "unread";

/** What an empty tab may claim: projects it reached a verdict on, projects with none of it set up,
 *  and each cell that does not know. */
export function tabGaps(tab: MaintTab, cards: readonly { path: string; cells: readonly Cell[] }[], root: string | null = null): { read: number; unset: number; gaps: TabGap[] } {
  let read = 0, unset = 0;
  const gaps: TabGap[] = [];
  for (const c of cards) {
    if (root !== null && c.path !== root) continue;
    const cells = c.cells.filter((x) => FACET_TAB[x.facet] === tab);
    if (cells.some(isVerdict)) read++;
    else if (cells.length && cells.every(isNone)) unset++;
    for (const x of cells) {
      if (!isVerdict(x) && !isNone(x)) gaps.push({ path: c.path, facet: x.facet, text: x.state === "past" ? "not checked this session" : x.text || "not read yet" });
    }
  }
  return { read, unset, gaps: gaps.sort((a, b) => a.path.localeCompare(b.path) || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet)) };
}

// ---------- the project tab's cards ----------

export interface FlowRow {
  workflow: string; status: CiStatus; at: number | null;
  runs: CiStatus[]; // its newest runs, oldest first, so a strip reads left to right
  red: string | null; // failing for ("3d", "" when its source cannot date it); null when it is not
}

/** Delivery's CI half: one row per workflow on the default branch, the failing ones first. */
export function ciFlows(inp: MaintInput, now = Date.now()): { branch: string | null; rows: FlowRow[] } {
  const reps = okFacts(inp, "ci"), sec = now / 1000, rows: FlowRow[] = [];
  const fails = new Map(ciFailures(reps).map((x) => [x.workflow, x]));
  let branch: string | null = null;
  for (const { facts: f } of reps) {
    if (f.kind !== "ciRuns") continue;
    branch ??= f.branch;
    const by = new Map<string, CiRun[]>();
    for (const r of f.runs) by.set(r.workflow, [...(by.get(r.workflow) ?? []), r]);
    for (const [workflow, runs] of by) {
      const x = fails.get(workflow);
      rows.push({ workflow, status: runs[0].status, at: runs[0].at,
        runs: runs.slice(0, 8).map((r) => r.status).reverse(), red: x ? redFor(x, sec) ?? "" : null });
    }
  }
  return { branch, rows: rows.sort((a, b) => Number(b.red !== null) - Number(a.red !== null) || a.workflow.localeCompare(b.workflow)) };
}

export interface Kv { k: string; v: string }

/** The forge line under the tab's cards: where this repo lives, and how to pin one nobody could name. */
export function forgeText(inp: MaintInput): string {
  const f = inp.det?.forge;
  if (!f) return "";
  if (f.kind === "none") return "no remote";
  const where = [f.host, f.path].filter(Boolean).join("/") || f.kind;
  return f.kind === "unknown" ? `${where} · forge unknown: pin [maintenance] forge` : where;
}

/** Delivery's release half, one line per thing a source read; nothing read is no line. */
export function releaseRows(inp: MaintInput, now = Date.now()): Kv[] {
  const sec = now / 1000, out: Kv[] = [];
  const ago = (at: number | null) => at ? ` · ${span(sec - at)} ago` : "";
  for (const { facts: f } of okFacts(inp, "release")) {
    if (f.kind === "release") {
      out.push({ k: "Last tag", v: f.tag ? `${f.tag}${ago(f.tagAt)} · ${plural(f.since, "commit")} since` : `no release tag on ${f.trunk ?? "the trunk"}` });
      if (f.fetchedAt) out.push({ k: "As of", v: `last fetch ${span(sec - f.fetchedAt)} ago` });
    } else if (f.kind === "releases") {
      out.push({ k: "Published", v: f.latest ? `${f.latest.tag}${ago(f.latest.at)}` : "no releases" });
    } else if (f.kind === "changelog" && f.unreleased !== null) {
      out.push({ k: "Changelog", v: `${plural(f.unreleased, "entry", "entries")} under Unreleased` });
    }
  }
  return out;
}

export interface Hygiene {
  trunk: string | null; unpushed: number | null; localOnly: string[]; merged: string[]; gone: string[];
  stale: string[]; idle: number; fetchedAt: number | null;
}
/** Git hygiene's counts, or null until a source read them. */
export function hygieneOf(inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Hygiene | null {
  const h = okFacts(inp, "git").map((r) => r.facts).find((f): f is HygieneFacts => f.kind === "hygiene");
  if (!h) return null;
  const { stale, idle } = aged(h, th, now / 1000);
  return { trunk: h.trunk, unpushed: h.unpushed, localOnly: h.localOnly, merged: h.merged, gone: h.gone,
    stale: stale.map((b) => b.name), idle: idle.length, fetchedAt: h.fetchedAt };
}

export interface CoverRow { facet: Facet; label: string; state: CovState | "unread" | "skipped" | "marker" | "untracked" | "none"; text: string; fix: string | null }

/** Coverage: every source and marker detected here and what became of it, in card order. */
export function coverRows(inp: MaintInput): CoverRow[] {
  const det = inp.det;
  if (!det) return [];
  const out: CoverRow[] = det.config.off.filter((f): f is Facet => FACETS.includes(f as Facet))
    .map((facet) => ({ facet, label: facetDef(facet).label, state: "untracked", text: "switched off in .episko/episko.toml", fix: null }));
  for (const id of det.sources) {
    const r = inp.reports[id], facet = findSource(id)?.facet ?? r?.facet;
    if (!facet) continue;
    const row = (state: CoverRow["state"], text: string, fix: string | null = null) => out.push({ facet, label: labelOf(id), state, text, fix });
    if (inp.skip?.includes(id)) row("skipped", "skipped on this machine");
    else if (!r) row("unread", "not read yet");
    else row(r.coverage.state, covText(r.coverage), fixOf(r.coverage));
  }
  for (const m of det.markers) {
    out.push({ facet: m.facet, label: m.label, state: "marker", text: `found ${m.found.join(", ") || "on this forge"}, nothing reads it yet`, fix: null });
  }
  for (const facet of FACETS) {
    if (!out.some((r) => r.facet === facet)) out.push({ facet, label: facetDef(facet).none, state: "none", text: "nothing detected", fix: null });
  }
  return out.sort((a, b) => FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet));
}

// ---------- the all-clear's two lists ----------

export interface ComingUp { root: string; what: string; at: number } // at: unix secs

/** Dates inside the window that will need someone; certificates are the only ones the wire carries yet. */
export function comingUp(projects: readonly { root: string; inp: MaintInput }[], now = Date.now(), days = 30): ComingUp[] {
  const sec = now / 1000, out: ComingUp[] = [];
  for (const { root, inp } of projects) {
    for (const { facts } of okFacts(inp, "prod")) {
      if (facts.kind !== "probes") continue;
      for (const p of facts.items) {
        if (p.certNotAfter !== null && p.certNotAfter > sec && p.certNotAfter - sec <= days * DAY) {
          out.push({ root, what: `certificate for ${p.name}`, at: p.certNotAfter });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || a.root.localeCompare(b.root));
}

// ---------- prod ----------

export interface ProbeRow {
  name: string; url: string; err: string | null;
  status: string; level: Level; // "200 · 140ms", "no answer"
  cert: string; certLevel: Level; // "" for plain http, where there is no certificate to read
}

/** The Runs on card's addresses as last checked, or null when nothing was; prodRule's levels, row by row. */
export function probeRows(inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): { at: number | null; rows: ProbeRow[] } | null {
  if (inp.det?.config.off.includes("prod")) return null;
  const reps = (inp.det?.sources ?? []).map((id) => inp.reports[id])
    .filter((r): r is SourceReport => r?.coverage.state === "ok" && r.facts?.kind === "probes" && !inp.skip?.includes(r.source));
  if (!reps.length) return null;
  const sec = now / 1000;
  const rows = reps.flatMap((r) => r.facts!.kind === "probes" ? r.facts!.items : []).map((p): ProbeRow => {
    const down = p.err !== null || p.code === null || p.code >= 500;
    const left = p.certNotAfter === null ? null : p.certNotAfter - sec;
    const [cert, certLevel]: [string, Level] = left === null ? (p.url.startsWith("https:") ? ["cert unknown", "muted"] : ["", "ok"])
      : left <= 0 ? ["cert expired", "bad"] : [`cert ${span(left)}`, left < th.certWarnDays * DAY ? "warn" : "ok"];
    return { name: p.name, url: p.url, err: p.err,
      status: p.code === null ? "no answer" : `${p.code}${p.ms !== null ? ` · ${p.ms}ms` : ""}`,
      level: down ? "bad" : p.code! >= 400 ? "warn" : "ok", cert, certLevel };
  });
  return { at: Math.max(...reps.map((r) => r.at ?? 0)) || null, rows };
}

export interface HostRow { host: string; projects: string[]; level: Level; text: string }
const HOST_RANK: Level[] = ["bad", "warn", "info", "muted", "unread", "ok"];
const byRank = (a: { level: Level }, b: { level: Level }) => HOST_RANK.indexOf(a.level) - HOST_RANK.indexOf(b.level);

/** Servers are not projects: one row per host, joined many-to-many on `[deploy] host`, worst first.
 *  A host is fine only when every project it runs was read fine; a known problem outranks the unknown. */
export function hostRows(projects: readonly { path: string; hosts: readonly string[]; prod?: Cell }[]): HostRow[] {
  const by = new Map<string, Map<string, Cell | undefined>>();
  for (const p of projects) {
    for (const h of p.hosts) {
      if (!h) continue;
      const e = by.get(h) ?? new Map<string, Cell | undefined>();
      e.set(p.path, p.prod);
      by.set(h, e);
    }
  }
  return [...by].map(([host, e]) => {
    const read = [...e.values()].filter((c): c is Cell => c?.state === "read").sort(byRank);
    const worst: Cell | undefined = read[0];
    const [level, text]: [Level, string] = worst && (byRank(worst, { level: "muted" }) < 0 || read.length === e.size)
      ? [worst.level, worst.text] : ["muted", read.length ? `${read.length} of ${e.size} checked` : "not checked"];
    return { host, projects: [...e.keys()].sort((a, b) => a.localeCompare(b)), level, text };
  }).sort((a, b) => byRank(a, b) || a.host.localeCompare(b.host));
}

// ---------- the cold-boot snapshot (`cc-maint`) ----------

export const SNAP_ROOTS = 200, SNAP_FINDINGS = 12, SNAP_TEXT = 80, SNAP_KEY = 300;
const LEVELS: readonly Level[] = ["bad", "warn", "info", "ok", "muted", "unread"];
/** What a finished scan leaves for the next boot: a card's words, never an advisory's payload or a URL.
 *  `at` (ms) only on what an older scan left, when it differs from the snapshot's own. */
export interface SnapCell { facet: Facet; level: Level; text: string; at?: number }
export interface SnapFinding { facet: Facet; key: string; level: Finding["level"]; text: string; at?: number }
export interface MaintSnap { at: number; cells: SnapCell[]; findings: SnapFinding[] } // at: ms
export type MaintSnaps = Record<string, MaintSnap>;

const VERDICT: readonly CellState[] = ["read", "none", "off"];
const FINDING_RANK: readonly Finding["level"][] = ["bad", "warn", "info"];

/** One project's snapshot: its seven cells and its first lines, as the card drew them when the scan finished.
 *  A facet this scan reached no verdict on keeps `prev`'s cell and lines, dated as then: a failed read
 *  must not erase the last known red. */
export function takeSnap(root: string, inp: MaintInput, now = Date.now(), prev?: MaintSnap): MaintSnap {
  const th = clampMaint(inp.det?.config.thresholds);
  const live = facetCells(inp, th, now);
  const kept = new Set(prev ? live.filter((c) => !VERDICT.includes(c.state)).map((c) => c.facet) : []);
  const dated = <T extends { at?: number }>(x: T): T => ({ ...x, at: x.at ?? prev!.at });
  const cells = live.map((c): SnapCell => {
    const old = kept.has(c.facet) ? prev!.cells.find((p) => p.facet === c.facet) : undefined;
    return old ? dated(old) : { facet: c.facet, level: c.level, text: c.text.slice(0, SNAP_TEXT) };
  });
  const fresh = findings(root, inp, th, now).filter((f) => !kept.has(f.facet) && f.key.length <= SNAP_KEY)
    .map((f): SnapFinding => ({ facet: f.facet, key: f.key, level: f.level, text: f.text.slice(0, SNAP_TEXT) }));
  const carried = (prev?.findings ?? []).filter((f) => kept.has(f.facet)).map(dated);
  const all = [...fresh, ...carried].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet) || a.key.localeCompare(b.key));
  return { at: now, cells, findings: all.slice(0, SNAP_FINDINGS) };
}

const short = (n: number): Is => (v) => typeof v === "string" && v.length <= n;
const optAt: Is = (v) => v === undefined || (num(v) && (v as number) > 0);
const isSnapCell = shape({ facet: oneOf(FACETS), level: oneOf(LEVELS), text: short(SNAP_TEXT), at: optAt });
const isSnapFinding = shape({ facet: oneOf(FACETS), key: short(SNAP_KEY), level: oneOf(FINDING_RANK), text: short(SNAP_TEXT), at: optAt });
const withAt = (at: number | undefined) => at === undefined ? {} : { at };

/** `cc-maint` narrowed: a root of the wrong shape is dropped on its own, and past twelve lines or two
 *  hundred roots (the oldest go) is cut. Rebuilt field by field, so a hand-added URL never survives. */
export function clampSnaps(raw: unknown): MaintSnaps {
  if (!isObj(raw)) return {};
  const kept = Object.entries(raw).flatMap(([root, v]): [string, MaintSnap][] => {
    if (!root || !isObj(v) || !num(v.at) || (v.at as number) <= 0 || !Array.isArray(v.cells) || !Array.isArray(v.findings)) return [];
    // Seven facets, each once: a card with a hole would draw a cell nobody stored.
    if (!v.cells.every(isSnapCell) || FACETS.some((f) => (v.cells as SnapCell[]).filter((c) => c.facet === f).length !== 1)) return [];
    const cells = FACETS.map((f) => (v.cells as SnapCell[]).find((c) => c.facet === f)!)
      .map(({ facet, level, text, at }) => ({ facet, level, text, ...withAt(at) }));
    const fs = (v.findings.filter(isSnapFinding) as SnapFinding[]).slice(0, SNAP_FINDINGS)
      .map(({ facet, key, level, text, at }) => ({ facet, key, level, text, ...withAt(at) }));
    return [[root, { at: v.at as number, cells, findings: fs }]];
  });
  return Object.fromEntries(kept.sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0])).slice(0, SNAP_ROOTS));
}

/** A snapshot's cells as a card draws them: muted and as of then, never a dot, whatever they said. */
export function pastCells(s: MaintSnap, now = Date.now()): Cell[] {
  const tip = (at: number) => [`as of the last check, ${span((now - at) / 1000)} ago`, "not checked this session"];
  return s.cells.map((c): Cell => ({ facet: c.facet, state: "past", level: "muted",
    text: c.text || (c.level === "ok" ? "fine" : "not read"), tip: tip(c.at ?? s.at), fix: null, asOf: null }));
}

/** A red default branch as Today's queue takes it; `asOf` (ms) marks the snapshot's, `since` (ms) the first red run. */
export interface CiRow { key: string; text: string; detail: string; since: number | null; asOf: number | null }

/** This session's CI lines once its CI cell has a verdict, else the last check's, which say when that was.
 *  A read that failed is no verdict: it must not stand in for the last known red. */
export function ciRows(root: string, inp: MaintInput | null, snap: MaintSnap | null | undefined, now = Date.now()): CiRow[] {
  const th = clampMaint(inp?.det?.config.thresholds);
  const state = inp ? facetCell("ci", inp, th, now).state : "unread";
  if (inp && (state === "read" || state === "none" || state === "off")) {
    const since = new Map(ciFailures(okFacts(inp, "ci")).map((x) => [`ci:${x.workflow}`, x.since]));
    return findings(root, inp, th, now).filter((f) => f.facet === "ci").map((f) => {
      const s = since.get(f.key);
      return { key: f.key, text: f.text, detail: f.detail, since: s ? s * 1000 : null, asOf: null };
    });
  }
  // The key is findings' own `ci:<workflow>`, and the workflow is all of a line's detail a snapshot keeps.
  return (snap?.findings ?? []).filter((f) => f.facet === "ci")
    .map((f) => ({ key: f.key, text: f.text, detail: f.key.replace(/^ci:/, ""), since: null, asOf: f.at ?? snap!.at }));
}
