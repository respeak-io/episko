import { describe, expect, it } from "vitest";
import { briefFor, type MaintBriefCtx } from "../src/maintbrief";
import { FACT_FACET, MAINT_DEFAULTS, findings, type Facts, type MaintInput, type SourceReport } from "../src/maint";

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
});
