import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./localstorage"; // must precede the subject import

// state.ts reads every preference at module scope, so a JSON.parse that throws there is a
// blank window before any UI exists. Each case seeds a key and evaluates the module again.
const boot = async () => { vi.resetModules(); return import("../src/state"); };

describe("state.ts boots whatever localStorage holds", () => {
  beforeEach(() => { store.clear(); });

  it("survives a truncated write of every key it reads at import time", async () => {
    for (const k of ["cc-agent-by-project", "cc-colors", "cc-favorites", "cc-proj-order", "cc-gh-account"]) {
      store.clear();
      store.set(k, '{"a":');     // what a crash mid-write leaves behind
      await expect(boot(), `${k} took the app down`).resolves.toBeTruthy();
    }
  });

  it("refuses a parseable value of the wrong shape, rather than passing it on", async () => {
    // Each of these parses; "null" only fails at the first property access, far from here.
    for (const raw of ["null", "[]", '"a string"', "42"]) {
      store.clear();
      store.set("cc-agent-by-project", raw);
      store.set("cc-colors", raw);
      const s = await boot();
      expect(s.agentByProject, `cc-agent-by-project = ${raw}`).toEqual({});
      expect(s.colorOverrides, `cc-colors = ${raw}`).toEqual({});
    }
  });

  it("keeps the good entries out of a half-corrupt map", async () => {
    store.set("cc-agent-by-project", JSON.stringify({ "/w/a": "codex", "/w/b": 7, "/w/c": null }));
    const s = await boot();
    expect(s.agentByProject).toEqual({ "/w/a": "codex" });
  });

  it("keeps a list a list, and drops entries that are not paths", async () => {
    store.set("cc-proj-order", JSON.stringify(["/w/a", 7, null, "/w/b"]));
    store.set("cc-favorites", JSON.stringify([{ path: "/w/a", name: "stale" }, { name: "no path" }, null]));
    const s = await boot();
    expect(s.projOrder).toEqual(["/w/a", "/w/b"]);
    // The name is re-derived from the path on load.
    expect(s.FAVORITES).toEqual([{ path: "/w/a", name: "a" }]);
  });

  it("refuses a GitHub account pin of the wrong shape", async () => {
    // The pin is passed to gh as an identity; a non-string reaching the backend is a rejected invoke.
    store.set("cc-gh-account", JSON.stringify({ "/w/a": "octo-work", "/w/b": 7 }));
    const s = await boot();
    expect(s.ghAccountByProject).toEqual({ "/w/a": "octo-work" });
    expect(s.ghAccountFor("/w/a")).toBe("octo-work");
    expect(s.ghAccountFor("/w/b")).toBeNull(); // null, not undefined: it goes straight to the backend
  });

  it("still reads a well-formed value", async () => {
    store.set("cc-agent-by-project", JSON.stringify({ "/w/epi": "codex" }));
    store.set("cc-proj-order", JSON.stringify(["/w/epi"]));
    const s = await boot();
    expect(s.agentByProject).toEqual({ "/w/epi": "codex" });
    expect(s.projOrder).toEqual(["/w/epi"]);
  });
});
