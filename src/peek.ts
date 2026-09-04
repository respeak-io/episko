// Peek: resting the pointer on a project reveals the checkouts nothing is running in. Pure
// transitions over an explicit `now`; ./sidebar drives the timers (test/peek.test.ts).

export interface PeekPrefs {
  enabled: boolean;
  pinLive: boolean; // a live project keeps its idle checkouts listed; off by default
  openMs: number;
  closeMs: number;  // grace after the pointer leaves, long enough to travel to the click
}

export const PEEK_DEFAULTS: PeekPrefs = { enabled: true, pinLive: false, openMs: 1000, closeMs: 3000 };

// Below ~150ms it opens while you travel past; under ~400ms it closes before the pointer arrives.
export const PEEK_OPEN_RANGE = { min: 150, max: 4000 } as const;
export const PEEK_CLOSE_RANGE = { min: 400, max: 10000 } as const;

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

/** Whatever came out of `localStorage` (or a settings stepper), made safe. */
export function clampPeekPrefs(p: Partial<PeekPrefs> | null | undefined): PeekPrefs {
  return {
    enabled: p?.enabled !== false,
    pinLive: p?.pinLive === true, // opt-in, so older cc-peek blobs keep behaving
    openMs: clamp(Number(p?.openMs), PEEK_OPEN_RANGE.min, PEEK_OPEN_RANGE.max, PEEK_DEFAULTS.openMs),
    closeMs: clamp(Number(p?.closeMs), PEEK_CLOSE_RANGE.min, PEEK_CLOSE_RANGE.max, PEEK_DEFAULTS.closeMs),
  };
}

// Peek off never meant "hide for good"; `pinLive` keeps a live project's checkouts listed.
// `live` is ./grouping's `clusterIsLive` over every cluster; a dormant session does not count.
export function peekStaysOpen(p: PeekPrefs, live: boolean): boolean {
  return !p.enabled || (p.pinLive && live);
}

// At most one group is expanded, identified by path: the sidebar rebuilds its DOM constantly.
export interface PeekState {
  open: string | null;
  arming: { path: string; at: number } | null;
  closingAt: number | null;                    // when `open` collapses; null while the pointer is inside
}

export const PEEK_IDLE: PeekState = { open: null, arming: null, closingAt: null };

export function peekEnter(s: PeekState, path: string, now: number, p: PeekPrefs): PeekState {
  if (!p.enabled) return s.open || s.arming ? PEEK_IDLE : s;
  if (s.open === path) return s.closingAt === null ? s : { ...s, closingAt: null };
  // Already inside an expanded rail: no delay, and the previous group closes in the same beat.
  if (s.open) return { open: path, arming: null, closingAt: null };
  if (s.arming?.path === path) return s;
  return { ...s, arming: { path, at: now + p.openMs } };
}

export function peekLeave(s: PeekState, path: string, now: number, p: PeekPrefs): PeekState {
  const arming = s.arming?.path === path ? null : s.arming;
  // Only the group on screen gets a grace period; leaving one that was merely arming cancels it.
  const closingAt = s.open === path && s.closingAt === null ? now + p.closeMs : s.closingAt;
  return arming === s.arming && closingAt === s.closingAt ? s : { ...s, arming, closingAt };
}

export function peekLeaveAll(s: PeekState, now: number, p: PeekPrefs): PeekState {
  if (!s.open) return s.arming ? { ...s, arming: null } : s;
  return { ...s, arming: null, closingAt: s.closingAt ?? now + p.closeMs };
}

export function peekTick(s: PeekState, now: number): PeekState {
  if (s.arming && now >= s.arming.at) return { open: s.arming.path, arming: null, closingAt: null };
  if (s.closingAt !== null && now >= s.closingAt) return PEEK_IDLE;
  return s;
}

/** The next moment `peekTick` would change something; the driver schedules one timeout to it. */
export function peekNextDeadline(s: PeekState): number | null {
  if (s.arming) return s.arming.at;
  return s.closingAt;
}
