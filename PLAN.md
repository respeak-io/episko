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

**Status 2026-07-25:** Phase 0 done. Phase 1 six slices in — `types`, `format`,
`rl`, `usage`, `phase`, `palette` extracted and tested. Green: **237 vitest + 69
cargo**, `tsc --noEmit` clean. `main.ts` 5,705 → 5,348 lines. Next slice is
`state.ts` (see Phase 1), then `grouping.ts`. Two bugs found and fixed along the
way, two open findings — all four under *Findings from the Phase-1 slices* below.

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
- [ ] **`state.ts`** — the mutable app state: `sessions`, `activeId`, `FAVORITES`,
      `sortMode`, `wtGroup`, `projOrder`. *Inserted 2026-07-25*, because
      `grouping.ts` cannot be done without it: of its five functions only
      `clusterByWorktree` and `urgencyRank` are leaves, `splitByWorktree` reads
      `FAVORITES`, and `projectList` needs `allProjects()` + the three sort/group
      variables — which `nextAfterClose` then inherits by calling it. Ground rule 3
      already anticipates this module. A pure relocation: no new tests of its own,
      it exists so the next slice has something to import.
      **Open question for whoever takes it:** one mutable exported object that
      `main.ts` writes directly (the `rl` precedent), or a `setX` per variable (the
      `setUsageRange`/`setTokenDays` precedent)? The object scales better at a dozen
      variables; the setters make writes greppable. Pick one, record it here, and
      apply it consistently — do not mix.
- [ ] `grouping.ts` — `clusterByWorktree`, `splitByWorktree`, `urgencyRank`,
      `projectList` ordering, `nextAfterClose`. Depends on `state.ts` above.
      `projectList` and `nextAfterClose` are the fiddliest untested logic left —
      sidebar ordering and which pane takes over on close.
- [ ] Runnables frontend logic — the pure parts: `stopRuleBlocked`, the
      `launchWithDeps`/`waitForExit` chain rules (label resolution, sequence vs
      parallel, failed-dep stops chain), `${input:…}` substitution glue
- [ ] Render modules — *no unit tests, size/readability only*: `sidebar.ts`,
      `inspector.ts`, footer + usage popup, debug panel, DnD
- [ ] `main.ts` reduced to bootstrap: state, the `listen()` handlers,
      `renderAll()` orchestration

## Phase 2 — split `lib.rs` into modules

Existing tests move with their subjects. The compiler and the Phase-0 net carry
this phase.

- [ ] `git.rs` — worktrees, branches, diffs, commit info (largest tested block)
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

Extracting-then-testing found four things. Two were fixed (in their own commit,
after the moves landed — never in the same commit as a move); two are open and
neither is caused by this effort.

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

**Open — the debug console is expensive while open.** `dlog()` runs on every hook
event and, when the panel is open, calls `renderDbgPanel()`, which rebuilds a
250-row log plus a session table through `innerHTML`, and fires an `invoke` per
line. Under a normal multi-session hook rate this makes the whole UI visibly
sluggish (hover animations trailing the cursor). Underneath it is the deliberate
render-everything-per-event design, which CLAUDE.md documents and which is out of
scope here. Recorded so it is not rediscovered as a mystery; the debug panel is
already on the Phase-1 render-module list, which is where any fix belongs.

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

## Kickoff prompt

Paste into a fresh session on this branch to continue the effort:

> Read PLAN.md and CLAUDE.md first. PLAN.md is the tracker for this effort and its
> ground rules bind you — in particular the Phase-1 preamble ("How a leaf module
> calls back into the app" and "Test conventions for these slices"), which were
> decided in earlier sessions and are not to be re-argued.
>
> Continue the "presentable" effort: take the first unchecked item of the earliest
> unfinished phase and complete it as its own commit — extract → test → commit, per
> the ground rules (mechanical moves only, no architecture changes; relocate code,
> do not rewrite, rename or improve a signature). Tick that item's checkbox in
> PLAN.md in the same commit.
>
> Gates, all green before each commit: `pnpm exec tsc --noEmit`, `pnpm test`, and —
> only if you touched Rust — `cargo test` in `src-tauri/`. Use **pnpm**, not npm.
> Note `tsconfig`'s `include` is `["src"]`, so tsc does *not* check `test/` — a
> broken test file only shows up under vitest. Run both, every time.
> `noUnusedLocals` is on, so an import left behind by an extraction is a hard
> error; let it guide you.
>
> Prove each new test bites by mutating the subject and watching it fail, and say
> so in the commit message (see the test conventions). If you find a real bug,
> finish the move first and flag it — a behaviour change is its own commit, landed
> after. Verify each move was mechanical by diffing the relocated block against
> `git show HEAD:src/main.ts`; the only differences should be the seams you
> intended.
>
> Then continue with the next item. Stop when the phase is complete, or sooner if a
> decision recorded in PLAN.md turns out not to cover your case — in which case
> raise it rather than inventing an answer, and record what is decided.
