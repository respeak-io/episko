import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  checkDeploy, deployLosses, deployPrompt, deploySummary, deployText, deployToml, isEmptyDeploy, narrowDeploy, NO_FILE,
  type DeployCfg, type DeployProposal,
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
