// The moment a session starts wanting you, and what happens to it afterwards: the
// highlight that fades off its sidebar row, the order the "your turn" badge lists the
// fleet in, and what opening a pane does to that list.
//
// WHY THIS EXISTS. The reactor badge counts the needs-you set (./grouping's `needsYou`)
// and nothing ever left it except by the session's own doing — a turn you had read,
// answered and moved on from still sat in the badge, in the tray title and in the
// palette's "Needs you" group until the agent happened to start another turn. So the
// count drifted upwards over a session of work and stopped meaning anything, which is
// the failure mode every notification badge has. And the moment that *matters* — an
// agent finishing while you are looking at a different pane — had no signal at all in
// the sidebar beyond a glyph quietly changing colour among twenty others.
//
// THE RULES ARE HERE AND THE TIMERS ARE NOT. Everything below is data and pure
// functions over an explicit `now` — no DOM, no ./state, no renderer — so ./sidebar is
// left as a thin driver that only has to schedule a timeout to `attnFlashDeadline`.
// Same split as ./peek and ./sound. See test/attn.test.ts.
//
// TWO STAMPS, AND THE WHOLE FEATURE IS THE COMPARISON BETWEEN THEM. `Sess.attnAt` is
// when this pane entered the needs-you set (0 when it isn't in it), maintained in one
// place by ./grouping's `syncAttn`; `Sess.seenAt` is the last time you put the pane on
// the stage. `seenAt >= attnAt` therefore means "you have looked at this since it
// started wanting you", which is the one question both halves ask — so a click cannot
// clear the badge without also stopping the highlight, and neither needs a set of
// acknowledged ids to be kept in sync with the session map.

import type { Sess } from "./types";

/// Which end of the queue the reactor's picker starts from.
export type AttnOrder = "recent" | "waiting";

export interface AttnPrefs {
  /// Light a session's sidebar row when it starts wanting you.
  highlight: boolean;
  /// How long that light lasts. It fades over the whole of it rather than switching
  /// off at the end — a highlight you have to catch mid-blink is worse than none.
  highlightMs: number;
  /// The order the "your turn" badge and its picker list the fleet in, *within* an
  /// urgency tier (a blocking permission still outranks a finished turn — see
  /// `needsYouSessions`).
  order: AttnOrder;
  /// Opening a session takes it out of the badge. Off means the badge only ever
  /// empties when the sessions in it move on by themselves, which is what it did
  /// before this existed.
  clearOnOpen: boolean;
}

export const ATTN_DEFAULTS: AttnPrefs = {
  highlight: true, highlightMs: 4000, order: "recent", clearOnOpen: true,
};

/// Bounds for the highlight. Not taste: under ~800ms the fade is a flicker you cannot
/// tell from a repaint, and the upper bound only exists so a held-down + cannot leave
/// half the rail glowing for a minute — a highlight that outlives your attention is
/// just a second selection colour.
export const ATTN_HIGHLIGHT_RANGE = { min: 800, max: 20000 } as const;
export const ATTN_HIGHLIGHT_STEP = 400;

/// Each order's glyph and one-line description — shared by the settings picker and
/// anything else that names them, so the two can never drift apart.
export const ATTN_ORDERS: { id: AttnOrder; label: string; sub: string; glyph: string }[] = [
  { id: "recent",  label: "Newest first",    glyph: "◷", sub: "The one that just finished is at the top" },
  { id: "waiting", label: "Longest waiting", glyph: "◵", sub: "The one that has been waiting on you longest" },
];

const clamp = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

/** Whatever came out of `localStorage` (or a settings stepper), made safe. */
export function clampAttnPrefs(p: Partial<AttnPrefs> | null | undefined): AttnPrefs {
  return {
    highlight: p?.highlight !== false,
    highlightMs: clamp(Number(p?.highlightMs), ATTN_HIGHLIGHT_RANGE.min, ATTN_HIGHLIGHT_RANGE.max, ATTN_DEFAULTS.highlightMs),
    order: p?.order === "waiting" ? "waiting" : "recent",
    clearOnOpen: p?.clearOnOpen !== false,
  };
}
/// Whether these are still the shipped defaults — what disables the Reset button.
export function isDefaultAttnPrefs(p: AttnPrefs): boolean {
  return p.highlight === ATTN_DEFAULTS.highlight && p.highlightMs === ATTN_DEFAULTS.highlightMs
    && p.order === ATTN_DEFAULTS.order && p.clearOnOpen === ATTN_DEFAULTS.clearOnOpen;
}

/**
 * Have you had this pane on the stage since it started wanting you?
 *
 * `active` is passed rather than read, both because this module owns no state and
 * because it is a genuinely separate reason: the pane you are looking at *right now*
 * counts as seen the instant it finishes, without waiting for a click it will never
 * get. A badge telling you to go and look at the thing filling your screen is noise.
 */
export const attnSeen = (s: Sess, active: boolean): boolean =>
  active || (s.attnAt > 0 && s.seenAt >= s.attnAt);

/**
 * Should this session drop out of the "needs you" set because you have already been
 * to it?
 *
 * **A blocking permission never clears.** Looking at a permission is not answering
 * one: Claude is stopped, doing nothing, until the decision is made, and a badge that
 * forgot about it because you glanced at the pane would be the one lie this feature
 * could tell that actually costs you work. Everything else — a finished turn, a turn
 * the API killed, a failed run — is information you have now received.
 */
export function attnCleared(s: Sess, p: AttnPrefs, active: boolean): boolean {
  if (!p.clearOnOpen) return false;
  if (s.attention) return false;
  return attnSeen(s, active);
}

/**
 * How far into its highlight this row is, or null when it isn't lit.
 *
 * The AGE rather than a boolean, because the driver has to be able to resume the fade
 * from where it is: the sidebar rebuilds its DOM on every telemetry burst, and a class
 * re-applied to a fresh node restarts the animation from zero. ./sidebar feeds this
 * straight into a negative `animation-delay`, exactly as ./peek does for its arming
 * hairline, so a lit row that is repainted six times keeps fading on schedule instead
 * of glowing for as long as the fleet is busy.
 *
 * Seen beats the clock even with `clearOnOpen` off: that switch is about the *badge*,
 * and a row that went on flashing at you while its pane was on screen would be arguing
 * with what you are already doing.
 */
export function attnFlash(s: Sess, p: AttnPrefs, active: boolean, now: number): number | null {
  if (!p.highlight || !s.attnAt) return null;
  if (attnSeen(s, active)) return null;
  const age = now - s.attnAt;
  return age >= 0 && age < p.highlightMs ? age : null;
}

/**
 * When the earliest live highlight goes out, or null when nothing is lit.
 *
 * The driver schedules one timeout to this rather than keeping an interval running —
 * an idle rail should cost nothing at all, and this is what makes that true. (The
 * fade itself is CSS; this is only what takes the class back off, which reduced
 * motion — where there is no fade, just a tint — depends on.)
 */
export function attnFlashDeadline(
  list: Iterable<Sess>, p: AttnPrefs, activeId: string | null, now: number,
): number | null {
  let at: number | null = null;
  for (const s of list) {
    if (attnFlash(s, p, s.id === activeId, now) === null) continue;
    const end = s.attnAt + p.highlightMs;
    if (at === null || end < at) at = end;
  }
  return at;
}

/**
 * The tiebreak the reactor's queue is sorted by *inside* one urgency tier.
 *
 * Newest-first is the default because of what the list is for: you come back to
 * Episko, something finished while you were away, and the thing you want is the one
 * that just landed — not the one that has been sitting there since before you left,
 * which is by definition the one you already decided not to deal with.
 */
export function attnOrder(p: AttnPrefs): (a: Sess, b: Sess) => number {
  return p.order === "recent" ? (a, b) => b.attnAt - a.attnAt : (a, b) => a.attnAt - b.attnAt;
}
