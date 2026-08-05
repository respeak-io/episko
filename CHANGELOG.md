# Changelog

Every release, newest first. This file is the **only** place release notes are written:
the app ships it and shows it in *What's new*, `release.yml` lifts the matching section
into the GitHub release, and CI refuses a `dev → main` pull request whose `Unreleased`
section is empty.

`pnpm changelog` drafts `Unreleased` from the commits since the last tag. It writes a
draft and stops — nothing here is generated at release time, so what ships is what
somebody read.

Markers: `+` new · `~` changed · `!` fixed

## Unreleased

! **A big fleet no longer silently drops old terminals onto the slow renderer.** Every
  pane held a WebGL context for the life of the pane, and webviews cap a page at 16
  live contexts — one pane past that and the browser starts evicting the *oldest*,
  exactly the long-lived sessions you keep returning to, permanently downgrading them
  to DOM rendering with no error anywhere. Contexts now come from a small pool over
  the recently-viewed panes, so the cliff is unreachable however many panes exist,
  switching between the panes you actually work in stops paying a renderer rebuild
  each time — and a context lost anyway logs itself to the 🐞 console and heals the
  next time the pane is activated.
~ **A burst of telemetry costs one repaint, not one per event.** Every hook and
  statusLine used to trigger a full render of every surface, and N busy agents
  multiplied that into a constant main-thread load that grew with the fleet. Renders
  now coalesce to at most one paint per animation frame; the 🐞 console counts paints
  beside received events, so the batching is visible while the app runs.
! **Ended sessions stop taxing the app forever.** An ended session's pane now releases
  its 8000-line scrollback once it leaves the stage — the final screen stays, and
  History reopens the full transcript from disk — and panes whose process has exited
  drop out of the 4-second branch poll. The quit dialog also stops counting a finished
  task as "still running".
! **A reload no longer loses your panes — they come back, scrollback included.** A
  webview reload left every `claude` process running with nothing on screen attached
  to it, and then offered the orphans back as dormant rows with *Resume* enabled — a
  second `--resume` against a transcript its live process still owns, which silently
  interleaves both conversations into one file. Two halves fix it: the sidebar and
  History now ask the backend which PTYs it actually holds, so a live orphan can
  never read as resumable; and startup rebuilds a pane for each one, replaying the
  recent output the backend now retains per session, so the conversation is simply
  on screen again where it was.
! **Opening the working set no longer costs a git process per untracked file.** Each
  untracked file entered the peek's patch through its own `git diff --no-index` — up to
  300 processes back to back on one click, each allocating a console on Windows, which
  is exactly the creation storm behind the occasional `git.exe` `0xc0000142` dialog.
  The cap is now 25, and the viewer's existing truncation note covers the rest — nobody
  reads 300 untracked files in a peek.
~ **The statusLine ticks every 10 seconds instead of every 3.** The tick is the idle
  cadence only — an active session's statusLine already re-runs on its own events — and
  on Windows each tick costs a Git Bash, a curl and a console, per session, on or off
  screen, forever. Nothing it carries (model, context %, cost, duration, rate limits)
  moves faster than minutes while a session sits idle, so this is the same figures at a
  third of the process churn.

+ **A task chain is one row, and it opens into a tiled stage.** A `dependsOn` launch
  still runs one pane per step — an exit code per step is what the phase glyphs are —
  but the sidebar now folds the steps into a single row carrying the worst step's
  status, so a failed build reads as a failed chain even when a later step never ran.
  Clicking the row tiles every step on the stage at once, and closing one tile focuses
  the next in the chain rather than abandoning the rest.
+ **Projects can be grouped, and a group folds away.** Name a set of projects — *Work*,
  *Side* — and collapse it to a single line when you are not in it. Right-click a project
  for *Add to group…*, or drag it onto a group the way you already drag one to reorder;
  right-click the group's own heading to rename, fold, or delete it. A group has no
  order of its own: it sits where its first project sits, so the sort you picked still
  decides the rail and dragging a project takes its group with it.
+ **A folded group still says when something in it needs you.** The heading carries the
  status glyph of the most urgent session it is hiding and a dot for uncommitted changes,
  because a tidy-up that could bury a session waiting on a permission would be a trap.
  ⌘1–9 still reaches into a folded group, and taking a session in one onto the stage
  unfolds it rather than leaving the rail with nothing selected.
! **Tasks now get the PATH your own terminal has.** A login shell reads `~/.zshrc` only
  when it is *interactive*, and that is where nvm, pnpm, mise and Homebrew's `shellenv`
  actually live — so a `justfile` could report no tasks at all, and a task that worked in
  your terminal could die in Episko on *command not found*. The PATH is now harvested
  from an interactive login shell instead.
! **Windows: npm scripts launch.** Windows starts real executables and nothing else, so
  every `package.json` script — a `.cmd` shim, not a program — failed to start. Scripts
  are now resolved the way the shell would and routed through `cmd.exe`.
! **A VS Code compound task can run.** A `tasks.json` entry with no `command` but a
  `dependsOn` list — usually exactly the one `isDefault` marks as the build — was blocked
  as "no command" instead of running the steps it names.

~ **Windows: a session no longer launches a PowerShell for every hook.** Each lifecycle
  event — every tool call, every turn, every notification — used to start a whole
  PowerShell just to reach `curl`, about 220ms and a second process each time, per
  session. Claude Code can now be handed the command and its arguments directly, with no
  shell in between, so a hook is one short-lived `curl` and nothing else. The statusLine
  still needs a shell and is unchanged.
! **The branch shown beside a session cost two `git` processes a session, every four
  seconds.** With a few sessions open that was a git launched roughly twice a second to
  re-read a file that hadn't changed — enough, on Windows, where starting a process is
  the expensive part, to be a real share of what the machine was doing. It reads `.git`
  directly now, like the worktree roster beside it already did. Nothing on screen
  changes.
+ **Running a task that takes parameters no longer costs a dialog.** *Run* now starts it
  with what it already knows — the values you gave last time, or the definition's own
  defaults — and a `⋯` button beside the row (⌥⏎, or *⋯ Parameters* on a finished run)
  is there for the times you want to change them. The row's tooltip shows the command as
  it will actually run, so nothing is filled in behind your back, and the prompt still
  opens by itself when a value genuinely has nowhere to come from.
! **A `just` recipe taking `*args` stops asking for them.** A `*name` parameter takes
  zero or more arguments, so `just saas-start` is a complete command — but it was read as
  a required value and put a prompt in front of every run. `+name`, which does want at
  least one, is unchanged. Such a recipe can also now be a run-on-stop rule.
! **The parameter prompt looks like the rest of the app.** Its Cancel button was drawing
  as a raw platform button, and the pair sat flush against the field above them.

~ **The menu-bar menu shows status in colour, and groups sessions by project.** Every
  row used to be one long string — glyph, project, branch and status — and a menu item's
  text is always drawn in the menu's own colour, so `◆` (waiting on you) and `✕` (the
  turn died) arrived the same grey as *Quit*: the two states you open that menu for were
  the two it could not show. The double spaces meant to line the columns up did nothing
  either, the menu font being proportional. Each session now carries its status as a
  real coloured icon in the sidebar's own vocabulary — amber ●, green ✓, pink ◆, red ✕,
  hollow ○ idle — under a heading naming its project, so the row itself is just the
  branch. The colours are read from the app's stylesheet rather than restated, so they
  cannot drift from the sidebar's.

! **Today's disk figure is today's, rather than last night's arriving late.** The daily
  I/O rollup credited a reading to the day the *poll* happened, and the poll only runs
  while a session is on stage — so a stretch with the dashboard up, or the window in the
  background, went unsampled and the next reading dropped the whole gap on whichever day
  it landed in. Across a midnight that meant a full evening of churn appearing as a
  morning's work: 530MB reported on a day that had done about 25MB, while the evening
  that earned it showed 54MB. An increment measured across a boundary is now spread over
  the days it actually covers, and a minute-by-minute heartbeat keeps the window short
  even with nothing on stage. The heartbeat reads only the counters — no `git` call
  beside it, and no more writing than before, because a disk meter that churns the disk
  is measuring itself.
~ **The last recurring `git` process is gone.** The pane on stage re-ran a private
  `git status` every 4 seconds to refresh the inspector's working-set numbers — the
  only subprocess the app still spawned on a timer — re-learning what the stale-driven
  dirty poll already reads for every folder at once. The inspector now picks its
  numbers up from that shared read: an agent's edits still land on the next tick, and
  changes made behind Episko's back (your editor, a build) surface within the sweep's
  15 seconds instead of 4 — the same trade the sidebar's dirty dot has always made.
! **A running task no longer books its disk reads again on every poll.** The app-wide
  I/O total kept a session's bytes past its exit by "retiring" any sampled pid it no
  longer recognised — but it recognised pids by the list that exists to tell *claude*
  processes apart from external ones, which shells and tasks never join. So a live test
  run or terminal pane read as freshly exited on every 4-second poll, and its whole
  cumulative counter was banked again each time: one vitest run could inflate a day's
  read figure by two orders of magnitude. Retirement now keys on the actual pane
  roster, so a pane's bytes are banked exactly once, when it closes. Days recorded
  before this fix overstate reads badly — there is no way to repair them after the
  fact, so trust the figure from the first fixed day on.

! **Starting an agent on an issue now actually claims it.** *Claim & start* has never
  written anything to GitHub. The call was one argument short, and a call that is one
  argument short is not a partial call — it is no call at all, so no assignee, no label
  and no comment have landed since the feature shipped, behind a toast that cheerfully
  said *Started on #232*. Handing the issue back when the agent stops was broken the same
  way and even quieter. Both write what they say they will now, and a claim that only
  half lands says so on screen instead of in a log nobody opens.
! **A dispatched prompt is sent, rather than left sitting in the box.** The Enter that
  submits it travelled in the same keystroke burst as the prompt itself — and Claude
  reads a burst as a *paste*, where a carriage return is a new line, not a send. So the
  agent you started was still waiting for you to press Enter, which is the one thing the
  button exists to spare you.
~ **The dispatch sheet no longer promises a worktree it does not make**, and *push the
  branch now* is gone with it. Nothing ever implemented that switch — there was no branch
  to push and the command never took the argument — and a control that cannot act is
  worse than one that is missing, because flipping it reads as a decision taken.
~ **The disk-I/O total looks like something you can click, and says why clicking it
  sometimes changes nothing.** The row cycles three windows — today, this run, everything
  recorded — but it was pixel-identical to the two static rows above it until you happened
  to hover, so there was nothing to suggest it did anything. It now carries a `⟳`. And on
  a machine's first day all three windows genuinely read the same, because the only day
  recorded *is* today and all of it *was* this run: correct, and indistinguishable from a
  dead button, so the row now says so in a line that disappears the moment they diverge.
! **"Everything recorded" no longer claims zero on a machine that has recorded nothing.**
  An empty rollup rendered as `0 B read · 0 B written`, which says the disk sat idle
  rather than that nothing was kept — the distinction the per-project spend strip already
  makes with a dash. It reads *not recorded* now.
! **Removing a worktree on Windows no longer half-works.** `git worktree remove` deletes
  the checkout folder *before* it unregisters the worktree, and carries on past a failed
  delete — so on Windows, where a folder any process holds open cannot be deleted, a
  removal would leave the worktree gone from git with its directory still on disk.
  Episko read that as "nothing happened" and offered `git worktree remove --force`, the
  one command that could no longer work: *fatal: is not a working tree*. It now asks
  whether the worktree is still registered rather than guessing from the folder, and the
  common cause is gone too — removing a checkout from a session waits for that session's
  process to actually die, instead of deleting the folder it is still sitting in.
+ **When a folder won't delete, Episko says who is holding it.** Processes it started are
  cleared without asking; anything else — an editor, a dev server, a terminal you left
  open — is listed by name, with the choice to terminate them and retry or leave the
  folder alone. Read-only files, which nothing is holding at all, are simply cleared.

## 0.14.0 — 2026-08-03
A day's work becomes something the team can read, and the app gets quieter underneath.

+ **The project dashboard says when it is still reading.** Opening a project costs a
  scan of every transcript on the machine, three git calls and — on a GitHub repo — two
  more `gh` calls after those, and none of it used to show. The strip led with a
  confident row of zeros, the aside was simply short a card or two, and a folder still
  being read looked exactly like a folder with nothing in it. Every wait now draws the
  shape of what is coming: the strip, the timeline, the aside's cards, and the issues
  card that arrives last. A day whose sentence is still being written says *writing*
  beside the plain headline it already has, rather than hiding a line you can read to
  promise a better one.
! **Every project in the sidebar opens its dashboard, not just the ones with a session
  running.** A folder Episko knew about only from a session in another terminal, only
  from past sessions, or from a worktree whose session had ended simply did not respond
  to the click — with nothing greyed out to say why, because the header was built without
  the handler rather than with a disabled one. A worktree's header now opens its
  *project's* dashboard, too: keyed to the checkout it matched no sessions at all, so the
  timeline showed commits nobody appeared to have worked on. Checkouts are a card inside
  the project, which is where they belong.
! **Clicking a session from the project dashboard opens it.** Picking an external or a
  restorable session while the dashboard was on screen changed the header, the inspector
  and the accent colour but left the dashboard itself sitting on top of the transcript it
  had just loaded, so the click read as recolouring the page. Leaving a dashboard you had
  collapsed to its icon rail (⌘I) also carried the rail onto the next session, where it
  held the wrong buttons — and closing the dashboard with nothing else running left a
  blank stage instead of the "no sessions" card. All three were the same missing
  handover: what takes the stage now says so in one place, and everything else steps
  aside.
! **The dashboard no longer shows the last project's answers under the new project's
  name.** Clicking from one project to another kept the previous one's tier for a beat,
  so a repository could flash *not a repo* — losing the worktree and commit-graph verbs
  with it — and a GitHub project's issues could appear briefly under a folder that has
  none.
+ **A day now gets two sentences: yours, and the project's.** The one on the timeline is
  still your day — your sessions, your spend. Above it, on days more than one person
  committed, sits a second line describing what the *project* did, written from the
  commits and pull requests alone. A release tagged by a bot doesn't make a day a team
  day, and on a day you worked alone the box is absent rather than repeating the line
  beneath it.
+ **The shared work log can be found, and it holds the right half.** The project's line
  can be written to `.episko/digest.md` and committed, so everyone who pulls gets the
  same account instead of re-deriving — and paying for — their own; on a team repo that
  makes it cheaper than a summary per person, not dearer. Nothing in the app offered it
  before: the timeline now says so at its foot once there is something to share, and the
  inspector carries *Share the work log…* beside the other project verbs.
+ **↗ Jump to its terminal works on Windows.** Clicking an external session used to
  answer *"focusing external sessions isn't supported on Windows yet"*; it now brings
  the hosting window forward — Windows Terminal, VS Code, or a plain console alike. With
  several windows of one app open it picks the one running that session rather than
  whichever was last in front. macOS still lands on the exact tab; Windows has no tty to
  aim at, so it lands on the window.
~ **Your own half never reaches a file.** It was one sentence blending both, which meant
  a committed line was whoever generated it last describing the part of the day they
  personally saw — and your session titles and daily spend went into a file that gets
  pushed. Your line now stays in Episko's own cache.
~ **A work log already in the repo is contributed to without asking.** Creating a
  committable file in your repo still needs an explicit yes; adding your days to one a
  colleague has already committed does not, or the file quietly becomes one person's
  diary.
! ***What's new* shows its formatting instead of its asterisks.** Emphasis rendered as
  literal `*` and `**` throughout the release notes — every italic in the file, and any
  entry that put an italic inside a bold phrase, which came out with no bold either. The
  one-line summary at the top of each release was rendered as plain text as well.
! ***What's new* no longer opens on a blank "next release".** Cutting a release leaves an
  empty section behind for the next one, and every build shipped with that section
  showing in the sidebar — a row that opened on a heading, "not released yet", and
  nothing else.
~ **The generated-by-a-model mark reads as a mark, not as the last word of the
  sentence.** In the shared box it sits in the box's own bottom-right corner instead of
  trailing the text wherever it happened to wrap.
~ **The dashboard's right-hand column gets more room and takes a share of a wide
  window.** Issues, checkouts and notes all put a title next to a number, and at a fixed
  width every one of them was cut short while the timeline beside them — one capped
  sentence per row — took the whole of any extra space.
~ **Every action in the project inspector says what it does.** Four of them carried a
  label and nothing else while the rest had a line underneath, so the list read as two
  kinds of thing.
! **Removing a worktree that is already gone says so up front.** A checkout merged and
  deleted outside Episko still asked the full "the folder goes, its branch is deleted"
  warning, and only after you clicked through did it report that the folder had been gone
  all along. It now offers to prune git's leftover record of it instead, and says plainly
  that nothing is lost.
! **The hover bar of checkouts appears on projects with nothing running.** Resting on a
  project revealed its idle worktrees only if something was already running in that repo —
  and closing the last session made the rows disappear again. Episko now knows a
  project's checkouts whether or not it is busy, which is exactly when you want to start
  one.
! **A permission decision can no longer be swallowed by a repaint.** The inspector was
  rebuilt on every telemetry event — several times a second with a few agents running —
  so a click on *Allow* that happened to span one of those rebuilds landed on nothing,
  leaving the session waiting on an answer you had already given. The panel now repaints
  only when something on it changed. The collapsed project rail is the same fix.
~ **Episko writes to disk far less while it is just running.** Three records were
  persisted on every status update from every session — roughly once a second on a busy
  fleet, mostly rewriting bytes that hadn't changed, one of them 25× larger than the
  figure it accompanied. The day's spend is still saved the instant it changes; the
  breakdowns behind it are saved on a timer and flushed when you quit. Daily records are
  also capped now instead of growing forever.
+ **The day's spend opens.** *today $x.xx* in the status bar is now a button, like the
  limits beside it: it shows what the day cost, split by project and by session, and
  clicking a session that is still running jumps to it. Whatever the split can't account
  for is a row of its own rather than quietly missing, so the popover can never read
  lower than the segment that opened it.
~ **The inspector's read/written figure says which window it covers, and defaults to
  today.** It was labelled *total* while showing neither a daily nor a lifetime number:
  the processes' own counters, which start again every time Episko does. Episko now keeps
  a daily record, and the row cycles today → this run → everything recorded.
~ **One ＋ on the project dashboard, not two.** *New session* and *New worktree session…*
  sat one above the other, so picking the right row meant knowing whether the folder was
  a repo — which is what the dialog asks about anyway. *New session* now opens that
  dialog, exactly as ＋ Session in the header already did, and starts straight away in a
  folder that has no branches to choose between.
! **The dashboard's buttons stop flickering under the pointer.** ▶ Start and everything
  beside it pulsed between their hover and resting colours while the mouse sat still on
  them — the whole pane was rebuilt on every telemetry event, so with a few agents
  running the button was destroyed and recreated several times a second. The same rebuild
  emptied the note box while you were typing in it. Both stop: the dashboard now repaints
  only what actually changed, which on a quiet minute is nothing.
! **Starting an agent on an issue works, and the claim gets written.** Every dispatch from
  the dashboard reported *Could not start a session* — while starting one. The pane was
  there and the agent was idle in it: what never arrived was the prompt naming the issue,
  and the claim that tells a colleague somebody has this one. Dispatching a note had the
  same hole, and consumed the note on the way through.
! **A project's day summaries appear straight away.** Every past day's sentence was
  already on disk from the first time you looked, but the timeline asked for today's
  first — and today is the one day that has to be re-written, so a week of summaries
  paid for days ago waited behind one live model call, and behind the full 45-second
  timeout when that call wedged. The days that cost nothing now fill immediately and
  today's arrives when it arrives.
! **Opening a second project while the first is still summarising no longer leaves it
  blank.** The request was dropped rather than queued, so that project showed its plain
  headlines for the whole visit even though every sentence was cached. A summary that
  lands after you have moved on also no longer files itself under the project you moved
  to.
! **A repo cloned through an SSH host alias is on GitHub after all.** Two GitHub accounts
  on one machine means an `~/.ssh/config` entry per identity — `github.com-work` pointing
  at `github.com` — and that alias, not the hostname, is what the remote URL carries. The
  dashboard read the name literally, decided the project was hosted somewhere it had
  never heard of, and hid issues, pull requests and claims behind a card explaining that
  the remote wasn't GitHub. `gh` had been resolving those aliases all along.

## 0.13.7 — 2026-08-01
The project dashboard stops being a page you can only read.

~ **The stage header's buttons work on a project dashboard.** ◷ History, ❯ Terminal and
  ▶ Run were greyed out there and ＋ Session opened ⌘K to ask which project — while the
  project's name sat in the header beside them. All four now act on the project on
  screen: History opens scoped to it, Terminal and Run start in its root, and ＋ Session
  opens the same new-session dialog you get from one of its sessions. ⌘T, ⌘⇧R, ⌘⇧H and
  ⌘⏎ follow.

## 0.13.6 — 2026-08-01
Housekeeping on the surfaces 0.13 added, plus two in History.

! **The project dashboard's top strip reads as five figures again.** It was printing
  the raw markup of its own commit sparkline as text, and stacking the five tiles into
  a column one per row instead of laying them across. Two separate faults that arrived
  looking like one.
! **⌘K's project swatches lost the grey dot beside them.** Every coloured square in the
  list had a second, larger circle spilling out of its corner — a switch knob it had
  inherited from an unrelated control that happened to share its name.
! **The stage header runs the full width of the window.** The title, ◷ History,
  ❯ Terminal, ▶ Run and ＋ Session had to share the space left over beside the
  inspector; the inspector now starts below the header instead of beside it, which is
  where it was always acting from anyway.
! **The *Reveal idle checkouts on hover* switch sits beside its label**, not on its own
  line underneath it, matching every other switch in Settings.
! **⌘I on a project dashboard collapses the inspector to its 44px rail.** It was
  documented and drawn that way but the panel never actually narrowed, so the rail was
  a row of glyphs adrift in a full-width empty panel.
! **The macOS traffic lights have room to breathe.** The Episko logo sat close enough to
  them to read as a fourth button in the row.
! **History no longer lists Episko's own summariser.** The one-line summary the Trail
  writes for each day is a real Claude session, so it left a transcript behind — and
  History, which reads every transcript on the machine, listed all of them. Dozens of
  identical rows reading "Below is a factual record of one day of…", crowding out the
  conversations you were looking for.
! **A transcript with nothing to preview says so in a box, not over the whole dialog.**
  Picking a session that turned out to be tool calls only replaced the entire list with
  one centred sentence, which read as the dialog breaking rather than as an answer.

## 0.13.5 — 2026-08-01
Two things 0.13.0 shipped that had never been clicked.

! **Clicking a project opens its dashboard.** It did nothing at all in 0.13.0 — the
  header carried the right attribute and the handler had the right branch, but the
  attribute was missing from the delegated click selector, so the branch was
  unreachable and the whole feature was dead on arrival.
! **The sidebar shows a hairline filling under a project while it counts down** to
  revealing that project's idle checkouts. Without it the panel appeared a second after
  you stopped moving, which read as a glitch rather than as a deliberate pause. It fills
  in step with the real timer rather than restarting whenever the sidebar repaints, it
  is drawn on every kind of project row rather than only the two with saved sessions,
  and the preview in Settings › Worktrees shows it too — the timing you are setting
  there is the thing it is previewing.
! **What's new opens by itself after an update again.** It skipped 0.13.0 entirely: the
  release that introduced the screen is the one where nobody has a record of having read
  it, and that empty record was being read as "brand new install, stay quiet". It now
  remembers every version it has shown you, so each one announces once and going back to
  an older build stays silent.
! **The macOS traffic lights sit centred in the header.** They were 5px from the top
  edge and 21px from the bottom of a 40px bar — `trafficLightPosition.y` is not the gap
  above the buttons but the height tao gives the titlebar container, so the number that
  reads as "centred" is 22, not 14.
! **Resuming a session no longer charges the day twice for it.** Claude's cost counter
  keeps running across a `--resume`, so the pane a relaunch creates — *Move session*,
  a restore, a History reopen — inherited a total that had already been counted and
  booked all of it again. One worktree move put $28 into the day a second time, so the
  day read $68 while the session that earned it read $39. The day's increment is now
  measured against the conversation rather than against the pane showing it, and that
  measurement now survives quitting the app — restoring a session after a restart was
  the commonest way to hit this and the last one still open. Days already recorded stay
  inflated — nothing stored says by how much — so `scripts/reconcile-usage.mjs` rebuilds
  them from the transcripts instead. It leaves a day alone rather than guessing at it
  when the records behind it can't all be priced, and says which ones and why.
~ **The release-notes button is a document icon, and sits to the right of the version
  number** it explains rather than the left. It was also sharing a CSS class with the
  usage sparkline, which gave an 18px button a 24px-tall glyph.

## 0.13.0 — 2026-07-31
A project is a place you arrive at now, not a session you fall into.

+ **Clicking a project opens a dashboard.** The last week of that project's commits and
  sessions, summarised a day at a time, with every commit one keystroke away.
+ **Issues and pull requests**, with triage for the ones that have gone quiet and a
  *claim* so a colleague's agent doesn't start the same work twice. Starting an agent on
  an issue creates a worktree, sends the prompt, and says so on GitHub.
+ **A shared work log.** `.episko/digest.md` is committed, so the team reads one history
  instead of each paying to re-derive it. Notes can be shared the same way.
+ **What's new** — this screen. It opens once after an update, and the ✦ beside the
  version number in the footer reopens it.
~ **The sidebar only lists checkouts something is running in.** Rest on a project for a
  moment to see the rest; the timings are yours to set in Settings › Worktrees.
~ The project header's ⌘I collapses the inspector to an icon rail rather than hiding it,
  because on the dashboard it holds the only copy of History, Terminal and Run.

## 0.12.0 — 2026-07-31
Six branches landed at once, and the window finally has one title bar.

+ The app draws its own title bar on both platforms — the native one is gone.
+ A session notices when an agent leaves the checkout it was launched in, and offers to
  follow it there or move the conversation.
+ **Commit graph** — a project's history, one page at a time, from the project menu.
+ Choose the permission mode a session starts in.
+ Right-click a ⑃ cluster header for its own menu; ＋ launches straight into that checkout.
~ The ＋ Session picker offers branches that exist only on a remote.
~ The main checkout stops dressing as a worktree — it wears ⌂ and the project's own accent.
! Ctrl+Shift+C / Ctrl+Shift+V copy and paste in shell and task panes.
! A turn the API killed no longer turns green a minute later.
! Windows: one canonical path spelling, so a repo stops rendering as two.

## 0.11.1 — 2026-07-28
A one-line fix for something that made a whole feature look broken.

! A symlinked working directory found no past sessions at all. The transcript folder is
  keyed by the *physical* path, so encoding the spelling you typed found nothing — which
  read as "no history" rather than as a failure.

## 0.11.0 — 2026-07-27
**Runnables** — Episko runs the task definitions your project already ships.

+ Run tasks from `package.json`, `justfile`, `Makefile`, `Taskfile.yml`, `mise.toml`,
  `Cargo.toml`, and VS Code's `tasks.json` / `launch.json`. A run is just another pane,
  so it gets the phase glyphs, the tray and ⌘1–9 for free.
+ **Run after a session stops**: when an agent finishes a turn in a project, verify it.
+ A project task panel for pinning, hiding, editing and overriding — writing only ever
  to `.episko/tasks.toml`, never to another tool's file.
+ The episko.dev site, and a README written around what Episko actually does.
! Ctrl+C interrupts an embedded Claude pane; it never exits it.
! Ctrl+V pastes images correctly.

## 0.10.1 — 2026-07-23
Cleanup after the rename.

! Recover settings stranded by the Muster → Episko rename. macOS keys localStorage to
  the bundle id, so a renamed bundle looked like a factory reset.

## 0.10.0 — 2026-07-23
**Muster is now Episko.** Same app, better name.

~ Renamed throughout, including the bundle id — see 0.10.1 for the settings this stranded.
! Windows: one canonical path spelling, so external sessions merge into their project.
! Embedded-terminal ghost cells — resize is debounced and forces a repaint.

## 0.9.0 — 2026-07-22
Released as Muster.

+ Worktree grouping in the sidebar: several checkouts of one repo read as one project.
+ Session history — reopen a session you closed.

## 0.8.0 — 2026-07-21
Released as Muster.

+ Usage analytics: spend per day, per model and per project, with a token ledger read
  from Claude's own transcripts.

## 0.7.0 — 2026-07-21
Released as Muster.

+ External sessions — Claude sessions started outside the app are listed, mirrored
  read-only, and can be jumped to in their own terminal.

## 0.6.0 — 2026-07-21
Released as Muster.

+ The permission cockpit: a blocking permission request is answered in the app, without
  switching to the pane that asked.

## 0.5.1 — 2026-07-20
Released as Muster.

! The tray title no longer lags a phase behind the sidebar.

## 0.5.0 — 2026-07-20
Released as Muster.

+ The ⑃ worktree dialog: create, switch and prune checkouts without leaving the app.

## 0.4.3 — 2026-07-18
Released as Muster. The first build worth installing.

+ Auto-update, so this is the last one you install by hand.
