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
- `pnpm test` — 468 vitest tests over the logic modules
- `cargo check --locked` and `cargo test --locked` — 99 tests on macOS, 96 on
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
      happily on hooks alone. The evidence is the inspector's **model / context % /
      cost / duration**, the footer meters, and the **5h / 7d rate-limit windows**
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

### The two surfaces with no automated cover at all

Both are CSS/markup, so `tsc` and the suites say nothing about either.

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
