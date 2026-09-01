// Project groups: a named, collapsible heading over several projects in the sidebar.
// Not an ordering (./grouping places a group by its members). Pure over an explicit store
// (./state imports this); a mutator returns a new store, or the same one on a no-op.

// `id` is opaque and stable: what `of` and the sidebar's `data-fold` point at.
export interface GroupDef { id: string; name: string; collapsed: boolean }
// `of`: project path (the `cc-proj-order` key) → group id; no entry means ungrouped.
export interface GroupStore { groups: GroupDef[]; of: Record<string, string> }

export const NO_GROUPS: GroupStore = { groups: [], of: {} };

const MAX_NAME = 40; // fits the 220px rail
const MAX_GROUPS = 40;

export function cleanGroupName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

// Repairs rather than trusts: unique ids, and every membership pointing at a group that
// exists. A dangling one would hide a project in a fold nothing draws.
export function clampGroups(raw: unknown): GroupStore {
  const src = (raw ?? null) as Partial<GroupStore> | null;
  const groups: GroupDef[] = [];
  const ids = new Set<string>();
  for (const g of Array.isArray(src?.groups) ? src.groups : []) {
    if (groups.length >= MAX_GROUPS) break;
    const id = typeof g?.id === "string" ? g.id : "";
    if (!id || ids.has(id)) continue;
    ids.add(id);
    groups.push({ id, name: cleanGroupName(g?.name) || "Group", collapsed: g?.collapsed === true });
  }
  const of: Record<string, string> = {};
  const rawOf = src?.of;
  if (rawOf && typeof rawOf === "object") {
    for (const [path, gid] of Object.entries(rawOf)) {
      if (path && typeof gid === "string" && ids.has(gid)) of[path] = gid;
    }
  }
  return { groups, of };
}

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

export function createGroup(st: GroupStore, name: string, paths: string[] = []): GroupStore {
  if (st.groups.length >= MAX_GROUPS) return st;
  const id = nextGroupId(st);
  const of = { ...st.of };
  for (const p of paths) if (p) of[p] = id;
  return { groups: [...st.groups, { id, name: cleanGroupName(name) || "Group", collapsed: false }], of };
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

// Only the heading goes; its projects return to the top level.
export function deleteGroup(st: GroupStore, gid: string): GroupStore {
  if (!groupById(st, gid)) return st;
  const of: Record<string, string> = {};
  for (const [p, g] of Object.entries(st.of)) if (g !== gid) of[p] = g;
  return { groups: st.groups.filter((g) => g.id !== gid), of };
}

export function setCollapsed(st: GroupStore, gid: string, collapsed: boolean): GroupStore {
  const g = groupById(st, gid);
  if (!g || g.collapsed === collapsed) return st;
  return { ...st, groups: st.groups.map((x) => (x.id === gid ? { ...x, collapsed } : x)) };
}

export function collapseAll(st: GroupStore, collapsed: boolean): GroupStore {
  if (st.groups.every((g) => g.collapsed === collapsed)) return st;
  return { ...st, groups: st.groups.map((g) => ({ ...g, collapsed })) };
}
