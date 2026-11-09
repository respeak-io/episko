import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CARRY, PREVIEW_PREFIX, carryOf, leaves, nextMark, overlay, type Store } from "../src/channel";
import { SYNC_KEYS } from "../src/sync";

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  const s: Store = { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
  return { m, s };
};

// sync.test.ts holds SYNC_KEYS against every `"cc-` literal in src/, so matching it is coverage.
describe("every key is a decision", () => {
  it("classifies exactly the keys sync does", () => {
    expect(Object.keys(CARRY).sort()).toEqual(Object.keys(SYNC_KEYS).sort());
  });
  it("keeps every synced setting to the preview, and every synced record shared", () => {
    for (const [k, c] of Object.entries(SYNC_KEYS)) {
      if (c === "pref") expect(carryOf(k), k).toBe("own");
      if (c === "account" || c === "roster") expect(carryOf(k), k).toBe("shared");
    }
  });
  it("shares the records a return to stable must find", () => {
    for (const k of ["cc-usage", "cc-restore", "cc-handoff", "cc-notes", "cc-claude-accounts", "cc-sync-stamps", "cc-channel"])
      expect(carryOf(k), k).toBe("shared");
  });
  it("treats an unlisted key as stable does", () => {
    expect(carryOf("cc-something-new")).toBe("shared");
  });
});

describe("a preview's view of the store", () => {
  it("is the store itself on stable", () => {
    const { s } = mem();
    expect(overlay(s, "stable")).toBe(s);
  });
  it("reads stable's setting until it writes its own, and never writes stable's", () => {
    const { m, s } = mem({ "cc-sort": "manual" });
    const o = overlay(s, "preview");
    expect(o.get("cc-sort")).toBe("manual");
    o.set("cc-sort", "recent");
    expect(o.get("cc-sort")).toBe("recent");
    expect(m.get("cc-sort")).toBe("manual");
    expect(m.get(PREVIEW_PREFIX + "cc-sort")).toBe("recent");
  });
  it("hides stable's value after a removal, and leaves it in place", () => {
    const { m, s } = mem({ "cc-sort": "manual" });
    const o = overlay(s, "preview");
    o.remove("cc-sort");
    expect(o.get("cc-sort")).toBeNull();
    expect(m.get("cc-sort")).toBe("manual");
    o.set("cc-sort", "recent");
    expect(o.get("cc-sort")).toBe("recent");
  });
  it("sees stable's later change to a setting the preview never touched", () => {
    const { m, s } = mem();
    const o = overlay(s, "preview");
    m.set("cc-sound", "off");
    expect(o.get("cc-sound")).toBe("off");
  });
  it("writes a shared key, an unlisted one and a foreign one straight through", () => {
    const { m, s } = mem();
    const o = overlay(s, "preview");
    for (const k of ["cc-usage", "cc-something-new", "theme"]) {
      o.set(k, "1");
      expect(m.get(k), k).toBe("1");
      o.remove(k);
      expect(m.has(k), k).toBe(false);
    }
  });
});

describe("what leaves the machine", () => {
  it("never sends a preview's own setting, and changes nothing on stable", () => {
    expect(leaves("cc-sort", "preview")).toBe(false);
    expect(leaves("cc-usage", "preview")).toBe(true);
    expect(leaves("cc-sort", "stable")).toBe(true);
  });
});

describe("the channel mark", () => {
  it("keeps when a channel was entered while it stays, and restarts on a switch", () => {
    const a = nextMark(null, "preview", "0.39.1-preview.4", 100);
    expect(a).toEqual({ channel: "preview", version: "0.39.1-preview.4", since: 100 });
    expect(nextMark(a, "preview", "0.39.1-preview.5", 200).since).toBe(100);
    expect(nextMark(a, "stable", "0.39.0", 300)).toEqual({ channel: "stable", version: "0.39.0", since: 300 });
    expect(nextMark({ channel: "preview", since: "x" }, "preview", "v", 400).since).toBe(400);
  });
});

// The hook only works if it runs before the first read and under synclink's own hook.
describe("load order", () => {
  it("is main.ts's first import", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main.match(/^import\s.*$/m)?.[0]).toBe('import "./channelhook";');
  });
});
