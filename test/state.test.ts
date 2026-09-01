import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./localstorage"; // must precede the subject import

// `state.ts` is the module every other module imports, and it reads its preferences at
// MODULE SCOPE. So a `JSON.parse` that throws in here is not a lost preference — it is a
// blank window, before any UI exists to tell you why or to clear the key that did it.
//
// A stored value is not trustworthy just because we wrote it: a crash mid-write leaves
// truncated JSON, and these are exactly the keys people hand-edit. Same staging as
// `usage.test.ts`'s "ignores a corrupt baseline key rather than failing to boot" — seed
// the key, evaluate the module again, and assert it came up.
//
// The shapes below are chosen because each one gets PAST a plain `JSON.parse` and only
// fails later, at the first property access, far away from here. `"null"` and `"[]"`
// parse perfectly.
const boot = async () => { vi.resetModules(); return import("../src/state"); };

describe("state.ts boots whatever localStorage holds", () => {
  beforeEach(() => { store.clear(); });

  it("survives a truncated write of every key it reads at import time", async () => {
    for (const k of ["cc-agent-by-project", "cc-colors", "cc-favorites", "cc-proj-order", "cc-title"]) {
      store.clear();
      store.set(k, '{"a":');     // what a crash mid-write leaves behind
      await expect(boot(), `${k} took the app down`).resolves.toBeTruthy();
    }
  });

  it("refuses a parseable value of the wrong shape, rather than passing it on", async () => {
    // Each of these parses, so only a shape check catches it. `null` is the sharp one:
    // `agentByProject[key]` on it throws at the project menu, not here.
    for (const raw of ["null", "[]", '"a string"', "42"]) {
      store.clear();
      store.set("cc-agent-by-project", raw);
      store.set("cc-colors", raw);
      const s = await boot();
      expect(s.agentByProject, `cc-agent-by-project = ${raw}`).toEqual({});
      expect(s.colorOverrides, `cc-colors = ${raw}`).toEqual({});
    }
  });

  it("refuses a cc-title whose extra is not a string", async () => {
    // The value is spread into a compiled RegExp character class on every title change.
    // `null` and `[]` both parse; only a shape check catches them, and the failure
    // would land in the terminal's OSC handler rather than here.
    for (const raw of ["null", "[]", '{"extra":7}', '{"extra":null}', '"nope"']) {
      store.clear();
      store.set("cc-title", raw);
      const s = await boot();
      expect(s.titlePrefs, `cc-title = ${raw}`).toEqual({ scrub: true, extra: "" });
    }
  });

  it("still reads a well-formed cc-title, and defaults the scrub to on", async () => {
    store.set("cc-title", JSON.stringify({ extra: "◐-◗" }));
    expect((await boot()).titlePrefs).toEqual({ scrub: true, extra: "◐-◗" });
    store.set("cc-title", JSON.stringify({ scrub: false, extra: "§" }));
    expect((await boot()).titlePrefs).toEqual({ scrub: false, extra: "§" });
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
    // The name is re-derived from the path on load, which is the existing self-heal.
    expect(s.FAVORITES).toEqual([{ path: "/w/a", name: "a" }]);
  });

  it("still reads a well-formed value", async () => {
    // The other half of the contract: narrowing must not throw the good data away.
    store.set("cc-agent-by-project", JSON.stringify({ "/w/epi": "codex" }));
    store.set("cc-proj-order", JSON.stringify(["/w/epi"]));
    const s = await boot();
    expect(s.agentByProject).toEqual({ "/w/epi": "codex" });
    expect(s.projOrder).toEqual(["/w/epi"]);
  });
});
