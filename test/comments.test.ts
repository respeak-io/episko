import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { density, langOf, type Lang } from "./density";

// The comment gate (CLAUDE.md § Comments): a comment states a rule, a why or a pointer in
// a few lines. Per file, no comment block longer than MAX_BLOCK lines, and no more than
// FREE + RATIO × code comment-only lines. Read source, never run it.
const MAX_BLOCK = 5;
const RATIO = 0.3;
const FREE = 15;

const ROOT = new URL("../", import.meta.url);
const list = (dir: string, ext: string) =>
  readdirSync(new URL(dir, ROOT)).filter((f) => f.endsWith(ext)).map((f) => dir + f);
const FILES = [
  ...list("src/", ".ts"),
  ...list("src/providers/", ".ts"),
  ...list("src-tauri/src/", ".rs"),
  ...list("test/", ".ts"),
  "src/styles.css",
  "index.html",
];

describe("the scanner tells comments from code", () => {
  const d = (s: string, lang: Lang = "ts") => density(s, lang);
  it("skips strings, templates and regex literals", () => {
    expect(d('const a = "http://x"; // c\n')).toEqual({ code: 1, comment: 0, longest: 0, longestAt: 0 });
    expect(d("const r = /\\/\\/[/]/g;\nconst s = a / b / c;\n")).toMatchObject({ code: 2, comment: 0 });
    expect(d("const t = `//${x /* y */}//`;\n")).toMatchObject({ code: 1, comment: 0 });
    expect(d("// a\n// b\nx();\n/* c\n d */\n")).toEqual({ code: 1, comment: 4, longest: 2, longestAt: 1 });
  });
  it("knows Rust's raw strings, char literals, lifetimes and nested blocks", () => {
    expect(d('let s = r#"// not"#; let c = \'"\'; fn f<\'a>(x: &\'a str) {}\n', "rs")).toMatchObject({ code: 1, comment: 0 });
    expect(d("/* a /* b */ still */ x;\n//! doc\n", "rs")).toEqual({ code: 1, comment: 1, longest: 1, longestAt: 2 });
  });
  it("reads CSS and HTML comments", () => {
    expect(d('a { content: "/* no */"; } /* yes */\n/* two\n   lines */\n', "css")).toEqual({ code: 1, comment: 2, longest: 2, longestAt: 2 });
    expect(d("<div><!-- x\n y --></div>\n<!-- z -->\n", "html")).toEqual({ code: 2, comment: 1, longest: 1, longestAt: 3 });
  });
});

describe("every source file keeps comments to what the code cannot say", () => {
  for (const f of FILES) {
    it(f, () => {
      const m = density(readFileSync(new URL(f, ROOT), "utf8"), langOf(f));
      const allowed = Math.floor(FREE + RATIO * m.code);
      expect(m.longest, `a ${m.longest}-line comment block at line ${m.longestAt}; the cap is ${MAX_BLOCK}`).toBeLessThanOrEqual(MAX_BLOCK);
      expect(m.comment, `${m.comment} comment lines on ${m.code} code lines; ${allowed} allowed`).toBeLessThanOrEqual(allowed);
    });
  }
});
