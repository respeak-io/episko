import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// The IPC argument contract: `invoke("x", {…})` and `#[tauri::command] fn x(…)` are two
// halves of one signature nothing else checks, and Tauri rejects the whole call on one
// missing key. Both halves are parsed out of source and compared in both directions.

const SRC = new URL("../src/", import.meta.url);
const RS = new URL("../src-tauri/src/", import.meta.url);

const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8");
const tsFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const rsFiles = readdirSync(RS).filter((f) => f.endsWith(".rs"));

// ---------- the Rust half ----------

// Injected by Tauri by type, so they never appear in the JS argument object.
const INJECTED = /\b(AppHandle|State\s*<|Window|WebviewWindow|Runtime|Request<|Channel<)/;

interface Cmd { name: string; required: string[]; optional: string[]; file: string }

/** Split a parameter list on top-level commas — types carry their own `<>` and `()`. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Read from `from` (an index of `(`) to its matching `)`. */
function parenBody(s: string, from: number): string {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (depth === 0) return s.slice(from + 1, i); }
  }
  throw new Error("unbalanced parentheses in a #[tauri::command] signature");
}

function rustCommands(): Map<string, Cmd> {
  const cmds = new Map<string, Cmd>();
  for (const f of rsFiles) {
    const src = read(RS, f);
    // Both forms: `#[tauri::command]` and the `(async)` variant that runs on a pool.
    for (const m of src.matchAll(/#\[tauri::command(?:\([^)]*\))?\]/g)) {
      const after = src.slice(m.index!);
      const sig = /\bfn\s+([a-z0-9_]+)\s*\(/.exec(after);
      if (!sig) continue;
      const name = sig[1];
      const params = splitParams(parenBody(after, sig.index! + sig[0].length - 1));
      const required: string[] = [], optional: string[] = [];
      for (const p of params) {
        const c = p.indexOf(":");
        if (c < 0) continue;
        const pname = p.slice(0, c).trim().replace(/^mut\s+/, "");
        const ptype = p.slice(c + 1).trim();
        if (INJECTED.test(ptype) || pname.startsWith("_")) continue;
        // Tauri v2 accepts a camelCase key for a snake_case parameter.
        const key = pname.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
        (ptype.startsWith("Option<") ? optional : required).push(key);
      }
      cmds.set(name, { name, required, optional, file: f });
    }
  }
  return cmds;
}

// ---------- the TypeScript half ----------

interface Site { cmd: string; keys: string[]; file: string; literal: boolean }

/** How far a comment starting at `i` runs, or 0 if none does. Both scanners below skip
 *  comments: a `// … `pty-exit` …` line above an argument would otherwise open a template
 *  string that swallows the rest of the object, and the test fails for the wrong reason. */
function commentEnd(s: string, i: number): number {
  if (s[i] === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); return nl < 0 ? s.length : nl; }
  if (s[i] === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); return end < 0 ? s.length : end + 2; }
  return 0;
}

/** Read from `from` (an index of `{`) to its matching `}`, ignoring string contents. */
function braceBody(s: string, from: number): string {
  let depth = 0, quote = "";
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    const c = commentEnd(s, i);
    if (c) { i = c - 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return s.slice(from + 1, i); }
  }
  throw new Error("unbalanced braces in an invoke() argument object");
}

/** The top-level keys of an object literal body — `a: x`, `a,` and `a` alike. */
function objectKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0, quote = "", atKey = true, cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    const c = commentEnd(body, i);
    if (c) { i = c - 1; cur = ""; continue; }   // a comment names no key
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if ("{([".includes(ch)) { depth++; continue; }
    if ("})]".includes(ch)) { depth--; continue; }
    if (depth > 0) continue;
    if (ch === ",") { if (atKey && cur.trim()) keys.push(cur.trim()); cur = ""; atKey = true; continue; }
    if (ch === ":") { if (atKey && cur.trim()) keys.push(cur.trim()); cur = ""; atKey = false; continue; }
    cur += ch;
  }
  if (atKey && cur.trim()) keys.push(cur.trim());
  return keys.filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
}

function invokeSites(): Site[] {
  const sites: Site[] = [];
  for (const f of tsFiles) {
    const src = read(SRC, f);
    for (const m of src.matchAll(/\binvoke\s*(?:<[^>()]*>)?\s*\(\s*"([a-z0-9_]+)"/g)) {
      const cmd = m[1];
      const rest = src.slice(m.index! + m[0].length);
      const nextComma = /^\s*,/.exec(rest);
      if (!nextComma) { sites.push({ cmd, keys: [], file: f, literal: true }); continue; }
      const afterComma = rest.slice(nextComma[0].length);
      const open = /^\s*\{/.exec(afterComma);
      // A non-literal argument (a variable, a spread) can't be checked from source.
      if (!open) { sites.push({ cmd, keys: [], file: f, literal: false }); continue; }
      const start = afterComma.indexOf("{", open[0].length - 1);
      sites.push({ cmd, keys: objectKeys(braceBody(afterComma, start)), file: f, literal: true });
    }
  }
  return sites;
}

// ---------- the comparison ----------

const cmds = rustCommands();
const sites = invokeSites();
const checkable = sites.filter((s) => s.literal && cmds.has(s.cmd));

describe("the invoke() ↔ #[tauri::command] argument contract", () => {
  it("finds both halves to compare", () => {
    expect(cmds.size).toBeGreaterThan(40);
    expect(sites.length).toBeGreaterThan(60);
    expect(checkable.length).toBeGreaterThan(50);
  });

  it("invokes no command the backend does not define", () => {
    // A renamed or deleted command. The invoke rejects with "command not found".
    const unknown = sites.filter((s) => !cmds.has(s.cmd)).map((s) => `${s.file}: ${s.cmd}`);
    expect([...new Set(unknown)]).toEqual([]);
  });

  it("passes EVERY required argument — a missing one rejects the whole call", () => {
    const bad: string[] = [];
    for (const s of checkable) {
      const missing = cmds.get(s.cmd)!.required.filter((k) => !s.keys.includes(k));
      if (missing.length) bad.push(`${s.file}: ${s.cmd} is missing [${missing.join(", ")}]`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("passes NO argument the command does not take", () => {
    // A stray key is not itself fatal, but it is always a sign the two halves have drifted.
    const bad: string[] = [];
    for (const s of checkable) {
      const c = cmds.get(s.cmd)!;
      const known = new Set([...c.required, ...c.optional]);
      const extra = s.keys.filter((k) => !known.has(k));
      if (extra.length) bad.push(`${s.file}: ${s.cmd} passes unknown [${extra.join(", ")}]`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("says what it could not check, rather than reading as full coverage", () => {
    // Zero is not required; this keeps the blind spot small enough to know about.
    const opaque = sites.filter((s) => !s.literal).map((s) => `${s.file}: ${s.cmd}`);
    expect(opaque.length).toBeLessThan(5);
  });
});

// ---------- what a command RETURNS ----------
// A return shape has the same two authors: `#[derive(Serialize)] struct BgLog` decides the
// wire keys, `interface BgRead` what is read back, and serde camelCases a snake_case field
// only under `rename_all`. Compared in both directions, and against a written-down list.

/** Tauri v2 hands a snake_case field to the frontend camelCased — but only via serde. */
const camel = (s: string) => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** Case-insensitive sort: a plain `.sort()` puts `noRoot` before `none`, which nobody can check by eye. */
const sorted = (xs: string[]) => [...xs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

/** Read from `from` (an index of `{`) to its matching `}`, dropping comments and strings:
 *  an apostrophe or a `{` in a doc comment would otherwise end the body early. */
function declBody(s: string, from: number): string {
  let depth = 0, out = "";
  for (let i = from; i < s.length; i++) {
    if (s[i] === "/" && s[i + 1] === "/") { const nl = s.indexOf("\n", i); if (nl < 0) break; i = nl; out += "\n"; continue; }
    if (s[i] === "/" && s[i + 1] === "*") { const end = s.indexOf("*/", i + 2); if (end < 0) break; i = end + 1; continue; }
    if (s[i] === '"') { const end = s.indexOf('"', i + 1); if (end < 0) break; i = end; continue; }
    if (s[i] === "{") { depth++; if (depth === 1) continue; }
    else if (s[i] === "}" && --depth === 0) return out;
    out += s[i];
  }
  throw new Error("unbalanced braces in a declaration test/ipc.test.ts reads");
}

/** The comment-free body of the declaration `head` matches, or "" when it is gone. */
function bodyOf(src: string, head: RegExp): string {
  const m = head.exec(src);
  return m ? declBody(src, m.index + m[0].length - 1) : "";
}

/** `name: Type,` — the field names of a plain Rust struct, attributes and all skipped. */
const rustFields = (body: string): string[] =>
  [...body.matchAll(/^[ \t]*(?:pub(?:\([a-z]+\))?[ \t]+)?([a-z_][A-Za-z0-9_]*)[ \t]*:/gm)].map((m) => m[1]);

/** `name: Type;` — the property names of a TS interface, one per line or all on one. */
const tsFields = (body: string): string[] =>
  [...body.matchAll(/(?:^|[;,])[ \t]*(?:readonly[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*\??[ \t]*:/gm)].map((m) => m[1]);

/** The members of a `export type X = "a" | "b";` union, in declaration order. */
const tsUnion = (src: string, name: string): string[] => {
  const m = new RegExp(`export\\s+type\\s+${name}\\s*=([^;]*);`).exec(src);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
};

/** A fieldless Rust enum, wherever in the backend it was declared, plus whether the
 *  attributes immediately above it rename its variants for the wire. */
function rustEnum(name: string): { variants: string[]; renamed: boolean } {
  for (const f of rsFiles) {
    const src = read(RS, f);
    const head = new RegExp(`\\benum\\s+${name}\\s*\\{`).exec(src);
    if (!head) continue;
    const body = declBody(src, head.index + head[0].length - 1);
    return {
      variants: body.split(",").map((p) => p.trim()).filter((p) => /^[A-Z][A-Za-z0-9]*$/.test(p)),
      renamed: /rename_all\s*=\s*"camelCase"/.test(src.slice(Math.max(0, head.index - 120), head.index)),
    };
  }
  return { variants: [], renamed: false };
}

const PTY = read(RS, "pty.rs");
const SERVERS = read(SRC, "servers.ts");
const TYPES = read(SRC, "types.ts");

const bgLogHead = /pub\(crate\)\s+struct\s+BgLog\s*\{/.exec(PTY);
const bgLogFields = bgLogHead ? rustFields(declBody(PTY, bgLogHead.index + bgLogHead[0].length - 1)) : [];
// The derives and `#[serde(…)]` attributes above the struct, and nothing else.
const bgLogAttrs = bgLogHead ? PTY.slice(Math.max(0, bgLogHead.index - 120), bgLogHead.index) : "";
const bgReadFields = tsFields(bodyOf(SERVERS, /export\s+interface\s+BgRead\s*\{/));
const bgMiss = rustEnum("BgMiss");

describe("what a command returns", () => {
  it("finds both halves to compare", () => {
    // Floors, not equalities: a field added to both sides at once is the change to let through.
    expect(bgLogFields.length).toBeGreaterThanOrEqual(9);
    expect(bgReadFields.length).toBeGreaterThanOrEqual(8);
  });

  it("renames its multi-word fields on the way out", () => {
    // Without `rename_all`, `root_rank` arrives under that name and every `read.rootRank` is undefined.
    const unrenamed = /rename_all\s*=\s*"camelCase"/.test(bgLogAttrs)
      ? []
      : bgLogFields.filter((f) => f.includes("_"));
    expect(unrenamed).toEqual([]);
  });

  it("names in BgRead exactly what BgLog serializes, bar `missing`", () => {
    // `missing` stays outside `BgRead` and is intersected at the invoke site, so `applyBgLog`
    // cannot decide what a miss means; that is `applyBgMiss`'s question.
    expect(sorted(bgLogFields.map(camel).filter((f) => f !== "missing"))).toEqual(sorted(bgReadFields));
  });

  it("keeps the wire keys written down, so a rename on both sides is still a change", () => {
    // A rename on both sides passes the join above and breaks every other reader of the shape.
    expect(sorted(bgLogFields.map(camel))).toEqual(
      ["discovered", "len", "missing", "path", "reason", "rootRank", "text", "tried", "unchanged"],
    );
  });

  it("gives BgMissReason exactly BgMiss's variants", () => {
    // `reason`'s values are the contract: `bgRetire` fires on `notYet` and never on `noRoot`.
    // The enum needs its own `rename_all`, or serde puts `BadId` on a wire that says `badId`.
    expect(bgMiss.renamed).toBe(true);
    const wire = sorted(bgMiss.variants.map((v) => v[0].toLowerCase() + v.slice(1)));
    expect(wire).toEqual(sorted(tsUnion(TYPES, "BgMissReason")));
    expect(wire).toEqual(["ambiguous", "badId", "none", "noRoot", "notYet", "unreadable"]);
  });
});
