// The app's mutable state: the session map, the stage pointer, every persisted preference.
// Reads are the live ESM binding (`activeId`, never `state.activeId`); a `setX` assigns and
// nothing else. Preferences are read at module scope, so a test imports ./localstorage first.
import { basename, hslToHex } from "./format";
import { safeParse } from "./store";
import { clampAttnPrefs, type AttnPrefs } from "./attn";
import type { DiffMode } from "./diff";
import { clampKeyPrefs, serializeKeyPrefs, type KeyPrefs } from "./keys";
import { clampPeekPrefs, type PeekPrefs } from "./peek";
import { clampRevivePrefs, type RevivePrefs } from "./revive";
import { clampGroups, type GroupStore } from "./projgroups";
import { clampSoundPrefs, type SoundPrefs } from "./sound";
import { clampScrollback, clampVitalsPrefs, type VitalsPrefs } from "./perf";
import { agentInstalled, CLAUDE_CLI, pickAgent } from "./types";
import type { AgentCli, DiffStat, Engine, ExtSession, Res, Restorable, Sess, WtHead } from "./types";
import { parseFootPrefs, type FootPrefs } from "./footprefs";
import type { GhAccount } from "./ghwork";
import { parseMotionPrefs, type MotionPrefs } from "./motion";

export interface Favorite { name: string; path: string }
const DEFAULT_FAVORITES: Favorite[] = [];
// Names are re-derived from the path: older installs stored the full backslash path as the name.
export let FAVORITES: Favorite[] = favList(localStorage.getItem("cc-favorites"))
  .map((f: Favorite) => ({ ...f, name: basename(f.path) }));
export function setFavorites(f: Favorite[]) { FAVORITES = f; }
export function saveFavorites() { localStorage.setItem("cc-favorites", JSON.stringify(FAVORITES)); }
export let projOrder: string[] = strList(localStorage.getItem("cc-proj-order"));
export function setProjOrder(o: string[]) { projOrder = o; }
export function saveProjOrder() { localStorage.setItem("cc-proj-order", JSON.stringify(projOrder)); }
// Membership only, never an ordering: `projOrder` stays the one answer to sidebar order.
export let projGroups: GroupStore = clampGroups(safeParse(localStorage.getItem("cc-proj-groups")));
export function setProjGroups(g: GroupStore) { projGroups = clampGroups(g); }
export function saveProjGroups() { localStorage.setItem("cc-proj-groups", JSON.stringify(projGroups)); }
export type SortMode = "manual" | "active" | "attention";
export const SORT_MODES: SortMode[] = ["manual", "active", "attention"];
export let sortMode: SortMode = (localStorage.getItem("cc-sort") as SortMode) || "manual";
if (!SORT_MODES.includes(sortMode)) sortMode = "manual";
export function setSortMode(m: SortMode) { sortMode = m; }
export const SORT_META: Record<SortMode, { glyph: string; label: string }> = {
  manual:    { glyph: "≡", label: "Manual order · drag to arrange" },
  active:    { glyph: "◷", label: "Latest activity first" },
  attention: { glyph: "◆", label: "Needs you first" },
};
// --- sidebar worktree grouping -------------------------------------------------
// Only toplevel also splits projectList(); a project with one checkout always renders flat.
export type WtGroup = "off" | "subheader" | "toplevel" | "chip";
const WT_GROUPS: WtGroup[] = ["off", "subheader", "toplevel", "chip"];
export let wtGroup: WtGroup = (localStorage.getItem("cc-worktree-group") as WtGroup) || "subheader";
if (!WT_GROUPS.includes(wtGroup)) wtGroup = "subheader";
export function setWtGroup(m: WtGroup) { wtGroup = WT_GROUPS.includes(m) ? m : "subheader"; }

// --- the trunk each project is measured against -----------------------------------
// Per-repo trunk override; display only, never committed, and `git_branch_list` re-validates it.
export let cmpBase: Record<string, string> = (safeParse<Record<string, string>>(localStorage.getItem("cc-cmp-base")) ?? {}) as Record<string, string>;
export function setCmpBase(repoDir: string, ref: string) {
  const next = { ...cmpBase };
  if (ref) next[repoDir] = ref; else delete next[repoDir];
  cmpBase = next;
}

// --- sidebar peek ---------------------------------------------------------------
export let peekPrefs: PeekPrefs = clampPeekPrefs(safeParse(localStorage.getItem("cc-peek")));
export function setPeekPrefs(p: PeekPrefs) { peekPrefs = clampPeekPrefs(p); }

// --- the "needs you" set -----------------------------------------------------------
export let attnPrefs: AttnPrefs = clampAttnPrefs(safeParse(localStorage.getItem("cc-attn")));
export function setAttnPrefs(p: AttnPrefs) { attnPrefs = clampAttnPrefs(p); }

// --- sound alerts ---------------------------------------------------------------
export let soundPrefs: SoundPrefs = clampSoundPrefs(safeParse(localStorage.getItem("cc-sound")));
export function setSoundPrefs(p: SoundPrefs) { soundPrefs = clampSoundPrefs(p); }

// --- reviving a session the API killed --------------------------------------------
// Ships off; `clampRevivePrefs` demands an explicit `true`, since this types into a terminal unattended.
export let revivePrefs: RevivePrefs = clampRevivePrefs(safeParse(localStorage.getItem("cc-revive")));
export function setRevivePrefs(p: RevivePrefs) { revivePrefs = clampRevivePrefs(p); }

// --- keyboard shortcuts ----------------------------------------------------------
// Held resolved (the keydown handler reads it per keystroke) but stored as overrides only, so a
// later default reaches old installs. Read a chord through `activeBind`, never `keyPrefs.binds[id]`.
export let keyPrefs: KeyPrefs = clampKeyPrefs(safeParse(localStorage.getItem("cc-keys")));
export function setKeyPrefs(p: KeyPrefs) { keyPrefs = clampKeyPrefs(serializeKeyPrefs(p)); }
// Narrowing reads, declared so they hoist. A bad value is dropped whole: a throw here is a blank window.
function strMap(raw: string | null): Record<string, string> {
  const v = safeParse<Record<string, string>>(raw);
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, m]) => typeof m === "string")) as Record<string, string>;
}
function strList(raw: string | null): string[] {
  const v = safeParse<string[]>(raw);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function favList(raw: string | null): Favorite[] {
  const v = safeParse<Favorite[]>(raw);
  if (!Array.isArray(v)) return DEFAULT_FAVORITES;
  return v.filter((f): f is Favorite => !!f && typeof f === "object" && typeof f.path === "string");
}

export const colorOverrides: Record<string, string> = strMap(localStorage.getItem("cc-colors"));
// Not in format.ts: it reads `colorOverrides`, and format.ts must not depend on state.
export function accentFor(key: string): string {
  if (colorOverrides[key]) return colorOverrides[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 0.68, 0.63);
}

// ---------- model ----------
export const sessions = new Map<string, Sess>();
export let activeId: string | null = null;
export function setActiveId(id: string | null) { activeId = id; }
// The stage shows exactly one thing: `activeId` and `mirror` are mutually exclusive
// (CLAUDE.md). "ext" carries the pid because Claude's session_id rotates on
// /clear, /compact and /resume; `refreshExternals` re-binds through the pid.
export let mirror:
  | { kind: "ext"; id: string; pid: number }
  | { kind: "past"; id: string }
  | { kind: "dash"; root: string; name: string }
  | null = null;
export function setMirror(m: typeof mirror) { mirror = m; }
export const extMirrorId = (): string | null => (mirror?.kind === "ext" ? mirror.id : null);
export const extMirrorPid = (): number | null => (mirror?.kind === "ext" ? mirror.pid : null);
export const pastMirrorId = (): string | null => (mirror?.kind === "past" ? mirror.id : null);
export const dashMirror = () => (mirror?.kind === "dash" ? mirror : null);
// A run group tiled beside the focused pane; `activeId` still names that pane. Exclusive with `mirror`.
export let stageGroup: string | null = null;
export function setStageGroup(g: string | null) { stageGroup = g; }
export const collapsedRuns = new Set<string>(); // not persisted: run ids are per-launch uuids
export let externals: ExtSession[] = [];
export function setExternals(l: ExtSession[]) { externals = l; }
export let dormants: Restorable[] = [];
export function setDormants(l: Restorable[]) { dormants = l; }
// Every PTY the backend holds, keyed `<provider>:<session id>`. After a webview reload the map is
// empty while every PTY runs on (#47), so this is what lets `dormantBusy`/`histBusy` refuse a resume.
export let backendLive: ReadonlySet<string> = new Set();
export function setBackendLive(s: ReadonlySet<string>) { backendLive = s; }
// Backend `telemetry-health`; while down, every Claude pane goes quiet with no error and the rail says idle.
export let telemetryUp = true;
export function setTelemetryUp(v: boolean) { telemetryUp = v; }
// Background-shell log root as the backend resolved it. `moved` still works; it warns that the path changed.
export interface BgLogHealthEvent {
  state: "ok" | "moved" | "blind";
  root: string; rank: number; discovered: boolean; tried: string[];
}
export let bgLogHealth: BgLogHealthEvent | null = null;
export function setBgLogHealth(v: BgLogHealthEvent | null) { bgLogHealth = v; }
export interface EngineDef { id: Engine; label: string; sub: string }
export const ALL_ENGINES: EngineDef[] = [
  { id: "embedded", label: "Embedded", sub: "In-app terminal" },
  { id: "ghostty",  label: "Ghostty",  sub: "External window · tinted" },
  { id: "terminal", label: "Terminal", sub: "macOS Terminal.app" },
  { id: "iterm",    label: "iTerm",    sub: "iTerm2" },
];
export function engineDef(id: Engine): EngineDef { return ALL_ENGINES.find((e) => e.id === id) || ALL_ENGINES[0]; }
export let availEngines: Engine[] = ["embedded"];
export let diffMode: DiffMode = localStorage.getItem("cc-diff-mode") === "split" ? "split" : "unified";
export function setDiffMode(m: DiffMode) { diffMode = m; }
export const TERM_FONT_DEFAULT = 12.5;
export let termFontSize = parseFloat(localStorage.getItem("cc-term-font") || "") || TERM_FONT_DEFAULT;
export function setTermFontSize(v: number) { termFontSize = v; }
export function setAvailEngines(l: Engine[]) { availEngines = l; }
// --- agent providers ------------------------------------------------------------
// Filled once from `list_agents`; rows with a missing binary stay so the picker can say why.
export let availAgents: AgentCli[] = [];
let finishAgentDiscovery: (() => void) | null = null;
/** Launches wait for the startup probe, or a persisted non-Claude choice would fall back to Claude. */
export const agentDiscoveryReady = new Promise<void>((resolve) => { finishAgentDiscovery = resolve; });
export function setAvailAgents(l: AgentCli[]) {
  availAgents = l;
  finishAgentDiscovery?.();
  finishAgentDiscovery = null;
}
export function installedAgents(): AgentCli[] { return availAgents.filter(agentInstalled); }
export function agentDef(id: string): AgentCli | undefined {
  return id === CLAUDE_CLI.id ? CLAUDE_CLI : availAgents.find((a) => a.id === id);
}
export function allAgents(): AgentCli[] { return [CLAUDE_CLI, ...installedAgents()]; }
export function missingAgents(): AgentCli[] { return availAgents.filter((a) => !agentInstalled(a)); }
// --- which agent a new session runs -------------------------------------------
// Resolution order and the uninstalled fallback: `pickAgent` in ./types.
export let defaultAgent: string = localStorage.getItem("cc-agent") || CLAUDE_CLI.id;
export function setDefaultAgent(id: string) { defaultAgent = id; }
// Keyed by `colorKey` so every worktree of a repo inherits it; personal, never committed.
export const agentByProject: Record<string, string> = strMap(localStorage.getItem("cc-agent-by-project"));
export function setProjectAgent(colorKey: string, id: string | null) {
  if (id) agentByProject[colorKey] = id; else delete agentByProject[colorKey];
}
// Read at the launch site, never stored on a `Sess`: a second copy could go stale.
export function effectiveAgent(colorKey: string): AgentCli {
  return pickAgent(colorKey, defaultAgent, agentByProject, availAgents);
}
// --- which GitHub account a project reads as ---------------------------------
// `gh` switches accounts globally, so a two-identity machine needs a per-project pin; never committed.
export const ghAccountByProject: Record<string, string> = strMap(localStorage.getItem("cc-gh-account"));
export function setProjectGhAccount(colorKey: string, login: string | null) {
  if (login) ghAccountByProject[colorKey] = login; else delete ghAccountByProject[colorKey];
}
// Passed to the backend per call; never stored on a `Sess` or pushed there as a second copy.
export const ghAccountFor = (colorKey: string): string | null => ghAccountByProject[colorKey] ?? null;
// Runtime only, never persisted: gh's state, and a stale copy would offer a logged-out account.
export let ghLogins: GhAccount[] = [];
export function setGhLogins(a: GhAccount[]) { ghLogins = a; }
// Ignores project overrides but keeps a launch's fallback, so the row names what would run.
export function defaultAgentDef(): AgentCli { return pickAgent("", defaultAgent, {}, availAgents); }
export let termEngine: Engine = (localStorage.getItem("cc-term-engine") as Engine) || "embedded";
export function setTermEngine(e: Engine) { termEngine = e; }
// --- how each provider starts -------------------------------------------------
// Keyed by provider; definitions and validation are ./providers'. The old Claude-only key migrates one way.
function loadPermissionModes(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem("cc-perm-modes") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, mode]) => typeof mode === "string")) as Record<string, string>;
  } catch { return {}; }
}
const storedPermissionModes = loadPermissionModes();
const legacyPermMode = localStorage.getItem("cc-perm-mode") || "default";
if (!storedPermissionModes[CLAUDE_CLI.id]) storedPermissionModes[CLAUDE_CLI.id] = legacyPermMode;
export const permissionModes = storedPermissionModes;
export function permissionModeFor(provider: string): string {
  return permissionModes[provider] || "default";
}
export function setProviderPermissionMode(provider: string, mode: string) {
  permissionModes[provider] = mode;
}
// By folder, not session: the sidebar dot reads it too, and `Sess.git` is only fresh on stage.
export const dirtyByFolder = new Map<string, DiffStat | null>();
export const isDirty = (g?: DiffStat | null): boolean => !!g && (g.files > 0 || g.untracked > 0);
export const folderDirty = (f: string): boolean => isDirty(dirtyByFolder.get(f));
export const dirtyStale = new Set<string>(); // filled by markWorkdirStale, drained by refreshDirtyStates
// An allowlist of readers, so a tool added to Claude Code later defaults to a cheap re-read.
const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "ExitPlanMode", "BashOutput", "AskUserQuestion"]);
export function markWorkdirStale(s: Sess, tool: string) {
  if (!s.workdir || READONLY_TOOLS.has(tool)) return;
  dirtyStale.add(s.workdir);
}

// Every checkout of a repo, session or not; filled by `refreshWorktrees` from `worktree_heads`.
export const worktreesByRepo = new Map<string, WtHead[]>();
export const wtSig = (l: WtHead[]) => l.map((w) => `${w.path} ${w.branch} ${w.exists ? 1 : 0}`).join("");

// App-wide, not per session, shown on every session like `rl.ts`'s limits (docs/architecture.md).
export const ioAll: Res = { readBps: 0, writeBps: 0, readMb: 0, writtenMb: 0, primed: false };

export let footPrefs: FootPrefs = parseFootPrefs(localStorage.getItem("cc-foot"));
export function setFootPrefs(p: FootPrefs) { footPrefs = p; }

export let motionPrefs: MotionPrefs = parseMotionPrefs(localStorage.getItem("cc-motion"));
export function setMotionPrefs(p: MotionPrefs) { motionPrefs = p; }

// Not `document.hasFocus()`: the webview and the OS window disagree during a drag.
export let winFocused = true;
export function setWinFocused(v: boolean) { winFocused = v; }

export let vitalsPrefs: VitalsPrefs = clampVitalsPrefs(safeParse(localStorage.getItem("cc-vitals")));
export function setVitalsPrefs(p: VitalsPrefs) { vitalsPrefs = clampVitalsPrefs(p); }

export let termScrollback: number = clampScrollback(localStorage.getItem("cc-scrollback"));
export function setTermScrollback(n: number) { termScrollback = clampScrollback(n); }
