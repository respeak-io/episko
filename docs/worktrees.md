# Project groups, worktrees & drift

> Rules and their reasons, compressed — the full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

## Project groups — the user's headings over the rail

Named collapsible folds over projects (`projgroups.ts`, pure and tested, owns the store; `grouping.ts`'s `groupedProjects` derives what the rail draws; `sidebarview.foldHead` is the markup; `sidebar.ts` owns the element and the drag). Made from right-click → *Add to group…* or by dragging a project onto one.

- **A group is not an ordering** — a name, a collapsed flag, a set of paths; its position derives from its first member under the active sort. There is no second order to keep in step with `cc-proj-order` (persisting one is the thing not to do — they would disagree within a day), and a group floats in the attention sort exactly when a member does.
- **`.pf*`, never `.pg*`** — `.pgroup` is a project and `applyPeek`/the drag reach for it by class (same trap as the graph's `gc-*`/`gco-*`).
- **Collapsed IS in the markup, unlike peek's hover** — a collapse is one deliberate click, so it may cost a repaint and in exchange cannot be lost to a re-render. Members render either way: `0fr → 1fr` needs content height, and the 0fr row is what makes collapsed rows unclickable.
- **Folding never folds away urgency**: a collapsed header carries `groupSummary`'s most-urgent glyph and a dirty dot; ⌘1–9 reaches inside (`orderedSessions` walks the *grouped* order); `setActive` calls `revealProjGroup` so landing inside a folded group unfolds it.
- **The drag reads membership off the DOM in the same pass as the order** (`saveSidebarArrangement`); the marker goes into the drop target's *parent*, and memberships of projects **not on screen** carry over untouched — in toplevel mode a repo can render only as its worktrees, and rebuilding from scratch would silently unfile it.
- **An empty group is kept**, landing at the end — a heading someone named, and the drop target that refills it.
- **A menu row that re-renders `#ctxMenu` must stop the click there** (`keepMenuOpen`) — the outside-click closer asks `closest()` of the original target, which an `innerHTML` swap detached; it answers null and closes the menu just opened.

## Noticing that a checkout moved

Nothing watches the filesystem (no thread, no crate, no lifecycle). **The hook stream is the trigger; git is the authority**: `PostToolUse` carries the Bash command; `phase.ts` hands it to the `onSessionTouched` seam (main.ts wires it), which queues a working-set re-read and — if `gitMutates` matches — pokes `refreshGitViews` on a 250ms debounce. **`gitMutates` never decides what changed, only whether to look** — keep it loose (a false positive costs one empty re-read; a false negative one poll interval). Don't tighten it into a shell parser; the poll is the backstop, and the only thing that catches a branch switched in your own terminal.

**Two commands, two costs**: `list_worktrees` runs a `status --porcelain` per checkout plus `merge-base` per branch — right for the ⑃ dialog, far too heavy to poll. **`worktree_heads` answers "which checkouts, and what's on each HEAD" from `.git` files with no git process** — the sidebar's roster (`worktreesByRepo`) and its change stamp. Two traps: git's bookkeeping name under `worktrees/` need not match the folder (the path comes from `gitdir`), and every path goes through `physical_cwd` or one checkout renders as two.

**`git_head` rides the same poll, also spawn-free** (reads `.git/HEAD` — it used to be two git processes per pane per 4s, at ~140ms per process creation on Windows). Two things it must keep right: a linked worktree has its own `HEAD` but **shares the repo's refs** (`git_dirs` returns both dirs; `resolve_ref` falls back to `packed-refs`), and an **unborn HEAD is `None`, not detached** — only the missing ref tells them apart; `projmenu.ts` drops *Commit graph…* on `None`. Tested by substitution against git's own answers.

**The dirty poll is stale-driven, not blanket**: `refreshDirtyStates` reads only folders `markWorkdirStale` flagged, plus a 15s sweep for what no hook can see (your editor, a build, an external session). The tool allowlist is a list of *readers* — anything unknown marks the folder, so a new tool defaults to wrong-but-cheap rather than silently missing writes. `git_diffstat` is one `status --porcelain=v2 --branch` (which carries upstream and ahead/behind), with the `--numstat` walk skipped on a clean tree.

Everything lands through `refreshGitViews` → `renderAll()`, so the sidebar, branch chip and open ⑃ dialog cannot disagree. **Both removal paths call `refreshGitViews` unconditionally** (a stranded removal still changed the roster) — `renderAll` paints the roster, it never re-reads it.

**The ⑃ cluster header renders only for a live checkout** (`clusterIsLive`); it carries `＋` (→ `launchWorktree`, `colorKey` keyed to the **repo root** or the pane splits into its own group) and a right-click menu (`projmenu.ts`) sharing `#ctxMenu` — `data-wt` is matched *ahead* of `data-key`, so tree distance doesn't decide.

**Idle checkouts are peek rows** (`peekBody` → `.pgpeek`), collapsed until the pointer rests on the group — they're worth *reaching*, not *showing*, and the whole row launches (one verb, a target the width of the sidebar). Load-bearing:

- **`peek.ts` owns the rules and is pure** over an explicit `now`; `sidebar.ts` schedules **one** timeout to `peekNextDeadline`; an idle sidebar arms nothing.
- **Hover is not a render input**: the expansion is a class applied outside the render path (in the markup it would bust the byte-identical cache per mouse move, and a telemetry tick would collapse a group under the pointer). `PeekState.open` is a **project path**, re-applied via `applyPeek()` after each DOM write; listeners are delegated `mouseover`/`mouseout` on the persistent `#projects`.
- **Moving between two expanded groups skips the delay** — a pointer already inside the rail isn't passing over it.
- **Off keeps rows reachable** (the wrapper renders already-open).
- **Rows need a roster, so idle projects are polled too**: `refreshWorktrees` also reads **favourites**, stale-driven — never-read ones seeded on the next tick, the rest on a 20s sweep (an idle repo changes on human timescales).

Timings live in `cc-peek`, set in Settings › Worktrees over a **live preview built from the real CSS and the real reducer** — a preview styled separately from what it previews is just a picture.

**`openWt` has two modes, and the difference is framing**: `launch` ("where should this session start?" — every branch a row) vs `manage` (`{ manage: true, focusDir }` from a cluster menu — branches wait for a query, the engine chip goes, the count reads `N checkouts`). **⏎ still starts a session in both** — changing what Enter does between modes is the worse trap. **The main checkout is not a worktree and says so twice**: `clusterGlyph` gives it `⌂` and `branchHue` seeds from its **path** (it comes out wearing the project's own accent); every chip and header goes through those two helpers so the modes can't disagree.

**Removal is keyed by path** (`removeWorktreeAt`) — an empty cluster is exactly the checkout you most want to prune. It closes the Episko sessions there (the backend refuses while one runs) but **refuses outright when an external session is in the checkout** — the backend can't see it, and `git worktree remove` would delete the folder under a live agent; the menu says so on the row.

**Ask the question the folder's state actually poses**: a checkout removed *outside* Episko leaves git's record and a cluster while a session still names the path. Both flows branch on `exists` — `removeWorktreeAt` from the `worktree_heads` roster, `wtConfirmHtml` from its own `list_worktrees` result: present → the removal warning; gone → "this only clears git's record, nothing is lost". **An unknown roster means "assume it is there".**

**A failed `git worktree remove` does NOT mean nothing happened**: git deletes the directory first and carries on past a failed delete ("no going back", per its own source), so a folder it couldn't delete leaves the worktree **already unregistered** at exit 255 — reporting refusal produced the one handoff guaranteed to fail (`remove --force` → "not a working tree"). `remove_worktree_impl` asks `still_registered` — a **fresh** listing, since the point is git may have changed it — and an unregistered worktree goes down `finish_removal` whatever the exit code; unknown counts as *still registered*.

**Windows will not delete a directory a live process sits in** (POSIX unlinks and lets the last handle close). That difference shapes three things:

- **The wait before the delete is load-bearing**: `kill_session` returns after the signal; only `pty-exit` proves the process was reaped. `closeSessionsIn` registers each waiter **before** its kill and calls `closeSession` **last** (it settles pending waiters with `-1`); already-`ended` panes are left out of the race. The wait is bounded.
- **A stranded folder is `ok: true` with a `stranded` field, not `ok: false`** — the worktree really is gone, so every caller must refresh as on a clean run. The leftover *directory* is a separate problem with a separate repair (`purge_worktree_folder`).
- **`remove_tree` replaces `fs::remove_dir_all`**: it names **which** path refused (the Restart Manager can only be asked about a file; `remove_dir_all`'s error carries no path), clears the read-only attribute, and never follows a link — the one way a recursive delete does damage outside its target.

**`path_holders` names the holder; killing one is a different decision.** Two probes: a `sysinfo` cwd scan (any OS) and, on Windows, the Restart Manager (`RmGetList`) for open handles — both degrade to "found nothing" (a diagnostic shown *after* a failure; a handle can release in between). `PathHolder.ours` splits the repair: a process Episko launched is cleared silently; anything else goes in a dialog naming it. `purge_worktree_folder` **re-probes before killing** (pids are reused) and refuses a path without a grandparent.

## Drift — the agent left the checkout it was launched in

The roster answers "what is checked out where"; this answers what it cannot: **which checkout is this agent's work landing in?** Two ways an agent changes checkout, behaving as opposites, each invisible to the other's signal (verified against the real CLI and real sessions):

| | **out of** the project dir | **into** the project dir |
| --- | --- | --- |
| how | `git worktree add ../x` via Bash | Claude Code's `EnterWorktree` tool |
| where | a sibling, e.g. `.cc-worktrees/…` | `<repo>/.claude/worktrees/<name>` |
| hook `cwd` | **pinned** — every `cd` out is undone | **follows** |
| the transcript | stays where it was | **Claude re-homes it itself** |
| `gitMutates` | fires | never — no Bash command ran |
| the signal | a write's `file_path` | `cwd` |

Hence two signals with different standing (`driftUpdate`), and the asymmetry is the design:

- **`cwd` may only ever *set* a drift, never clear a write-derived one** — it reads "home" for the entire life of a Bash-worktree drift, so letting it clear would delete the answer on the next hook. It retires only a drift it itself reported.
- **Writes latch** (an agent working elsewhere still reads its original checkout constantly); cleared only by a write home.
- **Both sides resolve to a checkout before comparison, longest match wins** — keeps `cd src/` (not a move), a subfolder launch (not a move) and a nested worktree (a move) straight at once.
- **The target must be a checkout the roster already knows** — a false positive here puts a wrong branch on screen and offers to relocate a live session into `$TMPDIR`.

Display is the same either way and **the row does not move**: a `⤳ branch` marker, `old ⤳ ⑃ new` on the header chip, a card atop the inspector above the working set it contradicts.

**`Drift.via` decides the repair**, and conflating the two is wrong in both directions:

- **`via: "cwd"`** → *Follow it here*: the process and conversation are already there; `followSessionDrift` adopts the directory **in place** — no confirm, no kill, no move, no relaunch. It re-points `workdir`/`branch`, drops the stale working set, marks a re-read, re-saves the roster.
- **`via: "write"`** → *Move session here*: nothing has re-homed anything, and `claude --resume` takes an id and **no path** (it looks up `<enc(cwd)>/<id>.jsonl`), so no typed command relocates a session. **Kill, wait, move, relaunch** — and the wait is `pty-exit`, not the invoke returning: `kill_session` returns after sending the signal, and only the reaper's `pty-exit` (after `child.wait()`) proves the transcript handle closed. Renaming earlier is the bug the ordering prevents (Windows refuses; POSIX lets the dying process write into the moved file). Bounded, so a wedged process can't strand the pane. `move_session_transcript` **renames rather than copies** (two files with one id double-list in History and make `--resume` ambiguous), carries the `<id>/tool-results` sidecar, refuses to overwrite, and restricts the id to uuid characters before it becomes a filename. A failed move still relaunches — in the original folder.

`move_session_transcript` is the only thing Episko ever writes inside `~/.claude` — everything else it writes in a user's repo is under `.episko/` (see App-wide rules in CLAUDE.md).

Known wart: a moved transcript's first user record still names the old cwd, so `transcript_origin` grafts its History row onto the old project. Defensible, and not worth rewriting records.
