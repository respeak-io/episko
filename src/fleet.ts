// One card per project for the fleet screen, from data the frontend already holds; ./fleetview
// owns the markup. See docs/dashboard.md and test/fleet.test.ts.

import type { ProjGroup } from "./grouping";
import { histProject, type HistEntry } from "./history";
import type { TrailCommit } from "./trail";
import type { DiffStat, Sess } from "./types";

export interface FleetCard {
  path: string; name: string; accent: string;
  live: number; needs: number; urgency: number;
  dirty: DiffStat | null | undefined;
  lastCommit: number; lastSession: number; commits: number; spend: number;
}
// `attnPending`/`urgency` are ./grouping's, injected so nothing here reads the live session map.
// Pending, never raw `needsYou`: this screen counts at the user, and its own "Needs you" card
// draws `needsYouSessions()` — two predicates would put two numbers on one screen (./attn).
export interface FleetInput {
  projects: ProjGroup[];
  commits: TrailCommit[];
  hist: HistEntry[];
  dirty: ReadonlyMap<string, DiffStat | null>;
  costFor: (projectName: string) => number;
  attnPending: (s: Sess) => boolean;
  urgency: (s: Sess) => number;
  now: number;
}
export type FleetSort = "attention" | "recent" | "name";
export interface FleetTally { projects: number; live: number; needs: number; dirty: number; unread: number }

export function fleetCards(i: FleetInput): FleetCard[] {
  const newest = new Map<string, number>(), count = new Map<string, number>();
  for (const c of i.commits) {
    count.set(c.root, (count.get(c.root) ?? 0) + 1);
    newest.set(c.root, Math.max(newest.get(c.root) ?? 0, c.when * 1000));
  }
  const seen = new Map<string, number>(); // the sidebar's own grouping rule, as dashDays uses it
  for (const h of i.hist) {
    const k = histProject(h).colorKey;
    seen.set(k, Math.max(seen.get(k) ?? 0, h.last_active * 1000));
  }
  return i.projects.map((p) => {
    const repo = p.repoRoot ?? p.path;
    return {
      path: p.path, name: p.name, accent: p.accent,
      live: p.sessions.length,
      needs: p.sessions.filter((s) => i.attnPending(s)).length,
      urgency: p.sessions.reduce((m, s) => Math.min(m, i.urgency(s)), 99),
      // Three states, and `undefined` is the one that matters: the map is pruned to folders in
      // play, so an unswept folder is unread and must never render as clean. Never `folderDirty`.
      dirty: i.dirty.get(p.path),
      lastCommit: newest.get(repo) ?? 0,
      lastSession: seen.get(repo) ?? 0,
      commits: count.get(repo) ?? 0,
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

export function fleetTally(cards: FleetCard[]): FleetTally {
  const t: FleetTally = { projects: cards.length, live: 0, needs: 0, dirty: 0, unread: 0 };
  for (const c of cards) {
    t.live += c.live;
    t.needs += c.needs;
    if (c.dirty === undefined) t.unread++;
    else if (c.dirty && c.dirty.dirty > 0) t.dirty++;
  }
  return t;
}
