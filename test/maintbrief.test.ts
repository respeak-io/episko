import { describe, expect, it } from "vitest";
import { FIX, branchNote, briefFor, sessionBrief, sweepBrief, sweepPrompt, sweepSessionBrief, type MaintBriefCtx } from "../src/maintbrief";
import {
  FACT_FACET, MAINT_DEFAULTS, VERB_KIND, findings, sessionKind, sweepLine, sweepVerdict, type Deployed, type Facts, type Finding, type MaintInput, type PkgLatest, type RerunJob, type SourceReport, type SweepAdvisory, type SweepFacts, type Verb,
} from "../src/maint";
import { typable } from "../src/format";

// The brief is the product: an agent is only as good as what it was told, and a person reads it
// in the composer before sending. It is built from facts, so it never names who reported them.

const NOW = 1_790_000_000_000, S = NOW / 1000, D = 86_400;
const ok = (source: string, facts: Facts): SourceReport => ({
  source, facet: FACT_FACET[facts.kind], cost: "forge", coverage: { state: "ok" }, at: S, truncated: false, gaps: [], facts,
});
const input = (...reps: SourceReport[]): MaintInput => ({
  det: {
    repoRoot: "/r", forge: { kind: "unknown", host: null, path: null, by: "none" }, sources: reps.map((r) => r.source), markers: [],
    config: { readable: true, forge: null, off: [], sources: {}, bots: [], trunk: null, tagPattern: null, sarif: [], params: {}, thresholds: {} },
    deploy: null,
  },
  reports: Object.fromEntries(reps.map((r) => [r.source, r])),
});
const ctx: MaintBriefCtx = { project: "acme", verify: ["pnpm test"], now: NOW };
const advisory = { aliases: ["CVE-2026-0001"], ecosystem: "npm", rawSeverity: "HIGH", url: "https://adv.example/GHSA-1", location: "package-lock.json" };

const inp = input(
  ok("dependabot-alerts", { kind: "advisories", items: [
    { id: "GHSA-1", kind: "dependency", pkg: "lodash", version: "4.17.20", severity: "high", summary: "Prototype pollution", fixed: null, tool: "dependabot", ...advisory },
    { id: "K-1", aliases: [], kind: "secret", pkg: null, ecosystem: null, version: null, severity: "high", rawSeverity: "", summary: "API test key committed", fixed: null, location: "scripts/seed.ts", url: "https://adv.example/K-1", tool: "github" },
  ] }),
  ok("osv", { kind: "advisories", items: [
    { id: "VULN-1", kind: "dependency", pkg: "lodash", version: "4.17.20", severity: "medium", summary: "", fixed: "4.17.21", tool: "osv", ...advisory, url: null },
  ] }),
  ok("github-actions", { kind: "ciRuns", branch: "main", runs: [
    { workflow: "e2e", status: "fail", raw: "failure", sha: "4f2a91c0ffee", at: S - 2 * D, url: "https://ci.example/runs/9" },
  ] }),
  ok("bot-src", { kind: "updatePrs", bot: "renovate", configured: true, dashboard: null, prs: [
    { number: 42, title: "Update serde", url: "https://forge.example/pr/42", branch: "u/serde", draft: false, at: S - D, checks: "fail" },
  ] }),
  ok("tags", { kind: "release", trunk: "origin/main", tag: "v1.2.0", tagAt: S - 40 * D, since: 31, oldestUnreleasedAt: S - 41 * D, tagsSeen: 9, fetchedAt: S }),
  ok("git", { kind: "hygiene", trunk: "origin/main", unpushed: 9, localOnly: ["feat/map"], merged: ["old"], gone: ["dead"], branches: [], worktrees: [], fetchedAt: S }),
  ok("probe", { kind: "probes", items: [
    { name: "api", url: "https://api.example/health", code: 502, ms: null, certNotAfter: null, err: null },
    { name: "app", url: "https://app.example", code: 200, ms: 90, certNotAfter: S + 6 * D, err: null },
  ] }),
);
const fs = findings("/r", inp, MAINT_DEFAULTS, NOW);
const by = (key: string) => fs.find((f) => f.key === key)!;
const brief = (key: string) => briefFor(by(key), inp, ctx)!;

describe("deploying: a plan and a diagnosis, never a deploy", () => {
  const env = (o: Partial<Deployed> = {}): Deployed => ({
    env: "prod", tier: "production", sha: "a".repeat(40), tag: "v1.0", branch: "main", at: S - 3 * D, url: null, last: null,
    behind: 23, behindAt: S - 9 * D, ahead: 0, ...o,
  });
  const envsIn = (...envs: Deployed[]) => input(ok("gd", { kind: "deployments", trunk: "origin/main", envs, fetchedAt: S }));
  const line = (i: MaintInput, key: string) => findings("/r", i, MAINT_DEFAULTS, NOW).find((f) => f.key === key)!;
  const a = "a".repeat(40), b = "b".repeat(40);
  const fail = { state: "fail" as const, raw: "FAILURE", sha: b, at: S - 2 * 3600, url: "https://ci.example/run/9" };

  it("plans one environment from its facts and forbids shipping it", () => {
    const i = envsIn(env()), text = briefFor(line(i, "release:deploy"), i, ctx)!;
    expect(text).toContain("prod in acme is 23 commits behind origin/main.");
    expect(text).toContain(`live: v1.0 (aaaaaaa) live for 3d from main`);
    expect(text).toContain(`\`git log ${a}..origin/main\``);
    expect(text).toContain("the oldest 9d old");
    expect(text).toMatch(/migrations, config, infrastructure, removed endpoints/);
    expect(text).toMatch(/whether CI on the trunk is green/);
    expect(text.trim().endsWith("Do not deploy, tag, push or trigger any workflow: a person ships it.")).toBe(true);
    expect(text).not.toContain("###");
  });

  it("says commits live that the trunk lacks must land first", () => {
    const i = envsIn(env({ ahead: 3 })), text = briefFor(line(i, "release:deploy"), i, ctx)!;
    expect(text).toContain("prod in acme runs 3 commits not on origin/main.");
    expect(text).toContain(`\`git log origin/main..${a}\``);
    expect(text).toContain("Get them onto the trunk first.");
    expect(text).toContain(`\`git log ${a}..origin/main\``);
  });

  it("gives several environments a heading each, and leaves out what is not production", () => {
    const i = envsIn(env(), env({ env: "eu-prod", behind: 2, behindAt: S - D }), env({ env: "staging", tier: "staging" }));
    const text = briefFor(line(i, "release:deploy"), i, ctx)!;
    expect(text).toContain("Plan the next deploy of 2 environments in acme.");
    expect(text).toContain("### prod is 23 commits behind origin/main");
    expect(text).toContain("### eu-prod is 2 commits behind origin/main");
    expect(text).not.toContain("staging");
  });

  it("explains a failed deploy from its log and waits for a person", () => {
    const i = envsIn(env({ behind: 0, behindAt: null, last: fail })), text = briefFor(line(i, "release:deploy-failed"), i, ctx)!;
    expect(text).toContain("A deploy of prod failed in acme.");
    expect(text).toContain("https://ci.example/run/9");
    expect(text).toContain(`the failed attempt: ${b}, 2h ago`);
    expect(text).toContain("still live: v1.0 (aaaaaaa) live for 3d from main");
    expect(text).toContain(`\`git log ${a}..${b}\``);
    expect(text).toMatch(/wait for a person before re-running, redeploying or rolling back anything\.$/);
    expect(text).not.toMatch(/\bredeploy it\b/);
  });

  it("names nothing it cannot and covers staging's failure too", () => {
    const i = envsIn(env({ sha: null, tag: null, at: null, behind: null, behindAt: null, ahead: null, last: fail }), env({ env: "stg", tier: "staging", behind: 0, behindAt: null, last: fail }));
    const f = line(i, "release:deploy-failed");
    expect([f.text, f.level, f.ref]).toEqual(["2 deploys failed", "bad", null]);
    const text = briefFor(f, i, ctx)!;
    expect(text).toContain("### prod: failed 2h ago");
    expect(text).toContain("### stg: failed 2h ago");
    expect(text).toContain("still live: nothing found");
    expect(FIX.filter(([t]) => t({ key: "release:deploy-failed" })).length).toBe(1);
  });

  it("says a cut list may hold more, before the line that closes it", () => {
    const whole = envsIn(env({ last: fail }));
    const i = input({ ...ok("gd", { kind: "deployments", trunk: "origin/main", envs: [env({ last: fail })], fetchedAt: S }), truncated: true });
    for (const key of ["release:deploy", "release:deploy-failed"]) {
      expect(briefFor(line(i, key), i, ctx), key).toContain("This list hit a page cap, so more environments may exist than are named here");
      expect(briefFor(line(whole, key), whole, ctx), key).not.toContain("page cap");
    }
    expect(briefFor(line(i, "release:deploy"), i, ctx)!.trim().endsWith("a person ships it.")).toBe(true);
  });

  it("answers null once the facts are gone", () => {
    const i = envsIn(env({ last: fail }));
    const [plan, fix] = [line(i, "release:deploy"), line(i, "release:deploy-failed")];
    const gone = input(ok("gd", { kind: "deployments", trunk: "origin/main", envs: [], fetchedAt: S }));
    expect([briefFor(plan, gone, ctx), briefFor(fix, gone, ctx)]).toEqual([null, null]);
    const caught = envsIn(env({ behind: 0, behindAt: null }));
    expect(briefFor(plan, caught, ctx), "production caught up").toBeNull();
  });
});

describe("briefFor", () => {
  it("writes one for every finding an agent answers", () => {
    for (const f of fs) expect(briefFor(f, inp, ctx), f.key).toBeTruthy();
    expect(new Set(fs.map((f) => f.verb))).toEqual(new Set(["fix", "patch", "rotate", "review", "release", "push", "tidy"]));
  });

  it("carries the advisory's URL, package and fix, from whichever reporter knew it", () => {
    const b = brief("security:dependency");
    expect(b).toContain("https://adv.example/GHSA-1");
    expect(b).toContain("lodash 4.17.20 (npm) in package-lock.json; fixed in 4.17.21");
    expect(b).toContain("CVE-2026-0001");
    expect(b).toContain("pnpm test");
  });

  it("names no vendor, even when the facts came from one", () => {
    for (const f of fs) expect(briefFor(f, inp, ctx), f.key).not.toMatch(/dependabot|osv|github|renovate/i);
  });

  it("carries the evidence each verb needs", () => {
    expect(brief("ci")).toMatch(/e2e workflow, red for 2d[\s\S]*https:\/\/ci\.example\/runs\/9[\s\S]*4f2a91c0ffee/);
    expect(brief("security:secret")).toMatch(/API test key[\s\S]*scripts\/seed\.ts/);
    expect(brief("deps:renovate")).toContain("#42 Update serde · checks fail · https://forge.example/pr/42");
    expect(brief("release")).toContain("git log v1.2.0..origin/main");
    expect(brief("git:unpushed")).toMatch(/9 commits in acme[\s\S]*feat\/map[\s\S]*Never force-push/);
    expect(brief("git:tidy")).toMatch(/merged into origin\/main: old[\s\S]*upstream gone: dead[\s\S]*git branch -d/);
    expect(brief("prod:api")).toContain("api (https://api.example/health) in acme answered 502");
    expect(brief("prod:cert:app")).toContain("expires in 6d");
  });

  it("is prefilled, never sent: no line ending a person would not type", () => {
    for (const f of fs) {
      const b = briefFor(f, inp, ctx)!;
      expect(b.endsWith("\n"), f.key).toBe(false);
      expect(b).not.toContain("\r");
    }
  });

  it("answers null once the facts behind a finding are gone, and for verbs no agent answers", () => {
    const green = input(ok("github-actions", { kind: "ciRuns", branch: "main", runs: [
      { workflow: "e2e", status: "pass", raw: "success", sha: "4f2a91c0ffee", at: S - D, url: null },
    ] }));
    expect(briefFor(by("ci"), green, ctx)).toBeNull();
    expect(briefFor(by("release"), input(), ctx)).toBeNull();
    expect(briefFor({ ...by("release"), verb: "run" }, inp, ctx)).toBeNull();
    expect(briefFor({ ...by("release"), verb: "fetch" }, inp, ctx)).toBeNull();
    expect(briefFor({ ...by("prod:api"), verb: "setup" }, inp, ctx), "prod is set up by proposing [deploy]").toBeNull();
  });

  it("finds Fix's brief by the finding's key, one exact row per kind", () => {
    const claims = (key: string) => FIX.filter(([test]) => test({ key })).length;
    for (const key of ["ci", "ci:flaky", "prod:api", "prod:cert:app", "prod:cert", "release:deploy-failed", "security:code", "security:config", "prod:host:disk", "prod:host:load"]) expect(claims(key), key).toBe(1);
    // Later prod sources key `prod:<kind>:…`, which no probe's name can spell.
    for (const key of ["prod:host:other", "prod:domain:acme.example", "prod:errors:new", "release:deploy", "security:dependency"]) {
      expect(claims(key), key).toBe(0);
    }
    expect(briefFor({ ...by("prod:api"), key: "prod:domain:acme.example" }, inp, ctx), "no row: no brief, never the probe's").toBeNull();
    expect(briefFor({ ...by("prod:api"), key: "prod:host:disk" }, inp, ctx), "a probe's facts are no host's").toBeNull();
  });

  it("sets up CI or an update bot from the facet alone, naming what is already in the tree", () => {
    const bare = input();
    bare.det!.forge.host = "git.example.org";
    bare.det!.markers = [{ facet: "ci", label: "Some CI", found: [".some-ci.yml"] }];
    const setup = (facet: "ci" | "deps") => briefFor({ ...by("release"), facet, verb: "setup", key: `${facet}:setup` }, bare, ctx)!;
    expect(setup("ci")).toMatch(/acme has no CI[\s\S]*git\.example\.org[\s\S]*\.some-ci\.yml[\s\S]*pnpm test/);
    expect(setup("deps")).toMatch(/no update bot[\s\S]*git\.example\.org/);
    expect(setup("deps")).not.toContain(".some-ci.yml");
  });

  // A code-scanning source switched off on its forge (`coverSetups`): a workflow, never a switch flipped.
  it("sets up code scanning as a workflow a person reviews and enables", () => {
    const bare = input();
    bare.det!.forge.host = "git.example.org";
    const text = briefFor({ ...by("release"), facet: "security", verb: "setup", key: "setup:x", ref: "sec.code" }, bare, ctx)!;
    expect(text).toMatch(/acme has code scanning switched off[\s\S]*git\.example\.org[\s\S]*every pull request/);
    expect(text).toContain("Do not push or enable anything on the remote");
    expect(text).not.toMatch(/GitHub|CodeQL/);
    expect(briefFor({ ...by("release"), facet: "security", verb: "setup", key: "setup:x", ref: null }, bare, ctx), "only code scanning").toBeNull();
  });

  it("asks for a scanner's findings in code to be judged where they are, every place named", () => {
    const code = (location: string) => ({ id: "js/sql-injection", aliases: [], kind: "code" as const, pkg: null, ecosystem: null,
      version: null, severity: "high" as const, rawSeverity: "8.8", summary: "Query built from user input", fixed: null, location, url: null, tool: "t" });
    const two = input(ok("a", { kind: "advisories", items: [code("src/db.js:42"), code("src/q.js:7")] }), ok("b", { kind: "advisories", items: [code("src/db.js:42")] }));
    const f = findings("/r", two, MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.verb, x.text, x.detail])).toEqual([
      ["security:code", "fix", "2 code findings", "2 high · src/db.js:42, src/q.js:7"],
    ]);
    const b = briefFor(f[0], two, ctx)!;
    expect(b).toMatch(/2 findings in acme[\s\S]*### js\/sql-injection, high[\s\S]*at src\/db\.js:42[\s\S]*at src\/q\.js:7[\s\S]*false positive[\s\S]*pnpm test/);
    const one = input(ok("b", { kind: "advisories", items: [code("src/db.js:42")] }));
    const b1 = briefFor(findings("/r", one, MAINT_DEFAULTS, NOW)[0], one, ctx)!;
    expect(b1).toMatch(/a finding in acme: js\/sql-injection, high\.[\s\S]*at src\/db\.js:42/);
    expect(b1).not.toContain("###");
  });

  it("covers every advisory behind a folded line, each with its own package, fix and link", () => {
    const dep = (id: string, severity: "high" | "medium", pkg: string, version: string, fixed: string | null) => ({
      id, aliases: [], kind: "dependency" as const, pkg, ecosystem: "npm", version, severity, rawSeverity: severity,
      summary: `${pkg} is unsafe`, fixed, location: "pnpm-lock.yaml", url: `https://adv.example/${id}`, tool: "dependabot",
    });
    const four = input(ok("dependabot-alerts", { kind: "advisories", items: [
      dep("GHSA-a", "high", "source-map-js", "1.2.0", "1.2.2"), dep("GHSA-b", "medium", "@vitest/mocker", "4.1.0", "4.1.12"),
      dep("GHSA-c", "medium", "postcss", "8.5.1", "8.5.23"), dep("GHSA-d", "medium", "vitest", "4.1.0", null),
    ] }));
    const f = findings("/r", four, MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.text])).toEqual([["security:dependency", "4 advisories"]]);
    const b = briefFor(f[0], four, ctx)!;
    expect(b).toMatch(/^Patch 4 advisories in acme, worst first/);
    expect(b.indexOf("### GHSA-a · high"), "worst first").toBeLessThan(b.indexOf("### GHSA-b · medium"));
    for (const [id, line] of [["GHSA-a", "source-map-js 1.2.0 (npm) in pnpm-lock.yaml; fixed in 1.2.2"],
      ["GHSA-b", "@vitest/mocker 4.1.0 (npm) in pnpm-lock.yaml; fixed in 4.1.12"],
      ["GHSA-c", "postcss 8.5.1 (npm) in pnpm-lock.yaml; fixed in 8.5.23"],
      ["GHSA-d", "vitest 4.1.0 (npm) in pnpm-lock.yaml; no fixed version published"]]) {
      expect(b).toContain(`https://adv.example/${id}`);
      expect(b).toContain(line);
    }
    expect(b).not.toMatch(/dependabot|osv|github|renovate/i);
    expect(b.endsWith("\n")).toBe(false);
  });

  it("briefs noisy CI apart from broken CI: each job, its step, each log, and never a retry", () => {
    const seen = (sha: string, at: number, passed: boolean) => ({ sha, branch: "feature/x", at, passed, url: `https://ci.example/job/${sha}` });
    const win: RerunJob = { workflow: "ci", job: "build-check (windows-latest)", reruns: 3, passed: 2, steps: ["Cargo test"],
      seen: [seen("aaaa1111bbbb", S - D, true), seen("cccc2222dddd", S - 3 * D, false), seen("eeee3333ffff", S - 9 * D, true)] };
    const green = ok("github-actions", { kind: "ciRuns", branch: "main", runs: [
      { workflow: "ci", status: "pass", raw: "success", sha: "4f2a91c0ffee", at: S - D, url: null }] });
    const noisy = (...jobs: RerunJob[]) => input(green, ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: null, runs: 140, reran: 3, jobs }));
    const one = noisy(win);
    const f = findings("/r", one, MAINT_DEFAULTS, NOW).find((x) => x.key === "ci:flaky")!;
    const b = briefFor(f, one, ctx)!;
    expect(b).toMatch(/^CI in acme is noisy: the build-check \(windows-latest\) job failed and then passed when the same commit was run again, 2 of 3 times in the last 30 days\./);
    expect(b).toContain("- fails at: Cargo test");
    expect(b).toContain("- aaaa111 on feature/x, 1d ago: https://ci.example/job/aaaa1111bbbb");
    expect(b).toContain("- cccc222 on feature/x, 3d ago, and failed again: https://ci.example/job/cccc2222dddd");
    expect(b).toContain("the logs at the links name the test");
    expect(b).toContain("Do not add a retry");
    expect(b).toContain("pnpm test");
    expect(b).not.toMatch(/github|actions|\bgh\b/i);
    expect(b.endsWith("\n")).toBe(false);
    // Several jobs each get a heading; a broken branch keeps its own brief; no noise, no brief.
    const two = noisy(win, { ...win, workflow: "nightly", job: "e2e", reruns: 2 });
    const g = findings("/r", two, MAINT_DEFAULTS, NOW).find((x) => x.key === "ci:flaky")!;
    expect(briefFor(g, two, ctx)).toMatch(/2 jobs failed[\s\S]*### build-check \(windows-latest\) \(ci\): passed on re-run 2 of 3[\s\S]*### e2e \(nightly\): passed on re-run 2 of 2/);
    expect(briefFor(f, input(green), ctx), "null once the facts are gone").toBeNull();
    expect(briefFor(f, noisy({ ...win, passed: 1 }), ctx), "below the threshold is no Fix").toBeNull();
    expect(brief("ci")).toMatch(/^CI is failing on main/);
    const cut = input(green, ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: S - 9 * D, runs: 500, reran: 3, jobs: [win] }));
    expect(briefFor(f, cut, ctx)).toContain("A busy project's window was shorter");
    const part = input(green, { ...ok("github-actions-reruns", { kind: "ciReruns", days: 30, since: null, runs: 500, reran: 3, jobs: [win] }), truncated: true });
    expect(briefFor(f, part, ctx)).toContain("Part of this read failed or hit a cap, so these counts are floors.");
    expect(briefFor(f, part, ctx), "a failed read is no busy project").not.toContain("busy");
  });

  it("names every red workflow behind the one CI line, oldest first", () => {
    const run = (workflow: string, at: number, sha: string) => ({ workflow, status: "fail" as const, raw: "failure", sha, at, url: `https://ci.example/${workflow}` });
    const red = input(ok("github-actions", { kind: "ciRuns", branch: "main", runs: [run("lint", S - D, "bbbb"), run("e2e", S - 2 * D, "aaaa")] }));
    const f = findings("/r", red, MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.text])).toEqual([["ci", "2 workflows failing"]]);
    expect(briefFor(f[0], red, ctx)).toMatch(
      /2 workflows, oldest first[\s\S]*### e2e on main, red for 2d[\s\S]*ci\.example\/e2e[\s\S]*aaaa[\s\S]*### lint on main, red for 1d[\s\S]*bbbb/);
  });

  // The line counts only detected, unskipped sources, and the brief must name exactly what it counted.
  it("briefs only the advisories the line counted, and says when a capped list may hold more", () => {
    const dep = (id: string, pkg: string) => ({ id, aliases: [], kind: "dependency" as const, pkg, ecosystem: "npm", version: "1.0.0",
      severity: "high" as const, rawSeverity: "", summary: `${pkg} is unsafe`, fixed: "1.0.1", location: null, url: null, tool: "t" });
    const two = input(ok("a", { kind: "advisories", items: [dep("A-1", "left-pad")] }), ok("b", { kind: "advisories", items: [dep("B-1", "is-odd")] }));
    const one = (i: MaintInput) => briefFor(findings("/r", i, MAINT_DEFAULTS, NOW)[0], i, ctx)!;
    for (const i of [{ ...two, skip: ["b"] }, { ...two, det: { ...two.det!, sources: ["a"] } }]) {
      expect(one(i)).toMatch(/^Patch A-1 · high in acme\./);
      expect(one(i)).not.toMatch(/is-odd|###/);
    }
    expect(one(two)).not.toContain("page cap");
    const capped = { ...two, reports: { ...two.reports, b: { ...two.reports.b, truncated: true } } };
    expect(one(capped)).toMatch(/Patch 2 advisories[\s\S]*page cap, so more advisories may exist/);
  });

  it("rotates every secret behind a folded line", () => {
    const k = (id: string, location: string) => ({ id, aliases: [], kind: "secret" as const, pkg: null, ecosystem: null, version: null,
      severity: "unknown" as const, rawSeverity: "", summary: `${id} token`, fixed: null, location, url: null, tool: "t" });
    const two = input(ok("a", { kind: "advisories", items: [k("K-1", "seed.ts"), k("K-2", ".env")] }));
    const f = findings("/r", two, MAINT_DEFAULTS, NOW);
    expect(f.map((x) => [x.key, x.verb, x.text])).toEqual([["security:secret", "rotate", "2 secrets reported"]]);
    expect(briefFor(f[0], two, ctx)).toMatch(/2 secrets were reported in acme[\s\S]*### K-1: K-1 token[\s\S]*found in seed\.ts[\s\S]*### K-2[\s\S]*found in \.env[\s\S]*Treat each as leaked/);
  });

  it("never hands one package another package's fix", () => {
    const two = input(ok("a", { kind: "advisories", items: [
      { id: "V-1", kind: "dependency", pkg: "left", version: "1.0", severity: "high", summary: "x", fixed: "1.1", tool: "t", ...advisory },
      { id: "V-2", kind: "dependency", pkg: "right", version: "2.0", severity: "high", summary: "x", fixed: null, tool: "t", ...advisory },
    ] }));
    const f = findings("/r", two, MAINT_DEFAULTS, NOW)[0];
    const b = briefFor(f, two, ctx)!;
    expect(b).toContain("left 1.0 (npm) in package-lock.json; fixed in 1.1");
    expect(b).toContain("right 2.0 (npm) in package-lock.json; no fixed version published");
  });

  it("moves every runtime at or near its end in every file that declares it, and runs the checks", () => {
    const rt = (name: string, cycle: string, eol: number | boolean, file: string, declared = cycle) =>
      ({ product: name, name, declared, cycle, eol, latest: null, newest: "26", file, url: `https://eol.example/${name}` });
    const one = input(ok("runtime-eol", { kind: "runtimes", items: [
      rt("node", "18", 1_745_971_200, ".nvmrc"), rt("node", "18", 1_745_971_200, "Dockerfile", "18.20.1"), rt("go", "1.27", false, "go.mod"),
    ] }));
    const f = findings("/r", one, MAINT_DEFAULTS, NOW).find((x) => x.key === "security:runtime")!;
    const b = briefFor(f, one, ctx)!;
    expect(b).toContain("Upgrade node 18 in acme: it reached its end of life on 2025-04-30");
    expect(b).toContain("- .nvmrc declares 18\n- Dockerfile declares 18.20.1\n- the newest cycle is 26");
    expect(b).toContain("in every file that");
    expect(b).toContain("pnpm test");
    expect(b, "a supported runtime is not part of it").not.toContain("go 1.27");
    const two = input(ok("runtime-eol", { kind: "runtimes", items: [rt("node", "18", 1_745_971_200, ".nvmrc"), rt("postgres", "14", S + 20 * D, "compose.yml")] }));
    const g = findings("/r", two, MAINT_DEFAULTS, NOW).find((x) => x.key === "security:runtime")!;
    const b2 = briefFor(g, two, ctx)!;
    expect(b2).toContain("Upgrade 2 runtimes in acme");
    expect(b2).toContain("### node 18 · ended");
    expect(b2).toContain("### postgres 14 · ends in 20d\nIt reaches its end of life on");
    const fine = input(ok("runtime-eol", { kind: "runtimes", items: [rt("go", "1.27", false, "go.mod")] }));
    expect(briefFor(f, fine, ctx), "nothing left to upgrade").toBeNull();
  });

  it("brings every package a major or more behind to its newest major, the most first, naming what it could not compare", () => {
    const pkg = (name: string, installed: string[], latest: string | null, o: Partial<PkgLatest> = {}): PkgLatest =>
      ({ name, ecosystem: "npm", importers: ["."], installed, latest, dev: false, url: latest ? `https://reg.example/${name}` : null, why: null, ...o });
    const reg = (items: PkgLatest[], truncated = false) => ({ ...ok("npm-registry", { kind: "packages", items, current: 4 }), truncated });
    const items = [
      pkg("lodash", ["4.17.20"], "4.18.1"), pkg("react", ["18.2.0", "17.0.2"], "19.2.0", { importers: [".", "packages/app"] }),
      pkg("vitest", ["1.6.0"], "4.1.0", { dev: true }), pkg("left-pad", [], null, { why: "from git" }), pkg("tiny", ["0.9.0"], "2.1.0", { dev: null }),
    ];
    const pk = input(reg(items));
    const f = findings("/r", pk, MAINT_DEFAULTS, NOW).find((x) => x.key === "deps:packages")!;
    const cut = { ...pk, reports: { ...pk.reports, "npm-registry": { ...pk.reports["npm-registry"]!, gaps: ["yarn.lock not read"] } } };
    expect(briefFor(f, cut, ctx), "a lockfile nobody read is named").toContain("Not read: yarn.lock not read");
    expect([f.verb, f.facet, f.level, f.text]).toEqual(["upgrade", "deps", "info", "3 packages a major or more behind"]);
    const b = briefFor(f, pk, ctx)!;
    expect(b).toMatch(/^Bring 3 direct dependencies of acme to their newest major, the most majors behind first\. Each is a breaking upgrade/);
    expect(b).toContain([
      "- vitest 1.6.0 → 4.1.0 · 3 majors · development only · declared in . · https://reg.example/vitest",
      "- react 17.0.2 → 19.2.0 · 2 majors · shipped · declared in ., packages/app · https://reg.example/react",
      "- tiny 0.9.0 → 2.1.0 · 2+ majors (a floor: from 0.x) · declared in . · https://reg.example/tiny",
      "",
      "Not compared: left-pad (from git)",
    ].join("\n"));
    expect(b, "a minor behind is no breaking upgrade").not.toContain("lodash");
    expect(b).toContain("## Before you change anything");
    expect(b).toContain("pnpm test");
    expect(b).not.toContain("page cap");
    expect(b.endsWith("\n")).toBe(false);
    expect(briefFor(f, input(reg(items, true)), ctx)).toContain("page cap, so more packages may exist");
    expect(briefFor(f, input(reg(items.slice(0, 1))), ctx), "nothing a major behind").toBeNull();
    expect(briefFor({ ...f, facet: "security" }, pk, ctx), "Upgrade on a security line is the runtimes' brief").toBeNull();
  });
});

// A sweep's affected project is briefed as any Patch is, and the read-only agent is asked from the
// same facts; neither names who published the advisory.
describe("a host's brief", () => {
  const facts: Facts = { kind: "hosts", items: [{
    alias: "prod-1", os: "Linux", now: S, uptime: 41 * D, load: [1, 1, 12.4], cpus: 4,
    disks: [{ mount: "/", sizeKb: 50 * 1024 * 1024, usedKb: 48 * 1024 * 1024, availKb: 2 * 1024 * 1024 }],
    updates: 14, security: 6, packages: ["openssl", "libc6"], pm: "apt", listsAt: S - 12 * D, reboot: true, rebootWhy: ["linux-image-6.8.0-49-generic"],
    containers: [{ name: "acme-api-1", image: "x", state: "running", health: "unhealthy", restarts: 12, exit: 137, startedAt: S - D, project: "acme", service: "api" }],
    compose: ["worker"],
  }] };
  const hostInp = input({ ...ok("ssh-host", facts), at: S - 3 * 3600 });
  const line = (kind: string): Finding => findings("/r", hostInp, MAINT_DEFAULTS, NOW).find((f) => f.key === `prod:host:${kind}`)!;
  const brief = (kind: string) => briefFor(line(kind), hostInp, ctx)!;

  it("names the alias, the project and how old the reading is", () => {
    expect(brief("disk").split("\n")[0]).toBe("prod-1 ([deploy] host of acme) needs attention, as Episko read it 3h ago:");
  });

  it("lists every problem with its numbers, the clicked one first", () => {
    const b = brief("disk");
    expect(b).toContain("- / is 96% full: 2.0 GB free of 50.0 GB");
    expect(b).toContain("- 14 updates pending, 6 of them security: openssl, libc6");
    expect(b).toContain("- its package lists are 12d old");
    expect(b).toContain("- it needs a reboot: linux-image-6.8.0-49-generic");
    expect(b).toContain("- acme-api-1 (service api): running, unhealthy, restarted 12 times, last exit 137");
    expect(b).toContain("- service worker has no running container, and none exists");
    expect(b).toContain("- its 15-minute load is 12.4 on 4 CPUs, 3.1 per CPU");
    const bullets = (k: string) => brief(k).split("\n").filter((l) => l.startsWith("- "));
    expect(bullets("disk")[0]).toContain("/ is 96%");
    expect(bullets("load")[0]).toContain("15-minute load");
    expect(bullets("reboot")[0]).toContain("needs a reboot");
  });

  it("sends the agent read-only over the person's ssh, and stops it before any write", () => {
    const b = brief("containers");
    expect(b).toContain("Connect with `ssh prod-1` and investigate read-only");
    expect(b).toContain("Say each read-only command before you run it on the");
    expect(b).toContain("stop for a person before anything that writes");
    expect(b).toContain("Change nothing on the host yourself");
    expect(b).toContain("before deleting, upgrading, restarting or rebooting anything");
    expect(b.endsWith("\n"), "never ends in a newline: nothing could press Enter").toBe(false);
  });

  it("answers null once the facts are gone or the host is fine", () => {
    const f = line("disk");
    expect(briefFor(f, input(), ctx)).toBeNull();
    const fine: Facts = { kind: "hosts", items: [{ ...(facts as Extract<Facts, { kind: "hosts" }>).items[0], disks: [{ mount: "/", sizeKb: 100, usedKb: 10, availKb: 90 }], updates: 0, security: 0, packages: [], listsAt: S, reboot: false, rebootWhy: [], load: [0, 0, 0], containers: [], compose: [] }] };
    expect(briefFor(f, input(ok("ssh-host", fine)), ctx)).toBeNull();
    expect(briefFor({ ...f, ref: "other" }, hostInp, ctx), "another host's line").toBeNull();
  });
});

describe("the advisory sweep's briefs", () => {
  const adv: SweepAdvisory = {
    id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"], summary: "Command Injection in lodash", severity: "high", rawSeverity: "HIGH",
    url: "https://adv.example/GHSA-35jh-r3h4-6jhm", asked: [], gaps: [],
    packages: [{ ecosystem: "npm", name: "lodash", spans: [{ kind: "SEMVER", introduced: "0", fixed: "4.17.21", lastAffected: null }], versions: [], versionsCut: false, range: null }],
  };
  const facts = (o: Partial<SweepFacts>): SweepFacts => ({ root: "/r", locks: ["package-lock.json"], found: [], unpinned: [], unread: [], ...o });

  it("patches each copy inside the range, with the fix, the compatibility rules and the checks", () => {
    const f = facts({ found: [{ pkg: 0, version: "4.17.20", file: "package-lock.json" }, { pkg: 0, version: "4.17.21", file: "web/pnpm-lock.yaml" }] });
    const b = sweepBrief(adv, f, ctx)!;
    expect(b).toContain("Patch GHSA-35jh-r3h4-6jhm (CVE-2021-23337) · high in acme.");
    expect(b).toContain("- lodash 4.17.20 (npm) in package-lock.json; fixed in 4.17.21");
    expect(b, "a patched copy is not part of it").not.toContain("web/pnpm-lock.yaml");
    expect(b).toContain("from the lockfiles alone");
    expect(b).toContain("## Before you change anything");
    expect(b).toContain("pnpm test");
    expect(sweepBrief(adv, facts({ found: [{ pkg: 0, version: "4.17.21", file: "package-lock.json" }] }), ctx), "nothing affected").toBeNull();
  });

  it("asks the agent one question with what could not be decided, and the block to answer in", () => {
    const f = facts({ unpinned: [{ pkg: 0, version: "github:me/lodash#fix", file: "package-lock.json" }] });
    const p = sweepPrompt(adv, sweepVerdict(adv, f), "gb-dashboard");
    expect(p).toContain("Is the project in this folder (gb-dashboard) affected by GHSA-35jh-r3h4-6jhm (CVE-2021-23337)?");
    expect(p).toContain("- npm lodash <4.17.21, fixed in 4.17.21");
    expect(p).toContain("- package-lock.json: lodash from github:me/lodash#fix, not the registry's copy, so its version proves nothing");
    expect(p).toContain("```toml\nverdict = ");
    expect(p).toContain("nothing you answer is applied");
  });
});

describe("a session's briefs", () => {
  const wt = { kind: "wt" as const, path: "/wt/maint-ci" };
  const fresh = { kind: "new" as const, branch: "maint/ci", base: "origin/main" };
  const old = { kind: "old" as const, branch: "maint/ci", base: "origin/main" };
  // The later kinds' lines: a job flaky on re-runs, and a production both behind and failing.
  const later = input(
    ok("reruns", { kind: "ciReruns", days: 30, since: null, runs: 9, reran: 1, jobs: [{ workflow: "ci", job: "e2e", reruns: 2, passed: 2, steps: ["Cargo test"], seen: [] }] }),
    ok("gd", { kind: "deployments", trunk: "origin/main", fetchedAt: S, envs: [{ env: "prod", tier: "production", sha: "a".repeat(40), tag: "v1.0", branch: "main", at: S - 3 * D, url: null,
      behind: 23, behindAt: S - 9 * D, ahead: 0, last: { state: "fail", raw: "FAILURE", sha: "b".repeat(40), at: S - 7200, url: "https://ci.example/run/9" } }] }),
  );
  const lineIn = (i: MaintInput, key: string) => findings("/r", i, MAINT_DEFAULTS, NOW).find((f) => f.key === key)!;

  it("has a brief for every verb a session can pick", () => {
    const bare = input();
    const rt = input(ok("eol", { kind: "runtimes", items: [
      { product: "nodejs", name: "node", declared: "18", cycle: "18", eol: S - 30 * D, latest: "18.20", newest: "24", file: ".nvmrc", url: null },
    ] }));
    const sample: Partial<Record<Verb, [Finding, MaintInput]>> = {
      fix: [by("ci"), inp], patch: [by("security:dependency"), inp], rotate: [by("security:secret"), inp],
      release: [by("release"), inp], push: [by("git:unpushed"), inp], tidy: [by("git:tidy"), inp],
      deploy: [lineIn(later, "release:deploy"), later],
      setup: [{ ...by("release"), facet: "ci", verb: "setup", key: "ci:setup" }, bare],
      upgrade: [{ ...by("release"), facet: "security", verb: "upgrade", key: "security:runtime" }, rt],
    };
    const pickable = Object.entries(VERB_KIND).filter(([, k]) => k !== null).map(([v]) => v as Verb);
    expect(Object.keys(sample).sort()).toEqual([...pickable].sort());
    for (const v of pickable) {
      const [f, from] = sample[v]!;
      expect(f.verb, v).toBe(v);
      expect(briefFor(f, from, { ...ctx, now: NOW }), v).toBeTruthy();
    }
  });

  it("ends a new checkout's brief on where it stands: the branch, the base, install first, no push", () => {
    const b = sessionBrief(by("ci"), inp, ctx, fresh)!;
    expect(b.startsWith(briefFor(by("ci"), inp, ctx)!)).toBe(true);
    const note = b.slice(briefFor(by("ci"), inp, ctx)!.length);
    expect(note).toContain("a new checkout on maint/ci, cut from origin/main for this work alone");
    expect(note).toMatch(/Install the project's dependencies before running the checks/);
    expect(note).toMatch(/Pushing and opening a pull request are a person's call: do neither/);
  });

  it("leaves Plan deploy in the folder with its last word intact: no note may follow *a person ships it*", () => {
    const f = lineIn(later, "release:deploy");
    expect(VERB_KIND[f.verb]).toBe("here");
    const b = sessionBrief(f, later, ctx, { kind: "here" })!;
    expect(b).toBe(briefFor(f, later, ctx));
    expect(b.trim().endsWith("Do not deploy, tag, push or trigger any workflow: a person ships it.")).toBe(true);
  });

  it("sends a flaky job's Fix to its own branch, on its own brief", () => {
    const f = lineIn(later, "ci:flaky"), branch = "maint/ci-flaky";
    expect(sessionKind(f)).toBe("branch");
    const alone = briefFor(f, later, ctx)!, b = sessionBrief(f, later, ctx, { kind: "new", branch, base: "origin/main" })!;
    expect(b.startsWith(alone)).toBe(true);
    expect(b.slice(alone.length)).toContain(`a new checkout on ${branch}, cut from origin/main`);
  });

  // A brief that forbids any change has nothing to commit, and "Commit your work here" must not follow it.
  it("runs a Fix in the folder exactly when its brief changes nothing", () => {
    const hostFacts: Facts = { kind: "hosts", items: [{ alias: "prod-1", os: "Linux", now: S, uptime: D, load: [1, 1, 1], cpus: 4, disks: [{ mount: "/", sizeKb: 100, usedKb: 96, availKb: 4 }],
      updates: 0, security: 0, packages: [], pm: "apt", listsAt: S, reboot: true, rebootWhy: [], containers: [], compose: [] }] };
    const hosted = input(ok("ssh-host", hostFacts));
    const lines = [...[inp, later, hosted].flatMap((i) => findings("/r", i, MAINT_DEFAULTS, NOW).filter((f) => f.verb === "fix").map((f) => [f, i] as const))];
    expect(lines.map(([f]) => f.key)).toEqual(expect.arrayContaining(["ci", "ci:flaky", "prod:api", "prod:cert:app", "release:deploy-failed", "prod:host:disk", "prod:host:reboot"]));
    for (const [f, i] of lines) {
      const brief = briefFor(f, i, ctx)!;
      expect(sessionKind(f) === "here", f.key).toBe(/Change nothing/.test(brief));
      if (sessionKind(f) === "here") expect(sessionBrief(f, i, ctx, { kind: "here" }), f.key).toBe(brief);
    }
  });

  it("sends a package line to its own branch, on the packages brief", () => {
    const pk = input(ok("npm-registry", { kind: "packages", current: 0, items: [
      { name: "react", ecosystem: "npm", importers: ["."], installed: ["17.0.2"], latest: "19.2.0", dev: false, url: null, why: null },
    ] }));
    const f = lineIn(pk, "deps:packages"), branch = "maint/deps-packages";
    expect(VERB_KIND[f.verb]).toBe("branch");
    const alone = briefFor(f, pk, ctx)!, b = sessionBrief(f, pk, ctx, { kind: "new", branch, base: "origin/main" })!;
    expect(alone).toMatch(/^Bring 1 direct dependenc/);
    expect(b.startsWith(alone)).toBe(true);
    expect(b.slice(alone.length)).toContain(`a new checkout on ${branch}, cut from origin/main`);
  });

  it("tells an existing checkout to read what is already there first", () => {
    const b = sessionBrief(by("ci"), inp, ctx, wt)!;
    expect(b).toContain("an existing checkout on maint/ci, which may hold earlier work: read `git log origin/main..HEAD` first");
    expect(b).toContain("bring in what `git log HEAD..origin/main` shows it has fallen behind");
    expect(b).toMatch(/do neither\.$/);
    const bare = branchNote(wt, null, "maint/ci").join(" ");
    expect(bare).toContain("`git log --oneline -20`");
    expect(bare).not.toContain("HEAD..");
  });

  it("tells a fresh checkout of an earlier branch what it really stands on, never that it was cut from the trunk", () => {
    const b = sessionBrief(by("ci"), inp, ctx, old)!;
    expect(b).toContain("a new checkout of the existing branch maint/ci, which may hold earlier work");
    expect(b).toContain("`git log origin/main..HEAD`");
    expect(b).toContain("`git log HEAD..origin/main`");
    expect(b).not.toContain("cut from");
    expect(b).not.toContain("for this work alone");
    expect(b).toMatch(/Install the project's dependencies/);
    expect(b).toMatch(/do neither\.$/);
  });

  it("leaves a row in the project's folder as it was", () => {
    for (const key of ["release", "git:tidy", "git:unpushed"]) {
      expect(sessionBrief(by(key), inp, ctx, { kind: "here" })).toBe(briefFor(by(key), inp, ctx));
    }
  });

  it("names a base it does not have in words", () => {
    expect(branchNote({ kind: "new", branch: "maint/ci", base: "" }, null, "maint/ci").join(" ")).toContain("cut from what this project had checked out");
  });

  it("answers null once the facts are gone, rather than a note with no brief", () => {
    expect(sessionBrief(by("release"), input(), ctx, fresh)).toBeNull();
  });

  it("adds no control character: its lines are joined, and only the join's breaks reach typable", () => {
    for (const w of [fresh, wt, old]) expect(branchNote(w, "origin/main", "maint/ci").join("")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const b = sessionBrief(by("ci"), inp, ctx, fresh)!;
    expect(b).not.toContain("\r");
    expect(typable(b)).toContain("do neither.");
  });

  it("notes a sweep's row the same way, on the advisory's branch", () => {
    const adv: SweepAdvisory = {
      id: "CVE-2021-23337", aliases: [], summary: "Injection", severity: "high", rawSeverity: "HIGH", url: null, asked: [], gaps: [],
      packages: [{ name: "lodash", ecosystem: "npm", range: "<4.17.21", events: [], versions: [] } as unknown as SweepAdvisory["packages"][number]],
    };
    const facts: SweepFacts = { root: "/r", locks: ["package-lock.json"], found: [{ pkg: 0, version: "4.17.20", file: "package-lock.json" }], unpinned: [], unread: [] };
    const f = sweepLine(adv, "/r");
    const where = { kind: "new" as const, branch: "maint/cve-2021-23337", base: "origin/main" };
    const plain = sweepBrief(adv, facts, ctx);
    const noted = sweepSessionBrief(adv, facts, f, inp, ctx, where);
    if (plain === null) expect(noted).toBeNull();
    else expect(noted).toContain(`${plain}\n\nYou are in a new checkout on maint/cve-2021-23337`);
  });
});
