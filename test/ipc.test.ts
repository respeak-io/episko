import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

// The IPC argument contract, made impossible to break silently.
//
// `invoke("gh_claim", {…})` and `#[tauri::command] fn gh_claim(…)` are two halves of one
// signature with nothing between them that can check the join. Tauri deserializes the
// argument object at runtime and rejects the WHOLE call on one missing key — so an
// invoke that forgets an argument does not degrade, it fails completely, and it fails
// with a rejected promise that a `.catch(() => {})` or a `dlog` warning swallows whole.
//
// Nothing else catches this. `tsc` sees `invoke`'s parameter as `InvokeArgs`, an index
// signature, so every object literal type-checks. Every unit test is happy — the pure
// modules underneath are fine. `cargo` is happy — the command compiles. The feature is
// simply dead on arrival, and only running the app and reading a log finds out.
//
// That is exactly how claiming shipped: `gh_claim` was invoked without its `body`
// argument (and with a `pushBranch` the command never took), so for three releases
// every dispatch was rejected before `gh` ran — no assignee, no label, no comment —
// while the dashboard said "Started on #232". `gh_release` had the same defect and was
// even quieter, behind a bare `.catch(() => {})`. This test is why that cannot recur.
//
// Same shape as ./dispatch: parse both halves out of the source and compare them, in
// both directions, because each direction is a different bug.

const SRC = new URL("../src/", import.meta.url);
const RS = new URL("../src-tauri/src/", import.meta.url);

const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8");
const tsFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const rsFiles = readdirSync(RS).filter((f) => f.endsWith(".rs"));

// ---------- the Rust half ----------

/// Tauri injects these by TYPE, not by name — they never appear in the JS argument
/// object, so requiring them would fail every command that takes state or a window.
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
    // `invoke("cmd"` and `invoke<T>("cmd"`, wherever they appear.
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
    // The failing case reads: dashboard.ts: gh_claim is missing [body].
    const bad: string[] = [];
    for (const s of checkable) {
      const missing = cmds.get(s.cmd)!.required.filter((k) => !s.keys.includes(k));
      if (missing.length) bad.push(`${s.file}: ${s.cmd} is missing [${missing.join(", ")}]`);
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("passes NO argument the command does not take", () => {
    // A stray key is not itself fatal, but it is always a sign the two halves have
    // drifted — `pushBranch` sat in the gh_claim call for a command that never had it.
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
    // A non-literal argument object is unverifiable from source. Zero is not required —
    // this asserts the blind spot stays small enough to know about.
    const opaque = sites.filter((s) => !s.literal).map((s) => `${s.file}: ${s.cmd}`);
    expect(opaque.length).toBeLessThan(5);
  });
});

// ---------- what a command RETURNS ----------
//
// The argument object is only half of an invoke. A command's RETURN shape has the same
// two authors and nothing between them either: `#[derive(serde::Serialize)] struct BgLog`
// decides the keys that go on the wire, `interface BgRead` in servers.ts decides the keys
// the frontend reads back, and serde spells a `snake_case` field camelCase only if
// somebody remembered `rename_all`. Every `BgLog` field was a single word until
// `root_rank` — that, and nothing else, is why this has never bitten.
//
// It fails the way the argument contract does: silently and completely. A `root_rank`
// that arrives under its Rust name leaves `read.rootRank` `undefined`, every rule reading
// it answers "no", the row draws its empty state for the life of the session — and `tsc`
// is happy (the interface promises `number`, and the invoke boundary is a cast), vitest
// is happy (the pure modules underneath are fine) and cargo is happy (the struct
// compiles). That is the exact shape of the bug the background-log probe exists to fix,
// reintroduced by its own fix.
//
// So both halves are read out of the source and compared in both directions, and once
// more against a written-down list, so that a rename on BOTH sides is still a decision
// somebody has to make on purpose.

/** Tauri v2 hands a snake_case field to the frontend camelCased — but only via serde. */
const camel = (s: string) => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());

/** Sorted for comparison, ignoring case. A plain `.sort()` is by UTF-16 code unit, which
 *  puts `noRoot` before `none` — true, and useless: the written-down lists below are read
 *  by people, and a list nobody can check by eye is a list nobody checks. */
const sorted = (xs: string[]) => [...xs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

/**
 * Read from `from` (an index of `{`) to its matching `}`, dropping comments and the
 * insides of string literals as it goes. Both declarations below are documented in
 * prose, and prose is exactly what breaks a naive scan: one apostrophe in "Claude's"
 * or one `{` in an example would end the body somewhere in the middle of it. Rust and
 * TypeScript spell comments and strings the same way, so one scanner does both.
 */
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
/// The derives and `#[serde(…)]` attributes sitting above the struct, and nothing else.
const bgLogAttrs = bgLogHead ? PTY.slice(Math.max(0, bgLogHead.index - 120), bgLogHead.index) : "";
const bgReadFields = tsFields(bodyOf(SERVERS, /export\s+interface\s+BgRead\s*\{/));
const bgMiss = rustEnum("BgMiss");

describe("what a command returns", () => {
  it("finds both halves to compare", () => {
    // A regex that quietly stops matching must not read as agreement. Both counts are
    // floors rather than equalities: this test is here to police the JOIN, and a field
    // added to both sides at once is the one change it should let through.
    expect(bgLogFields.length).toBeGreaterThanOrEqual(9);
    expect(bgReadFields.length).toBeGreaterThanOrEqual(8);
  });

  it("renames its multi-word fields on the way out", () => {
    // Without `rename_all`, `root_rank` reaches the frontend under that name and every
    // `read.rootRank` in the app is `undefined` — with all three gates still green.
    const unrenamed = /rename_all\s*=\s*"camelCase"/.test(bgLogAttrs)
      ? []
      : bgLogFields.filter((f) => f.includes("_"));
    expect(unrenamed).toEqual([]);
  });

  it("names in BgRead exactly what BgLog serializes, bar `missing`", () => {
    // `missing` is deliberately OUTSIDE `BgRead` and intersected at the invoke site, so
    // that `applyBgLog` cannot reach it and decide for itself what a miss means — that
    // is `applyBgMiss`'s question. Every other key is the same key on both sides.
    expect(sorted(bgLogFields.map(camel).filter((f) => f !== "missing"))).toEqual(sorted(bgReadFields));
  });

  it("keeps the wire keys written down, so a rename on both sides is still a change", () => {
    // The comparison above passes happily if the two halves are renamed together in one
    // commit — which is the moment every OTHER reader of this shape (the debug snapshot,
    // the `bglog-health` payload, a hand-written fixture) silently stops matching.
    expect(sorted(bgLogFields.map(camel))).toEqual(
      ["discovered", "len", "missing", "path", "reason", "rootRank", "text", "tried", "unchanged"],
    );
  });

  it("gives BgMissReason exactly BgMiss's variants", () => {
    // `reason` is the one field whose VALUES are a contract as well as its name, and it
    // is the field the whole feature turns on: `bgRetire` fires on `notYet` and must
    // never fire on `noRoot`. A variant Rust can emit and TypeScript has never heard of
    // lands as a `reason` that matches nothing, and the record neither retires nor
    // reports itself blind. The enum needs its own `rename_all` for the same reason the
    // struct does — plain serde would put `BadId` on a wire that says `badId`.
    expect(bgMiss.renamed).toBe(true);
    const wire = sorted(bgMiss.variants.map((v) => v[0].toLowerCase() + v.slice(1)));
    expect(wire).toEqual(sorted(tsUnion(TYPES, "BgMissReason")));
    expect(wire).toEqual(["ambiguous", "badId", "none", "noRoot", "notYet", "unreadable"]);
  });
});
