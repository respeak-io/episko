// Maintenance's rules (docs/maintenance.md): the wire narrowed rather than trusted, and what it
// means — a facet's cell, the findings under a card, a project's band and the order cards stand
// in. Facts in, words out: no DOM, no Tauri, and no vendor named, so the next adapter needs none.

import { FACETS, COSTS, facetDef, facetSources, findSource, permitted, type Cost, type Facet, type MaintCap } from "./maintsources";
import { narrowDeploy, type DeployCfg } from "./deploy";
import type { BranchFilter } from "./branches";
import { cmpVer, parseVer, satisfies, verCmpStr } from "./deps";
import { fmtDay, nfcKeys } from "./format";
import { whereProblem, type DispatchWhere } from "./claim";
import { SLUG_MAX, worktreeDirLen } from "./handoff";
import type { WtHead } from "./types";

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
/** A direct dependency and its registry's newest release; one at its newest is only counted (`current`). */
export interface PkgLatest {
  name: string; ecosystem: string; importers: string[]; installed: string[];
  latest: string | null; dev: boolean | null; url: string | null; why: string | null; // why: it could not be placed
}
export interface ForgeRelease { tag: string; name: string; at: number | null; url: string | null }
export interface Probe { name: string; url: string; code: number | null; ms: number | null; certNotAfter: number | null; err: string | null }
export interface Disk { mount: string; sizeKb: number; usedKb: number; availKb: number }
/** A container as its host's runtime reports it; `state` is the runtime's own word. */
export interface HostContainer {
  name: string; image: string; state: string; health: string | null; restarts: number; exit: number | null;
  startedAt: number | null; project: string | null; service: string | null;
}
/** One host as its script read it: a null is a section nothing answered, never 0. */
export interface HostFacts {
  alias: string; os: string | null; now: number | null; uptime: number | null; load: [number, number, number] | null;
  cpus: number | null; disks: Disk[]; updates: number | null; security: number | null; packages: string[]; pm: string | null;
  listsAt: number | null; reboot: boolean | null; rebootWhy: string[]; containers: HostContainer[] | null; compose: string[];
}
/** A cycle's end: unix secs, or the bare yes or no a list gives where it names no date. */
export type Eol = number | boolean | null;
export interface Runtime {
  product: string; name: string; declared: string; cycle: string | null; eol: Eol;
  latest: string | null; newest: string | null; file: string; url: string | null;
}
export interface BranchAge { name: string; at: number }
export interface WtAge { path: string; branch: string; at: number | null }
/** One run where a job failed and ran again on the same commit; `at` and `url` are the failed attempt's. */
export interface Rerun { sha: string; branch: string; at: number | null; passed: boolean; url: string | null }
/** A job that passed on a re-run of its commit at least once in the window; `seen` newest first. */
export interface RerunJob { workflow: string; job: string; reruns: number; passed: number; steps: string[]; seen: Rerun[] }
export const DEPLOY_STATES = ["live", "fail", "running", "waiting", "inactive", "gone", "unknown"] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];
export const ENV_TIERS = ["production", "staging", "preview", "other"] as const;
export type EnvTier = (typeof ENV_TIERS)[number];
/** An attempt newer than what is live; `url` is its log. */
export interface DeployAttempt { state: DeployState; raw: string; sha: string; at: number | null; url: string | null }
/** One environment. `sha: null` is nothing live found; `behind: null` a lag nobody counted, never 0. */
export interface Deployed {
  env: string; tier: EnvTier; sha: string | null; tag: string | null; branch: string | null; at: number | null; url: string | null;
  last: DeployAttempt | null; behind: number | null; behindAt: number | null; ahead: number | null;
}

// Every time is unix seconds, as the wire carries it.
export type Facts =
  | { kind: "ciRuns"; branch: string; runs: CiRun[] }
  | { kind: "ciReruns"; days: number; since: number | null; runs: number; reran: number; jobs: RerunJob[] } // every branch; since: a cut window
  | { kind: "advisories"; items: Advisory[] }
  | { kind: "updatePrs"; bot: string; configured: boolean; prs: UpdatePr[]; dashboard: number | null }
  | { kind: "packages"; items: PkgLatest[]; current: number }
  | { kind: "release"; trunk: string | null; tag: string | null; tagAt: number | null; since: number;
      oldestUnreleasedAt: number | null; tagsSeen: number; fetchedAt: number | null }
  | { kind: "releases"; latest: ForgeRelease | null; count: number }
  | { kind: "changelog"; unreleased: number | null; latest: string | null; latestAt: number | null }
  | { kind: "deployments"; trunk: string | null; envs: Deployed[]; fetchedAt: number | null }
  | { kind: "hygiene"; trunk: string | null; unpushed: number | null; localOnly: string[]; merged: string[];
      gone: string[]; branches: BranchAge[]; worktrees: WtAge[]; fetchedAt: number | null }
  | { kind: "work"; issues: number; prs: number; reviewRequested: number | null } // null: the search failed
  | { kind: "probes"; items: Probe[] }
  | { kind: "hosts"; items: HostFacts[] }
  | { kind: "runtimes"; items: Runtime[] };
export type FactKind = Facts["kind"];
type FactsOf<K extends FactKind> = Extract<Facts, { kind: K }>;

/** The one facet each kind may answer (`Facts::facet`); a record, so a new kind fails to compile here. */
export const FACT_FACET: Record<FactKind, Facet> = {
  ciRuns: "ci",
  ciReruns: "ci",
  advisories: "security",
  updatePrs: "deps",
  packages: "deps",
  release: "release",
  releases: "release",
  changelog: "release",
  deployments: "release",
  hygiene: "git",
  work: "work",
  probes: "prod",
  hosts: "prod",
  runtimes: "security",
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
const isDisk = shape({ mount: str, sizeKb: num, usedKb: num, availKb: num });
const isContainer = shape({
  name: str, image: str, state: str, health: opt(str), restarts: num, exit: opt(num), startedAt: opt(num), project: opt(str), service: opt(str),
});
const isHost = shape({
  alias: str, os: opt(str), now: opt(num), uptime: opt(num), load: opt((v) => Array.isArray(v) && v.length === 3 && v.every(num)),
  cpus: opt(num), disks: list(isDisk), updates: opt(num), security: opt(num), packages: list(str), pm: opt(str), listsAt: opt(num),
  reboot: opt(bool), rebootWhy: list(str), containers: opt(list(isContainer)), compose: list(str),
});
const isRuntime = shape({
  product: str, name: str, declared: str, cycle: opt(str), eol: (v) => v === null || num(v) || bool(v),
  latest: opt(str), newest: opt(str), file: str, url: opt(str),
});
const isPkg = shape({
  name: str, ecosystem: str, importers: list(str), installed: list(str), latest: opt(str), dev: opt(bool), url: opt(str), why: opt(str),
});

const isDeployed = shape({
  env: str, tier: oneOf(ENV_TIERS), sha: opt(str), tag: opt(str), branch: opt(str), at: opt(num), url: opt(str),
  last: opt(shape({ state: oneOf(DEPLOY_STATES), raw: str, sha: str, at: opt(num), url: opt(str) })),
  behind: opt(num), behindAt: opt(num), ahead: opt(num),
});

const FACT_SHAPES: Record<FactKind, Is> = {
  ciRuns: shape({ branch: str, runs: list(isCiRun) }),
  ciReruns: shape({ days: num, since: opt(num), runs: num, reran: num, jobs: list(shape({ workflow: str, job: str, reruns: num, passed: num,
    steps: list(str), seen: list(shape({ sha: str, branch: str, at: opt(num), passed: bool, url: opt(str) })) })) }),
  advisories: shape({ items: list(isAdvisory) }),
  updatePrs: shape({ bot: str, configured: bool, prs: list(isPr), dashboard: opt(num) }),
  packages: shape({ items: list(isPkg), current: num }),
  release: shape({ trunk: opt(str), tag: opt(str), tagAt: opt(num), since: num, oldestUnreleasedAt: opt(num), tagsSeen: num, fetchedAt: opt(num) }),
  releases: shape({ latest: opt(shape({ tag: str, name: str, at: opt(num), url: opt(str) })), count: num }),
  changelog: shape({ unreleased: opt(num), latest: opt(str), latestAt: opt(num) }),
  deployments: shape({ trunk: opt(str), envs: list(isDeployed), fetchedAt: opt(num) }),
  hygiene: shape({
    trunk: opt(str), unpushed: opt(num), localOnly: list(str), merged: list(str), gone: list(str),
    branches: list(shape({ name: str, at: num })), worktrees: list(shape({ path: str, branch: str, at: opt(num) })), fetchedAt: opt(num),
  }),
  work: shape({ issues: num, prs: num, reviewRequested: opt(num) }),
  probes: shape({ items: list(isProbe) }),
  hosts: shape({ items: list(isHost) }),
  runtimes: shape({ items: list(isRuntime) }),
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
  eolWarnDays: number; // a runtime whose cycle ends sooner is drifting
  flakyReruns: number; // a job that passed on a re-run of its own commit this often in the window is flaky
  deployBehindCommits: number; // production this many trunk commits behind is drifting
  deployBehindDays: number; // or whose oldest commit not live is this old
  deployIdleDays: number; // no attempt for this long: listed, never judged
  diskWarnPct: number; // a filesystem this full is drifting
  diskBadPct: number; // and this full is broken
  containerRestarts: number; // a running container restarted this often is drifting
  loadPerCpu: number; // the 15-minute load per CPU that is drifting
}
export const MAINT_DEFAULTS: MaintThresholds = {
  unreleasedCommits: 30,
  unreleasedDays: 21,
  staleBranchDays: 30,
  certWarnDays: 21,
  botSilentDays: 30,
  botPrBacklog: 5,
  fetchStaleDays: 7,
  eolWarnDays: 90,
  flakyReruns: 2,
  deployBehindCommits: 20,
  deployBehindDays: 14,
  deployIdleDays: 180,
  diskWarnPct: 85,
  diskBadPct: 95,
  containerRestarts: 5,
  loadPerCpu: 2,
};
const RAW_KEYS: Record<keyof MaintThresholds, string> = {
  unreleasedCommits: "unreleased_commits",
  unreleasedDays: "unreleased_days",
  staleBranchDays: "stale_branch_days",
  certWarnDays: "cert_warn_days",
  botSilentDays: "bot_silent_days",
  botPrBacklog: "bot_pr_backlog",
  fetchStaleDays: "fetch_stale_days",
  eolWarnDays: "eol_warn_days",
  flakyReruns: "flaky_reruns",
  deployBehindCommits: "deploy_behind_commits",
  deployBehindDays: "deploy_behind_days",
  deployIdleDays: "deploy_idle_days",
  diskWarnPct: "disk_warn_pct",
  diskBadPct: "disk_bad_pct",
  containerRestarts: "container_restarts",
  loadPerCpu: "load_per_cpu",
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
  hosts?: readonly string[]; // the [deploy] hosts this machine may ssh to (`MaintPrefs.hosts`)
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

// A cell that cannot check says why in a word; its tip and Coverage say the rest.
const OFF_WORD: Partial<Record<Facet, string>> = { security: "alerts off" };
/** The few words a cell shows for a coverage: what stands between it and an answer. */
export function whyWord(c: Coverage, facet: Facet): string {
  switch (c.state) {
    case "ok": return "read";
    case "noAccess": return /insufficient_scope|auth refresh|\b(token|required|following) scopes?\b/i.test(`${c.reason} ${c.fix ?? ""}`) ? "token scope" : "no access"; // never a bare word: an ssh alias reaches this text
    case "noTool": return /auth login/i.test(c.fix ?? "") ? "signed out" : "tool missing";
    case "off": return OFF_WORD[facet] ?? "switched off";
    case "unsupported": return "unavailable";
    case "notRun": return "not checked";
    case "error": return "read failed";
  }
}

/** A facet's verdict from one kind of facts. `blind`: what it read cannot answer the facet alone. */
export interface Judged { level: Level; text: string; tip: string[]; asOf?: number | null; blind?: boolean }
interface Ctx { th: MaintThresholds; now: number; trunc: boolean; reps: (CiReport & Pick<SourceReport, "gaps">)[]; tagged?: readonly string[] }
type Rule = (facts: Facts[], c: Ctx) => Judged;

const kinds = <K extends FactKind>(facts: Facts[], k: K): FactsOf<K>[] =>
  facts.filter((f): f is FactsOf<K> => f.kind === k);
const count = (n: number, c: Ctx) => `${n}${c.trunc ? "+" : ""}`;

// `since` and `sha` are the first red run's, null from a source blind to ci.failing-since; `floor`
// marks a streak that ran off a capped page.
export interface CiFailure { workflow: string; since: number | null; floor: boolean; sha: string | null; url: string | null; branch: string; source: string }
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
        sha: dated ? first.sha : null, url: runs[0].url, branch: f.branch, source });
    }
  }
  return out.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || a.workflow.localeCompare(b.workflow));
}
/** How long a failure has been red ("3d", a floor "3d+"), or null when its source cannot say. */
export const redFor = (x: CiFailure, sec: number): string | null =>
  x.since === null ? null : `${span(sec - x.since)}${x.floor ? "+" : ""}`;

// Positive evidence only: zero runs is "never ran", and skips alone are not a pass. Re-runs read
// without the runs vouch for nothing, so the runs read's own reason names the cell.
const ciRunsRule: Rule = (facts, c) => {
  const all = kinds(facts, "ciRuns");
  if (!all.length) return { level: "muted", text: "runs not read", tip: [], blind: true };
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

/** A job that failed and then passed when its commit ran again, as a CI source counted it: `warn`
 *  once it did so `flakyReruns` times in the window. `cut`: its counts are floors, for any reason;
 *  `short`: because a busy window was read short, the one reason that is the project's doing. */
export type FlakyJob = RerunJob & { source: string; days: number; cut: boolean; short: boolean; last: number | null; url: string | null; level: "warn" | "info" };
function flakyOf(reps: readonly CiReport[], th: MaintThresholds): FlakyJob[] {
  return reps.flatMap(({ source, truncated, facts: f }) => f?.kind !== "ciReruns" ? [] : f.jobs.map((j): FlakyJob => ({
    ...j, source, days: f.days, cut: truncated || f.since !== null, short: f.since !== null, last: j.seen[0]?.at ?? null, url: j.seen[0]?.url ?? null,
    level: j.passed >= th.flakyReruns ? "warn" : "info",
  }))).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.passed - a.passed || (b.last ?? 0) - (a.last ?? 0)
    || a.workflow.localeCompare(b.workflow) || a.job.localeCompare(b.job));
}
/** A project's flaky jobs, the noisiest first. */
export const flakyJobs = (inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS): FlakyJob[] => flakyOf(okFacts(inp, "ci"), th);

// Noise beside a red default branch, never in place of it: amber, and alone it vouches for nothing.
const rerunsRule = (facts: Facts[], c: Ctx): Judged | null => {
  if (!kinds(facts, "ciReruns").length) return null;
  const all = flakyOf(c.reps, c.th), noisy = all.filter((j) => j.level === "warn");
  const tip = all.map((j) => `${j.job} (${j.workflow}): passed on re-run ${j.passed} of ${j.reruns} in ${j.days}d`);
  if (!noisy.length) return { level: "ok", text: "", tip, blind: true };
  const n = `${noisy.length}${noisy.some((j) => j.cut) ? "+" : ""}`;
  return { level: "warn", text: `${n} flaky job${noisy.length === 1 ? "" : "s"}`, tip, blind: true };
};
const ciRule: Rule = (facts, c) => {
  const base = ciRunsRule(facts, c), j = worseOf(base, rerunsRule(facts, c));
  // A muted base keeps its words in front, so amber never hides "never ran".
  return j.level === "warn" && base.level === "muted" ? { ...j, text: `${base.text} · ${j.text}` } : j;
};

const SEV_LEVEL: Record<Severity, Level> = { critical: "bad", high: "bad", medium: "warn", low: "info", unknown: "info" };
const sevRank = (s: Severity) => SEVERITIES.indexOf(s);
const SEV_SHORT: Record<Severity, string> = { critical: "critical", high: "high", medium: "med", low: "low", unknown: "unknown" };

/** How many of each severity, worst first, empty buckets left out: "1 high · 3 medium". */
export function sevMix(sevs: readonly Severity[], short = false, n = (k: number) => String(k)): string[] {
  return SEVERITIES.flatMap((s) => {
    const k = sevs.filter((x) => x === s).length;
    return k ? [`${n(k)} ${short ? SEV_SHORT[s] : s}`] : [];
  });
}

type Seg = [Level, string];
// The two worst buckets, a secret worse than any severity and a runtime past its end beside the
// advisories of its level: "1 high · 3 med", "1 secret · node 18 EOL".
const securityRule: Rule = (facts, c) => {
  const merged = mergeAdvisories(kinds(facts, "advisories").map((f) => f.items));
  const rts = judgeRuntimes(kinds(facts, "runtimes").flatMap((f) => f.items), c.th, c.now);
  const tip = [...merged.map((a) => [a.severity, a.id, a.pkgs.join(", ") || a.items[0]?.location].filter(Boolean).join(" · ")),
    ...rts.map((r) => `${rtName(r)}: ${r.text} · ${r.decls.map((d) => d.file).join(", ")}`)];
  const secrets = merged.filter((a) => a.kind === "secret").length;
  const rest = merged.filter((a) => a.kind !== "secret");
  const said = (level: Level, many: string, one: (r: RuntimeState) => string): Seg[] => {
    const rs = rts.filter((r) => r.level === level);
    return rs.length ? [[level, rs.length === 1 ? one(rs[0]) : `${rs.length} runtimes ${many}`]] : [];
  };
  const segs: Seg[] = [
    ...(secrets ? [["bad", `${count(secrets, c)} secret${secrets === 1 ? "" : "s"}`] as Seg] : []),
    ...SEVERITIES.flatMap((s) => sevMix(rest.filter((a) => a.severity === s).map((a) => a.severity), true, (k) => count(k, c))
      .map((t): Seg => [SEV_LEVEL[s], t])),
    ...said("bad", "EOL", (r) => `${rtName(r)} EOL`),
    ...said("warn", "ending", (r) => `${rtName(r)} EOL in ${longSpan(r.left ?? 0)}`),
    ...said("muted", "unknown", (r) => `${rtName(r)} unknown`),
  ].sort((a, b) => HOST_RANK.indexOf(a[0]) - HOST_RANK.indexOf(b[0]));
  // A supported runtime vouches for no advisory: the dot needs an advisory source that answered.
  if (!segs.length && !kinds(facts, "advisories").length) return { level: "muted", text: "advisories not read", tip, blind: true };
  if (!segs.length) return { level: "ok", text: "", tip: tip.length ? tip : ["no open advisories"] };
  return { level: segs[0][0], text: segs.slice(0, 2).map((x) => x[1]).join(" · "), tip };
};

// ---------- runtimes and their end of life ----------

/** One runtime cycle in one project, with every file that declares it: ended is red, ending inside
 *  `eolWarnDays` amber, and a cycle the list does not hold, or an end it does not give, unknown. */
export interface RuntimeState {
  product: string; name: string; cycle: string | null; eol: Eol; latest: string | null; newest: string | null;
  url: string | null; decls: { file: string; declared: string }[];
  level: Level; text: string; // "ended 18mo ago", "ends in 52d", "no end announced", "cycle unknown"
  left: number | null; // secs to its end, negative once past; null without a date
}
export const rtName = (r: Pick<RuntimeState, "name" | "cycle" | "decls">): string => `${r.name} ${r.cycle ?? r.decls[0]?.declared ?? "?"}`;
const MONTH = 30 * DAY, YEAR = 365 * DAY;
/** An age too long for days: 52d, 18mo, 3y. */
export function longSpan(sec: number): string {
  const s = Math.max(0, sec);
  return s < 60 * DAY ? `${Math.max(1, Math.floor(s / DAY))}d` : s < 2 * YEAR ? `${Math.floor(s / MONTH)}mo` : `${Math.floor(s / YEAR)}y`;
}

// A cycle the list ends the day the next ships (Rust's six weeks) is a pin, an MSRV choice, never
// ended: red on every pinned toolchain would teach the cell to be ignored.
const ROLLING = new Set(["rust"]);

function judgeRuntimes(items: readonly Runtime[], th: MaintThresholds, now: number): RuntimeState[] {
  const sec = now / 1000, by = new Map<string, RuntimeState>();
  for (const r of items) {
    const key = `${r.product}@${r.cycle ?? `?${r.declared}`}`, e = by.get(key), decl = { file: r.file, declared: r.declared };
    if (e) {
      if (!e.decls.some((d) => d.file === decl.file && d.declared === decl.declared)) e.decls.push(decl);
      continue;
    }
    const pinned = ROLLING.has(r.product) && r.cycle !== null && r.eol !== null && r.eol !== false;
    const left = typeof r.eol === "number" && !pinned ? r.eol - sec : null;
    const [level, text]: Seg = r.cycle === null ? ["muted", "cycle unknown"]
      : pinned ? ["ok", r.newest && r.newest !== r.cycle ? `pinned, ${r.newest} is newest` : "pinned"]
      : r.eol === true ? ["bad", "ended"] : r.eol === false ? ["ok", "no end announced"] : left === null ? ["muted", "end unknown"]
      : left <= 0 ? ["bad", `ended ${longSpan(-left)} ago`] : [left < th.eolWarnDays * DAY ? "warn" : "ok", `ends in ${longSpan(left)}`];
    by.set(key, { product: r.product, name: r.name, cycle: r.cycle, eol: r.eol, latest: r.latest, newest: r.newest, url: r.url,
      decls: [decl], level, text, left });
  }
  return [...by.values()].sort((a, b) => HOST_RANK.indexOf(a.level) - HOST_RANK.indexOf(b.level)
    || (a.left ?? Infinity) - (b.left ?? Infinity) || rtName(a).localeCompare(rtName(b)));
}

/** A project's runtimes as its security sources read them, worst first. */
export const runtimeStates = (inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): RuntimeState[] =>
  judgeRuntimes(okFacts(inp, "security").flatMap((r) => r.facts.kind === "runtimes" ? r.facts.items : []), th, now);

// ---------- deployments: what each environment runs ----------

/** A newer attempt than what is live. Only a failure moves a level: no agent can answer a wait or a run. */
export interface EnvAttempt { state: DeployState; text: string; level: Level; sha: string; age: number | null; url: string | null }
/** One environment, merged across sources and judged. Previews are hidden, and every other tier is
 *  listed; only production, and a staging that failed, may speak in the Release cell (`judged`). */
export interface EnvState {
  env: string; tier: EnvTier; source: string; trunk: string | null;
  live: string | null; // its tag, else the short sha; null: nothing live found
  sha: string | null; branch: string | null; age: number | null; url: string | null;
  behind: number | null; behindAge: number | null; ahead: number | null; last: EnvAttempt | null;
  idle: boolean; hidden: boolean; judged: boolean;
  lag: Level; lagText: string; // what its distance from the trunk says alone, a failure aside
  level: Level; text: string;
}

const FAIL_LEVEL: Record<EnvTier, Level> = { production: "bad", staging: "warn", preview: "info", other: "info" };

function lagOf(e: Deployed, th: MaintThresholds, sec: number): Seg {
  const prod = e.tier === "production", ahead = e.ahead ?? 0;
  if (!e.sha) return ["muted", `${e.env}: nothing live`];
  if (prod && ahead) return ["warn", `${e.env} off trunk`];
  if (e.behind === null) return ["muted", `${e.env} behind unknown`];
  if (!e.behind) return ahead ? ["info", `${e.env} ${ahead} ahead`] : ["ok", ""];
  const far = e.behind >= th.deployBehindCommits || (e.behindAt !== null && sec - e.behindAt >= th.deployBehindDays * DAY);
  return [prod && far ? "warn" : "info", `${e.env} ${e.behind} behind`];
}

// An idle environment is listed and never judged, so its old failure is history: muted, as its row is.
function attemptOf(e: Deployed, idle: boolean, sec: number): EnvAttempt | null {
  const a = e.last;
  if (!a) return null;
  const age = a.at === null ? null : sec - a.at, when = age === null ? "" : span(age);
  const [level, text]: Seg = a.state === "fail" ? [FAIL_LEVEL[e.tier], `failed${when && ` ${when} ago`}`]
    : a.state === "waiting" ? ["muted", `waiting${when && ` ${when}`}`]
    : a.state === "running" ? ["muted", "deploying"] : ["muted", a.raw.toLowerCase()];
  return { state: a.state, text, level: idle ? "muted" : level, sha: a.sha, age, url: a.url };
}

function judgeEnv({ source, trunk, e }: SeenEnv, tagged: ReadonlySet<string>, th: MaintThresholds, sec: number): EnvState {
  const failed = e.last?.state === "fail", hidden = e.tier === "preview", newest = Math.max(e.at ?? 0, e.last?.at ?? 0);
  const idle = !tagged.has(e.env.toLowerCase()) && newest > 0 && sec - newest > th.deployIdleDays * DAY;
  const [lag, lagText] = lagOf(e, th, sec);
  const [level, text]: Seg = idle ? ["info", `idle ${longSpan(sec - newest)}`] : failed ? [FAIL_LEVEL[e.tier], `${e.env} deploy failed`] : [lag, lagText];
  return {
    env: e.env, tier: e.tier, source, trunk, live: e.tag ?? (e.sha && e.sha.slice(0, 7)), sha: e.sha, branch: e.branch,
    age: e.at === null ? null : sec - e.at, url: e.url, behind: e.behind, ahead: e.ahead,
    behindAge: e.behindAt === null ? null : sec - e.behindAt, last: attemptOf(e, idle, sec), idle, hidden,
    judged: !idle && !hidden && (e.tier === "production" || (e.tier === "staging" && failed)), lag, lagText, level, text,
  };
}

type SeenEnv = { source: string; trunk: string | null; e: Deployed };
// A clash keeps the one with a live commit, then the newer `at`, then the forge's; a newer failure stays either way.
function mergeEnv(a: SeenEnv, b: SeenEnv): SeenEnv {
  const forge = (x: SeenEnv) => findSource(x.source)?.cost === "forge", at = (x: SeenEnv) => x.e.at ?? 0;
  const first = !a.e.sha !== !b.e.sha ? (a.e.sha ? a : b) : at(a) !== at(b) ? (at(a) > at(b) ? a : b) : forge(b) && !forge(a) ? b : a;
  const other = first === a ? b : a, late = other.e.last && (other.e.last.at ?? 0) > at(first) ? other.e.last : null;
  return { ...first, e: { ...first.e, last: first.e.last ?? late } };
}

function judgeEnvs(reps: readonly CiReport[], tagged: readonly string[], th: MaintThresholds, now: number): EnvState[] {
  const by = new Map<string, SeenEnv>();
  for (const { source, facts: f } of reps) {
    if (f?.kind !== "deployments") continue;
    for (const e of f.envs) {
      const k = e.env.toLowerCase(), had = by.get(k), mine = { source, trunk: f.trunk, e };
      by.set(k, had ? mergeEnv(had, mine) : mine);
    }
  }
  const named = new Set(tagged.map((n) => n.toLowerCase()));
  return [...by.values()].map((x) => judgeEnv(x, named, th, now / 1000))
    .sort((a, b) => byRank(a, b) || ENV_TIERS.indexOf(a.tier) - ENV_TIERS.indexOf(b.tier) || a.env.localeCompare(b.env));
}
const taggedEnvs = (inp: MaintInput) => Object.keys(inp.det?.deploy?.envs ?? {});

/** A project's environments as its release sources read them, worst first. */
export const deployStates = (inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): EnvState[] =>
  judgeEnvs(okFacts(inp, "release"), taggedEnvs(inp), th, now);
/** A deployments list that hit its cap, or a read in part: its counts are floors and it vouches for nothing. */
export const deploysCut = (inp: MaintInput): boolean => okFacts(inp, "release").some((r) => r.truncated && r.facts.kind === "deployments");
/** What *Plan deploy* covers: production running other than the trunk. */
export const envsToShip = (envs: readonly EnvState[]): EnvState[] =>
  envs.filter((e) => !e.idle && e.tier === "production" && e.sha !== null && !!(e.behind || e.ahead));
/** What a deploy's *Fix* covers: a failure production or staging has not got past. */
export const envsFailed = (envs: readonly EnvState[]): EnvState[] =>
  envs.filter((e) => !e.idle && e.last?.state === "fail" && (e.tier === "production" || e.tier === "staging"));

// A bot nothing shows to be alive is silent, not healthy: open PRs are the only trace it leaves.
function botRule(facts: Facts[], ctx: Ctx): Judged | null {
  const ups = kinds(facts, "updatePrs");
  if (!ups.length) return null;
  const c = { ...ctx, trunc: ctx.reps.some((r) => r.truncated && r.facts?.kind === "updatePrs") };
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
  // A pile is one bot's, as each bot's line and board row judge it.
  if (ups.some((u) => u.prs.length >= c.th.botPrBacklog)) return { level: "warn", text: `${count(prs.length, c)} PRs`, tip };
  if (silent) return { level: "muted", text: "silent", tip };
  return prs.length ? { level: "info", text: `${count(prs.length, c)} PR${prs.length === 1 ? "" : "s"}`, tip } : { level: "ok", text: "", tip };
}

// ---------- packages behind their newest major ----------

/** How many majors `to` is past `from`: below 1.0 the minor counts (the patch below 0.1), and 0.x to
 *  1 or later is a floor, since no version list is read. Null when either does not parse. */
export function majorsBehind(from: string, to: string): { n: number; floor: boolean } | null {
  const a = parseVer(from), b = parseVer(to);
  if (!a || !b) return null;
  if (cmpVer(a, b) >= 0) return { n: 0, floor: false };
  if (a.major > 0) return { n: b.major - a.major, floor: false };
  if (b.major > 0) return { n: b.major, floor: true };
  if (a.minor > 0 || b.minor > 0) return { n: b.minor - a.minor, floor: a.minor === 0 };
  return { n: b.patch - a.patch, floor: false };
}

/** One direct dependency as judged: `from` is the lowest installed version that parses, the copy furthest behind. */
export interface PkgState extends PkgLatest { from: string | null; majors: number | null; floor: boolean; source: string }
export interface PkgStates {
  behind: PkgState[]; // a major or more behind, the most first
  current: number; // at their newest major
  unplaced: PkgState[]; // no newest release, nothing installed, or a version that does not compare
  majors: number; // summed over `behind`: what orders projects
  floor: boolean; // something unplaced or not read, or a 0.x leap: every figure is at least this
  capped: boolean;
  gaps: string[]; // what the read could not read: a lockfile, a name that failed
  partial: boolean; // cut at a cap or with a gap: more may be behind than `behind` names
}
type PkgReport = Pick<SourceReport, "source" | "truncated" | "gaps"> & { facts: FactsOf<"packages"> };
const pkgReports = (reps: readonly Pick<SourceReport, "source" | "truncated" | "gaps" | "facts">[]): PkgReport[] =>
  reps.flatMap((r) => r.facts?.kind === "packages" ? [{ source: r.source, truncated: r.truncated, gaps: r.gaps, facts: r.facts }] : []);

function judgePkgs(reps: readonly PkgReport[]): PkgStates {
  const all = reps.flatMap((r) => r.facts.items.map((p): PkgState => {
    const vs = p.installed.flatMap((v) => { const x = parseVer(v); return x ? [{ v, x }] : []; }).sort((a, b) => cmpVer(a.x, b.x));
    const from = vs[0]?.v ?? null, m = from !== null && p.latest !== null ? majorsBehind(from, p.latest) : null;
    return { ...p, from, majors: m?.n ?? null, floor: !!m?.floor, source: r.source };
  }));
  const byName = (a: PkgState, b: PkgState) => a.name.localeCompare(b.name) || a.ecosystem.localeCompare(b.ecosystem);
  const unplaced = all.filter((p) => p.latest === null || !p.installed.length || p.majors === null).sort(byName);
  const behind = all.filter((p) => (p.majors ?? 0) > 0).sort((a, b) => b.majors! - a.majors! || byName(a, b));
  const capped = reps.some((r) => r.truncated), gaps = reps.flatMap((r) => r.gaps), partial = capped || gaps.length > 0;
  return {
    behind, unplaced, capped, gaps, partial, majors: behind.reduce((n, p) => n + p.majors!, 0),
    current: reps.reduce((n, r) => n + r.facts.current, 0) + all.filter((p) => p.majors === 0).length,
    floor: partial || unplaced.length > 0 || behind.some((p) => p.floor),
  };
}

/** A project's direct dependencies as its registry sources read them. */
export const pkgStates = (inp: MaintInput): PkgStates => judgePkgs(pkgReports(okFacts(inp, "deps")));
export const majorsText = (p: Pick<PkgState, "majors" | "floor">): string =>
  `${p.majors ?? "?"}${p.floor ? "+" : ""} major${p.majors === 1 && !p.floor ? "" : "s"}`;
/** Why a package could not be placed, in a few words. */
export const unplacedWhy = (p: PkgState): string =>
  p.why ?? (p.latest === null ? "no newest release" : !p.installed.length ? "not installed" : "a version that does not compare");

const TIP_PKGS = 8;
// Drift is a ranking, never amber: nearly every repository is a major behind on something. Blind:
// a registry read cannot say whether anything opens updates, or what another registry would answer.
function pkgRule(c: Ctx): Judged | null {
  const reps = pkgReports(c.reps);
  if (!reps.length) return null;
  const s = judgePkgs(reps), more = s.behind.length - TIP_PKGS;
  const tip = [...s.behind.slice(0, TIP_PKGS).map((p) => `${p.name} ${p.from} → ${p.latest} · ${majorsText(p)}`),
    ...(more > 0 ? [`+${more} more behind`] : []),
    ...(s.unplaced.length ? [`not placed: ${peekNames(s.unplaced.map((p) => `${p.name} (${unplacedWhy(p)})`))}`] : []),
    `${plural(s.current, "package")} at their newest major`];
  if (s.behind.length) return { level: "info", text: `${s.behind.length}${s.partial ? "+" : ""} behind`, tip, blind: true };
  if (s.unplaced.length) return { level: "muted", text: `${s.unplaced.length} unplaced`, tip, blind: true };
  if (!s.partial) return { level: "ok", text: "", tip, blind: true };
  return { level: "muted", text: "partly read", tip: [s.capped ? "more names than one read asks about" : "a lockfile or a name could not be read", ...tip], blind: true };
}

// Each kind judged alone and joined by worseOf; a bot nobody set up never speaks over packages that were read.
// Beside a bot that answered, packages are blind to the bots and not to themselves: "3 unplaced" still speaks.
const depsRule: Rule = (facts, c) => {
  const bots = botRule(facts, c), pkgs = pkgRule(c), none = facetDef("deps").none;
  if (!pkgs) return bots ?? { level: "muted", text: none, tip: [] };
  if (!bots) return pkgs;
  return bots.level === "muted" && bots.text === none ? { ...pkgs, tip: [...pkgs.tip, none] } : worseOf(bots, { ...pkgs, blind: false });
};

const releaseHalf: Rule = (facts, c) => {
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

const envTip = (e: EnvState) => `${e.env}: ${[e.live ? `runs ${e.live}` : "nothing live found",
  e.behind !== null && `${plural(e.behind, "commit")} behind ${e.trunk ?? "the trunk"}`, !!e.ahead && `${plural(e.ahead, "commit")} not on it`,
  e.last?.text].filter(Boolean).join(", ")}`;
// The worst environment that may speak; none is null, so a project with no deployments reads as it did.
const deployHalf = (facts: Facts[], c: Ctx): Judged | null => {
  const envs = judgeEnvs(c.reps, c.tagged ?? [], c.th, c.now).filter((e) => e.judged);
  if (!envs.length) return null;
  const asOf = kinds(facts, "deployments").find((d) => d.fetchedAt !== null)?.fetchedAt ?? null;
  // A cut list cannot vouch for what it left out.
  return { level: envs[0].level, text: envs[0].text, tip: envs.map(envTip), asOf, blind: c.reps.some((r) => r.truncated && r.facts?.kind === "deployments") };
};
const RELEASE_KINDS: readonly FactKind[] = ["release", "releases", "changelog"];
// What the release half can vouch with: a tag read, or a published release or changelog that said something.
const releaseSaid = (facts: Facts[]) => facts.some((f) => f.kind === "release" || (f.kind === "releases" && !!f.latest) || (f.kind === "changelog" && (!!f.unreleased || !!f.latest)));
// A muted half yields to one with a verdict: production counted at 0 behind answers *no tags*. But with
// no tag read to say that, a failed read beside it keeps the cell at can't check: nothing vouches for releases.
const releaseRule: Rule = (facts, c) => {
  const base = releaseHalf(facts, c), dep = deployHalf(facts, c);
  if (!dep) return facts.some((f) => RELEASE_KINDS.includes(f.kind)) ? base : { ...base, blind: true };
  const yields = (j: Judged) => j.level === "muted" ? { ...j, blind: true } : j;
  const j = worseOf(yields(base), yields(dep));
  const said = [base, dep].filter((x) => x.level !== "ok" && (x.level !== "muted" || j.level === "muted")).sort(byRank).map((x) => x.text);
  return { ...j, text: said.join(" · ") || j.text, blind: !releaseSaid(facts) };
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
  // Local-only alone is no colour: with nothing unpushed a remote holds every commit (a fresh worktree branch).
  if (h.unpushed) return j("warn", `${h.unpushed} unpushed`);
  if (tidy || stale.length || idle.length) return j("info", `${tidy + stale.length + idle.length} to tidy`);
  return h.unpushed === null ? j("muted", "no remote") : j("ok", "");
};

// A certificate nobody could read is unknown, never fine.
const probeJudge = (facts: Facts[], c: Ctx): Judged | null => {
  const items = kinds(facts, "probes").flatMap((f) => f.items);
  if (!items.length) return null;
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
  if (items.some((p) => /^https:/i.test(p.url) && p.certNotAfter === null)) return { level: "muted", text: "cert unknown", tip };
  return { level: "ok", text: "", tip };
};

const hostJudge = (facts: Facts[], c: Ctx): Judged | null => {
  const st = kinds(facts, "hosts").flatMap((f) => f.items).map((h) => hostState(h, h.compose, c.th, c.now, c.trunc)).sort(byRank);
  return st.length ? { level: st[0].level, text: st[0].text, tip: st.flatMap((s) => s.tip) } : null;
};

// One judge per kind of prod facts, the worse speaking (worseOf). `alone`: whether that kind may
// draw the grey dot with nothing beside it; one that never can is judged blind.
const PROD_JUDGES: { judge: (facts: Facts[], c: Ctx) => Judged | null; alone: boolean }[] = [
  { judge: probeJudge, alone: true },
  { judge: hostJudge, alone: true },
];
const prodRule: Rule = (facts, c) => {
  const said = PROD_JUDGES.flatMap(({ judge, alone }) => { const j = judge(facts, c); return j ? [alone ? j : { ...j, blind: true }] : []; });
  return said.length ? said.slice(1).reduce((a, b) => worseOf(a, b), said[0]) : { level: "muted", text: facetDef("prod").none, tip: [] };
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

const SAYS: readonly Level[] = ["bad", "warn", "info"];
// A blind verdict that found nothing cannot vouch; one that found something speaks like any other.
const unsure = (j: Judged) => !!j.blind && !SAYS.includes(j.level);
/** Two kinds' verdicts on one facet, the second null when its kind has no facts: the worse level
 *  speaks and both tips are kept. A blind kind speaks over one that can answer only with something
 *  it found, never with an unknown or a pass, and the pair is blind only while neither found any. */
export function worseOf(a: Judged, b: Judged | null): Judged {
  if (!b) return a;
  const rank = (j: Judged, o: Judged) => unsure(j) && !o.blind ? HOST_RANK.length : HOST_RANK.indexOf(j.level);
  const w = rank(b, a) < rank(a, b) ? b : a;
  const at = [a.asOf, b.asOf].filter((x): x is number => typeof x === "number");
  return { level: w.level, text: w.text, tip: [...a.tip, ...b.tip], asOf: at.length ? Math.min(...at) : null, blind: unsure(a) && unsure(b) };
}

// A facet whose second kind of facts lands combines the two here, through worseOf.
const RULES: Record<Facet, Rule> = {
  ci: ciRule,
  security: securityRule,
  deps: depsRule,
  release: releaseRule,
  git: gitRule,
  prod: prodRule,
  work: workRule,
};

const skipped = (id: string, reason = "skipped on this machine"): SourceReport => ({
  source: id, facet: findSource(id)?.facet ?? null, cost: findSource(id)?.cost ?? null,
  coverage: { state: "off", reason }, at: null, truncated: false, gaps: [], facts: null,
});

/** The host sources a `[deploy] host` nobody ticked here keeps from running: found by what they see,
 *  never by id, and skipped as `MaintPrefs.off` is. A teammate's commit never picks where this machine connects. */
export function hostSkips(det: Detection | null, hosts: readonly string[]): string[] {
  const h = det?.deploy?.host;
  return !det || !h || hosts.includes(h) ? [] : det.sources.filter(readsHost);
}
/** Whether `id` is skipped here because the host it reads is not allowed on this machine. */
const unticked = (inp: MaintInput, id: string): boolean =>
  !!inp.skip?.includes(id) && hostSkips(inp.det, inp.hosts ?? []).includes(id);
/** Whether a source reads the `[deploy] host`: found by what it sees, never by its id. */
export const readsHost = (id: string): boolean => !!findSource(id)?.sees.includes("prod.host");
const notAllowed = (inp: MaintInput) => `${inp.det?.deploy?.host ?? "the host"} is not allowed on this machine`;

/** A click's answer outlives a `[deploy]` edited by hand or a pull (Rust keeps it 24 h, `cc-maint-scan`
 *  longer): another host's facts are a host nobody asked yet, and its services are the ones named now. */
export function currentHosts(det: Detection | null, reports: Readonly<Record<string, SourceReport>>): Readonly<Record<string, SourceReport>> {
  const host = det?.deploy?.host, compose = det?.deploy?.compose ?? [];
  if (!host) return reports;
  const out = { ...reports };
  for (const [id, r] of Object.entries(reports)) {
    if (r.facts?.kind !== "hosts") continue;
    const items = r.facts.items.filter((h) => h.alias === host).map((h) => ({ ...h, compose: [...compose] }));
    out[id] = items.length ? { ...r, facts: { kind: "hosts", items } }
      : { ...r, coverage: { state: "notRun" }, at: null, truncated: false, gaps: [], facts: null };
  }
  return out;
}

/** The facet's reports in detection order, or null while any is still out. An id this build does not
 *  know files under its report's own facet. */
function facetReports(facet: Facet, inp: MaintInput): SourceReport[] | null {
  const out: SourceReport[] = [];
  for (const id of inp.det?.sources ?? []) {
    if ((findSource(id)?.facet ?? inp.reports[id]?.facet) !== facet) continue;
    const r = inp.skip?.includes(id) ? skipped(id, unticked(inp, id) ? notAllowed(inp) : undefined) : inp.reports[id];
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
  const marked = `can't check (${markers.map((m) => m.label).join(", ")})`;
  if (!reps.length && !markers.length) return cell("none", "muted", facetDef(facet).none, head);
  if (!reps.length) return cell("markers", "muted", marked, [...head, ...found]);
  const ranked = [...reps].sort((a, b) => COV_RANK.indexOf(a.coverage.state) - COV_RANK.indexOf(b.coverage.state));
  const notes = ranked.filter((r) => r.coverage.state !== "ok").map((r) => `${labelOf(r.source)}: ${covText(r.coverage)}`);
  const fix = ranked.map((r) => fixOf(r.coverage)).find((f) => f) ?? null;
  const ok = reps.filter((r) => r.coverage.state === "ok" && r.facts);
  // The most actionable coverage names the cell; a source nobody clicked only when every one is, and a
  // host not allowed here only when nothing else of the facet could be asked instead.
  const lead = ranked.find((r) => r.coverage.state !== "ok" && !unticked(inp, r.source)) ?? ranked[0];
  const why = unticked(inp, lead.source) ? "not allowed here" : inp.skip?.includes(lead.source) ? "skipped here" : whyWord(lead.coverage, facet);
  if (!ok.length) return cell("cantCheck", "muted", why, [...head, ...notes, ...found], fix);
  const trunc = ok.some((r) => r.truncated);
  const j = RULES[facet](ok.map((r) => r.facts!), { th, now, trunc, reps: ok, tagged: taggedEnvs(inp) });
  if (unsure(j) && ranked[0].coverage.state !== "ok") return cell("cantCheck", "muted", why, [...head, ...j.tip, ...notes, ...found], fix);
  // What a marker names nothing reads, so a blind verdict cannot vouch for it either.
  if (unsure(j) && markers.length) return cell("markers", "muted", marked, [...head, ...j.tip, ...found]);
  const asOf = j.asOf ?? null;
  let { level, text } = j;
  const age = asOf !== null ? now / 1000 - asOf : null;
  if (age !== null && age > th.fetchStaleDays * DAY && (level === "ok" || level === "info")) {
    level = "warn";
    text ||= `fetched ${span(age)} ago`; // amber is never the empty grey dot's text
  }
  const fetched = age !== null ? [`as of last fetch ${span(age)} ago`] : [];
  const gaps = ok.flatMap((r) => r.gaps.map((g) => `${labelOf(r.source)}: ${g}`));
  // A cut environment list has no figure in the cell to floor; its gap says what was listed.
  const capped = ok.some((r) => r.truncated && r.facts!.kind !== "deployments") ? ["a list hit its page cap, so counts are floors"] : [];
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

const FINDING_TEXT: Record<AdvisoryKind, [string, string]> = {
  dependency: ["advisory", "advisories"], code: ["code finding", "code findings"],
  config: ["misconfiguration", "misconfigurations"], secret: ["secret reported", "secrets reported"],
};
const KIND_VERB: Record<AdvisoryKind, Verb> = { dependency: "patch", code: "fix", config: "fix", secret: "rotate" };

// ---------- findings, the lines under a card ----------

export type Verb = "fix" | "patch" | "rotate" | "upgrade" | "release" | "deploy" | "push" | "tidy" | "review" | "fetch" | "run" | "setup";
export interface Finding {
  root: string; facet: Facet; key: string; level: "bad" | "warn" | "info";
  text: string; detail: string; verb: Verb;
  source: string; // the report it came from
  ref: string | null; // what in that report: a workflow, an advisory id, a bot, a tag, a probe
  busy?: boolean; // a Run row whose read is out, so a second click cannot start it again
}

/** A facet's reports a card may judge: detected, not off, read, and not skipped here. */
export const okFacts = (inp: MaintInput, facet: Facet): { source: string; truncated: boolean; gaps: string[]; facts: Facts }[] =>
  inp.det?.config.off.includes(facet) ? [] : (inp.det?.sources ?? [])
    .map((id) => inp.reports[id])
    .filter((r): r is SourceReport => !!r && r.coverage.state === "ok" && !!r.facts && FACT_FACET[r.facts.kind] === facet && !inp.skip?.includes(r.source))
    .map((r) => ({ source: r.source, truncated: r.truncated, gaps: r.gaps, facts: r.facts! }));

const LEVEL_RANK = { bad: 0, warn: 1, info: 2 } as const;
// The newest fetch any git or release read carries: what its counts are as old as.
const lastFetch = (inp: MaintInput) => [...okFacts(inp, "git"), ...okFacts(inp, "release")]
  .flatMap(({ source, facts }) => "fetchedAt" in facts && facts.fetchedAt !== null ? [{ source, at: facts.fetchedAt }] : [])
  .sort((a, b) => b.at - a.at)[0];
const workFacts = (inp: MaintInput) => okFacts(inp, "work")
  .flatMap((r) => r.facts.kind === "work" ? [{ source: r.source, facts: r.facts }] : []);

/** Every finding for one project, worst first. Each carries the verb that answers it. */
export function findings(root: string, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Finding[] {
  const out: Finding[] = [];
  const add = (facet: Facet, f: Omit<Finding, "root" | "facet">) => out.push({ root, facet, ...f });
  const sec = now / 1000;
  // Every red workflow is one Fix, oldest first; Today's queue keeps a row each (`ciRows`).
  const red = ciFailures(okFacts(inp, "ci"));
  if (red.length) {
    const x = red[0], age = redFor(x, sec), on = [...new Set(red.map((y) => y.branch))].join(", ");
    const names = red.map((y) => [y.workflow, redFor(y, sec)].filter(Boolean).join(" "));
    add("ci", { key: "ci", level: "bad", verb: "fix", source: x.source, ref: red.length === 1 ? x.workflow : null,
      text: red.length === 1 ? `CI failing${age ? ` ${age}` : ""}` : `${red.length} workflows failing`,
      detail: red.length === 1 ? `${x.workflow} on ${x.branch}${x.sha ? ` · first red at ${x.sha.slice(0, 7)}` : ""}`
        : `${names.slice(0, 3).join(", ")}${red.length > 3 ? " …" : ""} on ${on}` });
  }
  // Noisy is not broken: its own line and its own Fix, which hunts the nondeterminism.
  const noisy = flakyJobs(inp, th).filter((j) => j.level === "warn");
  if (noisy.length) {
    const j = noisy[0], cut = noisy.some((x) => x.cut);
    add("ci", { key: "ci:flaky", level: "warn", verb: "fix", source: j.source, ref: "flaky",
      text: noisy.length === 1 ? `${j.job} passed on re-run ${j.passed}×` : `${noisy.length}${cut ? "+" : ""} flaky jobs`,
      detail: noisy.length === 1
        ? [j.workflow, `${j.passed} of ${j.reruns} re-runs passed in ${j.days} days`, j.steps.length ? `fails at ${j.steps.join(", ")}` : "",
          j.short ? "a busy window, read in part" : cut ? "read in part" : ""].filter(Boolean).join(" · ")
        : noisy.slice(0, 3).map((x) => `${x.job} ${x.passed}×`).join(", ") + (noisy.length > 3 ? " …" : "") });
  }
  // One line per kind: four advisories are one Patch, as 65 branches are one Tidy (docs/maintenance.md).
  const advs = okFacts(inp, "security");
  const merged = mergeAdvisories(advs.map((r) => r.facts.kind === "advisories" ? r.facts.items : []));
  for (const kind of ADVISORY_KINDS) {
    const group = merged.filter((a) => a.kind === kind);
    if (!group.length) continue;
    // Only a capped source that reported this kind makes its count a floor.
    const trunc = advs.some((r) => r.truncated && r.facts.kind === "advisories" && r.facts.items.some((i) => i.kind === kind));
    const a = group[0], lvl = kind === "secret" ? "bad" : SEV_LEVEL[a.severity];
    const source = advs.find((r) => r.facts.kind === "advisories" && r.facts.items.some((i) => a.items.includes(i)))?.source ?? "";
    const where = (x: MergedAdvisory) => x.pkgs.length ? x.pkgs : x.items[0]?.location ? [x.items[0].location] : [];
    let text: string, detail: string;
    if (group.length === 1 && !trunc) {
      // Only a dependency has a published fix to name; code is fixed in place, and a secret is rotated.
      const fix = kind !== "dependency" ? "" : a.fixed ? `fixed in ${a.fixed}` : a.items.some((x) => x.fixed) ? "" : "no fix published";
      text = kind === "secret" ? FINDING_TEXT.secret[0] : `${a.severity === "unknown" ? "" : `${a.severity} `}${FINDING_TEXT[kind][0]}`;
      detail = [where(a).join(", "), fix, a.summary].filter(Boolean).join(" · ");
    } else {
      const places = [...new Set(group.flatMap(where))]; // worst first, as mergeAdvisories ranks them
      text = `${group.length}${trunc ? "+" : ""} ${FINDING_TEXT[kind][1]}`;
      detail = [...(kind === "secret" ? [] : sevMix(group.map((x) => x.severity), false, (k) => `${k}${trunc ? "+" : ""}`)),
        places.slice(0, 3).join(", ") + (places.length > 3 ? " …" : "")].filter(Boolean).join(" · ");
    }
    add("security", { key: `security:${kind}`, level: lvl === "bad" ? "bad" : lvl === "warn" ? "warn" : "info",
      text, detail, verb: KIND_VERB[kind], source, ref: kind });
  }
  // Every runtime past or near its end is one Upgrade, as four advisories are one Patch.
  const due = runtimeStates(inp, th, now).filter((r) => r.level === "bad" || r.level === "warn");
  if (due.length) {
    const r = due[0], source = advs.find((x) => x.facts.kind === "runtimes")?.source ?? "";
    add("security", { key: "security:runtime", level: due.some((x) => x.level === "bad") ? "bad" : "warn", verb: "upgrade", source, ref: "runtime",
      text: due.length === 1 ? `${rtName(r)} ${r.text}` : `${due.length} runtimes to upgrade`,
      detail: due.length === 1 ? [`from ${r.decls.map((d) => d.file).join(", ")}`, r.newest && `newest ${r.newest}`].filter(Boolean).join(" · ")
        : due.slice(0, 3).map((x) => `${rtName(x)} ${x.text}`).join(", ") + (due.length > 3 ? " …" : "") });
  }
  for (const { source, facts } of okFacts(inp, "deps")) {
    if (facts.kind !== "updatePrs" || !facts.prs.length) continue;
    const red = facts.prs.filter((p) => p.checks === "fail").length;
    const pile = facts.prs.length >= th.botPrBacklog;
    add("deps", { key: `deps:${facts.bot}`, level: red || pile ? "warn" : "info",
      text: red ? `${plural(red, "update PR")} red` : `${plural(facts.prs.length, "update PR")} open`,
      detail: facts.prs.slice(0, 3).map((p) => `#${p.number} ${p.title}`).join(" · "), verb: "review", source, ref: facts.bot });
  }
  // Every package a major or more behind is one Upgrade, the most first; info, so never a badge.
  const pk = pkgStates(inp);
  if (pk.behind.length) {
    const p = pk.behind[0], one = pk.behind.length === 1 && !pk.partial;
    add("deps", { key: "deps:packages", level: "info", verb: "upgrade", source: p.source, ref: "packages",
      text: one ? `${p.name} ${majorsText(p)} behind` : `${pk.behind.length}${pk.partial ? "+" : ""} packages a major or more behind`,
      detail: pk.behind.slice(0, 3).map((x) => `${x.name} ${x.from} → ${x.latest}`).join(", ") + (pk.behind.length > 3 ? " …" : "") });
  }
  for (const { source, facts } of okFacts(inp, "release")) {
    if (facts.kind !== "release" || !facts.tag || !facts.since) continue;
    const old = facts.oldestUnreleasedAt ? sec - facts.oldestUnreleasedAt : 0;
    const drift = facts.since >= th.unreleasedCommits || old >= th.unreleasedDays * DAY;
    add("release", { key: "release", level: drift ? "warn" : "info", text: `${plural(facts.since, "commit")} since ${facts.tag}`,
      detail: old ? `oldest unreleased ${span(old)}` : "", verb: "release", source, ref: facts.tag });
  }
  // One Plan deploy over production and one Fix over the failures, as four advisories are one Patch.
  const envs = deployStates(inp, th, now), ship = envsToShip(envs), broke = envsFailed(envs), cut = deploysCut(inp) ? "+" : "";
  if (ship.length) {
    const e = ship[0], many = ship.length > 1;
    add("release", { key: "release:deploy", level: ship.some((x) => x.lag === "warn") ? "warn" : "info", verb: "deploy", source: e.source, ref: many ? null : e.env,
      text: many ? `${ship.length}${cut} environments ${ship.every((x) => !x.ahead) ? "behind" : "not at the trunk"}`
        : e.ahead ? `${e.env} runs ${plural(e.ahead, "commit")} not on ${e.trunk ?? "the trunk"}` : `${e.env} is ${plural(e.behind ?? 0, "commit")} behind`,
      detail: many ? ship.slice(0, 3).map((x) => x.lagText).join(", ") + (ship.length > 3 ? " …" : "")
        : [`runs ${e.live}`, e.ahead && e.behind ? `${e.behind} behind` : "", e.behindAge !== null ? `oldest undeployed ${span(e.behindAge)}` : ""].filter(Boolean).join(" · ") });
  }
  if (broke.length) {
    const e = broke[0], many = broke.length > 1;
    add("release", { key: "release:deploy-failed", level: broke.some((x) => x.tier === "production") ? "bad" : "warn", verb: "fix", source: e.source, ref: many ? null : e.env,
      text: many ? `${broke.length}${cut} deploys failed` : `${e.env} deploy ${e.last!.text}`,
      detail: many ? broke.slice(0, 3).map((x) => `${x.env} ${x.last!.text}`).join(", ") + (broke.length > 3 ? " …" : "")
        : e.live ? `still running ${e.live}` : "nothing live found" });
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
  const fetched = lastFetch(inp);
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
  // A host's trouble is one line per kind, its alias the ref: one Fix brief then covers all of it.
  for (const { source, truncated, facts } of okFacts(inp, "prod")) {
    if (facts.kind !== "hosts") continue;
    for (const h of facts.items) {
      for (const l of hostState(h, h.compose, th, now, truncated).lines) {
        add("prod", { key: `prod:host:${l.kind}`, level: l.level, text: l.text, detail: l.detail, verb: "fix", source, ref: h.alias });
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

// A deps source that answers packages rather than update pull requests.
const isRegistry = (id: string, inp: MaintInput) => !!findSource(id)?.sees.includes("deps.latest") || inp.reports[id]?.facts?.kind === "packages";

// A facet nothing could ever have read: no remote, or a bot nobody configured and that opened nothing.
// Deps asks its bots alone: a registry read says nothing about whether anything opens updates.
function wantsSetup(facet: "ci" | "deps", inp: MaintInput, th: MaintThresholds, now: number): boolean {
  const det = inp.det, forge = det?.forge.kind;
  if (!det || !forge || forge === "none" || det.markers.some((m) => m.facet === facet)) return false;
  if (facet === "ci") return facetCell(facet, inp, th, now).state === "none";
  if (det.config.off.includes("deps")) return false;
  // A registry read answers packages; every other deps source is an update bot's.
  const bots = det.sources.filter((id) => (findSource(id)?.facet ?? inp.reports[id]?.facet) === "deps" && !isRegistry(id, inp));
  if (bots.some((id) => !inp.skip?.includes(id) && !inp.reports[id])) return false; // a read still out
  const ups = okFacts(inp, "deps").flatMap((r) => bots.includes(r.source) && r.facts.kind === "updatePrs" ? [r.facts] : []);
  return !bots.length || (ups.length > 0 && ups.every((u) => !u.prs.length && !u.configured));
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

// What each click-only prod source does and needs, by what it sees: Check prod's tip and its empty
// toast name every source by its label, so a new one needs a row here and no new sentence.
const PROD_ASKS: Partial<Record<MaintCap, { does: (hosts: readonly string[]) => string; needs: string }>> = {
  "prod.status": { does: () => "each [deploy] address once, and its certificate", needs: "an address in [deploy]" },
  "prod.host": { does: (h) => `one read-only command on ${h.join(", ") || "each allowed host"}, over your own ssh`, needs: "a [deploy] host allowed on this machine" },
};
const asks = (id: string) => findSource(id)?.sees.map((c) => PROD_ASKS[c]).find((x) => x);

/** Check prod's tip over the sources `prodChecks` returns and the hosts they reach: who is asked what. */
export function prodTip(ids: readonly string[], hosts: readonly string[]): string {
  const said = [...new Set(ids)].map((id) => `${findSource(id)?.label ?? id}: ${asks(id)?.does(hosts) ?? "asked once"}`);
  return `Asks from this machine, once: ${said.join("; ")}. Nothing else connects`;
}

/** Check prod's toast when no project gives it anything to ask. */
export function prodNone(): string {
  const needs = [...new Set(facetSources("prod").filter((d) => !permitted(d.cost, "scan", false)).flatMap((d) => asks(d.id)?.needs ?? []))];
  return `No project here has ${needs.join(" or ") || "anything Check prod asks"}`;
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
  return out;
}

/** A source only a click runs, which nobody has clicked here. An offer, not a finding: no tab row,
 *  no count, only Coverage's button or row (docs/maintenance.md). */
export function offers(root: string, inp: MaintInput): Finding[] {
  const out: Finding[] = [];
  for (const id of inp.det?.sources ?? []) {
    const r = inp.reports[id], facet = findSource(id)?.facet;
    if (!facet || r?.coverage.state !== "notRun" || inp.skip?.includes(id) || inp.det!.config.off.includes(facet)) continue;
    out.push({ root, facet, key: `run:${id}`, level: "info", text: `${labelOf(id)}: ${offerWord(id)}`,
      detail: "runs only when asked, never in a scan", verb: "run", source: id, ref: readsHost(id) ? inp.det?.deploy?.host ?? null : null,
      ...(inp.asking?.includes(id) ? { busy: true } : {}) });
  }
  return out;
}
const offerWord = (id: string) => findSource(id)?.cost === "tool" ? "not run" : "not checked";

/** Code scanning switched off on a forge that offers it: Coverage's *Set up*, a workflow an agent
 *  writes and a person enables. Not a finding: nothing was read, so nothing is wrong yet. */
export function coverSetups(root: string, inp: MaintInput): Finding[] {
  const det = inp.det;
  if (!det || det.config.off.includes("security")) return [];
  return det.sources.flatMap((id): Finding[] => {
    const d = findSource(id);
    if (!d || d.facet !== "security" || d.cost !== "forge" || !d.sees.includes("sec.code") || !d.forge.includes(det.forge.kind)
      || inp.reports[id]?.coverage.state !== "off" || inp.skip?.includes(id)) return [];
    return [{ root, facet: "security", key: `setup:${id}`, level: "info", text: `${labelOf(id)}: off`,
      detail: "nothing analyses the code on the forge", verb: "setup", source: id, ref: "sec.code" }];
  });
}

/** The `[maintenance]` keys an agent may propose (maint.rs's `SETUP_KEYS`, held by the suite), and the one a reason names. */
export const SETUP_KEYS = ["trunk", "tag_pattern", "sarif", "bots"] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];
const SETUP_RE = new RegExp(`\\[maintenance\\] (${SETUP_KEYS.join("|")})\\b|\\b(tag_pattern) "`);
export function setupKeyOf(text: string): SetupKey | null {
  const m = SETUP_RE.exec(text);
  return (m?.[1] ?? m?.[2] ?? null) as SetupKey | null;
}

/** Every row a tab lists: the card's lines and the tabs' own. Offers are not among them. */
export const tabFindings = (root: string, inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Finding[] =>
  [...findings(root, inp, th, now), ...tabExtras(root, inp, th, now)];

/** One tab's rows across projects, `root` narrowing it to one: worst first, ending on the path and
 *  the key, so a repaint never reorders. */
export function tabRows<T extends Finding>(tab: MaintTab, rows: readonly T[], root: string | null = null): T[] {
  return rows.filter((f) => FACET_TAB[f.facet] === tab && (root === null || f.root === root))
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet)
      || a.root.localeCompare(b.root) || a.key.localeCompare(b.key));
}

/** A count is what needs you: red and amber rows only, so a tab of muted rows shows no number. */
export const needsCount = (rows: readonly Finding[]): number => rows.filter((f) => f.level !== "info").length;

export interface TabCount { n: number; level: Finding["level"] | null } // level: the worst row's, null at 0
export function tabTally(rows: readonly Finding[], root: string | null = null): Record<MaintTab, TabCount> {
  return Object.fromEntries(MAINT_TABS.map((t) => {
    const r = tabRows(t, rows, root), n = needsCount(r);
    return [t, { n, level: n ? r[0].level : null }];
  })) as Record<MaintTab, TabCount>;
}

/** The boards a cross-project tab draws (`tabBoards`), each an anchor a card line can open on. */
export const BOARD_IDS = [
  "advisories",
  "runtimes",
  "update-prs",
  "packages",
  "ci",
  "flaky",
  "deployments",
  "releases",
  "hygiene",
  "work",
  "hosts",
  "addresses",
] as const;
export type BoardId = (typeof BOARD_IDS)[number];
// Each facet's boards and the keys each carries a verb for, the first match winning; a pre-fold
// snapshot's `ci:<workflow>` is CI's too.
const FACET_BOARD: Record<Facet, [BoardId, RegExp][]> = {
  ci: [["flaky", /^ci:flaky$/], ["ci", /^ci$|^ci:(?!setup$)/]],
  release: [["deployments", /^release:deploy(-failed)?$/], ["releases", /^release$/]],
  security: [["runtimes", /^security:runtime$/], ["advisories", /^security:(?!setup$)/]],
  deps: [["packages", /^deps:packages$/], ["update-prs", /^deps:(?!setup$)/]],
  git: [["hygiene", /^git:(unpushed|tidy|fetch)$/]],
  prod: [["hosts", /^prod:host:/], ["addresses", /^prod:(?!setup$)/]],
  work: [["work", /^work:(review|open)$/]],
};

/** Where a card line opens: its facet's tab, at the board that summarises it, or the tab's top
 *  (`board: null`) for a line no board carries (*Set up*, an offer). */
export function findingTarget(f: Pick<Finding, "facet" | "key">): { tab: MaintTab; board: BoardId | null } {
  return { tab: FACET_TAB[f.facet], board: FACET_BOARD[f.facet].find(([, keys]) => keys.test(f.key))?.[0] ?? null };
}

export interface ProjectPick { root: string; name: string; n: number; level: Finding["level"] | null }
/** A tab's project picker: every project with what needs you there (red and amber, as the badges),
 *  those with something first, then by name, so the list never reorders between two looks. */
export function projectPicks(tab: MaintTab, rows: readonly Finding[], projects: readonly { root: string; name: string }[]): ProjectPick[] {
  const rank = (p: ProjectPick) => p.level ? LEVEL_RANK[p.level] : 3;
  return projects.map((p) => {
    const r = tabRows(tab, rows, p.root), n = needsCount(r);
    return { root: p.root, name: p.name, n, level: n ? r[0].level : null };
  }).sort((a, b) => rank(a) - rank(b) || b.n - a.n || a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}

// Muted is unknown ("never ran", "reviews unknown"), except a read that found the facet's none.
const isNone = (x: Cell) => x.state === "none" || x.state === "off" || (x.state === "read" && x.level === "muted" && x.text === facetDef(x.facet).none);
const isVerdict = (x: Cell) => x.state === "read" && x.level !== "muted" && x.level !== "unread";
// A source that was asked and did not answer: neither one nobody asked (`notRun`) nor one skipped here.
const readFailed = (inp: MaintInput, only: (id: string) => boolean) => (inp.det?.sources ?? []).some((id) => {
  const s = inp.reports[id]?.coverage.state;
  return only(id) && !inp.skip?.includes(id) && !!s && s !== "ok" && s !== "notRun";
});
// A verdict rests on its facet's first kind: re-runs beside a failed runs read, environments beside a failed
// release read, or packages beside a failed bot read, speak for themselves and not for it. Each prod kind answers only for itself.
const vouched = (x: Cell, inp: MaintInput) => {
  if (x.state !== "read") return true;
  const facts = okFacts(inp, x.facet).map((r) => r.facts);
  if (x.facet === "ci") return facts.some((f) => f.kind === "ciRuns");
  if (x.facet === "deps") return facts.some((f) => f.kind === "updatePrs") || !readFailed(inp, (id) => findSource(id)?.facet === "deps" && !isRegistry(id, inp));
  if (x.facet === "prod") return !readFailed(inp, (id) => findSource(id)?.facet === "prod");
  return x.facet !== "release" || releaseSaid(facts) || !readFailed(inp, (id) => findSource(id)?.facet === "release");
};

/** What an empty tab may claim: projects it reached a verdict on and projects with none of it set
 *  up. What the rest do not know is `coverGroups`'. */
export function tabGaps(tab: MaintTab, cards: readonly { path: string; cells: readonly Cell[] }[], root: string | null = null): { read: number; unset: number } {
  let read = 0, unset = 0;
  for (const c of cards) {
    if (root !== null && c.path !== root) continue;
    const cells = c.cells.filter((x) => FACET_TAB[x.facet] === tab);
    if (cells.some(isVerdict)) read++;
    else if (cells.length && cells.every(isNone)) unset++;
  }
  return { read, unset };
}

/** A cell whose answer is why nothing read it: on the dashboard it opens Coverage, not its card. */
export const coverFirst = (c: Cell): boolean => c.state === "cantCheck" || c.state === "markers";

// ---------- coverage across projects, by reason ----------

/** The manifest's page that switches `source` on for this repository, or null: a forge it does not
 *  talk to, a host only a pin or a name decided (the template names the table's), or a path that is
 *  not one owner/repo. */
export function settingsUrl(source: string, f: Forge | null | undefined): string | null {
  const d = findSource(source);
  const seg = (x: string) => /^[\w.-]+$/.test(x) && !/^\.+$/.test(x);
  const path = f?.path ?? "", parts = path.split("/");
  if (!d?.settings || f?.by !== "table" || !d.forge.includes(f.kind) || parts.length !== 2 || !parts.every(seg)) return null;
  return d.settings.replace("{path}", path);
}
const settingsFor = (r: SourceReport, det: Detection): string | null =>
  r.coverage.state === "off" ? settingsUrl(r.source, det.forge) : null;

export type CoverAction =
  | { kind: "settings"; urls: Record<string, string> } // per root; a root without one is listed bare
  | { kind: "fix"; fix: string }
  | { kind: "run"; source: string }
  | { kind: "allow"; host: string }; // a [deploy] host this machine may not reach yet
export interface CoverGroup {
  key: string; facet: Facet;
  source: string | null; // the source it is about, so a Set up can sit on its row; null for a facet or marker
  cfg: boolean; // a [maintenance] key would answer it: the setup doors
  what: string; // the source, marker or facet it is about
  why: string; // the cell's word for it
  detail: string; // the coverage in full, as the first project had it
  roots: string[];
  quiet: boolean; // a bot nothing shows to be alive: said, but below what stops a check
  action: CoverAction | null;
}

/** One tab's Coverage, grouped by reason across projects rather than by project: every cell with no
 *  verdict, explained by its sources, and every click-only source nobody ran. Widest first. */
export function coverGroups(tab: MaintTab, projects: readonly { path: string; inp: MaintInput; cells: readonly Cell[] }[],
  root: string | null = null, now = Date.now()): CoverGroup[] {
  const by = new Map<string, CoverGroup>();
  type Said = Omit<CoverGroup, "roots" | "action" | "quiet" | "source" | "cfg"> & Partial<Pick<CoverGroup, "source">>;
  const add = (path: string, g: Said, action: CoverAction | null = null, quiet = false) => {
    const e = by.get(g.key) ?? { source: null, cfg: !!setupKeyOf(g.detail), ...g, roots: [], quiet,
      action: action?.kind === "settings" ? { kind: "settings", urls: {} } : action };
    if (!e.roots.includes(path)) e.roots.push(path);
    if (e.action?.kind === "settings" && action?.kind === "settings") Object.assign(e.action.urls, action.urls);
    by.set(g.key, e);
  };
  for (const { path, inp, cells } of projects) {
    if (root !== null && path !== root) continue;
    const det = inp.det, th = clampMaint(det?.config.thresholds);
    const markerRows = (d: Detection, facet: Facet) => {
      for (const m of d.markers.filter((x) => x.facet === facet)) {
        add(path, { key: `marker:${m.label}`, facet, what: m.label, why: "nothing reads it yet", detail: `found ${m.found.join(", ") || "on this forge"}` });
      }
    };
    const explain = (facet: Facet, only?: (id: string) => boolean) => {
      if (!det) return;
      for (const id of det.sources) {
        const r = inp.reports[id];
        if ((findSource(id)?.facet ?? r?.facet) !== facet || (only && !only(id)) || unticked(inp, id)) continue; // an unticked host is below, cell or not
        if (inp.skip?.includes(id)) { if (!only) add(path, { key: `${id}|skipped`, facet, source: id, what: labelOf(id), why: "skipped here", detail: "skipped on this machine" }); continue; }
        if (!r || r.coverage.state === "ok" || r.coverage.state === "notRun") continue; // an offer, below
        const fix = fixOf(r.coverage), url = settingsFor(r, det);
        // Grouped by the fix where there is one: an account name in the reason must not split a row.
        const key = `${id}|${r.coverage.state}|${fix ?? (r.coverage.state === "error" ? "" : covText(r.coverage))}`;
        // Every off row collects links, so a first project with none cannot strip the rest of theirs.
        add(path, { key, facet, source: id, what: labelOf(id), why: whyWord(r.coverage, facet), detail: covText(r.coverage) },
          fix ? { kind: "fix", fix } : r.coverage.state === "off" ? { kind: "settings", urls: url ? { [path]: url } : {} } : null);
      }
    };
    for (const c of cells) {
      const facet = c.facet, label = facetDef(facet).label;
      const noRuns = isVerdict(c) && !vouched(c, inp);
      if (FACET_TAB[facet] !== tab) continue;
      // One deps cell, two questions: what one kind said vouches for nothing the other could not read.
      const both = facet === "deps" && c.state === "read" && !!det?.sources.some((id) => isRegistry(id, inp));
      if (isNone(c) && !both) continue;
      // A release verdict speaks for tags alone: a token refused everywhere must not look like no deployments.
      if (c.state === "read" && facet === "release") explain(facet, (id) => !!findSource(id)?.sees.includes("rel.deployed"));
      if (isVerdict(c) && !noRuns && !both) continue;
      if (c.state === "past" || c.state === "unread" || !det) {
        const why = c.state === "past" ? "not checked this session" : "not read yet";
        add(path, { key: `${facet}|${c.state}`, facet, what: label, why, detail: "" });
      } else if (c.state === "markers") {
        markerRows(det, facet);
      } else if (c.state === "cantCheck") {
        explain(facet);
      } else {
        if (both) markerRows(det, facet);
        if (both || noRuns) explain(facet);
        const reads = facet === "deps" ? okFacts(inp, "deps") : [];
        // depsRule's silence, bot by bot: only a dated PR can say a bot has gone quiet.
        if (botRule(reads.map((r) => r.facts), { th, now, trunc: false, reps: [] })?.text === "silent") {
          for (const { source, facts: f } of reads) {
            if (f.kind !== "updatePrs") continue;
            const dated = f.prs.flatMap((p) => p.at !== null ? [p.at] : []);
            const old = dated.length > 0 && now / 1000 - Math.max(...dated) > th.botSilentDays * DAY;
            if (!old && (f.prs.length || !f.configured || f.dashboard !== null)) continue;
            const why = old ? `opened nothing in ${th.botSilentDays}+ days` : "configured, no open pull request";
            add(path, { key: `${source}|silent|${why}`, facet, source, what: labelOf(source), why,
              detail: "open pull requests are the only trace an update bot leaves" }, null, true);
          }
        }
        if (!isVerdict(c) && !isNone(c) && !(facet === "deps" && c.text === "silent")) {
          // The count is each project's own: a row is grouped by the reason.
          const unplaced = facet === "deps" && /^\d+ unplaced$/.test(c.text);
          add(path, { key: `${facet}|${unplaced ? "unplaced" : c.text}`, facet, what: label, why: unplaced ? "packages not placed" : c.text, detail: c.tip[0] ?? "" });
        }
      }
    }
    for (const o of offers(path, inp)) {
      if (FACET_TAB[o.facet] !== tab) continue;
      add(path, { key: `${o.source}|notRun`, facet: o.facet, source: o.source, what: labelOf(o.source), why: offerWord(o.source), detail: o.detail },
        { kind: "run", source: o.source });
    }
    // Like an offer: one Allow away from a click, whatever the cell read from the rest.
    const host = det?.deploy?.host;
    for (const id of det && host ? det.sources : []) {
      const facet = findSource(id)?.facet;
      if (!host || !facet || FACET_TAB[facet] !== tab || !unticked(inp, id)) continue;
      add(path, { key: `${id}|unticked|${host}`, facet, source: id, what: labelOf(id), why: "not allowed here", detail: notAllowed(inp) },
        { kind: "allow", host });
    }
  }
  return [...by.values()].map((g) => ({
    ...g, roots: g.roots.sort((a, b) => a.localeCompare(b)),
    action: g.action?.kind === "settings" && !Object.keys(g.action.urls).length ? null : g.action,
  })).sort((a, b) => Number(a.quiet) - Number(b.quiet) || b.roots.length - a.roots.length
    || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet) || a.what.localeCompare(b.what) || a.key.localeCompare(b.key));
}

// ---------- the cross-project tabs' boards ----------

/** One project as a tab's boards take it: `rows` are its `tabFindings`, where every verb comes from. */
export interface TabProject { path: string; inp: MaintInput; cells: readonly Cell[]; rows: readonly Finding[] }
const within = (ps: readonly TabProject[], root: string | null) => ps.filter((p) => root === null || p.path === root);
const verbOf = (p: TabProject, key: string): Finding | null => p.rows.find((f) => f.key === key) ?? null;
const thOf = (p: TabProject) => clampMaint(p.inp.det?.config.thresholds);
const rowRank = (l: Level) => HOST_RANK.indexOf(l);
/** Projects whose facet some source answered, of the one kind its board counts where a facet has two. */
const readOf = (ps: readonly TabProject[], facet: Facet, of?: readonly FactKind[]) =>
  ps.filter((p) => okFacts(p.inp, facet).some((r) => !of || of.includes(r.facts.kind))).length;
const READ_KIND: Partial<Record<Facet, readonly FactKind[]>> = { ci: ["ciRuns"], deps: ["updatePrs"], release: RELEASE_KINDS };

/** The Security strip's buckets, a secret worse than any severity, as the cell has it. */
export const SEV_BUCKETS = ["secret", ...SEVERITIES] as const;
export type SevBucket = (typeof SEV_BUCKETS)[number];
const BUCKET_LEVEL: Record<SevBucket, Finding["level"]> = { secret: "bad", ...SEV_LEVEL } as Record<SevBucket, Finding["level"]>;

export interface AdvRow {
  key: string; id: string; aliases: string[]; kind: AdvisoryKind; bucket: SevBucket; level: Finding["level"];
  what: string; // the packages, or where in the code
  installed: string[]; fixed: string[]; summary: string; url: string | null;
  projects: { root: string; verb: Finding | null }[]; // each project's own line for this kind
}

/** One row per vulnerability across every project (`mergeAdvisories` over all of them), its projects
 *  as chips. Worst first, then the widest, then the key. */
export function advisoryRows(ps: readonly TabProject[], root: string | null = null): { rows: AdvRow[]; capped: boolean; read: number } {
  const owner = new Map<Advisory, string>(), lists: Advisory[][] = [];
  let capped = false;
  // By path, since a tie in mergeAdvisories goes to the first reported: a repaint must not reword a row.
  const mine = within(ps, root).sort((a, b) => a.path.localeCompare(b.path));
  for (const p of mine) {
    for (const r of okFacts(p.inp, "security")) {
      if (r.facts.kind !== "advisories") continue;
      capped ||= r.truncated;
      for (const a of r.facts.items) owner.set(a, p.path);
      lists.push(r.facts.items);
    }
  }
  const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  const rows = mergeAdvisories(lists).map((m): AdvRow => {
    const bucket: SevBucket = m.kind === "secret" ? "secret" : m.severity;
    const roots = uniq(m.items.map((x) => owner.get(x) ?? null));
    return {
      key: m.key, id: m.id, aliases: m.aliases, kind: m.kind, bucket, level: BUCKET_LEVEL[bucket],
      what: m.pkgs.length ? m.pkgs.join(", ") : uniq(m.items.map((x) => x.location)).join(", "),
      installed: uniq(m.items.map((x) => x.version)), fixed: uniq(m.items.map((x) => x.fixed)), summary: m.summary, url: m.url,
      projects: roots.map((r) => ({ root: r, verb: verbOf(mine.find((p) => p.path === r)!, `security:${m.kind}`) })),
    };
  }).sort((a, b) => SEV_BUCKETS.indexOf(a.bucket) - SEV_BUCKETS.indexOf(b.bucket)
    || b.projects.length - a.projects.length || a.key.localeCompare(b.key));
  return { rows, capped, read: mine.filter((p) => okFacts(p.inp, "security").some((r) => r.facts.kind === "advisories")).length };
}

export type EolRow = RuntimeState & { root: string; verb: Finding | null };
/** Every runtime cycle each project declares, the nearest end first; the project's one Upgrade sits
 *  on each row it covers. */
export function eolBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): EolRow[] {
  return within(ps, root).flatMap((p) => runtimeStates(p.inp, thOf(p), now).map((r) => ({
    ...r, root: p.path, verb: r.level === "bad" || r.level === "warn" ? verbOf(p, "security:runtime") : null,
  }))).sort((a, b) => rowRank(a.level) - rowRank(b.level) || (a.left ?? Infinity) - (b.left ?? Infinity)
    || a.root.localeCompare(b.root) || rtName(a).localeCompare(rtName(b)));
}

export interface SevCount { bucket: SevBucket; n: number; level: Finding["level"] }
/** The four severities always, a secret or an unknown one only when there is one or it is the pick,
 *  so a pick whose rows went away still has the button that clears it. */
export const sevStrip = (rows: readonly AdvRow[], sev: SevBucket | null = null): SevCount[] => SEV_BUCKETS
  .map((bucket) => ({ bucket, n: rows.filter((r) => r.bucket === bucket).length, level: BUCKET_LEVEL[bucket] }))
  .filter((c) => c.n || c.bucket === sev || (c.bucket !== "secret" && c.bucket !== "unknown"));
export const bySev = (rows: readonly AdvRow[], sev: SevBucket | null): AdvRow[] => rows.filter((r) => sev === null || r.bucket === sev);

export interface PrRow {
  root: string; bot: string; open: number; red: number;
  green: number; // checks pass and not a draft: what a merge could take now
  oldest: number | null; capped: boolean; level: Level; verb: Finding | null;
}
/** Open update pull requests, one row per project and bot; `oldest` is the oldest one's age (secs). */
export function updatePrRows(ps: readonly TabProject[], root: string | null = null, now = Date.now()): PrRow[] {
  const out: PrRow[] = [];
  for (const p of within(ps, root)) {
    for (const { truncated, facts: f } of okFacts(p.inp, "deps")) {
      if (f.kind !== "updatePrs" || !f.prs.length) continue;
      const red = f.prs.filter((x) => x.checks === "fail").length, at = f.prs.flatMap((x) => x.at !== null ? [x.at] : []);
      out.push({ root: p.path, bot: f.bot, open: f.prs.length, red, capped: truncated, green: f.prs.filter((x) => x.checks === "pass" && !x.draft).length,
        oldest: at.length ? now / 1000 - Math.min(...at) : null,
        level: red || f.prs.length >= thOf(p).botPrBacklog ? "warn" : "info", verb: verbOf(p, `deps:${f.bot}`) });
    }
  }
  return out.sort((a, b) => rowRank(a.level) - rowRank(b.level) || b.red - a.red || b.open - a.open
    || a.root.localeCompare(b.root) || a.bot.localeCompare(b.bot));
}

export interface PkgRow {
  root: string; behind: PkgState[]; // the most majors first: one project's board lists them
  majors: number; ratio: number; // majors behind, summed, and its share of the board's largest, for a bar
  floor: boolean; capped: boolean; gaps: string[]; partial: boolean; current: number; unplaced: PkgState[]; level: Level; verb: Finding | null;
}
/** Which project costs most to bring current: one row per project a registry source answered, the
 *  most majors behind first. Nothing behind but something unplaced is muted, never the grey dot. */
export function packagesBoard(ps: readonly TabProject[], root: string | null = null): PkgRow[] {
  const out = within(ps, root).flatMap((p): PkgRow[] => {
    const reps = pkgReports(okFacts(p.inp, "deps"));
    if (!reps.length) return [];
    const s = judgePkgs(reps);
    return [{ root: p.path, behind: s.behind, majors: s.majors, ratio: 0, floor: s.floor, capped: s.capped, gaps: s.gaps, partial: s.partial, current: s.current,
      unplaced: s.unplaced, level: s.behind.length ? "info" : s.floor ? "muted" : "ok", verb: verbOf(p, "deps:packages") }];
  });
  const max = Math.max(1, ...out.map((r) => r.majors));
  return out.map((r) => ({ ...r, ratio: r.majors / max }))
    .sort((a, b) => rowRank(a.level) - rowRank(b.level) || b.majors - a.majors || a.root.localeCompare(b.root));
}

export const CI_STRIP = 12;
/** One run in a strip: its status, and the run page a dot opens. */
export interface RunDot { workflow: string; status: CiStatus; at: number | null; url: string | null }
const dotOf = (r: CiRun): RunDot => ({ workflow: r.workflow, status: r.status, at: r.at, url: r.url });
export interface CiBoardRow {
  root: string; level: Level; text: string; // the CI cell's own words
  since: string | null; // failing for, null when green or undatable
  why: string; // the red workflows, or the newest run
  runs: RunDot[]; // the newest CI_STRIP runs on the default branch, oldest first
  branch: string | null; flows: FlowRow[]; // each workflow on its own, which one project's board lists
  verb: Finding | null;
}
/** One row per project whose CI a source read, the longest red first. */
export function ciBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): CiBoardRow[] {
  const sec = now / 1000;
  return within(ps, root).flatMap((p) => {
    const reps = okFacts(p.inp, "ci").filter((r) => r.facts.kind === "ciRuns"); // the default branch's, never the re-runs
    const runs = reps.flatMap((r) => r.facts.kind === "ciRuns" ? r.facts.runs : []);
    if (!reps.length) return [];
    // The default branch's verdict alone, not the cell's: noise has a board of its own.
    const c = ciRunsRule(reps.map((r) => r.facts), { th: thOf(p), now, trunc: reps.some((r) => r.truncated), reps });
    const red = ciFailures(reps), last = [...runs].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const { branch, rows: flows } = ciFlows(p.inp, now);
    const why = red.length ? red.map((x) => x.workflow).join(", ")
      : last[0] ? `${last[0].workflow}${last[0].at ? ` · ${span(sec - last[0].at)} ago` : ""}` : "no run yet";
    return [{ row: { root: p.path, level: c.level, text: c.text, since: red[0] ? redFor(red[0], sec) : null, why,
      runs: last.slice(0, CI_STRIP).map(dotOf).reverse(), branch, flows, verb: verbOf(p, "ci") }, at: red[0]?.since ?? Infinity }];
  }).sort((a, b) => rowRank(a.row.level) - rowRank(b.row.level) || a.at - b.at || a.row.root.localeCompare(b.row.root)).map((x) => x.row);
}

export interface FlakyRow {
  root: string; workflow: string; job: string; passed: number; reruns: number; steps: string[];
  last: number | null; // the newest failed attempt's age (secs)
  url: string | null; // that attempt's log
  level: Level; capped: boolean; verb: Finding | null;
}
/** Every job that passed on a re-run of its commit, across projects: the noisiest first, a warn row
 *  carrying its project's one Fix as an end-of-life row carries Upgrade. */
export function flakyBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): FlakyRow[] {
  const sec = now / 1000;
  return within(ps, root).flatMap((p) => flakyJobs(p.inp, thOf(p)).map((j): FlakyRow => ({
    root: p.path, workflow: j.workflow, job: j.job, passed: j.passed, reruns: j.reruns, steps: j.steps,
    last: j.last === null ? null : sec - j.last, url: j.url, level: j.level, capped: j.cut,
    verb: j.level === "warn" ? verbOf(p, "ci:flaky") : null,
  }))).sort((a, b) => rowRank(a.level) - rowRank(b.level) || b.passed - a.passed || (a.last ?? Infinity) - (b.last ?? Infinity)
    || a.root.localeCompare(b.root) || a.job.localeCompare(b.job));
}

/** The Flaky jobs board and its note: the window, how many runs were read and re-run, whether any of
 *  that was read short, and what an empty board may claim: never a whole window it did not read. */
function flakyIn(ps: readonly TabProject[], root: string | null, now: number): Boards["flaky"] {
  const mine = within(ps, root);
  const reps = mine.flatMap((p) => okFacts(p.inp, "ci").flatMap((r) => r.facts.kind === "ciReruns" ? [{ ...r, facts: r.facts }] : []));
  const days = Math.max(0, ...reps.map((r) => r.facts.days)), cut = reps.some((r) => r.truncated || r.facts.since !== null);
  return {
    rows: flakyBoard(ps, root, now), read: readOf(mine, "ci", ["ciReruns"]), days,
    runs: reps.reduce((n, r) => n + r.facts.runs, 0), reran: reps.reduce((n, r) => n + r.facts.reran, 0),
    cut, short: reps.some((r) => r.facts.since !== null),
    clear: cut ? "No flaky job in what could be read." : `No job needed a re-run to pass in ${days} days.`,
  };
}

export interface RelRow {
  root: string; tag: string | null; tagAge: number | null; since: number;
  trunk: string | null; // what an untagged project was read against
  tagRead: boolean; // a tag source answered; without one, tag and since say nothing
  ratio: number; // of the board's largest count, for a bar
  oldest: number | null; level: Level; verb: Finding | null;
  fetched: number | null; // the last fetch's age: the tag count is as old as it
  published: { tag: string | null; age: number | null } | null; // the forge's latest release, null unread
  changelog: number | null; // entries under Unreleased, null with no such section read
}
/** Unreleased work per project from its tags, its published release and changelog beside it; a
 *  project never tagged says so and has no count. */
export function releaseBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): RelRow[] {
  const sec = now / 1000, out: RelRow[] = [];
  for (const p of within(ps, root)) {
    const facts = okFacts(p.inp, "release").map((r) => r.facts);
    const f = facts.find((x): x is FactsOf<"release"> => x.kind === "release");
    const pub = facts.find((x): x is FactsOf<"releases"> => x.kind === "releases");
    const log = facts.find((x): x is FactsOf<"changelog"> => x.kind === "changelog");
    if (!f && !pub && !log) continue;
    const th = thOf(p), old = f?.tag && f.since && f.oldestUnreleasedAt ? sec - f.oldestUnreleasedAt : null;
    const drift = !!f && (f.since >= th.unreleasedCommits || (old ?? 0) >= th.unreleasedDays * DAY);
    out.push({ root: p.path, tag: f?.tag ?? null, trunk: f?.trunk ?? null, tagRead: !!f, tagAge: f?.tag && f.tagAt ? sec - f.tagAt : null,
      since: f?.tag ? f.since : 0, ratio: 0, oldest: old, fetched: f?.fetchedAt ? sec - f.fetchedAt : null,
      published: pub ? { tag: pub.latest?.tag ?? null, age: pub.latest?.at ? sec - pub.latest.at : null } : null,
      changelog: log?.unreleased ?? null,
      level: !f?.tag ? "muted" : !f.since ? "ok" : drift ? "warn" : "info", verb: verbOf(p, "release") });
  }
  const max = Math.max(1, ...out.map((r) => r.since));
  return out.map((r) => ({ ...r, ratio: r.since / max }))
    .sort((a, b) => rowRank(a.level) - rowRank(b.level) || b.since - a.since || a.root.localeCompare(b.root));
}

export type DeployRow = EnvState & { root: string; verbs: Finding[] };
/** One row per environment of each project: worst first, an idle one last, then by project, tier and
 *  name. Previews are counted, not drawn. A row carries the verb of each line it is under. */
export function deployBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): { rows: DeployRow[]; hidden: number; read: number; cut: boolean } {
  const mine = within(ps, root), all = mine.flatMap((p) => {
    const envs = deployStates(p.inp, thOf(p), now), ship = envsToShip(envs), broke = envsFailed(envs);
    return envs.map((e): DeployRow => ({ ...e, root: p.path, verbs: [
      ...(broke.includes(e) ? [verbOf(p, "release:deploy-failed")] : []), ...(ship.includes(e) ? [verbOf(p, "release:deploy")] : []),
    ].filter((f): f is Finding => !!f) }));
  });
  const rank = (r: DeployRow) => r.idle ? HOST_RANK.length : rowRank(r.level);
  return {
    rows: all.filter((r) => !r.hidden).sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root)
      || ENV_TIERS.indexOf(a.tier) - ENV_TIERS.indexOf(b.tier) || a.env.localeCompare(b.env)),
    hidden: all.filter((r) => r.hidden).length, read: readOf(mine, "release", ["deployments"]), cut: mine.some((p) => deploysCut(p.inp)),
  };
}

/** A hygiene count: zero is the grey dot (`ok`), null is unknown; `names` what it counts, for its tip. */
export interface HygCount { n: number | null; level: Level; names: string[] }
export interface HygRow {
  root: string; trunk: string | null;
  unpushed: HygCount; localOnly: HygCount; merged: HygCount; gone: HygCount; idle: HygCount;
  stale: HygCount; staleDays: number; // branches only here, untouched that long
  fetched: { age: number | null; level: Level };
  level: Level; verbs: Finding[]; // Push, Tidy, Fetch: whichever lines this project has
}
/** One row per project whose git state a source read; only a non-zero count speaks. */
export function hygieneBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): HygRow[] {
  const sec = now / 1000;
  const n = (k: number | null, loud: Level, names: string[] = []): HygCount => ({ n: k, level: k === null ? "muted" : k ? loud : "ok", names });
  return within(ps, root).flatMap((p) => {
    const h = hygieneOf(p.inp, thOf(p), now);
    if (!h) return [];
    const age = h.fetchedAt === null ? null : sec - h.fetchedAt;
    const cs = [n(h.unpushed, "warn"), n(h.localOnly.length, "info", h.localOnly), n(h.mergedRead ? h.merged.length : null, "info", h.merged),
      n(h.gone.length, "info", h.gone), n(h.idle, "info", h.idleNames), n(h.stale.length, "info", h.stale)];
    const fetched: Level = age !== null && age > thOf(p).fetchStaleDays * DAY ? "warn" : "ok";
    const level = [...cs.map((c) => c.level), fetched].sort((a, b) => rowRank(a) - rowRank(b))[0];
    const verbs = ["git:unpushed", "git:tidy", "git:fetch"].flatMap((k) => verbOf(p, k) ?? []);
    const sum = cs.reduce((s, c) => s + (c.n ?? 0), 0);
    return [{ sum, row: { root: p.path, trunk: h.trunk, unpushed: cs[0], localOnly: cs[1], merged: cs[2], gone: cs[3], idle: cs[4],
      stale: cs[5], staleDays: thOf(p).staleBranchDays, fetched: { age, level: fetched }, level, verbs } }];
  }).sort((a, b) => rowRank(a.row.level) - rowRank(b.row.level) || b.sum - a.sum || a.row.root.localeCompare(b.row.root)).map((x) => x.row);
}

export interface WorkRow {
  root: string; issues: number; prs: number;
  review: number | null; // null: every review search failed
  reviewPartial: boolean; // some failed, so `review` is a floor
  issuesRatio: number; prsRatio: number; level: Level;
  verbs: Finding[]; // its review line, then its open-work line: the row draws the first and carries both
  queue: boolean; // the dashboard's queue lists what it counts, so its numbers are doors (the manifest's `queue`)
}
/** Open work per project: reviews waiting on you first, then the biggest pile. */
export function workBoard(ps: readonly TabProject[], root: string | null = null): WorkRow[] {
  const out: WorkRow[] = [];
  for (const p of within(ps, root)) {
    const reps = okFacts(p.inp, "work"), w = reps.flatMap((r) => r.facts.kind === "work" ? [r.facts] : []);
    if (!w.length) continue;
    const issues = w.reduce((s, x) => s + x.issues, 0), prs = w.reduce((s, x) => s + x.prs, 0);
    const failed = w.filter((x) => x.reviewRequested === null).length;
    const review = failed === w.length ? null : w.reduce((s, x) => s + (x.reviewRequested ?? 0), 0);
    out.push({ root: p.path, issues, prs, review, reviewPartial: review !== null && failed > 0, issuesRatio: 0, prsRatio: 0,
      level: review ? "warn" : issues + prs ? "info" : review === null || failed ? "muted" : "ok",
      verbs: ["work:review", "work:open"].flatMap((k) => verbOf(p, k) ?? []),
      queue: reps.every((r) => findSource(r.source)?.queue) });
  }
  const mi = Math.max(1, ...out.map((r) => r.issues)), mp = Math.max(1, ...out.map((r) => r.prs));
  return out.map((r) => ({ ...r, issuesRatio: r.issues / mi, prsRatio: r.prs / mp }))
    .sort((a, b) => (b.review ?? -1) - (a.review ?? -1) || b.issues + b.prs - (a.issues + a.prs) || a.root.localeCompare(b.root));
}

export type ProbeBoardRow = ProbeRow & { root: string; verb: Finding | null };
/** Every address last checked, across projects, the worst answer first. */
export function probeBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): ProbeBoardRow[] {
  const worst = (r: ProbeRow) => Math.min(rowRank(r.level), rowRank(r.certLevel));
  return within(ps, root).flatMap((p) => (probeRows(p.inp, thOf(p), now)?.rows ?? []).map((r) => ({
    ...r, root: p.path, verb: verbOf(p, `prod:${r.name}`) ?? verbOf(p, `prod:cert:${r.name}`),
  }))).sort((a, b) => worst(a) - worst(b) || a.root.localeCompare(b.root) || a.name.localeCompare(b.name));
}

/** A host as the Servers board draws it: `facts` and `state` stay null until a read this machine may draw. */
export interface HostBoardRow {
  host: string;
  projects: string[]; // every project naming it, over the filter
  at: number | null; // when the read drawn answered, or else the one that failed
  facts: HostFacts | null;
  state: HostState | null;
  why: string | null; // that failed read, in a word (Coverage says the rest)
  gaps: string[]; // what the read drawn could not read
  allowed: boolean;
  checking: boolean;
  sources: string[]; // what its Check asks
  verbs: Finding[]; // the lines the card carries, worst first: the first is its Brief, and each says what that brief says
}

/** One card per `[deploy] host` over the filter, worst first, then the alias: the newest read among the
 *  projects naming it, judged against every service any of them names. A failure newer than it speaks instead. */
export function hostBoard(ps: readonly TabProject[], root: string | null = null, now = Date.now()): HostBoardRow[] {
  const by = new Map<string, { p: TabProject; sum: HostSummary }[]>();
  for (const p of within(ps, root)) {
    const sum = p.inp.det?.config.off.includes("prod") ? null : hostSummary(p.inp, thOf(p), now);
    if (sum) by.set(sum.alias, [...(by.get(sum.alias) ?? []), { p, sum }]);
  }
  return [...by].map(([host, mine]): HostBoardRow => {
    const reads = mine.flatMap(({ p }) => okFacts(p.inp, "prod").flatMap((r) => {
      const h = r.facts.kind === "hosts" ? r.facts.items.find((x) => x.alias === host) : undefined, rep = p.inp.reports[r.source];
      return h ? [{ p, h, truncated: r.truncated, at: rep?.at ?? 0, gaps: rep?.gaps ?? [] }] : [];
    })).sort((a, b) => b.at - a.at || a.p.path.localeCompare(b.p.path));
    const allowed = mine.some((m) => m.sum.allowed), projects = mine.map((m) => m.p.path).sort((a, b) => a.localeCompare(b));
    const failed = allowed ? mine.map((m) => m.sum).filter((s) => s.why).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] : undefined;
    const read = failed && (failed.at ?? 0) > (reads[0]?.at ?? 0) ? undefined : reads[0];
    const compose = [...new Set(mine.flatMap((m) => m.p.inp.det?.deploy?.compose ?? []))].sort();
    const state = read ? hostState(read.h, compose, thOf(read.p), now, read.truncated) : null;
    // The Brief is one project's own read, so only what it also says is carried; anything else stays listed below, with its Fix.
    const who = [...new Set([...reads.map((x) => x.p), ...mine.map((m) => m.p)])];
    const lines = (state?.lines ?? []).flatMap((l) => who.flatMap((p) => verbOf(p, `prod:host:${l.kind}`) ?? []));
    const said = lines.filter((f) => f.root === lines[0].root);
    return {
      host, projects, at: read?.at ?? failed?.at ?? null, facts: read?.h ?? null, state,
      why: read ? null : failed?.why ?? null, gaps: read?.gaps ?? [],
      allowed, checking: mine.some((m) => m.p.inp.asking?.some(readsHost)),
      sources: [...new Set(mine.flatMap((m) => prodChecks(m.p.inp).filter(readsHost)))],
      verbs: lines.filter((f) => said.some((s) => s.key === f.key && s.text === f.text && s.detail === f.detail)),
    };
  }).sort((a, b) => byRank({ level: a.state?.level ?? "muted" }, { level: b.state?.level ?? "muted" }) || a.host.localeCompare(b.host));
}

export interface Boards {
  adv: AdvRow[];
  strip: SevCount[];
  capped: boolean;
  prs: PrRow[];
  advRead: number; // projects an advisory source answered: what the advisories board may claim
  eol: EolRow[];
  ci: CiBoardRow[];
  flaky: { rows: FlakyRow[]; read: number; days: number; runs: number; reran: number; cut: boolean; short: boolean; clear: string }; // read: projects re-runs were read for
  deploys: DeployRow[];
  deployHidden: number; // preview environments not drawn
  deployRead: number; // projects a deployments source answered
  deployCut: boolean; // a list hit its cap, or came back in part: more may exist than are drawn
  releases: RelRow[];
  hygiene: HygRow[];
  work: WorkRow[];
  hosts: HostBoardRow[];
  probes: ProbeBoardRow[];
  pkgs: PkgRow[];
  pkgRead: number; // projects a registry source answered: what the packages board may claim
  read: Partial<Record<Facet, number>>; // projects a source answered, per facet the tab shows
  unchecked: number; // projects in the filter whose addresses nobody has checked yet; a host's card asks for itself
  drawn: string[]; // `root|key` of every line a board carries the verb for; the rest are listed below them
  one: boolean; // narrowed to one project, so no row names it: the column would only repeat the name
}

/** The open tab's boards over the project filter; `sev` narrows the advisories, never the strip. */
export function tabBoards(tab: MaintTab, ps: readonly TabProject[], root: string | null = null, sev: SevBucket | null = null, now = Date.now()): Boards {
  const b: Boards = {
    adv: [],
    strip: [],
    capped: false,
    prs: [],
    advRead: 0,
    eol: [],
    ci: [],
    flaky: { rows: [], read: 0, days: 0, runs: 0, reran: 0, cut: false, short: false, clear: "" },
    deploys: [],
    deployHidden: 0,
    deployRead: 0,
    deployCut: false,
    releases: [],
    hygiene: [],
    work: [],
    hosts: [],
    probes: [],
    pkgs: [],
    pkgRead: 0,
    read: {},
    unchecked: 0,
    drawn: [],
    one: root !== null,
  };
  const mine = within(ps, root);
  for (const f of FACETS) if (FACET_TAB[f] === tab) b.read[f] = readOf(mine, f, READ_KIND[f]);
  const all = tab === "security" ? advisoryRows(ps, root) : { rows: [], capped: false, read: 0 };
  if (tab === "security") {
    Object.assign(b, { adv: bySev(all.rows, sev), strip: sevStrip(all.rows, sev), capped: all.capped, advRead: all.read,
      eol: eolBoard(ps, root, now), prs: updatePrRows(ps, root, now) });
    b.pkgs = packagesBoard(ps, root);
    b.pkgRead = b.pkgs.length;
  }
  if (tab === "delivery") Object.assign(b, { ci: ciBoard(ps, root, now), releases: releaseBoard(ps, root, now) });
  if (tab === "delivery") b.flaky = flakyIn(ps, root, now);
  if (tab === "delivery") { const d = deployBoard(ps, root, now); Object.assign(b, { deploys: d.rows, deployHidden: d.hidden, deployRead: d.read, deployCut: d.cut }); }
  if (tab === "code") b.hygiene = hygieneBoard(ps, root, now);
  if (tab === "work") b.work = workBoard(ps, root);
  if (tab === "servers") {
    b.hosts = hostBoard(ps, root, now);
    b.probes = probeBoard(ps, root, now);
    // A check that ran and failed is Coverage's to explain, never "not checked yet".
    b.unchecked = mine.filter((p) => {
      const ids = prodChecks(p.inp).filter((id) => !readsHost(id));
      return ids.length && ids.every((id) => (p.inp.reports[id]?.coverage.state ?? "notRun") === "notRun");
    }).length;
  }
  // A filtered-out severity hides its rows, not their lines: those are still the board's.
  const verbs = [
    ...all.rows.flatMap((r) => r.projects.map((x) => x.verb)),
    ...b.eol.map((r) => r.verb),
    ...b.prs.map((r) => r.verb),
    ...b.pkgs.map((r) => r.verb),
    ...b.ci.map((r) => r.verb),
    ...b.flaky.rows.map((r) => r.verb),
    ...b.deploys.flatMap((r) => r.verbs),
    ...b.releases.map((r) => r.verb),
    ...b.hygiene.flatMap((r) => r.verbs),
    ...b.work.flatMap((r) => r.verbs),
    ...b.hosts.flatMap((r) => r.verbs),
    ...b.probes.map((r) => r.verb),
  ];
  b.drawn = [...new Set(verbs.flatMap((v) => v ? [`${v.root}|${v.key}`] : []))].sort();
  return b;
}

/** Everything a tab draws but its host's chrome. The fleet and a project's dashboard both build it
 *  here, so one project on the dashboard is exactly the fleet narrowed to it. */
export interface TabModel {
  tabs: Record<MaintTab, TabCount>; // the bar's counts, over the filter
  boards: Boards | null; // null on Overview
  rows: Finding[]; // the open tab's lines no board carries a verb for, in tabRows' order
  offers: Finding[]; // its click-only sources nobody ran: Coverage's run doors when narrowed
  setups: Finding[]; // its Coverage rows an agent could set up (`coverSetups`), drawn when narrowed
  cover: CoverGroup[];
  read: number; unset: number; // what an empty tab may claim (tabGaps)
}
export function tabModel(sub: MaintTab | null, ps: readonly TabProject[], root: string | null = null,
  sev: SevBucket | null = null, now = Date.now()): TabModel {
  const rows = ps.flatMap((p) => p.rows), tabs = tabTally(rows, root);
  if (!sub) return { tabs, boards: null, rows: [], offers: [], setups: [], cover: [], read: 0, unset: 0 };
  const boards = tabBoards(sub, ps, root, sev, now), drawn = new Set(boards.drawn);
  return {
    tabs, boards, ...tabGaps(sub, ps, root),
    rows: tabRows(sub, rows, root).filter((r) => !drawn.has(`${r.root}|${r.key}`)),
    offers: tabRows(sub, ps.flatMap((p) => offers(p.path, p.inp)), root),
    setups: tabRows(sub, ps.flatMap((p) => coverSetups(p.path, p.inp)), root),
    cover: coverGroups(sub, ps, root, now),
  };
}

// ---------- a board's numbers as doors ----------

/** Where a board number opens: the dashboard view that acts on what it counts, with that already
 *  picked, a fetch, or a page. The host routes it, so the fleet and the dashboard share one table. */
export type Door =
  | { to: "branches"; filter: Exclude<BranchFilter, "all" | "checkout"> }
  | { to: "checkouts" } // the Branches view's Checkouts tab, where a worktree is removed
  | { to: "queue"; filter: "iss" | "pr" } // Today's queue on that chip
  | { to: "landed" } // Today's Landed, the unreleased commits
  | { to: "deps"; tab?: "vulns" | "prs" | "stale" } // the dependency overlay, on that tab
  | { to: "fetch" }
  | { to: "url"; url: string };

const br = (filter: Extract<Door, { to: "branches" }>["filter"]): Door => ({ to: "branches", filter });
// Every number column of every board; "url" takes the cell's own address, null is a number with no door.
const DOORS = {
  advisories: {}, // the severity strip filters in place
  packages: { behind: { to: "deps", tab: "stale" }, latest: "url" }, // where <pm> outdated is asked; the package's page
  runtimes: { ends: "url" }, // the runtime's page on the list that dates its cycles
  "update-prs": { open: { to: "deps", tab: "prs" }, green: { to: "deps", tab: "prs" }, red: { to: "deps", tab: "prs" } },
  ci: { run: "url" },
  flaky: { passed: null, last: "url" }, // the newest failed attempt's log
  deployments: { site: "url", behind: { to: "landed" }, log: "url" }, // its page, the commits it lacks, the newer attempt's log
  releases: { since: { to: "landed" }, changelog: null },
  hygiene: {
    unpushed: br("unpushed"), localOnly: br("localonly"), merged: br("merged"), gone: br("gone"), stale: br("untouched"),
    idle: { to: "checkouts" }, fetched: { to: "fetch" },
  },
  work: { review: { to: "queue", filter: "pr" }, issues: { to: "queue", filter: "iss" }, prs: { to: "queue", filter: "pr" } },
  hosts: { disk: null, updates: null, reboot: null, containers: null, load: null, uptime: null }, // no view to open: the card's verbs act
  addresses: { address: "url" },
} as const satisfies { [B in BoardId]: Readonly<Record<string, Door | "url" | null>> };
/** A board's own column names, so a view that asks for one the table lacks fails tsc, not a click. */
export type BoardCol<B extends BoardId> = keyof (typeof DOORS)[B] & string;
export const BOARD_COLS = Object.fromEntries(BOARD_IDS.map((b) => [b, Object.keys(DOORS[b])])) as Record<BoardId, string[]>;
const cellOf = (board: BoardId, col: string): Door | "url" | null | undefined =>
  (DOORS[board] as Readonly<Record<string, Door | "url" | null>> | undefined)?.[col];

/** A column's door, whatever its value: what ./maintui routes a clicked number through. */
export function doorAt(board: BoardId, col: string): Door | null {
  const d = cellOf(board, col);
  return d && d !== "url" ? d : null;
}

/** A board cell's door, or null: a zero is the grey dot and an unknown a `?`, and neither opens
 *  anything; a page opens only over http(s). */
export function boardDoor(board: BoardId, col: string, v: number | string | null): Door | null {
  const d = cellOf(board, col);
  if (!d || v === null || v === 0 || v === "") return null;
  if (d === "url") return typeof v === "string" && /^https?:\/\//i.test(v) ? { to: "url", url: v } : null;
  return typeof v === "number" ? d : null;
}

/** A count's tip: the first names it counts, and how many more. */
export function peekNames(names: readonly string[], n = 6, total = names.length): string {
  return names.slice(0, n).join(", ") + (total > n ? ` +${total - n} more` : "");
}

/** An advisory row's fix verdict from the dashboard's own dependency read, by any of its ids. */
export const advFix = (r: Pick<AdvRow, "id" | "aliases">, fixes: Readonly<Record<string, string>>): string | null =>
  [r.id, ...r.aliases].map((k) => fixes[k.toUpperCase()]).find(Boolean) ?? null;

/** The dashboard's out-of-date line: the count once a package manager answered, else what its door
 *  runs; null when it has neither. It stays the dashboard's own; the board's rows are the registries'. */
export function outdatedText(scanned: boolean, outdated: number, tool: string | null): string | null {
  if (scanned) return outdated ? `${plural(outdated, "package")} out of date` : "nothing out of date";
  return tool ? `not checked · the arrow above runs ${tool}` : null;
}

// ---------- the project tab's cards ----------

export interface FlowRow {
  workflow: string; status: CiStatus; at: number | null;
  runs: RunDot[]; // its newest runs, oldest first, so a strip reads left to right
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
        runs: runs.slice(0, CI_STRIP).map(dotOf).reverse(), red: x ? redFor(x, sec) ?? "" : null });
    }
  }
  return { branch, rows: rows.sort((a, b) => Number(b.red !== null) - Number(a.red !== null) || a.workflow.localeCompare(b.workflow)) };
}

/** The forge line under the tab's cards: where this repo lives, and how to pin one nobody could name. */
export function forgeText(inp: MaintInput): string {
  const f = inp.det?.forge;
  if (!f) return "";
  if (f.kind === "none") return "no remote";
  const where = [f.host, f.path].filter(Boolean).join("/") || f.kind;
  return f.kind === "unknown" ? `${where} · forge unknown: pin [maintenance] forge` : where;
}


export interface Hygiene {
  trunk: string | null; unpushed: number | null; localOnly: string[]; merged: string[]; gone: string[];
  stale: string[]; idle: number; idleNames: string[]; fetchedAt: number | null; // idleNames: each worktree's folder
  mergedRead: boolean; // false: no trunk, or git.rs could not read the protect list, so `merged` is empty for nothing
}
/** Git hygiene's counts, or null until a source read them. */
export function hygieneOf(inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): Hygiene | null {
  const rep = okFacts(inp, "git").find((r) => r.facts.kind === "hygiene");
  if (!rep) return null;
  const h = rep.facts as HygieneFacts, { stale, idle } = aged(h, th, now / 1000);
  return { trunk: h.trunk, unpushed: h.unpushed, localOnly: h.localOnly, merged: h.merged, gone: h.gone,
    stale: stale.map((b) => b.name), idle: idle.length, idleNames: idle.map((w) => w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path),
    fetchedAt: h.fetchedAt,
    mergedRead: h.trunk !== null && !inp.reports[rep.source].gaps.some((g) => g.startsWith("merged branches not read")) };
}

export interface CoverRow {
  facet: Facet; label: string; state: CovState | "unread" | "skipped" | "marker" | "untracked" | "none"; text: string; fix: string | null;
  source: string | null; // a source's id, so an offer's button can sit on its row; null for the rest
  url: string | null; // the forge page that switches an `off` source on
  cfg: boolean; // a [maintenance] key would answer it: the setup doors
  host: { alias: string; allowed: boolean } | null; // the [deploy] host a source reads: its row's Allow or Disallow
}

/** Coverage: every source and marker detected here and what became of it, in card order. */
export function coverRows(inp: MaintInput): CoverRow[] {
  const det = inp.det;
  if (!det) return [];
  const out: CoverRow[] = det.config.off.filter((f): f is Facet => FACETS.includes(f as Facet))
    .map((facet) => ({ facet, label: facetDef(facet).label, state: "untracked", text: "switched off in .episko/episko.toml", fix: null, source: null, url: null, cfg: false, host: null }));
  for (const id of det.sources) {
    const r = inp.reports[id], facet = findSource(id)?.facet ?? r?.facet;
    if (!facet) continue;
    const alias = readsHost(id) ? det.deploy?.host : null;
    const host = alias ? { alias, allowed: (inp.hosts ?? []).includes(alias) } : null;
    const row = (state: CoverRow["state"], text: string, fix: string | null = null, url: string | null = null) =>
      out.push({ facet, label: labelOf(id), state, text, fix, source: id, url, cfg: !!setupKeyOf(text), host });
    // A read that answered without a key it needed says so: merged branches want a trunk.
    const gap = r?.coverage.state === "ok" ? r.gaps.find((g) => setupKeyOf(g)) : undefined;
    if (unticked(inp, id)) row("skipped", notAllowed(inp));
    else if (inp.skip?.includes(id)) row("skipped", "skipped on this machine");
    else if (!r) row("unread", "not read yet");
    else row(r.coverage.state, gap ? `read; ${gap}` : covText(r.coverage), fixOf(r.coverage), settingsFor(r, det));
  }
  for (const m of det.markers) {
    out.push({ facet: m.facet, label: m.label, state: "marker", text: `found ${m.found.join(", ") || "on this forge"}, nothing reads it yet`, fix: null, source: null, url: null, cfg: false, host: null });
  }
  for (const facet of FACETS) {
    if (!out.some((r) => r.facet === facet)) out.push({ facet, label: facetDef(facet).none, state: "none", text: "nothing detected", fix: null, source: null, url: null, cfg: false, host: null });
  }
  return out.sort((a, b) => FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet));
}

// ---------- the all-clear's two lists ----------

export interface ComingUp { root: string; what: string; at: number } // at: unix secs

/** Dates inside the window that will need someone: certificates, and runtimes reaching their end. */
export function comingUp(projects: readonly { root: string; inp: MaintInput }[], now = Date.now(), days = 30): ComingUp[] {
  const sec = now / 1000, out: ComingUp[] = [];
  for (const { root, inp } of projects) {
    for (const r of runtimeStates(inp, clampMaint(inp.det?.config.thresholds), now)) {
      if (r.left !== null && typeof r.eol === "number" && r.eol > sec && r.eol - sec <= days * DAY) out.push({ root, what: `${rtName(r)} end-of-life`, at: r.eol });
    }
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
  name: string; url: string; err: string | null; code: number | null; ms: number | null;
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
    const [cert, certLevel]: [string, Level] = left === null ? (/^https:/i.test(p.url) ? ["cert unknown", "muted"] : ["", "ok"])
      : left <= 0 ? ["cert expired", "bad"] : [`cert ${span(left)}`, left < th.certWarnDays * DAY ? "warn" : "ok"];
    return { name: p.name, url: p.url, err: p.err, code: p.code, ms: p.ms,
      status: p.code === null ? "no answer" : `${p.code}${p.ms !== null ? ` · ${p.ms}ms` : ""}`,
      level: down ? "bad" : p.code! >= 400 ? "warn" : "ok", cert, certLevel };
  });
  return { at: Math.max(...reps.map((r) => r.at ?? 0)) || null, rows };
}

export interface HostRow { host: string; projects: string[]; level: Level; text: string; read: boolean } // read: the host itself answered
const HOST_RANK: Level[] = ["bad", "warn", "info", "muted", "unread", "ok"];
const byRank = (a: { level: Level }, b: { level: Level }) => HOST_RANK.indexOf(a.level) - HOST_RANK.indexOf(b.level);

/** Servers are not projects: one row per host, joined many-to-many on `[deploy] host`, worst first.
 *  A host is fine only when every project it runs was read fine; a known problem outranks the unknown. */
export function hostRows(projects: readonly { path: string; hosts: readonly string[]; prod?: Cell; read?: boolean; allowed?: boolean }[]): HostRow[] {
  const by = new Map<string, Map<string, Cell | undefined>>(), seen = new Set<string>(), allowed = new Set<string>();
  for (const p of projects) {
    for (const h of p.hosts) {
      if (!h) continue;
      const e = by.get(h) ?? new Map<string, Cell | undefined>();
      e.set(p.path, p.prod);
      by.set(h, e);
      if (p.read) seen.add(h);
      if (p.allowed) allowed.add(h);
    }
  }
  return [...by].map(([host, e]) => {
    const read = [...e.values()].filter((c): c is Cell => c?.state === "read").sort(byRank);
    const worst: Cell | undefined = read[0];
    const [level, text]: [Level, string] = worst && (byRank(worst, { level: "muted" }) < 0 || read.length === e.size)
      ? [worst.level, worst.text] : ["muted", read.length ? `${read.length} of ${e.size} checked` : "not checked"];
    // A Prod cell's dot may be the addresses' alone: a host nobody read is not a healthy host.
    const [lv, says]: [Level, string] = level === "ok" && !seen.has(host) ? ["muted", allowed.has(host) ? "host not read" : "not allowed here"] : [level, text];
    return { host, projects: [...e.keys()].sort((a, b) => a.localeCompare(b)), level: lv, text: says, read: seen.has(host) };
  }).sort((a, b) => byRank(a, b) || a.host.localeCompare(b.host));
}

// ---------- a host's vitals (the `hosts` facts) ----------

export const HOST_KINDS = ["disk", "containers", "updates", "reboot", "load"] as const;
export type HostKind = (typeof HOST_KINDS)[number];
/** One kind of trouble on a host: its card line's words, and the points its brief lists. */
export interface HostLine { kind: HostKind; level: Finding["level"]; text: string; detail: string; points: string[] }
export interface HostPart { level: Level; text: string }
export interface HostDisk { mount: string; pct: number; level: "bad" | "warn" | "ok"; free: string }
export interface HostFail { text: string; level: "bad" | "warn"; tip: string }
/** A host judged part by part; `level`/`text` are the worst judged part's, `summary` the whole in one line.
 *  The last row is what a board's card prints beside the parts, judged here so the two cannot differ. */
export interface HostState {
  alias: string; level: Level; text: string; tip: string[]; summary: string;
  disk: HostPart; updates: HostPart; reboot: HostPart; containers: HostPart; load: HostPart; uptime: HostPart;
  lines: HostLine[];
  disks: HostDisk[]; failing: HostFail[]; running: string | null; lists: { age: number; level: "warn" | "ok" } | null; perCpu: number | null;
  pending: { text: string; level: "warn" | "info" } | null;
}

/** How full, as df counts it: used of what a user may use, rounded up. */
export const diskPct = (d: Disk): number => d.usedKb + d.availKb > 0 ? Math.ceil((d.usedKb * 100) / (d.usedKb + d.availKb)) : 0;
const MB = 1024, GB = 1024 * 1024; // df's kilobytes
const size = (kb: number) => kb >= GB ? `${(kb / GB).toFixed(kb >= 100 * GB ? 0 : 1)} GB` : `${Math.round(kb / MB)} MB`;
const isUp = (c: HostContainer) => c.state === "running";
// Under a day longSpan's floor would call a host booted minutes ago a day old.
export const upSpan = (sec: number): string => sec < DAY ? span(sec) : longSpan(sec);

const diskLevel = (pct: number, th: MaintThresholds): HostDisk["level"] => pct >= th.diskBadPct ? "bad" : pct >= th.diskWarnPct ? "warn" : "ok";

function diskParts(h: HostFacts, th: MaintThresholds, on: string): [HostPart, HostLine | null] {
  const all = h.disks.map((d) => ({ d, pct: diskPct(d), level: diskLevel(diskPct(d), th) }));
  const filling = all.filter((x) => x.level !== "ok").sort((a, b) => b.pct - a.pct), root = all[0];
  if (!root) return [{ level: "muted", text: "disk unknown" }, null];
  if (!filling.length) return [{ level: "ok", text: `${root.d.mount} ${root.pct}%` }, null];
  const x = filling[0], level = filling.some((y) => y.level === "bad") ? "bad" : "warn";
  return [{ level, text: `${x.d.mount} ${x.pct}%` }, {
    kind: "disk", level, text: filling.length === 1 ? `${x.d.mount} ${x.pct}% full${on}` : `${filling.length} disks filling${on}`,
    detail: filling.map((y) => `${y.d.mount} ${y.pct}% · ${size(y.d.availKb)} free`).join(", "),
    points: filling.map((y) => `${y.d.mount} is ${y.pct}% full: ${size(y.d.availKb)} free of ${size(y.d.sizeKb)}`),
  }];
}

// Package lists as old as the host's own update timer: past `fetchStaleDays`, its counts drift too.
function listsOf(h: HostFacts, th: MaintThresholds, at: number): HostState["lists"] {
  if (h.listsAt === null) return null;
  const age = at - h.listsAt;
  return { age, level: age > th.fetchStaleDays * DAY ? "warn" : "ok" };
}

function updateParts(h: HostFacts, th: MaintThresholds, at: number, on: string): [HostPart, HostLine | null] {
  if (h.updates === null) return [{ level: "muted", text: "updates unknown" }, null];
  const lists = listsOf(h, th, at), age = lists?.age ?? null, stale = lists?.level === "warn";
  const sec = h.security ?? 0, n = h.updates, old = stale ? `lists ${span(age!)} old` : "";
  const part: HostPart = sec ? { level: "warn", text: `${sec} security` } : stale ? { level: "warn", text: old }
    : n ? { level: "info", text: plural(n, "update") } : { level: "ok", text: "up to date" };
  if (!sec && !stale && !n) return [part, null];
  const names = h.packages.slice(0, 5).join(", ") + (h.packages.length > 5 ? " …" : "");
  const count = n ? `${n} pending${h.security !== null ? `, ${sec} security` : ""}` : "";
  return [part, {
    kind: "updates", level: sec || stale ? "warn" : "info",
    text: sec ? `${plural(sec, "security update")}${on}` : stale ? `package lists ${span(age!)} old${on}` : `${plural(n, "update")}${on}`,
    detail: [count, old, names].filter(Boolean).join(" · "),
    points: [
      ...(n ? [`${plural(n, "update")} pending${h.security !== null ? `, ${sec} of them security` : ""}${names ? `: ${names}` : ""}`] : []),
      ...(stale ? [`its package lists are ${span(age!)} old: the host's own update timer may have stopped, and these counts are that old`] : []),
    ],
  }];
}

type Failing = { name: string; why: string; level: "bad" | "warn"; c: HostContainer | null };
// A count past the cap is a floor.
const runningOf = (cs: readonly HostContainer[], capped: boolean) => `${cs.filter(isUp).length}/${cs.length}${capped ? "+" : ""}`;
// Restarting, dead or unhealthy is red, and so is a named service with no replica up; a running one
// that keeps restarting is amber. An exit nobody named cannot tell a leftover from a failure: a tip.
function containerParts(h: HostFacts, compose: readonly string[], th: MaintThresholds, on: string, tip: string[], capped: boolean): [HostPart | null, HostLine | null, HostFail[]] {
  const cs = h.containers;
  if (!cs) return [compose.length ? { level: "muted", text: "containers unknown" } : null, null, []];
  const name = (c: HostContainer) => c.service ?? c.name, fails: Failing[] = [];
  for (const c of cs) {
    if (c.state === "restarting" || c.state === "dead") fails.push({ name: name(c), why: c.state, level: "bad", c });
    else if (isUp(c) && c.health === "unhealthy") fails.push({ name: name(c), why: "unhealthy", level: "bad", c });
    else if (isUp(c) && c.restarts >= th.containerRestarts) fails.push({ name: name(c), why: `restarted ${c.restarts} times`, level: "warn", c });
    else if (c.state === "exited" && c.exit && !(c.service && compose.includes(c.service))) tip.push(`${c.name} exited ${c.exit}`);
  }
  // Past the cap a service not on the list may only have been cut off it: unknown, never stopped.
  const cut: string[] = [];
  for (const s of compose) {
    const mine = cs.filter((c) => c.service === s), projects = [...new Set(mine.flatMap((c) => c.project ?? []))];
    if (!mine.some(isUp) && !fails.some((f) => f.name === s && f.level === "bad")) {
      if (capped) cut.push(s);
      else fails.push({ name: s, why: "not running", level: "bad", c: null });
    }
    if (projects.length > 1) tip.push(`${s} is a service of ${projects.length} projects on ${h.alias}: ${projects.join(", ")}`);
  }
  if (cut.length) tip.push(`${cut.join(", ")} not among the first ${cs.length} containers on ${h.alias}`);
  const bad = fails.filter((f) => f.level === "bad");
  if (!fails.length) return [cut.length ? { level: "muted", text: "containers unknown" } : { level: "ok", text: `${runningOf(cs, capped)} up` }, null, []];
  const worst = bad.length ? bad : fails, one = worst.length === 1;
  const point = (f: Failing) => f.c
    ? `${f.c.name}${f.c.service ? ` (service ${f.c.service})` : ""}: ${f.c.state}${f.c.health ? `, ${f.c.health}` : ""}, restarted ${plural(f.c.restarts, "time")}${f.c.exit ? `, last exit ${f.c.exit}` : ""}`
    : `service ${f.name} has no running container${cs.some((c) => c.service === f.name) ? "" : ", and none exists"}`;
  const chips = fails.map((f): HostFail => ({
    text: `${f.name} ${f.why}${f.c?.restarts && !f.why.startsWith("restarted") ? ` · ${plural(f.c.restarts, "restart")}` : ""}`, level: f.level, tip: point(f),
  })).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return [{ level: worst[0].level, text: one ? `${worst[0].name} ${worst[0].why}` : `${worst.length} ${bad.length ? "failing" : "restarting"}` }, {
    kind: "containers", level: worst[0].level,
    text: one ? `${worst[0].name} ${worst[0].why}${on}` : `${worst.length} containers ${bad.length ? "failing" : "restarting often"}${on}`,
    detail: fails.slice(0, 4).map((f) => `${f.name} ${f.why}`).join(", ") + (fails.length > 4 ? " …" : ""),
    points: fails.map(point),
  }, chips];
}

/** One host judged against `[maintenance.thresholds]`. A part nothing read is muted, never the dot, and
 *  the dot needs its disks and its updates read off fresh lists; a reboot or containers nobody could
 *  say about, with nothing named, stay a tip line. Ages are the host's own clock's. */
export function hostState(h: HostFacts, compose: readonly string[], th: MaintThresholds = MAINT_DEFAULTS, now = Date.now(), capped = false): HostState {
  const at = h.now ?? now / 1000, on = ` on ${h.alias}`, tip: string[] = [];
  const [disk, dl] = diskParts(h, th, on), [updates, ul] = updateParts(h, th, at, on);
  const [containers, cl, failing] = containerParts(h, compose, th, on, tip, capped);
  const reboot: HostPart = h.reboot === null ? { level: "muted", text: "reboot unknown" } : h.reboot ? { level: "warn", text: "reboot needed" } : { level: "ok", text: "" };
  const rl: HostLine | null = h.reboot ? { kind: "reboot", level: "warn", text: `${h.alias} needs a reboot`, detail: h.rebootWhy.slice(0, 3).join(", "),
    points: [`it needs a reboot${h.rebootWhy.length ? `: ${h.rebootWhy.join(", ")}` : ""}`] } : null;
  if (h.reboot === null) tip.push(`nothing on ${h.alias} says whether it needs a reboot`);
  const per = h.load && h.cpus ? h.load[2] / h.cpus : null, hot = per !== null && per >= th.loadPerCpu;
  const load: HostPart = per === null ? { level: "muted", text: "load unknown" } : { level: hot ? "warn" : "ok", text: `load ${per.toFixed(1)}/cpu` };
  const ll: HostLine | null = hot ? { kind: "load", level: "warn", text: `${h.alias} load ${per!.toFixed(1)} per CPU`, detail: `15-minute load ${h.load![2]} on ${plural(h.cpus!, "CPU")}`,
    points: [`its 15-minute load is ${h.load![2]} on ${plural(h.cpus!, "CPU")}, ${per!.toFixed(1)} per CPU`] } : null;
  const uptime: HostPart = { level: "ok", text: h.uptime === null ? "" : `up ${upSpan(h.uptime)}` };
  const judged = [disk, updates, ...(h.reboot !== null ? [reboot] : []), ...(containers ? [containers] : []), ...(per !== null ? [load] : [])];
  const worst = [...judged].sort(byRank)[0];
  const lines = [dl, cl, ul, rl, ll].filter((l): l is HostLine => !!l).sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  const summary = [disk.text, updates.text, h.reboot ? reboot.text : "", h.containers ? containers?.text ?? "" : "", uptime.text].filter(Boolean).join(" · ");
  return {
    alias: h.alias, level: worst.level, text: worst.level === "ok" ? "" : worst.text, summary,
    tip: [`${h.alias}: ${summary}`, ...lines.map((l) => l.text), ...tip],
    disk, updates, reboot, containers: containers ?? { level: "ok", text: "" }, load, uptime, lines,
    disks: h.disks.map((d) => ({ mount: d.mount, pct: diskPct(d), level: diskLevel(diskPct(d), th), free: size(d.availKb) })),
    failing, running: h.containers && runningOf(h.containers, capped), lists: listsOf(h, th, at), perCpu: per,
    pending: h.updates ? { text: `${h.updates}${h.security ? ` · ${h.security} security` : ""}`, level: h.security ? "warn" : "info" } : null,
  };
}

/** The Runs on card's host: whether this machine may reach it, its last read judged, or that read's
 *  failure in a word (`why`, Coverage's to explain), and what it could not read (`gaps`). Null when no
 *  `[deploy] host` is read here (none, or its source switched off). */
export interface HostSummary { alias: string; allowed: boolean; at: number | null; state: HostState | null; why: string | null; gaps: string[] }
export function hostSummary(inp: MaintInput, th: MaintThresholds = MAINT_DEFAULTS, now = Date.now()): HostSummary | null {
  const alias = inp.det?.deploy?.host, ids = (inp.det?.sources ?? []).filter((id) => readsHost(id) && (!inp.skip?.includes(id) || unticked(inp, id)));
  if (!alias || !ids.length) return null;
  const allowed = (inp.hosts ?? []).includes(alias);
  const reps = ids.map((id) => inp.reports[id]), rep = reps.find((r) => r?.coverage.state === "ok" && r.facts?.kind === "hosts");
  const failed = rep ? undefined : reps.find((r) => r && r.coverage.state !== "notRun");
  const h = rep?.facts?.kind === "hosts" ? rep.facts.items.find((x) => x.alias === alias) : undefined;
  return {
    alias, allowed, at: (rep ?? failed)?.at ?? null, state: allowed && h ? hostState(h, h.compose, th, now, rep?.truncated) : null,
    why: failed ? whyWord(failed.coverage, "prod") : null, gaps: rep?.gaps ?? [],
  };
}

/** Whether this project's host answered a read: a host row's tip stops saying it was never read. */
export const hostRead = (inp: MaintInput): boolean => okFacts(inp, "prod").some((r) => r.facts.kind === "hosts");

// ---------- the cold-boot snapshot (`cc-maint`) ----------

export const SNAP_ROOTS = 200, SNAP_FINDINGS = 12, SNAP_TEXT = 80, SNAP_KEY = 300;
const LEVELS: readonly Level[] = ["bad", "warn", "info", "ok", "muted", "unread"];
/** What a finished scan leaves for the next boot: a card's words, never an advisory's payload or a URL.
 *  `at` (ms) only on what an older scan left, when it differs from the snapshot's own. */
export interface SnapCell { facet: Facet; level: Level; text: string; at?: number }
export interface SnapFinding { facet: Facet; key: string; level: Finding["level"]; text: string; at?: number }
/** `account`: the forge login pinned when it was read, null for none (and for a snapshot from before it was kept). */
export interface MaintSnap { at: number; account: string | null; cells: SnapCell[]; findings: SnapFinding[] } // at: ms
export type MaintSnaps = Record<string, MaintSnap>;
/** A root's snapshot, if the identity reading this project now is the one that left it, as `cc-maint-scan` loads. */
export const snapFor = (snaps: MaintSnaps, root: string, account: string | null): MaintSnap | undefined =>
  snaps[root]?.account === account ? snaps[root] : undefined;

const VERDICT: readonly CellState[] = ["read", "none", "off"];
const FINDING_RANK: readonly Finding["level"][] = ["bad", "warn", "info"];
// A second kind read beside a failed read of the first reaches no verdict on the facet, so the last
// known red stands. Only a fresh red replaces it, and re-runs are never red.
const reached = (c: Cell, inp: MaintInput) => VERDICT.includes(c.state) && (vouched(c, inp) || c.level === "bad");
// Release's only red is a deploy's, and tags cannot speak for it: a failed environments read leaves its lines standing.
const deployStands = (c: Cell, inp: MaintInput, prev: MaintSnap) => c.facet === "release" && c.state === "read" && c.level !== "bad"
  && prev.findings.some((f) => f.key.startsWith("release:deploy")) && readFailed(inp, (id) => !!findSource(id)?.sees.includes("rel.deployed"));

/** One project's snapshot: its seven cells and its first lines, as the card drew them when the scan finished.
 *  A facet this scan reached no verdict on keeps `prev`'s cell and lines, dated as then: a failed read
 *  must not erase the last known red. */
export function takeSnap(root: string, inp: MaintInput, now = Date.now(), prev?: MaintSnap, account: string | null = null): MaintSnap {
  const th = clampMaint(inp.det?.config.thresholds);
  const live = facetCells(inp, th, now);
  const kept = new Set(prev ? live.filter((c) => !reached(c, inp) || deployStands(c, inp, prev)).map((c) => c.facet) : []);
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
  return { at: now, account, cells, findings: all.slice(0, SNAP_FINDINGS) };
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
    return [[root, { at: v.at as number, account: strOr(v.account), cells, findings: fs }]];
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
export function ciRows(inp: MaintInput | null, snap: MaintSnap | null | undefined, now = Date.now()): CiRow[] {
  const th = clampMaint(inp?.det?.config.thresholds);
  if (inp && reached(facetCell("ci", inp, th, now), inp)) {
    const sec = now / 1000;
    return ciFailures(okFacts(inp, "ci")).map((x) => {
      const age = redFor(x, sec);
      return { key: `ci:${x.workflow}`, text: `CI failing${age ? ` ${age}` : ""}`, since: x.since ? x.since * 1000 : null, asOf: null,
        detail: `${x.workflow} on ${x.branch}${x.sha ? ` · first red at ${x.sha.slice(0, 7)}` : ""}` };
    });
  }
  // A snapshot keeps words only; a line from before slice 14 named its one workflow in its key. Red
  // only: a flaky job is noise, never a red default branch.
  return (snap?.findings ?? []).filter((f) => f.facet === "ci" && f.level === "bad")
    .map((f) => ({ key: f.key, text: f.text, detail: f.key.replace(/^ci:?/, ""), since: null, asOf: f.at ?? snap!.at }));
}

// ---------- the last scan, kept whole (`cc-maint-scan`) ----------

/** What a boot paints before anyone asks: each root's detection and reports as its last finished scan left them. */
export interface KeptScan { at: number; account: string | null; det: Detection; reports: Record<string, SourceReport> } // at: ms
export type KeptScans = Record<string, KeptScan>;
export const KEPT_CHARS = 1_500_000; // localStorage is shared with every other cc- key

/** `cc-maint-scan` narrowed through the wire's own narrowing: a root that fails it is dropped alone. */
export function clampKept(raw: unknown): KeptScans {
  if (!isObj(raw)) return {};
  return Object.fromEntries(Object.entries(raw).flatMap(([root, v]): [string, KeptScan][] => {
    if (!root || !isObj(v) || !num(v.at) || (v.at as number) <= 0 || !isObj(v.reports)) return [];
    const det = narrowDetection(v.det);
    if (!det) return [];
    const reports = Object.fromEntries(Object.entries(v.reports).map(([id, r]) => [id, narrowMaint(r, id)]));
    return [[root, { at: v.at as number, account: strOr(v.account), det, reports }]];
  }));
}

/** The newest scans that fit `budget` characters; a root left out falls back to its `cc-maint` snapshot. */
export function packKept(all: KeptScans, budget = KEPT_CHARS): KeptScans {
  const out: KeptScans = {};
  let used = 2;
  for (const [root, k] of Object.entries(all).sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]))) {
    const n = JSON.stringify(root).length + JSON.stringify(k).length + (used > 2 ? 2 : 1); // `:` and a `,` after the first
    if (used + n <= budget) { out[root] = k; used += n; }
  }
  return out;
}

// ---------- the week's marks (`cc-maint-week`) ----------

export const WEEK_DAYS = 7, WEEK_ROOTS = 200, WEEK_ROWS = 60, WEEK_NAMES = 4, WEEK_TEXT = 120, WEEK_LINES = 5;
export const WEEK_MARKS = WEEK_DAYS + 1; // one per local day of the window, and the baseline before it
export const WEEK_CHARS = 250_000; // beside cc-maint-scan's 1.5M, under one origin's quota
const WEEK_FACETS: readonly Facet[] = ["ci", "security", "deps", "release"];

/** One vulnerability as a mark keeps it: its names (`keysOf`), never its package, summary or link. */
export interface MarkAdv { names: string[]; severity: Severity; kind: AdvisoryKind }
export interface MarkRt { key: string; name: string; eol: Eol } // key: product@cycle
export interface MarkRel { tags: number | null; tag: string | null; published: number | null; fetchedAt: number | null }
/** What a finished scan leaves for next week: identities and counts. A null facet, or a source or bot
 *  left out, had no verdict read in full; `none` names a facet with nothing to read (no source, off),
 *  `part` a source that answered with only part of its list. */
export interface WeekMark {
  at: number; account: string | null; // at: ms
  ci: { red: string[]; green: string[] } | null; // each workflow whose newest finished default-branch run failed, or passed
  adv: Record<string, MarkAdv[]>; part: string[]; // per source
  prs: Record<string, number[]>; // open update PRs per bot
  rt: MarkRt[] | null; rel: MarkRel | null; none: Facet[];
}
export type WeekMarks = Record<string, WeekMark[]>; // newest first

const cut = (s: string) => s.slice(0, WEEK_TEXT);
const fits = (xs: readonly unknown[]) => xs.length <= WEEK_ROWS;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
// A mark is one per local day, so age is counted in those: last Monday's stays a week old at whatever hour
// either ran, and a clock change moves no day.
const dayNo = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / (DAY * 1000); };
const weekOld = (m: WeekMark, now: WeekMark) => dayNo(now.at) - dayNo(m.at) >= WEEK_DAYS;
const productOf = (key: string) => key.slice(0, key.indexOf("@"));

// A finding's line moves with every edit above it, so across a week it is its rule and its file.
const markNames = (a: Advisory) => [...new Set(keysOf(a).map((n) => a.kind === "dependency" ? n : n.replace(/:\d+$/, "")))];

/** Whether a finished scan leaves a mark: a checkout that is gone detects no source, which is no verdict. */
export const leavesMark = (inp: MaintInput): boolean => !!inp.det?.sources.length;

/** The mark a finished scan leaves, over `okFacts`: a truncated or failed source is left out. */
export function takeMark(inp: MaintInput, at: number, account: string | null): WeekMark {
  const th = clampMaint(inp.det?.config.thresholds);
  const none = WEEK_FACETS.filter((f) => ["none", "off"].includes(facetCell(f, inp, th, at).state));
  // One list across the sources that read the default branch, so it stands only when every one answered: a
  // failed one is no fix. A flaky read adds nothing to the list, so it can neither cost it nor vouch for it.
  const listsRuns = (id: string) => { const d = findSource(id); return d ? d.facet === "ci" && d.sees.includes("ci.default-branch") : inp.reports[id]?.facet === "ci"; };
  const ciIds = (inp.det?.sources ?? []).filter((id) => listsRuns(id) && !inp.skip?.includes(id));
  // Each workflow's newest finished run: one still out, or skipped, keeps its last verdict in both lists.
  const finished = okFacts(inp, "ci").map((r) => r.facts.kind !== "ciRuns" ? r
    : { ...r, facts: { ...r.facts, runs: r.facts.runs.filter((x) => x.status === "pass" || x.status === "fail") } });
  const red = [...new Set(ciFailures(finished).map((x) => cut(x.workflow)))].sort();
  const newest = new Map<string, CiStatus>();
  for (const { facts: f } of finished) if (f.kind === "ciRuns") for (const r of f.runs) if (!newest.has(r.workflow)) newest.set(r.workflow, r.status);
  const green = [...new Set([...newest].filter(([, st]) => st === "pass").map(([w]) => cut(w)))].sort();
  const ciRead = !none.includes("ci") && ciIds.length > 0 && ciIds.every((id) => inp.reports[id]?.coverage.state === "ok");
  const adv: Record<string, MarkAdv[]> = {}, prs: Record<string, number[]> = {}, part: string[] = [];
  let rt: MarkRt[] | null = null, rel: MarkRel | null = null;
  for (const { source, truncated, facts: f } of okFacts(inp, "security")) {
    if (f.kind === "advisories") {
      const rows = foldMarks(f.items.map((a): MarkAdv => ({ names: markNames(a), severity: a.severity, kind: a.kind })));
      // A broken file's rows are simply gone, and a cut list's: either would read as cleared.
      if (truncated || inp.reports[source]?.gaps.length || !fits(rows)) part.push(cut(source));
      else adv[cut(source)] = rows.map((r) => ({ ...r, names: r.names.slice(0, WEEK_NAMES).map(cut) }));
    } else if (f.kind === "runtimes" && !truncated) {
      const prev: MarkRt[] = rt ?? [], by = new Map(prev.map((r) => [r.key, r]));
      for (const r of f.items) {
        const key = cut(`${r.product}@${r.cycle ?? `?${r.declared}`}`); // judgeRuntimes' key
        by.set(key, { key, name: cut(`${r.name} ${r.cycle ?? r.declared}`), eol: r.eol });
      }
      rt = [...by.values()];
    }
  }
  for (const { truncated, facts: f } of okFacts(inp, "deps")) {
    if (f.kind === "updatePrs" && !truncated && fits(f.prs)) prs[cut(f.bot)] = f.prs.map((p) => p.number).sort((a, b) => a - b);
  }
  for (const { truncated, facts: f } of okFacts(inp, "release")) {
    const was: MarkRel = rel ?? { tags: null, tag: null, published: null, fetchedAt: null };
    if (f.kind === "release") rel = { ...was, tags: f.tagsSeen, tag: f.tag === null ? null : cut(f.tag), fetchedAt: f.fetchedAt };
    else if (f.kind === "releases" && !truncated) rel = { ...was, published: f.count };
  }
  return { at, account, ci: ciRead && fits(red) && fits(green) ? { red, green } : null, adv, part, prs, rt: rt && fits(rt) ? rt : null, rel, none };
}

// Newest first: every mark inside the window of the newest, then the newest older one, the baseline.
function prune(marks: readonly WeekMark[]): WeekMark[] {
  const s = [...marks].sort((a, b) => b.at - a.at), base = s.find((m) => weekOld(m, s[0]));
  return [...s.filter((m) => !weekOld(m, s[0])).slice(0, WEEK_MARKS - (base ? 1 : 0)), ...(base ? [base] : [])];
}

/** One more finished scan. A mark of the same local day is replaced, but a facet, source or bot the newer
 *  scan reached no verdict on keeps that one's: a failed afternoon read never erases the morning's. */
export function addMark(marks: readonly WeekMark[], m: WeekMark): WeekMark[] {
  const old = marks.find((x) => dayNo(x.at) === dayNo(m.at) && x.account === m.account);
  const off = (f: Facet) => m.none.includes(f);
  // The tag read and the published count fail apart, so each keeps the morning's alone.
  const rel = (o: MarkRel | null): MarkRel | null => !o || !m.rel ? m.rel ?? (off("release") ? null : o) : {
    ...(m.rel.tags === null ? { tags: o.tags, tag: o.tag, fetchedAt: o.fetchedAt } : { tags: m.rel.tags, tag: m.rel.tag, fetchedAt: m.rel.fetchedAt }),
    published: m.rel.published ?? o.published,
  };
  const merged: WeekMark = !old ? m : {
    ...m, ci: m.ci ?? (off("ci") ? null : old.ci), rt: m.rt ?? (off("security") ? null : old.rt), rel: rel(old.rel),
    adv: off("security") ? m.adv : { ...old.adv, ...m.adv }, part: off("security") ? m.part : [...new Set([...old.part, ...m.part])],
    prs: off("deps") ? m.prs : { ...old.prs, ...m.prs },
  };
  return prune([merged, ...marks.filter((x) => x !== old)]);
}

/** This account's newest mark and the newest one seven local days older or more, else its oldest earlier one. */
export function weekPair(marks: readonly WeekMark[], account: string | null): { now: WeekMark; base: WeekMark | null } | null {
  const mine = marks.filter((m) => m.account === account).sort((a, b) => b.at - a.at);
  if (!mine.length) return null;
  const now = mine[0], base = mine.find((m) => weekOld(m, now)) ?? mine[mine.length - 1];
  return { now, base: base === now ? null : base };
}

const isMarkAdv = shape({ names: (v) => list(str)(v) && (v as string[]).length > 0, severity: oneOf(SEVERITIES), kind: oneOf(ADVISORY_KINDS) });
const isMarkRt = shape({ key: str, name: str, eol: (v) => v === null || num(v) || bool(v) });
const isMarkRel = shape({ tags: opt(num), tag: opt(str), published: opt(num), fetchedAt: opt(num) });
const isMark = shape({
  at: (v) => num(v) && (v as number) > 0, ci: opt(shape({ red: list(str), green: list(str) })), adv: (v) => isObj(v) && Object.values(v).every(list(isMarkAdv)), part: list(str),
  prs: (v) => isObj(v) && Object.values(v).every(list(num)), rt: opt(list(isMarkRt)), rel: opt(isMarkRel), none: list(oneOf(FACETS)),
});

// Rebuilt field by field: a list past the cap is no verdict, never a cut one that would read as cleared.
function clampMark(v: unknown): WeekMark | null {
  if (!isMark(v)) return null;
  const m = v as WeekMark;
  const adv = Object.entries(m.adv).filter(([, xs]) => fits(xs))
    .map(([s, xs]) => [cut(s), xs.map((a) => ({ names: a.names.slice(0, WEEK_NAMES).map(cut), severity: a.severity, kind: a.kind }))]);
  const prs = Object.entries(m.prs).filter(([, xs]) => fits(xs)).map(([b, xs]) => [cut(b), [...xs]]);
  const rel = m.rel && { tags: m.rel.tags, tag: m.rel.tag === null ? null : cut(m.rel.tag), published: m.rel.published, fetchedAt: m.rel.fetchedAt };
  return {
    at: m.at, account: strOr((v as Obj).account),
    ci: m.ci && fits(m.ci.red) && fits(m.ci.green) ? { red: m.ci.red.map(cut), green: m.ci.green.map(cut) } : null,
    adv: Object.fromEntries(adv), part: [...new Set(m.part)].slice(0, WEEK_ROWS).map(cut), prs: Object.fromEntries(prs),
    rt: m.rt && fits(m.rt) ? m.rt.map((r) => ({ key: cut(r.key), name: cut(r.name), eol: r.eol })) : null, rel, none: [...new Set(m.none)],
  };
}

/** `cc-maint-week` narrowed: a bad mark or root is dropped alone, a root keeps one mark per local day
 *  and account inside the window plus its baseline, and past two hundred roots the oldest go. */
export function clampWeek(raw: unknown): WeekMarks {
  if (!isObj(raw)) return {};
  const roots = Object.entries(nfcKeys(raw)).flatMap(([root, v]): [string, WeekMark[]][] => {
    if (!root || !Array.isArray(v)) return [];
    const seen = new Set<string>();
    const ms = v.map(clampMark).filter((m): m is WeekMark => !!m).sort((a, b) => b.at - a.at)
      .filter((m) => { const k = `${dayNo(m.at)}\n${m.account}`; return !seen.has(k) && !!seen.add(k); });
    return ms.length ? [[root, prune(ms)]] : [];
  });
  return Object.fromEntries(roots.sort((a, b) => b[1][0].at - a[1][0].at || a[0].localeCompare(b[0])).slice(0, WEEK_ROOTS));
}

/** What fits `budget` characters: every root's newest mark and baseline first, newest roots first, so a
 *  comparison outlives the days between; then, newest first, whole windows where they still fit. */
export function packWeek(all: WeekMarks, budget = WEEK_CHARS): WeekMarks {
  const out: WeekMarks = {};
  let used = 1; // `{}` less the comma after the last entry
  const roots = Object.entries(all).filter(([, ms]) => ms.length).sort((a, b) => b[1][0].at - a[1][0].at || a[0].localeCompare(b[0]));
  for (const [root, ms] of roots) {
    const base = ms.find((m) => weekOld(m, ms[0])) ?? ms[ms.length - 1], v = base === ms[0] ? [ms[0]] : [ms[0], base];
    const n = JSON.stringify(root).length + JSON.stringify(v).length + 2; // `:` and `,`
    if (used + n <= budget) { out[root] = v; used += n; }
  }
  for (const [root, ms] of roots) {
    const more = out[root] ? JSON.stringify(ms).length - JSON.stringify(out[root]).length : 0;
    if (more > 0 && used + more <= budget) { out[root] = ms; used += more; }
  }
  return out;
}

// ---------- since last week: two marks compared ----------

export type WeekSpan = "first" | "week" | "long"; // first: no mark is a week old yet
/** A change between a project's two marks; `key` is a finding's, so `findingTarget` opens its board. */
export interface WeekChange { root: string; facet: Facet; key: string; level: Level; text: string; detail: string }
/** What could not be compared, and why. `facet` null is the whole project; `click`: said in the tip only. */
export interface WeekGap { facet: Facet | null; roots: string[]; why: string; click: boolean }
export interface WeekDigest {
  since: number; until: number; span: WeekSpan; // ms
  compared: number; unmarked: string[]; unread: string[]; behind: string[]; // checked once so far; never; not lately
  advNew: number; advCleared: number; ciBroke: number; ciFixed: number;
  prsOpened: number; prsClosed: number; released: number; ended: number; movedOff: number;
  changes: WeekChange[]; gaps: WeekGap[];
  quiet: boolean; // nothing changed in what was compared
}
export interface WeekPairIn { root: string; base: WeekMark; now: WeekMark; th: MaintThresholds }

const WEEK_KIND: Record<AdvisoryKind, [string, string]> = {
  dependency: ["advisory", "advisories"], code: ["code finding", "code findings"],
  config: ["misconfiguration", "misconfigurations"], secret: ["secret", "secrets"],
};
// Asked only on a click, unless this machine opted in, when every scan asks it and its failure is news.
const clickOnly = (s: string, opted: readonly string[]) => { const d = findSource(s); return !!d && !permitted(d.cost, "scan", opted.includes(s)); };
const rtClickOnly = (opted: readonly string[]) => facetSources("security").filter((s) => s.sees.includes("sec.runtime")).every((s) => clickOnly(s.id, opted));
const firsts = (xs: readonly string[], n = 3) => xs.slice(0, n).join(", ") + (xs.length > n ? " …" : "");

// One row per vulnerability across sources: a name shared by two rows makes them one, at the worse severity.
function foldMarks(rows: readonly MarkAdv[]): MarkAdv[] {
  const out: MarkAdv[] = [];
  for (const r of rows) {
    const hits = out.filter((g) => g.names.some((n) => r.names.includes(n)));
    const all = [r, ...hits], worst = all.sort((a, b) => sevRank(a.severity) - sevRank(b.severity))[0];
    for (const h of hits) out.splice(out.indexOf(h), 1);
    out.push({ names: [...new Set(all.flatMap((x) => x.names))].sort(), severity: worst.severity, kind: worst.kind });
  }
  return out.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (a.names[0] ?? "").localeCompare(b.names[0] ?? ""));
}

/** The fleet's week from each project's pair of marks, compared only where both read the same thing in full. */
export function weekDigest(pairs: readonly WeekPairIn[], unmarked: readonly string[], unread: readonly string[] = [], opted: readonly string[] = []): WeekDigest {
  const d: WeekDigest = { since: 0, until: 0, span: "week", compared: 0, unmarked: [...unmarked].sort(), unread: [...unread].sort(), behind: [], advNew: 0, advCleared: 0,
    ciBroke: 0, ciFixed: 0, prsOpened: 0, prsClosed: 0, released: 0, ended: 0, movedOff: 0, changes: [], gaps: [], quiet: false };
  const gaps = new Map<string, WeekGap>();
  const gap = (facet: Facet | null, root: string, why: string, click = false) => {
    const g = gaps.get(`${facet}\n${why}`) ?? { facet, roots: [], why, click };
    if (!g.roots.includes(root)) g.roots.push(root);
    gaps.set(`${facet}\n${why}`, g);
  };
  const commonest = (ps: readonly WeekPairIn[], at: (p: WeekPairIn) => number, oldest: boolean): [number, WeekPairIn[]] => {
    const by = new Map<number, WeekPairIn[]>();
    for (const p of ps) by.set(dayNo(at(p)), [...(by.get(dayNo(at(p))) ?? []), p]);
    return [...by].sort((a, b) => b[1].length - a[1].length || (oldest ? a[0] - b[0] : b[0] - a[0]))[0] ?? [0, []];
  };
  // Both ends are the commonest day, so one project read since, or unread for a month, moves neither.
  // A project more than a day behind says nothing of this week: its changes are older than the head.
  const [latest, ends] = commonest(pairs, (p) => p.now.at, false);
  const isBehind = (m: WeekMark) => latest - dayNo(m.at) > 1;
  const [, mode] = commonest(pairs.filter((p) => !isBehind(p.now)), (p) => p.base.at, true);
  d.since = mode.length ? Math.min(...mode.map((p) => p.base.at)) : 0;
  d.until = ends.length ? Math.max(...ends.map((p) => p.now.at)) : 0;
  d.span = mode.every((p) => !weekOld(p.base, p.now)) ? "first" : dayNo(d.until) - dayNo(d.since) <= WEEK_DAYS + 1 ? "week" : "long";
  for (const { root, base, now, th } of pairs) {
    if (isBehind(now)) { d.behind.push(root); gap(null, root, `last checked ${fmtDay(now.at)}`); continue; }
    const add = (facet: Facet, key: string, level: Level, text: string, detail = "") => d.changes.push({ root, facet, key, level, text, detail });
    const said = new Set<Facet>(), was = (f: Facet) => base.none.includes(f) || now.none.includes(f);
    const miss = (f: Facet, why: string, click = false) => { said.add(f); gap(f, root, why, click); };
    const unknown = (f: Facet, why: string) => { if (!was(f) && !said.has(f)) gap(f, root, why); };
    const when = (then: boolean) => then ? "then" : "now";
    if (Math.abs(dayNo(base.at) - dayNo(d.since)) > 1) gap(null, root, `compared from ${fmtDay(base.at)}`);
    let compared = false;
    // Fixed is red then and passing now: a re-run still out, or a workflow gone, has fixed nothing yet.
    if (base.ci && now.ci) {
      compared = true;
      const broke = now.ci.red.filter((w) => !base.ci!.red.includes(w)), fixed = base.ci.red.filter((w) => now.ci!.green.includes(w));
      d.ciBroke += broke.length; d.ciFixed += fixed.length;
      if (broke.length) add("ci", "ci", "bad", broke.length === 1 ? `CI broke: ${broke[0]}` : `${broke.length} workflows broke`, broke.length > 1 ? firsts(broke) : "");
      if (fixed.length) add("ci", "ci", "ok", fixed.length === 1 ? `CI fixed: ${fixed[0]}` : `${fixed.length} workflows fixed`, fixed.length > 1 ? firsts(fixed) : "");
    } else unknown("ci", base.ci ? "no verdict now" : now.ci ? "no verdict then" : "no verdict either time");
    // Per source read in full both times, folded by name, so one reporter's id meets another's alias.
    const srcs = [...new Set([...Object.keys(base.adv), ...Object.keys(now.adv)])].sort();
    const both = srcs.filter((s) => has(base.adv, s) && has(now.adv, s));
    for (const s of srcs) if (!both.includes(s)) miss("security", `${labelOf(s)} read in full only ${when(has(base.adv, s))}`, clickOnly(s, opted));
    for (const s of new Set([...base.part, ...now.part])) if (!srcs.includes(s)) miss("security", `${labelOf(s)} read only in part`, clickOnly(s, opted));
    if (both.length) {
      compared = true;
      const then = foldMarks(both.flatMap((s) => base.adv[s])), is = foldMarks(both.flatMap((s) => now.adv[s]));
      // Against every source of the other mark: one read only once may still be reporting the row.
      const namesIn = (m: WeekMark) => new Set(Object.values(m.adv).flat().flatMap((a) => a.names));
      const thenN = namesIn(base), isN = namesIn(now);
      const fresh = is.filter((a) => !a.names.some((n) => thenN.has(n))), gone = then.filter((a) => !a.names.some((n) => isN.has(n)));
      d.advNew += fresh.length; d.advCleared += gone.length;
      for (const kind of ADVISORY_KINDS) {
        const nu = fresh.filter((a) => a.kind === kind), cl = gone.filter((a) => a.kind === kind), [one, many] = WEEK_KIND[kind];
        const sev = (s: Severity) => s === "unknown" || kind === "secret" ? "" : `${s} `;
        if (nu.length) add("security", `security:${kind}`, kind === "secret" ? "bad" : SEV_LEVEL[nu[0].severity],
          nu.length === 1 ? `new ${sev(nu[0].severity)}${one}` : `${nu.length} new ${many}`, firsts(nu.map((a) => a.names[0])));
        if (cl.length) add("security", `security:${kind}`, "ok", `${plural(cl.length, one, many)} cleared`, firsts(cl.map((a) => a.names[0])));
      }
    } else if (!srcs.length) unknown("security", "no advisory source read in full both times");
    // A runtime that reached its end inside the window is dated by the newer mark alone.
    const from = base.at / 1000, sec = now.at / 1000;
    for (const r of now.rt ?? []) {
      if (ROLLING.has(productOf(r.key))) continue;
      const turned = r.eol === true && !!base.rt?.some((b) => b.key === r.key && b.eol !== true);
      if (!turned && !(typeof r.eol === "number" && r.eol > from && r.eol <= sec)) continue;
      d.ended++;
      add("security", "security:runtime", "bad", `${r.name} reached end-of-life`, typeof r.eol === "number" ? `ended ${longSpan(sec - r.eol)} ago` : "now listed as ended");
    }
    const due = (r: MarkRt) => !ROLLING.has(productOf(r.key)) && (r.eol === true || (typeof r.eol === "number" && r.eol - from < th.eolWarnDays * DAY));
    if (base.rt && now.rt) {
      compared = true;
      // Onto another cycle of the product: one whose list failed this time simply has no row.
      for (const b of base.rt) {
        if (!due(b) || now.rt.some((r) => r.key === b.key) || !now.rt.some((r) => productOf(r.key) === productOf(b.key))) continue;
        d.movedOff++;
        add("security", "security:runtime", "ok", `moved off ${b.name}`);
      }
    } else if (base.rt || now.rt) miss("security", `runtimes read only ${when(!!base.rt)}`, rtClickOnly(opted));
    const bots = [...new Set([...Object.keys(base.prs), ...Object.keys(now.prs)])].sort();
    for (const b of bots) {
      if (!has(base.prs, b) || !has(now.prs, b)) { miss("deps", `${findSource(`${b}-prs`)?.label ?? b} read in full only ${when(has(base.prs, b))}`); continue; }
      compared = true;
      const opened = now.prs[b].filter((n) => !base.prs[b].includes(n)), closed = base.prs[b].filter((n) => !now.prs[b].includes(n));
      d.prsOpened += opened.length; d.prsClosed += closed.length;
      const nums = (xs: number[]) => firsts(xs.map((n) => `#${n}`), 4);
      if (opened.length) add("deps", `deps:${b}`, "info", `${plural(opened.length, "update PR")} opened`, nums(opened));
      if (closed.length) add("deps", `deps:${b}`, "ok", `${plural(closed.length, "update PR")} closed`, nums(closed));
    }
    if (!bots.length) unknown("deps", "no update bot read in full both times");
    // Tags counted both times, else published releases; a deleted tag never counts as minus one.
    const tags = base.rel?.tags != null && now.rel?.tags != null, pub = base.rel?.published != null && now.rel?.published != null;
    if (tags || pub) {
      compared = true;
      const n = Math.max(0, tags ? now.rel!.tags! - base.rel!.tags! : now.rel!.published! - base.rel!.published!);
      d.released += n;
      if (n) add("release", "release", "ok", `${plural(n, "release")} tagged`, tags && now.rel!.tag ? `newest ${now.rel!.tag}` : "");
    } else unknown("release", base.rel ? "no release count now" : now.rel ? "no release count then" : "no release count either time");
    const fetched = now.rel?.fetchedAt;
    if (fetched && sec - fetched > th.fetchStaleDays * DAY) gap("release", root, `counted as of the last fetch, ${span(sec - fetched)} ago`);
    if (compared) d.compared++;
  }
  d.behind.sort();
  d.changes.sort((a, b) => HOST_RANK.indexOf(a.level) - HOST_RANK.indexOf(b.level) || FACETS.indexOf(a.facet) - FACETS.indexOf(b.facet)
    || a.root.localeCompare(b.root) || a.key.localeCompare(b.key) || a.text.localeCompare(b.text));
  d.gaps = [...gaps.values()].map((g) => ({ ...g, roots: [...g.roots].sort() }))
    .sort((a, b) => (a.facet ? FACETS.indexOf(a.facet) : FACETS.length) - (b.facet ? FACETS.indexOf(b.facet) : FACETS.length) || a.why.localeCompare(b.why));
  d.quiet = d.compared > 0 && !d.changes.length;
  return d;
}

export interface WeekFig { n: number; text: string; level: Level | null } // level: coloured only for what needs you
/** The band's figures, every one non-zero; colour only on what broke, what is new and what ended. */
export function weekFigs(d: WeekDigest): WeekFig[] {
  const worst = d.changes.find((c) => c.facet === "security" && c.key !== "security:runtime" && c.level !== "ok")?.level;
  const fig = (n: number, one: string, many: string, level: Level | null = null): WeekFig[] => n ? [{ n, text: n === 1 ? one : many, level }] : [];
  return [
    ...fig(d.ciBroke, "workflow broke", "workflows broke", "bad"),
    ...fig(d.ciFixed, "workflow fixed", "workflows fixed"),
    ...fig(d.advNew, "new advisory", "new advisories", worst === "bad" || worst === "warn" ? worst : null),
    ...fig(d.advCleared, "advisory cleared", "advisories cleared"),
    ...fig(d.ended, "runtime reached end-of-life", "runtimes reached end-of-life", "bad"),
    ...fig(d.movedOff, "runtime moved off", "runtimes moved off"),
    ...fig(d.prsClosed, "update PR closed", "update PRs closed"),
    ...fig(d.prsOpened, "update PR opened", "update PRs opened"),
    ...fig(d.released, "release tagged", "releases tagged"),
  ];
}

/** The week in one line per facet, as the all-clear's row says it: "12 update PRs closed · 3 opened". */
export function weekSummary(d: WeekDigest): string[] {
  if (d.quiet) return [`no change in the ${plural(d.compared, "project")} compared`];
  const two = (a: number, aText: string, b: number, bWord: string, bText: string) =>
    a ? `${aText}${b ? ` · ${b} ${bWord}` : ""}` : b ? bText : "";
  return [
    two(d.ciBroke, `${plural(d.ciBroke, "workflow")} broke`, d.ciFixed, "fixed", `${plural(d.ciFixed, "workflow")} fixed`),
    two(d.advCleared, `${plural(d.advCleared, "advisory", "advisories")} cleared`, d.advNew, "new", `${d.advNew} new ${d.advNew === 1 ? "advisory" : "advisories"}`),
    d.ended ? `${plural(d.ended, "runtime")} reached end-of-life` : "",
    d.movedOff ? `${plural(d.movedOff, "runtime")} moved off` : "",
    two(d.prsClosed, `${plural(d.prsClosed, "update PR")} closed`, d.prsOpened, "opened", `${plural(d.prsOpened, "update PR")} opened`),
    d.released ? `${plural(d.released, "release")} tagged` : "",
  ].filter(Boolean);
}

/** The band's *Not compared* line and its tip: a source asked only on a click is named in the tip alone. */
export function weekNotCompared(d: WeekDigest, names: Readonly<Record<string, string>>): { line: string; tip: string[] } | null {
  const nameOf = (r: string) => names[r] ?? r, said = d.gaps.filter((g) => !g.click);
  const parts = [...FACETS, null].flatMap((f) => {
    const n = new Set(said.filter((g) => g.facet === f).flatMap((g) => g.roots).filter((r) => !d.behind.includes(r))).size;
    return !n ? [] : [f ? `${facetDef(f).label} in ${plural(n, "project")}` : `${plural(n, "project")} compared over another span`];
  });
  if (d.behind.length) parts.push(`${plural(d.behind.length, "project")} last checked earlier`);
  if (d.unmarked.length) parts.push(`${plural(d.unmarked.length, "project")} checked once so far`);
  if (d.unread.length) parts.push(`${plural(d.unread.length, "project")} not checked yet`);
  if (!parts.length && d.gaps.length) parts.push("checks that run only on a click");
  if (!parts.length) return null;
  const line = (head: string, roots: readonly string[]) => `${head[0].toUpperCase()}${head.slice(1)}: ${roots.map(nameOf).join(", ")}`;
  const tip = [...d.gaps.map((g) => line(g.facet ? `${facetDef(g.facet).label}: ${g.why}` : g.why, g.roots)),
    ...(d.unmarked.length ? [line("checked once so far", d.unmarked)] : []), ...(d.unread.length ? [line("not checked yet", d.unread)] : [])];
  return { line: `Not compared: ${parts.join(" · ")}`, tip };
}

// ---------- a maintenance session: ticked lines, one tiled agent each (docs/maintenance.md) ----------

/** Where a verb's agent works; a Record, so a new verb fails to compile until it is classified.
 *  `here`: it works on the repo's own branches or writes nothing, so a fix branch would be one more to tidy. */
export const VERB_KIND: Record<Verb, "branch" | "here" | null> = {
  fix: "branch",
  patch: "branch",
  rotate: "branch",
  upgrade: "branch",
  setup: "branch",
  release: "here",
  deploy: "here",
  push: "here",
  tidy: "here",
  review: null,
  fetch: null,
  run: null,
};
export const SESSION_MAX = 8; // one WebGL context per visible tile: terminal.ts's GL_POOL_MAX, held by a test
export const SESSION_EXTERNAL = "Agents open outside Episko (Settings › Launching), so there are no panes to tile";
export const SESSION_OVER = `${SESSION_MAX} at most at once: one tile each`;
const FIX_SLUG_MAX = 40;

export const sessionKey = (f: Pick<Finding, "root" | "key">) => `${f.root}\u0000${f.key}`;
export function parseSessionKey(k: string): { root: string; key: string } {
  const at = k.indexOf("\u0000");
  return { root: k.slice(0, at), key: k.slice(at + 1) };
}
/** A line an agent could take now. A snapshot's lines are not findings, so they never reach this. */
export const sessionPickable = (f: Pick<Finding, "verb" | "busy">) => VERB_KIND[f.verb] !== null && !f.busy;

/** The cards a chip shows, quiet ones behind the fold under All. The view and the selection read this one list. */
export function cardsShown<T extends { band: Band }>(cards: readonly T[], chip: Band | "all"): T[] {
  return cards.filter((c) => chip === "all" ? c.band !== "quiet" : c.band === chip);
}
/** ./pick's context: every line on a shown card in rank order. A quiet card is drawn compact, so it has none. */
export function sessionLines(cards: readonly { band: Band; findings: readonly Finding[] }[]): { order: string[]; pickable: Set<string> } {
  const lines = cards.filter((c) => c.band !== "quiet").flatMap((c) => c.findings);
  return { order: lines.map(sessionKey), pickable: new Set(lines.filter(sessionPickable).map(sessionKey)) };
}

/** What a fix branch is cut from: the git read's trunk, the release facet's (all maint_trunk's answer), then the file's. */
export function trunkOf(inp: MaintInput): string | null {
  for (const { facts } of [...okFacts(inp, "git"), ...okFacts(inp, "release")]) if ("trunk" in facts && facts.trunk) return facts.trunk;
  return inp.det?.config.trunk ?? null;
}
/** Stable per line, so a later session lands beside the earlier work: `prod:cert:api` is `maint/prod-cert-api`. */
export function fixBranch(f: Pick<Finding, "key">): string {
  const slug = f.key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, FIX_SLUG_MAX).replace(/-+$/, "");
  return `maint/${slug || "line"}`;
}

export interface SessionLine { f: Finding; inp: MaintInput }
/** `old`: a fix branch an earlier session left with no checkout. create_worktree checks it out as it stands and ignores the base. */
export type SessionWhere = DispatchWhere | { kind: "old"; branch: string; base: string };
export interface SessionRow { root: string; key: string; text: string; where: SessionWhere; branch: string | null; from: string }
/** `open`: an agent is already there, which is the one skip worth its own word. */
export interface SessionSkip { root: string; key: string; why: string; open: boolean }
export interface SessionPlan { rows: SessionRow[]; skipped: SessionSkip[]; over: number }
export interface SessionLaunch { root: string; project: string; where: SessionWhere; branch: string | null; text: string; what: string }
export interface SessionCtx {
  heads: (root: string) => WtHead[];
  plain: (root: string) => boolean; // known to be no repo, so there is no branch to cut
  earlier: (root: string, branch: string) => boolean; // that local branch exists, with or without a checkout
  busy: (path: string, root: string) => boolean; // an agent is at work in that checkout
  name: (root: string) => string;
  now: number;
}

// Maintenance never fetches, so a base is as old as the last fetch and says so; no fetch on record is not a fresh one.
function sessionFrom(inp: MaintInput, base: string, name: string, now: number): string {
  if (!base) return `what ${name} has checked out`;
  const at = lastFetch(inp)?.at;
  if (at === undefined) return `${base}, last fetch unknown`;
  const age = now / 1000 - at;
  return age > clampMaint(inp.det?.config.thresholds).fetchStaleDays * DAY ? `${base}, as of the last fetch ${span(age)} ago` : base;
}

/** What Start would make of the ticked lines, in ticked order. Nothing here runs; ./actions cuts the worktrees. */
export function sessionPlan(picked: readonly SessionLine[], ctx: SessionCtx): SessionPlan {
  const rows: SessionRow[] = [], skipped: SessionSkip[] = [], taken = new Set<string>();
  for (const { f, inp } of picked) {
    const { root, key, text } = f, name = ctx.name(root);
    const skip = (why: string, open = false) => skipped.push({ root, key, why: `${name}: ${why}`, open });
    const kind = VERB_KIND[f.verb];
    if (!kind) { skip("no agent answers this line"); continue; }
    if (kind === "here" || ctx.plain(root)) { rows.push({ root, key, text, where: { kind: "here" }, branch: null, from: "" }); continue; }
    const branch = fixBranch(f), heads = ctx.heads(root), one = `${root}\u0000${branch}`;
    if (taken.has(one)) { skip(`another ticked line lands on ${branch}`); continue; }
    taken.add(one);
    const on = heads.find((h) => h.exists && h.branch === branch);
    if (on) {
      if (ctx.busy(on.path, root)) skip(`an agent already works on ${branch}`, true);
      else rows.push({ root, key, text, where: on.is_main ? { kind: "here" } : { kind: "wt", path: on.path }, branch, from: "" });
      continue;
    }
    // git refuses a branch whose registered folder was deleted by hand, until that is pruned.
    if (heads.some((h) => h.branch === branch)) { skip(`${branch}'s folder is gone and git still lists it: run \`git worktree prune\``); continue; }
    const base = trunkOf(inp) ?? "";
    const problem = whereProblem({ kind: "new", branch, base }, heads)
      ?? (worktreeDirLen(root, branch) > SLUG_MAX ? "this folder's path is too long for Claude to file the conversation under" : null);
    if (problem) skip(problem);
    else if (ctx.earlier(root, branch)) rows.push({ root, key, text, where: { kind: "old", branch, base }, branch, from: "" });
    else rows.push({ root, key, text, where: { kind: "new", branch, base }, branch, from: sessionFrom(inp, base, name, ctx.now) });
  }
  return { rows: rows.slice(0, SESSION_MAX), skipped, over: Math.max(0, rows.length - SESSION_MAX) };
}

/** Why Start cannot run as ticked; a person unticks what is named, so nothing is dropped behind their back. */
export function sessionGate(plan: SessionPlan, embedded: boolean): string | null {
  if (!embedded) return SESSION_EXTERNAL;
  if (plan.over) return SESSION_OVER;
  return plan.skipped[0]?.why ?? null;
}
/** A sweep has no ticks to untick: what cannot start is left out and named, and only nothing left refuses. */
export function sweepGate(plan: SessionPlan, embedded: boolean): string | null {
  return embedded && !plan.over && plan.rows.length ? null : sessionGate(plan, embedded);
}
/** What a launch left out, for the toast it ends on. */
export function sessionLeft(plan: SessionPlan): string[] {
  const [first, ...rest] = plan.skipped;
  return first ? [`${first.why}${rest.length ? ` and ${rest.length} more` : ""}`] : [];
}
/** What the ticks will become, said before the click rather than asked after it. `hidden`: ticks the chip is not showing. */
export function sessionText(plan: SessionPlan, hidden = 0): string {
  const of = (...k: SessionWhere["kind"][]) => plan.rows.filter((r) => k.includes(r.where.kind)).length;
  const fresh = of("new"), again = of("wt", "old"), here = of("here"), open = plan.skipped.filter((s) => s.open).length;
  const stuck = plan.skipped.length - open;
  return [
    hidden && `${hidden} behind this filter`,
    fresh && (fresh === 1 ? "1 on a new fix branch" : `${fresh} on new fix branches`),
    again && (again === 1 ? "1 on its earlier fix branch" : `${again} on their earlier fix branches`),
    here && (here === 1 ? "1 in its project's folder" : `${here} in their projects' folders`),
    open && `${open} already open`,
    stuck && `${stuck} can't start`,
  ].filter(Boolean).join(" · ");
}
/** One line per row, naming where it lands. */
export function sessionTip(plan: SessionPlan, name: (root: string) => string): string {
  const dest = (r: SessionRow) => r.where.kind === "new" ? `${r.where.branch} from ${r.from}`
    : r.where.kind === "wt" ? `${r.branch}, its earlier checkout` : r.where.kind === "old" ? `${r.branch}, its earlier branch`
    : r.branch ? `${r.branch}, in its folder` : "in its folder";
  return [...plan.rows.map((r) => `${name(r.root)} · ${r.text} → ${dest(r)}`), ...plan.skipped.map((s) => s.why)].join("\n");
}
/** The toast a session ends on: what started, the first thing that did not, and what was noted before it began. */
export function sessionDone(started: number, total: number, fails: readonly string[], notes: readonly string[] = []): string {
  const head = started !== total ? `Started ${started} of ${total}${fails.length ? ` · ${fails[0]}` : ""}`
    : total === 1 ? "Started 1 agent, prefilled. Read it, then press Enter" : `Started ${total} agents, each prefilled. Read each, then press Enter`;
  return [head, ...notes].join(" · ");
}
/** A sweep's affected project as a line, so it obeys every rule a ticked line does: `maint/<advisory id>`. */
export const sweepLine = (adv: SweepAdvisory, root: string): Finding => ({
  root, facet: "security", key: adv.id ?? adv.packages[0]?.name ?? "sweep", level: "bad", text: sweepTitle(adv), detail: "", verb: "patch", source: "", ref: "dependency",
});

// ---------- the advisory sweep (maint_sweep.rs; docs/maintenance.md § Advisory sweep) ----------
// Rust resolves the advisory and reads what each project installs; whether that is affected is decided
// here with ./deps' narrow semver, and a shape it cannot read is unsure, never a guess either way.

export interface SweepSpan { kind: string; introduced: string | null; fixed: string | null; lastAffected: string | null }
/** One affected package: its runs from the record, or `range` as a person typed it. */
export interface SweepPkg {
  ecosystem: string; name: string; spans: SweepSpan[]; range: string | null;
  versions: string[]; versionsCut: boolean; // cut: a version missing from the list proves nothing
}
export interface SweepAdvisory {
  id: string | null; aliases: string[]; summary: string; severity: Severity; rawSeverity: string; url: string | null;
  packages: SweepPkg[]; asked: string[]; gaps: string[];
}
export interface SweepCopy { pkg: number; version: string; file: string } // pkg: an index into `packages`
export interface SweepUnread { file: string; ecosystem: string; reason: string }
export interface SweepFacts { root: string; locks: string[]; found: SweepCopy[]; unpinned: SweepCopy[]; unread: SweepUnread[] }
export const SWEEP_CHECKS = ["affected", "not-affected", "unsure"] as const;
export interface SweepCheck { verdict: (typeof SWEEP_CHECKS)[number]; evidence: string[] }
/** A read-only agent asked about one unsure project: its answer is shown beside the row, never applied. */
export type SweepAgent = { state: "running" } | { state: "done"; check: SweepCheck } | { state: "error"; err: string };
export type SweepState = "resolving" | "matching" | "done" | "error";

const isSpan = shape({ kind: str, introduced: opt(str), fixed: opt(str), lastAffected: opt(str) });
const isSweepPkg = shape({ ecosystem: str, name: str, spans: list(isSpan), versions: list(str), versionsCut: bool, range: opt(str) });
const isSweepAdv = shape({
  id: opt(str), aliases: list(str), summary: str, severity: oneOf(SEVERITIES), rawSeverity: str, url: opt(str),
  packages: list(isSweepPkg), asked: list(str), gaps: list(str),
});
const isCopy = shape({ pkg: num, version: str, file: str });
const isSweepFacts = shape({
  root: str, locks: list(str), found: list(isCopy), unpinned: list(isCopy), unread: list(shape({ file: str, ecosystem: str, reason: str })),
});
export const narrowSweep = (raw: unknown): SweepAdvisory | null => isSweepAdv(raw) ? raw as SweepAdvisory : null;
export const narrowSweepFacts = (raw: unknown): SweepFacts[] => Array.isArray(raw) ? raw.filter(isSweepFacts) as SweepFacts[] : [];
export const narrowSweepCheck = (raw: unknown): SweepCheck | null =>
  shape({ verdict: oneOf(SWEEP_CHECKS), evidence: list(str) })(raw) ? raw as SweepCheck : null;

/** One run as a range `satisfies` reads; null for a commit range, in which no version can be placed. */
export function spanRange(s: SweepSpan): string | null {
  if (s.kind.toUpperCase() === "GIT") return null;
  const lo = s.introduced && s.introduced !== "0" ? `>=${s.introduced}` : "";
  const hi = s.fixed ? `<${s.fixed}` : s.lastAffected ? `<=${s.lastAffected}` : "";
  return [lo, hi].filter(Boolean).join(" ") || "*";
}

/** What the advisory says of one package, as a person reads it. */
export function affectedText(p: SweepPkg): string {
  if (p.range !== null) return `${p.ecosystem} ${p.name} ${p.range}`;
  const runs = p.spans.map((s) => spanRange(s) ?? "a commit range");
  const fixed = [...new Set(p.spans.flatMap((s) => s.fixed && spanRange(s) ? [s.fixed] : []))];
  const what = runs.length ? runs.join(" || ") : p.versions.length ? plural(p.versions.length, "listed version") : "no range";
  return `${p.ecosystem} ${p.name} ${what}${fixed.length ? `, fixed in ${fixed.join(", ")}` : ""}`;
}

export type Placed = { state: "in"; range: string; fixed: string | null } | { state: "out"; past: string | null } | { state: "unknown"; why: string };
const fixAbove = (p: SweepPkg, v: string) => p.spans.flatMap((s) => s.fixed && verCmpStr(s.fixed, v) > 0 ? [s.fixed] : []).sort(verCmpStr)[0] ?? null;

/** Where one installed version stands against one package's runs; `past` is the newest fix it is at or beyond. */
export function placeVersion(p: SweepPkg, version: string): Placed {
  if (p.versions.includes(version)) return { state: "in", range: "a listed version", fixed: fixAbove(p, version) };
  if (!parseVer(version)) return { state: "unknown", why: `${version} is not a version this can compare` };
  const runs: { r: string | null; fixed: string | null }[] = p.range !== null ? [{ r: p.range, fixed: null }]
    : p.spans.map((s) => ({ r: spanRange(s), fixed: s.fixed }));
  let why: string | null = runs.length || p.versions.length ? null : "the advisory names no version range";
  for (const { r, fixed } of runs) {
    if (r === null) { why = "its range is a commit range, which names no version"; continue; }
    const held = satisfies(version, r, p.ecosystem);
    if (held === null) { why = `${r} is a range shape this does not read`; continue; }
    if (held) return { state: "in", range: r, fixed };
  }
  if (why) return { state: "unknown", why };
  if (!runs.length && p.versionsCut) return { state: "unknown", why: `${version} is not among the listed versions, and the list was cut short` };
  const past = p.spans.flatMap((s) => s.fixed && verCmpStr(version, s.fixed) >= 0 ? [s.fixed] : []).sort(verCmpStr).pop() ?? null;
  return { state: "out", past };
}

export type SweepVerdict = "affected" | "unsure" | "patched" | "unused";
export const SWEEP_VERDICTS: readonly SweepVerdict[] = ["affected", "unsure", "patched", "unused"];
export interface SweepRow {
  root: string; verdict: SweepVerdict;
  word: string; // a copy past its fix is "patched", one never in range "not in range"
  evidence: string[]; // a line per copy, and per file that might hold one and was not read
  fix: string | null; // affected only
}

/** One project: affected if any copy is in a range, else unsure if anything could not be placed or read. */
export function sweepVerdict(adv: SweepAdvisory, f: SweepFacts): SweepRow {
  const row = (verdict: SweepVerdict, word: string, evidence: string[], fix: string | null = null): SweepRow =>
    ({ root: f.root, verdict, word, evidence, fix });
  if (!adv.packages.length) return row("unsure", "unsure", [adv.gaps[adv.gaps.length - 1] ?? "the advisory names no package to match"]);
  const hit: string[] = [], unsure: string[] = [], clear: string[] = [], fixes = new Set<string>();
  let past = 0;
  for (const c of f.found) {
    const p = adv.packages[c.pkg];
    if (!p) continue;
    const at = placeVersion(p, c.version), where = `${c.file}: ${p.name}@${c.version}`;
    if (at.state === "in") { hit.push(`${where} · in ${at.range}`); if (at.fixed) fixes.add(at.fixed); }
    else if (at.state === "unknown") unsure.push(`${where} · ${at.why}`);
    else { clear.push(`${where} · ${at.past ? `at or past the fix, ${at.past}` : "outside every affected range"}`); past += at.past ? 1 : 0; }
  }
  for (const c of f.unpinned) unsure.push(`${c.file}: ${adv.packages[c.pkg]?.name ?? "?"} from ${c.version}, not the registry's copy, so its version proves nothing`);
  const ecos = new Set(adv.packages.map((p) => p.ecosystem));
  for (const u of f.unread) if (ecos.has(u.ecosystem)) unsure.push(`${u.file}: ${u.reason}`);
  if (hit.length) {
    const typed = adv.packages.find((p) => p.range !== null)?.range;
    const fix = fixes.size ? `bump → ${[...fixes].sort(verCmpStr).join(", ")}` : typed ? `a version outside ${typed}` : "no fix published";
    return row("affected", "affected", [...hit, ...unsure], fix);
  }
  if (unsure.length) return row("unsure", "unsure", [...unsure, ...clear]);
  if (clear.length) return row("patched", past === clear.length ? "patched" : "not in range", clear);
  const names = [...new Set(adv.packages.map((p) => p.name))];
  const none = `no ${names.slice(0, 3).join(", ")}${names.length > 3 ? " …" : ""}`;
  const ecoList = [...ecos].join(" or ");
  return row("unused", "not using", [f.locks.length ? `${f.locks.join(", ")}: ${none}` : `no ${ecoList} manifest or lockfile`]);
}

/** A row per root asked, worst first, then by path so a repaint never reorders. A root the read
 *  answered nothing for is unsure, never missing: a missing row would read as an all-clear. */
export const sweepRows = (adv: SweepAdvisory, facts: readonly SweepFacts[], roots: readonly string[]): SweepRow[] =>
  [...new Set(roots)].map((root) => {
    const f = facts.find((x) => x.root === root);
    return f ? sweepVerdict(adv, f) : { root, verdict: "unsure" as const, word: "unsure", evidence: ["its lockfiles were not read"], fix: null };
  }).sort((a, b) => SWEEP_VERDICTS.indexOf(a.verdict) - SWEEP_VERDICTS.indexOf(b.verdict) || a.root.localeCompare(b.root));

/** The advisory as one line: its id and first aliases, or the package and range typed. */
export const sweepTitle = (adv: SweepAdvisory): string =>
  adv.id ? `${adv.id}${adv.aliases.length ? ` (${adv.aliases.slice(0, 3).join(", ")})` : ""}` : adv.summary;

/** *Copy report*: the advisory, a line per project that uses it worst first, and the rest named once. */
export function sweepReport(adv: SweepAdvisory, rows: readonly SweepRow[], names: Readonly<Record<string, string>>,
  agents: Readonly<Record<string, SweepAgent>> = {}): string {
  const name = (r: string) => names[r] ?? r;
  const unused = rows.filter((r) => r.verdict === "unused");
  const lines = rows.filter((r) => r.verdict !== "unused").flatMap((r) => {
    const a = agents[r.root];
    return [
      `- ${name(r.root)}: ${r.word}${r.fix ? ` · ${r.fix}` : ""}`, ...r.evidence.map((e) => `    ${e}`),
      ...(a?.state === "done" ? [`    an agent read it: ${a.check.verdict}`, ...a.check.evidence.map((e) => `      ${e}`)] : []),
    ];
  });
  return [
    `Advisory sweep: ${sweepTitle(adv)}${adv.severity === "unknown" ? "" : ` · ${adv.severity}`}`,
    ...(adv.id && adv.summary ? [adv.summary] : []), ...(adv.url ? [adv.url] : []),
    ...adv.packages.map((p) => `affects ${affectedText(p)}`), ...adv.gaps,
    "",
    ...(lines.length ? lines : ["No project uses it."]),
    ...(unused.length ? ["", `Not using it (${unused.length}): ${unused.map((r) => name(r.root)).join(", ")}`] : []),
  ].join("\n");
}
