import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  SYNC_KEYS, SYNC_DOWN_MS, PRESENCE_MAX, narrowPresence, parseHeaders, teamRows, acceptPref, acceptUsage, advance, mergeScoped, peerDays,
  prefOutbox, readPeers, syncClass, syncHealth, usageOutbox, wins, type Peers, type SyncEvent,
  PREF_LABEL, STREAM_INFO, deviceName, devicesByUser, digestCover, digestMisses, narrowDevices, narrowDigest, narrowShare,
  prefDiff, readArrivals, spendSources,
} from "../src/sync";

const ROOT = new URL("../", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");
const SRC = [
  ...readdirSync(new URL("src/", ROOT)).filter((f) => f.endsWith(".ts")).map((f) => "src/" + f),
  ...readdirSync(new URL("src/providers/", ROOT)).filter((f) => f.endsWith(".ts")).map((f) => "src/providers/" + f),
].filter((f) => f !== "src/sync.ts");
const keysIn = (text: string) => new Set([...text.matchAll(/["'`](cc-[a-z0-9-]+)["'`]/g)].map((m) => m[1]));
const used = new Set(SRC.flatMap((f) => [...keysIn(read(f))]));

const ev = (over: Partial<SyncEvent>): SyncEvent => ({ seq: 1, stream: "prefs", key: "cc-sort", actor: "me", device: "b", at: 10, payload: "manual", ...over });

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
  it("takes a removed pref as back-to-default", () => {
    expect(acceptPref(ev({ key: "cc-keys", payload: null }), undefined, "a")).toEqual({ key: "cc-keys", value: null });
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

describe("presence", () => {
  it("keeps project, branch and state, and drops anything else a peer sends", () => {
    const got = narrowPresence([{ pid: "git:1", project: "app", branch: "main", state: "working", title: "Fix the login bug", prompt: "secret" }]);
    expect(got).toEqual([{ pid: "git:1", project: "app", branch: "main", state: "working" }]);
  });
  it("drops rows with no project or an unknown state, and caps the list", () => {
    expect(narrowPresence([{ project: "", state: "working" }, { project: "a", state: "hacking" }, null, "x"])).toEqual([]);
    expect(narrowPresence(null)).toEqual([]);
    const many = Array.from({ length: PRESENCE_MAX + 5 }, (_, i) => ({ project: `p${i}`, state: "idle" }));
    expect(narrowPresence(many)).toHaveLength(PRESENCE_MAX);
  });
  it("puts a blocked session first and marks your own other machines", () => {
    const rows = teamRows({
      d1: { user: "ana", items: [{ pid: "", project: "api", branch: "", state: "idle" }] },
      d2: { user: "ben", items: [{ pid: "", project: "web", branch: "x", state: "attention" }] },
      d3: { user: "me", items: [{ pid: "", project: "cli", branch: "", state: "working" }] },
    }, "me");
    expect(rows.map((r) => [r.user, r.state, r.mine])).toEqual([["ben", "attention", false], ["me", "working", true], ["ana", "idle", false]]);
  });
});

describe("parseHeaders", () => {
  it("reads a Cloudflare Access service token and a basic-auth line", () => {
    const text = "# Cloudflare Access\nCF-Access-Client-Id: abc.access\r\nCF-Access-Client-Secret:  s3cr:et \n\nAuthorization: Basic dTpw\n";
    expect(parseHeaders(text)).toEqual({ error: null, headers: [
      ["CF-Access-Client-Id", "abc.access"], ["CF-Access-Client-Secret", "s3cr:et"], ["Authorization", "Basic dTpw"],
    ] });
    expect(parseHeaders("  \n# only a comment")).toEqual({ headers: [], error: null });
  });
  it("names the line and the reason, and takes nothing from a bad paste", () => {
    for (const [text, why] of [
      ["no colon here", "Name: value"], ["Bad Name: x", "not a header name"], ["X-Empty:", "no value"],
      ["Host: evil", "connection itself"], ["sec-websocket-key: x", "connection itself"],
      ["X-A: 1\nx-a: 2", "twice"], ["X-A: tab\tok\nX-B: bell\u0007", "cannot carry"],
    ] as const) {
      const r = parseHeaders(text);
      expect(r.headers, text).toEqual([]);
      expect(r.error, text).toContain(why);
    }
    expect(parseHeaders("X-B: 1\nnope").error).toMatch(/^line 2:/);
  });
});

describe("who is who", () => {
  const devs = narrowDevices([
    { user: "me", device: "d1", label: "Laptop" }, { user: "ana", device: "d3", label: "Desk" },
    { user: "me", device: "d2", label: "Tower" }, { nope: 1 }, { device: "" },
  ]);
  it("keeps only rows that name a device", () => {
    expect(devs.map((d) => d.device)).toEqual(["d1", "d3", "d2"]);
    expect(narrowDevices(null)).toEqual([]);
  });
  it("calls this machine so, and an unheard-of one by a short id", () => {
    expect(deviceName(devs, "d1", "d1")).toBe("this machine");
    expect(deviceName(devs, "d2", "d1")).toBe("Tower");
    expect(deviceName(devs, "abcdef123456", "d1")).toBe("machine abcdef");
  });
  it("puts your machines first, this one leading", () => {
    const g = devicesByUser(devs, "me", "d2");
    expect(g.map((u) => [u.user, u.mine])).toEqual([["me", true], ["ana", false]]);
    expect(g[0].devices.map((d) => d.device)).toEqual(["d2", "d1"]);
  });
});

describe("where the spend came from", () => {
  const devs = [{ user: "me", device: "lap", label: "Laptop" }];
  it("names each machine and drops the ones that spent nothing", () => {
    const peers: Peers = { lap: { "2026-10-01": 3, "2026-10-02": 1 }, gone: { "2026-09-01": 9 } };
    const rows = spendSources({ "2026-10-02": 2 }, peers, ["2026-10-01", "2026-10-02"], devs, "me1");
    expect(rows).toEqual([
      { device: "lap", label: "Laptop", usd: 4, self: false },
      { device: "me1", label: "this machine", usd: 2, self: true },
    ]);
  });
});

describe("a synced preference, in words", () => {
  it("labels every pref key", () => {
    for (const [k, c] of Object.entries(SYNC_KEYS)) if (c === "pref") expect(PREF_LABEL[k], k).toBeTruthy();
  });
  it("lists the changed fields of an object and nothing else", () => {
    const d = prefDiff(JSON.stringify({ enabled: true, binds: { palette: "Mod+K", run: "Mod+R" } }),
      JSON.stringify({ enabled: true, binds: { palette: "Mod+P", run: "Mod+R" } }));
    expect(d).toEqual({ lines: [{ path: "binds.palette", from: "Mod+K", to: "Mod+P" }], more: 0 });
  });
  it("reads a scalar and a removal", () => {
    expect(prefDiff("13", "14").lines).toEqual([{ path: "", from: "13", to: "14" }]);
    expect(prefDiff("manual", null).lines).toEqual([{ path: "", from: "manual", to: "—" }]);
  });
  it("caps a long diff and counts the rest", () => {
    const a: Record<string, number> = {}, b: Record<string, number> = {};
    for (let i = 0; i < 12; i++) { a[`k${i}`] = i; b[`k${i}`] = i + 1; }
    const d = prefDiff(JSON.stringify(a), JSON.stringify(b), 8);
    expect([d.lines.length, d.more]).toEqual([8, 4]);
  });
  it("drops a stored arrival of the wrong shape on its own", () => {
    const ok = { at: 1, key: "cc-sort", device: "d", lines: [] };
    expect(readArrivals(JSON.stringify([ok, { at: "x" }, null]))).toEqual([{ ...ok, more: 0 }]);
    expect(readArrivals("{")).toEqual([]);
  });
});

describe("the streams' reach", () => {
  it("keeps everything personal except the two team streams", () => {
    const team = Object.entries(STREAM_INFO).filter(([, i]) => i.scope === "team").map(([s]) => s).sort();
    expect(team).toEqual(["claims", "notes"]);
  });
});

describe("a work-log line knows what it covers", () => {
  it("reads a legacy string as covering an unknown set, which is trusted", () => {
    const d = narrowDigest("Shipped sync.");
    expect(d).toEqual({ line: "Shipped sync.", covers: null });
    expect(digestMisses(d!, ["a".repeat(40)])).toBe(false);
  });
  it("is redone only when this machine has a commit the line never saw", () => {
    const d = narrowDigest({ line: "x", covers: ["aaaaaaaaaaaa1234"] })!;
    expect(d.covers).toEqual(["aaaaaaaaaaaa"]);
    expect(digestMisses(d, ["aaaaaaaaaaaaffff"])).toBe(false);
    expect(digestMisses(d, ["aaaaaaaaaaaaffff", "bbbbbbbbbbbb0000"])).toBe(true);
  });
  it("grows its cover rather than replacing it, so two machines converge", () => {
    const d = narrowDigest({ line: "x", covers: ["aaaaaaaaaaaa"] })!;
    expect(digestCover(d, ["bbbbbbbbbbbbcc"])).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(digestCover(undefined, ["cccccccccccc00"])).toEqual(["cccccccccccc"]);
  });
  it("refuses an empty line, and a channel that is neither git nor the server", () => {
    expect(narrowDigest({ line: " " })).toBeNull();
    expect(narrowShare("server")).toBe("server");
    expect(narrowShare("off")).toBeNull();
  });
});
