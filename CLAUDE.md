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
- **The macOS-only arms cannot be linted on Windows at all.** Flipping `target_os` as well fails hard: `rusqlite` is a macOS-only dependency, so the code behind those arms doesn't have its crate. CI's macOS leg is the only check for that code.

**Package manager: `pnpm`** for this repo (there's a `pnpm-lock.yaml`; both CI workflows use `pnpm install --frozen-lockfile`, and `packageManager` in `package.json` pins the version for corepack/CI). Use pnpm here, not npm. Windows code-signing / release-signing setup lives in `src-tauri/SIGNING.md`.

Test coverage is **unit-only — there is no end-to-end harness**, but it is no longer thin: **417 vitest + cargo (91 on macOS, 84 on Windows — the platform tests are `cfg`-gated)**, both run in CI on both OSes.

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
  without defaults become the same kind of prompt. **An introspector that fails is
  a blocked row too, never an empty list** (`IntrospectFail`): silence there is
  unfalsifiable — it reads exactly like a project that declares no tasks, which is
  how a working justfile stayed invisible. `NoProgram` names the *PATH* rather than
  guessing "not installed", because installed-but-not-visible is the commoner case.

### Run groups — one chain, one row

A chain launches **one pane per step**, and that is not negotiable: a run's exit code
*is* its phase, and you cannot get four exit codes out of one PTY. What was
negotiable is how it reads, which used to be three loose rows interleaved with your
agents. So `launchWithDeps` mints a **`run.groupId`** per *launch* and every step
inherits it — including the chain's own pane, or the root of "build → test" would sit
outside the group it created. Nesting inherits via `opts.groupId ?? crypto.randomUUID()`,
which is what makes "outermost wins" true without threading a depth counter.

- **Per launch, never per task.** Running `fe-check` twice gives two rows to compare,
  which is the point.
- **The fold is presentational.** `foldRunGroups` and `groupPhase` are pure and live in
  `grouping.ts` (the tested layer); panes, PTYs and the phase machine are untouched.
  A group takes the position of its **first member**, so whatever `projectList` already
  sorted by still decides where it sits — re-sorting there would overrule it silently.
- **Worktree clustering keys on the *checkout*, via `checkoutOf`, never on `workdir`.**
  A task's `workdir` is where the **task** runs, and a VS Code `options.cwd` is routinely
  a subfolder (`01_frontend`, `02_backend`) — which is not another worktree. Keying on it
  gave one chain a "worktree" header per pane, all showing the same branch, and *also*
  broke the fold: it happens inside a cluster, so members split across clusters could
  never group. `run.root` (the discovery dir) is the checkout, which is why
  `launchWithDeps` must pass `discoveredIn` down to dependencies rather than clearing it.
- **A group of one renders as a plain row.** A header wrapping a single step is
  overhead, and a chain whose dependencies all resolved to nothing is not a chain.
- **`groupPhase` is worst-of, not last-of.** A failed build stops the chain, so the
  steps behind it never run — last-of would report `done` on a broken chain. `working`
  beats `done` in the other direction, and an `idle` step is one queued behind a
  sequential dependency, so it counts as working too.
- **The header is a block, not a `.srow`.** A summary of N runs is a different kind of
  thing from a run, so `.rgroup` carries a surface with the steps inset inside it and
  the set reads as one object; styling the parent like its own children is what made it
  vanish into them. Two traps live in that markup: `.rgrow` **must** stay
  `position: relative` so the ✕ stays absolutely positioned — an absolutely-positioned
  child is not a grid item, and making it static claims a cell, wraps onto a second
  implicit row and doubles the header's height. And the block's background is
  `--surface`, never `--lift`: lift is a white veil, which reads as "raised" on the dark
  ground and as *nothing* on a light one.
- **Clicking the header tiles the group across the stage** (`openRunGroup` →
  `stageGroup`), focused on the failure if there is one, else the last step to start.
  `#terminals.tiled` turns the absolutely-positioned pane overlays into grid cells, so
  several are `.active` at once; each gets a `.pane-cap` naming it (with a ✕ carrying
  `data-close`, so the existing dispatcher closes it — persistent once the run has
  finished, hover-only while it is alive), CSS-hidden until tiled. `refreshPaneCaps` is
  called from `renderAll` because panes sit outside the render-everything sweep.
  The twisty (▸) expands the step list instead — different question, so a separate hit
  target, which only works because `[data-rgtoggle]` is in `main.ts`'s `closest`
  selector list. **`refit()` must refit every visible pane when tiled**, not just the
  focused one, or a resize leaves the others at the wrong geometry.
- **A chain launch lands on the group, not on whichever step started last.** `launchTask`
  calls `openRunGroup(opts.groupId)` instead of `setActive` when the pane belongs to a
  chain — one chord starts a whole stack, so the stack is what you meant to look at, and
  activating each member in turn both left the stage on an arbitrary step and untiled the
  group on the way. It re-tiles as later steps appear **only while the stage is still on
  that group**: a sequential chain can start step 3 minutes in, and it must not yank you
  back from wherever you went.
- **Closing one tile stays in the mosaic** (`nextInGroup`). `nextAfterClose` answers the
  *sidebar's* question over the whole project, so on its own it handed the stage to
  whichever Claude session sat beside the group — and untiled it on the way. A surviving
  group sibling wins, focused next-then-previous because the grid reflows into the gap.
  Closing a tile also has to `refit()`: every surviving cell changed size, but
  `#terminals` did not, so the ResizeObserver never fires.
- **Closing a group asks first if anything is still running** (`closeRunGroup`). One ✕
  can stand for a dev server, a database container and four finished installs, and
  killing a stack you meant to keep is not undoable. A chain that has already finished
  closes instantly — that is tidying, not destruction.
- **Header shows all of them, a row shows one.** `setActive` *leaves* the tiled view,
  because keeping it and only moving the focus ring read as the click doing nothing.
  `openRunGroup` therefore has to pass `setActive(id, keepGroup = true)` — the default
  would clear the `stageGroup` it just set and never tile at all. Clicking a *tile* is
  the third case, `focusInGroup`: it moves `activeId` (so header/inspector follow) and
  keeps the layout, via one delegated `mousedown` on `#terminals`.
- **A finished run's duration is frozen at `run.endedAt`, and `runElapsed` is the only
  place that computes one.** It was three places — the sidebar column, a tiled pane's
  caption and the inspector's "Took" row each did their own `Date.now() - startedAt`, so
  all three kept counting after the process exited and a step that took 400ms read
  "1m 23s" a minute later. Fixing two of the three is how that bug survived being
  "fixed" once; the consolidation is the actual fix. Lives in `types.ts` beside the
  other discriminants — pure, `now` injectable, and therefore tested.

**`dependsOn` is a DAG, and it must be walked once — not once per path.** Every
dependency of one launch is memoised in `launchWithDeps`'s `started` map (task id →
"did it succeed"), claimed *synchronously* before the first await so two branches
racing for the same dependency cannot both start it. Without it, one ⌘⇧B on a real
`"Dev: Frontend + Backend"` launched **27 panes for 11 tasks** — `uv sync` six times,
`pnpm install` and `docker compose up` four each — because a shared dependency was
restarted down every path that named it. VS Code runs each task once per invocation.
Two consequences worth keeping:

- **Memoise the whole outcome, not just the launch.** `exitWaiters` holds one resolver
  per session id, so two dependents each calling `waitForExit` on the same pane would
  clobber one another's resolver and one branch would hang for ever.
- **`findDepCycle` runs first, over the whole graph, before a single pane starts.**
  Better on its own (the per-path check in `resolveDeps` only fires once part of the
  chain is already running, leaving half a stack behind it) and *required* by the memo:
  a branch that awaits a shared task instead of descending into it can end up waiting
  on a branch that is waiting on it. Pure, so it is tested — including that it does not
  mistake a diamond for a cycle.

`dependsOn` is resolved **in the frontend** (`launchWithDeps`), because only the
side that owns the panes can wait on an exit code. Dependencies are named by
*label*, run in parallel unless `dependsOrder: "sequence"` (VS Code's default,
surprising as it is), and a failed dependency stops the chain. `waitForExit`
resolves from the `pty-exit` listener *before* its early return, and
`closeSession` resolves it with `-1`, so a chain can never deadlock on a pane
that went away.

`launch.json` configs are offered as **run without debugging** (VS Code's ⌃F5).
Episko has no debug adapter, so `request: "attach"` and compound configs are
blocked rather than silently started as plain processes. **A compound *task* is the
opposite case and must not be confused with it** — see below.

### Compound tasks, and ⌘⇧B

A `tasks.json` entry with **no `command` but a `dependsOn` list** is VS Code's
*compound task*: the dependencies are the work. `"Dev: Frontend + Backend"` is the
canonical shape, and it is usually what `"group": {"kind":"build","isDefault":true}`
marks — so blocking it as `"no command"` withheld precisely the task a whole stack
gets started from. `Runnable.compound` says so explicitly rather than being inferred
from an empty command line, and `launchWithDeps` runs the dependencies and stops.

- **`compound` is not `blocked`.** Nothing is missing. Its `detail` names what it will
  run (`runs Frontend (vite dev), Backend (uvicorn)`), because `"no command"` as a
  subtitle read like a defect.
- **`launchWithDeps` returns `{ok, id}`, not `string | null`.** The two are genuinely
  independent: a compound *succeeds* while launching no pane. Reading that absence as
  failure is what would stop a nested compound from ever satisfying its parent.
- **A background dependency is satisfied once it starts, never awaited.** Both of
  `"Dev: …"`'s dependencies are servers that never exit, so `waitForExit` on them hung
  the chain forever and nothing downstream ran. VS Code behaves the same way. A
  *non*-background dependency is still awaited — "build then test" only means something
  if the build's exit code is read.
- **A compound can't be a run-on-stop rule** (`stopRuleBlocked`): it has no pane, and
  `forSession` is deliberately cleared for dependencies, so a failure would have
  nowhere to be reported back to.
- **`default_for` is separate from `group`.** The kind is a display bucket many tasks
  share; `isDefault` is what makes exactly one of them the answer to ⌘⇧B. `runDefaultTask`
  takes the marked one, else an unambiguous single member of the group, else **opens the
  picker** — silently running the first build-ish task in the file is how you deploy
  when you meant to compile.
- **⌘⇧B / ⌘⇧T must be registered *before* plain ⌘B / ⌘T** in `main.ts`'s keydown chain,
  which deliberately doesn't test `!e.shiftKey`. A shifted binding placed after its
  unshifted twin silently never fires.

The pay-off is that this needs no orchestration of its own: the chord resolves one
task, and the existing `dependsOn` fan-out plus the run-group fold do the rest — the
whole stack comes up as a single sidebar row you can click open into a tiled view.

`spawn_task` is the third PTY entry point after `spawn_claude` / `spawn_shell`.
It takes a `TaskSpec { exec, cwd, env }` — a resolved subset of a `Runnable` — and
is deliberately **un-instrumented**: no `--settings` file, no telemetry, no cost,
and its pid never enters `owned_pids`. `Exec::Shell` runs through a *login* shell,
and `Exec::Argv` through `argv_command` (see PATH and Windows argv, below).
The `Exec` wire format is pinned by a round-trip test — the frontend hands a
discovered `exec` straight back to `spawn_task`, so a rename there breaks every
launch silently.

### PATH, and why a login shell is not enough

**A login shell does not give a task the user's PATH.** This looks like a detail and
is worth three separate shipped bugs. zsh — macOS's default — sources `~/.zshrc`
**only when interactive**, and `.zshrc` is where nvm, pnpm's `PNPM_HOME`, mise and
Homebrew's `shellenv` are actually exported. So `zsh -l -c` sees none of them, and a
Finder-launched app starts from `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. That produced:

- a task running `pnpm tauri dev` dying on `command not found: pnpm`, while the
  identical line worked in iTerm;
- a real `justfile` reported as **no tasks at all**, because `Command::new("just")`
  failed with `NotFound` and the provider returned an empty list;
- the same, silently, for any `cargo install`ed listing tool.

The fix is `platform::augmented_path`, and it has two halves. It **harvests** the PATH
from an *interactive* login shell (`$SHELL -i -l -c`) once per run, cached in a
`LazyLock` and warmed off the UI thread by `warm_shell_path` in `run()`; and it
appends hardcoded fallbacks (`~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, …)
for when the probe fails. Four rules hold it together:

- **The harvested PATH goes first, fallbacks after.** If nvm puts a node ahead of
  `/usr/local/bin`, a task must get nvm's, or "works in iTerm, fails in Episko" is
  back one layer down.
- **The probe's output is fenced, not assumed.** An interactive shell runs rc files
  and rc files talk (powerlevel10k's gitstatus warning, a motd). The PATH is wrapped
  in `PATH_MARK` and extracted; anything that doesn't parse as a PATH is *refused*,
  because a mangled value would shadow the fallbacks it sits in front of. fish is the
  live case — it interpolates `$PATH` space-separated.
- **Interactive is for the probe only, never for the task.** rc noise is fine to parse
  out of one probe and unacceptable prepended to every task's pane.
- **Anything that shells out needs it.** Every introspector goes through
  `introspect_output`, which applies `augmented_path` *and* `sys_command`. A provider
  that spawns a tool without both is the justfile bug again.

### Windows argv: `CreateProcessW` cannot run a script

portable-pty hands the resolved program to `CreateProcessW` as `lpApplicationName`,
which starts PE executables and nothing else. On Windows `npm`/`pnpm`/`yarn` are a
`.cmd` shim plus an extensionless bash script — and portable-pty's own `search_path`
prefers the *extensionless* one. So every `package.json` script (the npm provider
emits `Exec::Argv`) failed to launch there while running fine on macOS.

`argv_command` resolves the program itself — PATHEXT over the augmented PATH, ignoring
extensionless matches — and routes anything that isn't `.exe`/`.com` through
`cmd.exe /C`, which resolves PATHEXT properly and can run a script. A program that
resolves to nothing goes through `cmd.exe` too, on purpose: "'foo' is not recognized"
then prints **in the pane the user is watching** instead of as a spawn error with no
context. The pure half, `win_runs_directly`, is compiled on every platform
(`cfg_attr(not(windows), allow(dead_code))`, not `cfg(windows)`) precisely so the
decision is testable from a Mac and reachable by the cfg-flip trick.

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
**`.episko/tasks.toml` is the only file Episko writes** — a discovered VS Code task
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

`main.rs` only calls `episko_lib::run()`. `lib.rs` is **bootstrap, not the backend**: 449 lines out of ~7,600. Dependencies point downward, `platform.rs` at the bottom.

| Module | Lines | What |
| --- | --- | --- |
| `lib.rs` | 449 | `run()`, `AppState`/`Session`, the tray mirror, the panic hook, `write_debug_file`/`log_frontend`, `confirm_quit`, and the `invoke_handler!` list |
| `tasks.rs` | 2,394 | runnable discovery — see Runnables above |
| `git.rs` | 1,532 | worktrees, branches, the working-set diff, the toolbar's fetch/pull/push, commit info |
| `usage.rs` | 819 | transcripts + the token ledger — everything read out of `~/.claude` |
| `pty.rs` | 705 | the four launch engines, `stream_pty_session`, the PTY lifecycle |
| `platform.rs` | 683 | OS leaves (top half) + OS integrations (bottom half) |
| `telemetry.rs` | 469 | `write_instrument_settings`, `run_telemetry_server`, `resolve_permission` |
| `external.rs` | 339 | the `~/.claude/sessions` registry, `ProcTable`, terminal focus |
| `icons.rs` | 184 | project favicon/logo probing |
| `testutil.rs` | 24 | `scratch_dir`, `cfg(test)` only |

Four conventions hold across them:

- **`AppState` and `Session` live in the crate root**, reached as `crate::AppState`. There is deliberately **no `state.rs`** — `run()` is their only constructor and it lives in `lib.rs`, so owner and definition stay together. Their *fields* need no visibility annotation at all (a private field is visible to the defining module and every descendant, and every module here is a descendant of the crate root); only the structs carry `pub(crate)`, and only to satisfy the private-in-public lint. Don't mix in a `state.rs` later.
- **`pub(crate)`, never `pub`** — including on a `#[tauri::command]` fn in a private module, which works. `tasks.rs` uses plain `pub` and reads like a counter-example but isn't: `mod tasks;` is private, so `pub` inside it is unreachable from outside the crate anyway.
- **`platform.rs`'s first half imports nothing from the crate.** That is exactly what lets every other module depend on it; the second half (the OS integrations) may, since `set_caffeinate` takes `State<AppState>`. **Don't let the first half grow a crate dependency.**
- **A cfg-gated helper with a single consumer module belongs to *that* module**, not to `platform.rs` — `apply_utf8_locale` and `interactive_shell` are `pty.rs`'s (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, and the leaf layer must not import `portable_pty`), `same_path` is `git.rs`'s.

`AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see External sessions), the held-open `pending` permission requests, and `caffeinate`.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `kind:"shell"` on the frontend `Sess` and skip telemetry/cost; `spawn_task` is the third entry point (see Runnables above).
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()` — add new `#[tauri::command]` fns there.

## Frontend (`src/`, `index.html`, `src/styles.css`) — 34 modules

**No framework, and no longer one file.** ~7,200 lines across 34 modules; `main.ts` is 642 of them and is **bootstrap only**. State lives in a `sessions: Map<session_id, Sess>` (owned by `state.ts`) plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing — follow this render-everything pattern rather than mutating DOM directly.

What `main.ts` still holds, deliberately: the imports and the whole of the `setXHost`/`setX` wiring (~70 lines — it is the seam map, and belongs in the file that owns the graph), the one-time startup blocks, `renderAll()`, every `listen()` handler, the delegated `[data-*]` click dispatcher and the global keydown, the ResizeObserver, the quit guard, the debug-console button wiring, and the nine `setInterval`s.

**Tested logic modules** (nine — no DOM, no Tauri, no render imports; these are what the 417 vitest tests cover, one `test/*.test.ts` per module bar `types.ts`, whose discriminants are exercised through the four suites that import it):

| Module | What |
| --- | --- |
| `types.ts` | the shared data model: `Sess`, `Phase`, and the one-line discriminants that read them (`isAgent`, `statusKey`, `PILL_TEXT`, `runElapsed`, `taskStateText`) |
| `format.ts` | durations, paths, escaping, sparklines, money and token counts — data in, string out |
| `diff.ts` | the unified-diff parser behind the working-set viewer (the extraction precedent) |
| `rl.ts` | account-wide rate limits: merging readings, burn rate, the window forecast |
| `usage.ts` | the `cc-usage` daily rollup, `uBuckets`/`uSum`, the day/token join |
| `phase.ts` | `applyHook` / `applyStatusline` — telemetry → session state. The heart of the display |
| `palette.ts` | ⌘K ranking: fuzzy match, scoring, prefix parsing, frecency |
| `grouping.ts` | what the sidebar shows and in what order; `urgencyRank`, `needsYou`, `nextAfterClose`, and the run-group fold (`foldRunGroups`, `groupPhase`, `nextInGroup`) |
| `tasks.ts` | the frontend half of Runnables: `stopRuleBlocked`, `launchWithDeps` (dep memoisation), `findDepCycle`, `applyRunner`, `${input:…}` glue |

**Shared**: `state.ts` (the session map, the stage pointer, every persisted preference) and `dom.ts` (`$`, `toast`, the shared scrim, `IS_MAC`/`MOD`/`chord`).

**Markup-only views**, untested by design: `usageview`, `inspectorview`, `sidebarview`.

**DOM-owning / render**, untested by design: `sidebar`, `footer`, `tray`, `inspector`, `debug`, `worktree` (the new-session dialog, the biggest single module at 932 lines), `settings`, `taskui`, `palui`, `projmenu`, `caffeinate`, `diffview`, `mirror`, `update`.

**Behaviour** — IPC and DOM all the way down, so untested too, and therefore the thinnest ice in the app: `panes` (the three spawners + a pane's lifecycle), `terminal` (the xterm plumbing), `taskrun` (run on stop), `actions` (the app-level verbs), `icons` (the per-project glyph store).

Four rules keep that graph honest. **There are no import cycles across the 34 modules; re-run a cycle check after any change that adds an import.**

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
  `attachCustomKeyEventHandler` call. (`macShellKeys`, also in `terminal.ts`, is the
  *shell* pane's handler; no pane is both, so the two never collide.)
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of `main.ts`. Telemetry is routed by `data.session_id?.toLowerCase()` — session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **Persistence is all `localStorage`**, ~20 keys prefixed `cc-` (favorites, drag order, colours, icons, engine, font size, sort/grouping, frecency, caffeinate, the `cc-usage` daily cost rollup, the `cc-restore` roster, and the task keys `cc-task-{prefs,pins,hidden,onstop,runner,inputs}` + `cc-trusted`). `grep '"cc-'` for the current set.
- **Debug console** (🐞 button, bottom-right): an in-app event log + live state via `dlog()`/`dbgSnapshot()`. It flags **unrouted telemetry** (the routing-drift class of bug above) and JS errors, and mirrors a snapshot to `$TMPDIR/cc-launcher/episko-debug.json` (written by the `write_debug_file` command) so an external tool or an LLM agent can read live app state while it runs.
- **Two-tier logging — live snapshot vs. durable timeline.** The `episko-debug.json` snapshot is a *state-of-now* blob that is overwritten each flush and does **not** survive a crash (the frontend never flushes if the process dies). The durable tier is the backend rolling `episko.log` (+ `panic.log`) in the OS app-log dir (macOS `~/Library/Logs/io.respeak.episko/`), via `tauri-plugin-log` and a panic hook — the only on-disk trace of a panic that unwinds cleanly out of `main` (no crash dump / WER otherwise). Every `dlog()` line tees into it through the `log_frontend` command (tagged `[ui]`), so the UI and backend event streams land in **one time-ordered file**. A `episko.log` that stops without an `exit · clean shutdown` line is itself evidence of an abnormal termination. Use the snapshot for "what is it doing *now*", the rolling log for "why did it *die*".

## Four launch engines, one telemetry path

`termEngine` selects where the terminal lives; the instrumentation (and thus the cockpit's telemetry) is identical for all:

- **embedded** — xterm.js pane inside the app (the only one that renders in-app).
- **ghostty** — external tinted window (`spawn_ghostty`).
- **terminal / iterm** — `spawn_external_terminal` writes an executable `.command` wrapper and hands it to `open -a`.

`available_terminals` reports which are installed so the UI only offers working ones.

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
- **The transcript folder is keyed by the *physical* workdir**, so `project_transcript_dir` canonicalizes before encoding (`physical_cwd`). This is not Claude being clever: `getcwd()` reports the resolved path however the process got there, so a session launched in a symlinked folder writes under the resolved encoding and under no other — encode the spelling the user picked and `list_past_sessions` returns empty, which reads as "no past sessions" rather than as a failure. On Windows the canonical form is verbatim (`\\?\C:\…`) and **must** have that prefix stripped or a currently-working path breaks; `strip_verbatim` is separated out precisely so that half is testable on a machine that can't produce one.
- **The roster is a convenience layer, not a system of record** — `/resume` inside Claude always lists every session for a folder, so nothing dropped or removed is ever lost. Keep UI copy honest about that, and don't build recovery machinery for a problem `/resume` already solves.
- **The stage has one owner:** `activeId` and the `mirror` pointer (`{kind:"ext"|"past"}`) are mutually exclusive — the read-only kinds share one discriminated pointer rather than a flag each. Timer-driven inspector repaints must bail on `mirror`, not just the external case. **`stageGroup` does not break this and must not become a third owner:** it names a tiled run group, but `activeId` still names the one *focused* pane, which is what the header, inspector, footer and keystrokes read. It is a modifier on the single-pane stage ("also show that pane's group siblings"), which is exactly why adding it changed no existing `activeId` consumer.

## Notes on scope & doc drift

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines, per-session CPU/RAM via `ps`, terminal-window focus. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic.

**`SPIKE.md` is a historical record and is not maintained.** It describes the Phase-0 spike — single-session, "observe-only" permissions, one file per side — and is kept because it is the record of where this started, not because it is true. It carries a banner saying so. Don't consult it for how the app works today, and don't edit it to match; `README.md` is current.

**Trust the code over the docs** when they disagree, and fix the doc in the same commit.
