// Sound alerts: the catalogue, the tones as data, and `soundFor`, which decides whether a
// moment rings. Pure functions over an explicit `now`; ./chime is the player. The hard
// part is playing one sound instead of six (docs/sounds.md).

import type { Phase, Sess, SessKind } from "./types";

// ---------- the tones ----------
// Synthesised rather than shipped as audio files: a few hundred bytes of data, no asset, no decode.
// Assignable to lib.dom's OscillatorType; this module promises to name no browser type.
export type Wave = "sine" | "triangle" | "square" | "sawtooth";
// `at`/`ms` are milliseconds from the tone's start; `gain` is relative to the master volume.
export interface ToneStep { hz: number; at: number; ms: number; gain?: number; wave?: Wave }
export type ToneId =
  | "chime" | "arp" | "bell" | "ping" | "pop"
  | "knock" | "drop" | "alert" | "buzz" | "swell";
export interface Tone { id: ToneId; label: string; hint: string; steps: ToneStep[] }

// Pitches are real notes (A4 = 440): intervals are what tell two sounds apart from another room.
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
// An unknown id falls back to the first tone: a hand-edited `cc-sound` must not silence the app.
export function toneDef(id: ToneId): Tone { return TONES.find((t) => t.id === id) || TONES[0]; }
export function toneMs(t: Tone): number { return t.steps.reduce((n, s) => Math.max(n, s.at + s.ms), 0); }

// ---------- the catalogue ----------
export type SoundEvent =
  | "permission" | "question" | "done" | "error" | "taskFail"
  | "limit" | "taskDone" | "toolFail" | "ended" | "launched";

export interface SoundEventDef {
  id: SoundEvent; glyph: string; label: string; hint: string;
  tone: ToneId;
  on: boolean;
  priority: number; // 3 urgent · 2 needs you · 1 info · 0 background; read only by soundFor's burst rule
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
export type SoundWhen = "always" | "away"; // "away": the noise exists to reach you in another window
export interface SoundPrefs {
  enabled: boolean;
  volume: number; // 0–100, not a raw amplitude; ./chime curves it
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
// Built fresh each read, so a caller spreading it can never hand a mutated `events` map back.
export const soundDefaults = (): SoundPrefs => ({ enabled: true, volume: 60, when: "always", events: defaultEvents() });

const clampNum = (n: number, lo: number, hi: number, dflt: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;

// Narrow whatever came out of localStorage. An `events` map written before an event
// existed must arrive with that event at its own default, not missing.
export function clampSoundPrefs(p: Partial<SoundPrefs> | null | undefined): SoundPrefs {
  const d = soundDefaults();
  const events = {} as SoundPrefs["events"];
  const raw = (p?.events ?? {}) as Partial<SoundPrefs["events"]>;
  for (const def of SOUND_EVENTS) {
    const got = raw[def.id];
    const tone = got?.tone as ToneId | undefined;
    events[def.id] = {
      on: typeof got?.on === "boolean" ? got.on : def.on,
      // A tone id we no longer ship decays to this event's default, not to TONES[0].
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
export function isDefaultSoundPrefs(p: SoundPrefs): boolean {
  const d = soundDefaults();
  return p.enabled === d.enabled && p.volume === d.volume && p.when === d.when
    && EVENT_IDS.every((id) => p.events[id].on === d.events[id].on && p.events[id].tone === d.events[id].tone);
}

// ---------- the decision ----------
// GAP: one moment's telemetry across sessions is one burst. REPEAT is per-event and longer,
// because the same fact arrives twice by design (PermissionRequest + Notification,
// SessionEnd + pty-exit) and neither half is a bug to fix upstream.
export const SOUND_GAP_MS = 350;
export const SOUND_REPEAT_MS = 1200;

export interface SoundGate {
  focused: boolean;
  lastAt: number;
  lastEv: SoundEvent | null;
}
export const SOUND_GATE_IDLE: SoundGate = { focused: true, lastAt: 0, lastEv: null };
const priority = (e: SoundEvent | null) => (e === null ? -1 : soundEventDef(e).priority);

// Cheapest and most absolute reason first. Inside the gap a more urgent event still gets
// through: a permission 80ms after "your turn" is the thing you need to hear.
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
// Taken before and after `applyHook`: the state machine is what knows what happened, and
// re-deriving it from the payload here would be a second copy of ./phase.
export interface SoundSnap {
  phase: Phase; attention: string | null; apiErrAt: number | null;
  reviving: boolean; // the revive watchdog already has a schedule; see hookSound's error rule
}
export const soundSnap = (s: Sess): SoundSnap =>
  ({ phase: s.phase, attention: s.attention, apiErrAt: s.apiErr?.at ?? null, reviving: !!s.revive });

// Attention outranks the phase: a turn that ends and raises a permission in one beat is
// asking you something. A new `apiErr` stamp (only StopFailure writes it) is the real
// failure; a tool that failed mid-turn is routine and gets the opt-in `toolFail`.
export function hookSound(before: SoundSnap, after: SoundSnap): SoundEvent | null {
  if (after.attention && after.attention !== before.attention) {
    return /permission/i.test(after.attention) ? "permission" : "question";
  }
  // A failure the watchdog is already handling is not news. The first still rings (Sess.revive
  // is null until ./actions schedules) and so does giving up; the ones between stay quiet.
  if (after.apiErrAt !== null && after.apiErrAt !== before.apiErrAt) return after.reviving ? null : "error";
  if (after.phase === before.phase) return null;
  if (after.phase === "done") return "done";
  if (after.phase === "ended") return "ended";
  if (after.phase === "error") return "toolFail";
  return null;
}

// A task's exit code is its verdict; anything else just stopped (SOUND_REPEAT_MS pairs it with SessionEnd).
export const exitSound = (kind: SessKind, code: number): SoundEvent =>
  kind === "task" ? (code === 0 ? "taskDone" : "taskFail") : "ended";

// Marks rather than a percentage-changed signal: a chime per statusLine would be unbearable.
export const LIMIT_STEPS = [50, 80, 95];
// The highest mark crossed between two readings, or null. A window reset moves the number
// down and crosses nothing; a first reading (before null) is a baseline, not a crossing.
export function limitCrossed(before: number | null, after: number | null): number | null {
  if (after == null || before == null) return null;
  let hit: number | null = null;
  for (const step of LIMIT_STEPS) if (after >= step && before < step) hit = step;
  return hit;
}
