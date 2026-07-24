// The shared data model: the shapes that cross module boundaries. Types only —
// no logic, no imports beyond the xterm handles a live pane holds — so every
// other module can depend on this one without dragging DOM or Tauri along.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

// ---------- model ----------
export type Phase = "idle" | "thinking" | "working" | "done" | "error" | "ended";
export type Risk = "low" | "med" | "high";
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
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null; res: { cpu: number; memMb: number } | null;
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
