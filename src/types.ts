// The shared data model: the shapes that cross module boundaries. Types, plus
// the one-line discriminants that read them — no other logic, and no imports
// beyond the xterm handles a live pane holds — so every other module can depend
// on this one without dragging DOM or Tauri along.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

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
export interface Act { tool: string; arg: string; time: string; startMs: number; durMs: number | null }
// A single item from a TodoWrite payload (the plan Claude keeps for itself).
export interface Todo { content: string; status: string }
// Uncommitted "working set" summary from the git_diffstat backend command, plus
// where the branch sits against its upstream (ahead/behind are as of the last
// fetch, not live — see upstream_state in lib.rs).
export interface DiffStat {
  added: number; removed: number; files: number; untracked: number; dirty: number;
  upstream: string | null; ahead: number; behind: number;
}
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
// Disk I/O for one session's `claude` process: rates over the gap since the previous
// sample, plus lifetime totals. `primed` is false on the first reading, when there is
// nothing to difference against and the rates are 0 by default rather than measured.
export interface Res { readBps: number; writeBps: number; readMb: number; writtenMb: number; primed: boolean }
// Result of a fetch/pull/push. `suggest` is set when the action was refused (or
// git failed) and there's a command worth handing to a real terminal.
export interface GitActionResult { ok: boolean; summary: string; output: string; suggest: string | null }
// What a pane actually contains. All three run in an identical PTY; the kind is
// what decides whether telemetry, cost and git actions apply to it.
//   claude — an instrumented `claude` session (the only kind with telemetry)
//   shell  — a plain login shell (❯ Terminal)
//   task   — one run of a Runnable (▶ Run), whose exit code becomes done/error
// Note `external` is orthogonal: it means "the terminal lives in Ghostty/iTerm
// rather than an embedded pane", and only ever applies to a claude session.
export type SessKind = "claude" | "shell" | "task";
// Where a launched terminal lives. The instrumentation is identical for all four;
// this only decides which window the PTY is attached to. The label/availability
// table (ALL_ENGINES, available_terminals) stays in the UI layer that offers them.
export type Engine = "embedded" | "ghostty" | "terminal" | "iterm";
// Always ask through this rather than re-testing the string: whether telemetry,
// cost and git actions apply to a pane is one decision, made in one place.
export const isAgent = (s: Sess) => s.kind === "claude";
// Which glyph/CSS bucket a pane falls into: a blocking permission outranks the
// phase it is blocking. Read by the sidebar rows, the mini-rail, the tray and the
// inspector pill, so it lives here rather than in any one of them.
export const statusKey = (s: Sess) => (s.attention ? "attention" : s.phase);
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
export const phaseText = (s: Sess) => (s.phase === "error" && s.apiErr ? apiErrText(s.apiErr) : PILL_TEXT[s.phase]);

// The resolved half of a Runnable — what the backend needs to actually start it.
export interface Exec { mode: "argv"; program: string; args: string[] }
export interface ExecShell { mode: "shell"; line: string }
// One value a task needs before it can run — a VS Code `${input:…}` declaration,
// or a just recipe parameter with no default.
export interface InputSpec {
  id: string; kind: "promptString" | "pickString"; description: string;
  default: string | null; options: string[]; password: boolean;
}
export interface Runnable {
  id: string; label: string; detail: string | null;
  source: string; sourceFile: string; group: string | null;
  exec: Exec | ExecShell; cwd: string; env: Record<string, string>;
  background: boolean; inputs: InputSpec[];
  // Labels, not ids — VS Code names dependencies by label.
  dependsOn: string[]; dependsOrder: "parallel" | "sequence";
  blocked: string | null;
}

export interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  // resumeId = the id `claude --resume` must target. It starts equal to `id` (we
  // launch with --session-id id) but tracks Claude's *runtime* id, which rotates
  // on /clear, /compact and /resume — each rotation opening a NEW transcript file.
  // Restoring `id` after a compaction would resurrect the pre-compaction thread.
  resumeId: string;
  branch: string; worktree: string | null; title: string;
  phase: Phase; phaseSince: number; lastActivity: number; attention: string | null; pendingCmd: string; pendingPermId: string | null; pendRisk: Risk | null; subagents: number;
  // Set by StopFailure, cleared the moment the session starts a new turn. While it
  // is set the turn is known-failed, which is what stops the 60s idle Notification
  // from relabelling a dead turn "your turn" — see endTurn in phase.ts.
  apiErr: ApiErr | null;
  // Set when the agent's writes land in a *different* checkout of this repo than the
  // one the session was launched in — see driftTarget in ./gitwatch for why writes are
  // the only signal that can say so. Display-only: `workdir` stays the folder Claude
  // actually runs in (and that `--resume` needs) until the user moves the session.
  drift: Drift | null;
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null; res: Res | null;
  lastEvent: string; activity: Act[];
  kind: SessKind; external: boolean; term?: Terminal; fit?: FitAddon; pane: HTMLElement;
  // task panes only
  run?: {
    id: string; label: string; source: string; sourceFile: string; cmd: string; background: boolean;
    startedAt: number; exitCode: number | null; tail: string[];
    /// The directory discovery ran in — where `sourceFile` is rooted, so *reveal
    /// source* can find the file even for a task whose run cwd is a subfolder.
    root: string;
    /// Set when a run-on-stop rule started this — the session whose turn it was
    /// verifying, and therefore the one a failure should be offered back to.
    forSession?: string;
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
// Episko's launch uuid IS Claude's --session-id, so every session we launch already
// has a transcript at ~/.claude/projects/<enc(workdir)>/<id>.jsonl. Restoring is
// therefore not about capturing conversation state — Claude already has it — but
// about remembering which sessions were on screen at quit, and with what identity.
export interface Restorable {
  id: string;          // the original launch uuid (roster key, stable across restarts)
  resumeId: string;    // what to hand `claude --resume`
  project: string; workdir: string; colorKey: string;
  worktree: string | null; branch: string;
  title: string;       // last known label; refreshed from the transcript on load
  lastActivity: number;
}
