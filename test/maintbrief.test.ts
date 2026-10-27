import { describe, expect, it } from "vitest";
import { briefFor, type MaintBriefCtx } from "../src/maintbrief";
import { FACT_FACET, MAINT_DEFAULTS, findings, type Facts, type Finding, type MaintInput, type SourceReport } from "../src/maint";

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
    const b = brief("security:GHSA-1");
    expect(b).toContain("https://adv.example/GHSA-1");
    expect(b).toContain("lodash 4.17.20 (npm) in package-lock.json; fixed in 4.17.21");
    expect(b).toContain("CVE-2026-0001");
    expect(b).toContain("pnpm test");
  });

  it("names no vendor, even when the facts came from one", () => {
    for (const f of fs) expect(briefFor(f, inp, ctx), f.key).not.toMatch(/dependabot|osv|github|renovate/i);
  });

  it("carries the evidence each verb needs", () => {
    expect(brief("ci:e2e")).toMatch(/e2e workflow, red for 2d[\s\S]*https:\/\/ci\.example\/runs\/9[\s\S]*4f2a91c0ffee/);
    expect(brief("security:K-1")).toMatch(/API test key[\s\S]*scripts\/seed\.ts/);
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
    const gone: Finding = { ...by("ci:e2e"), ref: "deleted" };
    expect(briefFor(gone, inp, ctx)).toBeNull();
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
});
