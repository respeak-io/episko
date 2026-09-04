# Sessions: engines, permission modes, other agents, external, restore & History

> Rules and their reasons, compressed. The full narratives live in git history (CLAUDE.md before the split). Trust the code over the docs when they disagree, and fix the doc in the same commit.

## Claude launch engines

`termEngine` picks where a Claude terminal lives; its hook instrumentation is identical for **embedded** (xterm pane), **ghostty**, **terminal / iterm**. Provider adapters declare `external-terminal` when they can preserve their control plane outside Episko. Codex does not yet, so its launch stays embedded and the UI says so rather than displaying an engine it will ignore.

## Provider launch permissions

`permissionModes` (`cc-perm-modes`) is a provider-keyed preference. Settings reads the
selected provider's `permissionModes` from `src/providers/index.ts`; changing Agent
replaces the choices and restores that provider's last selection. A terminal-only agent
advertises no `launch-permissions` capability and gets an intentional “configure this in
the agent” note. The former `cc-perm-mode` value migrates into Claude's entry.

The mode is only a *starting* policy, so it is not copied onto `Sess`: Claude's ⇧⇥ and a
provider's own TUI/config can change the live policy after launch. The new-session dialog
chips a non-default policy because that is the last moment the stored launch fact is
guaranteed true.

Both backend mappings are whitelists, never passthroughs:

- Claude's `permission_mode_arg` in `pty.rs` maps its six adapter choices to
  `claude --permission-mode`; standard emits no flag. Every embedded/external Claude
  spawner uses it, including the generated shell-script path.
- Codex's mapping lives at the provider boundary in `agent.rs`: `On request` emits
  `--ask-for-approval on-request`; `Read only` combines `never` with the `read-only`
  sandbox; `Auto` combines `never` with `workspace-write`; `Full access` emits
  `--dangerously-bypass-approvals-and-sandbox`; `Codex config` emits nothing. The
  sandboxed `Auto` combination is the current stable expression of the old
  `--full-auto` behavior. Unknown ids emit nothing.

Whether an in-app approval card can appear is part of each provider-owned mode
definition (`asks`), distinct from the `permissions` capability that says the adapter
can route a native approval when one occurs. The quick-start guide consumes that
neutral fact rather than naming a vendor.

Claude validates its mode spellings and exits on an unknown one;
`claude_cli_still_accepts_every_permission_mode_we_offer` (`#[ignore]`d, no tokens, no
auth) checks the real binary per `RELEASE.md`. Rust unit tests pin every Codex mapping,
including hostile/unknown input and flag ordering before `resume`.

## Coding-agent providers (`kind:"agent"`)

Every coding conversation is now `Sess.kind === "agent"`. `provider` is a stable catalogue id and `capabilities` says what its adapter can actually supply: session state, activity, context, usage, runtime permissions, launch-permission choices, resume, history and external-terminal support. Shells and tasks remain their own kinds. `isClaude` is reserved for Claude-specific launch/protocol decisions; shared surfaces gate on `hasAgentCapability` / `hasSessionState`.

`spawn_agent` runs non-Claude CLIs in an embedded pane: same PTY, xterm and project tree, with an optional provider control plane beside it. `AGENTS` in `pty.rs` is the discovery table (21 entries); `list_agents` returns all rows with `path` and `capabilities`, and `launchAgent` builds the self-describing session.

**Which agent runs is a preference, not a per-launch question.** It is one of three facts about a launch beside `termEngine` (where the terminal opens) and that provider's entry in `permissionModes` (how it starts), and it is stored and read exactly like them:

- **Global**: `defaultAgent` / `cc-agent`, Settings › Sessions, listed *first* of the three because it is the outermost — what runs, then where, then how. Claude Code is the default **value**, no longer a hardcoded choice.
- **Per project**: `agentByProject` / `cc-agent-by-project`, a `Record<colorKey, id>` set from the project's own context menu (`Agent · X`). Keyed by repo root, so every worktree of a repo inherits one answer — which is why the worktree menu names the agent but has no picker of its own; a per-checkout picker would be setting something other than what it appeared to. Personal, in `localStorage`, deliberately **not** `.episko/` — a colleague opening the same repo keeps whichever agent they drive.
- **`pickAgent`** (./types, tested) resolves the two with a plain cascade: override → default → Claude, skipping any id that is not **installed** — `agentInstalled`, not merely "present in the list", since the list now includes agents this machine hasn't got. That skip is the whole reason it is a function: both prefs are ids in `localStorage` and the probe re-runs every startup, so without it uninstalling an agent breaks ⌘N in every project pinned to it. A dead *override* drops to the default rather than straight to Claude — the plain cascade every settings system has.
- **`launch()` resolves the provider before it builds anything.** A resume carries `resumeProvider`, so changing the default cannot reopen a Codex thread in Claude (or vice versa). Dashboard issue dispatch follows the same project preference; its claim is released from provider-neutral `pty-exit`, so no provider-specific lifecycle hook is required.
- **Every launch surface says which agent it is about to start**: the project menu's `＋ New session` sub, the worktree menu's `＋ New session here`, and a chip in the new-session dialog — shown only when it is *not* Claude, on the same "the chip means something is different here" rule the permission-mode chip follows. The dialog shows any integrated provider's non-default launch policy. Settings swaps the policy list with the selected agent; unsupported agents get an explicit terminal/config fallback.

- **The list is what Herdr detects, because that list is the industry's** — Amp, Antigravity, Cline, Codex, Cursor, Devin, Droid, Gemini, GitHub Copilot, Grok, Hermes, Kilo, Kimi, Kiro, Maki, MastraCode, OMP, OpenCode, Pi, Qoder, Qwen. **Three binaries are not their product's name and cannot be guessed**: Antigravity ships `agy`, Kiro ships `kiro-cli`, Cursor ships `cursor-agent`. A wrong name here fails *silently* — the agent simply never appears on a machine that has it, which is indistinguishable from not having installed it — so each one comes from the vendor's own installer rather than from the label.
- **Claude Code is deliberately not in the table.** `spawn_claude` launches it instrumented; a second entry would offer the same binary stripped of the phase, cost, context and permission cockpit that are the reason to run it in Episko, with nothing on the row to say which one you picked.
- **Integration is capability-based.** Claude's adapter is its existing hooks/statusLine pipeline. Codex starts one loopback [`codex app-server --listen`](https://developers.openai.com/codex/app-server/) per pane; Episko observes JSON-RPC while the real TUI connects with `codex --remote`. `src/providers/codex.ts` is the only frontend module that knows Codex item/method shapes and normalizes them into `src/agents.ts`'s shared events. It supplies phase, activity, context/token usage, approvals, rate limits, history and resume. Codex spending is explicitly an API-equivalent estimate: App Server's cumulative USD estimate wins when present, otherwise its per-model usage groups are priced at standard public API rates. Its WebSocket transport is experimental; the isolated backend transport is the compatibility boundary if Codex changes it. The complete extension contract lives in `docs/providers.md`.
  - Each pane owns a dedicated App Server, so the observer claims its top-level thread without comparing the App Server's resolved `cwd` to the launcher's spelling; this also lets `/clear` replace the route. It keeps that thread's full descendant set. Descendant tool/file activity and approvals are tagged and routed into the parent's shared timeline/approval queue; their lifecycle, plan and token events are ignored so a child cannot mark its parent done or replace its plan. Activity ids include the child thread id to prevent collisions.
  - App Server quota notifications are sparse, so the backend folds concrete fields into its last complete quota read. It hashes a stable ChatGPT identity into an opaque scope; API-key/Bedrock auth exposes only its mode, not a credential identity, so those readings deliberately stay per-pane instead of risking a cross-account merge. The neutral fleet reducer shares or clears snapshots only among panes with the same non-null scope. `account/updated` invalidates old identity/read state before it requests a fresh account and complete quota snapshot; a webview reload explicitly refreshes account quota, thread metadata and the usage estimate.
  - A provider without an adapter is honestly terminal-only. `midFlight` then answers false because nothing can report it idle; otherwise one long-lived pane would make its checkout permanently unswitchable. Integrated agents use the normal phase/attention rules.
  - The **dirty dot does** count an agent pane's folder (`refreshDirtyStates`), because "this checkout has uncommitted work" is answered by git, not by telemetry. A shell's still doesn't: a shell is as often opened to look as to change.
- **Detection is `resolve_cli`, and it lives in `pty.rs` rather than beside `resolve_claude`.** Its Windows half *is* `win_resolve` (which exists for `argv_command`), and `platform.rs`'s first half must stay free of crate dependencies. Two deliberate differences from `resolve_claude`: it returns `None` rather than falling back to the bare name (a fallback would put all 21 agents in every picker, 20 of them a route to "command not found"), and it never spawns a login shell (`resolve_claude` can afford one probe; this runs the whole table, and 21 login shells is a visible stall on a Mac — `augmented_path()` already harvested that PATH once per run).
- **The terminal-only launch goes through `argv_command`**, the same helper `spawn_task` uses. Integrated provider launchers own their command shape; Codex's helper likewise crosses through `cmd.exe` for npm `.cmd` shims on Windows.
- **Keystrokes take `clipboardKeys`, not `shellKeys`.** These are full-screen TUIs that own their keyboard; a shell pane's ⌥/⌘ word-navigation rewrites would land inside whatever the agent has bound there. Ctrl+Shift+C/V is the one pair worth taking, because Ctrl+C has to stay the interrupt.
- **The pid stays out of Claude's `owned_pids`** because that set only filters Claude's external registry. Integrated runtimes live in `agent_runtimes`, stop with their PTY, join the provider-aware restore roster, and are adopted after a webview reload. Terminal-only providers advertise neither resume nor history and therefore do not join the roster.
- **The selectors paint real provider marks, never inferred initials.** Vendor ids and vetted SVG imports live together at `src/providers/logos.ts`; the shared project menu and Settings ask that boundary for a trusted fragment. Most marks come from the version-pinned Lobe Icons SVG catalogue, while Droid/Factory, Maki, OMP and Pi use first-party compact assets because substituting similarly named AI products would be worse than a neutral fallback. `AgentSpec.mark` remains only as a backwards-compatible backend wire field. A contract test requires every catalogue id to have an explicit asset mapping. Expanding *more supported* keeps the menu header in place and scrolls the bounded agent list instead of growing beyond the viewport.
- **What isn't installed is shown, greyed, rather than dropped — and this replaced the opposite rule.** `list_agents` used to filter, copying `available_terminals`' contract, and that was wrong: an external terminal Episko doesn't offer is one you can plainly see is not on your Mac, whereas an agent that silently fails to appear is indistinguishable from Episko not supporting it, and the only place to take that question is the issue tracker. The picker now lists the installed ones above a fold and the rest below it (`agentShowAll`, sticky for the app's life), each greyed row saying `not on PATH · <bin>` — **the binary name is the answer**, more precise than any install link and immune to the rot twenty-one vendor URLs would bring. `cls: "dis"` is what makes them inert: every click listener on `#ctxMenu` that can see them bails on a `.dis` row before reading its act, so there is no dead branch to write. Settings offers installed agents only (a segmented control cannot carry twenty-two), and says in its hint how many others exist and where to read about them. This is the rule `tasks.rs` already follows for a Runnable that cannot run and `projmenu.ts` for a worktree that cannot be removed: **what can't be used says why.**
- **The `Agent · X` row is on the project menu unconditionally**, including on a machine with nothing but Claude installed — which is the case where it earns most, since the picker behind it is where "Episko supports twenty-one of these" is written down. Dropping it there would hide the feature from exactly the person who hasn't found it.
- **`»` is two tables.** `sidebarview.ts` draws the glyph and `tray.ts`'s `SHAPE` names the shape `icons.rs`'s `shape_sdf` rasterises (`dchevron`); change them together or the tray disagrees with the rail beside it. It is deliberately not a diamond variant — `◆` is the one glyph in that menu meaning *drop what you are doing*.

**What this is not.** Episko does not classify state by matching the terminal's bottom buffer. It reads provider-owned structured interfaces (Claude hooks, Codex App Server). A later OpenCode adapter should implement the same normalized event seam, not add screen regexes that silently break when a TUI is restyled.

## External (non-Episko) sessions

Discovered from `~/.claude/sessions/<pid>.json` (one per running interactive session; same path/format on Windows; VS Code-hosted included; format details in the `claude-code-local-session-registry` memory). The listing is OS-agnostic: `list_external_sessions` liveness-checks against `ProcTable`, one in-process `sysinfo` snapshot (no `ps` spawns; 3s poll).

- **Filter owned sessions by pid, never by session id**: Episko's own sessions register there too, and `/resume`//`/clear` rewrite `<pid>.json` with a *new* id, so an id exclude lets a live owned session reappear as "external". `owned_pids` plus the ancestry walk (`ProcTable::is_descendant_of`) also catch child-terminal launches.
- **The walk is deliberately broad and bites in dev**: `pnpm tauri dev` started from an Episko pane becomes its descendant, so a second instance's sessions vanish from the first's external list. **Run dev builds from a real terminal**, and prefer quitting the installed app; dev and installed share one `episko-debug.json` (keyed by `$TMPDIR`) but **not** localStorage (WebKit keys the store by binary identity; measured, and `scripts/reconcile-usage.mjs` depends on it, targeting `io.respeak.episko` explicitly).
- `read_transcript` mirrors read-only. **`focus_external_session` is written twice**, because "which window is that pid's terminal" has no portable answer. macOS: exact tab by tty via AppleScript for Terminal/iTerm2, else `open` the owning `.app` (required for Electron hosts, whose integrated terminal runs under a helper System Events can't target; we can front VS Code, not the panel). Windows: walk to the first ancestor owning a visible top-level window, then `SetForegroundWindow`. It must not stop at the windowless `Code.exe` pty host, must find classic `conhost` via a per-level *child* scan (it owns the window but is a child), and must give up rather than answer `explorer.exe` (a wrong window looks like success). Known gap: Windows Terminal as default console host is nowhere in the ancestry. A host owns one window per project, so the window is chosen by matching the project folder against the caption (hint read from the session's own registry file), falling back topmost.
- **Known gap**: sessions launched into an external Terminal/iTerm via `open -a` aren't in our process tree, so they rely on the id exclude and can leak after a `/resume`.

## Restorable sessions

Restore remembers what resumable provider conversations were on screen rather than copying conversation state. The roster stores `provider` + `resumeId`; Claude hands that id to `--resume`, while Codex hands its thread id to `codex --remote … resume`.

- **The roster** (`cc-restore`) holds open sessions whose provider advertises `resume`; `closeSession` removes an entry (explicit close means done); shells, tasks and terminal-only agents never join. Saves are debounced *with a ceiling* (`ROSTER_MAX_STALE`), because continuous events would reset a pure trailing debounce forever.
- **Resume `resumeId`, not `id`**: each runtime-id rotation starts a **new transcript file**, so the launch uuid goes stale as a resume target. `run_telemetry_server` preserves the incoming id as `claude_session_id` before forcing ours on; the frontend tracks `Sess.resumeId` and saves on rotation. Routing is unchanged.
- **`--resume` and `--session-id` are mutually exclusive** (resume wins); `--settings` stays keyed to the launch uuid, so `X-CC-Session` routes whatever id Claude runs under.
- **Verified against the real CLIs**: resume runs in the **original cwd** and a live id is never resumed twice (`dormantBusy`). A webview reload orphans every PTY; `live_sessions` → `backendLive` makes it busy, and startup re-adopts every provider-backed agent pane. Adoption waits for agent discovery, with the checked-in provider manifest as the capability fallback, so a fast `live_sessions` result cannot rebuild an integrated pane as terminal-only. Scrollback uses `ScrollBuf`'s sequence-number snapshot protocol, so a chunk emitted around adoption is neither duplicated nor lost. Claude hooks and the Codex observer keep routing to the stable Episko pane id.
- **`list_past_sessions` labels**: `ai-title` (last occurrence wins) → `last-prompt` → first user message. That layout is internal to Claude Code and unstable, so the chain is load-bearing. Bounded tail (64KB, widened to 512KB when neither record was in range). No transcript → dropped (launched-but-never-prompted writes none).
- **The transcript folder keys on the *physical* workdir** (`project_transcript_dir` canonicalizes via `physical_cwd`: `getcwd()` reports resolved paths, so encoding the user's spelling returns empty and reads as "no past sessions"). Windows canonical form is verbatim `\\?\` and **must** be stripped (`strip_verbatim`, separated so it's testable off-Windows). Both live in `platform.rs` (`repo_root_of` needs the same resolution).
- **Claude's cost counter survives the relaunch, so the day's baseline must too**: `total_cost_usd` comes back from `--resume` still carrying the previous process's spend (observed across a 25s kill; reset across 10h; undocumented where the line falls), and a new `Sess` with `cost: null` double-books the carried figure; that shipped (~$28 booked twice in one day). `costDelta` (usage.ts) keys the baseline by **Claude's runtime session id** (resume preserves it) and treats a *drop* as the counter restarting. The baseline is **persisted** (`cc-cost-base`), because memory-only missed the commonest route, quit→reopen→restore, and the drop branch is what makes a stale entry harmless, so retention is capped by count rather than age. **Anything that diffs a cumulative telemetry figure against a `Sess` field repeats the bug.**
- **The roster is a convenience layer rather than a system of record**: Claude transcripts and Codex thread history remain the durable sources.
- **The stage has one owner**: `activeId` and `mirror` (`{kind:"ext"|"past"|"dash"}`) are mutually exclusive; timer-driven inspector repaints must bail on `mirror`, and not merely on the external case; `stageGroup` is a modifier rather than another owner. **`takeStage(show)` in `dom.ts` is the only code that may touch `#extPane`/`#dashPane`/`#empty`/`insp-mini`**. Openers hiding rivals by hand shipped two-of-four complete: both panes are `position:absolute; inset:0` with **no z-index**, so DOM order decides and a missed hide puts the mirror *behind* an opaque pane, reading as "the click only changed the colours". `insp-mini` is dashboard-only. Add a stage kind by extending `Stage`, never by poking `hidden` at a call site.

## Shelving (⇩) and sign off

The middle answer between leaving a session open and closing it. A shelved session's
process, PTY and WebGL context are given back; its **row stays in the sidebar** under
its project, one click from carrying on. `canShelve` (./types) is the single gate:
`isAgent` + not `external` + a workdir + the `resume` capability.

- **A shelved session is not a new kind of object.** `shelveSession` (./panes) builds
  the same `Restorable` a quit already writes (`rosterEntry`, ./mirror) and puts it in
  `dormants`, so it inherits the read-only mirror, the ⟲ button, `dormantBusy`, the
  `cc-restore` persistence and the provider reconcile at boot for nothing. The copy is
  the union of the two ways in ("shelved", never "from your last run"), because with
  one row shape a reader cannot be told which it is — and does not need to be.
- **The dormant row goes on before the pane comes down.** `closeSession` ends in
  `flushRoster`, which keeps only the dormants that are not also live; an entry added
  first survives the very flush its own close triggers, one added after loses the race.
- **`backendLive` is pruned by hand at the same moment.** `kill_session` drops the PTY
  synchronously, but `backendLive` is a 3s poll — so for three seconds `dormantBusy`
  would paint the fresh row "busy" and refuse the resume the shelve just made possible.
- **External sessions cannot be shelved, and that is the point.** `kill_session` cannot
  reach a process in the user's own Terminal, so the row would go while the agent ran on.
- **The verb and the mechanism are separate on purpose.** `shelveSession` (./panes) is
  the pane operation; `shelveSessionAsked` (./actions) is the verb the ⇩ button and the
  palette row trigger, and the confirmation is the whole difference between them. The
  sign-off sheet calls the mechanism directly, having already asked about the fleet.
- **`midWork` is what a shelve interrupts**, and it is wider than `midFlight` by exactly
  one case: a turn that ended while its fan-out runs on is `done` with no attention.
  Both shelve paths read it, so the single-session warning and the sign-off sheet cannot
  disagree about which sessions are still working.

**Sign off** (./signoff, top bar beside caffeinate) is the bulk half. It opens a *sheet*
rather than an `ask()`, because the answer is not yes/no: two of the three groups it
lists are exceptions the user has to be able to change first. Sessions still working are
**kept** by default (the cost of stopping a turn is work you redo; the cost of leaving a
session up is what the feature exists to reduce), and shells/tasks — which can only be
closed, never shelved — are offered for closing with the switch **on**, listed by name.
Neither switch is remembered: both are answers about tonight's fleet, and a remembered
"close my shells" would kill a dev server three weeks later. The headline counts what the
switches have left selected, so it and the button can never disagree.

Two seams are load-bearing. ./signoff reaches `shelveSession`/`closeSession` through its
**host** rather than importing ./panes, because ./footer must close its popover and
./panes imports ./footer — a direct import closes the ring. And `#extPane`'s bar is
written per opener (`renderExtHeader` / `renderPastHeader`), since one pane now serves a
session running in another terminal *and* one running nowhere at all.

## History (`◷`, ⌘⇧H)

Answers "reopen the one I closed", which the roster cannot. It joins Claude's transcript scan (including IDE/terminal sessions) with Codex `thread/list`; selecting a Codex row uses `thread/read`, and resume carries the provider id. `history.ts` owns provider-neutral rules, `historyui.ts` the dialog, and each provider adapter maps its public history shape.

- **The cwd comes from inside the file, never the folder name**: the `<enc>` scheme is lossy, with no inverse. `transcript_origin` reads `cwd` (and `gitBranch`) off the first user record, from a bounded *head*. No `cwd` → dropped (`--resume` must run in the original dir, so the row could only fail).
- **Then `norm_path`**: Claude records the path as typed (`e:\proj` vs `E:\proj`) while everything compared against is normalised; skipping this made 135 of 219 rows read as worktrees, and 32 after.
- **Each row carries its `repo_root`** (`repo_root_of`, memoised per unique cwd, skipped for gone folders; the same enrichment `list_external_sessions` gets from `git_repo_info`). Load-bearing for `histProject()` and the ◧ scope filter: a worktree lives *beside* its repo, so no prefix test finds it.
- **Bounded before it reads**: an `(mtime, len)` pass ranks every transcript and only the newest `limit` get the tail scan, so `limit` caps I/O rather than rows. Runs on a blocking thread.
- **"Last active" is read out of the records, never off the file** (`TranscriptMeta::last_active`, a `line_timestamp` substring scan above the metadata gate). Claude appends untimestamped bookkeeping (`mode`, `permission-mode`, `ai-title`, `last-prompt`) when a session starts and again when it goes away, so **every transcript open at a shutdown is stamped with the shutdown, to the second** — four sessions last worked at 08:08, 10:30, 12:50 and 15:50 all read "6h ago" after one 03:41 reboot, and the same collapse files a day's work into the wrong day in the Trail. The file mtime survives only as the fallback for a transcript with no timestamped record at all. Rows are re-sorted on the honest figure after pass 2, since pass 1's mtime rank is only an approximation of it (mtime is never *earlier* than the newest record beneath it, so ranking the cheap pass by it is still sound — it can cost a slot, not correctness).
- **The scan was profiled, and both hot spots were the unguessable ones** (subprocess spawns and tail reads; the directory walk was negligible). Both were removed rather than paged: `repo_root_of` reads the `.git` layout directly, with no subprocess; it walks from the **physical** cwd (git resolves symlinks before answering, and a linked worktree's root comes from the canonically-written `gitdir:` file, so an unresolved walk disagrees with *itself* and splits a repo from its own worktrees); a **stale worktree**'s dangling `.git` pointer means "not a repository" rather than starting a parent search; following it would file a dead checkout under a repo that forgot it. Tested by substitution against git's own answers. `transcript_meta` reads a 64KB tail, widening to 512KB only when **both** `ai-title` and `last-prompt` were missing. Each is last-wins, so one in range means the newest is; accepting on *either* mislabelled rows. Verified against the full corpus: zero differ from an always-full read.
- **Same resume constraints as a dormant row, surfaced not hidden**: a live id is listed but tagged `live` (a second `--resume` interleaves); a vanished folder is tagged `no folder`, not dropped.
- **The shelved card and History's detail pane both lead with what you asked**, and both draw it with ./inspectorview's `askedHtml` — one builder, like `wpeekHtml`, rather than a copy per dialog. In ./mirror's card it sits between the facts and *Resume*, because that is what the decision is made on, and a row **jumps the read-only mirror beside it** (`data-pastq` carries the index into the array the mirror rendered, envelopes included, or the jump lands on the wrong message). In History the list sits *below* the Resume button instead: that dialog's primary action must stay above the fold.
- **The detail pane leads with what you asked**, above *how it ended*: a conversation is identified by its questions, and the last few messages of a tail are usually the agent's. Both come from one `readProviderHistory` read; the envelope turns Claude writes as you (`<command-name>`, the `Caveat:` preamble, an interrupted request) are dropped by ./outline's `isEnvelope`, the same filter that keeps them out of a resumed pane's outline.
- **Two doors, one dialog**: the stage-header `◷` opens *scoped* (everything beside it acts on the project on screen; `syncStageButtons` greys it with them); the top-bar `◷` is whole-machine. Reuses `#wtDlg`'s `.wt-*` skin and the mirror's `.tvmsg` preview.

## The outline of a resumed session

A resumed pane starts blind: its questions are in the provider's transcript, not in the hooks it is about to receive. So `seedOutline` (./panes, both spawners) does one `readProviderHistory` read at launch and `seedPrompts` (./outline) puts the user turns in front of anything the pane has already recorded — everything the transcript holds predates it. It runs **once**: a second read would list the lot twice, and no dedupe can tell that from a question genuinely asked twice.

- **A Claude pane on the fullscreen renderer has no scrollback at all, and that is the whole story.** Claude Code ships two renderers behind the `tui` setting: `"fullscreen"` takes the **alternate screen** — `\x1b[?1049h\x1b[2J\x1b[H` in its first hundred bytes, then `?1000h/?1002h/?1003h/?1006h` to grab the mouse, and no `?1049l` until it exits (probed against the real CLI, not read off a doc) — and keeps a virtualised scrollback of its own; `"default"` is the classic main-screen renderer, which prints into the terminal's history like anything else, and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` forces it for one launch. xterm's alternate buffer holds exactly one screen: `baseY` is always 0, `viewportY` never moves, `scrollToLine` is a no-op and `registerMarker` returns a row the next frame paints over. That is why the first cut of this feature jumped to the prompt bar, and why the second — which matched the text — lit up whatever line happened to be showing: the questions were never in the buffer to begin with. The debug line said so at every click (`view 0 → 0`), which is the argument for logging the viewport either side of a jump.
- **One path per buffer kind, and neither renderer is required.** `scrollToPrompt` branches on `buffer.active.type`. A normal buffer — the classic renderer, a shell, a task, any agent that prints — is the scrollback path below: find the line, `scrollToLine`, mark it. The alternate screen is the hunt: the conversation is the TUI's, so the jump is asked of it **with its own keys** — `PageUp`/`PageDown` to page, `Ctrl+Home`/`Ctrl+End` for the two ends, straight from its key table (context `Scroll`) and each probed against the real CLI — with the text search re-run on every redrawn screen. Keys rather than the wheel, which was the first driver: in this TUI a notch is `scroll:lineUp`, **one line**, so a wheel hunt had to measure what a notch was worth and still crawled, while a page is deterministic and never longer than a screen, so a hit cannot be stepped over. Four rules make the hunt safe and finite. **The nearer end first**, unless the question is on screen already: the outline knows which half of the conversation a question is in, so an early one is paged *down* to from the top and a late one *up* to from the end, and a question already showing moves nothing, since jumping to an end would undo the reading you are in. **A page that changes nothing is the far end** (`screenShift` reads 0), which ends a hunt in a young session after one page — but *a write is not a redraw*: the footer repaints on its own clock, so "no change" is believed only after the full `FRAME_MS`, or the hunt ends on step one (that shipped, for an afternoon). **A time budget as well as a page count**, so a long conversation gets as far as it can rather than hanging on a click. And a hunt that found nothing **returns to the live end**, because failing to find your question must not also lose your place. One hunt at a time (two would page each other), and a slow one says so after ~0.7s rather than looking dead.
- **A paging key is not typing.** This is the only place Episko writes to a live session outside the two documented Enter presses, and it stays outside that rule on purpose: `PageUp` and `Ctrl+End` can put nothing in the composer and confirm nothing, and they are exactly what the user's own keyboard would have sent. Nothing is ever typed to find a question. (Codex's TUI is on the alternate screen too and takes the same path; whether it pages on the same keys is untested, and a TUI that ignores them simply reports *not found*.)
- **The submit marker is a hint, and the text is the address.** `UserPromptSubmit` fires the moment you press Enter, *before* the REPL has committed the message: Claude Code's frame is redrawn from its top, so the message lands several rows **above** the cursor row the hook can mark, and the marked row is still inside the input box until enough output has pushed it out. Jumping to it therefore scrolled to the prompt bar — for the newest question, to nothing at all, since the viewport was already there. So every row is now resolved by **matching what you typed** against the scrollback, on the click that needs it: ./outline turns the question's first line into a key (`promptKeys`; `normLine` strips the REPL's own `>` off both sides, so a quoted or bulleted question still matches, a key under 12 characters must *lead* its row rather than merely appear in it, and the 60-character key is retried at 24 because Ink wraps the message at the pane's width, not ours — the first rendered row may hold less of it than the key), and ./terminal joins each wrap-run, walks up to the hint's line and takes the **nearest hit at or above** it — the message is above the cursor row, while a reply quoting you back is below, and two identical questions resolve to their own occurrences because each has its own hint. The hit is anchored with a marker of its own and `found` stops the scan repeating; a miss stamps `lost` and falls back to the hint, which is still roughly right. A pane's whole buffer is one scan, run at most once per question.
- **A restored row is not greyed, and it is not pretending.** It has no marker at all because Episko never watched it arrive — but `--resume` replays the conversation into the pane, so the same search finds it, top-down (its replay is above everything the pane has done since). Only a miss greys the row, and its tooltip then says *before this pane* rather than *scrolled out*. The `↩` mark is on it either way, because "this came from the transcript" stays true after a hit.
- **A jump the viewport cannot make is still a jump.** `scrollToLine` clamps at `ybase`, so a question whose turn produced less than a screenful of output — always the newest one, and every one of them in a young session — is already on screen and the scroll moves nothing at all. That reads as a dead click and is how the feature first shipped broken (measured: markers at 5/23/41 against a `ybase` of 26, so only the first two moved). So `flashLine` selects the line either way — the whole wrap-run of it, since a question that took three rows is three rows of answer — and **the mark, not the scroll, is the answer** to *where did I ask this*. It is a selection rather than a decoration because `registerDecoration` is xterm's proposed API and throws without `allowProposedApi` — which would have taken the scroll down with it; the marking is wrapped in a `try` for the same reason. `dlog` records the line and the viewport either side of every jump, which is what answers the question next time.
- **A time only when the transcript said one.** `TranscriptMsg.at` passes Claude's ISO timestamp straight through (`Date.parse` is the reader); `Prompt.at` is 0 when nothing said, and the row then shows no clock rather than inventing one. Codex records none today, so its restored rows are the honest blank.

## Reviving a session the API killed (`revive.ts`, `tickRevive` in `actions.ts`)

Ships **off** (`cc-revive`, Settings › Sessions). Switched on, it types a carry-on into a
session whose turn ended in `StopFailure` — the overnight case, where the cost of a
thirty-second outage is eight hours of a session sitting at its prompt. `revive.ts` is
pure and holds every rule; `tickRevive` is a 10s poll that applies what it returns and
decides nothing.

- **A poll, not a timeout scheduled to `reviveDeadline`.** The two things worth waking
  for are a rung falling due and the network coming back, and only one is an event. A Wi-Fi
  interface reassociating at 04:12 fires nothing, so a deadline-driven design would sit on
  an overdue attempt with no reason to re-examine it. The 10s is only the granularity of
  "how soon after the internet returns"; the ladder's own waits are minutes wide.
- **`attention` is checked before anything that can return `send`.** A blocking permission
  sits at a prompt indistinguishable from an idle one, so a continue typed into it
  *answers* it. This is the one failure mode here that is destructive rather than useless.
- **`apiErr`, not `phase === "error"`.** A failed tool call reddens the same glyph; only
  `StopFailure` writes `apiErr`, and only that means the API killed the turn.
- **The terminal list is a denylist and the unknown bucket defaults ON.** Retrying a kind
  we should not costs a few no-op turns bounded by `attempts`; *not* retrying a kind
  Anthropic added after this build costs the night, silently, on the failure nobody
  anticipated. `TERMINAL_KINDS` (auth, billing, org, invalid request, model, and
  `max_output_tokens`) is the part no preference can switch back on.
- **`ReviveState.attempts` survives the turns a continue starts.** It is cleared in exactly
  one place — `endTurn`'s success branch in `phase.ts` — and deliberately *not* in
  `newTurn`, which is where it looks like it belongs. Clear it there and a down API (each
  new turn failing in milliseconds) restarts the streak at rung one every time, flattening
  the ladder into a fixed `baseMs` hammer.
- **A fresh `apiErr.at` re-times the ladder from when the failure happened**, not from
  when the poll noticed, and `send` moves `dueAt` to the next rung as part of sending — so
  a write that goes nowhere and provokes no new `StopFailure` cannot be re-sent every tick
  until the budget is gone.
- **No fan-out guard, which is a reversal rather than an omission.** Agents killed
  alongside their parent never send `SubagentStop`, so `subagents` stays high with nothing
  behind it; standing down for it would sleep through `FANOUT_DEAD_MS` (an hour) in exactly
  the scenario this exists for. (`bgWaiting` could not express it anyway — it requires
  `done`/`idle`, so on a session already narrowed to `error` it is false by construction.)
- **Being offline does not consume an attempt.** `dueAt` stays in the past, so the next
  tick after the interface returns sends immediately. For the failure this was written for,
  every attempt would otherwise be spent while there was no network to spend it on.
- **`jitterPct` is not a nicety.** Six sessions killed by one 529 back off identically and
  return in the same second, at which point they are the overload.
- **One noise, at the give-up.** `soundSnap.reviving` silences the `error` chime for a
  failure the watchdog already has a schedule for; the first failure still rings (no
  schedule exists yet) and `tickRevive` plays `error` by hand when it stops trying. Six
  buzzes for one outage is how somebody ends up switching all the sounds off.
- **Backstop below all of it**: `spawn_claude` sets `CLAUDE_CODE_MAX_RETRIES=12` unless the
  user's environment already sets it. Claude Code's own classifier already covers 429/5xx
  and the connection errors, so a wider leash means fewer turns ever reach this module.
