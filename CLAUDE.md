# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Episko is a Tauri v2 desktop app (Rust backend + vanilla-TS frontend) that launches and manages many Claude Code sessions at once (each in its own PTY) and streams live status/cost/context telemetry back into the app. macOS-first; still an early spike.

**The deep design notes live in `docs/`, one file per area, indexed at the bottom of this file. Read the matching doc before working on an area.** This file keeps the commands, the module maps, and the invariants that apply to almost any change.

## Commands

```sh
pnpm install            # first time
pnpm tauri dev      # run the app (Tauri + Vite dev server on fixed port 1420)
pnpm tauri build    # production bundle
pnpm build          # tsc typecheck + vite build (frontend only; the beforeBuildCommand)
pnpm exec tsc --noEmit       # typecheck only (tsconfig is noEmit)
pnpm test               # vitest: frontend unit tests (test/*.test.ts)
pnpm coverage           # the same suites with v8 coverage
```

Rust backend (run from `src-tauri/`): `cargo check`, `cargo test`, `cargo build`, `cargo clippy --all-targets`. **Clippy is a CI gate** (`-- -D warnings`, both OSes). Run `rustup component add clippy` first, then run every gate above locally before pushing, on the toolchains CI uses (`stable` Rust, the `.nvmrc` Node via `nvm use`). All three suites have gone red in CI for exactly one reason: the check was never run locally.

- **Package manager: `pnpm`**, never npm (`pnpm-lock.yaml`; `packageManager` pins the version; CI uses `--frozen-lockfile`).
- Half the Rust is platform-`cfg`-gated and invisible to any one machine. The **cfg-flip trick** type-checks the other half; see `docs/testing.md` for the procedure and its limits, and commit your real changes before running it.
- **Never build a test's temp path by hand.** `testutil::scratch_dir` resolves before it returns so fixtures compare like with like; `env::temp_dir()` is a symlink on macOS and an 8.3 short name on the Windows runner (`docs/testing.md`).

## Testing

**Unit-only: there is no end-to-end harness**, though the suites are substantial: roughly 800 vitest + 180 cargo tests, run in CI on both OSes; `tsc` (strict) is the real linter. The render, view and DOM-owning modules on both sides are untested by design, since anything touching the DOM, PTYs or live telemetry is verified by running the app, and **`RELEASE.md` holds that manual checklist** plus the tag/verify steps. Coverage is a yardstick with no gate on it, deliberately (`docs/testing.md` for the numbers and the vitest reporter trap).

- **vitest runs in the `node` environment**: no module a test can reach may touch a browser global at module scope: `document`, `window`, *or* `navigator`. Platform predicates live in `dom.ts` (`IS_MAC`, `IS_WIN`) behind a `typeof navigator` guard; import those.
- Two **contract tests parse source rather than call it**: `dispatch.test.ts` (a `[data-*]` branch is unreachable unless its attribute is in the dispatcher's `closest()` selector) and `ipc.test.ts` (an `invoke("x", {…})` must pass exactly the arguments `#[tauri::command] fn x` declares, since Tauri rejects the whole invoke on one missing key). Both joins had silently broken in production before the tests existed.
- Rust tests are in-file `#[cfg(test)] mod tests`, several driving real `git` or the real `tiny_http` server; there is deliberately no `src-tauri/tests/` dir. Two `#[ignore]`d tests run against the real `claude` CLI via `cargo test -- --ignored`, which is a `RELEASE.md` step rather than a CI one.

## The core mechanism: per-launch instrumentation

This is the one idea that makes the whole app work; everything else hangs off it.

On every launch, the Rust backend (`write_instrument_settings`) generates a throwaway `--settings` file at `$TMPDIR/cc-launcher/instrument-<uuid>.json` containing a `statusLine` command and `hooks` for the full session lifecycle. Each hook/statusLine is a shell command that POSTs its JSON payload to a **localhost `tiny_http` server the app bound to an ephemeral port at startup**. Claude is then spawned as `claude --session-id <uuid> --settings <file>`, so:

- Every event carries the `session_id` we chose, letting the frontend route it to the right pane **before any output appears**.
- No global `~/.claude` mutation and no transcript-file parsing, so instrumentation is entirely per-launch and disappears with the temp file.

**Route by the stable launch id, never Claude's runtime `session_id`.** Claude mints a *new* `session_id` on `/clear`, `/compact` and `/resume`, so the payload's `session_id` drifts away from the uuid we launched with, after which telemetry would route to nothing (inspector freezes) and the `SessionEnd` fired at the rotation would leave the pane showing the "ended" `·` glyph while the process runs on. So every hook/statusLine POST is tagged with our stable uuid via an **`X-CC-Session` header** (and the blocking permission hook via **`?sid=`**, since it's `type:"http"` with no shell to add a header). `run_telemetry_server` reads that and *forces* it onto the payload's `session_id` before emitting. As a backstop, the frontend un-ends any session that keeps receiving statusLines (a statusLine only fires from a live REPL).

Three hard constraints shape this code:

- **Claude runs hooks/statusLine with a stripped PATH.** Generated commands use absolute `/usr/bin/curl` and `/bin/cat`, never bare `curl`. Likewise `resolve_claude()` probes known install locations (and falls back to the login shell) and `augmented_path()` rebuilds a usable PATH, because a GUI app launched from Finder also gets a stripped PATH.
- **The hooks run no shell; the statusLine cannot avoid one.** A command hook takes an **exec form** (`command` plus an `args` array, each element delivered verbatim), so the hooks spawn `curl` and nothing else (the shell form it replaced paid a PowerShell launch per hook event). The statusLine gets no such escape: Claude Code defines neither `args` nor `shell` for it and routes it through **Git Bash whenever Git Bash is installed** (else PowerShell), so that one command must parse in *either* shell: no `&` call operator, no `$null`, no `Write-Output`, and forward slashes. Get that wrong and there is no error, just every figure the statusLine carries (model, context %, cost, duration, **the rate limits**) gone at once while the hooks keep phases flowing. That shipped once.
  **Neither half can be checked by reading the generated JSON** (such a test agrees with our intent, and the intent was the bug), so both are *executed* against a mock server for no tokens: `statusline_command_posts_from_every_shell_claude_might_pick` and `hook_exec_form_posts_without_any_shell`, guarding opposite hazards (a shell may not *parse* the string; with no shell nothing strips quotes, so shell-style quoting reaches curl verbatim). Both failures are silent (`-s` + `async`).
- **`PermissionRequest` is a *blocking* `type:"http"` hook**, unlike the other events (`"async": true`, fire-and-forget). The telemetry server holds that request open in `AppState.pending`, emits a `permission` event to the UI, and only responds when `resolve_permission` is called with allow/deny/terminal. Do not make it async or respond early, or Claude will hang or lose the decision.

## Backend (`src-tauri/src/`): thirteen modules

`main.rs` only calls `episko_lib::run()`. `lib.rs` is the **bootstrap**; the backend logic is the twelve modules under it. Dependencies point downward, `platform.rs` at the bottom. Rust tests are in-file `#[cfg(test)] mod tests`, next to their subject.

| Module | What |
| --- | --- |
| `lib.rs` | `run()`, `AppState`/`Session`, the window (see docs/native-ui.md), the tray mirror, the panic hook, `write_debug_file`/`log_frontend`, `confirm_quit`, and the `invoke_handler!` list |
| `git.rs` | worktrees, branches (local **and** remote-only, each with its standing and author), the working-set diff, the paged commit graph, the toolbar's fetch/pull/push, commit info, the branch sweeps (`sweep_branches`, `delete_remote_branches`) |
| `tasks.rs` | runnable discovery; see docs/tasks.md |
| `usage.rs` | transcripts (incl. History's whole-machine scan) + the token ledger; everything read out of `~/.claude` |
| `pty.rs` | the four launch engines, the permission-mode whitelist, app-wide disk I/O, `stream_pty_session`, the PTY lifecycle |
| `telemetry.rs` | `write_instrument_settings`, `run_telemetry_server`, `resolve_permission` |
| `platform.rs` | OS leaves (top half, incl. `norm_path`/`physical_cwd` and the `path_holders`/`remove_tree` group) + OS integrations (bottom half) |
| `external.rs` | the `~/.claude/sessions` registry, `ProcTable`, terminal focus |
| `github.rs` | `gh`: issues/PRs, the claim writes, closing, the committed keep list, the merged-PR evidence behind the broom's force |
| `notes.rs` | shared notes (`.episko/notes.toml`) |
| `summarize.rs` | `summarize_day` (Haiku via `claude -p`) over both `Scope`s + the committed `.episko/digest.md` |
| `icons.rs` | project favicon/logo probing + the tray menu's status glyphs (`glyph_rgba`) |
| `testutil.rs` | `git`, `scratch_dir`, `cfg(test)` only |

Four conventions hold across them:

- **`AppState` and `Session` live in the crate root**, reached as `crate::AppState`. There is deliberately **no `state.rs`**, because `run()` is their only constructor and it lives in `lib.rs`, so owner and definition stay together. Their *fields* need no visibility annotation at all (a private field is visible to the defining module and every descendant, and every module here is a descendant of the crate root); only the structs carry `pub(crate)`, and only to satisfy the private-in-public lint. Don't mix in a `state.rs` later.
- **`pub(crate)`, never `pub`**, including on a `#[tauri::command]` fn in a private module, which works. `tasks.rs` uses plain `pub` and only looks like a counter-example: `mod tasks;` is private, so `pub` inside it is unreachable from outside the crate anyway.
- **`platform.rs`'s first half imports nothing from the crate.** That is exactly what lets every other module depend on it; the second half (the OS integrations) may, since `set_caffeinate` takes `State<AppState>`. **Don't let the first half grow a crate dependency.**
- **A cfg-gated helper with a single consumer module belongs to *that* module** rather than to `platform.rs`. `apply_utf8_locale` and `interactive_shell` are `pty.rs`'s (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, and the leaf layer must not import `portable_pty`), `same_path` is `git.rs`'s.

`AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see docs/sessions.md), `io_samples` (the previous disk-I/O reading per pid, which is what turns the kernel's lifetime byte counters into the inspector's rate) and `io_retired` (the bytes of sessions that have since exited, so the app-wide total doesn't fall when a pane closes), the held-open `pending` permission requests, and `caffeinate`.

The disk-I/O accounting behind `io_samples`/`io_retired` (run vs. day vs. all-time, the `cc-io` rollup, `splitIo`, what the counters do and don't cover) is subtle and lives in `docs/architecture.md`; read it before touching any of it.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane. The `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `kind:"shell"` on the frontend `Sess` and skip telemetry/cost; `spawn_task` is the third entry point (see docs/tasks.md).
- **`write_pty` is the one place that decides what a child receives**, and on Windows that is not "the bytes we were given": ConPTY re-synthesizes a VT stream into key events, and a character it best-fits into the OEM code page arrives on a key-**up** record, where `_getwch` (Python's `getpass`, i.e. any script asking for a secret) never looks. So a non-ASCII character goes out as a win32 input record instead (`win32_input_encode`), exactly as Windows Terminal does. **ASCII and escape sequences are never rewritten.** Read docs/architecture.md before touching it; a hidden prompt makes every mistake here silent.
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()`; add new `#[tauri::command]` fns there.

## Frontend (`src/`, `index.html`, `src/styles.css`): 58 modules

**No framework, and no longer one file.** 58 modules; `main.ts` is **bootstrap only**. State lives in a `sessions: Map<session_id, Sess>` (owned by `state.ts`) plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing, so follow this render-everything pattern rather than mutating DOM directly. **`renderAll()` is coalesced**: a call only marks the pass due, and one flush per animation frame paints whatever state every event in that frame left behind, so a telemetry burst from N sessions costs a single paint. The rAF is paired with a 250ms `setTimeout` fallback, and that is not belt-and-braces: rAF never fires while the window is hidden, and the tray this pass repaints is exactly the surface being read then. The 🐞 console counts paints beside received events (`paints` in the stats line), so the batching is checkable while the app runs.

What `main.ts` still holds, deliberately: the imports and the whole of the `setXHost`/`setX` wiring (the seam map, which belongs in the file that owns the graph), the one-time startup blocks, `renderAll()`, every `listen()` handler, the delegated `[data-*]` click dispatcher and the global keydown, the ResizeObserver, the quit guard, the debug-console button wiring, the window controls (see docs/native-ui.md), and the `setInterval`s.

**Tested logic modules** (twenty-five, with no DOM, no Tauri and no render imports; these are what the vitest suites cover, one `test/*.test.ts` per module bar `types.ts`, whose discriminants are exercised through the four suites that import it, plus `dispatch.test.ts` and `ipc.test.ts` which read source instead of importing it):

| Module | What |
| --- | --- |
| `types.ts` | the shared data model: `Sess`, `Phase`, `Fanout`, and the one-line discriminants that read them (`isAgent`, `statusKey`, `PILL_TEXT`, `bgWaiting`, `fanoutTally`, `runElapsed`, `taskStateText`) |
| `format.ts` | durations, paths, escaping, sparklines, money and token counts; data in, string out. `dialogBody` is here too: a confirmation's plain-text prose → the markup ./confirm paints |
| `diff.ts` | the unified-diff parser behind the working-set viewer (the extraction precedent) |
| `rl.ts` | account-wide rate limits: merging readings, burn rate, the window forecast |
| `usage.ts` | the `cc-usage` daily rollup, `uBuckets`/`uSum`, the day/token join, `daySpend`'s split of a day, the `cc-io` disk rollup and what keeps a claude self-update's ~290 MiB out of it |
| `phase.ts` | `applyHook` / `applyStatusline`: telemetry → session state. The heart of the display |
| `files.ts` | the inspector's Context card: which files a session read, edited and created, the ladder a file's kind climbs, and the one-line tally of everything that moved no file |
| `palette.ts` | ⌘K ranking: fuzzy match, scoring, prefix parsing, frecency |
| `grouping.ts` | what the sidebar shows and in what order; `urgencyRank`, `needsYou`/`attnPending`/`syncAttn`, `nextAfterClose`, `dormantBusy`, and the run-group fold (`foldRunGroups`, `groupPhase`, `nextInGroup`) |
| `tasks.ts` | the frontend half of Runnables: `stopRuleBlocked`, `launchWithDeps` (dep memoisation), `findDepCycle`, `applyRunner`, `${input:…}` glue |
| `history.ts` | History's rules: `histProject` (regrafting a row onto a project), `histBusy`, the scope/search predicates, day buckets |
| `gitwatch.ts` | `gitMutates`: whether a shell command an agent ran is worth re-reading git for; `driftTarget`/`driftUpdate`: which checkout its work has moved to, from writes *and* `cwd` |
| `graph.ts` | the commit graph: `layoutGraph`'s lanes, what names a lane (`lineRef`, `lineTip`), `parseRefs`, the geometry and `rowSvg` |
| `peek.ts` | the sidebar's hover-to-reveal: what arms, what cancels, what the next deadline is |
| `attn.ts` | the moment a session starts wanting you: the highlight that fades off its row, the order the "your turn" badge queues in, and what opening a pane does to it |
| `projgroups.ts` | the user's named groups of projects: the store, its repair, and every mutation of it |
| `trail.ts` | a day of work assembled from transcripts, git and the usage rollup; `dayFacts` (yours) and `projectDayFacts`/`sharedDay` (the team's) |
| `notes.ts` | the one thing on the dashboard you type; capture, filing, removal |
| `branches.ts` | branch cleanup: what is worth deleting, what blocks it, and what each command is asked for (see docs/worktrees.md) |
| `dash.ts` | the project dashboard's rules: `projectTier`, `dashDays`, `dashPulse`, `projectCost` |
| `ghwork.ts` | issues and PRs: recency buckets, what triage dares suggest, who already has one |
| `changelog.ts` | CHANGELOG.md → releases, `inlineMd`'s bold/italic/code, and the one moment *What's new* opens by itself |
| `claim.ts` | what Episko writes when you dispatch at shared work, and who decides |
| `sound.ts` | which moments are worth hearing, the tones as data, and (the hard part) what stops a fleet becoming a fruit machine |
| `keys.ts` | the bindable actions, a chord's parse/format/match, what happens when a rebind takes a chord somebody else had, and what the master switch turns off |

**Shared**: `state.ts` (the session map, the stage pointer, every persisted preference) and `dom.ts` (`$`, `toast`, the shared scrim, `IS_MAC`/`MOD`/`chord`).

**Markup-only views**, untested by design: `usageview`, `inspectorview`, `sidebarview`.

**DOM-owning / render**, untested by design: `sidebar`, `footer`, `tray`, `inspector`, `debug`, `confirm` (every yes/no question in the app), `worktree` (the new-session dialog and the worktree removal flows, the biggest single module), `settings`, `taskui`, `palui`, `projmenu`, `caffeinate`, `diffview`, `graphview` (the paged commit-graph panel), `mirror`, `historyui`, `update`, `chime` (the only file that touches Web Audio, a live browser resource, so a test would only assert against its own mock).

**Behaviour**, IPC and DOM all the way down, so untested too, and therefore the thinnest ice in the app: `panes` (the three spawners + a pane's lifecycle), `terminal` (the xterm plumbing), `taskrun` (run on stop), `actions` (the app-level verbs), `icons` (the per-project glyph store).

Four rules keep that graph honest. **There are no import cycles across the 57 modules; re-run a cycle check after any change that adds an import.**

- **Dependency direction is state ← render ← wiring.** A logic module must not import render code or `main.ts`.
- **When an extracted function needs something that lives further up**, resolve it in this order: (1) **move the callee down too** if it is itself leaf-shaped, which is why `icons.ts` sits below `sidebar.ts` and `usage.ts` below `phase.ts`; (2) **a settable hook defaulting to a no-op** (`setRlLogger`, `setPanesRenderAll`) when the callee genuinely belongs to the render layer; (3) **an extra parameter** only as a last resort, since it changes a signature the move was supposed to leave alone. A control panel touching many things it doesn't own may take **one host object** instead of N setters (`settings`, `palui`, `projmenu`); prefer per-callee setters below ~4.
- **A `*view.ts` takes data and returns a string**: no `$()`, no `innerHTML`, no renderer call. The `render*` function that paints the result stays with whoever owns the element, its timers and its delegated handlers. If a candidate seems to need a `setSomething`, it is a `render*` and should stay behind.
- **`state.ts`'s `setX` setters assign and nothing else.** Persistence and `renderAll()` belong to the call site, which is what `actions.ts` is for. (Conflating the two is a bug this codebase has already shipped once: a settings picker called `state.ts`'s `setWtGroup` instead of `actions.ts`'s, so the choice never persisted.) Reads are the live ESM binding and stay bare identifiers (`activeId`, never `state.activeId`).

**Every `innerHTML` surface on `renderAll`'s path is guarded**: markup is rebuilt every pass but assigned only when the string differs from the last write. On an interactive surface the guard is doing *correctness* work: an assignment destroys the node under the pointer, which can silently drop a click (a permission *Allow* was lost exactly that way). A per-second clock in the markup defeats a guard entirely, and the cache must be invalidated wherever another module writes the same element (`stageGen`). Full story (which surfaces, the measurement trap, why `textContent` surfaces need no guard) in `docs/architecture.md`; read it before adding any surface to `renderAll`.

And the things that hold however the files are arranged:

- **`Sess.kind`** (`"claude" | "shell" | "task"`) decides whether telemetry, cost
  and git actions apply to a pane. Use the `isAgent(s)` helper rather than
  re-testing the string. It is orthogonal to `Sess.external`, which means "the
  terminal lives in Ghostty/iTerm rather than an embedded pane" and only ever
  applies to a claude session.
- **A pane's WebGL context comes from a small LRU pool** (`attachWebgl`/`detachWebgl` in `terminal.ts`, `GL_POOL_MAX` = 8). Both simpler designs (a context per pane for life, dispose-per-deactivation) were tried and are wrong; `docs/architecture.md` says why, along with the ended-pane scrollback rules.
- **A claude pane's keystrokes are filtered before the PTY sees them.** They go through `claudeInput` in `terminal.ts`, which swallows a fast double `^C`. xterm keeps only **one** `attachCustomKeyEventHandler` per pane: a new key rule belongs in `claudeInput`/`winClaudePaste` (claude), `shellKeys` (shell) or `clipboardKeys` (task), never in a second handler.
- **Copy/paste in a shell or task pane is Ctrl+Shift+C/V**, read/written via `tauri-plugin-clipboard-manager` (never `navigator.clipboard`, which raises OS permission prompts) and pasted through `term.paste` (never `write_pty`, since bracketed paste and `\r\n`→`\r` must still apply).
- **A `[data-*]` branch is only reachable if its attribute is ALSO in the dispatcher's
  `closest()` selector.** One selector decides what `el` is; an unlisted attribute means
  `el` is null and the handler returns before the branch written for it. `tsc` is happy
  and every unit test passes, so the feature is simply dead, and only clicking it finds
  out. That is how the dashboard shipped in 0.13.0 with its entry point disconnected.
  `test/dispatch.test.ts` now compares the two halves in both directions (an unlisted
  branch is unreachable; a listed attribute with no branch silently swallows clicks).
- **Read every shortcut from its binding.** `keyPrefs` (./state, from `keys.ts`) is the
  one table; `matchAction` dispatches it in main.ts, Settings › Keys rebinds it, and the
  footer popover, the palette hints and the sidebar's button titles all *read* it. Never
  compare `e.key` to a letter for an app-level shortcut, and never spell a chord into a
  label. Both were how the handler, the cheat sheet and the hints drifted apart before.
  Matching is **exact**, so a shifted binding no longer has to be written above its
  unshifted twin to fire (the old chain's documented trap). Escape stays hard-coded: it
  backs out of whichever dialog is open, so it is nine bindings, not one. A tenth lives
  in `confirm.ts` and deliberately pre-empts all of them (see the rule below).
- **Read a chord through `activeBind(keyPrefs, id)`, never `keyPrefs.binds[id]`.** That is
  the one place the master switch is applied, and `matchAction`/`shortcutRows` take the
  whole `KeyPrefs` so a caller cannot skip it. A display site that read `binds` directly
  would leave the footer sheet, the palette and the tooltips advertising chords the app
  has stopped answering. **The Settings picker is the one exception** and must stay one:
  it *edits* the stored chords, so with the switch off it still shows what you set;
  resolving through `activeBind` there would blank all fourteen rows and turn "your
  chords are kept" into a lie.
- **There are two independent levels of off, and neither is destructive.** A cleared row
  (`binds[id] === null`, the ⊘ button) says *this chord is in my way*; the master switch
  says *give the keyboard back to the agents*. They round-trip separately through
  `cc-keys`, so flipping the switch back on must not resurrect rows cleared one at a
  time. Neither reaches Escape (nine dialogs rather than one action, and never bindable) or a
  terminal's own copy/paste (xterm's handler, below this layer), which is what makes
  either safe to leave on.
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of `main.ts`. Telemetry is routed by `data.session_id?.toLowerCase()`, so session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **The inspector's Context card is a *set of files*, not a log of tool calls** (`files.ts`, `contextHtml`). `Sess.files` holds one entry per path with a `kind` that only ever climbs read → edited → created, because an agent re-reads what it just wrote constantly and a last-verb-wins field would demote half the edited files seconds later. It is fed from **PostToolUse**, not the Pre hook the timeline opens on: `tool_response.type` is what distinguishes a `Write` that created from one that overwrote. **Bash is deliberately not modelled** — `touch`, `>` and `sed -i` reach us as a shell string, and what they did to the tree is already answered correctly by the working-set card that reads git; the non-file tools are summarised in one line instead. The old timeline is still there under the card's `Tools` tab.
- **A turn the API killed ends in `error`.** `StopFailure` sets `Sess.apiErr`; **`endTurn` is the single place that decides done vs. error**; every surface reads `phaseText(s)`, never `PILL_TEXT[s.phase]` directly. The trap (a 60s idle nudge that relabels the failure) shipped once; see `docs/architecture.md`.
- **A turn that ended while its agents run on stays `background`.** The `Workflow` tool returns a run id in ~2s and `Stop` fires while its fleet runs for another twenty minutes, so `done` alone stopped meaning "your turn". `Sess.fanout` holds the run (named from the `PreToolUse{Workflow}` payload, counted from `SubagentStart`/`Stop`, with no disk and no backend), `statusKey` answers `"background"` for it, and `needsYou` says no. **Never add a status to `GLYPH`/`GCLASS` without also adding it to `tray.ts`'s `SHAPE`**; see `docs/architecture.md`.
- **A `localStorage` write on the telemetry path is a disk write**: statusLines land every ~10s per session. Three cadences, chosen deliberately: eager (`cc-usage`, small and unreconstructable), only-when-changed (`cc-cost-base`), floored and flushed on quit/midnight (`cc-usage-detail` 30s, `cc-io` 60s). Cap anything keyed by day. Sizes and reasoning: `docs/architecture.md`.
- **Persistence is all `localStorage`**, every key prefixed `cc-`; `grep '"cc-'` for the current set.
- **Debug console** (🐞, bottom-right): in-app event log + live state via `dlog()`/`dbgSnapshot()`; flags unrouted telemetry and JS errors; mirrors a snapshot to `$TMPDIR/cc-launcher/episko-debug.json` for external tools. The snapshot is state-of-now and does not survive a crash. The durable timeline is the rolling `episko.log` (+ `panic.log`) in the OS app-log dir, which every `dlog()` tees into via `log_frontend` (`docs/architecture.md`).

## App-wide rules

- **Episko writes almost nothing outside its own storage.** In a user's repo: only `.episko/{tasks.toml,episko.toml,notes.toml,digest.md}`, always through `toml_edit`/read-modify-write so hand-written formatting survives, and always asking before creating a new committable file. The single write inside `~/.claude` is *Move session*'s transcript move. Everything else is `localStorage` and the app dirs.
- **The stage has one owner**: `activeId` and the `mirror` pointer (`{kind:"ext"|"past"|"dash"}`) are mutually exclusive, and `takeStage(show)` in `dom.ts` is the only code that may touch `#extPane`/`#dashPane`/`#empty`/`insp-mini`. Add a stage kind by extending `Stage`, never by poking `hidden` at a call site.
- **`termEngine` picks where a terminal lives** (embedded xterm pane / ghostty / Terminal / iTerm); the per-launch instrumentation and telemetry are identical for all four. `permMode` is orthogonal and sets the *starting* permission mode only (`docs/sessions.md`).
- **`needsYou` is the raw fact; `attnPending` is what you count at the user.** A session
  you have been to since it finished leaves the badge, the tray title, the palette's
  "Needs you" group and a collapsed group's glyph (`Sess.seenAt >= Sess.attnAt`, ./attn);
  a blocking permission never leaves any of them, because looking at one is not answering
  it. `attnAt` is stamped in **one** place — `syncAttn()`, the first line of
  `renderAllNow` — never at the five events that can set it, and never from `phaseSince`,
  which a permission does not move. Don't fold the filter into `needsYou`: `syncAttn`
  asks that one, and the two would then flip each other every paint (`docs/architecture.md`).
- **Every yes/no question goes through `ask` in `confirm.ts`, and nothing is ever asked
  natively.** `ask()` from `@tauri-apps/plugin-dialog` draws an OS box — system font,
  system button order, no way to mark which of the two answers deletes something, and
  the message flattened to one blob — so all ten confirmations were moved into the app's
  own skin. `confirm.ts` keeps the plugin's exact signature (`ask(message, { title, kind,
  okLabel, cancelLabel })`), so a call site changes only its import. `kind` is not
  decoration: `info` gets the accent button, `warning`/`error` get the red one. The
  message stays plain text — `dialogBody` (./format) reads its blank lines, bullets and
  backticks — so wording is edited where it is written, not in markup.
  **`open` is the one native dialog left**, deliberately: that is the OS file browser,
  and imitating it in-app would be strictly worse. `test/confirm.test.ts` fails if any
  other export of that plugin comes back.
  The dialog also owns the keyboard while it is up: a **capture-phase** `keydown`
  registered at module scope (so it beats main.ts's, whose listeners are added later in
  the same phase on the same target) calling **`stopImmediatePropagation`** — plain
  `stopPropagation` leaves main.ts's own capture listener for `reveal` live behind the
  modal. Esc, the cancel button and a backdrop click all resolve `false`; a second
  question raised while one is up **queues** rather than replacing it.
- **A sound is raised, never decided at the call site.** Every trigger calls `playSound(ev)` unconditionally and lets `sound.ts` answer; a second "are sounds on?" test anywhere is a switch that turns half the feature off (`docs/sounds.md`).

## Deep dives (`docs/`)

The full design notes (the shipped-bug histories and every invariant's reasoning) live in `docs/`, split out of this file. **Read the matching doc before working on an area.** The one-liners here are only each doc's sharpest rule.

- **`docs/testing.md`**: the gates in full, the cfg-flip trick and its limits, coverage caveats, the fixture-path trap.
- **`docs/tasks.md`**: runnables (`tasks.rs`, `▶ Run`, ⌘⇧B, run groups, run-on-stop, overrides). Discovery never executes the project; `dependsOn` is memoised (one chord once launched 27 panes for 11 tasks); a login shell does **not** give a task the user's PATH; Windows `CreateProcessW` cannot run a script; what can't run says so rather than disappearing.
- **`docs/releases.md`**: `CHANGELOG.md` has three consumers that must never disagree; the gate is on the PR rather than the tag; don't reintroduce the fresh-install guard.
- **`docs/dashboard.md`**: the project dashboard and its GitHub half. Three tiers (GitHub / git / neither); per-project cost comes from `cc-usage-detail`, never `cc-usage`; a claim is only ever a hint; a day's two generated sentences must never be mixed, and only the project half is committable (`.episko/digest.md`).
- **`docs/commit-graph.md`**: never read a whole history (one page at a time, `--date-order`); a tag never names a lane; `gc-*` is the chip prefix, `gco-*` the overlay's.
- **`docs/architecture.md`**: the deep halves of the backend/frontend sections above: disk-I/O accounting, the `innerHTML` guards, the needs-you set's two stamps, the WebGL pool, keystrokes/clipboard, `StopFailure`, storage cadences, the two logging tiers.
- **`docs/worktrees.md`**: project groups, the peek rows, the worktree roster and polls (`worktree_heads` is spawn-free and pollable; `list_worktrees` is neither), removal (a failed `git worktree remove` does **not** mean nothing happened), and drift (`Drift.via` decides the repair: follow in place vs. kill-wait-move-relaunch).
- **`docs/sessions.md`**: launch engines, permission modes (a whitelist rather than a passthrough), external sessions (filter owned ones by pid rather than by session id), restore (use `resumeId` rather than `id`; `costDelta` baselines, since anything that diffs a cumulative telemetry figure against a `Sess` field repeats a shipped bug), and History.
- **`docs/native-ui.md`**: the title bar (the window is built in `setup()` rather than by config; drag-region gotchas), the tray menu (icons exist because menu text is always menu-coloured; project headers must be disabled items), and the OS dialogs Episko stopped drawing (`confirm.ts` — a native box cannot mark its destructive button; the file picker is the one that stays).
- **`docs/sounds.md`**: sound alerts. The hard part is playing one sound instead of six: the same moment reaches the frontend twice *by design*, so every play is gated, except that a more urgent event still gets through the burst window, which is the point. Anything that fires on routine activity ships switched off.

## Notes on scope & doc drift

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines. Terminal-window focus is **no longer** one of them, since `focus_external_session` has a win32 half (see docs/sessions.md), though only macOS can address an individual tab. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic. Resource reporting is **no longer** one of the macOS-bound bits: `all_sessions_resources` reports disk I/O through `sysinfo` (one refresh, every OS) rather than shelling out to `ps`, so `ps_one` is now reached only from the macOS-only terminal-focus path.

**`SPIKE.md` is a historical record and is not maintained.** It describes the Phase-0 spike (single-session, "observe-only" permissions, one file per side) and is kept as the record of where this started rather than as a description of today. It carries a banner saying so. Don't consult it for how the app works today, and don't edit it to match; `README.md` is current.

**Trust the code over the docs** when they disagree, and fix the doc in the same commit.
