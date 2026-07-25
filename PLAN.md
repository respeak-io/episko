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
- [ ] `grouping.ts` — `clusterByWorktree`, `splitByWorktree`, `urgencyRank`,
      `projectList` ordering, `nextAfterClose`
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

> Read PLAN.md and CLAUDE.md. Continue the "presentable" effort: take the first
> unchecked item of the earliest unfinished phase and complete it as its own
> commit — extract → test → commit, per the plan's ground rules (mechanical moves
> only, no architecture changes). Afterwards `pnpm exec tsc --noEmit`, `pnpm
> test`, and — for Rust changes — `cargo test` in src-tauri must be green. Tick
> the item's checkbox in PLAN.md in the same commit. Then continue with the next
> item; stop when the phase is complete and summarize what moved, what is now
> tested, and what the next slice would be.
