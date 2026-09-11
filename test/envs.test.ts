import { describe, expect, it } from "vitest";
import {
  activePreset, clampEnvPrefs, effectiveTags, ENV_DEFAULTS, ENV_RX_MAX, envChip, envMark,
  envOrigin, envRegex, envRulesOf, envSections, groupChip, hasProjectRules, isDanger,
  isDefaultEnvRules, needsBackup, presetDest, presetRows, rulesFrom,
  type EnvGroup, type EnvPolicy, type EnvPreset, type EnvPrefs, type EnvScan, type EnvState,
  type EnvTag,
} from "../src/envs";

const P = (name: string, active = false, path = `.env.${name}`): EnvPreset =>
  ({ path, name, vars: 3, mtimeMs: 0, active });

const POLICY: EnvPolicy = { targets: null, presets: null, ignore: null, tags: [] };

const G = (state: EnvState, presets: EnvPreset[], target = ".env", dir = ""): EnvGroup =>
  ({ dir, target, state, presets });

function scan(groups: EnvGroup[], policy: Partial<EnvPolicy> = {}): EnvScan {
  return { groups, policy: { ...POLICY, ...policy }, policyReadable: true };
}

// `enabled` is off by default, so every chip test would answer null without this.
const prefs = (over: Partial<EnvPrefs> = {}): EnvPrefs => clampEnvPrefs({ ...ENV_DEFAULTS, enabled: true, ...over });
const tags = () => prefs().tags;

describe("what a stored blob is allowed to say", () => {
  it("ships OFF: it reads files in every open checkout and nobody installed Episko for it", () => {
    expect(clampEnvPrefs(null).enabled).toBe(false);
    expect(ENV_DEFAULTS.enabled).toBe(false);
    // An explicit true is the only thing that turns it on — a truthy scrap in storage is not.
    expect(clampEnvPrefs({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
    expect(clampEnvPrefs({ enabled: true }).enabled).toBe(true);
  });
  it("survives a value of the wrong shape entirely", () => {
    expect(clampEnvPrefs([] as unknown as EnvPrefs)).toEqual(clampEnvPrefs(ENV_DEFAULTS));
    expect(clampEnvPrefs("nope" as unknown as EnvPrefs)).toEqual(clampEnvPrefs(ENV_DEFAULTS));
    expect(clampEnvPrefs({ targets: "x" as unknown as string[] }).targets).toEqual(ENV_DEFAULTS.targets);
  });
  it("keeps a deliberately empty list, which is how the rules are turned off", () => {
    expect(clampEnvPrefs({ tags: [] }).tags).toEqual([]);
    expect(isDefaultEnvRules(envRulesOf(clampEnvPrefs({ tags: [] })))).toBe(false);
    expect(isDefaultEnvRules(envRulesOf(clampEnvPrefs(null)))).toBe(true);
  });
  it("drops a rule with no pattern and narrows a tone it does not know", () => {
    const got = clampEnvPrefs({
      tags: [{ match: "" }, { match: "  prod ", tone: "MAGENTA" }, { match: "dev", tone: "safe", label: " Dev " }],
    });
    expect(got.tags).toEqual([
      { match: "prod", tone: "warn", label: null },
      { match: "dev", tone: "safe", label: "Dev" },
    ]);
  });
  it("caps the lists, since these are keys people hand-edit", () => {
    const many = Array.from({ length: 99 }, (_, i) => `p${i}`);
    expect(clampEnvPrefs({ presets: many }).presets.length).toBeLessThanOrEqual(24);
    expect(clampEnvPrefs({ tags: many.map((m) => ({ match: m })) }).tags.length).toBeLessThanOrEqual(24);
  });
});

describe("compiling a rule somebody typed", () => {
  it("is always case-insensitive, since nobody spells PROD one way", () => {
    expect(envRegex("prod")!.test("PRODUCTION")).toBe(true);
    expect(envRegex("^prod$")!.test("preprod")).toBe(false);
  });
  it("answers null rather than throwing, for every way a pattern can be unusable", () => {
    expect(envRegex("(unclosed")).toBeNull();
    expect(envRegex("")).toBeNull();
    expect(envRegex("a".repeat(ENV_RX_MAX + 1))).toBeNull();
  });
  it("skips a broken rule instead of letting it take the rules below it", () => {
    const rules: EnvTag[] = [{ match: "(oops", tone: "danger" }, { match: "prod", tone: "danger" }];
    expect(envMark("prod", rules).tone).toBe("danger");
    expect(envMark("dev", rules).tone).toBe("none");
  });
});

describe("which rule names an environment", () => {
  it("takes the first that matches, which is why the defaults are ordered", () => {
    // `preprod` contains `prod`; asking the broad rule first would call it production.
    expect(envMark("preprod", tags()).tone).toBe("warn");
    expect(envMark("production", tags()).tone).toBe("danger");
    expect(envMark("staging", tags()).tone).toBe("warn");
    expect(envMark("dev", tags()).tone).toBe("safe");
  });
  it("reports the pattern that decided, and lets a rule rename what it matched", () => {
    expect(envMark("prod", [{ match: "prod", tone: "danger", label: "PRODUCTION" }]))
      .toEqual({ tone: "danger", label: "PRODUCTION", rule: "prod" });
    expect(envMark("weird", [])).toEqual({ tone: "none", label: "weird", rule: "" });
  });
  it("prefers the project's rules, and only while it has some", () => {
    const own: EnvTag[] = [{ match: "dev", tone: "danger" }];
    expect(effectiveTags(prefs(), scan([], { tags: own }))).toEqual(own);
    expect(effectiveTags(prefs(), scan([], { tags: [] }))).toEqual(prefs().tags);
    expect(effectiveTags(prefs(), null)).toEqual(prefs().tags);
  });
  it("says which side each field came from, and whether the project spoke at all", () => {
    expect(envOrigin({ ...POLICY, targets: [".env"] }).targets).toBe("project");
    expect(envOrigin({ ...POLICY, tags: [{ match: "x" }] }).tags).toBe("project");
    expect(envOrigin(POLICY)).toEqual({ targets: "app", presets: "app", ignore: "app", tags: "app" });
    expect(hasProjectRules(POLICY)).toBe(false);
    expect(hasProjectRules({ ...POLICY, ignore: [] })).toBe(true); // an empty list is still a statement
    expect(hasProjectRules(null)).toBe(false);
  });
  it("seeds the dialog from the project where it spoke and the app where it did not", () => {
    const app = envRulesOf(prefs());
    const got = rulesFrom({ ...POLICY, targets: ["app.env"] }, app);
    expect(got.targets).toEqual(["app.env"]);
    expect(got.presets).toEqual(app.presets);
    expect(got.tags).toEqual(app.tags);
  });
});

describe("what one environment's chip says", () => {
  it("names the active preset and takes its rule's tone", () => {
    const c = groupChip(G("preset", [P("dev"), P("prod", true)]), tags());
    expect(c.text).toBe("prod");
    expect(c.tone).toBe("danger");
    expect(c.title).toContain(".env.prod");
    expect(c.title).toContain("/prod|live/i");
  });
  it("offers the presets when there is no target yet", () => {
    const c = groupChip(G("missing", [P("dev")]), tags());
    expect(c).toMatchObject({ text: "no .env", tone: "none" });
    // A target deep in a monorepo is named by its file, since the section header has the path.
    expect(groupChip(G("missing", [], "apps/web/.env", "apps/web"), tags()).text).toBe("no .env");
  });
  it("calls content no preset holds `modified`, and that is the one state needing a backup", () => {
    const g = G("modified", [P("dev"), P("prod")]);
    expect(groupChip(g, tags())).toMatchObject({ text: "modified", tone: "warn" });
    expect(needsBackup(g)).toBe(true);
    expect(needsBackup(G("preset", [P("dev", true)]))).toBe(false);
    expect(needsBackup(null)).toBe(false);
    expect(activePreset(g)).toBeNull();
  });
});

describe("the chip for a whole checkout", () => {
  it("says nothing at all where the project does not work this way", () => {
    expect(envChip(null, prefs())).toBeNull();
    expect(envChip(scan([]), prefs())).toBeNull();
    expect(envChip(scan([G("preset", [P("prod", true)])]), prefs({ enabled: false }))).toBeNull();
  });
  it("is the one environment's chip when there is one", () => {
    const c = envChip(scan([G("preset", [P("prod", true)])]), prefs())!;
    expect(c.text).toBe("prod");
    expect(isDanger(c)).toBe(true);
  });
  it("speaks for the worst of several, and counts the rest", () => {
    const c = envChip(scan([
      G("preset", [P("dev", true)], "apps/docs/.env", "apps/docs"),
      G("preset", [P("prod", true)], "apps/api/.env", "apps/api"),
      G("preset", [P("staging", true)], "apps/web/.env", "apps/web"),
    ]), prefs())!;
    expect(c.text).toBe("prod +2");
    expect(c.tone).toBe("danger");
    // Every one of them is named, or the count is a number with nothing behind it.
    expect(c.title.split("\n")).toEqual([
      "apps/docs/.env → dev", "apps/api/.env → prod", "apps/web/.env → staging",
    ]);
  });
  it("puts an environment no rule claims ahead of one called safe", () => {
    const c = envChip(scan([
      G("preset", [P("dev", true)]),
      G("preset", [P("weird", true)], "apps/x/.env", "apps/x"),
    ]), prefs())!;
    expect(c.text).toBe("weird +1");
    expect(c.tone).toBe("none");
  });
});

describe("the sections every surface shares", () => {
  it("are one order, by name, whatever order the files came back in", () => {
    const secs = envSections(scan([G("preset", [P("staging"), P("dev"), P("prod", true)])]), prefs());
    expect(secs).toHaveLength(1);
    expect(secs[0].rows.map((r) => r.preset.name)).toEqual(["dev", "prod", "staging"]);
    expect(secs[0].rows.map((r) => r.mark.tone)).toEqual(["safe", "danger", "warn"]);
    expect(envSections(null, prefs())).toEqual([]);
    expect(envSections(scan([G("preset", [])]), prefs({ enabled: false }))).toEqual([]);
  });
  it("keeps a monorepo's packages apart, in the order the backend found them", () => {
    const secs = envSections(scan([
      G("preset", [P("prod", true, "apps/api/.env.prod")], "apps/api/.env", "apps/api"),
      G("missing", [P("dev", false, "apps/web/.env.dev")], "apps/web/.env", "apps/web"),
    ]), prefs());
    expect(secs.map((s) => s.group.target)).toEqual(["apps/api/.env", "apps/web/.env"]);
    expect(secs.map((s) => s.chip.text)).toEqual(["prod", "no .env"]);
    expect(presetRows(secs[1].group, tags()).map((r) => r.preset.path)).toEqual(["apps/web/.env.dev"]);
  });
});

describe("where a saved preset lands", () => {
  it("copies the shape of the presets already beside that target", () => {
    expect(presetDest(G("modified", [P("prod", false, ".env.prod")]), "mine")).toBe(".env.mine");
    expect(presetDest(G("modified", [P("prod", false, "envs/prod.env")]), "mine")).toBe("envs/mine.env");
    expect(presetDest(G("modified", [P("prod", false, "envs/prod")]), "mine")).toBe("envs/mine");
    expect(presetDest(G("modified", [P("prod", false, "config/prod.toml")]), "mine")).toBe(".env.mine");
  });
  it("stays in its own package, never at the root of the repo", () => {
    const web = G("modified", [P("prod", false, "apps/web/.env.prod")], "apps/web/.env", "apps/web");
    expect(presetDest(web, "mine")).toBe("apps/web/.env.mine");
    // Nothing to copy: beside the target itself, which is still inside the package.
    expect(presetDest(G("modified", [], "apps/web/.env", "apps/web"), "mine")).toBe("apps/web/.env.mine");
  });
  it("cannot be talked into a name that leaves the project", () => {
    expect(presetDest(G("modified", []), "  ")).toBe("");
    expect(presetDest(G("modified", []), "../escape")).toBe(".env.escape");
    expect(presetDest(G("modified", []), "a/b")).toBe(".env.a-b");
    expect(presetDest(G("modified", []), "my env!")).toBe(".env.my-env");
  });
});
