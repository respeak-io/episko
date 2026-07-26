# PLAN — presentable: restructure & test coverage

Roadmap for making the codebase presentable for a first public release: split the
two monoliths, put every *decision* the app makes under test, make CI enforce it,
and fix doc drift. **No architecture changes** — the no-framework render-everything
pattern, the single `sessions` Map, and the per-launch instrumentation design all
stay exactly as CLAUDE.md describes them. This plan changes file boundaries and
adds tests, nothing else.

Created 2026-07-24 on branch `chore/tests`, baseline v0.11.0 (post-runnables).
Tick checkboxes as slices land; keep this file honest — it is the tracker.

Green at baseline: 12 vitest + 61 cargo tests, `tsc --noEmit` clean.

**Status 2026-07-26: Phase 0 and Phase 1 are done.** `main.ts` is 642 lines of
bootstrap, `listen()` handlers and `renderAll()`; there were 5,705 (**−89%**). 33
modules, no import cycles.

- **Tested logic modules** (eight): `types`, `format`, `rl`, `usage`, `phase`,
  `palette`, `grouping`, `tasks`.
- **Markup-only view modules** (three, untested by design): `usageview`,
  `inspectorview`, `sidebarview`.
- **DOM-owning / render modules** (untested by design): `debug`, `worktree`,
  `settings`, `taskui`, `caffeinate`, `diffview`, `sidebar`, `footer`, `tray`,
  `inspector`, `palui`, `projmenu`, `mirror`, `update`.
- **Behaviour modules** (untested by design so far — see the note below):
  `panes` (the three spawners + a pane's lifecycle), `taskrun` (run-on-stop),
  `terminal` (the xterm plumbing), `actions` (the app-level verbs), `icons`.
- **Shared**: `state` (the session map, the stage pointer, every persisted
  preference) and `dom` (`$`, `toast`, the scrim, the chord glyphs).

Green: **368 vitest + 69 cargo**, `tsc --noEmit` clean, no import cycles across 34
modules. Four bugs found and fixed along the way, two open findings — all six under
*Findings from the Phase-1 slices* below.

**Worth knowing before Phase 2/3.** The frontend is now split but *not* fully tested:
`panes`, `taskrun`, `actions` and `terminal` came out under the render-module rule (no
unit tests) even though they are behaviour, not markup. That was right for the split —
they are IPC and DOM all the way down — but it means the Phase-3 items are the only
thing standing behind them. **`taskrun`'s three invariants (never two at once, never
twice per turn, never unattended-hostile) are exactly the kind of thing worth testing
now that they live in a module that imports nothing from `main.ts`** — a plausible
first slice of a Phase 1½ if one is wanted.

Nothing in this effort has been exercised in the running app: every slice was verified
by `tsc`, `pnpm test` and a mechanical diff against `HEAD`. The click-through in
*Verifying a slice by hand* is owed, and the worktree-grouping fix below is the one
change with a visible before/after to check first.

The recipe is settled — guarded line-range slice → wire → `tsc`/`pnpm test` →
diff-against-HEAD → smoke through the app's own buttons — and so are the traps that
have cost time. Beyond the three already recorded (section comments that lie about a
block's extent, regex call-rewrites that also rename declarations, verification diffs
that silently compare two empty files), two more from this session:

- **A verification window that is a few lines short reports a difference that isn't
  one.** It happened twice; both times the fix was to re-derive the boundary from
  `HEAD` by grep rather than reusing a line number the earlier slice had shifted.
  Compare the two blocks **line-sorted** — a move that only reorders declarations then
  shows as identical, and a real edit still shows.
- **`dom.ts` must not touch the DOM at module scope.** `./debug` imports it, so vitest
  pulls it into the node environment through every logic module that logs.

## Baseline (2026-07-24)

| Area | Size | Tests |
| --- | --- | --- |
| `src/main.ts` | 5,705 lines | **0** — untestable as-is: module-level xterm/Tauri/DOM side effects mean nothing can be imported into vitest |
| `src/diff.ts` | 52 lines | 12 vitest tests (thorough) — the extraction precedent |
| `src-tauri/src/lib.rs` | 3,998 lines | 22 tests — git/worktree layer, transcript & usage parsers, ProcTable, registry |
| `src-tauri/src/tasks.rs` | 2,210 lines | 39 tests — already the target pattern: own module, tested |
| CI (`ci.yml`) | compile gate only | **runs no tests at all** — `pnpm test` / `cargo test` exist but never run in CI |

Untested despite being load-bearing: `write_instrument_settings` (the core
mechanism), the telemetry sid-forcing in `run_telemetry_server`, and the entire
frontend state logic (`applyHook`/`applyStatusline`, rate-limit forecast,
grouping/sort, palette, permission risk rating).

## Ground rules

1. **Extract → test → commit.** Never restructure ahead of the safety net. Each
   slice is one module moved out plus its tests, small enough to review. No
   big-bang diffs.
2. **Mechanical moves only.** Code is relocated, not rewritten. Behavior changes
   are separate commits, argued on their own.
3. **Dependency direction in the frontend:** state ← render ← wiring. Extracted
   logic modules must not import render code; mutable module state gathers in one
   `state.ts` rather than scattering. No import cycles.
4. **Green at every commit:** `pnpm exec tsc --noEmit`, `pnpm test`, and (for Rust
   changes) `cargo test` in `src-tauri/`. Between slices, run `pnpm tauri dev`
   and click through the core paths — the OS edge (PTY, windows, tray) has no
   automated net and never will here.
5. `tasks.rs` (39 tests, own module) is the in-repo precedent for what Phase 1/2
   modules should look like.

## Phase 0 — safety net (small)

- [x] CI: add `pnpm test` (after the frontend build) and `cargo test --locked`
      (after cargo check) to `ci.yml`, both OSes.
- [x] Test `write_instrument_settings`: all lifecycle hooks `"async": true`;
      `PermissionRequest` is a *blocking* `type:"http"` hook with `?sid=`;
      `X-CC-Session` header in every generated command; absolute curl paths
      (stripped-PATH constraint); port + session id embedded; `shell:"powershell"`
      on Windows.
- [x] Tests for the remaining restructure-independent helpers:
      `sh_quote`, `git_action` (temp repo + bare remote, like the branch-list
      test), `git_diffstat`, `upstream_state`, `sniff_mime`,
      `valid_caffeinate_flag`, `query_param`.
- [x] **Telemetry-server integration test** — the app's core mechanism, today
      protected by prose only. Drive the real `tiny_http` server on an ephemeral
      port against a mock app and assert both documented hard constraints:
      - a `/hook` POST carrying `X-CC-Session: <ours>` and a *different*
        `session_id` in the body emits a `telemetry` event with `session_id`
        forced to ours and Claude's runtime id preserved as `claude_session_id`
        (the routing-drift bug class the debug console counts as "unrouted");
      - a `/permission` POST (id via `?sid=`, no header) does **not** get a
        response until `resolve_permission` is called, then gets the decision.
      Needs: `tauri = { features = ["test"] }` as a dev-dependency and
      `run_telemetry_server` made generic over `R: Runtime` (it takes a concrete
      `AppHandle` today) so `tauri::test::mock_app()` fits — the standard Tauri
      pattern, mechanical. No Claude, no PTY, deterministic, CI-safe.
      Also needed, unforeseen: a `/MANIFESTDEPENDENCY` link arg in `build.rs` on
      Windows. Building a `tauri::App` imports v6-only comctl32 symbols, and a
      cargo test harness gets no manifest — so the exe died at load with
      `STATUS_ENTRYPOINT_NOT_FOUND` before any test ran. Rationale in `build.rs`.

## Phase 1 — split `main.ts`, test-driven, leaves first

Each unchecked item = one slice: extract the module, write its tests, commit.
Order matters — pure leaves first, DOM last.

**How a leaf module calls back into the app.** Decided 2026-07-24, so it needn't
be re-argued per slice. A logic module must not import render code or `main.ts`
(ground rule 3), so when an extracted function needs something that lives up
there, resolve it in this order:

1. **Move the callee down too**, if it is itself leaf-shaped. `addUsage` only
   touches `localStorage` and pure helpers, so `usage.ts` moves *before*
   `phase.ts` (reordered below) and the problem disappears with no machinery.
2. **A settable hook, defaulting to a no-op**, when the callee genuinely belongs
   to the render/wiring layer — as `dlog` does, since it repaints the debug
   panel. The module owns the variable and exports a setter; `main.ts` wires it
   at startup. `format.ts`'s `setHome` is the shipped example; `rl.ts` gets
   `setRlLogger` when the forecast-vs-actual log (`fcLog`, `midSnap`,
   `maybeMidSnap`, `logWindowClose`, `onRlUpdate`) follows the rest of the
   rate-limit code down.
3. **An extra parameter** only as a last resort — it changes a signature the
   move is supposed to leave alone, and every test then has to pass a stub.

**Test conventions for these slices.** Decided across the first six, so they
needn't be rediscovered:

- **`localStorage` is stubbed by import order, not by a mock.** Leaf modules read
  their slice of it at *module scope* (`const usage = JSON.parse(localStorage…)`),
  and vitest's node environment has no such global — so `import { store } from
  "./localstorage"` must sit on the line **above** the subject's import, and ESM's
  evaluation order does the rest. `test/localstorage.ts` also exposes the backing
  map, so a test can seed it before import and assert on writes after.
- **Module state is reset in place, not re-imported.** The exported binding is the
  live object (`rl`, `usage`, `frecency`, `fcLog`), so `beforeEach` clears its keys
  the same way the app itself does on a rotation.
- **Fake timers by default.** `applyHook`/`applyStatusline`/`frecScore`/`todayKey`
  read `Date.now()` heavily; `vi.useFakeTimers()` + `vi.setSystemTime()` is what
  makes them deterministic. Build calendar fixtures from local components
  (`new Date(2027, 2, 14, 12)`), never from an epoch, or the day keys shift by zone.
- **Every new test must be shown to bite.** Apply mutations to the subject one at a
  time and confirm each turns the suite red. ~250 have been run so far across the
  six modules; the two survivors that remain were each shown to be *equivalent*
  mutants, and said so in the commit. A small script over a backup copy of the file
  works well — write it to the scratchpad, not the repo.
- **Say so in the commit message**: how many mutations, how many killed, and why
  any survivor is equivalent rather than a coverage gap.

**The `*view.ts` boundary, for the render half.** Decided across `usageview`,
`inspectorview` and `sidebarview`, so it needn't be re-argued. A `*view.ts` module
takes data and returns a **string**: no `$()`, no `innerHTML`, no renderer call. The
`render*` function that paints the result stays in `main.ts`, because what it owns is
the element, the timers and the delegated handlers the markup's `data-` attributes are
read by. Two consequences worth knowing before starting one:

- **A view module needs no seam.** None of the three took a hook, unlike every logic
  slice — a function that only reads data and returns a string has nothing to call
  upward. If a candidate seems to need `setSomething`, it is a `render*` and should
  stay behind.
- **Its dependencies must already be below it**, since it may not import `main.ts`.
  That is what pulled `statusKey` into `types.ts`, `mirror` into `state.ts`, and
  `gitBusy` into `inspectorview` itself. Prefer the module that *owns* the thing
  (`gitBusy` greys only the git buttons) over `state.ts` as a dumping ground.
- **Slice by line range with a guard, not by hand.** A ~20-line script that asserts
  each boundary line still says what you expect, then cuts, makes the move provably
  mechanical — `diff` the result against `git show HEAD:src/main.ts` and the only
  changes should be `export` keywords. The guard has already caught one wrong
  assumption about where a block started.
- **Smoke a view module by calling it with a hand-built input.** Driving it through
  the real pipeline in the browser does *not* work: vite serves an edited module
  under a `?t=` URL, so a dynamic `import()` gets a second instance with its own
  empty state, and the seeded data never reaches it.

**Extracting a DOM-owning module** (a dialog, a panel — `debug`, `worktree`,
`settings` so far). Different rules from a `*view.ts`, learned across those three:

- **It moves whole**, state and event handlers included. These dialogs' markup reads
  their own state (which row is armed, what is prefetched, which tab is open), so
  there is no view/controller seam to split them on — trying is what makes a mess.
  Handlers that address rows by index into the module's own array were never part of
  the global `[data-*]` dispatcher and should go with it.
- **`$`, `toast`, `dropScrim` come from `./dom`**, which exists precisely so these
  modules needn't import `main.ts`. `dlog` comes from `./debug`. Anything else it
  cannot own is a hook.
- **A control panel may take one host object instead of N setters.** `settings.ts`
  changes seven things it does not own; seven setters would be noise. State the
  deviation where it happens. Prefer per-callee setters below ~4.
- **Prefer moving shared state to the module that *owns* it**, not to `state.ts` by
  reflex — `gitBusy` went to `inspectorview` (it greys those buttons and nothing
  else), while `mirror`, `termEngine`, `termFontSize` and the dirty-folder cache are
  genuinely app-wide and went to `state.ts`. If two modules render the same thing
  (`SORT_META` — the rail glyph and the settings segment), move it, never copy it;
  a duplicate is a drift bug waiting to happen.
- **Smoke it through the app's own buttons, never a dynamic `import()`.** For a
  module that registers event listeners, a second instance means a second set of
  listeners: Escape appeared to close the worktree dialog *and* clear its filter in
  one press. Restart vite first so nothing is served under `?t=`, then click the real
  control. Reading module state back through a dynamic import is unreliable for the
  same reason — assert against the DOM.

- [x] `types.ts` — `Sess`, `Phase`, shared interfaces (no logic; unblocks the rest)
- [x] `format.ts` — `fmtDur`/`fmtUntil`/`fmtSpan`/`relTime`/`fmtDwell`, `esc`,
      `tilde`, `basename`, `sparkline`, `uUsd`/`uTok`/`uDelta`, `hslToHex`
- [x] `rl.ts` — `mergeRl`, `rlPct`/`rlReset`, `pushRlSample`, `burnRate`,
      `forecastWin` (the usage-limit forecast math)
- [x] `usage.ts` — `todayKey`, `addUsage`, `usageWindow`, `uBuckets`, `uSum`.
      Moved ahead of `phase.ts`: `applyStatusline` calls `addUsage`, and doing
      this first is what stops that becoming a seam (rule 1 above).
- [x] `phase.ts` — `applyHook`/`applyStatusline`/`setPhase` plus `toolArg`,
      `permCmd`, `riskLevel`, `abbr`, `applyTodos`/`applyPlan`. The heart of the
      display. `applyHook` moves clean; `applyStatusline`'s two upward calls are
      `addUsage` (gone by then, per above) and `onRlUpdate` — which reaches
      `dlog`, so the forecast-log block moves into `rl.ts` behind `setRlLogger`
      (rule 2 above) rather than `phase.ts` reaching up for it. Test the
      documented invariants: permission → attention, subagent depth suppresses
      phase flips, statusLine un-ends an "ended" session.
- [x] `palette.ts` — `fuzzy`, `scoreItem`, `parsePal`, `frecScore`
- [x] **`state.ts`** — the mutable app state: `sessions`, `activeId`, `FAVORITES`,
      `sortMode`, `wtGroup`, `projOrder`. *Inserted 2026-07-25*, because
      `grouping.ts` cannot be done without it: of its five functions only
      `clusterByWorktree` and `urgencyRank` are leaves, `splitByWorktree` reads
      `FAVORITES`, and `projectList` needs `allProjects()` + the three sort/group
      variables — which `nextAfterClose` then inherits by calling it. Ground rule 3
      already anticipates this module. A pure relocation: no new tests of its own,
      it exists so the next slice has something to import.
      **Decided: `setX` per variable** (the `setUsageRange`/`setTokenDays` half),
      settled by counting the call sites — 183 reads against 7 writes. Reads are the
      **live ESM binding**, so they stay bare identifiers (`activeId`, never
      `state.activeId`) and the slice touches only the writes; the object would have
      rewritten all 183, which ground rule 2 is there to prevent. A setter **assigns
      and nothing else** — persistence and `renderAll()` stay at the call site that
      already did them. `sessions` is a `const` Map, so it needs no setter at all,
      and that alone is 98 of the reads. `main.ts` keeps its own `setWtGroup`
      (validate → persist → repaint) and imports the state one aliased, rather than
      renaming either. Do not mix in an object later.
- [x] `grouping.ts` — `clusterByWorktree`, `splitByWorktree`, `urgencyRank`,
      `projectList` ordering, `nextAfterClose`. Depends on `state.ts` above.
      `projectList` and `nextAfterClose` are the fiddliest untested logic left —
      sidebar ordering and which pane takes over on close.
      `allProjects` came too (`projectList` is a sort *of* it), and with it three
      more callees, all resolved by seam rule 1 rather than a hook: `externals` and
      `dormants` are plain state and moved into `state.ts` under its setter
      convention (4 writes), and `accentFor` followed its `colorOverrides` map there
      — it cannot live in `format.ts`, which `state.ts` already imports. `branchHue`
      stayed in `main.ts`: it colours a chip, so it is render.
- [x] Runnables frontend logic — the pure parts: `stopRuleBlocked`, the
      `launchWithDeps`/`waitForExit` chain rules (label resolution, sequence vs
      parallel, failed-dep stops chain), `${input:…}` substitution glue.
      Landed as `tasks.ts`, plus `execCmd`, `applyRunner` and the remembered-input
      store. First slice to need **three** seam-rule-2 hooks at once —
      `setTaskLauncher` (a pane + PTY), `setTaskLogger`, `setTaskToast` — because
      the chain narrates and reports as it goes. Assert *when* each dependency
      starts, not just the result: parallel vs sequence is otherwise the same
      final state. Surfaced the dependency-resolution bug below.
- [x] Render modules — *no unit tests, size/readability only*: `sidebar.ts`,
      `inspector.ts`, footer + usage popup, debug panel, DnD.
      **Six done.** Markup-only (`*view.ts`, see the boundary below): `usageview`,
      `inspectorview`, `sidebarview`. DOM-owning, moved whole with their state and
      handlers: `debug`, `worktree` (the new-session dialog, 932 lines — the biggest
      single cluster), `settings`. Plus `dom.ts` (`$`, `toast`, the shared scrim) and
      the task preference state relocated into `tasks.ts`.
      Since: `taskui` (the ▶ Run picker + the project tasks panel), `caffeinate`,
      `diffview`, and task discovery + the preference state folded into `tasks`.
      Then `icons` (the per-project glyph store) — not a render module itself but the
      seam-rule-1 prerequisite for `sidebar`, since `projGlyph`/`iconFor` are read by
      four surfaces (sidebar rows, mini-rail, palette, colour popover) and so belong
      below all of them. Then `sidebar` (`renderSidebar` + `renderMini` + the project
      reorder + the file drop), which also moved `IS_MAC`/`MOD`/`chord` into `dom.ts`
      for the same reason.

      **New constraint learned here: `dom.ts` must not touch the DOM at module scope.**
      `./debug` imports it, so vitest pulls `dom.ts` into the node environment through
      every logic module that logs — putting the `if (!IS_MAC)` index.html glyph rewrite
      there turned `test/tasks.test.ts` red with `document is not defined`. The
      constants are fine (`navigator.userAgent` exists in node); the rewrite is bootstrap
      and stays in `main.ts`.

      Then the **needs-you cluster** (`needsYou`, `needsYouSessions`, `reactorState`,
      `reactorLabel`) into `grouping.ts` — *with* tests, because it is logic, not
      markup. Two render modules want it (the header reactor badge and the tray title),
      so neither can own it, and it is the same fleet `urgencyRank`/`orderedSessions`
      already read: not "what order does the sidebar show these in" but "which of them
      is waiting on the human". `PILL_TEXT` went to `types.ts` on `statusKey`'s
      three-reader argument.
      Then `tray` (the native menu-bar mirror) and `footer` (the status bar,
      `closeFootMenus` and its four popovers — usage, shortcuts, terminal-engine,
      reactor). The **header reactor badge went into `footer`** despite not being in the
      footer: `closeFootMenus` is the only-one-menu-open rule and the badge's dropdown
      is one of them, so splitting them would have each module importing the other's
      close function. `setEngine` came too — it is the engine popover's action.

      That closes evidence group 1 bar the stage itself, done last (below).

      Group 2 (cosmetic, no profiling payoff) then began with `palui` — the ⌘K box
      beside the `palette` that already held its tested decisions, the same split
      `tasks`/`taskui` has. It is the widest-reaching surface in the app, so it takes
      **one host object of twelve callees** rather than twelve setters, on `settings.ts`'s
      precedent. The terminal-engine popover, also listed under group 2, had already
      gone out with `footer`.
      Then `projmenu` — the project context menu *and* the appearance/colour panel,
      one module because the panel is also the menu's Appearance submenu and each
      closes the other. Six callees, so another host object.
      Then the `${input:…}` prompt into `taskui` — the last group-2 item. It needed no
      hook of its own, and *removed* two: it was a member of both `taskui`'s and
      `palui`'s host object, and is now a plain import from the module whose two
      surfaces are its only callers (seam rule 1 again).

      Last, `inspector` — the named module the two evidence groups never listed, because
      `inspectorview` already held all of its markup. What was left is the dispatcher
      (`renderInspector`) plus the two cards that are *not* an agent's: the shell card
      and the task-run card with its four per-`Sess` button listeners. On `renderAll`'s
      hot path, so it belongs to group 1 in spirit and was done last only because
      `PILL_TEXT` had to reach `types.ts` first.

      **Deliberately left in `main.ts`, and not oversights:**
      - `renderHeader` (10 lines) and `syncStageButtons` (10) — the stage's chrome, and
        small enough that a `stage.ts` would be a file per twenty lines.
      - `renderExtHeader`/`renderExtInspector`/`extPeekHtml` and
        `renderPastHeader`/`renderPastInspector`/`renderTranscript` — the read-only
        mirrors. They are not a render cluster on their own: each is welded to the
        `openExternal`/`openDormant`/`loadTranscript` machinery beside it, and that
        whole external+dormant block is one candidate for the bootstrap trim below.
      - `renderAll` itself, which is the orchestration the next item is named after.

      **What remains is not equal, so it is ordered by evidence rather than by
      file order** (decided 2026-07-25 after asking what the split is actually
      *for*). These modules get no tests either way, so the only payoffs are the
      bootstrap trim and the Phase-3 profiling pass — and that pass names its
      suspects: the nine `setInterval`s, and `renderAll()` firing `renderSidebar` +
      `renderMini` + `renderFoot` + `renderAttn` + `updateTray` unconditionally on
      **every telemetry event**.

      1. **`renderSidebar` / `renderMini` / the DnD, the tray mirror, the footer
         (`renderFoot` + `closeFootMenus` and its popovers).** Worth doing: these
         are exactly the surfaces on `renderAll`'s hot path, and the profiling pass
         needs each one isolated before it can ask "did this need to repaint?".
      2. **The ⌘K palette UI, the project context menu, the terminal-engine
         popover, the inputs prompt.** Cosmetic only — they render on demand, never
         from `renderAll`, so isolating them tells the profiling pass nothing. Do
         them last, or leave them for the bootstrap trim to sweep up.

      Note the palette's *decisions* are already extracted and tested (`palette.ts`,
      39 tests): fuzzy match, scoring, prefix parsing, frecency. Only the painting
      is left, which is why moving it buys no coverage.
- [x] `main.ts` reduced to bootstrap: state, the `listen()` handlers,
      `renderAll()` orchestration

      Started 2026-07-26 from 1,593 lines. First out: **`update.ts`** (app self-update
      + the footer version label). It is the one cluster in what remains that needs
      *nothing* from main.ts — the only thing it asks about the rest of the app is how
      many live panes an install would kill, and that is `./state`. So it takes no hook
      and exports nothing either: `import "./update"` for its side effects **is** the
      wiring. First module in the repo imported that way; say so at the import, or it
      reads like a leftover.

      Ordered by independence, what is left in `main.ts` and where it should go:
      1. ~~The external + dormant block~~ — **done, as `mirror.ts`** (274 lines out).
         Named for what actually unites the two halves: the `mirror` stage pointer in
         `state.ts`, which is mutually exclusive with `activeId`. Everything in it
         either sets that pointer, repaints what it points at, or reconciles it when
         the thing it points at goes away — which is also the answer to why the four
         read-only `render*` functions belong here and not in `inspector.ts`: each is
         welded to the open/load machinery beside it and none is ever called with a
         `Sess`. `refreshDirtyStates` came too (it feeds both the sidebar dot and the
         external diff card, and `openExternal` calls it). Three seam-rule-2 setters.
      2. ~~The run-on-stop / task-run block~~ — **done, as `taskrun.ts`**, and the
         prediction held: it *removed* a host. `inspector.ts` existed with a
         three-member host object solely because `rerunTask`/`revealSource`/
         `sendOutputToSession` were in `main.ts`; they are now below it, so
         `setInspectorHost` is gone and it imports them. `launchTask` did **not** come
         along — it builds a pane (xterm, PTY, `Sess`), so it belongs to item 3 and is
         a `setTaskRunLaunchTask` seam until then.
      3. ~~The pane layer~~ — **done, as `terminal.ts` then `panes.ts`.** The xterm half
         all three spawners share went first (seam rule 1, the way `icons.ts` preceded
         `sidebar.ts`) and needed no hook; then the three spawners themselves, the
         session lifecycle, the stage chrome (`renderHeader`, `syncStageButtons`) and
         the two context resolvers, behind a single `setPanesRenderAll`.

         **One decision worth recording: `panes.ts` keeps `taskrun.ts`'s three setters
         alive on purpose.** `taskrun` could import `setActive`/`closeSession`/
         `launchTask` directly and drop them — except `inspector.ts` imports `taskrun`
         and `panes` imports `inspector` (for `renderInspector`), so a direct import
         would close the loop `inspector → taskrun → panes → inspector`. Ground rule 3
         forbids that, and three setters are the cheaper side of the trade. A
         `scripts`-free cycle check over `src/*.ts` reports **no cycles across 33
         modules**; run it again after any slice that adds an import.

         `runGit` followed in the same shape a commit later — it acts on a session's
         workdir and re-reads that session's stats, so `panes` already had everything
         it needs. That one *did* shrink a host: `palui` imports it now instead of
         taking it as an eleventh member, and the cycle check still reads clean.

      4. **`actions.ts`** (added to the order once 1–3 were out and what remained was
         visible): the small app-level verbs several surfaces trigger and none owns —
         `addProject`/`addProjectPath`/`removeFavorite`, `openProjectFolder`,
         `resolvePermission`, `setSort`/`cycleSort`, `toggleRail`/`toggleInsp`, the
         theme trio, and the app-level `setWtGroup`. All one shape, which is the reason
         they are not in `state.ts`: **mutate the preference, persist it, repaint.**
         `state.ts`'s setters assign and nothing else (PLAN's own `setX` decision); the
         persistence and the repaint are this layer's. One hook, `setActionsRenderAll`.

      **Done.** What `main.ts` holds now, and deliberately: the imports and the whole
      of the `setXHost` wiring (~70 lines — it is the seam map, and belongs in the file
      that owns the graph), the one-time startup blocks (legacy-localStorage recovery,
      the non-mac ⌘-glyph rewrite of index.html, engine validation, the theme
      override), `renderAll()`, every `listen()` handler, the delegated `[data-*]`
      click dispatcher and the global keydown, the ResizeObserver, the quit guard with
      its `listPhrase` helper, the debug-console button wiring, and the nine
      `setInterval`s. That is the item's own definition of bootstrap.

## Phase 2 — split `lib.rs` into modules

Existing tests move with their subjects. The compiler and the Phase-0 net carry
this phase.

**Two decisions, made in the first slice as the kickoff prompt asked.**

- **`AppState` and `Session` stay in the crate root**, reached as `crate::AppState`
  from every module. No `state.rs`. Three reasons: `run()` is their only
  constructor and it lives in `lib.rs`, so the owner and the definition stay
  together; Rust needs no setter convention to keep the boundary honest —
  `pub(crate)` fields plus the compiler do what Phase 1 needed 7 `setX` functions
  for; and a `state.rs` holding two structs would be a file per 34 lines, which is
  the same argument that kept `renderHeader` out of a `stage.ts`. The cfg-gated
  `caffeinate` field also means a `state.rs` would have to import `KeepAwake` back
  out of the platform layer for no gain. Don't mix in a `state.rs` later.
- **`platform.rs` goes first, not last.** The greps settle it: `sys_command` 18
  uses, `norm_path` 12, `sh_quote` 11, `home_dir` 9 — every other Phase-2 module
  calls them, so this is seam rule 1 (move the callee down first), the same reason
  `icons.ts` preceded `sidebar.ts`. Confirmed too that `git_cmd`/`git_run` are
  git-only *and* that `git_cmd` itself calls `augmented_path` — so `git.rs` depends
  on `platform.rs`, not the reverse.

  **What `platform.rs` does *not* take**, and the rule behind it: a cfg-gated
  helper with a single consumer module belongs to *that* module. So
  `apply_utf8_locale`, `interactive_shell` and `task_shell` are held for `pty.rs`
  (`apply_utf8_locale` takes a `portable_pty::CommandBuilder`, which is the tell —
  the leaf layer must not import `portable_pty`), and `same_path` for `git.rs`.
  `resolve_claude`/`augmented_path` *did* come, because `augmented_path` is called
  from `git_cmd` as well as the launch engines.

**Two mechanics confirmed by compiling, not by reasoning** — both were open
questions in the kickoff prompt:

- **`pub(crate)` works on a `#[tauri::command]` fn** in a private module, so the
  prompt's "`pub(crate)`, never `pub`" rule holds throughout and needs no exception.
  (`tasks.rs` uses plain `pub`, which reads like a counter-example but isn't: `mod
  tasks;` is private, so `pub` inside it is unreachable from outside the crate
  anyway. Don't "fix" `tasks.rs` — PLAN says don't touch it.)
- **Struct *fields* need no annotation at all.** A private field is visible to the
  defining module *and every descendant*, and every module here is a descendant of
  the crate root — so `git.rs` reads `state.sessions` and `s.workdir` with
  `AppState`/`Session` fields left exactly as they were. Only the structs
  themselves take `pub(crate)`, and only to satisfy the private-in-public lint on
  a `pub(crate) fn` that names them. This is a second argument for the crate-root
  decision above: a `state.rs` would have needed `pub(crate)` on every field.

- [x] `platform.rs` (moved to the front — see above) — `home_dir`, `norm_path`,
      `sys_command`, `resolve_claude`, `augmented_path`, `sh_quote`, `ps_one`, and
      the three tests over them. 173 lines, verified line-sorted against `HEAD` with
      one intended difference: `ps_one`'s doc comment said "the cross-platform
      `ProcTable` below", which the move made false.
- [x] `git.rs` — worktrees, branches, diffs, commit info (largest tested block).
      1,006 lines of source in one contiguous block (`create_worktree` through
      `git_action`) plus 15 of the 69 tests. `same_path`, `git_cmd`, `git_run`,
      `upstream_state` and `remove_worktree_impl` stayed private to it; only
      `git_repo_info` crosses back (`list_external_sessions` calls it).

      **Also added: `#[cfg(test)] mod testutil;`** — `scratch_dir` is used by the git
      tests, the transcript tests and (later) the usage tests, so it cannot live in
      any one of them, and copying it per module is the `SORT_META` drift bug. It
      holds `scratch_dir` + its `COUNTER` and nothing else: `wt_root`, `git()` and
      `commit()` have a single owner and went into `git.rs`'s own test mod. Resist
      growing it — a helper belongs here only once a *second* module needs it.
- [ ] `telemetry.rs` — server + `write_instrument_settings`. The Phase-0 server
      test already covers the sid-forcing end-to-end; optionally lift it into a
      pure function here for cheap edge-case tests (no sid header at all,
      unparseable body, non-object payload)
- [ ] `pty.rs` — `stream_pty_session` + the spawners
- [ ] `external.rs` — registry parsing, `ProcTable`, focus
- [ ] `usage.rs` — `scan_usage` + `parse_usage_line`; inject a base dir
      (default `~/.claude`) so `scan_usage`, `list_past_sessions`,
      `read_transcript` become testable, then test them
- [ ] `icons.rs`, `platform.rs` — icon probing, cfg-gated OS helpers

## Phase 3 — due diligence & polish

- [ ] Doc drift: CLAUDE.md gets the module map (replaces the "one file"
      descriptions); README mentions the Windows embedded port; SPIKE.md marked
      historical
- [ ] Clippy: fix warnings, then drop the `|| true` in CI — a linter that can't
      fail is decoration
- [ ] **Profiling pass: does anything still work when nobody is looking?**
      Prompted by the debug-snapshot finding above, which was only noticed because
      the UI got sluggish — nothing in the test net can see this class of problem.
      The rule to check against: *periodic and per-event work should be skipped when
      its output is not visible, and skipped when nothing changed.* Not a rewrite —
      the render-everything-via-`renderAll()` pattern stays (see Out of scope); this
      is about the guards around it, which is why it belongs after the Phase-1 render
      split, when each surface is its own module and can be reasoned about alone.

      Confirmed offender (measured): the 4s `flushDebug` interval, above.

      Leads to measure, *not yet verified* — check before believing:
      - the nine `setInterval`s in `main.ts` (external-session poll 3s, dirty states
        5s, branches 4s, worktree age 1s, transcript mirror, debug flush 4s, plus
        three others) — which of them run while their surface is hidden, or while the
        window is entirely unfocused?
      - `renderAll()` runs `renderSidebar()`, `renderMini()`, `renderFoot()`,
        `renderAttn()` and `updateTray()` unconditionally on **every** telemetry
        event — does the mini-rail render while the sidebar is expanded, and does the
        tray menu get rebuilt on every hook?
      - `renderDbgBadge()` + `dbgIssues()` on every `dlog()`, i.e. every hook.
      - `document.hidden` / window-blur is not consulted anywhere. A fleet of agents
        streaming hooks into a background window is the app's normal state.

      How to measure without the OS edge: `pnpm dev` and profile the frontend in a
      browser (see *Verifying a slice by hand*) — the Tauri calls throw but the
      timers, the render path and the JSON work are all real and show up in a
      performance trace. For the IPC and disk half, watch the snapshot file's write
      rate and size. Record findings here; fix the cheap ones, and split anything
      structural into its own commit with a before/after measurement.

- [ ] Dead-code and TODO sweep, both sides
- [ ] Optional: coverage as a yardstick (`@vitest/coverage-v8`, `cargo llvm-cov`)
- [ ] Manual release smoke checklist (launch → telemetry arrives → answer a
      permission → resume → external session visible → task run + on-stop rule)
- [ ] **CLI contract test against real `claude -p`**, marked `#[ignore]` and run
      via `cargo test -- --ignored` as part of the release checklist — never a PR
      gate (needs `claude` on PATH, auth, tokens, and it is slow). Rationale: the
      app rides several interfaces of an external tool that ships weekly and that
      CLAUDE.md itself calls unstable — the hook schema, the statusLine JSON,
      `~/.claude/sessions/<pid>.json`, and the transcript record types. If a
      release renames a field, everything still compiles, no test goes red, and
      telemetry simply goes quiet. The test writes a real instrument settings
      file, runs `claude -p` against a **throwaway** session in a temp dir (never
      a real one — resuming appends to it) and asserts our hooks actually hit our
      server.

## Findings from the Phase-1 slices

Extracting-then-testing found six things. Four were fixed (each in its own
commit, after the moves landed — never in the same commit as a move); two are
open and neither is caused by this effort.

**Fixed** (`d2f035e`) — an unresolvable dependency ran the task anyway. `resolveDeps`
returned `[]` for three different questions — the task has no dependencies, a label
matched nothing, and this is a cycle — and `launchWithDeps` read all three as
"nothing to wait for". So renaming a `build` task silently made every task that
`dependsOn` it run *without* it, behind a toast that named the missing label but not
the consequence; a cycle ran its members without their own dependencies. The exact
outcome the chain exists to prevent, and the opposite of what its own comment
promised. `null` now means "could not resolve" and `[]` keeps meaning "has none".
Found by writing the chain tests, not by reading the code — the test that deadlocked
was the tell.

**Fixed** (a name collision that silently disabled a settings control) — the settings
window's **worktree-grouping** picker called `state.ts`'s `setWtGroup`, not the
app-level one in `actions.ts`. Same name, two different jobs: state's setter *assigns
and nothing else* (that is the `setX` convention this plan chose deliberately), while
the app-level one assigns, writes `cc-worktree-group` and calls `renderAll()`. So
picking a mode from Settings changed the in-memory value and repainted the settings
picker only — the sidebar did not regroup until some unrelated telemetry tick, and the
choice was gone on restart. Found while extracting `actions.ts`, which is what put the
two same-named functions in front of each other for the first time. Fixed by routing it
through `SettingsHost` (an eighth member); a direct import would be a cycle, since
`actions.ts` imports `settings.ts` for `renderSettings`. No test: `settings.ts` is
DOM-owning and untested by design, so the check is the click-through — this one is
*visible*, the sidebar regroups the moment you pick.

**Fixed** (`6949087`), each with the failing test written first:

- `riskLevel` under-rated `rm -rf`. `rm\s+-[rf]` matched one flag letter and the
  following `\b` then fell between the r and the f, so the combined form never
  matched: `rm -r x` rated high while `rm -rf x` rated "review". Now `-[rf]+`.
- `fuzzy`'s word-start class omitted the backslash, so on Windows no path segment
  in a palette subtitle was a word start. Not cosmetic — the ranking *inverted*,
  because a missing bonus costs 4.0 against a position penalty of 0.02/index. For
  query `resp`, `E:\code\Respeak` scored 13.24 and lost to `x-response-log` at
  17.08; it now scores 17.24 and wins, matching macOS. Same oversight class as the
  Windows-path bug already fixed in `basename()`.

**Open — statusLine telemetry does not arrive on Windows.** Observed 2026-07-25 on
an installed v0.10.1: across six live sessions and ~3,900 routed events, `model`,
`ctxPct`, `cost`, `durMs` and all four `rateLimits` fields were null. Those come
*only* from `applyStatusline`. Isolated as far as the transport: a hand-rolled POST
to `/statusline` with a bogus `X-CC-Session` returned HTTP 200, incremented `rx`,
and logged `statusline telemetry for unrouted session … — dropped`, so the
`tiny_http` server, the route, the header-forcing, the `curl.exe` path and the
unrouted detection all work. The generated instrument file has the statusLine
configured correctly (`shell: "powershell"`, absolute `curl.exe`). So the failure is
upstream: Claude Code is not invoking the command, or it fails before reaching curl.
**Not yet reproduced on 0.11.0 — confirm that first.** This matters to the plan:
`usage.ts`, `rl.ts` and roughly half of `phase.ts` are the statusLine path, so about
a hundred of the new tests currently guard code that never runs on this platform.
The tests are not wasted — they are what will tell you the logic is right once the
input returns — but do not read them as evidence the feature works. This is exactly
the drift the Phase-3 CLI contract test exists to catch, which argues for pulling
that item forward.

**Open — the debug snapshot flush costs the same whether anyone is watching.**
Observed 2026-07-25: the UI went visibly sluggish (hover animations trailing the
cursor, laggy pane selection) on an instance with six live sessions, and clearing
the debug log fixed it **while the panel was closed** — which is the evidence that
matters, because it rules out the panel's own rendering.

The cause is `setInterval(flushDebug, 4000)`, unconditional and never cleared.
`flushDebug` builds `dbgSnapshot()` — which embeds `dbgLog.slice(-250)` — then
`JSON.stringify(…, null, 2)`, *pretty-printed*, ~29KB in practice, hands that string
across the Tauri IPC boundary, and Rust writes it to disk. Every four seconds,
forever, whether the panel is open, whether anything changed, whether the log is
worth writing. Clearing the ring cut the `log:` array from 250 entries to 0 and so
cut the stringify, the IPC payload and the disk write by roughly 90% — hence the
immediate relief. Secondary, on the same hot path: `renderDbgBadge()` runs on
*every* `dlog()` and `dbgIssues()` reduces the whole 400-entry ring each time.

Note the snapshot is *meant* to be written with the panel closed — CLAUDE.md says
its purpose is letting an external tool or an agent read live state while the app
runs — so the fix is not "only flush when visible" but "flush cheaply and only when
something changed": drop the pretty-printing, skip the write when the snapshot is
unchanged, and stop re-slicing the log ring on every tick. See the profiling item
in Phase 3; the debug panel is already on the Phase-1 render-module list.

## Verifying a slice by hand

Ground rule 4's click-through, made concrete — the automated net stops at the OS
edge and this is the only thing that covers it.

- **Never run `pnpm tauri dev` from inside an Episko pane.** Check with a process
  ancestry walk first. A dev build launched from a pane becomes a descendant of the
  installed app, so `ProcTable::is_descendant_of` filters its sessions out of the
  external list, and — worse for verification — the two share one `localStorage`
  and one `episko-debug.json`, so the snapshot cannot be attributed to either.
  Quit the installed app and use a real terminal.
- **Telemetry arriving** = the 🐞 console's `telemetry: rx N · routed N · dropped N`.
  `rx` climbing is arrival; `dropped` (shown in warn colour) is routing drift. A
  fresh instance reads `rx 0` until a session is launched *inside it*. Note hooks
  log a line each but **statusLine deliberately does not** — the way to see that
  half is the inspector's model / context % / cost / duration and the footer meters.
- **Permission answerable** = ask a session to run something needing approval; the
  pane must raise `permission: <tool>` with the command preview and a risk chip,
  and clicking allow / deny / hand-to-terminal must unblock Claude. It is a
  *blocking* hook: if the UI does not answer, Claude hangs. Also answer once
  directly in the CLI and confirm the badge clears on the next lifecycle event.
- **Paths (Windows):** snapshot `%TEMP%\cc-launcher\episko-debug.json` (state-of-now,
  overwritten each flush, lost on a crash); durable log
  `%LOCALAPPDATA%\io.respeak.episko\logs\episko.log`. macOS equivalents in CLAUDE.md.
- **Frontend-only smoke, when the full app can't be run:** `pnpm dev` and load
  `localhost:1420` in a browser. It gets its own origin and its own `localStorage`,
  so it is isolated from any installed app. Tauri `invoke`/`listen` calls throw
  (no backend) but module evaluation, the startup wiring and `renderAll()` all run,
  and modules can be imported and exercised directly from the console. This is what
  caught nothing and confirmed everything after the first four slices — it verifies
  the wiring executes, which no unit test does.

## On integration tests

Decided 2026-07-24, so it needn't be re-argued mid-restructure.

- **No `src-tauri/tests/` directory.** Those tests only see the crate's public
  API, which here is `run()` and nothing else. Using them would mean widening
  visibility purely for test access — the wrong trade. Rust's own convention
  puts unit tests in-file (`#[cfg(test)] mod tests`) precisely so they can reach
  private items, which is what every existing test depends on.
- **The valuable integration tests already exist**, just in the unit-test
  position: the git ones drive real `git` against real temp repos (bare remotes,
  locked worktrees, hand-deleted checkouts). That is real integration, and it is
  the model for anything new.
- **Two seams were still uncovered**, and both are now scheduled: the telemetry
  loop (Phase 0) and the Claude Code CLI contract (Phase 3).
- **Frontend:** `mockIPC` from `@tauri-apps/api/mocks` lets vitest exercise code
  that calls `invoke()` with no backend — so Phase-1 modules that talk to Rust
  are testable and needn't be left out. Full jsdom render tests are *not*
  planned: snapshotting template literals mostly re-asserts itself. At most a few
  smoke tests that representative states don't throw.

## Out of scope (deliberately)

- E2E automation of the OS edge — `tauri-driver` doesn't support macOS, and the
  cost/benefit is poor; the smoke checklist covers it.
- `styles.css` split, framework adoption, render diffing, rewrites of any kind.

## Kickoff prompt — Phase 2

Paste into a fresh session on this branch. Written to be worked **autonomously** — the
effort has stalled before on an agent stopping at a tidy checkpoint that was not a
blocker. (The Phase-1 version of this prompt is in git history; Phase 1 is done.)

> Read PLAN.md and CLAUDE.md first. PLAN.md is the tracker and its ground rules bind
> you. The decisions already recorded there — ground rules 1–5, *On integration tests*,
> and the Phase-2 module list — were settled in earlier sessions and are **not to be
> re-argued**. Phase 0 and Phase 1 are done; **Phase 2 splits `src-tauri/src/lib.rs`
> (4,711 lines) into modules.**
>
> **Work the plan without checking in.** Take the first unchecked item of Phase 2, land
> it as its own commit, then take the next one, and keep going. Do not stop between
> slices to summarise, do not ask whether to continue, and do not treat "this is a
> natural place to pause" as a reason to stop — it isn't. Stop only when the phase is
> complete or you hit a real blocker.
>
> **Real blockers** — the only reasons to stop and ask:
> - Something needs the app *run interactively*.
> - A behaviour change that is not a bug fix — a default, a wording, anything where
>   "correct" is a product call rather than a contradiction in the code.
> - A seam or decision PLAN's rules genuinely do not cover. Record what you decide;
>   don't invent an answer silently.
> - Anything outward-facing: pushing, releasing, touching a remote.
>
> Running low on context is not a blocker — it is a handoff. Update PLAN.md so the next
> session can continue without the user, then say so.
>
> **What a Rust slice is, concretely.** The Phase-1 recipe carries over — guarded
> line-range slice → wire → gates → diff the relocated block against
> `git show HEAD:src-tauri/src/lib.rs`, where the only differences should be the seams
> you intended. What changes is the seam mechanism. There is no hook rule here; Rust
> has real visibility:
>
> - **`mod x;` in `lib.rs`, `pub(crate)` on anything crossing the boundary, `use
>   crate::x::…` at the consumer.** `pub(crate)`, never `pub` — the crate's public API
>   is `run()` and nothing else, and *On integration tests* depends on that.
> - **`#[tauri::command]` fns must stay in `tauri::generate_handler![…]`.** Path-qualify
>   them the way the already-extracted module does (`tasks::discover_runnables`,
>   `tasks::save_episko_task`). Reassuringly this one is compiler-caught: a command that
>   falls out of scope fails the build rather than silently vanishing at runtime.
> - **Tests move with their subjects, in-file.** `#[cfg(test)] mod tests` inside the new
>   module, so they still reach private items — that is the whole reason PLAN refused a
>   `src-tauri/tests/` directory. `tasks.rs` (39 tests, its own module, `use super::*`)
>   is the shape to copy.
> - **`tasks.rs` is already the target pattern and needs nothing.** Don't touch it.
>
> **Three traps specific to this phase.**
>
> 1. **`#[cfg]` pairs must move as pairs.** `lib.rs` has 34 cfg-gated items, many as
>    `#[cfg(windows)]` / `#[cfg(not(windows))]` twins: `resolve_claude`,
>    `augmented_path`, `apply_utf8_locale`, `interactive_shell`, `task_shell`,
>    `find_ghostty`, `available_terminals`, `spawn_external_terminal`,
>    `open_terminal_here`, `focus_external_session`, `ps_one`, `set_caffeinate`
>    (+ `KeepAwake`, `execution_state_for`), and the macOS-only legacy-localStorage
>    readers. Take one half and it still compiles **on your platform** and breaks the
>    other in CI, which runs both. Grep each name before you cut and check you have
>    every arm.
> 2. **The test count is platform-specific.** 73 `#[test]` fns are declared; **69 run on
>    Windows**, because some are cfg-gated. So the check is "`cargo test` reports the
>    same number as it did before this slice", not a number copied out of this file. A
>    dropped or orphaned test changes it.
> 3. **Don't tidy `build.rs`.** Its `/MANIFESTDEPENDENCY` link arg exists because
>    building a `tauri::App` in a test harness gets no manifest and the exe dies at load
>    with `STATUS_ENTRYPOINT_NOT_FOUND` before any test runs. The rationale is in the
>    file. It looks removable and is not.
>
> **Two decisions to make in the first slice, and record.**
>
> - **Where `AppState` and `Session` go.** 18 sites take `State<AppState>`, and the pty,
>   telemetry, caffeinate, external and tray clusters all touch it — this is Phase 1's
>   `state.ts` question again. Either a `state.rs`, or leave it in the crate root where
>   every module reaches it as `crate::AppState`. Pick one, say why, don't mix.
> - **Whether `platform.rs` really comes last.** PLAN lists it last, but the shared leaf
>   helpers live in it and everything else calls them: `sys_command` (17 uses),
>   `norm_path` (12), `sh_quote` (11), `home_dir` (9). That is Phase 1's seam rule 1 —
>   move the callee down first — and it is what made `icons.ts` precede `sidebar.ts` and
>   `terminal.ts` precede `panes.ts`. Check the greps yourself before reordering, and
>   note that `git_cmd` (15) / `git_run` (8) are git-only and belong in `git.rs`.
>
> **Gates, all green before every commit:** `cargo test` in `src-tauri/` — that is the
> real net here, and far stronger than the frontend had. Also `pnpm exec tsc --noEmit`
> and `pnpm test` **only if you touched TypeScript**, which this phase should not.
> `cargo clippy` is advisory (CI runs it with `|| true`, and it may not be installed) —
> don't block on it. Use **pnpm**, not npm.
>
> **If you find a real bug:** finish the move first, flag it, then fix it in its own
> commit with the failing test written first. Never in the same commit as a move.
>
> **Report honestly.** If a verification step examined nothing, say so rather than
> reporting that it passed — that has happened on this effort, twice through a diff
> window a few lines short. Compare the two blocks **line-sorted**, so a pure reorder
> reads as identical and a real edit still shows. If tests fail, show the output. If you
> skipped part of a slice, name it.
>
> **Two open findings are worth more than another module, and one of them needs the
> user:** see *Findings from the Phase-1 slices*. The Windows statusLine one in
> particular blocks reading roughly a hundred of the new frontend tests as evidence the
> feature works — and Phase 2's `telemetry.rs` is the module that half runs through.
