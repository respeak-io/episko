// Peek — resting on a project reveals the checkouts nothing is running in.
//
// WHY THIS EXISTS. The sidebar listed every checkout of every repo all the time, and
// most of them had no session in them, so a project with four worktrees spent four
// rows saying "no session" four times. Those rows are worth *reaching*, not worth
// *showing*: you want them when you are about to start something, which is exactly
// when the pointer is already on the project. So they collapse, and resting on the
// group brings them back.
//
// THE RULES ARE HERE AND THE TIMERS ARE NOT. Everything below is a pure transition
// over an explicit `now` — no `setTimeout`, no DOM, no ./state — so the awkward part
// (what cancels what) is unit-testable and ./sidebar is left as a thin driver that
// only has to schedule a timeout to `peekNextDeadline`. See test/peek.test.ts.
//
// The one rule worth reading twice is in `peekEnter`: **moving from one expanded
// group to another skips the delay entirely.** The delay exists to ignore a pointer
// passing *over* the rail; a pointer that is already inside an expanded rail is not
// passing over anything, and making it wait a second again reads as the app being
// slow rather than as it being careful.

/// What the user set. Milliseconds, already clamped — see `clampPeekPrefs`.
export interface PeekPrefs {
  /// Off means the checkouts simply stay hidden; the ⑃ dialog is still the way in.
  enabled: boolean;
  /// Exempt the projects you are already working in: one with a session running keeps
  /// its idle checkouts listed instead of collapsing them. **Off by default**, and the
  /// default is the point — peek exists because four rows saying "no session" are worth
  /// *reaching*, and this is the narrow case where they are worth *showing*: in a
  /// project you have a pane open in, the sibling checkout is the next thing you reach
  /// for, and paying the hover delay for it every time is a toll rather than a
  /// tidy-up. Idle projects still collapse, so the rail's length still tracks what you
  /// are doing rather than how many worktrees exist.
  pinLive: boolean;
  /// How long the pointer must rest on a project before it expands.
  openMs: number;
  /// How long an expanded group survives after the pointer leaves it. Generous on
  /// purpose: the whole point of expanding is that you are about to click something
  /// in there, and a panel that vanishes as you travel towards it is worse than one
  /// that never opened.
  closeMs: number;
}

export const PEEK_DEFAULTS: PeekPrefs = { enabled: true, pinLive: false, openMs: 1000, closeMs: 3000 };

/// Bounds for the two timings. Not taste — these are the values either side of which
/// the feature stops working: below ~150ms it fires while you are travelling past,
/// and a close grace under ~400ms collapses before the pointer can arrive. The upper
/// bounds only exist so a typo can't wedge a group open for an hour.
export const PEEK_OPEN_RANGE = { min: 150, max: 4000 } as const;
export const PEEK_CLOSE_RANGE = { min: 400, max: 10000 } as const;

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

/** Whatever came out of `localStorage` (or a settings stepper), made safe. */
export function clampPeekPrefs(p: Partial<PeekPrefs> | null | undefined): PeekPrefs {
  return {
    enabled: p?.enabled !== false,
    // The mirror image of `enabled` above, and for the same reason each way round: a
    // key that isn't there yet must land on the shipped default. Peek is on unless
    // switched off; this one is off unless switched on, so it reads `=== true` rather
    // than `!== false` and every pre-existing cc-peek blob keeps behaving as it did.
    pinLive: p?.pinLive === true,
    openMs: clamp(Number(p?.openMs), PEEK_OPEN_RANGE.min, PEEK_OPEN_RANGE.max, PEEK_DEFAULTS.openMs),
    closeMs: clamp(Number(p?.closeMs), PEEK_CLOSE_RANGE.min, PEEK_CLOSE_RANGE.max, PEEK_DEFAULTS.closeMs),
  };
}

/**
 * Does a project's idle-checkout body render already open, instead of waiting for the
 * pointer? Two ways that happens and they are different reasons, which is why one
 * predicate answers for both: peek switched **off** keeps every checkout listed (the
 * feature's off state was never "hide them for good"), and `pinLive` keeps them listed
 * for the projects with something running in them.
 *
 * `live` is "does anything at all run in this project" — an Episko pane or an external
 * session in any of its checkouts (./grouping's `clusterIsLive`, over every cluster).
 * Dormant sessions are deliberately not it: a project you finished with yesterday is
 * exactly the one peek was built to fold away.
 *
 * Pure and here rather than in ./sidebarview because the "off" half of it was already a
 * rule two surfaces had to agree on — the sidebar and the Settings preview — and a
 * second reason to be open is a second chance for them to drift apart.
 */
export function peekStaysOpen(p: PeekPrefs, live: boolean): boolean {
  return !p.enabled || (p.pinLive && live);
}

/// Exactly one group is ever expanded. `open` is a project path (`.pgroup`'s
/// `data-path`), which is also what survives a re-render — the sidebar rebuilds its
/// DOM constantly, so the expanded group has to be identified by something in the
/// data rather than by an element reference.
export interface PeekState {
  open: string | null;
  /// The group whose open timer is running, and when it fires.
  arming: { path: string; at: number } | null;
  /// When `open` collapses, once the pointer has left it. Null while the pointer is
  /// still inside.
  closingAt: number | null;
}

export const PEEK_IDLE: PeekState = { open: null, arming: null, closingAt: null };

/** The pointer entered a project group. */
export function peekEnter(s: PeekState, path: string, now: number, p: PeekPrefs): PeekState {
  if (!p.enabled) return s.open || s.arming ? PEEK_IDLE : s;
  // Already showing this one: the pointer came back, so cancel the collapse.
  if (s.open === path) return s.closingAt === null ? s : { ...s, closingAt: null };
  // Already inside an expanded rail — see the header comment. No delay, and the
  // previous group closes in the same beat rather than overlapping with this one.
  if (s.open) return { open: path, arming: null, closingAt: null };
  if (s.arming?.path === path) return s;                   // its timer is already running
  return { ...s, arming: { path, at: now + p.openMs } };
}

/** The pointer left a project group — for a sibling, for the gap, or for the page. */
export function peekLeave(s: PeekState, path: string, now: number, p: PeekPrefs): PeekState {
  const arming = s.arming?.path === path ? null : s.arming;
  // Only the group actually on screen gets a grace period; leaving a group that was
  // merely arming just cancels it.
  const closingAt = s.open === path && s.closingAt === null ? now + p.closeMs : s.closingAt;
  return arming === s.arming && closingAt === s.closingAt ? s : { ...s, arming, closingAt };
}

/** The pointer left the sidebar entirely. */
export function peekLeaveAll(s: PeekState, now: number, p: PeekPrefs): PeekState {
  if (!s.open) return s.arming ? { ...s, arming: null } : s;
  return { ...s, arming: null, closingAt: s.closingAt ?? now + p.closeMs };
}

/** Apply whatever deadlines have come due. */
export function peekTick(s: PeekState, now: number): PeekState {
  if (s.arming && now >= s.arming.at) return { open: s.arming.path, arming: null, closingAt: null };
  if (s.closingAt !== null && now >= s.closingAt) return PEEK_IDLE;
  return s;
}

/**
 * The next moment `peekTick` would change something, or null when nothing is pending.
 *
 * The driver schedules one timeout to this rather than keeping an interval running —
 * an idle sidebar should cost nothing at all, and this is what makes that true.
 */
export function peekNextDeadline(s: PeekState): number | null {
  if (s.arming) return s.arming.at;
  return s.closingAt;
}
