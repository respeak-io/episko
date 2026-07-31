# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Episko is a Tauri v2 desktop app (Rust backend + vanilla-TS frontend) that launches and manages many Claude Code sessions at once — each in its own PTY — and streams live status/cost/context telemetry back into the app. macOS-first; still an early spike.

## Commands

```sh
pnpm install            # first time
pnpm tauri dev      # run the app (Tauri + Vite dev server on fixed port 1420)
pnpm tauri build    # production bundle
pnpm build          # tsc typecheck + vite build (frontend only; the beforeBuildCommand)
pnpm exec tsc --noEmit       # typecheck only (tsconfig is noEmit)
pnpm test               # vitest — frontend unit tests (test/*.test.ts)
pnpm coverage           # the same suites with v8 coverage
```

Coverage is a **yardstick, not a target** — there is deliberately no gate, because the
render and DOM-owning modules are untested by design. Current: **85.8%** statements
over the modules the suites load, **17.4%** over all of `src/`, and **72.3%** Rust
lines (`cargo llvm-cov --summary-only` from `src-tauri/`). Both gaps are the OS edge,
which `RELEASE.md` covers by hand. Note vitest's `text` reporter **hides any file at
100% in all four columns**, so a fully-covered module looks absent; use
`--coverage.reporter=json-summary` for per-file truth.

Rust backend (run from `src-tauri/`): `cargo check`, `cargo test`, `cargo build`, `cargo clippy --all-targets`. **Clippy is a CI gate** (`-- -D warnings`, both OSes) — keep it clean, and if a lint wants a real change rather than a tidy-up, `#[allow]` it with a comment saying why.

**Install the gate before you rely on it: `rustup component add clippy`.** It is not
in a default toolchain, and a gate you cannot run is one you will only meet in CI.
This is not hypothetical — clippy, `cargo test` and the vitest suite each went red on
the very branch that made CI enforce them, all three for the same reason: the check
was never run locally, so the branch asserted green it had not earned. Run the gates
in the block above before pushing, and match the toolchain CI uses (`stable` for Rust,
`.nvmrc` for Node) so a pass locally means a pass there.

**Two verification tricks the platform split makes necessary.** `cargo check` and clippy only compile the arms for *their own* target, so half this code is invisible on any one machine:

- **The cfg flip.** Swap every `cfg(windows)` ↔ `cfg(not(windows))` in `src-tauri/src`, re-run `cargo clippy --all-targets`, then `git checkout -- src-tauri/src` to swap back. This type-checks and lints the other half, and has caught a dead import that was invisible locally and a warning in CI. Two cautions: it does **not** touch `cfg(target_os = …)` or `cfg(unix)`, so `reveal_path`'s unused `exists` is a known false positive; and **commit or stash your real changes first** — the `git checkout` that reverts the flip reverts everything else in that directory too.
- **The macOS-only arms cannot be linted on Windows at all.** Flipping `target_os` as well fails hard: `rusqlite` is a macOS-only dependency, so the code behind those arms doesn't have its crate. CI's macOS leg is the only check for that code. The same limit applies to the flip in the other direction: run it on macOS and the now-enabled `cfg(windows)` arms want `std::os::windows` and `windows_sys`, which that target doesn't have, so a handful of `E0433`s are the trick reaching its edge rather than a finding.

**A fixture path is not the path the code under test will see.** `env::temp_dir()`
returns whatever the environment says, and on both CI runners that is a spelling the OS
itself does not use: macOS `$TMPDIR` is `/var/folders/…`, a symlink to
`/private/var/folders/…`, and the Windows runner's is the 8.3 short name
`C:\Users\RUNNER~1\…`. Anything that resolves a path — `git`, which does it before it
answers, or `physical_cwd`, which exists to match it — then returns the *other* spelling
and the assertion fails on a difference that has nothing to do with the behaviour under
test. **`scratch_dir` resolves before it returns** so fixtures compare like with like;
build a temp path some other way and this is waiting. It is not a CI-only trap — a dev
Mac has the same symlink — but it is one both legs will find at once.

**Package manager: `pnpm`** for this repo (there's a `pnpm-lock.yaml`; both CI workflows use `pnpm install --frozen-lockfile`, and `packageManager` in `package.json` pins the version for corepack/CI). Use pnpm here, not npm. Windows code-signing / release-signing setup lives in `src-tauri/SIGNING.md`.

Test coverage is **unit-only — there is no end-to-end harness**, but it is no longer thin: **431 vitest + cargo (91 on macOS, 88 on Windows — the platform tests are `cfg`-gated)**, both run in CI on both OSes.

**vitest runs in the `node` environment, so no module a test can reach may touch a browser global at module scope.** Not just `document`/`window`: `globalThis.navigator` only exists from **Node 21**, so a bare `navigator.userAgent` at module scope killed every suite that transitively imported that file back when CI pinned Node 20 — while passing on a dev machine with a newer Node. Node is now pinned once in **`.nvmrc`** (26) and read from there by both workflows and `nvm use`, so CI and local cannot drift again; the guard stays regardless, because the rule is about the `node` environment, not about which Node. Platform predicates therefore live in `dom.ts` (`IS_MAC`, `IS_WIN`), read once through a `typeof navigator === "undefined"` guard; import those rather than reading `navigator` again. `vitest` covers the pure frontend logic modules (`test/*.test.ts`, one file per module — see the frontend module map below for which nine those are); the Rust tests are `#[cfg(test)] mod tests` **in-file**, next to their subject, several of them real integration tests that drive `git` against temp repos or the real `tiny_http` telemetry server against a mock app. There is deliberately no `src-tauri/tests/` directory: it would only see the crate's public API, which here is `run()`.

What is **untested by design**: the render, view and DOM-owning modules on both sides of the app — snapshotting template literals mostly re-asserts itself. Anything touching the DOM, PTYs, or live telemetry is still verified by **running the app and exercising it** — the statusLine half of telemetry only fires in interactive mode, so it cannot be checked end to end with `claude -p`. Split that one carefully, because the split is not where it looks: whether the generated statusLine command *works* is checked headlessly and in CI (the shell runs it for real — see the constraint above). What needs a live REPL is only whether **Claude still picks the shell and payload we expect**. That costs a TTY, not tokens: a session you launch and never prompt makes no API call, and the statusLine fires on start and every `refreshInterval` seconds regardless. It's a `RELEASE.md` click-through, and a cheap one. `tsc` (strict) is the real linter. Requires `claude` on PATH, the Node in `.nvmrc` (`nvm use`; `engines` floors it at 24), and Rust stable + Tauri system deps.

CLI *mechanics*, though, often can be checked headlessly — drive `claude -p` against a **throwaway** session in a temp dir and inspect the resulting `.jsonl` (never a real session: resuming appends to it). That is what the one `#[ignore]`d test does (`claude_cli_still_honours_our_instrumentation` in `telemetry.rs`): it runs the real binary and asserts Claude Code's hook schema and transcript layout still match what this app reads. It is **not** in CI — it needs auth and spends tokens — and is run via `cargo test -- --ignored` as part of `RELEASE.md`'s checklist.

**`RELEASE.md` holds the manual release procedure** — what CI already guarantees, the click-through for the OS edge, and the tag/verify steps. Anything that can only be checked by running the app belongs there, not here.

## The core mechanism: per-launch instrumentation

This is the one idea that makes the whole app work; everything else hangs off it.

On every launch, the Rust backend (`write_instrument_settings`) generates a throwaway `--settings` file at `$TMPDIR/cc-launcher/instrument-<uuid>.json` containing a `statusLine` command and `hooks` for the full session lifecycle. Each hook/statusLine is a shell command that POSTs its JSON payload to a **localhost `tiny_http` server the app bound to an ephemeral port at startup**. Claude is then spawned as `claude --session-id <uuid> --settings <file>`, so:

- Every event carries the `session_id` we chose, letting the frontend route it to the right pane **before any output appears**.
- No global `~/.claude` mutation and no transcript-file parsing — instrumentation is entirely per-launch and disappears with the temp file.

**Route by the stable launch id, never Claude's runtime `session_id`.** Claude mints a *new* `session_id` on `/clear`, `/compact` and `/resume`, so the payload's `session_id` drifts away from the uuid we launched with — after which telemetry would route to nothing (inspector freezes) and the `SessionEnd` fired at the rotation would leave the pane showing the "ended" `·` glyph while the process runs on. So every hook/statusLine POST is tagged with our stable uuid via an **`X-CC-Session` header** (and the blocking permission hook via **`?sid=`**, since it's `type:"http"` with no shell to add a header). `run_telemetry_server` reads that and *forces* it onto the payload's `session_id` before emitting. As a backstop, the frontend un-ends any session that keeps receiving statusLines (a statusLine only fires from a live REPL).

Three hard constraints shape this code:

- **Claude runs hooks/statusLine with a stripped PATH.** Generated commands use absolute `/usr/bin/curl` and `/bin/cat`, never bare `curl`. Likewise `resolve_claude()` probes known install locations (and falls back to the login shell) and `augmented_path()` rebuilds a usable PATH, because a GUI app launched from Finder also gets a stripped PATH.
- **On Windows the two halves run in different shells, and only the hooks can be told which.** `shell` is a *hook* field; Claude Code has no statusLine counterpart and routes that command through **Git Bash whenever Git Bash is installed** (else PowerShell). So the hooks are pinned to `powershell` and written in it, while the statusLine command must parse in *either* shell: no `&` call operator, no `$null`, no `Write-Output`, and forward slashes, which Git Bash won't eat as escapes. Get this wrong and there is no error and no lost hook — just every figure the statusLine carries (model, context %, cost, duration, **and the account-wide rate limits**) gone at once, while the hooks keep phases flowing and the pane looks healthy. That shipped once. Asserting the generated JSON cannot catch it: such a test agrees with our intent, and the intent was the bug. `statusline_command_posts_from_every_shell_claude_might_pick` executes the generated string through every shell Claude might pick instead — no Claude, no tokens, it's just curl.
- **`PermissionRequest` is a *blocking* `type:"http"` hook**, unlike the other events (`"async": true`, fire-and-forget). The telemetry server holds that request open in `AppState.pending`, emits a `permission` event to the UI, and only responds when `resolve_permission` is called with allow/deny/terminal. Do not make it async or respond early, or Claude will hang or lose the decision.

## Runnables — tasks & scripts (`src-tauri/src/tasks.rs`, `▶ Run`)

Episko runs the task definitions a project already ships. A **`Runnable`** is one
such definition. Providers: `.episko/tasks.toml` (Episko's own committable
format), `.vscode/tasks.json`, `.vscode/launch.json`, `package.json` scripts,
`justfile`, `Taskfile.yml`, `mise.toml`, `Makefile`, `Cargo.toml`.
Discovery is in `tasks.rs`; execution reuses the existing PTY path, because **a
task run is just another `Sess`** — see the `kind` discriminant below. That's what
buys tasks the phase state machine, sidebar glyphs, attention badge, tray and
⌘1–9 for free: a run's **exit code is its phase** (0 → `done`, non-zero →
`error`), delivered over the same `pty-exit` event as everything else.

Three rules constrain `tasks.rs`:

- **Discovery never executes the project.** Most providers only parse. The
  introspecting ones *evaluate* what they read — `just --dump` runs backtick
  variables and imports at parse time — so they sit behind a **trust gate**:
  `discover(root, trusted)`, where the frontend grants `trusted` only if the
  global introspect toggle is on, the `just` provider is enabled, *and* the
  folder is one the user chose (a `cc-favorites` project, or a one-time confirm
  stored in `cc-trusted`). `just`, `task` and `mise` all go through the shared
  `Introspector` shape; untrusted, each yields a single blocked row, so its tasks
  read as withheld rather than missing. Makefiles and Cargo are parsed/inferred
  statically for exactly this reason — `make -qp` would expand `$(shell …)`.
- **Ids are stable and namespaced** (`npm:test`, `vscode:build`, `just:deploy`).
  Pins (`cc-task-pins`) and palette frecency key off them, so they must survive a
  rescan; `dedupe_ids` guarantees uniqueness.
- **What can't run says so.** `blocked: Some(reason)` renders greyed in the
  picker instead of being dropped — a missing row reads as "Episko didn't find my
  task". VS Code tasks are blocked when they need an editor (`${file}`,
  `${lineNumber}`) or have an unsupported `type`. Supported variables:
  `workspaceFolder`, `workspaceFolderBasename`, `cwd`, `userHome`,
  `pathSeparator`, `env:X`. `${input:X}` is deliberately **left intact** by
  discovery — only the frontend knows the answer, so it prompts (`openInputPrompt`)
  and substitutes via `applyInputs` just before launch. just recipe parameters
  without defaults become the same kind of prompt.

`dependsOn` is resolved **in the frontend** (`launchWithDeps`), because only the
side that owns the panes can wait on an exit code. Dependencies are named by
*label*, run in parallel unless `dependsOrder: "sequence"` (VS Code's default,
surprising as it is), and a failed dependency stops the chain. `waitForExit`
resolves from the `pty-exit` listener *before* its early return, and
`closeSession` resolves it with `-1`, so a chain can never deadlock on a pane
that went away.

`launch.json` configs are offered as **run without debugging** (VS Code's ⌃F5).
Episko has no debug adapter, so `request: "attach"` and compound configs are
blocked rather than silently started as plain processes.

`spawn_task` is the third PTY entry point after `spawn_claude` / `spawn_shell`.
It takes a `TaskSpec { exec, cwd, env }` — a resolved subset of a `Runnable` — and
is deliberately **un-instrumented**: no `--settings` file, no telemetry, no cost,
and its pid never enters `owned_pids`. `Exec::Shell` runs through a *login* shell
so tasks inherit the same PATH and version-manager shims the user's own terminal
has (a task that works in iTerm and fails in Episko is the bug class this avoids).
The `Exec` wire format is pinned by a round-trip test — the frontend hands a
discovered `exec` straight back to `spawn_task`, so a rename there breaks every
launch silently.

Surfaces: the `▶ Run` header button (picker: pinned, then a frecency-ranked
**recent** group in the unfiltered view, then grouped by source), a **Tasks** group
in ⌘K, and a task inspector offering re-run / pin / stop / *send output to a
session*. Successful non-background runs auto-dismiss after 20s unless focused;
failures persist and raise attention.

Discovery is **memoised in Rust** (`discover_cached`), keyed by `(root, trusted)`
and invalidated by a *stamp* — the `(mtime, len)` of every file a provider reads,
where a missing file is itself part of the stamp so creating or deleting one
invalidates too. Not a file watcher: no thread, no crate and no per-project
lifecycle to answer what ~20 `metadata()` calls answer instantly. **A new provider
file must be added to `source_files()`**, or its tasks go stale behind the cache.
Known gap: files an introspector pulls in itself (`just` `import`, Taskfile
`includes:`) aren't stamped.

## Run on stop — the agent/task loop

The part a plain terminal can't do, and the reason tasks live inside Episko: the
`Stop` hook already arrives here, so a project can say *"when an agent finishes a
turn in this folder, run this"* and every turn becomes a verified turn. One rule
per project (`cc-task-onstop`, keyed by project root like pins), set with `⟲` in
the project tasks panel, reviewed and revoked in Settings › Tasks.

- **Unattended means unattended.** `stopRuleBlocked` refuses a background task (it
  never finishes a turn, so it could only pile up one dev server per turn), one
  with `${input:…}` (it would block on a dialog nobody opened), and a blocked one.
- **The run must not take the stage.** `launchTask` takes `focus: false` for this
  path only — the pane appears in the sidebar but the session you were reading
  stays on screen. Consequence: an unfocused pane can't be measured, so it starts
  at xterm's default 24×80 and gets a real size when you first activate it.
- **Never two at once, never twice per turn.** A run of the rule still in flight
  wins, and `STOP_RUN_FLOOR` swallows a double-fired `Stop`. The floor timestamp
  *and* a per-project in-flight marker are both claimed *before* the first `await`
  (discovery is async); the marker is what covers a rule with `dependsOn`, whose
  pane doesn't exist until its whole dependency chain has run — so the pane scan
  alone can't see the chain starting.
- **Discovery runs in the session's `workdir`**, so with several worktrees of one
  repo open the run verifies the checkout that agent just edited.
- **A failure goes back to the session that caused it.** `run.forSession` records
  which session's turn was being checked, and the inspector's *↩ Send output to…*
  offers it back to that session alone — if it has ended or lives in an external
  terminal (no PTY to type into), the handoff is withheld rather than misdirected to
  whichever agent in this project sorts first. A hand-run task (no `forSession`)
  still offers the first live agent. The handoff types without a trailing newline —
  Episko prefills, the human presses Enter.

## Task settings (Settings ⌘, → **Tasks** tab)

The settings window is `SET_TABS` + `renderSetControl` — declarative controls, not
hand-written markup per page. Tasks added two control kinds the existing `seg`
couldn't express: **`toggle`** (a single switch) and **`multi`** (independently
toggled values, for "which providers to scan" and the revocable trust list). New
task settings belong in that tab as control descriptors; `applySetting` dispatches
them.

Task preferences live in `cc-task-prefs`, pins in `cc-task-pins`, hidden tasks in
`cc-task-hidden`, run-on-stop rules in `cc-task-onstop`, trust in `cc-trusted`. The split is deliberate and worth
preserving: **personal preference → `localStorage`; project fact →
`.episko/tasks.toml`**, which is committable and works for a colleague who never
opens Episko.

## Project tasks panel (`openTaskManager`)

Pin / hide / create / edit / delete / **override**, reached from ⌘K.
**`.episko/tasks.toml` is the only file Episko writes** (in a user's repo — the one
other place it writes is `~/.claude`, and only when you press *Move session*; see Drift) — a discovered VS Code task
or justfile belongs to another tool, so editing one writes an `[override."<id>"]`
into `tasks.toml` keyed by its discovered id, **never** a mutation of
`.vscode/tasks.json`. Writes go through `toml_edit`, not a serialize-the-whole-struct
round trip, so a hand-written file keeps its comments, ordering and spacing — there's
a test for exactly that. Creating the file for the first time asks, because a new
committable file in someone's repo is a real side effect.

## Overrides, and the rest of P4

Overrides (`[override.*]`) close the "Episko never rewrites a file it didn't create"
loop: `apply_overrides` patches discovered rows *after* dedupe (so it keys off final
ids), and an override whose target vanished becomes a **blocked row** (`override:<id>`)
rather than a silent no-op — a typo'd id reads as broken, not missing, exactly like
the rest of the module. `save_task_override` writes `background` unconditionally
(unlike a `[[task]]`, whose absent key means `false`) because an override's job
includes turning a discovered background flag *off*. Overriding `run` re-derives its
`${input:…}` prompts (`redetect_inputs`). Reverting removes the key and, if it was the
last, the whole `[override]` table. The panel learns which ids are overridden from
`list_task_overrides` (reads the file, not the cache, so a just-saved override shows).

Four smaller P4 affordances, all in the frontend:

- **Package-runner override** (`cc-task-runner`, per project). Detection stays in
  Rust; the override is applied *after* discovery by swapping an npm task's
  `exec.program` (`applyRunner`), so the discovery cache never has to know about it.
  Surfaced as a strip atop the panel, shown only when the project has npm scripts.
- **Remembered `${input:…}` values** (`cc-task-inputs`, keyed project + task + input).
  Pre-fills the prompt with what you typed last; **never a password** (`i.password`).
- **↗ Reveal source** — `reveal_path` selects the source file in the OS file manager,
  guarding against a `..` escape and falling back to the folder if the file is gone.
  `run.root` (the discovery dir) is stored on the pane so it resolves the relative
  `sourceFile` even for a task whose run cwd is a subfolder.
- **⟳ Rescan** — `rescan_runnables` drops the project's cache entries; the panel
  button and the picker's ⌘⇧R both route through it. The escape hatch for the one
  thing the stamp can't see: a file an introspector imports itself.

## Backend (`src-tauri/src/`) — ten modules

`main.rs` only calls `episko_lib::run()`. `lib.rs` is **bootstrap, not the backend**: 450 lines out of ~8,700. Dependencies point downward, `platform.rs` at the bottom.

| Module | Lines | What |
| --- | --- | --- |
| `lib.rs` | 494 | `run()`, `AppState`/`Session`, the window (see One title bar), the tray mirror, the panic hook, `write_debug_file`/`log_frontend`, `confirm_quit`, and the `invoke_handler!` list |
| `tasks.rs` | 2,399 | runnable discovery — see Runnables above |
| `git.rs` | 2,067 | worktrees, branches (local **and** remote-only), the working-set diff, the toolbar's fetch/pull/push, commit info |
| `usage.rs` | 1,475 | transcripts (incl. History's whole-machine scan) + the token ledger — everything read out of `~/.claude` |
| `telemetry.rs` | 926 | `write_instrument_settings`, `run_telemetry_server`, `resolve_permission` |
| `platform.rs` | 743 | OS leaves (top half, incl. `norm_path`/`physical_cwd`) + OS integrations (bottom half) |
| `pty.rs` | 803 | the four launch engines, `stream_pty_session`, the PTY lifecycle |
| `external.rs` | 339 | the `~/.claude/sessions` registry, `ProcTable`, terminal focus |
| `icons.rs` | 184 | project favicon/logo probing |
| `testutil.rs` | 50 | `git`, `scratch_dir`, `cfg(test)` only |

Four conventions hold across them:

- **`AppState` and `Session` live in the crate root**, reached as `crate::AppState`. There is deliberately **no `state.rs`** — `run()` is their only constructor and it lives in `lib.rs`, so owner and definition stay together. Their *fields* need no visibility annotation at all (a private field is visible to the defining module and every descendant, and every module here is a descendant of the crate root); only the structs carry `pub(crate)`, and only to satisfy the private-in-public lint. Don't mix in a `state.rs` later.
- **`pub(crate)`, never `pub`** — including on a `#[tauri::command]` fn in a private module, which works. `tasks.rs` uses plain `pub` and reads like a counter-example but isn't: `mod tasks;` is private, so `pub` inside it is unreachable from outside the crate anyway.
- **`platform.rs`'s first half imports nothing from the crate.** That is exactly what lets every other module depend on it; the second half (the OS integrations) may, since `set_caffeinate` takes `State<AppState>`. **Don't let the first half grow a crate dependency.**
- **A cfg-gated helper with a single consumer module belongs to *that* module**, not to `platform.rs` — `apply_utf8_locale` and `interactive_shell` are `pty.rs`'s (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, and the leaf layer must not import `portable_pty`), `same_path` is `git.rs`'s.

`AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see External sessions), `io_samples` (the previous disk-I/O reading per pid, which is what turns the kernel's lifetime byte counters into the inspector's rate), the held-open `pending` permission requests, and `caffeinate`.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `kind:"shell"` on the frontend `Sess` and skip telemetry/cost; `spawn_task` is the third entry point (see Runnables above).
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()` — add new `#[tauri::command]` fns there.

## Frontend (`src/`, `index.html`, `src/styles.css`) — 37 modules

**No framework, and no longer one file.** ~8,860 lines across 37 modules; `main.ts` is 724 of them and is **bootstrap only**. State lives in a `sessions: Map<session_id, Sess>` (owned by `state.ts`) plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing — follow this render-everything pattern rather than mutating DOM directly.

What `main.ts` still holds, deliberately: the imports and the whole of the `setXHost`/`setX` wiring (~70 lines — it is the seam map, and belongs in the file that owns the graph), the one-time startup blocks, `renderAll()`, every `listen()` handler, the delegated `[data-*]` click dispatcher and the global keydown, the ResizeObserver, the quit guard, the debug-console button wiring, the window controls (see One title bar), and the nine `setInterval`s.

**Tested logic modules** (eleven — no DOM, no Tauri, no render imports; these are what the 431 vitest tests cover, one `test/*.test.ts` per module bar `types.ts`, whose discriminants are exercised through the four suites that import it):

| Module | What |
| --- | --- |
| `types.ts` | the shared data model: `Sess`, `Phase`, and the one-line discriminants that read them (`isAgent`, `statusKey`, `PILL_TEXT`) |
| `format.ts` | durations, paths, escaping, sparklines, money and token counts — data in, string out |
| `diff.ts` | the unified-diff parser behind the working-set viewer (the extraction precedent) |
| `rl.ts` | account-wide rate limits: merging readings, burn rate, the window forecast |
| `usage.ts` | the `cc-usage` daily rollup, `uBuckets`/`uSum`, the day/token join |
| `phase.ts` | `applyHook` / `applyStatusline` — telemetry → session state. The heart of the display |
| `palette.ts` | ⌘K ranking: fuzzy match, scoring, prefix parsing, frecency |
| `grouping.ts` | what the sidebar shows and in what order; `urgencyRank`, `needsYou`, `nextAfterClose` |
| `tasks.ts` | the frontend half of Runnables: `stopRuleBlocked`, `launchWithDeps`, `applyRunner`, `${input:…}` glue |
| `history.ts` | History's rules: `histProject` (regrafting a row onto a project), `histBusy`, the scope/search predicates, day buckets |
| `gitwatch.ts` | `gitMutates` — whether a shell command an agent ran is worth re-reading git for; `driftTarget`/`driftUpdate` — which checkout its work has moved to, from writes *and* `cwd` |

**Shared**: `state.ts` (the session map, the stage pointer, every persisted preference) and `dom.ts` (`$`, `toast`, the shared scrim, `IS_MAC`/`MOD`/`chord`).

**Markup-only views**, untested by design: `usageview`, `inspectorview`, `sidebarview`.

**DOM-owning / render**, untested by design: `sidebar`, `footer`, `tray`, `inspector`, `debug`, `worktree` (the new-session dialog and the worktree removal flows, the biggest single module at 1,085 lines), `settings`, `taskui`, `palui`, `projmenu`, `caffeinate`, `diffview`, `mirror`, `historyui`, `update`.

**Behaviour** — IPC and DOM all the way down, so untested too, and therefore the thinnest ice in the app: `panes` (the three spawners + a pane's lifecycle), `terminal` (the xterm plumbing), `taskrun` (run on stop), `actions` (the app-level verbs), `icons` (the per-project glyph store).

Four rules keep that graph honest. **There are no import cycles across the 36 modules; re-run a cycle check after any change that adds an import.**

- **Dependency direction is state ← render ← wiring.** A logic module must not import render code or `main.ts`.
- **When an extracted function needs something that lives further up**, resolve it in this order: (1) **move the callee down too** if it is itself leaf-shaped — that is why `icons.ts` sits below `sidebar.ts` and `usage.ts` below `phase.ts`; (2) **a settable hook defaulting to a no-op** (`setRlLogger`, `setPanesRenderAll`) when the callee genuinely belongs to the render layer; (3) **an extra parameter** only as a last resort, since it changes a signature the move was supposed to leave alone. A control panel touching many things it doesn't own may take **one host object** instead of N setters (`settings`, `palui`, `projmenu`); prefer per-callee setters below ~4.
- **A `*view.ts` takes data and returns a string** — no `$()`, no `innerHTML`, no renderer call. The `render*` function that paints the result stays with whoever owns the element, its timers and its delegated handlers. If a candidate seems to need a `setSomething`, it is a `render*` and should stay behind.
- **`state.ts`'s `setX` setters assign and nothing else.** Persistence and `renderAll()` belong to the call site — that is what `actions.ts` is for. (Conflating the two is a bug this codebase has already shipped once: a settings picker called `state.ts`'s `setWtGroup` instead of `actions.ts`'s, so the choice never persisted.) Reads are the live ESM binding and stay bare identifiers (`activeId`, never `state.activeId`).

**Two surfaces on `renderAll`'s path are guarded, and the guard is a pattern, not a
one-off.** `renderSidebar` builds its markup every time but assigns `#projects.innerHTML`
only when the string differs from what it last wrote; `updateTray` diffs a signature
before rebuilding the native menu. Both exist because `renderAll()` fires on *every*
telemetry event and most events change nothing those surfaces show — 84.5% of sidebar
repaints were byte-identical under a realistic event stream. This is **not** render
diffing (no DOM is compared or patched) and it does not weaken the render-everything
rule; it is "skip when nothing changed", applied where it was measured to matter. If
you add a surface to `renderAll`, measure it before assuming it is free.

**When you measure a render function, force layout or the number is a lie.** An
`innerHTML` assignment defers style recalc and layout to the next frame, which a
benchmark loop never reaches, so the expensive part is invisible. Read
`document.body.offsetHeight` after each call. `renderSidebar` measures 0.13 ms without
this and 7.0 ms with it — the difference between "free" and "the hot path".

And the things that hold however the files are arranged:

- **`Sess.kind`** (`"claude" | "shell" | "task"`) decides whether telemetry, cost
  and git actions apply to a pane — use the `isAgent(s)` helper rather than
  re-testing the string. It is orthogonal to `Sess.external`, which means "the
  terminal lives in Ghostty/iTerm rather than an embedded pane" and only ever
  applies to a claude session.
- **A claude pane's keystrokes are not raw pass-through.** Shell and task panes
  wire `term.onData` straight to `write_pty` (in `panes.ts`); a claude pane goes
  through `claudeInput` in **`terminal.ts`**, which forwards the first `^C`
  (interrupt) but swallows a repeat inside `INTR_GUARD_MS` — Claude's REPL exits on
  a fast double `^C`, and a session lost that way leaves a dead pane behind. Ending
  a session is meant to be explicit (✕, ⌘K → Close, `/exit`). Windows Ctrl+V is
  handled separately in `winClaudePaste`, alongside it, via
  `attachCustomKeyEventHandler` — note xterm keeps only **one** such handler, so a
  new key rule belongs in that function or in `claudeInput`, never in a second
  `attachCustomKeyEventHandler` call. A shell pane's one handler is `shellKeys` and a
  task pane's is `clipboardKeys`, both also in `terminal.ts`; no pane is more than one
  kind, so the three never collide.
- **Copy/paste in a shell or task pane is Ctrl+Shift+C/V, and it is ours.** The
  unshifted chords aren't available: Ctrl+C is the interrupt those panes exist to send,
  and xterm eats Ctrl+V into a dead `^V`. So `clipboardKeys` claims the shifted pair —
  the same chords Windows Terminal, GNOME Terminal and VS Code's terminal use — while
  macOS's ⌘C/⌘V still reach the WebView's native copy/paste untouched. It reads and
  writes through **`tauri-plugin-clipboard-manager`, not `navigator.clipboard`**:
  `readText()` in the WebView is behind the `clipboard-read` permission, which wry only
  auto-grants for a webview built with `enable_clipboard_access()` (Tauri leaves it
  off), so the browser path would raise a WebView2 permission prompt on Windows and
  WKWebView's paste-confirmation button on macOS. Pasting goes through `term.paste`
  rather than `write_pty` so bracketed-paste mode and `\r\n`→`\r` still apply.
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of `main.ts`. Telemetry is routed by `data.session_id?.toLowerCase()` — session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **A turn that died is not a turn that finished, and only one hook knows which.** Claude Code fires `StopFailure` (not `Stop`) when the API kills a turn — a 529, a rate limit, a dead key — carrying an `error` enum (`overloaded`, `rate_limit`, `authentication_failed`, `max_output_tokens`, …) and the `error_details` text the pane shows. Everything *after* that point looks identical to a clean finish: the same 60-second idle `Notification` (`notification_type: "idle_prompt"`) arrives either way. Unguarded it relabelled the turn "your turn" and turned the red ✕ green a minute after the failure — which shipped, and is why `Sess.apiErr` exists. It is set by `StopFailure`, cleared only when the session genuinely starts another turn (`UserPromptSubmit` / `PreToolUse` / `SessionStart` / `SessionEnd`), and **`endTurn` is the single place that decides done vs. error** — both `Stop` and the idle nudge go through it, and the run-on-stop rule is skipped while it's set. Every surface that spells a state out reads `phaseText(s)`, not `PILL_TEXT[s.phase]`, so the reason travels with the glyph: "API overloaded" means wait, "auth failed" means go fix your credentials, and a bare ✕ means neither.
- **Persistence is all `localStorage`**, ~20 keys prefixed `cc-` (favorites, drag order, colours, icons, engine, font size, sort/grouping, frecency, caffeinate, the `cc-usage` daily cost rollup, the `cc-restore` roster, and the task keys `cc-task-{prefs,pins,hidden,onstop,runner,inputs}` + `cc-trusted`). `grep '"cc-'` for the current set.
- **Debug console** (🐞 button, bottom-right): an in-app event log + live state via `dlog()`/`dbgSnapshot()`. It flags **unrouted telemetry** (the routing-drift class of bug above) and JS errors, and mirrors a snapshot to `$TMPDIR/cc-launcher/episko-debug.json` (written by the `write_debug_file` command) so an external tool or an LLM agent can read live app state while it runs.
- **Two-tier logging — live snapshot vs. durable timeline.** The `episko-debug.json` snapshot is a *state-of-now* blob that is overwritten each flush and does **not** survive a crash (the frontend never flushes if the process dies). The durable tier is the backend rolling `episko.log` (+ `panic.log`) in the OS app-log dir (macOS `~/Library/Logs/io.respeak.episko/`), via `tauri-plugin-log` and a panic hook — the only on-disk trace of a panic that unwinds cleanly out of `main` (no crash dump / WER otherwise). Every `dlog()` line tees into it through the `log_frontend` command (tagged `[ui]`), so the UI and backend event streams land in **one time-ordered file**. A `episko.log` that stops without an `exit · clean shutdown` line is itself evidence of an abnormal termination. Use the snapshot for "what is it doing *now*", the rolling log for "why did it *die*".

## Noticing that a checkout moved

Nothing in Episko watches the filesystem — deliberately, for the reason the task
discovery cache gives (no thread, no crate, no per-project lifecycle). So everything
about "which branch is this on, and what checkouts exist" is either polled or pushed
from the hook stream, and the split matters.

**The hook stream is the trigger; git is the authority.** `PostToolUse` carries the
Bash command verbatim, so a settled tool call is the earliest warning that a session
moved HEAD or added a worktree. `phase.ts` hands it to the `onSessionTouched` seam
(main.ts wires it, a test leaves it a no-op), which does two things: queues the
session's workdir for a working-set re-read, and — if `gitMutates` matches — pokes
`refreshGitViews` on a 250ms debounce. **`gitMutates` never decides what changed**, only
whether to look, which is what makes it safe to keep loose: a false positive (`git
checkout -- file.ts`) costs one re-read that renders nothing, and a false negative (an
alias, a git call inside a script, an MCP git server) costs at most one poll interval.
Don't tighten it into a shell parser; the poll below is the backstop, and it is the only
thing that catches a branch switched in your own terminal.

**Two commands, two costs, and they must not be confused.** `list_worktrees` runs a
`status --porcelain` per checkout plus a `merge-base` per branch — right for the ⑃
dialog, far too heavy to poll. `worktree_heads` answers "which checkouts exist and what
is on each HEAD" from `.git/HEAD` and `.git/worktrees/*/{gitdir,HEAD}` with **no git
process at all**, which is what lets the sidebar hold a roster (`worktreesByRepo`) and
notice a worktree an agent created *before* anything runs in it. Its result doubles as
the change stamp: compare, and only then do the expensive thing. Two traps live in it —
git's bookkeeping name under `worktrees/` need not match the checkout's folder name (so
the path comes from `gitdir`), and every path goes through `physical_cwd` for the same
reason `repo_root_of` does, or one checkout renders as two.

**The dirty poll is stale-driven, not blanket.** `refreshDirtyStates` used to re-read
every open folder every 5s; it now reads only folders `markWorkdirStale` flagged, plus a
15s sweep for what no hook can see (your editor, a build, an external session). The tool
allowlist behind it is a list of *readers* — anything not on it marks the folder — so a
tool added to Claude Code later defaults to wrong-but-cheap rather than to silently
missing writes. `git_diffstat` itself is one `status --porcelain=v2 --branch` (which
carries the upstream and ahead/behind that `upstream_state` cost two more processes),
with the `--numstat` walk skipped entirely on a clean tree.

Everything lands through `refreshGitViews` → `renderAll()`, so the sidebar, the header's
branch chip and the open ⑃ dialog cannot disagree about what is checked out where. A
removal is the one change to that roster the app makes *itself*, so both removal paths
call `refreshGitViews` on success rather than waiting for the poll — `renderAll` only
paints the roster, it never re-reads it, so without this the cluster you just deleted
stays on screen.

**The ⑃ cluster header is the surface for a checkout** (subheader mode). It renders
whether or not anything runs beneath it, which is what lets the roster's discovery show:
a worktree an agent created appears as a dimmed header (`.wtvacant`) rather than as a
row that says "no session". It carries a `＋` (→ `launchWorktree`, which keys the new
session's `colorKey` to the **repo root**, or the pane splits off into a project group of
its own) and a **right-click menu** in `projmenu.ts` — terminal, folder, copy path, the ⑃
dialog, and remove. That menu shares `#ctxMenu` with the project one: `data-wt` is
matched *ahead* of `data-key` in the `contextmenu` handler, because a cluster sits inside
a project group and a combined `closest()` would be decided by tree distance rather than
by what was clicked. Chip mode has no headers, so the "no session" row survives there
alone.

**`openWt` has two modes, and the difference is framing, not machinery.** `launch` is
the original — "where should this session start?", so every branch in the repo is a row.
`manage` is what a ⑃ cluster's context menu opens (`{ manage: true, focusDir }`): the
caller already knows where a session would go, so what it wants is the checkouts. The
detail pane was *always* a management surface — folder, HEAD, working tree, merged-or-
not, the removal flow, every warning about a locked/detached/vanished checkout — so
manage mode only drops what surrounds it: **branches wait for a query** (unfiltered they
bury the handful of checkouts you came for, but gating rather than dropping keeps "add a
worktree on an existing branch" reachable, which the create row can't offer for a name
that is already a branch), the **engine chip** goes, and the count reads `N checkouts`
rather than `N destinations`. The title is load-bearing on its own: headed "New session"
it reads as the launcher whatever is highlighted in it. **⏎ still starts a session in
both** — changing what Enter does between two modes of one dialog is a worse trap than a
verb that is occasionally not what you came for.

**The main checkout is not a worktree, and says so twice.** `clusterGlyph` gives it `⌂`
— the glyph the dialog's Repo row and the project menu's "Open project folder" already
use — and `branchHue` seeds it from its **path** rather than its branch, so it comes out
wearing the project header's own accent (a hand-picked colour included). Both exist
because `⑃ develop` above three `feat/*` clusters is four worktrees to anyone who
doesn't already know which branch name meant "the original". Every chip and header goes
through those two helpers, so subheader and chip mode cannot disagree.

**Removal is keyed by path, not by session** (`removeWorktreeAt`) — a cluster can hold
none, one or several, and an empty one is exactly the checkout you most want to prune.
It closes the Episko sessions living there (the backend refuses while one runs), but
**refuses outright when an external session is in the checkout**: the backend can't see
one, so `git worktree remove` would delete the folder out from under an agent in someone
else's terminal. The menu says so on the row rather than letting the click fail.

## Drift — the agent left the checkout it was launched in

The section above answers "what is checked out where". This answers the other half,
which it cannot: **which checkout is this agent's work actually landing in?** The
worktree roster notices a new checkout (the toast fires, the row appears); it is the
*session → checkout* link that goes stale.

**There are two ways an agent changes checkout, they behave as opposites, and each is
invisible to the signal that catches the other.** Both were verified against the real
CLI (2.1.220) and against real sessions — guessing here produced a first cut that
covered one and read as broken in the other.

| | **out of** the project dir | **into** the project dir |
| --- | --- | --- |
| how | `git worktree add ../x` via Bash | Claude Code's `EnterWorktree` tool |
| where | a sibling, e.g. `.cc-worktrees/…` | `<repo>/.claude/worktrees/<name>` |
| hook `cwd` | **pinned** — every `cd` out is undone (`Shell cwd was reset to …`) | **follows** |
| the transcript | stays where it was | **Claude re-homes it itself** |
| `gitMutates` | fires | never — no Bash command ran |
| the signal | a write's `file_path` | `cwd` |

One real session had 42 `Shell cwd was reset to …` and 622 records all naming the folder
it had already left; another used `EnterWorktree`, made **zero** writes, and had its
transcript moved out from under Episko by Claude. Neither signal alone covers both.

Hence two signals with different standing, and the asymmetry is the whole design
(`driftUpdate`):

- **`cwd` may only ever *set* a drift, never clear a write-derived one.** A `cwd` reading
  "home" proves nothing about where the writes are going — that is exactly the left-hand
  column, where it reads "home" for the entire life of the drift. Letting it clear would
  delete the answer on the next hook. It retires only a drift `cwd` itself reported.
- **Writes latch**, because an agent working in another checkout still reads its original
  one constantly (usually *why* it moved). Cleared only by a write home.
- **Both sides resolve to a checkout before being compared**, never the path against
  `workdir` directly. That is what keeps `cd src/` (not a move), a session launched in a
  subfolder (not a move) and a nested worktree (a move) all straight at once, and why the
  longest match wins — `EnterWorktree`'s worktrees live *inside* the repo that contains
  them.
- **The target must be a checkout the roster already knows.** Unlike `gitMutates`, a
  false positive is not a wasted re-read — it puts a wrong branch on screen and offers to
  relocate a live session into `$TMPDIR`.

Display is the same either way and **the row does not move**: it stays under the checkout
that owns its identity, carrying a `⤳ branch` marker, with `old ⤳ ⑃ new` on the header
chip and a card at the top of the inspector, above the working set and git buttons it
contradicts.

**`Drift.via` is not decoration — it decides the repair**, and conflating the two would
be wrong in both directions:

- **`via: "cwd"`** → *Follow it here.* The process is already running there and the
  conversation is already there. Episko is merely behind, so `followSessionDrift` adopts
  the directory **in place** — no confirm, no kill, no file move, no relaunch; the pane
  never blinks. It re-points `workdir`/`branch`, drops the stale `git` working set, marks
  the new folder for a re-read and re-saves the roster (restore must target the folder
  the transcript is in).
- **`via: "write"`** → *Move session here.* Nothing has re-homed anything. `claude
  --resume` takes a session id and **no path** (there is no path-based resume flag) and
  looks the conversation up under `<enc(cwd)>/<id>.jsonl`, so *no sequence of commands a
  user could type* relocates a session. **Kill, wait, move, relaunch** — and the
  *wait* is not the `invoke` returning. `kill_session` sends a signal and returns, so
  awaiting it proves only that the signal was sent; the process is reaped on a backend
  thread that emits `pty-exit` **after** `child.wait()`, and that event is the only
  evidence the transcript handle is closed. Renaming before it lands is the bug the
  ordering exists to prevent (Windows refuses to rename an open file; POSIX succeeds and
  leaves the dying session writing into the moved file). The wait is bounded, so a wedged
  process cannot strand the pane. `move_session_transcript`
  renames rather than copies (two files with one id would double-list in History and leave
  `--resume` ambiguous), carries the `<id>/tool-results` sidecar, refuses to overwrite, and
  restricts the id to uuid characters before it reaches a filename (no dot, no separator, so nothing escapes the projects tree). A failed move still
  relaunches — in the *original* folder — so the cost is a restarted pane.

`move_session_transcript` is the only thing Episko ever writes inside `~/.claude`, and the
second exception to "Episko only writes `.episko/tasks.toml`".

Known wart: a moved transcript's first user record still names the old cwd, so
`transcript_origin` grafts its History row onto the old project. Defensible (the
conversation did start there) and not worth rewriting records to fix.

## Four launch engines, one telemetry path

`termEngine` selects where the terminal lives; the instrumentation (and thus the cockpit's telemetry) is identical for all:

- **embedded** — xterm.js pane inside the app (the only one that renders in-app).
- **ghostty** — external tinted window (`spawn_ghostty`).
- **terminal / iterm** — `spawn_external_terminal` writes an executable `.command` wrapper and hands it to `open -a`.

`available_terminals` reports which are installed so the UI only offers working ones.

## One title bar, and it is the header

The app draws its own header, so a native title bar above it was a second bar
saying less. It is gone on both platforms, but by different routes, and the
difference is the point:

- **macOS keeps its decorations.** `titleBarStyle: "Overlay"` + `hiddenTitle` hide
  the bar while floating the *real* traffic lights over `.top`;
  `trafficLightPosition` centres them in its 40px and `html.mac`'s `padding-left`
  leaves them room. Drawing our own would lose the green button, which zooms or
  goes fullscreen depending on how you hold it. In fullscreen the OS takes the
  lights back into its own sliding overlay, so `html.fs` closes that gap.
- **Windows has no such style**, so the frame goes entirely (`decorations: false`)
  and `#winCtl` draws minimize / maximize / close.
- **A browser gets neither.** The same HTML opens on vite's port in dev, where
  there is no window behind it — and `IS_WIN` is a *user-agent* read, so it is
  still true in Chrome. Everything that acts on the native window is therefore
  gated on **`IS_TAURI`** (`dom.ts`, from the `isTauri` global tauri defines
  before any page script), including the platform class itself: no class, so the
  CSS shows no controls and reserves no traffic-light gap.

Four things about that split are easy to get wrong:

- **The window is built in `setup()`, not by the config** (`"create": false`).
  `decorations` is not a per-platform config key, and a `tauri.windows.conf.json`
  would replace the whole `windows` array (json merge-patch), so every shared key
  would exist twice and drift. **Flipping it after creation is not the same
  thing:** tauri attaches its undecorated-resize child window only when the webview
  is created over an *already* undecorated window, so a late flip yields a window
  whose edges cannot be dragged at all — the WebView2 child swallows the hit test
  and nothing behind it answers. `from_config` keeps one definition and cfg-gates
  the single flag that differs. (What tao does *not* do is drop `WS_CAPTION`: it
  zeroes the non-client area instead, which is what keeps the shadow, the rounded
  corners and snap. So a style-bit check reads "decorated" either way — measure
  `GetClientRect` against `GetWindowRect` instead. It was 1px inset here, 30 on a
  build with the bar.)
- **Dragging is `data-tauri-drag-region="deep"` on the header**, which excludes
  clickable elements for us — but only what the DOM calls clickable. `#kbar` is a
  `<div>` that listens for a click, so it opts out explicitly (`="false"`); without
  that the drag swallows the mouseup its click needs and ⌘K stops opening, with
  nothing in any log to say so.
- **Close goes through the OS close request** (`win.close()`), so it lands in the
  same `quit-requested` confirm as Ctrl+Q instead of stepping around the guard.
- **Maximize is only *asked* for.** The glyph flips on the `onResized` that comes
  back, which is also what catches Win+↑, a snap, and the double-click the drag
  region handles itself. The same listener is what tells macOS it entered
  fullscreen.

## External (non-Episko) sessions

Episko surfaces Claude sessions started *outside* it, discovered from `~/.claude/sessions/<pid>.json` (one per running interactive session — same path and format on Windows under `%USERPROFILE%`, VS Code-hosted sessions included, verified on CC 2.1.216; format details in the `claude-code-local-session-registry` memory). The **listing is OS-agnostic**: `list_external_sessions` liveness-checks survivors against `ProcTable`, one in-process `sysinfo` snapshot of the process table (no `ps`/`tasklist` spawns — the frontend polls every 3s), so discovery works on macOS, Windows and (untested) Linux alike.

- **Filter owned sessions by pid, never by session id.** Episko's own sessions register there too (confirmed CC 2.1.211), and `/resume`/`/clear` rewrite `<pid>.json` with a *new* id — so an id-based exclude lets a live, Episko-owned session reappear as "external" showing the resumed transcript. `AppState.owned_pids` holds every claude pid Episko spawned; the ancestry walk (`ProcTable::is_descendant_of`) also catches child-terminal launches.
- **That ancestry walk is deliberately broad, and it bites during development.** Anything started from a terminal *inside* Episko — notably `pnpm tauri dev` — becomes its descendant, so a second Episko instance's sessions are silently filtered out of the first's external list. **Run dev builds from a real terminal, not an Episko pane.** (Dev and installed also share one localStorage and one `episko-debug.json`, so prefer quitting the installed app entirely.)
- `read_transcript` mirrors a session read-only (decoding the cwd→`<enc>` path scheme). `focus_external_session` — still **macOS-only** — jumps to its terminal: exact tab focus by tty via AppleScript for Terminal.app/iTerm2, else `open` on the owning top-level `.app`. That `.app` fallback is **required** for Electron hosts like VS Code — their integrated terminal runs under a *helper* process System Events can't target by unix id (fails `-1719`); the tradeoff is we can only front VS Code, not the specific panel.
- **Known gap:** sessions launched into an external Terminal.app/iTerm (via `open -a`) aren't in Episko's process tree, so they still rely on the session-id `exclude` and can leak after a `/resume`.

## Restorable sessions (surviving a restart)

Episko's launch uuid **is** Claude's `--session-id`, so every session it launches already has a transcript at `~/.claude/projects/<enc(workdir)>/<id>.jsonl`. Restore is therefore about remembering what was on screen and under what identity — not capturing conversation state.

- **The roster** (`cc-restore`) holds what was open at quit; `closeSession` removes an entry (an explicit close means done). Shells never join. Saves are debounced *with a ceiling* (`ROSTER_MAX_STALE`) — a busy session's continuous telemetry would reset a pure trailing debounce forever and never write.
- **Resume `resumeId`, not `id`.** Each runtime-id rotation (see the core-mechanism section) starts a **new transcript file**, so the launch uuid goes stale as a resume target. `run_telemetry_server` preserves Claude's incoming id as `claude_session_id` *before* forcing ours on; the frontend tracks it into `Sess.resumeId` and saves immediately on rotation. Routing is unchanged.
- **`--resume` and `--session-id` are mutually exclusive** (resume wins), so all three spawners branch either/or on `resume: Option<String>`. `--settings` stays keyed to our launch uuid, so `X-CC-Session` routes telemetry whatever id Claude runs under.
- **Verified against the real CLI:** resume preserves the id and appends to the *same* transcript; it must run in the **original cwd** (else `No conversation found with session ID: …`); and resuming an **already-live** session silently interleaves both transcripts (Claude takes no lock). Hence `dormantBusy()` gates Resume, and spawners refuse a vanished workdir (deleted worktrees are real).
- `list_past_sessions(workdir)` supplies labels from Claude's `ai-title` record — **last occurrence wins** — falling back `ai-title` → `last-prompt` → first user message. That layout is internal to Claude Code and documented as unstable across releases, so the chain is load-bearing, not padding. Only the 512KB tail is scanned. Entries with **no transcript are dropped** (a session launched but never prompted writes none).
- **The transcript folder is keyed by the *physical* workdir**, so `project_transcript_dir` canonicalizes before encoding (`physical_cwd`). This is not Claude being clever: `getcwd()` reports the resolved path however the process got there, so a session launched in a symlinked folder writes under the resolved encoding and under no other — encode the spelling the user picked and `list_past_sessions` returns empty, which reads as "no past sessions" rather than as a failure. On Windows the canonical form is verbatim (`\\?\C:\…`) and **must** have that prefix stripped or a currently-working path breaks; `strip_verbatim` is separated out precisely so that half is testable on a machine that can't produce one. Both live in **`platform.rs`**, not here: `repo_root_of` needs the same resolution for the same underlying reason, so the encoder is no longer the only caller.
- **The roster is a convenience layer, not a system of record** — `/resume` inside Claude always lists every session for a folder, so nothing dropped or removed is ever lost. Keep UI copy honest about that, and don't build recovery machinery for a problem `/resume` already solves.
- **The stage has one owner:** `activeId` and the `mirror` pointer (`{kind:"ext"|"past"}`) are mutually exclusive — the read-only kinds share one discriminated pointer rather than a flag each. Timer-driven inspector repaints must bail on `mirror`, not just the external case.

## History (`◷ History`, ⌘⇧H, `list_session_history`)

The roster above answers "what was open when Episko quit". History answers "reopen the
one I closed" — which the roster *can't*, by design: `closeSession` drops an entry (an
explicit close means done) and it only ever knew Episko's own launches. So History
reads the store that forgets nothing, walking all of `~/.claude/projects/*/*.jsonl`.
It is therefore a **superset** of the dormant rows, sessions started in a plain
terminal or an IDE included. `history.ts` owns the rules, `historyui.ts` the dialog —
the `palette`/`palui` split, and what makes the rules testable.

- **The cwd comes from inside the file, never the folder name.** `project_transcript_dir`
  encodes a cwd into `<enc>` by mapping every non-alphanumeric char to `-`, and that is
  lossy — the inverse does not exist. So `transcript_origin` reads the `cwd` (and
  `gitBranch`) off the first user record, from a bounded *head* rather than the tail
  `transcript_meta` needs. A transcript with no `cwd` is **dropped**: `--resume` must
  run in the original directory, so a row without one could only fail.
- **Then `norm_path`.** Claude records the path as the user typed it (`e:\proj` and
  `E:\proj` for one folder) while everything History compares it against —
  `git_repo_info`'s root, a live session's `workdir` — is normalised. Skipping this made
  a repo's own checkout unequal to its own `repo_root`, so **135 of 219 rows read as
  worktrees**; after, 32. Safe for the transcript lookup: identity off Windows, and on
  Windows only the drive letter and separators, which the case-insensitive filesystem
  and the `<enc>` scheme both absorb.
- **Each row carries its `repo_root`** (`git_repo_info`, memoised per unique cwd,
  skipped for folders that are gone) — the same enrichment `list_external_sessions`
  does. It is what lets `histProject()` graft a row back onto the sidebar's grouping,
  and it is load-bearing for the ◧ scope filter: a worktree lives *beside* its repo, so
  no path-prefix test can find it. A few dozen git calls per scan, not one per row.
- **Bounded before it reads.** A `(mtime, len)` pass over dir entries ranks every
  transcript and keeps the newest `limit`; only those get the tail scan. So `limit` caps
  I/O, **not rows** — the result can come back shorter. Runs on a blocking thread.
- **The scan was profiled, and both hot spots were the ones nobody would guess.** At
  244 transcripts / 737MB it took ~5s *debug*: `git rev-parse` × 24 folders was **3.3s**
  (process creation on Windows, ~140ms a call) and the 512KB tail reads were **1.7s**;
  the directory walk was 6ms. So a smaller page size would have addressed the *smaller*
  half — the folder count barely moves with it. Both were removed instead, and it now
  runs in **~0.48s debug** (~1.6ms per transcript, so `limit` is a genuine linear dial):
  - `git_repo_info` → **`repo_root_of`** in `git.rs`, which reads the `.git` dir/file
    layout directly. No subprocess. A test asserts it against `git_repo_info` case by
    case, including a **stale worktree** — a pruned admin dir leaves the `.git` file
    pointing at nothing, and git calls that "not a repository" and stops rather than
    searching upward, so following that dangling pointer would file a dead checkout
    under a repo that has forgotten it. It walks from the **physical** cwd
    (`physical_cwd`), and that is load-bearing: `git` resolves symlinks before it
    answers, so an unresolved walk returns a second spelling of the same root, which
    then fails the exact string equality the sidebar groups by and stops a repo merging
    with its own worktrees. Dropping that call also makes the function disagree with
    *itself* — a linked worktree's root is read out of the `gitdir:` file, which git
    wrote canonically, so only the `.git`-is-a-directory branches were ever unresolved.
  - `transcript_meta` reads a **64KB tail first**, widening to 512KB only when both
    `ai-title` and `last-prompt` were not in range. Requiring *both* is the whole
    correctness argument: each is last-occurrence-wins, so once one is in the window the
    newest one is too. Accepting on *either* mislabelled 10 of 244 transcripts with the
    raw prompt, because the summary sat further back. Verified across the real corpus:
    0/244 differ from an always-full read.
  - `transcript_meta` also has a substring gate (parse only `ai-title` / `last-prompt` /
    the first user line), behaviour-neutral since no other record's match arm does
    anything.
- **Same two resume constraints as a dormant row**, surfaced rather than hidden: an id
  live anywhere is listed but tagged `live` (Claude takes no transcript lock, so a
  second `--resume` interleaves both conversations into one file), and a vanished folder
  is tagged `no folder` instead of dropped — a deleted worktree still reads.
- **Two doors, one dialog — the difference is only the scope it opens in.** `◷ History`
  in the stage header opens *scoped*, because everything beside it (❯ Terminal, ▶ Run,
  ＋ Session) acts on the project on screen; a global button among them would read as
  one more of those, and `syncStageButtons` greys it with them. The whole-machine view
  is the `◷` icon in the top bar, with the other app-wide controls.
- The dialog reuses `#wtDlg`'s `.wt-*` skin wholesale (head / query / list+detail / foot)
  and the mirror's `.tvmsg` markup for its inline preview.

## Notes on scope & doc drift

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines, terminal-window focus. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic. Per-session resources are **no longer** one of the macOS-bound bits: `session_resources` reports disk I/O through `sysinfo` (one syscall, every OS) rather than shelling out to `ps`, so `ps_one` is now reached only from the macOS-only terminal-focus path.

**`SPIKE.md` is a historical record and is not maintained.** It describes the Phase-0 spike — single-session, "observe-only" permissions, one file per side — and is kept because it is the record of where this started, not because it is true. It carries a banner saying so. Don't consult it for how the app works today, and don't edit it to match; `README.md` is current.

**Trust the code over the docs** when they disagree, and fix the doc in the same commit.
