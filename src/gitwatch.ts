// What a session's tool activity implies about git: re-read now (`gitMutates`), and which
// checkout its work lands in (drift). A trigger, not an authority, so `VERBS` leans inclusive.

import type { Drift } from "./types";

const VERBS ="checkout|switch|worktree|branch|merge|rebase|reset|pull|stash";

// Matched anywhere; the bounded gap lets `git -C path checkout` through without running on.
const GIT_MUTATES = new RegExp(
  `\\bgit\\b[\\s\\S]{0,80}?\\b(${VERBS})\\b` +
  `|\\bgh\\b[\\s\\S]{0,40}?\\bpr\\s+checkout\\b`,
);

export function gitMutates(cmd: unknown): boolean {
  return typeof cmd === "string" && GIT_MUTATES.test(cmd);
}

// ---------- drift: the agent is working in a checkout it wasn't launched in ----------
// Two signals (docs/worktrees.md): `cwd` follows Claude's own EnterWorktree and may only
// SET a drift; a write (or a shell-only agent's `cd`) catches the sibling worktree Claude
// pins cwd away from, and LATCHES, since the agent keeps reading its old checkout.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Levels the raw side (`cwd`, `file_path`, `workdir`) against Rust's `norm_path`. Case is
// folded too: `norm_path` upper-cases a drive letter Claude may send lower-case. Symlinks
// cannot be resolved here, which is what `checkoutDrift` failing closed is for.
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function under(dir: string, path: string): boolean {
  const d = norm(dir), p = norm(path);
  return d !== "" && (p === d || p.startsWith(d + "/"));
}
export function sameDir(a: string, b: string): boolean {
  return norm(a) !== "" && norm(a) === norm(b);
}

type Checkout = { path: string; branch: string; exists: boolean };

// Longest match wins: a worktree may sit inside its own repo (`repo/wt/feature`).
function checkoutOf(path: string, roster: readonly Checkout[]): Checkout | null {
  let best: Checkout | null = null;
  for (const w of roster) {
    if (!w.exists || !under(w.path, path)) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

// Which checkout a pane's directory is in, for ./grouping. An exact match keeps the caller's
// spelling, or a session key stops matching the project path it is compared against.
export function checkoutDir(path: string, roster: readonly Checkout[]): string {
  const home = checkoutOf(path, roster);
  return home && norm(home.path) !== norm(path) ? home.path : path;
}

// Only a checkout the roster knows counts: a false positive here offers to move a live
// session. Both sides resolve to a checkout first, so a session started in a subfolder has
// not drifted within its own; a home that cannot be placed fails closed to no drift.
function checkoutDrift(workdir: string, path: unknown, roster: readonly Checkout[]) {
  if (typeof path !== "string" || !path.trim()) return null;
  const home = checkoutOf(workdir, roster);
  if (!home) return null;
  const target = checkoutOf(path, roster);
  if (!target || target.path === home.path) return null;
  return { dir: target.path, branch: target.branch };
}

// ---------- the Bash arm: an agent that calls no write tool at all ----------
// A shell-first agent's cwd is pinned and WRITE_TOOLS never fires, so its `cd` stands in
// for a write, bounded to a write-shaped command that names exactly one placeable directory.

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function field(input: unknown, key: "file_path" | "command"): string | null {
  if (!input || typeof input !== "object") return null;
  return str((input as Record<string, unknown>)[key]);
}

// Keywords, not a parser, and shy where `VERBS` is loose: a false match shows a wrong branch.
const BASH_WRITES = [
  // Whitespace before `>` (else `=>` and `2>&1` match) and a `.` or `/` in the target
  // (else `x > 12` inside a heredoc body does); `/dev/null` is nobody's file.
  /(^|\s)>{1,2}\s*(?!&)(?!\/dev\/null\b)[^\s;&|<>]*[.\/][^\s;&|<>]*/,
  // Python `open(p,"w")` / `.write(`; stdout/stderr prints are not writes.
  /open\([^)]*['"][wax]|(?<!stdout)(?<!stderr)\.write(_text|_bytes)?\(/,
  /\b(sed|perl)\s+(-[A-Za-z]+\s+)*-[A-Za-z]*i\b/, // in-place: `sed -i`, `perl -pi -e`
];

const CD_TARGET = /(?:^|[\n;&|(])\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function collapse(p: string): string {
  const segs: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || (seg === "" && segs.length)) continue;   // a leading "" is the root
    if (seg === "..") { if (segs.length > 1) segs.pop(); continue; }
    segs.push(seg);
  }
  return segs.join("/");
}

// Relative against the hook's cwd: `cd ../tour` is how the sibling layout escapes the pin.
function resolveDir(target: string, cwd: string | null): string | null {
  if (isAbs(target)) return collapse(norm(target));
  if (!cwd || !isAbs(cwd)) return null;      // nothing to resolve against
  return collapse(`${norm(cwd)}/${norm(target)}`);
}

function bashWroteIn(cmd: string | null, cwd: string | null): string | null {
  if (!cmd || !BASH_WRITES.some((re) => re.test(cmd))) return null;
  const dirs = new Set<string>();
  for (const m of cmd.matchAll(CD_TARGET)) {
    const d = m[1] ?? m[2] ?? m[3];
    if (!d) continue;
    const abs = resolveDir(d, cwd);
    if (!abs) return null;   // unplaceable: may well be a second directory
    dirs.add(abs);
  }
  return dirs.size === 1 ? [...dirs][0] : null;   // two `cd`s have no one answer
}

function writeSite(tool: string, input: unknown, cwd: string | null): string | null {
  if (WRITE_TOOLS.has(tool)) return field(input, "file_path");
  return tool === "Bash" ? bashWroteIn(field(input, "command"), cwd) : null;
}

export function driftTarget(
  workdir: string, tool: string, input: unknown, cwd: unknown, roster: readonly Checkout[],
): Drift | null {
  const site = writeSite(tool, input, str(cwd));
  const d = site && checkoutDrift(workdir, site, roster);
  return d ? { ...d, via: "write" } : null;
}

// `cwd` first: Claude stating where the session, transcript included (see `via`), now lives.
export function driftUpdate(
  prev: Drift | null, workdir: string, tool: string, input: unknown, cwd: unknown,
  roster: readonly Checkout[],
): Drift | null {
  const byCwd = checkoutDrift(workdir, cwd, roster);
  if (byCwd) return { ...byCwd, via: "cwd" };
  // At home, `cwd` retires only a drift it reported; one naming no checkout says nothing.
  if (prev?.via === "cwd" && typeof cwd === "string" && checkoutOf(cwd, roster)) return null;

  const site = writeSite(tool, input, str(cwd));   // what sets a drift retires it, Bash arm too
  const byWrite = site && checkoutDrift(workdir, site, roster);
  if (byWrite) return { ...byWrite, via: "write" };
  if (!site) return prev;
  const home = checkoutOf(workdir, roster);
  const wrote = checkoutOf(site, roster);
  return home && wrote && wrote.path === home.path ? null : prev;   // a write home clears it
}
