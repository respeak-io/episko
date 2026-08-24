// Sound alerts — the catalogue of what is worth hearing, the tones themselves, and
// the one function that decides whether a given moment actually rings.
//
// WHY THIS EXISTS. Episko is a cockpit for a fleet you are deliberately *not*
// watching: the whole point of running six agents is that you go and do something
// else. Every signal it has until now is visual — the sidebar glyph, the attention
// badge, the tray — and all three require the window to be in front of you. A
// blocked permission is the extreme case: Claude is stopped, doing nothing, until
// you answer, and nothing tells you.
//
// THE RULES ARE HERE AND THE AUDIO IS NOT. Everything below is data and pure
// functions over an explicit `now` — no `AudioContext`, no DOM, no ./state — so the
// awkward parts (what suppresses what, what a corrupt preference decays to) are
// unit-testable, and ./chime is left as a thin player that only has to turn a
// `Tone` into oscillators. Same split as ./peek and ./sidebar. See test/sound.test.ts.
//
// THE HARD PART IS NOT PLAYING A SOUND, IT IS NOT PLAYING SIX. Telemetry arrives in
// bursts — N agents each firing a hook per lifecycle event plus a statusLine — and
// the same real-world moment reaches us twice by design (a permission arrives as both
// the blocking `PermissionRequest` and a `Notification`; a session ending arrives as
// both `SessionEnd` and `pty-exit`). An unguarded `play()` per event turns a fleet
// into a fruit machine. `soundFor` is where that is prevented, and it is the reason
// this module exists as a decision rather than a call.

import type { Phase, Sess, SessKind } from "./types";

// ---------- the tones ----------
// Synthesised rather than shipped as audio files: a handful of oscillator envelopes
// is a few hundred bytes of data, needs no bundler asset handling, no decode, no
// network, and no license — and a two-note chime is not something a WAV does better.
/// Deliberately our own union rather than lib.dom's `OscillatorType`. It is assignable
/// to it, and this module promises to name no browser type.
export type Wave = "sine" | "triangle" | "square" | "sawtooth";
/// One oscillator in a tone. `at`/`ms` are milliseconds from the tone's start, so a
/// tone is a tiny score rather than a chain of callbacks; `gain` is relative to the
/// user's master volume, which is the only thing that scales the whole set.
export interface ToneStep { hz: number; at: number; ms: number; gain?: number; wave?: Wave }
export type ToneId =
  | "chime" | "arp" | "bell" | "ping" | "pop"
  | "knock" | "drop" | "alert" | "buzz" | "swell";
export interface Tone { id: ToneId; label: string; hint: string; steps: ToneStep[] }

// Pitches are real notes (A4 = 440) because intervals are what make two sounds
// distinguishable from another room — a rising fifth reads as "finished" and a
// falling one as "stopped" long before you have consciously identified either.
export const TONES: Tone[] = [
  { id: "chime", label: "Chime", hint: "Two-note rise", steps: [
    { hz: 880, at: 0, ms: 180 }, { hz: 1318.5, at: 100, ms: 320, gain: 0.85 } ] },
  { id: "arp", label: "Arpeggio", hint: "Three notes up", steps: [
    { hz: 523.25, at: 0, ms: 130 }, { hz: 659.25, at: 70, ms: 130 }, { hz: 783.99, at: 140, ms: 300 } ] },
  { id: "bell", label: "Bell", hint: "Struck, long decay", steps: [
    { hz: 659.25, at: 0, ms: 900 }, { hz: 987.77, at: 0, ms: 700, gain: 0.4 }, { hz: 1318.5, at: 0, ms: 450, gain: 0.22 } ] },
  { id: "ping", label: "Ping", hint: "One clear blip", steps: [
    { hz: 1174.66, at: 0, ms: 220 } ] },
  { id: "pop", label: "Pop", hint: "Barely there", steps: [
    { hz: 1568, at: 0, ms: 70, wave: "triangle", gain: 0.7 } ] },
  { id: "knock", label: "Knock", hint: "Two low taps", steps: [
    { hz: 196, at: 0, ms: 110, wave: "triangle" }, { hz: 174.61, at: 130, ms: 140, wave: "triangle" } ] },
  { id: "drop", label: "Drop", hint: "Two-note fall", steps: [
    { hz: 659.25, at: 0, ms: 150 }, { hz: 392, at: 110, ms: 340, gain: 0.9 } ] },
  { id: "alert", label: "Alert", hint: "Three urgent pips", steps: [
    { hz: 987.77, at: 0, ms: 90, wave: "square", gain: 0.45 },
    { hz: 987.77, at: 150, ms: 90, wave: "square", gain: 0.45 },
    { hz: 1318.5, at: 300, ms: 190, wave: "square", gain: 0.45 } ] },
  { id: "buzz", label: "Buzz", hint: "Low and wrong", steps: [
    { hz: 146.83, at: 0, ms: 150, wave: "sawtooth", gain: 0.5 },
    { hz: 110, at: 180, ms: 280, wave: "sawtooth", gain: 0.5 } ] },
  { id: "swell", label: "Swell", hint: "Soft, unhurried", steps: [
    { hz: 329.63, at: 0, ms: 700, gain: 0.7 }, { hz: 493.88, at: 120, ms: 640, gain: 0.45 } ] },
];
const TONE_IDS = TONES.map((t) => t.id);
/// An unknown id falls back to the first tone rather than throwing — this is reached
/// from a persisted preference, and a hand-edited `cc-sound` must not silence the app.
export function toneDef(id: ToneId): Tone { return TONES.find((t) => t.id === id) || TONES[0]; }
/// How long a tone rings, end to end. The player needs it to schedule; the settings
/// preview needs it to not stack previews on top of each other.
export function toneMs(t: Tone): number { return t.steps.reduce((n, s) => Math.max(n, s.at + s.ms), 0); }

// ---------- the catalogue ----------
/// Everything Episko is willing to make a noise about. Ordered by how much it wants
/// you, which is also the order the settings list shows.
export type SoundEvent =
  | "permission" | "question" | "done" | "error" | "taskFail"
  | "limit" | "taskDone" | "toolFail" | "ended" | "launched";

export interface SoundEventDef {
  id: SoundEvent; glyph: string; label: string; hint: string;
  /// The tone a fresh install uses, and what Reset returns to.
  tone: ToneId;
  /// Whether a fresh install has it on. The three that are off by default are the
  /// ones that fire *often* — a noise you learn to ignore has made every other
  /// noise worse, so opting in to them is the honest default.
  on: boolean;
  /// 3 urgent · 2 needs you · 1 informational · 0 background. Only read by the
  /// burst rule in `soundFor`: inside the gap, a louder event still gets through.
  priority: number;
}

export const SOUND_EVENTS: SoundEventDef[] = [
  { id: "permission", glyph: "◆", label: "Permission asked", priority: 3, tone: "alert", on: true,
    hint: "The agent is blocked and doing nothing until you answer." },
  { id: "question", glyph: "◇", label: "Notification", priority: 2, tone: "ping", on: true,
    hint: "Anything else the session raises: a question, a nudge, a plan to accept." },
  { id: "done", glyph: "●", label: "Your turn", priority: 2, tone: "chime", on: true,
    hint: "An agent finished its turn and is waiting on you." },
  { id: "error", glyph: "✕", label: "Turn failed", priority: 2, tone: "buzz", on: true,
    hint: "The API killed the turn: overloaded, rate limited, auth. A tool that failed is a different event." },
  { id: "taskFail", glyph: "▶", label: "Run failed", priority: 2, tone: "buzz", on: true,
    hint: "A task exited non-zero. Includes the ones that run by themselves after a turn." },
  { id: "limit", glyph: "▦", label: "Usage limit", priority: 2, tone: "bell", on: true,
    hint: "A rate-limit window crossed 50%, 80% or 95%. Account-wide, so it fires once, not once per session." },
  { id: "taskDone", glyph: "▶", label: "Run passed", priority: 1, tone: "arp", on: true,
    hint: "A task exited 0." },
  { id: "toolFail", glyph: "!", label: "Tool call failed", priority: 0, tone: "pop", on: false,
    hint: "A single tool errored mid-turn. Off by default: a failed grep is normal, and this fires every time." },
  { id: "ended", glyph: "·", label: "Session ended", priority: 0, tone: "drop", on: false,
    hint: "A session or terminal's process exited." },
  { id: "launched", glyph: "+", label: "Session launched", priority: 0, tone: "knock", on: false,
    hint: "You started a session. Off by default, since you were there." },
];
const EVENT_IDS = SOUND_EVENTS.map((e) => e.id);
export function soundEventDef(id: SoundEvent): SoundEventDef {
  return SOUND_EVENTS.find((e) => e.id === id) || SOUND_EVENTS[0];
}

// ---------- the preferences ----------
/// When sounds are allowed to play at all. `away` is the setting most people
/// actually want: the noise exists to reach you in another window, and hearing it
/// while you are looking straight at the pane that made it is pure annoyance.
export type SoundWhen = "always" | "away";
export interface SoundPrefs {
  enabled: boolean;
  /// 0–100. Not a raw amplitude — ./chime curves it, because linear gain sounds
  /// like nothing at all until about 60 and then like a siren.
  volume: number;
  when: SoundWhen;
  events: Record<SoundEvent, { on: boolean; tone: ToneId }>;
}

export const VOLUME_RANGE = { min: 0, max: 100 } as const;
export const VOLUME_STEP = 10;

function defaultEvents(): SoundPrefs["events"] {
  const out = {} as SoundPrefs["events"];
  for (const d of SOUND_EVENTS) out[d.id] = { on: d.on, tone: d.tone };
  return out;
}
/// Built fresh each read rather than shared, so a caller spreading `SOUND_DEFAULTS`
/// can never hand a mutated `events` map back to the store.
export const soundDefaults = (): SoundPrefs => ({ enabled: true, volume: 60, when: "always", events: defaultEvents() });

const clampNum = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

/**
 * Whatever came out of `localStorage` (or a settings control), made safe.
 *
 * The three things it has to survive, all of which have happened to the other JSON
 * blob preferences: a key that is simply absent (an older install), a value that was
 * hand-edited to nonsense, and — the one worth naming — an `events` map written
 * before an event existed. A new entry in `SOUND_EVENTS` must arrive switched to its
 * own default, not missing, or the row renders and the switch reads `undefined`.
 */
export function clampSoundPrefs(p: Partial<SoundPrefs> | null | undefined): SoundPrefs {
  const d = soundDefaults();
  const events = {} as SoundPrefs["events"];
  const raw = (p?.events ?? {}) as Partial<SoundPrefs["events"]>;
  for (const def of SOUND_EVENTS) {
    const got = raw[def.id];
    const tone = got?.tone as ToneId | undefined;
    events[def.id] = {
      on: typeof got?.on === "boolean" ? got.on : def.on,
      // An id we no longer ship (a renamed tone) decays to this event's own default
      // rather than to TONES[0] — the default is what the user would have picked.
      tone: tone && TONE_IDS.includes(tone) ? tone : def.tone,
    };
  }
  return {
    enabled: p?.enabled !== false,
    volume: clampNum(Number(p?.volume), VOLUME_RANGE.min, VOLUME_RANGE.max, d.volume),
    when: p?.when === "away" ? "away" : "always",
    events,
  };
}
/// Whether these are still the shipped defaults — what disables the Reset button.
export function isDefaultSoundPrefs(p: SoundPrefs): boolean {
  const d = soundDefaults();
  return p.enabled === d.enabled && p.volume === d.volume && p.when === d.when
    && EVENT_IDS.every((id) => p.events[id].on === d.events[id].on && p.events[id].tone === d.events[id].tone);
}

// ---------- the decision ----------
/// The two suppression windows. `GAP` is "these are the same burst" — telemetry from
/// one moment across several sessions lands inside a frame or two, and hearing it
/// once is the correct rendering of one event. `REPEAT` is longer and per-event,
/// because the duplicates that matter are *by design*: a permission arrives as both
/// the blocking hook and a Notification, and a session ending as both `SessionEnd`
/// and `pty-exit`. Neither is a bug to fix upstream — both really are two signals of
/// one fact, and one of the two is what makes the other reliable.
export const SOUND_GAP_MS = 350;
export const SOUND_REPEAT_MS = 1200;

/// What the player knows that this module cannot: whether the window has focus, and
/// what it last actually played.
export interface SoundGate {
  focused: boolean;
  lastAt: number;
  lastEv: SoundEvent | null;
}
export const SOUND_GATE_IDLE: SoundGate = { focused: true, lastAt: 0, lastEv: null };
const priority = (e: SoundEvent | null) => (e === null ? -1 : soundEventDef(e).priority);

/**
 * Should this moment make a noise, and with which tone? `null` means silence.
 *
 * The order of the checks is the order of the reasons, cheapest and most absolute
 * first: switched off, muted, the wrong side of the focus rule, this event switched
 * off, then the two burst windows.
 *
 * The last rule is the only interesting one: **inside the gap, a more urgent event
 * still gets through.** A permission landing 80ms after a "your turn" is not a
 * duplicate of it — it is the thing you actually need to hear, and swallowing it to
 * protect against bursts would suppress exactly the alert the feature exists for.
 */
export function soundFor(p: SoundPrefs, ev: SoundEvent, now: number, g: SoundGate): ToneId | null {
  if (!p.enabled || p.volume <= 0) return null;
  if (p.when === "away" && g.focused) return null;
  const cfg = p.events[ev];
  if (!cfg?.on) return null;
  const since = now - g.lastAt;
  if (g.lastEv === ev && since < SOUND_REPEAT_MS) return null;
  if (since < SOUND_GAP_MS && priority(ev) <= priority(g.lastEv)) return null;
  return cfg.tone;
}

// ---------- reading the moment off the session ----------
/// The three fields that decide whether a hook was worth hearing. Taken before
/// `applyHook` runs and again after, because the state machine is the thing that
/// knows what happened — re-deriving it from the raw payload here would be a second
/// copy of ./phase, and the second copy is always the one that gets it wrong.
export interface SoundSnap { phase: Phase; attention: string | null; apiErrAt: number | null }
export const soundSnap = (s: Sess): SoundSnap =>
  ({ phase: s.phase, attention: s.attention, apiErrAt: s.apiErr?.at ?? null });

/**
 * What (if anything) a telemetry event changed that is worth a noise.
 *
 * Attention outranks the phase deliberately: a session that ends a turn *and* raises
 * a permission in the same beat is asking you something, and "your turn" is the
 * weaker way to say so.
 *
 * The `error` / `toolFail` split is this codebase's oldest live distinction, and it
 * is a sound rule as much as a label one. `phase: "error"` is set by BOTH a failed
 * tool call mid-turn and a turn the API killed, and the first is *routine* — a grep
 * that matched nothing, a build that failed on purpose. Ringing the same alarm for
 * both trains you to ignore it within an hour. So a new `apiErr` stamp (which only
 * `StopFailure` writes) is the real failure, and everything else that reddens the
 * glyph is the opt-in `toolFail`.
 */
export function hookSound(before: SoundSnap, after: SoundSnap): SoundEvent | null {
  if (after.attention && after.attention !== before.attention) {
    return /permission/i.test(after.attention) ? "permission" : "question";
  }
  if (after.apiErrAt !== null && after.apiErrAt !== before.apiErrAt) return "error";
  if (after.phase === before.phase) return null;
  if (after.phase === "done") return "done";
  if (after.phase === "ended") return "ended";
  if (after.phase === "error") return "toolFail";
  return null;
}

/// A pane's process exited. A task's exit code IS its verdict; anything else just
/// stopped. (A Claude session normally rings this from `SessionEnd` a moment earlier
/// — `SOUND_REPEAT_MS` is what makes the pair one sound.)
export const exitSound = (kind: SessKind, code: number): SoundEvent =>
  kind === "task" ? (code === 0 ? "taskDone" : "taskFail") : "ended";

/// The rate-limit marks worth interrupting you for. Not a percentage-changed signal:
/// the number climbs continuously, and a chime per statusLine would be unbearable.
export const LIMIT_STEPS = [50, 80, 95];
/**
 * The highest mark this reading crossed that the previous one had not, or null.
 *
 * A window *reset* moves the number down, which crosses nothing — that is why this
 * compares two readings rather than testing a threshold outright.
 *
 * **The first reading of a run is a baseline, not a crossing.** `rl.h5` is null until
 * the first statusLine lands, and counting that from zero would ring the bell on
 * every single launch that starts above 50% — the one moment the sound is worth
 * least, because you are looking straight at the footer meter that already says so.
 */
export function limitCrossed(before: number | null, after: number | null): number | null {
  if (after == null || before == null) return null;
  let hit: number | null = null;
  for (const step of LIMIT_STEPS) if (after >= step && before < step) hit = step;
  return hit;
}
