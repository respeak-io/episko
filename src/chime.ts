// The player. ./sound decides *whether* and *which*; this turns a `Tone` into
// oscillators and is the only file in the app that touches Web Audio.
//
// Untested by design, like every module that owns a live browser resource — an
// `AudioContext` is not something a vitest node run can hold, and a test that mocked
// one would be asserting against the mock. What is worth testing (the catalogue, the
// clamping, the burst suppression) is in ./sound, which this imports and cannot be
// imported by.
//
// TWO THINGS THIS FILE EXISTS TO GET RIGHT, both of which are silent when wrong:
//
// **The context starts suspended.** Every engine's autoplay policy refuses audio
// until the page has seen a user gesture, and a WebView is no exception — Episko's
// first sound is very often a permission alert that arrives while nobody has clicked
// anything for ten minutes. So the context is created lazily and `resume()`d on every
// play, and a one-shot gesture listener wakes it the moment the app is touched. The
// failure without that is not an error anywhere: it is a permission that never made a
// noise, which is indistinguishable from the feature being off.
//
// **A gate-shaped envelope clicks.** Starting an oscillator at full gain and stopping
// it puts a step discontinuity in the buffer, which is a pop, and ten of those an hour
// is worse than no sound at all. Every step gets a short attack and an exponential
// decay instead, and the ramps only ever run to a small positive value because
// `exponentialRampToValueAtTime` is undefined at zero.

import { soundPrefs } from "./state";
import {
  soundFor, SOUND_GATE_IDLE, toneDef, toneMs,
  type SoundEvent, type SoundGate, type ToneId,
} from "./sound";

// ./debug is a render-layer module, so it arrives as a settable hook rather than an
// import (PLAN seam rule 2) — the same arrangement ./rl uses for the same reason.
// Worth logging: "why was there no noise" is otherwise unanswerable from outside.
let log: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setSoundLogger(fn: typeof log) { log = fn; }

/// Peak amplitude of a single step at 100% volume. Low on purpose: several steps can
/// overlap (see the bell), and the sum must not clip. Loudness lives in the volume
/// curve below, not here.
const PEAK = 0.22;
const ATTACK = 0.008;
/// The exponential ramps' floor — silence, as far as anyone can hear, and positive,
/// which the Web Audio ramp requires.
const ZERO = 0.0001;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/// Set once we have failed to build a context, so a browser without Web Audio (or a
/// WebView that refused) costs one attempt rather than one per event forever.
let dead = false;

function audio(): AudioContext | null {
  if (ctx || dead) return ctx;
  const Ctor: typeof AudioContext | undefined =
    typeof window === "undefined" ? undefined
      : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) { dead = true; log("warn", "sound: no Web Audio in this webview, so alerts are silent"); return null; }
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
  } catch (e) {
    dead = true;
    log("warn", `sound: could not open an audio context (${String(e)})`);
    return null;
  }
  return ctx;
}

// The gesture that unlocks the context. Registered once at module scope — this module
// is only ever imported by the wiring layer, which is what makes that legal — and
// `once`, because after the first resume the context stays running for the app's life.
// Nothing here plays: it exists purely so the FIRST alert is audible rather than the
// second. `capture` so it still fires for handlers that stop propagation.
if (typeof document !== "undefined") {
  const wake = () => { const c = audio(); if (c && c.state === "suspended") void c.resume(); };
  document.addEventListener("pointerdown", wake, { once: true, capture: true });
  document.addEventListener("keydown", wake, { once: true, capture: true });
}

/// 0–100 → amplitude. Loudness is roughly the square of amplitude, so a linear slider
/// spends its bottom half inaudible and its top half painful; this spreads the useful
/// range across the whole control.
const amplitude = (volume: number) => Math.pow(Math.max(0, Math.min(100, volume)) / 100, 1.8) * PEAK;

function ring(id: ToneId, volume: number) {
  const c = audio();
  if (!c || !master || volume <= 0) return;
  // Cheap and idempotent, and the only thing standing between a backgrounded app and
  // silence: a WebView may suspend the context whenever it likes, not just at startup.
  if (c.state === "suspended") void c.resume();
  const tone = toneDef(id);
  const amp = amplitude(volume);
  // A hair in the future: scheduling at exactly `currentTime` is scheduling in the past
  // by the time the node exists, and the runtime's repair for that is an audible click.
  const t0 = c.currentTime + 0.01;
  for (const st of tone.steps) {
    const start = t0 + st.at / 1000;
    const end = start + st.ms / 1000;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = st.wave ?? "sine";
    osc.frequency.setValueAtTime(st.hz, start);
    // A step shorter than the attack would ramp up past its own end and never come
    // back down — which is the one envelope that rings on forever.
    const atk = Math.min(ATTACK, (end - start) * 0.4);
    g.gain.setValueAtTime(ZERO, start);
    g.gain.exponentialRampToValueAtTime(Math.max(ZERO, amp * (st.gain ?? 1)), start + atk);
    g.gain.exponentialRampToValueAtTime(ZERO, end);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
    // Nodes are not garbage until they are disconnected; an app that runs for days
    // and rings a few thousand times would otherwise keep every one of them.
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }
}

// What ./sound cannot see: whether anyone is looking, and what was last heard. Held
// here rather than in ./state because nothing else in the app has any use for it and
// it is not worth persisting — a fresh run should never suppress its first sound.
let gate: SoundGate = SOUND_GATE_IDLE;

/**
 * An event happened. Rings if the user's preferences and the burst rules say so.
 *
 * Every caller fires this unconditionally and lets `soundFor` decide — the call sites
 * (the telemetry handler, the exit handler, `launch`) must not grow a second copy of
 * the "is sound on?" question, or turning it off in one place and not the other is a
 * bug nobody can hear.
 */
export function playSound(ev: SoundEvent) {
  const now = Date.now();
  // `document.hasFocus()` and not `visibilityState`: a window that is merely behind
  // another one is still "visible", and that is exactly the case the `away` setting
  // is about.
  const focused = typeof document !== "undefined" && document.hasFocus();
  const tone = soundFor(soundPrefs, ev, now, { ...gate, focused });
  if (!tone) return;
  gate = { focused, lastAt: now, lastEv: ev };
  ring(tone, soundPrefs.volume);
  log("info", `sound ${ev} · ${tone}`);
}

/**
 * Play something because the user asked to hear it, in Settings.
 *
 * Deliberately NOT `playSound`: a preview must ignore the focus rule (you are looking
 * straight at the settings window, which is the one moment `away` would silence
 * everything), the per-event switch (you are auditioning a row you may be about to
 * switch on) and the burst gate (clicking through tones is meant to be rapid). The one
 * thing it honours is the volume, because that is usually what is being judged. It
 * also leaves `gate` alone, so an audition can never suppress a real alert that lands
 * mid-click.
 */
export function previewTone(id: ToneId) { ring(id, soundPrefs.volume); }
export function previewEvent(ev: SoundEvent) { previewTone(soundPrefs.events[ev].tone); }
/// How long a preview will ring, so a caller can pace a sequence of them.
export const previewMs = (id: ToneId) => toneMs(toneDef(id));
