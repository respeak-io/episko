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
