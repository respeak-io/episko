// What a session's tool activity implies about git: whether Episko should go and
// re-read state (`gitMutates`), and which checkout the agent's work is actually
// landing in (`driftTarget`). Pure logic, in its own module so it can be tested —
// the DOM and PTY halves of main.ts can't be.
//
// The contract that makes this safe to keep loose: **this is a trigger, not an
// authority**. It only decides *when to look*; `git_head` and `worktree_heads` decide
// what actually changed, and render nothing when the answer is "nothing". So the two
// error directions cost very different amounts:
//
//   false positive — `git checkout -- src/foo.ts` restores a file and moves no branch.
//     We do one cheap re-read that finds nothing and repaints nothing.
//   false negative — `git co` (a user alias), `gco` from oh-my-zsh, a git call buried
//     inside `./scripts/new-wt.sh`, or an MCP git server that never touches Bash.
//     The 4s poll still catches it; we lose the instant update, not the update.
//
// Which is why the list below leans inclusive and doesn't try to be a shell parser.

import type { Drift } from "./types";

/// Verbs that can move HEAD or change the set of checkouts.
const VERBS ="checkout|switch|worktree|branch|merge|rebase|reset|pull|stash";

// Matched anywhere in the string, because `cd sub && git switch x` is entirely normal.
// The bounded gap between `git` and the verb lets global flags through
// (`git -C /some/long/path checkout`) without letting the match run away into an
// unrelated later command.
const GIT_MUTATES = new RegExp(
  `\\bgit\\b[\\s\\S]{0,80}?\\b(${VERBS})\\b` +
  `|\\bgh\\b[\\s\\S]{0,40}?\\bpr\\s+checkout\\b`,
);

/// True when `cmd` might have moved HEAD or changed the set of worktrees.
export function gitMutates(cmd: unknown): boolean {
  return typeof cmd === "string" && GIT_MUTATES.test(cmd);
}

// ---------- drift: the agent is working in a checkout it wasn't launched in ----------
//
// There are **two** ways an agent changes checkout, they behave as opposites, and each
// is invisible to the signal that catches the other. Both were verified against the real
// CLI (2.1.220) and against real sessions, because guessing here produced a feature that
// covered one of them and read as broken in the other.
//
// **1. Out of the project dir** — `git worktree add ../feature` via Bash, the sibling
// layout. Claude Code pins the session to its launch directory and actively undoes any
// `cd` that leaves it ("Shell cwd was reset to …"), so `cwd` never moves; the session
// that prompted this had 42 such resets and 622 records all naming the folder it had
// already left. The transcript stays where it was. What names the new checkout is a
// write's `file_path`, absolute on every payload — or, for an agent that calls no write
// tool at all, the `cd` its Bash command ran under (`bashWroteIn`).
//
// **2. Into the project dir** — Claude Code's own `EnterWorktree` tool, which creates
// `<repo>/.claude/worktrees/<name>`. Being inside the project dir, there is no reset:
// `cwd` *follows*, and Claude **re-homes its own transcript** under the new directory.
// So `cwd` is authoritative here — and `gitMutates` never fires, because no Bash command
// was run at all.
//
// Hence two signals with different standing, and the asymmetry is the whole design:
//
// - `cwd` may only ever **set** a drift, never clear a write-derived one. A `cwd` that
//   says "home" proves nothing about where the writes are going — that is precisely
//   case 1, where it says "home" for the entire life of the drift.
// - Writes are the fallback for case 1, and they **latch**: an agent working in another
//   checkout still reads its original one constantly (that is usually why it moved), so
//   a flag recomputed per tool call would flicker off on every such read.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// The two sides of every comparison here come from different places and are spelled
// differently, which is the trap this codebase has already fallen into once (see
// History's `norm_path`, where skipping it made a repo's own checkout unequal to its own
// root and 135 of 219 rows read as worktrees). The roster side is resolved and
// normalised in Rust — `worktree_heads` returns `norm_path(physical_cwd(…))`. The other
// side is raw: `cwd` and `file_path` as Claude Code reports them, and `Sess.workdir` as
// the user spelled it when they picked the folder.
//
// So separators and a trailing slash are levelled here, and case with them: `norm_path`
// upper-cases a Windows drive letter that Claude may well send lower-case, and both
// mainstream desktop filesystems are case-insensitive by default anyway. The cost is
// that two checkouts differing only in case would read as one — on a case-sensitive
// volume, and vanishingly unlikely for checkouts of the same repo. Symlinks cannot be
// resolved from here at all, which is what `checkoutDrift` failing closed is for.
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function under(dir: string, path: string): boolean {
  const d = norm(dir), p = norm(path);
  return d !== "" && (p === d || p.startsWith(d + "/"));
}

type Checkout = { path: string; branch: string; exists: boolean };

// Which checkout a path belongs to. The *longest* match wins, and that is the whole
// subtlety: a worktree may sit inside its own repo (`repo/wt/feature`), where the repo
// root also contains the path and would otherwise win by appearing first.
function checkoutOf(path: string, roster: readonly Checkout[]): Checkout | null {
  let best: Checkout | null = null;
  for (const w of roster) {
    if (!w.exists || !under(w.path, path)) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

/// Which checkout a pane's *directory* belongs to, as a path — the grouping answer,
/// where everything below is the drift answer. Same resolution, different question, so
/// it shares the longest-match rule rather than growing a second one in ./grouping.
///
/// A pane's own directory is not always its checkout. A task declares its own cwd (VS
/// Code's `options.cwd`, routinely `01_frontend`), and a shell opened while that task
/// pane is on stage inherits it — `❯ Terminal` starts in `activeCwd()`, the stage
/// owner's raw workdir — so panes can sit several folders deep inside the checkout they
/// belong to. The roster is the only thing that knows where the checkout actually ends.
///
/// **An exact match keeps the caller's spelling.** The roster side is resolved and
/// normalised in Rust; the caller's side is however the user picked or typed it. Handing
/// back the roster's spelling for the same directory would make a session's key stop
/// matching the project path it is compared against, and that comparison is what decides
/// whether a cluster is the repo's own (its ⌂ glyph, its label, its ＋ target). Only a
/// path genuinely *inside* a checkout is rewritten — the one case with no spelling of
/// its own worth keeping. An unplaceable folder (no roster yet, a scratch dir) is
/// returned untouched: same fail-closed rule as drift.
export function checkoutDir(path: string, roster: readonly Checkout[]): string {
  const home = checkoutOf(path, roster);
  return home && norm(home.path) !== norm(path) ? home.path : path;
}

/// Which checkout `path` belongs to, when that isn't the session's own.
///
/// Deliberately narrow: the target must be a checkout of *this session's repo* that the
/// worktree roster already knows about. "Any directory outside the workdir" would fire
/// on a scratch file or an edit to a config in $HOME — a false positive here doesn't
/// cost a wasted re-read like `gitMutates`, it puts a wrong branch name on screen and
/// offers to relocate a live session into it. So an unknown folder reads as no drift, and
/// the poll that maintains the roster is what makes a genuinely new worktree visible.
///
/// Both sides resolve to a checkout before being compared, rather than testing `path`
/// against `workdir` directly. That is what keeps several cases straight at once: a
/// session started in a *subfolder* of a checkout has not drifted when it works
/// elsewhere in that same checkout (and `cd src/` is not a checkout change), while one
/// started in a nested worktree has drifted the moment it touches the enclosing repo.
/// **Fails closed**, and that is the whole of its safety. If the session's *own* folder
/// cannot be placed in the roster — a spelling git resolved and we cannot (a symlinked
/// project path), a roster read before the checkout existed — then nothing here is
/// knowable and the answer is "no drift". Comparing against a missing home instead would
/// make every write into the session's own checkout read as a move, permanently, which
/// is worse than saying nothing: the card would offer to relocate a session that never
/// went anywhere.
function checkoutDrift(workdir: string, path: unknown, roster: readonly Checkout[]) {
  if (typeof path !== "string" || !path.trim()) return null;
  const home = checkoutOf(workdir, roster);
  if (!home) return null;
  const target = checkoutOf(path, roster);
  if (!target || target.path === home.path) return null;
  return { dir: target.path, branch: target.branch };
}

// ---------- the Bash arm: an agent that calls no write tool at all ----------
//
// A session can be told to prefer the shell for everything — `cat > f <<'EOF'` to create
// a file, an inline `python3` heredoc to edit one — and then `WRITE_TOOLS` never fires.
// Every hook says `Bash`, `tool_input.file_path` is absent, and `cwd` is pinned to the
// launch dir by case 1, so **both** signals above are blind at once and the session
// reports the branch it launched on for the rest of its life. Measured on the real
// session that prompted this: 99 hooks, 99 of them `Bash`, 0 writes, drift never set.
//
// The evidence here is weaker than a write's `file_path` — a `cd` says where the shell
// stood, not where the bytes went — so it is bounded on both sides: the command must
// look like it wrote something, AND it must name exactly one absolute directory, AND
// (via `checkoutDrift`, as always) the roster must already recognise that directory as a
// checkout of this session's repo.

/// One string field of the hook's `tool_input`, if it is usable.
function field(input: unknown, key: "file_path" | "command"): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

/// What makes a shell command look like it wrote a file. A short keyword list and
/// deliberately not a parser: it decides only whether to *believe* the `cd`, and being
/// wrong in the shy direction costs exactly what the status quo cost. Over the 99
/// commands of that real session these three matched 27, and nothing else was needed.
const BASH_WRITES = [
  // A real output redirect (`> f`, `>> f`, `cat > f <<'EOF'`). Two guards, and both were
  // put there by a false positive found in that session's own traffic rather than by
  // taste. **Whitespace before the `>`**, or every `=>` in a TypeScript heredoc is a
  // redirect (11 of the 99) and so is every `2>&1`. **A `.` or `/` in the target**, or
  // `if (s.activity.length > 12)` — a comparison inside a heredoc *body* — redirects to
  // `12`. Together they still matched all 6 genuine writes (`cat > src/toolio.ts`,
  // `printf … > data.txt`, `cat > harness/tools.html`, …). `/dev/null` is not a file
  // anyone is working in.
  /(^|\s)>{1,2}\s*(?!&)(?!\/dev\/null\b)[^\s;&|<>]*[.\/][^\s;&|<>]*/,
  // `python3 - <<'PY' … open(p,"w") … .write(s)`: the dominant edit shape once an agent
  // has no Edit tool, and the one with no `>` anywhere in it. Printing is not writing,
  // hence the two exclusions.
  /open\([^)]*['"][wax]|(?<!stdout)(?<!stderr)\.write(_text|_bytes)?\(/,
  // In-place stream editing: `sed -i`, `perl -pi -e`.
  /\b(sed|perl)\s+(-[A-Za-z]+\s+)*-[A-Za-z]*i\b/,
];

// `cd` at a command position — string start, or after a separator or a newline. Quoted
// and bare forms both. Only an **absolute** target is any use: a relative one resolves
// against a cwd that case 1 has pinned to the launch dir, so it can only ever re-derive
// the answer we already have.
const CD_TARGET = /(?:^|[\n;&|(])\s*cd\s+(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;

function isAbs(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

/// The directory a write-shaped Bash command ran in, when the command names exactly one.
///
/// **Exactly one** is the fail-closed half. `cd a && … && cd b` genuinely does not have
/// an answer, and neither does a `cd` sitting in a heredoc *body* next to the one that
/// set the command up — so both cases answer nothing rather than guessing, the same rule
/// `checkoutDrift` follows when it cannot place the session's own folder.
function bashWroteIn(cmd: string | null): string | null {
  if (!cmd || !BASH_WRITES.some((re) => re.test(cmd))) return null;
  const dirs = new Set<string>();
  for (const m of cmd.matchAll(CD_TARGET)) {
    const d = m[1] ?? m[2] ?? m[3];
    if (d && isAbs(d)) dirs.add(norm(d));
  }
  return dirs.size === 1 ? [...dirs][0] : null;
}

/// Where this call's write landed, however the agent writes files: a write tool names
/// the file, a Bash command names only the directory it ran under. `checkoutOf` resolves
/// the two identically, which is what lets everything downstream stay one code path.
function writeSite(tool: string, input: unknown): string | null {
  if (WRITE_TOOLS.has(tool)) return field(input, "file_path");
  return tool === "Bash" ? bashWroteIn(field(input, "command")) : null;
}

/// Which checkout an agent's *write* landed in, when that isn't the session's own.
/// The signal for case 1 above — the only one that works when `cwd` is pinned.
/// `input` is the hook's `tool_input` verbatim; which of its fields count is `writeSite`'s.
export function driftTarget(
  workdir: string, tool: string, input: unknown, roster: readonly Checkout[],
): Drift | null {
  const site = writeSite(tool, input);
  const d = site && checkoutDrift(workdir, site, roster);
  return d ? { ...d, via: "write" } : null;
}

/// The session's drift after one hook — both signals, in order of standing.
///
/// `cwd` first, because when it moves it is Claude Code stating where the session now
/// lives, which no heuristic can outrank: it also means the transcript has moved, so the
/// two drifts need different repairs (see `via`). But it is **positive-only**. A `cwd`
/// reading "home" is the normal, permanent state of a case-1 drift, so letting it clear
/// one would delete the answer on the very next hook. It may retire only a drift `cwd`
/// itself reported.
///
/// Writes then latch, for case 1 — where "a write" is whatever `writeSite` can place,
/// so a shell-only agent's `cd` counts as one. A drift, once seen, holds until the agent
/// writes home again: the act, and the only act, that means it came back. Anything else
/// (a read anywhere, a write to a folder that is no checkout of this repo, a Bash call
/// that wrote nothing or named no directory) leaves the answer alone.
export function driftUpdate(
  prev: Drift | null, workdir: string, tool: string, input: unknown, cwd: unknown,
  roster: readonly Checkout[],
): Drift | null {
  const byCwd = checkoutDrift(workdir, cwd, roster);
  if (byCwd) return { ...byCwd, via: "cwd" };
  // `cwd` resolved to the session's own checkout: authoritative *only* over a drift it
  // reported. A `cwd` that names no checkout at all (a scratch dir, $HOME) says nothing.
  if (prev?.via === "cwd" && typeof cwd === "string" && checkoutOf(cwd, roster)) return null;

  // One `writeSite`, used twice: what sets a drift is what retires it, so a Bash write
  // home clears exactly as an `Edit` home does. Letting the shell arm set but never
  // clear would strand a Bash-first session on a stale card offering to move it into a
  // checkout it had already come back from.
  const site = writeSite(tool, input);
  const byWrite = site && checkoutDrift(workdir, site, roster);
  if (byWrite) return { ...byWrite, via: "write" };
  // Not drift. Only a write that landed squarely in the session's own checkout retires
  // one — and, as above, only when we can actually place that checkout. An unplaceable
  // home clears nothing rather than clearing everything.
  if (!site) return prev;
  const home = checkoutOf(workdir, roster);
  const wrote = checkoutOf(site, roster);
  return home && wrote && wrote.path === home.path ? null : prev;
}
