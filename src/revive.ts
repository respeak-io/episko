// Bringing a session back after the API killed its turn: which failures a retry can fix,
// the backoff ladder, and what must never be typed into. Pure functions over an explicit
// `now`; the driver (`tickRevive` in ./actions) decides nothing. See docs/sessions.md.

// `ReviveState` is a `Sess` field, so it lives in ./types; defining it here would be a cycle.
import { isAgent, type ReviveState, type Sess } from "./types";
export type { ReviveState };

// ---------- what kind of failure this was ----------

/** Failure buckets a user can switch independently; coarser than Claude Code's raw `error` enum. */
export type ReviveKind = "overloaded" | "rate_limit" | "server_error" | "network" | "other";

export interface ReviveKindDef { id: ReviveKind; label: string; glyph: string; hint: string }
// Ordered by how sure we are that waiting fixes it; the settings list shows this order.
export const REVIVE_KINDS: ReviveKindDef[] = [
  { id: "overloaded", glyph: "▤", label: "Overloaded",
    hint: "The 529 everyone gets at peak. Waiting is the entire fix." },
  { id: "network", glyph: "⚡", label: "Network gone",
    hint: "DNS or the socket failed — usually the machine's Wi-Fi napping rather than anything Anthropic did." },
  { id: "server_error", glyph: "!", label: "Server error",
    hint: "A 5xx that isn't capacity. Usually transient, occasionally not." },
  { id: "rate_limit", glyph: "◷", label: "Rate limited",
    hint: "Your own quota, not the API's health. The wait that clears it can be hours, so let the ladder run long." },
  { id: "other", glyph: "?", label: "Unrecognised failures",
    hint: "A failure kind Episko doesn't have a name for — including any Anthropic adds after this build. Off means a new kind of outage silently gets no retry." },
];

// Kinds a retry cannot fix; no preference re-enables them. `max_output_tokens` is not an outage,
// but a job whose turns end that way ends every one of them that way: the prompt author's call.
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error",
  "invalid_request", "model_not_found", "max_output_tokens",
]);

const NAMED: Readonly<Record<string, ReviveKind>> = {
  overloaded: "overloaded", rate_limit: "rate_limit", server_error: "server_error",
};
// Claude Code names no network failure; matching the transport's free text keeps it out of `other`.
const NETWORKISH = /\b(e?notfound|econn|etimedout|enetunreach|ehostunreach|eai_again|dns|socket|network|offline|unreachable|timed?[ _-]?out|timeout|connect)/i;

/** The bucket a raw `StopFailure` kind falls into, or null when it must never be retried. */
export function reviveKind(raw: string): ReviveKind | null {
  const k = (raw || "").trim().toLowerCase();
  if (TERMINAL_KINDS.has(k)) return null;
  if (NAMED[k]) return NAMED[k];
  return NETWORKISH.test(k) ? "network" : "other";
}

// ---------- the preferences ----------

export interface RevivePrefs {
  enabled: boolean; // off on a fresh install: the one feature that types into a terminal unattended
  attempts: number; // per failure streak
  baseMs: number; // first wait; Claude Code has already exhausted its own backoff when StopFailure fires
  factor: number;
  maxMs: number;
  jitterPct: number; // scatter either side, so a fleet that failed together does not retry in lockstep
  kinds: ReviveKind[];
}

export const REVIVE_DEFAULTS: RevivePrefs = {
  enabled: false,
  attempts: 6,
  baseMs: 30_000,
  factor: 2,
  maxMs: 900_000,
  jitterPct: 20,
  kinds: ["overloaded", "network", "server_error", "rate_limit", "other"],
};

// Each bound is a real edge: `base` under 5s would beat Claude Code's own exhausted backoff,
// `max` at 4h covers the longest rate-limit window, and past ~20 attempts the cap is no safety net.
export const REVIVE_ATTEMPTS_RANGE = { min: 1, max: 20 } as const;
export const REVIVE_BASE_RANGE = { min: 5_000, max: 600_000 } as const;
export const REVIVE_MAX_RANGE = { min: 30_000, max: 14_400_000 } as const;
export const REVIVE_FACTOR_RANGE = { min: 1, max: 4 } as const;
export const REVIVE_JITTER_RANGE = { min: 0, max: 50 } as const;
// Step sizes follow the value: a flat 5s step across a four-hour range would be thousands of presses.
export const reviveBaseStep = (v: number) => (v < 60_000 ? 5_000 : v < 300_000 ? 30_000 : 60_000);
export const reviveMaxStep = (v: number) => (v < 300_000 ? 30_000 : v < 3_600_000 ? 300_000 : 1_800_000);
export const REVIVE_FACTOR_STEP = 0.25;
export const REVIVE_JITTER_STEP = 10;

const clampNum = (n: unknown, lo: number, hi: number, dflt: number, round: (x: number) => number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, round(v))) : dflt;
};
const KIND_IDS = REVIVE_KINDS.map((k) => k.id);

/** Whatever `localStorage` held (or a stepper produced), made safe. */
export function clampRevivePrefs(p: Partial<RevivePrefs> | null | undefined): RevivePrefs {
  // `=== true`, not `!== false` like the other switches: a corrupt blob must not start typing.
  const enabled = p?.enabled === true;
  const kinds = Array.isArray(p?.kinds)
    ? KIND_IDS.filter((k) => (p!.kinds as unknown[]).includes(k))
    : REVIVE_DEFAULTS.kinds;
  return {
    enabled,
    attempts: clampNum(p?.attempts, REVIVE_ATTEMPTS_RANGE.min, REVIVE_ATTEMPTS_RANGE.max, REVIVE_DEFAULTS.attempts, Math.round),
    baseMs: clampNum(p?.baseMs, REVIVE_BASE_RANGE.min, REVIVE_BASE_RANGE.max, REVIVE_DEFAULTS.baseMs, Math.round),
    factor: clampNum(p?.factor, REVIVE_FACTOR_RANGE.min, REVIVE_FACTOR_RANGE.max, REVIVE_DEFAULTS.factor, (x) => Math.round(x * 100) / 100),
    maxMs: clampNum(p?.maxMs, REVIVE_MAX_RANGE.min, REVIVE_MAX_RANGE.max, REVIVE_DEFAULTS.maxMs, Math.round),
    jitterPct: clampNum(p?.jitterPct, REVIVE_JITTER_RANGE.min, REVIVE_JITTER_RANGE.max, REVIVE_DEFAULTS.jitterPct, Math.round),
    kinds, // an empty list is a choice ("none of these"), not damage to repair
  };
}

export function isDefaultRevivePrefs(p: RevivePrefs): boolean {
  const d = REVIVE_DEFAULTS;
  return p.enabled === d.enabled && p.attempts === d.attempts && p.baseMs === d.baseMs
    && p.factor === d.factor && p.maxMs === d.maxMs && p.jitterPct === d.jitterPct
    && p.kinds.length === d.kinds.length && d.kinds.every((k) => p.kinds.includes(k));
}

// ---------- the ladder ----------

/** Jitter-free so the settings preview shows the real ladder; `reviveJitter` scatters at schedule time. */
export function reviveDelay(p: RevivePrefs, n: number): number {
  const i = Math.max(1, Math.round(n));
  return Math.min(p.maxMs, Math.round(p.baseMs * Math.pow(p.factor, i - 1)));
}

export function reviveJitter(ms: number, p: RevivePrefs, rand: () => number = Math.random): number {
  if (p.jitterPct <= 0) return ms;
  const span = ms * (p.jitterPct / 100);
  return Math.max(0, Math.round(ms + (rand() * 2 - 1) * span));
}

export const revivePlan = (p: RevivePrefs): number[] =>
  Array.from({ length: p.attempts }, (_, i) => reviveDelay(p, i + 1));

/** The outage this ladder rides out end to end; jitter is symmetric, so it is ignored. */
export const reviveWindowMs = (p: RevivePrefs): number =>
  revivePlan(p).reduce((n, ms) => n + ms, 0);

// ---------- the per-session schedule ----------

export type ReviveSkip =
  | "off" | "not-agent" | "external" | "no-failure" | "attention"
  | "kind" | "exhausted" | "waiting" | "offline";

export type ReviveAction =
  | { do: "none"; why: ReviveSkip }
  | { do: "schedule"; state: ReviveState }
  | { do: "send"; state: ReviveState; prompt: string }
  | { do: "giveup"; state: ReviveState };

// Pure ASCII: a non-ASCII character takes `write_pty`'s win32 input-record path on Windows, not
// worth exercising on the one write nobody is awake to check. Both sentences matter: the first
// stops the agent treating this as an interruption; the second makes it check what landed first.
export const REVIVE_PROMPT =
  "Your previous turn was cut short by an API error, not by me. Nothing about the task has changed. "
  + "Check the current state of whatever you were part-way through before assuming it did or didn't land, then carry on.";

// Returns what to do, never doing it. `online` is a parameter: tests run with no `navigator`.
export function reviveStep(
  s: Sess, p: RevivePrefs, now: number, online: boolean, rand: () => number = Math.random,
): ReviveAction {
  if (!p.enabled) return { do: "none", why: "off" };
  if (!isAgent(s)) return { do: "none", why: "not-agent" };
  if (s.external) return { do: "none", why: "external" }; // Episko holds no PTY for it
  // Only a turn the API killed: `phase === "error"` alone also covers a failed tool call.
  if (s.phase !== "error" || !s.apiErr) return { do: "none", why: "no-failure" };
  // Checked before anything that can send: a continue typed at a blocking permission answers it.
  if (s.attention) return { do: "none", why: "attention" };
  // No fan-out guard, on purpose: agents killed with their parent never send SubagentStop, so
  // `liveCount` would hold this off for an hour with nothing behind it (docs/sessions.md).

  const kind = reviveKind(s.apiErr.kind);
  if (!kind || !p.kinds.includes(kind)) return { do: "none", why: "kind" };

  const st = s.revive;
  const spent = st?.attempts ?? 0;
  if (spent >= p.attempts) {
    return st && !st.gaveUp ? { do: "giveup", state: { ...st, gaveUp: true } } : { do: "none", why: "exhausted" };
  }
  // Not yet scheduled for this failure: time it from when it happened; `attempts` must carry over.
  if (!st || st.errAt !== s.apiErr.at) {
    const wait = reviveJitter(reviveDelay(p, spent + 1), p, rand);
    return {
      do: "schedule",
      state: { attempts: spent, errAt: s.apiErr.at, dueAt: s.apiErr.at + wait, lastAt: st?.lastAt ?? 0, gaveUp: false },
    };
  }
  if (now < st.dueAt) return { do: "none", why: "waiting" };
  if (!online) return { do: "none", why: "offline" };
  // Sending moves `dueAt` to the next rung, or a write that goes nowhere would be resent every tick.
  const nextWait = reviveJitter(reviveDelay(p, spent + 2), p, rand);
  return {
    do: "send",
    state: { ...st, attempts: spent + 1, lastAt: now, dueAt: now + nextWait },
    prompt: REVIVE_PROMPT,
  };
}

// ---------- what the inspector says about it ----------

// "45s", "12m", "1h 30m": the ladder is a row of these, so fmtDur's "2m 00s" would be noise.
export function reviveGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function reviveStatus(s: Sess, p: RevivePrefs, now: number): string | null {
  const st = s.revive;
  if (!st) return null;
  if (st.gaveUp || st.attempts >= p.attempts) {
    return st.attempts > 0
      ? `Gave up after ${st.attempts} ${st.attempts === 1 ? "try" : "tries"}`
      : "Not retrying this one";
  }
  const left = Math.max(0, st.dueAt - now);
  const nth = `try ${st.attempts + 1} of ${p.attempts}`;
  return `Retrying in ${reviveGap(left)} · ${nth}`;
}

export function reviveDeadline(list: Iterable<Sess>, p: RevivePrefs, now: number): number | null {
  if (!p.enabled) return null;
  let at: number | null = null;
  for (const s of list) {
    const st = s.revive;
    if (!st || st.gaveUp || st.attempts >= p.attempts) continue;
    if (s.phase !== "error" || !s.apiErr || s.attention) continue;
    if (st.dueAt < now) return now; // already overdue — the next tick sends it
    if (at === null || st.dueAt < at) at = st.dueAt;
  }
  return at;
}
