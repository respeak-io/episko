// Project groups — a named, collapsible heading over several projects in the sidebar.
//
// WHY THIS EXISTS. The rail lists every project flat, so a machine with a dozen repos
// open spends a dozen headers on repos you are not working in today. A group is the
// user's own answer to that: name a set of projects, fold it away, and the rail shows
// what you are actually doing.
//
// WHAT A GROUP IS NOT: an ordering. A group holds a name, a collapsed flag and a set of
// project paths, and nothing else. *Where* it sits in the sidebar is decided by its
// members under whichever sort is active (./grouping's `groupedProjects`), so there is
// no second order to keep in step with `cc-proj-order` and therefore no way for the two
// to disagree — drag a project and the group it is in follows it.
//
// THE RULES ARE HERE AND THE STATE IS NOT. Everything below is pure over an explicit
// store — no ./state, no DOM, no renderer — the same shape ./peek takes, and for the
// same concrete reason: ./state imports this module for its validator, so anything here
// that reached back into ./state would be an import cycle. Every mutator returns a NEW
// store, and returns the one it was given unchanged when there is nothing to do, which
// is what lets the call site skip a repaint on a no-op.
//
// See test/projgroups.test.ts.

/// One group. `id` is opaque and stable — it is what `of` below points at, what the
/// sidebar writes into `data-fold`, and what a rename must not change.
export interface GroupDef { id: string; name: string; collapsed: boolean }
/// `of` maps a project path (the same key `cc-proj-order`, `cc-colors` and `FAVORITES`
/// all use) to a group id. A path with no entry is ungrouped and renders top-level.
export interface GroupStore { groups: GroupDef[]; of: Record<string, string> }

export const NO_GROUPS: GroupStore = { groups: [], of: {} };

/// A name has to fit a 220px rail, and the count is only a guard against a corrupt or
/// hand-edited store — nobody reaches either by hand.
const MAX_NAME = 40;
const MAX_GROUPS = 40;

/** Whatever the user typed, made fit: one-line, trimmed, bounded. May return "". */
export function cleanGroupName(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

/**
 * Whatever came out of `localStorage`, made safe.
 *
 * Two invariants matter and both are repaired rather than trusted: group ids are
 * unique, and every membership points at a group that exists. A dangling membership
 * would render as a project that has simply vanished from the rail — it belongs to a
 * fold nothing draws — which is the one failure mode of this feature a user could not
 * diagnose.
 */
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

/// The lowest `g<n>` this store isn't already using. Derived rather than random or
/// timestamped so a test can name the group it just created, and so nothing here needs
/// `Date.now()` — the store is written from a `renderAll` path under fake timers.
export function nextGroupId(st: GroupStore): string {
  const used = new Set(st.groups.map((g) => g.id));
  let n = 1;
  while (used.has("g" + n)) n++;
  return "g" + n;
}

export const groupById = (st: GroupStore, gid: string): GroupDef | null => st.groups.find((g) => g.id === gid) ?? null;
export const groupOf = (st: GroupStore, path: string): string | null => st.of[path] ?? null;
export const groupPaths = (st: GroupStore, gid: string): string[] => Object.keys(st.of).filter((p) => st.of[p] === gid);

/** Create a group and file `paths` into it in one step — the only way one is born. */
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
  // Filing into a group that doesn't exist would produce exactly the dangling
  // membership `clampGroups` repairs, so it is refused at the source too.
  if (!groupById(st, gid) || st.of[path] === gid) return st;
  return { ...st, of: { ...st.of, [path]: gid } };
}

export function renameGroup(st: GroupStore, gid: string, name: string): GroupStore {
  const n = cleanGroupName(name);
  // An empty name is a slip, not an instruction — a nameless heading is unusable and
  // the group would be unreachable except by dragging things out of it one at a time.
  if (!n || !groupById(st, gid)) return st;
  return { ...st, groups: st.groups.map((g) => (g.id === gid ? { ...g, name: n } : g)) };
}

/// Deleting a group keeps every project in it — only the heading goes. There is
/// nothing to confirm and nothing to undo: the projects reappear at the top level and
/// making the group again is one right-click.
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
