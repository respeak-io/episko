import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  SYNC_KEYS, SYNC_DOWN_MS, acceptPref, acceptUsage, advance, mergeScoped, peerDays,
  prefOutbox, readPeers, syncClass, syncHealth, usageOutbox, wins, type Peers, type SyncEvent,
} from "../src/sync";

const ROOT = new URL("../", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");
const SRC = [
  ...readdirSync(new URL("src/", ROOT)).filter((f) => f.endsWith(".ts")).map((f) => "src/" + f),
  ...readdirSync(new URL("src/providers/", ROOT)).filter((f) => f.endsWith(".ts")).map((f) => "src/providers/" + f),
].filter((f) => f !== "src/sync.ts");
const keysIn = (text: string) => new Set([...text.matchAll(/["'`](cc-[a-z0-9-]+)["'`]/g)].map((m) => m[1]));
const used = new Set(SRC.flatMap((f) => [...keysIn(read(f))]));

const ev = (over: Partial<SyncEvent>): SyncEvent => ({ seq: 1, stream: "prefs", key: "cc-sort", device: "b", at: 10, payload: "manual", ...over });

// The allowlist is only as good as its coverage: a key nobody classified is a decision nobody made.
describe("the allowlist contract", () => {
  it("classifies every cc- key the app stores", () => {
    const missing = [...used].filter((k) => !(k in SYNC_KEYS)).sort();
    expect(missing, "add each to SYNC_KEYS in src/sync.ts, as `local` unless it is safe to leave the machine").toEqual([]);
  });
  it("names no key the app no longer stores", () => {
    expect(Object.keys(SYNC_KEYS).filter((k) => !used.has(k)).sort()).toEqual([]);
  });
  it("defaults an unknown key to local", () => {
    expect(syncClass("cc-something-new")).toBe("local");
  });
  it("keeps what runs and what is permitted out of sync", () => {
    for (const k of ["cc-perm-modes", "cc-perm-mode", "cc-trusted", "cc-task-onstop", "cc-task-prefs", "cc-digest-ok", "cc-revive"])
      expect(syncClass(k), k).toBe("local");
  });
});

// The privacy floor, made checkable: sync.ts cannot reach storage, the session or the network itself.
describe("the payload builder is fed from the allowlist alone", () => {
  const src = read("src/sync.ts");
  it("imports nothing but the store's narrowing", () => {
    expect([...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual(["./store"]);
  });
  it("never touches localStorage, fetch or Tauri", () => {
    expect(src).not.toMatch(/\blocalStorage\s*[.[]|\bfetch\s*\(|\binvoke\s*\(|@tauri-apps/);
  });
  it("sends only pref keys, whatever storage holds", () => {
    const all = (k: string) => `v:${k}`;
    const out = prefOutbox(all);
    expect(out.length).toBeGreaterThan(0);
    for (const { key } of out) expect(SYNC_KEYS[key], key).toBe("pref");
    expect(prefOutbox(() => null)).toEqual([]);
  });
});

describe("last-writer-wins", () => {
  it("takes the newer write and breaks a tie the same way on every machine", () => {
    expect(wins({ at: 2, device: "a" }, { at: 1, device: "z" })).toBe(true);
    expect(wins({ at: 1, device: "z" }, { at: 2, device: "a" })).toBe(false);
    expect(wins({ at: 5, device: "b" }, { at: 5, device: "a" })).toBe(true);
    expect(wins({ at: 5, device: "a" }, { at: 5, device: "b" })).toBe(false);
    expect(wins({ at: 0, device: "a" }, undefined)).toBe(true);
  });
  it("never rewinds a cursor", () => {
    expect(advance(10, 12)).toBe(12);
    expect(advance(10, 3)).toBe(10);
    for (const bad of [NaN, 1.5, "20", null]) expect(advance(10, bad)).toBe(10);
  });
});

describe("acceptPref", () => {
  it("takes a newer pref from another machine", () => {
    expect(acceptPref(ev({}), { at: 5, device: "a" }, "a")).toEqual({ key: "cc-sort", value: "manual" });
  });
  it("refuses our own echo, an older write, and any key we would not send", () => {
    expect(acceptPref(ev({ device: "a" }), undefined, "a")).toBeNull();
    expect(acceptPref(ev({ at: 1 }), { at: 5, device: "a" }, "a")).toBeNull();
    expect(acceptPref(ev({ key: "cc-perm-modes", payload: '{"claude":"bypassPermissions"}' }), undefined, "a")).toBeNull();
    expect(acceptPref(ev({ key: "cc-favorites", payload: "[]" }), undefined, "a")).toBeNull();
    expect(acceptPref(ev({ key: "cc-unknown" }), undefined, "a")).toBeNull();
  });
  it("drops a malformed value on its own rather than storing it", () => {
    expect(acceptPref(ev({ key: "cc-sound", payload: '{"on":' }), undefined, "a")).toBeNull();
    expect(acceptPref(ev({ key: "cc-sound", payload: 7 }), undefined, "a")).toBeNull();
    expect(acceptPref(ev({ key: "cc-sound", payload: '{"on":true}' }), undefined, "a")).toEqual({ key: "cc-sound", value: '{"on":true}' });
  });
});

describe("usage partitions by device", () => {
  const u = (key: string, payload: unknown, device = key.split("|")[1]): SyncEvent => ev({ stream: "usage", key, device, payload });

  it("sends each day under this device's cell only", () => {
    expect(usageOutbox({ "2026-09-24": 3.5, "2026-09-23": 0, bogus: 9 }, "lap")).toEqual([{ key: "2026-09-24|lap", value: "3.5" }]);
  });
  it("sums two machines' spend on one day instead of letting one overwrite the other", () => {
    const peers: Peers = {};
    expect(acceptUsage(peers, u("2026-09-24|desk", "4"), "lap")).toBe(true);
    expect(acceptUsage(peers, u("2026-09-24|mini", 1.5), "lap")).toBe(true);
    expect(peerDays(peers)).toEqual({ "2026-09-24": 5.5 });
  });
  it("never takes this machine's own spend back from the server", () => {
    const peers: Peers = {};
    expect(acceptUsage(peers, u("2026-09-24|lap", "99"), "lap")).toBe(false);
    expect(peers).toEqual({});
  });
  it("keeps the larger figure when pages arrive out of order", () => {
    const peers: Peers = {};
    acceptUsage(peers, u("2026-09-24|desk", "4"), "lap");
    expect(acceptUsage(peers, u("2026-09-24|desk", "2"), "lap")).toBe(false);
    expect(peers.desk["2026-09-24"]).toBe(4);
  });
  it("refuses a cell another device claims to own, and nonsense amounts", () => {
    const peers: Peers = {};
    expect(acceptUsage(peers, u("2026-09-24|desk", "4", "mini"), "lap")).toBe(false);
    for (const bad of ["-1", "NaN", "abc", null, {}]) expect(acceptUsage(peers, u("2026-09-24|desk", bad), "lap")).toBe(false);
    expect(acceptUsage(peers, u("yesterday|desk", "1"), "lap")).toBe(false);
    expect(acceptUsage(peers, u("2026-09-24", "1", "desk"), "lap")).toBe(false);
  });
  it("reads cc-usage-peers without trusting it", () => {
    for (const bad of [null, "", "{", "null", "[]", "7"]) expect(readPeers(bad)).toEqual({});
    expect(readPeers(JSON.stringify({ desk: { "2026-09-24": 2, junk: 1, "2026-09-23": -1 }, mini: [], x: null })))
      .toEqual({ desk: { "2026-09-24": 2 } });
  });
});

describe("mergeScoped", () => {
  const held = { at: 10, wins: [{ label: "Fable", pct: 40, resetTs: 99 }] };
  it("takes a fresher reading", () => {
    expect(mergeScoped(held, { at: 20, wins: [{ label: "Fable", pct: 55, resetTs: 99 }] })?.wins?.[0].pct).toBe(55);
  });
  it("treats an absent window list as nothing learned, and an empty one as the answer", () => {
    expect(mergeScoped(held, { at: 20 })).toBe(held);
    expect(mergeScoped(held, { at: 20, wins: [] })).toEqual({ at: 20, wins: [] });
  });
  it("keeps the held reading against an older one or garbage", () => {
    expect(mergeScoped(held, { at: 5, wins: [] })).toBe(held);
    for (const bad of [null, "x", { wins: [] }]) expect(mergeScoped(held, bad)).toBe(held);
  });
  it("narrows each window", () => {
    expect(mergeScoped(null, { at: 1, wins: [{ label: "Opus", pct: "9", resetTs: NaN }, { label: "" }, null] }))
      .toEqual({ at: 1, wins: [{ label: "Opus", pct: null, resetTs: null }] });
  });
});

describe("syncHealth", () => {
  it("is silent when sync is not set up: a solo user never needs a server", () => {
    expect(syncHealth(false, false, null, 0)).toBe("off");
  });
  it("goes red once the server has been unreachable past the window, or was never reached", () => {
    expect(syncHealth(true, true, 0, 1e9)).toBe("ok");
    expect(syncHealth(true, false, 1000, 1000 + SYNC_DOWN_MS - 1)).toBe("lagging");
    expect(syncHealth(true, false, 1000, 1000 + SYNC_DOWN_MS)).toBe("down");
    expect(syncHealth(true, false, null, 5)).toBe("down");
  });
});
