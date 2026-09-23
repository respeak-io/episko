# The project dashboard

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

**Left-clicking a project opens it**, the header's own answer to "what is going on in this repo". **Every header shape must carry `data-dash`**: two of `renderSidebar`'s three shapes shipped without it for two releases: absent attribute → `closest()` null → silently inert, the same failure class `dispatch.test.ts` guards elsewhere.

**The key is `repoRoot ?? path`, because a checkout is not a project**: `splitByWorktree` keys groups by checkout dir while `dashDays` regrafts history onto the repo root (`histProject`), so a worktree-keyed dashboard matches no sessions; `splitByWorktree` carries `repoRoot` back for whatever needs it.

**Three columns, left to right, each answering one question**: `#dashHere` (*where you are* — the sessions running here, the verb tiles, the branch and its position, the checkouts), `#dashMoved` (*what moved* — the *Since you were last here* band, the working set, and *Landed*), `#dashNext` (*what's next* — one ranked queue). The reading order is the decision order, which is why the queue is last and the verbs are first.

Split: **`dash.ts` pure and tested** (`projectTier`, `dashDays`, `dashPulse`, `projectCost`, `densePerDay`, `sinceFacts`), **`queue.ts`** the queue's rules, **`graph.ts`** `foldBots`; **`dashview.ts`** and **`landedview.ts`** data → string; **`dashboard.ts`** owns the pane, IPC, summary queue, events. Rides the `mirror` pointer (`kind: "dash"`) rather than a second flag. **Nothing runs until a project is clicked**: no probe at startup, nothing on `renderAll`.

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
- **The list drops empty days and the ribbon must not**: `trailDays` omits them (blank rows read broken); `densePerDay` fills them back (two busy days a week apart must not render adjacent) and stamps each bar with its own midnight, so the strip can name the day under the pointer.
- **The ribbon is bars, one a day, never a line.** A line drawn between two counts invents the days in between, and over thirty points it reads as one continuous story where the truth is a dozen quiet days — the exact failure `densePerDay` exists to prevent, re-introduced by the renderer. `barstrip` (./format) scales to the busiest day, floors every other bar at a 3px stub (a gap in the row reads as "nothing recorded"), and lights the newest seven. It draws only for a repo: a plain folder would get a flat row of zeroes about a fact it does not have. **The hoverable, clickable day is the full-height `.sb-b` column, never the bar** — a real `<button>` carrying the app's one `data-tip`, because a quiet day's bar is a 3px sliver and the quiet days are precisely what the strip exists to show.
- **Clicking a day opens that day, and it never reaches disk.** `git_log_days` already hands the pane every commit in the window, so `dayCard` (./dash) re-reads what `dashDays` assembled — the figures, the commits (subject, short sha, author, capped at `DAY_ROWS` with the tail *counted* rather than printed) and the sessions — and ./menu draws it anchored to the bar. This is the day-by-day timeline the band replaced: gone as a standing surface, back as a click. **Three rules.** The geometry is ./format's (`barRow`) but the **markup is the view's**, because each column is a click target and a `data-dash*` attribute is only under contract where `test/dispatch.test.ts` reads it. A commit row's pick carries every character `git_log_days` kept (9, its own truncation) while the row shows seven — the rail has no width for more and `git show` needs more than seven. **Open the commit graph** carries the day with it (`GraphMark`), so the panel opens already paged down to that day with its commits lit — a highlight and not a filter, for the reasons in docs/commit-graph.md. And a **session row is shown, not offered**: there is no resume-by-id verb on `DashHost`, and a row that looks like a door onto nothing is worse than a row that plainly is not one.
- **The header's four verbs act on the dashboard's project**: `activeProjectCtx`/`activeCwd` (panes.ts) answer for the dash mirror too, so ＋ / ❯ / ▶ / ◷ and every chord keyed off them treat it like a session's. `requestLaunch`'s two zero-IPC signals (a live session's `branch`, `dirtyByFolder`) only cover folders something is *running* in, hence `dashLaunchHint()` passes in what the dashboard already fetched, keeping the click synchronous (see `requestLaunch`'s comment for why nothing may be awaited before the dialog is up). The inspector's ＋ is that same single call: one verb that opens the worktree dialog when there's a branch to pick; `verbTiles` keeps the ellipsis only on a repo. `DashHost` carries **both** `launch` and `requestLaunch`: a dispatch has already decided where it's going, a person clicking ＋ has not.
- **The band is measured from your last visit, not from midnight — and the cut is the instant, not
  the day.** The day timeline it replaced was a full-height list nobody scrolled; what gets read is
  the last thing that happened. `sinceFacts`
  answers it and `cc-dash-seen` holds one stamp per project, read through `readObj` and repaired to
  NFC like every other path key. A commit and a session each carry their own timestamp, so the
  window is cut where you left it; the whole-day rule this replaced re-counted the day you were
  standing in, which made **Mark read** a button that moved no figure on any project whose work was
  all today. **Spend cannot follow**: `cc-usage` is one figure a day, so a day's cost counts only
  once the whole day is inside the window — under-reporting the day you left rather than charging
  an hour's gap with everything you spent before it. **The band never shows nothing.** `quiet` (nothing
  left in the gap) is the state *Mark read* produces, and `bandFacts` answers it by falling back
  to the **whole window** rather than emptying the card: the ribbon and the last few days'
  sentences hang off these figures, and a card that blanks itself takes them with it and reads as
  breakage. `SinceFacts.window` is what the wording keys off — **four headings, never
  interchangeable** (first look / the window, capped / the window, caught up / the window, and a
  real gap), with the `sb-ago` slot carrying whatever the heading does not: the visit for the
  first three, the span for the last. *Mark read* is offered on `!window` alone, so it is absent
  exactly when there is nothing left to mark. `summaryDays` reads `bandFacts` too — it decides
  which days a `claude -p` is bought for, and buying a sentence the band will not print, or
  printing a day nothing was bought for, are the same bug from opposite ends. **`openDashboard` reads the stamp before it writes it** — the other
  order makes the band permanently say nothing moved, and no test catches that, so the ordering is a
  comment at the call site. `first` (never opened) and `capped` (the stamp predates the window) are
  different facts with different wordings and must not collapse into one flag; the band's *in the
  last N days* number comes from the **range**, never from `SinceFacts.days`, which is the true age
  of the stamp and can exceed the window. The sentences are the ones `summarize_day` already wrote —
  the band chooses among them and never pays for a new one.

- **The queue is one list because the four cards were four versions of one question.** *Open work*,
  *Still needed?*, *Dependencies* and *Notes* each asked what to start next here. `rankQueue` merges
  them; **a thread that is both open work and a triage suggestion is ONE row at its better rank**,
  carrying its `triage` reason, which is what stops `#37` being two rows in two cards four inches
  apart. Quiet is a facet on a row, not a source. Ties break on `moved` then `key.localeCompare`, so
  a coalesced repaint never reorders a row under the pointer, and `queueTally` is called on the
  **unfiltered** items so a chip says what it would reveal. Three verbs deliberately did **not**
  come across: `deprun` needs the Dependencies overlay's tick set and would be a button that visibly
  does nothing, `unkeep` is an undo on a keep list and has no row in a queue of open work, and
  `share` writes a committable file and the card carries no `canShare` fact. Each still lives in its
  overlay, which is what keeps `dispatch.test.ts`'s probe list satisfied.

- **The search is the pool, not a seventh chip.** `searchQueue` runs before the filter and before
  `queueTally`, so a chip says what it would reveal *within* the search rather than what the project
  has. It matches everything a row says plus the words its chip stands for — `iss 37`, `adv`,
  `quiet`, none of which any field spells out — every term must match, and it is a plain substring:
  this is a filter box, not a ranker. The box lives in painted markup, so `keepCaret` puts the focus
  and the caret back after each repaint (the Branches filter's own trick, now shared by both). The
  head it sits in is **sticky**, and the enlarge link is right-aligned in it and names the view it
  opens: a narrowed list you have to scroll back up to escape is the trap this shape avoids.
- **A run of rows that say the same thing stands behind ONE row, where the ranking already put
  them side by side.** `groupKey` names what a row is one of — the bot that opened a pull request,
  or the fact that a package is behind — and everything else answers null: an advisory, an issue
  and a note are never folded away. `foldQueue` takes runs of `FOLD_MIN` (3) or more, since folding
  a pair behind a click says less than the pair did (./graph's `foldBots`, the precedent, answers
  the same way), and a fold sits at **one rank**, so dependabot's ready-to-merge run and its
  blocked run are two folds that open apart. The head row says how many, whose, and the one fact
  that decides whether you open it — *all ready to merge*, or the blockers they share, commonest
  first, **with no count in front of them**, because `prBlockers` already spells its own ("3 checks
  failing") and a second number says it twice.
- **`rankQueue` clusters before it returns, or the fold would be a lie.** Two bots run nightly, so
  recency alone lands their pull requests `d, r, d, r, d, r` and no run reaches three; "16 from
  dependabot" with five more scattered below is a count you cannot act on. A group sits where its
  FIRST row ranked, so it overtakes nothing and no row crosses a rank boundary, and the seat is
  derived from the sorted list, so a repaint of unchanged state reorders nothing. Which folds are
  open lives in `dashboard.ts` and is **cleared on the project switch** — what you unfolded to read
  once is not a preference, and it never reaches `localStorage`. **A search folds nothing**
  (`plainRows`): its result is the pool you asked for, and hiding part of it behind a count is the
  opposite of narrowing.
- **A row's SECOND verbs are collapsed until the row is under the pointer** (`qacts`/`.qacts`,
  opened by `:hover` and by `:focus-within`, so Tab never lands on a button nobody can see): ✓ / ✕
  on a quiet issue, ⤢ into the reader, ↗ to GitHub, ✕ on a note. **▶ is never in that box** — it is
  what the row is *for*, and a list whose one verb appears only on hover is a list you have to hunt
  across to find out what you can do with it. An **age is not a verb** either and stays put.
- **The list is every row, because the column is a scroller** with a sticky head and a pinned foot.
  The 8-row cap and its `…and 14 more` belonged to a card in a column that scrolled as one piece;
  under a sticky head they made a list that ended in an apology where there was room to read. The
  enlarge link still opens the full board, and `rankQueue`'s order is what decides the top of the
  list — which is why a triage suggestion still LEADS its rank rather than relying on any cap.
  **A scroller that is repainted must be put back where it was**: `#dashNext` is itself the
  scrolling box, so the assignment that rebuilds it resets `scrollTop`, and the GitHub answer and
  the dependency scan both land seconds after the pane opens. `paintNext` keeps the position as
  `paintOverlay` keeps the overlay's — and both ask `wouldPaint` FIRST, because `scrollTop` is a
  layout read and this runs on `renderAll`'s path, where a read on an unchanged pass forces the
  reflow the paint cache exists to avoid. The cache itself is now this module's alone (nothing
  else writes these four ids), so `invalidatePaintCache` is only about the project switch.
- **The composer is pinned to the foot of the column and opens on focus.** It is still static markup
  outside everything this module paints — a draft note must survive the GitHub answer landing two
  columns over — and what changed is that `#dashNext` scrolls while the form does not, so the one
  thing on this pane you type is never scrolled away from. Stacked (≤1320px) the column hugs its
  content again and the foot travels with it, which is the same arithmetic rather than a special case.
  It is a **textarea**, so a note can be more than a line; a textarea swallows Enter, so `dashboard.ts`
  binds Enter to file it and leaves ⇧Enter for the second line, which is exactly what the hint says.
  The hint says **only** that, plus where sharing happens: a note is shared by flipping *shared* on it
  in the Notes view (`.episko/notes.toml`), which is nowhere near this box, so the hint carries a
  `Notes ⤢` of its own rather than a sentence about a switch you cannot see. `.nt-form .nt-row button`
  is scoped for the same reason — the unscoped `.nt-form button` put a 25px square around that link.
- **Every control in the column explains itself through ./dom's `data-tip`**, never through a
  native `title`: one tooltip, styled like the app, as the cards in column A already use. Two
  things follow. An empty filter chip is **`aria-disabled`, not `disabled`** — a disabled control
  swallows the pointer events `wireTips` listens for, so the tip saying *why* the chip is empty
  would never appear — and the pane's listener refuses the inert half instead. And a tip is a
  sentence rather than a label: the glyph is already on the button.
- **⤢ on a row pulls the thread INTO Episko** (`gh_issue` → ./issue → ./issueview, the `"issue"`
  overlay): the description and every comment, rendered by ./issue's own markdown — enough for a
  thread and no more, so what it does not know renders as the paragraph it looks like, where
  half-parsing would quietly drop somebody's words. Three rules hold it. A link is **http(s) only**
  and opens through the pane's own `data-dashurl`, never by navigating the webview; an **image is
  drawn as a link and never fetched**, because rendering one reaches the network for whatever a
  stranger put in an issue; and the panel **writes nothing** — its ▶ opens the same dispatch sheet
  the row's does, so a claim is still shown before it is posted. The read is cached on the board's
  own TTL (dropped with it by `gh_invalidate`, by key prefix since it is keyed by root AND thread —
  which is also why it is the one cache here with a size cap: every other is bounded by the projects
  you open, this one grows with every ⤢) and is guarded on the project **and** the thread:
  a second ⤢ while the first is in flight must not paint the wrong body under the title. Past twenty
  comments the panel says where the rest is rather than growing without end.
- **A bot run in *Landed* is folded, never filtered.** The section is one page of `git_graph` at
  `scope: "all"` — every ref, because the question is what the branch you are *not* on has been
  doing, and because `"head"` errors on an unborn HEAD where `"all"` returns an empty page (which
  renders as an **absent** card, not a broken one). `foldBots` takes `layoutGraph`'s **rows**, never
  its commits: drop a commit and you drop its lane, the row below becomes a child whose parent is
  off the page, `layoutGraph` opens a fresh line for the tail and every row under it changes colour
  and column. A run only folds when it is consecutive on one lane and line with an unchanged
  `through` set, carries no refs, and is not row 0 — a ref on a folded commit would vanish silently.
  **How much of that page is drawn is MEASURED** — `fitLanded`, the one measured number on this
  page, and the exception to the rule that this pane reads no layout. The section is last in
  column B, so what it should show is "however many rows fit under the working set", which is the
  window's answer and not the project's: a fixed eight left a third of a tall column empty and
  overflowed a short one. Three things make that safe. The measurement is **relative** — `free` is
  the slack the last paint left over (the column's `clientHeight` minus its last child's bottom,
  plus `scrollTop` so the reading does not move when the column scrolls), and the count changes by
  whole `ROW_H` rows, so it settles on the **next** pass and cannot oscillate. It is taken **only
  after a pass that actually wrote** (`paint` now reports that) plus on a `ResizeObserver` over the
  column, because ⌘I, the rail and the window are the three things that move the box without an
  event this module hears, and because a layout read on every `renderAll` frame would force the
  reflow the paint guards exist to avoid. And it **never grows past what the page can fill**
  (`landedDrawn < landedFit` holds the count): banking room a short history cannot use would spend
  it in one overflowing paint on the next project. A column that hugs its content — the stacked
  breakpoints, where there is no bottom to fill to — measures `free === 0` and is left alone, which
  is the same arithmetic rather than a special case. `LANDED_MIN` (3) is the floor: a column too
  short for even that is one whose band alone overflows, and hiding the section would not fix it.
  `hidden` and `span` are counted over the rows SHOWN: the chip must not stand for commits nothing
  on the page hides, and the graph cell must not keep a track no visible row reaches.
  **A ref chip wears its own line's colour** (`--lane`, `laneColor(row.line)`), which is what
  retired the lane legend: a list of names above eight rows said in words what the rows were
  already saying in colour, and it cost a line of vertical space per repaint. HEAD keeps the accent
  — it marks the checkout rather than a line — and a tag keeps its own, since a tag is a moment and
  never a lineage (`lineRef` will not name a lane after one either).
  `.lgrow`'s CSS height **must** equal `ROW_H`, and the cell is one fixed width, unlike the panel's
  per-row silhouette: over eight rows in a narrow column an aligned subject buys more than the
  silhouette does. Everything the panel is good at — paging, the message overlay, the scroll spy —
  stays in the panel, which is what the ⤢ opens, from the header and from the foot of the list.

- **⌘I folds the queue column; there is no rail.** It collapsed to a 44px strip for four releases
  because the pane's verbs lived only in the inspector — and they never had to: the stage header's
  ◷ ❯ ▶ ＋ already act on the dashboard's project (`activeProjectCtx` checks `dashMirror()` first),
  so four of the old *Do something here* rows were a second copy of buttons already on screen. The
  verbs that were genuinely only there are now `verbTiles` in column A, the inspector column is
  hidden outright on this stage (`.app.stage-dash`), and `⌘I` toggles `#dashPane.fold-next`. A verb
  reachable only while collapsed was a verb nobody found; deleting the surface is what fixed it,
  not keeping the two in step. **◨ itself stays on every stage**, including this one: the fold is a
  verb the pane has and nothing else offers, so hiding the button would leave the chord as the only
  way to find it. Only the fleet disables it, and a disabled button has to stay *visible* or the
  reason it gives is a tooltip nobody can reach. `syncStageButtons` lights it from the truth for
  whichever stage is up — `fold-next` here, `insp-off` elsewhere — so the two cannot drift. **Every `data-dashact` surface is still dispatched by one if-chain
  through `#dashPane`'s single listener**, and `dispatch.test.ts` still holds both halves in both
  directions across four surfaces (`verbTiles`, `repoCard`, `ghPicker`, `landedCard`): a row whose
  verb has no branch is a button that does nothing, a branch nobody emits is code that cannot run,
  and neither is visible to `tsc` or to a reader of either file alone.
- **`cleanup` opens the Branches view**, an enlarge overlay like *Checkouts* and *Open work*, repo-gated like *Commit graph…*. Its reads (`git_branch_list`, `list_worktrees`, `gh_merged_prs`) fire **when the view opens**, never with the rest of the dashboard: the pane's own invariant, one level down. It is the only overlay that acts rather than reports, so it carries the app's one bulk-destructive button; see `docs/worktrees.md` for the rules it enforces and `branches.ts` for where they live.
- **The main checkout's git verbs live in the Checkout section of column A, not in a menu.** They were rows there for one release and it was the wrong shape: a verb in a twelve-row menu is a verb you go looking for, and the pane is called an overview, so where the repo stands belongs *on* it. That is also why the card carries state at all: a row of buttons with no branch and no counts above them answers nothing. It states the position **once** (`syncLine`) and lets each button's tooltip say what that button would do with it; two sentences over the same numbers is how a pull row and a push row drift apart. `upName` trims the branch off a tracking ref that merely repeats it (`main` tracking `origin/main` reads "origin"), since the header already says the branch; a ref with a different name stays spelled out. Uncommitted work is **not** on that line, though it was for four releases: it is the Working set card's, directly above, and `switchSub`'s tooltip is what still names the dirty-tree refusal — on the button that does the refusing. **Every verb acts on the repo's main worktree**, never on whichever folder is highlighted (`mainCheckout`, from the `worktree_heads` the pane already bought, with the root as fallback, so a failed probe doesn't make a verb vanish).
- **The Working set card is the main checkout's uncommitted work, and it is a door rather than a list.** Its enlargement is named (*Review N files ⤢*) rather than wearing the bare ⤢ every other card uses: it is the one control on the pane people open it to press. `git_working_set` is `git_diffstat`'s own process with the entries kept, so naming the files costs nothing over counting them, and `WorkingSet extends DiffStat` means the Repository card reads the same object rather than a second read of the same folder. It draws `wpeekHtml` — the peek the inspector and the external mirror already draw — over `fileSetHtml`'s rows, so a working set looks the same in all four places it is asked about. **Absent when clean, a skeleton until the read lands**: pending is not clean, the same three states the rest of the pane keeps apart. **No `⤢`**, because this card's enlargement is the diff overlay, a global modal, and `data-dashopen-view` must keep meaning exactly one mechanism (`#dashOverlay`). Its clicks are the one thing on this pane that `#dashPane`'s listener never sees: peek and rows carry `data-diff`, so they fall through to main.ts's document dispatcher, and `closest()` hands it the row rather than the block for the same reason `data-forget` beats `data-past`. A row adds `data-difffocus`, which opens the overlay with that file unfolded, as the explorer's ↵ does. **It is re-read on a 15s gate** (`refreshDashWorkset`, driven from main.ts beside the dirty-dot sweep), because a working set goes stale under a running agent and this pane otherwise runs nothing on a schedule; a git op in flight skips the tick, so a `syncMain` mid-fetch is never raced.
- **A checkout nothing is running in had never been measured, and the card called it `clean`.** `folderDirty` reads `dirtyByFolder`, which `refreshDirtyStates` fills from live agent panes and external sessions and then prunes of everything else — so for the whole life of the Checkouts card, every worktree without a session rendered the green tag. The map's `undefined` (never read) and `null` (read, not a repo) already carried the distinction, so the card reads `dirtyByFolder.get()` directly and shows three states: `—`, `clean`, `N uncommitted` — the count, because 1 against 40 is the entire question. The sweep now also measures the checkouts of the project **on the stage**, so the answer arrives rather than the guess, and the prune drops them when the dashboard closes. ./health's `measured: false` must never render as clean, one feature over. A row is a door onto its own diff **only while it is dirty** (`.cr[data-dashwt]` carries the cursor); `data-dashwt` was emitted from the day the card shipped, probed by nothing and styled `cursor: pointer`, and `dispatch.test.ts` now compares every `data-dash*` both ways rather than only the verbs. The ＋ and ❯ are nested **inside** that row, so they must stay probed before it: `return` ends a branch, not the propagation.
- **⇣ Pull and ⇡ Push both fetch first, always.** Nothing here runs git on a schedule, so the ahead/behind the card shows is as old as the last fetch, and `git_action` short-circuits on exactly that stale count: a pull reports *already up to date* without reaching the remote, and a push runs against a `behind` it has no reason to believe, so the rejection comes back as a raw non-fast-forward instead of as the sentence naming the fix. Fetch, re-read, then decide; every wording says which number it is reading and how fresh it is. The `loadDash` probe is a `git_diffstat` rather than a fetch: a network round trip per project click would tax the one thing this pane promises is free, and can hang for the full 45s timeout. `syncState` is one reading for both verbs, which is why `ahead` is its own state rather than a flavour of `level`: unpushed commits are the quiet answer for the one and the entire point of the other. It is also why only *busy* greys them: `no-upstream` and `diverged` are precisely the cases the backend refuses with the command that works, handed to a prefilled terminal (`DashHost.handToTerminal`), and disabling them would amputate the useful half. `syncing` holds the **root and the op** rather than a boolean, so switching project mid-pull doesn't put "Pulling…" on a dashboard where nothing is; it greys **both** buttons (one git process at a time, or the second decides against counts the first is still moving) and is deliberately absent from `openDashboard`'s reset, since a git process does not stop because you looked elsewhere. **A pull that landed reloads the whole pane; a push does not**: new commits bring a colleague's `.episko/digest.md` and notes with them, which is most of the point of pulling from here, whereas a push changes nothing the timeline reads and pays only for the re-read of the counts.
- **⇄ Switch branch opens the ⑃ dialog on its switch card rather than switching** (`DashHost.switchBranch` → `openWt(…, { manage: true, armSwitch: true })`, the same route the ⑃ cluster menu's *Switch branch…* row takes). Every guard the verb needs already lives in that card: work in flight in the folder, a branch another worktree holds, the dirty-tree refusal (git would carry uncommitted changes across), and a remote-only target that has to be cut from `origin/…` and set to track it. A second copy of four guards is four things to keep true. The switch card seeds its branch from what the dashboard already fetched, or it reads `—` until its own git call lands. Coming back, `setWtOnBranchSwitched` → `dashBranchSwitched` re-reads the pane in full: the timeline is a `git log` on that folder, the ⇣ ⇡ rows name the branch and its upstream, and the Checkouts card lists what each folder is on, so none of it is patchable from a branch name. It is guarded on the project, since the same dialog is reachable from the sidebar while a different project's dashboard holds the stage.

## The GitHub half

`ghwork.ts` owns the rules (tested); `claim.ts` owns what a dispatch writes. `gh_threads` is three `gh` calls per repo (issues, PRs, viewer) cached 60s, and **degrades rather than failing** (`available: false` + reason, one quiet row, like a blocked runnable). A project pinned to an account spends two, not three — the pin *is* the viewer.

**Two orderings decide how long the card takes, and both were wrong in the same direction: the network waited on things it does not depend on.**

- **`loadGh` is fired *first*, before the local reads**, right after `project_facts`, which is the only thing it needs. Fired last, the network could not begin until a scan of every transcript on the machine had finished: ~1–2s of local reads in front of ~1.3s of `gh`, a total explained by neither half. "The timeline should paint without waiting for the network" is satisfied by not **awaiting** it, which was always the case, and not by starting it late.
- **The GitHub cards cross the `loading` branch** (`ghCards`, built once and emitted in both). Firing early only helps if an early answer can be *shown* early, and that branch used to switch the whole column. This is the same exemption Notes always had. It also gives the GitHub half a **skeleton of its own** during the long read; one generic `cardSkeleton` stood in for up to four cards, so the card people open the dashboard for read as absent rather than pending.
- **The three `gh` calls run concurrently** (`std::thread::scope`, inside the existing `spawn_blocking`): 662 + 605 + 457 ms sequential measured against a real repo, 1.7–2.3s wall clock vs 0.7–1.0s for the same three at once. The viewer is now probed even when the issue read fails, which is consistent rather than new: that is the same gh-missing/logged-out failure `viewer_login` already caches deliberately, and the one case the two differ (a non-GitHub folder) is exactly where `gh api user` still answers, being repo-independent.

- **The Dependencies card is the GitHub half's fourth card and has rules of its own** (`docs/dependencies.md`): it shares `gh()`'s account-and-token path, degrades on its own (the alert scope 403 is commoner than a gh outage, so a failed alert read must not take the bot-PR list down with it), and is the one card that still says something on a **non**-GitHub project, because the manifests and the package-manager scan need neither GitHub nor git.
- **A claim is only ever a hint**: shown, warned once, then you proceed. Claims expire (`CLAIM_STALE_MS`; a sleeping laptop must not block a colleague), and `pty-exit` releases what a session took.
- **Preference AND `.episko/episko.toml`'s `[claim]`**: a project-disabled switch renders greyed rather than hidden ("why can't I assign?" needs an answer).
- **`holderOf` reads in one order**: our ledger (knows unpushed dispatches) → assignee (the explicit human signal) → `agent:` label (a machine, which can't say whose).
- **Triage never offers a PR**, an assigned issue, or anything on the project's keep list.
- **`gh_close_issue` is the only destructive write, and it comments *before* it closes**: a failed close then leaves an explanation, the other order leaves a mystery.
- **Dispatch sends the prompt**, the one deliberate break of "Episko prefills, the human presses Enter": the confirm sheet *is* the reading. A colleague's shared note stays prefilled. Both halves need the session id back from `launch`: `panes.ts` returns `string | null` and `DashHost.launch` is typed to match; typed `unknown`, every dispatch failed for a release while looking like success. **Type the seam as well as the call site**, since only `tsc` catches this class.
- **The Enter that sends must be its own `write_pty`**: a `\r` inside one chunk is a paste-newline rather than a submit (verified against the real CLI). Anything that *sends* rather than prefills inherits this.
- **Pass every argument a `#[tauri::command]` declares**, because Tauri rejects the whole invoke on one missing key, so an omitted argument is no call at all. `gh_claim` shipped three releases missing its `body`: no assignee, label or comment ever landed while the UI said *Started*. `ipc.test.ts` now compares both directions, and outcomes are read, so a half-landed claim says so on screen.
- **The viewer (`gh api user`) is cached per process, not per repo** — for gh's *active* account. A project pinned to another account never reaches that cache: its login is already known, so `viewer_login` returns it without a process. Caching one login per process is what made two accounts indistinguishable, and claims are what pay for it ("mine" vs "a colleague's" is that string compared to an assignee).

### Two GitHub accounts on one machine

**`gh` has one active account per host and switches it globally** (`gh auth switch`), which is fine for one identity and useless for two at once — a work account and a personal one, the situation an `~/.ssh/config` alias in a remote (`git@github.com-work:org/repo.git`) usually exists to keep apart. Episko already resolves that alias to mint the slug (`parse_remote`), so the dashboard finds the repo and then `gh` reads it as the wrong person.

- **The failure names nothing.** GitHub answers a private repo your token cannot see exactly as it answers one that does not exist: *Could not resolve to a Repository with the name 'org/repo'*. Nothing in it mentions an account, so it reads as a typo or a deleted repo, and the fix — which is a *setting* — is invisible. `classify` therefore takes the login the call ran as and says "signed in as X, which cannot see this repository". Nothing else in the failure can point at the fix.
- **The choice is per project, in `localStorage` (`cc-gh-account`, keyed by `colorKey`), never committed.** Which of *your* accounts you are is not a project fact; a colleague pulling the repo has their own. Same shape and same reasoning as the per-project agent override (`cc-agent-by-project`).
- **`GH_TOKEN` is how an account is chosen, per call.** gh has no per-invocation account flag, so `gh()` reads that account's own token back out of gh's keyring (`gh auth token --user`) and hands it to the one child process. No global switch, no config written, nothing another project can trip over. The token is **never cached and never logged**: gh refreshes them on its own schedule, and the read costs ~40ms in front of a ~600ms network call.
- **A pin gh has forgotten is an error, not a fall-back.** `account_token` fails loudly rather than letting the call run as the active account — falling back is precisely what the pin was set to prevent, and it would put a *different* account's issues under this project's name. `ghWho`'s `known: false` is how every surface shows that state instead of quietly ticking nothing.
- **The pin is passed as an argument, never pushed to the backend as a map.** Every `gh` command takes `account: Option<String>`, read at the call site with `ghAccountFor(root)` — one copy of the preference, and `ipc.test.ts` fails if a call site forgets it. (A backend-held mirror of a frontend preference is the "second copy that can go stale" the agent override is written to avoid.)
- **Switching accounts drops every cache for that repo** (`gh_invalidate` plus `dep_invalidate`), because the board, the day's activity and the merged-PR evidence were all answered by the identity you have just stopped using. A board that repaints as the new account beside a triage list that is still the old one is worse than either alone.
- **The picker is offered in two places and only where it can change an answer** (`ghPickable`: more than one account). In the project menu beside the agent picker, which is where per-project preferences live; and *inside the GitHub card that failed*, because that card is where you find out the setting exists. One account is not a choice.

**Three committed files, one rule**: `.episko/digest.md`, `.episko/episko.toml` (`[triage] keep`, `[claim]`), `.episko/notes.toml`. All are project facts, all `toml_edit` read-modify-write, all refusing to create themselves without an explicit yes, all needing **git rather than GitHub**.

**A day gets TWO generated sentences, and the split is what makes one committable** (`Scope` in `summarize.rs` picks the instruction as well as the record):

- **Yours** (`dayFacts`): your session titles and spend, from *this* machine. Never reaches a file; lives in `trail-summaries.json`; the day's headline.
- **The project's** (`projectDayFacts`): commit subjects, authors, PR events. Same facts for the whole team, therefore committable, and the half `.episko/digest.md` holds.

Committing the mixture is the bug the split fixes: `write_digest` replaces the day's key, so the committed line becomes whoever wrote last describing their own half; it reads fine and isn't the day. The split also keeps `spend: $…` out of a pushed file.

**Written for every closed day with commits; shown for some**: `sharedDay` shows the box only when more than one *human* committed (`isBotAuthor` filters). It deliberately does **not** ask "did somebody *else* commit", because that needs to know who you are, and `%an` vs `git config user.name` breaks on second machines, spellings, and co-authored commits.

`summarize_day` spends money (Haiku via `claude -p`), so it is cached, opt-in (`cc-digest-ok` per project, since a new committable file is a real side effect), and **read before generated** (`read_digest` parses the file first; the second person to open a week pays nothing for the shared half). Only *closed* days are written, because today's line would dirty a tracked file on every change.

**Two different gates, and only one of them is a question.** `cc-digest-ok` gates the *committed* half — writing `.episko/digest.md`, asked once per project. Your own day lines are not gated by it: opening a project dashboard generates them for the days in range as soon as it loads. The master switch is `cc-dash-summaries` (`dashSummaries`), which **defaults on and has no control yet** — `setDashSummaries` is exported and nothing calls it — so the only way to stop the spend today is the stored key. Wiring it into Settings › Dashboard is the missing half.

## The fleet screen (the home stage)

Every project at once, and the one screen that is *not* about a project. `fleet.ts` owns the rules, `fleetview.ts` the markup (`data-fl*` only, its own half of `dispatch.test.ts`), `fleetui.ts` the pane, its reads and its clicks. It rides the stage pointer (`kind: "fleet"`) rather than a second flag, and it is **`takeStage("home")`** — so, unlike the project dashboard, its two reads do run at boot and on every exit from the stage. A return home inside `FLEET_FRESH_MS` re-reads nothing, and its `git_diffstat` per project is deliberately kept off the recurring dirty sweep (./mirror): a screen that is up whenever nothing else is must not put a git process per project on a 15s loop.

- **A band of five figures, then three columns**: live sessions, needs you, spend, tokens, week used — a tile each, because the band is read before anything under it and a row of inline figures reads as a caption to the title. Under it: who wants something, the projects, what it cost.
- **The left column is labels and rows, never cards.** Three boxed headings over three rows each is a form; a section says its count beside its label and its own sentence when it has nothing, since a box that empties itself is indistinguishable from one that failed.
- **The projects are cards, and the toggle is a layout rather than a filter** (`cc-fleet-layout`). ▦ is one card per project — the live glyphs, the window's commits a bar a day, the branch, the uncommitted count, the spend and the age; ☰ is the same facts on one line, for a fleet too long to scan. Nothing is dropped between the two.
- **One window for the whole screen** (`cc-fleet-range`, 7/14/30 days). The commit scan is the range's, so a change re-reads rather than re-slices, and the guard on the answer is the range as well as the stage — a 30-day scan landing after a switch to 7 must not repaint it. **Which load owns `loading` is `loadSeq`, and the flag is cleared before the stage guard**: only the newest load may clear it, or an abandoned one takes the spinner off a screen that is still reading — and a load abandoned because you *left* has to clear it on the way out, since `FLEET_FRESH_MS` then short-circuits the reload that would otherwise have fixed it and the screen says "reading every project…" with nothing reading. `fetchedAt` is deliberately left unset on that path, which is what makes the next open re-read rather than treat the stale answer as fresh.
- **A branch chip costs no git process.** `worktree_heads` reads `.git/` (docs/worktrees.md), so the screen buys one file read per project for the branch and the checkout count. Nothing read plus a `git_diffstat` of `null` is *not a repo*; an unswept folder is `—` and must never render as clean — ./fleet keeps the three states the dashboard's Checkouts card keeps.
- **Money is by project NAME**, as `cc-usage-detail` records it, so two repos sharing a basename sum into one figure that cannot be un-merged afterwards; the card's tip says which it is rather than pretending. Per-model **tokens** come from the token days and per-model **cost** from `cc-usage-detail`, joined on the display name ./usage already puts on both.
- **The needs-you figure and the rows under it are one set** (`attnPending` injected, never raw `needsYou`), or one screen carries two numbers for one question. The tile's sub-line is `needsSplit`, and asking leads it: it is the only one of the three with a process held open behind it.
- **A session running outside Episko is still a live session.** The externals registry feeds *Live now* and each card's glyph row, and `FleetCard.live` counts both kinds — the band and the rows must not answer one question with two numbers. `needs` and `urgency` stay ours alone: an external has no hooks behind it and can want nothing. Its row opens the read-only mirror (`data-flext`) and carries **no ✕**, because the terminal it runs in is not ours to close.
- **The two halves of the money column come from different places, and only one of them is a scan.** Tokens are `token_usage_by_day` over `~/.claude` — the whole machine, including every `claude` run outside Episko — and it used to be triggered only by opening the Usage window, so this screen's token half sat blank until you did. The home stage now asks for it on open (`FleetHost.refreshUsage`, throttled to ten minutes of its own). **Dollars are not a scan**: `cc-usage` is Episko's own telemetry ledger, written from the statusLine's cost, so it can only ever cover sessions Episko ran. A model can therefore show real tokens against a `—` cost, and the empty Spend section says which figure it is rather than showing a dash that reads as a failed read.
- **Issues are not here.** A card says what this screen already read — commits and sessions in the window. Open work is the project dashboard's, bought when you open it, and a fleet-wide `gh` sweep is exactly the "nothing runs until you ask" rule this screen inherits.
