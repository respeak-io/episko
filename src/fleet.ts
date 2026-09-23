// One card per project for the fleet screen, from data the frontend already holds; ./fleetview
// owns the markup. See docs/dashboard.md and test/fleet.test.ts.

import type { ProjGroup } from "./grouping";
import { groupOf, type GroupDef, type GroupStore } from "./projgroups";
import { histProject, type HistEntry } from "./history";
import type { TrailCommit } from "./trail";
import type { DiffStat, Sess, WtHead } from "./types";

/** The windows the screen offers. One range for both halves, so a figure means one thing. */
export const FLEET_RANGES = [7, 14, 30] as const;

export interface FleetCard {
  path: string; name: string; accent: string;
  group: string | null;   // the sidebar group it is filed in, or null for the top level
  live: number; needs: number; urgency: number;
  dirty: DiffStat | null | undefined;
  branch: string; checkouts: number;
  lastCommit: number; lastSession: number; commits: number; sessions: number; spend: number;
}
// `attnPending`/`urgency` are ./grouping's, injected so nothing here reads the live session map.
// Pending, never raw `needsYou`: this screen counts at the user, and its own "Needs you" card
// draws `needsYouSessions()` — two predicates would put two numbers on one screen (./attn).
export interface FleetInput {
  projects: ProjGroup[];
  commits: TrailCommit[];
  hist: HistEntry[];
  heads: ReadonlyMap<string, WtHead[]>; // worktree_heads by repo root: the branch chip and the count
  dirty: ReadonlyMap<string, DiffStat | null>;
  costFor: (projectName: string) => number;
  groups: GroupStore;     // the sidebar's own store, injected: nothing here reads ./state
  attnPending: (s: Sess) => boolean;
  urgency: (s: Sess) => number;
  days: number;
  now: number;
}
export type FleetSort = "attention" | "recent" | "name";
export interface FleetTally {
  projects: number; checkouts: number; live: number; liveProjects: number;
  needs: number; dirty: number; unread: number;
}

export function fleetCards(i: FleetInput): FleetCard[] {
  const since = i.now - i.days * 86_400_000;
  const newest = new Map<string, number>(), count = new Map<string, number>();
  for (const c of i.commits) {
    count.set(c.root, (count.get(c.root) ?? 0) + 1);
    newest.set(c.root, Math.max(newest.get(c.root) ?? 0, c.when * 1000));
  }
  const seen = new Map<string, number>(), ran = new Map<string, number>(); // the sidebar's grouping rule, as dashDays uses it
  for (const h of i.hist) {
    const k = histProject(h).colorKey, when = h.last_active * 1000;
    seen.set(k, Math.max(seen.get(k) ?? 0, when));
    if (when >= since) ran.set(k, (ran.get(k) ?? 0) + 1);
  }
  return i.projects.map((p) => {
    const repo = p.repoRoot ?? p.path;
    const heads = i.heads.get(repo) ?? [];
    return {
      path: p.path, name: p.name, accent: p.accent,
      // The sidebar's fallback too (./grouping's `foldIdOf`): the user filed the repo, so
      // every checkout of it answers with that group.
      group: groupOf(i.groups, p.path) ?? (p.repoRoot ? groupOf(i.groups, p.repoRoot) : null),
      // Both kinds: an external is as live as ours, and this figure is what the band counts.
      // `needs` and `urgency` stay ours alone — an external has no hooks and can want nothing.
      live: p.sessions.length + p.externals.length,
      needs: p.sessions.filter((s) => i.attnPending(s)).length,
      urgency: p.sessions.reduce((m, s) => Math.min(m, i.urgency(s)), 99),
      // Three states, and `undefined` is the one that matters: the map is pruned to folders in
      // play, so an unswept folder is unread and must never render as clean. Never `folderDirty`.
      dirty: i.dirty.get(p.path),
      // The main checkout's, since every other figure on the card is that folder's too.
      branch: heads.find((h) => h.is_main)?.branch ?? "",
      checkouts: heads.length,
      lastCommit: newest.get(repo) ?? 0,
      lastSession: seen.get(repo) ?? 0,
      commits: count.get(repo) ?? 0,
      sessions: ran.get(repo) ?? 0,
      // By NAME, as `cc-usage-detail` records it; two repos sharing a basename sum into one.
      spend: i.costFor(p.name),
    };
  });
}

export function fleetSorted(cards: FleetCard[], sort: FleetSort): FleetCard[] {
  const moved = (c: FleetCard) => Math.max(c.lastCommit, c.lastSession);
  const cmp: (a: FleetCard, b: FleetCard) => number = sort === "attention"
    ? (a, b) => a.urgency - b.urgency || b.needs - a.needs || b.lastSession - a.lastSession
    : sort === "recent" ? (a, b) => moved(b) - moved(a)
      : (a, b) => a.name.localeCompare(b.name);
  // Every sort ends on the path, so a repaint of unchanged state never reorders a card.
  return [...cards].sort((a, b) => cmp(a, b) || a.path.localeCompare(b.path));
}

/** One heading's worth of cards. `name` is the group's, or `TOP_LEVEL` for the unfiled run. */
export interface FleetSection { name: string; cards: FleetCard[] }
export const TOP_LEVEL = "Top level";   // ./projmenu's word for a project in no group

// ./grouping's sidebar rule over the cards: every run — a group, or the unfiled ones — sits
// where its first member does under the active sort, so the switch reorders nothing. An empty
// group is dropped rather than kept last: on this screen it is a heading over nothing, where
// in the sidebar it is the drop target that refills it.
export function fleetSections(cards: FleetCard[], groups: GroupDef[]): FleetSection[] {
  const out: FleetSection[] = [];
  const open = new Map<string, FleetSection>();
  for (const c of cards) {
    const g = c.group ? groups.find((x) => x.id === c.group) : undefined;
    const id = g?.id ?? "";
    let sec = open.get(id);
    if (!sec) { sec = { name: g?.name ?? TOP_LEVEL, cards: [] }; open.set(id, sec); out.push(sec); }
    sec.cards.push(c);
  }
  return out;
}

export function fleetTally(cards: FleetCard[]): FleetTally {
  const t: FleetTally = { projects: cards.length, checkouts: 0, live: 0, liveProjects: 0, needs: 0, dirty: 0, unread: 0 };
  for (const c of cards) {
    t.live += c.live;
    t.needs += c.needs;
    if (c.live > 0) t.liveProjects++;
    // A project nothing has read yet counts as the one checkout we know it has.
    t.checkouts += Math.max(1, c.checkouts);
    if (c.dirty === undefined) t.unread++;
    else if (c.dirty && c.dirty.dirty > 0) t.dirty++;
  }
  return t;
}

export type NeedKind = "attention" | "error" | "done";
const NEED_WORD: Record<NeedKind, string> = { attention: "asking", done: "done", error: "failed" };
// The Needs you tile's sub-line. Asking leads, because it is the only one of the three that is
// holding a process open; `reactorState` is what names each session.
export function needsSplit(kinds: NeedKind[]): string {
  const n: Record<NeedKind, number> = { attention: 0, done: 0, error: 0 };
  for (const k of kinds) if (k in n) n[k]++;
  const parts = (["attention", "done", "error"] as NeedKind[])
    .filter((k) => n[k] > 0).map((k) => `${n[k]} ${NEED_WORD[k]}`);
  return parts.length ? parts.join(", ") : "nothing waiting";
}
