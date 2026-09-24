// The roster on the wire (docs/sync.md): the seven path-keyed stores, spoken in project ids so
// they mean the same thing on every machine. Pure over an explicit roster and two lookups; the
// app keeps carrying paths, and nothing in the render layer knows ids exist.
import { clampGroups, type GroupStore } from "./projgroups";

export interface Roster {
  favorites: { name: string; path: string }[];
  order: string[];
  groups: GroupStore;
  colors: Record<string, string>;
  icons: Record<string, string>;
  agent: Record<string, string>;
  gh: Record<string, string>;
}
/** A roster as the server holds it: wire key → value. A removed entry is an absent key. */
export type Wire = Record<string, unknown>;
export type IdOf = (path: string) => string | undefined;
export type PathOf = (id: string) => string | undefined;

const MAPS = { color: "colors", icon: "icons", agent: "agent", gh: "gh" } as const;
type MapKind = keyof typeof MAPS;

/** The roster, id-keyed. A project with no id yet is simply not on the wire. */
export function rosterWire(r: Roster, idOf: IdOf): Wire {
  const w: Wire = {};
  for (const f of r.favorites) { const id = idOf(f.path); if (id && !(`fav|${id}` in w)) w[`fav|${id}`] = { name: f.name }; }
  for (const kind of Object.keys(MAPS) as MapKind[]) {
    for (const [path, v] of Object.entries(r[MAPS[kind]])) {
      const id = idOf(path);
      if (id && typeof v === "string" && !(`${kind}|${id}` in w)) w[`${kind}|${id}`] = v;
    }
  }
  const order: string[] = [];
  for (const p of r.order) { const id = idOf(p); if (id && !order.includes(id)) order.push(id); }
  if (order.length) w.order = order;
  if (r.groups.groups.length) {
    const of: Record<string, string> = {};
    for (const [path, gid] of Object.entries(r.groups.of)) { const id = idOf(path); if (id) of[id] = gid; }
    // `collapsed` is how this screen looks, not a fact about the projects: it stays here.
    w.groups = { groups: r.groups.groups.map((g) => ({ id: g.id, name: g.name })), of };
  }
  return w;
}

export const idOfKey = (k: string): string | undefined => { const i = k.indexOf("|"); return i > 0 ? k.slice(i + 1) : undefined; };

/**
 * This machine's wire laid over the last agreed one. An entry for a project not cloned here is
 * carried through untouched, so no machine ever sends the absence of what it cannot see. The
 * order keeps every unknown id in its slot and re-sorts only the ids this machine can place.
 */
export function mergeWire(prev: Wire, mine: Wire, known: (id: string) => boolean): Wire {
  const out: Wire = { ...mine };
  for (const [k, v] of Object.entries(prev)) {
    const id = idOfKey(k);
    if (id !== undefined && !known(id) && !(k in out)) out[k] = v;
  }
  const was = Array.isArray(prev.order) ? (prev.order as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const local = Array.isArray(mine.order) ? (mine.order as string[]) : [];
  if (was.length || local.length) {
    const queue = local.filter((id) => was.includes(id));
    const order = was.map((id) => (known(id) && local.includes(id) ? queue.shift()! : id)).filter((id) => known(id) ? local.includes(id) : true);
    for (const id of local) if (!order.includes(id)) order.push(id);
    out.order = order;
  }
  const pg = prev.groups as { of?: Record<string, string> } | undefined;
  if (pg?.of && out.groups) {
    const g = out.groups as { groups: unknown[]; of: Record<string, string> };
    const keep: Record<string, string> = {};
    for (const [id, gid] of Object.entries(pg.of)) if (!known(id)) keep[id] = gid;
    out.groups = { ...g, of: { ...keep, ...g.of } };
  }
  return out;
}

/** Keys whose value differs between two wires, removals included, in a stable order. */
export function wireDiff(prev: Wire, next: Wire): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])).sort();
}

export const isRosterKey = (k: string) => k === "order" || k === "groups" || /^(fav|color|icon|agent|gh)\|.+/.test(k);

/**
 * One wire entry applied to this machine's roster. False when there is no local checkout of the
 * project yet (the entry is held and re-applied once one appears) or the value is unusable.
 */
export function applyWire(r: Roster, key: string, value: unknown, pathOf: PathOf, idOf: IdOf): boolean {
  if (key === "order") {
    if (!Array.isArray(value)) return false;
    const rank = new Map<string, number>();
    value.forEach((id, i) => { if (typeof id === "string" && !rank.has(id)) rank.set(id, i); });
    const at = (p: string) => { const id = idOf(p); return id !== undefined && rank.has(id) ? rank.get(id)! : Infinity; };
    // Stable: a project the other machine has never seen keeps its place among the unranked.
    const next = r.order.map((p, i) => ({ p, i, k: at(p) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.p);
    const moved = next.some((p, i) => p !== r.order[i]);
    r.order = next;
    return moved;
  }
  if (key === "groups") {
    const v = value as { groups?: unknown; of?: unknown } | null;
    if (!v || typeof v !== "object") return false;
    const collapsed = new Map(r.groups.groups.map((g) => [g.id, g.collapsed]));
    const of: Record<string, string> = {};
    // A project with no id stays in whatever group it was in here, if that group survived.
    for (const [path, gid] of Object.entries(r.groups.of)) if (!idOf(path)) of[path] = gid;
    if (v.of && typeof v.of === "object") {
      for (const [id, gid] of Object.entries(v.of as Record<string, unknown>)) {
        const path = pathOf(id);
        if (path && typeof gid === "string") of[path] = gid;
      }
    }
    const groups = Array.isArray(v.groups) ? v.groups.map((g) => ({ ...(g as object), collapsed: collapsed.get((g as { id?: string })?.id ?? "") === true })) : [];
    r.groups = clampGroups({ groups, of });
    return true;
  }
  const bar = key.indexOf("|");
  const kind = key.slice(0, bar), id = key.slice(bar + 1);
  const path = pathOf(id);
  if (!path) return false;
  if (kind === "fav") {
    const has = r.favorites.some((f) => idOf(f.path) === id);
    if (value === null || value === undefined) {
      r.favorites = r.favorites.filter((f) => idOf(f.path) !== id);
      return has;
    }
    if (has) return false;
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    r.favorites = [...r.favorites, { name, path }];
    return true;
  }
  if (!(kind in MAPS)) return false;
  const map = r[MAPS[kind as MapKind]];
  // Every checkout of this project here answers to one entry, the one `pathOf` names.
  for (const p of Object.keys(map)) if (p !== path && idOf(p) === id) delete map[p];
  if (value === null || value === undefined) { delete map[path]; return true; }
  if (typeof value !== "string") return false;
  map[path] = value;
  return true;
}
