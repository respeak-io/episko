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
import { basename } from "./format";
import type { Sess } from "./types";

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
export const WT_GROUPS: WtGroup[] = ["off", "subheader", "toplevel", "chip"];
export let wtGroup: WtGroup = (localStorage.getItem("cc-worktree-group") as WtGroup) || "subheader";
if (!WT_GROUPS.includes(wtGroup)) wtGroup = "subheader";
export function setWtGroup(m: WtGroup) { wtGroup = WT_GROUPS.includes(m) ? m : "subheader"; }

// ---------- model ----------
// The shapes themselves live in ./types; this is the state that hangs off them.
export const sessions = new Map<string, Sess>();
export let activeId: string | null = null;
export function setActiveId(id: string | null) { activeId = id; }
