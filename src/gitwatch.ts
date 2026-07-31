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
// already left. The transcript stays where it was. The only thing that names the new
// checkout is a write's `file_path`, absolute on every payload.
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

// Path containment, tolerant of the two spellings a path reaches us in: Windows
// backslashes, and a trailing separator on a directory. Case is left alone — the
// comparison is between two paths git itself reported, so they already agree.
function under(dir: string, path: string): boolean {
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
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
function checkoutDrift(workdir: string, path: unknown, roster: readonly Checkout[]) {
  if (typeof path !== "string" || !path.trim()) return null;
  const target = checkoutOf(path, roster);
  if (!target) return null;                      // not in any checkout of this repo
  if (target.path === checkoutOf(workdir, roster)?.path) return null;
  return { dir: target.path, branch: target.branch };
}

/// Which checkout an agent's *write* landed in, when that isn't the session's own.
/// The signal for case 1 above — the only one that works when `cwd` is pinned.
export function driftTarget(
  workdir: string, tool: string, filePath: unknown, roster: readonly Checkout[],
): Drift | null {
  if (!WRITE_TOOLS.has(tool)) return null;
  const d = checkoutDrift(workdir, filePath, roster);
  return d && { ...d, via: "write" };
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
/// Writes then latch, for case 1. A drift, once seen, holds until the agent writes home
/// again — the act, and the only act, that means it came back. Anything else (a read
/// anywhere, a write to a folder that is no checkout of this repo, a Bash call) leaves
/// the answer alone.
export function driftUpdate(
  prev: Drift | null, workdir: string, tool: string, filePath: unknown, cwd: unknown,
  roster: readonly Checkout[],
): Drift | null {
  const byCwd = checkoutDrift(workdir, cwd, roster);
  if (byCwd) return { ...byCwd, via: "cwd" };
  // `cwd` resolved to the session's own checkout: authoritative *only* over a drift it
  // reported. A `cwd` that names no checkout at all (a scratch dir, $HOME) says nothing.
  if (prev?.via === "cwd" && typeof cwd === "string" && checkoutOf(cwd, roster)) return null;

  const byWrite = driftTarget(workdir, tool, filePath, roster);
  if (byWrite) return byWrite;
  if (!WRITE_TOOLS.has(tool) || typeof filePath !== "string" || !filePath.trim()) return prev;
  const wrote = checkoutOf(filePath, roster);
  return wrote && wrote.path === checkoutOf(workdir, roster)?.path ? null : prev;
}
