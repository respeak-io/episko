// When a session starts wanting you: the row highlight, the badge's queue order, and what opening
// a pane does to it. Pure functions over an explicit `now`; ./sidebar drives the timers.

import type { Sess } from "./types";

export type AttnOrder = "recent" | "waiting";

export interface AttnPrefs {
  highlight: boolean;
  highlightMs: number;  // the light fades over the whole span rather than switching off at the end
  order: AttnOrder;     // within an urgency tier; a blocking permission still outranks a finished turn
  clearOnOpen: boolean;
}

export const ATTN_DEFAULTS: AttnPrefs = {
  highlight: true, highlightMs: 4000, order: "recent", clearOnOpen: true,
};

// Under ~800ms the fade reads as flicker; the cap keeps a burst of finishes from glowing for a minute.
export const ATTN_HIGHLIGHT_RANGE = { min: 800, max: 20000 } as const;
export const ATTN_HIGHLIGHT_STEP = 400;

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
export function isDefaultAttnPrefs(p: AttnPrefs): boolean {
  return p.highlight === ATTN_DEFAULTS.highlight && p.highlightMs === ATTN_DEFAULTS.highlightMs
    && p.order === ATTN_DEFAULTS.order && p.clearOnOpen === ATTN_DEFAULTS.clearOnOpen;
}

// The active pane counts as seen the instant it finishes: it is already on screen.
export const attnSeen = (s: Sess, active: boolean): boolean =>
  active || (s.attnAt > 0 && s.seenAt >= s.attnAt);

// A blocking permission never clears: looking at one is not answering it.
export function attnCleared(s: Sess, p: AttnPrefs, active: boolean): boolean {
  if (!p.clearOnOpen) return false;
  if (s.attention) return false;
  return attnSeen(s, active);
}

// The age rather than a boolean, so ./sidebar can resume the fade via a negative `animation-delay`.
// Seen ends the flash even with `clearOnOpen` off: that switch is about the badge, not the row.
export function attnFlash(s: Sess, p: AttnPrefs, active: boolean, now: number): number | null {
  if (!p.highlight || !s.attnAt) return null;
  if (attnSeen(s, active)) return null;
  const age = now - s.attnAt;
  return age >= 0 && age < p.highlightMs ? age : null;
}

// When the earliest live highlight goes out; the driver schedules one timeout to it, not an interval.
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

// The tiebreak inside one urgency tier.
export function attnOrder(p: AttnPrefs): (a: Sess, b: Sess) => number {
  return p.order === "recent" ? (a, b) => b.attnAt - a.attnAt : (a, b) => a.attnAt - b.attnAt;
}
