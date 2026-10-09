import { describe, expect, it } from "vitest";
import {
  clampProjPrefs, fetchFor, overriders, permOverride, withFetch, withPerm, type ProjPrefStore,
} from "../src/projprefs";

const G = { enabled: true, everyMs: 300_000 };

describe("what a stored blob is allowed to say", () => {
  it("survives a value of the wrong shape entirely", () => {
    for (const bad of [null, "x", 3, [], [{ perm: { claude: "plan" } }]]) expect(clampProjPrefs(bad)).toEqual({});
  });
  it("keeps only fields it understands, and drops a project left with none", () => {
    expect(clampProjPrefs({
      "/a": { perm: { claude: "plan", codex: 4, x: "" }, fetch: false, fetchEvery: 900_000, junk: 1 },
      "/b": { fetch: "no", fetchEvery: 1 },
      "/c": "plan",
    })).toEqual({ "/a": { perm: { claude: "plan" }, fetch: false, fetchEvery: 900_000 } });
  });
  it("takes only a cadence the picker offers, as the global rule does", () => {
    expect(clampProjPrefs({ "/a": { fetchEvery: 30_000 } })).toEqual({});
  });
  it("folds a decomposed path onto the precomposed spelling every other store uses", () => {
    const s = clampProjPrefs({ "/Büro": { fetch: false } });
    expect(Object.keys(s)).toEqual(["/Büro"]);
  });
});

describe("resolving a project against Settings", () => {
  const s: ProjPrefStore = { "/a": { perm: { claude: "plan" }, fetch: false } };
  it("answers the override for its own provider only", () => {
    expect(permOverride(s, "/a", "claude")).toBe("plan");
    expect(permOverride(s, "/a", "codex")).toBeUndefined();
    expect(permOverride(s, "/b", "claude")).toBeUndefined();
  });
  it("falls back to Settings per half, so an off switch keeps the global cadence", () => {
    expect(fetchFor(G, s, "/a")).toEqual({ enabled: false, everyMs: 300_000 });
    expect(fetchFor(G, { "/a": { fetchEvery: 1_800_000 } }, "/a")).toEqual({ enabled: true, everyMs: 1_800_000 });
    expect(fetchFor({ enabled: false, everyMs: 60_000 }, {}, "/a")).toEqual({ enabled: false, everyMs: 60_000 });
  });
});

describe("changing a project's answer", () => {
  it("never mutates the store it was given", () => {
    const s: ProjPrefStore = { "/a": { fetch: true } };
    withPerm(s, "/a", "claude", "plan");
    withFetch(s, "/a", { fetch: false });
    expect(s).toEqual({ "/a": { fetch: true } });
  });
  it("clears with null, and a project with nothing left leaves the store", () => {
    let s = withPerm({}, "/a", "claude", "plan");
    s = withFetch(s, "/a", { fetch: false, fetchEvery: 900_000 });
    expect(s["/a"]).toEqual({ perm: { claude: "plan" }, fetch: false, fetchEvery: 900_000 });
    s = withPerm(s, "/a", "claude", null);
    s = withFetch(s, "/a", { fetch: null });
    expect(s["/a"]).toEqual({ fetchEvery: 900_000 });
    s = withFetch(s, "/a", { fetchEvery: null });
    expect(s).toEqual({});
  });
  it("leaves the other half alone when one is patched", () => {
    const s = withFetch({ "/a": { fetch: false, fetchEvery: 60_000 } }, "/a", { fetchEvery: null });
    expect(s["/a"]).toEqual({ fetch: false });
  });
});

describe("who overrides a global row", () => {
  const s: ProjPrefStore = {
    "/a": { perm: { claude: "plan" } }, "/b": { fetchEvery: 60_000 }, "/c": { perm: { codex: "auto" }, fetch: false },
  };
  it("asks per provider for a permission mode", () => {
    expect(overriders(s, "perm", "claude")).toEqual(["/a"]);
    expect(overriders(s, "perm", "codex")).toEqual(["/c"]);
  });
  it("counts either half of auto-fetch", () => {
    expect(overriders(s, "fetch")).toEqual(["/b", "/c"]);
  });
});
