# The project dashboard

> Rules and their reasons, compressed — the full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

**Left-clicking a project opens it** — the header's own answer to "what is going on in this repo". **Every header shape must carry `data-dash`**: two of `renderSidebar`'s three shapes shipped without it for two releases — absent attribute → `closest()` null → silently inert, the same failure class `dispatch.test.ts` guards elsewhere.

**The key is `repoRoot ?? path`, because a checkout is not a project**: `splitByWorktree` keys groups by checkout dir while `dashDays` regrafts history onto the repo root (`histProject`), so a worktree-keyed dashboard matches no sessions; `splitByWorktree` carries `repoRoot` back for whatever needs it.

Split: **`dash.ts` pure and tested** (`projectTier`, `dashDays`, `dashPulse`, `projectCost`, `densePerDay`); **`dashview.ts`** data → string; **`dashboard.ts`** owns the pane, IPC, summary queue, events. Rides the `mirror` pointer (`kind: "dash"`), not a second flag. **Nothing runs until a project is clicked** — no probe at startup, nothing on `renderAll`.

**Three gates, and they are not the same gate** (`projectTier`, one `project_facts` call):

- **GitHub** — issues, PRs, claims (all `gh`; below).
- **git** — commits, checkouts, and *everything shared*: `.episko/` needs **git, not GitHub** (a GitLab/self-hosted remote is this tier — `parse_remote` mints a slug for `github.com` only). **The host in a remote URL may be an `~/.ssh/config` alias** (`Host github.com-work`), so `ssh -G <name>` resolves it (config-only, memoised) — a string match misfiles exactly the people with the most repos. Test trap: `git remote get-url` applies `insteadOf` rewrites, so fixtures use `example-org`.
- **neither** — sessions, spend, notes; none ever cared about git.

**A card with nothing to say is absent, not empty** (`missingCard` says once what the folder can't do). **A card not read yet is neither** — skeletons:

- **The waits are separate flags on purpose**: `loading` (local reads), `ghLoading` (starts later, ends later), `writing`/`stage` (model calls). One `isLoading` would skeleton what already answered.
- **`factsKnown` is not `loading`** — it asks whether `project_facts` answered *for the project on screen*; `tier` defaults to `none`, which is an assertion. The repo verbs and the `not a repo` chip hang off it.
- **Every write in `loadDash` is guarded by `root() !== r`, including `loading` itself** — two awaits, and a click during either would land the old folder's answers under the new name.
- A pending sentence is a mark beside the deterministic headline; the shared box is a real skeleton. Both reuse the usage screen's `.u-skel`/`.u-spin` — one loading vocabulary.

Easy to get wrong:

- **Per-project cost comes from `cc-usage-detail`, never `cc-usage`** (the plain rollup is every project at once). Older days legitimately lack the split → a dash, not `$0.00` — "we didn't keep this" and "it was free" are different facts. `DayDetail` carries a per-session `sess` map (read by `daySpend` → `costPopHtml`). **A split can fall short of the day's total, each split separately** — `cc-usage` banks from the first dollar, a later-shipped split starts mid-day — so `daySpend` gives **both** lists their own `unattributed` row; a split with *nothing* stays empty ("predates the record"). The half-cent floor: both figures are the same deltas summed in different order.
- **The list drops empty days and the sparkline must not**: `trailDays` omits them (blank rows read broken); `densePerDay` fills them back (two busy days a week apart must not render adjacent).
- **The header's four verbs act on the dashboard's project**: `activeProjectCtx`/`activeCwd` (panes.ts) answer for the dash mirror too, so ＋ / ❯ / ▶ / ◷ and every chord keyed off them treat it like a session's. `requestLaunch`'s two zero-IPC signals (a live session's `branch`, `dirtyByFolder`) only cover folders something is *running* in — hence `dashLaunchHint()` passes in what the dashboard already fetched, keeping the click synchronous (see `requestLaunch`'s comment for why nothing may be awaited before the dialog is up). The inspector's ＋ is that same single call — one verb that opens the worktree dialog when there's a branch to pick; `dashInspector` keeps the ellipsis only on a repo. `DashHost` carries **both** `launch` and `requestLaunch`: a dispatch has already decided where it's going, a person clicking ＋ has not.
- **⌘I collapses to a 44px rail here, not to nothing** — the dashboard's verbs live only in the inspector. On a session ⌘I still hides it fully. **The rail is the same verb set**, so an entry added to *Do something here* belongs in `dashStrip` too — two surfaces offering different verbs is worse than either alone.
- **`cleanup` opens the Branches view** — an enlarge overlay like *Checkouts* and *Open work*, repo-gated like *Commit graph…*. Its reads (`git_branch_list`, `list_worktrees`, `gh_merged_prs`) fire **when the view opens**, never with the rest of the dashboard: the pane's own invariant, one level down. It is the only overlay that acts rather than reports, so it carries the app's one bulk-destructive button — see `docs/worktrees.md` for the rules it enforces and `branches.ts` for where they live.

## The GitHub half

`ghwork.ts` owns the rules (tested); `claim.ts` owns what a dispatch writes. `gh_threads` is two `gh` calls per repo, cached 60s, and **degrades rather than failing** (`available: false` + reason — one quiet row, like a blocked runnable).

- **A claim is a hint, never a lock** — shown, warned once, then you proceed. Claims expire (`CLAIM_STALE_MS`; a sleeping laptop must not block a colleague), and `pty-exit` releases what a session took.
- **Preference AND `.episko/episko.toml`'s `[claim]`** — a project-disabled switch renders greyed, not hidden ("why can't I assign?" needs an answer).
- **`holderOf` reads in one order**: our ledger (knows unpushed dispatches) → assignee (the explicit human signal) → `agent:` label (a machine, which can't say whose).
- **Triage never offers a PR**, an assigned issue, or anything on the project's keep list.
- **`gh_close_issue` is the only destructive write, and it comments *before* it closes** — a failed close then leaves an explanation; the other order leaves a mystery.
- **Dispatch sends the prompt** — the one deliberate break of "Episko prefills, the human presses Enter": the confirm sheet *is* the reading. A colleague's shared note stays prefilled. Both halves need the session id back from `launch` — `panes.ts` returns `string | null` and `DashHost.launch` is typed to match; typed `unknown`, every dispatch failed for a release while looking like success. **Type the seam, not the call site** — only `tsc` catches this class.
- **The Enter that sends must be its own `write_pty`** — a `\r` inside one chunk is a paste-newline, not a submit (verified against the real CLI). Anything that *sends* rather than prefills inherits this.
- **Pass every argument a `#[tauri::command]` declares** — Tauri rejects the whole invoke on one missing key, so an omitted argument is no call at all. `gh_claim` shipped three releases missing its `body`: no assignee, label or comment ever landed while the UI said *Started*. `ipc.test.ts` now compares both directions, and outcomes are read — a half-landed claim says so on screen.
- **The viewer (`gh api user`) is cached per process, not per repo.**

**Three committed files, one rule**: `.episko/digest.md`, `.episko/episko.toml` (`[triage] keep`, `[claim]`), `.episko/notes.toml` — all project facts, all `toml_edit` read-modify-write, all refusing to create themselves without an explicit yes, all needing **git, not GitHub**.

**A day gets TWO generated sentences, and the split is what makes one committable** (`Scope` in `summarize.rs` picks the instruction as well as the record):

- **Yours** (`dayFacts`) — your session titles and spend, from *this* machine. Never reaches a file; lives in `trail-summaries.json`; the day's headline.
- **The project's** (`projectDayFacts`) — commit subjects, authors, PR events: same facts for the whole team, therefore committable — the half `.episko/digest.md` holds.

Committing the mixture is the bug the split fixes: `write_digest` replaces the day's key, so the committed line becomes whoever wrote last describing their own half — it reads fine and isn't the day. The split also keeps `spend: $…` out of a pushed file.

**Written for every closed day with commits; shown for some**: `sharedDay` shows the box only when more than one *human* committed (`isBotAuthor` filters). It deliberately does **not** ask "did somebody *else* commit" — that needs to know who you are, and `%an` vs `git config user.name` breaks on second machines, spellings, and co-authored commits.

`summarize_day` spends money (Haiku via `claude -p`), so it is cached, opt-in (`cc-digest-ok` per project — a new committable file is a real side effect), and **read before generated** (`read_digest` parses the file first; the second person to open a week pays nothing for the shared half). Only *closed* days are written — today's line would dirty a tracked file on every change.
