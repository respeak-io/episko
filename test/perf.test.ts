import { describe, expect, it } from "vitest";
import {
  clampScrollback, clampVitalsPrefs, driftVerdict, fmtPerHour, fmtSpanShort, leakSuspects,
  MIN_SPAN_MS, pushVitals, SCROLLBACK_DEFAULT, SCROLLBACK_OPTS, VITALS, VITALS_CAP,
  VITALS_DEFAULTS, VITALS_EVERY, vitalsDrift, vitalsLine, vitalsPrefsJson,
  type VitalCounts, type Vitals,
} from "../src/perf";

const HOUR = 3_600_000;

/// A sample with every counter at zero, so a test names only the ones it is about.
function sample(t: number, over: Partial<VitalCounts & { upMs: number }> = {}): Vitals {
  return {
    t, upMs: t,
    dom: 0, heapMB: 0, canvases: 0, files: 0, servers: 0, termLines: 0,
    panes: 0, gl: 0, acts: 0, hist: 0, paints: 0, events: 0,
    ...over,
  };
}

/// Two samples `hours` apart, the second differing by `over`.
function series(hours: number, over: Partial<VitalCounts & { upMs: number }>): Vitals[] {
  const t0 = 1_700_000_000_000;
  return [sample(t0), sample(t0 + hours * HOUR, { upMs: t0 + hours * HOUR, ...over })];
}

describe("the counter table", () => {
  it("has a unique id and log key for every counter", () => {
    expect(new Set(VITALS.map((v) => v.id)).size).toBe(VITALS.length);
    expect(new Set(VITALS.map((v) => v.key)).size).toBe(VITALS.length);
  });
  // The whole accusation rule reads `climb != null && kind === "growth"`, so a threshold
  // on a level or a rate would arm a counter that is bounded or monotonic by design — a
  // permanent false positive on the two kinds that exist precisely to not be accused.
  it("carries a climb threshold on growth counters and on nothing else", () => {
    for (const v of VITALS) {
      if (v.kind === "growth") expect(v.climb, `${v.id} is growth and needs a threshold`).toBeGreaterThan(0);
      else expect(v.climb, `${v.id} is a ${v.kind} and must not have one`).toBeUndefined();
    }
  });
  it("says something about every counter, since the table is the only documentation the tab has", () => {
    for (const v of VITALS) {
      expect(v.label.length).toBeGreaterThan(2);
      expect(v.hint.length).toBeGreaterThan(30);
    }
  });
});

describe("clampVitalsPrefs — the store and its repair", () => {
  it("is off with nothing stored, which is what a fresh install gets", () => {
    expect(clampVitalsPrefs(null)).toEqual(VITALS_DEFAULTS);
    expect(clampVitalsPrefs(undefined).enabled).toBe(false);
  });
  // The switch has to be an explicit `true`. A stored `"yes"`, a `1` or a truthy object
  // would otherwise start a recorder nobody asked for on a store somebody hand-edited.
  it("only ever reads a literal true as on", () => {
    expect(clampVitalsPrefs({ enabled: true }).enabled).toBe(true);
    for (const junk of [1, "true", {}, [], "on"]) {
      expect(clampVitalsPrefs({ enabled: junk as never }).enabled).toBe(false);
    }
  });
  it("refuses a cadence that is not one of the three offered", () => {
    expect(clampVitalsPrefs({ everyMs: 60_000 }).everyMs).toBe(60_000);
    for (const junk of [0, -1, 42, 86_400_000, NaN, "300000" as never, null as never]) {
      expect(clampVitalsPrefs({ everyMs: junk as number }).everyMs).toBe(VITALS_DEFAULTS.everyMs);
    }
  });
  it("round-trips through its stored form", () => {
    const p = { enabled: true, everyMs: VITALS_EVERY[2] };
    expect(clampVitalsPrefs(JSON.parse(vitalsPrefsJson(p)))).toEqual(p);
  });
});

describe("clampScrollback", () => {
  it("keeps the three offered sizes", () => {
    for (const n of SCROLLBACK_OPTS) expect(clampScrollback(String(n))).toBe(n);
  });
  // Snapping to the *default* rather than to the nearest option is the deliberate half:
  // a stored `50` honoured as 1000 is defensible, but honoured as 50 it is a terminal
  // with no history and nothing on screen saying why.
  it("falls back to the default for anything else, rather than to the nearest size", () => {
    for (const junk of [null, undefined, "", "lots", 0, -1, 50, 999, 12_000, NaN]) {
      expect(clampScrollback(junk)).toBe(SCROLLBACK_DEFAULT);
    }
  });
});

describe("pushVitals", () => {
  it("keeps the newest samples and drops the oldest past the cap", () => {
    const ring: Vitals[] = [];
    for (let i = 0; i < 5; i++) pushVitals(ring, sample(i), 3);
    expect(ring.length).toBe(3);
    expect(ring.map((v) => v.t)).toEqual([2, 3, 4]);
  });
  it("holds a useful span at the default cap", () => {
    // 300 samples at the five-minute cadence is a full day, which is the incident length
    // this whole feature is sized for.
    expect((VITALS_CAP * 300_000) / HOUR).toBeGreaterThanOrEqual(24);
  });
});

describe("vitalsLine — the durable form", () => {
  const line = vitalsLine(sample(0, { upMs: 90 * 60_000, dom: 1842, heapMB: 118, panes: 6 }));
  it("is greppable behind one stable prefix", () => {
    expect(line.startsWith("vitals ")).toBe(true);
  });
  it("writes every counter, in the table's order, as key=value", () => {
    expect(line).toContain("dom=1842");
    expect(line).toContain("heap=118");
    expect(line).toContain("panes=6");
    const keys = [...line.matchAll(/(\w+)=/g)].map((m) => m[1]);
    expect(keys).toEqual(["up", ...VITALS.map((v) => v.key)]);
  });
  it("reports page uptime in minutes, so a reload is visible as a drop", () => {
    expect(line).toContain("up=90m");
  });
});

describe("vitalsDrift", () => {
  it("says nothing at all with fewer than two samples", () => {
    expect(vitalsDrift([])).toBeNull();
    expect(vitalsDrift([sample(0)])).toBeNull();
  });
  it("compares first against last and reports the rate per hour", () => {
    const d = vitalsDrift(series(4, { dom: 800 }))!;
    const dom = d.rows.find((r) => r.id === "dom")!;
    expect(dom.first).toBe(0);
    expect(dom.last).toBe(800);
    expect(dom.delta).toBe(800);
    expect(dom.perHour).toBe(200);
  });
  it("uses the whole ring's endpoints, not the last pair", () => {
    const t0 = 1_700_000_000_000;
    const ring = [0, 1, 2, 3].map((h) => sample(t0 + h * HOUR, { upMs: t0 + h * HOUR, dom: h * 100 }));
    const d = vitalsDrift(ring)!;
    expect(d.samples).toBe(4);
    expect(d.spanMs).toBe(3 * HOUR);
    expect(d.rows.find((r) => r.id === "dom")!.delta).toBe(300);
  });
  // A percentage off a zero start is either infinity or a fiction, and the readout draws
  // whatever it is handed.
  it("gives no percentage when a counter started at zero", () => {
    const d = vitalsDrift(series(1, { dom: 50, heapMB: 0 }))!;
    expect(d.rows.find((r) => r.id === "dom")!.pct).toBeNull();
  });
  it("gives a percentage when it started somewhere", () => {
    const t0 = 1_700_000_000_000;
    const d = vitalsDrift([
      sample(t0, { dom: 100 }),
      sample(t0 + HOUR, { upMs: t0 + HOUR, dom: 150 }),
    ])!;
    expect(d.rows.find((r) => r.id === "dom")!.pct).toBeCloseTo(50);
  });
  // The one signal that says the series spans two lives of the page. Without it a reload
  // — the workaround for this very bug — reads as every counter dropping to zero, i.e.
  // as a fix.
  it("flags a window the webview reloaded inside", () => {
    const t0 = 1_700_000_000_000;
    const ring = [
      sample(t0, { upMs: 10 * HOUR, dom: 5000 }),
      sample(t0 + HOUR, { upMs: 60_000, dom: 700 }),
    ];
    expect(vitalsDrift(ring)!.reloaded).toBe(true);
    expect(vitalsDrift(series(1, { dom: 1 }))!.reloaded).toBe(false);
  });
});

describe("leakSuspects — what is allowed to accuse", () => {
  it("names a growth counter climbing past its threshold", () => {
    // 800 DOM nodes over 2h is 400/h, twice the 200/h threshold.
    const bad = leakSuspects(vitalsDrift(series(2, { dom: 800 })));
    expect(bad.map((r) => r.id)).toEqual(["dom"]);
  });
  it("stays quiet below the threshold", () => {
    expect(leakSuspects(vitalsDrift(series(2, { dom: 100 })))).toEqual([]);
  });
  // The health.ts rule, one level down: a chip that fires on ordinary behaviour teaches
  // you to ignore the row that matters. Scrollback filling to its ceiling and the paint
  // counter counting are both *correct*, and both would otherwise dominate every reading.
  it("never accuses a level or a rate, however fast it climbs", () => {
    const d = vitalsDrift(series(2, { termLines: 90_000, acts: 40_000, paints: 300_000, events: 500_000 }));
    expect(leakSuspects(d)).toEqual([]);
  });
  it("says nothing about a window shorter than half an hour", () => {
    const short = vitalsDrift(series(MIN_SPAN_MS / HOUR / 2, { dom: 100_000 }));
    expect(short!.rows.find((r) => r.id === "dom")!.perHour).toBeGreaterThan(0);
    expect(leakSuspects(short)).toEqual([]);
  });
  it("says nothing about a window the page reloaded inside", () => {
    const t0 = 1_700_000_000_000;
    const ring = [
      sample(t0, { upMs: 10 * HOUR, dom: 100 }),
      sample(t0 + 2 * HOUR, { upMs: 60_000, dom: 9000 }),
    ];
    expect(leakSuspects(vitalsDrift(ring))).toEqual([]);
  });
  it("ignores a counter that fell", () => {
    const t0 = 1_700_000_000_000;
    const ring = [
      sample(t0, { dom: 9000 }),
      sample(t0 + 2 * HOUR, { upMs: t0 + 2 * HOUR, dom: 100 }),
    ];
    expect(leakSuspects(vitalsDrift(ring))).toEqual([]);
  });
  // Counters measured in nodes and in megabytes cannot be ranked by raw rate, so the
  // order is by multiple of each one's own threshold. Here: dom at 3x, heap at 10x.
  it("ranks by how far past its own threshold each one is, not by raw rate", () => {
    const bad = leakSuspects(vitalsDrift(series(1, { dom: 600, heapMB: 40 })));
    expect(bad.map((r) => r.id)).toEqual(["heapMB", "dom"]);
  });
});

describe("driftVerdict — the sentence the tab leads with", () => {
  const on = { enabled: true, everyMs: 300_000 };
  it("says it is not recording when it is not, and says what that costs", () => {
    const v = driftVerdict({ enabled: false, everyMs: 300_000 }, vitalsDrift(series(9, { dom: 9000 })));
    expect(v).toMatch(/not recording/i);
  });
  it("distinguishes too-early from clean", () => {
    expect(driftVerdict(on, null)).toMatch(/two samples/i);
    expect(driftVerdict(on, vitalsDrift(series(0.2, {})))).toMatch(/half an hour/i);
    expect(driftVerdict(on, vitalsDrift(series(9, {})))).toMatch(/nothing growing/i);
  });
  it("names what grew, with its rate", () => {
    const v = driftVerdict(on, vitalsDrift(series(2, { dom: 800 })));
    expect(v).toMatch(/DOM nodes/);  // as written in the table, not lowercased into "dom nodes"
    expect(v).toContain("+400/h");
  });
  it("explains a reload rather than reporting the nonsense it produces", () => {
    const t0 = 1_700_000_000_000;
    const v = driftVerdict(on, vitalsDrift([
      sample(t0, { upMs: 10 * HOUR, dom: 5000 }),
      sample(t0 + 2 * HOUR, { upMs: 60_000, dom: 100 }),
    ]));
    expect(v).toMatch(/reloaded/i);
  });
});

describe("the two formatters", () => {
  it("writes a span in hours and minutes", () => {
    expect(fmtSpanShort(20 * 60_000)).toBe("20m");
    expect(fmtSpanShort(95 * 60_000)).toBe("1h 35m");
    // A whole number of hours drops the minutes — "16h 0m" reads as a bug in the sentence
    // the verdict builds around it.
    expect(fmtSpanShort(16 * 3_600_000)).toBe("16h");
  });
  // The heap threshold is 4MB/h, so a rate rounded to a whole number would print a clean
  // 3.6 as "4" — the flagged value — on the counter the whole feature turns on.
  it("keeps a decimal on small rates, where the thresholds live", () => {
    expect(fmtPerHour(3.6)).toBe("3.6");
    expect(fmtPerHour(0.4)).toBe("0.4");
    expect(fmtPerHour(34.2)).toBe("34");
    expect(fmtPerHour(4210)).toBe((4210).toLocaleString());
  });
});
