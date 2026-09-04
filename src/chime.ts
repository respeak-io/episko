// The player: ./sound decides whether and which; this turns a `Tone` into oscillators and is
// the only file that touches Web Audio, so it is untested by design.

import { soundPrefs } from "./state";
import {
  soundFor, SOUND_GATE_IDLE, toneDef, toneMs,
  type SoundEvent, type SoundGate, type ToneId,
} from "./sound";

// ./debug is render-layer, so the logger arrives as a settable hook, as ./rl's does.
let log: (lvl: "info" | "warn" | "error", msg: string) => void = () => {};
export function setSoundLogger(fn: typeof log) { log = fn; }

const PEAK = 0.22; // per-step peak at 100%: steps overlap (the bell) and the sum must not clip
const ATTACK = 0.008;
const ZERO = 0.0001; // the ramps' floor: `exponentialRampToValueAtTime` is undefined at zero

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dead = false; // a failed context build costs one attempt, not one per event forever

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

// Autoplay policy: the context starts suspended until a user gesture, and Episko's first
// sound is often an alert nobody has clicked for. One-shot listeners wake it, in the capture
// phase so a handler that stops propagation cannot starve them.
if (typeof document !== "undefined") {
  const wake = () => { const c = audio(); if (c && c.state === "suspended") void c.resume(); };
  document.addEventListener("pointerdown", wake, { once: true, capture: true });
  document.addEventListener("keydown", wake, { once: true, capture: true });
}

// Loudness is roughly the square of amplitude, so a linear slider wastes its bottom half.
const amplitude = (volume: number) => Math.pow(Math.max(0, Math.min(100, volume)) / 100, 1.8) * PEAK;

function ring(id: ToneId, volume: number) {
  const c = audio();
  if (!c || !master || volume <= 0) return;
  if (c.state === "suspended") void c.resume(); // a WebView may suspend the context at any time
  const tone = toneDef(id);
  const amp = amplitude(volume);
  const t0 = c.currentTime + 0.01; // exactly `currentTime` is already past once the node exists: a click
  for (const st of tone.steps) {
    const start = t0 + st.at / 1000;
    const end = start + st.ms / 1000;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = st.wave ?? "sine";
    osc.frequency.setValueAtTime(st.hz, start);
    // A gate-shaped envelope pops; a step shorter than the attack would ramp past its end and ring forever.
    const atk = Math.min(ATTACK, (end - start) * 0.4);
    g.gain.setValueAtTime(ZERO, start);
    g.gain.exponentialRampToValueAtTime(Math.max(ZERO, amp * (st.gain ?? 1)), start + atk);
    g.gain.exponentialRampToValueAtTime(ZERO, end);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(end + 0.02);
    osc.onended = () => { osc.disconnect(); g.disconnect(); }; // nodes are not garbage until disconnected
  }
}

let gate: SoundGate = SOUND_GATE_IDLE; // not persisted: a fresh run must never suppress its first sound

/** Every caller fires this unconditionally and lets `soundFor` decide (docs/sounds.md). */
export function playSound(ev: SoundEvent) {
  const now = Date.now();
  // `hasFocus()`, not `visibilityState`: a window merely behind another is still "visible".
  const focused = typeof document !== "undefined" && document.hasFocus();
  const tone = soundFor(soundPrefs, ev, now, { ...gate, focused });
  if (!tone) return;
  gate = { focused, lastAt: now, lastEv: ev };
  ring(tone, soundPrefs.volume);
  log("info", `sound ${ev} · ${tone}`);
}

// Not `playSound`: a preview skips the focus rule, event switch and burst gate, and leaves `gate` alone.
export function previewTone(id: ToneId) { ring(id, soundPrefs.volume); }
export function previewEvent(ev: SoundEvent) { previewTone(soundPrefs.events[ev].tone); }
export const previewMs = (id: ToneId) => toneMs(toneDef(id)); // so a caller can pace a sequence of previews
