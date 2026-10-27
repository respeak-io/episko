import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADVISORY_KINDS, CI_STATUSES, COV_STATES, FACET_TAB, FACT_FACET, FACT_KINDS, MAINT_DEFAULTS, SEVERITIES,
  ciFailures, clampMaint, comingUp, facetCell, facetCells, findings, hostRows, mergeAdvisories, narrowDetection,
  narrowMaint, projectBand, rankMaint, span,
  type Advisory, type Coverage, type Detection, type Facts, type Finding, type MaintInput, type SourceReport,
} from "../src/maint";
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
  ({ workflow, status, raw: status, sha, at, url: `https://ci.example/${workflow}/${at}` });
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
        expect(c).toMatchObject({ state: "cantCheck", text: "can't check" });
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
    const w = (reviewRequested: number) => input(ok("w", { kind: "work", issues: 12, prs: 3, reviewRequested }));
    expect(cell("work", w(0))).toMatchObject({ level: "info", text: "12 open" });
    expect(cell("work", w(1))).toMatchObject({ level: "warn", text: "1 to review" });
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
      ["ci:e2e", "bad", "fix"], ["security:A", "bad", "patch"], ["security:K", "bad", "rotate"], ["prod:api", "bad", "fix"],
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

describe("coming up and hosts", () => {
  it("lists certificates inside the window, soonest first", () => {
    const p = (name: string, days: number) => ({ name, url: `https://${name}`, code: 200, ms: 1, certNotAfter: S + days * D, err: null });
    const rows = comingUp([
      { root: "/a", inp: input(ok("h", { kind: "probes", items: [p("x", 24), p("y", 45), p("gone", -1)] })) },
      { root: "/b", inp: input(ok("h", { kind: "probes", items: [p("z", 3)] })) },
    ], NOW);
    expect(rows.map((r) => [r.root, r.what])).toEqual([["/b", "certificate for z"], ["/a", "certificate for x"]]);
  });

  it("joins hosts to projects many-to-many", () => {
    expect(hostRows([{ path: "/b", hosts: ["prod-1"] }, { path: "/a", hosts: ["prod-1", "pi"] }, { path: "/c", hosts: [] }]))
      .toEqual([{ host: "pi", projects: ["/a"] }, { host: "prod-1", projects: ["/a", "/b"] }]);
  });
});

// docs/maintenance.md's trigger rule, read off the source: the fleet is the home stage, so these run
// at boot and on every exit from a pane, and a sweep reached from any of them is one nobody asked for.
describe("nothing scans until a person asks", () => {
  const FLEETUI = readFileSync(new URL("../src/fleetui.ts", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  // Inverted on purpose: every ./maintscan or ./maintui binding counts as a scan unless it is
  // listed here as a cache read, so a new import has to be argued into this list.
  const READS = ["maintOf", "maintInput", "fleetCheckedAt", "fleetScanning", "MAINT_FRESH_MS", "maintChip", "quietOpen", "MaintHost"];
  const imported = [...FLEETUI.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/(?:maintscan|maintui)"/g)]
    .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "")).filter(Boolean));
  const SCANS = [...imported.filter((n) => !READS.includes(n)), "maint_read", "maint_detect"];
  // Each top-level declaration runs to the next one; good enough for a call graph over one file.
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+)([A-Za-z_$][\w$]*)/gm;
  const heads = [...FLEETUI.matchAll(decl)];
  const bodies = new Map(heads.map((m, i) => [m[1], FLEETUI.slice(m.index!, heads[i + 1]?.index ?? FLEETUI.length)]));
  const reaches = (from: string): string[] => {
    const seen = new Set([from]), queue = [from], hit = new Set<string>();
    while (queue.length) {
      for (const w of bodies.get(queue.shift()!)!.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (SCANS.includes(w)) hit.add(w);
        else if (bodies.has(w) && !seen.has(w)) { seen.add(w); queue.push(w); }
      }
    }
    return [...hit];
  };

  it("finds the functions it is about, and a walk that can see a scan", () => {
    for (const f of ["openFleet", "loadFleet", "renderFleet", "buildView", "buildMaint"]) expect(bodies.has(f), f).toBe(true);
    expect(reaches("setFleetView")).toContain("scanFleet"); // the switch is the ask
    expect(SCANS).toEqual(expect.arrayContaining(["scanFleet", "maintClick"]));
  });

  it("never reaches a scan from openFleet, loadFleet, renderFleet or buildView", () => {
    for (const f of ["openFleet", "loadFleet", "renderFleet", "buildView"]) expect(reaches(f), f).toEqual([]);
  });
});
