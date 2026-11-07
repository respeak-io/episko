import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADVISORY_KINDS, BOARD_IDS, CI_STATUSES, rtName, CI_STRIP, COV_STATES, FACET_TAB, FACT_FACET, FACT_KINDS, MAINT_DEFAULTS, MAINT_TABS, SEVERITIES,
  SNAP_FINDINGS, SNAP_KEY, SNAP_ROOTS, SNAP_TEXT, clampKept, packKept, ciFailures, findingTarget, projectPicks, ciFlows, ciRows, clampMaint, clampSnaps, pastCells, snapFor, takeSnap, comingUp, coverFirst, coverGroups, coverRows, facetCell, facetCells, findings, forgeText, hostRows, hygieneOf, mergeAdvisories, narrowDetection,
  advisoryRows, bySev, ciBoard, hygieneBoard, probeBoard, releaseBoard, sevStrip, tabBoards, updatePrRows, workBoard,
  narrowMaint, needsCount, offers, probeRows, prodChecks, projectBand, rankMaint, settingsUrl, span, tabExtras, tabFindings, tabGaps, tabModel, tabRows, tabTally, whyWord,
  advFix, outdatedText, BOARD_COLS, boardDoor, doorAt, peekNames, coverSetups, setupKeyOf, SETUP_KEYS, eolBoard, longSpan, runtimeStates,
  affectedText, narrowSweep, narrowSweepCheck, narrowSweepFacts, placeVersion, spanRange, sweepReport, sweepRows, sweepTitle, sweepVerdict, SWEEP_VERDICTS,
  worseOf, type Judged, flakyBoard, flakyJobs, type RerunJob,
  deployBoard, deployStates, envsFailed, envsToShip, DEPLOY_STATES, ENV_TIERS, type Deployed,
  cardsShown, fixBranch, parseSessionKey, SESSION_EXTERNAL, SESSION_MAX, SESSION_OVER, sessionDone, sessionGate, sessionKey, sessionLeft, sessionLines, sessionPickable, sessionPlan, sessionText, sessionTip, sweepGate, sweepLine, trunkOf, VERB_KIND,
  type Band, type SessionCtx, type SessionLine, type SessionPlan, type Verb,
  addMark, clampWeek, leavesMark, packWeek, takeMark, weekDigest, weekFigs, weekNotCompared, weekPair, weekSummary, WEEK_MARKS, WEEK_ROOTS, WEEK_ROWS, WEEK_TEXT,
  type MarkAdv, type MarkRel, type MarkRt, type WeekMark, type WeekPairIn,
  addCoverCaps, onClickOnly, sessionKind, currentHosts, diskPct, HOST_KINDS, hostBoard, hostRead, hostSkips, hostState, hostSummary, prodNone, prodTip, readsHost, upSpan, type HostFacts,
  majorsBehind, majorsText, packagesBoard, pkgStates, unplacedWhy, type PkgLatest,
  currentDomains, domainStates, type Domain,
  currentErrors, errorStates, errorSummary, ERR_LEVELS, ERR_TRENDS, KEPT_BACKLOG, KEPT_CUT, tokenDoor, type ErrIssue,
  type Advisory, type Runtime, type BoardId, type Coverage, type Detection, type Door, type Facts, type Finding, type MaintInput, type SourceReport, type TabProject,
  type SweepAdvisory, type SweepFacts, type SweepPkg,
} from "../src/maint";
import { BRANCH_FILTERS } from "../src/branches";
import { whereProblem } from "../src/claim";
import type { WtHead } from "../src/types";
import { fmtDay } from "../src/format";
import { briefFor } from "../src/maintbrief";
import { FACETS, SOURCES, type Facet, type MaintCap } from "../src/maintsources";

// Unknown is never green: every rule here that fails, fails by drawing a healthy dot over a fact
// nobody read. The wire half is pinned by the fixture maint.rs writes (wire_fixture_is_current).

const wire = JSON.parse(readFileSync(new URL("./fixtures/maint-wire.json", import.meta.url), "utf8")) as {
  detection: unknown; reports: Record<string, unknown>[];
};

const NOW = 1_790_000_000_000, S = NOW / 1000, H = 3600, D = 86_400;
const GHA = "github-actions"; // a source that sees ci.failing-since

const det = (sources: string[], o: Partial<Detection> = {}): Detection => ({
  repoRoot: "/r", forge: { kind: "unknown", host: null, path: null, by: "none" }, sources, markers: [],
  config: { readable: true, forge: null, off: [], sources: {}, bots: [], trunk: null, tagPattern: null, sarif: [], params: {}, thresholds: {} },
  deploy: null,
  ...o,
});
const ok = (source: string, facts: Facts, o: Partial<SourceReport> = {}): SourceReport => ({
  source, facet: FACT_FACET[facts.kind], cost: "forge", coverage: { state: "ok" }, at: S, truncated: false, gaps: [], facts, ...o,
});
const not = (source: string, facet: Facet, coverage: Coverage): SourceReport => ({
  source, facet, cost: "forge", coverage, at: null, truncated: false, gaps: [], facts: null,
});
const input = (...reps: SourceReport[]): MaintInput =>
  ({ det: det(reps.map((r) => r.source)), reports: Object.fromEntries(reps.map((r) => [r.source, r])) });

const run = (workflow: string, status: (typeof CI_STATUSES)[number], at: number, sha = "abcdef1234") =>
  ({ workflow, status, raw: status as string, sha, at, url: `https://ci.example/${workflow}/${at}` });
const ci = (...runs: ReturnType<typeof run>[]): Facts => ({ kind: "ciRuns", branch: "main", runs });
const adv = (o: Partial<Advisory> = {}): Advisory => ({
  id: "A-1", aliases: [], kind: "dependency", pkg: "lodash", ecosystem: "npm", version: "4.17.20", severity: "high",
  rawSeverity: "HIGH", summary: "Prototype pollution", fixed: "4.17.21", location: "package-lock.json",
  url: "https://adv.example/A-1", tool: "t1", ...o,
});
const rel = (o: Partial<Extract<Facts, { kind: "release" }>> = {}): Facts => ({
  kind: "release", trunk: "origin/main", tag: "v1.0", tagAt: S - 2 * D, since: 0, oldestUnreleasedAt: null, tagsSeen: 1, fetchedAt: S - H, ...o,
});
const hyg = (o: Partial<Extract<Facts, { kind: "hygiene" }>> = {}): Facts => ({
  kind: "hygiene", trunk: "origin/main", unpushed: 0, localOnly: [], merged: [], gone: [], branches: [], worktrees: [], fetchedAt: S - H, ...o,
});
const prs = (n: number, o: Partial<Extract<Facts, { kind: "updatePrs" }>> = {}, checks: (typeof CI_STATUSES)[number] = "pass"): Facts => ({
  kind: "updatePrs", bot: "b", configured: true, dashboard: null,
  prs: Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Update p${i}`, url: `u${i}`, branch: `b/p${i}`, draft: false, at: S - D, checks })),
  ...o,
});
// A direct dependency as a registry source reports one; `reg` the report, `current` the ones at their newest.
const pkg = (name: string, installed: string[], latest: string | null, o: Partial<PkgLatest> = {}): PkgLatest =>
  ({ name, ecosystem: "npm", importers: ["."], installed, latest, dev: false, url: latest ? `https://reg.example/${name}` : null, why: null, ...o });
const reg = (items: PkgLatest[], current = 0, o: Partial<SourceReport> = {}): SourceReport =>
  ({ ...ok("npm-registry", { kind: "packages", items, current }, o), cost: "public" });
const cell = (f: Facet, inp: MaintInput) => facetCell(f, inp, MAINT_DEFAULTS, NOW);

describe("the wire", () => {
  it("narrowMaint accepts every report the backend writes, unchanged", () => {
    for (const r of wire.reports) expect(narrowMaint(r, r.source as string)).toEqual(r);
  });

  it("knows every coverage state and fact kind, and the fixture covers them all", () => {
    const states = new Set(wire.reports.map((r) => (r.coverage as { state: string }).state));
    const kinds = new Set(wire.reports.flatMap((r) => r.facts ? [(r.facts as { kind: string }).kind] : []));
    expect([...states].sort()).toEqual([...COV_STATES].sort());
    expect([...kinds].sort()).toEqual([...FACT_KINDS].sort());
    const facts = wire.reports.map((r) => r.facts as Facts | null);
    for (const f of facts) {
      if (f?.kind === "ciRuns") for (const x of f.runs) expect(CI_STATUSES).toContain(x.status);
      if (f?.kind === "advisories") for (const x of f.items) { expect(SEVERITIES).toContain(x.severity); expect(ADVISORY_KINDS).toContain(x.kind); }
      if (f?.kind === "updatePrs") for (const x of f.prs) expect(CI_STATUSES).toContain(x.checks);
    }
  });

  it("narrowDetection accepts the backend's detection", () => {
    expect(narrowDetection(wire.detection)).toEqual(wire.detection);
    expect(narrowDetection(null)).toBeNull();
    expect(narrowDetection({ repoRoot: "/r" })).toBeNull();
  });

  it("turns a report of the wrong shape into an error for that source alone", () => {
    const good = wire.reports[0];
    const bad = (r: unknown, src = "github-actions") => narrowMaint(r, src).coverage.state;
    expect(bad(null)).toBe("error");
    expect(bad(good, "osv")).toBe("error");
    expect(bad({ ...good, coverage: { state: "fine" } })).toBe("error");
    expect(bad({ ...good, coverage: { state: "noAccess", reason: 3 } })).toBe("error");
    expect(bad({ ...good, facts: null })).toBe("error");
    expect(bad({ ...good, facts: { kind: "ciRuns", branch: "main", runs: "lots" } })).toBe("error");
    expect(bad({ ...good, facts: { kind: "work", issues: 1, prs: 0, reviewRequested: 0 } }), "facts outside the facet").toBe("error");
    expect(narrowMaint({ ...good, facts: null }, "github-actions")).toMatchObject({ facet: "ci", cost: "forge", facts: null });
    const off = narrowMaint({ ...good, coverage: { state: "notRun" } }, "github-actions");
    expect(off.facts, "only ok carries facts").toBeNull();
  });

  it("files a broken report this build cannot place under the facet it claimed, and its cell cannot check", () => {
    const future = narrowMaint({ ...wire.reports[0], source: "future-src", facet: "ci", coverage: { state: "fine" } }, "future-src");
    expect(future).toMatchObject({ source: "future-src", facet: "ci", cost: null, coverage: { state: "error" } });
    expect(facetCell("ci", input(future), MAINT_DEFAULTS, NOW)).toMatchObject({ state: "cantCheck", text: "read failed" });
  });
});

describe("clampMaint", () => {
  it("reads the file's spelling over the defaults and refuses a zero", () => {
    expect(clampMaint(undefined)).toEqual(MAINT_DEFAULTS);
    expect(clampMaint({ stale_branch_days: 0, unreleased_days: -1, cert_warn_days: "9" })).toEqual(MAINT_DEFAULTS);
    expect(clampMaint({ stale_branch_days: 6, cert_warn_days: 10 })).toMatchObject({ staleBranchDays: 6, certWarnDays: 10 });
    expect(clampMaint(narrowDetection(wire.detection)!.config.thresholds).staleBranchDays).toBe(24);
    expect(clampMaint({ deploy_behind_commits: 5, deploy_behind_days: 2, deploy_idle_days: 30 })).toMatchObject({ deployBehindCommits: 5, deployBehindDays: 2, deployIdleDays: 30 });
    expect(clampMaint({ deploy_behind_commits: 0, deploy_behind_days: 0, deploy_idle_days: -1 })).toEqual(MAINT_DEFAULTS);
    expect(MAINT_DEFAULTS).toMatchObject({ deployBehindCommits: 20, deployBehindDays: 14, deployIdleDays: 180 });
  });
});

describe("facetCell: unknown is never green", () => {
  const states: Coverage[] = [
    { state: "off", reason: "disabled" },
    { state: "noAccess", reason: "token lacks a scope", fix: "gh auth refresh" },
    { state: "noTool", tool: "auditor", fix: "install auditor" },
    { state: "unsupported", reason: "no default branch known" },
    { state: "notRun" },
    { state: "error", reason: "HTTP 502" },
  ];

  // Each state's word, `states` in order; off is "alerts off" on Security alone.
  const words = ["switched off", "token scope", "tool missing", "unavailable", "not checked", "read failed"];

  it("draws no grey dot for any coverage but ok, alone or together, in any facet", () => {
    expect(states.map((s) => s.state).sort()).toEqual(COV_STATES.filter((s) => s !== "ok").sort());
    for (const f of FACETS) {
      for (const [i, s] of states.entries()) {
        const c = cell(f, input(not("x", f, s)));
        expect(c.level, `${f} ${s.state}`).not.toBe("ok");
        // Never a bare "can't check": the coverage says why, in the cell's own few words.
        expect(c).toMatchObject({ state: "cantCheck", text: f === "security" && !i ? "alerts off" : words[i] });
        expect(c.text).not.toMatch(/can't check/);
      }
      expect(cell(f, input(...states.map((s, i) => not(`x${i}`, f, s)))).level).toBe("muted");
    }
  });

  it("reads Rust's own coverages, not hand-written ones, so a reworded fix fails here", () => {
    const of = (source: string, state: string) => wire.reports.find((r) => r.source === source && (r.coverage as Coverage).state === state)!.coverage as Coverage;
    expect(whyWord(of("dependabot-alerts", "noAccess"), "security")).toBe("token scope");
    expect(whyWord(of("github-work", "noTool"), "work")).toBe("signed out");
    expect(whyWord(of("gitlab-work", "noTool"), "work")).toBe("signed out");
    expect(whyWord(of("gitlab-ci", "noAccess"), "ci")).toBe("no access");
    expect(whyWord(of("cargo-audit", "noTool"), "security")).toBe("tool missing");
  });

  it("puts the coverage that carries a fix first in the tip", () => {
    const c = cell("security", input(not("a", "security", states[4]), not("b", "security", states[2]), not("c", "security", states[1])));
    expect(c.tip[0]).toMatch(/^c: no access/);
    expect(c.fix).toBe("gh auth refresh");
  });

  it("names the reason in a word, the most actionable coverage when several fail differently", () => {
    const why = (c: Coverage, f: Facet = "security") => whyWord(c, f);
    expect(why({ state: "off", reason: "Dependabot alerts are switched off" })).toBe("alerts off");
    expect(why({ state: "off", reason: "x" }, "ci")).toBe("switched off");
    expect(why({ state: "noAccess", reason: "gh's token cannot read security alerts", fix: "gh auth refresh -h github.com -s security_events" })).toBe("token scope");
    expect(why({ state: "noAccess", reason: "acme/app is not visible to bob", fix: "pick the account" })).toBe("no access");
    expect(why({ state: "noTool", tool: "gh", fix: "gh auth login" })).toBe("signed out");
    expect(why({ state: "noTool", tool: "cargo-audit", fix: "cargo install cargo-audit --locked" })).toBe("tool missing");
    expect(why({ state: "unsupported", reason: "needs Advanced Security" })).toBe("unavailable");
    expect(why({ state: "notRun" })).toBe("not checked");
    expect(why({ state: "error", reason: "HTTP 502" })).toBe("read failed");
    // Off outranks unsupported and a never-run click, so the switch somebody can flip names the cell.
    const mixed = cell("security", input(not("a", "security", states[4]), not("b", "security", states[3]), not("c", "security", states[0])));
    expect(mixed).toMatchObject({ state: "cantCheck", level: "muted", text: "alerts off" });
    expect(mixed.tip, "the tip lists them all").toEqual(["c: off: disabled", "b: no default branch known", "a: never run"]);
    expect(cell("security", input(not("a", "security", states[0]), not("b", "security", states[1]))).text, "a fix outranks a switch").toBe("token scope");
    expect(cell("security", input(not("a", "security", states[4]), not("b", "security", states[4]))).text, "only clicks left").toBe("not checked");
    expect(coverFirst(mixed)).toBe(true);
    const marked = { det: det([], { markers: [{ facet: "ci" as const, label: "Woodpecker", found: [".woodpecker.yml"] }] }), reports: {} };
    expect(coverFirst(cell("ci", marked)), "a marker's answer is Coverage too").toBe(true);
    expect(coverFirst(cell("security", input(ok("a", { kind: "advisories", items: [] }), not("b", "security", states[0])))), "a verdict opens its card").toBe(false);
  });

  it("walks the ladder top-down: off, unread, none, markers", () => {
    const off = { ...input(ok("g", hyg())), det: det(["g"], { config: { ...det([]).config, off: ["git"] } }) };
    expect(cell("git", off)).toMatchObject({ state: "off", level: "muted", text: "not tracked" });
    expect(cell("git", { det: null, reports: {} })).toMatchObject({ state: "unread", level: "unread" });
    expect(cell("git", { det: det(["git-local"]), reports: {} }), "a read still out").toMatchObject({ state: "unread" });
    expect(cell("ci", input())).toMatchObject({ state: "none", level: "muted", text: "no CI" });
    expect(cell("deps", input()).text).toBe("no update bot");
    const marked = { ...input(), det: det([], { markers: [{ facet: "ci", label: "Woodpecker", found: [".woodpecker.yml"] }] }) };
    expect(cell("ci", marked)).toMatchObject({ state: "markers", level: "muted", text: "can't check (Woodpecker)" });
    expect(cell("ci", marked).tip.join()).toContain(".woodpecker.yml");
  });

  it("says a source this machine skips cannot be checked, never that there is none", () => {
    const inp = { ...input(ok("g", hyg())), skip: ["g"] };
    expect(cell("git", inp)).toMatchObject({ state: "cantCheck", text: "skipped here" });
    expect(cell("git", inp).tip.join()).toContain("skipped on this machine");
  });

  it("states partial coverage rather than hiding it", () => {
    const c = cell("security", input(ok("a", { kind: "advisories", items: [] }), not("b", "security", { state: "notRun" })));
    expect(c).toMatchObject({ state: "read", level: "ok", text: "" });
    expect(c.tip).toContain("b: never run");
  });

  it("says when the file that configures it could not be read", () => {
    const inp = input(ok("g", hyg()));
    inp.det!.config.readable = false;
    expect(cell("git", inp).tip[0]).toMatch(/unreadable/);
  });
});

describe("facet rules over ok facts", () => {
  it("CI with zero runs never ran; skips alone are no pass", () => {
    expect(cell("ci", input(ok(GHA, ci())))).toMatchObject({ level: "muted", text: "never ran" });
    expect(cell("ci", input(ok(GHA, ci(run("w", "skip", S - H)))))).toMatchObject({ level: "muted", text: "no passing run" });
    expect(cell("ci", input(ok(GHA, ci(run("w", "pass", S - H)))))).toMatchObject({ level: "ok", text: "" });
    expect(cell("ci", input(ok(GHA, ci(run("w", "running", S), run("w", "pass", S - H)))))).toMatchObject({ level: "info", text: "running" });
    const gated = cell("ci", input(ok(GHA, ci({ ...run("pipeline", "neutral", S), raw: "manual" }))));
    expect(gated).toMatchObject({ level: "muted", text: "no passing run", tip: ["pipeline: neutral (manual)"] });
  });

  it("CI is only healthy when every workflow's newest run passed or skipped", () => {
    const mixed = (...more: ReturnType<typeof run>[]) => cell("ci", input(ok(GHA, ci(run("test", "pass", S - H), ...more))));
    expect(mixed(run("lint", "skip", S - H))).toMatchObject({ level: "ok", text: "" });
    expect(mixed(run("deploy", "cancelled", S - H))).toMatchObject({ level: "muted", text: "1 cancelled" });
    expect(mixed(run("deploy", "unknown", S - H), run("docs", "neutral", S - H))).toMatchObject({ level: "muted", text: "2 not passing" });
  });

  it("CI failing is dated from the first red of the unbroken run, and broken however young", () => {
    const c = cell("ci", input(ok(GHA, ci(run("w", "fail", S - H), run("w", "fail", S - 2 * D), run("w", "pass", S - 3 * D), run("v", "pass", S)))));
    expect(c).toMatchObject({ level: "bad", text: "failing 2d" });
    expect(cell("ci", input(ok(GHA, ci(run("w", "fail", S - 4 * H)))))).toMatchObject({ level: "bad", text: "failing 4h" });
  });

  it("a streak that runs off a capped page is a floor, and only that one", () => {
    const capped = (...runs: ReturnType<typeof run>[]) => cell("ci", input(ok(GHA, ci(...runs), { truncated: true })));
    expect(capped(run("w", "fail", S - H), run("w", "fail", S - 3 * D))).toMatchObject({ text: "failing 3d+" });
    expect(capped(run("w", "fail", S - 3 * D), run("w", "pass", S - 4 * D)).text).toBe("failing 3d");
  });

  it("a source blind to failing-since never dates the red or names a first red commit", () => {
    const c = cell("ci", input(ok("forge-commit-status", ci(run("ci/jenkins", "fail", S - 2 * D)))));
    expect(c).toMatchObject({ level: "bad", text: "failing" });
    expect(c.tip.join(" ")).not.toMatch(/first red|2d/);
    const f = findings("/r", input(ok("forge-commit-status", ci(run("ci/jenkins", "fail", S - 2 * D)))), MAINT_DEFAULTS, NOW);
    expect(f[0]).toMatchObject({ key: "ci", text: "CI failing", detail: "ci/jenkins on main", ref: "ci/jenkins" });
  });

  it("dates failing-since over the recorded gh run list as Rust parsed it", () => {
    const gha = narrowMaint(wire.reports.find((r) => r.source === GHA)!, GHA);
    const f = findings("/r", input(gha), MAINT_DEFAULTS, NOW).filter((x) => x.facet === "ci");
    expect(f.map((x) => x.ref)).toEqual(["ci"]); // site passed last, lint is running, Dependabot is no CI
    expect(f[0].detail).toBe("ci on main · first red at aaaa003");
    expect(ciFailures([gha])[0].since).toBe(Date.parse("2026-10-24T09:00:00Z") / 1000);
  });

  it("security names its mix, worst first, and a capped list is a floor", () => {
    const two = [adv({ id: "A", severity: "medium" }), adv({ id: "B", severity: "critical" }), adv({ id: "C", severity: "critical" })];
    expect(cell("security", input(ok("s", { kind: "advisories", items: two })))).toMatchObject({ level: "bad", text: "2 critical · 1 med" });
    expect(cell("security", input(ok("s", { kind: "advisories", items: two }, { truncated: true }))).text).toBe("2+ critical · 1+ med");
    expect(cell("security", input(ok("s", { kind: "advisories", items: [adv({ severity: "medium" })] })))).toMatchObject({ level: "warn" });
    expect(cell("security", input(ok("s", { kind: "advisories", items: [adv({ kind: "secret" })] })))).toMatchObject({ level: "bad", text: "1 secret" });
  });

  it("a bot nothing shows to be alive is silent, not healthy", () => {
    expect(cell("deps", input(ok("d", prs(0))))).toMatchObject({ level: "muted", text: "silent" });
    expect(cell("deps", input(ok("d", prs(0, { dashboard: 7 }))))).toMatchObject({ level: "ok" });
    expect(cell("deps", input(ok("d", prs(0, { configured: false }))))).toMatchObject({ level: "muted", text: "no update bot" });
    const old = prs(1);
    if (old.kind === "updatePrs") old.prs[0].at = S - 40 * D;
    expect(cell("deps", input(ok("d", old)))).toMatchObject({ level: "muted", text: "silent" });
    expect(cell("deps", input(ok("d", prs(2))))).toMatchObject({ level: "info", text: "2 PRs" });
    expect(cell("deps", input(ok("d", prs(5))))).toMatchObject({ level: "warn", text: "5 PRs" });
    const two = input(ok("d", prs(3)), ok("e", prs(2, { bot: "c" })));
    expect(cell("deps", two), "a pile is one bot's, as its line is").toMatchObject({ level: "info", text: "5 PRs" });
    expect(findings("/r", two, MAINT_DEFAULTS, NOW).map((f) => f.level)).toEqual(["info", "info"]);
    expect(cell("deps", input(ok("d", prs(1, {}, "fail"))))).toMatchObject({ level: "warn", text: "1 red" });
    const undated = prs(2);
    if (undated.kind === "updatePrs") for (const p of undated.prs) p.at = null;
    const c = cell("deps", input(ok("d", undated)));
    expect(c, "an unknown date is not an ancient one").toMatchObject({ level: "info", text: "2 PRs" });
    expect(c.tip.join()).not.toMatch(/old/);
  });

  it("release: no tag is never '0 unreleased', and drift has two triggers", () => {
    expect(cell("release", input(ok("t", rel({ tag: null, tagAt: null, since: 40 }))))).toMatchObject({ level: "muted", text: "no tags" });
    expect(cell("release", input(ok("t", rel())))).toMatchObject({ level: "ok", text: "v1.0, 2d" });
    expect(cell("release", input(ok("t", rel({ since: 3, oldestUnreleasedAt: S - D }))))).toMatchObject({ level: "info", text: "3 unreleased" });
    expect(cell("release", input(ok("t", rel({ since: 30 })))).level).toBe("warn");
    expect(cell("release", input(ok("t", rel({ since: 2, oldestUnreleasedAt: S - 22 * D })))).level).toBe("warn");
  });

  it("release and git counts drift once the last fetch is a week old, and say so", () => {
    const c = cell("release", input(ok("t", rel({ fetchedAt: S - 9 * D }))));
    expect(c).toMatchObject({ level: "warn", text: "v1.0, 2d", asOf: S - 9 * D });
    expect(c.tip[0]).toBe("as of last fetch 9d ago");
    expect(cell("git", input(ok("g", hyg({ fetchedAt: S - 8 * D }))))).toMatchObject({ level: "warn", text: "fetched 8d ago" });
    const f = findings("/r", input(ok("g", hyg({ fetchedAt: S - 8 * D })), ok("t", rel({ fetchedAt: S - 9 * D }))), MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.level, x.verb, x.text])).toEqual([["git:fetch", "warn", "fetch", "last fetch 8d ago"]]);
    expect(findings("/r", input(ok("g", hyg())), MAINT_DEFAULTS, NOW)).toEqual([]);
  });

  it("git: unpushed work is drifting, tidying is information, no remote is unknown", () => {
    expect(cell("git", input(ok("g", hyg({ unpushed: 3, localOnly: ["wip"] }))))).toMatchObject({ level: "warn", text: "3 unpushed" });
    expect(cell("git", input(ok("g", hyg({ merged: ["a", "b"] }))))).toMatchObject({ level: "info", text: "2 to tidy" });
    expect(cell("git", input(ok("g", hyg({ unpushed: null }))))).toMatchObject({ level: "muted", text: "no remote" });
    expect(cell("git", input(ok("g", hyg())))).toMatchObject({ level: "ok", text: "" });
  });

  it("git: a branch only here whose commits a remote holds needs nothing, so it is no colour and no line", () => {
    const fresh = input(ok("g", hyg({ localOnly: ["cur", "wt-branch"] })));
    expect(cell("git", fresh)).toMatchObject({ level: "ok", text: "" });
    expect(cell("git", fresh).tip).toContain("only here: cur, wt-branch");
    expect(findings("/r", fresh, MAINT_DEFAULTS, NOW)).toEqual([]);
    expect(cell("git", input(ok("g", hyg({ unpushed: null, localOnly: ["main"] }))))).toMatchObject({ level: "muted", text: "no remote" });
  });

  it("prod: down is broken, and a certificate nobody could read is unknown, never fine", () => {
    const probe = (o = {}) => ({ name: "app", url: "https://app.example", code: 200, ms: 90, certNotAfter: S + 90 * D, err: null, ...o });
    const p = (o = {}) => input(ok("h", { kind: "probes", items: [probe(o)] }));
    expect(cell("prod", p())).toMatchObject({ level: "ok" });
    expect(cell("prod", p({ code: 502 }))).toMatchObject({ level: "bad", text: "app 502" });
    expect(cell("prod", p({ code: null, err: "timeout" }))).toMatchObject({ level: "bad", text: "app down" });
    expect(cell("prod", p({ certNotAfter: S + 6 * D }))).toMatchObject({ level: "warn", text: "cert 6d" });
    expect(cell("prod", p({ certNotAfter: null }))).toMatchObject({ level: "muted", text: "cert unknown" });
    expect(cell("prod", p({ certNotAfter: null, url: "HTTPS://app.example" })), "a scheme in any case").toMatchObject({ level: "muted", text: "cert unknown" });
    const expired = cell("prod", p({ certNotAfter: S - 3 * D }));
    expect(expired).toMatchObject({ level: "bad", text: "cert expired" });
    expect(expired.tip).toEqual(["app: 200 · cert expired 3d ago"]);
  });

  it("work counts what is open and amber only for what waits on you", () => {
    const w = (reviewRequested: number | null, issues = 12) => input(ok("w", { kind: "work", issues, prs: 3, reviewRequested }));
    expect(cell("work", w(0))).toMatchObject({ level: "info", text: "12 open" });
    expect(cell("work", w(1))).toMatchObject({ level: "warn", text: "1 to review" });
    expect(cell("work", w(0, 0))).toMatchObject({ level: "ok", text: "" });
    expect(cell("work", w(null, 0)), "the review count was never read: not grey").toMatchObject({ level: "muted", text: "reviews unknown" });
    expect(cell("work", w(null))).toMatchObject({ level: "info", text: "12 open" });
  });

  it("cells come in card order", () => {
    expect(facetCells(input(), MAINT_DEFAULTS, NOW).map((c) => c.facet)).toEqual([...FACETS]);
    expect(span(30)).toBe("1m");
  });
});

describe("worseOf: a facet's second kind of facts", () => {
  const j = (level: Judged["level"], text: string, more: Partial<Judged> = {}): Judged => ({ level, text, tip: [text], ...more });

  it("lets the worse verdict speak and keeps both tips, a kind with no facts saying nothing", () => {
    const pass = j("ok", ""), red = j("bad", "failing 2d"), amber = j("warn", "2 flaky");
    expect(worseOf(pass, null)).toBe(pass);
    expect(worseOf(pass, amber)).toEqual({ level: "warn", text: "2 flaky", tip: ["", "2 flaky"], asOf: null, blind: false });
    expect(worseOf(red, amber)).toMatchObject({ level: "bad", text: "failing 2d", tip: ["failing 2d", "2 flaky"] });
    expect(worseOf(j("info", "running"), j("info", "3 deploys")).text, "a tie is the first kind's").toBe("running");
    expect(worseOf(pass, j("muted", "cert unknown")).level, "unknown is never green").toBe("muted");
  });

  it("dates the pair by the older fetch", () => {
    expect(worseOf(j("ok", "", { asOf: 200 }), j("ok", "", { asOf: 100 })).asOf).toBe(100);
    expect(worseOf(j("ok", "", { asOf: 200 }), j("warn", "lag")).asOf, "a kind no fetch dates keeps the other's").toBe(200);
  });

  it("lets a blind kind add what it found, never an unknown or a pass over one that answered", () => {
    const answered = j("ok", ""), blindOk = j("ok", "", { blind: true }), blindUnknown = j("muted", "not checked", { blind: true });
    expect(worseOf(answered, blindUnknown)).toMatchObject({ level: "ok", blind: false });
    expect(worseOf(blindUnknown, answered), "in either order").toMatchObject({ level: "ok", blind: false });
    expect(worseOf(answered, blindOk)).toMatchObject({ level: "ok", blind: false });
    expect(worseOf(answered, j("warn", "expires in 9d", { blind: true }))).toMatchObject({ level: "warn", text: "expires in 9d", blind: false });
    expect(worseOf(blindOk, blindUnknown), "nothing answered the facet").toMatchObject({ level: "muted", text: "not checked", blind: true });
    expect(worseOf(j("bad", "domain expired", { blind: true }), blindOk), "what a blind kind found needs no vouching")
      .toMatchObject({ level: "bad", text: "domain expired", blind: false });
  });
});

describe("what the all-clear says it covered", () => {
  it("lists what a source that did not answer would have covered, and what it can never see", () => {
    const sees = new Set<MaintCap>(), blind = new Set<MaintCap>();
    const inp = input(ok(GHA, ci(run("build", "pass", S - H))), not("github-actions-reruns", "ci", { state: "noAccess", reason: "x", fix: null }), not("npm-registry", "deps", { state: "notRun" }));
    addCoverCaps(inp, sees, blind);
    expect(sees.has("ci.default-branch")).toBe(true);
    for (const c of ["ci.reruns", "deps.latest", "deps.transitive", "ci.external"] as const) expect(blind.has(c), c).toBe(true);
    expect(sees.has("ci.reruns")).toBe(false);
    const skipped = new Set<MaintCap>(), left = new Set<MaintCap>();
    addCoverCaps({ ...inp, skip: [GHA] }, skipped, left);
    expect([skipped.has("ci.default-branch"), left.has("ci.default-branch")], "a read this machine skips covers nothing").toEqual([false, true]);
  });
});

describe("flaky jobs: noise beside a red default branch, never in place of it", () => {
  const RR = "github-actions-reruns";
  it("says a failed re-run read in Coverage beside a good runs read, where no board can", () => {
    const refused = not(RR, "ci", { state: "noAccess", reason: "token scope", fix: "gh auth refresh" });
    const rows = (inp: MaintInput) => coverGroups("delivery", [{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) }], null, NOW).map((g) => g.source);
    expect(rows(input(ok(GHA, ci(run("build", "pass", S - H))), refused))).toEqual([RR]);
    expect(rows(input(ok(GHA, ci()), refused)), "beside a muted cell").toContain(RR);
    expect(rows(input(ok(GHA, ci(run("build", "pass", S - H))), ok(RR, { kind: "ciReruns", days: 30, since: null, runs: 9, reran: 0, jobs: [] }))), "it answered").toEqual([]);
  });
  const seen = (at: number, passed: boolean) => ({ sha: "abcdef1234", branch: "feature", at, passed, url: `https://ci.example/job/${at}` });
  // `passed` of `reruns` occurrences passed, the newest first, a day apart.
  const rjob = (job: string, passed: number, reruns = passed): RerunJob => ({ workflow: "ci", job, reruns, passed, steps: ["Cargo test"],
    seen: Array.from({ length: Math.min(reruns, 3) }, (_, i) => seen(S - (i + 1) * D, i < passed)) });
  const reruns = (...jobs: RerunJob[]): Facts => ({ kind: "ciReruns", days: 30, since: null, runs: 140, reran: jobs.length, jobs });
  const green = () => ok(GHA, ci(run("build", "pass", S - H)));
  const failedRuns = () => not(GHA, "ci", { state: "error", reason: "HTTP 502" });

  it("narrows the recorded re-runs unchanged, and a job of the wrong shape fails that source alone", () => {
    const rr = wire.reports.find((r) => r.source === RR)!;
    const f = narrowMaint(rr, RR).facts as Extract<Facts, { kind: "ciReruns" }>;
    expect(f.jobs.map((x) => [x.workflow, x.job, x.reruns, x.passed, x.steps])).toEqual([["ci", "build-check (windows-latest)", 1, 1, ["Cargo test"]]]);
    expect(narrowMaint({ ...rr, facts: { ...f, jobs: [{ ...f.jobs[0], passed: "1" }] } }, RR).coverage.state).toBe("error");
    expect(narrowMaint({ ...rr, facts: { ...f, since: "never" } }, RR).coverage.state).toBe("error");
  });

  it("never lets re-runs vouch for the cell: beside a failed runs read it says that read's word, never 'never ran'", () => {
    const c = cell("ci", input(failedRuns(), ok(RR, reruns(rjob("t", 1)))));
    expect(c).toMatchObject({ state: "cantCheck", level: "muted", text: "read failed" });
    expect(cell("ci", input(ok(RR, reruns()))), "read alone, it is no dot").toMatchObject({ level: "muted", text: "runs not read" });
  });

  it("turns amber at the threshold, leaves a dot with a tip line below it, and lets red stay red", () => {
    expect(cell("ci", input(green(), ok(RR, reruns(rjob("build-check (windows-latest)", 2, 3)))))).toMatchObject({ level: "warn", text: "1 flaky job" });
    const once = cell("ci", input(green(), ok(RR, reruns(rjob("slow", 1)))));
    expect(once).toMatchObject({ level: "ok", text: "" });
    expect(once.tip).toContain("slow (ci): passed on re-run 1 of 1 in 30d");
    const red = cell("ci", input(ok(GHA, ci(run("build", "fail", S - D))), ok(RR, reruns(rjob("t", 3)))));
    expect(red).toMatchObject({ level: "bad", text: "failing 1d" });
    expect(red.tip).toContain("t (ci): passed on re-run 3 of 3 in 30d");
    expect(cell("ci", input(ok(GHA, ci()), ok(RR, reruns(rjob("t", 2))))), "a muted base keeps its words").toMatchObject({ level: "warn", text: "never ran · 1 flaky job" });
    expect(cell("ci", input(failedRuns(), ok(RR, reruns(rjob("t", 2)))))).toMatchObject({ state: "read", level: "warn", text: "runs not read · 1 flaky job" });
    expect(findings("/r", input(green(), ok(RR, reruns(rjob("t", 2)), { truncated: true })), MAINT_DEFAULTS, NOW)[0].detail, "a failed read is no busy project")
      .toBe("ci · 2 of 2 re-runs passed in 30 days · fails at Cargo test · read in part");
    expect(findings("/r", input(green(), ok(RR, { ...reruns(rjob("t", 2)), since: S - D } as Facts, { truncated: true })), MAINT_DEFAULTS, NOW)[0].detail)
      .toBe("ci · 2 of 2 re-runs passed in 30 days · fails at Cargo test · a busy window, read in part");
    expect(cell("ci", input(green(), ok(RR, reruns(rjob("a", 2), rjob("b", 4)), { truncated: true })))).toMatchObject({ text: "2+ flaky jobs" });
    // Amber always has its line, and the band reads the cell.
    expect(projectBand(facetCells(input(green(), ok(RR, reruns(rjob("t", 2)))), MAINT_DEFAULTS, NOW))).toBe("drifting");
  });

  it("reads the threshold from the file and refuses a zero", () => {
    const inp = input(green(), ok(RR, reruns(rjob("t", 1))));
    expect(facetCell("ci", inp, clampMaint({ flaky_reruns: 1 }), NOW)).toMatchObject({ level: "warn", text: "1 flaky job" });
    expect(clampMaint({ flaky_reruns: 0 }).flakyReruns).toBe(2);
    expect(flakyJobs(inp, clampMaint({ flaky_reruns: 1 })).map((j) => [j.job, j.level])).toEqual([["t", "warn"]]);
    expect(flakyJobs(inp).map((j) => [j.job, j.level, j.last, j.url])).toEqual([["t", "info", S - D, `https://ci.example/job/${S - D}`]]);
  });

  it("is one ci:flaky line with Fix, worded for one job or several, beside the red line and never below the threshold", () => {
    const one = findings("/r", input(green(), ok(RR, reruns(rjob("build-check (windows-latest)", 2, 3)))), MAINT_DEFAULTS, NOW);
    expect(one.map((f) => [f.key, f.level, f.verb, f.ref, f.text, f.detail])).toEqual([["ci:flaky", "warn", "fix", "flaky",
      "build-check (windows-latest) passed on re-run 2×", "ci · 2 of 3 re-runs passed in 30 days · fails at Cargo test"]]);
    const several = findings("/r", input(green(), ok(RR, reruns(rjob("a", 2), rjob("b", 5), rjob("c", 3), rjob("d", 2), rjob("e", 1)))), MAINT_DEFAULTS, NOW);
    expect(several.map((f) => [f.key, f.text, f.detail])).toEqual([["ci:flaky", "4 flaky jobs", "b 5×, c 3×, a 2× …"]]);
    expect(findings("/r", input(green(), ok(RR, reruns(rjob("a", 1)))), MAINT_DEFAULTS, NOW)).toEqual([]);
    const both = findings("/r", input(ok(GHA, ci(run("build", "fail", S - D))), ok(RR, reruns(rjob("a", 2)))), MAINT_DEFAULTS, NOW);
    expect(both.map((f) => [f.key, f.level]), "broken and noisy are two problems").toEqual([["ci", "bad"], ["ci:flaky", "warn"]]);
  });

  it("opens on its own board, and never becomes Today's red default branch", () => {
    expect(findingTarget({ facet: "ci", key: "ci:flaky" })).toEqual({ tab: "delivery", board: "flaky" });
    expect(findingTarget({ facet: "ci", key: "ci" })).toEqual({ tab: "delivery", board: "ci" });
    const inp = input(green(), ok(RR, reruns(rjob("a", 2))));
    expect(ciRows(inp, undefined, NOW)).toEqual([]);
    const snap = takeSnap("/r", inp, NOW);
    expect(snap.findings.map((f) => f.key)).toEqual(["ci:flaky"]);
    expect(ciRows(null, snap, NOW), "a snapshot's noise is no red row").toEqual([]);
  });

  it("keeps the last known red when only the re-runs were read", () => {
    const red = takeSnap("/r", input(ok(GHA, ci(run("build", "fail", S - 2 * D)))), NOW - D * 1000);
    const failed = input(failedRuns(), ok(RR, reruns(rjob("a", 2))));
    expect(cell("ci", failed).state).toBe("read");
    expect(ciRows(failed, red, NOW).map((r) => [r.text, r.asOf])).toEqual([["CI failing 1d", red.at]]);
    const next = takeSnap("/r", failed, NOW, red);
    expect(next.cells.find((c) => c.facet === "ci")).toMatchObject({ level: "bad", at: red.at });
    expect(next.findings.map((f) => f.key)).toEqual(["ci"]);
  });

  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };

  it("lists a failed runs read in Coverage even when the re-runs found noise", () => {
    const failed = { ...failedRuns(), coverage: { state: "noAccess", reason: "token scope", fix: "gh auth refresh" } as Coverage };
    const row = (reps: SourceReport[]) => coverGroups("delivery", [tp("/r", ...reps)], null, NOW).map((g) => [g.source, g.why, g.action]);
    const said = [[GHA, "token scope", { kind: "fix", fix: "gh auth refresh" }]];
    expect(row([failed, ok(RR, reruns(rjob("t", 2)))]), "amber for the noise, and still no word on the branch").toEqual(said);
    expect(row([failed, ok(RR, reruns(rjob("t", 1)))]), "the same row as with no noise").toEqual(said);
    expect(row([green(), ok(RR, reruns(rjob("t", 2)))]), "a read default branch leaves nothing to explain").toEqual([]);
  });

  it("keeps the CI board the default branch's: green stays green beside noise, red stays red", () => {
    const b = tabBoards("delivery", [tp("/a", green(), ok(RR, reruns(rjob("t", 2)))), tp("/b", green())], null, null, NOW);
    expect(b.ci.map((r) => [r.root, r.level, r.text])).toEqual([["/a", "ok", ""], ["/b", "ok", ""]]);
    const red = tabBoards("delivery", [tp("/a", ok(GHA, ci(run("build", "fail", S - D))), ok(RR, reruns(rjob("t", 2))))], null, null, NOW);
    expect(red.ci.map((r) => [r.level, r.text])).toEqual([["bad", "failing 1d"]]);
  });

  it("never claims a whole window it did not read, and says why it did not", () => {
    const board = (...reps: SourceReport[]) => tabBoards("delivery", [tp("/a", ...reps)], null, null, NOW).flaky;
    expect(board(green(), ok(RR, reruns()))).toMatchObject({ cut: false, short: false, clear: "No job needed a re-run to pass in 30 days." });
    const failed = ok(RR, { ...reruns(), reran: 3 } as Facts, { truncated: true, gaps: ["CI on abc: jobs not read: HTTP 502"] });
    expect(board(green(), failed)).toMatchObject({ rows: [], cut: true, short: false, clear: "No flaky job in what could be read." });
    const busy = ok(RR, { ...reruns(), since: S - 9 * D } as Facts, { truncated: true });
    expect(board(green(), busy)).toMatchObject({ rows: [], cut: true, short: true, clear: "No flaky job in what could be read." });
  });

  it("draws the Flaky jobs board: the noisiest first, a Fix on its warn rows only, a cut window a floor", () => {
    const ps = [
      tp("/a", green(), ok(RR, reruns(rjob("slow", 1), rjob("race", 3, 4)))),
      tp("/b", green(), ok(RR, reruns(rjob("net", 2)), { truncated: true })),
      tp("/c", ok(RR, reruns())),
    ];
    const b = tabBoards("delivery", ps, null, null, NOW);
    expect(b.flaky.rows.map((r) => [r.root, r.job, r.passed, r.reruns, r.level, r.capped, r.verb?.key ?? null])).toEqual([
      ["/a", "race", 3, 4, "warn", false, "ci:flaky"], ["/b", "net", 2, 2, "warn", true, "ci:flaky"], ["/a", "slow", 1, 1, "info", false, null],
    ]);
    expect(b.flaky.rows[0]).toMatchObject({ last: D, url: `https://ci.example/job/${S - D}`, steps: ["Cargo test"], workflow: "ci" });
    expect(b.flaky).toMatchObject({ read: 3, days: 30, runs: 420, reran: 3, cut: true });
    expect(b.drawn).toEqual(expect.arrayContaining(["/a|ci:flaky", "/b|ci:flaky"]));
    expect(b.ci.map((r) => r.root), "re-runs alone give no CI row").toEqual(["/a", "/b"]);
    expect(b.read.ci, "the CI board counts the runs read, not the re-runs").toBe(2);
    expect(flakyBoard(ps, "/c", NOW)).toEqual([]);
    expect(tabBoards("delivery", ps, "/c", null, NOW).flaky).toMatchObject({ read: 1, cut: false });
    expect(tabBoards("security", ps, null, null, NOW).flaky.read, "only Delivery reads it").toBe(0);
    expect(boardDoor("flaky", "last", b.flaky.rows[0].url)).toEqual({ to: "url", url: `https://ci.example/job/${S - D}` });
    expect(boardDoor("flaky", "last", "file:///etc/passwd")).toBeNull();
    expect(boardDoor("flaky", "passed", 3), "a count with no door, as the changelog's").toBeNull();
  });
});

describe("deployments: what each environment runs", () => {
  const GD = "github-deployments", DT = "deploy-tags";
  const env = (o: Partial<Deployed> = {}): Deployed => ({
    env: "prod", tier: "production", sha: "a".repeat(40), tag: "v1.0", branch: "main", at: S - D, url: "https://app.example", last: null,
    behind: 0, behindAt: null, ahead: 0, ...o,
  });
  const deps = (envs: Deployed[], o: Partial<Extract<Facts, { kind: "deployments" }>> = {}): Facts => ({ kind: "deployments", trunk: "origin/main", envs, fetchedAt: S - H, ...o });
  const fail = (at = S - 2 * H) => ({ state: "fail" as const, raw: "FAILURE", sha: "b".repeat(40), at, url: "https://ci.example/9" });
  const one = (e: Deployed, inp = input(ok(GD, deps([e])))) => deployStates(inp, MAINT_DEFAULTS, NOW)[0];
  const lines = (i: MaintInput) => findings("/r", i, MAINT_DEFAULTS, NOW).filter((f) => f.key.startsWith("release:deploy"));
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };

  it("narrows the backend's report, and a wrong shape fails that source alone", () => {
    const r = wire.reports.find((x) => x.source === GD)!;
    const f = narrowMaint(r, GD).facts as Extract<Facts, { kind: "deployments" }>;
    expect(f.envs.map((e) => [e.env, e.tier, e.behind])).toEqual([["production", "production", 23], ["Preview – ui", "preview", 0], ["staging", "staging", null], ["automations", "other", null]]);
    expect(f.envs[0].last?.state).toBe("fail");
    expect(f.envs[3].sha).toBeNull();
    expect(FACT_FACET.deployments).toBe("release");
    expect(narrowMaint({ ...r, facts: { ...f, envs: [{ ...f.envs[0], tier: "prod" }] } }, GD).coverage.state).toBe("error");
    expect(narrowMaint({ ...r, facts: { ...f, envs: [{ ...f.envs[0], last: { ...f.envs[0].last, state: "done" } }] } }, GD).coverage.state).toBe("error");
    expect(narrowMaint({ ...r, facts: { ...f, fetchedAt: "soon" } }, GD).coverage.state).toBe("error");
    expect([...DEPLOY_STATES, ...ENV_TIERS]).toContain("gone");
  });

  it("levels production on the thresholds, either of them", () => {
    expect(one(env())).toMatchObject({ level: "ok", text: "", judged: true });
    expect(one(env({ behind: 19, behindAt: S - 13 * D }))).toMatchObject({ level: "info", text: "prod 19 behind" });
    expect(one(env({ behind: 20, behindAt: S - D }))).toMatchObject({ level: "warn", text: "prod 20 behind", behind: 20 });
    expect(one(env({ behind: 2, behindAt: S - 14 * D }))).toMatchObject({ level: "warn", text: "prod 2 behind" });
    expect(one(env({ ahead: 3, behind: 1 }))).toMatchObject({ level: "warn", text: "prod off trunk" });
  });

  it("never reads a lag nobody counted, or nothing live, as fine", () => {
    expect(one(env({ behind: null, ahead: null }))).toMatchObject({ level: "muted", text: "prod behind unknown", live: "v1.0" });
    expect(one(env({ sha: null, tag: null, behind: null, ahead: null }))).toMatchObject({ level: "muted", text: "prod: nothing live", live: null });
    expect(one(env({ tag: null })).live, "the short sha when no tag names it").toBe("aaaaaaa");
  });

  it("judges a failure by its tier and lets a wait or a run change nothing", () => {
    expect(one(env({ last: fail() }))).toMatchObject({ level: "bad", text: "prod deploy failed", judged: true });
    expect(one(env({ env: "stg", tier: "staging", last: fail() }))).toMatchObject({ level: "warn", judged: true });
    expect(one(env({ env: "ops", tier: "other", last: fail() }))).toMatchObject({ level: "info", judged: false });
    for (const [state, text] of [["waiting", "waiting 2h"], ["running", "deploying"]] as const) {
      const s = one(env({ behind: 3, behindAt: S - D, last: { ...fail(), state, raw: state.toUpperCase() } }));
      expect(s).toMatchObject({ level: "info", text: "prod 3 behind" });
      expect(s.last).toMatchObject({ text, level: "muted" });
    }
    expect(one(env({ last: { ...fail(), state: "gone", raw: "DESTROYED" } })).last?.text).toBe("destroyed");
  });

  it("lists staging and the rest, without letting their lag speak", () => {
    const s = one(env({ env: "stg", tier: "staging", behind: 40, behindAt: S - 30 * D }));
    expect(s).toMatchObject({ level: "info", text: "stg 40 behind", judged: false });
    expect(one(env({ env: "stg", tier: "staging", ahead: 2 }))).toMatchObject({ level: "info", text: "stg 2 ahead" });
    expect(one(env({ env: "ops", tier: "other", behind: 40 }))).toMatchObject({ level: "info", judged: false });
    expect(one(env({ env: "Preview", tier: "preview" }))).toMatchObject({ hidden: true, judged: false });
  });

  it("calls an environment nobody touched idle, and never judges it", () => {
    const old = env({ env: "Production", at: S - 5 * 365 * D, behind: 9000, behindAt: S - 5 * 365 * D });
    expect(one(old)).toMatchObject({ idle: true, judged: false, level: "info", text: "idle 5y" });
    expect(one(env({ ...old, at: S - 179 * D }))).toMatchObject({ idle: false, judged: true, level: "warn" });
    expect(one(env({ ...old, last: fail() })), "a recent attempt is activity").toMatchObject({ idle: false, level: "bad" });
    expect(lines(input(ok(GD, deps([old])))), "and it has no line").toEqual([]);
    const inp = { ...input(ok(GD, deps([old]))) };
    inp.det = det([GD], { deploy: { host: null, compose: [], urls: {}, sentry: null, versionUrl: null, envs: { production: "prod-*" } } });
    expect(one(old, inp), "a tag convention someone wrote is never idle").toMatchObject({ idle: false, judged: true });
    expect(deployStates(input(ok(GD, deps([old]))), clampMaint({ deploy_idle_days: 3000 }), NOW)[0].idle).toBe(false);
  });

  it("merges one environment from both sources, case-blind", () => {
    const merged = (a: Deployed, b: Deployed) => deployStates(input(ok(GD, deps([a])), ok(DT, deps([b]), { cost: "local" })), MAINT_DEFAULTS, NOW);
    const tagged = env({ env: "Prod", sha: "c".repeat(40), tag: "prod-9", at: S - H, url: null });
    const forge = env({ at: S - D });
    expect(merged(forge, tagged).map((e) => [e.env, e.source, e.live])).toEqual([["Prod", DT, "prod-9"]]);
    expect(merged(env({ at: S - H }), tagged).map((e) => e.source), "a tie goes to the forge").toEqual([GD]);
    expect(merged(env({ at: S - H }), { ...tagged, at: null }).map((e) => e.source), "a date beats none").toEqual([GD]);
    expect(merged(env({ sha: null, tag: null, at: null }), tagged).map((e) => e.source), "something live beats nothing").toEqual([DT]);
    expect(merged(env({ at: S - D, last: fail(S - 60) }), tagged)[0], "a newer failure survives the merge").toMatchObject({ source: DT, level: "bad" });
    expect(merged(env({ at: S - 2 * D, last: fail(S - D) }), tagged)[0].last, "an older one does not").toBeNull();
  });

  describe("the Release cell", () => {
    const fixtures: Facts[] = [rel(), rel({ since: 3 }), rel({ since: 40, oldestUnreleasedAt: S - 30 * D }), rel({ tag: null, tagAt: null })];
    it("reads exactly as before with no environment that may speak", () => {
      for (const r of fixtures) {
        const before = cell("release", input(ok("git-tags", r)));
        expect(cell("release", input(ok("git-tags", r), ok(GD, deps([])))), "envs: []").toEqual(before);
        expect(cell("release", input(ok("git-tags", r), ok(GD, deps([env({ env: "Preview", tier: "preview", behind: 9 })])))), "a preview").toEqual(before);
        expect(cell("release", input(ok("git-tags", r), ok(GD, deps([env({ env: "ops", tier: "other", behind: 90, last: fail() })])))), "listed only").toEqual(before);
        expect(cell("release", input(ok("git-tags", r), ok(GD, deps([env({ env: "stg", tier: "staging", behind: 90 })])))), "a staging behind").toEqual(before);
        expect(cell("release", input(ok("git-tags", r), ok(GD, deps([env({ at: S - 400 * D, behind: 900 })])))), "idle").toEqual(before);
      }
    });
    it("takes an empty answer for no answer beside a read that failed", () => {
      const failed = not("git-tags", "release", { state: "unsupported", reason: "no trunk" });
      expect(cell("release", input(failed, ok(GD, deps([]))))).toMatchObject({ state: "cantCheck", text: "unavailable" });
      expect(cell("release", input(failed, ok(GD, deps([env({ behind: null, ahead: null })]))))).toMatchObject({ state: "cantCheck", text: "unavailable" });
    });
    it("lets production at zero speak for itself and never for a release read that failed", () => {
      const failed = not("git-tags", "release", { state: "error", reason: "git exploded" });
      expect(cell("release", input(failed, ok(GD, deps([env()]))))).toMatchObject({ state: "cantCheck", level: "muted" });
      const emptyLog = ok("changelog", { kind: "changelog", unreleased: null, latest: null, latestAt: null });
      expect(cell("release", input(failed, emptyLog, ok(GD, deps([env()])))), "a changelog that said nothing answers nothing").toMatchObject({ state: "cantCheck" });
      expect(cell("release", input(failed, ok(GD, deps([env({ behind: 30, behindAt: S - D })])))), "what it found still speaks").toMatchObject({ state: "read", level: "warn", text: "prod 30 behind" });
      expect(cell("release", input(ok(GD, deps([env()])))), "nothing failed: the count is the evidence").toMatchObject({ state: "read", level: "ok", text: "" });
    });
    it("lets a cut list vouch for nothing, and floors no figure it did not cut", () => {
      const gaps = ["the 12 most recently active of 15 environments are listed"];
      const cut = (e: Deployed) => ok(GD, deps([e]), { truncated: true, gaps });
      expect(cell("release", input(ok("git-tags", rel({ tag: null, tagAt: null })), cut(env())))).toMatchObject({ level: "muted", text: "no tags" });
      expect(cell("release", input(ok("git-tags", rel()), cut(env())))).toMatchObject({ level: "ok", text: "v1.0, 2d" });
      const behind = cell("release", input(ok("git-tags", rel({ since: 3 })), cut(env({ behind: 30, behindAt: S - D }))));
      expect(behind).toMatchObject({ level: "warn", text: "prod 30 behind · 3 unreleased" });
      expect(behind.tip.join("\n")).toContain(`GitHub deployments: ${gaps[0]}`);
      expect(behind.tip.join("\n"), "3 unreleased and 30 behind are exact").not.toContain("floors");
      expect(cell("release", input(ok("github-releases", { kind: "releases", latest: null, count: 100 }, { truncated: true }))).tip.join("\n")).toContain("floors");
    });
    it("draws the dot only on production counted at zero behind", () => {
      const noTags = ok("git-tags", rel({ tag: null, tagAt: null }));
      expect(cell("release", input(noTags, ok(GD, deps([env()]))))).toMatchObject({ level: "ok", text: "" });
      expect(cell("release", input(noTags, ok(GD, deps([env({ behind: null, ahead: null })]))))).toMatchObject({ level: "muted", text: "no tags · prod behind unknown" });
      expect(cell("release", input(noTags, ok(GD, deps([env(), env({ env: "eu-prod", sha: null, tag: null, behind: null, ahead: null })])))), "one unknown holds the dot back")
        .toMatchObject({ level: "muted" });
      expect(cell("release", input(ok("git-tags", rel()), ok(GD, deps([env({ behind: null, ahead: null })])))), "a muted half yields").toMatchObject({ level: "ok", text: "v1.0, 2d" });
    });
    it("names both halves, the worse first, at the worse level", () => {
      const three = ok("git-tags", rel({ since: 3 }));
      const c = cell("release", input(three, ok(GD, deps([env({ behind: 30, behindAt: S - D })]))));
      expect(c).toMatchObject({ level: "warn", text: "prod 30 behind · 3 unreleased" });
      expect(c.tip.join("\n")).toContain("prod: runs v1.0, 30 commits behind origin/main");
      expect(c.tip.join("\n")).toContain("3 commits since v1.0");
      expect(cell("release", input(three, ok(GD, deps([env({ last: fail() })]))))).toMatchObject({ level: "bad", text: "prod deploy failed · 3 unreleased" });
      expect(cell("release", input(three, ok(GD, deps([env()]))))).toMatchObject({ level: "info", text: "3 unreleased" });
      expect(cell("release", input(three, ok(GD, deps([env({ env: "stg", tier: "staging", last: fail() })]))))).toMatchObject({ level: "warn", text: "stg deploy failed · 3 unreleased" });
      expect(cell("release", input(ok("git-tags", rel({ tag: null, tagAt: null })), ok(GD, deps([env({ behind: 30 })]))))).toMatchObject({ level: "warn", text: "prod 30 behind" });
    });
    it("dates a stale count by its fetch and says so in a line", () => {
      const stale = input(ok(GD, deps([env()], { fetchedAt: S - 9 * D })));
      expect(cell("release", stale)).toMatchObject({ level: "warn", text: "fetched 9d ago", asOf: S - 9 * D });
      expect(findings("/r", stale, MAINT_DEFAULTS, NOW).map((f) => f.key)).toEqual(["git:fetch"]);
    });
  });

  it("files one line per kind, with its verb", () => {
    const behind = (env_: string, n: number) => env({ env: env_, behind: n, behindAt: S - D });
    expect(lines(input(ok(GD, deps([behind("prod", 23)]))))).toMatchObject([{ key: "release:deploy", level: "warn", verb: "deploy", ref: "prod", source: GD, text: "prod is 23 commits behind", detail: "runs v1.0 · oldest undeployed 1d" }]);
    expect(lines(input(ok(GD, deps([behind("prod", 3)])))), "below both thresholds").toMatchObject([{ level: "info", text: "prod is 3 commits behind" }]);
    expect(lines(input(ok(GD, deps([env({ ahead: 3, behind: 2 })]))))).toMatchObject([{ level: "warn", text: "prod runs 3 commits not on origin/main", detail: "runs v1.0 · 2 behind" }]);
    expect(lines(input(ok(GD, deps([behind("prod", 23), behind("eu-prod", 2)]))))).toMatchObject([{ key: "release:deploy", level: "warn", ref: null, text: "2 environments behind", detail: "prod 23 behind, eu-prod 2 behind" }]);
    expect(lines(input(ok(GD, deps([env({ last: fail() })]))))).toMatchObject([{ key: "release:deploy-failed", level: "bad", verb: "fix", ref: "prod", text: "prod deploy failed 2h ago", detail: "still running v1.0" }]);
    expect(lines(input(ok(GD, deps([env({ env: "stg", tier: "staging", last: fail() })]))))).toMatchObject([{ level: "warn", text: "stg deploy failed 2h ago" }]);
    expect(lines(input(ok(GD, deps([env({ last: fail() }), env({ env: "stg", tier: "staging", last: fail() })]))))).toMatchObject([{ level: "bad", text: "2 deploys failed" }]);
    expect(lines(input(ok(GD, deps([env({ last: fail(), behind: 40 })])))).map((f) => f.key), "broken and behind are two lines").toEqual(["release:deploy-failed", "release:deploy"]);
    const key = (i: MaintInput) => lines(i).find((f) => f.key === "release:deploy");
    expect(key(input(ok(GD, deps([env({ behind: 30, behindAt: S - D, last: fail() }), behind("eu-prod", 2)])))), "the failure has its own line")
      .toMatchObject({ text: "2 environments behind", detail: "prod 30 behind, eu-prod 2 behind" });
    expect(key(input(ok(GD, deps([env({ ahead: 2 }), env({ env: "eu-prod", ahead: 1 })])))), "neither is behind")
      .toMatchObject({ text: "2 environments not at the trunk", detail: "eu-prod off trunk, prod off trunk" });
    expect(key(input(ok(GD, deps([behind("prod", 30), behind("eu-prod", 2)]), { truncated: true })))?.text, "a cut list's count is a floor").toBe("2+ environments behind");
    expect(lines(input(ok(GD, deps([env({ last: fail() }), env({ env: "stg", tier: "staging", last: fail() })]), { truncated: true })))[0].text).toBe("2+ deploys failed");
    for (const quiet of [env(), env({ behind: null, ahead: null }), env({ env: "stg", tier: "staging", behind: 40 }), env({ env: "ops", tier: "other", behind: 40, last: fail() }), env({ env: "pr-1", tier: "preview", behind: 40, last: fail() })]) {
      expect(lines(input(ok(GD, deps([quiet])))), quiet.env).toEqual([]);
    }
    expect(envsToShip(deployStates(input(ok(GD, deps([env({ env: "stg", tier: "staging", behind: 4 })]))), MAINT_DEFAULTS, NOW))).toEqual([]);
    expect(envsFailed(deployStates(input(ok(GD, deps([env({ env: "stg", tier: "staging", last: fail() })]))), MAINT_DEFAULTS, NOW))).toHaveLength(1);
  });

  it("opens both lines on the board that draws their verbs", () => {
    expect(findingTarget({ facet: "release", key: "release:deploy" })).toEqual({ tab: "delivery", board: "deployments" });
    expect(findingTarget({ facet: "release", key: "release:deploy-failed" })).toEqual({ tab: "delivery", board: "deployments" });
    expect(findingTarget({ facet: "release", key: "release" })).toEqual({ tab: "delivery", board: "releases" });
    expect(findingTarget({ facet: "release", key: "release:other" }), "a new kind claims no board").toEqual({ tab: "delivery", board: null });
    expect(boardDoor("deployments", "behind", 3)).toEqual({ to: "landed" });
    expect(boardDoor("deployments", "site", "https://app.example")).toEqual({ to: "url", url: "https://app.example" });
    expect(boardDoor("deployments", "log", "javascript:alert(1)")).toBeNull();
    expect(boardDoor("deployments", "behind", 0), "a zero is the dot").toBeNull();
  });

  it("lists the board worst first, previews counted and idle last, carrying each verb", () => {
    const a = tp("/a", ok(GD, deps([env({ behind: 30, behindAt: S - D }), env({ env: "Preview – ui", tier: "preview" }), env({ env: "old", at: S - 400 * D, behind: 900 })])));
    const b = tp("/b", ok(GD, deps([env({ last: fail() }), env({ env: "stg", tier: "staging" }), env({ env: "ops", tier: "other", behind: 4 })])));
    const c = tp("/c", ok(GD, deps([])));
    const d = deployBoard([c, a, b], null, NOW);
    expect(d.rows.map((r) => `${r.root} ${r.env} ${r.level}`)).toEqual(["/b prod bad", "/a prod warn", "/b ops info", "/b stg ok", "/a old info"]);
    expect([d.hidden, d.read]).toEqual([1, 3]);
    expect(d.rows[0].verbs.map((f) => f.verb)).toEqual(["fix"]);
    expect(d.rows[1].verbs.map((f) => f.verb)).toEqual(["deploy"]);
    expect(d.rows[2].verbs, "listed only").toEqual([]);
    const both = tp("/d", ok(GD, deps([env({ behind: 30, last: fail() })])));
    expect(deployBoard([both], null, NOW).rows[0].verbs.map((f) => f.key), "a row carries each line it is under").toEqual(["release:deploy-failed", "release:deploy"]);
    const retired = deployBoard([tp("/e", ok(GD, deps([env({ env: "old", sha: null, tag: null, at: null, behind: null, ahead: null, last: fail(S - 400 * D) })])))], null, NOW).rows[0];
    expect(retired).toMatchObject({ idle: true, level: "info", verbs: [] });
    expect(retired.last, "a failure from 13 months ago is history, not red").toMatchObject({ level: "muted", text: "failed 400d ago" });
    const tb = tabBoards("delivery", [a, b, c], null, null, NOW);
    expect(tb.deploys.length).toBe(5);
    expect([tb.deployHidden, tb.deployRead]).toEqual([1, 3]);
    expect(tb.deployCut).toBe(false);
    expect(tabBoards("delivery", [a, tp("/s", ok(GD, deps([env()]), { truncated: true }))], null, null, NOW).deployCut, "the board says a list was cut").toBe(true);
    expect(tb.drawn).toEqual(expect.arrayContaining(["/a|release:deploy", "/b|release:deploy-failed"]));
    const narrowed = tabBoards("delivery", [a, b, c], "/a", null, NOW);
    expect(narrowed.deploys.map((r) => r.env)).toEqual(["prod", "old"]);
    expect(narrowed.one).toBe(true);
    expect(tabBoards("security", [a], null, null, NOW).deploys).toEqual([]);
    // Environments are not releases: the release table's note counts what it lists.
    expect(tabBoards("delivery", [a], null, null, NOW).read.release).toBe(0);
    expect(tabModel("delivery", [a, b], null, null, NOW).rows.filter((f) => f.key.startsWith("release:")), "every verb is on the board").toEqual([]);
  });

  it("lists a refused read of the environments in Coverage, whatever the release half said", () => {
    const refused = not(GD, "release", { state: "noAccess", reason: "token scope", fix: "pick the GitHub account" });
    const row = (...reps: SourceReport[]) => coverGroups("delivery", [tp("/r", ...reps)], null, NOW).filter((g) => g.source !== null).map((g) => [g.source, g.why, g.action]);
    const said = [[GD, "token scope", { kind: "fix", fix: "pick the GitHub account" }]];
    expect(row(ok("git-tags", rel()), refused), "beside a verdict").toEqual(said);
    expect(row(ok("git-tags", rel({ tag: null, tagAt: null })), refused), "beside no tags").toEqual(said);
    const groups = coverGroups("delivery", [tp("/a", ok("git-tags", rel()), refused), tp("/b", ok("git-tags", rel()), refused)], null, NOW);
    expect(groups.map((g) => g.roots), "one row, however many projects").toEqual([["/a", "/b"]]);
    expect(row(ok("git-tags", rel()), ok(GD, deps([]))), "an answer with no environments is no gap").toEqual([]);
    expect(row(ok("git-tags", rel()), not("github-releases", "release", { state: "error", reason: "x" })), "only the environments' own sources").toEqual([]);
    const inp = { ...input(ok("git-tags", rel()), refused), skip: [GD] };
    expect(coverGroups("delivery", [{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) }], null, NOW), "a skip someone chose is not news beside a verdict").toEqual([]);
  });

  describe("a failed read beside the other half", () => {
    const tagsFailed = not("git-tags", "release", { state: "error", reason: "git exploded" });
    const refused = not(GD, "release", { state: "noAccess", reason: "token scope", fix: null });
    const tags = ok("git-tags", rel());
    const behind = ok(GD, deps([env({ behind: 30, behindAt: S - D })])), broke = ok(GD, deps([env({ last: fail() })]));
    const relOf = (s: ReturnType<typeof takeSnap>) => ({
      cell: s.cells.find((c) => c.facet === "release"), lines: s.findings.filter((f) => f.facet === "release").map((f) => [f.key, f.at]),
    });
    const red = takeSnap("/r", input(tags, broke), NOW - D * 1000);

    it("lists a failed release read in Coverage beside what the environments found", () => {
      const row = (...reps: SourceReport[]) => coverGroups("delivery", [tp("/r", ...reps)], null, NOW).map((g) => g.source);
      expect(cell("release", input(tagsFailed, behind)), "the cell still says what it found").toMatchObject({ state: "read", level: "warn" });
      expect(row(tagsFailed, behind), "amber for production, and still no word on the tags").toEqual(["git-tags"]);
      expect(row(tagsFailed, broke), "red for production too").toEqual(["git-tags"]);
      const emptyLog = ok("changelog", { kind: "changelog", unreleased: null, latest: null, latestAt: null });
      expect(row(tagsFailed, emptyLog, behind), "a changelog that said nothing answers nothing").toEqual(["git-tags"]);
      const published = ok("github-releases", { kind: "releases", latest: { tag: "v2", name: "v2", at: S - D, url: null }, count: 1 });
      expect(row(tagsFailed, published, behind), "a published release answers for the half").toEqual([]);
      expect(row(behind), "nothing failed: the environments' count is the evidence").toEqual([]);
      expect(row(tagsFailed, refused, ok("deploy-tags", deps([env({ behind: 30, behindAt: S - D })]), { cost: "local" })).sort(), "each failed read once").toEqual(["git-tags", GD]);
    });

    it("keeps the last known deploy red while the environments cannot be read", () => {
      expect(relOf(red)).toMatchObject({ cell: { level: "bad", text: "prod deploy failed" }, lines: [["release:deploy-failed", undefined]] });
      const next = relOf(takeSnap("/r", input(tags, refused), NOW, red));
      expect(next.cell, "dated as then, not the tags' dot").toMatchObject({ level: "bad", text: "prod deploy failed", at: red.at });
      expect(next.lines).toEqual([["release:deploy-failed", red.at]]);
      expect(relOf(takeSnap("/r", input(tags, ok(GD, deps([env()]))), NOW, red)).lines, "an answer with no failure replaces it").toEqual([]);
      const skip = { ...input(tags, refused), skip: [GD] };
      expect(relOf(takeSnap("/r", skip, NOW, red)).cell, "a skip someone chose is no failed read").toMatchObject({ level: "ok", text: "v1.0, 2d" });
    });

    it("keeps nothing a failed environments read could not have said", () => {
      const quiet = takeSnap("/r", input(tags), NOW - D * 1000);
      const next = relOf(takeSnap("/r", input(ok("git-tags", rel({ since: 3 })), refused), NOW, quiet));
      expect(next.cell, "a token never allowed the read: the tags stay live").toEqual({ facet: "release", level: "info", text: "3 unreleased" });
      expect(next.lines).toEqual([["release", undefined]]);
    });

    it("keeps the last known red over amber when the release read failed, and lets a fresh red replace anything", () => {
      const held = relOf(takeSnap("/r", input(tagsFailed, behind), NOW, red));
      expect(held.cell).toMatchObject({ level: "bad", text: "prod deploy failed", at: red.at });
      expect(held.lines).toEqual([["release:deploy-failed", red.at]]);
      const amber = takeSnap("/r", input(ok("git-tags", rel({ since: 40, oldestUnreleasedAt: S - 30 * D }))), NOW - D * 1000);
      const fresh = relOf(takeSnap("/r", input(tagsFailed, broke), NOW, amber));
      expect(fresh.cell, "a red nobody had seen is never dropped").toEqual({ facet: "release", level: "bad", text: "prod deploy failed" });
      expect(fresh.lines).toEqual([["release:deploy-failed", undefined]]);
    });
  });

  it("puts the Release tab's numbers on the tally", () => {
    const p = tp("/a", ok(GD, deps([env({ last: fail() })])));
    expect(tabTally(p.rows).delivery).toEqual({ n: 1, level: "bad" });
    expect(projectBand(p.cells)).toBe("needs");
    const noisy = tp("/b", ok(GD, deps([env({ env: "ops", tier: "other", last: fail() })])));
    expect(tabTally(noisy.rows).delivery.n, "listed only is no count").toBe(0);
    expect(projectBand(noisy.cells)).not.toBe("needs");
  });
});

describe("mergeAdvisories", () => {
  it("folds reporters sharing any id or alias into one row at the worst severity", () => {
    const rows = mergeAdvisories([
      [adv({ id: "GHSA-1", aliases: ["CVE-1"], severity: "medium", fixed: null, tool: "t1" })],
      [adv({ id: "OSV-1", aliases: ["CVE-1"], severity: "critical", url: null, tool: "t2" })],
      [adv({ id: "X-9", aliases: [], pkg: "other", severity: "low" })],
    ]);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ id: "GHSA-1", aliases: ["CVE-1", "OSV-1"], severity: "critical", fixed: "4.17.21", tools: ["t1", "t2"] });
    expect(rows[0].url).toBe("https://adv.example/A-1");
  });

  it("gives a row a fix only when it is one package", () => {
    const two = mergeAdvisories([[adv({ id: "A", pkg: "a", fixed: "1.2" })], [adv({ id: "B", aliases: ["A"], pkg: "b", fixed: null })]]);
    expect(two[0]).toMatchObject({ pkgs: ["a", "b"], fixed: null });
    const inp = input(ok("s", { kind: "advisories", items: two[0].items }));
    expect(findings("/r", inp, MAINT_DEFAULTS, NOW)[0].detail, "never b's fix, never 'no fix'").toBe("a, b · Prototype pollution");
  });

  it("joins two rows a third one bridges", () => {
    const rows = mergeAdvisories([[adv({ id: "A", aliases: [] }), adv({ id: "B", aliases: [] })], [adv({ id: "C", aliases: ["A", "B"] })]]);
    expect(rows.map((r) => [r.id, r.aliases])).toEqual([["A", ["B", "C"]]]);
  });

  it("dedupes one vulnerability across every reporter's GHSA and CVE names, keeping the worst severity", () => {
    const rows = mergeAdvisories([
      [adv({ id: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-1234"], severity: "medium", tool: "t1" })],
      [adv({ id: "RUSTSEC-2026-0007", aliases: ["cve-2026-1234"], severity: "unknown", fixed: null, tool: "t2" })],
      [adv({ id: "CVE-2026-1234", aliases: [], severity: "critical", url: null, tool: "t3" })],
      [adv({ id: "GHSA-zzzz-zzzz-zzzz", aliases: ["CVE-2026-9999"], severity: "low", tool: "t1" })],
    ]);
    expect(rows.map((r) => [r.id, r.severity])).toEqual([["CVE-2026-1234", "critical"], ["GHSA-zzzz-zzzz-zzzz", "low"]]);
    expect(rows[0]).toMatchObject({ key: "CVE-2026-1234", aliases: ["GHSA-aaaa-bbbb-cccc", "RUSTSEC-2026-0007"], tools: ["t1", "t2", "t3"] });
    expect(rows[0].items.length, "every report stays behind the row").toBe(3);
    const c = cell("security", input(ok("a", { kind: "advisories", items: rows.flatMap((r) => r.items) })));
    expect(c, "counted once, at its worst").toMatchObject({ level: "bad", text: "1 critical · 1 low" });
  });

  it("keeps a rule firing in two places as two rows, and two reporters at one place as one", () => {
    const code = (o: Partial<Advisory>) => adv({ id: "js/sql-injection", kind: "code", pkg: null, ecosystem: null, version: null, fixed: null, ...o });
    const rows = mergeAdvisories([
      [code({ location: "src/db.js:42", severity: "high", tool: "t1" }), code({ location: "src/q.js:7", severity: "high", tool: "t1" })],
      [code({ location: "src/db.js:42", severity: "critical", tool: "t2" })],
    ]);
    expect(rows.map((r) => [r.key, r.severity, r.tools])).toEqual([
      ["js/sql-injection@src/db.js:42", "critical", ["t1", "t2"]], ["js/sql-injection@src/q.js:7", "high", ["t1"]],
    ]);
    const f = findings("/r", input(ok("s", { kind: "advisories", items: rows.flatMap((r) => r.items) })), MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.verb, x.text, x.detail]), "two rows, one line: a card folds a kind").toEqual([
      ["security:code", "fix", "2 code findings", "1 critical · 1 high · src/db.js:42, src/q.js:7"],
    ]);
    expect(f[0].detail, "code has no published fix to miss").not.toMatch(/fix/);
  });
});

describe("one line per kind, and the severity mix", () => {
  const dep = (id: string, severity: Advisory["severity"], ...pkgs: string[]) =>
    pkgs.map((pkg) => adv({ id, severity, pkg, summary: `${id} in ${pkg}`, fixed: null }));
  const four = [...dep("GHSA-d", "medium", "@vitest/mocker"), ...dep("GHSA-a", "high", "source-map-js"),
    ...dep("GHSA-b", "medium", "@vitest/mocker", "vitest"), ...dep("GHSA-c", "medium", "postcss")];
  const sec = (items: Advisory[], o: Partial<SourceReport> = {}) => input(ok("s", { kind: "advisories", items }, o));
  const lines = (inp: MaintInput) => findings("/r", inp, MAINT_DEFAULTS, NOW).filter((f) => f.facet === "security");

  it("folds four advisories into one line at the worst level, packages deduped worst first", () => {
    expect(lines(sec(four)).map((f) => [f.key, f.level, f.verb, f.text, f.detail, f.ref])).toEqual([[
      "security:dependency", "bad", "patch", "4 advisories", "1 high · 3 medium · source-map-js, @vitest/mocker, vitest …", "dependency",
    ]]);
    expect(cell("security", sec(four))).toMatchObject({ level: "bad", text: "1 high · 3 med" });
    expect(lines(sec(four, { truncated: true }))[0].text, "a capped list is a floor").toBe("4+ advisories");
  });

  it("still reads one advisory as it always did", () => {
    expect(lines(sec([adv()])).map((f) => [f.text, f.detail])).toEqual([["high advisory", "lodash · fixed in 4.17.21 · Prototype pollution"]]);
  });

  it("names the two worst buckets in the cell, coloured by the worst", () => {
    const of = (...s: Advisory["severity"][]) => cell("security", sec(s.map((severity, i) => adv({ id: `X-${i}`, severity }))));
    expect(of("critical", "critical")).toMatchObject({ level: "bad", text: "2 critical" });
    expect(of("low", "critical", "high", "critical")).toMatchObject({ level: "bad", text: "2 critical · 1 high" });
    expect(of("medium", "unknown", "unknown")).toMatchObject({ level: "warn", text: "1 med · 2 unknown" });
    // An unrated advisory is still one: never the grey dot, never muted, as loud as low.
    expect(of("unknown")).toMatchObject({ level: "info", text: "1 unknown" });
    expect(of("unknown", "low")).toMatchObject({ level: "info", text: "1 low · 1 unknown" });
    const secret = adv({ id: "K", kind: "secret", pkg: null, severity: "unknown", location: "a.env" });
    expect(cell("security", sec([adv({ severity: "medium" }), secret]))).toMatchObject({ level: "bad", text: "1 secret · 1 med" });
  });

  it("folds code, config and secret findings the same way, one line per kind", () => {
    const at = (kind: Advisory["kind"], id: string, location: string, severity: Advisory["severity"] = "unknown") =>
      adv({ id, kind, location, severity, pkg: null, ecosystem: null, version: null, fixed: null });
    const inp = sec([at("code", "r1", "a.ts:1", "high"), at("code", "r2", "b.ts:2", "low"), at("config", "c1", "Dockerfile:3", "medium"),
      at("secret", "k1", "seed.ts"), at("secret", "k2", ".env")]);
    expect(lines(inp).map((f) => [f.key, f.level, f.verb, f.text, f.detail])).toEqual([
      ["security:code", "bad", "fix", "2 code findings", "1 high · 1 low · a.ts:1, b.ts:2"],
      ["security:secret", "bad", "rotate", "2 secrets reported", "seed.ts, .env"],
      ["security:config", "warn", "fix", "medium misconfiguration", "Dockerfile:3 · Prototype pollution"],
    ]);
  });

  it("makes a count a floor only for the kinds a capped source reported", () => {
    const secret = adv({ id: "K", kind: "secret", pkg: null, location: "seed.ts", summary: "API key" });
    const inp = input(ok("deps", { kind: "advisories", items: four }, { truncated: true }), ok("sec", { kind: "advisories", items: [secret] }));
    expect(lines(inp).map((f) => [f.key, f.text, f.detail])).toEqual([
      ["security:dependency", "4+ advisories", "1+ high · 3+ medium · source-map-js, @vitest/mocker, vitest …"],
      ["security:secret", "secret reported", "seed.ts · API key"],
    ]);
    // One row from a capped source is still a floor: the cap hid how many more of its kind there are.
    const mixed = sec([adv({ id: "r1", kind: "code", pkg: null, location: "a.ts:1" }), ...four], { truncated: true });
    expect(lines(mixed).find((f) => f.key === "security:code")!.text).toBe("1+ code findings");
  });

  it("folds every red workflow into one CI line, oldest first, while Today keeps a row each", () => {
    const inp = input(ok(GHA, ci(run("lint", "fail", S - D), run("build", "fail", S - 3 * D), run("e2e", "fail", S - 2 * H), run("site", "pass", S))));
    const f = findings("/r", inp, MAINT_DEFAULTS, NOW).filter((x) => x.facet === "ci");
    expect(f.map((x) => [x.key, x.level, x.verb, x.text, x.detail, x.ref])).toEqual([
      ["ci", "bad", "fix", "3 workflows failing", "build 3d, lint 1d, e2e 2h on main", null],
    ]);
    expect(ciRows(inp, undefined, NOW).map((r) => r.key)).toEqual(["ci:build", "ci:lint", "ci:e2e"]);
  });
});

describe("findings → verbs", () => {
  const inp = input(
    ok(GHA, ci(run("e2e", "fail", S - 2 * D), run("e2e", "pass", S - 3 * D))),
    ok("s", { kind: "advisories", items: [adv({ id: "A", severity: "critical" }), adv({ id: "K", kind: "secret", pkg: null, location: "seed.ts" })] }),
    ok("d", prs(1, {}, "fail")),
    ok("t", rel({ since: 40 })),
    ok("g", hyg({ unpushed: 2, merged: ["old"] })),
    ok("h", { kind: "probes", items: [
      { name: "api", url: "https://api.example", code: 502, ms: null, certNotAfter: null, err: null },
      { name: "app", url: "https://app.example", code: 200, ms: 90, certNotAfter: S + 5 * D, err: null },
    ] }),
  );
  const fs = findings("/r", inp, MAINT_DEFAULTS, NOW);

  it("gives every finding the verb that answers it, worst first", () => {
    expect(fs.map((f) => [f.key, f.level, f.verb])).toEqual([
      ["ci", "bad", "fix"], ["security:dependency", "bad", "patch"], ["security:secret", "bad", "rotate"], ["prod:api", "bad", "fix"],
      ["deps:b", "warn", "review"], ["release", "warn", "release"], ["git:unpushed", "warn", "push"], ["prod:cert:app", "warn", "fix"],
      ["git:tidy", "info", "tidy"],
    ]);
    expect(fs.every((f) => f.root === "/r")).toBe(true);
    expect(fs.find((f) => f.key === "security:dependency")).toMatchObject({ source: "s", ref: "dependency", text: "critical advisory" });
  });

  it("finds nothing in a facet that is off or a source that is skipped", () => {
    const off = { ...inp, det: { ...inp.det!, config: { ...inp.det!.config, off: ["ci"] } }, skip: ["s"] };
    const keys = findings("/r", off, MAINT_DEFAULTS, NOW).map((f) => f.facet);
    expect(keys).not.toContain("ci");
    expect(keys).not.toContain("security");
  });
});

describe("bands and rank", () => {
  const c = (...levels: ReturnType<typeof cell>["level"][]) => levels.map((level) => ({ ...cell("ci", input()), level }));
  it("colours only what needs you; a card still being read is not quiet", () => {
    expect(projectBand(c("ok", "warn", "bad"))).toBe("needs");
    expect(projectBand(c("ok", "warn", "unread"))).toBe("drifting");
    expect(projectBand(c("ok", "muted", "unread"))).toBe("unread");
    expect(projectBand(c("ok", "muted", "info"))).toBe("quiet");
  });

  it("ranks worst first and ends on the path, so a repaint never reorders", () => {
    const f = (level: Finding["level"]) => ({ level }) as Finding;
    const rows = [
      { path: "/q", band: "quiet" as const, findings: [] },
      { path: "/b", band: "needs" as const, findings: [f("bad")] },
      { path: "/a", band: "needs" as const, findings: [f("bad")] },
      { path: "/c", band: "needs" as const, findings: [f("bad"), f("bad")] },
      { path: "/d", band: "drifting" as const, findings: [f("warn")] },
      { path: "/u", band: "unread" as const, findings: [] },
    ];
    const once = rankMaint(rows).map((r) => r.path);
    expect(once).toEqual(["/c", "/a", "/b", "/d", "/u", "/q"]);
    expect(rankMaint([...rows].reverse()).map((r) => r.path)).toEqual(once);
    expect(rows[0].path, "a copy, never in place").toBe("/q");
  });

  it("opens each facet's tab", () => {
    expect(FACET_TAB).toEqual({ ci: "delivery", release: "delivery", security: "security", deps: "security", git: "code", prod: "servers", work: "work" });
  });
});

describe("the cross-project tabs", () => {
  const gh = { kind: "github", host: "github.com", path: "o/r", by: "table" as const };
  const on = (root: string, ...reps: SourceReport[]): MaintInput =>
    ({ ...input(...reps), det: det(reps.map((r) => r.source), { repoRoot: root, forge: gh }) });
  const work = (o: Partial<Extract<Facts, { kind: "work" }>> = {}): Facts => ({ kind: "work", issues: 3, prs: 1, reviewRequested: 0, ...o });

  it("sends every facet to exactly one tab, and every tab is some facet's", () => {
    for (const f of FACETS) expect(MAINT_TABS, f).toContain(FACET_TAB[f]);
    expect(new Set(Object.values(FACET_TAB))).toEqual(new Set(MAINT_TABS));
    expect(Object.keys(FACET_TAB).sort()).toEqual([...FACETS].sort());
  });

  it("gives the Work cell's amber a line, and lists open work only in the tab", () => {
    const inp = on("/r", ok("w", work({ reviewRequested: 2 })));
    expect(findings("/r", inp, MAINT_DEFAULTS, NOW).map((f) => [f.key, f.level, f.verb])).toEqual([["work:review", "warn", "review"]]);
    const open = (i: MaintInput) => tabExtras("/r", i, MAINT_DEFAULTS, NOW).filter((x) => x.facet === "work").map((x) => [x.key, x.text]);
    expect(open(inp)).toEqual([["work:open", "3 open issues · 1 open pull request"]]);
    expect(open(on("/r", ok("w", work({ issues: 0, prs: 0 }))))).toEqual([]);
  });

  it("offers Set up only where nothing could ever have read the facet", () => {
    const keys = (inp: MaintInput) => tabExtras("/r", inp, MAINT_DEFAULTS, NOW).map((f) => [f.key, f.verb]);
    const silentBot = ok("d", prs(0, { configured: false }));
    expect(keys(on("/r", silentBot))).toEqual([["ci:setup", "setup"], ["deps:setup", "setup"]]);
    expect(keys(on("/r", ok("d", prs(0))))).toEqual([["ci:setup", "setup"]]); // configured: silent, not absent
    const marked = { ...on("/r", silentBot) };
    marked.det = { ...marked.det!, markers: [{ facet: "ci", label: "Jenkins", found: ["Jenkinsfile"] }] };
    expect(keys(marked), "a CI we cannot read is not a missing one").toEqual([["deps:setup", "setup"]]);
    const local = { ...on("/r", silentBot) };
    local.det = { ...local.det!, forge: { kind: "none", host: null, path: null, by: "none" } };
    expect(keys(local), "nowhere to run it").toEqual([]);
    expect(keys({ det: null, reports: {} }), "unread is never none").toEqual([]);
  });

  it("answers every row's verb: an agent's verb has a brief, from the facts alone", () => {
    const inp = on("/r",
      ok(GHA, ci(run("e2e", "fail", S - 2 * D))),
      ok("s", { kind: "advisories", items: [adv()] }), ok("d", prs(2)), ok("t", rel({ since: 3 })),
      ok("g", hyg({ unpushed: 1, merged: ["x"] })), ok("w", work({ reviewRequested: 1 })),
    );
    const rows = tabFindings("/r", inp, MAINT_DEFAULTS, NOW);
    expect(rows.length).toBeGreaterThan(6);
    for (const f of rows.filter((x) => !["review", "fetch", "run"].includes(x.verb))) {
      expect(briefFor(f, inp, { project: "r", verify: [], now: NOW }), f.key).not.toBeNull();
    }
    const setup = tabFindings("/r", on("/r"), MAINT_DEFAULTS, NOW).find((f) => f.key === "ci:setup")!;
    expect(briefFor(setup, on("/r"), { project: "r", verify: [], now: NOW })).toContain("no CI");
    const bare = on("/r", ok("d", prs(0, { configured: false })));
    const bot = tabFindings("/r", bare, MAINT_DEFAULTS, NOW).find((f) => f.key === "deps:setup")!;
    expect(briefFor(bot, bare, { project: "r", verify: [], now: NOW })).toContain("no update bot");
  });

  const f = (root: string, facet: Finding["facet"], level: Finding["level"], key: string): Finding =>
    ({ root, facet, level, key, text: key, detail: "", verb: "fix", source: "s", ref: null });
  const all = [
    f("/b", "ci", "bad", "ci:x"), f("/a", "release", "warn", "release"), f("/a", "ci", "bad", "ci:y"),
    f("/a", "ci", "bad", "ci:x"), f("/c", "ci", "info", "ci:setup"), f("/a", "git", "warn", "git:unpushed"),
    f("/b", "security", "bad", "security:A"),
  ];

  it("keeps a tab's own facets, worst first, ending on the path and the key, whatever order they came in", () => {
    const once = tabRows("delivery", all).map((r) => `${r.root} ${r.key}`);
    expect(once).toEqual(["/a ci:x", "/a ci:y", "/b ci:x", "/a release", "/c ci:setup"]);
    expect(tabRows("delivery", [...all].reverse()).map((r) => `${r.root} ${r.key}`)).toEqual(once);
    expect(all[0].root, "a copy, never in place").toBe("/b");
  });

  it("narrows to one project when a cell asked for it", () => {
    expect(tabRows("delivery", all, "/a").map((r) => r.key)).toEqual(["ci:x", "ci:y", "release"]);
    expect(tabRows("delivery", all, "/nowhere")).toEqual([]);
  });

  it("counts each tab's red and amber rows with its worst, over the filter, and a muted tab shows no number", () => {
    expect(tabTally(all)).toEqual({
      security: { n: 1, level: "bad" }, delivery: { n: 4, level: "bad" }, code: { n: 1, level: "warn" },
      servers: { n: 0, level: null }, work: { n: 0, level: null },
    });
    expect(tabTally(all, "/c").delivery, "an info row is listed, not counted").toEqual({ n: 0, level: null });
    expect(needsCount(all)).toBe(6);
  });

  it("counts a folded kind once in a tab and its badge, however many rows are behind it", () => {
    const items = [adv({ id: "A", severity: "high" }), adv({ id: "B", severity: "medium", pkg: "postcss" }),
      adv({ id: "C", severity: "medium", pkg: "vitest" }), adv({ id: "K", kind: "secret", pkg: null, location: "seed.ts" })];
    const rows = tabFindings("/a", input(ok("s", { kind: "advisories", items })), MAINT_DEFAULTS, NOW);
    expect(tabRows("security", rows).filter((f) => f.facet === "security").map((f) => [f.key, f.text]))
      .toEqual([["security:dependency", "3 advisories"], ["security:secret", "secret reported"]]);
    expect(tabTally(rows).security).toEqual({ n: 2, level: "bad" });
  });

  // A lockfile project on GitHub: Dependabot answered, npm audit and OSV.dev were never clicked.
  const offering = (root: string, ...extra: SourceReport[]): MaintInput => {
    const reps = [ok("dependabot-alerts", { kind: "advisories", items: [adv()] }),
      { ...not("npm-audit", "security", { state: "notRun" }), cost: "tool" as const },
      { ...not("osv", "security", { state: "notRun" }), cost: "public" as const }, ...extra];
    const forge = { kind: "none", host: null, path: null, by: "none" } as const; // no Set up rows beside them
    return { det: det(reps.map((r) => r.source), { repoRoot: root, forge }), reports: Object.fromEntries(reps.map((r) => [r.source, r])) };
  };

  it("keeps a never-run source out of every finding, row and count: it is an offer", () => {
    const inp = offering("/a"), rows = tabFindings("/a", inp, MAINT_DEFAULTS, NOW);
    expect(tabRows("security", rows).map((f) => f.key)).toEqual(["security:dependency"]);
    expect(rows.some((f) => f.verb === "run")).toBe(false);
    expect(tabTally(rows).security).toEqual({ n: 1, level: "bad" });
    expect(offers("/a", inp).map((f) => [f.key, f.verb, f.text])).toEqual([
      ["run:npm-audit", "run", "npm audit: not run"], ["run:osv", "run", "OSV.dev: not checked"],
    ]);
    expect(offers("/a", { ...inp, skip: ["osv"] }).map((f) => f.key), "skipped here is not offered").toEqual(["run:npm-audit"]);
    const ran = { ...inp, reports: { ...inp.reports, "npm-audit": ok("npm-audit", { kind: "advisories", items: [] }) } };
    expect(offers("/a", ran).map((f) => f.key), "asked once is no longer an offer").toEqual(["run:osv"]);
  });

  describe("Coverage, by reason across projects", () => {
    const hub = (path: string) => ({ kind: "github", host: "github.com", path, by: "table" as const });
    // A GitHub project whose Dependabot alerts are off, with npm audit offered beside them.
    const switchedOff = (root: string, path: string | null = `o/${root.slice(1)}`, o: Partial<MaintInput> = {}): MaintInput => {
      const reps = [not("dependabot-alerts", "security", { state: "off", reason: "Dependabot alerts are switched off for this repository" }),
        { ...not("npm-audit", "security", { state: "notRun" }), cost: "tool" as const }];
      return { det: det(reps.map((r) => r.source), { repoRoot: root, forge: path ? hub(path) : { kind: "gitlab", host: "gitlab.com", path: "g/r", by: "table" } }),
        reports: Object.fromEntries(reps.map((r) => [r.source, r])), ...o };
    };
    const scope = (root: string): MaintInput => {
      const r = not("dependabot-alerts", "security", { state: "noAccess", reason: `who is ${root}`, fix: "gh auth refresh -s security_events" });
      return { det: det([r.source], { repoRoot: root, forge: hub(`o${root}`) }), reports: { [r.source]: r } };
    };
    const at = (path: string, inp: MaintInput) => ({ path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) });

    it("groups by source and reason, not by project, widest first, with the one action that fixes it", () => {
      const projects = [at("/c", switchedOff("/c")), at("/a", switchedOff("/a")), at("/b", switchedOff("/b")), at("/d", scope("/d")), at("/e", scope("/e"))];
      const g = coverGroups("security", projects, null, NOW);
      expect(g.map((x) => [x.what, x.why, x.roots])).toEqual([
        ["Dependabot alerts", "alerts off", ["/a", "/b", "/c"]],
        ["npm audit", "not run", ["/a", "/b", "/c"]],
        ["Dependabot alerts", "token scope", ["/d", "/e"]],
      ]);
      expect(g[0].action).toEqual({ kind: "settings", urls: {
        "/a": "https://github.com/o/a/settings/security_analysis", "/b": "https://github.com/o/b/settings/security_analysis",
        "/c": "https://github.com/o/c/settings/security_analysis" } });
      expect(g[1].action).toEqual({ kind: "run", source: "npm-audit" });
      expect(g[2].action, "an account in the reason never splits a row").toEqual({ kind: "fix", fix: "gh auth refresh -s security_events" });
      expect(g.every((x) => !x.quiet)).toBe(true);
    });

    it("keeps every project's link when the first one listed has none", () => {
      const g = coverGroups("security", [at("/b", switchedOff("/b", null)), at("/a", switchedOff("/a"))], null, NOW)[0];
      expect(g.action).toEqual({ kind: "settings", urls: { "/a": "https://github.com/o/a/settings/security_analysis" } });
    });

    it("merges failed reads whatever each said, and says a source skipped here", () => {
      const failed = (root: string, reason: string): MaintInput => {
        const r = not("dependabot-alerts", "security", { state: "error", reason });
        return { det: det([r.source], { repoRoot: root, forge: hub(`o${root}`) }), reports: { [r.source]: r } };
      };
      const skipped = { ...scope("/s"), skip: ["dependabot-alerts"] };
      const g = coverGroups("security", [at("/a", failed("/a", "HTTP 502")), at("/b", failed("/b", "timed out")), at("/s", skipped)], null, NOW);
      expect(g.map((x) => [x.what, x.why, x.roots, x.action])).toEqual([
        ["Dependabot alerts", "read failed", ["/a", "/b"], null], ["Dependabot alerts", "skipped here", ["/s"], null],
      ]);
    });

    it("narrows to one project, and lists a project off the forge without a link it cannot name", () => {
      const projects = [at("/a", switchedOff("/a")), at("/b", switchedOff("/b", null))];
      expect(coverGroups("security", projects, "/b", NOW).map((x) => [x.what, x.roots, x.action])).toEqual([
        ["Dependabot alerts", ["/b"], null], ["npm audit", ["/b"], { kind: "run", source: "npm-audit" }],
      ]);
      const both = coverGroups("security", projects, null, NOW)[0];
      expect(both.roots).toEqual(["/a", "/b"]);
      expect(both.action).toEqual({ kind: "settings", urls: { "/a": "https://github.com/o/a/settings/security_analysis" } });
      expect(coverGroups("delivery", projects, null, NOW).filter((x) => x.facet === "security")).toEqual([]);
    });

    it("says a silent bot apart from what stops a check, and below it", () => {
      const old = (root: string) => on(root, ok("dependabot-prs", prs(1, { prs: [{ number: 1, title: "t", url: "u", branch: "b", draft: false, at: S - 40 * D, checks: "pass" }] })));
      const quiet = (root: string) => on(root, ok("dependabot-prs", prs(0, { configured: true })));
      const projects = [at("/a", old("/a")), at("/b", old("/b")), at("/c", quiet("/c")), at("/d", switchedOff("/d"))];
      expect(cell("deps", old("/a")).text).toBe("silent");
      const g = coverGroups("security", projects, null, NOW);
      expect(g.map((x) => [x.what, x.why, x.roots.length, x.quiet])).toEqual([
        ["Dependabot alerts", "alerts off", 1, false], ["npm audit", "not run", 1, false],
        ["Dependabot", "opened nothing in 30+ days", 2, true], ["Dependabot", "configured, no open pull request", 1, true],
      ]);
      expect(g.filter((x) => x.quiet).every((x) => x.action === null)).toBe(true);
    });

    it("explains every cell with no verdict, and never one that has a verdict", () => {
      const marked = { det: det([], { markers: [{ facet: "ci" as const, label: "Woodpecker", found: [".woodpecker.yml"] }] }), reports: {} };
      const never = on("/n", ok(GHA, ci()));
      const projects = [at("/m", marked), at("/n", never), at("/u", { det: null, reports: {} }), at("/a", on("/a", ok(GHA, ci(run("e2e", "pass", S - D)))))];
      const g = coverGroups("delivery", projects, null, NOW);
      expect(g.map((x) => [x.what, x.why, x.roots])).toEqual([
        ["CI", "never ran", ["/n"]], ["CI", "not read yet", ["/u"]], ["Woodpecker", "nothing reads it yet", ["/m"]], ["Release", "not read yet", ["/u"]],
      ]);
      expect(g.some((x) => x.roots.includes("/a")), "a verdict is not a coverage row").toBe(false);
      const quiet = at("/q", on("/q", ok("dependabot-alerts", { kind: "advisories", items: [] })));
      expect(coverGroups("security", [quiet], null, NOW), "a clean read leaves nothing to explain").toEqual([]);
    });

    it("names a settings page only from the manifest, for a forge path it can spell, none otherwise", () => {
      const A = "dependabot-alerts", page = "https://github.com/o/r/settings/security_analysis";
      expect(settingsUrl(A, hub("o/r"))).toBe(page);
      expect(settingsUrl(A, { kind: "github", host: "gh-work", path: "o/r", by: "table" }), "an ssh alias the table resolved").toBe(page);
      expect(settingsUrl(A, { kind: "github", host: "git.corp.example", path: "o/r", by: "pin" }), "a pinned host the page does not name").toBeNull();
      expect(settingsUrl(A, { kind: "gitlab", host: "gitlab.com", path: "g/r", by: "table" }), "a forge the source does not talk to").toBeNull();
      expect(settingsUrl("gitlab-ci", { kind: "gitlab", host: "gitlab.com", path: "g/r", by: "table" }), "a source with no page").toBeNull();
      expect(settingsUrl("npm-audit", hub("o/r"))).toBeNull();
      expect(settingsUrl(A, { kind: "github", host: "github.acme.io", path: "o/r", by: "name" }), "a host only its name decided").toBeNull();
      expect(settingsUrl(A, hub("o/r/../../evil"))).toBeNull();
      expect(settingsUrl(A, hub("../.."))).toBeNull();
      expect(settingsUrl(A, hub("./r"))).toBeNull();
      expect(settingsUrl(A, hub("o r/x"))).toBeNull();
      expect(settingsUrl(A, null)).toBeNull();
    });

    it("carries the settings link onto the project's Coverage card, only for a forge switch that is off", () => {
      const rows = coverRows(switchedOff("/a"));
      expect(rows.find((r) => r.source === "dependabot-alerts")).toMatchObject({ state: "off", url: "https://github.com/o/a/settings/security_analysis" });
      expect(rows.find((r) => r.source === "npm-audit")?.url).toBeNull();
      expect(coverRows(switchedOff("/a", null)).find((r) => r.source === "dependabot-alerts")?.url).toBeNull();
      expect(coverRows(scope("/d")).find((r) => r.source === "dependabot-alerts")).toMatchObject({ fix: "gh auth refresh -s security_events", url: null });
    });

    // Code scanning off is a workflow nobody wrote yet: Set up, on the forge that offers it only.
    const noScan = (root: string, forge = hub(`o${root}`), o: Partial<MaintInput> = {}): MaintInput => {
      const r = not("github-code-scanning", "security", { state: "off", reason: "no analysis found" });
      return { det: det([r.source], { repoRoot: root, forge }), reports: { [r.source]: r }, ...o };
    };

    it("offers Set up for code scanning switched off, and never as a finding", () => {
      const s = coverSetups("/a", noScan("/a"));
      expect(s.map((f) => [f.key, f.verb, f.facet, f.source, f.ref])).toEqual([["setup:github-code-scanning", "setup", "security", "github-code-scanning", "sec.code"]]);
      expect(tabFindings("/a", noScan("/a"), MAINT_DEFAULTS, NOW).some((f) => f.facet === "security"), "not a To do row").toBe(false);
      expect(coverSetups("/a", noScan("/a", { kind: "gitlab", host: "gitlab.com", path: "g/r", by: "table" })), "a forge it does not talk to").toEqual([]);
      expect(coverSetups("/a", noScan("/a", undefined, { skip: ["github-code-scanning"] }))).toEqual([]);
      const off = noScan("/a");
      off.det!.config.off = ["security"];
      expect(coverSetups("/a", off), "a facet switched off").toEqual([]);
      const read = { ...noScan("/a"), reports: { "github-code-scanning": ok("github-code-scanning", { kind: "advisories", items: [] }) } };
      expect(coverSetups("/a", read), "a read that answered").toEqual([]);
      expect(coverSetups("/a", switchedOff("/a")), "Dependabot alerts off is a switch, not a workflow").toEqual([]);
    });

    it("puts Set up on the code-scanning row of a narrowed tab's Coverage", () => {
      const p = (path: string) => { const inp = noScan(path), cells = facetCells(inp, MAINT_DEFAULTS, NOW); return { path, inp, cells, rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) }; };
      const m = tabModel("security", [p("/a"), p("/b")], "/b", null, NOW);
      expect(m.setups.map((f) => [f.root, f.key])).toEqual([["/b", "setup:github-code-scanning"]]);
      expect(m.cover.map((g) => [g.what, g.source, g.cfg])).toEqual([["GitHub code scanning", "github-code-scanning", false]]);
      expect(tabModel("delivery", [p("/a")], "/a", null, NOW).setups).toEqual([]);
    });

    it("knows which Coverage reasons a [maintenance] key answers", () => {
      expect(setupKeyOf("no default branch known: set [maintenance] trunk")).toBe("trunk");
      expect(setupKeyOf('failed: [maintenance] trunk "dvel" names no commit here')).toBe("trunk");
      expect(setupKeyOf('failed: tag_pattern "v[0-9]*": only * is special here')).toBe("tag_pattern");
      expect(setupKeyOf("no file matches [maintenance] sarif: out/*.sarif")).toBe("sarif");
      expect(setupKeyOf("forge unknown: pin [maintenance] forge"), "the forge pin is a person's").toBeNull();
      expect(setupKeyOf("Dependabot alerts are switched off")).toBeNull();
      const rs = /const SETUP_KEYS: &\[&str\] = &\[([^\]]*)\]/.exec(readFileSync(new URL("../src-tauri/src/maint.rs", import.meta.url), "utf8"));
      expect(rs?.[1].split(",").map((k) => k.trim().replace(/"/g, "")), "maint.rs's list").toEqual([...SETUP_KEYS]);
      const tags = not("git-tags", "release", { state: "unsupported", reason: "no remote, so no default branch: set [maintenance] trunk" });
      const local = ok("git-local", { kind: "hygiene", trunk: null, unpushed: null, localOnly: [], merged: [], gone: [], branches: [], worktrees: [], fetchedAt: null },
        { gaps: ["merged branches not read: no remote, so no default branch: set [maintenance] trunk"] });
      const rows = coverRows({ det: det(["git-tags", "git-local"]), reports: { "git-tags": tags, "git-local": local } });
      expect(rows.filter((r) => r.cfg).map((r) => [r.source, r.text])).toEqual([
        ["git-tags", "no remote, so no default branch: set [maintenance] trunk"],
        ["git-local", "read; merged branches not read: no remote, so no default branch: set [maintenance] trunk"],
      ]);
      const g = coverGroups("delivery", [{ path: "/r", inp: { det: det(["git-tags"]), reports: { "git-tags": tags } }, cells: facetCells({ det: det(["git-tags"]), reports: { "git-tags": tags } }, MAINT_DEFAULTS, NOW) }], "/r", NOW);
      expect(g.find((x) => x.source === "git-tags")?.cfg).toBe(true);
    });
  });

  it("says what an empty tab read and what it could not, never an all-clear over nothing", () => {
    const card = (path: string, inp: MaintInput) => ({ path, cells: facetCells(inp, MAINT_DEFAULTS, NOW) });
    const cards = [
      card("/b", { det: null, reports: {} }),
      card("/a", on("/a", ok(GHA, ci(run("e2e", "pass", S - D))), not("t", "release", { state: "error", reason: "x" }))),
    ];
    expect(tabGaps("delivery", cards)).toEqual({ read: 1, unset: 0 });
    expect(tabGaps("delivery", cards, "/b").read).toBe(0);
    expect(tabGaps("servers", cards, "/a"), "no deploy is a fact, not a gap").toEqual({ read: 0, unset: 1 });
  });

  it("counts a cell that does not know as a gap, never as read", () => {
    const card = (path: string, inp: MaintInput) => ({ path, cells: facetCells(inp, MAINT_DEFAULTS, NOW) });
    const unknown = [card("/a", on("/a", ok("w", work({ issues: 0, prs: 0, reviewRequested: null }))))];
    expect(tabGaps("work", unknown)).toEqual({ read: 0, unset: 0 });
    const never = [card("/a", on("/a", ok(GHA, ci())))];
    expect(tabGaps("delivery", never)).toEqual({ read: 0, unset: 0 });
    const bare = [card("/a", on("/a", ok("d", prs(0, { configured: false }))))];
    expect(tabGaps("security", bare), "no bot found is the facet's none").toEqual({ read: 0, unset: 1 });
  });
});

describe("runtime end-of-life", () => {
  const rt = (name: string, cycle: string | null, eol: Runtime["eol"], o: Partial<Runtime> = {}): Runtime => ({
    product: name, name, declared: cycle ?? "99", cycle, eol, latest: null, newest: null, file: ".nvmrc", url: `https://eol.example/${name}`, ...o,
  });
  const eol = (...items: Runtime[]) => ok("runtime-eol", { kind: "runtimes", items }, { cost: "public" });
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const ended = rt("node", "18", S - 540 * D, { newest: "26" });

  it("narrows the wire's runtimes, and refuses an end that is neither a date nor a yes or no", () => {
    const r = wire.reports.find((x) => (x.facts as Facts | null)?.kind === "runtimes")!;
    expect(narrowMaint(r, "runtime-eol")).toEqual(r);
    const items = (r.facts as Extract<Facts, { kind: "runtimes" }>).items;
    expect(items.map((x) => x.eol), "a date, a bare yes, and unknown").toEqual([1_745_971_200, true, null]);
    expect(narrowMaint({ ...r, facts: { kind: "runtimes", items: [{ ...items[0], eol: "2025-04-30" }] } }, "runtime-eol").coverage.state).toBe("error");
  });

  it("walks the ladder: ended is red, ending soon amber, supported the dot, and unknown never green", () => {
    const sec = (...items: Runtime[]) => cell("security", input(eol(...items)));
    expect(sec(ended)).toMatchObject({ level: "bad", text: "node 18 EOL" });
    expect(sec(rt("node", "3", true))).toMatchObject({ level: "bad", text: "node 3 EOL" });
    expect(sec(rt("node", "20", S + 52 * D))).toMatchObject({ level: "warn", text: "node 20 EOL in 52d" });
    const fine = [rt("node", "24", S + 400 * D), rt("go", "1.27", false)];
    expect(sec(...fine), "a supported runtime vouches for no advisory").toMatchObject({ state: "read", level: "muted", text: "advisories not read" });
    const alerts = (...items: Advisory[]) => ok("dependabot-alerts", { kind: "advisories", items });
    expect(cell("security", input(alerts(), eol(...fine)))).toMatchObject({ level: "ok", text: "" });
    const scope = not("dependabot-alerts", "security", { state: "noAccess", reason: "token lacks security_events", fix: "gh auth refresh -s security_events" });
    expect(cell("security", input(scope, eol(...fine))), "a click on endoflife.date never turns can't-check into the dot")
      .toMatchObject({ state: "cantCheck", level: "muted", text: "token scope", fix: "gh auth refresh -s security_events" });
    expect(sec(rt("postgres", null, null))).toMatchObject({ level: "muted", text: "postgres 99 unknown" });
    expect(sec(rt("node", "24", null)), "a listed cycle with no end given").toMatchObject({ level: "muted", text: "node 24 unknown" });
    expect(sec(ended, rt("python", "3.9", S - 330 * D)), "two ended").toMatchObject({ level: "bad", text: "2 runtimes EOL" });
    const near = input(alerts(), eol(rt("node", "20", S + 52 * D)));
    expect(facetCell("security", near, clampMaint({ eol_warn_days: 30 }), NOW), "the threshold is the team's").toMatchObject({ level: "ok" });
    expect(clampMaint({ eol_warn_days: 0 }).eolWarnDays).toBe(90);
    // A toolchain pinned below the newest is a choice, not an ended runtime: no red, no line, no date.
    const pin = rt("rust", "1.98", S - 27 * D, { newest: "1.99" });
    expect(cell("security", input(alerts(), eol(pin)))).toMatchObject({ level: "ok", text: "" });
    expect(runtimeStates(input(eol(pin)), MAINT_DEFAULTS, NOW)[0]).toMatchObject({ level: "ok", text: "pinned, 1.99 is newest", left: null });
    expect(findings("/r", input(eol(pin)), MAINT_DEFAULTS, NOW)).toEqual([]);
    // Beside advisories at its level: a runtime past its end is as loud as a high advisory.
    expect(cell("security", input(alerts(adv({ severity: "medium" })), eol(ended)))).toMatchObject({ level: "bad", text: "node 18 EOL · 1 med" });
    expect(cell("security", input(alerts(adv()), eol(rt("node", "20", S + 52 * D))))).toMatchObject({ level: "bad", text: "1 high · node 20 EOL in 52d" });
    expect(cell("security", input(alerts(adv({ severity: "low" })), eol(rt("go", "1.27", false))))).toMatchObject({ level: "info", text: "1 low" });
    const never = { ...not("runtime-eol", "security", { state: "notRun" }), cost: "public" as const };
    expect(cell("security", input(never))).toMatchObject({ state: "cantCheck", text: "not checked" });
    expect(offers("/r", input(never)).map((f) => [f.key, f.text])).toEqual([["run:runtime-eol", "endoflife.date: not checked"]]);
  });

  it("folds every runtime to upgrade into one line, worst first, and leaves the supported ones out", () => {
    const line = (...items: Runtime[]) => findings("/r", input(eol(...items)), MAINT_DEFAULTS, NOW).map((f) => [f.key, f.level, f.text, f.detail, f.verb]);
    expect(line(ended, { ...ended, file: "Dockerfile" }, rt("go", "1.27", false))).toEqual([
      ["security:runtime", "bad", "node 18 ended 18mo ago", "from .nvmrc, Dockerfile · newest 26", "upgrade"],
    ]);
    expect(line(rt("postgres", "14", S + 20 * D), rt("python", "3.9", S - 330 * D), ended, rt("node", "26", S + 900 * D))).toEqual([
      ["security:runtime", "bad", "3 runtimes to upgrade", "node 18 ended 18mo ago, python 3.9 ended 11mo ago, postgres 14 ends in 20d", "upgrade"],
    ]);
    expect(line(rt("postgres", "14", S + 20 * D))[0].slice(1, 3)).toEqual(["warn", "postgres 14 ends in 20d"]);
    expect(line(rt("node", "26", S + 900 * D), rt("x", null, null)), "fine and unknown are no line").toEqual([]);
    expect(findingTarget({ facet: "security", key: "security:runtime" })).toEqual({ tab: "security", board: "runtimes" });
    expect([longSpan(3 * D), longSpan(59 * D), longSpan(60 * D), longSpan(800 * D)]).toEqual(["3d", "59d", "2mo", "2y"]);
  });

  it("lays its board out per project and cycle, the nearest end first, the project's Upgrade on each row it covers", () => {
    const ps = [
      tp("/b", eol(rt("postgres", "14", S + 20 * D, { file: "compose.yml" }), rt("node", "24", S + 400 * D))),
      tp("/a", eol(ended, { ...ended, file: "Dockerfile", declared: "18.20.1" }, rt("go", "1.27", false, { file: "go.mod" }))),
    ];
    const rows = eolBoard(ps, null, NOW);
    expect(rows.map((r) => [r.root, rtName(r), r.level, r.text, r.verb?.key ?? null])).toEqual([
      ["/a", "node 18", "bad", "ended 18mo ago", "security:runtime"], ["/b", "postgres 14", "warn", "ends in 20d", "security:runtime"],
      ["/b", "node 24", "ok", "ends in 13mo", null], ["/a", "go 1.27", "ok", "no end announced", null],
    ]);
    expect(rows[0].decls).toEqual([{ file: ".nvmrc", declared: "18" }, { file: "Dockerfile", declared: "18.20.1" }]);
    const b = tabBoards("security", ps, null, null, NOW);
    expect(b.eol).toEqual(rows);
    expect(b.drawn).toEqual(["/a|security:runtime", "/b|security:runtime"]);
    expect(b.advRead, "no advisory source answered, so no advisories board").toBe(0);
    expect(tabBoards("security", [...ps].reverse(), null, null, NOW).eol, "a repaint never reorders").toEqual(rows);
    expect(tabBoards("security", ps, "/b", null, NOW).eol.map((r) => r.root)).toEqual(["/b", "/b"]);
    expect(boardDoor("runtimes", "ends", rows[0].url)).toEqual({ to: "url", url: "https://eol.example/node" });
    expect(runtimeStates(ps[1].inp, MAINT_DEFAULTS, NOW).map(rtName), "worst first").toEqual(["node 18", "go 1.27"]);
  });

  it("lists a runtime reaching its end inside the window beside the certificates, and nothing already past", () => {
    const cert = ok("h", { kind: "probes", items: [{ name: "x", url: "https://x", code: 200, ms: 1, certNotAfter: S + 10 * D, err: null }] });
    const rows = comingUp([
      { root: "/a", inp: input(eol(rt("postgres", "14", S + 20 * D), ended, rt("node", "3", true), rt("go", "1.27", false))) },
      { root: "/b", inp: input(eol(rt("node", "20", S + 40 * D)), cert) },
    ], NOW);
    expect(rows.map((r) => [r.root, r.what, r.at])).toEqual([["/b", "certificate for x", S + 10 * D], ["/a", "postgres 14 end-of-life", S + 20 * D]]);
  });
});

describe("packages behind their newest major", () => {
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const deps = (...reps: SourceReport[]) => cell("deps", input(...reps));
  const notRun = { ...not("npm-registry", "deps", { state: "notRun" }), cost: "public" as const };

  it("narrows the wire's packages, and refuses one of the wrong shape", () => {
    const r = wire.reports.find((x) => (x.facts as { kind?: string } | null)?.kind === "packages")!;
    expect(narrowMaint(r, "npm-registry")).toEqual(r);
    const facts = r.facts as Extract<Facts, { kind: "packages" }>;
    expect(facts.items.map((p) => [p.name, p.latest, p.dev])).toEqual([["react", "19.2.0", false], ["lodash", "4.18.1", null], ["left-pad", null, true]]);
    const bad = (f: unknown) => narrowMaint({ ...r, facts: f }, "npm-registry").coverage.state;
    expect(bad({ ...facts, items: [{ ...facts.items[0], dev: "yes" }] })).toBe("error");
    expect(bad({ kind: "packages", items: [] }), "current counts the rest, so it is never missing").toBe("error");
  });

  it("counts majors behind: the minor below 1.0, the patch below 0.1, and a floor from 0.x to 1 or later", () => {
    const t: [string, string, { n: number; floor: boolean } | null][] = [
      ["17.0.2", "19.2.0", { n: 2, floor: false }], ["4.17.20", "4.18.1", { n: 0, floor: false }], ["0.9.0", "0.12.1", { n: 3, floor: false }],
      ["0.0.3", "0.0.5", { n: 2, floor: false }], ["0.9.4", "2.1.0", { n: 2, floor: true }], ["0.0.3", "0.2.0", { n: 2, floor: true }],
      ["2.0.0-rc.1", "2.0.0", { n: 0, floor: false }], ["1.0.0-beta.2", "3.1.0", { n: 2, floor: false }], ["3.0.0", "2.9.0", { n: 0, floor: false }],
      ["main", "2.0.0", null], ["1.0.0", "", null],
    ];
    for (const [a, b, want] of t) expect(majorsBehind(a, b), `${a} → ${b}`).toEqual(want);
    expect([majorsText({ majors: 1, floor: false }), majorsText({ majors: 2, floor: true }), majorsText({ majors: null, floor: false })])
      .toEqual(["1 major", "2+ majors", "? majors"]);
  });

  it("judges each package from its lowest installed copy, the most majors first, and counts the current ones", () => {
    const s = pkgStates(input(reg([
      pkg("react", ["18.2.0", "17.0.2"], "19.2.0"), pkg("vitest", ["1.6.0"], "4.1.0", { dev: true }), pkg("lodash", ["4.17.20"], "4.18.1"),
      pkg("tiny", ["0.9.0"], "2.1.0"), pkg("gone", [], null, { why: "from git" }), pkg("odd", ["main"], "1.0.0"), pkg("lost", ["1.0.0"], null),
    ], 5)));
    expect(s.behind.map((p) => [p.name, p.from, p.majors, p.floor])).toEqual([["vitest", "1.6.0", 3, false], ["react", "17.0.2", 2, false], ["tiny", "0.9.0", 2, true]]);
    expect(s.unplaced.map((p) => [p.name, unplacedWhy(p)])).toEqual([["gone", "from git"], ["lost", "no newest release"], ["odd", "a version that does not compare"]]);
    expect([s.current, s.majors, s.floor, s.capped]).toEqual([6, 7, true, false]);
    expect(pkgStates(input(reg([pkg("react", ["17.0.0"], "19.0.0")]))).floor, "all placed, no leap from 0.x: exact").toBe(false);
    expect(pkgStates(input(reg([], 3, { truncated: true })))).toMatchObject({ capped: true, floor: true, current: 3 });
  });

  it("says how many are behind at info, never amber however far, and the grey dot only when every one was placed", () => {
    const far = deps(reg([pkg("react", ["1.0.0"], "19.0.0"), pkg("vue", ["1.0.0"], "3.0.0")]));
    expect([far.state, far.level, far.text]).toEqual(["read", "info", "2 behind"]);
    expect(far.tip).toContain("react 1.0.0 → 19.0.0 · 18 majors");
    expect(deps(reg([pkg("lodash", ["4.17.20"], "4.18.1")], 9))).toMatchObject({ level: "ok", text: "" });
    expect(deps(reg([pkg("gone", [], null, { why: "from git" })], 9)), "unplaced is unknown, never the dot").toMatchObject({ level: "muted", text: "1 unplaced" });
    expect(deps(reg([], 9, { truncated: true })), "past the cap nothing vouches for the rest").toMatchObject({ level: "muted", text: "partly read" });
    expect(deps(reg([pkg("react", ["17.0.0"], "19.0.0")], 0, { truncated: true })).text).toBe("1+ behind");
    expect(projectBand(facetCells(input(reg([pkg("react", ["1.0.0"], "19.0.0")])), MAINT_DEFAULTS, NOW)), "a ranking, never drifting").toBe("quiet");
  });

  it("joins the update bots through worseOf: the worse kind speaks and both tips are kept", () => {
    const red = deps(ok("dependabot-prs", prs(2, {}, "fail")), reg([pkg("react", ["17.0.0"], "19.0.0")]));
    expect([red.level, red.text]).toEqual(["warn", "2 red"]);
    expect(red.tip.some((t) => t.startsWith("react 17.0.0 → 19.0.0")), "the packages are still in the tip").toBe(true);
    expect(deps(ok("dependabot-prs", prs(1)), reg([pkg("react", ["17.0.0"], "19.0.0")])).text, "a tie keeps the bots' words").toBe("1 PR");
    const old = prs(1, { prs: [{ number: 1, title: "x", url: "u", branch: "b", draft: false, at: S - 90 * D, checks: "pass" }] });
    const quiet = deps(ok("dependabot-prs", old), reg([pkg("react", ["17.0.0"], "19.0.0")]));
    expect([quiet.text, quiet.tip.some((t) => t.startsWith("newest PR 90d old"))], "what was found speaks over a muted kind, which keeps its tip").toEqual(["1 behind", true]);
  });

  it("never lets a registry read vouch for what it could not read: a bot, another registry or a marker", () => {
    const out = not("dependabot-prs", "deps", { state: "noTool", tool: "gh", fix: "gh auth login" });
    const failed = { ...not("crates-registry", "deps", { state: "error", reason: "HTTP 503" }), cost: "public" as const };
    const unasked = { ...not("crates-registry", "deps", { state: "notRun" }), cost: "public" as const };
    expect(deps(reg([], 12)), "alone and every one placed, the dot").toMatchObject({ state: "read", level: "ok", text: "" });
    expect(deps(out, reg([], 12)), "the bot's read failed").toMatchObject({ state: "cantCheck", text: "signed out", fix: "gh auth login" });
    expect(deps(reg([], 12), failed), "the other registry's did").toMatchObject({ state: "cantCheck", text: "read failed" });
    expect(deps(reg([], 12), unasked), "or nobody asked it").toMatchObject({ state: "cantCheck", text: "not checked" });
    expect(deps(out, reg([pkg("gone", [], null, { why: "from git" })], 1)), "an unknown is no answer either").toMatchObject({ state: "cantCheck", text: "signed out" });
    expect(deps(out, ok("renovate-prs", prs(0, { configured: false })), reg([], 2)), "nor is a bot nobody set up").toMatchObject({ state: "cantCheck", text: "signed out" });
    expect(deps(out, reg([pkg("react", ["17.0.0"], "19.0.0")])), "what it found speaks, and the fix stays").toMatchObject({ state: "read", level: "info", text: "1 behind", fix: "gh auth login" });
    const marked = (...reps: SourceReport[]): MaintInput => ({ ...input(...reps),
      det: det(reps.map((r) => r.source), { markers: [{ facet: "deps", label: "Renovate", found: ["renovate.json"] }] }) });
    expect(cell("deps", marked(reg([], 3))), "a marker nothing reads").toMatchObject({ state: "markers", level: "muted", text: "can't check (Renovate)" });
    expect(cell("deps", marked(reg([pkg("react", ["17.0.0"], "19.0.0")]))), "again what it found speaks").toMatchObject({ state: "read", level: "info", text: "1 behind" });
  });

  it("keeps a bot's answer from hiding what could not be placed, and vouches once both answered", () => {
    const up = ok("dependabot-prs", prs(0, { dashboard: 7 }));
    expect(deps(up, reg([], 5))).toMatchObject({ state: "read", level: "ok", text: "" });
    expect(deps(up, reg([pkg("gone", [], null, { why: "from git" })], 5))).toMatchObject({ level: "muted", text: "1 unplaced" });
    expect(deps(up, reg([], 5, { gaps: ["yarn.lock not read"] }))).toMatchObject({ level: "muted", text: "partly read" });
    expect(deps(ok("dependabot-prs", prs(0)), reg([pkg("gone", [], null)], 5)), "a tie keeps the bot's silence").toMatchObject({ level: "muted", text: "silent" });
  });

  it("reads a gap as a read cut short: a lockfile nobody read earns no dot and no exact count", () => {
    const gap = { gaps: ["web/pnpm-lock.yaml: lockfileVersion 5.4 not read"] };
    const c = deps(reg([], 3, gap));
    expect([c.level, c.text, c.tip[0]]).toEqual(["muted", "partly read", "a lockfile or a name could not be read"]);
    expect(c.tip, "the facet ladder names which").toContain(`npm registry: ${gap.gaps[0]}`);
    expect(deps(reg([pkg("react", ["17.0.0"], "19.0.0")], 0, gap)).text).toBe("1+ behind");
    expect(pkgStates(input(reg([], 3, gap)))).toMatchObject({ floor: true, partial: true, capped: false, gaps: gap.gaps });
    expect(findings("/r", input(reg([pkg("react", ["17.0.0"], "19.0.0")], 0, gap)), MAINT_DEFAULTS, NOW).find((f) => f.key === "deps:packages")?.text)
      .toBe("1+ packages a major or more behind");
    expect(packagesBoard([tp("/r", reg([], 3, gap))]).map((r) => [r.level, r.floor, r.majors, r.gaps])).toEqual([["muted", true, 0, gap.gaps]]);
  });

  it("claims update pull requests only of projects a bot was read for, whatever the registries answered", () => {
    const read = (...ps: TabProject[]) => { const b = tabBoards("security", ps, null, null, NOW); return [b.read.deps, b.pkgRead]; };
    expect(read(tp("/gl", reg([pkg("react", ["17.0.0"], "19.0.0")], 2))), "a registry is no update-PR read").toEqual([0, 1]);
    expect(read(tp("/gh", not("dependabot-prs", "deps", { state: "noAccess", reason: "no", fix: null }), reg([], 2))), "nor beside a bot that failed").toEqual([0, 1]);
    expect(read(tp("/gh", ok("dependabot-prs", prs(1)), reg([], 2)), tp("/gl", reg([], 2)))).toEqual([1, 2]);
    expect(tabBoards("delivery", [tp("/r", ok("github-actions", ci()))], null, null, NOW).read.ci, "the other facets count as before").toBe(1);
  });

  it("lists what a package count cannot answer in Coverage, and groups one reason across projects", () => {
    const rows = (...ps: TabProject[]) => coverGroups("security", ps, null, NOW).filter((g) => g.facet === "deps").map((g) => [g.key, g.why, g.quiet, g.roots.length, g.action?.kind ?? null]);
    const behind = reg([pkg("react", ["17.0.0"], "19.0.0")], 2);
    const out = not("dependabot-prs", "deps", { state: "noTool", tool: "gh", fix: "gh auth login" });
    expect(rows(tp("/a", out, behind)), "a failed bot keeps its row and fix").toEqual([["dependabot-prs|noTool|gh auth login", "signed out", false, 1, "fix"]]);
    expect(rows(tp("/a", out, reg([], 2))), "and beside a read with nothing behind").toEqual([["dependabot-prs|noTool|gh auth login", "signed out", false, 1, "fix"]]);
    const failed = { ...not("crates-registry", "deps", { state: "error", reason: "HTTP 503" }), cost: "public" as const };
    expect(rows(tp("/a", behind, failed)).map((r) => r[0]), "a failed registry beside one that answered").toEqual(["crates-registry|error|"]);
    const quiet = ok("dependabot-prs", prs(0));
    expect(rows(tp("/a", quiet)), "a silent bot, on its own").toEqual([["dependabot-prs|silent|configured, no open pull request", "configured, no open pull request", true, 1, null]]);
    expect(rows(tp("/a", quiet, behind)), "stays beside a package behind").toEqual(rows(tp("/a", quiet)));
    expect(rows(tp("/a", ok("dependabot-prs", prs(0, { configured: false })), behind)), "a bot nobody set up is Set up's, never a gap").toEqual([]);
    expect(rows(tp("/a", ok("dependabot-prs", prs(1)), behind)), "nothing to list").toEqual([]);
    const gone = (n: number) => reg(Array.from({ length: n }, (_, i) => pkg(`g${i}`, [], null, { why: "from git" })), 1);
    expect(rows(tp("/a", gone(1)), tp("/b", gone(2))), "the count is each project's own").toEqual([["deps|unplaced", "packages not placed", false, 2, null]]);
    expect(rows(tp("/a", reg([], 1, { truncated: true }))).map((r) => r[1])).toEqual(["partly read"]);
    const marked = (...reps: SourceReport[]): TabProject => {
      const inp = { ...input(...reps), det: det(reps.map((r) => r.source), { markers: [{ facet: "deps", label: "Renovate", found: ["renovate.json"] }] }) };
      return { path: "/m", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: [] };
    };
    expect(rows(marked(reg([], 2))).map((r) => r[0]), "a marker beside a clean read").toEqual(["marker:Renovate"]);
    expect(rows(marked(behind)).map((r) => r[0]), "and beside one that found something").toEqual(["marker:Renovate"]);
  });

  it("keeps the last known red when only a registry answered beside a failed bot read", () => {
    const deps1 = (s: ReturnType<typeof takeSnap>) => s.cells.find((c) => c.facet === "deps");
    const red = takeSnap("/r", input(ok("dependabot-prs", prs(2, {}, "fail"))), NOW - D * 1000), was = deps1(red)!;
    const behind = reg([pkg("react", ["17.0.0"], "19.0.0")], 2);
    const failed = input(not("dependabot-prs", "deps", { state: "noAccess", reason: "no", fix: null }), behind);
    expect(cell("deps", failed), "what it found is drawn").toMatchObject({ state: "read", level: "info", text: "1 behind" });
    const next = takeSnap("/r", failed, NOW, red);
    expect(deps1(next)).toMatchObject({ level: was.level, text: was.text, at: red.at });
    expect(next.findings.filter((f) => f.facet === "deps").map((f) => f.key)).toEqual(red.findings.filter((f) => f.facet === "deps").map((f) => f.key));
    expect(deps1(takeSnap("/r", input(ok("dependabot-prs", prs(1)), behind), NOW, red))?.at, "a bot that answered replaces it").toBeUndefined();
    expect(deps1(takeSnap("/r", input(behind), NOW, red))?.at, "as does a project with no bot to fail").toBeUndefined();
    const unasked = input(not("dependabot-prs", "deps", { state: "notRun" }), behind);
    expect(deps1(takeSnap("/r", unasked, NOW, red))?.at, "a bot nobody asked did not fail").toBeUndefined();
  });

  it("names a package line's fix branch off its key", () => {
    expect(fixBranch({ key: "deps:packages" })).toBe("maint/deps-packages");
  });

  it("keeps no update bot beside a registry nobody asked, and says it only in the tip beside packages that were read", () => {
    const none = ok("dependabot-prs", prs(0, { configured: false }));
    expect(deps(none, notRun)).toMatchObject({ state: "read", level: "muted", text: "no update bot" });
    const read = deps(none, reg([], 3));
    expect([read.level, read.text, read.tip.includes("no update bot")]).toEqual(["ok", "", true]);
    expect(deps(none, reg([pkg("react", ["17.0.0"], "19.0.0")]))).toMatchObject({ level: "info", text: "1 behind" });
  });

  it("asks Set up of the update bots alone, so a registry never takes it from a project nothing opens updates for", () => {
    const at = (kind: string, sources: string[], ...reps: SourceReport[]): MaintInput =>
      ({ ...input(...reps), det: det(sources, { forge: { kind, host: `${kind}.com`, path: "o/r", by: "table" } }) });
    const ids = (reps: SourceReport[]) => reps.map((r) => r.source);
    const setups = (i: MaintInput) => tabExtras("/r", i, MAINT_DEFAULTS, NOW).filter((f) => f.facet === "deps").map((f) => f.key);
    const gl = (...reps: SourceReport[]) => at("gitlab", ids(reps), ...reps), gh = (...reps: SourceReport[]) => at("github", ids(reps), ...reps);
    expect(cell("deps", gl(notRun)), "its only deps source never asked").toMatchObject({ state: "cantCheck", text: "not checked" });
    expect(setups(gl(notRun))).toEqual(["deps:setup"]);
    expect(setups(gl(reg([pkg("react", ["17.0.0"], "19.0.0")]))), "a registry read is no bot").toEqual(["deps:setup"]);
    expect(setups(gh(ok("dependabot-prs", prs(0)), reg([], 2))), "a configured bot is silent, not absent").toEqual([]);
    expect(setups(gh(ok("dependabot-prs", prs(0, { configured: false })), reg([], 2)))).toEqual(["deps:setup"]);
    expect(setups(at("github", ["dependabot-prs", "npm-registry"], reg([], 2))), "a bot read still out decides nothing").toEqual([]);
  });

  it("folds every package behind into one Upgrade line, the most first, and a capped count with a +", () => {
    const line = (...reps: SourceReport[]) => findings("/r", input(...reps), MAINT_DEFAULTS, NOW).filter((f) => f.facet === "deps")
      .map((f) => [f.key, f.level, f.verb, f.text, f.detail, f.ref, f.source]);
    expect(line(reg([pkg("react", ["17.0.2"], "19.2.0"), pkg("lodash", ["4.17.20"], "4.18.1")])))
      .toEqual([["deps:packages", "info", "upgrade", "react 2 majors behind", "react 17.0.2 → 19.2.0", "packages", "npm-registry"]]);
    expect(line(reg([pkg("tiny", ["0.9.0"], "2.1.0")]))[0][3]).toBe("tiny 2+ majors behind");
    const four = [pkg("a", ["1.0.0"], "2.0.0"), pkg("b", ["1.0.0"], "5.0.0"), pkg("c", ["1.0.0"], "3.0.0"), pkg("d", ["1.0.0"], "3.0.0")];
    expect(line(reg(four))[0].slice(3, 5)).toEqual(["4 packages a major or more behind", "b 1.0.0 → 5.0.0, c 1.0.0 → 3.0.0, d 1.0.0 → 3.0.0 …"]);
    expect(line(reg(four.slice(0, 1), 0, { truncated: true }))[0][3]).toBe("1+ packages a major or more behind");
    expect(line(reg([pkg("lodash", ["4.17.20"], "4.18.1"), pkg("gone", [], null)])), "nothing a major behind is no line").toEqual([]);
    expect(needsCount(findings("/r", input(reg(four)), MAINT_DEFAULTS, NOW)), "never counted in a badge").toBe(0);
  });

  it("ranks projects by majors behind with a bar, and a project it could not place muted after them", () => {
    const ps = [
      tp("/small", reg([pkg("a", ["1.0.0"], "2.0.0")], 3)),
      tp("/big", reg([pkg("a", ["1.0.0"], "4.0.0"), pkg("b", ["0.9.0"], "1.0.0")], 1)),
      tp("/unknown", reg([pkg("gone", [], null, { why: "not on the registry" })], 2)),
      tp("/fine", reg([], 7)),
      tp("/none", ok("git-local", hyg())),
    ];
    const rows = (xs: TabProject[], root: string | null = null) => packagesBoard(xs, root)
      .map((r) => [r.root, r.majors, r.ratio, r.floor, r.level, r.behind.length, r.unplaced.length, r.current, r.verb?.key ?? null]);
    expect(rows(ps)).toEqual([
      ["/big", 4, 1, true, "info", 2, 0, 1, "deps:packages"], ["/small", 1, 0.25, false, "info", 1, 0, 3, "deps:packages"],
      ["/unknown", 0, 0, true, "muted", 0, 1, 2, null], ["/fine", 0, 0, false, "ok", 0, 0, 7, null],
    ]);
    expect(rows([...ps].reverse()), "a repaint never reorders").toEqual(rows(ps));
    expect(rows(ps, "/small").map((r) => r[0])).toEqual(["/small"]);
    const b = tabBoards("security", ps, null, null, NOW);
    expect([b.pkgRead, b.drawn.filter((k) => k.endsWith("|deps:packages"))]).toEqual([4, ["/big|deps:packages", "/small|deps:packages"]]);
    expect(findingTarget({ facet: "deps", key: "deps:packages" })).toEqual({ tab: "security", board: "packages" });
    expect(findingTarget({ facet: "deps", key: "deps:renovate" }).board, "a bot's line stays on its board").toBe("update-prs");
    expect(tabBoards("delivery", ps, null, null, NOW).pkgs, "only Security draws it").toEqual([]);
  });

  it("opens Behind where the package manager is asked, and Latest on the package's page only over http(s)", () => {
    expect(boardDoor("packages", "behind", 3)).toEqual({ to: "deps", tab: "stale" });
    expect(boardDoor("packages", "behind", 0)).toBeNull();
    expect(boardDoor("packages", "latest", "https://reg.example/react")).toEqual({ to: "url", url: "https://reg.example/react" });
    expect(boardDoor("packages", "latest", null)).toBeNull();
    expect(boardDoor("packages", "latest", "file:///etc/passwd")).toBeNull();
  });
});

describe("prod, coming up and hosts", () => {
  const p = (name: string, days: number | null, o = {}) =>
    ({ name, url: `https://${name}`, code: 200, ms: 1, certNotAfter: days === null ? null : S + days * D, err: null, ...o });
  const probes = (...items: ReturnType<typeof p>[]): Facts => ({ kind: "probes", items });

  it("lists certificates inside the window, soonest first, ties by project", () => {
    const rows = comingUp([
      { root: "/a", inp: input(ok("h", probes(p("x", 24), p("y", 45), p("gone", -1), p("unknown", null)))) },
      { root: "/c", inp: input(ok("h", probes(p("w", 3)))) },
      { root: "/b", inp: input(ok("h", probes(p("z", 3)))) },
      { root: "/d", inp: input(not("h", "prod", { state: "notRun" })) },
    ], NOW);
    expect(rows.map((r) => [r.root, r.what])).toEqual([["/b", "certificate for z"], ["/c", "certificate for w"], ["/a", "certificate for x"]]);
    expect(comingUp([{ root: "/a", inp: input(ok("h", probes(p("x", 31)))) }], NOW), "past the window").toEqual([]);
  });

  it("levels each address as the Prod cell does: down is red, a 4xx and a near cert amber, unknown never fine", () => {
    const rows = (...items: ReturnType<typeof p>[]) => probeRows(input(ok("h", probes(...items), { at: S - H })), MAINT_DEFAULTS, NOW);
    expect(probeRows(input(not("h", "prod", { state: "notRun" })), MAINT_DEFAULTS, NOW), "never checked is no rows").toBeNull();
    const r = rows(
      p("ok", 90, { ms: 140 }), p("soon", 6), p("gone", -2), p("five", 90, { code: 502 }), p("four", 90, { code: 404, ms: null }),
      p("down", null, { code: null, ms: null, err: "Could not resolve host" }), p("blind", null),
      { ...p("plain", null), url: "http://plain" }, { ...p("upper", null), url: "HTTPS://upper" },
    )!;
    expect(r.at).toBe(S - H);
    expect(r.rows.map((x) => [x.name, x.status, x.level, x.cert, x.certLevel])).toEqual([
      ["ok", "200 · 140ms", "ok", "cert 90d", "ok"], ["soon", "200 · 1ms", "ok", "cert 6d", "warn"],
      ["gone", "200 · 1ms", "ok", "cert expired", "bad"], ["five", "502 · 1ms", "bad", "cert 90d", "ok"],
      ["four", "404", "warn", "cert 90d", "ok"], ["down", "no answer", "bad", "cert unknown", "muted"],
      ["blind", "200 · 1ms", "ok", "cert unknown", "muted"], ["plain", "200 · 1ms", "ok", "", "ok"],
      ["upper", "200 · 1ms", "ok", "cert unknown", "muted"],
    ]);
    expect(cell("prod", input(ok("h", probes(p("a", 90), p("b", 90, { code: 404 }))))), "a 4xx is amber, not down")
      .toMatchObject({ level: "warn", text: "b 404" });
    expect(cell("prod", input(ok("h", probes(p("a", 90), { ...p("plain", null), url: "http://plain" })))), "plain http has no cert to miss")
      .toMatchObject({ level: "ok", text: "" });
  });

  it("asks a click for what a scan may not run, and says it was never asked rather than that it cannot be", () => {
    const d = det(["http-probe", "git-local"], { forge: { kind: "github", host: "github.com", path: "o/r", by: "table" } });
    const inp: MaintInput = { det: d, reports: { "http-probe": { ...not("http-probe", "prod", { state: "notRun" }), cost: "remote" }, "git-local": ok("git-local", hyg()) } };
    expect(prodChecks(inp)).toEqual(["http-probe"]);
    expect(prodChecks({ ...inp, skip: ["http-probe"] })).toEqual([]);
    expect(prodChecks({ ...inp, det: { ...d, config: { ...d.config, off: ["prod"] } } })).toEqual([]);
    expect(cell("prod", inp)).toMatchObject({ state: "cantCheck", level: "muted", text: "not checked" });
    const run = offers("/r", inp);
    expect(run.map((f) => [f.key, f.facet, f.source, f.text])).toEqual([["run:http-probe", "prod", "http-probe", "URL checks: not checked"]]);
    expect(run[0].busy, "nothing out yet").toBeUndefined();
    expect(tabExtras("/r", inp, MAINT_DEFAULTS, NOW).filter((f) => f.verb === "run"), "an offer is never a tab row").toEqual([]);
    const out = offers("/r", { ...inp, asking: ["http-probe"] });
    expect(out[0].busy, "a read already out is not a button to start another").toBe(true);
    const answered = { ...inp, reports: { ...inp.reports, "http-probe": ok("http-probe", probes(p("app", 90))) } };
    expect(offers("/r", answered), "asked once is no longer an offer").toEqual([]);
  });

  it("joins hosts to projects many-to-many, worst first, and a host none of whose projects was checked is not checked", () => {
    const prod = (inp: MaintInput) => cell("prod", inp);
    const down = prod(input(ok("h", probes(p("api", 90, { code: 502 })))));
    const fine = prod(input(ok("h", probes(p("app", 90)))));
    const near = prod(input(ok("h", probes(p("app", 4)))));
    const never = prod(input(not("h", "prod", { state: "notRun" })));
    expect(hostRows([
      { path: "/b", hosts: ["prod-1"], prod: fine }, { path: "/a", hosts: ["prod-1", "pi"], prod: down },
      { path: "/c", hosts: [] }, { path: "/d", hosts: ["nas"], prod: never }, { path: "/e", hosts: ["edge"], prod: near },
      { path: "/f", hosts: ["quiet"], prod: fine, read: true },
    ])).toEqual([
      { host: "pi", projects: ["/a"], level: "bad", text: "api 502", read: false },
      { host: "prod-1", projects: ["/a", "/b"], level: "bad", text: "api 502", read: false },
      { host: "edge", projects: ["/e"], level: "warn", text: "cert 4d", read: false },
      { host: "nas", projects: ["/d"], level: "muted", text: "not checked", read: false },
      { host: "quiet", projects: ["/f"], level: "ok", text: "", read: true },
    ]);
  });

  it("never draws the healthy dot from the addresses alone, on a host nobody read", () => {
    const fine = cell("prod", input(ok("h", probes(p("app", 90)))));
    const row = (o: { read?: boolean; allowed?: boolean }) => hostRows([{ path: "/a", hosts: ["h"], prod: fine, ...o }])[0];
    expect(row({ allowed: false })).toMatchObject({ level: "muted", text: "not allowed here", read: false });
    expect(row({ allowed: true })).toMatchObject({ level: "muted", text: "host not read", read: false });
    expect(row({ allowed: true, read: true })).toMatchObject({ level: "ok", text: "", read: true });
    const down = cell("prod", input(ok("h", probes(p("api", 90, { code: 502 })))));
    expect(hostRows([{ path: "/a", hosts: ["h"], prod: down }])[0], "a known problem still speaks").toMatchObject({ level: "bad", text: "api 502" });
  });

  it("never draws the healthy dot over a host half of whose projects nobody knows", () => {
    const fine = cell("prod", input(ok("h", probes(p("app", 90)))));
    const blind = cell("prod", input(ok("h", probes(p("api", null)))));
    const never = cell("prod", input(not("h", "prod", { state: "notRun" })));
    const rows = hostRows([
      { path: "/a", hosts: ["mixed", "half"], prod: fine }, { path: "/b", hosts: ["mixed"], prod: blind },
      { path: "/c", hosts: ["half"], prod: fine }, { path: "/d", hosts: ["half", "all"], prod: never }, { path: "/e", hosts: ["all"], prod: fine },
    ]);
    expect(rows.map((r) => [r.host, r.level, r.text])).toEqual([
      ["all", "muted", "1 of 2 checked"], ["half", "muted", "2 of 3 checked"], ["mixed", "muted", blind.text],
    ]);
    expect(blind.level).toBe("muted");
  });
});

describe("a host's vitals", () => {
  const GB = 1024 * 1024;
  const disk = (mount: string, pct: number) => ({ mount, sizeKb: 100 * GB, usedKb: pct * GB, availKb: (100 - pct) * GB });
  const box = (o: Partial<NonNullable<HostFacts["containers"]>[number]> = {}) => ({
    name: "acme-api-1", image: "x", state: "running", health: null, restarts: 0, exit: 0, startedAt: S - D, project: "acme", service: "api", ...o,
  });
  const host = (o: Partial<HostFacts> = {}): HostFacts => ({
    alias: "prod-1", os: "Linux 6.8", now: S, uptime: 41 * D, load: [0.4, 0.5, 0.6], cpus: 4, disks: [disk("/", 62)], updates: 0, security: 0,
    packages: [], pm: "apt", listsAt: S - D, reboot: false, rebootWhy: [], containers: [box()], compose: [], ...o,
  });
  const judge = (o: Partial<HostFacts> = {}, th = MAINT_DEFAULTS) => { const h = host(o); return hostState(h, h.compose, th, NOW); };
  const line = (o: Partial<HostFacts>, kind: string, th = MAINT_DEFAULTS) => judge(o, th).lines.find((l) => l.kind === kind);
  const hosts = (o: Partial<HostFacts> = {}): Facts => ({ kind: "hosts", items: [host(o)] });

  it("narrows the wire's hosts and refuses a load that is not three numbers", () => {
    const rep = wire.reports.find((r) => (r.facts as { kind?: string } | null)?.kind === "hosts")!;
    expect(narrowMaint(rep, "ssh-host")).toEqual(rep);
    const items = (rep.facts as { items: Record<string, unknown>[] }).items;
    const bad = (o: Record<string, unknown>) => narrowMaint({ ...rep, facts: { kind: "hosts", items: [{ ...items[0], ...o }] } }, "ssh-host").coverage.state;
    expect(bad({ load: [1, 2] })).toBe("error");
    expect(bad({ load: [1, 2, "x"] })).toBe("error");
    expect(bad({ load: null, containers: null, updates: null })).toBe("ok");
    expect(bad({ containers: [{ name: "x" }] })).toBe("error");
  });

  it("is the grey dot only with its disks and updates read off fresh lists", () => {
    expect(judge()).toMatchObject({ level: "ok", text: "", lines: [], summary: "/ 62% · up to date · 1/1 up · up 41d" });
    expect(cell("prod", input(ok("h", hosts())))).toMatchObject({ level: "ok", text: "" });
    expect(diskPct({ mount: "/", sizeKb: 50_620_216, usedKb: 48_123_456, availKb: 2_480_376 }), "df's own math, rounded up").toBe(96);
  });

  it("says what it could not read, muted and never the dot", () => {
    expect(judge({ disks: [] })).toMatchObject({ level: "muted", text: "disk unknown" });
    expect(judge({ updates: null, security: null })).toMatchObject({ level: "muted", text: "updates unknown" });
    expect(judge({ containers: null, compose: ["api"] })).toMatchObject({ level: "muted", text: "containers unknown" });
    // Nothing named and nothing known about containers, or no word on a reboot: the rest may still pass, and the tip says so.
    expect(judge({ containers: null })).toMatchObject({ level: "ok", text: "" });
    const noWord = judge({ reboot: null });
    expect(noWord).toMatchObject({ level: "ok", text: "" });
    expect(noWord.tip.join("\n")).toContain("nothing on prod-1 says whether it needs a reboot");
    expect(judge({ load: null, cpus: null }).level, "load unknown stays a part, no blocker").toBe("ok");
  });

  it("judges each disk at its thresholds, which a file can move", () => {
    expect(judge({ disks: [disk("/", 84)] }).level).toBe("ok");
    expect(judge({ disks: [disk("/", 85)] })).toMatchObject({ level: "warn", text: "/ 85%" });
    expect(judge({ disks: [disk("/", 95)] })).toMatchObject({ level: "bad", text: "/ 95%" });
    expect(judge({ disks: [disk("/", 90)] }, clampMaint({ disk_warn_pct: 91, disk_bad_pct: 99 })).level).toBe("ok");
    expect(judge({ disks: [disk("/", 90)] }, clampMaint({ disk_bad_pct: 90 })).level).toBe("bad");
    expect(line({ disks: [disk("/", 96)] }, "disk")).toMatchObject({ level: "bad", text: "/ 96% full on prod-1", detail: "/ 96% · 4.0 GB free" });
    const two = line({ disks: [disk("/", 86), disk("/srv", 97), disk("/boot", 10)] }, "disk")!;
    expect(two).toMatchObject({ level: "bad", text: "2 disks filling on prod-1" });
    expect(two.points).toEqual(["/srv is 97% full: 3.0 GB free of 100 GB", "/ is 86% full: 14.0 GB free of 100 GB"]);
  });

  it("files security updates and stale lists as amber, and plain updates as a note", () => {
    expect(line({ updates: 14, security: 6, packages: ["openssl", "libc6"] }, "updates")).toMatchObject({
      level: "warn", text: "6 security updates on prod-1", detail: "14 pending, 6 security · openssl, libc6",
      points: ["14 updates pending, 6 of them security: openssl, libc6"],
    });
    expect(line({ updates: 14, security: 0 }, "updates")).toMatchObject({ level: "info", text: "14 updates on prod-1" });
    expect(judge({ updates: 14, security: 0 })).toMatchObject({ level: "info", text: "14 updates" });
    expect(line({ updates: 3, security: null, pm: "apk" }, "updates"), "no split: never counted as security").toMatchObject({ level: "info", detail: "3 pending" });
    expect(line({ listsAt: S - 12 * D }, "updates")).toMatchObject({ level: "warn", text: "package lists 12d old on prod-1" });
    expect(judge({ listsAt: S - 12 * D, now: S + 5 * D }).lines[0].text, "ages are the host's own clock's").toBe("package lists 17d old on prod-1");
    expect(judge({ listsAt: S - 6 * D }).level).toBe("ok");
    expect(judge({ listsAt: null, pm: "dnf" }).level, "dnf and apk give no age, so their 0 is trusted as read").toBe("ok");
    expect(judge({ listsAt: S - 6 * D }, clampMaint({ fetch_stale_days: 5 })).level, "fetch_stale_days decides").toBe("warn");
  });

  it("wants a reboot in amber, saying why", () => {
    expect(line({ reboot: true, rebootWhy: ["linux-image-6.8.0-49-generic"] }, "reboot")).toMatchObject({
      level: "warn", text: "prod-1 needs a reboot", detail: "linux-image-6.8.0-49-generic", points: ["it needs a reboot: linux-image-6.8.0-49-generic"],
    });
    expect(judge({ reboot: true })).toMatchObject({ level: "warn", text: "reboot needed" });
    expect(judge({ reboot: false }).lines).toEqual([]);
  });

  it("reds a container that fails and a named service with none running, across replicas", () => {
    for (const o of [{ state: "restarting" }, { state: "dead" }, { health: "unhealthy" }]) {
      expect(judge({ containers: [box(o)] }).level, JSON.stringify(o)).toBe("bad");
    }
    expect(line({ containers: [box({ health: "unhealthy" })] }, "containers")).toMatchObject({ level: "bad", text: "api unhealthy on prod-1", detail: "api unhealthy" });
    expect(judge({ containers: [box({ state: "exited", health: "unhealthy", exit: 1 })] }).level, "an exited one's health is stale").toBe("ok");
    expect(line({ containers: [box({ service: "db" })], compose: ["api"] }, "containers")).toMatchObject({
      level: "bad", text: "api not running on prod-1", points: ["service api has no running container, and none exists"],
    });
    expect(line({ containers: [box({ state: "exited" })], compose: ["api"] }, "containers")?.points, "it exists, stopped").toEqual(["service api has no running container"]);
    const replicas = [box({ name: "api-1", state: "exited", exit: 1 }), box({ name: "api-2" })];
    expect(judge({ containers: replicas, compose: ["api"] }).level, "one replica up is the service up").toBe("ok");
    const three = line({ containers: [box({ name: "a", service: "a", state: "dead" }), box({ name: "b", service: "b", state: "dead" })], compose: ["c"] }, "containers");
    expect(three).toMatchObject({ level: "bad", text: "3 containers failing on prod-1" });
    expect(judge({ containers: [], compose: [] })).toMatchObject({ level: "ok", summary: "/ 62% · up to date · 0/0 up · up 41d" });
  });

  it("ambers a running container that keeps restarting, at the threshold", () => {
    expect(line({ containers: [box({ name: "w", service: "worker", restarts: 12 })] }, "containers")).toMatchObject({ level: "warn", text: "worker restarted 12 times on prod-1" });
    expect(judge({ containers: [box({ restarts: 4 })] }).level).toBe("ok");
    expect(judge({ containers: [box({ restarts: 4 })] }, clampMaint({ container_restarts: 3 })).level).toBe("warn");
    expect(judge({ containers: [box({ state: "exited", restarts: 40 })] }).level, "only a running one").toBe("ok");
  });

  it("keeps an exit nobody named to the tip, since it cannot tell a leftover from a failure", () => {
    const s = judge({ containers: [box(), box({ name: "old-cron", service: null, project: null, state: "exited", exit: 1 })] });
    expect(s.level).toBe("ok");
    expect(s.tip).toContain("old-cron exited 1");
    const shared = judge({ containers: [box({ project: "acme" }), box({ name: "b", project: "beta" })], compose: ["api"] });
    expect(shared.tip.join("\n"), "one service label in two projects is said").toContain("api is a service of 2 projects on prod-1: acme, beta");
  });

  it("past the cap, prints a floor and calls a service off the list unknown, never stopped", () => {
    const capped = (o: Partial<HostFacts>) => { const h = host(o); return hostState(h, h.compose, MAINT_DEFAULTS, NOW, true); };
    expect(capped({}).summary).toContain("1/1+ up");
    expect(capped({})).toMatchObject({ level: "ok", text: "" });
    const off = capped({ compose: ["worker"] });
    expect(off).toMatchObject({ level: "muted", text: "containers unknown", lines: [] });
    expect(off.tip.join("\n")).toContain("worker not among the first 1 containers on prod-1");
    expect(capped({ compose: ["api"] }).level, "one that is on the list and up is up").toBe("ok");
    expect(capped({ containers: [box({ state: "dead" })], compose: ["api", "worker"] }), "what is on the list still speaks").toMatchObject({ level: "bad", text: "api dead" });
    const inp = input({ ...ok("h", hosts({ compose: ["worker"] })), truncated: true });
    expect(cell("prod", inp)).toMatchObject({ level: "muted", text: "containers unknown" });
    expect(findings("/r", inp, MAINT_DEFAULTS, NOW)).toEqual([]);
  });

  it("ambers load per CPU on the 15-minute figure", () => {
    expect(line({ load: [9, 9, 12.4], cpus: 4 }, "load")).toMatchObject({ level: "warn", text: "prod-1 load 3.1 per CPU", detail: "15-minute load 12.4 on 4 CPUs" });
    expect(judge({ load: [99, 99, 1], cpus: 4 }).level, "a spike is not the 15-minute figure").toBe("ok");
    expect(judge({ load: [1, 1, 1], cpus: 2 }, clampMaint({ load_per_cpu: 0.4 })).level).toBe("warn");
  });

  it("files every threshold under its raw key", () => {
    expect(clampMaint({ disk_warn_pct: 70, disk_bad_pct: 80, container_restarts: 2, load_per_cpu: 1.5 }))
      .toMatchObject({ diskWarnPct: 70, diskBadPct: 80, containerRestarts: 2, loadPerCpu: 1.5 });
    expect(clampMaint({ disk_warn_pct: 0, disk_bad_pct: -1 })).toMatchObject({ diskWarnPct: 85, diskBadPct: 95 });
  });

  describe("prod's composition", () => {
    const fine = { name: "app", url: "https://app", code: 200, ms: 9, certNotAfter: S + 90 * D, err: null };
    const probes = (o = {}): Facts => ({ kind: "probes", items: [{ ...fine, ...o }] });
    const both = (a: Facts, b: Facts) => input(ok("a", a), ok("b", b));

    it("judges a host by its own report's cap, so a cut address list cannot hide a named service that is down", () => {
      const down = hosts({ compose: ["web"], containers: [] });
      const cut = input(ok("a", probes(), { truncated: true }), ok("b", down));
      expect(cell("prod", cut)).toMatchObject({ state: "read", level: "bad", text: "web not running" });
      expect(projectBand(facetCells(cut, MAINT_DEFAULTS, NOW))).toBe("needs");
      expect(cell("prod", input(ok("a", probes()), ok("b", down, { truncated: true }))), "its own cap is the one that says").toMatchObject({ level: "muted", text: "containers unknown" });
    });

    it("lets the worse of probes and hosts speak, keeps both tips, and draws the dot only over two fine answers", () => {
      expect(cell("prod", both(probes(), hosts()))).toMatchObject({ level: "ok", text: "" });
      expect(cell("prod", both(probes({ code: 502 }), hosts({ updates: 3 })))).toMatchObject({ level: "bad", text: "app 502" });
      const worse = cell("prod", both(probes(), hosts({ disks: [disk("/", 96)] })));
      expect(worse).toMatchObject({ level: "bad", text: "/ 96%" });
      expect(worse.tip.join("\n"), "the kind that speaks leads").toMatch(/^prod-1: \/ 96%[\s\S]*app: 200/);
      expect(cell("prod", both(probes({ certNotAfter: null }), hosts())), "an unknown beside a pass stays unknown").toMatchObject({ level: "muted", text: "cert unknown" });
      expect(cell("prod", both(probes(), hosts({ updates: null, security: null })))).toMatchObject({ level: "muted", text: "updates unknown" });
    });

    it("lets no kind's failed read erase the other's last known red, and lists it in Coverage", () => {
      const HP = "http-probe", SH = "ssh-host";
      const down = not(SH, "prod", { state: "error", reason: "no answer after 45s" });
      const prodOf = (s: ReturnType<typeof takeSnap>) => ({ cell: s.cells.find((c) => c.facet === "prod"), lines: s.findings.filter((f) => f.facet === "prod").map((f) => f.key) });
      const red = takeSnap("/r", input(ok(HP, probes()), ok(SH, hosts({ disks: [disk("/", 96)] }))), NOW - 1000);
      const next = prodOf(takeSnap("/r", input(ok(HP, probes()), down), NOW, red));
      expect(next.cell, "a host that stopped answering").toMatchObject({ level: "bad", at: NOW - 1000 });
      expect(next.lines).toEqual(["prod:host:disk"]);
      const redUrl = takeSnap("/r", input(ok(HP, probes({ code: 502 })), ok(SH, hosts())), NOW - 1000);
      const blank = not(HP, "prod", { state: "noTool", tool: "curl", fix: null });
      expect(prodOf(takeSnap("/r", input(blank, ok(SH, hosts())), NOW, redUrl)).lines, "the other way round").toEqual(["prod:app"]);
      // A fresh answer clears a kind's own lines; a host this machine skips or no longer names keeps none.
      expect(prodOf(takeSnap("/r", input(ok(HP, probes()), ok(SH, hosts())), NOW, red)).lines).toEqual([]);
      expect(prodOf(takeSnap("/r", { ...input(ok(HP, probes()), down), skip: [SH] }, NOW, red)).lines).toEqual([]);
      expect(prodOf(takeSnap("/r", input(ok(HP, probes())), NOW, red)).lines).toEqual([]);
      // A kind nobody asked has said nothing either, so the other's dot is not the project's.
      const unasked = prodOf(takeSnap("/r", input(ok(HP, probes()), not(SH, "prod", { state: "notRun" })), NOW, red));
      expect(unasked.lines).toEqual(["prod:host:disk"]);
      expect(unasked.cell).toMatchObject({ level: "bad", at: NOW - 1000 });
      // A fresh red of one kind sits beside what the other last said, and speaks for itself.
      const beside = prodOf(takeSnap("/r", input(ok(HP, probes({ code: 502 })), down), NOW, red));
      expect(beside.lines.sort()).toEqual(["prod:app", "prod:host:disk"]);
      expect(beside.cell).toMatchObject({ level: "bad", text: "app 502" });
      expect(beside.cell?.at).toBeUndefined();
      // The kind that answered is not held to its old red because the other still fails.
      const cleared = prodOf(takeSnap("/r", input(ok(HP, probes()), down), NOW, redUrl));
      expect(cleared.lines).toEqual([]);
      expect(cleared.cell).toMatchObject({ level: "ok", text: "" });
      // Neither answered: the whole facet stands, as any other's does.
      const silent = prodOf(takeSnap("/r", input(blank, down), NOW, red));
      expect(silent.lines).toEqual(["prod:host:disk"]);
      expect(silent.cell).toMatchObject({ level: "bad", at: NOW - 1000 });
      const row = (inp: MaintInput) => coverGroups("servers", [{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) }], null, NOW).map((g) => [g.source, g.why]);
      expect(row(input(ok(HP, probes()), down)), "beside the addresses' dot").toEqual([[SH, "read failed"]]);
      expect(row(input(blank, ok(SH, hosts()))), "beside the host's").toEqual([[HP, "tool missing"]]);
      expect(row(input(blank, ok(SH, hosts({ disks: [] })))), "beside a muted cell too").toEqual(expect.arrayContaining([[HP, "tool missing"]]));
      expect(row(input(ok(HP, probes({ certNotAfter: null })), down))).toEqual(expect.arrayContaining([[SH, "read failed"]]));
      expect(row(input(ok(HP, probes()), ok(SH, hosts())))).toEqual([]);
    });

    it("reads a project with a host and no address as read, not as no deploy", () => {
      expect(cell("prod", input(ok("h", hosts({ updates: 2 }))))).toMatchObject({ state: "read", level: "info", text: "2 updates" });
      expect(cell("prod", input(ok("h", { kind: "hosts", items: [] })))).toMatchObject({ level: "muted", text: "no deploy" });
    });

    it("gives one line per kind, each with its verb and the alias as ref, and a key no probe can spell", () => {
      const inp = input(ok("h", hosts({ disks: [disk("/", 96), disk("/srv", 90)], updates: 2, security: 1, reboot: true, load: [1, 1, 12], cpus: 4, containers: [box({ health: "unhealthy" })] })));
      const fs = findings("/r", inp, MAINT_DEFAULTS, NOW);
      expect(fs.map((f) => [f.key, f.level, f.verb, f.ref])).toEqual([
        ["prod:host:containers", "bad", "fix", "prod-1"], ["prod:host:disk", "bad", "fix", "prod-1"],
        ["prod:host:load", "warn", "fix", "prod-1"], ["prod:host:reboot", "warn", "fix", "prod-1"], ["prod:host:updates", "warn", "fix", "prod-1"],
      ]);
      expect(fs.every((f) => f.source === "h" && f.facet === "prod")).toBe(true);
      expect(HOST_KINDS.map((k) => `prod:host:${k}`).sort()).toEqual(fs.map((f) => f.key).sort());
      expect(findingTarget({ facet: "prod", key: "prod:host:disk" })).toEqual({ tab: "servers", board: "hosts" });
      expect(findingTarget({ facet: "prod", key: "prod:app" })).toEqual({ tab: "servers", board: "addresses" });
    });
  });

  describe("a host this machine has not allowed", () => {
    const d = (sources: string[], h = "prod-1") => det(sources, { deploy: { host: h, compose: [], urls: { app: "https://app" }, sentry: null, versionUrl: null, envs: {} } });
    const notRun = (id: string) => ({ ...not(id, "prod", { state: "notRun" }), cost: "remote" as const });
    const fresh = (hosts: string[] = [], sources = ["http-probe", "ssh-host"]): MaintInput => {
      const de = d(sources);
      return { det: de, reports: Object.fromEntries(sources.map((id) => [id, notRun(id)])), skip: hostSkips(de, hosts), hosts };
    };

    it("is skipped by what the source sees, never by its id", () => {
      expect(hostSkips(d(["http-probe", "ssh-host", "git-local"]), [])).toEqual(["ssh-host"]);
      expect(hostSkips(d(["http-probe", "ssh-host"]), ["prod-1"])).toEqual([]);
      expect(hostSkips(d(["ssh-host"]), ["other"])).toEqual(["ssh-host"]);
      expect(hostSkips(det(["ssh-host"]), []), "no [deploy] host").toEqual([]);
      expect(hostSkips(null, [])).toEqual([]);
      expect(hostSkips(d(["http-probe"]), []), "no host source").toEqual([]);
    });

    it("keeps Check prod off it, and the addresses still ask", () => {
      expect(prodChecks(fresh())).toEqual(["http-probe"]);
      expect(prodChecks(fresh(["prod-1"]))).toEqual(["http-probe", "ssh-host"]);
      expect(offers("/r", fresh()).map((o) => o.source), "an offer it is not").toEqual(["http-probe"]);
    });

    it("reads not checked while something else can still be clicked, and not allowed only alone", () => {
      expect(cell("prod", fresh())).toMatchObject({ state: "cantCheck", level: "muted", text: "not checked" });
      expect(cell("prod", fresh()).tip.join("\n")).toContain("SSH host: off: prod-1 is not allowed on this machine");
      expect(cell("prod", fresh(["prod-1"]))).toMatchObject({ text: "not checked" });
      expect(cell("prod", fresh([], ["ssh-host"]))).toMatchObject({ state: "cantCheck", level: "muted", text: "not allowed here" });
      const off = fresh([], ["ssh-host"]);
      expect(cell("prod", { ...off, skip: ["ssh-host"], hosts: ["prod-1"] }), "off here for another reason").toMatchObject({ text: "skipped here" });
      const failed = fresh();
      expect(cell("prod", { ...failed, reports: { ...failed.reports, "http-probe": not("http-probe", "prod", { state: "error", reason: "boom" }) } })).toMatchObject({ text: "read failed" });
    });

    it("is judged from a click's facts only while it is allowed", () => {
      const reports = { "ssh-host": ok("ssh-host", hosts({ disks: [disk("/", 96)] })) };
      const on: MaintInput = { det: d(["ssh-host"]), reports, skip: [], hosts: ["prod-1"] };
      const off: MaintInput = { ...on, skip: ["ssh-host"], hosts: [] };
      expect(cell("prod", on).text).toBe("/ 96%");
      expect(findings("/r", on, MAINT_DEFAULTS, NOW)[0].key).toBe("prod:host:disk");
      expect(cell("prod", off)).toMatchObject({ state: "cantCheck", text: "not allowed here" });
      expect(findings("/r", off, MAINT_DEFAULTS, NOW)).toEqual([]);
      expect([hostRead(on), hostRead(off)]).toEqual([true, false]);
      expect(hostSummary(on, MAINT_DEFAULTS, NOW)).toMatchObject({ alias: "prod-1", allowed: true, at: S, state: { level: "bad", text: "/ 96%" } });
      expect(hostSummary(off, MAINT_DEFAULTS, NOW)).toMatchObject({ alias: "prod-1", allowed: false, state: null });
      expect(hostSummary({ ...on, reports: {} }, MAINT_DEFAULTS, NOW)).toMatchObject({ allowed: true, at: null, state: null });
      expect(hostSummary({ det: det(["ssh-host"]), reports: {} })).toBeNull();
      expect(hostSummary({ det: d(["http-probe"]), reports: {} }), "nothing reads it, so there is nothing to allow").toBeNull();
    });

    it("says a read failed on the Runs on card, never that nobody checked", () => {
      const inp = (coverage: Coverage): MaintInput => ({ det: d(["ssh-host"]), hosts: ["prod-1"], skip: [], reports: { "ssh-host": { ...not("ssh-host", "prod", coverage), at: S } } });
      expect(hostSummary(inp({ state: "noAccess", reason: "prod-1 refused every key", fix: "ssh prod-1" }), MAINT_DEFAULTS, NOW)).toMatchObject({ why: "no access", at: S, state: null });
      expect(hostSummary(inp({ state: "error", reason: "no answer after 45s" }), MAINT_DEFAULTS, NOW)).toMatchObject({ why: "read failed", at: S, state: null });
      expect(hostSummary(inp({ state: "notRun" }), MAINT_DEFAULTS, NOW)).toMatchObject({ why: null, at: null, state: null });
      const gaps: MaintInput = { det: d(["ssh-host"]), hosts: ["prod-1"], skip: [], reports: { "ssh-host": { ...ok("ssh-host", hosts()), gaps: ["load on prod-1 not read"] } } };
      expect(hostSummary(gaps, MAINT_DEFAULTS, NOW)).toMatchObject({ why: null, gaps: ["load on prod-1 not read"] });
      expect(cell("prod", gaps).tip.join("\n"), "the cell's tip states it too").toContain("load on prod-1 not read");
    });

    it("treats a click's answer about another host as a host nobody asked yet", () => {
      const reports = { "ssh-host": ok("ssh-host", hosts({ disks: [disk("/", 96)] })) };
      const moved = currentHosts(d(["ssh-host"], "prod-2"), reports);
      expect(moved["ssh-host"]).toMatchObject({ coverage: { state: "notRun" }, facts: null, at: null });
      const inp: MaintInput = { det: d(["ssh-host"], "prod-2"), hosts: ["prod-2"], skip: [], reports: moved };
      expect(cell("prod", inp)).toMatchObject({ state: "cantCheck", text: "not checked" });
      expect(findings("/r", inp, MAINT_DEFAULTS, NOW)).toEqual([]);
      expect(hostRead(inp)).toBe(false);
      expect(offers("/r", inp).map((o) => o.source), "Check prod and its door ask it again").toEqual(["ssh-host"]);
      expect(currentHosts(d(["ssh-host"]), reports)["ssh-host"].facts, "the same host's stands").toEqual(reports["ssh-host"].facts);
      expect(currentHosts(det(["ssh-host"]), reports), "no [deploy] host, so nothing to compare").toBe(reports);
      const named = det(["ssh-host"], { deploy: { host: "prod-1", compose: ["worker"], urls: {}, sentry: null, versionUrl: null, envs: {} } });
      const now = currentHosts(named, { "ssh-host": ok("ssh-host", hosts()) });
      expect(cell("prod", { det: named, reports: now, skip: [], hosts: ["prod-1"] }), "judged against the services named now").toMatchObject({ level: "bad", text: "worker not running" });
    });

    it("names the host on its Run door, and only there", () => {
      const out = offers("/r", fresh(["prod-1"]));
      expect(out.map((o) => [o.source, o.ref])).toEqual([["http-probe", null], ["ssh-host", "prod-1"]]);
    });

    it("carries its Allow on the Coverage row and across projects, whatever the cell read", () => {
      const inp = fresh(), row = coverRows(inp).find((r) => r.source === "ssh-host");
      expect(row).toMatchObject({ state: "skipped", text: "prod-1 is not allowed on this machine", host: { alias: "prod-1", allowed: false } });
      expect(coverRows(fresh(["prod-1"])).find((r) => r.source === "ssh-host"), "Disallow's row").toMatchObject({ state: "notRun", host: { alias: "prod-1", allowed: true } });
      expect(coverRows({ ...inp, skip: ["http-probe", "ssh-host"], hosts: ["prod-1"] }).find((r) => r.source === "http-probe")).toMatchObject({ state: "skipped", host: null });
      const group = (i: MaintInput, path = "/a") => ({ path, inp: i, cells: facetCells(i, MAINT_DEFAULTS, NOW) });
      const answered: MaintInput = { ...inp, reports: { ...inp.reports, "http-probe": ok("http-probe", probes1()) } };
      const gs = coverGroups("servers", [group(inp), group(answered, "/b")], null, NOW).filter((g) => g.source === "ssh-host");
      expect(gs).toHaveLength(1);
      expect(gs[0]).toMatchObject({ why: "not allowed here", roots: ["/a", "/b"], action: { kind: "allow", host: "prod-1" }, detail: "prod-1 is not allowed on this machine" });
      const allowed = coverGroups("servers", [group(fresh(["prod-1"]))], null, NOW);
      expect(allowed.some((g) => g.why === "not allowed here")).toBe(false);
      expect(allowed.map((g) => g.action?.kind)).toContain("run");
    });

    const probes1 = (): Facts => ({ kind: "probes", items: [{ name: "app", url: "https://app", code: 200, ms: 9, certNotAfter: S + 90 * D, err: null }] });
  });

  describe("what a card prints, from the one judge", () => {
    it("judges every disk it lists, with what is free", () => {
      expect(judge({ disks: [disk("/", 96), disk("/srv", 86), disk("/boot", 40)] }).disks).toEqual([
        { mount: "/", pct: 96, level: "bad", free: "4.0 GB" }, { mount: "/srv", pct: 86, level: "warn", free: "14.0 GB" }, { mount: "/boot", pct: 40, level: "ok", free: "60.0 GB" },
      ]);
      expect(judge({ disks: [disk("/", 90)] }, clampMaint({ disk_warn_pct: 91 })).disks[0].level, "the thresholds move it too").toBe("ok");
      expect(judge({ disks: [] }).disks).toEqual([]);
    });

    it("says each failing container with its health and restarts, the red ones first", () => {
      expect(judge({ containers: [box({ health: "unhealthy", restarts: 3 })] }).failing).toEqual([
        { text: "api unhealthy · 3 restarts", level: "bad", tip: "acme-api-1 (service api): running, unhealthy, restarted 3 times" },
      ]);
      expect(judge({ containers: [box({ name: "w", service: "worker", restarts: 12 }), box({ state: "dead", restarts: 1 })] }).failing.map((f) => [f.text, f.level])).toEqual([
        ["api dead · 1 restart", "bad"], ["worker restarted 12 times", "warn"],
      ]);
      expect(judge({ containers: [], compose: ["api"] }).failing.map((f) => f.text), "named, and none there").toEqual(["api not running"]);
      expect(judge().failing).toEqual([]);
      expect(judge({ containers: null }).failing).toEqual([]);
    });

    it("counts containers as running of all, a floor past the cap, and nothing it could not read", () => {
      expect(judge({ containers: [box(), box({ state: "exited" })] }).running).toBe("1/2");
      const h = host();
      expect(hostState(h, h.compose, MAINT_DEFAULTS, NOW, true).running).toBe("1/1+");
      expect(judge({ containers: null }).running).toBeNull();
    });

    it("ages the package lists on the host's clock, and states no age nothing gave", () => {
      expect(judge({ listsAt: S - D }).lists).toEqual({ age: D, level: "ok" });
      expect(judge({ listsAt: S - 12 * D }).lists).toEqual({ age: 12 * D, level: "warn" });
      expect(judge({ listsAt: S - 12 * D, now: S + 5 * D }).lists?.age).toBe(17 * D);
      expect(judge({ listsAt: null }).lists).toBeNull();
    });

    it("gives load per CPU only when both were read", () => {
      expect(judge({ load: [1, 1, 3], cpus: 2 }).perCpu).toBe(1.5);
      expect(judge({ load: null }).perCpu).toBeNull();
      expect(judge({ cpus: null }).perCpu).toBeNull();
    });

    it("says uptime in the unit it has: a host booted minutes ago was never up a day", () => {
      expect([300, 23 * H, D, 41 * D].map((up) => judge({ uptime: up }).uptime.text)).toEqual(["up 5m", "up 23h", "up 1d", "up 41d"]);
      expect(judge({ uptime: 300 }).summary).toContain("up 5m");
      expect([upSpan(300), upSpan(90 * D)]).toEqual(["5m", "3mo"]);
    });

    it("judges what is pending: amber on a security update, a count otherwise, nothing at zero or unread", () => {
      expect(judge({ updates: 14, security: 6 }).pending).toEqual({ text: "14 · 6 security", level: "warn" });
      expect(judge({ updates: 3, security: 0 }).pending).toEqual({ text: "3", level: "info" });
      expect(judge({ updates: 3, security: null }).pending).toEqual({ text: "3", level: "info" });
      expect(judge({ updates: 0 }).pending).toBeNull();
      expect(judge({ updates: null }).pending).toBeNull();
    });
  });

  describe("the Hosts board", () => {
    const named = (alias = "prod-1", compose: string[] = [], urls: Record<string, string> = {}) =>
      det(["ssh-host", ...(Object.keys(urls).length ? ["http-probe"] : [])], { deploy: { host: alias, compose, urls, sentry: null, versionUrl: null, envs: {} } });
    const project = (path: string, de: Detection, reports: SourceReport[], o: Partial<MaintInput> = {}): TabProject => {
      const allowed = o.hosts ?? ["prod-1", "edge"];
      const inp: MaintInput = { det: de, reports: Object.fromEntries(reports.map((r) => [r.source, r])), skip: hostSkips(de, allowed), hosts: allowed, ...o };
      return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
    };
    const read = (o: Partial<HostFacts> = {}, at = S) => ok("ssh-host", hosts(o), { at, cost: "remote" });
    const asked = { ...not("ssh-host", "prod", { state: "notRun" }), cost: "remote" as const };
    const board = (...ps: TabProject[]) => hostBoard(ps, null, NOW);

    it("finds a host source by what it sees, never by its id", () => {
      expect([readsHost("ssh-host"), readsHost("http-probe"), readsHost("nonsense")]).toEqual([true, false, false]);
    });

    it("joins the projects naming one alias, the newest read speaking, judged against every service any names", () => {
      const a = project("/a", named("prod-1", ["api"]), [read({ disks: [disk("/", 96)], compose: ["api"] }, S - D)]);
      const b = project("/b", named("prod-1", ["web"]), [read({ compose: ["web"] })]);
      const [row, ...rest] = board(a, b);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({ host: "prod-1", projects: ["/a", "/b"], at: S, allowed: true, checking: false, sources: ["ssh-host"], why: null });
      expect(row.state, "/b's read, so the disk is its 62%").toMatchObject({ level: "bad", text: "web not running", disk: { text: "/ 62%" } });
      expect(row.facts?.disks[0].mount).toBe("/");
    });

    it("carries a line of each project naming it, so none is listed twice, and the first is its Brief", () => {
      const fact = { disks: [disk("/", 96)], reboot: true };
      const a = project("/a", named(), [read(fact)]), b = project("/b", named(), [read(fact)]);
      const [row] = board(b, a);
      expect(row.verbs.map((f) => [f.root, f.key])).toEqual([
        ["/a", "prod:host:disk"], ["/b", "prod:host:disk"], ["/a", "prod:host:reboot"], ["/b", "prod:host:reboot"],
      ]);
      const model = tabModel("servers", [a, b], null, null, NOW);
      expect(model.boards?.drawn).toEqual(["/a|prod:host:disk", "/a|prod:host:reboot", "/b|prod:host:disk", "/b|prod:host:reboot"]);
      expect(model.rows).toEqual([]);
      expect(tabBoards("servers", [a], "/a", null, NOW).one).toBe(true);
    });

    it("leaves a line the newest read no longer shows on the project that still says it", () => {
      const old = project("/old", named(), [read({ disks: [disk("/", 96)] }, S - D)]), fresh = project("/new", named(), [read()]);
      const model = tabModel("servers", [old, fresh], null, null, NOW);
      expect(model.boards?.hosts[0]).toMatchObject({ verbs: [], state: { level: "ok" } });
      expect(model.rows.map((r) => [r.root, r.key])).toEqual([["/old", "prod:host:disk"]]);
    });

    it("offers a Brief when the newest read's project has no line but another names what failed", () => {
      const a = project("/a", named("prod-1", ["api"]), [read({ compose: ["api"] })]);
      const b = project("/b", named("prod-1", ["web"]), [read({ compose: ["web"] }, S - D)]);
      expect(board(a, b)[0].verbs.map((f) => [f.root, f.key])).toEqual([["/b", "prod:host:containers"]]);
    });

    it("carries only what its Brief says: another project's service stays listed, with its Fix", () => {
      const a = project("/a", named("prod-1", ["api"]), [read({ containers: [], compose: ["api"] })]);
      const b = project("/b", named("prod-1", ["web"]), [read({ containers: [], compose: ["web"] })]);
      const model = tabModel("servers", [a, b], null, null, NOW), [row] = model.boards!.hosts;
      expect(row.state?.failing.map((f) => f.text), "the card says both").toEqual(["api not running", "web not running"]);
      expect(row.verbs.map((f) => [f.root, f.key])).toEqual([["/a", "prod:host:containers"]]);
      expect(model.rows.map((r) => [r.root, r.text])).toEqual([["/b", "web not running on prod-1"]]);
    });

    it("reads a line's detail too, since two different pairs of services count the same", () => {
      const pair = (path: string, compose: string[]) => project(path, named("prod-1", compose), [read({ containers: [], compose })]);
      const model = tabModel("servers", [pair("/a", ["a1", "a2"]), pair("/b", ["b1", "b2"])], null, null, NOW);
      expect(model.rows.map((r) => [r.root, r.text, r.detail])).toEqual([["/b", "2 containers failing on prod-1", "b1 not running, b2 not running"]]);
    });

    it("holds what is carried against the Brief's project, not the first to say each kind", () => {
      const a = project("/a", named("prod-1", ["api"]), [read({ compose: ["api"], reboot: true })]);
      const b = project("/b", named("prod-1", ["web"]), [read({ compose: ["web"] }, S - D)]);
      const model = tabModel("servers", [a, b], null, null, NOW);
      expect(model.boards?.hosts[0].verbs.map((f) => [f.root, f.key]), "/b's brief says nothing of the reboot").toEqual([["/b", "prod:host:containers"]]);
      expect(model.rows.map((r) => [r.root, r.key])).toEqual([["/a", "prod:host:reboot"]]);
    });

    it("offers its Check, not a Brief, for a red only a project nobody has read names", () => {
      const a = project("/a", named("prod-1", ["api"]), [read({ compose: ["api"] })]), b = project("/b", named("prod-1", ["web"]), [asked]);
      expect(board(a, b)[0]).toMatchObject({ state: { level: "bad", text: "web not running" }, verbs: [], sources: ["ssh-host"] });
      expect(a.cells.find((c) => c.facet === "prod")?.level, "/a's own cell is clean until /b is checked").toBe("ok");
    });

    it("lets the newest attempt speak: a failure newer than every read, and one failure's word with its own time", () => {
      const refused = (at: number) => ({ ...not("ssh-host", "prod", { state: "noAccess", reason: "prod-1 refused every key", fix: "ssh prod-1" }), at, cost: "remote" as const });
      const broke = (at: number) => ({ ...not("ssh-host", "prod", { state: "error", reason: "no answer after 45s" }), at, cost: "remote" as const });
      expect(board(project("/a", named(), [refused(S - 3 * D)]), project("/b", named(), [broke(S - 60)]))[0]).toMatchObject({ why: "read failed", at: S - 60, state: null });
      expect(board(project("/a", named(), [broke(S - 3 * D)]), project("/b", named(), [refused(S - 60)]))[0]).toMatchObject({ why: "no access", at: S - 60, state: null });
      const stale = project("/a", named(), [read({ disks: [disk("/", 96)] }, S - 3 * D)]);
      const model = tabModel("servers", [stale, project("/b", named(), [refused(S - 60)])], null, null, NOW);
      expect(model.boards?.hosts[0]).toMatchObject({ why: "no access", at: S - 60, facts: null, state: null, verbs: [] });
      expect(model.rows.map((r) => [r.root, r.key]), "the older read's line is still said, on its project").toEqual([["/a", "prod:host:disk"]]);
      expect(board(project("/a", named(), [read()]), project("/b", named(), [refused(S - 60)]))[0], "a read newer than the failure stands").toMatchObject({ why: null, at: S, state: { level: "ok" } });
    });

    it("sorts worst first, then by alias, whatever order the projects came in", () => {
      const ps = [
        project("/a", named("edge"), [read({ alias: "edge" })]),
        project("/b", named("prod-1"), [read({ disks: [disk("/", 96)] })]),
        project("/c", named("zeta"), [asked], { hosts: ["zeta"] }),
        project("/d", named("alpha"), [asked], { hosts: [] }),
      ];
      const hostsOf = (xs: TabProject[]) => hostBoard(xs, null, NOW).map((r) => r.host);
      expect(hostsOf(ps)).toEqual(["prod-1", "alpha", "zeta", "edge"]);
      expect(hostsOf([...ps].reverse())).toEqual(hostsOf(ps));
      const twins = [project("/x", named(), [read({ disks: [disk("/", 40)] })]), project("/y", named(), [read({ disks: [disk("/", 50)] })])];
      expect(hostBoard(twins, null, NOW)[0].state?.disk.text, "one instant: the first path, either way round").toBe("/ 40%");
      expect(hostBoard([...twins].reverse(), null, NOW)[0].state?.disk.text).toBe("/ 40%");
    });

    it("draws nothing it read for a host this machine has not allowed, and offers only Allow", () => {
      const [row] = board(project("/a", named(), [read({ disks: [disk("/", 96)] })], { hosts: [] }));
      expect(row).toMatchObject({ host: "prod-1", allowed: false, at: null, why: null, facts: null, state: null, verbs: [], sources: [], gaps: [] });
      const failed = { ...not("ssh-host", "prod", { state: "error", reason: "no answer after 45s" }), at: S - H, cost: "remote" as const };
      expect(board(project("/a", named(), [failed], { hosts: [] }))[0], "nor a kept failure").toMatchObject({ allowed: false, at: null, why: null });
    });

    it("has no card for a source switched off here, and one for a host nobody allowed", () => {
      const de = named(), reports = { "ssh-host": read() };
      expect(hostSummary({ det: de, reports, skip: ["ssh-host"], hosts: ["prod-1"] }, MAINT_DEFAULTS, NOW)).toBeNull();
      expect(board(project("/a", de, [read()], { skip: ["ssh-host"] }))).toEqual([]);
      expect(hostSummary({ det: de, reports, skip: ["ssh-host"], hosts: [] }, MAINT_DEFAULTS, NOW)).toMatchObject({ alias: "prod-1", allowed: false });
    });

    it("says a read failed, and says nothing was asked when nothing was", () => {
      const failed = { ...not("ssh-host", "prod", { state: "noAccess", reason: "prod-1 refused every key", fix: "ssh prod-1" }), at: S - H, cost: "remote" as const };
      expect(board(project("/a", named(), [failed]))[0]).toMatchObject({ why: "no access", at: S - H, state: null, facts: null, allowed: true, sources: ["ssh-host"] });
      expect(board(project("/a", named(), [asked]))[0]).toMatchObject({ why: null, at: null, state: null, sources: ["ssh-host"] });
      expect(board(project("/a", named(), []))[0], "not even asked yet").toMatchObject({ why: null, at: null, state: null });
    });

    it("keeps what the read could not read", () => {
      const [row] = board(project("/a", named(), [{ ...read(), gaps: ["no docker on prod-1"] }]));
      expect(row.gaps).toEqual(["no docker on prod-1"]);
    });

    it("says it is checking while a host source is out, and only then", () => {
      expect(board(project("/a", named(), [asked], { asking: ["ssh-host"] }))[0].checking).toBe(true);
      expect(board(project("/a", named(), [asked], { asking: ["http-probe"] }))[0].checking).toBe(false);
    });

    it("honours the filter, skips a project naming no host, and has no card where prod is switched off", () => {
      const a = project("/a", named(), [read()]), b = project("/b", named(), [read()]);
      expect(hostBoard([a, b], "/a", NOW)[0].projects).toEqual(["/a"]);
      expect(hostBoard([a, b], "/none", NOW)).toEqual([]);
      const de = named();
      expect(board(project("/off", { ...de, config: { ...de.config, off: ["prod"] } }, [read()]))).toEqual([]);
      expect(board(project("/x", det(["http-probe"]), []))).toEqual([]);
    });

    it("is built on Servers alone", () => {
      const a = project("/a", named(), [read()]);
      expect(tabBoards("servers", [a], null, null, NOW).hosts).toHaveLength(1);
      expect(tabBoards("code", [a], null, null, NOW).hosts).toEqual([]);
    });

    it("lets a card ask for its host, so *not checked yet* speaks for the addresses alone", () => {
      const urls = { app: "https://app" }, probe = { ...not("http-probe", "prod", { state: "notRun" }), cost: "remote" as const };
      const n = (p: TabProject) => tabBoards("servers", [p], null, null, NOW).unchecked;
      expect(n(project("/h", named(), [asked])), "a host alone has its card's Check").toBe(0);
      expect(n(project("/b", named("prod-1", [], urls), [asked, probe]))).toBe(1);
      expect(n(project("/r", named("prod-1", [], urls), [read(), probe])), "the host answered and the addresses did not").toBe(1);
    });
  });

  describe("Check prod's words", () => {
    it("names every source it asks by its label, and each host it reaches", () => {
      expect(prodTip(["http-probe"], [])).toBe("Asks from this machine, once: URL checks: each [deploy] address once, and its certificate. Nothing else connects");
      expect(prodTip(["http-probe", "ssh-host"], ["prod-1", "edge"])).toBe(
        "Asks from this machine, once: URL checks: each [deploy] address once, and its certificate; SSH host: one fixed read-only script (disk, load, pending updates, reboot, containers) on prod-1, edge, over your own ssh. Nothing else connects");
    });

    it("asks only what no opt-in could let a scan run: a public source keeps its own door", () => {
      for (const d of SOURCES) expect(onClickOnly(d), d.id).toBe(d.cost === "remote" || d.cost === "tool");
    });

    it("says what no project had to ask, from the same labels' needs", () => {
      expect(prodNone()).toBe("No project here has an address in [deploy], a [deploy] host allowed on this machine or an error tracker project in [deploy]");
    });
  });

  it("reads ssh's own failure in a few words, its fix a command for a terminal", () => {
    const rep = wire.reports.find((r) => r.source === "ssh-host" && (r.coverage as { state: string }).state === "noAccess")!;
    const c = narrowMaint(rep, "ssh-host").coverage;
    expect(c).toMatchObject({ state: "noAccess", fix: "ssh prod-1" });
    expect(whyWord(c, "prod")).toBe("no access");
    expect(whyWord({ state: "noAccess", reason: "telescope-1 refused every key ssh offered from this machine", fix: "ssh telescope-1" }, "prod"), "an alias is a name a person chose").toBe("no access");
    expect(whyWord({ state: "noAccess", reason: "glab: insufficient_scope (HTTP 403)", fix: "glab auth login" }, "ci"), "the forge's own word still reads").toBe("token scope");
    expect(whyWord({ state: "noAccess", reason: "your token has not been granted the required scopes", fix: "pick the account" }, "release"), "nor does its prose go dark").toBe("token scope");
  });

  it("stops saying a host was never read once one project's read answered", () => {
    expect(hostRows([{ path: "/a", hosts: ["p"], read: true }, { path: "/b", hosts: ["p"], read: false }, { path: "/c", hosts: ["q"] }]).map((r) => [r.host, r.read]))
      .toEqual([["p", true], ["q", false]]);
  });
});

describe("registered domains", () => {
  const RD = "rdap-domain", HP = "http-probe";
  const dom = (domain: string, days: number | null, o: Partial<Domain> = {}): Domain => ({
    domain, names: ["api", "app"], expires: days === null ? null : S + days * D, status: ["client transfer prohibited"],
    registrar: "Cloudflare, Inc", url: "https://registrar.example/", ...o,
  });
  const doms = (...items: Domain[]): Facts => ({ kind: "domains", items });
  const fine = { name: "app", url: "https://app.example.com", code: 200, ms: 9, certNotAfter: S + 90 * D, err: null };
  const probes = (o = {}): Facts => ({ kind: "probes", items: [{ ...fine, ...o }] });
  const unasked = not(HP, "prod", { state: "notRun" });
  const states = (...items: Domain[]) => domainStates(input(ok(RD, doms(...items))), MAINT_DEFAULTS, NOW);
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };

  // The status variants are hand-written: a recorded record with only its status words changed.
  it("judges each domain by its registry's words before its date, and an unknown never fine", () => {
    const said = (d: Domain) => { const [x] = states(d); return [x.level, x.text, x.word]; };
    expect(said(dom("a.com", 300, { status: ["redemption period"] }))).toEqual(["bad", "lapsed (redemption period)", "domain lapsed"]);
    expect(said(dom("a.com", 300, { status: ["client hold"] }))).toEqual(["bad", "on hold (client hold)", "domain on hold"]);
    expect(said(dom("a.com", -3))).toEqual(["bad", "expired 3d ago", "domain expired"]);
    expect(said(dom("a.com", 365, { status: ["auto renew period"] })), "the registry moved the date a year on").toEqual(["warn", "renewed at expiry, not yet paid for", "domain unpaid"]);
    expect(said(dom("a.com", 12))).toEqual(["warn", "expires in 12d", "domain 12d"]);
    expect(said(dom("a.com", 425))).toEqual(["ok", "expires in 14mo", ""]);
    expect(said(dom("a.de", null, { status: ["active"] })), "a registration that runs until cancelled").toEqual(["ok", "no expiry published", ""]);
    expect(said(dom("a.de", null, { status: [] })), "no date and no word is no evidence").toEqual(["muted", "expiry unknown", "domain expiry unknown"]);
    const th = clampMaint({ domain_warn_days: 10 });
    expect(domainStates(input(ok(RD, doms(dom("a.com", 12)))), th, NOW)[0].level, "the team's threshold").toBe("ok");
    expect(clampMaint({ domain_warn_days: 0 }).domainWarnDays, "a zero would fire on every domain").toBe(30);
    expect(states(dom("far.com", 400), dom("soon.com", 12), dom("gone.com", -1), dom("near.com", 20)).map((d) => d.domain))
      .toEqual(["gone.com", "soon.com", "near.com", "far.com"]);
  });

  it("never lets a registered name vouch for an address, while one being lost still colours the cell", () => {
    expect(cell("prod", input(unasked, ok(RD, doms(dom("example.com", 400)))))).toMatchObject({ state: "cantCheck", level: "muted", text: "not checked" });
    expect(cell("prod", input(ok(RD, doms(dom("example.com", 400))))), "with nothing else to ask").toMatchObject({ state: "read", level: "muted", text: "addresses not checked" });
    expect(cell("prod", input(unasked, ok(RD, doms(dom("example.com", 400, { status: ["redemption period"] })))))).toMatchObject({ state: "read", level: "bad", text: "domain lapsed" });
    const both = cell("prod", input(ok(HP, probes()), ok(RD, doms(dom("example.com", 12), dom("example.org", 400)))));
    expect(both).toMatchObject({ level: "warn", text: "domain 12d" });
    expect(both.tip).toEqual(expect.arrayContaining(["example.com: expires in 12d · Cloudflare, Inc", "example.org: expires in 13mo · Cloudflare, Inc"]));
    expect(cell("prod", input(ok(HP, probes({ code: 502 })), ok(RD, doms(dom("example.com", 12))))), "an address down outranks a domain").toMatchObject({ level: "bad", text: "app 502" });
    expect(cell("prod", input(ok(HP, probes({ code: 404 })), ok(RD, doms(dom("example.com", -1))))), "a lost domain outranks a 4xx").toMatchObject({ level: "bad", text: "domain expired" });
    expect(cell("prod", input(ok(HP, probes()), ok(RD, doms(dom("example.com", null, { status: [] }))))), "its unknown never speaks over an answer").toMatchObject({ level: "ok", text: "" });
    const two = doms(dom("a.com", -1), dom("b.com", 1, { status: ["client hold"] }));
    expect(cell("prod", input(ok(HP, probes()), ok(RD, two)))).toMatchObject({ level: "bad", text: "2 domains at risk" });
    expect(cell("prod", input(ok(HP, probes()), ok(RD, two, { truncated: true }))), "its own report's cap").toMatchObject({ text: "2+ domains at risk" });
  });

  it("gives each domain at risk its own line, opening the Domains board", () => {
    const inp = input(ok(HP, probes()), ok(RD, doms(dom("example.com", 12), dom("example.org", 400), dom("x.io", -2, { names: ["docs"], registrar: null }))));
    const fs = findings("/r", inp, MAINT_DEFAULTS, NOW).filter((f) => f.key.startsWith("prod:domain:"));
    expect(fs.map((f) => [f.key, f.level, f.verb, f.ref, f.text, f.detail, f.source])).toEqual([
      ["prod:domain:x.io", "bad", "fix", "x.io", "x.io expired 2d ago", "behind docs", RD],
      ["prod:domain:example.com", "warn", "fix", "example.com", "example.com expires in 12d", "behind api, app · Cloudflare, Inc", RD],
    ]);
    expect(findingTarget({ facet: "prod", key: "prod:domain:example.com" })).toEqual({ tab: "servers", board: "domains" });
    expect(findingTarget({ facet: "prod", key: "prod:app" })).toEqual({ tab: "servers", board: "addresses" });
    expect(sessionKind(fs[0]), "a renewal is paid at the registrar, not written on a branch").toBe("here");
  });

  it("lists a registration inside the window as coming up, never one past or beyond it", () => {
    const rows = comingUp([{ root: "/a", inp: input(ok(RD, doms(dom("soon.com", 9), dom("gone.com", -1), dom("far.com", 31), dom("none.de", null)))) }], NOW);
    expect(rows).toEqual([{ root: "/a", what: "soon.com registration", at: S + 9 * D }]);
  });

  it("keeps the registries out of Check prod: a third party has its own switch and its own door", () => {
    const d = det([HP, RD]), inp: MaintInput = { det: d, reports: { [HP]: unasked, [RD]: { ...not(RD, "prod", { state: "notRun" }), cost: "public" } } };
    expect(prodChecks(inp)).toEqual([HP]);
    expect(offers("/r", inp).map((f) => [f.key, f.text])).toEqual([["run:http-probe", "URL checks: not checked"], ["run:rdap-domain", "RDAP: not checked"]]);
    const sees = new Set<MaintCap>(), blind = new Set<MaintCap>();
    addCoverCaps({ ...inp, reports: { ...inp.reports, [HP]: ok(HP, probes()) } }, sees, blind);
    expect([sees.has("prod.status"), blind.has("prod.domain")], "domain expiry is unseen until a registry answers").toEqual([true, true]);
  });

  it("draws one row per domain across projects, worst then soonest, its verbs drawn", () => {
    const ps = [
      tp("/b", ok(RD, doms(dom("b.com", 20), dom("b.org", 400)))),
      tp("/a", ok(RD, doms(dom("a.com", 400, { status: ["client hold"] })))),
      tp("/c", ok(RD, doms(dom("c.com", 12)))),
    ];
    const b = tabBoards("servers", ps, null, null, NOW);
    expect(b.domains.map((r) => [r.root, r.domain, r.level, r.verb?.key ?? null])).toEqual([
      ["/a", "a.com", "bad", "prod:domain:a.com"], ["/c", "c.com", "warn", "prod:domain:c.com"],
      ["/b", "b.com", "warn", "prod:domain:b.com"], ["/b", "b.org", "ok", null],
    ]);
    expect(b.drawn).toEqual(["/a|prod:domain:a.com", "/b|prod:domain:b.com", "/c|prod:domain:c.com"]);
    expect(tabBoards("servers", ps, "/c", null, NOW).domains.map((r) => r.domain)).toEqual(["c.com"]);
    expect(boardDoor("domains", "registrar", "https://registrar.example/")).toEqual({ to: "url", url: "https://registrar.example/" });
    expect(boardDoor("domains", "registrar", "javascript:alert(1)")).toBeNull();
  });

  it("refuses a domain of the wrong shape, as any other report", () => {
    const good = ok(RD, doms(dom("a.com", 9)));
    expect(narrowMaint(good, RD)).toEqual(good);
    expect(narrowMaint({ ...good, facts: doms({ ...dom("a.com", 9), domain: 3 as unknown as string }) }, RD).coverage.state).toBe("error");
    expect(narrowMaint({ ...good, facts: doms({ ...dom("a.com", 9), status: "active" as unknown as string[] }) }, RD).coverage.state).toBe("error");
  });

  it("reads a domain [deploy] no longer names as nobody having asked, and names each by what names it now", () => {
    const cfg = (urls: Record<string, string>, versionUrl: string | null = null) =>
      det([RD], { deploy: { host: null, compose: [], urls, sentry: null, versionUrl, envs: {} } });
    const reports = { [RD]: ok(RD, doms(dom("example.com", 9, { names: ["old"] }), dom("gone.org", 9))) };
    const now = currentDomains(cfg({ app: "https://APP.example.com./x", www: "https://example.com" }, "https://api.example.com/v"), reports)[RD];
    expect(now.facts).toEqual(doms(dom("example.com", 9, { names: ["app", "version", "www"] })));
    expect(currentDomains(cfg({ app: "https://elsewhere.net" }), reports)[RD]).toMatchObject({ coverage: { state: "notRun" }, facts: null, at: null });
    expect(currentDomains(det([RD]), reports), "no [deploy], nothing to compare").toBe(reports);
  });

  it("lets a domain's failed or unasked read keep its last line beside the addresses' answer, and an answer replace it", () => {
    const lines = (s: ReturnType<typeof takeSnap>) => s.findings.filter((f) => f.facet === "prod").map((f) => f.key);
    const red = takeSnap("/r", input(ok(HP, probes()), ok(RD, doms(dom("a.com", -1)))), NOW - 1000);
    const failed = takeSnap("/r", input(ok(HP, probes()), not(RD, "prod", { state: "error", reason: "HTTP 503" })), NOW, red);
    expect(lines(failed)).toEqual(["prod:domain:a.com"]);
    expect(failed.cells.find((c) => c.facet === "prod")).toMatchObject({ level: "bad", at: NOW - 1000 });
    expect(lines(takeSnap("/r", input(ok(HP, probes()), not(RD, "prod", { state: "notRun" })), NOW, red)), "nobody asked").toEqual(["prod:domain:a.com"]);
    expect(lines(takeSnap("/r", input(ok(HP, probes()), ok(RD, doms(dom("a.com", 400)))), NOW, red)), "renewed").toEqual([]);
    expect(lines(takeSnap("/r", input(ok(HP, probes())), NOW, red)), "no longer in [deploy]").toEqual([]);
    const row = (inp: MaintInput) => coverGroups("servers", [{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) }], null, NOW).map((g) => [g.source, g.why]);
    expect(row(input(ok(HP, probes()), not(RD, "prod", { state: "error", reason: "HTTP 503" }))), "a failed read beside a good one stays a Coverage row").toEqual([[RD, "read failed"]]);
  });

  it("lets a domain that answered replace its lines while the cell cannot vouch, and keeps the addresses' unasked ones", () => {
    const prodOf = (s: ReturnType<typeof takeSnap>) => ({ cell: s.cells.find((c) => c.facet === "prod"), lines: s.findings.filter((f) => f.facet === "prod").map((f) => f.key) });
    const red = takeSnap("/r", input(unasked, ok(RD, doms(dom("a.com", 300, { status: ["redemption period"] })))), NOW - 1000);
    expect(prodOf(red).lines).toEqual(["prod:domain:a.com"]);
    const renewed = prodOf(takeSnap("/r", input(unasked, ok(RD, doms(dom("a.com", 400)))), NOW, red));
    expect(renewed).toEqual({ cell: { facet: "prod", level: "muted", text: "not checked" }, lines: [] });
    const failed = input(not(HP, "prod", { state: "error", reason: "timed out" }), ok(RD, doms(dom("a.com", 400))));
    expect(prodOf(takeSnap("/r", failed, NOW, red)).lines, "beside a failed address read too").toEqual([]);
    const down = takeSnap("/r", input(ok(HP, probes({ code: 502 })), ok(RD, doms(dom("a.com", 400)))), NOW - 1000);
    const held = prodOf(takeSnap("/r", input(unasked, ok(RD, doms(dom("a.com", 400)))), NOW, down));
    expect(held.lines, "an address nobody asked keeps its last line").toEqual(["prod:app"]);
    expect(held.cell).toMatchObject({ level: "bad", at: NOW - 1000 });
  });

  it("says not checked beside a TLD no registry answers for, and gives the reasons an address was never sent", () => {
    const deOnly = not(RD, "prod", { state: "unsupported", reason: ".de lists no RDAP service" });
    expect(cell("prod", input(unasked, deOnly)), "unavailable would read as prod being down").toMatchObject({ state: "cantCheck", text: "not checked" });
    expect(cell("prod", input(deOnly)), "with nothing else to ask").toMatchObject({ state: "cantCheck", text: "unavailable" });
    expect(cell("prod", input(not(HP, "prod", { state: "error", reason: "x" }), deOnly)).text, "a failure still leads").toBe("read failed");
    const gap = "lan: not asked, an IP address";
    const skipped = cell("prod", input(unasked, ok(RD, doms(dom("example.com", 400)), { gaps: [gap] })));
    expect(skipped).toMatchObject({ state: "cantCheck", text: "not checked" });
    expect(skipped.tip).toContain(`RDAP: ${gap}`);
  });
});

// Found by what it sees, never by its id: the frontend names no tracker.
describe("errors in production", () => {
  const SE = SOURCES.find((s) => s.sees.includes("prod.errors"))!.id, HP = "http-probe";
  type ErrFacts = Extract<Facts, { kind: "errors" }>;
  const iss = (o: Partial<ErrIssue> = {}): ErrIssue => ({
    id: "1", shortId: "API-1", title: "TypeError: x is undefined", culprit: "app/views in index", level: "error", rawLevel: "error",
    trend: "new", rawTrend: "new", events: 9, users: 3, firstSeen: S - 2 * D, lastSeen: S - H, unhandled: true, url: "https://errors.example/1/", ...o,
  });
  const old = (o: Partial<ErrIssue> = {}) => iss({ trend: "ongoing", rawTrend: "ongoing", firstSeen: S - 90 * D, ...o });
  const errs = (issues: ErrIssue[], o: Partial<ErrFacts> = {}): ErrFacts => ({
    kind: "errors", project: "acme/api", environment: null, windowDays: 14, release: { version: "api@1.4.0", at: S - 5 * D, newIssues: 1 },
    lastEvent: S - H, url: "https://errors.example/acme/", issues, ...o,
  });
  const rep = (issues: ErrIssue[], o: Partial<ErrFacts> = {}, r: Partial<SourceReport> = {}): SourceReport => ({ ...ok(SE, errs(issues, o), r), cost: "remote" });
  const fine = { name: "app", url: "https://app.example.com", code: 200, ms: 9, certNotAfter: S + 90 * D, err: null };
  const probes = (o = {}): Facts => ({ kind: "probes", items: [{ ...fine, ...o }] });
  const said = (inp: MaintInput, th = MAINT_DEFAULTS) => { const c = facetCell("prod", inp, th, NOW); return [c.level, c.text]; };
  const of = (state: string, n = 0) => wire.reports.filter((r) => r.source === SE && (r.coverage as Coverage).state === state)[n].coverage as Coverage;
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const linked = (sentry: string | null, params: Record<string, string> = {}) =>
    det([SE], { deploy: { host: null, compose: [], urls: {}, sentry, versionUrl: null, envs: {} }, config: { ...det([]).config, params } });

  it("reads the backend's own report: levels and trends in the closed vocabulary", () => {
    const r = wire.reports.find((x) => x.source === SE && (x.facts as Facts | null)?.kind === "errors")!;
    const f = narrowMaint(r, SE).facts as ErrFacts;
    expect(f.issues.length).toBeGreaterThan(1);
    for (const i of f.issues) { expect(ERR_LEVELS).toContain(i.level); expect(ERR_TRENDS).toContain(i.trend); }
    // Its window's first events all fall after the release; only the issues' own first sightings may call one new.
    const [st] = errorStates(input(narrowMaint(r, SE)), MAINT_DEFAULTS, NOW);
    expect(st.needy.map((x) => [x.shortId, x.why])).not.toContainEqual(["PUMP-STATION-3", "new"]);
    expect(st.needy.find((x) => x.shortId === "PUMP-STATION-17")?.why, "older than the release, back after a fix").toBe("regressed");
    const good = rep([iss()]);
    expect(narrowMaint(good, SE)).toEqual(good);
    expect(narrowMaint({ ...good, facts: errs([{ ...iss(), level: "critical" as ErrIssue["level"] }]) }, SE).coverage.state, "a level Rust never sends").toBe("error");
    expect(narrowMaint({ ...good, facts: errs([{ ...iss(), events: "150" as unknown as number }]) }, SE).coverage.state).toBe("error");
  });

  it("calls an issue new by its first sighting since the release, and by the tracker's own word without one", () => {
    expect(said(input(rep([iss()])))).toEqual(["warn", "1 new since 1.4.0"]);
    expect(said(input(rep([iss({ firstSeen: S - 9 * D })]))), "new to the tracker, but older than the release").toEqual(["info", "1 unresolved"]);
    expect(said(input(rep([iss({ firstSeen: S - 9 * D })], { release: null })))).toEqual(["warn", "1 new this week"]);
    expect(said(input(rep([iss({ trend: "ongoing" })], { release: { version: "2.0", at: null, newIssues: null } }))), "an undated release is none").toEqual(["info", "1 unresolved"]);
    const tip = (o: Partial<ErrFacts>) => facetCell("prod", input(rep([iss()], o)), MAINT_DEFAULTS, NOW).tip;
    expect(tip({})).toContain(`new: first seen since 1.4.0 went out on ${fmtDay((S - 5 * D) * 1000)}`);
    expect(tip({ release: null })).toContain("new: first seen in the last 7 days, the tracker's own word, since it records no release");
    expect(tip({ environment: "production" })[0]).toBe("acme/api, environment production: 1 unresolved seen in 14 days");
    expect(tip({})[0]).toBe("acme/api, every environment: 1 unresolved seen in 14 days");
  });

  it("is amber for what is new or back, red for a crash or one reaching error_users, and a backlog only informs", () => {
    expect(said(input(rep([old({ trend: "regressed" })])))).toEqual(["warn", "1 regressed"]);
    expect(said(input(rep([old({ trend: "escalating" })])))).toEqual(["warn", "1 escalating"]);
    expect(said(input(rep([old({ trend: "regressed" }), old({ id: "2", trend: "escalating" })])))).toEqual(["warn", "2 back"]);
    expect(said(input(rep([iss(), old({ id: "2", trend: "regressed" })])))).toEqual(["warn", "2 new or back"]);
    expect(said(input(rep([iss({ level: "fatal" })])))).toEqual(["bad", "1 new since 1.4.0"]);
    expect(said(input(rep([old({ trend: "regressed", users: 100 })])))).toEqual(["bad", "1 regressed"]);
    expect(said(input(rep([old({ trend: "regressed", users: 100 })])), clampMaint({ error_users: 500 }))).toEqual(["warn", "1 regressed"]);
    expect(said(input(rep([iss(), old({ id: "2" })])), clampMaint({ new_errors: 2 })), "below the team's count, a backlog").toEqual(["info", "2 unresolved"]);
    expect(said(input(rep([old(), old({ id: "2" }), old({ id: "3", users: 5000 })]))), "an old backlog, however wide, never amber").toEqual(["info", "3 unresolved"]);
    expect(clampMaint({ new_errors: 0, error_users: -1 })).toMatchObject({ newErrors: 1, errorUsers: 100 });
    expect(MAINT_DEFAULTS).toMatchObject({ newErrors: 1, errorUsers: 100 });
  });

  it("draws the dot only on positive evidence: a quiet tracker is silent, and a cut list a floor", () => {
    expect(said(input(rep([])))).toEqual(["ok", ""]);
    expect(said(input(rep([], { lastEvent: null })))).toEqual(["muted", "silent"]);
    expect(said(input(rep([], { lastEvent: S - 20 * D })))).toEqual(["muted", "silent"]);
    expect(facetCell("prod", input(rep([], { lastEvent: null })), MAINT_DEFAULTS, NOW).tip).toContain("no event reached it in 14 days, so nothing says it still hears this project");
    const quiet = input(ok(HP, probes()), rep([], { lastEvent: null }));
    expect(coverGroups("servers", [{ path: "/r", inp: quiet, cells: facetCells(quiet, MAINT_DEFAULTS, NOW) }], null, NOW).find((g) => g.why === "silent")?.detail,
      "beside a fine address, the row says why the tracker is silent").toBe("no event reached it in 14 days, so nothing says it still hears this project");
    expect(said(input(rep(Array.from({ length: 100 }, (_, n) => old({ id: String(n) })), {}, { truncated: true })))).toEqual(["info", "100+ unresolved"]);
    expect(said(input(rep([iss(), iss({ id: "2" })], {}, { truncated: true })))).toEqual(["warn", "2+ new since 1.4.0"]);
  });

  it("joins the addresses through the worse of the two, and says no deploy only when nothing answered", () => {
    expect(said(input(ok(HP, probes()), rep([iss()])))).toEqual(["warn", "1 new since 1.4.0"]);
    expect(said(input(ok(HP, probes({ code: 502 })), rep([iss()])))).toEqual(["bad", "app 502"]);
    expect(said(input(ok(HP, probes()), rep([old()])))).toEqual(["info", "1 unresolved"]);
    expect(said(input(rep([]))), "a tracker that heard events vouches alone").toEqual(["ok", ""]);
    expect(said(input())).toEqual(["muted", "no deploy"]);
    expect(said(input(ok(HP, probes()), not(SE, "prod", of("noTool"))))[0], "a failed tracker beside a good address reaches the cell").not.toBe("muted");
    expect(said(input(not(SE, "prod", of("noTool"))))).toEqual(["muted", "no token"]);
    const prod = facetCell("prod", input(ok(HP, probes()), rep([iss()])), MAINT_DEFAULTS, NOW);
    expect(hostRows([{ path: "/a", hosts: ["p"], prod, read: true }]).map((r) => [r.level, r.text]), "a host row reads the Prod cell, errors and all").toEqual([["warn", "1 new since 1.4.0"]]);
  });

  it("gives every new or returning issue one Fix line, on a branch, below Servers' boards until its own exists", () => {
    const line = (...issues: ErrIssue[]) => (o: Partial<ErrFacts> = {}, r: Partial<SourceReport> = {}) =>
      findings("/r", input(ok(HP, probes()), rep(issues, o, r)), MAINT_DEFAULTS, NOW).find((f) => f.key === "prod:errors:new");
    const one = line(iss({ shortId: "API-12A" }))()!;
    expect([one.level, one.verb, one.source, one.ref, one.text, one.detail]).toEqual(["warn", "fix", SE, "acme/api", "API-12A new since 1.4.0", "TypeError: x is undefined"]);
    expect(line(iss())({ release: null })!.text).toBe("API-1 new this week");
    expect(line(old({ trend: "regressed" }))()!.text).toBe("API-1 regressed");
    expect(line(iss())({}, { truncated: true })!.text, "a cut list never reads as one").toBe("1+ new errors since 1.4.0");
    const four = [1, 2, 3, 4].map((n) => iss({ id: String(n), title: `E${n}`, users: n }));
    expect(line(...four)()).toMatchObject({ text: "4 new errors since 1.4.0", detail: "E4 · E3 · E2 …" });
    expect(line(old({ trend: "regressed" }), old({ id: "2", trend: "escalating" }))()!.text).toBe("2 errors back");
    expect(line(iss({ level: "fatal" }), old({ id: "2", trend: "regressed" }))()).toMatchObject({ level: "bad", text: "2 errors new or back" });
    expect(line(old())(), "a backlog has no line").toBeUndefined();
    const f = line(iss())()!;
    expect(findingTarget(f)).toEqual({ tab: "servers", board: null });
    expect(findingTarget({ facet: "prod", key: "prod:errors" }), "a url named errors is still an address").toEqual({ tab: "servers", board: "addresses" });
    const p = tp("/r", ok(HP, probes()), rep([iss()]));
    expect(tabModel("servers", [p], "/r", null, NOW).rows.map((r) => r.key)).toContain("prod:errors:new");
    expect(sessionKind(f), "its brief asks for a fix in code").toBe("branch");
    expect(briefFor(f, p.inp, { project: "acme", verify: [], now: NOW })).toMatch(/^API-1 in acme's error tracker/);
  });

  it("says no token, token refused and token scope in Rust's own words, each with Settings › Accounts as its door", () => {
    expect([whyWord(of("noTool"), "prod"), whyWord(of("noAccess", 0), "prod"), whyWord(of("noAccess", 1), "prod")]).toEqual(["no token", "token refused", "token scope"]);
    expect([tokenDoor(SE, of("noTool"), "prod"), tokenDoor(SE, of("noAccess", 0), "prod"), tokenDoor(SE, of("noAccess", 1), "prod")]).toEqual(["add", "replace", "replace"]);
    expect(tokenDoor(SE, { state: "error", reason: "rate limited by sentry.io" }, "prod"), "a rate limit is no token's").toBeNull();
    expect(tokenDoor(HP, of("noTool"), "prod"), "a source with no token row").toBeNull();
    expect(tokenDoor(SE, { state: "noTool", tool: "a token for x", fix: "run this" }, "prod"), "a command beats a door").toBeNull();
    const groups = (c: Coverage) => {
      const inp = input(ok(HP, probes()), not(SE, "prod", c));
      return coverGroups("servers", [{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW) }], null, NOW).filter((g) => g.source === SE);
    };
    expect(groups(of("noTool")).map((g) => [g.why, g.action])).toEqual([["no token", { kind: "token", source: SE, door: "add" }]]);
    expect(groups(of("noAccess", 0)).map((g) => g.action)).toEqual([{ kind: "token", source: SE, door: "replace" }]);
    expect(coverRows(input(not(SE, "prod", of("noTool")))).find((r) => r.source === SE)).toMatchObject({ state: "noTool", text: "a token for sentry.io not available", token: "add" });
    expect(coverRows(input(rep([]))).find((r) => r.source === SE)!.token).toBeNull();
  });

  it("reads facts about a project or an environment [deploy] no longer names as nobody having asked", () => {
    const reports = { [SE]: rep([iss()]) };
    expect(currentErrors(linked("acme/api"), reports)[SE]).toBe(reports[SE]);
    expect(currentErrors(linked("acme/web"), reports)[SE]).toMatchObject({ coverage: { state: "notRun" }, facts: null, at: null });
    expect(currentErrors(linked("acme/api", { sentry_environment: "production" }), reports)[SE].facts, "another environment's count").toBeNull();
    expect(currentErrors(linked(null), reports)[SE].facts).toBeNull();
    expect(currentErrors(linked("acme/api", { sentry_environment: "" }), reports)[SE], "an empty name is every environment, as Rust reads it").toBe(reports[SE]);
    expect(currentErrors(null, reports)).toBe(reports);
  });

  it("gives the Runs on card one line: the project, the cell's words, when it was asked, or why not", () => {
    const at = (d: Detection, ...reps: SourceReport[]): MaintInput => ({ det: d, reports: Object.fromEntries(reps.map((r) => [r.source, r])) });
    expect(errorSummary(at(linked("acme/api"), rep([iss()])), MAINT_DEFAULTS, NOW)).toMatchObject({ project: "acme/api", level: "warn", text: "1 new since 1.4.0", at: S, why: null });
    expect(errorSummary(at(linked("acme/api"), rep([])), MAINT_DEFAULTS, NOW)).toMatchObject({ level: "ok", text: "nothing new" });
    expect(errorSummary(at(linked("acme/api")), MAINT_DEFAULTS, NOW)).toMatchObject({ level: "muted", text: "not checked", why: "not checked", at: null });
    expect(errorSummary(at(linked("acme/api"), not(SE, "prod", of("noTool"))), MAINT_DEFAULTS, NOW))
      .toMatchObject({ text: "no token", tip: ["a token for sentry.io not available"] });
    expect(errorSummary(at(linked(null)), MAINT_DEFAULTS, NOW)).toBeNull();
    const off = linked("acme/api");
    off.config.off = ["prod"];
    expect(errorSummary(at(off, rep([iss()])), MAINT_DEFAULTS, NOW), "prod not tracked").toBeNull();
  });

  it("is asked by Check prod, whose tip and empty toast name it from its manifest row", () => {
    const d = det([HP, SE]), inp: MaintInput = { det: d, reports: { [HP]: not(HP, "prod", { state: "notRun" }), [SE]: { ...not(SE, "prod", { state: "notRun" }), cost: "remote" } } };
    expect(prodChecks(inp)).toEqual([HP, SE]);
    const label = SOURCES.find((s) => s.id === SE)!.label;
    expect(prodTip([HP, SE], [])).toContain(`${label}: the unresolved issues and newest release of the project [deploy] names, sent its name and the token saved for its host`);
    expect(tabBoards("servers", [tp("/r", rep([]))], null, null, NOW).unchecked, "a tracker alone leaves no address unchecked").toBe(0);
    const sees = new Set<MaintCap>(), blind = new Set<MaintCap>();
    addCoverCaps(input(ok(HP, probes())), sees, blind);
    expect(blind.has("prod.errors"), "an address says nothing of errors").toBe(true);
    const s2 = new Set<MaintCap>(), b2 = new Set<MaintCap>();
    addCoverCaps(input(rep([])), s2, b2);
    expect([s2.has("prod.errors"), s2.has("prod.errors-new"), b2.has("prod.status"), b2.has("prod.host")]).toEqual([true, true, true, true]);
  });

  it("keeps its line through a failed or unasked read beside an address answer, and an answer replaces it", () => {
    const lines = (s: ReturnType<typeof takeSnap>) => s.findings.filter((f) => f.facet === "prod").map((f) => f.key);
    const red = takeSnap("/r", input(ok(HP, probes()), rep([iss({ level: "fatal" })])), NOW - 1000);
    expect(lines(red)).toEqual(["prod:errors:new"]);
    const failed = takeSnap("/r", input(ok(HP, probes()), not(SE, "prod", { state: "error", reason: "rate limited" })), NOW, red);
    expect(lines(failed)).toEqual(["prod:errors:new"]);
    expect(failed.cells.find((c) => c.facet === "prod")).toMatchObject({ level: "bad", at: NOW - 1000 });
    expect(lines(takeSnap("/r", input(ok(HP, probes()), not(SE, "prod", { state: "notRun" })), NOW, red)), "nobody asked").toEqual(["prod:errors:new"]);
    expect(lines(takeSnap("/r", input(ok(HP, probes()), rep([old()])), NOW, red)), "fixed").toEqual([]);
    expect(lines(takeSnap("/r", input(ok(HP, probes())), NOW, red)), "no longer linked").toEqual([]);
  });

  it("slims a kept list to what needs someone and the newest of the rest, never costing another project its place", () => {
    const backlog = Array.from({ length: 80 }, (_, n) => old({ id: String(100 + n), title: `old ${"x".repeat(200)} ${n}` }));
    const scan = (at: number, reps: SourceReport[]) => { const inp = input(ok(GHA, ci(run("build", "fail", S - D))), ...reps); return { at, account: "me", det: inp.det!, reports: { ...inp.reports } }; };
    const big = scan(NOW, [rep([iss(), old({ id: "9", trend: "regressed" }), ...backlog])]), red = scan(NOW - H, []);
    const room = JSON.stringify({ "/big": scan(NOW, [rep([])]), "/red": red }).length + 9000;
    expect(JSON.stringify({ "/big": big, "/red": red }).length).toBeGreaterThan(room);
    const out = packKept({ "/big": big, "/red": red }, room);
    expect(Object.keys(out)).toEqual(["/big", "/red"]);
    const kept = out["/big"].reports[SE];
    expect([kept.truncated, kept.gaps]).toEqual([false, [KEPT_CUT]]);
    expect((kept.facts as ErrFacts).issues.map((i) => i.id)).toEqual(["1", "9", ...backlog.slice(0, KEPT_BACKLOG).map((i) => i.id)]);
    expect(said(input(kept)), "every needy issue kept, so its count is exact").toEqual(["warn", "2 new or back"]);
    expect(said(input(rep(backlog.slice(0, KEPT_BACKLOG), {}, { gaps: [KEPT_CUT] }))), "only the backlog is a floor").toEqual(["info", `${KEPT_BACKLOG}+ unresolved`]);
    expect(packKept({ "/big": big, "/red": red })["/big"], "with room it stays whole").toEqual(big);
  });
});

describe("the tabs' boards", () => {
  // A project as buildMaint hands it to the boards: its cells and its tab lines, verbs and all.
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const alerts = (...items: Advisory[]) => ok("dependabot-alerts", { kind: "advisories", items });
  const work = (issues: number, prs: number, reviewRequested: number | null): Facts => ({ kind: "work", issues, prs, reviewRequested });
  const shuffled = <T>(xs: T[]) => [...xs].reverse();

  it("folds one advisory reported in three projects into one row, its projects as chips, at the worst severity", () => {
    const ps = [
      tp("/c", alerts(adv({ id: "GHSA-x", severity: "medium", version: "4.17.19" }))),
      tp("/a", alerts(adv({ id: "CVE-1", aliases: ["ghsa-x"], severity: "critical", fixed: "4.17.22" }))),
      tp("/b", alerts(adv({ id: "GHSA-x", severity: "high" }), adv({ id: "B-2", pkg: "minimist", severity: "low", fixed: null }))),
    ];
    const { rows, read } = advisoryRows(ps);
    expect(read).toBe(3);
    expect(rows.map((r) => [r.id, r.bucket, r.level, r.projects.map((p) => p.root)])).toEqual([
      ["CVE-1", "critical", "bad", ["/a", "/b", "/c"]], ["B-2", "low", "info", ["/b"]],
    ]);
    const [x] = rows;
    expect([x.what, x.installed, x.fixed]).toEqual(["lodash", ["4.17.19", "4.17.20"], ["4.17.21", "4.17.22"]]);
    // Each chip's verb is that project's own line for the kind, so a click briefs that project.
    expect(x.projects.map((p) => [p.verb?.root, p.verb?.key, p.verb?.verb])).toEqual([
      ["/a", "security:dependency", "patch"], ["/b", "security:dependency", "patch"], ["/c", "security:dependency", "patch"],
    ]);
    expect(advisoryRows(ps, "/c").rows.map((r) => [r.id, r.bucket, r.projects.length]), "narrowed: only what that project reported")
      .toEqual([["GHSA-x", "medium", 1]]);
  });

  it("counts the strip per severity, the four always and a secret only when there is one, and filters the rows but never the strip", () => {
    const ps = [
      tp("/a", alerts(adv({ id: "A", severity: "critical" }), adv({ id: "B", pkg: "x", severity: "medium" }))),
      tp("/b", alerts(adv({ id: "C", pkg: "y", severity: "medium" }))),
    ];
    const strip = (rows: ReturnType<typeof advisoryRows>["rows"]) => sevStrip(rows).map((c) => [c.bucket, c.n, c.level]);
    const all = advisoryRows(ps).rows;
    expect(strip(all)).toEqual([["critical", 1, "bad"], ["high", 0, "bad"], ["medium", 2, "warn"], ["low", 0, "info"]]);
    const secret = tp("/s", ok("github-secret-scanning", { kind: "advisories", items: [adv({ id: "S", kind: "secret", pkg: null, severity: "unknown" })] }));
    expect(strip(advisoryRows([...ps, secret]).rows)[0], "a secret leads, as it does in the cell").toEqual(["secret", 1, "bad"]);
    expect(bySev(all, "medium").map((r) => r.id)).toEqual(["B", "C"]);
    expect(bySev(all, null)).toEqual(all);
    const b = tabBoards("security", ps, null, "critical", NOW);
    expect(b.adv.map((r) => r.id)).toEqual(["A"]);
    expect(b.strip.map((c) => c.n), "the strip still counts every row").toEqual([1, 0, 2, 0]);
    // A severity filtered out still carries its projects' lines, so they never fall into the list below.
    expect(b.drawn).toEqual(["/a|security:dependency", "/b|security:dependency"]);
    // A secret picked and then gone (a rescan, a narrower filter) keeps its button, or nothing could clear it.
    const gone = tabBoards("security", ps, null, "secret", NOW);
    expect([gone.adv, gone.strip.map((c) => [c.bucket, c.n])[0]]).toEqual([[], ["secret", 0]]);
    expect(sevStrip(all, "unknown").map((c) => c.bucket)).toEqual(["critical", "high", "medium", "low", "unknown"]);
  });

  it("lists update pull requests per project and bot: open, red, the oldest's age, red first", () => {
    const ps = [
      tp("/a", ok("dependabot-prs", prs(2))),
      tp("/b", ok("dependabot-prs", prs(3, {}, "fail"))),
      tp("/c", ok("dependabot-prs", prs(0))),
    ];
    expect(updatePrRows(ps, null, NOW).map((r) => [r.root, r.bot, r.open, r.red, r.oldest, r.level, r.verb?.key])).toEqual([
      ["/b", "b", 3, 3, D, "warn", "deps:b"], ["/a", "b", 2, 0, D, "info", "deps:b"],
    ]);
  });

  it("gives every project whose CI was read a row: failing since the first red, its last runs oldest first and capped", () => {
    const many = Array.from({ length: 20 }, (_, i) => run("build", i < 2 ? "fail" : i === 5 ? "cancelled" : "pass", S - i * H));
    const ps = [
      tp("/green", ok(GHA, ci(run("build", "pass", S - H)))),
      tp("/red", ok(GHA, ci(...many))),
      tp("/none", ok("git-local", hyg())),
    ];
    const rows = ciBoard(ps, null, NOW);
    expect(rows.map((r) => [r.root, r.level, r.text, r.since, r.why])).toEqual([
      ["/red", "bad", "failing 1h", "1h", "build"], ["/green", "ok", "", null, "build · 1h ago"],
    ]);
    expect(rows[0].runs).toHaveLength(CI_STRIP);
    expect(rows[0].runs.slice(-3).map((r) => r.status), "newest last").toEqual(["pass", "fail", "fail"]);
    expect(rows[0].runs[CI_STRIP - 6].status, "the cancelled run, six from the end").toBe("cancelled");
    expect(rows[0].runs.at(-1), "a dot carries its run's page").toEqual({ workflow: "build", status: "fail", at: S, url: `https://ci.example/build/${S}` });
    expect(rows[0].verb?.key).toBe("ci");
    expect(rows[1].verb, "green has nothing to fix").toBeNull();
  });

  it("ranks the longest red first, and a running or never-run project after the red ones", () => {
    const ps = [
      tp("/young", ok(GHA, ci(run("t", "fail", S - H)))),
      tp("/old", ok(GHA, ci(run("t", "fail", S - H), run("t", "fail", S - 3 * D)))),
      tp("/never", ok(GHA, ci())),
      tp("/busy", ok(GHA, ci(run("t", "running", S - 60)))),
    ];
    expect(ciBoard(ps, null, NOW).map((r) => [r.root, r.since ?? r.text])).toEqual([
      ["/old", "3d"], ["/young", "1h"], ["/busy", "running"], ["/never", "never ran"],
    ]);
  });

  it("draws unreleased work as a share of the largest, and a project never tagged with no count", () => {
    const ps = [
      tp("/small", ok("git-tags", rel({ since: 10, oldestUnreleasedAt: S - 2 * D }))),
      tp("/big", ok("git-tags", rel({ since: 40, oldestUnreleasedAt: S - 25 * D }))),
      tp("/done", ok("git-tags", rel())),
      tp("/bare", ok("git-tags", rel({ tag: null, tagAt: null, since: 7 }))),
    ];
    expect(releaseBoard(ps, null, NOW).map((r) => [r.root, r.tag, r.since, r.ratio, r.oldest, r.level, r.verb?.verb ?? null])).toEqual([
      ["/big", "v1.0", 40, 1, 25 * D, "warn", "release"], ["/small", "v1.0", 10, 0.25, 2 * D, "info", "release"],
      ["/bare", null, 0, 0, null, "muted", null], ["/done", "v1.0", 0, 0, null, "ok", null],
    ]);
  });

  it("mutes every zero in the hygiene table, lets only a non-zero count speak, and puts Push and Tidy on its row", () => {
    const ps = [
      tp("/clean", ok("git-local", hyg())),
      tp("/messy", ok("git-local", hyg({ unpushed: 3, localOnly: ["wip"], merged: ["a", "b"], gone: ["c"] }))),
      tp("/nowhere", ok("git-local", hyg({ unpushed: null }))),
      tp("/stale", ok("git-local", hyg({ fetchedAt: S - 9 * D }))),
    ];
    const rows = hygieneBoard(ps, null, NOW);
    const cnt = (r: (typeof rows)[number]) => [r.unpushed, r.localOnly, r.merged, r.gone, r.idle].map((c) => `${c.n}:${c.level}`);
    expect(rows.map((r) => [r.root, r.level])).toEqual([["/messy", "warn"], ["/stale", "warn"], ["/nowhere", "muted"], ["/clean", "ok"]]);
    expect(cnt(rows[0]), "local-only is the Git cell's tip, not its colour").toEqual(["3:warn", "1:info", "2:info", "1:info", "0:ok"]);
    expect(cnt(rows[3]), "a zero is the grey dot, never a number").toEqual(["0:ok", "0:ok", "0:ok", "0:ok", "0:ok"]);
    expect(cnt(rows[2])[0], "no remote is unknown, not zero").toBe("null:muted");
    expect(rows[0].verbs.map((f) => f.verb)).toEqual(["push", "tidy"]);
    expect([rows[1].fetched.level, rows[1].verbs.map((f) => f.verb)]).toEqual(["warn", ["fetch"]]);
  });

  it("never calls merged zero when nothing was compared: no trunk, or a protect list git.rs could not read", () => {
    const merged = (...reps: SourceReport[]) => hygieneBoard([tp("/r", ...reps)], null, NOW)[0].merged;
    expect(merged(ok("git-local", hyg({ trunk: null })))).toMatchObject({ n: null, level: "muted" });
    expect(merged(ok("git-local", hyg(), { gaps: ["merged branches not read: .episko/episko.toml unreadable"] })))
      .toMatchObject({ n: null, level: "muted" });
    expect(merged(ok("git-local", hyg()))).toEqual({ n: 0, level: "ok", names: [] });
  });

  it("sorts open work by reviews waiting on you, then by size, and scales each bar to its column", () => {
    const ps = [
      tp("/big", ok("github-work", work(40, 10, 0))),
      tp("/asked", ok("github-work", work(2, 1, 2))),
      tp("/small", ok("github-work", work(4, 5, 0))),
      tp("/blind", ok("github-work", work(1, 0, null))),
    ];
    expect(workBoard(ps).map((r) => [r.root, r.review, r.issuesRatio, r.prsRatio, r.level, r.verbs[0]?.key])).toEqual([
      ["/asked", 2, 0.05, 0.1, "warn", "work:review"], ["/big", 0, 1, 1, "info", "work:open"],
      ["/small", 0, 0.1, 0.5, "info", "work:open"], ["/blind", null, 0.025, 0, "info", "work:open"],
    ]);
    // Both lines are the row's, so the open-work one never repeats below the board.
    expect(workBoard(ps)[0].verbs.map((f) => f.key)).toEqual(["work:review", "work:open"]);
    expect(tabBoards("work", ps, "/asked", null, NOW).drawn).toEqual(["/asked|work:open", "/asked|work:review"]);
  });

  it("keeps the reviews one source counted when another's search failed, as a floor", () => {
    const ps = [
      tp("/half", ok("github-work", work(1, 0, 3)), ok("gitlab-work", work(0, 0, null))),
      tp("/big", ok("github-work", work(40, 10, 0))),
    ];
    const rows = workBoard(ps);
    expect(rows.map((r) => [r.root, r.review, r.reviewPartial, r.level])).toEqual([["/half", 3, true, "warn"], ["/big", 0, false, "info"]]);
  });

  it("makes a Work count a door only where the dashboard's queue lists what it counts", () => {
    const ps = [
      tp("/gh", ok("github-work", work(4, 2, 1))),
      tp("/gl", ok("gitlab-work", work(4, 2, 1))),
      tp("/both", ok("github-work", work(1, 0, 0)), ok("gitlab-work", work(1, 0, 0))),
    ];
    // The queue has no GitLab threads, so its counts would open an empty chip.
    expect(workBoard(ps).map((r) => [r.root, r.queue]).sort()).toEqual([["/both", false], ["/gh", true], ["/gl", false]]);
  });

  it("lists every address last checked, the worst answer first", () => {
    const p = (name: string, code: number | null, days: number) => ({ name, url: `https://${name}`, code, ms: 9, certNotAfter: S + days * D, err: code ? null : "refused" });
    const ps = [
      tp("/a", ok("h", { kind: "probes", items: [p("app", 200, 90), p("api", null, 90)] })),
      tp("/b", ok("h", { kind: "probes", items: [p("www", 200, 5)] })),
    ];
    expect(probeBoard(ps, null, NOW).map((r) => [r.root, r.name, r.code, r.level, r.certLevel, r.verb?.key ?? null])).toEqual([
      ["/a", "api", null, "bad", "ok", "prod:api"], ["/b", "www", 200, "ok", "warn", "prod:cert:www"], ["/a", "app", 200, "ok", "ok", null],
    ]);
  });

  it("says an address is not checked yet only for a project in the filter whose check nobody asked for", () => {
    const pp = (path: string, coverage: Coverage) => {
      const inp: MaintInput = { det: det(["http-probe"]), reports: { "http-probe": { ...not("http-probe", "prod", coverage), cost: "remote" } } };
      return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
    };
    const ps = [pp("/never", { state: "notRun" }), pp("/broke", { state: "error", reason: "refused" }), tp("/bare", ok("git-local", hyg()))];
    expect(tabBoards("servers", ps, null, null, NOW).unchecked).toBe(1);
    expect(tabBoards("servers", ps, "/bare", null, NOW).unchecked, "a project with no [deploy] is not 'not checked'").toBe(0);
    expect(tabBoards("servers", ps, "/broke", null, NOW).unchecked, "a check that failed is Coverage's to explain").toBe(0);
  });

  it("honours the project filter and sorts the same whatever order the projects came in", () => {
    const probe = (name: string, code: number) => ok("h", { kind: "probes", items: [{ name, url: `https://${name}`, code, ms: 9, certNotAfter: S + 90 * D, err: null }] });
    // /b the bigger on every board, so the reversed order exercises the ranking keys and not only the path tiebreak.
    const ps = [
      tp("/a", alerts(adv()), ok(GHA, ci(run("t", "pass", S))), ok("git-tags", rel({ since: 3 })), ok("git-local", hyg()),
        ok("github-work", work(1, 1, 0)), ok("dependabot-prs", prs(1)), probe("app", 200)),
      tp("/b", alerts(adv()), ok(GHA, ci(run("t", "fail", S))), ok("git-tags", rel({ since: 9 })), ok("git-local", hyg({ unpushed: 2 })),
        ok("github-work", work(5, 2, 1)), ok("dependabot-prs", prs(2, {}, "fail")), probe("www", 500)),
    ];
    for (const tab of MAINT_TABS) {
      const b = tabBoards(tab, ps, null, null, NOW);
      expect(tabBoards(tab, shuffled(ps), null, null, NOW), `${tab}: a repaint never reorders`).toEqual(b);
      const one = tabBoards(tab, ps, "/b", null, NOW);
      const roots = [...one.adv.flatMap((r) => r.projects.map((p) => p.root)), ...[one.prs, one.ci, one.releases, one.hygiene, one.work, one.probes]
        .flat().map((r) => r.root)];
      expect(new Set(roots), `${tab}: narrowed to /b`).toEqual(new Set(["/b"]));
      expect(one.drawn.every((k) => k.startsWith("/b|")), tab).toBe(true);
      const firsts = [b.prs, b.ci, b.releases, b.hygiene, b.work, b.probes].flatMap((xs) => xs.length ? [xs[0].root] : []);
      expect(firsts.every((r) => r === "/b"), `${tab}: the bigger first`).toBe(true);
    }
    expect(tabBoards("delivery", ps, "/b", null, NOW).read).toEqual({ ci: 1, release: 1 });
  });

  it("leaves a line no board carries to the list below them, and claims only the lines it draws a verb for", () => {
    const ps = [tp("/r", ok("git-local", hyg({ unpushed: 2, merged: ["x"] })))];
    const rows = ps[0].rows;
    expect(rows.map((f) => f.key)).toEqual(expect.arrayContaining(["ci:setup", "git:unpushed", "git:tidy"]));
    expect(tabBoards("code", ps, null, null, NOW).drawn).toEqual(["/r|git:tidy", "/r|git:unpushed"]);
    expect(tabBoards("delivery", ps, null, null, NOW).drawn, "Set up is no board's: it stays a line").toEqual([]);
  });
});

describe("a board's numbers are doors", () => {
  const branches = (filter: Extract<Door, { to: "branches" }>["filter"]): Door => ({ to: "branches", filter });
  // Every number column of every board, and where it opens: "url" takes the cell's own address.
  const WHERE: Record<BoardId, Record<string, Door | "url" | null>> = {
    advisories: {}, packages: { behind: { to: "deps", tab: "stale" }, latest: "url" }, runtimes: { ends: "url" },
    "update-prs": { open: { to: "deps", tab: "prs" }, green: { to: "deps", tab: "prs" }, red: { to: "deps", tab: "prs" } },
    ci: { run: "url" },
    flaky: { passed: null, last: "url" },
    deployments: { site: "url", behind: { to: "landed" }, log: "url" },
    releases: { since: { to: "landed" }, changelog: null },
    hygiene: {
      unpushed: branches("unpushed"), localOnly: branches("localonly"), merged: branches("merged"), gone: branches("gone"),
      stale: branches("untouched"), idle: { to: "checkouts" }, fetched: { to: "fetch" },
    },
    work: { review: { to: "queue", filter: "pr" }, issues: { to: "queue", filter: "iss" }, prs: { to: "queue", filter: "pr" } },
    hosts: { disk: null, updates: null, reboot: null, containers: null, load: null, uptime: null },
    addresses: { address: "url" },
    domains: { registrar: "url" },
  };

  it("names every column of every board", () => {
    expect(Object.keys(BOARD_COLS).sort()).toEqual([...BOARD_IDS].sort());
    for (const b of BOARD_IDS) expect(BOARD_COLS[b], b).toEqual(Object.keys(WHERE[b]));
  });

  it("opens each column where what it counts is acted on, and a zero or an unknown nowhere", () => {
    for (const b of BOARD_IDS) {
      for (const [col, to] of Object.entries(WHERE[b])) {
        const at = `${b}.${col}`;
        expect(boardDoor(b, col, 0), `${at}: a zero is the grey dot`).toBeNull();
        expect(boardDoor(b, col, null), `${at}: an unknown is a ?`).toBeNull();
        expect(boardDoor(b, col, ""), at).toBeNull();
        if (to === "url") {
          expect(boardDoor(b, col, "https://ci.example/run/1"), at).toEqual({ to: "url", url: "https://ci.example/run/1" });
          expect(boardDoor(b, col, "javascript:alert(1)"), `${at}: only a web page`).toBeNull();
          expect(boardDoor(b, col, 3), `${at}: a count is not a page`).toBeNull();
          expect(doorAt(b, col), `${at}: a page goes through data-mturl`).toBeNull();
        } else {
          expect(boardDoor(b, col, 3), at).toEqual(to);
          expect(boardDoor(b, col, "3"), `${at}: a door takes a count`).toBeNull();
          expect(doorAt(b, col), at).toEqual(to);
        }
      }
      expect(boardDoor(b, "nope", 3), `${b}: a column no board has`).toBeNull();
    }
  });

  it("opens Branches only on a chip the view has", () => {
    const ids = BRANCH_FILTERS.map((f) => f.id);
    for (const cols of Object.values(WHERE)) {
      for (const d of Object.values(cols)) if (d && d !== "url" && d.to === "branches") expect(ids).toContain(d.filter);
    }
  });

  it("peeks at what a count counts: the first names, then how many more", () => {
    expect(peekNames([])).toBe("");
    expect(peekNames(["a", "b"])).toBe("a, b");
    expect(peekNames(["a", "b", "c", "d"], 2)).toBe("a, b +2 more");
    expect(peekNames(["a", "b", "c"], 2, 120), "a capped list counts against the true total").toBe("a, b +118 more");
    const [r] = hygieneBoard([{ path: "/r", ...(() => {
      const inp = input(ok("git-local", hyg({
        localOnly: ["wip"], merged: ["a", "b"], gone: ["c"], branches: [{ name: "wip", at: S - 40 * D }],
        worktrees: [{ path: "C:\\wt\\spike", branch: "spike", at: S - 40 * D }],
      })));
      return { inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings("/r", inp, MAINT_DEFAULTS, NOW) };
    })() }], null, NOW);
    expect([r.localOnly, r.merged, r.gone, r.stale, r.idle].map((c) => c.names)).toEqual([["wip"], ["a", "b"], ["c"], ["wip"], ["spike"]]);
    expect(r.unpushed.names, "commits have no names").toEqual([]);
  });
});

describe("a card line opens what it summarises", () => {
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const scan = (items: Advisory[]) => ok("github-code-scanning", { kind: "advisories", items });
  const probe = (name: string, code: number | null, days: number) =>
    ({ name, url: `https://${name}`, code, ms: 9, certNotAfter: S + days * D, err: code ? null : "refused" });

  it("opens every kind of line on its facet's tab, at the board that carries its verb", () => {
    const p = tp("/r",
      ok(GHA, ci(run("build", "fail", S - H))),
      ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: null, runs: 9, reran: 2, jobs: [
        { workflow: "ci", job: "e2e", reruns: 2, passed: 2, steps: [], seen: [] }] }),
      ok("dependabot-alerts", { kind: "advisories", items: [adv()] }),
      scan([adv({ id: "C-1", kind: "code", pkg: null, location: "src/a.ts:3" }), adv({ id: "S-1", kind: "secret", pkg: null, location: "k" })]),
      ok("dependabot-prs", prs(2)),
      reg([pkg("react", ["17.0.2"], "19.2.0")]),
      ok("git-tags", rel({ since: 10, fetchedAt: S - 9 * D })),
      ok("github-deployments", { kind: "deployments", trunk: "main", fetchedAt: S - 9 * D, envs: [{ env: "prod", tier: "production", sha: "a".repeat(40), tag: null, branch: null, at: S - D, url: null,
        behind: 3, behindAt: S - D, ahead: 0, last: { state: "fail", raw: "FAILURE", sha: "b".repeat(40), at: S - H, url: null } }] }),
      ok("git-local", hyg({ unpushed: 2, merged: ["x"], fetchedAt: S - 9 * D })),
      ok("github-work", { kind: "work", issues: 3, prs: 1, reviewRequested: 1 }),
      ok("h", { kind: "probes", items: [probe("api", null, 90), probe("www", 200, 5)] }),
    );
    const at = Object.fromEntries(p.rows.map((f) => { const t = findingTarget(f); return [f.key, `${t.tab}/${t.board}`]; }));
    expect(at).toEqual({
      ci: "delivery/ci", "ci:flaky": "delivery/flaky", release: "delivery/releases",
      "release:deploy": "delivery/deployments", "release:deploy-failed": "delivery/deployments",
      "security:dependency": "security/advisories", "security:code": "security/advisories", "security:secret": "security/advisories",
      "deps:b": "security/update-prs", "deps:packages": "security/packages",
      "git:unpushed": "code/hygiene", "git:tidy": "code/hygiene", "git:fetch": "code/hygiene",
      "work:review": "work/work", "work:open": "work/work",
      "prod:api": "servers/addresses", "prod:cert:www": "servers/addresses",
    });
    // The anchor is only right if that board really draws the line: its verb is on it.
    for (const f of p.rows) {
      expect(tabBoards(findingTarget(f).tab, [p], "/r", null, NOW).drawn, f.key).toContain(`/r|${f.key}`);
    }
  });

  it("falls back to its tab's top for a line no board carries", () => {
    const p = tp("/r", ok("git-local", hyg()));
    const setup = p.rows.find((f) => f.key === "ci:setup")!;
    expect(findingTarget(setup)).toEqual({ tab: "delivery", board: null });
    expect(findingTarget({ facet: "deps", key: "deps:setup" })).toEqual({ tab: "security", board: null });
    expect(findingTarget({ facet: "security", key: "security:setup" })).toEqual({ tab: "security", board: null });
    expect(findingTarget({ facet: "prod", key: "prod:setup" })).toEqual({ tab: "servers", board: null });
    expect(findingTarget({ facet: "security", key: "run:osv" })).toEqual({ tab: "security", board: null });
    expect(findingTarget({ facet: "git", key: "git:something-new" })).toEqual({ tab: "code", board: null });
    // A snapshot written before the CI lines folded still names its workflow.
    expect(findingTarget({ facet: "ci", key: "ci:build" })).toEqual({ tab: "delivery", board: "ci" });
  });

  it("names each board where the view draws it: a facet's board is in its tab's renderer", () => {
    const src = readFileSync(new URL("../src/maintview.ts", import.meta.url), "utf8");
    const map = /const BOARDS: Record<MaintTab,[^\n]*\{([^}]*)\}/.exec(src)![1];
    const fnOf = Object.fromEntries([...map.matchAll(/(\w+): (\w+Html)/g)].map((m) => [m[1], m[2]]));
    const bodyOf = (fn: string) => {
      const at = src.indexOf(`function ${fn}(`);
      expect(at, fn).toBeGreaterThan(-1);
      const rest = src.slice(at);
      return rest.slice(0, rest.search(/\n\}\r?\n/));
    };
    // A board with a function of its own (`hostBoardHtml`) is in whichever tab's renderer calls it.
    const emitted = (tab: string) => {
      const own = bodyOf(fnOf[tab]), called = [...own.matchAll(/\b(\w+BoardHtml)\(/g)].map((m) => bodyOf(m[1]));
      return [own, ...called].flatMap((body) => [...body.matchAll(/board\("([\w-]+)"/g)].map((m) => m[1]));
    };
    const sample: Record<Facet, string> = {
      ci: "ci", release: "release", security: "security:code", deps: "deps:b", git: "git:tidy", prod: "prod:api", work: "work:open",
    };
    for (const f of FACETS) {
      const t = findingTarget({ facet: f, key: sample[f] });
      expect(emitted(t.tab), f).toContain(t.board);
    }
    expect(new Set(MAINT_TABS.flatMap(emitted))).toEqual(new Set(BOARD_IDS));
  });

  it("lists every project in the picker with what needs you in that tab: worst, most, then name and root", () => {
    const ps = [
      tp("/warn", ok("git-tags", rel({ since: 40 }))),
      tp("/red", ok(GHA, ci(run("t", "fail", S - H))), ok("git-tags", rel({ since: 40 }))),
      tp("/info", ok("git-tags", rel({ since: 3 }))),
    ];
    const rows = ps.flatMap((p) => p.rows);
    const projects = [
      { root: "/info", name: "Info" }, { root: "/unread", name: "aaa" }, { root: "/red", name: "zed" }, { root: "/warn", name: "Warn" },
    ];
    const picks = projectPicks("delivery", rows, projects);
    expect(picks.map((p) => [p.root, p.n, p.level])).toEqual([
      ["/red", 2, "bad"], ["/warn", 1, "warn"], ["/unread", 0, null], ["/info", 0, null],
    ]);
    expect(picks.map((p) => p.name), "a project nothing was read for is still listed").toContain("aaa");
    expect(projectPicks("delivery", [...rows].reverse(), [...projects].reverse()), "stable whatever the order").toEqual(picks);
    expect(projectPicks("code", rows, projects).every((p) => p.n === 0), "counted per tab").toBe(true);
    const red1 = tp("/red1", ok(GHA, ci(run("t", "fail", S - H))));
    const tie = projectPicks("delivery", [...rows, ...red1.rows], [...projects, { root: "/red1", name: "aaa" }, { root: "/b", name: "Info" }]);
    expect(tie.map((p) => p.root), "more lines first at one level; one name ordered by root").toEqual(["/red", "/red1", "/warn", "/unread", "/b", "/info"]);
  });
});

describe("the project dashboard's sub-tabs are the fleet's, narrowed", () => {
  const tp = (path: string, ...reps: SourceReport[]): TabProject => {
    const inp = input(...reps);
    return { path, inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings(path, inp, MAINT_DEFAULTS, NOW) };
  };
  const tool = (id: string): SourceReport => ({ ...not(id, "security", { state: "notRun" }), cost: "tool" });
  const many = (path: string, red: boolean) => tp(path,
    ok(GHA, ci(run("build", red ? "fail" : "pass", S - H), run("lint", "pass", S - 2 * H))),
    ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: null, runs: 40, reran: 2, jobs: [
      { workflow: "ci", job: "e2e", reruns: 3, passed: red ? 2 : 1, steps: ["Run"], seen: [] }] }),
    ok("dependabot-alerts", { kind: "advisories", items: [adv(), adv({ id: "B-2", pkg: "minimist", severity: "medium" })] }),
    ok("github-code-scanning", { kind: "advisories", items: [adv({ id: "C-1", kind: "code", pkg: null, location: "src/a.ts:3" })] }),
    not("github-secret-scanning", "security", { state: "off", reason: "secret scanning is off" }),
    tool("npm-audit"),
    ok("dependabot-prs", prs(2)),
    reg([pkg("react", ["17.0.2"], "19.2.0"), pkg("gone", [], null, { why: "from git" })], 4),
    ok("git-tags", rel({ since: 12, oldestUnreleasedAt: S - 3 * D })),
    ok("github-releases", { kind: "releases", latest: { tag: "v1.0", name: "v1.0", at: S - 2 * D, url: null }, count: 4 }),
    ok("changelog", { kind: "changelog", unreleased: 3, latest: "1.0", latestAt: S - 2 * D }),
    ok("git-local", hyg({ unpushed: 2, merged: ["x"], localOnly: ["old"], branches: [{ name: "old", at: S - 40 * D }] })),
    ok("github-work", { kind: "work", issues: 3, prs: 1, reviewRequested: 1 }),
    ok("h", { kind: "probes", items: [{ name: "api", url: "https://api", code: null, ms: null, certNotAfter: null, err: "refused" }] }),
  );

  it("builds exactly the fleet's tab narrowed to the project, for every sub-tab and the bar's counts", () => {
    const fleet = [many("/a", true), many("/b", false), tp("/c", ok("git-local", hyg()))];
    for (const sub of [null, ...MAINT_TABS]) {
      for (const sev of [null, "medium"] as const) {
        expect(tabModel(sub, [fleet[1]], "/b", sev, NOW), `${sub} ${sev}`).toEqual(tabModel(sub, fleet, "/b", sev, NOW));
      }
    }
    const sec = tabModel("security", [fleet[0]], "/a", null, NOW);
    expect(sec.boards!.adv.map((r) => [r.id, r.projects.map((p) => p.verb?.key)]), "one row per advisory, each with its own Patch").toEqual([
      ["A-1", ["security:dependency"]], ["C-1", ["security:code"]], ["B-2", ["security:dependency"]],
    ]);
    // Secret scanning off is no gap here: the cell reached its verdict from the sources that answered.
    expect(sec.cover.map((g) => [g.what, g.action?.kind]), "Coverage for this project, with its run door").toEqual([["npm audit", "run"]]);
    expect(sec.offers.map((o) => o.key)).toEqual(["run:npm-audit"]);
  });

  it("marks a board narrowed to one project, so the view drops the column that would only repeat its name", () => {
    const ps = [many("/a", true), many("/b", false)];
    for (const tab of MAINT_TABS) {
      expect(tabBoards(tab, ps, "/a", null, NOW).one, tab).toBe(true);
      expect(tabBoards(tab, ps, null, null, NOW).one, tab).toBe(false);
    }
    // Every table's Project column goes through the one switch, and the two places a name is drawn
    // outside a table (a CI row with no workflows, an advisory's chip) ask the same flag first.
    const src = readFileSync(new URL("../src/maintview.ts", import.meta.url), "utf8");
    const tables = src.match(/table\(\[[^\]]*/g) ?? [];
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t, "a table's columns start at projCol").toMatch(/^table\(\[\.\.\.projCol\(b\)/);
    expect(src.match(/"Project"/g)?.length, "the column is named in projCol alone").toBe(1);
    expect(src).toMatch(/\$\{b\.one \? `<span class="wn">\$\{esc\(r\.branch \?\? ""\)\}<\/span>` : projHtml\(/);
    expect(src).toMatch(/return b\.one \? \(p\.verb \? `<span class="mt-pc solo">/);
  });

  it("opens every To do row on a sub-tab that carries it: on its board, else listed below the boards", () => {
    const p = many("/r", true);
    const setup = tp("/s", ok("git-local", hyg()));
    for (const q of [p, setup]) {
      expect(q.rows.length).toBeGreaterThan(0);
      for (const f of q.rows) {
        const t = findingTarget(f), m = tabModel(t.tab, [q], q.path, null, NOW);
        expect(t.tab, f.key).toBe(FACET_TAB[f.facet]);
        if (t.board) expect(m.boards!.drawn, f.key).toContain(`${q.path}|${f.key}`);
        else expect(m.rows.map((r) => r.key), f.key).toContain(f.key);
      }
    }
  });

  it("keeps what the old cards showed: changelog entries, the published release, the last fetch, untouched branches, each workflow", () => {
    const p = many("/r", true);
    const [rel1] = releaseBoard([p], "/r", NOW);
    expect([rel1.changelog, rel1.published, rel1.fetched]).toEqual([3, { tag: "v1.0", age: 2 * D }, H]);
    const [untagged] = releaseBoard([tp("/u", ok("git-tags", rel({ tag: null, tagAt: null })))], "/u", NOW);
    expect([untagged.tag, untagged.trunk], "an untagged project names the trunk it was read against").toEqual([null, "origin/main"]);
    const bare = tp("/n", ok("github-releases", { kind: "releases", latest: null, count: 0 }));
    expect(releaseBoard([bare], "/n", NOW).map((r) => [r.tagRead, r.published, r.changelog, r.level]), "a forge release alone is still a row")
      .toEqual([[false, { tag: null, age: null }, null, "muted"]]);
    const [h] = hygieneBoard([p], "/r", NOW);
    expect([h.stale, h.staleDays]).toEqual([{ n: 1, level: "info", names: ["old"] }, MAINT_DEFAULTS.staleBranchDays]);
    const [c] = ciBoard([p], "/r", NOW);
    expect([c.branch, c.flows.map((w) => [w.workflow, w.red])]).toEqual(["main", [["build", "1h"], ["lint", null]]]);
    expect(updatePrRows([p], "/r", NOW)[0].green).toBe(2);
  });

  it("says the package manager's answer, or the door that asks it, and the fix an advisory takes", () => {
    expect(outdatedText(false, 0, "pnpm outdated")).toBe("not checked · the arrow above runs pnpm outdated");
    expect(outdatedText(true, 3, "pnpm outdated")).toBe("3 packages out of date");
    expect(outdatedText(true, 0, null)).toBe("nothing out of date");
    expect(outdatedText(false, 0, null)).toBeNull();
    const fixes = { "GHSA-X": "via a parent" };
    expect(advFix({ id: "CVE-1", aliases: ["ghsa-x"] }, fixes), "by any id, case-blind").toBe("via a parent");
    expect(advFix({ id: "OSV-9", aliases: [] }, fixes)).toBeNull();
  });
});

describe("the project tab's cards", () => {
  it("lists every workflow once, the red ones first, with its run strip oldest first", () => {
    const flows = ciFlows(input(ok(GHA, ci(run("lint", "pass", S - H), run("test", "fail", S - H), run("test", "fail", S - 3 * D), run("test", "pass", S - 4 * D)))), NOW);
    expect(flows.branch).toBe("main");
    expect(flows.rows.map((r) => [r.workflow, r.status, r.red])).toEqual([["test", "fail", "3d"], ["lint", "pass", null]]);
    expect(flows.rows[0].runs.map((r) => r.status)).toEqual(["pass", "fail", "fail"]);
    expect(ciFlows(input(not(GHA, "ci", { state: "notRun" })), NOW)).toEqual({ branch: null, rows: [] });
  });

  it("marks a failure its source cannot date red with no age, caps the strip, and merges two reports", () => {
    const undated = ciFlows(input(ok("forge-commit-status", ci(run("build", "fail", S - H)))), NOW);
    expect(undated.rows.map((r) => [r.workflow, r.red])).toEqual([["build", ""]]);
    const many = Array.from({ length: CI_STRIP + 2 }, (_, i) => run("lint", i === CI_STRIP - 1 || i === CI_STRIP + 1 ? "fail" : "pass", S - i * H));
    expect(ciFlows(input(ok(GHA, ci(...many))), NOW).rows[0].runs.map((r) => r.status), "the CI board's strip")
      .toEqual(["fail", ...Array(CI_STRIP - 1).fill("pass")]);
    const two = ciFlows(input(ok(GHA, ci(run("lint", "pass", S - H))),
      ok("forge-commit-status", { kind: "ciRuns", branch: "trunk", runs: [run("deploy", "pass", S - H)] })), NOW);
    expect(two.branch).toBe("main");
    expect(two.rows.map((r) => r.workflow)).toEqual(["deploy", "lint"]);
  });

  it("says nothing about a release no source read, and names the tag, the count and the fetch", () => {
    const one = (...reps: SourceReport[]) => {
      const inp = input(...reps);
      return releaseBoard([{ path: "/r", inp, cells: facetCells(inp, MAINT_DEFAULTS, NOW), rows: tabFindings("/r", inp, MAINT_DEFAULTS, NOW) }], "/r", NOW);
    };
    expect(one(not("git-tags", "release", { state: "notRun" }))).toEqual([]);
    const [r] = one(ok("git-tags", rel({ since: 4 })));
    expect([r.tag, r.tagAge, r.since, r.fetched, r.tagRead]).toEqual(["v1.0", 2 * D, 4, H, true]);
    expect(one(ok("git-tags", rel({ tag: null, fetchedAt: null }))).map((x) => [x.tag, x.since, x.fetched, x.level])).toEqual([[null, 0, null, "muted"]]);
  });

  it("counts hygiene with the same age rule as the cell, and null until it was read", () => {
    expect(hygieneOf(input(not("git-local", "git", { state: "notRun" })), MAINT_DEFAULTS, NOW)).toBeNull();
    const h = hygieneOf(input(ok("git-local", hyg({
      localOnly: ["old", "new"], branches: [{ name: "old", at: S - 40 * D }, { name: "new", at: S - D }, { name: "pushed", at: S - 90 * D }],
      worktrees: [{ path: "/w", branch: "x", at: S - 40 * D }, { path: "/v", branch: "y", at: null }],
    }))), MAINT_DEFAULTS, NOW)!;
    expect(h).toMatchObject({ stale: ["old"], idle: 1, idleNames: ["w"], unpushed: 0 });
    const git = cell("git", input(ok("git-local", hyg({
      localOnly: ["old", "new"], branches: [{ name: "old", at: S - 40 * D }, { name: "new", at: S - D }, { name: "pushed", at: S - 90 * D }],
      worktrees: [{ path: "/w", branch: "x", at: S - 40 * D }, { path: "/v", branch: "y", at: null }],
    }))));
    expect(git.tip).toEqual(expect.arrayContaining([
      `untouched ${MAINT_DEFAULTS.staleBranchDays}d+: ${h.stale.join(", ")}`, `${h.idle} worktree idle ${MAINT_DEFAULTS.staleBranchDays}d+`,
    ]));
  });

  it("names the forge, a missing remote, and how to pin one nobody could name", () => {
    const at = (forge: Detection["forge"]): MaintInput => ({ det: det([], { forge }), reports: {} });
    expect(forgeText({ det: null, reports: {} })).toBe("");
    expect(forgeText(at({ kind: "none", host: null, path: null, by: "none" }))).toBe("no remote");
    expect(forgeText(at({ kind: "github", host: "github.com", path: "o/r", by: "name" }))).toBe("github.com/o/r");
    expect(forgeText(at({ kind: "unknown", host: "git.example", path: "o/r", by: "name" })))
      .toBe("git.example/o/r · forge unknown: pin [maintenance] forge");
  });

  it("lists every detected source and marker under its facet, and what became of it", () => {
    const inp: MaintInput = {
      det: det(["git-local", GHA, "git-tags"], {
        markers: [{ facet: "ci", label: "Woodpecker", found: [".woodpecker.yml"] }],
        config: { ...det([]).config, off: ["prod"] },
      }),
      reports: { [GHA]: not(GHA, "ci", { state: "noAccess", reason: "who", fix: "gh auth login" }), "git-local": ok("git-local", hyg()) },
      skip: ["git-tags"],
    };
    expect(coverRows(inp).map((r) => [r.facet, r.state, r.fix, r.source])).toEqual([
      ["ci", "noAccess", "gh auth login", GHA], ["ci", "marker", null, null], ["security", "none", null, null], ["deps", "none", null, null],
      ["release", "skipped", null, "git-tags"], ["git", "ok", null, "git-local"], ["prod", "untracked", null, null], ["work", "none", null, null],
    ]);
    expect(coverRows({ det: null, reports: {} })).toEqual([]);
  });
});

describe("the cold-boot snapshot (cc-maint)", () => {
  const red = () => input(ok(GHA, ci(run("build", "fail", S - 3 * D), run("build", "pass", S - 4 * D))),
    ok("dependabot-alerts", { kind: "advisories", items: [adv()] }),
    ok("h", { kind: "probes", items: [{ name: "app", url: "https://app.example/health", code: 503, ms: 90, certNotAfter: null, err: null }] }),
    ok("git-local", hyg()));
  const stored = (o: Record<string, unknown> = {}) => ({
    at: NOW, cells: FACETS.map((facet) => ({ facet, level: "ok", text: "" })), findings: [], ...o,
  });

  it("round-trips a finished scan through the store unchanged", () => {
    const snap = takeSnap("/r", red(), NOW);
    expect(clampSnaps(JSON.parse(JSON.stringify({ "/r": snap })))).toEqual({ "/r": snap });
    expect(snap.cells.map((c) => c.facet)).toEqual([...FACETS]);
    expect(snap.findings.map((f) => f.key)).toContain("ci");
  });

  it("keeps the account that read it, and is no other identity's to draw", () => {
    const mine = takeSnap("/r", red(), NOW, undefined, "work");
    const snaps = clampSnaps(JSON.parse(JSON.stringify({ "/r": mine, "/legacy": stored() })));
    expect(snaps["/r"].account).toBe("work");
    expect(snapFor(snaps, "/r", "work")).toEqual(mine);
    expect(snapFor(snaps, "/r", "home"), "another login's verdict").toBeUndefined();
    expect(snapFor(snaps, "/r", null), "the pin removed").toBeUndefined();
    expect(snaps["/legacy"].account, "a snapshot from before the field is the unpinned one's").toBeNull();
    expect(snapFor(snaps, "/legacy", null)).toBeDefined();
    expect(snapFor(snaps, "/legacy", "work")).toBeUndefined();
    expect(clampSnaps({ "/r": stored({ account: 7 }) })["/r"].account, "a wrong shape is no account").toBeNull();
  });

  it("writes only what it will read back: long words are cut, an overlong key is left out, the root survives", () => {
    const probe = (name: string) => ({ name, url: "https://app.example/h", code: 503, ms: 90, certNotAfter: null, err: null });
    const long = "a".repeat(SNAP_TEXT + 20), huge = "b".repeat(SNAP_KEY + 1);
    const snap = takeSnap("/r", input(ok("h", { kind: "probes", items: [probe(long), probe(huge)] })), NOW);
    const back = clampSnaps(JSON.parse(JSON.stringify({ "/r": snap })))["/r"];
    expect(back).toEqual(snap);
    const texts = [...back.cells, ...back.findings].map((x) => x.text);
    expect(texts.every((t) => t.length <= SNAP_TEXT)).toBe(true);
    expect(texts.some((t) => t.length === SNAP_TEXT), "a long text was cut, not dropped").toBe(true);
    expect(back.findings.map((f) => f.key)).toEqual([`prod:${long}`]);
  });

  it("keeps a card's words and never an advisory's payload or a URL", () => {
    const json = JSON.stringify(takeSnap("/r", red(), NOW));
    expect(json).not.toContain("https://");
    expect(json).not.toContain("Prototype pollution");
    expect(json).not.toContain("lodash");
  });

  it("drops a root of the wrong shape on its own and keeps the rest", () => {
    const missing = stored({ cells: FACETS.slice(1).map((facet) => ({ facet, level: "ok", text: "" })) });
    const twice = stored({ cells: [...stored().cells, { facet: "ci", level: "bad", text: "x" }] });
    const bad = [missing, twice, stored({ at: "now" }), stored({ at: -1 }), stored({ cells: "seven" }), stored({ findings: null }),
      stored({ cells: stored().cells.map((c, i) => i ? c : { ...c, level: "green" }) }), "[]", null, 7];
    const raw = Object.fromEntries([...bad.map((v, i) => [`/bad${i}`, v]), ["/good", stored()]]);
    expect(Object.keys(clampSnaps(raw))).toEqual(["/good"]);
    for (const v of [null, "[]", [stored()], 3]) expect(clampSnaps(v)).toEqual({});
  });

  it("refuses oversize: a long text drops its root, a line past twelve and a root past two hundred are cut", () => {
    const long = stored({ cells: stored().cells.map((c, i) => i ? c : { ...c, text: "x".repeat(SNAP_TEXT + 1) }) });
    expect(clampSnaps({ "/long": long })).toEqual({});
    const lines = Array.from({ length: 20 }, (_, i) => ({ facet: "git", key: `git:${i}`, level: "info", text: `l${i}` }));
    const cut = clampSnaps({ "/r": stored({ findings: [{ facet: "ci", key: "ci:x", level: "ok", text: "not a level" }, ...lines] }) });
    expect(cut["/r"].findings.map((f) => f.key)).toEqual(lines.slice(0, SNAP_FINDINGS).map((f) => f.key));
    const many = Object.fromEntries(Array.from({ length: SNAP_ROOTS + 5 }, (_, i) => [`/p${i}`, stored({ at: NOW - i })]));
    const kept = Object.keys(clampSnaps(many));
    expect(kept).toHaveLength(SNAP_ROOTS);
    expect(kept).not.toContain(`/p${SNAP_ROOTS}`); // the oldest go
  });

  it("rebuilds every entry field by field, so a hand-added field never survives", () => {
    const raw = { "/r": { ...stored(), url: "https://x", findings: [{ facet: "ci", key: "ci:b", level: "bad", text: "t", url: "https://y" }] } };
    expect(JSON.stringify(clampSnaps(raw))).not.toContain("https://");
  });

  it("never yields a live dot: every cell is muted, worded and as of then", () => {
    const snap = clampSnaps({ "/r": stored({ at: NOW - 2 * H * 1000, cells: FACETS.map((facet, i) =>
      ({ facet, level: ["ok", "bad", "warn", "info", "muted", "unread", "ok"][i], text: i === 6 ? "v1.0" : i === 1 ? "failing 3d" : "" })) }) })["/r"];
    const cells = pastCells(snap, NOW);
    for (const c of cells) {
      expect(c.level).toBe("muted");
      expect(c.state).toBe("past");
      expect(c.text).not.toBe("");
    }
    expect(cells.map((c) => c.text)).toEqual(["fine", "failing 3d", "not read", "not read", "not read", "not read", "v1.0"]);
    expect(cells[0].tip[0]).toBe("as of the last check, 2h ago");
    expect(projectBand(cells)).toBe("unread"); // never quiet: nothing was read this session
    expect(tabGaps("delivery", [{ path: "/r", cells }]).read).toBe(0);
    expect(coverGroups("delivery", [{ path: "/r", inp: { det: null, reports: {} }, cells }], null, NOW).map((g) => [g.what, g.why]))
      .toEqual([["CI", "not checked this session"], ["Release", "not checked this session"]]);
  });
});

describe("the last scan kept whole (cc-maint-scan)", () => {
  const scan = (at: number) => {
    const inp = input(ok(GHA, ci(run("build", "fail", S - D))), ok("dependabot-alerts", { kind: "advisories", items: [adv()] }),
      not("github-code-scanning", "security", { state: "off", reason: "no analysis" }));
    return { at, account: "me", det: inp.det!, reports: { ...inp.reports } };
  };

  it("spends a Packages list before it spends a project: the red CI beside it stays kept", () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ name: `p${i}`, ecosystem: "npm", importers: ["."], installed: ["1.0.0"], latest: "2.0.0", dev: false, url: null, why: null }));
    const big = { ...scan(NOW), reports: { ...scan(NOW).reports, "npm-registry": ok("npm-registry", { kind: "packages", current: 0, items }) } };
    const all = { "/big": big, "/red": scan(NOW - H) };
    const room = JSON.stringify({ "/big": scan(NOW), "/red": scan(NOW - H) }).length + 400;
    expect(JSON.stringify(all).length, "the list alone would have evicted /red").toBeGreaterThan(room);
    const out = packKept(all, room);
    expect(Object.keys(out)).toEqual(["/big", "/red"]);
    expect(out["/red"].reports[GHA].facts?.kind).toBe("ciRuns");
    expect(out["/big"].reports[GHA].facts?.kind).toBe("ciRuns");
    expect(out["/big"].reports["npm-registry"]).toMatchObject({ coverage: { state: "notRun" }, at: null, gaps: [], facts: null });
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(room);
    expect(clampKept(JSON.parse(JSON.stringify(out)))["/big"].reports["npm-registry"].coverage, "the store reads it back as unasked").toEqual({ state: "notRun" });
    expect(packKept(all)["/big"], "with room it stays whole").toEqual(big);
    const older = { "/new": scan(NOW), "/big": { ...big, at: NOW - D } };
    expect(packKept(older, JSON.stringify(older).length)["/big"].reports["npm-registry"].facts, "the list that fits is kept").not.toBeNull();
  });

  it("round-trips through the store, so a boot draws exactly what the scan read", () => {
    const k = { "/r": scan(NOW) };
    expect(clampKept(JSON.parse(JSON.stringify(k)))).toEqual(k);
    expect(clampKept(JSON.parse(JSON.stringify({ "/r": { ...scan(NOW), account: undefined } })))["/r"].account).toBeNull();
  });

  it("drops a root of the wrong shape on its own, and a mangled report becomes that source's error, never facts", () => {
    const back = clampKept({
      "/a": scan(NOW), "/b": { ...scan(NOW), det: null }, "/c": { ...scan(NOW), at: 0 }, "/d": "x", "": scan(NOW),
      "/e": { ...scan(NOW), reports: { [GHA]: { source: GHA, coverage: { state: "ok" }, facet: "ci", facts: { kind: "ciRuns" } } } },
    });
    expect(Object.keys(back).sort()).toEqual(["/a", "/e"]);
    expect(back["/e"].reports[GHA].coverage.state).toBe("error");
    expect(back["/e"].reports[GHA].facts).toBeNull();
    expect(clampKept(null)).toEqual({});
    expect(clampKept([scan(NOW)])).toEqual({});
  });

  it("keeps the newest scans that fit, leaving the rest to their snapshot", () => {
    const all = { "/old": scan(NOW - D), "/new": scan(NOW), "/mid": scan(NOW - H) };
    const one = JSON.stringify({ "/new": all["/new"] }).length;
    expect(Object.keys(packKept(all, one))).toEqual(["/new"]);
    expect(Object.keys(packKept(all, JSON.stringify({ "/new": all["/new"], "/mid": all["/mid"] }).length))).toEqual(["/new", "/mid"]);
    expect(Object.keys(packKept(all))).toEqual(["/new", "/mid", "/old"]);
    expect(JSON.stringify(packKept(all, one)).length).toBe(one);
    expect(packKept(all, 10)).toEqual({});
  });
});

// The week's marks keep identities only, and a facet a scan reached no verdict on is no verdict a week
// later either: a cleared advisory is only ever one both marks read in full (docs/maintenance.md).
const NOON = new Date(2026, 9, 26, 12).getTime(), DMS = D * 1000; // local noon: a day's marks stay that day's in any zone
const mark = (at: number, o: Partial<WeekMark> = {}): WeekMark =>
  ({ at, account: "me", ci: { red: [], green: [] }, adv: {}, part: [], prs: {}, rt: null, rel: null, none: [], ...o });
const ma = (names: string[], severity: MarkAdv["severity"] = "high", kind: MarkAdv["kind"] = "dependency"): MarkAdv => ({ names, severity, kind });
const rtOf = (o: Partial<Runtime> = {}): Runtime => ({
  product: "nodejs", name: "node", declared: "18", cycle: "18", eol: NOON / 1000 - 30 * D, latest: null, newest: "26", file: ".nvmrc",
  url: "https://eol.example/nodejs", ...o,
});

describe("the week's marks (cc-maint-week)", () => {
  const t = NOON / 1000;
  const full = () => input(
    ok(GHA, ci(run("build", "fail", t - D), run("lint", "pass", t - D), run("build", "pass", t - 2 * D))),
    ok("dependabot-alerts", { kind: "advisories", items: [adv({ id: "GHSA-aaaa", aliases: ["CVE-2021-1"] }), adv({ id: "GHSA-aaaa", pkg: "lodash-es" })] }),
    ok("dependabot-prs", prs(2, { bot: "dependabot" })),
    ok("git-tags", rel({ tagsSeen: 4, tag: "v1.3", fetchedAt: t - H })),
    ok("runtime-eol", { kind: "runtimes", items: [rtOf(), rtOf({ file: "Dockerfile" })] }, { cost: "public" }),
  );

  it("keeps identities and counts, never a package, a summary, a title or a URL", () => {
    const m = takeMark(full(), NOON, "me");
    expect(m).toEqual({
      at: NOON, account: "me", ci: { red: ["build"], green: ["lint"] },
      adv: { "dependabot-alerts": [{ names: ["CVE-2021-1", "GHSA-AAAA"], severity: "high", kind: "dependency" }] },
      part: [], prs: { dependabot: [1, 2] }, rt: [{ key: "nodejs@18", name: "node 18", eol: NOON / 1000 - 30 * D }],
      rel: { tags: 4, tag: "v1.3", published: null, fetchedAt: t - H }, none: [],
    });
    const json = JSON.stringify(m);
    for (const s of ["https://", "lodash", "Prototype pollution", "Update p0", ".nvmrc"]) expect(json).not.toContain(s);
  });

  it("reads a registry with no update bot as nothing to compare, so the band says nothing of it", () => {
    const read = ok("npm-registry", { kind: "packages", current: 3, items: [] }), unasked = not("npm-registry", "deps", { state: "notRun" });
    for (const r of [read, unasked]) expect(takeMark(input(r), NOON, null).none, r.coverage.state).toContain("deps");
    expect(takeMark(input(read, ok("dependabot-prs", prs(1, { bot: "dependabot" }))), NOON, null).none, "a bot to read").not.toContain("deps");
    const marked: MaintInput = { ...input(read), det: det(["npm-registry"], { markers: [{ facet: "deps", label: "Renovate", found: ["renovate.json"] }] }) };
    expect(takeMark(marked, NOON, null).none, "a bot nothing can read yet is still not compared").not.toContain("deps");
    const week = weekDigest([{ root: "/r", base: takeMark(input(read), NOON, "me"), now: takeMark(input(read), NOON + 7 * DMS, "me"), th: MAINT_DEFAULTS }], []);
    expect(week.gaps.filter((g) => g.facet === "deps")).toEqual([]);
  });

  it("leaves out a truncated or failed source, and a facet with no verdict is null", () => {
    const capped = takeMark(input(
      ok("dependabot-alerts", { kind: "advisories", items: [adv()] }, { truncated: true }),
      ok("dependabot-prs", prs(3, { bot: "dependabot" }), { truncated: true }),
      not("osv", "security", { state: "notRun" }),
      ok("github-releases", { kind: "releases", latest: null, count: 100 }, { truncated: true }),
    ), NOON, null);
    expect([capped.adv, capped.prs, capped.rt, capped.rel, capped.ci]).toEqual([{}, {}, null, null, null]);
    expect(capped.part).toEqual(["dependabot-alerts"]);
    // CI is one list across its sources: one that failed would turn its red into a false fix.
    const half = takeMark(input(ok(GHA, ci(run("build", "pass", t))), not("forge-commit-status", "ci", { state: "error", reason: "502" })), NOON, null);
    expect(half.ci).toBeNull();
    const many = takeMark(input(ok("osv", { kind: "advisories", items: Array.from({ length: WEEK_ROWS + 1 }, (_, i) => adv({ id: `X-${i}` })) })), NOON, null);
    expect(many.adv, "a cut list would read as cleared").toEqual({});
    expect(many.part).toEqual(["osv"]);
    expect(takeMark(input(ok(GHA, ci(run("build", "pass", t)))), NOON, null).none, "nothing to read is said, not a gap")
      .toEqual(["security", "deps", "release"]);
    const off: MaintInput = { ...full(), det: det([GHA], { config: { ...det([]).config, off: ["ci"] } }) };
    expect(takeMark(off, NOON, null)).toMatchObject({ ci: null, none: expect.arrayContaining(["ci"]) });
    expect(takeMark({ ...full(), skip: ["dependabot-alerts"] }, NOON, null).adv, "a source skipped here").toEqual({});
  });

  it("stands on the sources that list runs: a re-run read adds nothing to that list, so it can neither cost nor vouch for it", () => {
    const RR = "github-actions-reruns", list = ok(GHA, ci(run("build", "fail", t), run("lint", "pass", t)));
    const reruns = ok(RR, { kind: "ciReruns", days: 30, since: null, runs: 9, reran: 0, jobs: [] });
    const failed = not(RR, "ci", { state: "error", reason: "502" });
    expect(takeMark(input(list, failed), NOON, null).ci, "a failed re-run read").toEqual({ red: ["build"], green: ["lint"] });
    expect(takeMark(input(list, reruns), NOON, null).ci).toEqual({ red: ["build"], green: ["lint"] });
    expect(takeMark(input(not(GHA, "ci", { state: "error", reason: "502" }), reruns), NOON, null).ci, "the list itself failed").toBeNull();
    expect(takeMark({ ...input(list, reruns), skip: [GHA] }, NOON, null).ci, "the list skipped here: re-runs alone are no verdict").toBeNull();
    const week = weekDigest([{ root: "/r", base: takeMark(input(list, reruns), NOON, "me"), now: takeMark(input(ok(GHA, ci(run("build", "pass", t + 7 * D), run("lint", "pass", t + 7 * D))), failed), NOON + 7 * DMS, "me"), th: MAINT_DEFAULTS }], []);
    expect(week).toMatchObject({ ciFixed: 1, gaps: [] });
  });

  it("takes every report the wire carries without throwing", () => {
    const reps = new Map<string, SourceReport>();
    for (const r of wire.reports) {
      const n = narrowMaint(r, r.source as string);
      if (n.coverage.state === "ok" && !reps.has(n.source)) reps.set(n.source, n);
    }
    expect([...new Set([...reps.values()].map((r) => r.facts!.kind))].sort()).toEqual([...FACT_KINDS].sort());
    const m = takeMark({ det: { ...narrowDetection(wire.detection)!, sources: [...reps.keys()] }, reports: Object.fromEntries(reps) }, NOON, null);
    expect(m.ci, "lint: a run still out, its last finished one passed").toEqual({ red: ["ci"], green: ["lint", "site"] });
    expect(Object.keys(m.adv)).toEqual(["osv"]);
    expect(m.prs).toEqual({ renovate: [42] });
    expect(m.rt?.map((r) => r.key)).toEqual(["nodejs@18", "nodejs@3", "postgresql@?99"]);
    expect(m.rel).toEqual({ tags: 9, tag: "v1.2.0", published: 9, fetchedAt: 1_790_000_000 });
    expect(clampWeek(JSON.parse(JSON.stringify({ "/r": [m] })))).toEqual({ "/r": [m] });
  });

  it("names a code finding by its rule and its file: a line that moved is the same finding", () => {
    const code = (...lines: number[]) => input(ok("github-code-scanning", { kind: "advisories",
      items: lines.map((l) => adv({ id: "js/sql-injection", kind: "code", location: `src/db.js:${l}` })) }));
    const pair = (then: MaintInput, is: MaintInput) => weekDigest([{ root: "/r", base: takeMark(then, NOON, "me"), now: takeMark(is, NOON + 7 * DMS, "me"), th: MAINT_DEFAULTS }], []);
    expect(takeMark(code(42, 57), NOON, "me").adv["github-code-scanning"], "two in one file are one row")
      .toEqual([{ names: ["JS/SQL-INJECTION@src/db.js"], severity: "high", kind: "code" }]);
    expect(pair(code(42), code(57)), "moved by an edit above it").toMatchObject({ advNew: 0, advCleared: 0, changes: [] });
    expect(pair(code(42, 57), code(57)), "one of two gone leaves the file's finding").toMatchObject({ advCleared: 0, changes: [] });
    expect(pair(code(42, 57), code()).changes.map((c) => [c.text, c.detail])).toEqual([["1 code finding cleared", "JS/SQL-INJECTION@src/db.js"]]);
    const secret = (l: number) => input(ok("sarif-files", { kind: "advisories", items: [adv({ id: "aws-key", kind: "secret", location: `.env:${l}` })] }));
    expect(pair(secret(3), secret(9))).toMatchObject({ advNew: 0, advCleared: 0 });
    const dep = takeMark(input(ok("dependabot-alerts", { kind: "advisories", items: [adv({ id: "GHSA-1:2" })] })), NOON, "me");
    expect(dep.adv["dependabot-alerts"][0].names, "a dependency's name is never read as a place").toEqual(["GHSA-1:2"]);
  });

  it("counts a read with gaps as not read in full, since what it lost would read as cleared", () => {
    const sarif = (ids: string[], gaps: string[] = []) => input(ok("sarif-files",
      { kind: "advisories", items: ids.map((id) => adv({ id, kind: "code", location: "a.js" })) }, { gaps }));
    const pair = (then: WeekMark, is: WeekMark) => weekDigest([{ root: "/r", base: then, now: is, th: MAINT_DEFAULTS }], []);
    const whole = takeMark(sarif(["r1", "r2", "r3"]), NOON, "me"), broke = takeMark(sarif(["r1"], ["b.sarif: not JSON"]), NOON + 7 * DMS, "me");
    expect(broke).toMatchObject({ adv: {}, part: ["sarif-files"] });
    const once = pair(whole, broke);
    expect(once).toMatchObject({ advCleared: 0, changes: [] });
    expect(once.gaps).toContainEqual({ facet: "security", roots: ["/r"], why: "SARIF files read in full only then", click: false });
    const twice = pair(takeMark(sarif(["r1"], ["b.sarif: not JSON"]), NOON, "me"), broke);
    expect(twice.gaps, "partial both times is still said").toContainEqual({ facet: "security", roots: ["/r"], why: "SARIF files read only in part", click: false });
    expect(twice.gaps.map((g) => g.why)).not.toContain("no advisory source read in full both times");
    const audit = input(ok("npm-audit", { kind: "advisories", items: [adv()] }, { gaps: ["web/package-lock.json: no answer after 180s"] }));
    expect(pair(takeMark(input(ok("npm-audit", { kind: "advisories", items: [adv(), adv({ id: "Y" })] })), NOON, "me"), takeMark(audit, NOON + 7 * DMS, "me"))).toMatchObject({ advCleared: 0 });
  });

  it("reads each workflow's newest finished run, so a re-run still out keeps its last verdict", () => {
    const of = (...runs: ReturnType<typeof run>[]) => takeMark(input(ok(GHA, ci(...runs))), NOON, null).ci;
    expect(of(run("b", "running", t), run("b", "fail", t - D))).toEqual({ red: ["b"], green: [] });
    expect(of(run("b", "cancelled", t), run("b", "pass", t - D))).toEqual({ red: [], green: ["b"] });
    expect(of(run("b", "skip", t), run("b", "neutral", t - H), run("b", "unknown", t - 2 * H), run("b", "fail", t - D))).toEqual({ red: ["b"], green: [] });
    expect(of(run("b", "running", t)), "no finished run: no verdict either way").toEqual({ red: [], green: [] });
    const pair = (then: ReturnType<typeof run>[], is: ReturnType<typeof run>[]) => weekDigest([{ root: "/r",
      base: takeMark(input(ok(GHA, ci(...then))), NOON, "me"), now: takeMark(input(ok(GHA, ci(...is))), NOON + 7 * DMS, "me"), th: MAINT_DEFAULTS }], []);
    expect(pair([run("b", "running", t), run("b", "fail", t - D)], [run("b", "fail", t), run("b", "fail", t - D)]), "red before and after a run in flight broke nothing")
      .toMatchObject({ ciBroke: 0, ciFixed: 0 });
    expect(pair([run("b", "fail", t)], [run("b", "running", t), run("b", "fail", t - D)])).toMatchObject({ ciFixed: 0 });
    expect(pair([run("b", "fail", t)], [run("b", "running", t), run("b", "pass", t - D)])).toMatchObject({ ciFixed: 1 });
  });

  it("leaves no mark where a detection found no source: a checkout that is gone is not a quiet one", () => {
    expect(leavesMark(input())).toBe(false);
    expect(leavesMark({ det: null, reports: {} })).toBe(false);
    expect(leavesMark(full())).toBe(true);
  });

  it("merges a same-day release figure field by field, each read keeping the other's", () => {
    const morning = mark(NOON - 3 * H * 1000, { rel: { tags: 10, tag: "v1", published: 4, fetchedAt: 1 } });
    const noTags = mark(NOON + 3 * H * 1000, { rel: { tags: null, tag: null, published: 5, fetchedAt: null } });
    expect(addMark([morning], noTags)[0].rel).toEqual({ tags: 10, tag: "v1", published: 5, fetchedAt: 1 });
    const noPub = mark(NOON + 3 * H * 1000, { rel: { tags: 11, tag: "v2", published: null, fetchedAt: 2 } });
    expect(addMark([morning], noPub)[0].rel).toEqual({ tags: 11, tag: "v2", published: 4, fetchedAt: 2 });
    expect(addMark([morning], mark(NOON + 3 * H * 1000, { rel: null }))[0].rel).toEqual(morning.rel);
    expect(addMark([morning], mark(NOON + 3 * H * 1000, { rel: null, none: ["release"] }))[0].rel, "nothing to read is a verdict").toBeNull();
  });

  it("replaces a mark of the same local day, keeping what the newer scan had no verdict on", () => {
    const morning = mark(NOON - 3 * H * 1000, { ci: { red: ["build"], green: [] }, adv: { a: [ma(["X-1"])] }, prs: { b: [1] }, rel: { tags: 2, tag: "v1", published: null, fetchedAt: null } });
    const afternoon = mark(NOON + 3 * H * 1000, { ci: null, adv: { c: [] }, prs: {}, rt: [{ key: "nodejs@18", name: "node 18", eol: false }] });
    const [m, ...rest] = addMark([morning], afternoon);
    expect(rest).toEqual([]);
    expect(m).toEqual({ ...afternoon, ci: morning.ci, adv: { a: [ma(["X-1"])], c: [] }, prs: { b: [1] }, rel: morning.rel });
    const nothing = addMark([morning], { ...afternoon, none: ["ci", "deps"] })[0];
    expect([nothing.ci, nothing.prs], "nothing to read is a verdict").toEqual([null, {}]);
    expect(addMark([morning], { ...afternoon, account: "other" }), "another identity's mark is its own").toHaveLength(2);
  });

  it("keeps the window and one baseline before it: eight marks at most", () => {
    let ms: WeekMark[] = [];
    for (let k = 0; k <= 11; k++) ms = addMark(ms, mark(NOON + k * DMS + H * 1000));
    ms = addMark(ms, mark(NOON + 12 * DMS));
    expect(ms).toHaveLength(WEEK_MARKS);
    expect(ms.map((m) => m.at)).toEqual([...ms.map((m) => m.at)].sort((a, b) => b - a));
    expect(ms[ms.length - 1].at, "the newest mark a week before the newest").toBe(NOON + 5 * DMS + H * 1000);
  });

  it("pairs the newest mark with the newest a week older, else the oldest earlier one, for this account only", () => {
    const ms = [mark(NOON + 10 * DMS), mark(NOON + 5 * DMS), mark(NOON + 2 * DMS), mark(NOON)];
    expect(weekPair(ms, "me")).toEqual({ now: ms[0], base: ms[2] });
    expect(weekPair(ms.slice(1, 3), "me"), "nothing a week old yet: the first check").toEqual({ now: ms[1], base: ms[2] });
    expect(weekPair([ms[0]], "me")).toEqual({ now: ms[0], base: null });
    expect(weekPair(ms, "other")).toBeNull();
    const theirs = [mark(NOON + 11 * DMS, { account: "other" }), ...ms];
    expect(weekPair(theirs, "me")?.now, "another login's newer mark is not this one's").toBe(ms[0]);
  });

  it("pairs by local day, so a Monday's check finds last Monday's at whatever hour each ran", () => {
    const at = (day: number, h: number, m = 0) => mark(new Date(2026, 9, day, h, m).getTime());
    const [a, b, c] = [at(19, 9, 10), at(26, 9, 30), at(33, 9)]; // 2 Nov, and a clock change between in much of the world
    expect(weekPair([c, b, a], "me")).toEqual({ now: c, base: b });
    expect(addMark([b, a], c).map((m) => m.at), "the baseline a pair would pick is the one kept").toEqual([c.at, b.at]);
    expect(packWeek({ "/r": [c, b, a] }, JSON.stringify({ "/r": [c, b] }).length)).toEqual({ "/r": [c, b] });
    const d = weekDigest([{ root: "/r", base: b, now: c, th: MAINT_DEFAULTS }], []);
    expect(d.span).toBe("week");
    expect(weekPair([at(32, 23, 59), b], "me")?.base, "six days on is not a week, however late").toBe(b);
    expect(weekDigest([{ root: "/r", base: b, now: at(32, 23, 59), th: MAINT_DEFAULTS }], []).span).toBe("first");
  });

  it("round-trips through the store and drops a bad mark or root alone", () => {
    let ms: WeekMark[] = [];
    for (const k of [0, 3, 8]) ms = addMark(ms, takeMark(full(), NOON + k * DMS, "me"));
    const all = { "/r": ms };
    expect(clampWeek(JSON.parse(JSON.stringify(all)))).toEqual(all);
    const good = mark(NOON), bad = [{ ...good, at: "now" }, { ...good, at: -1 }, { ...good, ci: ["build"] }, { ...good, none: ["nope"] }, { ...good, part: [1] },
      { ...good, adv: { a: [{ names: [], severity: "high", kind: "dependency" }] } }, { ...good, prs: { b: ["1"] } }, { ...good, rt: [{ key: 1 }] }, "x", null];
    const back = clampWeek({ "/r": [...bad, good], "/s": "marks", "/t": [], "/u": [null], "": [good] });
    expect(back).toEqual({ "/r": [good] });
    for (const v of [null, "[]", [good], 3]) expect(clampWeek(v)).toEqual({});
  });

  it("cuts names and text, makes a list past its cap no verdict, keeps the newest roots, and NFC-repairs keys", () => {
    const long = "x".repeat(WEEK_TEXT + 9);
    const m = clampWeek({ "/r": [mark(NOON, {
      adv: { a: [ma(["A", "B", "C", "D", "E", long])], big: Array.from({ length: WEEK_ROWS + 1 }, (_, i) => ma([`N-${i}`])) },
      ci: { red: Array.from({ length: WEEK_ROWS + 1 }, (_, i) => `w${i}`), green: [] }, prs: { [long]: [1] },
    })] })["/r"][0];
    expect(m.adv).toEqual({ a: [ma(["A", "B", "C", "D"])] });
    expect(m.ci, "a cut list would read as fixed").toBeNull();
    expect(Object.keys(m.prs)).toEqual(["x".repeat(WEEK_TEXT)]);
    const many = Object.fromEntries(Array.from({ length: WEEK_ROOTS + 5 }, (_, i) => [`/p${i}`, [mark(NOON - i * 1000)]]));
    const kept = Object.keys(clampWeek(many));
    expect(kept).toHaveLength(WEEK_ROOTS);
    expect(kept).not.toContain(`/p${WEEK_ROOTS}`); // the oldest go
    expect(Object.keys(clampWeek({ "/café": [mark(NOON)] }))).toEqual(["/café"]);
    const hand = { "/r": [{ ...mark(NOON), adv: { a: [{ ...ma(["X"]), url: "https://y" }] }, url: "https://x" }] };
    expect(JSON.stringify(clampWeek(hand))).not.toContain("https://");
  });

  it("packs every root's newest mark and baseline before any root's days between, newest first, within the budget", () => {
    const ms = (at: number) => [mark(at), mark(at - 3 * DMS), mark(at - 8 * DMS)];
    const all = { "/old": ms(NOON - DMS), "/new": ms(NOON) };
    expect(packWeek(all)).toEqual(all);
    const pairs = { "/new": [all["/new"][0], all["/new"][2]], "/old": [all["/old"][0], all["/old"][2]] };
    const both = JSON.stringify(pairs).length;
    expect(packWeek(all, both), "two comparisons before one root's whole week").toEqual(pairs);
    expect(JSON.stringify(packWeek(all, both))).toBe(JSON.stringify(pairs));
    expect(packWeek(all, both + JSON.stringify(all["/new"][1]).length + 1), "then the newest root's days").toEqual({ ...pairs, "/new": all["/new"] });
    expect(Object.keys(packWeek(all, both - 1)), "the oldest root goes first").toEqual(["/new"]);
    expect(JSON.stringify(packWeek(all, both - 1)).length).toBeLessThanOrEqual(both - 1);
    expect(packWeek(all, 10)).toEqual({});
  });
});

describe("since last week", () => {
  const WEEK = 7 * DMS;
  const pairOf = (base: Partial<WeekMark>, now: Partial<WeekMark>, root = "/r", from = NOON, th = MAINT_DEFAULTS): WeekPairIn =>
    ({ root, base: mark(from, base), now: mark(NOON + WEEK, now), th });
  const one = (base: Partial<WeekMark>, now: Partial<WeekMark>) => weekDigest([pairOf(base, now)], []);

  it("counts CI that broke and CI that passes again, and a re-run still out fixes nothing", () => {
    const d = one({ ci: { red: ["a", "c"], green: ["b"] } }, { ci: { red: ["b"], green: ["a"] } });
    expect(d).toMatchObject({ ciBroke: 1, ciFixed: 1, compared: 1 });
    expect(d.gaps.filter((g) => g.facet === "ci")).toEqual([]);
    expect(d.changes.map((c) => [c.level, c.text])).toEqual([["bad", "CI broke: b"], ["ok", "CI fixed: a"]]);
    expect(one({}, { ci: { red: ["x", "y"], green: [] } }).changes).toEqual([{ root: "/r", facet: "ci", key: "ci", level: "bad", text: "2 workflows broke", detail: "x, y" }]);
    for (const [base, now, why] of [[null, { red: [], green: [] }, "no verdict then"], [{ red: ["a"], green: [] }, null, "no verdict now"],
      [null, null, "no verdict either time"]] as const) {
      const x = one({ ci: base as WeekMark["ci"] }, { ci: now as WeekMark["ci"] });
      expect(x.ciFixed + x.ciBroke).toBe(0);
      expect(x.gaps).toContainEqual({ facet: "ci", roots: ["/r"], why, click: false });
    }
    expect(one({ ci: null, none: ["ci"] }, { ci: null, none: ["ci"] }).gaps.filter((g) => g.facet === "ci"), "no CI to compare is no gap").toEqual([]);
  });

  it("folds advisories across sources by alias, so one reporter's id and another's alias are one row", () => {
    const base = { adv: { "dependabot-alerts": [ma(["CVE-A", "GHSA-A"])], osv: [ma(["CVE-A"])] } };
    const kept = one(base, { adv: { "dependabot-alerts": [], osv: [ma(["CVE-A"]), ma(["GHSA-B"], "critical")] } });
    expect(kept).toMatchObject({ advNew: 1, advCleared: 0 });
    expect(kept.changes).toEqual([{ root: "/r", facet: "security", key: "security:dependency", level: "bad", text: "new critical advisory", detail: "GHSA-B" }]);
    const gone = one(base, { adv: { "dependabot-alerts": [], osv: [] } });
    expect(gone).toMatchObject({ advNew: 0, advCleared: 1 });
    expect(gone.changes.map((c) => [c.level, c.text, c.detail])).toEqual([["ok", "1 advisory cleared", "CVE-A"]]);
  });

  it("never clears what a source read in only one of the two marks: that is a gap", () => {
    const d = one({ adv: { "dependabot-alerts": [ma(["X"])], "npm-audit": [ma(["Y"])] } }, { adv: {} });
    expect(d).toMatchObject({ advCleared: 0, changes: [] });
    expect(d.gaps.filter((g) => g.facet === "security")).toEqual([
      { facet: "security", roots: ["/r"], why: "Dependabot alerts read in full only then", click: false },
      { facet: "security", roots: ["/r"], why: "npm audit read in full only then", click: true },
    ]);
    expect(one({ adv: {} }, { adv: {} }).gaps).toContainEqual({ facet: "security", roots: ["/r"], why: "no advisory source read in full both times", click: false });
  });

  it("calls nothing cleared or new that a source read only once still says", () => {
    const still = one({ adv: { "dependabot-alerts": [ma(["CVE-1", "GHSA-1"])] } }, { adv: { "dependabot-alerts": [], osv: [ma(["CVE-1"])] } });
    expect(still).toMatchObject({ advCleared: 0, advNew: 0, changes: [] });
    const already = one({ adv: { "dependabot-alerts": [], osv: [ma(["CVE-1"])] } }, { adv: { "dependabot-alerts": [ma(["CVE-1", "GHSA-1"])] } });
    expect(already).toMatchObject({ advCleared: 0, advNew: 0, changes: [] });
  });

  it("levels a new finding by its severity, and a secret is red whatever it says", () => {
    const lv = (x: MarkAdv) => one({ adv: { s: [] } }, { adv: { s: [x] } }).changes[0];
    expect(lv(ma(["A"], "critical"))).toMatchObject({ level: "bad", text: "new critical advisory" });
    expect(lv(ma(["A"], "medium"))).toMatchObject({ level: "warn", text: "new medium advisory" });
    expect(lv(ma(["A"], "low"))).toMatchObject({ level: "info" });
    expect(lv(ma(["A"], "unknown"))).toMatchObject({ level: "info", text: "new advisory" });
    expect(lv(ma(["A@.env"], "unknown", "secret"))).toMatchObject({ level: "bad", text: "new secret", key: "security:secret" });
    expect(one({ adv: { s: [] } }, { adv: { s: [ma(["A"], "low"), ma(["B"], "high")] } }).changes[0]).toMatchObject({ level: "bad", text: "2 new advisories", detail: "B, A" });
  });

  it("dates a runtime's end inside the window from the newer mark, and a pinned toolchain never ends", () => {
    const at = (days: number) => NOON / 1000 + days * D;
    const rt = (key: string, eol: MarkRt["eol"], name = "node 18"): MarkRt => ({ key, name, eol });
    const d = one({ rt: [rt("nodejs@18", at(3))] }, { rt: [rt("nodejs@18", at(3)), rt("rust@1.80", at(2), "rust 1.80"), rt("nodejs@20", at(30), "node 20")] });
    expect(d.ended).toBe(1);
    expect(d.changes).toEqual([{ root: "/r", facet: "security", key: "security:runtime", level: "bad", text: "node 18 reached end-of-life", detail: "ended 4d ago" }]);
    expect(one({ rt: null }, { rt: [rt("nodejs@18", at(3))] }), "the base needs no runtimes for that").toMatchObject({ ended: 1 });
    expect(one({ rt: [rt("nodejs@3", false)] }, { rt: [rt("nodejs@3", true, "node 3")] }).changes[0]).toMatchObject({ text: "node 3 reached end-of-life", detail: "now listed as ended" });
    const off = one({ rt: [rt("nodejs@16", at(-100), "node 16"), rt("nodejs@22", at(900), "node 22")] }, { rt: [rt("nodejs@22", at(900), "node 22")] });
    expect(off.changes.map((c) => [c.level, c.text])).toEqual([["ok", "moved off node 16"]]);
    expect(off).toMatchObject({ movedOff: 1, quiet: false });
    expect(weekSummary(off), "a move alone is still something compared").toEqual(["1 runtime moved off"]);
    expect(weekFigs(off)).toEqual([{ n: 1, text: "runtime moved off", level: null }]);
    const lost = one({ rt: [rt("python@3.8", at(-100), "python 3.8"), rt("nodejs@22", at(900), "node 22")] }, { rt: [rt("nodejs@22", at(900), "node 22")] });
    expect(lost, "a product whose list failed, or that left, is no move").toMatchObject({ movedOff: 0, changes: [] });
    expect(one({ rt: null }, { rt: [] }).gaps).toContainEqual({ facet: "security", roots: ["/r"], why: "runtimes read only now", click: true });
  });

  it("counts update PRs closed and opened per bot read in full both times", () => {
    const d = one({ prs: { dependabot: [1, 2, 3], renovate: [9] } }, { prs: { dependabot: [3, 4] } });
    expect(d).toMatchObject({ prsClosed: 2, prsOpened: 1 });
    expect(d.changes.map((c) => [c.level, c.key, c.text, c.detail])).toEqual([
      ["info", "deps:dependabot", "1 update PR opened", "#4"], ["ok", "deps:dependabot", "2 update PRs closed", "#1, #2"]]);
    expect(d.gaps).toContainEqual({ facet: "deps", roots: ["/r"], why: "Renovate read in full only then", click: false });
  });

  it("counts releases from the tags, else the published ones, never below zero, and says a stale fetch", () => {
    const r = (o: Partial<MarkRel>): MarkRel => ({ tags: null, tag: null, published: null, fetchedAt: (NOON + WEEK) / 1000 - H, ...o });
    expect(one({ rel: r({ tags: 3 }) }, { rel: r({ tags: 5, tag: "v2", published: 9 }) }).changes)
      .toEqual([{ root: "/r", facet: "release", key: "release", level: "ok", text: "2 releases tagged", detail: "newest v2" }]);
    expect(one({ rel: r({ published: 4 }) }, { rel: r({ tags: 1, published: 5 }) })).toMatchObject({ released: 1 });
    expect(one({ rel: r({ tags: 5 }) }, { rel: r({ tags: 4 }) })).toMatchObject({ released: 0, changes: [] });
    const stale = one({ rel: r({ tags: 1 }) }, { rel: r({ tags: 1, fetchedAt: (NOON + WEEK) / 1000 - 9 * D }) });
    expect(stale.gaps).toContainEqual({ facet: "release", roots: ["/r"], why: "counted as of the last fetch, 9d ago", click: false });
    expect(one({ rel: null }, { rel: r({ tags: 1 }) }).gaps).toContainEqual({ facet: "release", roots: ["/r"], why: "no release count then", click: false });
  });

  it("is quiet only over what it compared, and names the projects checked once", () => {
    const same = { ci: { red: ["a"], green: [] }, adv: { s: [ma(["X"])] }, prs: { b: [1] } };
    const q = weekDigest([pairOf(same, same)], ["/z", "/y"]);
    expect(q).toMatchObject({ quiet: true, compared: 1, unmarked: ["/y", "/z"] });
    expect(weekSummary(q)).toEqual(["no change in the 1 project compared"]);
    const blind = weekDigest([pairOf({ ci: null }, { ci: null })], []);
    expect(blind).toMatchObject({ quiet: false, compared: 0, changes: [] });
  });

  it("orders changes worst first and stably, and every change opens the board that carries it", () => {
    const rl = (tags: number): MarkRel => ({ tags, tag: null, published: null, fetchedAt: null });
    const d = weekDigest([
      pairOf({ prs: { b: [1] }, rel: rl(1) }, { prs: { b: [2] }, rel: rl(2) }, "/b"),
      pairOf({ ci: { red: [], green: ["x"] }, adv: { s: [] } }, { ci: { red: ["x"], green: [] }, adv: { s: [ma(["S@k"], "unknown", "secret"), ma(["M"], "medium")] } }, "/a"),
      pairOf({ rt: [] }, { rt: [{ key: "nodejs@18", name: "node 18", eol: (NOON + DMS) / 1000 }] }, "/c"),
    ], []);
    expect(d.changes.map((c) => `${c.level} ${c.root} ${c.key}`)).toEqual([
      "bad /a ci", "bad /a security:secret", "bad /c security:runtime", "warn /a security:dependency",
      "info /b deps:b", "ok /b deps:b", "ok /b release",
    ]);
    const boards = Object.fromEntries(d.changes.map((c) => [c.key, findingTarget(c).board]));
    expect(boards).toEqual({ ci: "ci", "security:secret": "advisories", "security:runtime": "runtimes", "security:dependency": "advisories",
      "deps:b": "update-prs", release: "releases" });
  });

  it("dates the head from the commonest baseline and says a project measured from another", () => {
    const d = weekDigest([pairOf({}, {}, "/a"), pairOf({}, {}, "/b"), pairOf({}, {}, "/c", NOON - 13 * DMS)], []);
    expect(d).toMatchObject({ since: NOON, until: NOON + WEEK, span: "week" });
    expect(d.gaps.filter((g) => g.facet === null)).toEqual([{ facet: null, roots: ["/c"], why: `compared from ${fmtDay(NOON - 13 * DMS)}`, click: false }]);
    expect(weekDigest([pairOf({}, {}, "/a", NOON + 3 * DMS)], []).span, "nothing a week old: the first check").toBe("first");
    expect(weekDigest([pairOf({}, {}, "/a", NOON - 7 * DMS)], []).span).toBe("long");
  });

  it("keeps a project behind the fleet's newest day out of the week, and says when it was last read", () => {
    const pair = (root: string, from: number, to: number, o: Partial<WeekMark> = {}): WeekPairIn => ({ root, base: mark(NOON + from * DMS), now: mark(NOON + to * DMS, o), th: MAINT_DEFAULTS });
    const red = { ci: { red: ["deploy"], green: [] } };
    const d = weekDigest([pairOf({}, {}, "/a"), pairOf({}, {}, "/b"), pair("/gone", -40, -33, red)], []);
    expect(d).toMatchObject({ ciBroke: 0, changes: [], compared: 2, behind: ["/gone"], span: "week", since: NOON, until: NOON + WEEK, quiet: true });
    expect(d.gaps).toContainEqual({ facet: null, roots: ["/gone"], why: `last checked ${fmtDay(NOON - 33 * DMS)}`, click: false });
    const said = weekNotCompared(d, { "/gone": "api" })!;
    expect(said.line).toContain("1 project last checked earlier");
    expect(said.line, "and it is not counted again as compared over another span").not.toContain("another span");
    expect(said.tip).toContain(`Last checked ${fmtDay(NOON - 33 * DMS)}: api`);
    expect(weekDigest([pairOf({}, {}, "/a"), pair("/short", 0, 1, red)], []), "a day's reading says little of the week").toMatchObject({ behind: ["/short"], compared: 1, ciBroke: 0 });
    expect(weekDigest([pairOf({}, {}, "/a"), pair("/slack", 0, 6, red)], []), "a day's slack is the same check").toMatchObject({ behind: [], ciBroke: 1 });
    const opened = weekDigest([pairOf({}, {}, "/a"), pairOf({}, {}, "/b"), pair("/x", 3, 10)], []);
    expect(opened, "one project read since moves neither end for the rest").toMatchObject({ behind: [], compared: 3, since: NOON, until: NOON + WEEK });
    expect(opened.gaps.filter((g) => g.facet === null)).toEqual([{ facet: null, roots: ["/x"], why: `compared from ${fmtDay(NOON + 3 * DMS)}`, click: false }]);
  });

  it("names a project with no mark at all, which is not one checked once", () => {
    const d = weekDigest([pairOf({}, {})], ["/once"], ["/never"]);
    expect(d).toMatchObject({ unmarked: ["/once"], unread: ["/never"] });
    const said = weekNotCompared(d, { "/never": "api" })!;
    expect(said.line).toContain("1 project not checked yet");
    expect(said.tip).toContain("Not checked yet: api");
  });

  it("says a public source this machine opted into when its read fails, since every scan asks it", () => {
    const base = { adv: { osv: [ma(["X"])] } }, now = { adv: {} }, why = "OSV.dev read in full only then";
    expect(weekDigest([pairOf(base, now)], []).gaps).toContainEqual({ facet: "security", roots: ["/r"], why, click: true });
    const opted = weekDigest([pairOf(base, now)], [], [], ["osv"]);
    expect(opted.gaps).toContainEqual({ facet: "security", roots: ["/r"], why, click: false });
    expect(weekNotCompared(opted, {})!.line).toContain("Security in 1 project");
    expect(weekDigest([pairOf({ rt: null }, { rt: [] })], [], [], ["runtime-eol"]).gaps)
      .toContainEqual({ facet: "security", roots: ["/r"], why: "runtimes read only now", click: false });
  });

  it("words the figures, the summary and what was not compared", () => {
    const d = weekDigest([
      pairOf({ ci: { red: ["a"], green: [] }, adv: { s: [ma(["X"])], "npm-audit": [] }, prs: { b: [1, 2, 3] } },
        { ci: { red: [], green: ["a"] }, adv: { s: [ma(["Y"], "medium")] }, prs: { b: [4] }, rel: { tags: 1, tag: null, published: null, fetchedAt: null } }),
      pairOf({ ci: null }, {}, "/q"),
    ], ["/n"]);
    expect(weekFigs(d)).toEqual([
      { n: 1, text: "workflow fixed", level: null }, { n: 1, text: "new advisory", level: "warn" }, { n: 1, text: "advisory cleared", level: null },
      { n: 3, text: "update PRs closed", level: null }, { n: 1, text: "update PR opened", level: null },
    ]);
    expect(weekSummary(d)).toEqual(["1 workflow fixed", "1 advisory cleared · 1 new", "3 update PRs closed · 1 opened"]);
    const gaps = weekNotCompared(d, { "/r": "app", "/q": "api", "/n": "web" })!;
    expect(gaps.line).toBe("Not compared: CI in 1 project · Security in 1 project · Dependencies in 1 project · Release in 2 projects · 1 project checked once so far");
    expect(gaps.tip).toEqual(expect.arrayContaining(["CI: no verdict then: api", "Security: npm audit read in full only then: app", "Checked once so far: web"]));
    const quietTip = weekNotCompared(weekDigest([pairOf({ adv: { "npm-audit": [], s: [] }, rel: { tags: 1, tag: null, published: null, fetchedAt: null } },
      { adv: { s: [] }, rel: { tags: 1, tag: null, published: null, fetchedAt: null } })], []), {});
    expect(quietTip, "a click-only source is named in the tip alone").toEqual({ line: "Not compared: Dependencies in 1 project", tip: [
      "Security: npm audit read in full only then: /r", "Dependencies: no update bot read in full both times: /r"] });
  });
});

describe("Today's red default branch", () => {
  const failing = () => input(ok(GHA, ci(run("build", "fail", S - 3 * D), run("build", "pass", S - 4 * D))));
  const snap = { at: NOW - 5 * H * 1000, account: null, cells: [], findings: [
    { facet: "ci" as const, key: "ci:deploy", level: "bad" as const, text: "CI failing 1d" },
    { facet: "git" as const, key: "git:tidy", level: "info" as const, text: "2 branches to tidy" },
  ] };

  it("reads this session's CI once its cell has an answer, dated by the first red run", () => {
    expect(ciRows(failing(), snap, NOW)).toEqual([
      { key: "ci:build", text: "CI failing 3d", detail: "build on main · first red at abcdef1", since: (S - 3 * D) * 1000, asOf: null },
    ]);
    expect(ciRows(input(ok(GHA, ci(run("build", "pass", S - D)))), snap, NOW)).toEqual([]); // green beats the snapshot
  });

  it("falls back to the last check's lines while the cell is unread, and says when that was", () => {
    const reading: MaintInput = { det: det([GHA]), reports: {} };
    for (const inp of [null, reading]) {
      expect(ciRows(inp, snap, NOW)).toEqual([{ key: "ci:deploy", text: "CI failing 1d", detail: "deploy", since: null, asOf: snap.at }]);
    }
    expect(ciRows(null, undefined, NOW)).toEqual([]);
  });

  it("keeps the last known red when this session's read failed: a failed read is no verdict", () => {
    const past = [{ key: "ci:deploy", text: "CI failing 1d", detail: "deploy", since: null, asOf: snap.at }];
    for (const cov of [{ state: "error", reason: "HTTP 502" }, { state: "noAccess", reason: "auth expired" }] as Coverage[]) {
      expect(ciRows(input(not(GHA, "ci", cov)), snap, NOW)).toEqual(past);
    }
    const marked: MaintInput = { det: det([], { markers: [{ facet: "ci", label: "GitLab CI", found: [".gitlab-ci.yml"] }] }), reports: {} };
    expect(ciRows(marked, snap, NOW)).toEqual(past);
    const noCi: MaintInput = { det: det([]), reports: {} };
    expect(ciRows(noCi, snap, NOW), "no CI at all is a verdict").toEqual([]);
  });

  it("a scan whose CI read failed keeps the last known red in the snapshot it leaves, dated as then", () => {
    const red = takeSnap("/r", failing(), NOW - 2 * D * 1000);
    const failed = input(not(GHA, "ci", { state: "noAccess", reason: "auth expired", fix: null }));
    const next = clampSnaps(JSON.parse(JSON.stringify({ "/r": takeSnap("/r", failed, NOW, red) })))["/r"];
    expect(next.at).toBe(NOW);
    expect(next.cells.find((c) => c.facet === "ci")).toEqual({ ...red.cells.find((c) => c.facet === "ci"), at: red.at });
    const line = red.findings.find((f) => f.key === "ci")!;
    expect(ciRows(null, next, NOW)).toEqual([{ key: "ci", text: line.text, detail: "", since: null, asOf: red.at }]);
    expect(pastCells(next, NOW).find((c) => c.facet === "ci")!.tip[0]).toBe("as of the last check, 2d ago");
    const green = takeSnap("/r", input(ok(GHA, ci(run("build", "pass", S - H)))), NOW, red);
    expect(green.findings.filter((f) => f.facet === "ci")).toEqual([]); // a verdict replaces it
    expect(green.cells.every((c) => c.at === undefined)).toBe(true);
  });
});

// docs/maintenance.md's trigger rule, read off the source: the fleet is the home stage, so these run
// at boot and on every exit from a pane, and a sweep reached from any of them is one nobody asked for.
// The dashboard paints on every renderAll frame, so the same holds for its render path.
describe("nothing scans until a person asks", () => {
  // Inverted on purpose: every ./maintscan or ./maintui binding counts as a scan unless it is
  // listed as a cache read, so a new import has to be argued into the list.
  const callGraph = (file: string, reads: string[], ownScans: string[]) => {
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")
      .replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    const imported = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/(?:maintscan|maintui)"/g)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean));
    const scans = [...imported.filter((n) => !reads.includes(n)), ...ownScans];
    // Each top-level declaration runs to the next one; good enough for a call graph over one file.
    const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm;
    const heads = [...src.matchAll(decl)];
    const bodies = new Map(heads.map((m, i) => [m[1], src.slice(m.index!, heads[i + 1]?.index ?? src.length)]));
    const reaches = (from: string): string[] => {
      const seen = new Set([from]), queue = [from], hit = new Set<string>();
      while (queue.length) {
        for (const w of bodies.get(queue.shift()!)!.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          if (scans.includes(w)) hit.add(w);
          else if (bodies.has(w) && !seen.has(w)) { seen.add(w); queue.push(w); }
        }
      }
      return [...hit];
    };
    return { scans, bodies, reaches };
  };

  const fleet = callGraph("fleetui.ts",
    ["maintOf", "maintInput", "maintSnap", "maintWeek", "maintPrefs", "fleetCheckedAt", "fleetScanning", "askingFor", "MAINT_FRESH_MS", "maintChip", "maintEarlier", "maintPicked", "maintSev", "quietOpen",
      "MaintHost", "sweeps", "shownSweep", "SweepRun"],
    ["maint_read", "maint_detect"]);
  const dash = callGraph("dashboard.ts", ["maintOf", "maintInput", "maintSnap", "askingFor", "maintSev", "MaintHost"], ["loadMaint", "maint_read", "maint_detect"]);

  it("finds the functions it is about, and a walk that can see a scan", () => {
    for (const f of ["openFleet", "loadFleet", "renderFleet", "buildView", "buildMaint"]) expect(fleet.bodies.has(f), f).toBe(true);
    expect(fleet.reaches("setFleetView")).toContain("scanFleet"); // the switch is the ask
    expect(fleet.reaches("maintOnBoot")).toContain("scanFleet"); // and a boot that lands on the view
    expect(fleet.scans).toEqual(expect.arrayContaining(["scanFleet", "maintClick"]));
    for (const f of ["renderDash", "renderDashHeader", "paintMaint", "maintNow", "setDashTab"]) expect(dash.bodies.has(f), f).toBe(true);
    expect(dash.reaches("setDashTab")).toContain("loadMaint"); // the tab is the ask
    expect(dash.scans).toEqual(expect.arrayContaining(["scanProject", "maintClick"]));
  });

  it("never reaches a scan from openFleet, loadFleet, renderFleet or buildView", () => {
    for (const f of ["openFleet", "loadFleet", "renderFleet", "buildView"]) expect(fleet.reaches(f), f).toEqual([]);
  });

  it("never reaches a scan from the dashboard's render path", () => {
    for (const f of ["renderDash", "renderDashHeader", "paintMaint", "maintNow"]) expect(dash.reaches(f), f).toEqual([]);
  });
});

// The advisory sweep decides each project from what Rust read out of its lockfiles; a shape the narrow
// semver cannot read is unsure, never a guess (docs/maintenance.md § Advisory sweep).
describe("the advisory sweep", () => {
  const span = (introduced: string | null, fixed: string | null, kind = "SEMVER", lastAffected: string | null = null) =>
    ({ kind, introduced, fixed, lastAffected });
  const pkg = (name: string, spans: ReturnType<typeof span>[], o: Partial<SweepPkg> = {}): SweepPkg =>
    ({ ecosystem: "npm", name, spans, versions: [], versionsCut: false, range: null, ...o });
  const adv = (...packages: SweepPkg[]): SweepAdvisory => ({
    id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], summary: "Command Injection in lodash", severity: "high", rawSeverity: "HIGH",
    url: "https://adv.example/GHSA-35jh-r3h4-6jhm", packages, asked: ["GHSA-35jh-r3h4-6jhm"], gaps: [],
  });
  const facts = (root: string, o: Partial<SweepFacts> = {}): SweepFacts =>
    ({ root, locks: ["package-lock.json"], found: [], unpinned: [], unread: [], ...o });
  const lodash = adv(pkg("lodash", [span("0", "4.17.21")]), pkg("smallvec", [span("0.6.3", "0.6.14"), span("1.0.0", "1.6.1")], { ecosystem: "crates.io" }));
  const copy = (pkgIx: number, version: string, file = "package-lock.json") => ({ pkg: pkgIx, version, file });

  it("is affected inside a range, and names the fix of the range it is in", () => {
    const r = sweepVerdict(lodash, facts("/a", { found: [copy(0, "4.17.20"), copy(1, "1.6.0", "Cargo.lock")] }));
    expect(r).toEqual({
      root: "/a", verdict: "affected", word: "affected", fix: "bump → 1.6.1, 4.17.21",
      evidence: ["package-lock.json: lodash@4.17.20 · in <4.17.21", "Cargo.lock: smallvec@1.6.0 · in >=1.0.0 <1.6.1"],
    });
    expect(placeVersion(lodash.packages[1], "0.6.13")).toEqual({ state: "in", range: ">=0.6.3 <0.6.14", fixed: "0.6.14" });
  });

  it("is patched at or past the fix, and not in range below where it was introduced", () => {
    expect(sweepVerdict(lodash, facts("/b", { found: [copy(0, "4.17.21")] })))
      .toMatchObject({ verdict: "patched", word: "patched", evidence: ["package-lock.json: lodash@4.17.21 · at or past the fix, 4.17.21"] });
    expect(sweepVerdict(lodash, facts("/c", { found: [copy(1, "0.5.0", "Cargo.lock")] })))
      .toMatchObject({ verdict: "patched", word: "not in range", evidence: ["Cargo.lock: smallvec@0.5.0 · outside every affected range"] });
  });

  it("is unsure for a range shape or a version it cannot read, never a guess either way", () => {
    const odd = adv(pkg("lodash", [], { range: "~> 4.17" }));
    expect(sweepVerdict(odd, facts("/d", { found: [copy(0, "4.17.20")] })))
      .toMatchObject({ verdict: "unsure", evidence: ["package-lock.json: lodash@4.17.20 · ~> 4.17 is a range shape this does not read"] });
    expect(sweepVerdict(lodash, facts("/d", { found: [copy(0, "latest-beta")] })).verdict).toBe("unsure");
    const commits = adv(pkg("lodash", [span("0", "c6e281b8", "GIT")]));
    expect(sweepVerdict(commits, facts("/d", { found: [copy(0, "4.17.20")] })).evidence[0]).toContain("commit range");
    expect(sweepVerdict(adv(), facts("/d")).verdict, "a record naming no package").toBe("unsure");
  });

  it("places a version by the record's own list, and an unlisted one against a cut list is unsure", () => {
    const listed = pkg("lodash-rails", [], { ecosystem: "RubyGems", versions: ["4.17.20", "4.17.15"] });
    expect(placeVersion(listed, "4.17.20")).toEqual({ state: "in", range: "a listed version", fixed: null });
    expect(placeVersion(listed, "4.17.21")).toEqual({ state: "out", past: null });
    expect(placeVersion({ ...listed, versionsCut: true }, "4.17.21").state, "missing from a cut list proves nothing").toBe("unknown");
  });

  it("is unsure for a git or path copy, and for a lockfile of the ecosystem it could not read", () => {
    const git = sweepVerdict(lodash, facts("/e", { unpinned: [copy(0, "git+ssh://git@example.com/me/lodash.git#abc")] }));
    expect(git).toMatchObject({ verdict: "unsure", evidence: ["package-lock.json: lodash from git+ssh://git@example.com/me/lodash.git#abc, not the registry's copy, so its version proves nothing"] });
    const yarn = facts("/f", { found: [copy(0, "4.17.21")], unread: [{ file: "web/yarn.lock", ecosystem: "npm", reason: "a lockfile Episko does not read" }] });
    expect(sweepVerdict(lodash, yarn), "one copy is patched, but another lockfile may hold one that is not").toMatchObject({ verdict: "unsure" });
    const py = facts("/g", { unread: [{ file: "poetry.lock", ecosystem: "PyPI", reason: "a lockfile Episko does not read" }] });
    expect(sweepVerdict(lodash, py).verdict, "another ecosystem's lockfile cannot hold it").toBe("unused");
    expect(sweepVerdict(lodash, facts("/h", { locks: [] })).evidence).toEqual(["no npm or crates.io manifest or lockfile"]);
    const pip = facts("/i", { locks: [], unread: [{ file: "pyproject.toml", ecosystem: "PyPI", reason: "no lockfile says what it installs" }] });
    expect(sweepVerdict(adv(pkg("jinja2", [span("0", "3.1.5")], { ecosystem: "PyPI" })), pip).verdict, "a manifest it cannot read is never 'not using'")
      .toBe("unsure");
  });

  it("orders worst first and writes a report a person can paste", () => {
    const all = ["/z-unused", "/b-patched", "/c-unsure", "/a-hit"];
    const rows = sweepRows(lodash, [
      facts("/z-unused"), facts("/b-patched", { found: [copy(0, "4.17.21")] }),
      facts("/c-unsure", { unpinned: [copy(0, "file:../lodash")] }), facts("/a-hit", { found: [copy(0, "4.17.20")] }),
    ], all);
    expect(rows.map((r) => r.verdict)).toEqual(SWEEP_VERDICTS);
    const names = { "/a-hit": "wirksam", "/b-patched": "puttyparty", "/c-unsure": "gb-dashboard", "/z-unused": "notes" };
    const agents = { "/c-unsure": { state: "done" as const, check: { verdict: "not-affected" as const, evidence: ["package.json: a fork carrying the fix"] } } };
    expect(sweepReport(lodash, rows, names, agents)).toBe([
      "Advisory sweep: GHSA-35jh-r3h4-6jhm (CVE-2021-23337) · high",
      "Command Injection in lodash",
      "https://adv.example/GHSA-35jh-r3h4-6jhm",
      "affects npm lodash <4.17.21, fixed in 4.17.21",
      "affects crates.io smallvec >=0.6.3 <0.6.14 || >=1.0.0 <1.6.1, fixed in 0.6.14, 1.6.1",
      "",
      "- wirksam: affected · bump → 4.17.21",
      "    package-lock.json: lodash@4.17.20 · in <4.17.21",
      "- gb-dashboard: unsure",
      "    package-lock.json: lodash from file:../lodash, not the registry's copy, so its version proves nothing",
      "    an agent read it: not-affected",
      "      package.json: a fork carrying the fix",
      "- puttyparty: patched",
      "    package-lock.json: lodash@4.17.21 · at or past the fix, 4.17.21",
      "",
      "Not using it (1): notes",
    ].join("\n"));
    expect(sweepReport(lodash, [sweepVerdict(lodash, facts("/z"))], {})).toContain("No project uses it.");
  });

  it("draws a root the read answered nothing for as unsure, never as missing", () => {
    const rows = sweepRows(lodash, [facts("/a")], ["/a", "/lost", "/a"]);
    expect(rows.map((r) => [r.root, r.verdict])).toEqual([["/lost", "unsure"], ["/a", "unused"]]);
    expect(rows[0].evidence).toEqual(["its lockfiles were not read"]);
    expect(sweepReport(lodash, sweepRows(lodash, [], ["/x"]), {})).not.toContain("No project uses it.");
  });

  it("reads a hand-typed range as written, with no fix to name", () => {
    const typed: SweepAdvisory = { ...adv(pkg("lodash", [], { range: "<4.17.21" })), id: null, aliases: [], summary: "lodash <4.17.21", url: null, severity: "unknown" };
    expect(sweepVerdict(typed, facts("/a", { found: [copy(0, "4.17.20")] }))).toMatchObject({ verdict: "affected", fix: "a version outside <4.17.21" });
    expect(sweepTitle(typed)).toBe("lodash <4.17.21");
    expect(affectedText(pkg("x", [span("2.0.0", null)]))).toBe("npm x >=2.0.0");
    expect(spanRange(span(null, null, "ECOSYSTEM", "4.5.0"))).toBe("<=4.5.0");
  });

  it("narrows exactly what maint_sweep.rs serializes (test/fixtures/sweep-wire.json)", () => {
    const w = JSON.parse(readFileSync(new URL("./fixtures/sweep-wire.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(narrowSweep(w.advisory)).toEqual(w.advisory);
    expect(narrowSweep(w.typed)).toEqual(w.typed);
    expect(narrowSweepFacts(w.facts)).toEqual(w.facts);
    expect(narrowSweepCheck(w.check)).toEqual(w.check);
  });

  it("narrows what Rust sends rather than trusting it", () => {
    expect(narrowSweep(lodash)).toEqual(lodash);
    expect(narrowSweep({ ...lodash, severity: "dire" })).toBeNull();
    expect(narrowSweepFacts([facts("/a"), { root: "/b" }, null])).toEqual([facts("/a")]);
    expect(narrowSweepFacts("nope")).toEqual([]);
    expect(narrowSweepCheck({ verdict: "not-affected", evidence: ["x"] })).toEqual({ verdict: "not-affected", evidence: ["x"] });
    expect(narrowSweepCheck({ verdict: "probably", evidence: [] })).toBeNull();
  });
});

describe("a maintenance session", () => {
  const line = (key: string, verb: Verb = "fix", o: Partial<Finding> = {}): Finding =>
    ({ root: "/r", facet: "ci", key, level: "warn", text: `the ${key} line`, detail: "", verb, source: "s", ref: null, ...o });
  const repo = (o: { trunk?: string | null; fetchedAt?: number } = {}) =>
    input(ok("g", hyg({ trunk: o.trunk === undefined ? "origin/main" : o.trunk, fetchedAt: o.fetchedAt ?? S - H })));
  const ctx = (o: Partial<SessionCtx> = {}): SessionCtx => ({ heads: () => [], plain: () => false, earlier: () => false, busy: () => false, name: () => "acme", now: NOW, ...o });
  const at = (f: Finding, inp: MaintInput = repo()): SessionLine => ({ f, inp });
  const head = (branch: string, o: Partial<WtHead> = {}): WtHead => ({ path: `/wt/${branch.replace("/", "-")}`, branch, is_main: false, exists: true, ...o });

  it("classifies every verb, in the order a person reads them", () => {
    expect(Object.entries(VERB_KIND).filter(([, k]) => k === "here").map(([v]) => v).sort()).toEqual(["deploy", "push", "release", "tidy"]);
    expect(Object.entries(VERB_KIND).filter(([, k]) => k === null).map(([v]) => v).sort()).toEqual(["fetch", "review", "run"]);
    expect(Object.entries(VERB_KIND).filter(([, k]) => k === "branch").map(([v]) => v).sort()).toEqual(["fix", "patch", "rotate", "setup", "upgrade"]);
  });

  it("holds the cap to the WebGL pool, one context per visible tile", () => {
    const src = readFileSync(new URL("../src/terminal.ts", import.meta.url), "utf8");
    expect(SESSION_MAX).toBe(Number(/GL_POOL_MAX = (\d+)/.exec(src)?.[1]));
  });

  it("never presses Enter: every pane is prefilled through the one path that writes no line ending", () => {
    const lf = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const actions = lf("actions.ts");
    const from = actions.indexOf("export async function launchTogether");
    const body = actions.slice(from, actions.indexOf("\n}\n", from));
    expect(from).toBeGreaterThan(0);
    expect(body).toContain("prefillFresh(sid, row.text)");
    expect(body).not.toContain("\\r");
    expect(body).not.toContain("write_pty");
    const panes = lf("panes.ts");
    const at = panes.indexOf("export function prefillFresh");
    const fresh = panes.slice(at, panes.indexOf("\n}\n", at));
    expect(fresh).toContain("freshReady(sid)");
    expect(fresh).toContain("typeInto(sid, text)");
    expect(fresh).not.toContain("\\r");
  });

  it("moves both older prefill paths off the fixed delay that raced a remount", () => {
    for (const file of ["main.ts", "dashboard.ts"]) {
      const src = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      expect(src, file).toContain("prefillFresh(sid, text);");
      expect(src, file).not.toMatch(/typeInto\(sid, text\)/);
    }
  });

  describe("fixBranch", () => {
    it("slugs every Overview key shape", () => {
      const said: Record<string, string> = {
        ci: "maint/ci", "security:dependency": "maint/security-dependency", "security:runtime": "maint/security-runtime",
        release: "maint/release", "git:tidy": "maint/git-tidy", "prod:api": "maint/prod-api", "prod:cert:api": "maint/prod-cert-api",
        "ci:flaky": "maint/ci-flaky", "release:deploy-failed": "maint/release-deploy-failed",
        "prod:API Gateway.v2": "maint/prod-api-gateway-v2", "CVE-2021-23337": "maint/cve-2021-23337",
      };
      for (const [key, b] of Object.entries(said)) {
        expect(fixBranch({ key }), key).toBe(b);
        expect(whereProblem({ kind: "new", branch: b, base: "" }, []), key).toBeNull();
      }
    });

    it("caps a long name at 40 and leaves no dash hanging off the cut", () => {
      const b = fixBranch({ key: `prod:${"a".repeat(34)}:more` });
      expect(b).toBe(`maint/prod-${"a".repeat(34)}`.slice(0, 46).replace(/-+$/, ""));
      expect(b.length - "maint/".length).toBeLessThanOrEqual(40);
      expect(fixBranch({ key: "x".repeat(39) + ":y" })).toBe(`maint/${"x".repeat(39)}`);
    });

    it("still answers for a name with nothing git can spell", () => {
      expect(fixBranch({ key: "日本語" })).toBe("maint/line");
      expect(whereProblem({ kind: "new", branch: fixBranch({ key: "日本語" }), base: "" }, [])).toBeNull();
    });
  });

  it("round-trips a key whose root may hold anything but a NUL", () => {
    const f = { root: "C:\\Work\\my repo", key: "prod:cert:api" };
    expect(parseSessionKey(sessionKey(f))).toEqual(f);
    expect(sessionKey({ root: "/a", key: "ci" })).not.toBe(sessionKey({ root: "/b", key: "ci" }));
  });

  describe("trunkOf", () => {
    it("reads hygiene's, then release's, then the file's, then says it does not know", () => {
      expect(trunkOf(input(ok("g", hyg({ trunk: "origin/dev" })), ok("t", rel({ trunk: "origin/main" }))))).toBe("origin/dev");
      expect(trunkOf(input(ok("g", hyg({ trunk: null })), ok("t", rel({ trunk: "origin/main" }))))).toBe("origin/main");
      const filed = input();
      filed.det!.config.trunk = "develop";
      expect(trunkOf(filed)).toBe("develop");
      expect(trunkOf(input())).toBeNull();
      expect(trunkOf({ det: null, reports: {} })).toBeNull();
    });

    it("takes a deployments read's trunk as the release facet's, and passes over one with no environment to measure", () => {
      expect(trunkOf(input(ok("gd", { kind: "deployments", trunk: "origin/main", envs: [], fetchedAt: null })))).toBe("origin/main");
      expect(trunkOf(input(ok("gd", { kind: "deployments", trunk: null, envs: [], fetchedAt: null })))).toBeNull();
    });

    it("does not read a source this machine skips", () => {
      expect(trunkOf({ ...input(ok("g", hyg({ trunk: "origin/dev" }))), skip: ["g"] })).toBeNull();
    });
  });

  describe("sessionPlan", () => {
    it("skips a verb no agent answers, naming the project", () => {
      const p = sessionPlan([at(line("deps:b", "review")), at(line("git:fetch", "fetch")), at(line("run:x", "run"))], ctx());
      expect(p.rows).toEqual([]);
      expect(p.skipped.map((s) => s.key)).toEqual(["deps:b", "git:fetch", "run:x"]);
      expect(p.skipped[0].why).toBe("acme: no agent answers this line");
      expect(p.skipped[0].open).toBe(false);
    });

    it("runs a Fix that only reads production in the project's folder, and any other Fix on its branch", () => {
      for (const key of ["prod:api", "prod:cert:api", "prod:host:disk", "prod:domain:example.com", "release:deploy-failed"]) {
        expect(sessionKind(line(key)), key).toBe("here");
        expect(sessionPlan([at(line(key))], ctx()).rows[0], key).toMatchObject({ where: { kind: "here" }, branch: null });
      }
      for (const key of ["ci", "ci:flaky", "security:code"]) expect(sessionKind(line(key)), key).toBe("branch");
      expect(sessionKind(line("prod:errors:new")), "an error in production is fixed in code").toBe("branch");
      expect(sessionPlan([at(line("prod:errors:new"))], ctx()).rows[0]).toMatchObject({ where: { kind: "new" }, branch: "maint/prod-errors-new" });
      expect(sessionKind(line("prod:setup", "setup")), "setting up [deploy] writes a file").toBe("branch");
      expect(sessionKind(line("deps:b", "review")), "no agent's work, whatever the key").toBeNull();
    });

    it("starts one agent per host of a project, since one brief names everything it has", () => {
      const p = sessionPlan([at(line("prod:host:disk")), at(line("prod:host:reboot")), at(line("prod:api"))], ctx());
      expect(p.rows.map((r) => r.key)).toEqual(["prod:host:disk", "prod:api"]);
      expect(p.skipped.map((s) => [s.key, s.why, s.open])).toEqual([["prod:host:reboot", "acme: another ticked line has this host's brief", false]]);
      expect(sessionGate(p, true), "said, not dropped").toBe("acme: another ticked line has this host's brief");
      const two = sessionPlan([at(line("prod:host:disk", "fix", { root: "/a" })), at(line("prod:host:disk", "fix", { root: "/b" }))], ctx());
      expect(two.rows.map((r) => r.root), "each project's brief names its own services").toEqual(["/a", "/b"]);
    });

    it("runs Push, Tidy, Draft release and Plan deploy in the project's folder, with no branch", () => {
      const p = sessionPlan([at(line("git:unpushed", "push")), at(line("git:tidy", "tidy")), at(line("release", "release")), at(line("release:deploy", "deploy"))], ctx());
      expect(p.rows.map((r) => r.where)).toEqual([{ kind: "here" }, { kind: "here" }, { kind: "here" }, { kind: "here" }]);
      expect(p.rows.every((r) => r.branch === null)).toBe(true);
    });

    it("ticks a flaky job and both deployment lines: the code work on its branch, the two that write nothing in the folder", () => {
      const inp = input(ok("g", hyg()),
        ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: null, runs: 9, reran: 1, jobs: [{ workflow: "ci", job: "e2e", reruns: 2, passed: 2, steps: [], seen: [] }] }),
        ok("github-deployments", { kind: "deployments", trunk: "origin/main", fetchedAt: S - H, envs: [{ env: "prod", tier: "production", sha: "a".repeat(40), tag: null, branch: null, at: S - D, url: null,
          behind: 23, behindAt: S - 9 * D, ahead: 0, last: { state: "fail", raw: "FAILURE", sha: "b".repeat(40), at: S - H, url: null } }] }));
      const fs = findings("/r", inp, MAINT_DEFAULTS, NOW), want = ["ci:flaky", "release:deploy-failed", "release:deploy"];
      const picked = want.map((k) => fs.find((f) => f.key === k)!);
      const { pickable } = sessionLines([{ band: "needs", findings: picked }]);
      expect([...pickable].map((k) => parseSessionKey(k).key)).toEqual(want);
      const { rows, skipped } = sessionPlan(picked.map((f) => at(f, inp)), ctx());
      expect(skipped).toEqual([]);
      expect(rows.map((r) => r.where)).toEqual([
        { kind: "new", branch: "maint/ci-flaky", base: "origin/main" },
        { kind: "here" },
        { kind: "here" },
      ]);
    });

    it("cuts a line that changes code off the trunk, whichever read named it", () => {
      const p = (inp: MaintInput) => sessionPlan([at(line("security:dependency", "patch"), inp)], ctx()).rows[0];
      expect(p(repo()).where).toEqual({ kind: "new", branch: "maint/security-dependency", base: "origin/main" });
      expect(p(repo()).from).toBe("origin/main");
      expect(p(input(ok("t", rel({ trunk: "origin/next" })))).where).toMatchObject({ base: "origin/next" });
      const filed = input();
      filed.det!.config.trunk = "develop";
      expect(p(filed).where).toMatchObject({ base: "develop" });
    });

    it("says what an empty base means, rather than leaving it blank", () => {
      const r = sessionPlan([at(line("ci"), input())], ctx()).rows[0];
      expect(r.where).toEqual({ kind: "new", branch: "maint/ci", base: "" });
      expect(r.from).toBe("what acme has checked out");
    });

    it("says how old the base is past the stale window, since Maintenance never fetches", () => {
      expect(sessionPlan([at(line("ci"), repo({ fetchedAt: S - 9 * D }))], ctx()).rows[0].from).toBe("origin/main, as of the last fetch 9d ago");
      expect(sessionPlan([at(line("ci"), repo({ fetchedAt: S - 2 * D }))], ctx()).rows[0].from).toBe("origin/main");
    });

    it("does not draw a fetch nobody has on record as a fresh one", () => {
      const never = input(ok("g", hyg({ trunk: "origin/main", fetchedAt: null })));
      expect(sessionPlan([at(line("ci"), never)], ctx()).rows[0].from).toBe("origin/main, last fetch unknown");
      const filed = input();
      filed.det!.config.trunk = "develop";
      expect(sessionPlan([at(line("ci"), filed)], ctx()).rows[0].from).toBe("develop, last fetch unknown");
    });

    it("reuses a checkout already on the branch, so a later session lands beside the earlier work", () => {
      const wt = sessionPlan([at(line("ci"))], ctx({ heads: () => [head("main", { is_main: true, path: "/r" }), head("maint/ci")] })).rows[0];
      expect(wt.where).toEqual({ kind: "wt", path: "/wt/maint-ci" });
      expect(wt.branch).toBe("maint/ci");
      const main = sessionPlan([at(line("ci"))], ctx({ heads: () => [head("maint/ci", { is_main: true, path: "/r" })] })).rows[0];
      expect(main.where).toEqual({ kind: "here" });
      expect(main.branch).toBe("maint/ci");
    });

    it("plans a branch an earlier session left as what it is, never as one cut fresh from the trunk", () => {
      const left = (root: string, b: string) => root === "/r" && b === "maint/ci";
      const r = sessionPlan([at(line("ci"))], ctx({ earlier: left })).rows[0];
      expect(r.where).toEqual({ kind: "old", branch: "maint/ci", base: "origin/main" });
      expect(r.branch).toBe("maint/ci");
      expect(r.from).toBe("");
      expect(sessionPlan([at(line("security:code"))], ctx({ earlier: left })).rows[0].where.kind).toBe("new");
    });

    it("lets a checkout on that branch win, since an earlier branch is only asked about with none", () => {
      const r = sessionPlan([at(line("ci"))], ctx({ earlier: () => true, heads: () => [head("maint/ci")] })).rows[0];
      expect(r.where).toEqual({ kind: "wt", path: "/wt/maint-ci" });
    });

    it("skips a branch whose folder was deleted by hand, which git refuses until it is pruned", () => {
      const p = sessionPlan([at(line("ci"))], ctx({ heads: () => [head("maint/ci", { exists: false })], earlier: () => true }));
      expect(p.rows).toEqual([]);
      expect(p.skipped[0]).toMatchObject({ key: "ci", open: false });
      expect(p.skipped[0].why).toBe("acme: maint/ci's folder is gone and git still lists it: run `git worktree prune`");
    });

    it("runs a code line in a plain folder where it stands, since there is no branch to cut", () => {
      const plain = (root: string) => root === "/r";
      const r = sessionPlan([at(line("security:runtime", "upgrade"), input())], ctx({ plain })).rows[0];
      expect(r.where).toEqual({ kind: "here" });
      expect(r.branch).toBeNull();
      expect(sessionPlan([at(line("ci", "fix", { root: "/repo" }))], ctx({ plain })).rows[0].where.kind).toBe("new");
    });

    it("skips a checkout an agent already works in, and asks about that checkout", () => {
      const asked: string[][] = [];
      const p = sessionPlan([at(line("ci")), at(line("security:code"))], ctx({
        heads: () => [head("maint/ci")], busy: (path, root) => { asked.push([path, root]); return true; },
      }));
      expect(asked).toEqual([["/wt/maint-ci", "/r"]]);
      expect(p.skipped).toEqual([{ root: "/r", key: "ci", why: "acme: an agent already works on maint/ci", open: true }]);
      expect(p.rows.map((r) => r.key)).toEqual(["security:code"]);
    });

    it("never lands two ticked lines of one project on one branch", () => {
      const p = sessionPlan([at(line("ci:a.b")), at(line("ci:a-b"))], ctx());
      expect(p.rows.map((r) => r.key)).toEqual(["ci:a.b"]);
      expect(p.skipped[0].why).toBe("acme: another ticked line lands on maint/ci-a-b");
      const two = sessionPlan([at(line("ci", "fix", { root: "/a" })), at(line("ci", "fix", { root: "/b" }))], ctx());
      expect(two.rows).toHaveLength(2);
    });

    it("skips a folder too long for Claude to file the conversation under", () => {
      const deep = `/${"d".repeat(190)}`;
      const p = sessionPlan([at(line("ci", "fix", { root: deep }))], ctx());
      expect(p.rows).toEqual([]);
      expect(p.skipped[0].why).toMatch(/too long/);
    });

    it("keeps the ticked order and counts what is past the cap", () => {
      const lines = Array.from({ length: SESSION_MAX + 2 }, (_, i) => at(line("ci", "fix", { root: `/p${i}` })));
      const p = sessionPlan([...lines].reverse(), ctx());
      expect(p.rows.map((r) => r.root)).toEqual(lines.slice(2).map((l) => l.f.root).reverse());
      expect(p.over).toBe(2);
    });
  });

  describe("sessionGate", () => {
    const empty: SessionPlan = { rows: [], skipped: [], over: 0 };
    it("answers null when Start may run", () => {
      expect(sessionGate(empty, true)).toBeNull();
    });
    it("says why, the engine first", () => {
      expect(sessionGate({ ...empty, over: 3 }, false)).toBe(SESSION_EXTERNAL);
      expect(SESSION_EXTERNAL).toBe("Agents open outside Episko (Settings › Launching), so there are no panes to tile");
      expect(sessionGate({ ...empty, over: 1 }, true)).toBe("8 at most at once: one tile each");
      expect(SESSION_OVER).toBe("8 at most at once: one tile each");
      expect(sessionGate({ ...empty, skipped: [{ root: "/r", key: "ci", why: "acme: busy", open: true }, { root: "/r", key: "b", why: "later", open: false }] }, true)).toBe("acme: busy");
    });
  });

  describe("sweepGate and sessionLeft", () => {
    const empty: SessionPlan = { rows: [], skipped: [], over: 0 };
    const rows = sessionPlan([at(line("ci"))], ctx()).rows;
    const busy = { root: "/r", key: "b", why: "acme: busy", open: true };
    it("starts what it can and names the rest, since a sweep has no tick to untick", () => {
      expect(sessionGate({ ...empty, rows, skipped: [busy] }, true), "ticks must be unticked").toBe("acme: busy");
      expect(sweepGate({ ...empty, rows, skipped: [busy] }, true)).toBeNull();
      expect(sessionLeft({ ...empty, rows, skipped: [busy] })).toEqual(["acme: busy"]);
      expect(sessionLeft({ ...empty, rows, skipped: [busy, busy, busy] })).toEqual(["acme: busy and 2 more"]);
      expect(sessionLeft({ ...empty, rows })).toEqual([]);
    });
    it("refuses only with nothing left, past the cap, or with no panes to tile", () => {
      expect(sweepGate({ ...empty, skipped: [busy] }, true)).toBe("acme: busy");
      expect(sweepGate({ ...empty, rows, over: 1 }, true)).toBe(SESSION_OVER);
      expect(sweepGate({ ...empty, rows }, false)).toBe(SESSION_EXTERNAL);
    });
  });

  describe("what the bar says", () => {
    const heads = () => [head("maint/ci")];
    const plan = sessionPlan(
      [at(line("security:code")), at(line("security:dependency", "patch")), at(line("git:tidy", "tidy")), at(line("ci"))],
      ctx({ heads, busy: () => true }),
    );
    it("names what the ticks become", () => {
      expect(sessionText(plan)).toBe("2 on new fix branches · 1 in its project's folder · 1 already open");
      const one = sessionPlan([at(line("ci"))], ctx());
      expect(sessionText(one)).toBe("1 on a new fix branch");
      const again = sessionPlan([at(line("ci"))], ctx({ heads }));
      expect(sessionText(again)).toBe("1 on its earlier fix branch");
      const folders = sessionPlan([at(line("git:tidy", "tidy", { root: "/a" })), at(line("git:tidy", "tidy", { root: "/b" }))], ctx());
      expect(sessionText(folders)).toBe("2 in their projects' folders");
      expect(sessionText(sessionPlan([at(line("r", "review"))], ctx()))).toBe("1 can't start");
      expect(sessionText(sessionPlan([at(line("ci"))], ctx({ earlier: () => true })))).toBe("1 on its earlier fix branch");
    });
    it("counts the ticks a chip is not showing, or the bar disagrees with what is on screen", () => {
      expect(sessionText(sessionPlan([at(line("ci"))], ctx()), 2)).toBe("2 behind this filter · 1 on a new fix branch");
    });
    it("lists each row's destination in its tip", () => {
      const tip = sessionTip(plan, () => "acme").split("\n");
      expect(tip).toContain("acme · the security:code line → maint/security-code from origin/main");
      expect(tip).toContain("acme · the git:tidy line → in its folder");
      expect(tip).toContain("acme: an agent already works on maint/ci");
      expect(sessionTip(sessionPlan([at(line("ci"))], ctx({ heads })), () => "acme")).toBe("acme · the ci line → maint/ci, its earlier checkout");
      expect(sessionTip(sessionPlan([at(line("ci"))], ctx({ earlier: () => true })), () => "acme")).toBe("acme · the ci line → maint/ci, its earlier branch");
    });
    it("ends on what started and the first thing that did not", () => {
      expect(sessionDone(5, 5, [])).toBe("Started 5 agents, each prefilled. Read each, then press Enter");
      expect(sessionDone(1, 1, [])).toBe("Started 1 agent, prefilled. Read it, then press Enter");
      expect(sessionDone(4, 5, ["wirksam: worktree: locked"])).toBe("Started 4 of 5 · wirksam: worktree: locked");
    });
    it("carries what was noted before the launch into the toast that would overwrite it", () => {
      expect(sessionDone(2, 2, [], ["1 line changed since the last check"])).toBe("Started 2 agents, each prefilled. Read each, then press Enter · 1 line changed since the last check");
      expect(sessionDone(1, 2, ["x: worktree: locked"], ["acme: busy"])).toBe("Started 1 of 2 · x: worktree: locked · acme: busy");
    });
  });

  describe("cardsShown and sessionLines", () => {
    const card = (path: string, band: Band, findings: Finding[]) => ({ path, band, findings });
    const needs = card("/n", "needs", [line("ci", "fix", { root: "/n" }), line("deps:b", "review", { root: "/n" })]);
    const drift = card("/d", "drifting", [line("git:unpushed", "push", { root: "/d" }), line("run:x", "fix", { root: "/d", busy: true })]);
    const quiet = card("/q", "quiet", [line("git:tidy", "tidy", { root: "/q" })]);
    const unread = card("/u", "unread", []);
    const cards = rankMaint([quiet, drift, unread, needs]);

    it("shows what each chip shows, in rank order", () => {
      expect(cardsShown(cards, "all").map((c) => c.path)).toEqual(["/n", "/d", "/u"]);
      expect(cardsShown(cards, "needs").map((c) => c.path)).toEqual(["/n"]);
      expect(cardsShown(cards, "drifting").map((c) => c.path)).toEqual(["/d"]);
      expect(cardsShown(cards, "quiet").map((c) => c.path)).toEqual(["/q"]);
    });

    it("orders every line drawn and offers only what an agent can take", () => {
      const { order, pickable } = sessionLines(cardsShown(cards, "all"));
      expect(order).toEqual(["/n\u0000ci", "/n\u0000deps:b", "/d\u0000git:unpushed", "/d\u0000run:x"]);
      expect([...pickable]).toEqual(["/n\u0000ci", "/d\u0000git:unpushed"]);
      expect(sessionPickable({ verb: "fix", busy: true })).toBe(false);
      expect(sessionPickable({ verb: "review" })).toBe(false);
    });

    it("offers nothing on a quiet card, which is drawn compact", () => {
      expect(sessionLines(cardsShown(cards, "quiet"))).toEqual({ order: [], pickable: new Set() });
    });

    it("offers nothing on a snapshot's card: its lines are words, not findings", () => {
      const past = { path: "/p", band: "unread" as Band, findings: [] as Finding[], past: { findings: [{ facet: "ci", key: "ci", text: "CI failing" }] } };
      expect(sessionLines([past])).toEqual({ order: [], pickable: new Set() });
    });
  });

  it("names a sweep's fix branch after the advisory, or the package when it has no id", () => {
    const a = { id: "CVE-2021-23337", aliases: [], summary: "x", severity: "high", rawSeverity: "", url: null, packages: [], asked: [], gaps: [] } as SweepAdvisory;
    expect(fixBranch(sweepLine(a, "/r"))).toBe("maint/cve-2021-23337");
    const typed = { ...a, id: null, packages: [{ name: "@scope/left-pad", ecosystem: "npm" } as SweepPkg] };
    expect(fixBranch(sweepLine(typed, "/r"))).toBe("maint/scope-left-pad");
    expect(sweepLine(a, "/r").verb).toBe("patch");
    expect(sessionPlan([{ f: sweepLine(a, "/r"), inp: repo() }], ctx()).rows[0].where).toEqual({ kind: "new", branch: "maint/cve-2021-23337", base: "origin/main" });
  });
});
