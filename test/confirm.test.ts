import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// Two joins ./confirm depends on that no type error can see: it must be the ONLY caller of
// the native dialog plugin anywhere in src/ (an OS box elsewhere compiles fine), and every
// id it `$()`s must exist in index.html, or `await ask()` throws and leaves the caller hung.

const SRC = new URL("../src/", import.meta.url);
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const tsFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const read = (f: string) => readFileSync(new URL(f, SRC), "utf8");

describe("the OS dialog stays gone", () => {
  it("has no module asking a question through tauri-plugin-dialog", () => {
    // `open` stays allowed: it is the OS file browser, and imitating it in-app is worse.
    // Everything else the plugin exports (ask, confirm, message, save) draws a native box.
    const NATIVE = /import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-dialog"/g;
    const offenders: string[] = [];
    for (const f of tsFiles) {
      for (const m of read(f).matchAll(NATIVE)) {
        const named = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const n of named) if (n !== "open") offenders.push(`${f}: ${n}`);
      }
    }
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
    expect(missing).toEqual([]);
  });

  it("sit above every other overlay, and on a backdrop of their own", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const z = (sel: string) => {
      const rule = new RegExp(`^\\${sel}\\s*\\{[^}]*z-index:\\s*(\\d+)`, "m").exec(css);
      if (!rule) throw new Error(`no z-index rule for ${sel}`);
      return +rule[1];
    };
    // A confirmation opens over the dialog that asked it; a lower z-index paints the question behind it.
    const every = [...css.matchAll(/z-index:\s*(\d+)/g)].map((m) => +m[1]);
    expect(Math.max(...every)).toBe(z(".cfm"));
    expect(z(".cfm-scrim")).toBeLessThan(z(".cfm"));
    // Its own backdrop, never the shared one, or ./dom's `dropScrim` would have to learn about it.
    expect(read("confirm.ts")).not.toContain('$("scrim")');
  });
});
