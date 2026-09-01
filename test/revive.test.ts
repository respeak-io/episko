import { describe, expect, it } from "vitest";
import type { ReviveState, Sess } from "../src/types";
import {
  clampRevivePrefs, isDefaultRevivePrefs, REVIVE_ATTEMPTS_RANGE, REVIVE_BASE_RANGE,
  REVIVE_DEFAULTS, REVIVE_FACTOR_RANGE, REVIVE_JITTER_RANGE, REVIVE_KINDS,
  REVIVE_MAX_RANGE, REVIVE_PROMPT, reviveDeadline, reviveDelay, reviveGap, reviveJitter,
  reviveKind, revivePlan, reviveStatus, reviveStep, reviveWindowMs,
  type RevivePrefs,
} from "../src/revive";

const NOW = 1800000000000; // 2027-01-15T08:00:00Z

// Only the fields ./revive reads; it is pure over a Sess, so a cast beats a real pane.
function sess(o: Partial<Sess> = {}): Sess {
  return {
    id: "s1", kind: "agent", provider: "claude", external: false, phase: "error", attention: null,
    apiErr: { kind: "overloaded", detail: "", at: NOW }, revive: null,
    agents: new Map(), fanout: null, queuedPrompt: false,
    ...o,
  } as Sess;
}
const prefs = (o: Partial<RevivePrefs> = {}): RevivePrefs =>
  ({ ...REVIVE_DEFAULTS, enabled: true, ...o });
// A schedule already in place for the fixture's current failure (errAt matches apiErr.at).
const state = (o: Partial<ReviveState> = {}): ReviveState =>
  ({ attempts: 0, errAt: NOW, dueAt: NOW + 30_000, lastAt: 0, gaveUp: false, ...o });
// Jitter pinned to the midpoint, so a scheduled `dueAt` is the plain ladder value.
const noJit = () => 0.5;

describe("reviveKind — what kind of failure this was", () => {
  it("refuses the ones a retry cannot fix", () => {
    // Null is the load-bearing return: no preference can switch these back on.
    for (const k of ["authentication_failed", "oauth_org_not_allowed", "billing_error",
      "invalid_request", "model_not_found", "max_output_tokens"]) {
      expect(reviveKind(k)).toBeNull();
    }
  });
  it("names the three Claude Code spells out", () => {
    expect(reviveKind("overloaded")).toBe("overloaded");
    expect(reviveKind("rate_limit")).toBe("rate_limit");
    expect(reviveKind("server_error")).toBe("server_error");
  });
  it("recognises a network failure by its transport name, which is all we ever get", () => {
    // There is no enum member for a network failure, so the text is the only signal there is.
    expect(reviveKind("ENOTFOUND")).toBe("network");
    expect(reviveKind("ECONNRESET")).toBe("network");
    expect(reviveKind("ETIMEDOUT")).toBe("network");
    expect(reviveKind("EAI_AGAIN")).toBe("network");
    expect(reviveKind("network_error")).toBe("network");
    expect(reviveKind("connection_timeout")).toBe("network");
  });
  it("files a kind it has never met under `other` rather than refusing it", () => {
    // A denylist: a few wasted retries on a new kind cost less than the night a missed retry loses.
    expect(reviveKind("quantum_flux")).toBe("other");
    expect(reviveKind("")).toBe("other");
  });
  it("does not care about case or stray whitespace", () => {
    expect(reviveKind("  OVERLOADED  ")).toBe("overloaded");
    expect(reviveKind("Authentication_Failed")).toBeNull();
  });
});

describe("clampRevivePrefs — whatever localStorage held, made safe", () => {
  it("gives an absent blob the shipped defaults, which are OFF", () => {
    expect(clampRevivePrefs(null)).toEqual(REVIVE_DEFAULTS);
    expect(clampRevivePrefs(undefined)).toEqual(REVIVE_DEFAULTS);
    expect(clampRevivePrefs({})).toEqual(REVIVE_DEFAULTS);
    expect(REVIVE_DEFAULTS.enabled).toBe(false);
  });
  it("needs an explicit `true` to switch on — the opposite of every other switch", () => {
    // The one preference that makes Episko type unattended, so a corrupt blob must decay to off.
    expect(clampRevivePrefs({ enabled: true }).enabled).toBe(true);
    expect(clampRevivePrefs({ enabled: undefined }).enabled).toBe(false);
    expect(clampRevivePrefs({ enabled: "yes" as unknown as boolean }).enabled).toBe(false);
    expect(clampRevivePrefs({ enabled: 1 as unknown as boolean }).enabled).toBe(false);
  });
  it("clamps every number into the range either side of which it stops making sense", () => {
    expect(clampRevivePrefs({ attempts: 0 }).attempts).toBe(REVIVE_ATTEMPTS_RANGE.min);
    expect(clampRevivePrefs({ attempts: 9999 }).attempts).toBe(REVIVE_ATTEMPTS_RANGE.max);
    expect(clampRevivePrefs({ baseMs: 1 }).baseMs).toBe(REVIVE_BASE_RANGE.min);
    expect(clampRevivePrefs({ maxMs: 1e12 }).maxMs).toBe(REVIVE_MAX_RANGE.max);
    expect(clampRevivePrefs({ factor: 0.1 }).factor).toBe(REVIVE_FACTOR_RANGE.min);
    expect(clampRevivePrefs({ jitterPct: 900 }).jitterPct).toBe(REVIVE_JITTER_RANGE.max);
  });
  it("decays a hand-edited number rather than taking the app down", () => {
    expect(clampRevivePrefs({ baseMs: NaN }).baseMs).toBe(REVIVE_DEFAULTS.baseMs);
    expect(clampRevivePrefs({ factor: "soon" as unknown as number }).factor).toBe(REVIVE_DEFAULTS.factor);
  });
  it("keeps only kinds it knows, and keeps an empty list empty", () => {
    expect(clampRevivePrefs({ kinds: ["overloaded", "nonsense"] as never }).kinds).toEqual(["overloaded"]);
    // An empty list is a choice; repairing it to the defaults would re-enable retries the user turned off.
    expect(clampRevivePrefs({ kinds: [] }).kinds).toEqual([]);
    expect(clampRevivePrefs({ kinds: "all" as never }).kinds).toEqual(REVIVE_DEFAULTS.kinds);
  });
  it("knows when it is still at its defaults, whatever order the kinds are in", () => {
    expect(isDefaultRevivePrefs(REVIVE_DEFAULTS)).toBe(true);
    expect(isDefaultRevivePrefs({ ...REVIVE_DEFAULTS, kinds: [...REVIVE_DEFAULTS.kinds].reverse() })).toBe(true);
    expect(isDefaultRevivePrefs({ ...REVIVE_DEFAULTS, baseMs: 45_000 })).toBe(false);
    expect(isDefaultRevivePrefs({ ...REVIVE_DEFAULTS, kinds: ["overloaded"] })).toBe(false);
  });
  it("ships every kind in the catalogue switched on", () => {
    expect([...REVIVE_DEFAULTS.kinds].sort()).toEqual(REVIVE_KINDS.map((k) => k.id).sort());
  });
});

describe("the ladder", () => {
  it("doubles by default and stops at the cap", () => {
    const p = prefs();
    expect(revivePlan(p)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000]);
    // The sixth rung would be 960s; the 15m cap is what it lands on instead.
    expect(reviveDelay(p, 6)).toBe(p.maxMs);
    expect(reviveDelay(p, 50)).toBe(p.maxMs);
  });
  it("goes flat at a factor of 1, which is a legitimate thing to ask for", () => {
    expect(revivePlan(prefs({ factor: 1, attempts: 3 }))).toEqual([30_000, 30_000, 30_000]);
  });
  it("treats attempt 0 and negatives as the first rung rather than dividing", () => {
    const p = prefs();
    expect(reviveDelay(p, 0)).toBe(p.baseMs);
    expect(reviveDelay(p, -5)).toBe(p.baseMs);
  });
  it("adds the rungs up into the one figure the settings panel exists to show", () => {
    // 30s+1m+2m+4m+8m+15m = 30m30s of outage ridden out on the shipped defaults.
    expect(reviveWindowMs(prefs())).toBe(1_830_000);
  });
});

describe("reviveJitter — what stops a fleet retrying in lockstep", () => {
  it("is the identity at 0%", () => {
    expect(reviveJitter(60_000, prefs({ jitterPct: 0 }), () => 0)).toBe(60_000);
  });
  it("scatters either side, never past the percentage asked for", () => {
    const p = prefs({ jitterPct: 20 });
    expect(reviveJitter(60_000, p, () => 0)).toBe(48_000);   // full negative
    expect(reviveJitter(60_000, p, () => 1)).toBe(72_000);   // full positive
    expect(reviveJitter(60_000, p, () => 0.5)).toBe(60_000); // midpoint
  });
  it("never returns a negative wait", () => {
    expect(reviveJitter(1000, prefs({ jitterPct: 50 }), () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("reviveStep — the things it must never do", () => {
  it("does nothing at all while the feature is off", () => {
    expect(reviveStep(sess(), prefs({ enabled: false }), NOW, true)).toEqual({ do: "none", why: "off" });
  });
  it("leaves shell and task panes alone — there is no conversation to resume", () => {
    expect(reviveStep(sess({ kind: "shell" }), prefs(), NOW, true).do).toBe("none");
    expect(reviveStep(sess({ kind: "task" }), prefs(), NOW, true)).toEqual({ do: "none", why: "not-agent" });
  });
  it("leaves an external session alone — Episko holds no PTY to type into", () => {
    expect(reviveStep(sess({ external: true }), prefs(), NOW, true)).toEqual({ do: "none", why: "external" });
  });
  it("NEVER types into a session that is asking you something", () => {
    // A continue typed at a blocking permission answers it; checked before anything that can send.
    const s = sess({ attention: "permission: Bash", revive: state({ dueAt: NOW - 1 }) });
    expect(reviveStep(s, prefs(), NOW, true)).toEqual({ do: "none", why: "attention" });
  });
  it("ignores a failed tool call, which reddens the same glyph for a different reason", () => {
    // A failed grep sets `phase: "error"` as much as a 529 does; only `apiErr` means the API killed the turn.
    expect(reviveStep(sess({ apiErr: null }), prefs(), NOW, true)).toEqual({ do: "none", why: "no-failure" });
  });
  it("ignores a session that is doing fine", () => {
    for (const phase of ["idle", "thinking", "working", "done", "ended"] as const) {
      expect(reviveStep(sess({ phase }), prefs(), NOW, true)).toEqual({ do: "none", why: "no-failure" });
    }
  });
  it("refuses a failure that waiting cannot fix, whatever the preferences say", () => {
    const p = prefs({ kinds: ["overloaded", "network", "server_error", "rate_limit", "other"] });
    const s = sess({ apiErr: { kind: "authentication_failed", detail: "", at: NOW } });
    expect(reviveStep(s, p, NOW, true)).toEqual({ do: "none", why: "kind" });
  });
  it("respects a kind the user switched off", () => {
    const s = sess({ apiErr: { kind: "rate_limit", detail: "", at: NOW } });
    expect(reviveStep(s, prefs({ kinds: ["overloaded"] }), NOW, true)).toEqual({ do: "none", why: "kind" });
  });
  it("does nothing when the user ticked no kinds at all", () => {
    expect(reviveStep(sess(), prefs({ kinds: [] }), NOW, true)).toEqual({ do: "none", why: "kind" });
  });
  it("is NOT held off by a fan-out counter left high by the same outage", () => {
    // Agents killed with their parent never send `SubagentStop` and never age out (no newer
    // fan-out inherits them), so `liveCount` stays high through exactly the outage this is for.
    const s = sess({
      agents: new Map(Array.from({ length: 7 }, (_, i) => [`a${i}`, { type: "Explore", since: NOW, orphanedAt: 0 }])),
      fanout: { name: "review", lastAt: NOW, started: 7, done: 0 } as never,
    });
    expect(reviveStep(s, prefs(), NOW, true, noJit).do).toBe("schedule");
  });
});

describe("reviveStep — the schedule", () => {
  it("times the first attempt from when the failure happened, not from this tick", () => {
    // A tick runs every ten seconds; timing from `now` would stretch every rung by the poll's lateness.
    const s = sess({ apiErr: { kind: "overloaded", detail: "", at: NOW } });
    const act = reviveStep(s, prefs(), NOW + 7_000, true, noJit);
    expect(act.do).toBe("schedule");
    if (act.do !== "schedule") throw new Error("unreachable");
    expect(act.state.dueAt).toBe(NOW + 30_000);
    expect(act.state.attempts).toBe(0);
    expect(act.state.errAt).toBe(NOW);
  });
  it("waits until the rung falls due", () => {
    const s = sess({ revive: state({ dueAt: NOW + 30_000 }) });
    expect(reviveStep(s, prefs(), NOW, true)).toEqual({ do: "none", why: "waiting" });
    expect(reviveStep(s, prefs(), NOW + 29_999, true)).toEqual({ do: "none", why: "waiting" });
  });
  it("sends the moment it is due", () => {
    const s = sess({ revive: state({ dueAt: NOW }) });
    const act = reviveStep(s, prefs(), NOW, true, noJit);
    expect(act.do).toBe("send");
    if (act.do !== "send") throw new Error("unreachable");
    expect(act.prompt).toBe(REVIVE_PROMPT);
    expect(act.state.attempts).toBe(1);
    expect(act.state.lastAt).toBe(NOW);
  });
  it("moves the next rung out as part of sending, so a wedged session is not hammered", () => {
    // A `dueAt` left in the past would send again on every tick, the whole budget gone in a minute.
    const s = sess({ revive: state({ dueAt: NOW }) });
    const act = reviveStep(s, prefs(), NOW, true, noJit);
    if (act.do !== "send") throw new Error("expected a send");
    expect(act.state.dueAt).toBe(NOW + 60_000); // rung 2, not rung 1 again
    // Feed it straight back in: still the same failure, so it holds.
    const again = reviveStep(sess({ revive: act.state }), prefs(), NOW + 1_000, true, noJit);
    expect(again).toEqual({ do: "none", why: "waiting" });
  });
  it("re-times from the NEW failure when a continue produced another one", () => {
    // A turn can run ten minutes before dying; the old schedule would then be overdue and skip a rung.
    const sent = state({ attempts: 1, errAt: NOW, dueAt: NOW + 60_000, lastAt: NOW });
    const later = NOW + 600_000;
    const s = sess({ revive: sent, apiErr: { kind: "overloaded", detail: "", at: later } });
    const act = reviveStep(s, prefs(), later + 100, true, noJit);
    expect(act.do).toBe("schedule");
    if (act.do !== "schedule") throw new Error("unreachable");
    expect(act.state.attempts).toBe(1);            // the streak is not reset
    expect(act.state.errAt).toBe(later);
    expect(act.state.dueAt).toBe(later + 60_000);  // rung 2, timed from the new failure
  });
  it("climbs the ladder across a streak instead of restarting it", () => {
    // If `attempts` reset per turn (clearing it in `newTurn`), a dead API failing each turn in
    // milliseconds would restart the streak at rung one and flatten the ladder into a 30s hammer.
    const p = prefs();
    const waits: number[] = [];
    let st: ReviveState | null = null;
    let at = NOW;
    for (let i = 0; i < p.attempts; i++) {
      const sch = reviveStep(sess({ revive: st, apiErr: { kind: "overloaded", detail: "", at } }), p, at, true, noJit);
      if (sch.do !== "schedule") throw new Error(`expected a schedule at ${i}, got ${sch.do}`);
      waits.push(sch.state.dueAt - at);
      const due = sch.state.dueAt;
      const send = reviveStep(sess({ revive: sch.state, apiErr: { kind: "overloaded", detail: "", at } }), p, due, true, noJit);
      if (send.do !== "send") throw new Error(`expected a send at ${i}, got ${send.do}`);
      st = send.state;
      at = due + 1_000; // the continue starts a turn that dies a second later
    }
    expect(waits).toEqual(revivePlan(p));
    expect(st!.attempts).toBe(p.attempts);
  });
});

describe("reviveStep — being offline", () => {
  it("does not spend an attempt on a request that cannot leave the machine", () => {
    // Otherwise every attempt is spent while the Wi-Fi naps, the failure this feature exists for.
    const s = sess({ revive: state({ dueAt: NOW - 60_000 }) });
    expect(reviveStep(s, prefs(), NOW, false)).toEqual({ do: "none", why: "offline" });
    expect(s.revive!.attempts).toBe(0);
  });
  it("sends immediately once the interface comes back, since dueAt stayed in the past", () => {
    const s = sess({ revive: state({ dueAt: NOW - 60_000 }) });
    const act = reviveStep(s, prefs(), NOW, true, noJit);
    expect(act.do).toBe("send");
  });
  it("checks the schedule before the network, so a session not yet due stays not-due", () => {
    const s = sess({ revive: state({ dueAt: NOW + 30_000 }) });
    expect(reviveStep(s, prefs(), NOW, false)).toEqual({ do: "none", why: "waiting" });
  });
});

describe("reviveStep — giving up", () => {
  it("announces the give-up exactly once", () => {
    const p = prefs({ attempts: 3 });
    const spent = state({ attempts: 3, dueAt: NOW - 1 });
    const first = reviveStep(sess({ revive: spent }), p, NOW, true);
    expect(first).toEqual({ do: "giveup", state: { ...spent, gaveUp: true } });
    // Applied, the next tick and every tick until morning is silent.
    const after = reviveStep(sess({ revive: { ...spent, gaveUp: true } }), p, NOW + 60_000, true);
    expect(after).toEqual({ do: "none", why: "exhausted" });
  });
  it("stops at the cap even when the budget was lowered under a live streak", () => {
    const s = sess({ revive: state({ attempts: 5, dueAt: NOW - 1 }) });
    expect(reviveStep(s, prefs({ attempts: 2 }), NOW, true).do).toBe("giveup");
  });
  it("still refuses to give up on a session that is asking you something", () => {
    // `attention` is checked first, so a permission does not also get an "I gave up" noise on top.
    const s = sess({ attention: "permission: Bash", revive: state({ attempts: 6 }) });
    expect(reviveStep(s, prefs(), NOW, true)).toEqual({ do: "none", why: "attention" });
  });
});

describe("what the surfaces read", () => {
  it("says nothing about a session the watchdog has never touched", () => {
    expect(reviveStatus(sess(), prefs(), NOW)).toBeNull();
  });
  it("counts down to the next try", () => {
    const s = sess({ revive: state({ attempts: 2, dueAt: NOW + 120_000 }) });
    expect(reviveStatus(s, prefs(), NOW)).toBe("Retrying in 2m · try 3 of 6");
    // Minutes are rounded, not truncated: 2m30s is "3m", not "2m".
    expect(reviveStatus(sess({ revive: state({ attempts: 2, dueAt: NOW + 150_000 }) }), prefs(), NOW))
      .toBe("Retrying in 3m · try 3 of 6");
  });
  it("leads with the count once it has stopped, because that is the story of the night", () => {
    expect(reviveStatus(sess({ revive: state({ attempts: 6, gaveUp: true }) }), prefs(), NOW))
      .toBe("Gave up after 6 tries");
    expect(reviveStatus(sess({ revive: state({ attempts: 1, gaveUp: true }) }), prefs(), NOW))
      .toBe("Gave up after 1 try");
  });
  it("never shows a negative countdown for a rung that is already overdue", () => {
    const s = sess({ revive: state({ dueAt: NOW - 90_000 }) });
    expect(reviveStatus(s, prefs(), NOW)).toBe("Retrying in 0s · try 1 of 6");
  });
  it("reports the earliest live deadline, and `now` when one is already overdue", () => {
    const a = sess({ id: "a", revive: state({ dueAt: NOW + 120_000 }) });
    const b = sess({ id: "b", revive: state({ dueAt: NOW + 30_000 }) });
    expect(reviveDeadline([a, b], prefs(), NOW)).toBe(NOW + 30_000);
    expect(reviveDeadline([a, sess({ id: "c", revive: state({ dueAt: NOW - 1 }) })], prefs(), NOW)).toBe(NOW);
    expect(reviveDeadline([a, b], prefs({ enabled: false }), NOW)).toBeNull();
    expect(reviveDeadline([sess()], prefs(), NOW)).toBeNull();
    expect(reviveDeadline([sess({ revive: state({ attempts: 6 }) })], prefs(), NOW)).toBeNull();
  });
  it("writes a gap in the fewest characters that stay unambiguous", () => {
    expect(reviveGap(0)).toBe("0s");
    expect(reviveGap(45_000)).toBe("45s");
    expect(reviveGap(120_000)).toBe("2m");
    expect(reviveGap(1_830_000)).toBe("31m");
    expect(reviveGap(3_600_000)).toBe("1h");
    expect(reviveGap(5_400_000)).toBe("1h 30m");
  });
});

describe("the prompt Episko types", () => {
  it("is one line, because a newline in a REPL is a submit", () => {
    expect(REVIVE_PROMPT).not.toMatch(/[\r\n]/);
  });
  it("is pure ASCII, so the Windows write path never has to re-encode it", () => {
    // `write_pty` re-encodes non-ASCII for ConPTY; this is the one write nobody is awake to check.
    expect([...REVIVE_PROMPT].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
  it("says the interruption was not the user, and asks it to check before assuming", () => {
    // Without the first the agent summarises instead of resuming; without the second it
    // guesses about the tool call whose response never arrived.
    expect(REVIVE_PROMPT).toMatch(/API error/i);
    expect(REVIVE_PROMPT).toMatch(/check/i);
  });
});
