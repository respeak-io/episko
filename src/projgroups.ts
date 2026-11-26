// Project groups: a named, collapsible heading over several projects in the sidebar, and over
// other groups. Its place in the order is a token in `cc-proj-order` (below). Pure over an explicit
// store (./state imports this); a mutator returns a new store, or the same one on a no-op.
import { nfcPath } from "./format";

// `id` is opaque and stable: what `of` and the sidebar's `data-fold` point at. `parent` null is top level.
export interface GroupDef { id: string; name: string; collapsed: boolean; parent: string | null }
// `of`: project path (the `cc-proj-order` key) → group id; no entry means ungrouped.
export interface GroupStore { groups: GroupDef[]; of: Record<string, string> }

export const NO_GROUPS: GroupStore = { groups: [], of: {} };

// A group's place in the manual order is an entry in `cc-proj-order` beside the paths, so the
// rail keeps ONE order (docs/worktrees.md). No absolute path starts with this.
const TOKEN = "group:";
export const groupToken = (gid: string): string => TOKEN + gid;
export const isGroupToken = (entry: string): boolean => entry.startsWith(TOKEN);

const MAX_NAME = 40; // fits the 220px rail
const MAX_GROUPS = 40;
export const MAX_DEPTH = 4; // levels of groups; each one indents a 220px rail

export function cleanGroupName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

// Repairs rather than trusts: unique ids, every parent and membership pointing at a group that
// exists, no cycle, no chain deeper than MAX_DEPTH. A dangling one would hide a project in a
// fold nothing draws; a cycle would hang the walk that draws them.
export function clampGroups(raw: unknown): GroupStore {
  const src = (raw ?? null) as Partial<GroupStore> | null;
  const groups: GroupDef[] = [];
  const ids = new Set<string>();
  for (const g of Array.isArray(src?.groups) ? src.groups : []) {
    if (groups.length >= MAX_GROUPS) break;
    const id = typeof g?.id === "string" ? g.id : "";
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const parent = typeof g?.parent === "string" && g.parent !== id ? g.parent : null;
    groups.push({ id, name: cleanGroupName(g?.name) || "Group", collapsed: g?.collapsed === true, parent });
  }
  for (const g of groups) if (g.parent && !ids.has(g.parent)) g.parent = null;
  // In store order, so the repair is deterministic: the first group found closing a loop, or
  // sitting too deep, is cut loose to the top level.
  for (const g of groups) if (g.parent && (chainOf(groups, g.parent).includes(g.id) || depthIn(groups, g.id) > MAX_DEPTH)) g.parent = null;
  const of: Record<string, string> = {};
  const rawOf = src?.of;
  if (rawOf && typeof rawOf === "object") {
    for (const [path, gid] of Object.entries(rawOf)) {
      if (path && typeof gid === "string" && ids.has(gid)) of[nfcPath(path)] = gid;
    }
  }
  return { groups, of };
}

// `gid` and its ancestors, leaf first; stops at a repeat, so a cycle cannot hang it.
function chainOf(groups: readonly GroupDef[], gid: string): string[] {
  const out: string[] = [];
  for (let g = groups.find((x) => x.id === gid); g && !out.includes(g.id); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) {
    out.push(g.id);
  }
  return out;
}
const depthIn = (groups: readonly GroupDef[], gid: string) => chainOf(groups, gid).length;

// Derived rather than random, so a test can name the group it made and nothing needs Date.now().
export function nextGroupId(st: GroupStore): string {
  const used = new Set(st.groups.map((g) => g.id));
  let n = 1;
  while (used.has("g" + n)) n++;
  return "g" + n;
}

export const groupById = (st: GroupStore, gid: string): GroupDef | null => st.groups.find((g) => g.id === gid) ?? null;
export const groupOf = (st: GroupStore, path: string): string | null => st.of[path] ?? null;
export const groupPaths = (st: GroupStore, gid: string): string[] => Object.keys(st.of).filter((p) => st.of[p] === gid);
export const childGroups = (st: GroupStore, parent: string | null): GroupDef[] => st.groups.filter((g) => g.parent === parent);

/** Root first, `gid` last; empty for an unknown id. */
export const groupAncestry = (groups: readonly GroupDef[], gid: string): GroupDef[] =>
  chainOf(groups, gid).reverse().map((id) => groups.find((g) => g.id === id)!);
/** 1 for a top-level group. */
export const groupDepth = (st: GroupStore, gid: string): number => depthIn(st.groups, gid);
/** "Work › Clients": the name a group goes by anywhere it is not drawn inside its parent. */
export const groupLabel = (groups: readonly GroupDef[], gid: string): string =>
  groupAncestry(groups, gid).map((g) => g.name).join(" › ");

/** `gid` and every group under it. */
export function subtreeIds(st: GroupStore, gid: string): Set<string> {
  const out = new Set<string>([gid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of st.groups) if (g.parent && out.has(g.parent) && !out.has(g.id)) { out.add(g.id); grew = true; }
  }
  return out;
}
// Levels a subtree occupies, itself included: what a move has to fit under its new parent.
function subtreeHeight(st: GroupStore, gid: string): number {
  const kids = childGroups(st, gid);
  return 1 + (kids.length ? Math.max(...kids.map((k) => subtreeHeight(st, k.id))) : 0);
}
/** Every project filed in `gid` or anything under it. */
export function groupPathsDeep(st: GroupStore, gid: string): string[] {
  const ids = subtreeIds(st, gid);
  return Object.keys(st.of).filter((p) => ids.has(st.of[p]));
}

/** Whether `gid` (with what it holds) may go under `parent`: never into itself, never past MAX_DEPTH. */
export function canMoveGroup(st: GroupStore, gid: string, parent: string | null): boolean {
  if (!groupById(st, gid)) return false;
  if (parent === null) return true;
  if (!groupById(st, parent) || subtreeIds(st, gid).has(parent)) return false;
  return groupDepth(st, parent) + subtreeHeight(st, gid) <= MAX_DEPTH;
}
/** Whether a new group fits under `parent`. */
export const canNestUnder = (st: GroupStore, parent: string | null): boolean =>
  parent === null || (!!groupById(st, parent) && groupDepth(st, parent) < MAX_DEPTH);

export function createGroup(st: GroupStore, name: string, paths: string[] = [], parent: string | null = null): GroupStore {
  if (st.groups.length >= MAX_GROUPS || !canNestUnder(st, parent)) return st;
  const id = nextGroupId(st);
  const of = { ...st.of };
  for (const p of paths) if (p) of[p] = id;
  return { groups: [...st.groups, { id, name: cleanGroupName(name) || "Group", collapsed: false, parent }], of };
}

export function moveGroup(st: GroupStore, gid: string, parent: string | null): GroupStore {
  const g = groupById(st, gid);
  if (!g || g.parent === parent || !canMoveGroup(st, gid, parent)) return st;
  return { ...st, groups: st.groups.map((x) => (x.id === gid ? { ...x, parent } : x)) };
}

/** File a project into a group, or (gid === null) back out to the top level. */
export function assignGroup(st: GroupStore, path: string, gid: string | null): GroupStore {
  if (!path) return st;
  if (gid === null) {
    if (!(path in st.of)) return st;
    const of = { ...st.of };
    delete of[path];
    return { ...st, of };
  }
  // A group that doesn't exist would be the dangling membership clampGroups repairs.
  if (!groupById(st, gid) || st.of[path] === gid) return st;
  return { ...st, of: { ...st.of, [path]: gid } };
}

export function renameGroup(st: GroupStore, gid: string, name: string): GroupStore {
  const n = cleanGroupName(name);
  // An empty name is a slip: a nameless heading would be unreachable.
  if (!n || !groupById(st, gid)) return st;
  return { ...st, groups: st.groups.map((g) => (g.id === gid ? { ...g, name: n } : g)) };
}

// Only the heading goes; its projects and groups move up one level, to where it stood.
export function deleteGroup(st: GroupStore, gid: string): GroupStore {
  const gone = groupById(st, gid);
  if (!gone) return st;
  const of: Record<string, string> = {};
  for (const [p, g] of Object.entries(st.of)) {
    if (g !== gid) of[p] = g;
    else if (gone.parent) of[p] = gone.parent;
  }
  const groups = st.groups.filter((g) => g.id !== gid).map((g) => (g.parent === gid ? { ...g, parent: gone.parent } : g));
  return { groups, of };
}

export function setCollapsed(st: GroupStore, gid: string, collapsed: boolean): GroupStore {
  const g = groupById(st, gid);
  if (!g || g.collapsed === collapsed) return st;
  return { ...st, groups: st.groups.map((x) => (x.id === gid ? { ...x, collapsed } : x)) };
}

/** Open `gid` and everything above it: landing on a project must not leave it inside a fold. */
export function expandTo(st: GroupStore, gid: string): GroupStore {
  const chain = new Set(chainOf(st.groups, gid));
  if (!st.groups.some((g) => chain.has(g.id) && g.collapsed)) return st;
  return { ...st, groups: st.groups.map((g) => (chain.has(g.id) && g.collapsed ? { ...g, collapsed: false } : g)) };
}

export function collapseAll(st: GroupStore, collapsed: boolean): GroupStore {
  if (st.groups.every((g) => g.collapsed === collapsed)) return st;
  return { ...st, groups: st.groups.map((g) => ({ ...g, collapsed })) };
}

/** Depth-first, siblings in store order: the order a picker lists groups in. */
export function groupTree(st: GroupStore): { group: GroupDef; depth: number }[] {
  const out: { group: GroupDef; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const g of childGroups(st, parent)) { out.push({ group: g, depth }); walk(g.id, depth + 1); }
  };
  walk(null, 0);
  return out;
}
