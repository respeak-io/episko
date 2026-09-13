import { describe, expect, it } from "vitest";
import {
  advisoryBrief, bumpKind, cardAdvisories, checkState, cmpVer, declaredIn, depSilent, depTally,
  fixKind, groupAdvisories, outdatedBrief, outRows, parseVer, prBlockers, prBrief, prFor,
  prPackages, prReady, renovateDashboard, satisfies, sevRank, verifyCommands,
  type DepAlert, type DepManifest, type DepPr, type OutdatedRun,
} from "../src/deps";
import type { GhThread } from "../src/ghwork";

const alert = (o: Partial<DepAlert> = {}): DepAlert => ({
  number: 1, state: "open", pkg: "vitest", ecosystem: "npm", manifest: "pnpm-lock.yaml",
  scope: "development", relationship: "direct", severity: "medium", ghsa: "GHSA-a", cve: null,
  summary: "s", cvss: 5.9, epss: 0.00375, range: ">= 2.1.0, < 4.1.11", patched: "4.1.11",
  url: "u", createdAt: "2026-09-11T01:39:28Z", updatedAt: "2026-09-11T01:39:28Z", ...o,
});

const pr = (o: Partial<DepPr> = {}): DepPr => ({
  number: 7, title: "Bump vitest from 4.1.0 to 4.1.11", url: "u", author: "dependabot[bot]",
  branch: "dependabot/npm_and_yarn/vitest-4.1.11", labels: [], draft: false,
  updatedAt: "2026-09-11T01:00:00Z", mergeable: "MERGEABLE", mergeState: "CLEAN",
  checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 }, bot: "dependabot", ...o,
});

const npmManifest = (ranges: Record<string, string>, dev: string[] = []): DepManifest =>
  ({ path: "package.json", ecosystem: "npm", ranges, dev });

describe("versions", () => {
  it("reads a partial version and sorts a prerelease below its release", () => {
    expect(parseVer("v4.1")).toEqual({ major: 4, minor: 1, patch: 0, pre: "" });
    expect(parseVer("not-a-version")).toBeNull();
    const lt = (a: string, b: string) => cmpVer(parseVer(a)!, parseVer(b)!) < 0;
    expect(lt("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(lt("1.0.0-rc.2", "1.0.0-rc.10")).toBe(true); // numeric, not lexical
    expect(cmpVer(parseVer("2.0.0")!, parseVer("2.0.0")!)).toBe(0);
  });

  it("calls a 0.x minor a MAJOR bump, because semver puts the breakage there", () => {
    expect(bumpKind("1.2.3", "2.0.0")).toBe("major");
    expect(bumpKind("0.2.3", "0.3.0")).toBe("major");
    expect(bumpKind("1.2.3", "1.3.0")).toBe("minor");
    expect(bumpKind("1.2.3", "1.2.4")).toBe("patch");
    expect(bumpKind("4.1.11", "4.1.0")).toBe("none");
    expect(bumpKind("weird", "1.0.0")).toBe("unknown");
  });
});

describe("ranges", () => {
  it("reads the shapes a manifest actually contains", () => {
    expect(satisfies("1.5.0", "^1.2.3")).toBe(true);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("3.4.0", "3.x")).toBe(true);
    expect(satisfies("4.0.0", "3.x")).toBe(false);
    expect(satisfies("2.0.0", ">=1.0.0 <3.0.0")).toBe(true);
    expect(satisfies("1.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
    expect(satisfies("1.5.0", "1.0.0 - 2.0.0")).toBe(true);
    expect(satisfies("1.2.3", "*")).toBe(true);
  });

  it("reads GitHub's own comma-separated advisory range", () => {
    // The real shape from a real alert: `>= 2.1.0, < 4.1.11`, which is an AND.
    expect(satisfies("3.0.0", ">= 2.1.0, < 4.1.11")).toBe(true);
    expect(satisfies("4.1.11", ">= 2.1.0, < 4.1.11")).toBe(false);
    expect(satisfies("2.0.0", ">= 2.1.0, < 4.1.11")).toBe(false);
  });

  it("reads a BARE version as cargo does and as npm does, which are opposites", () => {
    // `serde = "1"` allows 1.9; `"vitest": "1"` allows only 1.0.0. Getting this wrong
    // inverts every verdict for one of the two ecosystems.
    expect(satisfies("1.9.0", "1", "cargo")).toBe(true);
    expect(satisfies("1.9.0", "1", "npm")).toBe(false);
    expect(satisfies("2.0.0", "1", "cargo")).toBe(false);
  });

  it("answers null for a shape it does not model, rather than guessing either way", () => {
    expect(satisfies("1.0.0", "github:me/thing")).toBeNull();
    expect(satisfies("1.0.0", "workspace:^")).toBeNull();
    expect(satisfies("nonsense", "^1.0.0")).toBeNull();
  });
});

describe("the compatibility verdict", () => {
  const m = [npmManifest({ vitest: "^4.1.0", eslint: "8.0.0" }, ["vitest"])];

  it("finds where a package is declared, and says so when nothing does", () => {
    expect(declaredIn(m, "vitest")).toEqual({ path: "package.json", range: "^4.1.0", ecosystem: "npm", dev: true });
    expect(declaredIn(m, "@vitest/mocker")).toBeNull();
  });

  it("calls a fix inside the declared range a LOCKFILE bump", () => {
    // The real case: vitest ^4.1.0 declared, 4.1.11 patched — no manifest edit at all.
    expect(fixKind(alert({ patched: "4.1.11" }), declaredIn(m, "vitest"))).toBe("lockfile");
  });

  it("separates widening a range from crossing a major", () => {
    expect(fixKind(alert({ pkg: "eslint", patched: "8.9.0" }), declaredIn(m, "eslint"))).toBe("manifest");
    expect(fixKind(alert({ pkg: "eslint", patched: "9.0.0" }), declaredIn(m, "eslint"))).toBe("major");
  });

  it("distinguishes a transitive package from one we simply could not read", () => {
    expect(fixKind(alert({ pkg: "@vitest/mocker", relationship: "transitive" }), null)).toBe("transitive");
    expect(fixKind(alert({ pkg: "mystery", relationship: "direct" }), null)).toBe("unknown");
    // A range shape nobody models must not be dressed up as a verdict.
    expect(fixKind(alert(), { path: "package.json", range: "workspace:^", ecosystem: "npm", dev: false }))
      .toBe("unknown");
  });

  it("says there is no fix rather than inventing one", () => {
    expect(fixKind(alert({ patched: null }), declaredIn(m, "vitest"))).toBe("none");
  });
});

describe("advisories", () => {
  // Both halves of the alert pair this feature was designed against: one GHSA, two packages.
  const pair = [
    alert({ number: 5, pkg: "vitest", relationship: "direct" }),
    alert({ number: 4, pkg: "@vitest/mocker", relationship: "transitive" }),
  ];

  it("is ONE row per advisory, however many packages it hit", () => {
    const g = groupAdvisories(pair, [npmManifest({ vitest: "^4.1.0" })]);
    expect(g).toHaveLength(1);
    expect(g[0].alerts.map((a) => a.pkg)).toEqual(["@vitest/mocker", "vitest"]);
  });

  it("prices the group by its declared packages, not by a transitive one beside them", () => {
    // The real pair: vitest is declared and a lockfile bump clears it; @vitest/mocker is
    // transitive and is fixed by that same bump. "via a parent" would hide the actual action.
    const g = groupAdvisories(pair, [npmManifest({ vitest: "^4.1.0" })]);
    expect(g[0].worst).toBe("lockfile");
  });

  it("says via a parent only when NOTHING in the group is declared", () => {
    const g = groupAdvisories(
      [alert({ pkg: "@vitest/mocker", relationship: "transitive" })], [npmManifest({})]);
    expect(g[0].worst).toBe("transitive");
  });

  it("takes the COSTLIEST fix in the group, never the cheapest", () => {
    const g = groupAdvisories(
      [alert({ pkg: "a", patched: "2.0.0" }), alert({ pkg: "b", patched: "1.0.1" })],
      [npmManifest({ a: "^1.0.0", b: "^1.0.0" })]);
    // `b` is a lockfile bump and `a` crosses a major; saying "lockfile bump" would understate it.
    expect(g[0].worst).toBe("major");
  });

  it("puts severity first, then what ships, then likelihood", () => {
    expect(sevRank("critical")).toBeLessThan(sevRank("low"));
    expect(sevRank("nonsense")).toBeGreaterThan(sevRank("low"));
    const g = groupAdvisories([
      alert({ ghsa: "G-low", severity: "low" }),
      alert({ ghsa: "G-crit", severity: "critical" }),
      alert({ ghsa: "G-dev", severity: "high", scope: "development" }),
      alert({ ghsa: "G-ship", severity: "high", scope: "runtime" }),
    ], []);
    expect(g.map((a) => a.ghsa)).toEqual(["G-crit", "G-ship", "G-dev", "G-low"]);
  });

  it("keeps an alert with no GHSA rather than collapsing every one of them into a single row", () => {
    const g = groupAdvisories([alert({ number: 1, ghsa: "" }), alert({ number: 2, ghsa: "" })], []);
    expect(g).toHaveLength(2);
  });

  it("caps the card without touching the order the overlay shows", () => {
    const many = Array.from({ length: 9 }, (_, i) => alert({ ghsa: `G-${i}` }));
    expect(cardAdvisories(groupAdvisories(many, []))).toHaveLength(4);
  });
});

describe("the bots' pull requests", () => {
  it("reads one word out of a check rollup", () => {
    expect(checkState(pr())).toBe("passing");
    expect(checkState(pr({ checks: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 } }))).toBe("failing");
    // Failing beats pending: a run still going does not soften one that already failed.
    expect(checkState(pr({ checks: { total: 3, passed: 1, failed: 1, pending: 1, skipped: 0 } }))).toBe("failing");
    expect(checkState(pr({ checks: { total: 1, passed: 0, failed: 0, pending: 1, skipped: 0 } }))).toBe("pending");
    expect(checkState(pr({ checks: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 } }))).toBe("none");
  });

  it("names what is in the way, and calls nothing ready on no evidence", () => {
    expect(prBlockers(pr())).toEqual([]);
    expect(prReady(pr())).toBe(true);
    expect(prBlockers(pr({ mergeable: "CONFLICTING" }))[0]).toContain("conflicts");
    expect(prBlockers(pr({ draft: true }))[0]).toBe("draft");
    expect(prBlockers(pr({ mergeState: "BLOCKED" }))[0]).toContain("branch rule");
    // Nothing blocking, but nothing ran either — that is not evidence it is safe.
    expect(prReady(pr({ checks: { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 } }))).toBe(false);
  });

  it("reads the package out of a bot's branch name and its title", () => {
    expect(prPackages(pr())).toContain("vitest");
    expect(prPackages(pr({ branch: "renovate/vitest-4.x", title: "Update dependency vitest to v4" })))
      .toContain("vitest");
    // A grouped PR names no single package, and must not claim one.
    expect(prPackages(pr({ branch: "renovate/all-minor-patch", title: "Update all non-major dependencies" })))
      .not.toContain("all");
  });

  it("finds the PR that already covers an advisory, so nobody dispatches at solved work", () => {
    const adv = groupAdvisories([alert()], [])[0];
    expect(prFor(adv, [pr()])?.number).toBe(7);
    expect(prFor(adv, [pr({ branch: "dependabot/npm_and_yarn/lodash-4.17.21", title: "Bump lodash" })])).toBeNull();
  });

  it("finds Renovate's dashboard issue and nothing pretending to be it", () => {
    const t = (o: Partial<GhThread>): GhThread => ({
      number: 1, kind: "issue", title: "Dependency Dashboard", url: "u", assignees: [], labels: [],
      branch: null, author: "renovate[bot]", draft: false, updated_at: "", ...o,
    });
    expect(renovateDashboard([t({})])?.number).toBe(1);
    expect(renovateDashboard([t({ author: "a-person" })])).toBeNull();
    expect(renovateDashboard([t({ kind: "pr" })])).toBeNull();
  });
});

describe("what is merely out of date", () => {
  const run = (rows: OutdatedRun["rows"]): OutdatedRun => ({ tool: "pnpm", ok: true, reason: null, rows });
  const row = (o: Partial<OutdatedRun["rows"][0]>) =>
    ({ pkg: "a", current: "1.0.0", wanted: "1.0.0", latest: "2.0.0", kind: "dependencies", deprecated: false, ...o });

  it("returns nothing at all for a run that failed, rather than an empty success", () => {
    expect(outRows(null, [])).toEqual([]);
    expect(outRows({ tool: "pnpm", ok: false, reason: "no answer", rows: [row({})] }, [])).toEqual([]);
  });

  it("puts what the declared range already allows first, and ships before dev", () => {
    const out = outRows(run([
      row({ pkg: "dev-thing", kind: "devDependencies" }),
      row({ pkg: "safe", wanted: "1.4.0", latest: "2.0.0" }),
      row({ pkg: "ship" }),
    ]), []);
    expect(out.map((r) => r.pkg)).toEqual(["safe", "ship", "dev-thing"]);
    expect(out[0].safe).toBe(true);
    expect(out[0].bump).toBe("major");
    expect(out[2].dev).toBe(true);
  });
});

describe("the tally the card reads", () => {
  it("counts advisories rather than alerts, and calls nothing openable silent", () => {
    const adv = groupAdvisories([
      alert({ ghsa: "G-1", severity: "critical" }),
      alert({ ghsa: "G-1", pkg: "other", severity: "critical" }),
      alert({ ghsa: "G-2", severity: "high" }),
    ], []);
    const t = depTally(adv, [pr()], []);
    expect(t.vulns).toBe(2);
    expect(t.critical).toBe(1);
    expect(t.ready).toBe(1);
    expect(depSilent(t, [])).toBe(false);
  });

  it("is silent only when there is nothing to show AND nothing that could be asked", () => {
    const empty = depTally([], [], []);
    expect(depSilent(empty, [])).toBe(true);
    // A runnable package manager is something to offer, so the card stays.
    expect(depSilent(empty, [{ id: "pnpm", label: "pnpm outdated", cmd: "c", blocked: null }])).toBe(false);
    // A blocked one is not: it could not answer anything either.
    expect(depSilent(empty, [{ id: "pnpm", label: "pnpm outdated", cmd: "c", blocked: "not on PATH" }])).toBe(true);
  });
});

describe("the brief the agent is sent", () => {
  const ctx = {
    project: "episko", slug: "respeak-io/episko",
    manifests: [npmManifest({ vitest: "^4.1.0" }, ["vitest"])],
    verify: ["pnpm test", "cargo clippy --all-targets"],
  };

  it("names the declared range, the patched version and the verdict", () => {
    const adv = groupAdvisories([alert({ cve: "CVE-2026-84373" })], ctx.manifests);
    const b = advisoryBrief(adv, ctx);
    expect(b).toContain("GHSA-a");
    expect(b).toContain("CVE-2026-84373");
    expect(b).toContain('declared "^4.1.0" in package.json');
    expect(b).toContain("first patched 4.1.11");
    expect(b).toContain("verdict: lockfile bump");
  });

  it("tells the agent to read the notes and to run THIS project's checks", () => {
    const b = advisoryBrief(groupAdvisories([alert()], ctx.manifests), ctx);
    expect(b).toContain("release notes");
    expect(b).toContain("pnpm test");
    expect(b).toContain("cargo clippy --all-targets");
    expect(b).toMatch(/push nothing|Commit nothing/);
  });

  it("says how it was verified when the project declares no checks at all", () => {
    const b = advisoryBrief(groupAdvisories([alert()], ctx.manifests), { ...ctx, verify: [] });
    expect(b).toContain("no test or check task");
    expect(b).not.toContain("pnpm test");
  });

  it("says out loud when nothing declares the package", () => {
    const adv = groupAdvisories([alert({ pkg: "@vitest/mocker", relationship: "transitive" })], ctx.manifests);
    expect(advisoryBrief(adv, ctx)).toContain("not declared directly");
  });

  it("writes an out-of-date brief and a pull-request brief that carry their own facts", () => {
    const out = outRows({ tool: "pnpm", ok: true, reason: null, rows: [
      { pkg: "vitest", current: "4.1.0", wanted: "4.1.11", latest: "5.0.0", kind: "devDependencies", deprecated: true },
    ] }, ctx.manifests);
    const b = outdatedBrief(out, ctx);
    expect(b).toContain("vitest 4.1.0 → 5.0.0");
    expect(b).toContain("in-range: 4.1.11");
    expect(b).toContain("DEPRECATED");
    expect(b).toContain("major");

    const p = prBrief(pr({ checks: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 } }), ctx);
    expect(p).toContain("dependabot PR #7");
    expect(p).toContain("1 check failing");
    expect(p).toContain("pnpm test");
  });
});

describe("the checks a brief names", () => {
  const task = (cmd: string, group: string | null, blocked: string | null = null) => ({ cmd, group, blocked });

  it("takes test before check before build, and never one that cannot run", () => {
    const got = verifyCommands([
      task("pnpm build", "build"), task("pnpm exec tsc --noEmit", "check"),
      task("pnpm test", "test"), task("pnpm broken", "test", "npm is not on PATH"),
      task("pnpm dev", "run"),
    ]);
    expect(got).toEqual(["pnpm test", "pnpm exec tsc --noEmit", "pnpm build"]);
  });

  it("names a command once and caps the list", () => {
    const dupes = Array.from({ length: 8 }, (_, i) => task(`c${i % 2}`, "test"));
    expect(verifyCommands(dupes)).toEqual(["c0", "c1"]);
  });
});
