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
// An agent that runs `git worktree add … -b feat/x` and then works in the new checkout
// leaves the session pinned to the folder it started in — and Claude Code guarantees we
// cannot learn the move from `cwd`. Verified against the real CLI (2.1.220): a `cd`
// *inside* the session's directory persists and the hook's `cwd` follows it, but a `cd`
// *outside* it is undone ("Shell cwd was reset to …") and `cwd` never moves. The
// session that prompted this had 42 such resets and 622 records all naming the folder
// it had already left.
//
// What does name the new checkout is the file-writing tools' `file_path`, absolute on
// every payload. So drift is read off writes — and only writes, because a Read lands
// anywhere (a sibling repo, ~/.claude, a temp dir) and would make this flap.
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

/// Which checkout an agent's write landed in, when that isn't the session's own.
///
/// Deliberately narrow: the target must be a checkout of *this session's repo* that the
/// worktree roster already knows about. "Any directory outside the workdir" would fire
/// on a scratch file or an edit to a config in $HOME — a false positive here doesn't
/// cost a wasted re-read like `gitMutates`, it puts a wrong branch name on screen and
/// offers to move a live session into it. So an unknown folder reads as no drift, and
/// the poll that maintains the roster is what makes a genuinely new worktree visible.
///
/// Both sides resolve to a checkout before being compared, rather than testing the file
/// against `workdir` directly. That is what keeps two different launches straight: a
/// session started in a *subfolder* of a checkout has not drifted when it writes
/// elsewhere in that same checkout, while one started in a nested worktree has drifted
/// the moment it writes to the enclosing repo.
export function driftTarget(
  workdir: string, tool: string, filePath: unknown, roster: readonly Checkout[],
): Drift | null {
  if (!WRITE_TOOLS.has(tool) || typeof filePath !== "string" || !filePath.trim()) return null;
  const target = checkoutOf(filePath, roster);
  if (!target) return null;                      // wrote somewhere that isn't a checkout
  if (target.path === checkoutOf(workdir, roster)?.path) return null;
  return { dir: target.path, branch: target.branch };
}

/// The session's drift after one settled tool call — latched, not sampled.
///
/// Sampling would be wrong, and visibly so: an agent building in another checkout still
/// *reads* its original one constantly (that is usually why it moved — to port work
/// across), so a flag recomputed from each tool call would flicker off on every such
/// read and take the inspector's card and the sidebar's marker with it. So a drift, once
/// seen, holds until the agent writes home again — which is the act, and the only act,
/// that means it came back. Anything else (a read anywhere, a write to a third checkout
/// that is not this repo's, a Bash call) leaves the answer alone.
export function driftUpdate(
  prev: Drift | null, workdir: string, tool: string, filePath: unknown, roster: readonly Checkout[],
): Drift | null {
  const target = driftTarget(workdir, tool, filePath, roster);
  if (target) return target;
  // Not drift. Was it a write *home*? Only then does an existing drift clear.
  if (!WRITE_TOOLS.has(tool) || typeof filePath !== "string" || !filePath.trim()) return prev;
  const wrote = checkoutOf(filePath, roster);
  return wrote && wrote.path === checkoutOf(workdir, roster)?.path ? null : prev;
}
