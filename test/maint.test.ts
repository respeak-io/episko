import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADVISORY_KINDS, BOARD_IDS, CI_STATUSES, rtName, CI_STRIP, COV_STATES, FACET_TAB, FACT_FACET, FACT_KINDS, MAINT_DEFAULTS, MAINT_TABS, SEVERITIES,
  SNAP_FINDINGS, SNAP_KEY, SNAP_ROOTS, SNAP_TEXT, clampKept, packKept, ciFailures, findingTarget, projectPicks, ciFlows, ciRows, clampMaint, clampSnaps, pastCells, takeSnap, comingUp, coverFirst, coverGroups, coverRows, facetCell, facetCells, findings, forgeText, hostRows, hygieneOf, mergeAdvisories, narrowDetection,
  advisoryRows, bySev, ciBoard, hygieneBoard, probeBoard, releaseBoard, sevStrip, tabBoards, updatePrRows, workBoard,
  narrowMaint, needsCount, offers, probeRows, prodChecks, projectBand, rankMaint, settingsUrl, span, tabExtras, tabFindings, tabGaps, tabModel, tabRows, tabTally, whyWord,
  advFix, outdatedText, BOARD_COLS, boardDoor, doorAt, peekNames, coverSetups, setupKeyOf, SETUP_KEYS, eolBoard, longSpan, runtimeStates,
  affectedText, narrowSweep, narrowSweepCheck, narrowSweepFacts, placeVersion, spanRange, sweepReport, sweepRows, sweepTitle, sweepVerdict, SWEEP_VERDICTS,
  type Advisory, type Runtime, type BoardId, type Coverage, type Detection, type Door, type Facts, type Finding, type MaintInput, type SourceReport, type TabProject,
  type SweepAdvisory, type SweepFacts, type SweepPkg,
} from "../src/maint";
import { BRANCH_FILTERS } from "../src/branches";
import { briefFor } from "../src/maintbrief";
import { FACETS, type Facet } from "../src/maintsources";

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

  it("prod: down is broken, and a certificate nobody could read is unknown, never fine", () => {
    const probe = (o = {}) => ({ name: "app", url: "https://app.example", code: 200, ms: 90, certNotAfter: S + 90 * D, err: null, ...o });
    const p = (o = {}) => input(ok("h", { kind: "probes", items: [probe(o)] }));
    expect(cell("prod", p())).toMatchObject({ level: "ok" });
    expect(cell("prod", p({ code: 502 }))).toMatchObject({ level: "bad", text: "app 502" });
    expect(cell("prod", p({ code: null, err: "timeout" }))).toMatchObject({ level: "bad", text: "app down" });
    expect(cell("prod", p({ certNotAfter: S + 6 * D }))).toMatchObject({ level: "warn", text: "cert 6d" });
    expect(cell("prod", p({ certNotAfter: null }))).toMatchObject({ level: "muted", text: "cert unknown" });
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
      { ...p("plain", null), url: "http://plain" },
    )!;
    expect(r.at).toBe(S - H);
    expect(r.rows.map((x) => [x.name, x.status, x.level, x.cert, x.certLevel])).toEqual([
      ["ok", "200 · 140ms", "ok", "cert 90d", "ok"], ["soon", "200 · 1ms", "ok", "cert 6d", "warn"],
      ["gone", "200 · 1ms", "ok", "cert expired", "bad"], ["five", "502 · 1ms", "bad", "cert 90d", "ok"],
      ["four", "404", "warn", "cert 90d", "ok"], ["down", "no answer", "bad", "cert unknown", "muted"],
      ["blind", "200 · 1ms", "ok", "cert unknown", "muted"], ["plain", "200 · 1ms", "ok", "", "ok"],
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
      { path: "/f", hosts: ["quiet"], prod: fine },
    ])).toEqual([
      { host: "pi", projects: ["/a"], level: "bad", text: "api 502" },
      { host: "prod-1", projects: ["/a", "/b"], level: "bad", text: "api 502" },
      { host: "edge", projects: ["/e"], level: "warn", text: "cert 4d" },
      { host: "nas", projects: ["/d"], level: "muted", text: "not checked" },
      { host: "quiet", projects: ["/f"], level: "ok", text: "" },
    ]);
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
    expect(cnt(rows[0])).toEqual(["3:warn", "1:warn", "2:info", "1:info", "0:ok"]);
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
    advisories: {}, packages: {}, runtimes: { ends: "url" },
    "update-prs": { open: { to: "deps" }, green: { to: "deps" }, red: { to: "deps" } },
    ci: { run: "url" },
    releases: { since: { to: "landed" }, changelog: null },
    hygiene: {
      unpushed: branches("unpushed"), localOnly: branches("localonly"), merged: branches("merged"), gone: branches("gone"),
      stale: branches("stale"), idle: { to: "checkouts" }, fetched: { to: "fetch" },
    },
    work: { review: { to: "queue", filter: "pr" }, issues: { to: "queue", filter: "iss" }, prs: { to: "queue", filter: "pr" } },
    addresses: { address: "url" },
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
      ok("dependabot-alerts", { kind: "advisories", items: [adv()] }),
      scan([adv({ id: "C-1", kind: "code", pkg: null, location: "src/a.ts:3" }), adv({ id: "S-1", kind: "secret", pkg: null, location: "k" })]),
      ok("dependabot-prs", prs(2)),
      ok("git-tags", rel({ since: 10, fetchedAt: S - 9 * D })),
      ok("git-local", hyg({ unpushed: 2, merged: ["x"], fetchedAt: S - 9 * D })),
      ok("github-work", { kind: "work", issues: 3, prs: 1, reviewRequested: 1 }),
      ok("h", { kind: "probes", items: [probe("api", null, 90), probe("www", 200, 5)] }),
    );
    const at = Object.fromEntries(p.rows.map((f) => { const t = findingTarget(f); return [f.key, `${t.tab}/${t.board}`]; }));
    expect(at).toEqual({
      ci: "delivery/ci", release: "delivery/releases",
      "security:dependency": "security/advisories", "security:code": "security/advisories", "security:secret": "security/advisories",
      "deps:b": "security/update-prs",
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
    const emitted = (tab: string) => {
      const at = src.indexOf(`function ${fnOf[tab]}(`);
      expect(at, fnOf[tab]).toBeGreaterThan(-1);
      const rest = src.slice(at), body = rest.slice(0, rest.search(/\n\}\r?\n/));
      return [...body.matchAll(/board\("([\w-]+)"/g)].map((m) => m[1]);
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
    ok("dependabot-alerts", { kind: "advisories", items: [adv(), adv({ id: "B-2", pkg: "minimist", severity: "medium" })] }),
    ok("github-code-scanning", { kind: "advisories", items: [adv({ id: "C-1", kind: "code", pkg: null, location: "src/a.ts:3" })] }),
    not("github-secret-scanning", "security", { state: "off", reason: "secret scanning is off" }),
    tool("npm-audit"),
    ok("dependabot-prs", prs(2)),
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
    expect(outdatedText(false, 0, "pnpm outdated")).toBe("not checked · ⤢ runs pnpm outdated");
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

describe("Today's red default branch", () => {
  const failing = () => input(ok(GHA, ci(run("build", "fail", S - 3 * D), run("build", "pass", S - 4 * D))));
  const snap = { at: NOW - 5 * H * 1000, cells: [], findings: [
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
    ["maintOf", "maintInput", "maintSnap", "fleetCheckedAt", "fleetScanning", "askingFor", "MAINT_FRESH_MS", "maintChip", "maintSev", "quietOpen", "MaintHost",
      "sweeps", "shownSweep", "SweepRun"],
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
