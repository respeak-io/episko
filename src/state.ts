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
import type { DiffStat, Engine, ExtSession, Restorable, Sess, WtHead } from "./types";

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
  manual:    { glyph: "≡", label: "Manual order — drag to arrange" },
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
export let mirror: { kind: "ext"; id: string; pid: number } | { kind: "past"; id: string } | null = null;
export function setMirror(m: typeof mirror) { mirror = m; }
export const extMirrorId = (): string | null => (mirror?.kind === "ext" ? mirror.id : null);
export const extMirrorPid = (): number | null => (mirror?.kind === "ext" ? mirror.pid : null);
export const pastMirrorId = (): string | null => (mirror?.kind === "past" ? mirror.id : null);
// Claude Code sessions started OUTSIDE Episko (a plain terminal, an IDE). We
// discover them from ~/.claude/sessions/<pid>.json (via the backend), show them
// in the sidebar as read-only, and can jump to their terminal window.
export let externals: ExtSession[] = [];
export function setExternals(l: ExtSession[]) { externals = l; }
// Restorable-from-last-run rows: what the roster says was open at the last quit.
export let dormants: Restorable[] = [];
export function setDormants(l: Restorable[]) { dormants = l; }
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
