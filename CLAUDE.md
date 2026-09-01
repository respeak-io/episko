# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Episko is a Tauri v2 desktop app (Rust backend + vanilla-TS frontend) that launches and manages many coding-agent sessions at once (each in its own PTY) and streams provider capabilities such as status, context, usage and approvals back into the app. Claude Code and Codex are integrated providers; the remaining discovered CLIs use a terminal-only adapter. macOS-first; still an early spike.

**The deep design notes live in `docs/`, one file per area, indexed at the bottom of this file. Read the matching doc before working on an area.** This file keeps the commands, the module maps, and the invariants that apply to almost any change.

## Commands

```sh
pnpm install            # first time
pnpm tauri dev      # run the app (Tauri + Vite dev server on fixed port 1420)
pnpm tauri build    # production bundle
pnpm build          # typechecks BOTH projects + vite build (frontend only; the beforeBuildCommand)
pnpm exec tsc --noEmit       # typecheck src/ only (tsconfig is noEmit)
pnpm exec tsc -p tsconfig.test.json --noEmit   # typecheck test/ (the other half)
pnpm test               # vitest: frontend unit tests (test/*.test.ts)
pnpm coverage           # the same suites with v8 coverage
```

Rust backend (run from `src-tauri/`): `cargo check`, `cargo test`, `cargo build`, `cargo clippy --all-targets`. **Clippy is a CI gate** (`-- -D warnings`, both OSes). Run `rustup component add clippy` first, then run every gate above locally before pushing, on the toolchains CI uses (`stable` Rust, the `.nvmrc` Node via `nvm use`). All three suites have gone red in CI for exactly one reason: the check was never run locally.

- **Package manager: `pnpm`**, never npm (`pnpm-lock.yaml`; `packageManager` pins the version; CI uses `--frozen-lockfile`).
- Half the Rust is platform-`cfg`-gated and invisible to any one machine. The **cfg-flip trick** type-checks the other half; see `docs/testing.md` for the procedure and its limits, and commit your real changes before running it.
- **Never build a test's temp path by hand.** `testutil::scratch_dir` resolves before it returns so fixtures compare like with like; `env::temp_dir()` is a symlink on macOS and an 8.3 short name on the Windows runner (`docs/testing.md`).

## Testing

**Unit-only: there is no end-to-end harness**, though the suites are substantial: roughly 1400 vitest + 250 cargo tests, run in CI on both OSes; `tsc` (strict) is the real linter. The render, view and DOM-owning modules on both sides are untested by design, since anything touching the DOM, PTYs or live telemetry is verified by running the app, and **`RELEASE.md` holds that manual checklist** plus the tag/verify steps. Coverage is a yardstick with no gate on it, deliberately (`docs/testing.md` for the numbers and the vitest reporter trap).

- **vitest runs in the `node` environment**: no module a test can reach may touch a browser global at module scope: `document`, `window`, *or* `navigator`. Platform predicates live in `dom.ts` (`IS_MAC`, `IS_WIN`) behind a `typeof navigator` guard; import those.
- **`test/` is typechecked by a SECOND tsconfig, and the split is load-bearing.** The suites
  need `@types/node` (three contract tests parse source with `node:fs`); `src/` must never
  have it, because it is bundled for a webview and the only thing stopping a `process.env`
  from compiling there is that node's globals are absent. So `tsconfig.json` keeps
  `"types": []` — **without it TypeScript auto-loads every package under `node_modules/@types`
  and that guard silently dies the moment anything adds `@types/node`** — and
  `tsconfig.test.json` extends it with `types: ["node", "vite/client"]` and an ES2022 lib.
  `pnpm build` runs both, so CI gates both. src files are compiled under each project, but
  only the base one gates them, which is what keeps the guard real. Tests went unchecked
  until 0.22.0 and had drifted: a `Sess` fixture still carried a field deleted two PRs
  earlier, and two `HistEntry` fixtures were missing a required one.
- Four **contract tests parse source rather than call it**: `dispatch.test.ts` (a `[data-*]` branch is unreachable unless its attribute is in the dispatcher's `closest()` selector), `ipc.test.ts` (an `invoke("x", {…})` must pass exactly the arguments `#[tauri::command] fn x` declares, since Tauri rejects the whole invoke on one missing key) and `tour.test.ts` (a tour step's anchor must resolve in `index.html`, the rail legend it teaches must match `GLYPH`/`GCLASS`, and a card that says *Settings › Sounds* must name a tab `settings.ts` ships). The first two joins had silently broken in production before the tests existed; the third is the same shape. The fourth, `health.test.ts`, holds `isSourcePath` against `is_code_file` in `health.rs` — health.rs's own doc comment says the two lists must stay in step, and a comment is exactly as strong as whoever reads it; when they drifted, CSS files were measured and then silently never chipped.
- Rust tests are in-file `#[cfg(test)] mod tests`, several driving real `git` or the real `tiny_http` server; there is deliberately no `src-tauri/tests/` dir. Two `#[ignore]`d tests run against the real `claude` CLI via `cargo test -- --ignored`, which is a `RELEASE.md` step rather than a CI one.

## Claude's core mechanism: per-launch instrumentation

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
- **The server must be supervised, and it must come back on the SAME port.** `tiny_http`'s accept thread `break`s out of its loop on *any* `accept()` error, and `IncomingRequests::next()` is `self.server.recv().ok()` — so one `Err` becomes a `None` that ends the `for` loop, drops the `Server` and closes the socket. One `ECONNABORTED` did exactly that after six days of uptime and it stayed dead for fourteen hours: `AppState.port` still held the number, so every session launched afterwards got an instrument file pointing at a closed socket and sat at `idle` with no model, context, files or tools. Nothing anywhere said so — the hooks are `async` and everything uses `curl -s`. So `run_telemetry_server` is wrapped in **`serve_telemetry`**, which re-binds and re-binds *that port*: an instrument file is written at launch and never revisited, so reclaiming the number revives every running pane on its next statusLine, while a fresh port would only help future launches (it takes one only after ~a minute of failures, and then updates the now-**`AtomicU16`** `AppState.port`). Re-binding **must sleep first** — `tiny_http`'s `Drop` pokes its accept thread but never joins it, so the old listener is briefly still bound and `SO_REUSEADDR` does not help against a *listening* socket. Both transitions emit `telemetry-health`, which raises the top bar's red badge; a fleet nobody can hear must never look like a quiet one.

## Backend (`src-tauri/src/`): sixteen modules

`main.rs` only calls `episko_lib::run()`. `lib.rs` is the **bootstrap**; the backend logic is the fifteen modules under it. Dependencies point downward, `platform.rs` at the bottom. Rust tests are in-file `#[cfg(test)] mod tests`, next to their subject.

| Module | What |
| --- | --- |
| `lib.rs` | `run()`, `AppState`/`Session`, the window (see docs/native-ui.md), the tray mirror, the panic hook, `write_debug_file`/`log_frontend`, `confirm_quit`, and the `invoke_handler!` list |
| `git.rs` | worktrees, branches (local **and** remote-only, each with its standing and author), the working-set diff, the paged commit graph, the toolbar's fetch/pull/push, commit info, the branch sweeps (`sweep_branches`, `delete_remote_branches`) |
| `tasks.rs` | runnable discovery; see docs/tasks.md |
| `usage.rs` | transcripts (incl. History's whole-machine scan) + the token ledger; everything read out of `~/.claude` |
| `pty.rs` | the four launch engines, Claude's permission-mode whitelist, app-wide disk I/O (incl. `read_bg_log`, the tail of a background shell's output, and `bg_log_roots`/`bg_log_path`, where to find it), `stream_pty_session`, the PTY lifecycle |
| `agent.rs` | provider control planes beside a PTY: Codex App Server observer, launch-policy/approval routing and public history calls |
| `telemetry.rs` | `write_instrument_settings`, `run_telemetry_server` + the `serve_telemetry` supervisor that re-binds it, `resolve_permission` |
| `platform.rs` | OS leaves (top half, incl. `norm_path`/`physical_cwd` and the `path_holders`/`remove_tree` group) + OS integrations (bottom half) |
| `external.rs` | the `~/.claude/sessions` registry, `ProcTable`, terminal focus, `session_ports` (which TCP ports a pane's process tree is listening on) |
| `github.rs` | `gh`: issues/PRs, the claim writes, closing, the committed keep list, the merged-PR evidence behind the broom's force |
| `notes.rs` | shared notes (`.episko/notes.toml`) |
| `summarize.rs` | `summarize_day` (Haiku via `claude -p`) over both `Scope`s + the committed `.episko/digest.md` |
| `icons.rs` | project favicon/logo probing + the tray menu's status glyphs (`glyph_rgba`) |
| `files.rs` | the explorer's project index: `git ls-files` for a repo, a bounded walk for anything else; `index_of` is the in-crate half, so `health.rs` measures exactly the files the explorer lists |
| `health.rs` | what a change did to the shape of the code: code lines with comments stripped, function spans, nesting, approximate cognitive complexity, and the cross-file duplicate index. Facts only — which of them earn a chip is `health.ts`'s |
| `testutil.rs` | `git`, `scratch_dir`, `cfg(test)` only |

Four conventions hold across them:

- **`AppState` and `Session` live in the crate root**, reached as `crate::AppState`. There is deliberately **no `state.rs`**, because `run()` is their only constructor and it lives in `lib.rs`, so owner and definition stay together. Their *fields* need no visibility annotation at all (a private field is visible to the defining module and every descendant, and every module here is a descendant of the crate root); only the structs carry `pub(crate)`, and only to satisfy the private-in-public lint. Don't mix in a `state.rs` later.
- **`pub(crate)`, never `pub`**, including on a `#[tauri::command]` fn in a private module, which works. `tasks.rs` uses plain `pub` and only looks like a counter-example: `mod tasks;` is private, so `pub` inside it is unreachable from outside the crate anyway.
- **`platform.rs`'s first half imports nothing from the crate.** That is exactly what lets every other module depend on it; the second half (the OS integrations) may, since `set_caffeinate` takes `State<AppState>`. **Don't let the first half grow a crate dependency.**
- **A cfg-gated helper with a single consumer module belongs to *that* module** rather than to `platform.rs`. `apply_utf8_locale` and `interactive_shell` are `pty.rs`'s (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, and the leaf layer must not import `portable_pty`), `same_path` is `git.rs`'s.

`AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `agent_runtimes` (provider control-plane child + control channel), `owned_pids` (Claude external-registry filtering; see docs/sessions.md), `io_samples`, `io_retired`, the held-open Claude `pending` permission requests, and `caffeinate`.

The disk-I/O accounting behind `io_samples`/`io_retired` (run vs. day vs. all-time, the `cc-io` rollup, `splitIo`, what the counters do and don't cover) is subtle and lives in `docs/architecture.md`; read it before touching any of it.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns Claude, and (via `stream_pty_session`) starts the reader/reaper pair. `write_pty` / `resize_pty` / `kill_session` operate by session id. `spawn_shell` runs a login shell; `spawn_task` runs a discovered task; `spawn_agent` runs a non-Claude provider. Codex first starts a loopback App Server in `agent.rs` and points the real TUI at it with `--remote`; terminal-only providers go straight through `argv_command`. The reaper stops any provider runtime before emitting `pty-exit` (docs/sessions.md).
- **`write_pty` is the one place that decides what a child receives**, and on Windows that is not "the bytes we were given": ConPTY re-synthesizes a VT stream into key events, and a character it best-fits into the OEM code page arrives on a key-**up** record, where `_getwch` (Python's `getpass`, i.e. any script asking for a secret) never looks. So a non-ASCII character goes out as a win32 input record instead (`win32_input_encode`), exactly as Windows Terminal does. **ASCII and escape sequences are never rewritten.** Read docs/architecture.md before touching it; a hidden prompt makes every mistake here silent.
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()`; add new `#[tauri::command]` fns there.

## Frontend (`src/`, `index.html`, `src/styles.css`): 79 modules

**No framework, and no longer one file.** 79 modules; `main.ts` is **bootstrap only**. State lives in a `sessions: Map<session_id, Sess>` (owned by `state.ts`) plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing, so follow this render-everything pattern rather than mutating DOM directly. **`renderAll()` is coalesced**: a call only marks the pass due, and one flush per animation frame paints whatever state every event in that frame left behind, so a telemetry burst from N sessions costs a single paint. The rAF is paired with a 250ms `setTimeout` fallback, and that is not belt-and-braces: rAF never fires while the window is hidden, and the tray this pass repaints is exactly the surface being read then. The 🐞 console counts paints beside received events (`paints` in the stats line), so the batching is checkable while the app runs.

What `main.ts` still holds, deliberately: the imports and the whole of the `setXHost`/`setX` wiring (the seam map, which belongs in the file that owns the graph), the one-time startup blocks, `renderAll()`, every `listen()` handler, the delegated `[data-*]` click dispatcher and the global keydown, the ResizeObserver, the quit guard, the debug-console button wiring, the window controls (see docs/native-ui.md), and the `setInterval`s.

**Tested logic modules** (thirty-three, with no DOM, no Tauri and no render imports; these are what the vitest suites cover, one `test/*.test.ts` per module bar `types.ts`, whose discriminants are exercised through the four suites that import it, plus `dispatch.test.ts` and `ipc.test.ts` which read source instead of importing it):

| Module | What |
| --- | --- |
| `types.ts` | the shared data model: `Sess`, `Phase`, `Fanout`, and the one-line discriminants that read them (`isClaude`, `statusKey`, `PILL_TEXT`, `bgWaiting`, `fanoutTally`, `runElapsed`, `taskStateText`) |
| `agents.ts` | provider-neutral agent events and the shared reducer that mutates `Sess`; adapters feed this rather than writing a second cockpit |
| `providers/index.ts` | provider registry: normalized event adapters plus history/read/restore contracts used by shared UI |
| `providers/control.ts` | provider-specific approval routing, kept out of shared actions and reducers |
| `providers/codex.ts` | Codex App Server methods/items → normalized events, plus public thread history mapping |
| `format.ts` | durations, paths, escaping, sparklines, recency bands, money and token counts; data in, string out. `dialogBody` is here too: a confirmation's plain-text prose → the markup ./confirm paints. So is `cleanTitle` — the OSC title minus Claude's spinner — because that table tracks somebody else's release and belongs where it can be tested |
| `diff.ts` | the unified-diff parser behind the working-set viewer (the extraction precedent), plus what a *reader* needs from a hunk: which deletion became which addition (by similarity, not by position), and which words inside that pair moved — including when marking them would be noise |
| `rl.ts` | account-wide rate limits: merging readings, burn rate, the window forecast |
| `usage.ts` | the `cc-usage` daily rollup, `uBuckets`/`uSum`, the day/token join, `daySpend`'s split of a day, the `cc-io` disk rollup and what keeps a claude self-update's ~290 MiB out of it |
| `phase.ts` | `applyHook` / `applyStatusline`: telemetry → session state. The heart of the display |
| `files.ts` | the inspector's Context card: which files a session read, edited and created, the ladder a file's kind climbs, and the one-line tally of everything that moved no file |
| `health.ts` | which of `health.rs`'s measurements are worth saying: the thresholds and where each comes from, the two rules the patch answers alone (silenced errors, no test changed), and what a chip says |
| `toolio.ts` | what a tool call *was* and what came back: the three response shapes worth modelling by hand, the generic dump for everything else, the cap both sides are cut to as they land, and what Copy hands over |
| `palette.ts` | ⌘K ranking: fuzzy match, scoring, prefix parsing, frecency |
| `grouping.ts` | what the sidebar shows and in what order; `urgencyRank`, `needsYou`/`attnPending`/`syncAttn`, `nextAfterClose`, `dormantBusy`, and the run-group fold (`foldRunGroups`, `groupPhase`, `nextInGroup`) |
| `tasks.ts` | the frontend half of Runnables: `stopRuleBlocked`, `launchWithDeps` (dep memoisation), `findDepCycle`, `applyRunner`, `${input:…}` glue |
| `history.ts` | History's rules: `histProject` (regrafting a row onto a project), `histBusy`, the scope/search predicates, day buckets |
| `servers.ts` | the dev servers running behind the header pill, from all three sources: recognising an agent's backgrounded shell off its PostToolUse payload and reading its log file (the URL, the peek, the sentinel that says it died, and what the row says when the log was never found), telling a *server* from a *job* Claude auto-backgrounded at its 120s timeout (`timedOut`, `isJob`, `bgKind`), latching the URL an Episko task announces as its output streams, and reconciling both against the ports the kernel actually reports (`usefulPort`, `reconcilePorts`) |
| `gitwatch.ts` | `gitMutates`: whether a shell command an agent ran is worth re-reading git for; `driftTarget`/`driftUpdate`: which checkout its work has moved to, from writes, `cwd`, and the `cd` of a shell-only agent that calls no write tool |
| `graph.ts` | the commit graph: `layoutGraph`'s lanes, what names a lane (`lineRef`, `lineTip`), `parseRefs`, the geometry and `rowSvg` |
| `peek.ts` | the sidebar's hover-to-reveal: what arms, what cancels, what the next deadline is |
| `attn.ts` | the moment a session starts wanting you: the highlight that fades off its row, the order the "your turn" badge queues in, and what opening a pane does to it |
| `projgroups.ts` | the user's named groups of projects: the store, its repair, and every mutation of it |
| `trail.ts` | a day of work assembled from transcripts, git and the usage rollup; `dayFacts` (yours) and `projectDayFacts`/`sharedDay` (the team's) |
| `notes.ts` | the one thing on the dashboard you type; capture, filing, removal |
| `branches.ts` | branch cleanup: what is worth deleting, what blocks it, and what each command is asked for (see docs/worktrees.md) |
| `dash.ts` | the project dashboard's rules: `projectTier`, `dashDays`, `dashPulse`, `projectCost` |
| `explore.ts` | the explorer's rules: browse vs. find over one index, the scope filters, the touch join, what ↵ does (see docs/explorer.md) |
| `ghwork.ts` | issues and PRs: recency buckets, what triage dares suggest, who already has one |
| `changelog.ts` | CHANGELOG.md → releases, `inlineMd`'s bold/italic/code, and the one moment *What's new* opens by itself |
| `claim.ts` | what Episko writes when you dispatch at shared work, and who decides |
| `sound.ts` | which moments are worth hearing, the tones as data, and (the hard part) what stops a fleet becoming a fruit machine |
| `keys.ts` | the bindable actions, a chord's parse/format/match, what happens when a rebind takes a chord somebody else had, and what the master switch turns off |
| `footprefs.ts` | which segments the status bar shows: the table, the store, its repair, and why three of them have no switch |
| `motion.ts` | which visual effects may cost a GPU frame: the table, the store, and the classes `<html>` carries for the two standing switches plus the background pause |
| `tour.ts` | the guided tour's chapters and rules: when the picker is offered, what a step waits for, which panel its anchor needs open, and why a release intro is just a chapter (see docs/tour.md) |
| `revive.ts` | carrying on after the API kills a turn: which failures a retry can fix, the backoff ladder, and the three things it must never type into |
| `perf.ts` | what the interface weighs and what that is allowed to mean: the counter table and the three kinds (only an unbounded one may accuse), the drift between two readings, the greppable log line, and the scrollback knob |

**Shared**: `state.ts` (the session map, the stage pointer, every persisted preference) and `dom.ts` (`$`, `toast`, the shared scrim, `IS_MAC`/`MOD`/`chord`).

**Markup-only views**, untested by design: `usageview`, `inspectorview`, `sidebarview`, `patchview` (the diff viewer's files, hunks and index — split out of `diffview` when it grew two line layouts, and where `hunkHtml` moved from `inspectorview`, whose only caller it never was), `footerview` (the engine picker and the shortcut sheet — extracted from `footer.ts` because `footer` imports `settings`, so Settings' previews of those popovers could not have reached them otherwise).

**DOM-owning / render**, untested by design: `sidebar`, `footer`, `tray`, `inspector`, `confirm` (every yes/no question in the app), `callsheet` (the tool-call window: the dialog, its list/detail split and the two independent `innerHTML` guards that let you select text in it), `debug`, `worktree` (the new-session dialog and the worktree removal flows, the biggest single module), `settings`, `taskui`, `palui`, `projmenu`, `caffeinate`, `signoff` (the top bar's sign-off sheet: shelve the whole fleet at once, docs/sessions.md), `diffview` (the working-set review overlay: the dialog, its index rail, the scroll spy and which line layout is current), `graphview` (the paged commit-graph panel), `mirror`, `historyui`, `update`, `serversui` (the header's running-server pill, its popover and the poll behind it), `explorer` (⌘P, the project explorer), `tourui` (the veil, the card and the chapter picker), `chime` (the only file that touches Web Audio, a live browser resource, so a test would only assert against its own mock).

**Behaviour**, IPC and DOM all the way down, so untested too, and therefore the thinnest ice in the app: `panes` (the four spawners + a pane's lifecycle), `terminal` (the xterm plumbing), `taskrun` (run on stop), `actions` (the app-level verbs), `icons` (the per-project glyph store).

Four rules keep that graph honest. **There are no import cycles across the 79 modules; re-run a cycle check after any change that adds an import.**

- **Dependency direction is state ← render ← wiring.** A logic module must not import render code or `main.ts`.
- **When an extracted function needs something that lives further up**, resolve it in this order: (1) **move the callee down too** if it is itself leaf-shaped, which is why `icons.ts` sits below `sidebar.ts` and `usage.ts` below `phase.ts`; (2) **a settable hook defaulting to a no-op** (`setRlLogger`, `setPanesRenderAll`) when the callee genuinely belongs to the render layer; (3) **an extra parameter** only as a last resort, since it changes a signature the move was supposed to leave alone. A control panel touching many things it doesn't own may take **one host object** instead of N setters (`settings`, `palui`, `projmenu`); prefer per-callee setters below ~4.
- **A `*view.ts` takes data and returns a string**: no `$()`, no `innerHTML`, no renderer call. The `render*` function that paints the result stays with whoever owns the element, its timers and its delegated handlers. If a candidate seems to need a `setSomething`, it is a `render*` and should stay behind.
- **`state.ts`'s `setX` setters assign and nothing else.** Persistence and `renderAll()` belong to the call site, which is what `actions.ts` is for. (Conflating the two is a bug this codebase has already shipped once: a settings picker called `state.ts`'s `setWtGroup` instead of `actions.ts`'s, so the choice never persisted.) Reads are the live ESM binding and stay bare identifiers (`activeId`, never `state.activeId`).

**Every `innerHTML` surface on `renderAll`'s path is guarded**: markup is rebuilt every pass but assigned only when the string differs from the last write. On an interactive surface the guard is doing *correctness* work: an assignment destroys the node under the pointer, which can silently drop a click (a permission *Allow* was lost exactly that way). A per-second clock in the markup defeats a guard entirely, and the cache must be invalidated wherever another module writes the same element (`stageGen`). Full story (which surfaces, the measurement trap, why `textContent` surfaces need no guard) in `docs/architecture.md`; read it before adding any surface to `renderAll`.

And the things that hold however the files are arranged:

- **`Sess.kind` is product shape, not vendor**: `"agent" | "shell" | "task"`.
  Agent sessions carry a stable `provider` plus copied `capabilities`; shared surfaces
  use `isAgent`, `hasAgentCapability` and `hasSessionState`. Use `isClaude` only where
  the actual Claude protocol/launch flags matter. `Sess.external` is orthogonal and
  only available to providers advertising `external-terminal` (Claude today).
- **Provider adapters normalize; they do not fork the cockpit.** Claude hooks call
  `applyHook`/`applyStatusline`; Codex App Server methods pass through
  `providers/codex.ts` into `applyAgentEvent`. Phase, attention, inspector, files,
  approvals, context, usage, roster and history then read the same `Sess`. A provider
  with no adapter has no `session-state` capability and gets the explicit terminal-only
  card; never invent a phase for it, because a badge nothing can clear is worse than no
  badge. Add OpenCode by implementing the backend transport + provider adapter and
  declaring only the capabilities its structured interface actually supplies.
- **A pane glyph that isn't a phase lives in two tables that must move together**:
  `sidebarview.ts`'s (`❯` shell, `»` agent) and `tray.ts`'s `SHAPE` plus `icons.rs`'s
  `shape_sdf` (`chevron`, `dchevron`). The tray once spelled every kind of pane with the
  phase vocabulary and drew a live shell as an idle agent.
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
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "agent-event" | "tray-select")` at the bottom of `main.ts`. Claude telemetry routes by stable launch id; provider events carry `sessionId` + `provider` and are rejected if either does not match the pane.
- `applyHook` maps Claude lifecycle events and `applyStatusline` fills its model/context/cost/duration. `applyAgentEvent` maps normalized provider events onto the same state machine. Claude account limits remain in global `rl`; integrated-provider limits live on `Sess.rateLimits` and fan out only between panes whose non-null opaque `rateLimitScope` matches.
- **The inspector's Context card is a *set of files*, not a log of tool calls** (`files.ts`, `contextHtml`). `Sess.files` holds one entry per path with a `kind` that only ever climbs read → edited → created, because an agent re-reads what it just wrote constantly and a last-verb-wins field would demote half the edited files seconds later. It is fed from **PostToolUse**, not the Pre hook the timeline opens on: `tool_response.type` is what distinguishes a `Write` that created from one that overwrote. **Bash is deliberately not modelled** — `touch`, `>` and `sed -i` reach us as a shell string, and what they did to the tree is already answered correctly by the working-set card that reads git; the non-file tools are summarised in one line instead. The old timeline is still there under the card's `Tools` tab, one line per call, and **a row opens ./callsheet** rather than unfolding: `tool_input` and `tool_response` as ./toolio renders them, capped at capture (4000 chars a side) because a `Read` response is an entire file, and held in memory only — a tool payload must never reach `localStorage`. **A payload does not go in the rail.** 296px is ~38 characters of 10.5px mono, and every one of these is an 80–120 column artifact, so the row unfolding two `<pre>`s into it rendered a four-line patch as eleven and (with the `overflow-wrap: anywhere` that width forces) broke a diff's `+`/`−` off the lines that carry their meaning. What stays on the row is what a rail is good at — which call, how long, and the **first line of a failure's reason**, the one payload promoted out of a click because it has no other surface in the app. Two joins there are load-bearing. **Pair a call's Pre and Post hooks by `tool_use_id`, never by tool name**: the name picks the most recent open call so named, which is wrong whenever two calls of one tool overlap, and hanging an output off the wrong row is a lie the card states in full (the name match survives only as the fallback for a payload with no id). And **a failure carries no `tool_response` at all** — `PostToolUseFailure` puts the reason in a plain-string `error` — so anything reading a result has to read both fields.
- **The diff overlay is a review surface, and it is shaped like a pull request** — an
  index rail that is always on screen and file headers that **stick** to the top of the
  scroller. Both exist for one question the old single-column list could not answer
  without scrolling back up: *which file am I in*. So `.dfile` must never regain
  `overflow: hidden` (it would make each section its own scrollport and the sticky header
  would then stick to a box that never scrolls, i.e. not at all), and the rail's spy
  allows **one header's height of slack** — "the last header above the top edge" is wrong
  by one file for the whole handoff, while an arriving header is pushing the outgoing one
  out. Everything about what a hunk *means* is ./diff's, not the view's: which deletion
  became which addition is decided by **similarity, not position** (an agent's commonest
  edit is three comment lines added above one changed line, which positional pairing gets
  wrong and then offsets the rest of the run), and the word marks inside a pair are
  dropped entirely below a similarity floor, because a rewritten comment lit up in nine
  fragments says less than the row's own colour already did.
- **Code health is a signal, never a gate, and it never delays the diff.** The chips on a
  changed file (`health.rs` measures, ./health decides, ./patchview draws) land on a
  *second* pass: `project_health` reads every file in the project to build its duplicate
  index, so the overlay paints the patch first and `applyChips` inserts into the DOM that
  is already there rather than repainting it — a repaint would reset every fold, lose
  where you had scrolled to, and destroy the node under the pointer. Three rules hold
  whatever else changes. **The backend answers facts and the frontend owns thresholds**
  (`p90_code_lines` is the one project-wide number, because "big" is relative or it is
  nothing), so a `[health]` table in `.episko/episko.toml` changes behaviour without a
  rebuild — and `clampHealth` refuses a 0 at the boundary, since a threshold of 0 fires on
  every file. **`measured: false` must never render as clean**: a file the backend could
  not read carries a row of zeroes and every one of them is meaningless. And **a rule that
  fires on ordinary code is worse than no rule** — `.unwrap()` was the obvious silenced-error
  pattern and is deliberately absent, because it appears 156 times in `git.rs` alone and a
  chip on every Rust change teaches you to ignore the row that matters. Four more of that
  last kind, each found by pointing the rules at real code rather than at a fixture:
  **strip the visibility modifier before naming a function** (`pub(crate)` carries its own
  parentheses, so the name search read `pub` for the whole Rust backend, and `pub(crate)
  struct` slipped past the keyword rejection to register as a function); **blank string
  literals and skip non-source paths before matching a silenced error** (the CHANGELOG entry
  *announcing* the rule earned a red chip, and the pattern table earned six on itself);
  **only a declaration can win the length chip** (a call with a trailing block keeps the
  callee's name, so on every vitest file the longest "function" was the `describe`); and
  **nesting is measured from the enclosing function in both families**, with the indent step
  detected per file — absolute depth made one threshold mean two things, and a hard-coded
  four columns made the rule silently *never fire* on 2-space Python or YAML.
- **A finding is selected, not flashed, and it is copyable.** Clicking a chip lights every
  line it covers and stays lit until you pick another or click it again; a repeat click on
  a finding with several *places* walks to the next one. Two lists, deliberately: `Chip.lines`
  is everything to mark (a complex function marks the whole span the change added inside it)
  and `Chip.places` is what a click walks (that same function has exactly one) — conflating
  them made a chip claim "200 places". The chip row shares one sticky box with the file
  header (`.dftop`), because the control that walks between marks a hundred lines apart has
  to still be on screen when you get there. And **copy findings** puts them on the clipboard
  as text written for a session to act on: the premise of the whole feature is that you are
  reviewing work you did not type, so the fix will not be typed by you either, and a chip you
  can only look at makes you the courier. Clipboard via `tauri-plugin-clipboard-manager`,
  never `navigator.clipboard` (an OS permission prompt).
- **A turn the API killed ends in `error`.** `StopFailure` sets `Sess.apiErr`; **`endTurn` is the single place that decides done vs. error**; every surface reads `phaseText(s)`, never `PILL_TEXT[s.phase]` directly. The trap (a 60s idle nudge that relabels the failure) shipped once; see `docs/architecture.md`.
- **A turn that ended while its agents run on stays `background`.** The `Workflow` tool returns a run id in ~2s and `Stop` fires while its fleet runs for another twenty minutes, so `done` alone stopped meaning "your turn". `Sess.fanout` holds the run (named from the `PreToolUse{Workflow}` payload, with no disk and no backend) and **`Sess.agents` holds the agents still up, keyed by the `agent_id` both `Subagent*` hooks carry** — identity rather than a counter, for the same reason a tool call's Pre and Post pair by `tool_use_id`. Read it through `liveAgents`/`liveCount`, never by `.size`: an agent a *newer* fan-out inherited is stamped `orphanedAt` by `startFanout` and ages out on its own short window, because the hour that guards a live fleet only guards a ghost once the run that would report its Stop has been replaced (that is the "34 / 36" bug — see `docs/architecture.md`). `statusKey` answers `"background"` for a live fleet, and `needsYou` says no. **Never add a status to `GLYPH`/`GCLASS` without also adding it to `tray.ts`'s `SHAPE`**; see `docs/architecture.md`.
- **A `localStorage` write on the telemetry path is a disk write**: statusLines land every ~10s per session. Three cadences, chosen deliberately: eager (`cc-usage`, small and unreconstructable), only-when-changed (`cc-cost-base`), floored and flushed on quit/midnight (`cc-usage-detail` 30s, `cc-io` 60s). Cap anything keyed by day. Sizes and reasoning: `docs/architecture.md`.
- **An infinite animation and a `backdrop-filter` are a per-frame GPU cost, not a
  one-off.** Each pins the WebView2 compositor to the monitor's refresh rate for as long
  as it exists — 144Hz on a Windows desktop against the 60 this was designed at, which is
  why the complaint arrived from Windows and not from the Mac. Two rules follow. **A
  dialog that stays mounted at `opacity: 0` must not keep its blur**: seventeen do (that
  is what lets them fade), and each was a live render surface for a panel nobody can see,
  so the blur is gated on `:not(.show)`. And **the switches are ./motion's table and
  nothing else** — `fx-still` (cancel), `fx-flat` (no blur) and `fx-idle` (paused while
  the window is in the background, applied by main.ts's `onFocusChanged`), all put on
  `<html>` by ./actions' `applyFx`. `fx-still` is a deliberate *superset* of the OS's own
  `prefers-reduced-motion: reduce` — it flattens every transition where reduce names
  eight and tames a ninth — but the two must agree on the four **substitutes**, the
  places where an animation carries a state rather than decorating one and ending it
  would delete information; `test/motion.test.ts` fails if those lists drift apart.
  The cancel and the pause are separate on purpose — a paused animation resumes
  mid-cycle, where a cancelled one would restart every session's glyph in lockstep.
- **Persistence is all `localStorage`**, every key prefixed `cc-`; `grep '"cc-'` for the current set.
  **Every read of one narrows rather than trusts.** `state.ts` reads its preferences at
  module scope in the module everything else imports, so a `JSON.parse` that throws there
  is a blank window before any UI exists to say why — and a stored value is not safe just
  because we wrote it (a crash mid-write truncates, and these are the keys people hand-edit).
  A parseable value of the wrong shape is the sharper half: `"null"` and `"[]"` survive the
  parse and only fail at the first property access, somewhere else entirely. Use `strMap` /
  `strList` / `favList` / a `clamp*`, never a bare `JSON.parse`, and discard a bad value on
  its own rather than letting it take the session (`test/state.test.ts`).
- **Debug console** (🐞, bottom-right): in-app event log + live state via `dlog()`/`dbgSnapshot()`; flags unrouted telemetry and JS errors; mirrors a snapshot to `$TMPDIR/cc-launcher/episko-debug.json` for external tools. The snapshot is state-of-now and does not survive a crash. The durable timeline is the rolling `episko.log` (+ `panic.log`) in the OS app-log dir, which every `dlog()` tees into via `log_frontend` (`docs/architecture.md`).
- **A leak that takes fifteen hours cannot be diagnosed from a snapshot.** `dbgSnapshot`
  is state-of-now, so the *growth* half is **Settings › Diagnostics** (./perf decides,
  ./debug samples): one reading every few minutes, teed into the rolling `episko.log` via
  `log_frontend` — **never `dlog`**, which would push real events out of the 400-entry
  ring the panel exists to show. Three rules. It **ships off** and the tab says why, since
  the recorder has to be armed before the day it is needed. A counter's `kind` decides
  what it may accuse: only an unbounded `growth` one, never a `level` (scrollback lines
  saturate at their ceiling by design) or a `rate` (a total that counts is not a leak) —
  the health.ts rule, one level down. And **no verdict under half an hour or across a
  reload**: a busy turn makes any counter look alarming, and the reload that fixes this
  bug resets every one of them to zero, which reads as a cure. The tab's other three rows
  are the inspector (the `devtools` Cargo feature ships it in release builds), the
  scrollback limit, and the reload itself — a button because it *looks* like it kills
  your fleet and does not.

## App-wide rules

- **Episko writes almost nothing outside its own storage.** In a user's repo: only `.episko/{tasks.toml,episko.toml,notes.toml,digest.md}`, always through `toml_edit`/read-modify-write so hand-written formatting survives, and always asking before creating a new committable file. The single write inside `~/.claude` is *Move session*'s transcript move. Everything else is `localStorage` and the app dirs.
- **The app has three lists of files, and they must describe a path the same way.** The
  working set (git, `wpeekHtml` → the peek), the Context card (the hook stream, `files.ts`)
  and the explorer (`explore.ts`, the project index). The explorer is the superset: its
  scope chips are *filters* over the other two rather than a fourth idea, it reuses their
  marks and colours, and a row's ↵ hands a changed file to the peek rather than growing a
  viewer of its own. Adding a fourth place that lists files means adding it to that join,
  not beside it (docs/explorer.md).
- **The stage has one owner**: `activeId` and the `mirror` pointer (`{kind:"ext"|"past"|"dash"}`) are mutually exclusive, and `takeStage(show)` in `dom.ts` is the only code that may touch `#extPane`/`#dashPane`/`#empty`/`insp-mini`. Add a stage kind by extending `Stage`, never by poking `hidden` at a call site.
- **Three orthogonal facts decide a launch**: `defaultAgent` (**what** runs — Claude Code by default, overridable per project via `agentByProject`; resolved by `pickAgent` in ./types), `termEngine` (**where** its terminal lives), and the selected provider's entry in `permissionModes` (**how** it starts). Provider adapters own the choices; backend whitelists own their CLI mapping. `launch()` forks on the provider before it builds anything; a resume carries its original provider, while new sessions and dashboard issue dispatch follow the project preference (`docs/sessions.md`).
- **A background shell's log is addressed by the transcript path it had AT START, under
  a root we have to go and find.** An agent's `Bash{run_in_background:true}` is how every
  dev server in this app gets started, and Episko sees it for free:
  `tool_response.backgroundTaskId` on a PostToolUse it already receives, with the output
  at `<root>/<slug>/<uuid>/tasks/<id>.output`. Only the `<slug>/<uuid>` half genuinely
  mirrors `transcript_path`. **The root is not ours and cannot be derived** — it is
  `${CLAUDE_CODE_TMPDIR ?? "/tmp"}/claude-<uid>`, and the `env::temp_dir()/claude` we
  used to build has never once existed on a Mac (macOS ignores `TMPDIR` here — measured,
  not inferred), so every row sat at "starting…" for the life of the feature with `tsc`,
  vitest and cargo all green. So `bg_log_roots` probes a **ranked candidate
  list** (both directory shapes on every OS; only the order differs per OS, and no
  platform's row is asserted as the only possible answer), the winner is remembered in
  `AppState.bg_root` and invalidated rather than defended, and anything resolving below
  the first candidate raises `bglog-health` the way a re-bound telemetry port does — the
  feature still works and the app says so anyway, which buys one release of warning
  before the fallback stops matching too. But Claude mints a **new** session dir on
  `/clear`, `/compact` and `/resume`, so re-deriving the `<slug>/<uuid>` half later
  points at a directory that has never held the log. `BgServer.transcript` is captured
  when the shell is recorded and never recomputed (./servers, ./types); widening the
  ROOT must never re-derive it. Same trap as the `X-CC-Session` rule above, one level
  down.
- **Stopping a server is asked of the agent, never done behind its back.** The process
  is a descendant of Episko's own tree and could be killed — but the agent holds
  `TaskStop`, believes the server is up, and goes on saying so after a kill it never
  saw. So ./serversui prefills `TaskStop <id>` into the session and the human presses
  Enter: the `handToTerminal`/`sendOutputToSession` contract. A server whose session is
  gone is an **orphan**: `session_ports` cannot see it either, because attribution is by
  ancestry and its chain is broken, so it belongs to no pane and there is nobody to ask.
  Listing orphans would need a *project*-level answer (match the process's cwd or command
  line against known roots), which is a separate feature and not this one.
- **The kernel is the authority; a parsed log line is a guess.** `session_ports`
  (external.rs) walks every listening TCP socket back up the ppid chain to a pane's PTY
  child — measured **eight** hops from a `vite` leaf to `episko.exe`, well inside
  `is_descendant_of`'s cap — and that is the only signal that can see a server nobody
  announced: one typed by hand into a shell pane, or one whose banner nothing parses.
  `reconcilePorts` joins the two in a three-step ladder (a port a record already names
  is that record's → **one** silent record *that could be a server* and **one** loose
  port are each other → the rest get rows of their own), failing closed the moment
  either side is ambiguous.
  **`usefulPort` runs first and matters**: one real `wrangler dev` holds five listening
  sockets, of which four are Node's inspector and kernel-assigned control channels, so
  an unfiltered scan puts four pieces of noise in front of one useful row. And
  **`reconcilePorts` mutates**, so it belongs to the poll and never to a render pass.
- **The header lists three sources on different rules, because it is for what is
  otherwise invisible.** An agent's background shell has no pane, no row, nothing on screen, so
  **every** one is listed, but only one with an address is called a *server*: `bgKind`
  splits the popover into **Running servers** and **Background jobs**, and only the first
  heading counts toward the pill. An Episko **task** (`just dev`, a VS Code task,
  an npm script) already has a pane, a sidebar row, a glyph and a phase, so it appears
  **only once it has announced a URL** — the one thing its pane cannot give you. Same
  reason a failed *task* never appears here and a failed *shell* does: the sidebar has
  already gone red about the first. A bare **port** is listed when nothing else explains
  it, which is the only way a server started by hand in a shell pane has ever been
  visible. Stopping differs with the source and honestly so: Episko owns a task's PTY, so
  ✕ there is a real `closeSession` (what the pane's own ✕ does), an agent's shell is only
  ever asked, and a port row has **no ✕ at all** — we know which pid holds the socket, but
  it sits several hops below a pane that has its own ✕, and the row exists to tell you the
  port is open rather than to take responsibility for it. Its empty cell is kept so ◨
  stays in line down the list.
- **Claude Code backgrounds things nobody chose to background.** Any Bash command still
  running at its **120s timeout** is auto-backgrounded with `run_in_background` UNSET —
  12 of 143 real payloads, and they are `npm ci`, `pytest`, `vue-tsc`, `gh run watch`
  polls and `until …; do sleep …; done` waits, which is how a one-shot `python3 -c` once
  reached the header calling itself a running server. `tool_response.timedOutAfterMs` is
  how we know, `isJob` is the only thing that reads it, and what it decides is narrow:
  such a record may **never silently adopt a loose kernel port**, because nothing about
  it says it opened one. It does **not** decide the heading — that is `bgKind`, and it
  splits on *evidence* (an address, announced or adopted) rather than on the command
  string, for the same reason ./health has no `.unwrap()` rule: a rule that fires on
  ordinary commands teaches you to ignore the row that matters.
- **A task's server URL is latched as its output streams, never rescanned from `tail`.**
  `run.tail` is a rolling 40 lines, so a dev server's banner is gone from it seconds
  after the first HMR line — a URL read back off the tail would appear and then silently
  vanish. `taskServerUrl` folds it per line in main.ts's `pty-output` handler, and is
  **stricter than `serverUrl`**: it latches only on an announcement line, because its
  answer sticks and a stray `curl http://localhost:9999` in the output would otherwise
  put a wrong address on the row permanently.
- **A server that died on its own keeps its row; one that was asked to stop does not.**
  A dev server exiting on `EADDRINUSE` two seconds in is the commonest way this goes
  wrong, and dropping the count 1 → 0 would be the exact silence the feature exists to
  end — so a **non-zero** exit persists (red pill) until dismissed, the rule task panes
  already follow. `exit === 0` (a background one-shot finishing) and `exit === null` (a
  kill somebody requested) are not news and leave. `liveServers` is what the poll
  re-reads, `shownServers` what the popover draws; keep those two questions apart, or a
  dead log is re-read every four seconds forever. **Two further endings carry no exit
  code at all**, and that is the point: a record whose root was found and whose log never
  appeared **retires** ten minutes after the log went MISSING (`endReason: "stale"`;
  measured from `missSince` rather than from `startedAt`, or a log read all afternoon and
  then deleted would be given up on four seconds later as *log never appeared*), and a
  pane's own `pty-exit` **ends** every live record it started
  (`"session"`) rather than clearing the array, which would delete the crashed-server
  rows this whole rule exists to keep. Both are `exit: null`, so `failedServers` never
  sees them and the pill never goes red for something that did not fail — and `endReason`
  is what stops "nobody could find it", "somebody asked for this" and "it exited" from
  collapsing into one word. Retirement fires on `reason === "notYet"` alone: `noRoot` and
  `ambiguous` are an outage in our own probe, and a probe outage that quietly retires the
  fleet is a worse silence than the one being fixed.
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
- **Episko presses Enter for you in exactly one place**, and it must stay one: `tickRevive` in `actions.ts`, bringing back a session whose turn the API killed. Everything else that puts text in a terminal — `sendOutputToSession`, the dashboard's dispatch, `handToTerminal` — prefills and stops, because a human is there to read it before committing. The revive path exists precisely because nobody is. Every rule about when it may do that lives in `revive.ts` and is tested (`docs/sessions.md`); the driver decides nothing, and a new "should we retry this?" test at a call site would be the same half-off switch the sound rule above warns about.

## Deep dives (`docs/`)

The full design notes (the shipped-bug histories and every invariant's reasoning) live in `docs/`, split out of this file. **Read the matching doc before working on an area.** The one-liners here are only each doc's sharpest rule.

- **`docs/testing.md`**: the gates in full, the cfg-flip trick and its limits, coverage caveats, the fixture-path trap.
- **`docs/tasks.md`**: runnables (`tasks.rs`, `▶ Run`, ⌘⇧B, run groups, run-on-stop, overrides). Discovery never executes the project; `dependsOn` is memoised (one chord once launched 27 panes for 11 tasks); a login shell does **not** give a task the user's PATH; Windows `CreateProcessW` cannot run a script; what can't run says so rather than disappearing.
- **`docs/releases.md`**: `CHANGELOG.md` has three consumers that must never disagree; the gate is on the PR rather than the tag; don't reintroduce the fresh-install guard.
- **`docs/dashboard.md`**: the project dashboard and its GitHub half. Three tiers (GitHub / git / neither); per-project cost comes from `cc-usage-detail`, never `cc-usage`; a claim is only ever a hint; a day's two generated sentences must never be mixed, and only the project half is committable (`.episko/digest.md`).
- **`docs/commit-graph.md`**: never read a whole history (one page at a time, `--date-order`); a tag never names a lane; `gc-*` is the chip prefix, `gco-*` the overlay's.
- **`docs/architecture.md`**: the deep halves of the backend/frontend sections above: disk-I/O accounting, the `innerHTML` guards, the needs-you set's two stamps, the WebGL pool, keystrokes/clipboard, `StopFailure`, storage cadences, the two logging tiers.
- **`docs/worktrees.md`**: project groups, the peek rows, the worktree roster and polls (`worktree_heads` is spawn-free and pollable; `list_worktrees` is neither), removal (a failed `git worktree remove` does **not** mean nothing happened), and drift (`Drift.via` decides the repair: follow in place vs. kill-wait-move-relaunch).
- **`docs/sessions.md`**: launch engines, permission modes (a whitelist rather than a passthrough), external sessions (filter owned ones by pid rather than by session id), restore (use `resumeId` rather than `id`; `costDelta` baselines, since anything that diffs a cumulative telemetry figure against a `Sess` field repeats a shipped bug), History, shelving (a shelved session becomes the same restorable row a quit writes — never a second kind of row — and the dormant entry must go on the list *before* `closeSession` flushes the roster), and the revive watchdog (never type at a session that is asking you something; the attempt counter must survive the turns it starts, or the ladder flattens into a hammer).
- **`docs/providers.md`**: the provider contract, shared capability matrix, adapter/backend boundaries, feature checklist and the definition of done for adding first-class agents.
- **`docs/native-ui.md`**: the title bar (the window is built in `setup()` rather than by config; drag-region gotchas), the tray menu (icons exist because menu text is always menu-coloured; project headers must be disabled items), and the OS dialogs Episko stopped drawing (`confirm.ts` — a native box cannot mark its destructive button; the file picker is the one that stays).
- **`docs/tour.md`**: the guided tour. It opens on the *absence* of `cc-tour` and never after an update; a release intro is a chapter with a `since`, not a second mechanism; the veil is `pointer-events:none` so the lit control is the live one, and it must never join `SCRIM_DLGS`; a missing anchor skips a step **unless the step is waiting**, because a waiting step's anchor is usually what it is waiting for. **Write a step against the app, never against a mock, and walk it before you believe it** — every bug this feature has had was a card pointing confidently at something that was not there.
- **`docs/explorer.md`**: the project explorer (⌘P). One index feeds both modes; the marks come from the other two file lists; `git ls-files` is why there is no ignore parser; nothing watches the filesystem, and this is not the feature that changes that.
- **`docs/sounds.md`**: sound alerts. The hard part is playing one sound instead of six: the same moment reaches the frontend twice *by design*, so every play is gated, except that a more urgent event still gets through the burst window, which is the point. Anything that fires on routine activity ships switched off.

## Notes on scope & doc drift

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines. Terminal-window focus is **no longer** one of them, since `focus_external_session` has a win32 half (see docs/sessions.md), though only macOS can address an individual tab. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic. Resource reporting is **no longer** one of the macOS-bound bits: `all_sessions_resources` reports disk I/O through `sysinfo` (one refresh, every OS) rather than shelling out to `ps`, so `ps_one` is now reached only from the macOS-only terminal-focus path.

**`SPIKE.md` is a historical record and is not maintained.** It describes the Phase-0 spike (single-session, "observe-only" permissions, one file per side) and is kept as the record of where this started rather than as a description of today. It carries a banner saying so. Don't consult it for how the app works today, and don't edit it to match; `README.md` is current.

**Trust the code over the docs** when they disagree, and fix the doc in the same commit.
