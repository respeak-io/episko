// The shared data model and the one-line discriminants that read it; no DOM, no Tauri.

import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";

import { fmtShort } from "./format";
import providerManifest from "./providers/manifest.json";

// ---------- model ----------
export type Phase = "idle" | "thinking" | "working" | "done" | "error" | "ended";
export type Risk = "low" | "med" | "high";
export interface ApiErr { kind: string; detail: string; at: number } // from StopFailure
// The revive watchdog's schedule for an ApiErr; rules in ./revive, timer in ./actions.
export interface ReviveState {
  attempts: number; // this failure streak; survives the turns it starts (see Sess.revive)
  errAt: number;
  dueAt: number;
  lastAt: number;   // display only
  gaveUp: boolean;  // "stopped trying" announced once
}
// One tool call. `id` (Claude's tool_use_id) pairs Pre with Post; a name match is only the fallback
// for a payload with no id. inp/out are capped at capture (./toolio); `failed` puts the reason in `error`.
export interface Act {
  tool: string; arg: string; time: string; startMs: number; durMs: number | null;
  id: string; inp: string; out: string; failed: boolean;
  desc: string; // Claude's own reason for the call, lifted out of inp (descText in ./toolio)
}
export const actKey = (a: Act): string => a.id || `t${a.startMs}`; // startMs, not an index
// One entry per path, never per call; kind only climbs read → edited → created (RANK in ./files).
export type TouchKind = "created" | "edited" | "read";
export interface FileTouch { path: string; kind: TouchKind; n: number; at: number }

// Off the backend verbatim; notYet may retire the row, noRoot/ambiguous is an outage and must not.
export type BgMissReason = "none" | "badId" | "notYet" | "noRoot" | "ambiguous" | "unreadable";

export type BgEnd = "sentinel" | "unknown" | "stale" | "session"; // null means "somebody asked"

export type BgKind = "server" | "job"; // decided on evidence (a URL), never on the command text

// A background shell an agent started (Bash{run_in_background:true}); see ./servers. `transcript` is
// captured at start and never recomputed: Claude rotates the session dir on /clear, /compact and /resume.
export interface BgServer {
  taskId: string; // Claude's backgroundTaskId, the only handle TaskStop takes
  cmd: string;
  transcript: string;
  startedAt: number;
  log?: string; // this and everything below come off the log file by the poll, absent until the first read
  url?: string; // the LAST localhost URL printed; a restarted server prints a fresh one
  ended?: number; exit?: number | null; // an ended record stays on the session as history
  tail?: string[];
  len?: number; // log length at the last read; an unchanged file costs read_bg_log a metadata() call
  timedOut?: number; // tool_response.timedOutAfterMs; auto-backgrounded past 120s, may never adopt a port
  reason?: BgMissReason;
  tried?: string[];
  rootRank?: number; // -1 when found by directory scan
  missSince?: number; // first notYet, cleared on a read; retirement is measured from this, not startedAt
  endReason?: BgEnd;
}
export interface Todo { content: string; status: string }
export interface DiffStat {
  added: number; removed: number; files: number; untracked: number; dirty: number;
  upstream: string | null; ahead: number; behind: number; // as of the last fetch (upstream_state in git.rs)
}
export interface StatusFile {
  // 0/0 for a binary or an untracked file too large to read
  path: string; code: string; from: string | null; added: number; removed: number;
}
// entries is capped backend-side, dirty is not
export interface WorkingSet extends DiffStat { entries: StatusFile[] }

// ---- what a change did to the shape of the code (health.rs measures, ./health decides) ----
// cognitive: no-AST approximation, compare only within a change
export interface FnSpan { name: string; start: number; end: number; code_lines: number; cognitive: number }
export interface DupHit { line: number; other_path: string; other_line: number } // 6+ lines seen elsewhere
export interface FileHealth {
  path: string; code_lines: number; code_added: number;
  max_nesting: number; nesting_line: number;
  worst_fn: FnSpan | null; longest_fn: FnSpan | null;
  // false: unreadable, every number meaningless; render nothing, never zeroes
  dups: DupHit[]; measured: boolean;
}
export interface HealthPolicy {
  // [health] in .episko/episko.toml; absent = default, clampHealth refuses 0
  cognitive?: number; nesting?: number; longFn?: number; sizeAdd?: number;
}
export interface HealthReport {
  // p90 is the project's own; truncated: a dup may be missed
  files: FileHealth[]; p90_code_lines: number; indexed: number; truncated: boolean;
  prefs: HealthPolicy;
}
export interface WtHead { path: string; branch: string; is_main: boolean; exists: boolean }
// A checkout other than the launch one (./gitwatch). via decides the repair: "cwd" means Claude moved
// the session itself, so the dir is adopted; "write" means only its writes moved, so it relaunches there.
export interface Drift { dir: string; branch: string; via: "cwd" | "write" }
// A background fan-out (Workflow, or a burst of Task subagents). It ends the parent's turn, so done alone
// is not "your turn". Built from the hooks, never from Claude's run-state file (docs/architecture.md).
export interface Fanout {
  name: string; // meta.name; empty for a bare Task fan-out
  detail: string;
  phases: string[]; // meta.phases[].title, in order; no hook says which is current
  since: number;
  started: number; done: number; // cumulative; Sess.agents owns the live set
  lastAt: number; // the last Subagent* event; what liveFanout's grace window measures
}
// One spawned agent, by agent_id, so a Stop that never arrives is a named leftover rather than a wrong
// count. A payload with no id gets a synthetic one (startAgent) and stopAgent retires the oldest outstanding.
export interface Agent {
  type: string;
  since: number;
  // 0 while its fan-out is the running one, else when a newer run superseded it; then ORPHAN_DEAD_MS applies
  orphanedAt: number;
}
export interface Res { readBps: number; writeBps: number; readMb: number; writtenMb: number; primed: boolean }
// a version appearing mid-run is a self-update; installGrown in ./usage discounts it
export interface InstallFile { name: string; mb: number }
// why "cwd": sitting in the folder, "file": an open handle; ours is cleared without asking
export interface PathHolder { pid: number; name: string; why: "cwd" | "file"; ours: boolean }
// a removed worktree whose folder would not delete (Windows, in practice)
export interface Stranded { path: string; stuck: string; reason: string; holders: PathHolder[] }
// suggest: a command worth handing to a terminal when the action was refused. stranded (remove_worktree
// only) rides with ok: true: git dropped the worktree but the folder stayed (purge_worktree_folder's).
export interface GitActionResult {
  ok: boolean; summary: string; output: string; suggest: string | null;
  stranded?: Stranded | null;
}
export interface PurgeResult { gone: boolean; stranded: Stranded | null }
export type SessKind = "agent" | "shell" | "task";
export const AGENT_CAPABILITIES = [
  "session-state", "activity", "context", "usage", "permissions", "resume",
  "history", "external-terminal", "launch-permissions",
] as const; // user-facing capabilities, not transport names: any protocol may produce session-state
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

type ProviderManifestEntry = { capabilities: string[] };
const PROVIDER_MANIFEST = providerManifest as Record<string, ProviderManifestEntry>;
const AGENT_CAPABILITY_SET = new Set<string>(AGENT_CAPABILITIES);

/** The manifest is shared with Rust; a misspelt capability must throw here, not turn a feature off. */
export function providerCapabilities(id: string): AgentCapability[] {
  const capabilities = PROVIDER_MANIFEST[id]?.capabilities ?? [];
  for (const capability of capabilities) {
    if (!AGENT_CAPABILITY_SET.has(capability)) {
      throw new Error(`unknown capability ${capability} for provider ${id}`);
    }
  }
  return [...capabilities] as AgentCapability[];
}
// The whole catalogue, installed or not: path null means "not on this machine" and the row stays,
// greyed; mark is wire compat.
export interface AgentCli {
  id: string; label: string; mark: string; bin: string; path: string | null;
  capabilities: AgentCapability[];
}
export interface AgentTokenBreakdown {
  totalTokens: number; inputTokens: number; cachedInputTokens: number;
  cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number;
}
export interface AgentTokenUsage {
  // last is the latest call, the context reading for Codex; Claude leaves Sess.tokenUsage null (its
  // statusLine fills the legacy fields)
  total: AgentTokenBreakdown; last: AgentTokenBreakdown; contextWindow: number | null;
}
export interface AgentRateLimit {
  usedPercent: number; resetsAt: number | null; windowMins: number | null;
}
// Providers can raise several at once, so Sess keeps a queue; the legacy scalars mirror its head.
export interface PendingPermission {
  id: string; tool: string; command: string; risk: Risk;
}
export interface AgentPermissionMode {
  // id is opaque to all but its adapter and re-whitelisted at launch; asks: can an approval card still appear
  id: string; label: string; sub: string; glyph: string; asks: boolean;
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
// the one place the null-path convention is read
export const agentInstalled = (a: AgentCli) => a.path !== null;
// Claude's catalogue row, spelled here rather than in the backend's AGENTS table (it must go through
// spawn_claude to be instrumented). path is "" because resolve_claude never reports "not installed".
export const CLAUDE_CAPABILITIES: AgentCapability[] = providerCapabilities("claude");
export const CLAUDE_CLI: AgentCli = {
  id: "claude", label: "Claude Code", mark: "Cc", bin: "claude", path: "",
  capabilities: CLAUDE_CAPABILITIES,
};
// Project override, else global default, else Claude. Either pref can name an agent since
// uninstalled, so each step falls through rather than failing every launch in the project.
export function pickAgent(colorKey: string, def: string, byProject: Record<string, string>, avail: AgentCli[]): AgentCli {
  // agentInstalled, not merely listed: list_agents returns the whole catalogue
  const known = (id: string | undefined) =>
    id === CLAUDE_CLI.id ? CLAUDE_CLI : avail.find((a) => a.id === id && agentInstalled(a));
  return known(byProject[colorKey]) ?? known(def) ?? CLAUDE_CLI;
}

// Conversation identity, not a preference: an unknown provider must not become Claude and eat the
// wrong restore row. Absent means Claude; known-but-uninstalled is returned so its launch error explains.
export function resumeAgent(provider: string | undefined, catalogue: AgentCli[]): AgentCli | undefined {
  if (!provider || provider === CLAUDE_CLI.id) return CLAUDE_CLI;
  return catalogue.find((agent) => agent.id === provider);
}
// where the PTY's window lives; instrumentation is the same for all
export type Engine = "embedded" | "ghostty" | "terminal" | "iterm";
export const isAgent = (s: Sess) => s.kind === "agent";
export const isClaude = (s: Sess) => isAgent(s) && s.provider === "claude";
// the shared UI boundary; isClaude only where the protocol matters
export const hasAgentCapability = (s: Sess, capability: AgentCapability) =>
  isAgent(s) && s.capabilities.includes(capability);
export const hasSessionState = (s: Sess) => hasAgentCapability(s, "session-state");
// thread ids are provider-owned; a bare UUID is no global key
export const providerSessionKey = (provider: string | null | undefined, id: string) =>
  `${(provider || "").toLowerCase()}:${id.toLowerCase()}`;
// Nothing behind an exited pane can change (pollers skip it, the quit guard ignores it); a task's
// exit sets done/error, so its exit code decides.
export const isExited = (s: Sess) => (s.kind === "task" ? s.run?.exitCode != null : s.phase === "ended");
// Whether work is in flight, asked before switching the folder's branch. shell: never. task: while it
// runs. integrated agent: mid-turn or holding a permission. terminal-only agent: never, since nothing
// could report it idle again, and a checkout that can never be switched is the worse failure.
export const midFlight = (s: Sess) =>
  s.kind === "shell" || (isAgent(s) && !hasSessionState(s)) ? false
    : s.kind === "task" ? !isExited(s)
      : !!s.attention || s.phase === "working" || s.phase === "thinking";
// Shelve = stop now, keep a row that resumes later. Needs resume, a workdir (a resume runs in the original
// dir) and an embedded pane: kill_session cannot reach an external one.
export const canShelve = (s: Sess) =>
  isAgent(s) && !s.external && !!s.workdir && hasAgentCapability(s, "resume");
// ---------- background fan-outs: a session whose agents are still working is not waiting on you ----------

// A workflow's stage boundaries (barrier, dedupe, next parallel()) leave the live count at 0 while the
// run is alive; without a window the cockpit would flip to "your turn" and back at each of them.
export const FANOUT_GRACE_MS = 90_000;
// A SubagentStop can never come (interrupt, killed turn, dropped async POST) and every miss skews the
// count up, so silence past this outvotes it; a real event re-stamps lastAt and revives the readout.
export const FANOUT_DEAD_MS = 3_600_000;
// An inherited agent has no event coming (its run was replaced), so the fleet's hour would only
// guard a ghost.
export const ORPHAN_DEAD_MS = 900_000;
// A function, not a field: the expiry is a time, and a done session with a stale fleet receives no
// hook to repair it on.
export function liveAgents(s: Sess, now = Date.now()): Agent[] {
  const out: Agent[] = [];
  for (const a of s.agents.values()) if (!a.orphanedAt || now - a.orphanedAt < ORPHAN_DEAD_MS) out.push(a);
  return out;
}
export function liveCount(s: Sess, now = Date.now()): number {
  let n = 0;  // counted in place, not liveAgents().length: this runs on the paint path for every session
  for (const a of s.agents.values()) {
    if (!a.orphanedAt || now - a.orphanedAt < ORPHAN_DEAD_MS) n++;
  }
  return n;
}
// inherited leftovers still inside their window
export const orphanAgents = (s: Sess, now = Date.now()): Agent[] =>
  liveAgents(s, now).filter((a) => a.orphanedAt);
// A live agent is sufficient on its own (long quiet stretches mid-run are normal), but not past
// FANOUT_DEAD_MS of silence, when the count itself is what's suspect.
export function liveFanout(s: Sess, now = Date.now()): Fanout | null {
  if (!hasSessionState(s) || !s.fanout) return null;
  if (now - s.fanout.lastAt >= FANOUT_DEAD_MS) return null;
  return liveCount(s, now) > 0 || now - s.fanout.lastAt < FANOUT_GRACE_MS ? s.fanout : null;
}
// A permission or a failed turn outranks the fleet, and mid-turn the agent's own `working` is the
// truer reading.
export function bgWaiting(s: Sess, now = Date.now()): boolean {
  return !s.attention && (s.phase === "done" || s.phase === "idle") && !!liveFanout(s, now);
}
// total is max(started, done + running), never started alone: a second workflow restarts the counters
// and 4/2 would be the visible half. One owner, so the sidebar tally and the inspector bar never disagree.
export function fanoutTally(s: Sess, now = Date.now()): { done: number; total: number } | null {
  const f = liveFanout(s, now);
  if (!f) return null;
  const total = Math.max(f.started, f.done + liveCount(s, now));
  return total > 1 || bgWaiting(s, now) ? { done: Math.min(f.done, total), total } : null;
}
export function fanoutText(s: Sess, now = Date.now()): string {
  const n = liveCount(s, now);
  if (n) return `${n} agent${n === 1 ? "" : "s"} working`;
  return s.fanout?.name ? "workflow running" : "background work";
}

// glyph/CSS bucket: a permission outranks its phase, a live fan-out the done it left
export const statusKey = (s: Sess, now = Date.now()) =>
  s.attention ? "attention" : bgWaiting(s, now) ? "background" : s.phase;
// What a shelve would interrupt: midFlight plus a done turn whose fan-out runs on; both shelve paths read it.
export const midWork = (s: Sess, now = Date.now()) => midFlight(s) || statusKey(s, now) === "background";
export const PILL_TEXT: Record<Phase, string> = { idle: "idle", thinking: "thinking…", working: "working…", done: "your turn", error: "error", ended: "ended" };
// StopFailure's error enum in the cockpit's words; an unlisted value falls back to itself de-underscored
export const API_ERR_TEXT: Record<string, string> = {
  overloaded: "API overloaded", rate_limit: "rate limited", server_error: "API server error",
  authentication_failed: "auth failed", oauth_org_not_allowed: "org not allowed",
  billing_error: "billing problem", invalid_request: "invalid request",
  model_not_found: "model not found", max_output_tokens: "output limit reached",
  unknown: "API error",
};
export const apiErrText = (e: ApiErr) => API_ERR_TEXT[e.kind] ?? (e.kind.replace(/_/g, " ") || "API error");
// Every surface labels a state through this, never PILL_TEXT directly: "API overloaded" also says
// it wasn't your fault.
export const phaseText = (s: Sess, now = Date.now()) =>
  s.phase === "error" && s.apiErr ? apiErrText(s.apiErr)
    : bgWaiting(s, now) ? fanoutText(s, now)
      : PILL_TEXT[s.phase];

// The one source for a run's duration, frozen at exit; a surface doing its own Date.now() -
// startedAt counts on after the exit.
export function runElapsed(r: NonNullable<Sess["run"]>, now = Date.now()): string {
  // ?? now: an exit that predates endedAt (older build)
  return fmtShort((r.exitCode == null ? now : r.endedAt ?? now) - r.startedAt);
}

export function taskStateText(s: Sess, now = Date.now()): string {
  const r = s.run;
  if (!r) return "";
  if (r.background && r.exitCode == null) return "bg";
  if (r.exitCode == null) return s.phase === "working" ? runElapsed(r, now) : "";
  return r.exitCode === 0 ? runElapsed(r, now) : `exit ${r.exitCode}`;
}

export interface Exec { mode: "argv"; program: string; args: string[] }
export interface ExecShell { mode: "shell"; line: string }
export interface InputSpec {
  // a VS Code ${input:…} declaration, or a just parameter with no default
  id: string; kind: "promptString" | "pickString"; description: string;
  default: string | null; options: string[]; password: boolean;
  // runs fine left empty (a just *name param); plain Run skips the dialog, Run with parameters… offers it
  optional: boolean;
}
export interface Runnable {
  id: string; label: string; detail: string | null;
  source: string; sourceFile: string; group: string | null;
  exec: Exec | ExecShell; cwd: string; env: Record<string, string>;
  background: boolean; inputs: InputSpec[];
  // labels, not ids: VS Code names dependencies by label
  dependsOn: string[]; dependsOrder: "parallel" | "sequence";
  blocked: string | null;
  // no command of its own: dependsOn IS the work (a VS Code compound task); launchWithDeps runs the deps
  compound: boolean;
  // "build" | "test" when this is the group's default task, what ⌘⇧B / ⌘⇧T resolve to
  defaultFor: string | null;
}

export interface Sess {
  id: string; project: string; accent: string; workdir: string; colorKey: string;
  // the provider's own conversation id, not the pane id; Claude rotates it on /clear, /compact and /resume
  resumeId: string;
  branch: string; worktree: string | null; title: string;
  // The OSC title as the terminal sent it, before `cleanTitle`. `title` is lossy, so
  // this is what lets the scrub setting re-clean panes already on screen rather than
  // only the next one to speak. Optional: only an agent pane has an OSC to record.
  rawTitle?: string;
  phase: Phase; phaseSince: number; lastActivity: number; attention: string | null; pendingCmd: string; pendingPermId: string | null; pendRisk: Risk | null;
  pendingPermissions: PendingPermission[];
  // entered the needs-you set, 0 when not in it; stamped only by syncAttn (./grouping), never from phaseSince
  attnAt: number;
  seenAt: number; // last put on stage; compared against attnAt and nothing else (./attn)
  agents: Map<string, Agent>; // by agent_id; read through liveAgents/liveCount, never .size
  fanout: Fanout | null; // from the first SubagentStart (or the Workflow call) until the next turn clears it
  // A prompt typed mid-tool-call, queued behind a turn whose Stop has not landed. A flag, not a count:
  // exactly one Stop consumes it. Set only from working: thinking is also where a second idle prompt lands.
  queuedPrompt: boolean;
  // set by StopFailure, cleared on the next turn; keeps the idle nudge from relabelling a dead turn
  // (endTurn in ./phase)
  apiErr: ApiErr | null;
  // Cleared only by endTurn's success branch, never by newTurn: a continue Episko typed is a new
  // turn, and clearing there would flatten the backoff ladder into a hammer (./revive).
  revive: ReviveState | null;
  // another checkout of this repo (Drift.via, ./gitwatch); display-only, workdir is unchanged until followed
  drift: Drift | null;
  model: string; ctxPct: number | null; ctxTokens: number | null; cost: number | null; durMs: number | null;
  tokenUsage: AgentTokenUsage | null;
  rateLimits: AgentRateLimit[];
  rateLimitScope: string | null; // opaque; account-wide quota is shared only between equal non-null scopes
  curTool: string; curArg: string; todos: Todo[];
  ctxHist: number[]; costHist: number[]; git: DiffStat | null;
  lastEvent: string; activity: Act[];
  // from PostToolUse, display-only, empty after a restart (./files)
  files: FileTouch[]; tally: Record<string, number>;
  servers: BgServer[]; // background shells still up, from PostToolUse; display-only like files
  kind: SessKind; external: boolean; term?: Terminal; fit?: FitAddon; gl?: WebglAddon; pane: HTMLElement;
  // Only while a reload orphan's pane is rebuilt (#47): output queues here until the scrollback snapshot
  // is written, and a chunk at or below its seq is dropped on flush (adoptSession in ./panes).
  adopt?: { pending: { seq: number; bytes: Uint8Array }[] } | null;
  provider: string | null; // AgentCli.id for an agent pane, null for shells/tasks
  // copied at launch so the session stays self-describing if the catalogue changes
  capabilities: AgentCapability[];
  run?: { // task panes only
    id: string; label: string; source: string; sourceFile: string; cmd: string; background: boolean;
    startedAt: number; exitCode: number | null; tail: string[];
    // latched as output streams, never rescanned from the rolling tail (taskServerUrl in ./servers)
    url?: string;
    endedAt?: number; // freezes the duration at exit
    root: string; // where discovery ran; sourceFile is rooted here
    forSession?: string; // the session a run-on-stop rule was verifying; a failure goes back to it
    groupId?: string; // one dependsOn chain, minted per launch so two runs compare; absent on a lone task
    groupLabel?: string; // the root task's label; not derivable once all are panes
  };
}

// Claude Code sessions started outside Episko, from ~/.claude/sessions/<pid>.json; read-only rows.
export interface ExtSession {
  pid: number; session_id: string; cwd: string; name: string;
  status: string; status_updated_at?: number | null; started_at?: number | null; version: string;
  // repo_root is the main worktree, so all worktrees of one repo group under it
  repo_root?: string | null; branch?: string | null;
}

// ---------- restorable sessions: on screen at quit; the provider is stored so a preference change
// cannot reopen one in the wrong CLI ----------
// One embedded PTY as the backend holds it; matters only after a webview reload, when all are orphans (#47).
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
