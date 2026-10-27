import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADVISORY_KINDS, CI_STATUSES, COV_STATES, FACET_TAB, FACT_FACET, FACT_KINDS, MAINT_DEFAULTS, MAINT_TABS, SEVERITIES,
  SNAP_FINDINGS, SNAP_KEY, SNAP_ROOTS, SNAP_TEXT, ciFailures, ciFlows, ciRows, clampMaint, clampSnaps, pastCells, takeSnap, comingUp, coverRows, facetCell, facetCells, findings, forgeText, hostRows, hygieneOf, mergeAdvisories, narrowDetection,
  narrowMaint, probeRows, prodChecks, projectBand, rankMaint, releaseRows, span, tabExtras, tabFindings, tabGaps, tabRows, tabTally,
  type Advisory, type Coverage, type Detection, type Facts, type Finding, type MaintInput, type SourceReport,
} from "../src/maint";
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
    expect(facetCell("ci", input(future), MAINT_DEFAULTS, NOW)).toMatchObject({ state: "cantCheck", text: "can't check" });
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

  it("draws no grey dot for any coverage but ok, alone or together, in any facet", () => {
    expect(states.map((s) => s.state).sort()).toEqual(COV_STATES.filter((s) => s !== "ok").sort());
    for (const f of FACETS) {
      for (const s of states) {
        const c = cell(f, input(not("x", f, s)));
        expect(c.level, `${f} ${s.state}`).not.toBe("ok");
        // A source nobody clicked is not checked yet; every other state cannot be.
        expect(c).toMatchObject({ state: "cantCheck", text: s.state === "notRun" ? "not checked" : "can't check" });
      }
      expect(cell(f, input(...states.map((s, i) => not(`x${i}`, f, s)))).level).toBe("muted");
    }
  });

  it("puts the coverage that carries a fix first in the tip", () => {
    const c = cell("security", input(not("a", "security", states[4]), not("b", "security", states[2]), not("c", "security", states[1])));
    expect(c.tip[0]).toMatch(/^c: no access/);
    expect(c.fix).toBe("gh auth refresh");
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
    expect(cell("git", inp)).toMatchObject({ state: "cantCheck", text: "can't check" });
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
    expect(f[0]).toMatchObject({ key: "ci:ci/jenkins", text: "CI failing", detail: "ci/jenkins on main" });
  });

  it("dates failing-since over the recorded gh run list as Rust parsed it", () => {
    const gha = narrowMaint(wire.reports.find((r) => r.source === GHA)!, GHA);
    const f = findings("/r", input(gha), MAINT_DEFAULTS, NOW).filter((x) => x.facet === "ci");
    expect(f.map((x) => x.ref)).toEqual(["ci"]); // site passed last, lint is running, Dependabot is no CI
    expect(f[0].detail).toBe("ci on main · first red at aaaa003");
    expect(ciFailures([gha])[0].since).toBe(Date.parse("2026-10-24T09:00:00Z") / 1000);
  });

  it("security names its worst, and a capped list is a floor", () => {
    const two = [adv({ id: "A", severity: "medium" }), adv({ id: "B", severity: "critical" }), adv({ id: "C", severity: "critical" })];
    expect(cell("security", input(ok("s", { kind: "advisories", items: two })))).toMatchObject({ level: "bad", text: "2 critical" });
    expect(cell("security", input(ok("s", { kind: "advisories", items: two }, { truncated: true }))).text).toBe("2+ critical");
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
    expect(c, "counted once, at its worst").toMatchObject({ level: "bad", text: "1 critical" });
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
    expect(f.map((x) => [x.key, x.verb])).toEqual([["security:js/sql-injection@src/db.js:42", "fix"], ["security:js/sql-injection@src/q.js:7", "fix"]]);
    expect(f[0].detail, "code has no published fix to miss").not.toMatch(/fix/);
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
      ["ci:e2e", "bad", "fix"], ["security:A", "bad", "patch"], ["security:K@seed.ts", "bad", "rotate"], ["prod:api", "bad", "fix"],
      ["deps:b", "warn", "review"], ["release", "warn", "release"], ["git:unpushed", "warn", "push"], ["prod:cert:app", "warn", "fix"],
      ["git:tidy", "info", "tidy"],
    ]);
    expect(fs.every((f) => f.root === "/r")).toBe(true);
    expect(fs.find((f) => f.key === "security:A")).toMatchObject({ source: "s", ref: "A" });
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

  it("counts each tab with its worst row, over the filter", () => {
    expect(tabTally(all)).toEqual({
      security: { n: 1, level: "bad" }, delivery: { n: 5, level: "bad" }, code: { n: 1, level: "warn" },
      servers: { n: 0, level: null }, work: { n: 0, level: null },
    });
    expect(tabTally(all, "/c").delivery).toEqual({ n: 1, level: "info" });
  });

  it("says what an empty tab read and what it could not, never an all-clear over nothing", () => {
    const card = (path: string, inp: MaintInput) => ({ path, cells: facetCells(inp, MAINT_DEFAULTS, NOW) });
    const cards = [
      card("/b", { det: null, reports: {} }),
      card("/a", on("/a", ok(GHA, ci(run("e2e", "pass", S - D))), not("t", "release", { state: "error", reason: "x" }))),
    ];
    expect(tabGaps("delivery", cards)).toEqual({ read: 1, unset: 0, gaps: [
      { path: "/a", facet: "release", text: "can't check" },
      { path: "/b", facet: "ci", text: "not read yet" }, { path: "/b", facet: "release", text: "not read yet" },
    ] });
    expect(tabGaps("delivery", cards, "/b").read).toBe(0);
    expect(tabGaps("servers", cards, "/a"), "no deploy is a fact, not a gap").toEqual({ read: 0, unset: 1, gaps: [] });
  });

  it("counts a cell that does not know as a gap, never as read", () => {
    const card = (path: string, inp: MaintInput) => ({ path, cells: facetCells(inp, MAINT_DEFAULTS, NOW) });
    const unknown = [card("/a", on("/a", ok("w", work({ issues: 0, prs: 0, reviewRequested: null }))))];
    expect(tabGaps("work", unknown)).toEqual({ read: 0, unset: 0, gaps: [{ path: "/a", facet: "work", text: "reviews unknown" }] });
    const never = [card("/a", on("/a", ok(GHA, ci())))];
    expect(tabGaps("delivery", never).gaps.map((g) => g.text)).toContain("never ran");
    const bare = [card("/a", on("/a", ok("d", prs(0, { configured: false }))))];
    expect(tabGaps("security", bare), "no bot found is the facet's none").toMatchObject({ read: 0, gaps: [] });
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
    const run = tabExtras("/r", inp, MAINT_DEFAULTS, NOW).filter((f) => f.verb === "run");
    expect(run.map((f) => [f.key, f.facet, f.source, f.text])).toEqual([["run:http-probe", "prod", "http-probe", "URL checks: not checked"]]);
    expect(run[0].busy, "nothing out yet").toBeUndefined();
    const out = tabExtras("/r", { ...inp, asking: ["http-probe"] }, MAINT_DEFAULTS, NOW).filter((f) => f.verb === "run");
    expect(out[0].busy, "a read already out is not a button to start another").toBe(true);
    const answered = { ...inp, reports: { ...inp.reports, "http-probe": ok("http-probe", probes(p("app", 90))) } };
    expect(tabExtras("/r", answered, MAINT_DEFAULTS, NOW).filter((f) => f.verb === "run"), "asked once is no longer a row").toEqual([]);
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

describe("the project tab's cards", () => {
  it("lists every workflow once, the red ones first, with its run strip oldest first", () => {
    const flows = ciFlows(input(ok(GHA, ci(run("lint", "pass", S - H), run("test", "fail", S - H), run("test", "fail", S - 3 * D), run("test", "pass", S - 4 * D)))), NOW);
    expect(flows.branch).toBe("main");
    expect(flows.rows.map((r) => [r.workflow, r.status, r.red])).toEqual([["test", "fail", "3d"], ["lint", "pass", null]]);
    expect(flows.rows[0].runs).toEqual(["pass", "fail", "fail"]);
    expect(ciFlows(input(not(GHA, "ci", { state: "notRun" })), NOW)).toEqual({ branch: null, rows: [] });
  });

  it("marks a failure its source cannot date red with no age, caps the strip, and merges two reports", () => {
    const undated = ciFlows(input(ok("forge-commit-status", ci(run("build", "fail", S - H)))), NOW);
    expect(undated.rows.map((r) => [r.workflow, r.red])).toEqual([["build", ""]]);
    const many = Array.from({ length: 10 }, (_, i) => run("lint", i === 7 || i === 9 ? "fail" : "pass", S - i * H));
    expect(ciFlows(input(ok(GHA, ci(...many))), NOW).rows[0].runs).toEqual(["fail", ...Array(7).fill("pass")]);
    const two = ciFlows(input(ok(GHA, ci(run("lint", "pass", S - H))),
      ok("forge-commit-status", { kind: "ciRuns", branch: "trunk", runs: [run("deploy", "pass", S - H)] })), NOW);
    expect(two.branch).toBe("main");
    expect(two.rows.map((r) => r.workflow)).toEqual(["deploy", "lint"]);
  });

  it("says nothing about a release no source read, and names the tag, the count and the fetch", () => {
    expect(releaseRows(input(not("git-tags", "release", { state: "notRun" })), NOW)).toEqual([]);
    expect(releaseRows(input(ok("git-tags", rel({ since: 4 }))), NOW)).toEqual([
      { k: "Last tag", v: "v1.0 · 2d ago · 4 commits since" }, { k: "As of", v: "last fetch 1h ago" },
    ]);
    expect(releaseRows(input(ok("git-tags", rel({ tag: null, fetchedAt: null }))), NOW)).toEqual([{ k: "Last tag", v: "no release tag on origin/main" }]);
  });

  it("counts hygiene with the same age rule as the cell, and null until it was read", () => {
    expect(hygieneOf(input(not("git-local", "git", { state: "notRun" })), MAINT_DEFAULTS, NOW)).toBeNull();
    const h = hygieneOf(input(ok("git-local", hyg({
      localOnly: ["old", "new"], branches: [{ name: "old", at: S - 40 * D }, { name: "new", at: S - D }, { name: "pushed", at: S - 90 * D }],
      worktrees: [{ path: "/w", branch: "x", at: S - 40 * D }, { path: "/v", branch: "y", at: null }],
    }))), MAINT_DEFAULTS, NOW)!;
    expect(h).toMatchObject({ stale: ["old"], idle: 1, unpushed: 0 });
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
    expect(coverRows(inp).map((r) => [r.facet, r.state, r.fix])).toEqual([
      ["ci", "noAccess", "gh auth login"], ["ci", "marker", null], ["security", "none", null], ["deps", "none", null],
      ["release", "skipped", null], ["git", "ok", null], ["prod", "untracked", null], ["work", "none", null],
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
    expect(snap.findings.map((f) => f.key)).toContain("ci:build");
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
    expect(tabGaps("delivery", [{ path: "/r", cells }]).gaps.map((g) => g.text)).toEqual(["not checked this session", "not checked this session"]);
  });
});

describe("Today's red default branch", () => {
  const failing = () => input(ok(GHA, ci(run("build", "fail", S - 3 * D), run("build", "pass", S - 4 * D))));
  const snap = { at: NOW - 5 * H * 1000, cells: [], findings: [
    { facet: "ci" as const, key: "ci:deploy", level: "bad" as const, text: "CI failing 1d" },
    { facet: "git" as const, key: "git:tidy", level: "info" as const, text: "2 branches to tidy" },
  ] };

  it("reads this session's CI once its cell has an answer, dated by the first red run", () => {
    expect(ciRows("/r", failing(), snap, NOW)).toEqual([
      { key: "ci:build", text: "CI failing 3d", detail: "build on main · first red at abcdef1", since: (S - 3 * D) * 1000, asOf: null },
    ]);
    expect(ciRows("/r", input(ok(GHA, ci(run("build", "pass", S - D)))), snap, NOW)).toEqual([]); // green beats the snapshot
  });

  it("falls back to the last check's lines while the cell is unread, and says when that was", () => {
    const reading: MaintInput = { det: det([GHA]), reports: {} };
    for (const inp of [null, reading]) {
      expect(ciRows("/r", inp, snap, NOW)).toEqual([{ key: "ci:deploy", text: "CI failing 1d", detail: "deploy", since: null, asOf: snap.at }]);
    }
    expect(ciRows("/r", null, undefined, NOW)).toEqual([]);
  });

  it("keeps the last known red when this session's read failed: a failed read is no verdict", () => {
    const past = [{ key: "ci:deploy", text: "CI failing 1d", detail: "deploy", since: null, asOf: snap.at }];
    for (const cov of [{ state: "error", reason: "HTTP 502" }, { state: "noAccess", reason: "auth expired" }] as Coverage[]) {
      expect(ciRows("/r", input(not(GHA, "ci", cov)), snap, NOW)).toEqual(past);
    }
    const marked: MaintInput = { det: det([], { markers: [{ facet: "ci", label: "GitLab CI", found: [".gitlab-ci.yml"] }] }), reports: {} };
    expect(ciRows("/r", marked, snap, NOW)).toEqual(past);
    const noCi: MaintInput = { det: det([]), reports: {} };
    expect(ciRows("/r", noCi, snap, NOW), "no CI at all is a verdict").toEqual([]);
  });

  it("a scan whose CI read failed keeps the last known red in the snapshot it leaves, dated as then", () => {
    const red = takeSnap("/r", failing(), NOW - 2 * D * 1000);
    const failed = input(not(GHA, "ci", { state: "noAccess", reason: "auth expired", fix: null }));
    const next = clampSnaps(JSON.parse(JSON.stringify({ "/r": takeSnap("/r", failed, NOW, red) })))["/r"];
    expect(next.at).toBe(NOW);
    expect(next.cells.find((c) => c.facet === "ci")).toEqual({ ...red.cells.find((c) => c.facet === "ci"), at: red.at });
    const line = red.findings.find((f) => f.key === "ci:build")!;
    expect(ciRows("/r", null, next, NOW)).toEqual([{ key: "ci:build", text: line.text, detail: "build", since: null, asOf: red.at }]);
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
    ["maintOf", "maintInput", "maintSnap", "fleetCheckedAt", "fleetScanning", "askingFor", "MAINT_FRESH_MS", "maintChip", "quietOpen", "MaintHost"],
    ["maint_read", "maint_detect"]);
  const dash = callGraph("dashboard.ts", ["maintOf", "maintInput", "maintSnap", "askingFor", "MaintHost"], ["loadMaint", "maint_read", "maint_detect"]);

  it("finds the functions it is about, and a walk that can see a scan", () => {
    for (const f of ["openFleet", "loadFleet", "renderFleet", "buildView", "buildMaint"]) expect(fleet.bodies.has(f), f).toBe(true);
    expect(fleet.reaches("setFleetView")).toContain("scanFleet"); // the switch is the ask
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
