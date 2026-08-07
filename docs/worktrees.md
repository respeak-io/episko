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

## Branch cleanup — the rules, and the room they need

**`branches.ts` owns the rules** (pure, tested), **the dashboard's full-screen Branches view runs them**, and the ⑃ dialog's 🧹 only counts and hands over. Three evidence bases feed it — `gone` (its remote branch was deleted), `merged` (already in the trunk), and a merged pull request — and `sweep_branches` / `delete_remote_branches` are the only things that delete.

- **It moved out of the ⑃ dialog, and the reason is the shape of the decision.** It began as a pane in that dialog's detail column: a branch name, its evidence, the checkout it holds, its standing and its author, in ~340px beside a second list — which is why the dialog's own rows still reveal half of that only on hover. The decision is a **table**, one row per branch with a checkbox down the side, and that is what the enlarge-style overlay gives it. The dialog is for deciding where a session starts.
- **The ⑃ dialog carries none of it.** It briefly grew a broom per branch header, counting what the view would offer and handing over; both are gone. That dialog answers "where should this session start?", and the *only* thing it still shares with the cleanup is the trunk (`trunkOf`/`trunkOptions` from ./branches, so its `vs origin/main` chip and the view's footer can never name different ones).
- **Deletable first, blocked last** (`orderCands`), each half keeping git's own most-recent-first order. Blocked rows are not hidden — "why isn't this branch offered?" is a real question and the row carrying its reason is the answer — but they do not sit between you and the ticks.
- **The overlay repaints wholesale, so the scroll has to be carried across it** (`paintOverlay`). `paint` swaps `innerHTML` whenever the string differs, which destroys the element the scroll lives on: ticking a checkbox halfway down the table threw the view back to the top. There is no smaller correct repaint — the counts, the button label and the row highlight all change with that tick — so what survives is the scroll position, and only while the same view stays open.
- **The gh read is guarded on the project, never on a load counter.** Guarding it on the dialog's `wtGen` dropped the evidence whenever the pane was opened promptly — the throttled background fetch bumps that counter a beat after the dialog opens, which is exactly when the PR answer lands — and since the result then stayed null, nothing ever asked again: every squash-merged branch silently stopped being offered.
- **The two halves keep separate selections** (`branchPick`/`branchRPick`) and the half rides in the checkbox's own `data-` attribute. They run different commands; inferring the half from where a row sits would let a click on one side arm the other.

- **A pick is two claims, and only one of them is checkable.** `gone` is about the world, so `sweep_branches` re-derives it from `%(upstream:track)` and skips anything git now disagrees with (the dialog's list is up to a minute old). `force` is about *evidence* and nothing local can check it — it exists solely for a **squash**-merged PR, whose commits are ancestors of nothing, so `-d` refuses a branch whose work demonstrably shipped. `gh_merged_prs` is the only thing that knows, and `force` is set per row, never as a mode.
- **`merged` predicts the outcome; ahead/behind cannot.** A gone branch has no upstream left to be ahead *of*, so the backend zeroes both — `BranchInfo.merged` (one `--merged` listing in `git_branch_list`) is what tells you before the click which rows `-d` will take.
- **`merged` is measured against the trunk, not against HEAD.** It used to be "contained in whatever branch the repo is parked on", which in a repo sitting on a feature branch called half its history merged and offered it. Two branches are excluded whatever git says: the checked-out one, and **the trunk itself** — a local `main` is by definition contained in `origin/main`.
- **The sweep is scoped to the LIST, not the repo** — the header it sits in counts filtered rows, so reaching past the filter would delete what the query was hiding. Typing `feat/` and sweeping is then a feature.
- **A worktree's claim beats a force**: git refuses a held branch with or without `-D`. In the deep pane a held branch is *selectable only if* its checkout is clean, unlocked and has nothing running (Episko's or anyone's) — a bulk button must never be the thing that kills an agent. Checkouts are removed first and branches second, because a branch a worktree still holds cannot go.
- **Every name comes back**: `deleted` (with git's `(was <sha>)`, so `git branch <name> <sha>` undoes a force) plus `kept` (with git's own refusal) account for the whole input, and the `-D` for the rest goes to a terminal, never to a click — same rule as `delete_branch`.
- **The pane owns the detail column, and it is not keyed to a row** — which is why `wtPrefetch` must bail while one is open. An armed removal never needed that guard (`wtDetailHtml` renders those itself); this is the second writer to `#wtDetail`, and it silently replaced the pane a beat after it opened.

### The remote half

A second broom sits in the **Remote branches** header, and its rows now carry what GitHub's branches view carries: ahead/behind against the remote's default branch, and who wrote the tip commit. Both come out of the same `for-each-ref` — `%(ahead-behind:<base>)` (git 2.41+; an older git fails the *whole* listing on the unknown field, so the retry without it is what keeps remote rows from vanishing) and `%(authorname)`.

- **A remote row's ahead/behind mean something different from a local row's** — versus the trunk, not versus an upstream it doesn't have. `base` names what was measured and is **empty when it couldn't be** (no `origin/HEAD` and no main/master, a second remote, an old git). Empty is not "in sync": nothing is drawn, and nothing is offered for deletion.
- **One base, from the primary remote** (`origin`, else the first): a fork's `upstream` rows come back uncompared rather than compared against the wrong trunk — which is also the right answer for cleanup, since you can't delete on a remote you only fetch.
- **Nothing is ticked when the view opens.** It is the *Branches* view — you open it to look at your branches, and deleting is what you opt into. Landing on a full set of ticks and a "Delete 4" makes the destructive reading the default and turns reading the rows into work you have to undo; `All` is one click away. Late arrivals (the squash-merged rows the gh read adds) arrive unticked too — a row appearing under the pointer *already selected* is the worst version of a late answer.
- **Every anchor that opens the shared branch popover must be in main.ts's outside-click `closest()` selector**, or the click that opens it closes it again and the control reads as dead. The Branches view's trunk chip shipped missing from that list and did precisely nothing — the same silently-inert failure class `dispatch.test.ts` guards for the global dispatcher.
- **The trunk is overridable per repo** — the `vs origin/main` chip — in the ⑃ dialog's Remote branches header, and in the Branches view's **On &lt;remote&gt;** block header, where the whole Standing column is measured against it — stored in `cc-cmp-base` and passed to `git_branch_list` as `base`. Local, never committed: it changes what the picker *shows*, never what a command does. The backend **re-validates the ref** and silently falls back to the real default if it has gone, so a stale entry cannot mislead — which is why the chip renders `BranchInfo.base` (what was used) rather than the stored value. The picker seeds itself with the trunk in force: it is usually `origin/main`, which nothing in the repo need *track*, so a list built from upstreams alone was missing the one ref every number on screen is measured against.
- **A remote row's standing and author show for the row you are on**, not for all of them at once (`.wt-rmeta`, revealed on `:hover`/`.on`). Eleven rows each carrying `↑110 ↓10 Frederic…` is a wall of numbers bought by ellipsising the branch name — the one thing the row is for. The detail pane keeps both facts permanently for the selected row.
- **`delete_remote_branches` is the only write in the app that changes state for other people**, so it is bounded harder rather than more conveniently: the default branch is refused whatever it is asked, a ref whose sha has **moved since the row was read** is refused (the list is only as fresh as the last fetch), there is **no force and no `-D` handoff** — a protected-branch refusal is the server's answer, not ours to route around — and every delete comes back with its sha, because `git push <remote> <sha>:refs/heads/<name>` restores it while somebody still has the objects.
- **Only merged is ever offered**: contained in the default branch, or a merged PR (the squash case). Unmerged remote branches are listed blocked with their commit count — after a remote delete, no machine necessarily still has those commits.
- One push for the batch, then **per-branch retries to attribute a failure** (capped — past a dozen, git's message is reported against every row rather than spending that many round trips to phrase it per row).
- The footer verb is **mode-aware on purpose**: the local panes say "nothing on any remote is touched" and this one says the opposite. One shared sentence there would be a lie in the one pane where being wrong is public.

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
