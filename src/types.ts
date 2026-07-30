// The shared data model: the shapes that cross module boundaries. Types, plus
// the one-line discriminants that read them — no other logic, and no imports
// beyond the xterm handles a live pane holds — so every other module can depend
// on this one without dragging DOM or Tauri along.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import { fmtShort } from "./format";

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
