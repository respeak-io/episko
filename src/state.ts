// The app's mutable state: the session map, what's on stage, and the persisted
// sidebar preferences. Extracted from main.ts so the logic modules that read this
// state (grouping.ts next) have something to import that isn't the render layer —
// PLAN's ground rule 3, "mutable module state gathers in one state.ts rather than
// scattering".
//
// **Convention: reads are the live binding, writes go through a setter.** ESM
// bindings are read-only for importers, so a `let` that main.ts reassigns needs a
// `setX`; a `const` container (`sessions`) needs nothing. Reads therefore stay bare
// identifiers everywhere — `activeId`, not `state.activeId` — which is what keeps
// this extraction a relocation rather than a rewrite of 183 call sites, and leaves
// the ~7 writes greppable by setter name. This settles the open question PLAN.md
// left on this slice; the alternative (one exported mutable object) was the other
// half of `setUsageRange`/`setTokenDays` vs the `rl` object, and this module follows
// the setter half. Do not mix the two here.
//
// A setter assigns and nothing else: persistence and re-rendering stay at the call
// site that already did them, so no behaviour moves with the state.
//
// Note for tests: the preferences below are read from localStorage at *module
// scope*, so `import { store } from "./localstorage"` must sit on the line above
// this module's import (see test/localstorage.ts).
import { basename, hslToHex } from "./format";
import { clampAttnPrefs, type AttnPrefs } from "./attn";
import { clampKeyPrefs, serializeKeyPrefs, type KeyPrefs } from "./keys";
import { clampPeekPrefs, type PeekPrefs } from "./peek";
import { clampGroups, type GroupStore } from "./projgroups";
import { clampSoundPrefs, type SoundPrefs } from "./sound";
import type { DiffStat, Engine, ExtSession, PermMode, Res, Restorable, Sess, WtHead } from "./types";

export interface Favorite { name: string; path: string }
const DEFAULT_FAVORITES: Favorite[] = [];
// Re-derive each display name from its path on load: it's always the basename, and
// this self-heals favorites persisted before the Windows-path fix (whose stored name
// was the full backslash path).
export let FAVORITES: Favorite[] = (JSON.parse(localStorage.getItem("cc-favorites") || "null") || DEFAULT_FAVORITES)
  .map((f: Favorite) => ({ ...f, name: basename(f.path) }));
export function setFavorites(f: Favorite[]) { FAVORITES = f; }
export function saveFavorites() { localStorage.setItem("cc-favorites", JSON.stringify(FAVORITES)); }
// User-defined sidebar order (project path keys), set by drag-drop. Projects not
// listed here keep their natural order after the listed ones.
export let projOrder: string[] = JSON.parse(localStorage.getItem("cc-proj-order") || "null") || [];
export function setProjOrder(o: string[]) { projOrder = o; }
export function saveProjOrder() { localStorage.setItem("cc-proj-order", JSON.stringify(projOrder)); }
// The user's named, collapsible groups of projects, and which project is in which.
// One JSON blob under cc-proj-groups rather than a key each, for the same reason
// cc-peek is one: the two halves are only ever read together, and a membership that
// outlived its group is the one corruption a user could not diagnose. The rules and
// the validator are ./projgroups, which is pure — this only holds the value.
//
// Deliberately NOT an ordering: where a group sits is derived from its members under
// the active sort (./grouping's `groupedProjects`), so `projOrder` above stays the one
// answer to "what order is the sidebar in".
export let projGroups: GroupStore = clampGroups(safeParse(localStorage.getItem("cc-proj-groups")));
export function setProjGroups(g: GroupStore) { projGroups = clampGroups(g); }
export function saveProjGroups() { localStorage.setItem("cc-proj-groups", JSON.stringify(projGroups)); }
// Sidebar sort: "manual" honours the drag order above; "active" floats the most
// recently-active sessions/projects to the top; "attention" floats the ones that
// need you first (permission > error > your-turn), longest-waiting within a tier.
export type SortMode = "manual" | "active" | "attention";
export const SORT_MODES: SortMode[] = ["manual", "active", "attention"];
export let sortMode: SortMode = (localStorage.getItem("cc-sort") as SortMode) || "manual";
if (!SORT_MODES.includes(sortMode)) sortMode = "manual";
export function setSortMode(m: SortMode) { sortMode = m; }
// Each sort mode's rail glyph and one-line description — shared by the rail button
// and the settings segment, so the two can never drift apart.
export const SORT_META: Record<SortMode, { glyph: string; label: string }> = {
  manual:    { glyph: "≡", label: "Manual order · drag to arrange" },
  active:    { glyph: "◷", label: "Latest activity first" },
  attention: { glyph: "◆", label: "Needs you first" },
};
// --- sidebar worktree grouping -------------------------------------------------
// Sessions of a repo already collapse into one project group (colorKey = repo root);
// this decides how the worktrees WITHIN that group are shown. The distinguishing key
// per worktree is s.workdir (the actual checkout dir); s.worktree holds its branch.
//   off       — flat rows, branch only as a fallback label (legacy behaviour)
//   subheader — a ⑃-branch header per worktree cluster, sessions nested under it
//   toplevel  — each worktree becomes its own top-level group ("repo · branch")
//   chip      — flat rows, each worktree row carries a colour-coded ⑃ chip
// off/subheader/chip differ purely in the render layer; toplevel also splits
// projectList() so close-navigation and the mini-rail stay coherent. A project with a
// single checkout always renders flat, whatever the mode. Persisted under
// cc-worktree-group; no in-app control yet — the settings window (separate branch)
// will own the picker, until then flip it via setWtGroup() / localStorage.
export type WtGroup = "off" | "subheader" | "toplevel" | "chip";
const WT_GROUPS: WtGroup[] = ["off", "subheader", "toplevel", "chip"];
export let wtGroup: WtGroup = (localStorage.getItem("cc-worktree-group") as WtGroup) || "subheader";
if (!WT_GROUPS.includes(wtGroup)) wtGroup = "subheader";
export function setWtGroup(m: WtGroup) { wtGroup = WT_GROUPS.includes(m) ? m : "subheader"; }

// --- the trunk each project is measured against -----------------------------------
// Which branch "merged" and a remote branch's ahead/behind are compared to, per repo.
// Default (an absent entry) is the primary remote's own default branch, which is what
// git already knows; this is the override for the repos where that answer is wrong —
// a `develop` trunk, a release branch, a fork whose origin/HEAD points somewhere stale.
//
// Keyed by repo root and local, not committed: it changes what the branch picker SHOWS,
// never what any command does to a branch. `git_branch_list` re-validates the ref and
// falls back to the real default if it has gone, so a stale entry here cannot mislead.
export let cmpBase: Record<string, string> = (safeParse<Record<string, string>>(localStorage.getItem("cc-cmp-base")) ?? {}) as Record<string, string>;
export function setCmpBase(repoDir: string, ref: string) {
  const next = { ...cmpBase };
  if (ref) next[repoDir] = ref; else delete next[repoDir];
  cmpBase = next;
}

// --- sidebar peek ---------------------------------------------------------------
// Whether resting on a project reveals the checkouts nothing is running in, and for
// how long. The rules (and the clamping below) live in ./peek, which is pure and
// tested; this only holds the value. Persisted under cc-peek as one JSON blob rather
// than three keys, because the three are only ever read together.
export let peekPrefs: PeekPrefs = clampPeekPrefs(safeParse(localStorage.getItem("cc-peek")));
export function setPeekPrefs(p: PeekPrefs) { peekPrefs = clampPeekPrefs(p); }

// --- the "needs you" set -----------------------------------------------------------
// Whether a session lights up when it starts wanting you, for how long, which end of
// the queue the reactor badge lists from, and whether opening a pane takes it out of
// that queue. One JSON blob under cc-attn for the same reason as cc-peek below it: the
// four are only ever read together. The rules (and the clamping) live in ./attn, which
// is pure and tested; this only holds the value.
export let attnPrefs: AttnPrefs = clampAttnPrefs(safeParse(localStorage.getItem("cc-attn")));
export function setAttnPrefs(p: AttnPrefs) { attnPrefs = clampAttnPrefs(p); }

// --- sound alerts ---------------------------------------------------------------
// Whether Episko makes a noise when something wants you, and which noise. One JSON
// blob under cc-sound for the third time and the same reason as cc-peek above: the
// master switch, the volume and the ten per-event rows are only ever read together,
// and a per-event key that outlived its event is a corruption nobody could diagnose.
// The rules, the catalogue and the clamping are ./sound, which is pure and tested;
// this only holds the value.
export let soundPrefs: SoundPrefs = clampSoundPrefs(safeParse(localStorage.getItem("cc-sound")));
export function setSoundPrefs(p: SoundPrefs) { soundPrefs = clampSoundPrefs(p); }

// --- keyboard shortcuts ----------------------------------------------------------
// The master switch and what each bindable action is bound to *now* — the full
// resolved map, not the overrides: the global keydown handler runs against this on
// every keystroke in the app, so it must not be re-derived per press. One JSON blob
// under cc-keys for the same reason as cc-peek and cc-sound (the switch and the
// chords are only ever read together), and the chords stored as overrides only, so a
// default improved in a later release reaches every install that hadn't changed that
// particular row. The table, the parsing, the collision rules and what "off" means
// are ./keys, which is pure and tested; this only holds the value.
//
// **Read a chord through `activeBind`, never `keyPrefs.binds[id]`** — that is the one
// place the master switch is applied, and a display site that skips it would go on
// advertising a chord the app has stopped answering.
export let keyPrefs: KeyPrefs = clampKeyPrefs(safeParse(localStorage.getItem("cc-keys")));
export function setKeyPrefs(p: KeyPrefs) { keyPrefs = clampKeyPrefs(serializeKeyPrefs(p)); }
// Shared by every preference stored as a JSON blob (peek above, the project groups
// higher up). A corrupt or hand-edited value must not take the app down during module
// import, the same stance ./tasks and ./notes take with their own stores — and the
// clamp each caller runs on the result is what turns "parsed" into "usable".
function safeParse<T>(raw: string | null): Partial<T> | null {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// A hand-picked accent per project path, overriding the hash below. A `const` map
// mutated in place (like `sessions`), so it needs no setter; the colour picker in
// main.ts still owns writing it back to localStorage.
export const colorOverrides: Record<string, string> = JSON.parse(localStorage.getItem("cc-colors") || "{}");
// The project accent. Here rather than in format.ts because it reads the override
// map above, and format.ts must not depend on state (this module already imports
// it). Same hash seeds branch colours, so the sidebar's colour language is one.
export function accentFor(key: string): string {
  if (colorOverrides[key]) return colorOverrides[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return hslToHex(h % 360, 0.68, 0.63);
}

// ---------- model ----------
// The shapes themselves live in ./types; this is the state that hangs off them.
export const sessions = new Map<string, Sess>();
export let activeId: string | null = null;
export function setActiveId(id: string | null) { activeId = id; }
// The stage shows exactly ONE thing: a live Episko session (activeId), a live
// external session mirrored read-only, or a dormant session restorable from a past
// run. Holding the two read-only kinds in a single discriminated pointer — rather
// than a flag per kind — is what stops them fighting over the stage on the next
// render tick (see the note in renderAll).
//
// The "ext" kind also carries the session's `pid`, because its `id` is Claude's
// runtime session_id and that ROTATES on /clear, /compact and /resume. The pid is
// what stays stable, so refreshExternals re-binds through it instead of dropping
// the selection (which used to silently jump the sidebar to an unrelated session).
// Same rule as Sess.resumeId and the telemetry path: hold the stable handle.
export let mirror:
  | { kind: "ext"; id: string; pid: number }
  | { kind: "past"; id: string }
  // The project dashboard. Not a session at all, but it owns the stage exactly the way
  // the read-only mirrors do — so it joins this discriminated pointer rather than
  // becoming a second flag every `activeId` check would have to be paired with.
  | { kind: "dash"; root: string; name: string }
  | null = null;
export function setMirror(m: typeof mirror) { mirror = m; }
export const extMirrorId = (): string | null => (mirror?.kind === "ext" ? mirror.id : null);
export const extMirrorPid = (): number | null => (mirror?.kind === "ext" ? mirror.pid : null);
export const pastMirrorId = (): string | null => (mirror?.kind === "past" ? mirror.id : null);
export const dashMirror = () => (mirror?.kind === "dash" ? mirror : null);
// A run group tiled across the stage (its `run.groupId`), from clicking the group's
// sidebar header. NOT a fourth owner of the stage: `activeId` still names the one
// *focused* pane — it is what the header, inspector, footer and keystrokes read — and
// this only says "also show that pane's group siblings beside it". So the invariant
// above is unchanged, and every existing activeId consumer keeps working untouched.
// Mutually exclusive with `mirror` for the obvious reason: a mirror has no group.
export let stageGroup: string | null = null;
export function setStageGroup(g: string | null) { stageGroup = g; }
// Run groups the user has collapsed. Deliberately NOT persisted: the ids are
// per-launch uuids, so a saved entry could never match anything on a later run.
export const collapsedRuns = new Set<string>();
// Claude Code sessions started OUTSIDE Episko (a plain terminal, an IDE). We
// discover them from ~/.claude/sessions/<pid>.json (via the backend), show them
// in the sidebar as read-only, and can jump to their terminal window.
export let externals: ExtSession[] = [];
export function setExternals(l: ExtSession[]) { externals = l; }
// Restorable-from-last-run rows: what the roster says was open at the last quit.
export let dormants: Restorable[] = [];
export function setDormants(l: Restorable[]) { dormants = l; }
// Launch ids of every PTY the BACKEND holds (`live_sessions`, refreshed on the
// externals poll, lowercased at the call site). In normal operation this repeats
// the `sessions` map; the one state where they disagree is a webview reload, which
// empties the map while every PTY runs on (#47). Those orphans are invisible as
// externals too — `list_external_sessions` excludes owned pids — so this set is
// the only thing that lets `dormantBusy`/`histBusy` refuse to resume one.
export let backendLive: ReadonlySet<string> = new Set();
export function setBackendLive(s: ReadonlySet<string>) { backendLive = s; }
// Which terminal a new launch opens in. A persisted preference like the sort and
// grouping above; the table of what's installed and how to label it stays in the UI.
export interface EngineDef { id: Engine; label: string; sub: string }
export const ALL_ENGINES: EngineDef[] = [
  { id: "embedded", label: "Embedded", sub: "In-app terminal" },
  { id: "ghostty",  label: "Ghostty",  sub: "External window · tinted" },
  { id: "terminal", label: "Terminal", sub: "macOS Terminal.app" },
  { id: "iterm",    label: "iTerm",    sub: "iTerm2" },
];
export function engineDef(id: Engine): EngineDef { return ALL_ENGINES.find((e) => e.id === id) || ALL_ENGINES[0]; }
// Embedded is always available; installed external terminals are filled in from
// the backend on startup (see `available_terminals`).
export let availEngines: Engine[] = ["embedded"];
// xterm cell size, in px. Persisted under cc-term-font; applyFontSize in main.ts
// pushes it to every open terminal, because only that layer holds the xterm handles.
export let termFontSize = parseFloat(localStorage.getItem("cc-term-font") || "") || 12.5;
export function setTermFontSize(v: number) { termFontSize = v; }
export function setAvailEngines(l: Engine[]) { availEngines = l; }
export let termEngine: Engine = (localStorage.getItem("cc-term-engine") as Engine) || "embedded";
export function setTermEngine(e: Engine) { termEngine = e; }
// --- how a new session starts (claude --permission-mode) -----------------------
// A persisted preference like the engine above, and the same split: the type is in
// ./types (it crosses to the backend), the label table stays in the UI layer.
// Labels follow Claude Code's own names for these modes, so the picker and the
// indicator the REPL shows after ⇧⇥ can't read as two different things.
//
// Ordered by how much the mode hands over: Manual asks about everything, Bypass
// about nothing. The last three stop Claude asking, and therefore stop Episko's
// permission cards too — the hint in Settings › Sessions says so, since a pane that
// never raises one looks identical to a pane nobody has asked anything.
export interface PermModeDef { id: PermMode; label: string; sub: string; glyph: string }
export const ALL_PERM_MODES: PermModeDef[] = [
  { id: "default",           label: "Manual",       sub: "Asks before anything risky · Episko's permission cards", glyph: "◇" },
  { id: "plan",              label: "Plan",         sub: "Reads and plans; runs nothing until you accept",         glyph: "⊙" },
  { id: "acceptEdits",       label: "Accept edits", sub: "File edits go through; commands still ask",              glyph: "✎" },
  { id: "auto",              label: "Auto",         sub: "A model classifier answers the prompts for you",         glyph: "◈" },
  { id: "dontAsk",           label: "Don't ask",    sub: "Never prompts · anything not pre-approved is denied",    glyph: "⊘" },
  { id: "bypassPermissions", label: "Bypass",       sub: "No permission checks at all. Claude confirms once",      glyph: "⚠" },
];
export function permModeDef(id: PermMode): PermModeDef { return ALL_PERM_MODES.find((m) => m.id === id) || ALL_PERM_MODES[0]; }
export let permMode: PermMode = (localStorage.getItem("cc-perm-mode") as PermMode) || "default";
if (!ALL_PERM_MODES.some((m) => m.id === permMode)) permMode = "default";
export function setPermMode(m: PermMode) { permMode = m; }
// Uncommitted-changes cache, keyed by folder rather than session, because it feeds
// the sidebar's per-project dot and the external inspector's diff card as well as
// the active session: `Sess.git` only stays fresh for the session on stage, so
// nothing else can rely on it across every project.
export const dirtyByFolder = new Map<string, DiffStat | null>();
export const isDirty = (g?: DiffStat | null): boolean => !!g && (g.files > 0 || g.untracked > 0);
export const folderDirty = (f: string): boolean => isDirty(dirtyByFolder.get(f));
// Folders whose working tree an agent has just touched, so the dirty poll knows which
// are worth re-reading instead of sweeping every open checkout on a timer. Drained by
// `refreshDirtyStates`; filled by `markWorkdirStale` off the hook stream.
export const dirtyStale = new Set<string>();
// Tools that cannot change a working tree. An allowlist of *readers* rather than a
// list of writers, deliberately: a tool added to Claude Code later should default to
// "re-read the folder" and be wrong-but-cheap, not silently miss its writes.
const READONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "ExitPlanMode", "BashOutput", "AskUserQuestion"]);
export function markWorkdirStale(s: Sess, tool: string) {
  if (!s.workdir || READONLY_TOOLS.has(tool)) return;
  dirtyStale.add(s.workdir);
}

// The worktree roster: every checkout of a repo, whether or not a session lives in
// one. Keyed by the repo root the sidebar already groups by (`Sess.colorKey`), and
// filled by `refreshWorktrees` from the spawn-free `worktree_heads` command.
//
// Without this the sidebar can only show worktrees it has a session in, because
// clusters are derived from sessions — so an agent running `git worktree add` produced
// no visible change at all until you launched something into the new checkout.
export const worktreesByRepo = new Map<string, WtHead[]>();
// Cheap change stamp, compared per repo so a poll that finds nothing new costs a few
// file reads and zero renders. That is what lets the roster ride the same tick as the
// branch poll without adding a cost anyone can feel.
export const wtSig = (l: WtHead[]) => l.map((w) => `${w.path} ${w.branch} ${w.exists ? 1 : 0}`).join("");

// App-wide disk I/O, summed across every embedded claude session Episko owns — not a
// per-session figure. With several agents running, the question the inspector's I/O
// bars answer is "how hard is Episko working the disk", and a number for whichever
// pane happens to be on screen answers a different one while looking like that one.
// So it is shown identically on every session, exactly as the account-wide rate
// limits in `rl.ts` are, and for the same reason.
//
// Mutated in place by `refreshSessionStats` (a live binding, read as a bare
// identifier); `all_sessions_resources` in pty.rs does the summing and the per-pid
// rate differencing, because that is where the previous readings live.
export const ioAll: Res = { readBps: 0, writeBps: 0, readMb: 0, writtenMb: 0, primed: false };

// Which window the inspector's read/written total covers. `run` is what the figure
// always was — the kernel counters of the claude processes THIS Episko spawned, which
// go back to zero every launch — and it was labelled a bare "total", so it read as a
// lifetime number that happened to be small. `today` is the default because it is the
// question the footer's spend beside it already answers, and `all` is everything the
// `cc-io` rollup has banked since it started keeping one. Cycled by clicking the row.
export type IoScope = "today" | "run" | "all";
export const IO_SCOPES: IoScope[] = ["today", "run", "all"];
export let ioScope: IoScope =
  (IO_SCOPES as string[]).includes(localStorage.getItem("cc-io-scope") || "")
    ? localStorage.getItem("cc-io-scope") as IoScope : "today";
export function setIoScope(s: IoScope) { ioScope = s; }

// Whether the I/O box's explanation panel is open — and, when it is, the `Date.now()` it
// opened at. Deliberately NOT persisted and not a `cc-` key: the figures in that box are
// startling on first sight (a day of agents reads as a gigabyte written) and the panel
// exists to say why once, not to be a preference somebody carries between runs. Reset by
// a restart is the right lifetime for it.
//
// One number rather than a flag beside it, because the two would have to agree: the open
// time IS the open state (0 = closed), so there is no pair to drift. The timestamp is
// what lets the expander survive a repaint — see `resHtml` in ./inspectorview.
export let ioInfoAt = 0;
export function setIoInfoAt(t: number) { ioInfoAt = t; }
