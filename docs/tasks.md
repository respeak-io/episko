# Runnables — tasks & scripts

> Rules and their reasons, compressed — the full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

Episko runs the task definitions a project already ships. A **`Runnable`** is one such definition. Providers: `.episko/tasks.toml` (Episko's own committable format), `.vscode/tasks.json`, `.vscode/launch.json`, `package.json` scripts, `justfile`, `Taskfile.yml`, `mise.toml`, `Makefile`, `Cargo.toml`. Discovery is in `tasks.rs`; execution reuses the PTY path — **a task run is just another `Sess`** (see `Sess.kind` in CLAUDE.md), which buys the phase machine, glyphs, attention, tray and ⌘1–9 for free: a run's **exit code is its phase** (0 → `done`, non-zero → `error`) over the same `pty-exit` event.

Three rules constrain `tasks.rs`:

- **Discovery never executes the project.** Introspecting providers *evaluate* what they read (`just --dump` runs backticks and imports), so they sit behind the trust gate: `discover(root, trusted)`, granted only if the global toggle is on, the provider enabled, and the folder user-chosen (`cc-favorites` or a one-time `cc-trusted` confirm). `task` and `mise` share the `Introspector` shape; `just` has its own `just_recipes()` but shares `introspect_output` and the blocked-row pattern. Untrusted → one blocked row (withheld, not missing). Makefiles/Cargo are parsed statically — `make -qp` would expand `$(shell …)`.
- **Ids are stable and namespaced** (`npm:test`, `just:deploy`) — pins (`cc-task-pins`) and frecency key off them; `dedupe_ids` guarantees uniqueness across a rescan.
- **What can't run says so**: `blocked: Some(reason)` renders greyed, never dropped — a missing row reads as "Episko didn't find my task". VS Code tasks needing an editor (`${file}`, `${lineNumber}`) or an unsupported `type` are blocked. Supported vars: `workspaceFolder(Basename)`, `cwd`, `userHome`, `pathSeparator`, `env:X`. `${input:X}` is left intact — the frontend prompts (`openInputPrompt`) and substitutes (`applyInputs`) just before launch; `just` params without defaults prompt the same way. **A failed introspector is a blocked row, never an empty list** (`IntrospectFail`) — silence is unfalsifiable. `NoProgram` names the *PATH*, not "not installed" (installed-but-not-visible is the commoner case).

## Run groups — one chain, one row

A chain launches one pane per step (an exit code is a phase; one PTY cannot yield four). `launchWithDeps` mints `run.groupId` **per launch, never per task** (two runs of the same task are two rows to compare); every step inherits it, including the chain's own pane; nesting inherits via `opts.groupId ?? crypto.randomUUID()` — outermost wins.

- **The fold is presentational**: `foldRunGroups`/`groupPhase` are pure in `grouping.ts`; a group takes its first member's sorted position (re-sorting would silently overrule `projectList`).
- **Worktree clustering keys on the checkout via `checkoutOf`, never `workdir`** — a task's cwd is routinely a subfolder, which is not another worktree; `launchWithDeps` passes `discoveredIn` down to dependencies for exactly this.
- **A group of one renders as a plain row.**
- **`groupPhase` is worst-of, not last-of** — a failed build stops the chain, so last-of would report `done` on a broken one; `working` beats `done`, and `idle` counts as working (queued behind a sequential dep).
- **The header is a block (`.rgroup`), not a `.srow`.** `.rgrow` must stay `position: relative` (its absolutely-positioned ✕ gone static claims a grid cell and doubles the header); background is `--surface`, never `--lift` (a white veil reads as nothing on a light theme).
- **Clicking the header tiles the group** (`openRunGroup` → `stageGroup`), focused on the failure else the last to start. `#terminals.tiled` turns pane overlays into grid cells; each gets a `.pane-cap` with `data-close`; `refreshPaneCaps` is called from `renderAll` (panes sit outside the render sweep). The twisty (▸) expands the step list — a separate hit target, reachable only because `[data-rgtoggle]` is in `main.ts`'s `closest` list. **`refit()` must refit every visible pane when tiled.**
- **A chain launch lands on the group** (`launchTask` calls `openRunGroup`, not `setActive`), and re-tiles as later steps appear only while the stage is still on that group.
- **Closing one tile stays in the mosaic** (`nextInGroup` — `nextAfterClose` answers the *sidebar's* question and would hand the stage elsewhere and untile). Closing a tile must `refit()` — the grid reflowed but `#terminals` didn't resize, so no ResizeObserver fires.
- **Closing a group asks first if anything still runs** (`closeRunGroup`); a finished chain closes instantly.
- **`setActive` leaves the tiled view** (keeping it read as the click doing nothing), so `openRunGroup` passes `setActive(id, keepGroup = true)`; clicking a *tile* is `focusInGroup` — moves `activeId`, keeps the layout.
- **A finished run's duration freezes at `run.endedAt`, and `runElapsed` (types.ts — pure, `now`-injectable, tested) is the only place that computes one.** It was three places, which is how the bug survived being "fixed" once.

## Compound tasks, and ⌘⇧B

A `tasks.json` entry with **no `command` but a `dependsOn` list** is VS Code's compound task — usually the `"group": {"kind":"build","isDefault":true}` one, so blocking it as "no command" withholds exactly the task whole stacks start from. `Runnable.compound` is explicit; `launchWithDeps` runs the dependencies and stops.

- **`compound` is not `blocked`** — nothing is missing; its `detail` names what it runs.
- **`launchWithDeps` returns `{ok, id}`** — independent facts: a compound *succeeds* while launching no pane; reading that absence as failure would stop a nested compound satisfying its parent.
- **A background dependency is satisfied once it starts, never awaited** — a dev server never exits, so awaiting hung the chain (VS Code behaves the same). Non-background dependencies are awaited.
- **A compound can't be a run-on-stop rule** (`stopRuleBlocked`): no pane, and `forSession` is cleared for dependencies.
- **`default_for` is separate from `group`**; `runDefaultTask` takes the marked default, else an unambiguous single group member, else **opens the picker** — silently running the first build-ish task is how you deploy when you meant compile.
- **⌘⇧B/⌘⇧T must be registered *before* plain ⌘B/⌘T** in `main.ts`'s keydown chain, which doesn't test `!e.shiftKey` — a shifted binding after its twin silently never fires.

`launch.json` configs are offered as run-without-debugging (⌃F5); `request: "attach"` and compound *configs* are blocked, not silently started as plain processes.

`spawn_task` is the third PTY entry point: `TaskSpec { exec, cwd, env }`, deliberately **un-instrumented** (no settings file, no telemetry, no cost, pid not in `owned_pids`). `Exec::Shell` runs through a login shell, `Exec::Argv` through `argv_command`. The `Exec` wire format is pinned by a round-trip test — the frontend hands a discovered `exec` straight back to `spawn_task`.

## PATH — a login shell is not enough

zsh sources `~/.zshrc` **only when interactive**, and that is where nvm, `PNPM_HOME`, mise and Homebrew live; a Finder-launched app starts from `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. Shipped consequences: a `pnpm` task dying on `command not found` while working in iTerm; a real justfile reported as **no tasks** (`Command::new` failed `NotFound` → empty list). The fix is `platform::augmented_path`: it **harvests** the PATH from an *interactive* login shell (`$SHELL -i -l -c`) once per run (`LazyLock`, warmed by `warm_shell_path`), plus hardcoded fallbacks. Four rules:

- **Harvested PATH first, fallbacks after** — nvm's node must win.
- **The probe's output is fenced** (`PATH_MARK`) and refused if it doesn't parse as a PATH — rc files talk, and fish interpolates `$PATH` space-separated.
- **Interactive is for the probe only, never for the task.**
- **Anything that shells out needs it**: every introspector goes through `introspect_output` (`augmented_path` + `sys_command`) — a provider without both is the justfile bug again.

## Windows argv — `CreateProcessW` cannot run a script

portable-pty hands the program to `CreateProcessW` as `lpApplicationName` (PE executables only), and its `search_path` prefers the *extensionless* bash script over the `.cmd` shim — so every npm-provider `Exec::Argv` failed on Windows. `argv_command` resolves via PATHEXT over the augmented PATH (ignoring extensionless matches) and routes anything not `.exe`/`.com` — and anything unresolved, on purpose — through `cmd.exe /C`, so "'foo' is not recognized" prints **in the pane** rather than as a context-free spawn error. The pure half, `win_runs_directly`, is compiled on every platform (`cfg_attr(not(windows), allow(dead_code))`) so it is testable from a Mac and reachable by the cfg flip.

## Run on stop

One rule per project (`cc-task-onstop`, keyed by root), set with `⟲`, reviewed in Settings › Tasks: when an agent finishes a turn in this folder, run this.

- **Unattended means unattended**: `stopRuleBlocked` refuses a background task (it would pile up one server per turn), one whose `${input:…}` still needs a person (defaults and `optional` answer themselves — the launch goes through `prefillInputs`), and a blocked one.
- **The run must not take the stage**: `launchTask` `focus: false` for this path only; an unfocused pane starts at 24×80 until first activated.
- **Never two at once, never twice per turn**: an in-flight run wins, `STOP_RUN_FLOOR` swallows a double-fired `Stop`, and both the floor timestamp *and* the per-project in-flight marker are claimed **before the first `await`** — the marker is what covers a rule with `dependsOn`, whose pane doesn't exist until the chain has run.
- **Discovery runs in the session's `workdir`** — with several worktrees open, verify the checkout that agent edited.
- **A failure goes back to the session that caused it** (`run.forSession`); the handoff is withheld if that session ended or is external, and typed without a trailing newline — the human presses Enter.

## `dependsOn` — a DAG, walked once

Every dependency is memoised in `launchWithDeps`'s `started` map (task id → outcome), claimed **synchronously before the first await** — without it, one ⌘⇧B launched 27 panes for 11 tasks (shared deps restarted down every path; VS Code runs each task once per invocation).

- **Memoise the whole outcome**: `exitWaiters` holds one resolver per session id — two dependents calling `waitForExit` on the same pane would clobber each other and hang a branch forever.
- **`findDepCycle` runs first, over the whole graph, before any pane starts** — required by the memo (a branch awaiting a shared task can wait on a branch waiting on it). Pure and tested, including not mistaking a diamond for a cycle.

Dependencies are named by *label*, run in parallel unless `dependsOrder: "sequence"` (parallel is VS Code's own default, surprising as that is), and a failed dependency stops the chain. `waitForExit` resolves from the `pty-exit` listener *before* its early return, and `closeSession` resolves `-1` — a chain can never deadlock on a vanished pane.

## Inputs

**An input is a second verb, not a toll on the first**: *Run* goes through `prefillInputs` (last value from `cc-task-inputs` → definition default → empty if `optional`), prompting only when an input has no answer anywhere; changing values is its own button (`⋯` / ⌥⏎ / *⋯ Parameters*). Every attended surface routes through `runRunnable` (picker, ⌘K, ⌘⇧B — which toasts only when something actually launched) or shares `resolveRunInputs` (re-run, whose launch semantics differ: it closes the old pane first); run-on-stop is unattended and uses bare `prefillInputs`, never prompting. The row's tooltip shows the command *as prefilled* — a value reused silently is fine only while visible.

**`optional` exists because `just` has two variadics and they are opposites**: `*name` is complete without a value, `+name` is not — reading both as required put a prompt in front of every `*args` run. VS Code inputs are never optional. It is also the one thing `stopRuleBlocked` softens on: an input that answers itself is not a prompt.

## Settings, panel, overrides

Settings ⌘, → **Tasks**: declarative controls (`SET_TABS` + `renderSetControl`; kinds `toggle`, `multi`, later `wtpreview`/`peek` — previews are built from the app's own CSS and reducer, because a preview that restates what it previews drifts and then reassures falsely). `applySetting` dispatches. **Personal preference → `localStorage`** (`cc-task-{prefs,pins,hidden,onstop,runner,inputs}`, `cc-trusted`); **project fact → `.episko/tasks.toml`**, committable.

`openTaskManager` (⌘K): pin / hide / create / edit / delete / **override**. `.episko/` is the only place Episko writes in a user's repo (see App-wide rules in CLAUDE.md); editing a discovered task writes an `[override."<id>"]` into `tasks.toml`, **never** a mutation of `.vscode/tasks.json`. Writes go through `toml_edit` so hand-written comments/order survive (tested). Creating the file the first time asks — a new committable file is a real side effect.

Overrides: `apply_overrides` patches *after* dedupe (keys off final ids); an override whose target vanished becomes a **blocked row** (`override:<id>`), never a silent no-op. `save_task_override` writes `background` unconditionally (an override's job includes turning it *off*). Overriding `run` re-derives inputs (`redetect_inputs`). Reverting removes the key — and the whole table when last. The panel reads `list_task_overrides` (the file, not the cache).

Smaller affordances: **package-runner override** (`cc-task-runner`, applied *after* discovery by swapping `exec.program` — `applyRunner` — so the cache needn't know); **remembered inputs** (never a password — `i.password`); **↗ Reveal source** (`reveal_path` — guards `..` escape; `run.root` resolves the relative `sourceFile`); **⟳ Rescan** (`rescan_runnables` — the escape hatch for files an introspector imports itself, which the stamp can't see).

Discovery is **memoised in Rust** (`discover_cached`), keyed `(root, trusted)`, invalidated by a *stamp* — the `(mtime, len)` of every file a provider reads, a missing file included. Not a watcher: ~20 `metadata()` calls answer it. **A new provider file must be added to `source_files()`** or its tasks go stale behind the cache.

Surfaces: `▶ Run` (picker: pinned, then frecency-ranked recent, then by source), a Tasks group in ⌘K, the task inspector (re-run / pin / stop / send output to a session). Successful non-background runs auto-dismiss after 20s unless focused; failures persist and raise attention.
