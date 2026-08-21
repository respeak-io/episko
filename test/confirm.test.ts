import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// The two joins ./confirm depends on, neither of which any other check can see.
//
// ./confirm exists to keep every yes/no question inside the app's own skin, and it can
// only do that if it is the ONLY answer to "ask the user something". That is a property
// of the whole `src/` tree, not of ./confirm, so nothing in ./confirm can enforce it and
// no type error announces the lapse: `import { ask } from "@tauri-apps/plugin-dialog"`
// compiles, runs, and looks exactly like the local one at the call site. The failure is
// visual and one dialog wide — a single native box in a release otherwise free of them,
// which is the kind of thing you only notice on the machine that happens to hit it.
//
// The second half is the same hazard ./dispatch guards for clicks. This module is DOM-
// owning and untested by design, so its `$("cfmYes")` lookups are checked by nothing;
// `$` non-null-asserts, so a renamed or dropped id in index.html throws at *open* time,
// under the `await ask(...)` of a destructive action, with the caller's promise left
// pending forever and the app looking hung. Comparing the two halves as source is the
// only cheap way to have that fail in CI instead.

const SRC = new URL("../src/", import.meta.url);
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const tsFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");

describe("the OS dialog stays gone", () => {
  it("has no module asking a question through tauri-plugin-dialog", () => {
    // `open` is deliberately still allowed: that one is the OS *file browser* (./actions
    // adds a project folder with it, ./icons picks a logo), and an in-app imitation of a
    // file picker is strictly worse than the real thing. Everything else the plugin
    // exports — ask, confirm, message, save — draws a native box and belongs to ./confirm.
    const NATIVE = /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-dialog"/g;
    const offenders: string[] = [];
    for (const f of tsFiles) {
      for (const m of read(f).matchAll(NATIVE)) {
        const named = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const n of named) if (n !== "open") offenders.push(`${f}: ${n}`);
      }
    }
    // The failing case reads: `src/worktree.ts: ask` is back on the native plugin.
    expect(offenders).toEqual([]);
  });

  it("routes every caller through ./confirm instead", () => {
    const callers = tsFiles.filter((f) => f !== "confirm.ts" && /\bawait ask\(/.test(read(f)));
    expect(callers.length).toBeGreaterThan(5);
    for (const f of callers) expect(read(f)).toContain('from "./confirm"');
  });
});

describe("./confirm's element ids", () => {
  it("are all declared in index.html", () => {
    const src = read("confirm.ts");
    const ids = [...src.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(5);
    const missing = [...new Set(ids)].filter((id) => !HTML.includes(`id="${id}"`));
    // The failing case reads: `cfmHintOk` is looked up but nothing declares it.
    expect(missing).toEqual([]);
  });

  it("sit above every other overlay, and on a backdrop of their own", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const z = (sel: string) => {
      const rule = new RegExp(`^\\${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "m").exec(css);
      if (!rule) throw new Error(`no z-index rule for ${sel}`);
      return +rule[1];
    };
    // Not a style preference: a confirmation opens *over* #wtDlg and #mgrDlg, so a
    // lower stack order would leave the question painted behind the dialog that asked
    // it — visible enough to click through, and answerable by nothing.
    const every = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]);
    expect(Math.max(...every)).toBe(z(".cfm"));
    expect(z(".cfm-scrim")).toBeLessThan(z(".cfm"));
    // Its own backdrop, never the shared one — ./dom's `dropScrim` would otherwise have
    // to learn about a dialog that outranks everything it lists.
    expect(read("confirm.ts")).not.toContain('$("scrim")');
  });
});
