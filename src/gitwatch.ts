// Deciding, from a shell command an agent just ran, whether Episko should go and
// re-read git state. Pure logic, in its own module so it can be tested — the DOM and
// PTY halves of main.ts can't be.
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

/// Verbs that can move HEAD or change the set of checkouts.
const VERBS = "checkout|switch|worktree|branch|merge|rebase|reset|pull|stash";

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
