// The shared data model: the shapes that cross module boundaries. Types, plus
// the one-line discriminants that read them — no other logic, and no imports
// beyond the xterm handles a live pane holds — so every other module can depend
// on this one without dragging DOM or Tauri along.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";

import { fmtShort } from "./format";
import providerManifest from "./providers/manifest.json";

// ---------- model ----------
export type Phase = "idle" | "thinking" | "working" | "done" | "error" | "ended";
export type Risk = "low" | "med" | "high";
// Why the last turn died, from the StopFailure hook. `kind` is Claude Code's own
// `error` enum, `detail` the message it printed in the pane. Held beside the phase
// rather than folded into it because "the turn broke" and "whose fault it was" are
// different questions: overloaded means wait, rate_limit means wait longer,
// authentication_failed means go fix your credentials.
export interface ApiErr { kind: string; detail: string; at: number }
// One tool call on the activity timeline. `durMs` is filled in on PostToolUse
// (latency = the Pre→Post gap); null means still running.
//
// `inp` and `out` are the whole call — what was executed and what came back — already
// capped by ./toolio at capture, which is where the cap has to be: a `Read` response is
// an entire file. `out` stays empty until the Post hook lands, so "" means still running
// or (for a call the user never answered a permission on) never finished. `failed` is
// the PostToolUseFailure discriminant, where the reason lives in `error` and there is no
// `tool_response` at all.
//
// `id` is Claude Code's own `tool_use_id`, identical on the Pre and Post payloads of one
// call. It is what pairs them: matching on the tool *name* picks the most recent open
// call of that name, which is approximate under parallel subagents and was harmless
// while all it could misplace was a latency bar. Hanging a command's output off the
// wrong row is not harmless, so the name match survives only as the fallback for a
// payload with no id.
export interface Act {
  tool: string; arg: string; time: string; startMs: number; durMs: number | null;
  id: string; inp: string; out: string; failed: boolean;
  /// Claude's own note on why it made this call, lifted out of `inp` rather than left
  /// inside it — a `description:` line in the middle of a command is the difference
  /// between a block you can paste into a shell and one you have to edit first. See
  /// ./toolio's `descText` for which tools it is taken from and why not all of them.
  desc: string;
}
/// How a row is addressed by the click dispatcher and the expanded-row set. `startMs`
/// backs the id up rather than an array index, which every new call would shift.
export const actKey = (a: Act): string => a.id || `t${a.startMs}`;
// What a session did to one file, accumulated over the whole conversation — the model
// behind the inspector's Context card. One entry per path, never one per tool call:
// the question it answers is "what has this agent been into?", and an agent that reads
// the same file nine times has told you one thing nine times.
//
// `kind` only ever climbs (read → edited → created; see RANK in ./files), because it is
// a claim about the file rather than a log of the last thing that happened to it: a
// file the agent wrote and then re-read is still a file it wrote. `n` is every touch,
// `at` the most recent one — together they order the list and size the "×3" badge.
export type TouchKind = "created" | "edited" | "read";
export interface FileTouch { path: string; kind: TouchKind; n: number; at: number }
// A single item from a TodoWrite payload (the plan Claude keeps for itself).
export interface Todo { content: string; status: string }
// Uncommitted "working set" summary from the git_diffstat backend command, plus
// where the branch sits against its upstream (ahead/behind are as of the last
// fetch, not live — see upstream_state in lib.rs).
export interface DiffStat {
  added: number; removed: number; files: number; untracked: number; dirty: number;
  upstream: string | null; ahead: number; behind: number;
}
// One uncommitted file, as `git_working_set` names it. `code` is the single letter
// the pane shows (M/A/D/R/C/U, or `?` for untracked), `from` the path a rename came
// from, and the line counts are that file's own — for an untracked file, the lines the
// stat's own count read off disk, so the row and the total agree. 0/0 for a binary
// file, and for an untracked one too large to read.
export interface StatusFile {
  path: string; code: string; from: string | null; added: number; removed: number;
}
// A DiffStat with the files behind it. `entries` is capped backend-side while `dirty`
// is not, so `dirty - entries.length` is what a list says it left out.
export interface WorkingSet extends DiffStat { entries: StatusFile[] }
// One checkout of a repo as `worktree_heads` reports it — path, the branch on its
// HEAD, and whether the directory is still on disk. Read from files rather than from
// `git worktree list`, so it is cheap enough to poll; see the Rust side for why.
export interface WtHead { path: string; branch: string; is_main: boolean; exists: boolean }
// A checkout of a session's own repo that isn't the one it was launched in, as
// ./gitwatch reads it off the hook stream. What the inspector's "working in" card
// offers to point the session at.
//
// `via` is not decoration — it decides the repair, because the two ways an agent
// changes checkout leave the conversation in different places:
//   "cwd"   — Claude Code moved the session itself (its `EnterWorktree` tool, or any
//             `cd` staying inside the project dir). It has already re-homed the
//             transcript, so Episko only has to catch up: adopt the directory, no
//             restart, no file move.
//   "write" — the session is still running where it was launched and only its *writes*
//             moved. Nothing has re-homed anything, so following it means moving the
//             transcript and relaunching.
export interface Drift { dir: string; branch: string; via: "cwd" | "write" }
// A fleet of background agents the session launched and is no longer driving — the
// `Workflow` tool's fan-out, or a plain burst of `Task` subagents.
//
// It exists because a background fan-out **ends the parent's turn**. The Workflow tool
// returns a run id in about two seconds and the agent stops, so `Stop` fires, the phase
// goes `done`, and every surface reads "your turn" — for the twenty-odd minutes its
// agents keep working. That is the one state the cockpit got flatly wrong: the fleet is
// busy and the app says the human is the bottleneck.
//
// Everything here rides telemetry Episko already receives, which is why there is no
// backend half. `PreToolUse{Workflow}` carries the script, whose `meta` literal names
// the run and its phases; `SubagentStart`/`SubagentStop` fire on the PARENT session for
// every agent the fan-out spawns (53 of each for a 53-agent run). The run-state file
// Claude Code writes under `~/.claude/projects/…/workflows/` is not an option: it is
// created when the run *finishes*, so it knows nothing while it matters.
//
// `phases` is the titles only, in order, and nothing marks one as current — no hook
// says which phase a workflow is in, so the card lists what the run will do rather than
// claiming to know where it has got to.
export interface Fanout {
  /// `meta.name` — empty for a bare `Task` fan-out, which has no script to name it.
  name: string;
  /// `meta.description`.
  detail: string;
  /// `meta.phases[].title`, in order.
  phases: string[];
  since: number;
  /// Cumulative, unlike `Sess.subagents` — which stays the *live* count and is the one
  /// owner of that number. started − done is not it: an agent that never stopped would
  /// make the two disagree, and the display asks both questions separately.
  started: number; done: number;
  /// The last `SubagentStart`/`Stop`. What the grace window in `liveFanout` measures.
  lastAt: number;
}
// Disk I/O for one session's `claude` process: rates over the gap since the previous
// sample, plus lifetime totals. `primed` is false on the first reading, when there is
// nothing to difference against and the rates are 0 by default rather than measured.
export interface Res { readBps: number; writeBps: number; readMb: number; writtenMb: number; primed: boolean }
// One installed `claude` binary, as `all_sessions_resources` reports it alongside the
// counters. A version that appears mid-run is a self-update, whose ~290 MiB the kernel
// charged to a session of ours — see `installGrown` in ./usage, which is what turns this
// list into the discount that keeps it out of the day.
export interface InstallFile { name: string; mb: number }
// One process keeping a folder alive, as the backend's `path_holders` reports it.
// `why` is how it was found and how it reads to a human: "cwd" is a process sitting
// in the folder (a terminal, a dev server, a PTY pane on its way out), "file" is an
// open handle (an editor, a watcher). `ours` means Episko launched it — those are
// cleared without asking, since a removal already decided they should die.
export interface PathHolder { pid: number; name: string; why: "cwd" | "file"; ours: boolean }
// A worktree that was removed but whose folder would not delete. Windows-only in
// practice: it refuses to delete a directory any process has open, where POSIX
// unlinks it and lets the last handle close in its own time.
export interface Stranded { path: string; stuck: string; reason: string; holders: PathHolder[] }
// Result of a fetch/pull/push. `suggest` is set when the action was refused (or
// git failed) and there's a command worth handing to a real terminal.
//
// `stranded` is `remove_worktree`'s alone, and it rides alongside `ok: true` rather
// than instead of it — the worktree really is gone from git and the roster really did
// change, so every caller must refresh exactly as it would on a clean run. What is
// left over is a directory, which is a separate problem with a separate repair
// (`purge_worktree_folder`), not a different outcome for this one.
export interface GitActionResult {
  ok: boolean; summary: string; output: string; suggest: string | null;
  stranded?: Stranded | null;
}
// What `purge_worktree_folder` answers: did the folder go, and if not, who is left.
export interface PurgeResult { gone: boolean; stranded: Stranded | null }
// What a pane actually contains. All three run in an identical PTY; the kind is
// the durable product concept, while an agent's provider and capabilities decide
// which integrations apply to it.
//   agent — any coding-agent CLI, from a fully integrated provider to a terminal-only
//           fallback
//   shell  — a plain login shell (❯ Terminal)
//   task   — one run of a Runnable (▶ Run), whose exit code becomes done/error
// Note `external` is orthogonal: it means "the terminal lives in Ghostty/iTerm
// rather than an embedded pane". Provider capabilities decide whether that is
// available, rather than the session kind growing another provider-specific arm.
export type SessKind = "agent" | "shell" | "task";
// Features a provider adapter can supply to the shared session model. These are
// intentionally user-facing capabilities, not transport names: Claude hooks, the
// Codex App Server and a future OpenCode server can all produce `session-state`
// without the UI knowing which protocol delivered it.
export const AGENT_CAPABILITIES = [
  "session-state", "activity", "context", "usage", "permissions", "resume",
  "history", "external-terminal",
] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

type ProviderManifestEntry = { capabilities: string[] };
const PROVIDER_MANIFEST = providerManifest as Record<string, ProviderManifestEntry>;
const AGENT_CAPABILITY_SET = new Set<string>(AGENT_CAPABILITIES);

/**
 * The checked-in provider matrix is shared with Rust's CLI catalogue. Validate it
 * here as it crosses into typed frontend state: a misspelled capability must fail at
 * startup/tests rather than quietly turning a feature off in half of the app.
 */
export function providerCapabilities(id: string): AgentCapability[] {
  const capabilities = PROVIDER_MANIFEST[id]?.capabilities ?? [];
  for (const capability of capabilities) {
    if (!AGENT_CAPABILITY_SET.has(capability)) {
      throw new Error(`unknown capability ${capability} for provider ${id}`);
    }
  }
  return [...capabilities] as AgentCapability[];
}
// One coding-agent CLI Episko knows about, as `list_agents` reports it — the whole
// catalogue, installed or not. `path` is where it is, or **null** for "this machine
// hasn't got it": those rows are shown, greyed and inert, rather than dropped, because
// a missing row reads as "Episko doesn't support Codex" and sends somebody to the
// issue tracker. `bin` is what was looked for, which is the only useful thing to say
// about an agent that wasn't found. `mark` is its two-letter monogram; see the AGENTS
// table in pty.rs for why these are letters rather than logos.
export interface AgentCli {
  id: string; label: string; mark: string; bin: string; path: string | null;
  capabilities: AgentCapability[];
}
// Provider-normalized token accounting for one live conversation. `total` is the
// cumulative thread reading; `last` is the most recent model call and therefore the
// best available context-window reading for providers such as Codex. Claude can leave
// this null because its statusLine already fills the legacy context/cost fields.
export interface AgentTokenBreakdown {
  totalTokens: number; inputTokens: number; cachedInputTokens: number;
  cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number;
}
export interface AgentTokenUsage {
  total: AgentTokenBreakdown; last: AgentTokenBreakdown; contextWindow: number | null;
}
export interface AgentRateLimit {
  usedPercent: number; resetsAt: number | null; windowMins: number | null;
}
export function agentCapabilitySummary(a: AgentCli): string {
  if (!a.capabilities.includes("session-state")) return "terminal only";
  const features = [
    a.capabilities.includes("usage") ? "usage" : "phase",
    a.capabilities.includes("context") ? "context" : "",
    a.capabilities.includes("permissions") ? "permissions" : "",
  ].filter(Boolean);
  return features.join(", ") || "integrated";
}
/// Can this one actually be launched? The single place the null-path convention is
/// read, so no caller has to remember which way round it goes.
export const agentInstalled = (a: AgentCli) => a.path !== null;
// Claude Code as an entry in the same list, so the Settings picker and the launch path
// can treat "which agent" as one question with one shape of answer.
//
// Not in the backend's AGENTS table on purpose (that table is what `spawn_agent` will
// run, and claude must go through `spawn_claude` to be instrumented), so it is spelled
// once here instead. `path` is empty because nothing probes for it: `resolve_claude`
// is the app's own binary lookup and never reports "not installed" — if claude is
// missing, Episko has bigger problems than a greyed-out row.
export const CLAUDE_CAPABILITIES: AgentCapability[] = providerCapabilities("claude");
export const CLAUDE_CLI: AgentCli = {
  id: "claude", label: "Claude Code", mark: "Cc", bin: "claude", path: "",
  capabilities: CLAUDE_CAPABILITIES,
};
/// Which agent a launch in `colorKey` actually starts — the project override if there
/// is one, else the global default, else Claude.
///
/// The fallback is the whole reason this is a function and not a lookup. Both prefs
/// are ids persisted in `localStorage`, and `avail` is re-probed at every startup, so
/// either can name an agent that has since been uninstalled — at which point every
/// launch in that project would fail on a binary that is no longer there, with the
/// setting still cheerfully showing the name. Falling back means the worst case is "it
/// started the wrong agent", not "⌘N stopped working".
///
/// A plain cascade rather than a strict one: an override naming a dead agent drops to
/// the *default*, not straight to Claude. "My override broke, so I get my default" is
/// what every settings system does, and Claude is the floor of that cascade rather
/// than a special case inside it.
export function pickAgent(colorKey: string, def: string, byProject: Record<string, string>, avail: AgentCli[]): AgentCli {
  // `agentInstalled`, not just "is in the list": since `list_agents` began returning
  // the whole catalogue, being *in* `avail` stopped meaning the binary is there. An id
  // naming a listed-but-absent agent has to fall through exactly as an unknown one
  // does, or the picker's greyed rows become launchable through the back door.
  const known = (id: string | undefined) =>
    id === CLAUDE_CLI.id ? CLAUDE_CLI : avail.find((a) => a.id === id && agentInstalled(a));
  return known(byProject[colorKey]) ?? known(def) ?? CLAUDE_CLI;
}
// Where a launched terminal lives. The instrumentation is identical for all four;
// this only decides which window the PTY is attached to. The label/availability
// table (ALL_ENGINES, available_terminals) stays in the UI layer that offers them.
export type Engine = "embedded" | "ghostty" | "terminal" | "iterm";
// How a new claude session treats tool calls at launch (`claude --permission-mode`).
// Orthogonal to Engine: this decides what the session may do, not where its terminal
// lives, and it applies to every engine. The spellings are Claude Code's own, because
// they go on the command line verbatim (bar `default`, which means "pass no flag" —
// see `permission_mode_arg` in pty.rs). Only the *starting* mode: Claude's own ⇧⇥
// still switches mode inside a running session, and nothing here tracks that.
export type PermMode = "default" | "plan" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions";
export const isAgent = (s: Sess) => s.kind === "agent";
export const isClaude = (s: Sess) => isAgent(s) && s.provider === "claude";
// Capability checks are the shared UI boundary. `isClaude` remains for the few
// launch/protocol decisions that really are provider-specific; phase, inspector,
// roster and usage surfaces ask what the adapter supplies instead.
export const hasAgentCapability = (s: Sess, capability: AgentCapability) =>
  isAgent(s) && s.capabilities.includes(capability);
export const hasSessionState = (s: Sess) => hasAgentCapability(s, "session-state");
/// Stable identity wherever live provider sessions share one set. Thread ids are
/// provider-owned, so a bare UUID is not a global key once more than one adapter exists.
export const providerSessionKey = (provider: string | null | undefined, id: string) =>
  `${(provider || "").toLowerCase()}:${id.toLowerCase()}`;
// Whether the process behind a pane has exited. The pane still renders — an ended
// row is information — but nothing behind it can change any more, so the pollers
// skip it and the quit guard doesn't count it. Phase alone can't answer this for a
// task: its exit sets done/error, the same phases a live claude turn cycles through,
// so the run's exit code is the discriminant there.
export const isExited = (s: Sess) => (s.kind === "task" ? s.run?.exitCode != null : s.phase === "ended");
// Whether work is in flight in this pane — the question to ask before moving the
// ground under it, which today means switching the branch of the folder it lives in.
// Deliberately narrower than "a pane exists here", which is what the branch switch
// used to refuse on: one idle agent made a folder unswitchable, and the only way out
// was to close a conversation you wanted to keep.
//
// The three kinds answer it differently because they hold the tree differently:
//   shell  — never. It is your prompt, and `git switch` is a thing people run in a
//            terminal on purpose; a shell pane blocking one is the app arguing with
//            the command the pane exists to accept.
//   task   — while it runs. A run is a claim about a tree, and a build that starts on
//            one branch and finishes on another has verified nothing.
//   integrated agent — only mid-turn: thinking, working, or holding a permission whose tool call
//            fires the instant you allow it. Idle, done and error are all "the agent is
//            waiting on you" — it is not touching the tree, and its next turn reads
//            HEAD fresh rather than from the conversation.
//   terminal-only agent — never, and this one is a judgement call rather than a fact.
//            There is no control plane, so "is it mid-edit?" is genuinely
//            unanswerable; the choice is between a switch that is occasionally unsafe
//            and a checkout that can never be switched while a terminal-only agent pane is open,
//            since nothing would ever report it idle again. A session lives for hours
//            (unlike a task run, which is why that one blocks), so the permanent block
//            is the worse of the two — and the user drove the agent here and knows
//            whether it is working.
export const midFlight = (s: Sess) =>
  s.kind === "shell" || (isAgent(s) && !hasSessionState(s)) ? false
    : s.kind === "task" ? !isExited(s)
      : !!s.attention || s.phase === "working" || s.phase === "thinking";
// ---------- background fan-outs ----------
// One rule, read by six surfaces (sidebar glyph, mini-rail, tray, inspector pill and
// card, the "needs you" set): a session whose agents are still working is not waiting
// on you. It lives here beside the other discriminants for the same reason they do.

/// How long a fan-out keeps its state after the last agent stops.
///
/// Not cosmetic smoothing. A workflow script runs its stages between fan-outs — a
/// barrier collects results, plain JS dedupes them, the next `parallel()` spawns — and
/// through that gap the live count is genuinely 0 while the run is very much alive.
/// Without a window the cockpit would flip to "your turn" and back on every stage
/// boundary, which is worse than the bug this fixes. It is generous because the cost of
/// being late is one stale minute, and the cost of being early is a lie.
export const FANOUT_GRACE_MS = 90_000;
/// The opposite bound: how long `subagents > 0` is believed with no event behind it.
///
/// The live count is differenced from fire-and-forget hooks, and a `SubagentStop` can
/// genuinely never come — an interrupted workflow's agents, a turn the API killed, a
/// silently dropped POST (`curl -s` + async by design). Every miss skews the count up
/// and nothing ever skews it down, so without a ceiling one lost Stop pinned the
/// "background" badge on a finished pane for the rest of the app's life: a pane once
/// read "2/8" an hour after its run-state file said completed, six leaked agents
/// strong. An hour of silence outvotes the counter while sitting far above the longest
/// real quiet stretch seen mid-run (eighteen minutes); a fleet that outlives it only
/// dims until its next event, because that event re-stamps `lastAt` and revives the
/// readout. `applyHook` zeroes the count itself off this same answer.
export const FANOUT_DEAD_MS = 3_600_000;
/// The session's fan-out if it is still in flight, else null.
///
/// `subagents > 0` has to be sufficient on its own — a workflow agent can run eighteen
/// minutes without the parent seeing a single `Subagent*` event in between, so a rule
/// that only trusted recent activity would drop the longest runs first. Sufficient,
/// but not forever: past `FANOUT_DEAD_MS` of silence the count is what's suspect, and
/// the fleet is written off however high it reads.
export function liveFanout(s: Sess, now = Date.now()): Fanout | null {
  if (!hasSessionState(s) || !s.fanout) return null;
  if (now - s.fanout.lastAt >= FANOUT_DEAD_MS) return null;
  return s.subagents > 0 || now - s.fanout.lastAt < FANOUT_GRACE_MS ? s.fanout : null;
}
/// Is the fan-out the whole story — i.e. the conversation itself has nothing in flight?
///
/// Deliberately narrow. A permission still outranks it (Claude is blocked on you *now*),
/// and so does a failed turn; and while the agent is mid-turn its own `working` reading
/// is the truer one, with the fleet showing as a tally beside it. This is the state that
/// used to be a green ✓.
export function bgWaiting(s: Sess, now = Date.now()): boolean {
  return !s.attention && (s.phase === "done" || s.phase === "idle") && !!liveFanout(s, now);
}
/// `done / total` for a row or a card, or null when there is no fleet worth a number.
///
/// The total is `max(started, done + running)`, never `started` alone: launching a second
/// workflow while the first still has agents up restarts the counters, and a bar that
/// read 4/2 would be the visible half of that. One owner for the arithmetic, because the
/// sidebar tally and the inspector's bar must never disagree.
export function fanoutTally(s: Sess, now = Date.now()): { done: number; total: number } | null {
  const f = liveFanout(s, now);
  if (!f) return null;
  const total = Math.max(f.started, f.done + s.subagents);
  return total > 1 || bgWaiting(s, now) ? { done: Math.min(f.done, total), total } : null;
}
/// What a background fan-out is called in prose. The lull case says the run is alive
/// without naming a count, because during a stage boundary there is no count to name.
export function fanoutText(s: Sess): string {
  const n = s.subagents;
  if (n) return `${n} agent${n === 1 ? "" : "s"} working`;
  return s.fanout?.name ? "workflow running" : "background work";
}

// Which glyph/CSS bucket a pane falls into: a blocking permission outranks the
// phase it is blocking, and a live fan-out outranks the `done` it left behind.
// Read by the sidebar rows, the mini-rail, the tray and the inspector pill, so it
// lives here rather than in any one of them.
export const statusKey = (s: Sess, now = Date.now()) =>
  s.attention ? "attention" : bgWaiting(s, now) ? "background" : s.phase;
// What a phase is called in prose. Read by the inspector pill, the reactor dropdown
// and the tray menu — same three-reader argument as statusKey above, so it lives
// beside it rather than in whichever of them was extracted first.
export const PILL_TEXT: Record<Phase, string> = { idle: "idle", thinking: "thinking…", working: "working…", done: "your turn", error: "error", ended: "ended" };
// Claude Code's StopFailure `error` enum in the cockpit's words. An unlisted value
// (Claude adds to this enum) falls back to the raw one de-underscored, so a new
// failure kind still reads as itself rather than as a bare "error".
export const API_ERR_TEXT: Record<string, string> = {
  overloaded: "API overloaded", rate_limit: "rate limited", server_error: "API server error",
  authentication_failed: "auth failed", oauth_org_not_allowed: "org not allowed",
  billing_error: "billing problem", invalid_request: "invalid request",
  model_not_found: "model not found", max_output_tokens: "output limit reached",
  unknown: "API error",
};
export const apiErrText = (e: ApiErr) => API_ERR_TEXT[e.kind] ?? (e.kind.replace(/_/g, " ") || "API error");
// The phase in prose, naming the API failure when there is one. Every surface that
// labels a state reads this rather than PILL_TEXT directly: "error" tells you the
// turn broke, "API overloaded" also tells you it wasn't your fault and to retry.
export const phaseText = (s: Sess, now = Date.now()) =>
  s.phase === "error" && s.apiErr ? apiErrText(s.apiErr)
    : bgWaiting(s, now) ? fanoutText(s)
      : PILL_TEXT[s.phase];

/// How long a run has taken: wall-clock while it is going, and **frozen at its exit**
/// once it is over.
///
/// The single source for every duration a run shows, and it is one function because it
/// was three: the sidebar column, the tiled pane's caption and the inspector's "Took"
/// row each did their own `Date.now() - startedAt`. All three therefore kept counting
/// after the process had exited — a step that finished in 400ms read "1m 23s" a minute
/// later, and a whole tiled chain showed the same climbing number. Fixing two of the
/// three copies is exactly the mistake this consolidation prevents: anything that wants
/// a run's duration calls here.
export function runElapsed(r: NonNullable<Sess["run"]>, now = Date.now()): string {
  // `?? now` only covers a run whose exit predates this field — a pane restored from
  // an older build.
  return fmtShort((r.exitCode == null ? now : r.endedAt ?? now) - r.startedAt);
}

/// A run's trailing readout — the sidebar column, the palette subtitle and a tiled
/// pane's caption all show this one string. A background run never claims to be
/// finished, so it reads "bg" for as long as it lives.
///
/// It lives here, beside the other discriminants that read the model, because it is
/// pure — and `now` is a parameter so the elapsed case is testable without faking the
/// clock.
export function taskStateText(s: Sess, now = Date.now()): string {
  const r = s.run;
  if (!r) return "";
  if (r.background && r.exitCode == null) return "bg";
  if (r.exitCode == null) return s.phase === "working" ? runElapsed(r, now) : "";
  return r.exitCode === 0 ? runElapsed(r, now) : `exit ${r.exitCode}`;
}

// The resolved half of a Runnable — what the backend needs to actually start it.
export interface Exec { mode: "argv"; program: string; args: string[] }
export interface ExecShell { mode: "shell"; line: string }
// One value a task needs before it can run — a VS Code `${input:…}` declaration,
// or a just recipe parameter with no default.
export interface InputSpec {
  id: string; kind: "promptString" | "pickString"; description: string;
  default: string | null; options: string[]; password: boolean;
  // The task runs fine with this left empty (a just `*name` parameter). Plain Run
  // skips the dialog for it; "Run with parameters…" still offers the field.
  optional: boolean;
}
export interface Runnable {
  id: string; label: string; detail: string | null;
  source: string; sourceFile: string; group: string | null;
  exec: Exec | ExecShell; cwd: string; env: Record<string, string>;
  background: boolean; inputs: InputSpec[];
  // Labels, not ids — VS Code names dependencies by label.
  dependsOn: string[]; dependsOrder: "parallel" | "sequence";
  blocked: string | null;
  /// No command of its own — `dependsOn` IS the work (VS Code's compound task).
  /// Launches no pane; `launchWithDeps` runs the dependencies and stops.
  compound: boolean;
  /// "build" | "test" when the source file marks this that group's *default* task,
  /// which is what ⌘⇧B / ⌘⇧T resolve to.
  defaultFor: string | null;
}

export interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  // The provider's durable conversation/thread id, as distinct from Episko's pane id.
  // Claude rotates it on /clear, /compact and /resume; Codex supplies its thread id
  // after App Server starts. Restoring always targets this provider-owned identity.
  resumeId: string;
  branch: string; worktree: string | null; title: string;
  phase: Phase; phaseSince: number; lastActivity: number; attention: string | null; pendingCmd: string; pendingPermId: string | null; pendRisk: Risk | null;
  /// When this pane entered the "needs you" set, and **0 when it is not in it** —
  /// maintained in exactly one place (`syncAttn` in ./grouping) rather than at each of
  /// the four events that can put it there. It is not `phaseSince`: a permission is
  /// raised without the phase moving at all, and a fan-out's grace window expiring puts
  /// a session back in the set with no event of any kind. See ./attn for what reads it.
  attnAt: number;
  /// The last time you put this pane on the stage. Compared against `attnAt` — and
  /// against nothing else — to answer "have you looked at this since it started wanting
  /// you", which is what stops the reactor badge counting turns you have already read.
  seenAt: number;
  /// Agents running in this session's name RIGHT NOW — `SubagentStart` minus
  /// `SubagentStop`. The live count and nothing else; the cumulative tally, the run's
  /// name and its phases live on `fanout` beside it.
  subagents: number;
  /// The background fleet this session launched, from the first `SubagentStart` (or the
  /// `Workflow` call that named it) until the next turn clears it. Null for the great
  /// majority of sessions, which never fan out. See `Fanout` for why it exists.
  fanout: Fanout | null;
  // Set by StopFailure, cleared the moment the session starts a new turn. While it
  // is set the turn is known-failed, which is what stops the 60s idle Notification
  // from relabelling a dead turn "your turn" — see endTurn in phase.ts.
  apiErr: ApiErr | null;
  // Set when the agent's work has moved to a *different* checkout of this repo than the
  // one the session was launched in — by either route, see `Drift.via` above and
  // ./gitwatch for the two signals. Display-only either way: nothing here changes
  // `workdir`, so the pane keeps acting on its launch folder until the user follows the
  // drift. Which of the two it is decides what "following" means, and note that for
  // `via: "cwd"` the process has *already* left `workdir` — that is the gap the
  // inspector's button closes, not one Episko opened.
  drift: Drift | null;
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  tokenUsage: AgentTokenUsage | null;
  rateLimits: AgentRateLimit[];
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null;
  lastEvent: string; activity: Act[];
  /// Every file this session has read, edited or created, and how many tools it ran
  /// that touched no file at all. Both accumulate from PostToolUse and are display-only
  /// — nothing here is written to disk or read back, so a restart starts them empty.
  /// See ./files for the rules and the inspector's Context card for what draws them.
  files: FileTouch[]; tally: Record<string, number>;
  // `gl` is the pane's WebGL renderer addon while it holds a pooled context —
  // attached on activation, released when the pool evicts it or the pane exits (see
  // attachWebgl in ./terminal). Held here rather than inside terminal.ts because it
  // lives and dies with the pane.
  kind: SessKind; external: boolean; term?: Terminal; fit?: FitAddon; gl?: WebglAddon; pane: HTMLElement;
  // Set only while a reload orphan's pane is being rebuilt (#47 stage 2): incoming
  // pty-output chunks queue here instead of reaching the terminal until the
  // scrollback snapshot has been written. A queued chunk at or below the
  // snapshot's seq is already inside it and is dropped on flush; see adoptSession
  // in ./panes for the whole protocol.
  adopt?: { pending: { seq: number; bytes: Uint8Array }[] } | null;
  /// Stable provider slug for an agent pane (`AgentCli.id`), null for shells/tasks.
  /// Capabilities are copied at launch so every session remains self-describing even
  /// if the installed-provider catalogue is refreshed or the adapter disconnects.
  provider: string | null;
  capabilities: AgentCapability[];
  // task panes only
  run?: {
    id: string; label: string; source: string; sourceFile: string; cmd: string; background: boolean;
    startedAt: number; exitCode: number | null; tail: string[];
    /// When the process exited. Without it the elapsed readout is `Date.now() -
    /// startedAt` forever, so a run that took 400ms reads "1m 23s" a minute later —
    /// the duration has to be frozen at the exit, not recomputed on every repaint.
    endedAt?: number;
    /// The directory discovery ran in — where `sourceFile` is rooted, so *reveal
    /// source* can find the file even for a task whose run cwd is a subfolder.
    root: string;
    /// Set when a run-on-stop rule started this — the session whose turn it was
    /// verifying, and therefore the one a failure should be offered back to.
    forSession?: string;
    /// Every pane of one `dependsOn` chain shares this id, so the sidebar can show
    /// "build → lint → test" as one collapsible row instead of three loose panes,
    /// and the stage can tile them together. Minted per *launch*, never per task:
    /// running `fe-check` twice is two groups, which is what you want to compare.
    /// Absent on a task launched on its own — a group of one is just a row.
    groupId?: string;
    /// The chain's own name (the label of the task that pulled the others in), for
    /// the group row. Carried rather than derived: the root is not distinguishable
    /// from its dependencies once they are all just panes.
    groupLabel?: string;
  };
}

// Claude Code sessions started OUTSIDE Episko (a plain terminal, an IDE). We
// discover them from ~/.claude/sessions/<pid>.json (via the backend), show them
// in the sidebar as read-only, and can jump to their terminal window.
export interface ExtSession {
  pid: number; session_id: string; cwd: string; name: string;
  status: string; status_updated_at?: number | null; started_at?: number | null; version: string;
  // repo_root = the main worktree of this session's repo (backend-resolved), so all
  // worktrees of one repo group under it; branch = the branch checked out in cwd.
  repo_root?: string | null; branch?: string | null;
}

// ---------- restorable sessions ----------
// Restore remembers which resumable provider sessions were on screen at quit. Claude
// resumes its transcript; Codex resumes its App Server thread. The roster stores the
// provider so a later preference change cannot reopen a conversation in the wrong CLI.
/// One embedded PTY as the BACKEND holds it (`live_sessions`). Meaningful to the
/// frontend only where its own map falls short — after a webview reload, when the
/// map is empty and every one of these is an orphan (#47).
export interface LiveSess { id: string; kind: string; provider: string | null; workdir: string }

export interface Restorable {
  id: string;          // the original launch uuid (roster key, stable across restarts)
  resumeId: string;    // what to hand the provider's resume operation
  provider: string;
  project: string; workdir: string; colorKey: string;
  worktree: string | null; branch: string;
  title: string;       // last known label; refreshed from provider history when possible
  lastActivity: number;
}
