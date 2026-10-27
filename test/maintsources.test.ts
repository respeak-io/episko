import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BOTS, COSTS, FACETS, FACET_DEFS, MAINT_CAPS, MAINT_PREFS_DEFAULT, MARKERS, SOURCES, capsOf, facetDef,
  facetSources, findSource, permitted, runnable, sourceDef, type Cost, type Mode,
} from "../src/maintsources";
import { ADVISORY_KINDS, CI_STATUSES, FORGE_BY, SEVERITIES } from "../src/maint";

// Both sides read one manifest, and each keeps a list the other must agree with. TypeScript cannot
// see the Rust half, so these joins are read from source (the provider-contract precedent).

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rs = read("src-tauri/src/maint.rs");
const forgeRs = read("src-tauri/src/forge.rs");
const manifest = JSON.parse(read("src/maintmanifest.json")) as {
  sources: Record<string, { label: string; sees: string[]; blind: string[] }>;
  markers: { label: string; forge: string[] }[];
  bots: { id: string }[];
};
const block = (re: RegExp, src = rs) => re.exec(src)?.[1] ?? "";
// A `rename_all = "lowercase"` enum's variants as the wire spells them.
const variants = (name: string, src = rs) =>
  block(new RegExp(String.raw`pub\(crate\) enum ${name} \{([\s\S]*?)\}`), src).split("\n")
    .map((l) => /^\s*(\w+)/.exec(l.replace(/\/\/.*/, ""))?.[1]?.toLowerCase()).filter((v): v is string => !!v);
const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe("the manifest and maint.rs agree", () => {
  it("names exactly the sources Rust registers a read for", () => {
    const reg = [...block(/pub\(crate\) static SOURCES: &\[SourceDef\] = &\[([\s\S]*?)\n\];/).matchAll(/\bid: "([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(reg.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.sources).sort()).toEqual([...reg].sort());
    expect(SOURCES.map((s) => s.id).sort()).toEqual([...reg].sort());
  });

  it("mirrors MAINT_CAPS, the facets and the cost classes", () => {
    expect([...MAINT_CAPS]).toEqual(quoted(block(/pub\(crate\) const MAINT_CAPS: &\[&str\] = &\[([\s\S]*?)\];/)));
    const facets = block(/pub\(crate\) const FACETS: \[Facet; 7\] =\s*\[([\s\S]*?)\];/).match(/Facet::(\w+)/g) ?? [];
    expect(facets.map((f) => f.slice(7).toLowerCase())).toEqual([...FACETS]);
    const costs = block(/pub\(crate\) enum Cost \{([\s\S]*?)\}/).match(/\w+/g) ?? [];
    expect(costs.map((c) => c.toLowerCase())).toEqual([...COSTS]);
  });

  it("mirrors every wire enum, so a variant Rust adds is not an error for every report carrying it", () => {
    expect(variants("CiStatus")).toEqual([...CI_STATUSES]);
    expect(variants("Severity")).toEqual([...SEVERITIES]);
    expect(variants("AdvisoryKind")).toEqual([...ADVISORY_KINDS]);
    expect(variants("ForgeBy", forgeRs)).toEqual([...FORGE_BY]);
  });

  it("uses only capabilities in the closed vocabulary", () => {
    const used = new Set(Object.values(manifest.sources).flatMap((s) => [...s.sees, ...s.blind]));
    expect([...used].filter((c) => !(MAINT_CAPS as readonly string[]).includes(c))).toEqual([]);
    expect(() => capsOf(["git.unpushed", "git.unpushd"])).toThrow(/git\.unpushd/);
  });
});

describe("the manifest as TypeScript", () => {
  it("draws the seven facets in card order, each with its own none phrase", () => {
    expect(FACET_DEFS.map((f) => f.id)).toEqual([...FACETS]);
    expect(facetDef("ci").none).toBe("no CI");
    expect(facetDef("git").none).toBe("not a git repository");
    expect(new Set(FACET_DEFS.map((f) => f.none)).size).toBe(FACETS.length);
  });

  it("throws on an unknown source rather than guessing one", () => {
    expect(sourceDef("git-tags")).toMatchObject({ facet: "release", cost: "local" });
    expect(() => sourceDef("nope")).toThrow(/nope is not a maintenance source/);
    expect(findSource("nope")).toBeNull();
  });

  it("files every source and marker under one facet", () => {
    for (const f of FACETS) for (const s of facetSources(f)) expect(s.facet).toBe(f);
    expect(FACETS.flatMap(facetSources).length).toBe(SOURCES.length);
    expect(MARKERS.length).toBe(manifest.markers.length);
    expect(BOTS.map((b) => b.id)).toEqual(manifest.bots.map((b) => b.id));
  });
});

describe("what a mode may run", () => {
  it("mirrors maint.rs's cost gate", () => {
    const table: [Cost, Mode, boolean, boolean][] = [
      ["local", "scan", false, true], ["forge", "scan", false, true],
      ["public", "scan", false, false], ["public", "scan", true, true], ["public", "explicit", false, true],
      ["tool", "scan", true, false], ["tool", "explicit", false, true],
      ["remote", "scan", true, false], ["remote", "explicit", false, true],
    ];
    for (const [cost, mode, pub, want] of table) expect(permitted(cost, mode, pub), `${cost} ${mode} ${pub}`).toBe(want);
  });

  it("keeps detection order and drops what this machine skips or this build does not know", () => {
    const det = { sources: ["git-tags", "nope", "git-local", "changelog"] };
    expect(runnable(det, MAINT_PREFS_DEFAULT, "scan")).toEqual(["git-tags", "git-local", "changelog"]);
    expect(runnable(det, { public: [], off: ["git-local"] }, "explicit")).toEqual(["git-tags", "changelog"]);
  });
});

describe("the frontend never names a vendor", () => {
  // A feature gated on a vendor id is a feature the next vendor silently lacks.
  // Every word a label or ForgeKind holds, less the generic ones, so a new vendor row is caught unlisted.
  const generic = new Set(["ci", "on", "host", "actions", "pipelines", "alerts", "code", "scanning", "secret", "dev",
    "audit", "releases", "issues", "local", "branches", "git", "tags", "changelog", "md", "unknown", "none"]);
  const labels = [...manifest.markers, ...Object.values(manifest.sources)].map((m) => m.label);
  const vendors = new Set([
    ...labels.flatMap((l) => l.toLowerCase().split(/[^a-z0-9]+/)), ...variants("ForgeKind", forgeRs),
    ...manifest.bots.map((b) => b.id), ...manifest.markers.flatMap((m) => m.forge), "gh", "glab",
  ].filter((w) => w && !generic.has(w)));
  it("knows the vendors it guards against", () => {
    expect([...vendors]).toEqual(expect.arrayContaining(["github", "gitlab", "bitbucket", "azure", "woodpecker", "snyk", "osv", "renovate"]));
  });
  for (const f of ["src/maintsources.ts", "src/maint.ts", "src/maintbrief.ts"]) {
    it(f, () => {
      const src = read(f);
      expect([...vendors].filter((v) => new RegExp(`\\b${v}\\b`, "i").test(src))).toEqual([]);
    });
  }
});
