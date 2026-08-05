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
render and DOM-owning modules are untested by design. Current: **90.47%** statements
over the modules the suites load, **21.3%** over all of `src/`, and **71.0%** Rust
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

Test coverage is **unit-only — there is no end-to-end harness**, but it is no longer thin: **755 vitest + cargo (162 on macOS, 158 on Windows — the platform tests are `cfg`-gated)**, both run in CI on both OSes.

**vitest runs in the `node` environment, so no module a test can reach may touch a browser global at module scope.** Not just `document`/`window`: `globalThis.navigator` only exists from **Node 21**, so a bare `navigator.userAgent` at module scope killed every suite that transitively imported that file back when CI pinned Node 20 — while passing on a dev machine with a newer Node. Node is now pinned once in **`.nvmrc`** (26) and read from there by both workflows and `nvm use`, so CI and local cannot drift again; the guard stays regardless, because the rule is about the `node` environment, not about which Node. Platform predicates therefore live in `dom.ts` (`IS_MAC`, `IS_WIN`), read once through a `typeof navigator === "undefined"` guard; import those rather than reading `navigator` again. `vitest` covers the pure frontend logic modules (`test/*.test.ts`, one file per module — see the frontend module map below for which nineteen those are), **plus two contract tests that parse source rather than call it**: `dispatch.test.ts` (a `[data-*]` branch is unreachable unless its attribute is in the dispatcher's `closest()`) and `ipc.test.ts` (an `invoke("x", {…})` must pass exactly the arguments `#[tauri::command] fn x` declares). Both guard joins no compiler can see, and both exist because that join had already silently broken in production; the Rust tests are `#[cfg(test)] mod tests` **in-file**, next to their subject, several of them real integration tests that drive `git` against temp repos or the real `tiny_http` telemetry server against a mock app. There is deliberately no `src-tauri/tests/` directory: it would only see the crate's public API, which here is `run()`.

What is **untested by design**: the render, view and DOM-owning modules on both sides of the app — snapshotting template literals mostly re-asserts itself. Anything touching the DOM, PTYs, or live telemetry is still verified by **running the app and exercising it** — the statusLine half of telemetry only fires in interactive mode, so it cannot be checked end to end with `claude -p`. Split that one carefully, because the split is not where it looks: whether the generated statusLine command *works* is checked headlessly and in CI (the shell runs it for real — see the constraint above). What needs a live REPL is only whether **Claude still picks the shell and payload we expect**. That costs a TTY, not tokens: a session you launch and never prompt makes no API call, and the statusLine fires on start and every `refreshInterval` seconds regardless. It's a `RELEASE.md` click-through, and a cheap one. `tsc` (strict) is the real linter. Requires `claude` on PATH, the Node in `.nvmrc` (`nvm use`; `engines` floors it at 24), and Rust stable + Tauri system deps.

CLI *mechanics*, though, often can be checked headlessly — drive `claude -p` against a **throwaway** session in a temp dir and inspect the resulting `.jsonl` (never a real session: resuming appends to it). That is what `claude_cli_still_honours_our_instrumentation` (`telemetry.rs`) does: it runs the real binary and asserts Claude Code's hook schema and transcript layout still match what this app reads. It is **not** in CI — it needs auth and spends tokens — and is run via `cargo test -- --ignored` as part of `RELEASE.md`'s checklist. It is one of **two** `#[ignore]`d tests, and the other one is cheaper than its gating suggests: `claude_cli_still_accepts_every_permission_mode_we_offer` (`pty.rs`) spends no tokens and needs no auth (`--version` short-circuits *after* the CLI has validated the flag), and is `#[ignore]`d purely because CI has no `claude` binary. Both run in the same `--ignored` pass, so the checklist gains nothing to remember.

**`RELEASE.md` holds the manual release procedure** — what CI already guarantees, the click-through for the OS edge, and the tag/verify steps. Anything that can only be checked by running the app belongs there, not here.

## The core mechanism: per-launch instrumentation

This is the one idea that makes the whole app work; everything else hangs off it.

On every launch, the Rust backend (`write_instrument_settings`) generates a throwaway `--settings` file at `$TMPDIR/cc-launcher/instrument-<uuid>.json` containing a `statusLine` command and `hooks` for the full session lifecycle. Each hook/statusLine is a shell command that POSTs its JSON payload to a **localhost `tiny_http` server the app bound to an ephemeral port at startup**. Claude is then spawned as `claude --session-id <uuid> --settings <file>`, so:

- Every event carries the `session_id` we chose, letting the frontend route it to the right pane **before any output appears**.
- No global `~/.claude` mutation and no transcript-file parsing — instrumentation is entirely per-launch and disappears with the temp file.

**Route by the stable launch id, never Claude's runtime `session_id`.** Claude mints a *new* `session_id` on `/clear`, `/compact` and `/resume`, so the payload's `session_id` drifts away from the uuid we launched with — after which telemetry would route to nothing (inspector freezes) and the `SessionEnd` fired at the rotation would leave the pane showing the "ended" `·` glyph while the process runs on. So every hook/statusLine POST is tagged with our stable uuid via an **`X-CC-Session` header** (and the blocking permission hook via **`?sid=`**, since it's `type:"http"` with no shell to add a header). `run_telemetry_server` reads that and *forces* it onto the payload's `session_id` before emitting. As a backstop, the frontend un-ends any session that keeps receiving statusLines (a statusLine only fires from a live REPL).

Three hard constraints shape this code:

- **Claude runs hooks/statusLine with a stripped PATH.** Generated commands use absolute `/usr/bin/curl` and `/bin/cat`, never bare `curl`. Likewise `resolve_claude()` probes known install locations (and falls back to the login shell) and `augmented_path()` rebuilds a usable PATH, because a GUI app launched from Finder also gets a stripped PATH.
- **The hooks run no shell; the statusLine cannot avoid one.** A command hook takes an **exec form** — `command` (the binary itself) plus an `args` array, each element delivered verbatim — so the hooks spawn `curl` and nothing else. That is not a tidy-up: the shell form they replaced was pinned to `"shell": "powershell"`, so *every* PreToolUse, PostToolUse, Stop and Notification of every session paid a whole PowerShell launch (~220 ms, plus a second process) to reach curl. The statusLine gets no such escape — Claude Code defines neither `args` nor `shell` for it and routes it through **Git Bash whenever Git Bash is installed** (else PowerShell) — so that one command must still parse in *either* shell: no `&` call operator, no `$null`, no `Write-Output`, and forward slashes, which Git Bash won't eat as escapes. Get that wrong and there is no error and no lost hook — just every figure the statusLine carries (model, context %, cost, duration, **and the account-wide rate limits**) gone at once, while the hooks keep phases flowing and the pane looks healthy. That shipped once.
  **Neither half can be checked by reading the generated JSON** — such a test agrees with our intent, and the intent was the bug — so both are *executed* against a mock telemetry server, for no tokens and no Claude: `statusline_command_posts_from_every_shell_claude_might_pick` runs the string through every shell Claude might pick, and `hook_exec_form_posts_without_any_shell` spawns the hook's argv directly. The two guard opposite hazards, which is why neither replaces the other: a shell might not *parse* our string, whereas with no shell nothing strips quotes or splits words, so an argument written the way you'd write it for a shell (`'X-CC-Session: …'`, or `-H foo` as one element) reaches curl with the quotes still on it. Both failures are silent — `-s` keeps curl quiet and `async` means Claude never waits.
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

**An input is a second verb, not a toll on the first.** Running a task is the common
case and must not cost a dialog, so *Run* goes through `prefillInputs` — what you
typed last for that exact input (`cc-task-inputs`), else the definition's own
default, else empty for an `optional` one — and only opens the prompt when an input
has no answer anywhere. Changing the values is the deliberate act, so it gets its own
button: `⋯` on the picker row (⌥⏎), *⋯ Parameters* in a finished run's inspector.
Every surface routes through `runRunnable` so the two verbs cannot drift apart, and
the row's tooltip shows the command *as prefilled* — a value reused silently is fine
only while it is also visible.

**`optional` exists because `just` has two variadics and they are opposites.** A
`*name` takes zero or more, so the recipe is complete without it; a `+name` wants at
least one and `just` refuses the recipe without it. Reading both as required is what
put a prompt in front of every run of a `*args` recipe. VS Code declares no such
thing, so its inputs are never optional. It is also the one thing `stopRuleBlocked`
softens on: an input that can answer itself is not a prompt, and refusing a rule over
a dialog that never opens would be a lie about the reason.

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
  whose `${input:…}` still needs a person (it would block on a dialog nobody opened —
  one that can answer itself from a default or is `optional` is fine, and the launch
  goes through `prefillInputs` so no placeholder ever reaches a command line), and a
  blocked one.
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

Two later kinds are worth knowing about because they set the precedent for anything
with a *feel* rather than a value: **`wtpreview`** (a pick shown as live mini-sidebars)
and **`peek`** (steppers over a preview you hover). Both build their preview from the
app's own CSS and, in `peek`'s case, its own reducer — the rule being that a preview
which restates the thing it previews will drift from it, and then reassure you about
behaviour the app no longer has. A setting whose right value can only be *felt* should
ship with something to feel it on rather than a number in a box.

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

## Releases and the changelog (`CHANGELOG.md`, `scripts/changelog.mjs`)

**`CHANGELOG.md` is the only place release notes are written**, and it has three
consumers that must never disagree: the app's *What's new* screen parses it
(`changelog.ts` → `changelogui.ts`), `release.yml` lifts the tag's section into the
GitHub release body, and `ci.yml` refuses a `dev → main` pull request whose
`## Unreleased` section has no entries.

- **The app ships the file, it does not fetch it.** A `?raw` import bundles it at build
  time, so the screen works offline and **a build can only ever describe itself** —
  fetching the releases API would let a newer entry describe a version the user is not
  running, which is worse than showing nothing.
- **The gate is on the PR, not the tag.** A tag that fails has already had the decision
  to ship made behind it; a PR check fails while the fix is one command. `pnpm changelog
  draft` writes the section through Haiku and **stops** — it never commits, and the gate
  checks only that the section is non-empty, never that a model wrote it. A gate
  demanding generated prose would make writing your own notes a CI failure.
- **Three markers, not six headings**: `+` new, `~` changed, `!` fixed. Keep-a-Changelog's
  sections force a judgement call per line and leave headings with one bullet under them.
- **A section with no entries and no lede is dropped at parse time**, and that is not
  tidiness: `changelog release` opens a fresh empty `## Unreleased` and the tag builds
  from that state, so **every released build ships one**. Kept, it rendered as a "next"
  row in the rail that opened on a heading, the words "not released yet", and nothing
  else. Whether `## Unreleased` is non-empty stays a *branch* policy enforced by
  `changelog.mjs check` on the PR — that script has its own parser, so this does not
  weaken the gate.
- **`inlineMd` renders bold, italic and code, and the ordering is load-bearing.** Bold
  runs first and must tolerate a `*` inside it, or an entry with italics nested in bold
  is skipped entirely — 0.13.6 shipped one and it showed raw asterisks with no bold.
  Italic then runs *inside* what bold produced, anchored on a run with no `*` so an
  unpaired marker (`2 * 3`) is left alone. It lives in `changelog.ts`, not the DOM
  module, because it is string-in-string-out and therefore the half of the dialog that
  can be tested — where it used to live, the missing italic rule went unnoticed through
  nine releases of a file that uses italics constantly. The lede goes through it too.
- **`shouldAnnounce` opens once per released version, and the record is a set.**
  `cc-seen-versions` lists every version *What's new* has been opened for here (0.13.0's
  single-value `cc-seen-version` is still read once and folded in), so a version already
  read stays shut even after running a newer one, and a build with no section — a local
  dev build — is silent because the screen would open on nothing.
- **It used to have a fresh-install guard, and that guard is why 0.13.0 shipped silent.**
  It keyed on the seen-record being absent — but the release that *introduces* a
  seen-record is precisely the one where every existing install has none, so the version
  that shipped the feature was the version nobody was shown. Rescuing it means guessing
  whether the rest of `localStorage` looks "used", and that guess was measured wrong
  twice: `cc-icons`, `cc-icons-v` and `cc-restore` are all written during a first boot,
  `cc-restore` before `changelogui` is even imported. It also cannot be unit-tested — it
  depends on module import order across the whole app graph — so it would rot silently,
  in the direction of hiding the feature. **Don't reintroduce it.** The cost of living
  without it is that a first-time user sees the notes for the version they installed,
  once, which reads as an introduction and is one Esc away.
- **The release body is assembled in a step, not inlined in YAML.** A multi-line `${{ }}`
  inside a literal block indents only its first line and silently mangles the rest, which
  is why the install text lives in `.github/release-install.md` and is concatenated.
- A tag with no matching section still releases — the notes say so. Failing the build
  after the decision to ship is the thing the PR gate exists to prevent, and doing it
  anyway at tag time would just move the problem.

## The project dashboard (`dash.ts`, `dashview.ts`, `dashboard.ts`)

**Left-clicking a project opens it.** That click used to select whichever session
sorted first, so one gesture meant two different things depending on state, and "what
is going on in this repo" lived in a right-click menu nobody opens. The sessions are
the rows directly beneath the header; this is the header's own answer.

**Every header, whatever put the project in the list** — `renderSidebar` builds three
shapes (has sessions / favourite / discovered) and for two releases only the first two
carried `data-dash`, so a folder known only from an external session, only from past
ones, or from a worktree whose session had ended was inert on click. Nothing refused it;
the attribute was absent, so `closest()` returned null and the handler returned before
the branch written for it — the same silent shape `test/dispatch.test.ts` guards the
*other* half of. "Has an Episko session or is a favourite" is not a fact worth gating a
view on, and the empty-but-real dashboard those folders get is the answer.

**The key is `repoRoot ?? path`, because a checkout is not a project.** `splitByWorktree`
mints one group per worktree keyed by its checkout dir, and `dashDays` filters history
through `histProject`, which regrafts every row onto the repo root — so a dashboard keyed
by a worktree dir matches no sessions at all and renders a timeline of commits nobody
appears to have worked on. Splitting is the only thing that severs a group from its
project, so `splitByWorktree` now carries `repoRoot` for whatever needs to get back.

The split is `graph.ts`/`graphview.ts` again: **`dash.ts` is pure and tested**
(`projectTier`, `dashDays`, `dashPulse`, `projectCost`, `densePerDay`), **`dashview.ts`
takes data and returns a string**, **`dashboard.ts`** owns the pane, the IPC, the
summary queue and the delegated events. It rides the same `mirror` pointer as the
read-only session mirrors (`kind: "dash"`) rather than adding a second flag every
`activeId` check would have to be paired with.

**Nothing runs until a project is clicked.** No probe at startup, nothing on
`renderAll`'s path — a dashboard that cost anything to *not* open would tax every
session in the app for a view most ticks never show.

**Three gates decide what it can show, and they are not the same gate** (`projectTier`,
from one `project_facts` call):

- **GitHub** — issues, pull requests, claims. All `gh`, all still to come.
- **git** — the commit half of the timeline, the checkouts card, and *everything
  shared*: `.episko/` only means anything if it can be committed, so **sharing needs
  git, not GitHub**. A GitLab or self-hosted remote is this tier, which is why
  `parse_remote` mints a slug for `github.com` and nothing else — but **the host in a
  remote URL is not necessarily a hostname**. Someone with two GitHub accounts keeps
  them apart with an `~/.ssh/config` `Host github.com-work` alias, and it is the alias
  that lands in the URL, so a string match files a GitHub repo under "no GitHub" for
  exactly the people with the most repos. `ssh -G <name>` answers it (config only, no
  connection; an unknown name echoes back), memoised for the process. That is also a
  test trap: `git remote get-url` applies the developer's `url.*.insteadOf` rewrites, so
  a fixture naming a real owner can come back rewritten — fixtures use `example-org`.
- **neither** — sessions, spend and personal notes. None of those ever cared about git.

A card with nothing to say is **absent, not empty** — an "Issues" panel in a folder
that has no issues reads as breakage — and `missingCard` says once, plainly, what this
folder cannot do instead.

**And a card not read yet is neither**, which is what the skeletons are for. Opening a
project is a whole-machine transcript scan, three git calls, and then two `gh` calls
*after* those; every one of them used to land in silence, so "nothing here" and "not
read yet" — opposite answers — looked identical, and the strip led with a confident row
of zeros. Four things about that are worth keeping:

- **The waits are separate flags on purpose.** `loading` (the local reads), `ghLoading`
  (the GitHub half, which starts later and ends later) and `writing`/`stage` (the model
  calls) each darken a different surface. One `isLoading` over the lot would skeleton
  something that already has its answer.
- **`factsKnown` is not `loading`.** It asks whether `project_facts` has answered *for
  the project on screen*, and it is what the inspector's repo verbs and the `not a repo`
  chip hang off — because `tier` defaults to `none`, which is an assertion, not an
  absence. Keeping it separate is what stops a range change (which reloads the timeline
  but settles nothing about the tier) blinking ⑃ and ⑂ off and on.
- **Every write in `loadDash` is guarded by `root() !== r`, including `loading` itself.**
  Two awaits, and a click on another project during either one leaves a continuation
  that would otherwise land the previous folder's answers under the new folder's name —
  or clear the new load's skeletons while it is still running.
- **A pending sentence is not an absent one.** Your day already has a deterministic
  headline that reads correctly, so waiting is a mark *beside* it; the shared box has no
  such stand-in, so that one is a real skeleton. The shimmer and spinner are the usage
  screen's `.u-skel`/`.u-spin` — a second loading vocabulary is a second thing to keep in
  step.

Three things that are easy to get wrong:

- **Per-project cost comes from `cc-usage-detail`, never `cc-usage`.** The plain rollup
  is every project's spend that day at once, so attributing it to whichever dashboard
  is open would invent a number. The detail split only exists going forward, so older
  days legitimately have none, and the strip shows a dash rather than `$0.00` — "we
  didn't keep this" and "it was free" are different facts. `DayDetail` also carries a
  **per-session** `sess` map, which the footer's spend popover (`daySpend` →
  `costPopHtml`) reads; it replaced a `sessions: string[]` that recorded *which* ids
  contributed but not what any cost, and was therefore write-only for its whole life.
  **A split can fall short of the day's total, and each split falls short separately** —
  `cc-usage` banks the day's money from the first dollar, while a split introduced by a
  later build starts from whatever is spent after it lands. That makes **the day you
  upgrade** the ordinary case, not an exotic one: the projects list can be complete while
  the sessions list covers only the afternoon. So `daySpend` gives **both** lists their
  own `unattributed` row rather than dropping the difference — a list that summed lower
  than the footer segment that opened it would read as money going missing. A split with
  *nothing* in it stays empty instead, and the reader says the day predates the record:
  one anonymous row claiming the whole day reads as a session nobody can identify. The
  half-cent floor is not tidiness either — both figures are sums of the same deltas in a
  different order, so a fully attributed day still differs in the last place.
- **The list drops empty days and the sparkline must not.** `trailDays` omits a day
  nothing happened on (a column of blank rows reads as broken); `densePerDay` fills
  them back in, because two busy days a week apart otherwise render as two adjacent
  bars and read as "constantly busy".
- **The header's four verbs act on the dashboard's project, not on a session.**
  `activeProjectCtx`/`activeCwd` (panes.ts) answer for the dash mirror as well as for a
  session, external or dormant one, so ＋ Session, ❯ Terminal, ▶ Run and ◷ History —
  and everything else keyed off those two, ⌘T/⌘⇧R/⌘⇧H/⌘⏎ included — treat the project on
  screen exactly as they treat a session's. `＋ Session` opening ⌘K instead was the odd
  one out: it asked which project when the answer was the header it was in.
  `requestLaunch` decides "repo, so offer the worktree dialog" from three **zero-IPC**
  signals, and all three only cover a folder something is *running* in — which a
  dashboard is precisely not. Hence `dashLaunchHint()`: the dashboard already bought
  `project_facts` and `worktree_heads` for this folder, so the answer is passed in
  rather than asked for again, and the click stays synchronous (see the comment on
  `requestLaunch` for why nothing may be awaited before that dialog is on screen).
  **The inspector's ＋ is that same call**, and there is only one of it. It used to be a
  bare launch in the project root sitting above a separate *New worktree session…*, so
  which row you wanted depended on knowing whether the folder was a repo — a question
  the dashboard has already answered on screen, and the dialog asks anyway. One ＋ that
  means "start a session here" and opens the dialog when there is a branch to pick is
  the whole verb; `dashInspector` keeps the ellipsis only on a repo, since on a plain
  folder it launches outright and an ellipsis that opens nothing is a lie. `DashHost`
  therefore carries **both** `launch` and `requestLaunch`: a dispatch has already decided
  where it is going, a person clicking ＋ has not.
- **⌘I collapses to a 44px rail here, not to nothing.** The dashboard's own verbs — the
  worktree dialog, the commit graph, the folder, the live-session strip — exist only in
  the inspector, so hiding the panel outright would hide real verbs. On a session ⌘I
  still hides it completely.

### The GitHub half

`ghwork.ts` owns the rules and is tested; `claim.ts` owns what a dispatch writes.
`gh_threads` is two `gh` calls per repo, cached 60s, and **degrades rather than
failing**: gh missing, logged out or pointed at a non-GitHub folder is `available:
false` plus a reason, shown as one quiet row like a blocked runnable.

- **A claim is a hint, never a lock.** Nothing refuses a dispatch; someone else's claim
  is shown, warned about once, and then you proceed — two people may well both want a
  go at a hard bug. Claims expire (`CLAIM_STALE_MS`), because a laptop that slept must
  not block a colleague forever, and a `pty-exit` releases whatever that session took.
- **Two levels decide what gets written, and the project is a ceiling**: your
  preference, ANDed with `.episko/episko.toml`'s `[claim]`. A switch the project turned
  off renders greyed rather than hidden — "why can't I assign?" needs an answer.
- **`holderOf` reads three signals in one order and it is not arbitrary**: our own
  ledger first (it knows a dispatch nothing has been pushed for yet), then the assignee
  (the explicit human signal), then an `agent:` label (a machine, which cannot say
  whose).
- **Triage never offers a pull request**, never offers an assigned issue, and never
  offers one on the project's keep list. A quiet PR needs review or a rebase, not
  closing; the rest is a bot second-guessing a human, which is what makes a team switch
  triage off.
- **`gh_close_issue` is the only destructive write**, and it comments *before* it
  closes: if the close then fails the issue carries a note explaining what was
  attempted, which is recoverable, where the other order leaves it closed with no
  explanation.
- **Dispatch sends the prompt**, which breaks the app's usual "Episko prefills, the
  human presses Enter" rule — deliberately, and only here: that rule exists so nothing
  is sent you did not read, and a dispatch confirmed in a sheet *is* the reading. A
  colleague's shared note is still prefilled-not-sent: that is somebody else's sentence.
  **Both halves need the session id back from `launch`**, which is why `panes.ts`'s
  returns `string | null` and `DashHost.launch` is typed to match rather than
  `Promise<unknown>`. It returned nothing at all under that `unknown` for a release: the
  pane opened, `typeof sid !== "string"` was permanently true, and every dispatch said
  *Could not start a session* while starting one — no prompt, no claim, and a note eaten
  on the way past. **A hook typed `unknown` whose callers narrow it is the whole bug**;
  `tsc` is the only thing that can catch this class, so type the seam, not the call site.
- **The Enter that sends it must be its own `write_pty`.** Claude's REPL reads a burst
  arriving in one chunk as a **paste**, and a `\r` inside a paste is a newline in the
  buffer, not a submit — so `text + "\r"` in a single write left the prompt sitting in
  the input box waiting for the human this path exists to spare. Verified against the
  real CLI, not reasoned about: one write does not submit, text then a lone `\r` a beat
  later does. Anything else that means to *send* rather than prefill inherits this.
- **Pass every argument a `#[tauri::command]` declares, including the ones a flag turns
  off.** Tauri rejects the whole invoke on one missing key, so an omitted argument is
  never a partial call — it is no call. `gh_claim` went out without its `body` (and with
  a `pushBranch` the command never took) for three releases: every dispatch was rejected
  before `gh` ran, so no assignee, no label and no comment ever landed, while the
  dashboard said *Started on #232* and the only trace was a `dlog` warning. `gh_release`
  had the same defect behind a bare `.catch(() => {})`. **`test/ipc.test.ts` compares the
  two halves in both directions** now, and the outcome is read rather than discarded — a
  claim that half-lands says so on screen, because a claim that silently wrote nothing is
  worse than none: the dispatcher believes the work is marked and a colleague takes it
  anyway, which is the blind window `claim.ts` exists to close.
- **The viewer is cached for the process, not per repo.** `gh api user` returns the
  same login whichever folder it runs in, so keying it by root spent a process per
  project for an answer already in hand.

**Three committed files, one rule.** `.episko/digest.md` (the work log),
`.episko/episko.toml` (`[triage] keep`, beside `[claim]`) and `.episko/notes.toml` (a
promoted note) are all **project facts** — decided once, by anyone, and true for the
team. All three go through `toml_edit`/read-modify-write so a hand-written comment
survives, all three refuse to create themselves without an explicit yes, and all three
need **git, not GitHub**: they are files, and a file only means anything to a team if
it can be committed.

**A day gets TWO generated sentences, and the split is what makes one of them
committable.** They are not one prompt over different facts — `Scope` in `summarize.rs`
picks a different instruction as well as a different record, because a model told it is
reading a developer's day will narrate an afternoon out of a list of commit subjects:

- **Yours** (`dayFacts`) — your session titles and your spend, read from *this* machine's
  `~/.claude` and `cc-usage-detail`. Nobody else can reproduce it, so it never reaches a
  file: it lives in `trail-summaries.json` in the app config dir, and it is the day's
  headline.
- **The project's** (`projectDayFacts`) — commit subjects, authors and PR events, which
  everyone with the checkout has. Same facts for the whole team, therefore safe to
  commit, and this is the half `.episko/digest.md` holds.

Committing the *mixture* is the bug this split fixes, and it would never have looked like
one: two people summarising the same day hand Haiku different records, `write_digest`
replaces the day's key, and the committed line becomes whoever wrote last describing
their own half. It reads perfectly well. It is just not the day. Keeping the private half
out is also what keeps `spend: $58.23` out of a file that gets pushed.

**Written for every day, shown for some.** Every closed day with commits is generated and
committed — a colleague reading `digest.md` wants the project's whole history, solo days
included. Display is the narrower question and `sharedDay` answers it: the box appears
only when more than one *human* committed (`isBotAuthor` — a `[bot]` tagging a release is
not company). On a solo day it would restate the line directly beneath it. `sharedDay`
deliberately does **not** ask "did somebody *else* commit": that needs to know who you
are, and `%an` against `git config user.name` breaks on a second machine, a different
spelling of your own name, and every co-authored commit.

**The work log is the one thing Episko generates and then commits.** `summarize_day`
spends money (one `claude -p` per day per scope, Haiku), so it is cached, opt-in, and
**read before it is generated**: `read_digest` parses `.episko/digest.md` first, which
means the second person to open a week pays nothing for the shared half — so on a team
repo the split is *cheaper* in aggregate than one sentence per person was. Writing it is gated on an
explicit per-project yes (`cc-digest-ok`), because a new committable file in someone's
repo is a real side effect — the same stance `tasks.rs` takes with `tasks.toml`. This
is the **third** thing Episko writes outside its own config, after `.episko/tasks.toml`
and the `~/.claude` transcript move. Only a *closed* day is written: today's line
changes as the day goes on, and each change would dirty a tracked file.

## Project history — the commit graph panel (`git_graph`, `graph.ts`, `graphview.ts`)

A project's lanes, refs and recent commits, opened from the **project right-click menu**
(`Commit graph…`) and from nowhere else. That placement is the design, not a shortcut:
history answers a question you go looking for, so it earns a menu row rather than
header space, and the row is dropped when the folder isn't a repo (one `git_head` probe
already answers that for the worktree row beside it).

**The invariant is "never read a whole history", and it holds at both ends.** Nothing in
either module runs until that row is clicked, so app start and `renderAll()` are
untouched. The panel then reads ONE page — `git log --skip=<n> -n <PAGE+1>` — and asks
for the next only when the reader scrolls near the end of what it has, so a 300k-commit
monorepo costs the same first paint as a week-old repo. Four consequences worth keeping:

- **`more` is an observation, not a count.** The command asks for one commit past the
  page and reports whether it was there; counting commits would mean the walk this
  command exists to avoid.
- **`--date-order`, not `--topo-order`.** Both keep a child ahead of its parents, which
  is all the layout needs — but paging by recency means page 1 must be the newest
  commits *across* refs, and topo-order pulls a stale branch's whole chain forward to
  keep it contiguous.
- **`--decorate=full`.** Short ref names can't be classified (`feat/x` and `origin/x`
  are the same shape), so `parseRefs` reads `refs/heads/…` / `refs/remotes/…` /
  `refs/tags/…` instead of guessing.
- **Not a repo → `Err`; a repo with no commits → an empty page.** git is inconsistent
  here (`log --all` exits 0 on an unborn HEAD, a bare `log` calls it fatal), and the
  panel has to tell the two apart.

The split is diff.ts/diffview.ts again: **`graph.ts` is pure and tested** (lane
assignment, lane naming, ref chips, geometry, the row SVG — `sparkline`'s shape),
**`graphview.ts` owns the dialog**, the IPC and the scroll. `layoutGraph` runs over the
whole accumulated list after each page rather than incrementally: it is cheap, and it is
what keeps the lanes consistent across a page boundary without mutable state living
between fetches.

**Naming the lanes is where the subtle wrongness lives**, and all three rules below were
observed being wrong on this repo's own history before they were rules. Eight coloured
lines are unreadable without them, so each row carries `label` (what line it is on) and
`merged` (what it took in), surfaced as the node's tooltip and a line in the detail strip:

- **A row's label is the nearest ref *above* it on its own line, not the line's first.**
  When a feature branch's tip is simply the newest commit, the top of `dev`'s line
  carries that feature's ref — "first ref on the line" then labels half of dev's history
  with a branch cut from it.
- **A tag never names a line.** A label propagates down every commit below it, so
  accepting `v0.11.1` would read as a lineage that never existed. Tags stay chips.
- **What a merge took in is read from a ref *below* it** (its commits are older than the
  merge), falling back to the merge subject — which is the last place a merged-and-deleted
  branch's name survives, and is therefore marked `from: "merge"` and attributed in the
  wording. `mergeBranchName` matches only git's and GitHub's own phrasings; prose names
  nothing, and a guessed lane name is worse than a blank one.

**The chips are reduced, not just listed** (`refChips`), because a branchy repo puts
four or five refs on one commit and the raw list was wider than everything else on the
row: a local branch **absorbs its remote twins** (`main` + `origin/main` is one `main ⇡`
chip, where the glyph means "also pushed"), a remote with no local counterpart keeps its
`origin/` prefix because that prefix *is* the difference, **`origin/HEAD` is dropped** as
a symref that always duplicates a sibling, the order is fixed **HEAD → local → remote →
tag** (git's own order is not stable across repos, and the leftmost chip is the one that
survives a narrow column), and the tail folds into a **`+N`** chip. Chips never shrink —
flex would turn a 3-character `dev` into `dev…` to buy a long neighbour pixels it can't
use — so each has its own ceiling with an ellipsis, and the column *fades* its overflow
rather than slicing a name mid-word. Inside a chip, **only the name truncates**: the `⇡`
sits in its own non-shrinking span, because a long branch losing the marker loses the one
thing the collapse added.

Three layout couplings to respect. **`.grow`'s CSS height must equal `ROW_H`** — lanes
are drawn edge-to-edge per row, so any disagreement shows as a break at every boundary,
which is also why nothing may add to a row's box (the selection is a background and an
inset shadow, never a border). **The trailing columns are fixed-width on purpose**: each
row is its own grid, so `auto` would let every row size to its own author name and the
sha/date columns would stagger. And **the graph and the chips are ONE measured cell**
(`sizeLeftColumn`): each row's SVG is drawn to its own `span` — the lanes *that row*
touches, pass-throughs included — so the chips land against the graph's real silhouette,
and only the block as a whole is pinned to a common width. Sizing the two separately is
what put ~100px of empty column between a 2-lane row and its label in a 12-lane repo,
and it is why the labels sit beside the lanes at all: a label belongs to the *line*, and
inside the message column it reads as clutter attached to the wrong thing.

**A row shows a subject; a commit message is prose.** So the strip below the list is a
two-line *summary* — the commit (chips, subject, `⤢`) then its metadata (lane, author,
date, a short sha that *is* the copy button, parents) — and the whole commit opens in an
overlay *inside* the dialog (`⤢`, ⏎, or a double-click).

**The message is fetched per commit (`git_commit_message`), not carried by the page.** It
was a `%b` field on every commit once, which forced a length cap so 60 bodies wouldn't
cross IPC as half a megabyte of JSON — and the cap then truncated the one message somebody
had opened to read, which is the only message that was ever going to be read. One commit
is open at a time, so one `git show -s --format=%B` answers it, cached by sha so ↑/↓ and
back doesn't re-ask. The command refuses anything that isn't a hex object name: the sha
goes to git as a revision argument, where a leading dash would be read as an option. It covers the list rather than
being a second modal, so the graph stays behind it, ↑/↓ still walk commits with it open,
and **Esc steps out one layer at a time** — which is why main.ts calls `graphEscape` and
not `closeGraph`. Closing it takes no mouse travel **by construction**: the
strip's `⤢ Full message` and the overlay's `✕ Close` share one footprint (`.gswap` — same
width, same height, both hard right on the last line of their bar, and `.graph-detail`'s
64px height is what makes the two land on the same pixels), so the button that closes a
message appears exactly where the pointer already is. The header keeps a compact ✕ too,
and Esc does the same thing. A body wrapped into a 40px box inside the footer was the version before
this, and it left half the width empty while still being unreadable; a full 40-character
sha on its own line was the loudest thing in the panel, and it also went.

**One naming trap, since it cost a visible bug:** `gc-*` is the *ref-chip kind* prefix
(`gc-head`, `gc-branch`, …), so the commit overlay's own classes are `gco-*`. Calling its
header `.gc-head` gave every HEAD chip in the panel a header's `padding: 9px 13px` — a
chip you could see was wrong but not say why.

**What a narrow panel gives up, it gives up in order.** The collapse is CSS container
queries on the dialog (not viewport media queries — the panel's own width is what the
table lives in): the relative date shortens first (`2 days ago` → `2d`, both forms
rendered, CSS picks), then the sha column goes, then the author and the header path. The
subject is never the column that yields, which it *was* — an `fr` track gives up space
before any fixed one, so a rigid left block made the message vanish first in a narrow
window. It is now `minmax(0, var(--gleft-w))` with a floor under the subject, and the
measured cap is also bounded by a share of the panel width, which is the one rung of the
ladder that lives in JS (`sizeLeftColumn`, re-run on resize).

Lane colours are `--gl-0…7`, re-stepped for the light theme like every other palette in
`styles.css`. Scope (`all refs` / `this branch`) resets on each open and is deliberately
**not** persisted — all-refs is the answer the panel exists to give.

## Backend (`src-tauri/src/`) — thirteen modules

`main.rs` only calls `episko_lib::run()`. `lib.rs` is **bootstrap, not the backend**: 577 lines out of ~12824 (the counts below are whole files, in-file `#[cfg(test)] mod tests` included — that is most of `telemetry.rs`). Dependencies point downward, `platform.rs` at the bottom.

| Module | Lines | What |
| --- | --- | --- |
| `lib.rs` | 577 | `run()`, `AppState`/`Session`, the window (see One title bar), the tray mirror, the panic hook, `write_debug_file`/`log_frontend`, `confirm_quit`, and the `invoke_handler!` list |
| `git.rs` | 2,891 | worktrees, branches (local **and** remote-only), the working-set diff, the paged commit graph, the toolbar's fetch/pull/push, commit info |
| `tasks.rs` | 2,399 | runnable discovery — see Runnables above |
| `usage.rs` | 1,685 | transcripts (incl. History's whole-machine scan) + the token ledger — everything read out of `~/.claude` |
| `pty.rs` | 1,071 | the four launch engines, the permission-mode whitelist, app-wide disk I/O, `stream_pty_session`, the PTY lifecycle |
| `telemetry.rs` | 927 | `write_instrument_settings`, `run_telemetry_server`, `resolve_permission` |
| `platform.rs` | 752 | OS leaves (top half, incl. `norm_path`/`physical_cwd`) + OS integrations (bottom half) |
| `external.rs` | 588 | the `~/.claude/sessions` registry, `ProcTable`, terminal focus |
| `github.rs` | 828 | `gh` — issues/PRs, the claim writes, closing, the committed keep list |
| `notes.rs` | 175 | shared notes (`.episko/notes.toml`) |
| `summarize.rs` | 561 | `summarize_day` (Haiku via `claude -p`) over both `Scope`s + the committed `.episko/digest.md` |
| `icons.rs` | 314 | project favicon/logo probing + the tray menu's status glyphs (`glyph_rgba`) |
| `testutil.rs` | 50 | `git`, `scratch_dir`, `cfg(test)` only |

Four conventions hold across them:

- **`AppState` and `Session` live in the crate root**, reached as `crate::AppState`. There is deliberately **no `state.rs`** — `run()` is their only constructor and it lives in `lib.rs`, so owner and definition stay together. Their *fields* need no visibility annotation at all (a private field is visible to the defining module and every descendant, and every module here is a descendant of the crate root); only the structs carry `pub(crate)`, and only to satisfy the private-in-public lint. Don't mix in a `state.rs` later.
- **`pub(crate)`, never `pub`** — including on a `#[tauri::command]` fn in a private module, which works. `tasks.rs` uses plain `pub` and reads like a counter-example but isn't: `mod tasks;` is private, so `pub` inside it is unreachable from outside the crate anyway.
- **`platform.rs`'s first half imports nothing from the crate.** That is exactly what lets every other module depend on it; the second half (the OS integrations) may, since `set_caffeinate` takes `State<AppState>`. **Don't let the first half grow a crate dependency.**
- **A cfg-gated helper with a single consumer module belongs to *that* module**, not to `platform.rs` — `apply_utf8_locale` and `interactive_shell` are `pty.rs`'s (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, and the leaf layer must not import `portable_pty`), `same_path` is `git.rs`'s.

`AppState` holds the telemetry `port`, `sessions: HashMap<session_id, Session>` (each = PTY master + writer + child killer), `owned_pids` (see External sessions), `io_samples` (the previous disk-I/O reading per pid, which is what turns the kernel's lifetime byte counters into the inspector's rate) and `io_retired` (the bytes of sessions that have since exited, so the app-wide total doesn't fall when a pane closes), the held-open `pending` permission requests, and `caffeinate`.

**Both of those I/O fields are in-memory, so what `all_sessions_resources` reports is a
*run* figure — and that is why `cc-io` exists.** The counters belong to processes this
Episko spawned, so they start near zero on every launch; the inspector called the sum
"total", which is neither daily nor lifetime and reads as the latter. `addIo` banks each
poll's increment into a per-day rollup off the *same* sample the live bars are drawn
from, and `ioDelta` clamps a drop to zero because a restart is the normal case here, not
an edge one — the same reasoning as `costDelta`'s drop branch, reached independently.
There is no back-fill: days before it shipped have no entry and render as "not
recorded", never as zero — and `ioTotal()` answers **null**, not `{r:0,w:0}`, for the
same reason.

**The three windows the row cycles genuinely coincide at first, and the row has to say
so.** `all` equals `today` while one day is recorded — every install, for the first day
after the rollup ships — and `run` equals `today` whenever the run's first poll is also
the day's, because `ioDelta` banks the *whole* cumulative counter when there is no
previous reading. Both are correct, and together they make a cycling control whose three
positions carry identical numbers, which reads as a click that does nothing. `ioSameNote`
(pure, tested) names the coincidence and returns null once they diverge, so the sentence
is absent rather than empty. It compares the **rendered** strings, not the floats: two
figures that round together are one figure to the person asking why nothing changed. The
`⟳` beside the label is the other half — the row sits under two static rows it is
pixel-identical to, so a hover-only highlight was the entire affordance.

**The write is floored at a minute, and a disk meter is exactly the wrong thing to be
sloppy about here.** The poll behind it runs every 4s for as long as a session is on
stage, so persisting each reading would mean ~900 synchronous `stringify` + `setItem`
calls an hour to record a number read once a day. Accumulation stays per-poll (free);
only `flushIo` writes, and it is forced across a midnight (nothing adds to yesterday
again) and on `quit-requested`. **Skipping polls loses no bytes** — the counters are
cumulative and `io_retired` outlives a session's exit, so the next reading carries the
whole gap. The one real loss is the stretch after a run's last reading; `flushIo`
persists what was read, it does not take a reading.

**What a gap did cost is the day the bytes are filed under, and that used to be silently
wrong.** A bucket is credited when the poll *lands*, and the poll is gated three ways —
`if (mirror) return`, a session must be on stage, and a backgrounded WebView throttles
its timers regardless. So the sampler goes quiet for hours, and a quiet stretch spanning
a midnight booked the whole of yesterday's churn to today. Observed on this machine: an
evening's ~480MB of writes landed in a morning that had done ~25MB of work, while the
day that earned them read 54MB — one unsampled night, wrong in both directions. Two
halves fix it, and both are needed:

- **`splitIo` (pure, tested) spreads an increment over the days its window covers**,
  weighted by each day's wall-clock share. Nothing knows *when* inside a window a byte
  was written, so this is a guess — but a bounded, unbiased one, and the parts sum to
  exactly the increment so the rollup can't drift from the counter. A window inside one
  day is a single bucket and the arithmetic is untouched. A window no polling gap
  explains (a clock jump, a month asleep) is clamped rather than smeared across days the
  app wasn't running.
- **A 60s heartbeat in `main.ts` keeps the window short** when the 4s poll can't run. It
  calls `pollIo` — the I/O half of `refreshSessionStats`, split out precisely so the
  heartbeat does **not** drag `git_diffstat` and its `git` subprocess along with it. The
  cadence is `IO_SAVE_FLOOR_MS` exactly, so it cannot raise the write rate above what an
  on-stage session already produces: `addIo` returns before touching anything when the
  disk was idle, and flushes at most once per floor when it wasn't. **A meter must not
  add to what it measures** — keep any new sampler on that footing.

**And be honest about what the number covers: the `claude` processes themselves, nothing
they spawn.** Verified on macOS rather than assumed — a child writing 64MB moves the
parent's `proc_pid_rusage` counter by 0.0MB, while the same write in-process moves it by
exactly 64.0MB. So `cargo`, `pnpm`, `git` and test runs are invisible here and the real
churn an agent causes is *higher* than the row shows. Also expect physical writes to run
several times the logical bytes (measured ~5×: 92KB written for 17.4KB of transcript
growth) — APFS is copy-on-write, and a transcript grows by constant small appends.

- **PTY** via `portable-pty`. `spawn_claude` opens a PTY, spawns claude, and (via the shared `stream_pty_session` helper) starts two threads: a reader that base64-encodes output into `pty-output` events, and a reaper that removes the session and emits `pty-exit`. `write_pty` / `resize_pty` / `kill_session` operate by session_id. `spawn_shell` reuses the same path to run a plain login shell (no Claude, no instrumentation) in an embedded pane — the `❯ Terminal` button opens one when the launch engine is embedded (else it opens an external terminal via `open_terminal_here`). Shell panes carry `kind:"shell"` on the frontend `Sess` and skip telemetry/cost; `spawn_task` is the third entry point (see Runnables above).
- **Telemetry server** (`run_telemetry_server`) forwards `/hook` and `/statusline` POSTs as one `telemetry` event each; `/permission` is the blocking path described above.
- Commands are registered in the `invoke_handler![...]` list at the bottom of `run()` — add new `#[tauri::command]` fns there.

## Frontend (`src/`, `index.html`, `src/styles.css`) — 49 modules

**No framework, and no longer one file.** ~14296 lines across 49 modules; `main.ts` is 805 of them and is **bootstrap only**. State lives in a `sessions: Map<session_id, Sess>` (owned by `state.ts`) plus module-level variables; **every mutation ends by calling `renderAll()`**, which re-renders the sidebar, mini-rail, inspector, header, footer, attention badge, and tray from scratch. There is no diffing — follow this render-everything pattern rather than mutating DOM directly.

What `main.ts` still holds, deliberately: the imports and the whole of the `setXHost`/`setX` wiring (~70 lines — it is the seam map, and belongs in the file that owns the graph), the one-time startup blocks, `renderAll()`, every `listen()` handler, the delegated `[data-*]` click dispatcher and the global keydown, the ResizeObserver, the quit guard, the debug-console button wiring, the window controls (see One title bar), and the seven `setInterval`s.

**Tested logic modules** (nineteen — no DOM, no Tauri, no render imports; these are what the 744 vitest tests cover, one `test/*.test.ts` per module bar `types.ts`, whose discriminants are exercised through the four suites that import it, plus `dispatch.test.ts` and `ipc.test.ts` which read source instead of importing it):

| Module | What |
| --- | --- |
| `types.ts` | the shared data model: `Sess`, `Phase`, and the one-line discriminants that read them (`isAgent`, `statusKey`, `PILL_TEXT`, `runElapsed`, `taskStateText`) |
| `format.ts` | durations, paths, escaping, sparklines, money and token counts — data in, string out |
| `diff.ts` | the unified-diff parser behind the working-set viewer (the extraction precedent) |
| `rl.ts` | account-wide rate limits: merging readings, burn rate, the window forecast |
| `usage.ts` | the `cc-usage` daily rollup, `uBuckets`/`uSum`, the day/token join, `daySpend`'s split of a day, the `cc-io` disk rollup |
| `phase.ts` | `applyHook` / `applyStatusline` — telemetry → session state. The heart of the display |
| `palette.ts` | ⌘K ranking: fuzzy match, scoring, prefix parsing, frecency |
| `grouping.ts` | what the sidebar shows and in what order; `urgencyRank`, `needsYou`, `nextAfterClose`, and the run-group fold (`foldRunGroups`, `groupPhase`, `nextInGroup`) |
| `tasks.ts` | the frontend half of Runnables: `stopRuleBlocked`, `launchWithDeps` (dep memoisation), `findDepCycle`, `applyRunner`, `${input:…}` glue |
| `history.ts` | History's rules: `histProject` (regrafting a row onto a project), `histBusy`, the scope/search predicates, day buckets |
| `gitwatch.ts` | `gitMutates` — whether a shell command an agent ran is worth re-reading git for; `driftTarget`/`driftUpdate` — which checkout its work has moved to, from writes *and* `cwd` |
| `graph.ts` | the commit graph: `layoutGraph`'s lanes, what names a lane (`lineRef`, `lineTip`), `parseRefs`, the geometry and `rowSvg` |
| `peek.ts` | the sidebar's hover-to-reveal: what arms, what cancels, what the next deadline is |
| `trail.ts` | a day of work assembled from transcripts, git and the usage rollup; `dayFacts` (yours) and `projectDayFacts`/`sharedDay` (the team's) |
| `notes.ts` | the one thing on the dashboard you type — capture, filing, removal |
| `dash.ts` | the project dashboard's rules: `projectTier`, `dashDays`, `dashPulse`, `projectCost` |
| `ghwork.ts` | issues and PRs: recency buckets, what triage dares suggest, who already has one |
| `changelog.ts` | CHANGELOG.md → releases, `inlineMd`'s bold/italic/code, and the one moment *What's new* opens by itself |
| `claim.ts` | what Episko writes when you dispatch at shared work, and who decides |

**Shared**: `state.ts` (the session map, the stage pointer, every persisted preference) and `dom.ts` (`$`, `toast`, the shared scrim, `IS_MAC`/`MOD`/`chord`).

**Markup-only views**, untested by design: `usageview`, `inspectorview`, `sidebarview`.

**DOM-owning / render**, untested by design: `sidebar`, `footer`, `tray`, `inspector`, `debug`, `worktree` (the new-session dialog and the worktree removal flows, the biggest single module at 1,096 lines), `settings`, `taskui`, `palui`, `projmenu`, `caffeinate`, `diffview`, `graphview` (the paged commit-graph panel), `mirror`, `historyui`, `update`.

**Behaviour** — IPC and DOM all the way down, so untested too, and therefore the thinnest ice in the app: `panes` (the three spawners + a pane's lifecycle), `terminal` (the xterm plumbing), `taskrun` (run on stop), `actions` (the app-level verbs), `icons` (the per-project glyph store).

Four rules keep that graph honest. **There are no import cycles across the 49 modules; re-run a cycle check after any change that adds an import.**

- **Dependency direction is state ← render ← wiring.** A logic module must not import render code or `main.ts`.
- **When an extracted function needs something that lives further up**, resolve it in this order: (1) **move the callee down too** if it is itself leaf-shaped — that is why `icons.ts` sits below `sidebar.ts` and `usage.ts` below `phase.ts`; (2) **a settable hook defaulting to a no-op** (`setRlLogger`, `setPanesRenderAll`) when the callee genuinely belongs to the render layer; (3) **an extra parameter** only as a last resort, since it changes a signature the move was supposed to leave alone. A control panel touching many things it doesn't own may take **one host object** instead of N setters (`settings`, `palui`, `projmenu`); prefer per-callee setters below ~4.
- **A `*view.ts` takes data and returns a string** — no `$()`, no `innerHTML`, no renderer call. The `render*` function that paints the result stays with whoever owns the element, its timers and its delegated handlers. If a candidate seems to need a `setSomething`, it is a `render*` and should stay behind.
- **`state.ts`'s `setX` setters assign and nothing else.** Persistence and `renderAll()` belong to the call site — that is what `actions.ts` is for. (Conflating the two is a bug this codebase has already shipped once: a settings picker called `state.ts`'s `setWtGroup` instead of `actions.ts`'s, so the choice never persisted.) Reads are the live ESM binding and stay bare identifiers (`activeId`, never `state.activeId`).

**Every `innerHTML` surface on `renderAll`'s path is guarded, and the guard is a
pattern, not a one-off.** `renderSidebar` (`#projects`), `renderMini` (`#railmini`) and
`renderInspector` (`#inspector`) each build their markup every time but assign only when
the string differs from what they last wrote; `updateTray` diffs a signature before
rebuilding the native menu; `dashboard.ts`'s `paint(id, html)` does the same for each of
the dashboard's seven surfaces. `renderFoot`, `renderAttn`, `syncStageButtons` and
`reconcileCaf` need no guard — they assign `textContent`, class names and properties,
which replace no nodes. All of them exist because `renderAll()` fires on
*every* telemetry event and most events change nothing those surfaces show — 84.5% of
sidebar repaints were byte-identical under a realistic event stream. This is **not**
render diffing (no DOM is compared or patched) and it does not weaken the
render-everything rule; it is "skip when nothing changed", applied where it was measured
to matter. If you add a surface to `renderAll`, measure it before assuming it is free.

**On an interactive surface the guard is a correctness fix, not an optimisation.** Cost
is what the sidebar's guard bought; on every other surface what it buys is that **an
`innerHTML` assignment destroys the node under the pointer**, which costs three things
in rising order of seriousness — a restarted CSS transition (the dashboard's `▶ Start`
visibly pulsed under a still mouse), an emptied `<input>` (`#dashNote` lost a note
mid-typing), and **a dropped click**: replace a node between mousedown and mouseup and
the `click` fires on the container, so `closest("[data-perm]")` finds nothing and a
permission *Allow* is silently discarded on a session blocked waiting for it. None of
these is visible on an idle fleet, which is the state this app gets developed in. **A
repaint-per-event surface carrying buttons or inputs needs this guard before it ships.**

Two things make a guard *effective* rather than merely present, and both were needed
here. **A per-second clock in the markup defeats it entirely** — `dwellText` is `m:ss`,
so while it was rendered the inspector's string differed every second by construction
and no repaint could ever be skipped. It is now emitted empty and filled by `tickDwell`
(`textContent`), which main.ts's one-second tick already did for the neighbouring reason
that an `innerHTML` assignment restarts the heartbeat animation. And **the cache must be
invalidated wherever another module writes the same element**: `#inspector` belongs to
whoever holds the stage, so `paintInspector` keys on `dom.ts`'s `stageGen` — a counter
`takeStage` bumps — and `openDashboard` clears its own cache on every entry. `dom.ts`
owning that counter is what keeps a leaf module free of any dependency on the three
that need it.

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
- **A `[data-*]` branch is only reachable if its attribute is ALSO in the dispatcher's
  `closest()` selector.** One selector decides what `el` is; an unlisted attribute means
  `el` is null and the handler returns before the branch written for it. `tsc` is happy
  and every unit test passes — the feature is simply dead, and only clicking it finds
  out. That is how the dashboard shipped in 0.13.0 with its entry point disconnected.
  `test/dispatch.test.ts` now compares the two halves in both directions (an unlisted
  branch is unreachable; a listed attribute with no branch silently swallows clicks).
- **Event wiring**: `listen("pty-output" | "pty-exit" | "telemetry" | "permission" | "tray-select")` at the bottom of `main.ts`. Telemetry is routed by `data.session_id?.toLowerCase()` — session ids are matched case-insensitively, so keep them lowercase.
- `applyHook` maps lifecycle events → a `Phase` state machine (idle/thinking/working/done/error/ended) and attention flags; `applyStatusline` fills model/context%/cost/duration. **Rate limits are account-wide**, held in a single `rl` object and shown identically on every session, not per-session.
- **A turn that died is not a turn that finished, and only one hook knows which.** Claude Code fires `StopFailure` (not `Stop`) when the API kills a turn — a 529, a rate limit, a dead key — carrying an `error` enum (`overloaded`, `rate_limit`, `authentication_failed`, `max_output_tokens`, …) and the `error_details` text the pane shows. Everything *after* that point looks identical to a clean finish: the same 60-second idle `Notification` (`notification_type: "idle_prompt"`) arrives either way. Unguarded it relabelled the turn "your turn" and turned the red ✕ green a minute after the failure — which shipped, and is why `Sess.apiErr` exists. It is set by `StopFailure`, cleared only when the session genuinely starts another turn (`UserPromptSubmit` / `PreToolUse` / `SessionStart` / `SessionEnd`), and **`endTurn` is the single place that decides done vs. error** — both `Stop` and the idle nudge go through it, and the run-on-stop rule is skipped while it's set. Every surface that spells a state out reads `phaseText(s)`, not `PILL_TEXT[s.phase]`, so the reason travels with the glyph: "API overloaded" means wait, "auth failed" means go fix your credentials, and a bare ✕ means neither.
- **A `localStorage` write on the telemetry path is a disk write, and there are three
  cadences here — pick deliberately.** The statusLine fires **every 3s per session**
  (`refreshInterval` in `write_instrument_settings`), so anything `applyStatusline`
  reaches runs ~once a second on a working fleet. Measured on a real store: `cc-usage`
  980 chars, `cc-usage-detail` **24,586**, `cc-cost-base` 718, `cc-icons` 91,882.
  - **Eager** — `cc-usage`, the day's money. Small, and a crash-lost dollar cannot be
    reconstructed from anything.
  - **Only when the value changed** — `cc-cost-base`. An unchanged total leaves nothing
    to persist but `at`, which orders eviction and does not need second accuracy; it
    used to write the whole map on every statusLine, so an *idle* fleet wrote the same
    bytes once a second forever.
  - **Floored** — `cc-usage-detail` (30s) and `cc-io` (60s), both flushed on
    `quit-requested` and forced across a midnight, since nothing adds to yesterday
    again. Both are derived or approximate, and `daySpend`'s `unattributed` row already
    renders exactly what a crash-lost minute of attribution looks like.

  Also **cap anything keyed by day** — `cc-usage`, `cc-usage-detail` and `cc-io` are all
  bounded at `USAGE_MAX_DAYS`/`IO_MAX_DAYS` (420, past the Usage panel's widest 12-month
  range), because a daily key with no cap grows forever *and* is re-serialised on every
  write. `cc-icons` is the largest key by far but is written once per project ever, so
  it needs neither.
- **Persistence is all `localStorage`**, ~20 keys prefixed `cc-` (favorites, drag order, colours, icons, engine, permission mode, font size, sort/grouping, frecency, caffeinate, the `cc-usage` daily cost rollup and its `cc-cost-base` per-conversation baselines, the `cc-io` daily disk-I/O rollup and its `cc-io-scope` pick, the `cc-restore` roster, the sidebar's `cc-peek`, *What's new*'s `cc-seen-versions`, the dashboard's `cc-dash-*` and `cc-digest-ok`, and the task keys `cc-task-{prefs,pins,hidden,onstop,runner,inputs}` + `cc-trusted`). `grep '"cc-'` for the current set.
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

**`git_head` rides the same poll and is spawn-free for the same reason.** It answers a
session's live branch every 4s, once per open pane, and used to cost *two* git processes
each (`rev-parse --short HEAD`, then `symbolic-ref`) — so three sessions spent 1.5 git
processes a second re-reading a file, and on Windows, where process creation dominates
(~140 ms a call), that was a measurable share of the app's whole load. It now reads
`.git/HEAD` directly. Two things it must keep getting right: a **linked worktree has its
own `HEAD` but shares the repo's refs**, which is why `git_dirs` returns the per-worktree
dir *and* the common one and `resolve_ref` falls back to `packed-refs`; and an **unborn
HEAD is `None`, not detached** — `.git/HEAD` names a branch whether or not a commit
exists, so only the missing ref tells them apart, and `projmenu.ts` uses that `None` to
drop its *Commit graph…* row for a folder someone has just `git init`ed. Like
`repo_root_of`, it is tested by *substitution*: every case asserted against what git
itself answers, not against a restatement of the implementation.

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

**The ⑃ cluster header is the surface for a checkout** (subheader mode), and it renders
only for a checkout something is actually running in (`clusterIsLive`). It carries a `＋`
(→ `launchWorktree`, which keys the new session's `colorKey` to the **repo root**, or the
pane splits off into a project group of its own) and a **right-click menu** in
`projmenu.ts` — terminal, folder, copy path, the ⑃ dialog, and remove. That menu shares
`#ctxMenu` with the project one: `data-wt` is matched *ahead* of `data-key` in the
`contextmenu` handler, because a cluster sits inside a project group and a combined
`closest()` would be decided by tree distance rather than by what was clicked.

**The idle checkouts are peek rows** (`peekBody` → `.pgpeek`), collapsed until the
pointer rests on the project group. They used to be permanent dimmed headers, and a repo
with four worktrees spent four rows saying "no session" four times: those rows are worth
*reaching*, not *showing*, and the moment you want one is the moment the pointer is
already on the project. The whole row launches — there is no ＋ to aim at, because it has
exactly one thing it can do and a target the width of the sidebar beats a glyph. Four
things about it are load-bearing:

- **`peek.ts` owns the rules and is pure** — `peekEnter`/`peekLeave`/`peekTick` over an
  explicit `now`, no timers and no DOM, so what-cancels-what is unit-tested. `sidebar.ts`
  is a thin driver that schedules **one** timeout to `peekNextDeadline`; an idle sidebar
  arms nothing.
- **Hover is not a render input.** `peekBody` emits the rows on every paint and the
  expansion is one class applied outside the render path. Making it part of the markup
  would bust `renderSidebar`'s byte-identical cache (84.5% of repaints) on every mouse
  move — and worse, a telemetry tick would rebuild `#projects` and collapse a group under
  the pointer. That is also why `PeekState.open` is a **project path**, not an element:
  `renderSidebar` re-applies it through `applyPeek()` after each DOM write. The listeners
  are delegated `mouseover`/`mouseout` (which bubble) on the persistent `#projects`, for
  the same reason — `mouseenter` would need re-binding on every repaint.
- **Moving between two expanded groups skips the delay.** The delay exists to ignore a
  pointer passing *over* the rail; one already inside it is not passing over anything.
- **Off keeps the old behaviour** rather than hiding the rows for good — the wrapper
  renders already-open, so nothing that used to be reachable stops being so.
- **The rows need a roster, so an idle project must be polled for one too.** The rows
  come from `clusterByWorktree(p, true)`, which folds in `worktreesByRepo.get(p.path)` —
  and `refreshWorktrees` built that set from *sessions and externals only*, so a project
  you had not started anything in produced zero clusters and no bar at all, and closing
  the last session in one deleted the entry and took its rows away again. It now also
  reads **favourites**, on the stale-driven shape `refreshDirtyStates` uses: never-read
  ones are seeded on the next tick so the first hover already has them, and the rest ride
  a 20s sweep, because a repo nobody is working in changes on human timescales and
  reading every favourite every 4s would be ~20 IPC calls a tick to learn nothing.

Timings live in `cc-peek` and are set in Settings › Worktrees, where the control is a
pair of steppers over a **live preview built from the real `.pgroup`/`.pgpeek`/`.pkrow`
CSS and driven by the real reducer**. That is the point of it: "is 1000ms right?" has no
answer until you have rested a pointer on something for 1000ms, and a preview styled
separately from the thing it previews is just a picture.

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

**Ask the question the folder's state actually poses.** A checkout removed *outside*
Episko — a PR landing, a `git worktree remove` in your own terminal — leaves git's record
in `.git/worktrees` and a cluster here for as long as one of our sessions still names
that path, so removal remains reachable for a folder that is gone. Both flows now branch
on `exists` (`worktree_heads`, already in memory from the sidebar's roster): present →
the removal warning, gone → *"the folder is already gone; this only clears git's record
of it, nothing is lost"*. `wtConfirmHtml` always did this; `removeWorktreeAt` did not, so
it asked a destructive-sounding question about nothing and then reported "its folder was
already gone" from the backend's prune fallback — the fallback working exactly as
designed, arrived at by the worst possible route. **An unknown roster means "assume it is
there"**: guessing that way costs one honest sentence, where the reverse would offer to
prune a live checkout.

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

## Permission mode — how a session starts (Settings ⌘, → **Sessions**)

Orthogonal to the engine above: `permMode` (`cc-perm-mode`, `ALL_PERM_MODES` in
`state.ts`) is passed to all three claude spawners as `mode` and becomes
`claude --permission-mode <m>`. Four things about it are deliberate:

- **The standard mode passes no flag.** `permission_mode_arg` in `pty.rs` maps
  `"default"` (and Claude's own `manual` spelling) to `None`, because an absent
  `--permission-mode` is already ask-me-each-time. `--help` doesn't list `default`
  among its choices, so emitting it would depend on an undocumented alias.
- **The mode names are a whitelist, not a passthrough.** `permission_mode_arg`
  returns `&'static str`, so nothing the frontend sends reaches a command line.
  That matters because `spawn_external_terminal` interpolates the launch into a
  generated `.command` **shell script** — the one launch path with a shell in it.
  An unrecognised mode launches standard rather than failing.
- **It is only the *starting* mode, and nothing tracks it afterwards.** Claude's own
  ⇧⇥ switches mode inside a live session, so a recorded "this pane's mode" would go
  stale and lie; no `Sess` field holds one. The new-session dialog shows a chip for
  a non-default mode (`#wtMode`) because that is the last moment the choice is still
  true.
- **Three of the six turn Episko's permission cockpit off**, and silently: `dontAsk`,
  `bypassPermissions` and (mostly) `auto` mean Claude raises no permission request,
  so the blocking `PermissionRequest` hook never fires and a pane that would have
  asked simply doesn't. The picker's hint says so; keep it saying so.

Claude Code validates the mode against its own choice list and exits if it doesn't
know one, which kills the pane before it starts — the same class of external
contract as the hook schema. `claude_cli_still_accepts_every_permission_mode_we_offer`
(`pty.rs`, `#[ignore]`d) checks it against the real binary for **no tokens and no
auth** (`--version` short-circuits after the choice is validated); it is in
`RELEASE.md` only because CI hasn't got the binary.
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
  **`trafficLightPosition.y` is not the gap above the buttons**, which is why the
  first number looked plausible and shipped top-heavy: tao resizes the titlebar
  *container* to `button_height + y` and pins it to the window top, but never moves
  the button within it, and AppKit leaves that at `origin.y = 9` of a 14pt button.
  So the visible gap is `y - 9`, and centring wants `9 + (H - 14) / 2` — **22** for
  today's 40px `.top`. Change that height and this number moves with it; the
  arithmetic is checkable in a ten-line `swift` script against a bare `NSWindow`,
  which is cheaper than a rebuild per guess.
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

## The tray menu (`update_tray`, `tray.ts`, `icons.rs`'s `glyph_rgba`)

The other native surface, and the one the app draws least of: the OS owns the font,
the row height, the highlight and the corner radius, so **the only two things Episko
controls are each row's string and each row's 16px image**. Sessions are grouped under
their project and carry their status as a coloured icon; the label is the branch alone,
since the header now says which repo.

- **A menu item's text is always drawn in the menu's own colour.** So the glyph a label
  spells — `◆` waiting on you, `✕` the turn died — arrived the same grey as "Quit", and
  the two states you open this menu *for* were the two it could not show. An item's
  icon is an image and is **not** tinted, which is the whole reason the icons exist.
- **Therefore the icon must not be a template image** — the exact opposite of the tray
  icon in `run()`, which *is* one so it adapts to the menu bar. Get these backwards and
  every dot comes out menu-grey, i.e. the bug you set out to fix.
- **The frontend picks the shape and the colour, Rust only rasterises.** `GCLASS` maps
  a status to a class and `styles.css` gives that class its hue; `tray.ts` reads the
  colour back out of the stylesheet (`classRgb`) rather than restating it. A palette
  copied into Rust would part company with the sidebar the first time a hue is
  re-stepped for the light theme — and `g-ended` already differs between them.
- **32px source, because neither platform draws it at its own size**: muda scales the
  image to an 18pt row on macOS and blits it into a hard-coded 16×16 bitmap on Windows,
  so 32 halves exactly for one and still out-resolves the other on a retina display.
- **A project header is a *disabled* item, and disabled is load-bearing.** The tray's
  menu handler treats every id it doesn't recognise as a session to select
  (the `sid` catch-all), so a clickable header would emit a `tray-select` for nothing.
  Disabled items fire no `MenuEvent` at all. Anything new added to that menu needs
  either an id the handler matches ahead of the catch-all, or `enabled(false)`.
- The signature guard still stands, and now covers the icons too — a phase change that
  doesn't change the wording (a shell going from live to ended) must still repaint, so
  shape and colour are in the signature rather than just the label.

Windows renders the same items its own way and has no `set_title`, so the bar shows the
icon alone; whether a 16×16 blit of these shapes reads well there is a `RELEASE.md`
click-through, not something either CI leg can assert.

## External (non-Episko) sessions

Episko surfaces Claude sessions started *outside* it, discovered from `~/.claude/sessions/<pid>.json` (one per running interactive session — same path and format on Windows under `%USERPROFILE%`, VS Code-hosted sessions included, verified on CC 2.1.216; format details in the `claude-code-local-session-registry` memory). The **listing is OS-agnostic**: `list_external_sessions` liveness-checks survivors against `ProcTable`, one in-process `sysinfo` snapshot of the process table (no `ps`/`tasklist` spawns — the frontend polls every 3s), so discovery works on macOS, Windows and (untested) Linux alike.

- **Filter owned sessions by pid, never by session id.** Episko's own sessions register there too (confirmed CC 2.1.211), and `/resume`/`/clear` rewrite `<pid>.json` with a *new* id — so an id-based exclude lets a live, Episko-owned session reappear as "external" showing the resumed transcript. `AppState.owned_pids` holds every claude pid Episko spawned; the ancestry walk (`ProcTable::is_descendant_of`) also catches child-terminal launches.
- **That ancestry walk is deliberately broad, and it bites during development.** Anything started from a terminal *inside* Episko — notably `pnpm tauri dev` — becomes its descendant, so a second Episko instance's sessions are silently filtered out of the first's external list. **Run dev builds from a real terminal, not an Episko pane.** (Dev and installed share one `episko-debug.json` — it is keyed by `$TMPDIR`, not by build — so prefer quitting the installed app entirely. They do **not** share a localStorage: WebKit keys the store by the identifier the binary runs under, and `pnpm tauri dev` runs the bare `episko` binary rather than the bundle, so the two rollups live in separate files under `~/Library/WebKit/`. That is measured, not inferred, and `scripts/reconcile-usage.mjs` depends on it — it targets `io.respeak.episko` explicitly rather than guessing, because an earlier draft that picked the most recently written store repaired the dev history and reported success.)
- `read_transcript` mirrors a session read-only (decoding the cwd→`<enc>` path scheme). `focus_external_session` jumps to its terminal, and is the one thing here written **twice**, because "which window is that pid's terminal" has no portable answer:
  - **macOS** — exact tab focus by tty via AppleScript for Terminal.app/iTerm2, else `open` on the owning top-level `.app`. That `.app` fallback is **required** for Electron hosts like VS Code — their integrated terminal runs under a *helper* process System Events can't target by unix id (fails `-1719`); the tradeoff is we can only front VS Code, not the specific panel.
  - **Windows** — no tty, so no tab: walk the process tree to the first ancestor owning a visible top-level window (`EnumWindows`), then `SetForegroundWindow`. Three things that walk must get right, each verified against a live Windows process table rather than reasoned about: VS Code puts a **windowless** `Code.exe` pty host between the shell and the windowed one, so it must not stop at the first ancestor; the classic `conhost.exe` owns the window but is a **child** of the console process, so no upward walk reaches it (hence the per-level child scan); and a shell started from the Run box has **`explorer.exe`** as its parent, whose window must never be the answer — a wrong window looks like success, so the walk gives up instead. The known gap is the inverse of the conhost case: with Windows Terminal set as the *default* console host, a `powershell.exe` launched outside it is handed off to a WT that is nowhere in its ancestry, and nothing links the two.
  - A host process can own one window per project (three VS Code windows here, one `code.exe`), and Z-order alone then sends **every** jump to whichever was last in front. So the window is chosen by matching the session's project folder against the caption, falling back to topmost. The hint is read from the session's own registry file, which keeps the command's signature — and the whole macOS half — untouched.
- **Known gap:** sessions launched into an external Terminal.app/iTerm (via `open -a`) aren't in Episko's process tree, so they still rely on the session-id `exclude` and can leak after a `/resume`.

## Restorable sessions (surviving a restart)

Episko's launch uuid **is** Claude's `--session-id`, so every session it launches already has a transcript at `~/.claude/projects/<enc(workdir)>/<id>.jsonl`. Restore is therefore about remembering what was on screen and under what identity — not capturing conversation state.

- **The roster** (`cc-restore`) holds what was open at quit; `closeSession` removes an entry (an explicit close means done). Shells never join. Saves are debounced *with a ceiling* (`ROSTER_MAX_STALE`) — a busy session's continuous telemetry would reset a pure trailing debounce forever and never write.
- **Resume `resumeId`, not `id`.** Each runtime-id rotation (see the core-mechanism section) starts a **new transcript file**, so the launch uuid goes stale as a resume target. `run_telemetry_server` preserves Claude's incoming id as `claude_session_id` *before* forcing ours on; the frontend tracks it into `Sess.resumeId` and saves immediately on rotation. Routing is unchanged.
- **`--resume` and `--session-id` are mutually exclusive** (resume wins), so all three spawners branch either/or on `resume: Option<String>`. `--settings` stays keyed to our launch uuid, so `X-CC-Session` routes telemetry whatever id Claude runs under.
- **Verified against the real CLI:** resume preserves the id and appends to the *same* transcript; it must run in the **original cwd** (else `No conversation found with session ID: …`); and resuming an **already-live** session silently interleaves both transcripts (Claude takes no lock). Hence `dormantBusy()` gates Resume, and spawners refuse a vanished workdir (deleted worktrees are real).
- `list_past_sessions(workdir)` supplies labels from Claude's `ai-title` record — **last occurrence wins** — falling back `ai-title` → `last-prompt` → first user message. That layout is internal to Claude Code and documented as unstable across releases, so the chain is load-bearing, not padding. Only the 512KB tail is scanned. Entries with **no transcript are dropped** (a session launched but never prompted writes none).
- **The transcript folder is keyed by the *physical* workdir**, so `project_transcript_dir` canonicalizes before encoding (`physical_cwd`). This is not Claude being clever: `getcwd()` reports the resolved path however the process got there, so a session launched in a symlinked folder writes under the resolved encoding and under no other — encode the spelling the user picked and `list_past_sessions` returns empty, which reads as "no past sessions" rather than as a failure. On Windows the canonical form is verbatim (`\\?\C:\…`) and **must** have that prefix stripped or a currently-working path breaks; `strip_verbatim` is separated out precisely so that half is testable on a machine that can't produce one. Both live in **`platform.rs`**, not here: `repo_root_of` needs the same resolution for the same underlying reason, so the encoder is no longer the only caller.
- **Claude's cost counter survives the relaunch, so the day's baseline must too.** `total_cost_usd` (and `total_duration_ms`) come back from a `--resume` still carrying what the previous process spent — observed continuing across a 25-second kill-and-relaunch, and resetting across a ten-hour gap; nothing documents where that line falls. A relaunch builds a *new* `Sess` with `cost: null`, so diffing the running total against the pane booked the whole carried-over figure into `cc-usage` a second time. That shipped: a drift *Move session* put ~$28 into one day twice, and the day read $68 beside a pane reading $39. `costDelta` (usage.ts) keys the baseline by **Claude's runtime session id**, which resume preserves, and treats a *drop* as the counter restarting. Anything that adds a resume path inherits the fix; anything that diffs a cumulative telemetry figure against a `Sess` field repeats the bug.

  **The baseline is persisted (`cc-cost-base`), and it has to be**: held only in memory it covered a *Move session* and an in-session History reopen but not the commonest route of all — quit, reopen, restore. `cc-usage` is localStorage and survives that; a run-scoped map does not, so the restored pane's first statusLine met an empty baseline and booked the carried-over total into a day that already had it. The obvious worry about persisting — a baseline outliving the counter it describes would *swallow* real spend, the failure nobody can see — is what the **drop branch** answers: a restarted counter reads below its old baseline, so the whole new reading is booked as fresh. Retention is therefore deliberately generous and capped by count, not by age; the drop branch, not an expiry, is what makes a stale entry harmless.
- **The roster is a convenience layer, not a system of record** — `/resume` inside Claude always lists every session for a folder, so nothing dropped or removed is ever lost. Keep UI copy honest about that, and don't build recovery machinery for a problem `/resume` already solves.
- **The stage has one owner:** `activeId` and the `mirror` pointer (`{kind:"ext"|"past"|"dash"}`) are mutually exclusive — the read-only kinds share one discriminated pointer rather than a flag each. Timer-driven inspector repaints must bail on `mirror`, not just the external case. **`stageGroup` does not break this and must not become another owner:** it names a tiled run group, but `activeId` still names the one *focused* pane, which is what the header, inspector, footer and keystrokes read. It is a modifier on the single-pane stage ("also show that pane's group siblings"), which is exactly why adding it changed no existing `activeId` consumer.
- **And one function decides what is *on* it.** `takeStage(show)` in `dom.ts` — `"session" | "ext" | "dash" | "none"` — is the only thing that may touch `#extPane`, `#dashPane`, `#empty` or `insp-mini`. It lives in the leaf module so every opener can call it without an import edge (it is why `mirror.ts` still needs no `./dashboard` dependency). Each opener used to hide its rivals by hand and **only two of four did it completely**, which is not a class of bug the type checker or a unit test can see: `#extPane` and `#dashPane` are both `position:absolute; inset:0` with **no `z-index`**, so DOM order alone decides and `#dashPane` is second — an opener that shows the mirror without hiding the dashboard puts it *behind* a fully opaque pane. Nothing errors, nothing logs, and the header, inspector and `--accent` all update correctly, so the click reads as "it only changed the colours". `insp-mini` rides along because the 44px rail is a **dashboard-only** mode; anything else taking the stage must clear it or the next session inherits a rail holding the wrong buttons. Add a fourth pane by extending `Stage`, never by poking `hidden` at the call site.

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

macOS-first assumptions remain in the window/terminal layer: `osascript`, `open -a`, external-terminal engines. Terminal-window focus is **no longer** one of them — `focus_external_session` has a win32 half (see External sessions), though only macOS can address an individual tab. Windows has a working embedded-only port (PowerShell/`curl.exe` hook variants behind `#[cfg(windows)]`, cross-platform external-session listing); Linux is unported but the non-`ps` paths are written to be OS-agnostic. Resource reporting is **no longer** one of the macOS-bound bits: `all_sessions_resources` reports disk I/O through `sysinfo` (one refresh, every OS) rather than shelling out to `ps`, so `ps_one` is now reached only from the macOS-only terminal-focus path.

**`SPIKE.md` is a historical record and is not maintained.** It describes the Phase-0 spike — single-session, "observe-only" permissions, one file per side — and is kept because it is the record of where this started, not because it is true. It carries a banner saying so. Don't consult it for how the app works today, and don't edit it to match; `README.md` is current.

**Trust the code over the docs** when they disagree, and fix the doc in the same commit.
