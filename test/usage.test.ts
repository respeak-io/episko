import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject import
import {
  addUsage, costDelta, modelFamily, resetCostBaselines, setTokenDays, setUsageRange,
  todayKey, tokenDays, tokenScanAt, uBuckets, uDkey, uModels, usage, usageDetail,
  usageWindow, uSum, type DayUsage, type UDay,
} from "../src/usage";

// Local wall-clock, not an epoch: every key here is a *calendar* day in the user's
// own timezone, so the fixtures are built the same way the code reads them.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(noon(2027, 3, 14));
  // The two rollup records are module-level state the app keeps for its whole run;
  // tests reset them in place, since the exported binding is the live object.
  for (const k of Object.keys(usage)) delete usage[k];
  for (const k of Object.keys(usageDetail)) delete usageDetail[k];
  setTokenDays([]);
  setUsageRange(30);
  resetCostBaselines();
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

// A Sess carries far more than addUsage looks at; these are the fields it reads.
const sess = (o: Partial<Sess>): Sess =>
  ({ id: "s1", kind: "claude", model: "Opus 4.8", project: "epi", workdir: "/w/epi", ...o }) as Sess;

// One transcript-scanned day, with only the fields under test spelled out.
const day = (d: string, o: Partial<DayUsage> = {}): DayUsage => ({
  day: d, input: 0, output: 0, cache_read: 0, cache_write: 0,
  opus: 0, sonnet: 0, haiku: 0, other: 0, sessions: 0, projects: {}, ...o,
});

describe("todayKey / uDkey — the calendar-day key both stores are keyed by", () => {
  it("is zero-padded YYYY-MM-DD in local time", () => {
    vi.setSystemTime(noon(2027, 1, 5));
    expect(todayKey()).toBe("2027-01-05");
    expect(uDkey(new Date(2027, 0, 5))).toBe("2027-01-05");
  });
  it("agrees with uDkey, so the rollup and the day window join at all", () => {
    // usageWindow looks costs up by uDkey; addUsage files them under todayKey. If
    // these two ever disagreed, today's spend would silently vanish from the panel.
    expect(todayKey()).toBe(uDkey(new Date()));
  });
  it("reads the local day, not UTC's", () => {
    // 00:30 local is still "today" even where that is yesterday in UTC.
    vi.setSystemTime(new Date(2027, 11, 31, 0, 30, 0));
    expect(todayKey()).toBe("2027-12-31");
  });
});

describe("costDelta — what a running total owes the day", () => {
  it("books the whole first reading, since nothing was counted before it", () => {
    expect(costDelta("conv", 1.25)).toBe(1.25);
  });
  it("books only the increment while the counter climbs", () => {
    costDelta("conv", 1.25);
    expect(costDelta("conv", 3)).toBeCloseTo(1.75, 10);
    expect(costDelta("conv", 3)).toBe(0); // a repeated reading owes nothing
  });
  it("keeps one baseline per conversation, not one per app", () => {
    costDelta("a", 10);
    expect(costDelta("b", 4)).toBe(4); // b's first reading, not b minus a
    expect(costDelta("a", 12)).toBeCloseTo(2, 10);
  });
  it("survives the relaunch that resume performs — the pane changes, the total doesn't", () => {
    // The regression: a drift `Move session` kills the pane and relaunches it seconds
    // later, and Claude carries its running total across. Keyed by the pane this read
    // as $28 of fresh spend; keyed by the conversation it reads as the $2 it was.
    costDelta("conv", 28);
    expect(costDelta("conv", 30)).toBeCloseTo(2, 10);
  });
  it("treats a drop as the counter restarting, and follows it down", () => {
    // /clear, /compact, or a cold start: the new reading is all fresh spend, and the
    // next increment must be measured from there rather than from the stale high.
    costDelta("conv", 40);
    expect(costDelta("conv", 0.5)).toBe(0.5);
    expect(costDelta("conv", 1.5)).toBeCloseTo(1, 10);
  });
});

describe("modelFamily — collapsing display names to a tier", () => {
  it("matches the family anywhere in the name, case-insensitively", () => {
    expect(modelFamily("Claude Opus 4.8")).toBe("Opus");
    expect(modelFamily("sonnet-4-5")).toBe("Sonnet");
    expect(modelFamily("Haiku 4.5")).toBe("Haiku");
  });
  it("distinguishes an unrecognised model from no model at all", () => {
    expect(modelFamily("gpt-9")).toBe("Other");
    expect(modelFamily("")).toBe("Unknown");
  });
});

describe("addUsage — the daily $ rollup", () => {
  it("ignores anything that isn't a positive delta", () => {
    // The caller passes cost - (s.cost ?? 0); a repeated statusLine gives 0, and a
    // session whose cost resets would give a negative. Neither is new spend.
    addUsage(0, sess({}));
    addUsage(-1, sess({}));
    addUsage(NaN, sess({}));
    expect(usage).toEqual({});
    expect(store.get("cc-usage")).toBeUndefined();
  });
  it("accumulates today's total and persists it", () => {
    addUsage(1.5);
    addUsage(0.25);
    expect(usage["2027-03-14"]).toBeCloseTo(1.75, 10);
    expect(JSON.parse(store.get("cc-usage")!)["2027-03-14"]).toBeCloseTo(1.75, 10);
  });
  it("files spend under the day it arrived, not one bucket for all time", () => {
    addUsage(2);
    vi.setSystemTime(noon(2027, 3, 15));
    addUsage(3);
    expect(usage).toEqual({ "2027-03-14": 2, "2027-03-15": 3 });
  });
  it("counts the total but records no split when no session is given", () => {
    addUsage(2);
    expect(usage["2027-03-14"]).toBe(2);
    expect(usageDetail).toEqual({});
  });
  it("counts the total but records no split for a non-agent pane", () => {
    // Shell and task panes have no telemetry and no model — attributing their
    // (nonexistent) cost to a model family would be an invention.
    addUsage(2, sess({ kind: "shell" }));
    addUsage(3, sess({ kind: "task" }));
    expect(usage["2027-03-14"]).toBe(5);
    expect(usageDetail).toEqual({});
  });

  describe("the per-model / per-project split", () => {
    it("attributes the delta to the model live at the time", () => {
      addUsage(1, sess({ model: "Claude Opus 4.8" }));
      addUsage(2, sess({ model: "Sonnet 4.5" }));
      addUsage(4, sess({ model: "Claude Opus 4.8" }));
      expect(usageDetail["2027-03-14"].models).toEqual({ Opus: 5, Sonnet: 2 });
    });
    it("attributes it to the session's project", () => {
      addUsage(1, sess({ project: "epi" }));
      addUsage(2, sess({ project: "gb" }));
      expect(usageDetail["2027-03-14"].projects).toEqual({ epi: 1, gb: 2 });
    });
    it("falls back to the workdir's basename, then to \"unknown\"", () => {
      addUsage(1, sess({ project: "", workdir: "E:\\Programming\\respeak" }));
      addUsage(2, sess({ project: "", workdir: "" }));
      expect(usageDetail["2027-03-14"].projects).toEqual({ respeak: 1, unknown: 2 });
    });
    it("records each contributing session once, however many deltas it sends", () => {
      addUsage(1, sess({ id: "a" }));
      addUsage(1, sess({ id: "a" }));
      addUsage(1, sess({ id: "b" }));
      expect(usageDetail["2027-03-14"].sessions).toEqual(["a", "b"]);
    });
    it("persists the split under its own key, leaving the totals alone", () => {
      addUsage(1, sess({ id: "a", model: "Haiku 4.5", project: "epi" }));
      expect(JSON.parse(store.get("cc-usage-detail")!)).toEqual({
        "2027-03-14": { models: { Haiku: 1 }, projects: { epi: 1 }, sessions: ["a"] },
      });
      expect(JSON.parse(store.get("cc-usage")!)).toEqual({ "2027-03-14": 1 });
    });
  });
});

describe("setTokenDays — handing the transcript scan's result down", () => {
  it("replaces the days, stamps the scan time and persists both", () => {
    setTokenDays([day("2027-03-14", { input: 5 })]);
    expect(tokenDays).toHaveLength(1);
    expect(tokenScanAt).toBe(Date.now());
    expect(JSON.parse(store.get("cc-usage-tokens")!)[0].input).toBe(5);
    expect(store.get("cc-usage-tokens-at")).toBe(String(Date.now()));
  });
});

describe("usageWindow — joining the rollup to the scanned tokens", () => {
  it("returns n calendar days ending today, oldest first", () => {
    expect(usageWindow(3).map((d) => d.key)).toEqual(["2027-03-12", "2027-03-13", "2027-03-14"]);
  });
  it("walks back across a month boundary by calendar, not by 30-day arithmetic", () => {
    vi.setSystemTime(noon(2027, 3, 2));
    expect(usageWindow(4).map((d) => d.key)).toEqual(["2027-02-27", "2027-02-28", "2027-03-01", "2027-03-02"]);
  });
  it("walks back across a year boundary", () => {
    vi.setSystemTime(noon(2027, 1, 1));
    expect(usageWindow(2).map((d) => d.key)).toEqual(["2026-12-31", "2027-01-01"]);
  });
  it("carries each day's cost from the rollup", () => {
    usage["2027-03-13"] = 4.5;
    const w = usageWindow(2);
    expect(w.map((d) => d.cost)).toEqual([4.5, 0]); // a day with no spend reads 0, not undefined
  });
  it("sums all four token kinds into `tok`", () => {
    setTokenDays([day("2027-03-14", { input: 1, output: 2, cache_read: 4, cache_write: 8 })]);
    expect(usageWindow(1)[0].tok).toBe(15);
  });
  it("leaves a day the scan never saw without a detail record", () => {
    setTokenDays([day("2027-03-14", { input: 1 })]);
    const [older, today] = usageWindow(2);
    expect(older.u).toBeUndefined();
    expect(older.tok).toBe(0);
    expect(today.u?.day).toBe("2027-03-14");
  });
  it("ignores scanned days that fall outside the window", () => {
    setTokenDays([day("2020-01-01", { input: 99 }), day("2027-03-14", { input: 1 })]);
    const w = usageWindow(2);
    expect(w).toHaveLength(2);
    expect(uSum(w, (d) => d.tok)).toBe(1);
  });

  // A calendar walk (setDate) and a 24h-millisecond walk agree everywhere except
  // across a DST transition, where subtracting 86400000ms from local midnight lands
  // at 23:00 the day *before* — so the short day drops out of the window and its
  // neighbour appears twice. Node honours a mid-run TZ change, so we can pin a zone
  // that actually observes DST; where it doesn't take, the case is unobservable and
  // the test says "skipped" rather than passing on nothing.
  const dstZoneTakes = (() => {
    const was = process.env.TZ;
    process.env.TZ = "America/New_York";
    const ok = new Date(2027, 2, 1).getTimezoneOffset() === 300 && new Date(2027, 2, 15).getTimezoneOffset() === 240;
    process.env.TZ = was;
    return ok;
  })();

  describe("across a DST spring-forward", () => {
    const realTz = process.env.TZ;
    beforeEach(() => { process.env.TZ = "America/New_York"; vi.setSystemTime(noon(2027, 3, 15)); });
    afterEach(() => { process.env.TZ = realTz; });

    it.skipIf(!dstZoneTakes)("still lists every calendar day, including the 23-hour one", () => {
      // 2027-03-14 is the spring-forward day in US Eastern.
      expect(usageWindow(4).map((d) => d.key)).toEqual(["2027-03-12", "2027-03-13", "2027-03-14", "2027-03-15"]);
    });
    it.skipIf(!dstZoneTakes)("keeps that day's spend attached to it", () => {
      usage["2027-03-14"] = 7;
      expect(usageWindow(4).map((d) => d.cost)).toEqual([0, 0, 7, 0]);
    });
  });
});

describe("uSum / uModels — the two summaries the panel builds on", () => {
  it("uSum totals whatever accessor it is given", () => {
    const w: UDay[] = [{ key: "a", cost: 1, tok: 10 }, { key: "b", cost: 2, tok: 20 }];
    expect(uSum(w, (d) => d.cost)).toBe(3);
    expect(uSum(w, (d) => d.tok)).toBe(30);
    expect(uSum([], (d) => d.cost)).toBe(0);
  });
  it("uModels sums per family across days and keeps all four keys present", () => {
    // The bar chart indexes by a fixed key set, so a family with no tokens must
    // read 0 rather than be missing.
    const w: UDay[] = [
      { key: "a", cost: 0, tok: 0, u: day("a", { opus: 1, sonnet: 2 }) },
      { key: "b", cost: 0, tok: 0, u: day("b", { opus: 4, other: 8 }) },
      { key: "c", cost: 0, tok: 0 }, // never scanned — contributes nothing
    ];
    expect(uModels(w)).toEqual({ Opus: 5, Sonnet: 2, Haiku: 0, Other: 8 });
    expect(uModels([])).toEqual({ Opus: 0, Sonnet: 0, Haiku: 0, Other: 0 });
  });
});

describe("uBuckets — the bar chart's x-axis, one shape per range", () => {
  it("gives a bucket per day at 7D, labelled by day of month", () => {
    setUsageRange(7);
    const b = uBuckets();
    expect(b).toHaveLength(7);
    expect(b.map((x) => x.label)).toEqual(["8", "9", "10", "11", "12", "13", "14"]);
    expect(b[6].tip).toBe("Mar 14");
  });
  it("stays daily at 30D — the range that spans two months", () => {
    setUsageRange(30);
    const b = uBuckets();
    expect(b).toHaveLength(30);
    expect(b[0].tip).toBe("Feb 13");
    expect(b[29].tip).toBe("Mar 14");
  });
  it("totals a bucket from its days' per-model tokens", () => {
    setUsageRange(7);
    setTokenDays([day("2027-03-14", { opus: 3, haiku: 4 })]);
    const last = uBuckets()[6];
    expect(last.models).toEqual({ Opus: 3, Sonnet: 0, Haiku: 4, Other: 0 });
    expect(last.total).toBe(7);
  });
  it("buckets 90D into weeks of seven, labelled by the week's first day", () => {
    setUsageRange(90);
    const b = uBuckets();
    expect(b).toHaveLength(13); // 12 full weeks + a 6-day remainder, never dropped
    expect(b[0].tip).toMatch(/^Week of /);
    expect(b[0].label).toBe("12/15"); // 89 days before Mar 14 2027
  });
  it("buckets 12M by calendar month, labelled by month name", () => {
    setUsageRange(365);
    const b = uBuckets();
    expect(b).toHaveLength(13); // 365 days back from mid-March spans 13 months
    expect(b[0].label).toBe("Mar");
    expect(b[0].tip).toBe("Mar 2026");
    expect(b[b.length - 1].tip).toBe("Mar 2027");
  });
  it("groups by year as well as month, so two Marches don't merge", () => {
    setUsageRange(365);
    const labels = uBuckets().map((x) => x.tip);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
