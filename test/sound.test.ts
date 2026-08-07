import { describe, expect, it } from "vitest";
import {
  clampSoundPrefs, exitSound, hookSound, isDefaultSoundPrefs, limitCrossed,
  LIMIT_STEPS, soundDefaults, SOUND_EVENTS, SOUND_GAP_MS, SOUND_REPEAT_MS, soundFor,
  soundSnap, toneDef, toneMs, TONES, VOLUME_RANGE,
  type SoundEvent, type SoundGate, type SoundPrefs, type SoundSnap,
} from "../src/sound";
import type { Sess } from "../src/types";

const T = 1_000_000;
const prefs = (over: Partial<SoundPrefs> = {}): SoundPrefs => ({ ...soundDefaults(), ...over });
const gate = (over: Partial<SoundGate> = {}): SoundGate =>
  ({ focused: false, lastAt: 0, lastEv: null, ...over });
/// Every event switched on, so a test about the burst rules isn't quietly measuring
/// a default instead.
function allOn(over: Partial<SoundPrefs> = {}): SoundPrefs {
  const p = prefs(over);
  for (const d of SOUND_EVENTS) p.events[d.id] = { ...p.events[d.id], on: true };
  return p;
}

const snap = (over: Partial<SoundSnap> = {}): SoundSnap =>
  ({ phase: "working", attention: null, apiErrAt: null, ...over });

describe("the catalogue", () => {
  it("gives every event a tone that exists and a real priority", () => {
    const ids = new Set(TONES.map((t) => t.id));
    for (const d of SOUND_EVENTS) {
      expect(ids.has(d.tone), `${d.id} defaults to a tone that isn't shipped`).toBe(true);
      expect(d.priority).toBeGreaterThanOrEqual(0);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids on either side — a duplicate silently shadows a row", () => {
    expect(new Set(SOUND_EVENTS.map((d) => d.id)).size).toBe(SOUND_EVENTS.length);
    expect(new Set(TONES.map((t) => t.id)).size).toBe(TONES.length);
  });

  it("keeps every tone short enough to be an alert rather than a jingle", () => {
    for (const t of TONES) {
      expect(toneMs(t), `${t.id} rings for too long`).toBeLessThanOrEqual(1000);
      expect(toneMs(t)).toBeGreaterThan(0);
    }
  });

  it("falls back rather than throwing on a tone id we no longer ship", () => {
    expect(toneDef("gone" as never)).toBe(TONES[0]);
  });

  it("starts the events that fire constantly switched OFF", () => {
    // The whole feature's credibility: a set of alerts that fires on every failed grep
    // is a set of alerts you learn to ignore, which makes the permission chime useless.
    const byId = Object.fromEntries(SOUND_EVENTS.map((d) => [d.id, d.on]));
    expect(byId.toolFail).toBe(false);
    expect(byId.ended).toBe(false);
    expect(byId.launched).toBe(false);
    expect(byId.permission).toBe(true);
    expect(byId.done).toBe(true);
  });

  it("keeps the off-by-default ones LAST, because the settings hint says so", () => {
    // Settings › Sounds reads "the last three start switched off". A reorder that left
    // that sentence pointing at the wrong rows is exactly the kind of drift nothing
    // else would catch.
    const off = SOUND_EVENTS.filter((d) => !d.on).map((d) => d.id);
    expect(off.length).toBe(3);
    expect(SOUND_EVENTS.slice(-3).map((d) => d.id)).toEqual(off);
  });

  it("makes a permission the most urgent thing there is", () => {
    const perm = SOUND_EVENTS.find((d) => d.id === "permission")!;
    for (const d of SOUND_EVENTS) if (d.id !== "permission") expect(d.priority).toBeLessThan(perm.priority);
  });
});

describe("clampSoundPrefs", () => {
  it("defaults a missing or corrupt value rather than throwing", () => {
    expect(clampSoundPrefs(null)).toEqual(soundDefaults());
    expect(clampSoundPrefs({})).toEqual(soundDefaults());
    expect(clampSoundPrefs({ volume: NaN, when: undefined })).toEqual(soundDefaults());
    expect(clampSoundPrefs({ volume: "loud" } as never).volume).toBe(soundDefaults().volume);
  });

  it("holds the volume inside 0–100 and rounds it", () => {
    expect(clampSoundPrefs({ volume: -40 }).volume).toBe(VOLUME_RANGE.min);
    expect(clampSoundPrefs({ volume: 900 }).volume).toBe(VOLUME_RANGE.max);
    expect(clampSoundPrefs({ volume: 61.4 }).volume).toBe(61);
  });

  it("only treats an explicit false as off, so a missing key stays enabled", () => {
    expect(clampSoundPrefs({}).enabled).toBe(true);
    expect(clampSoundPrefs({ enabled: false }).enabled).toBe(false);
  });

  it("fills in an event the stored blob has never heard of", () => {
    // The realistic upgrade path: `cc-sound` written by a build with fewer events.
    const old = clampSoundPrefs({ events: { permission: { on: false, tone: "pop" } } as never });
    expect(old.events.permission).toEqual({ on: false, tone: "pop" });
    for (const d of SOUND_EVENTS) {
      expect(old.events[d.id], `${d.id} came back undefined`).toBeDefined();
      if (d.id !== "permission") expect(old.events[d.id]).toEqual({ on: d.on, tone: d.tone });
    }
  });

  it("drops an event key we no longer ship instead of carrying it forever", () => {
    const p = clampSoundPrefs({ events: { subagent: { on: true, tone: "ping" } } as never });
    expect(Object.keys(p.events).sort()).toEqual(SOUND_EVENTS.map((d) => d.id).sort());
  });

  it("decays an unknown tone to THAT event's default, not to the first tone", () => {
    const p = clampSoundPrefs({ events: { done: { on: true, tone: "gong" } } as never });
    expect(p.events.done.tone).toBe(SOUND_EVENTS.find((d) => d.id === "done")!.tone);
  });

  it("hands out a fresh events map each time, so a spread can't corrupt the defaults", () => {
    const a = soundDefaults();
    a.events.done.on = false;
    expect(soundDefaults().events.done.on).toBe(true);
  });
});

describe("isDefaultSoundPrefs", () => {
  it("is true for a fresh install and false after any single change", () => {
    expect(isDefaultSoundPrefs(soundDefaults())).toBe(true);
    expect(isDefaultSoundPrefs(prefs({ volume: 30 }))).toBe(false);
    expect(isDefaultSoundPrefs(prefs({ when: "away" }))).toBe(false);
    expect(isDefaultSoundPrefs(prefs({ enabled: false }))).toBe(false);
    const p = soundDefaults();
    p.events.done = { ...p.events.done, tone: "bell" };
    expect(isDefaultSoundPrefs(p)).toBe(false);
  });
});

describe("soundFor: the absolute refusals", () => {
  it("says nothing when sound is switched off", () => {
    expect(soundFor(prefs({ enabled: false }), "permission", T, gate())).toBeNull();
  });

  it("treats volume 0 as mute rather than as an inaudible sound", () => {
    // It matters: a "played" sound stamps the gate and would suppress the next one.
    expect(soundFor(prefs({ volume: 0 }), "permission", T, gate())).toBeNull();
  });

  it("says nothing for an event whose own switch is off", () => {
    expect(soundFor(prefs(), "toolFail", T, gate())).toBeNull();  // off by default
    expect(soundFor(allOn(), "toolFail", T, gate())).not.toBeNull();
  });
});

describe("soundFor: the focus rule", () => {
  it("stays quiet while you are looking at Episko in `away` mode", () => {
    const p = prefs({ when: "away" });
    expect(soundFor(p, "permission", T, gate({ focused: true }))).toBeNull();
    expect(soundFor(p, "permission", T, gate({ focused: false }))).toBe(p.events.permission.tone);
  });

  it("ignores focus entirely in `always` mode", () => {
    expect(soundFor(prefs(), "permission", T, gate({ focused: true }))).not.toBeNull();
  });
});

describe("soundFor: bursts", () => {
  it("collapses the same event arriving twice — the duplicates are by design", () => {
    // A permission is both a blocking hook and a Notification; an ending session is
    // both SessionEnd and pty-exit. Two signals, one fact, one noise.
    const g = gate({ lastAt: T, lastEv: "permission" });
    expect(soundFor(allOn(), "permission", T + SOUND_REPEAT_MS - 1, g)).toBeNull();
    expect(soundFor(allOn(), "permission", T + SOUND_REPEAT_MS, g)).not.toBeNull();
  });

  it("swallows a quieter event landing inside the gap after a louder one", () => {
    const g = gate({ lastAt: T, lastEv: "permission" });
    expect(soundFor(allOn(), "done", T + 50, g)).toBeNull();
    expect(soundFor(allOn(), "done", T + SOUND_GAP_MS, g)).not.toBeNull();
  });

  it("lets a MORE urgent event through the gap — the whole point of the feature", () => {
    // A permission 80ms after a "your turn" is not a duplicate of it; suppressing it
    // would silence exactly the alert this exists for.
    const g = gate({ lastAt: T, lastEv: "done" });
    expect(soundFor(allOn(), "permission", T + 80, g)).toBe(allOn().events.permission.tone);
  });

  it("does not let an EQUALLY urgent event through — that is a burst", () => {
    // N agents finishing together is one moment, not N.
    const g = gate({ lastAt: T, lastEv: "done" });
    expect(soundFor(allOn(), "error", T + 80, g)).toBeNull();   // both priority 2
  });

  it("rings on the very first event of a run, with nothing to compare against", () => {
    expect(soundFor(allOn(), "done", T, gate({ lastAt: 0, lastEv: null }))).not.toBeNull();
  });
});

describe("hookSound", () => {
  it("hears a permission the moment attention appears", () => {
    expect(hookSound(snap(), snap({ attention: "permission: Bash" }))).toBe("permission");
  });

  it("tells any other notification apart from a permission", () => {
    expect(hookSound(snap(), snap({ attention: "idle_prompt" }))).toBe("question");
  });

  it("does not re-ring an attention that was already there", () => {
    const a = snap({ attention: "permission: Bash", phase: "done" });
    expect(hookSound(a, { ...a })).toBeNull();
  });

  it("rings for a NEW permission that replaced a different one", () => {
    const before = snap({ attention: "permission: Read" });
    expect(hookSound(before, snap({ attention: "permission: Bash" }))).toBe("permission");
  });

  it("puts attention above the phase — being asked outranks being finished", () => {
    const after = snap({ phase: "done", attention: "permission: Bash" });
    expect(hookSound(snap({ phase: "working" }), after)).toBe("permission");
  });

  it("rings `done` when a turn ends", () => {
    expect(hookSound(snap({ phase: "working" }), snap({ phase: "done" }))).toBe("done");
  });

  it("says nothing for the phases nobody needs told about", () => {
    expect(hookSound(snap({ phase: "idle" }), snap({ phase: "thinking" }))).toBeNull();
    expect(hookSound(snap({ phase: "thinking" }), snap({ phase: "working" }))).toBeNull();
  });

  it("separates a turn the API killed from a tool call that failed", () => {
    // The distinction this codebase already draws for the LABEL, drawn again for the
    // noise — and here it matters more, because a failed grep is routine and an alarm
    // you hear ten times an hour is an alarm you stop hearing.
    const before = snap({ phase: "working" });
    expect(hookSound(before, snap({ phase: "error", apiErrAt: T }))).toBe("error");
    expect(hookSound(before, snap({ phase: "error" }))).toBe("toolFail");
  });

  it("rings `error` again for a SECOND API failure in the same red phase", () => {
    const before = snap({ phase: "error", apiErrAt: T });
    expect(hookSound(before, snap({ phase: "error", apiErrAt: T + 60_000 }))).toBe("error");
  });

  it("stays quiet when a retry clears the failure", () => {
    const before = snap({ phase: "error", apiErrAt: T });
    expect(hookSound(before, snap({ phase: "thinking" }))).toBeNull();
  });

  it("rings `ended` when the session stops", () => {
    expect(hookSound(snap({ phase: "working" }), snap({ phase: "ended" }))).toBe("ended");
  });

  it("stays quiet when a statusline un-ends a session that is really alive", () => {
    // applyStatusline flips "ended" back to "idle" — a rotation, not an event.
    expect(hookSound(snap({ phase: "ended" }), snap({ phase: "idle" }))).toBeNull();
  });
});

describe("soundSnap", () => {
  it("reads the three fields the decision needs off a live session", () => {
    const s = {
      phase: "error", attention: "permission: Bash",
      apiErr: { kind: "overloaded", detail: "", at: T },
    } as unknown as Sess;
    expect(soundSnap(s)).toEqual({ phase: "error", attention: "permission: Bash", apiErrAt: T });
    expect(soundSnap({ phase: "idle", attention: null, apiErr: null } as unknown as Sess).apiErrAt).toBeNull();
  });
});

describe("exitSound", () => {
  it("turns a task's exit code into its verdict", () => {
    expect(exitSound("task", 0)).toBe("taskDone");
    expect(exitSound("task", 1)).toBe("taskFail");
    expect(exitSound("task", 137)).toBe("taskFail");
  });

  it("treats anything else as merely having stopped, whatever the code", () => {
    expect(exitSound("claude", 0)).toBe("ended");
    expect(exitSound("claude", 1)).toBe("ended");
    expect(exitSound("shell", 0)).toBe("ended");
  });
});

describe("limitCrossed", () => {
  it("fires once at each mark and not in between", () => {
    expect(limitCrossed(48, 49)).toBeNull();
    expect(limitCrossed(48, 51)).toBe(50);
    expect(limitCrossed(51, 60)).toBeNull();
    expect(limitCrossed(79, 81)).toBe(80);
    expect(limitCrossed(94, 99)).toBe(95);
  });

  it("reports the HIGHEST mark when a reading jumps several at once", () => {
    // An idle session's first statusLine can be a long way ahead of the last one.
    expect(limitCrossed(10, 97)).toBe(95);
  });

  it("treats the first reading of a run as a baseline, not a crossing", () => {
    // Otherwise every launch that starts above 50% rings — at the one moment the
    // sound is worth least, because the footer meter is right there saying it.
    expect(limitCrossed(null, 90)).toBeNull();
    expect(limitCrossed(null, 12)).toBeNull();
    // …and the very next reading behaves normally.
    expect(limitCrossed(90, 96)).toBe(95);
  });

  it("crosses nothing when the window resets and the number falls", () => {
    // The reason this compares readings instead of testing a threshold outright.
    expect(limitCrossed(96, 0)).toBeNull();
    expect(limitCrossed(96, 3)).toBeNull();
  });

  it("ignores a missing reading rather than treating it as zero", () => {
    expect(limitCrossed(90, null)).toBeNull();
  });

  it("has marks that climb, so the highest-crossed scan is meaningful", () => {
    expect([...LIMIT_STEPS].sort((a, b) => a - b)).toEqual(LIMIT_STEPS);
  });
});

describe("the wiring the app depends on", () => {
  it("routes every event the app can raise through a real catalogue entry", () => {
    // main.ts and panes.ts call playSound with these literals; a rename that missed one
    // would be a silent no-op, since `soundFor` returns null for an unknown key.
    const raised: SoundEvent[] = [
      "permission", "question", "done", "error", "toolFail",
      "ended", "taskDone", "taskFail", "limit", "launched",
    ];
    const known = new Set(SOUND_EVENTS.map((d) => d.id));
    for (const ev of raised) expect(known.has(ev), `${ev} is raised but not in the catalogue`).toBe(true);
    expect(raised.length).toBe(SOUND_EVENTS.length);
  });
});
