# The project dashboard

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

**Left-clicking a project opens it**, the header's own answer to "what is going on in this repo". **Every header shape must carry `data-dash`**: two of `renderSidebar`'s three shapes shipped without it for two releases: absent attribute → `closest()` null → silently inert, the same failure class `dispatch.test.ts` guards elsewhere.

**The key is `repoRoot ?? path`, because a checkout is not a project**: `splitByWorktree` keys groups by checkout dir while `dashDays` regrafts history onto the repo root (`histProject`), so a worktree-keyed dashboard matches no sessions; `splitByWorktree` carries `repoRoot` back for whatever needs it.

Split: **`dash.ts` pure and tested** (`projectTier`, `dashDays`, `dashPulse`, `projectCost`, `densePerDay`); **`dashview.ts`** data → string; **`dashboard.ts`** owns the pane, IPC, summary queue, events. Rides the `mirror` pointer (`kind: "dash"`) rather than a second flag. **Nothing runs until a project is clicked**: no probe at startup, nothing on `renderAll`.

**Three gates, and they are not the same gate** (`projectTier`, one `project_facts` call):

- **GitHub**: issues, PRs, claims (all `gh`; below).
- **git**: commits, checkouts, and *everything shared*. `.episko/` needs **git rather than GitHub** (a GitLab/self-hosted remote is this tier; `parse_remote` mints a slug for `github.com` only). **The host in a remote URL may be an `~/.ssh/config` alias** (`Host github.com-work`), so `ssh -G <name>` resolves it (config-only, memoised); a string match misfiles exactly the people with the most repos. Test trap: `git remote get-url` applies `insteadOf` rewrites, so fixtures use `example-org`.
- **neither**: sessions, spend, notes; none ever cared about git.

**A card with nothing to say is absent rather than empty** (`missingCard` says once what the folder can't do). **A card not read yet is neither of those**, so it gets a skeleton:

- **The waits are separate flags on purpose**: `loading` (local reads), `ghLoading` (starts later, ends later), `writing`/`stage` (model calls). One `isLoading` would skeleton what already answered.
- **`factsKnown` answers a different question from `loading`**: it asks whether `project_facts` answered *for the project on screen*; `tier` defaults to `none`, which is an assertion. The repo verbs and the `not a repo` chip hang off it.
- **Every write in `loadDash` is guarded by `root() !== r`, including `loading` itself**: two awaits, and a click during either would land the old folder's answers under the new name.
- A pending sentence is a mark beside the deterministic headline; the shared box is a real skeleton. Both reuse the usage screen's `.u-skel`/`.u-spin`, so there is one loading vocabulary.

Easy to get wrong:

- **Per-project cost comes from `cc-usage-detail`, never `cc-usage`** (the plain rollup is every project at once). Older days legitimately lack the split → a dash rather than `$0.00`, because "we didn't keep this" and "it was free" are different facts. `DayDetail` carries a per-session `sess` map (read by `daySpend` → `costPopHtml`). **A split can fall short of the day's total, each split separately** (`cc-usage` banks from the first dollar, a later-shipped split starts mid-day), so `daySpend` gives **both** lists their own `unattributed` row; a split with *nothing* stays empty ("predates the record"). The half-cent floor: both figures are the same deltas summed in different order.
- **The list drops empty days and the sparkline must not**: `trailDays` omits them (blank rows read broken); `densePerDay` fills them back (two busy days a week apart must not render adjacent).
- **The header's four verbs act on the dashboard's project**: `activeProjectCtx`/`activeCwd` (panes.ts) answer for the dash mirror too, so ＋ / ❯ / ▶ / ◷ and every chord keyed off them treat it like a session's. `requestLaunch`'s two zero-IPC signals (a live session's `branch`, `dirtyByFolder`) only cover folders something is *running* in, hence `dashLaunchHint()` passes in what the dashboard already fetched, keeping the click synchronous (see `requestLaunch`'s comment for why nothing may be awaited before the dialog is up). The inspector's ＋ is that same single call: one verb that opens the worktree dialog when there's a branch to pick; `dashInspector` keeps the ellipsis only on a repo. `DashHost` carries **both** `launch` and `requestLaunch`: a dispatch has already decided where it's going, a person clicking ＋ has not.
- **⌘I collapses to a 44px rail here instead of hiding the panel**, because the dashboard's verbs live only in the inspector. On a session ⌘I still hides it fully. **The rail is the same verb set**, so an entry added to *Do something here* belongs in `dashStrip` too; two surfaces offering different verbs is worse than either alone.
- **`cleanup` opens the Branches view**, an enlarge overlay like *Checkouts* and *Open work*, repo-gated like *Commit graph…*. Its reads (`git_branch_list`, `list_worktrees`, `gh_merged_prs`) fire **when the view opens**, never with the rest of the dashboard: the pane's own invariant, one level down. It is the only overlay that acts rather than reports, so it carries the app's one bulk-destructive button; see `docs/worktrees.md` for the rules it enforces and `branches.ts` for where they live.
- **⇣ Pull acts on the repo's main worktree** (`mainCheckout`, from the `worktree_heads` the pane already bought, with the root as fallback, so a failed probe doesn't make the verb vanish), and **it fetches first, always**. Nothing here runs git on a schedule, so the ahead/behind it knows is as old as the last fetch, and `git_action("pull")` short-circuits on exactly that stale count, reporting *already up to date* without reaching the remote. Fetch, re-read, then decide; every wording says which number it is reading and how fresh it is. The `loadDash` probe is a `git_diffstat` rather than a fetch: a network round trip per project click would tax the one thing this pane promises is free, and can hang for the full 45s timeout. `pullState` is why only *busy* greys the button: `no-upstream` and `diverged` are precisely the cases the backend refuses with the command that works, handed to a prefilled terminal (`DashHost.handToTerminal`), and disabling them would amputate the useful half. `pulling` holds the **root** rather than a boolean, so switching project mid-pull doesn't put "Pulling…" on a dashboard where nothing is, and it is deliberately absent from `openDashboard`'s reset, since a git process does not stop because you looked elsewhere. A pull that landed reloads the whole pane rather than patching it: new commits, and a colleague's `.episko/digest.md` and notes with them, which is most of the point of pulling from here.

## The GitHub half

`ghwork.ts` owns the rules (tested); `claim.ts` owns what a dispatch writes. `gh_threads` is three `gh` calls per repo (issues, PRs, viewer) cached 60s, and **degrades rather than failing** (`available: false` + reason, one quiet row, like a blocked runnable).

**Two orderings decide how long the card takes, and both were wrong in the same direction: the network waited on things it does not depend on.**

- **`loadGh` is fired *first*, before the local reads**, right after `project_facts`, which is the only thing it needs. Fired last, the network could not begin until a scan of every transcript on the machine had finished: ~1–2s of local reads in front of ~1.3s of `gh`, a total explained by neither half. "The timeline should paint without waiting for the network" is satisfied by not **awaiting** it, which was always the case, and not by starting it late.
- **The GitHub cards cross the `loading` branch** (`ghCards`, built once and emitted in both). Firing early only helps if an early answer can be *shown* early, and that branch used to switch the whole column. This is the same exemption Notes always had. It also gives the GitHub half a **skeleton of its own** during the long read; one generic `cardSkeleton` stood in for up to four cards, so the card people open the dashboard for read as absent rather than pending.
- **The three `gh` calls run concurrently** (`std::thread::scope`, inside the existing `spawn_blocking`): 662 + 605 + 457 ms sequential measured against a real repo, 1.7–2.3s wall clock vs 0.7–1.0s for the same three at once. The viewer is now probed even when the issue read fails, which is consistent rather than new: that is the same gh-missing/logged-out failure `viewer_login` already caches deliberately, and the one case the two differ (a non-GitHub folder) is exactly where `gh api user` still answers, being repo-independent.

- **A claim is only ever a hint**: shown, warned once, then you proceed. Claims expire (`CLAIM_STALE_MS`; a sleeping laptop must not block a colleague), and `pty-exit` releases what a session took.
- **Preference AND `.episko/episko.toml`'s `[claim]`**: a project-disabled switch renders greyed rather than hidden ("why can't I assign?" needs an answer).
- **`holderOf` reads in one order**: our ledger (knows unpushed dispatches) → assignee (the explicit human signal) → `agent:` label (a machine, which can't say whose).
- **Triage never offers a PR**, an assigned issue, or anything on the project's keep list.
- **`gh_close_issue` is the only destructive write, and it comments *before* it closes**: a failed close then leaves an explanation, the other order leaves a mystery.
- **Dispatch sends the prompt**, the one deliberate break of "Episko prefills, the human presses Enter": the confirm sheet *is* the reading. A colleague's shared note stays prefilled. Both halves need the session id back from `launch`: `panes.ts` returns `string | null` and `DashHost.launch` is typed to match; typed `unknown`, every dispatch failed for a release while looking like success. **Type the seam as well as the call site**, since only `tsc` catches this class.
- **The Enter that sends must be its own `write_pty`**: a `\r` inside one chunk is a paste-newline rather than a submit (verified against the real CLI). Anything that *sends* rather than prefills inherits this.
- **Pass every argument a `#[tauri::command]` declares**, because Tauri rejects the whole invoke on one missing key, so an omitted argument is no call at all. `gh_claim` shipped three releases missing its `body`: no assignee, label or comment ever landed while the UI said *Started*. `ipc.test.ts` now compares both directions, and outcomes are read, so a half-landed claim says so on screen.
- **The viewer (`gh api user`) is cached per process, not per repo.**

**Three committed files, one rule**: `.episko/digest.md`, `.episko/episko.toml` (`[triage] keep`, `[claim]`), `.episko/notes.toml`. All are project facts, all `toml_edit` read-modify-write, all refusing to create themselves without an explicit yes, all needing **git rather than GitHub**.

**A day gets TWO generated sentences, and the split is what makes one committable** (`Scope` in `summarize.rs` picks the instruction as well as the record):

- **Yours** (`dayFacts`): your session titles and spend, from *this* machine. Never reaches a file; lives in `trail-summaries.json`; the day's headline.
- **The project's** (`projectDayFacts`): commit subjects, authors, PR events. Same facts for the whole team, therefore committable, and the half `.episko/digest.md` holds.

Committing the mixture is the bug the split fixes: `write_digest` replaces the day's key, so the committed line becomes whoever wrote last describing their own half; it reads fine and isn't the day. The split also keeps `spend: $…` out of a pushed file.

**Written for every closed day with commits; shown for some**: `sharedDay` shows the box only when more than one *human* committed (`isBotAuthor` filters). It deliberately does **not** ask "did somebody *else* commit", because that needs to know who you are, and `%an` vs `git config user.name` breaks on second machines, spellings, and co-authored commits.

`summarize_day` spends money (Haiku via `claude -p`), so it is cached, opt-in (`cc-digest-ok` per project, since a new committable file is a real side effect), and **read before generated** (`read_digest` parses the file first; the second person to open a week pays nothing for the shared half). Only *closed* days are written, because today's line would dirty a tracked file on every change.
