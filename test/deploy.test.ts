import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkDeploy, checkMaintCfg, deployLosses, deployPrompt, deploySummary, deployText, deployToml, isEmptyDeploy, isEmptyMaintCfg,
  maintCfgLosses, maintCfgSummary, maintCfgText, maintCfgToml, maintPrompt, narrowDeploy, narrowMaintCfg, NO_FILE,
  type DeployCfg, type DeployProposal, type MaintCfg, type MaintCfgProposal,
} from "../src/deploy";

// What an agent proposes for `[deploy]` is data a later click hands to ssh and curl, so a value
// that could become a flag or a non-http request never reaches Apply.

const wire = JSON.parse(readFileSync(new URL("./fixtures/maint-wire.json", import.meta.url), "utf8")) as { detection: { deploy: unknown } };
const NONE: DeployCfg = { host: null, compose: [], urls: {}, sentry: null, versionUrl: null };
const prop = (d: Partial<DeployCfg>, why: string[] = []): DeployProposal => ({ deploy: { ...NONE, ...d }, why });

describe("checkDeploy", () => {
  it("keeps what is safe", () => {
    const p = prop({ host: " prod-1 ", compose: ["api"], urls: { app: "https://app.example.com" }, sentry: "acme-co/api.web", versionUrl: "http://v.example/version" });
    expect(checkDeploy(p)).toEqual({ deploy: { ...p.deploy, host: "prod-1" }, dropped: [] });
  });

  it("refuses an address that is not http(s)", () => {
    const c = checkDeploy(prop({ urls: { app: "javascript:alert(1)", ok: "https://ok.example", "": "https://x.example" }, versionUrl: "file:///etc/passwd" }));
    expect(c.deploy.urls).toEqual({ ok: "https://ok.example" });
    expect(c.deploy.versionUrl).toBeNull();
    expect(c.dropped).toHaveLength(3);
  });

  it("refuses an alias or a service that would become a flag", () => {
    const c = checkDeploy(prop({ host: "-oProxyCommand=touch /tmp/x", compose: ["api", "--all", "two words"] }));
    expect(c.deploy.host).toBeNull();
    expect(c.deploy.compose).toEqual(["api"]);
    expect(c.dropped).toEqual([
      'host = "-oProxyCommand=touch /tmp/x" is not an ssh alias or host name',
      'compose service "--all" is not a name', 'compose service "two words" is not a name',
    ]);
  });

  it("refuses a sentry that is not org/project", () => {
    for (const bad of ["acme", "acme/api/x", "-acme/api", "acme/", "acme /api"]) {
      expect(checkDeploy(prop({ sentry: bad })).deploy.sentry, bad).toBeNull();
    }
  });

  // deploy.rs's `checks_agree_with_deploy_ts` runs this same table through `keep`.
  it("agrees with deploy.rs case for case", () => {
    const table = JSON.parse(readFileSync(new URL("./fixtures/deploy-checks.json", import.meta.url), "utf8")) as
      { cases: { field: string; value: string; refused: string | null }[] };
    const as: Record<string, (v: string) => Partial<DeployCfg>> = {
      url: (v) => ({ urls: { app: v } }), version_url: (v) => ({ versionUrl: v }), host: (v) => ({ host: v }),
      compose: (v) => ({ compose: [v] }), sentry: (v) => ({ sentry: v }),
    };
    expect(table.cases.map((c) => c.value)).toEqual(expect.arrayContaining(["https://", "https://a b", "HTTPS://x.example"]));
    for (const c of table.cases) {
      const out = checkDeploy(prop(as[c.field](c.value)));
      expect(out.dropped, `${c.field} = ${c.value}`).toEqual(c.refused ? [c.refused] : []);
      expect(isEmptyDeploy(out.deploy), `${c.field} = ${c.value}`).toBe(!!c.refused);
    }
  });
});

describe("the table", () => {
  it("narrows the backend's detection, and none is null", () => {
    expect(narrowDeploy(wire.detection.deploy)).toEqual(wire.detection.deploy);
    expect(narrowDeploy(null)).toBeNull();
    expect(narrowDeploy({ host: 3, compose: "api" })).toBeNull();
    expect(narrowDeploy({ host: "prod-1", urls: { a: 1, b: "https://b.example" } })).toEqual({ ...NONE, host: "prod-1", urls: { b: "https://b.example" } });
    expect(isEmptyDeploy(NONE)).toBe(true);
  });

  it("says itself in one line", () => {
    expect(deploySummary(null)).toBe("");
    expect(deploySummary({ ...NONE, host: "prod-1", compose: ["api", "worker"], urls: { a: "https://a.example" }, sentry: "acme/api" }))
      .toBe("on prod-1 · compose api, worker · 1 address · errors in acme/api");
  });

  it("matches deploy.rs's refusal for a missing file", () => {
    const rs = readFileSync(new URL("../src-tauri/src/deploy.rs", import.meta.url), "utf8");
    expect(rs).toContain(`const NO_FILE: &str = "${NO_FILE}";`);
  });
});

describe("the question and the review", () => {
  it("hands the agent what the table says now", () => {
    expect(deployPrompt(null)).toContain("There is none yet.");
    const now = deployPrompt({ ...NONE, host: "prod-1", urls: { app: "https://app.example.com", "my api": "https://api.example.com/health" }, versionUrl: "https://api.example.com/version" });
    expect(now).toContain('host = "prod-1"');
    expect(now).toContain('urls = { app = "https://app.example.com", "my api" = "https://api.example.com/health" }');
    expect(now).toContain('version_url = "https://api.example.com/version"');
    expect(now).toContain("a value you leave out is removed");
    expect(deployPrompt(null)).toMatch(/Never write a token, password, key or any other secret/);
  });

  it("writes the table as TOML deploy.rs reads back", () => {
    expect(deployToml({ ...NONE, host: 'a"b', compose: ["api", "worker"] })).toBe('[deploy]\nhost = "a\\"b"\ncompose = ["api", "worker"]');
  });

  it("names every current value a proposal removes or changes", () => {
    const cur: DeployCfg = { ...NONE, host: "old", compose: ["api"], urls: { app: "https://a.example", hand: "https://h.example" }, versionUrl: "https://v.example" };
    expect(deployLosses(cur, { ...cur, host: "new", compose: [], urls: { app: "https://a.example" }, versionUrl: null })).toEqual([
      '`host = "old"` becomes `"new"`', "compose service `api` is removed", '`urls.hand = "https://h.example"` is removed',
      '`version_url = "https://v.example"` is removed',
    ]);
    expect(deployLosses(cur, cur)).toEqual([]);
    expect(deployLosses(null, cur)).toEqual([]);
  });

  it("shows each kept value with its reason and lists what it left out", () => {
    const p = prop({ host: "prod-1", urls: { app: "https://app.example.com" }, sentry: "nope" }, ["host: deploy.sh line 3 runs ssh prod-1"]);
    const text = deployText(p, checkDeploy(p), { ...NONE, host: "old" });
    expect(text).toContain('- `host = "prod-1"`: deploy.sh line 3 runs ssh prod-1');
    expect(text).toContain("- app: `https://app.example.com`");
    expect(text).toContain('Left out:\n\n- sentry = "nope" is not org/project');
    expect(text).toContain('Changes what it says now:\n\n- `host = "old"` becomes `"prod-1"`');
    expect(deployText(p, checkDeploy(p), { ...NONE, host: "prod-1" })).not.toContain("Changes what it says now");
    expect(deployText(prop({}), checkDeploy(prop({})), null)).toBe("Claude found nothing it could support for `[deploy]`.");
  });
});

// `[maintenance]`'s keys are data git and a SARIF walk read, so a value that could become a flag, a
// wildmatch or a path out of the project never reaches Apply.
const BARE: MaintCfg = { trunk: null, tagPattern: null, sarif: [], bots: [] };
const mprop = (c: Partial<MaintCfg>, unknown: string[] = [], why: string[] = []): MaintCfgProposal => ({ maintenance: { ...BARE, ...c }, unknown, why });

describe("checkMaintCfg", () => {
  // maint.rs's `setup_checks_agree_with_deploy_ts` runs this same table through `keep_setup`.
  it("agrees with maint.rs case for case", () => {
    const table = JSON.parse(readFileSync(new URL("./fixtures/maint-checks.json", import.meta.url), "utf8")) as
      { cases: { field: string; value: string; refused: string | null }[] };
    const as: Record<string, (v: string) => MaintCfgProposal> = {
      trunk: (v) => mprop({ trunk: v }), tag_pattern: (v) => mprop({ tagPattern: v }), sarif: (v) => mprop({ sarif: [v] }),
      bots: (v) => mprop({ bots: [v] }), key: (v) => mprop({}, [v]),
    };
    expect(new Set(table.cases.map((c) => c.field))).toEqual(new Set(Object.keys(as)));
    for (const c of table.cases) {
      const out = checkMaintCfg(as[c.field](c.value));
      expect(out.dropped, `${c.field} = ${c.value}`).toEqual(c.refused ? [c.refused] : []);
      expect(isEmptyMaintCfg(out.maintenance), `${c.field} = ${c.value}`).toBe(c.field === "key" || !!c.refused);
    }
  });

  it("trims, drops empties and keeps one of each", () => {
    expect(checkMaintCfg(mprop({ trunk: " dev ", tagPattern: "  ", sarif: ["a.sarif", " a.sarif", ""], bots: ["x", "x"] })))
      .toEqual({ maintenance: { trunk: "dev", tagPattern: null, sarif: ["a.sarif"], bots: ["x"] }, dropped: [] });
  });
});

describe("the [maintenance] keys", () => {
  const cur: MaintCfg = { trunk: "dev", tagPattern: "v*", sarif: ["out/a.sarif", "out/b.sarif"], bots: ["acme-renovate"] };

  it("narrows the backend's answer, and none is null", () => {
    expect(narrowMaintCfg({ trunk: "dev", tagPattern: 3, sarif: ["a", 1], bots: "x" })).toEqual({ ...BARE, trunk: "dev", sarif: ["a"] });
    expect(narrowMaintCfg({ trunk: null, tagPattern: null, sarif: [], bots: [] })).toBeNull();
    expect(narrowMaintCfg(null)).toBeNull();
  });

  it("says itself in one line, and as TOML maint.rs reads back", () => {
    expect(maintCfgSummary(null)).toBe("");
    expect(maintCfgSummary(cur)).toBe("trunk dev · tags v* · 2 SARIF paths · bots acme-renovate");
    expect(maintCfgToml({ ...BARE, trunk: 'a"b', sarif: ["x.sarif"] })).toBe('[maintenance]\ntrunk = "a\\"b"\nsarif = ["x.sarif"]');
  });

  it("hands the agent what the keys say now and what Maintenance could not tell", () => {
    expect(maintPrompt(null)).toContain("None of them is set yet.");
    const now = maintPrompt(cur, ["git tags: no remote, so no default branch: set [maintenance] trunk"]);
    expect(now).toContain('trunk = "dev"\ntag_pattern = "v*"\nsarif = ["out/a.sarif", "out/b.sarif"]\nbots = ["acme-renovate"]');
    expect(now).toContain("a value you leave out is removed");
    expect(now).toContain("- git tags: no remote, so no default branch: set [maintenance] trunk");
    expect(now).toMatch(/Never write a token, password, key or any other secret/);
  });

  it("names every current value a proposal removes or changes", () => {
    expect(maintCfgLosses(cur, { trunk: "main", tagPattern: null, sarif: ["out/a.sarif"], bots: [] })).toEqual([
      '`trunk = "dev"` becomes `"main"`', '`tag_pattern = "v*"` is removed', "sarif path `out/b.sarif` is removed", "bot `acme-renovate` is removed",
    ]);
    expect(maintCfgLosses(cur, cur)).toEqual([]);
    expect(maintCfgLosses(null, cur)).toEqual([]);
  });

  it("shows each kept value with its reason, what it changes and what it left out", () => {
    const p = mprop({ trunk: "main", tagPattern: "v[0-9]*", sarif: ["out/a.sarif"] }, ["off"], ["trunk: CONTRIBUTING.md says PRs target main"]);
    const text = maintCfgText(p, checkMaintCfg(p), cur);
    expect(text).toContain('- `trunk = "main"`: CONTRIBUTING.md says PRs target main');
    expect(text).toContain('- `sarif = ["out/a.sarif"]`');
    expect(text).toContain('Changes what it says now:\n\n- `trunk = "dev"` becomes `"main"`\n- `tag_pattern = "v*"` is removed');
    expect(text).toContain("- bot `acme-renovate` is removed");
    expect(text).toContain('Left out:\n\n- tag_pattern = "v[0-9]*" is not a tag glob: * is its only wildcard\n- off is not a key an agent may set');
    expect(text).toContain("off, sources, thresholds and params stay as they are");
    expect(maintCfgText(mprop({}), checkMaintCfg(mprop({})), null)).toBe("Claude found nothing it could support for `[maintenance]`.");
    expect(maintCfgText(mprop({}), checkMaintCfg(mprop({})), cur)).toMatch(/^Claude found nothing[^\n]*so Apply clears what it says now/);
  });
});
