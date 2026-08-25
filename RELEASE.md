# Releasing Episko

Cutting a release is one command. Everything else on this page is the part no
automated gate can do.

**Why this is a file and not a README section.** README is for people deciding
whether to *use* Episko; this is a procedure for the one person shipping it, and it
is long enough that folding it in would bury the install instructions. It also has a
different lifetime — it changes when the OS edge changes, not when the app does.

---

## What CI already guarantees, so you needn't re-check it

Every push and PR to `dev`/`main` runs, on **both macOS and Windows** (`ci.yml`):

- `pnpm build` — `tsc --noEmit` (strict) plus the vite build
- `pnpm test` — 744 vitest tests over the logic modules
- `cargo check --locked` and `cargo test --locked` — 160 tests on macOS, 156 on
  Windows (the platform tests are `cfg`-gated, so the count differs by leg)
- `cargo clippy --all-targets --locked -- -D warnings`

Both legs matter and neither is redundant: the platform code is `cfg`-gated, so each
OS compiles and lints only its own half.

**What CI cannot see** is everything below — the PTY, the tray, real windows, the
permission round trip, and whether Claude Code's own interfaces still match ours.

---

## Before tagging

### 1. The CLI contract tests — run them, they are not in CI

```sh
cd src-tauri
cargo test --locked -- --ignored --nocapture
```

Two tests, both against the real binary, in one pass:

- `claude_cli_still_honours_our_instrumentation` runs one real `claude -p` against a
  throwaway session in a temp dir and asserts our hooks reach our server, that routing
  still uses our launch id, and that the transcript still carries the fields the cost
  ledger reads. **It needs `claude` on PATH and an authenticated account, and it spends
  tokens** — which is exactly why it is `#[ignore]`d and lives here rather than in the
  PR gate.
- `claude_cli_still_accepts_every_permission_mode_we_offer` runs `claude
  --permission-mode <m> --version` for each mode Settings offers. Claude Code validates
  the flag against its own choice list, so a mode renamed or dropped upstream turns
  every launch in that mode into a pane that dies before it starts. This one costs **no
  tokens and needs no auth** — it is `#[ignore]`d only because CI has no `claude`.

A failure here is the highest-signal failure in this document: it means a Claude Code
release changed something under us, and the app would otherwise have gone quiet
rather than gone red.

It does **not** cover the statusLine half (`-p` is non-interactive), the
`~/.claude/sessions` registry, or `PermissionRequest`. Those are the click-through
below.

### 2. Version bump

`package.json` and `src-tauri/tauri.conf.json` must agree, and the tag must match
both. The footer shows the running version; a mismatch there is the first thing a
user reports.

---

## The click-through

Do this on a **build**, not `pnpm tauri dev` — the packaged app has the stripped PATH
and the real bundle identity, which is where the OS edge actually bites.

**Never run a dev build from inside an Episko pane.** It becomes a descendant of the
installed app, so `ProcTable::is_descendant_of` filters its sessions out of the
external list; worse, the two share one `localStorage` and one `episko-debug.json`,
so nothing you observe can be attributed to either. Quit the installed app and use a
real terminal.

Tick these in order — each depends on the one above.

### Launch and telemetry

- [ ] **A session starts.** Add a project, `＋ Session`, accept Claude's
      workspace-trust prompt, ask it something. The terminal renders and accepts input.
- [ ] **Telemetry arrives.** The 🐞 console shows `telemetry: rx N · routed N ·
      dropped 0`, with `rx` climbing. `dropped` in warn colour is routing drift and is
      a release blocker. A fresh instance reads `rx 0` until a session is launched
      *inside it*.
- [ ] **The statusLine half arrives**, which the hook counter does not tell you —
      hooks log a line each, statusLine deliberately does not, and `rx`/`routed` climb
      happily on hooks alone. The evidence is the inspector's **model / context %**,
      the footer's **cost / duration** and **5h / 7d rate-limit windows**
      being populated rather than `–`. All of them ride this one path, so they fail
      together and silently; a healthy-looking pane is not evidence.
      **Costs nothing to check:** launch a session and read the inspector *without
      prompting it*. An unprompted session makes no API call, and the statusLine still
      fires on start and every 3s. **Do it on both OSes** — the two run in different
      shells, and Windows shipped this broken once (`shell` is a hook field the
      statusLine has no counterpart for, so Git Bash got a PowerShell command). CI now
      executes the generated command in every shell Claude might pick; what only you
      can see is whether Claude still hands it to one of them.
- [ ] **Phases track reality.** The sidebar glyph moves idle → thinking → working →
      your-turn as the agent works, and the pane doesn't show the ended `·` while the
      process is still alive.

### Keyboard, and the sidebar repaint guard

Both of these are code with no automated cover that moved recently — the key handlers
were re-applied into `terminal.ts` during the dev merge, and the repaint guard is new.
A regression in either is silent.

- [ ] **A double `^C` interrupts, it does not end the session.** In an embedded claude
      pane, press Ctrl+C twice quickly: the turn cancels, a toast explains, and the
      pane stays live. Then press it again after ~3s — it must interrupt normally.
      In a **shell** pane the same keystroke must still kill the process outright.
- [ ] **Windows only: Ctrl+V pastes an image** into a claude pane (copy a screenshot
      first). Plain text paste must still work in the same pane.
- [ ] **Ctrl+Shift+C / Ctrl+Shift+V copy and paste** in a **shell** pane and in a
      **task** pane. Select output with the mouse, Ctrl+Shift+C (a "Copied" toast, and
      it must land in another app's clipboard), then Ctrl+Shift+V into a prompt and see
      the text arrive intact. Neither chord may raise an OS clipboard-permission
      prompt — one means the WebView served it rather than the plugin. Plain Ctrl+C in
      those panes must still interrupt, and on macOS ⌘C/⌘V must still work.
- [ ] **The sidebar still repaints when it should.** `renderSidebar` now skips the
      `innerHTML` write when the markup is byte-identical, so watch that a phase
      change, an arriving permission, a new session, and closing one *all* still move
      the sidebar — and that a drag-reorder leaves it correct.

### The three surfaces with no automated cover at all

All CSS/markup or native chrome, so `tsc` and the suites say nothing about any of them.

- [ ] **The tray menu's status dots are in colour, and grouped.** Open the menu-bar
      icon with two projects running. Each project is a greyed heading with its
      sessions under it, and every session carries a *coloured* dot — amber working,
      green ✓, pink ◆, red ✕ — not a grey character. A grey dot means the icon reached
      AppKit as a template image; a missing dot means the rasteriser handed over a
      buffer of the wrong length, which the unit tests cover but the wiring does not.
      Click a heading: nothing must happen (it is `enabled(false)`; a clickable one
      would fall through the handler's `sid` catch-all and emit a `tray-select` for an
      id that is not a session). Click a session row: it takes the stage.
      **Windows too** — muda blits these into a hard-coded 16×16 bitmap there, so this
      is the only check that the shapes survive the halving.
- [ ] **The inspector's I/O block is app-wide.** Run two agents, give one of them
      something that churns the disk, and read the block on the *other* one: it must
      show the same figures, headed `all sessions · N running`. The rate is the sum,
      so it must exceed what either agent alone is doing. Then close a pane — the
      **total must not fall** (`io_retired` is what keeps it monotonic), while the
      running count drops. With nothing running the rates read `—`, not `0 B/s`.
- [ ] **Settings toggles sit beside their label, not under it.** Settings ⌘, →
      **Tasks**: "Let trusted projects introspect themselves" and "Raise attention
      when a run fails" must each be a row — text left, switch right — not a centred
      stack. This is a cascade order that has broken once (`.set-inline` has to stay
      after `.set-group`), and it fails silently and only visually.

### Sound alerts

Unit tests cover every decision (`test/sound.test.ts`); what they cannot cover is
whether anything comes out of the speakers, and **every failure mode here is silent** —
a broken alert is indistinguishable from a switched-off one.

- [ ] **The pane auditions itself.** Settings ⌘, → **Sounds**: click each row's ▶.
      Ten rows must each make a *distinguishable* noise, and the volume steppers must
      change how loud the next one is. Then click a row's sound name — the strip of ten
      tones opens under it, and picking one plays it and closes nothing else.
- [ ] **The first sound of a cold start is audible.** The real trap: autoplay policy
      leaves the context suspended until a gesture, so **quit, reopen, and without
      clicking anything in the window** let a session reach a permission (or ⌘, and
      click ▶ as the very first click). If the first one is silent and the second is
      not, the unlock listener in `chime.ts` is broken.
- [ ] **A permission chimes from the background.** Set *Play* → **Only when Episko is
      in the background**, put another window in front, and have a session ask for
      approval. It must ring there and **not** ring when you are looking at Episko.
- [ ] **A burst is one sound.** Start three or four agents and give them all the same
      prompt so they finish together. That must be one chime, not four. Then check the
      exception: a permission arriving right after another session's "your turn" must
      **still** ring — the urgent one is never the one swallowed.
- [ ] **A failed tool call is silent by default**, and a turn the API kills is not.
      Run something that fails a Bash call mid-turn: no noise (that is `toolFail`, off
      by default). Switch it on and it should sound — this is the split the phase
      machine already draws for the label.

### The blocking path

- [ ] **A permission is answerable.** Ask a session to run something needing
      approval. The pane must raise `permission: <tool>` with a command preview and a
      risk chip, and **allow / deny / hand-to-terminal must each unblock Claude**. This
      is a *blocking* hook — if the UI doesn't answer, Claude hangs, so a failure here
      is a hard blocker.
- [ ] **Answering in the CLI instead** also clears the badge on the next lifecycle event.
- [ ] **A non-default permission mode reaches the session.** Settings › Sessions →
      **Plan**, then `＋ Session`: the new-session dialog shows the Plan chip and the
      pane comes up in plan mode (Claude's own indicator says so, and it refuses to
      edit). Set it back to **Manual** afterwards — every launch, including a restore,
      reads this preference. Worth one pass in an *external* engine too, since that is
      the only path where the flag goes through a generated shell script.

### Running servers

The whole feature reads a payload field and a file layout that are **not ours** —
`tool_response.backgroundTaskId`, and the log Claude Code writes beside the transcript.
The rules are unit-tested against captured fixtures, but a release of Claude Code that
renames either would leave every test green and the pill permanently dark, so this is
the one section here that is checking somebody else's contract.

- [ ] **A dev server appears.** In a session, prompt: *"start the dev server in the
      background"* (any project with one). Within a few seconds the header grows a
      `◉ 1` pill, left of the reactor, and it turns **green** once the server prints its
      URL. Grey-and-never-green is the failure that matters: it means the shell was seen
      but its log was not, so check `bg_log_path` against the real
      `<tmp>/claude/<slug>/<uuid>/tasks/` layout before shipping.
- [ ] **The URL opens.** Click the pill, click the URL chip — your browser opens the
      running site. The row names the project and the command with the `cd …&&` prefix
      stripped.
- [ ] **The peek is live.** Click the row to expand it, then hit the site in the
      browser. New lines appear in the log peek within ~4s (a request log, an HMR line).
- [ ] **`◨` jumps** to the session that started it, and closes the popover.
- [ ] **Stop asks rather than kills.** Click `✕` on a live row: the session takes the
      stage with `Stop the background task <id>…` **prefilled and not sent**. Press
      Enter; the agent runs `TaskStop` and the pill drops. It must never kill the
      process directly — the point is that the agent knows its server is gone.
- [ ] **A crash stays on screen.** Start a dev server on a port that is already taken
      (start two). The second exits within seconds: its row must **stay**, dimmed, with
      `exited 1` where the URL was, and the pill must go **red** rather than dropping
      the count. `✕` on that row dismisses it and asks nobody.
- [ ] **`/clear` does not lose a running server.** With a server up, `/clear` the
      session. Claude mints a new session directory; the row must keep its URL and its
      peek, because the log path was captured at start. A row that goes grey here is
      the transcript path being re-derived — the one trap this feature has.
- [ ] **The poll is not re-reading the world.** With a server up and idle, the 🐞
      console's paint counter must stay flat. Every four seconds Episko asks for the
      log's length; an unchanged log must cost no paint.

The other half comes from Episko's own runnables, and shares none of the plumbing above
— no hook, no log file, no poll. Its evidence is the pane's own output as it streams.

- [ ] **A task you ran shows up too.** `▶ Run` a dev-server task (`just dev`, a VS Code
      task, an npm script). Once it prints its URL the row appears, marked `▶`, and the
      pill counts it. A task that is *not* a server — `tsc --watch`, a test run — must
      **not** appear at all: its pane already says everything there is to say.
- [ ] **Its URL survives a busy log.** Leave the task running and edit a file until the
      pane has scrolled well past 40 lines of HMR output. The URL must still be there.
      Losing it is the tail being rescanned instead of latched — the trap this half has.
- [ ] **Its Stop really stops.** `✕` on a `▶` row kills the task and closes its pane,
      exactly as the pane's own `✕` does — no prefilled message, no agent involved.
- [ ] **A restart follows the port.** Change the dev server's port in its config and let
      it restart itself; the row must follow to the new URL rather than keep the old one.

The third source asks the kernel rather than reading anything, and it is the one that
needs checking on **both** OSes: `session_ports` leans on `listeners`, whose Windows,
macOS and Linux halves are three separate implementations of the same question.

- [ ] **A server nobody announced still shows.** Open a plain `❯ Terminal` pane and run
      a dev server in it by hand. Within ~4s a row appears marked `◎`, named after the
      process (`node`, `python`), with a `localhost:<port>` button that opens. This is
      the only way that server has ever been visible, and it is the check that proves
      the ancestry walk reaches — the process sits many hops below the pane.
- [ ] **One server is one row.** Run something that opens several sockets (`wrangler
      dev` is the reference case: it holds five, four of them a debugger and
      kernel-assigned control channels). Exactly one row must appear, on the port you
      would actually open. Extra rows in the 49152+ range mean `usefulPort` is not being
      applied before the join.
- [ ] **A pane that went quiet gets its address filled in.** Have an agent background a
      server whose banner Episko cannot parse. The row should start at `starting…` and,
      on the next poll, gain `localhost:<port>` from the scan rather than staying blank.
- [ ] **A second server in the same pane does NOT get guessed at.** With two servers
      under one pane and neither announced, both must appear as their own `◎` rows —
      nothing should adopt an address it cannot be sure of.
- [ ] **It costs nothing when idle.** With no panes open the scan must not run at all
      (the roster is checked first). With panes open and no servers, the pill stays
      hidden and the paint counter stays flat.

### Identity across rotations

- [ ] **`/clear` (or `/compact`) does not orphan the pane.** Claude mints a new
      runtime `session_id`; telemetry must keep routing (inspector keeps updating) and
      the pane must **not** flip to the ended glyph. This is the single most
      regression-prone behaviour in the app.
- [ ] **Resume works after a restart.** Quit with a live session, reopen, resume it
      from the roster. It must resume the *same* conversation — that is `resumeId`, not
      the launch id, doing its job.

### Drift — an agent that changes checkout

**Two cases, and they behave as opposites** — one is not a spot check for the other.
Nothing here can be checked headlessly: the rules are unit-tested and the CLI contract is
pinned by the `--ignored` test above, but every surface below is DOM.

- [ ] **Case 1 — writes move, the session does not.** In a session launched in one
      checkout, have the agent `git worktree add` a **sibling** worktree (outside the
      project dir) and **write a file in it**. The sidebar row gains `⤳ <branch>`, the
      header chip reads `old ⤳ ⑃ new`, and the inspector shows the *Working in* card
      above the vital, offering **Move session here**.
- [ ] **The row does not move**, and does not flicker as the agent reads its old files.
      (Only a *write* back home clears the marker — reads must not.)
- [ ] **Move session here** confirms, ends the session, and resumes it in the new
      checkout with its history intact (ask it about something from before the move).
      Afterwards: marker gone, chip shows the new branch alone, and
      `~/.claude/projects/<enc(new)>/<id>.jsonl` exists while the old one does not.
- [ ] **A refused move is harmless** — deny at the confirm dialog and nothing changes.

- [ ] **Case 2 — Claude moves the session itself.** Prompt: *"create a new worktree and
      run a terminal command in it"*, which drives Claude Code's own `EnterWorktree`
      tool into `<repo>/.claude/worktrees/<name>`. **No file need be written.** The same
      marker and card appear, but the button reads **Follow it here**.
- [ ] **Follow it here is instant and lossless** — no confirm, no restart, the pane does
      not blink and the terminal keeps its scrollback. Afterwards the header path, the
      branch, ▶ Run and ❯ Terminal all point at the new checkout.
- [ ] **The conversation is still resumable afterwards** (Claude had already re-homed the
      transcript; Episko must not have moved it a second time).

### Panes that aren't agents

- [ ] **`❯ Terminal`** opens a working shell pane.
- [ ] **`▶ Run`** discovers this project's tasks and runs one; exit 0 shows `done`,
      non-zero shows `error` and raises attention.
- [ ] **A run-on-stop rule fires** once per turn, does not steal the stage, and offers
      its output back to the session whose turn triggered it.
- [ ] **⌘⇧B starts the default build task**, in a project whose `tasks.json` marks one
      (`"group": {"kind":"build","isDefault":true}`). If that task is a *compound* — no
      command, only `dependsOn` — the whole stack must come up: every dependency gets a
      pane, and the chord must NOT hang waiting on the background ones. **Count the
      panes**: a task named by several dependents must run ONCE — a real stack of 11
      tasks used to open 27 panes. Then hit the group's ✕ while it is still running and
      confirm it *asks* before killing anything. The stage must
      land on the **group** — tiled, with its sidebar header highlighted — not on
      whichever step happened to start last. Then click another session mid-chain: a
      later step appearing must NOT yank the stage back. Also confirm
      plain **⌘B still toggles the sidebar** and **⌘T still opens a terminal**: the
      shifted bindings sit ahead of them in one if/else chain, so a mistake there
      silently steals the unshifted chord.
- [ ] **A `dependsOn` chain folds into ONE sidebar row** (run this repo's `fe-check`, or
      any VS Code task with `dependsOn`). The fold and the aggregate phase are unit
      tested; the row, the twisty and the tiling are not, and cannot be — so check:
      the ▸ twisty expands the steps *without* tiling the stage; clicking the row's
      label tiles all the panes side by side with the focused one outlined; a resize
      reflows the grid and every pane stays correctly wrapped (not just the focused
      one); **nothing scrolls** — no scrollbar beside the tiled panes and the stage
      header stays put (the grid must fill the stage, never grow it); the steps sit
      under **one** worktree header, not one each (a task whose `options.cwd` is a
      subfolder still belongs to its checkout); closing ONE tile keeps the mosaic and moves to the next tile (not to a Claude session beside the group), and the survivors re-fit to their new cell sizes; the header's ✕ closes every pane in the
      chain; **clicking a step row leaves the mosaic and shows that pane alone** while
      clicking a *tile* keeps the mosaic and just moves the focus outline; a finished
      tile keeps a ✕ in its caption (a running one shows it on hover) and it closes only
      that pane; and a finished step's elapsed time **stops counting** rather than
      climbing with the clock — check all three readouts, the sidebar column, the
      tile's caption AND the inspector's "Took" row, which are easy to fix separately; and closing the members
      one by one returns the stage to a normal single pane rather than leaving an
      empty grid.
- [ ] **PATH: launch from Finder/Explorer, not a terminal, then run a task that needs a
      version manager** — `pnpm …` (or nvm's `node`, or an `asdf`/`mise` shim). A dev
      build inherits your shell's PATH and cannot see this class of bug at all; the
      installed app starts from `/usr/bin:/bin:/usr/sbin:/sbin`. The mechanism (the
      interactive-shell PATH probe) is unit-tested, but only the real app proves the
      probe ran before the task did.
- [ ] **PATH: a project with a `justfile` lists its recipes** in the picker, again from
      a Finder/Explorer launch. If `just` genuinely isn't installed the row must say
      *"`just` is not on Episko's PATH"* — an empty `just` group is the regression.
- [ ] **Windows only: a `package.json` script runs.** `npm`/`pnpm`/`yarn` resolve to a
      `.cmd` shim plus an extensionless bash script, neither of which `CreateProcessW`
      can start, so these launched not at all before `argv_command`. Only the pure
      decision half is unit-testable off Windows — the resolution half needs a real
      Windows PATH, so this checkbox is the only proof it works.

### Reading the repo

- [ ] **The commit graph draws a real history.** Right-click a project → `Commit
      graph…` on a repo that has merges. The lanes must be unbroken from row to row
      (a break means `.grow`'s height and `ROW_H` disagree), a merge must fork and
      converge, and HEAD/branch/remote/tag chips must land on the right commits.
      Then **scroll to the bottom**: the next page appends and the lanes continue
      across the seam — the panel must never load a whole history, so a big repo is
      the interesting case here. `This branch` narrows it; ⟳ re-reads it.
- [ ] **The chips stay legible on a branchy repo.** On one with local branches, their
      remote twins and a tag on a release commit: a branch and its remote must be ONE
      chip (`main ⇡`, hover says "also on origin"), `origin/HEAD` must not appear, HEAD
      must be the leftmost chip, and a commit carrying many refs must fold into `+N`
      rather than slicing a name mid-word. Every subject in the panel starts at the same
      x, while the chips hug the graph's own width row by row. A truncated chip keeps
      its `⇡`, and hovering it names the branch.
- [ ] **A whole commit message is readable — all of it.** Pick the longest commit message
      in the repo (`git log --format='%H %b' | …`, or just a big merge write-up) and press ⏎
      (or `⤢`, or double-click): the overlay shows the full message, ↑/↓ still move
      through commits with it open, and **Esc closes the overlay first and the panel
      second**. Both closes work — the header's ✕ and the
      `✕ Close` at the bottom right, which must sit on **exactly** the pixels the
      `⤢ Full message` button occupied, so opening and closing a message needs no mouse
      movement at all. Check that by clicking one and then the other without moving. A truncated subject in a row is readable by hovering it.
- [ ] **The table collapses in the right order.** Narrow the window: the date shortens
      (`2d`), then the sha column goes, then the author — and the *subject* keeps a
      usable width throughout, never squeezed to nothing.
- [ ] **The lanes say what they are.** Hover a node, and select one: the tooltip and the
      detail strip must name the branch that lane leads up to, and a merge must name what
      it took in. Check a commit *below* a branch tip on a busy line — the label is the
      nearest ref above it, so a stale side branch further up must not claim it, and a
      release tag must not name a stretch of history at all. This wording is a claim
      about ancestry; if it reads wrong, it is wrong.

### Sessions Episko doesn't own

- [ ] **An external session appears.** Start `claude` in a plain terminal; it shows in
      the sidebar within ~3s as a read-only mirror. Then `/clear` inside it and confirm
      it does **not** duplicate or vanish (pid-based filtering, not id-based).
- [ ] **↗ fronts its terminal.** macOS picks the exact *tab* (Terminal.app / iTerm2);
      Windows picks the *window*, so check it with two windows of one app open — two VS
      Code windows on different projects, or two Windows Terminal windows — and confirm
      the jump lands on the one running that session, not merely on the app. That
      tiebreak reads the window title, so it is the half no unit test can hold.

### The OS edge

- [ ] **Tray** mirrors the fleet; picking a session brings it to the stage.
- [ ] **Quit guard** warns about live sessions.
- [ ] **Caffeinate** asserts and releases (the icon reads armed vs asserting).
- [ ] **The window survives a resize** — panes refit, no stuck scrollback.

### The title bar, which is the header (no native one behind it)

Nothing here has automated cover: the frame is drawn by the OS on one side and by
`#winCtl` on the other, and each platform only ever sees its own half.

- [ ] **There is one bar, not two**, and the window still moves: drag the header
      (its background, the logo, the empty space around ⌘K) and the window follows;
      double-clicking it maximizes. **⌘K still opens on a single click** — the search
      bar opts out of the drag region, and a regression there is silent.
- [ ] **Windows:** minimize / maximize / close all work from the header, the middle
      glyph flips to the restore pair when maximized **and back** (also after Win+↑
      and a snap, which don't go through our button), and ✕ still raises the quit
      guard rather than killing live sessions. Then **resize from every edge and
      corner** and drag the window to a screen edge to snap — an undecorated window
      resizes through a child window tauri only attaches at creation, so this is what
      catches it having been lost.
- [ ] **macOS:** the traffic lights sit in the header, vertically centred, without
      overlapping the logo — and all three work, the green one included (both zoom
      and, held, fullscreen). In fullscreen the header must close the gap they leave.

### Logs, after all of the above

- [ ] `episko.log` ends with `exit · clean shutdown`. A log that just stops is
      evidence of an abnormal termination, and `panic.log` next to it is the only trace
      of a panic that unwound cleanly out of `main`.
- [ ] The debug snapshot is current. It is written **compact** and only when the state
      changed, plus a 60s heartbeat — so a `generatedAt` older than ~60s means the
      frontend stopped flushing, not that nothing happened.

| | macOS | Windows |
| --- | --- | --- |
| debug snapshot | `$TMPDIR/cc-launcher/episko-debug.json` | `%TEMP%\cc-launcher\episko-debug.json` |
| rolling log | `~/Library/Logs/io.respeak.episko/episko.log` | `%LOCALAPPDATA%\io.respeak.episko\logs\episko.log` |

---

## Cutting it

**The order matters, and it is not the obvious one.** `changelog release` closes
`## Unreleased` into a version section and opens a fresh empty one — which is exactly
what the `dev → main` gate refuses. So the roll cannot happen on the branch the pull
request is cut from, and every release since 0.13.x has done it on `main` afterwards
(`d673829`, `4cdf601`, `105d069` — each three files, on main, after the merge commit).

```sh
# 1. on dev: `## Unreleased` is FULL. Open the PR and let CI read it.
gh pr create --base main --head dev --title "release: 0.14.0"
gh pr merge <n> --merge            # a merge commit, not a squash

# 2. on main, after the merge — the roll and the version bump are one commit
git checkout main && git pull --ff-only
pnpm changelog release 0.14.0      # then re-read it: it does NOT write the lede
$EDITOR CHANGELOG.md               # add the one-line lede under the heading
#   …and bump `version` in package.json AND src-tauri/tauri.conf.json to match
git commit -am "release: 0.14.0" && git push origin main

# 3. the tag, from main
git tag v0.14.0 && git push origin v0.14.0

# 4. put main back into dev, or the next release ships these notes twice
git checkout dev && git merge --ff-only main && git push origin dev
```

**Step 4 is not tidying.** The merge leaves `main` with the entries rolled into a
version section and `dev` still holding the same entries under `## Unreleased`, so the
*next* dev → main PR re-proposes all of them and the release after that ships the
section twice. `dev` is a strict ancestor of `main` at this point, so it fast-forwards.
Afterwards `changelog check` fails on `dev` — correct, and not a problem: that gate only
runs on a pull request onto `main`, and the first entry of the next release clears it.

**The lede is worth the extra minute.** `changelog release` writes only the heading;
*What's new* renders the line under it as the release's headline, and `release.yml`
lifts the whole section into the GitHub release body. A section with no entries **and**
no lede is dropped at parse time, so a botched roll ships a release describing nothing.
Check it before tagging: `node scripts/changelog.mjs section 0.14.0 | head -3`.

`release.yml` builds both platforms against that tag, and both jobs append to the one
GitHub Release: macOS `aarch64` produces the `.dmg` + the updater artifact, Windows
x64 the NSIS `.exe` and `.msi`. The minisign key signs the updater artifacts on both;
**OS code-signing is separate** — macOS is self-signed and not notarized, and Windows
Azure Trusted Signing is opt-in and no-ops until the `AZURE_CLIENT_ID` secret exists
(see `src-tauri/SIGNING.md`).

Install instructions are embedded in the release body by the workflow, because GitHub
cannot pin a release and "always in the newest one" is the equivalent.

## After tagging

- [ ] Both matrix jobs green, and **both platforms' assets** on the release — a
      partial matrix leaves a release that only some users can install.
- [ ] `latest.json` is present and lists both platforms, or the in-app updater offers
      nothing.
- [ ] **The updater actually updates.** Install the *previous* version, launch it, and
      take the update. This is the one step that cannot be checked before tagging, and
      the one whose failure is silently permanent for everyone already installed.
- [ ] On Windows, SmartScreen warns but **More info → Run anyway** works. On macOS the
      quarantine steps in the release body clear it.
- [ ] **episko.dev shows the new version.** `site.yml` deploys it, chained off
      `release.yml` finishing — *not* off the release being published, because
      tauri-action creates that with `GITHUB_TOKEN` and GitHub will not start a
      workflow from an event that token raised. It fired for none of v0.10.0 … v0.11.1
      for exactly that reason, so if the chain ever goes quiet again, the fallback is
      `gh workflow run site.yml -f version=<x.y.z>`. The label the page *fetches* comes
      from the releases API at runtime, so a stale deploy only shows with JS off or
      when that unauthenticated API rate-limits — check the served HTML, not the
      rendered page: `curl -s https://episko.dev | grep -o 'data-ver>v[0-9.]*'`.
