// Bringing a session back after the API killed its turn — the rules for whether a
// failure is worth retrying, how long to wait, and when to stop trying.
//
// WHY THIS EXISTS. You start six agents on a long job and go to bed. At 03:40 the
// laptop's Wi-Fi power-saves the interface out from under `claude`, DNS stops
// resolving, Claude Code burns its own retries and the turn ends. Nothing is broken —
// the conversation is intact, the files are intact — but the session now sits at its
// prompt doing nothing, and it will still be sitting there at 08:00. The cost of a
// thirty-second outage is the whole night. That is the entire problem this solves:
// not lost work, *lost hours*, and the fix is one line of text typed into a REPL that
// was ready to carry on the moment the network came back.
//
// THE RULES ARE HERE AND THE TIMER IS NOT. Everything below is data and pure
// functions over an explicit `now` — no DOM, no ./state, no `invoke`, no renderer — so
// the parts that are actually dangerous (what must never be retried, what must never
// be typed into) are unit-testable, and the driver in ./actions is left with nothing to
// decide. Same split as ./attn, ./peek and ./sound. See test/revive.test.ts.
//
// THREE WAYS THIS COULD DO REAL DAMAGE, AND WHAT STOPS EACH.
//
//   1. **Typing into a session that is asking you something.** A blocking permission
//      leaves Claude stopped at a prompt that looks exactly like an idle one, and a
//      "continue" typed into it *answers* it — with whatever the first line of the
//      prompt happens to map to. So `s.attention` refuses outright, and it is checked
//      before anything else that could return `send`.
//   2. **Retrying a failure that will never succeed.** A dead API key fails in about
//      200ms, so an unguarded loop would spend the night typing into a session that
//      cannot possibly recover, burning the attempt budget it would have needed for
//      the real outage and filling the transcript with junk. `TERMINAL_KINDS` is that
//      list, and it is a denylist rather than an allowlist on purpose — see below.
//   3. **A fleet retrying in lockstep.** Six sessions die on the same 529 within a
//      second of each other, so six identical backoffs put all six back on the wire in
//      the same second, at which point they are the overload. `jitterPct` exists for
//      that and nothing else, which is why its default is not zero.
//
// WHY UNRECOGNISED FAILURES ARE RETRIED. Claude Code's `StopFailure` carries an `error`
// enum that Anthropic adds to, so this module will meet kinds it has never heard of.
// Guessing wrong in the "retry it" direction costs a handful of no-op turns, bounded by
// `attempts` and spaced by a ladder that is already minutes wide by its third rung.
// Guessing wrong in the "leave it alone" direction costs exactly what this module was
// written to prevent — a night — and does it silently, on the failure mode nobody
// anticipated, which is the only kind that matters at 03:40. So the unknown bucket is
// on by default and is a switch you can turn off, rather than a wall you cannot see.

// `ReviveState` is defined in ./types rather than here, for the reason `FileTouch` is:
// it is a field on `Sess`, and ./types imports nothing but ./format — putting the shape
// here and pointing `Sess` at it would make the two modules a cycle. The shape lives
// with the data model; every rule that reads or writes it lives here.
import { isAgent, type ReviveState, type Sess } from "./types";
export type { ReviveState };

// ---------- what kind of failure this was ----------

/// The failure buckets a user can switch on and off independently. Deliberately
/// coarser than Claude Code's raw `error` enum: "overloaded" and "server_error" are
/// one decision to almost everybody, but "rate limited" and "the network went away"
/// are genuinely different bets about how long to wait, and somebody who pays per
/// token may want the first off and the second on.
export type ReviveKind = "overloaded" | "rate_limit" | "server_error" | "network" | "other";

export interface ReviveKindDef { id: ReviveKind; label: string; glyph: string; hint: string }
/// Ordered by how confident we are that waiting fixes it, which is also the order the
/// settings list shows them in.
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

/// The `StopFailure` `error` values that a retry cannot fix: bad credentials, an
/// account problem, a malformed request, a model that isn't there. Retrying any of
/// these is not merely useless, it spends the attempt budget the real outage needs.
///
/// `max_output_tokens` is here for a different reason and is worth stating, because it
/// is the one entry that looks wrong: continuing after it genuinely *works*. But it is
/// not an outage — nothing is down, the turn simply produced more output than the cap
/// allows — and a job whose turns end that way ends every one of them that way, so the
/// watchdog would sit there driving a loop it can never finish while reporting itself
/// as riding out an incident. That is a decision for the person who wrote the prompt.
const TERMINAL_KINDS: ReadonlySet<string> = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error",
  "invalid_request", "model_not_found", "max_output_tokens",
]);

/// Raw kinds we recognise by name. Anything else falls through to the pattern below
/// and then to `"other"`.
const NAMED: Readonly<Record<string, ReviveKind>> = {
  overloaded: "overloaded", rate_limit: "rate_limit", server_error: "server_error",
};
/// A network failure reaches us under whatever name the transport gave it — Claude Code
/// has no enum member for "your DNS stopped answering", so the ENOTFOUND that started
/// all this arrives as free text. Matching the text is ugly and is meant to be: the
/// alternative is filing every real outage under `other`, where a user who switched that
/// bucket off would get no retry for the single most common overnight failure there is.
const NETWORKISH = /\b(e?notfound|econn|etimedout|enetunreach|ehostunreach|eai_again|dns|socket|network|offline|unreachable|timed?[ _-]?out|timeout|connect)/i;

/**
 * Which bucket a raw `StopFailure` kind falls into, or **null when it must never be
 * retried**.
 *
 * Null is the load-bearing return: every caller treats it as "stop", so a kind added to
 * `TERMINAL_KINDS` is switched off everywhere at once and cannot be re-enabled by a
 * preference. That asymmetry is deliberate — the buckets are the user's choice, the
 * terminal list is not.
 */
export function reviveKind(raw: string): ReviveKind | null {
  const k = (raw || "").trim().toLowerCase();
  if (TERMINAL_KINDS.has(k)) return null;
  if (NAMED[k]) return NAMED[k];
  return NETWORKISH.test(k) ? "network" : "other";
}

// ---------- the preferences ----------

export interface RevivePrefs {
  /// The master switch. **Off on a fresh install**, and that is not timidity: this is
  /// the one feature in the app that types into a terminal while nobody is watching,
  /// and a person who has not chosen that should never discover it by finding a prompt
  /// they did not send.
  enabled: boolean;
  /// How many continues one failure streak is worth before Episko stops and leaves the
  /// session for you. The cap is what makes every "retry it and see" decision above
  /// safe to get wrong.
  attempts: number;
  /// The first wait. Not zero and not close to it: Claude Code has *already* retried
  /// this request several times with its own backoff by the time `StopFailure` fires,
  /// so an instant continue is asking the same dead socket the same question.
  baseMs: number;
  /// What each rung multiplies the last by. 1 makes the ladder flat, which is a
  /// legitimate choice for a short outage you expect to clear.
  factor: number;
  /// The ceiling on any single wait, so a long ladder stays a ladder instead of
  /// disappearing over the horizon on its sixth rung.
  maxMs: number;
  /// How much to scatter each wait, as a percentage either side. The reason it is not
  /// zero by default is the whole fleet: identical backoffs on identical failures put
  /// every session back on the wire in the same second.
  jitterPct: number;
  /// Which failure buckets qualify. Order-insensitive; `reviveKind`'s null still wins.
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

/// Bounds, and each one is a real edge rather than taste.
/// - `attempts` at 1 is "try once and tell me"; past ~20 the ladder is longer than any
///   outage worth sleeping through and the cap has stopped being a safety net.
/// - `base` under 5s beats Claude Code's own exhausted backoff with a faster one.
/// - `max` at 4h is longer than the longest rate-limit window, which is the only thing
///   that justifies waiting that long at all.
export const REVIVE_ATTEMPTS_RANGE = { min: 1, max: 20 } as const;
export const REVIVE_BASE_RANGE = { min: 5_000, max: 600_000 } as const;
export const REVIVE_MAX_RANGE = { min: 30_000, max: 14_400_000 } as const;
export const REVIVE_FACTOR_RANGE = { min: 1, max: 4 } as const;
export const REVIVE_JITTER_RANGE = { min: 0, max: 50 } as const;
/// Steppers move in proportion to where they are: 5s at the bottom of a range whose top
/// is four hours would be 2,879 presses. Each returns the step to use *at* a value.
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
  // `=== true` rather than `!== false`, the opposite of every other switch in the app:
  // those default ON and need an explicit off to survive, this defaults OFF and needs an
  // explicit on. A corrupt or half-written blob must not start typing into terminals.
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
    // An empty list is kept rather than repaired to the defaults: "none of these"
    // is a coherent thing to have chosen, and it is exactly what the master switch
    // being on with nothing ticked should mean.
    kinds,
  };
}

/// Whether these are still the shipped defaults — what disables the Reset button.
export function isDefaultRevivePrefs(p: RevivePrefs): boolean {
  const d = REVIVE_DEFAULTS;
  return p.enabled === d.enabled && p.attempts === d.attempts && p.baseMs === d.baseMs
    && p.factor === d.factor && p.maxMs === d.maxMs && p.jitterPct === d.jitterPct
    && p.kinds.length === d.kinds.length && d.kinds.every((k) => p.kinds.includes(k));
}

// ---------- the ladder ----------

/**
 * How long to wait before attempt `n` (1-based), before jitter.
 *
 * Pure and jitter-free so the settings preview can show the ladder the user is actually
 * buying. The scatter is applied once, at schedule time, by `reviveJitter`.
 */
export function reviveDelay(p: RevivePrefs, n: number): number {
  const i = Math.max(1, Math.round(n));
  return Math.min(p.maxMs, Math.round(p.baseMs * Math.pow(p.factor, i - 1)));
}

/// One wait, scattered. `rand` is injected rather than reaching for `Math.random` so a
/// test can pin it; the default is the only thing production passes.
export function reviveJitter(ms: number, p: RevivePrefs, rand: () => number = Math.random): number {
  if (p.jitterPct <= 0) return ms;
  const span = ms * (p.jitterPct / 100);
  return Math.max(0, Math.round(ms + (rand() * 2 - 1) * span));
}

/// Every rung, in order. The settings preview draws this, and reading it back is the
/// only way to tell what a factor of 1.75 actually means.
export const revivePlan = (p: RevivePrefs): number[] =>
  Array.from({ length: p.attempts }, (_, i) => reviveDelay(p, i + 1));

/**
 * The outage this configuration rides out, end to end.
 *
 * The single most useful number in the settings panel, because it is the question the
 * user actually has ("will this survive the night?") and none of the five knobs answers
 * it alone. Jitter is ignored: it is symmetric, so it moves this by nothing on average
 * and would only make the headline figure wobble between repaints.
 */
export const reviveWindowMs = (p: RevivePrefs): number =>
  revivePlan(p).reduce((n, ms) => n + ms, 0);

// ---------- the per-session schedule ----------

// `ReviveState` (the schedule this module writes onto a session) is defined in ./types
// and re-exported at the top of this file, so a reader who follows the rules here does
// not have to go and find the shape they operate on. Two things about it are load-
// bearing enough to restate where they are enforced rather than where they are declared:
// `attempts` survives the turns a continue starts (or the ladder flattens into a fixed
// hammer — see the `send` branch below), and `errAt` re-times the ladder from the moment
// a failure happened rather than from whenever the tick noticed it.

/// Why a tick did nothing. Every one of these is a question somebody will ask the debug
/// console at 08:00 ("it was off?" / "it never even tried?"), and a bare boolean cannot
/// answer it. ./actions logs the ones worth logging.
export type ReviveSkip =
  | "off" | "not-agent" | "external" | "no-failure" | "attention"
  | "kind" | "exhausted" | "waiting" | "offline";

export type ReviveAction =
  | { do: "none"; why: ReviveSkip }
  | { do: "schedule"; state: ReviveState }
  | { do: "send"; state: ReviveState; prompt: string }
  | { do: "giveup"; state: ReviveState };

/**
 * What Episko types when it brings a session back.
 *
 * PURE ASCII, deliberately. `write_pty` does not send a non-ASCII character as bytes on
 * Windows: ConPTY would deliver it on a key-up record that `_getwch` never reads, so it
 * goes out as a win32 input record instead (see CLAUDE.md). That path is well tested and
 * would very probably be fine; it is simply not worth exercising on the one write in the
 * app that happens while nobody is awake to notice it came out wrong. An em dash bought
 * nothing here.
 *
 * Two sentences, and both earn their place. The first says *why* there is a message at
 * all, because the agent's own view is that it was mid-task and then the user said
 * something — without this it reads as an interruption and tends to summarise instead of
 * resume. The second exists because the failure lands at an unknowable point: the tool
 * call whose response never arrived may well have completed, and an agent that assumes
 * either way is the one that double-applies a migration or skips a commit. Asking it to
 * look is the difference between a resumed job and a corrupted one.
 */
export const REVIVE_PROMPT =
  "Your previous turn was cut short by an API error, not by me. Nothing about the task has changed. "
  + "Check the current state of whatever you were part-way through before assuming it did or didn't land, then carry on.";

/**
 * The whole decision, for one session, at one instant.
 *
 * Returns what to *do*, never doing it: the driver applies the returned state to the
 * session and (for `send`) writes the prompt. That split is what makes every rule above
 * testable without a PTY, and it is why this function takes `online` rather than reading
 * `navigator` — the browser global would put this module out of reach of the node-env
 * test suite, which is where it needs to be most.
 *
 * **`online: false` does not consume an attempt.** It returns `waiting`-shaped nothing
 * and leaves `dueAt` in the past, so the instant the interface comes back the next tick
 * sends immediately. Spending a retry on a request that cannot leave the machine is
 * spending the budget on the outage instead of on the recovery — and for the failure
 * this feature exists for (the laptop's Wi-Fi napping), *every* attempt would be spent
 * that way.
 */
export function reviveStep(
  s: Sess, p: RevivePrefs, now: number, online: boolean, rand: () => number = Math.random,
): ReviveAction {
  if (!p.enabled) return { do: "none", why: "off" };
  // A shell or task pane has no conversation to resume, and no REPL to type into.
  if (!isAgent(s)) return { do: "none", why: "not-agent" };
  // The terminal is in Ghostty/iTerm; Episko holds no PTY for it and `write_pty` has
  // nothing to write to. Nothing here can help an external session.
  if (s.external) return { do: "none", why: "external" };
  // The ONLY state worth reviving: a turn the API killed. Note this is deliberately
  // narrower than `phase === "error"`, which a failed tool call also produces — a grep
  // that matched nothing is not an outage, and typing at it would be nonsense.
  if (s.phase !== "error" || !s.apiErr) return { do: "none", why: "no-failure" };
  // Guard 1 from the header. Highest-priority check that can block a send, because it
  // is the one whose failure mode is destructive rather than merely useless.
  if (s.attention) return { do: "none", why: "attention" };
  // NO FAN-OUT GUARD HERE, and that is a deliberate reversal rather than an omission.
  // Holding off while `liveFanout` reads non-null is the obvious instinct — don't type
  // at a session whose fleet is still working — and it is wrong in exactly this state.
  // `subagents` is `SubagentStart` minus `SubagentStop`, and agents killed by the same
  // outage that killed the parent turn never send their Stop, so the counter stays high
  // with nothing behind it. Worse, the `Workflow` call that owned them died with the
  // turn, so there is no live tool call for a continue to collide with. A guard here
  // would therefore stand down for the full `FANOUT_DEAD_MS` hour in precisely the
  // scenario this feature exists for — a fleet and its parent going down together — and
  // the hour it cost would be the hour it was supposed to save.
  //
  // (`bgWaiting` cannot be used for it in any case: it requires `done` or `idle`, so on a
  // session this function has already narrowed to `error` it is false by construction.)

  const kind = reviveKind(s.apiErr.kind);
  if (!kind || !p.kinds.includes(kind)) return { do: "none", why: "kind" };

  const st = s.revive;
  const spent = st?.attempts ?? 0;
  if (spent >= p.attempts) {
    return st && !st.gaveUp ? { do: "giveup", state: { ...st, gaveUp: true } } : { do: "none", why: "exhausted" };
  }
  // A failure we have not scheduled for yet — either the first of a streak or the one
  // that followed the continue we just typed. Either way the next rung is timed from
  // when it happened, not from when this tick ran.
  if (!st || st.errAt !== s.apiErr.at) {
    const wait = reviveJitter(reviveDelay(p, spent + 1), p, rand);
    return {
      do: "schedule",
      state: { attempts: spent, errAt: s.apiErr.at, dueAt: s.apiErr.at + wait, lastAt: st?.lastAt ?? 0, gaveUp: false },
    };
  }
  if (now < st.dueAt) return { do: "none", why: "waiting" };
  if (!online) return { do: "none", why: "offline" };
  // `dueAt` moves to the *next* rung as part of sending. Without that, a send that
  // provokes no new `StopFailure` — the session is wedged, the write went nowhere —
  // would leave `dueAt` in the past and the next tick would send again, and the tick
  // after that, until the budget was gone in under a minute.
  const nextWait = reviveJitter(reviveDelay(p, spent + 2), p, rand);
  return {
    do: "send",
    state: { ...st, attempts: spent + 1, lastAt: now, dueAt: now + nextWait },
    prompt: REVIVE_PROMPT,
  };
}

// ---------- what the inspector says about it ----------

/// A gap in the fewest characters that stay unambiguous — "45s", "12m", "1h 30m". The
/// ladder is a row of these, so `fmtDur`'s "2m 00s" would be four columns of noise.
export function reviveGap(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/**
 * The one line the inspector's error card adds, or null when there is nothing to say.
 *
 * Written from the reader's position at 08:00 with a cold cup of coffee: the question is
 * never "what is the state machine doing" but "did it come back, and if not, when did it
 * stop trying". So the give-up line leads with the count — that number is the whole
 * story of the night.
 */
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

/// When the earliest scheduled continue comes due, or null when nothing is waiting.
/// The driver polls on a fixed tick rather than scheduling to this — a sleeping Wi-Fi
/// interface is not an event anything fires — but the debug snapshot shows it, and it is
/// the honest answer to "what is this thing waiting for".
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
