// The Orbit's arithmetic — where a thread sits, and how hard it is pulling. No DOM and
// no canvas, so it unit-tests like the rest of the model layer; ./orbitui draws it.
//
// RADIUS IS PRESSURE, NOT PHASE. That distinction is the whole reason this view is
// worth having. A static state→radius map is a legend with extra steps: it only moves
// when something changes state, so a fleet that is quietly going stale looks identical
// to one that is fine. Pressure = a floor set by the state, raised by how long the
// thread has been waiting — so a finished turn nobody has answered creeps inward all
// afternoon, and the picture keeps changing while *nothing* changes.
//
// It is a companion to the Threads board, never a replacement: you cannot read titles
// off a radial plot. Every dot is a click into the row it represents.

import { threadBand, threadStatusKey, type Thread } from "./thread";

/// The pressure floor per state, 0 (far out, fine) to 1 (pressed against you).
const BASE: Record<string, number> = {
  attention: 0.86, error: 0.70, done: 0.40, working: 0.22, thinking: 0.22,
  idle: 0.10, ended: 0.06, unclaimed: 0.04,
};
/// How much waiting can add on top.
const AGE_GAIN: Record<string, number> = {
  attention: 0.14, error: 0.22, done: 0.38, working: 0.18, thinking: 0.18,
  idle: 0.12, ended: 0.04, unclaimed: 0.12,
};
/// Minutes at which waiting stops adding. A blocked agent saturates in six minutes
/// because that wait is already rude; unclaimed work takes two days, because a note
/// sitting for an afternoon is not yet a problem.
const AGE_FULL: Record<string, number> = {
  attention: 6, error: 25, done: 55, working: 110,
  thinking: 110, idle: 240, ended: 1440, unclaimed: 2880,
};

/** How hard a thread is pulling: 0 = far out and fine, 1 = pressed against you. */
export function pressure(t: Thread, now = Date.now()): number {
  const key = threadStatusKey(t);
  const base = BASE[key] ?? 0.1;
  const gain = AGE_GAIN[key] ?? 0.1;
  const full = AGE_FULL[key] ?? 60;
  // `since` of 0 means "no known age" (a branch row, a malformed timestamp) — treat it
  // as brand new rather than infinitely old, or it would slam against the centre.
  const mins = t.since > 0 ? Math.max(0, (now - t.since) / 60_000) : 0;
  return Math.min(1, base + gain * Math.min(1, mins / full));
}

/**
 * Pressure → a fraction of the plot's radius.
 *
 * Never reaches the centre: the core is the user, and a dot sitting on top of it would
 * be unreadable exactly when it matters most.
 */
export function radiusFraction(p: number): number {
  return 0.155 + 0.845 * (1 - Math.min(1, Math.max(0, p)));
}

/// One project's slice of the ring. Sectors are assigned in a stable order so a repaint
/// never spins the whole picture — the thing you were looking at must stay where it was.
export interface Sector { colorKey: string; from: number; to: number }

export function sectors(colorKeys: string[], gap = 0.12): Sector[] {
  const keys = [...new Set(colorKeys)].sort();
  if (!keys.length) return [];
  const span = (Math.PI * 2) / keys.length;
  // Start at -90°, so the first project begins at the top rather than at 3 o'clock.
  const start = -Math.PI / 2;
  return keys.map((colorKey, i) => ({
    colorKey,
    from: start + i * span + gap / 2,
    to: start + (i + 1) * span - gap / 2,
  }));
}

export interface Dot {
  thread: Thread;
  /// Radians.
  angle: number;
  /// Fraction of the plot radius, 0 (centre) to 1 (rim).
  radius: number;
  /// Pixel radius of the dot itself, by spend — bounded so one expensive session
  /// cannot swallow the view.
  size: number;
  colorKey: string;
  /// Attention and error pull a line to the centre; nothing else does.
  urgent: boolean;
}

/**
 * Place every thread.
 *
 * Within a sector, threads are spread by a stable hash of their id rather than by
 * index: index-based placement makes every dot jump sideways whenever one thread is
 * added or removed, which is the specific thing that makes an ambient display
 * unwatchable.
 */
export function layout(threads: Thread[], now = Date.now()): Dot[] {
  const secs = sectors(threads.map((t) => t.colorKey || "—"));
  const byKey = new Map(secs.map((s) => [s.colorKey, s]));
  return threads.map((t) => {
    const key = t.colorKey || "—";
    const sec = byKey.get(key) ?? { colorKey: key, from: 0, to: Math.PI * 2 };
    let h = 0;
    for (let i = 0; i < t.id.length; i++) h = (h * 31 + t.id.charCodeAt(i)) >>> 0;
    const frac = (h % 1000) / 1000;
    const p = pressure(t, now);
    const status = threadStatusKey(t);
    return {
      thread: t,
      angle: sec.from + (sec.to - sec.from) * frac,
      radius: radiusFraction(p),
      // sqrt, so $40 is bigger than $4 without being ten times the area.
      size: Math.min(8, 3 + Math.sqrt(Math.max(0, t.cost ?? 0)) * 1.6),
      colorKey: key,
      urgent: status === "attention" || status === "error",
    };
  });
}

/**
 * Unclaimed threads collapse to one count per project once there are too many.
 *
 * The crowding rule, and the honest limit of the view: at forty threads the outer band
 * becomes a smear that says nothing. Inventory is what gets collapsed — never anything
 * running or waiting on you, since those are the only reasons to be looking.
 */
export function collapseUnclaimed(threads: Thread[], limit = 12): { shown: Thread[]; collapsed: Map<string, number> } {
  const open = threads.filter((t) => threadBand(t) === "open");
  if (open.length <= limit) return { shown: threads, collapsed: new Map() };
  const collapsed = new Map<string, number>();
  for (const t of open) collapsed.set(t.colorKey || "—", (collapsed.get(t.colorKey || "—") ?? 0) + 1);
  return { shown: threads.filter((t) => threadBand(t) !== "open"), collapsed };
}
