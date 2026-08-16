import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject import
import {
  addIo, addUsage, costDelta, dayIo, daySpend, flushIo, flushUsageDetail, installGrown,
  ioCreditBps, ioDayCount, ioDelta, ioExcludedMb, ioSameNote, ioTotal,
  modelFamily,
  resetCostBaselines, resetIoRollup, resetUsageWrites, setTokenDays, setUsageRange, splitIo,
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
  resetIoRollup();
  resetUsageWrites();
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
  it("persists the baseline, so quitting and restoring doesn't re-book the total", () => {
    // The half a run-scoped map couldn't cover. `cc-usage` is localStorage and survives
    // the quit; a baseline that didn't meant the restored pane's first reading met an
    // empty map and paid the day twice — the same bug, by the commonest route to it.
    costDelta("conv", 28);
    expect(store.get("cc-cost-base")).toContain("conv");
    const fresh = new Map(Object.entries(JSON.parse(store.get("cc-cost-base")!)));
    expect((fresh.get("conv") as { t: number }).t).toBe(28);
  });
  it("re-reads a persisted baseline on the next boot", async () => {
    // A real restart, as far as a unit test can stage one: seed the key, then evaluate
    // the module again. `conv` owes the increment, not the carried-over total.
    store.set("cc-cost-base", JSON.stringify({ conv: { t: 28, at: Date.now() } }));
    vi.resetModules();
    const { costDelta: booted } = await import("../src/usage");
    expect(booted("conv", 30)).toBeCloseTo(2, 10);
  });
  it("ignores a corrupt baseline key rather than failing to boot", async () => {
    store.set("cc-cost-base", "{not json");
    vi.resetModules();
    const { costDelta: booted } = await import("../src/usage");
    expect(booted("conv", 5)).toBe(5); // no baseline, so the whole reading — never a throw
  });
  it("caps the persisted map, evicting the conversations touched longest ago", async () => {
    vi.resetModules();
    const { costDelta: booted, resetCostBaselines: reset } = await import("../src/usage");
    reset();
    // 501 conversations, each stamped a minute apart, so "oldest" is unambiguous.
    for (let i = 0; i <= 500; i++) {
      vi.setSystemTime(new Date(2027, 2, 14, 12, 0, 0).getTime() + i * 60_000);
      booted(`c${i}`, 1);
    }
    const saved = JSON.parse(store.get("cc-cost-base")!) as Record<string, unknown>;
    expect(Object.keys(saved)).toHaveLength(500);
    expect(saved.c0).toBeUndefined();   // the first one touched fell off
    expect(saved.c500).toBeDefined();   // the most recent survived
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
    it("accumulates each contributing session's own spend, however many deltas it sends", () => {
      addUsage(1, sess({ id: "a" }));
      addUsage(1, sess({ id: "a" }));
      addUsage(1, sess({ id: "b" }));
      expect(usageDetail["2027-03-14"].sess!.a.usd).toBe(2);
      expect(usageDetail["2027-03-14"].sess!.b.usd).toBe(1);
    });
    it("re-stamps the title, because a session earns its first dollar before it has one", () => {
      // Claude names the conversation from its content, so the pane starts untitled and
      // is already spending. Write-once here left the busiest rows permanently unnamed.
      addUsage(1, sess({ id: "a", title: "" }));
      addUsage(1, sess({ id: "a", title: "Fix the router" }));
      expect(usageDetail["2027-03-14"].sess!.a.title).toBe("Fix the router");
    });
    it("keeps the last title rather than blanking it when one arrives empty", () => {
      addUsage(1, sess({ id: "a", title: "Fix the router" }));
      addUsage(1, sess({ id: "a", title: "" }));
      expect(usageDetail["2027-03-14"].sess!.a.title).toBe("Fix the router");
    });
    it("persists the split under its own key, leaving the totals alone", () => {
      addUsage(1, sess({ id: "a", model: "Haiku 4.5", project: "epi", title: "t" }));
      expect(JSON.parse(store.get("cc-usage-detail")!)).toEqual({
        "2027-03-14": {
          models: { Haiku: 1 }, projects: { epi: 1 },
          sess: { a: { usd: 1, title: "t", project: "epi" } },
        },
      });
      expect(JSON.parse(store.get("cc-usage")!)).toEqual({ "2027-03-14": 1 });
    });
  });

  describe("what gets written, and how often", () => {
    it("writes the day's money on every delta — it is small and nobody can rebuild it", () => {
      addUsage(1, sess({}));
      addUsage(2, sess({}));
      expect(JSON.parse(store.get("cc-usage")!)["2027-03-14"]).toBe(3);
    });

    it("does NOT rewrite the 25KB split on every delta", () => {
      // Measured on a real store: `cc-usage-detail` is 24,586 chars against
      // `cc-usage`'s 980, and both were written on the same trigger — a statusLine per
      // session every 3s. Attribution can lag by a minute; money cannot.
      addUsage(1, sess({}));            // the first write establishes the key
      store.clear();
      addUsage(2, sess({}));
      expect(usageDetail["2027-03-14"].projects.epi).toBe(3); // memory, current
      expect(store.get("cc-usage-detail")).toBeUndefined();   // disk, not yet
    });

    it("writes the split once the floor has passed", () => {
      addUsage(1, sess({}));
      store.clear();
      vi.advanceTimersByTime(30_000);
      addUsage(2, sess({}));
      expect(JSON.parse(store.get("cc-usage-detail")!)["2027-03-14"].projects.epi).toBe(3);
    });

    it("writes the split across a midnight regardless of the floor", () => {
      addUsage(1, sess({}));
      store.clear();
      vi.setSystemTime(noon(2027, 3, 15));
      addUsage(2, sess({}));
      expect(Object.keys(JSON.parse(store.get("cc-usage-detail")!))).toEqual(["2027-03-14", "2027-03-15"]);
    });

    it("flushUsageDetail writes what the floor is holding", () => {
      addUsage(1, sess({}));
      store.clear();
      addUsage(2, sess({}));
      flushUsageDetail();
      expect(JSON.parse(store.get("cc-usage-detail")!)["2027-03-14"].projects.epi).toBe(3);
    });

    it("caps both rollups by day, so a daily key cannot grow forever", () => {
      // 33 days after two months and unbounded; the Usage panel's widest range is 12
      // months, so a year and a bit is everything anything reads.
      for (let i = 0; i < 425; i++) {
        vi.setSystemTime(new Date(2027, 0, 1 + i, 12, 0, 0));
        addUsage(1, sess({}));
      }
      flushUsageDetail();
      expect(Object.keys(usage)).toHaveLength(420);
      expect(Object.keys(usageDetail)).toHaveLength(420);
      expect(usage["2027-01-01"]).toBeUndefined();  // the oldest days fell off
    });
  });
});

describe("costDelta — what it persists, and when", () => {
  it("writes the baseline when the figure moved", () => {
    costDelta("conv", 5);
    expect(JSON.parse(store.get("cc-cost-base")!).conv.t).toBe(5);
    store.clear();
    costDelta("conv", 9);
    expect(JSON.parse(store.get("cc-cost-base")!).conv.t).toBe(9);
  });

  it("writes NOTHING when a repeated statusLine reports the same total", () => {
    // The statusLine fires every 3s per session whether or not anything was spent, so
    // this used to write the whole map to disk once a second on an idle fleet — the
    // same bytes, for a change of `at` alone, which only orders eviction.
    costDelta("conv", 5);
    store.clear();
    expect(costDelta("conv", 5)).toBe(0);
    expect(store.get("cc-cost-base")).toBeUndefined();
  });

  it("still writes when a counter restarts below its baseline", () => {
    costDelta("conv", 40);
    store.clear();
    expect(costDelta("conv", 0.5)).toBe(0.5);
    expect(JSON.parse(store.get("cc-cost-base")!).conv.t).toBe(0.5);
  });
});

describe("daySpend — where today's money went", () => {
  const detail = (o: Partial<(typeof usageDetail)[string]>) =>
    ({ "2027-03-14": { models: {}, projects: {}, ...o } });

  it("ranks projects and sessions by spend, biggest first", () => {
    const d = daySpend(detail({
      projects: { epi: 1, gb: 4, other: 2 },
      sess: { a: { usd: 1, title: "small", project: "epi" }, b: { usd: 6, title: "big", project: "gb" } },
    }), "2027-03-14", 7);
    expect(d.projects.map((r) => r.label)).toEqual(["gb", "other", "epi"]);
    expect(d.sessions.map((r) => r.label)).toEqual(["big", "small"]);
    expect(d.sessions[0].sub).toBe("gb"); // the project rides along as the subtitle
  });

  it("names what the split cannot account for rather than dropping it", () => {
    // The whole reason this row exists: a list that summed lower than the footer segment
    // it opened from would read as money going missing.
    const d = daySpend(detail({ projects: { epi: 2 } }), "2027-03-14", 5);
    expect(d.projects.at(-1)).toEqual({ key: "", label: "unattributed", sub: "", usd: 3 });
    expect(d.split).toBe(2);
  });

  it("gives the SESSION list its own remainder — the two splits fall short separately", () => {
    // The day you upgrade, exactly: the day's total is already banked and the projects
    // split with it, while a per-session split introduced by that build starts from
    // whatever is spent after it. Covering only projects left this list quietly short.
    const d = daySpend(detail({
      projects: { epi: 5 },
      sess: { a: { usd: 2, title: "late starter", project: "epi" } },
    }), "2027-03-14", 5);
    expect(d.projects.map((r) => r.label)).toEqual(["epi"]);          // complete
    expect(d.sessions.map((r) => r.label)).toEqual(["late starter", "unattributed"]);
    expect(d.sessions.at(-1)!.usd).toBe(3);
  });

  it("does not invent a remainder out of floating-point dust", () => {
    // Both figures are sums of the same deltas in a different order, so a fully
    // attributed day still differs in the last place. A "$0.00 unattributed" row is
    // noise that reads as a bug.
    const d = daySpend(detail({ projects: { epi: 0.1 + 0.2 } }), "2027-03-14", 0.3);
    expect(d.projects.map((r) => r.label)).toEqual(["epi"]);
  });

  it("leaves a split with nothing in it empty rather than adding a lone mystery row", () => {
    // A day that predates the record entirely. One anonymous row claiming the whole day
    // reads as a session nobody can identify; the reader says so in words instead.
    const d = daySpend({}, "2027-03-14", 12);
    expect(d.projects).toEqual([]);
    expect(d.sessions).toEqual([]);
    expect(d.total).toBe(12); // the money is still stated, at the top
  });
});

describe("ioDelta / addIo — banking a counter that restarts", () => {
  it("books the whole first reading: this run spawned those processes", () => {
    expect(ioDelta({ r: 5, w: 2 }, null)).toEqual({ r: 5, w: 2 });
  });

  it("books only the increment once there is a previous reading", () => {
    expect(ioDelta({ r: 9, w: 4 }, { r: 5, w: 2 })).toEqual({ r: 4, w: 2 });
  });

  it("clamps a drop to zero instead of booking a negative day", () => {
    // Not an edge case — every Episko launch is one. The counters belong to processes
    // this run spawned, so they start near zero and the reading goes *down*.
    expect(ioDelta({ r: 1, w: 0 }, { r: 900, w: 400 })).toEqual({ r: 0, w: 0 });
  });

  it("accumulates increments into today and persists them", () => {
    addIo({ r: 10, w: 4 });
    addIo({ r: 25, w: 9 });
    expect(dayIo["2027-03-14"]).toEqual({ r: 25, w: 9 });
    flushIo(); // the second reading is inside the write floor — see the tests below
    expect(JSON.parse(store.get("cc-io")!)["2027-03-14"]).toEqual({ r: 25, w: 9 });
  });

  it("spreads an increment measured across a midnight over both days", () => {
    // noon → noon is 24h, half either side of midnight, so the 20/6 increment splits
    // evenly. Booking all of it to the 15th (what this did before) is the bug: the
    // bytes were churned across both days and only the *poll* happened on the second.
    addIo({ r: 10, w: 4 });
    vi.setSystemTime(noon(2027, 3, 15));
    addIo({ r: 30, w: 10 });
    expect(dayIo["2027-03-14"]).toEqual({ r: 20, w: 7 });
    expect(dayIo["2027-03-15"]).toEqual({ r: 10, w: 3 });
  });

  it("leaves the ordinary within-a-day increment as one bucket", () => {
    addIo({ r: 10, w: 4 });
    vi.advanceTimersByTime(4000);
    addIo({ r: 30, w: 10 });
    expect(dayIo["2027-03-14"]).toEqual({ r: 30, w: 10 });
    expect(dayIo["2027-03-15"]).toBeUndefined();
  });

  it("writes nothing when the disk was idle between polls", () => {
    addIo({ r: 10, w: 4 });
    store.clear();
    addIo({ r: 10, w: 4 });
    expect(store.get("cc-io")).toBeUndefined();
  });

  // The poll behind this runs every 4s for as long as a session is on stage. Persisting
  // every reading would make a *disk-I/O meter* one of the app's heaviest writers.
  it("keeps accumulating in memory but does not write on every poll", () => {
    addIo({ r: 10, w: 4 });   // the first write establishes the key
    store.clear();
    vi.advanceTimersByTime(4000);
    addIo({ r: 20, w: 8 });
    vi.advanceTimersByTime(4000);
    addIo({ r: 30, w: 12 });
    expect(dayIo["2027-03-14"]).toEqual({ r: 30, w: 12 }); // in memory, current
    expect(store.get("cc-io")).toBeUndefined();            // on disk, not yet
  });

  it("writes once the floor has passed", () => {
    addIo({ r: 10, w: 4 });
    store.clear();
    vi.advanceTimersByTime(60_000);
    addIo({ r: 30, w: 12 });
    expect(JSON.parse(store.get("cc-io")!)["2027-03-14"]).toEqual({ r: 30, w: 12 });
  });

  it("writes across a midnight regardless of the floor", () => {
    // Nothing adds to yesterday again, so a throttled write would drop its last minutes
    // permanently rather than merely late.
    addIo({ r: 10, w: 4 });
    store.clear();
    vi.setSystemTime(noon(2027, 3, 15));
    addIo({ r: 12, w: 5 });
    const saved = JSON.parse(store.get("cc-io")!);
    expect(saved["2027-03-14"]).toEqual({ r: 11, w: 4.5 }); // its own 10/4 + half the split
    expect(saved["2027-03-15"]).toEqual({ r: 1, w: 0.5 });
  });

  it("flushIo writes what the floor is still holding, and is a no-op when clean", () => {
    addIo({ r: 10, w: 4 });
    store.clear();
    addIo({ r: 30, w: 12 });   // inside the floor — not written
    flushIo();
    expect(JSON.parse(store.get("cc-io")!)["2027-03-14"]).toEqual({ r: 30, w: 12 });
    store.clear();
    flushIo();
    expect(store.get("cc-io")).toBeUndefined();
  });

  // The constraint the heartbeat has to meet: a disk meter must not become a heavy
  // writer. Sampling more often must not persist more often — the floor decides that,
  // not the caller — so adding a 60s sampler cannot cost more than the 4s poll already
  // does, and on an idle fleet costs nothing at all.
  it("does not write more often at the heartbeat's cadence than at the on-stage poll's", () => {
    const HOUR = 3600_000;
    const writesOver = (stepMs: number) => {
      resetIoRollup();
      const spy = vi.spyOn(localStorage, "setItem");
      for (let t = 0, mb = 0; t < HOUR; t += stepMs) {
        addIo({ r: ++mb, w: mb });   // never idle: something to persist on every sample
        vi.advanceTimersByTime(stepMs);
      }
      const n = spy.mock.calls.length;
      spy.mockRestore();
      return n;
    };
    const onStage = writesOver(4_000);     // the 4s poll, with a session on stage
    const heartbeat = writesOver(60_000);  // the heartbeat, with nothing on stage
    expect(heartbeat).toBeLessThanOrEqual(onStage);
    expect(heartbeat).toBeLessThanOrEqual(61);   // ~one a minute, not one a sample
  });

  it("writes nothing at all on a heartbeat over an idle fleet", () => {
    addIo({ r: 10, w: 4 });
    store.clear();
    for (let t = 0; t < 3600_000; t += 60_000) {
      vi.advanceTimersByTime(60_000);
      addIo({ r: 10, w: 4 });   // the counters have not moved
    }
    expect(store.get("cc-io")).toBeUndefined();
  });

  it("sums every recorded day, and answers NULL when nothing is recorded", () => {
    // Not `{r:0,w:0}`: an empty rollup means we did not keep this, and a confident zero
    // would claim the disk sat idle. The row renders the two differently.
    expect(ioTotal()).toBeNull();
    addIo({ r: 10, w: 4 });
    vi.setSystemTime(noon(2027, 3, 15));
    addIo({ r: 30, w: 10 });
    expect(ioTotal()).toEqual({ r: 30, w: 10 });
    expect(ioDayCount()).toBe(2);
  });
});

// A Claude Code self-update writes a whole new ~290 MiB binary, and the process that does
// it is one of ours — so the kernel charges those bytes to a session and the day reads as
// 300 MiB of agent churn, thirty times a hard day's real work, on the first launch after a
// few days away. Measured on this machine (2026-08-16): 292.8 MiB written by the session's
// own pid within a minute of app start, its counter still afterwards, while Episko's own
// process wrote 0.8 MiB. The size of the binary on disk is exactly how much to take back.
describe("addIo — a claude self-update is not session churn", () => {
  const KEY = "2027-03-14";
  const INSTALLED = [{ name: "2.1.232", mb: 292 }];
  const UPDATED = [{ name: "2.1.232", mb: 292 }, { name: "2.1.233", mb: 293 }];

  it("counts a binary that arrived or grew, and nothing else", () => {
    expect(installGrown(UPDATED, new Map([["2.1.232", 292]]))).toBe(293);   // arrival
    expect(installGrown([{ name: "a", mb: 10 }], new Map([["a", 4]]))).toBe(6); // in place
    // A pruned version frees space; it never wrote anything. And the first reading of a
    // run is a baseline, never a credit: what was installed before Episko started was
    // never charged to a process we measure.
    expect(installGrown([{ name: "a", mb: 10 }], new Map([["a", 10], ["old", 280]]))).toBe(0);
    expect(installGrown(UPDATED, null)).toBe(0);
  });

  it("discounts a version that appeared in the same window as the bytes", () => {
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 3, w: 300 }, UPDATED);        // +299 written, 293 of it a new binary
    expect(dayIo[KEY].w).toBeCloseTo(7, 5);  // the 1 already banked + the 6 that was churn
    expect(dayIo[KEY].r).toBe(3);            // reads are left alone — see ioFigures
    expect(ioExcludedMb()).toBeCloseTo(293, 5);
  });

  it("takes the bytes back out of the day when they were booked before the binary appeared", () => {
    // The flush of a 290 MiB file and its appearance in the directory need not land in the
    // same four-second window, and write-then-rename puts them in this order.
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 3, w: 300 }, INSTALLED);
    expect(dayIo[KEY].w).toBe(300);
    vi.advanceTimersByTime(4000);
    addIo({ r: 3, w: 300 }, UPDATED);
    expect(dayIo[KEY].w).toBeCloseTo(7, 5);
  });

  it("credits a binary written in place across as many polls as it takes", () => {
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 1, w: 101 }, [...INSTALLED, { name: "2.1.233", mb: 100 }]);
    expect(dayIo[KEY].w).toBeCloseTo(1, 5);
    vi.advanceTimersByTime(4000);
    addIo({ r: 1, w: 294 }, UPDATED);
    expect(dayIo[KEY].w).toBeCloseTo(1, 5);
  });

  it("never discounts a version that was already installed when the run began", () => {
    addIo({ r: 1, w: 300 }, INSTALLED);
    expect(dayIo[KEY].w).toBe(300);
    expect(ioExcludedMb()).toBe(0);
  });

  it("bounds the discount by what this run actually reported", () => {
    // The update was installed by a claude running *outside* Episko: those bytes were
    // never charged to a session of ours, so there is next to nothing to give back — and
    // an earlier run's real churn must not be handed over to pay for it.
    dayIo[KEY] = { r: 0, w: 500 };
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 2, w: 3 }, UPDATED);
    expect(dayIo[KEY].w).toBe(500);   // this run's 3 MiB is the most that could come off
  });

  it("drops a credit nothing ever claims instead of discounting later work", () => {
    // Otherwise a foreign update leaves a standing 290 MiB discount against whatever a
    // session writes next — which is exactly the failure a size threshold would have had
    // all the time, and it would hide the runaway agent this meter exists to show.
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 1, w: 1 }, UPDATED);
    vi.advanceTimersByTime(11 * 60_000);
    addIo({ r: 1, w: 51 }, UPDATED);        // 50 MiB of real churn, much later
    expect(dayIo[KEY].w).toBeCloseTo(50, 5);
  });

  it("takes the update out of the write RATE as well as the totals", () => {
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    const bank = addIo({ r: 1, w: 294 }, UPDATED);
    expect(bank).toEqual({ credited: 293, windowMs: 4000 });
    // 293 MiB over 4s is the ~73 MiB/s bar the meter would otherwise draw — beside a
    // total that has already disowned those bytes.
    expect(ioCreditBps(bank)).toBeCloseTo((293 * 1024 * 1024) / 4, 0);
    expect(ioCreditBps({ credited: 5, windowMs: 0 })).toBe(0); // a run's first reading
  });

  it("does not write on every poll while a 290 MiB binary is still landing", () => {
    // The discount must not become the heavy writer the floor exists to prevent. A credit
    // spent on the current window takes nothing out of a stored day, so it earns no early
    // write — only the retro half does, and that happens once.
    addIo({ r: 1, w: 1 }, INSTALLED);
    store.clear();
    const spy = vi.spyOn(localStorage, "setItem");
    for (let mb = 10; mb <= 290; mb += 10) {   // 29 polls of a binary growing in place
      vi.advanceTimersByTime(4000);
      addIo({ r: 1, w: 1 + mb }, [...INSTALLED, { name: "2.1.233", mb }]);
    }
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);   // the floor's ~1/minute, no more
    spy.mockRestore();
    expect(dayIo[KEY].w).toBeCloseTo(1, 5);                 // and none of it counted
  });

  it("leaves an install it cannot see alone", () => {
    // npm and Homebrew have no versions directory, and their updates are charged to the
    // package manager rather than to a session, so the backend sends an empty list and
    // every figure is the raw reading.
    addIo({ r: 1, w: 1 }, []);
    vi.advanceTimersByTime(4000);
    addIo({ r: 1, w: 300 }, []);
    expect(dayIo[KEY].w).toBe(300);
  });
});

describe("splitIo — which day an increment belongs to", () => {
  const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h).getTime();

  it("books the whole increment to the poll's day when there is no window", () => {
    // The first poll of a run: nothing to spread over, and the processes are ours.
    expect(splitIo({ r: 8, w: 3 }, 0, at(2027, 3, 14, 12)))
      .toEqual([["2027-03-14", { r: 8, w: 3 }]]);
  });

  it("is one bucket while the window stays inside a day", () => {
    expect(splitIo({ r: 8, w: 3 }, at(2027, 3, 14, 9), at(2027, 3, 14, 17)))
      .toEqual([["2027-03-14", { r: 8, w: 3 }]]);
  });

  it("weights each day by its share of the window, not by which one the poll landed in", () => {
    // 18:00 → 06:00: six hours before midnight, six after. This is the shape of the real
    // failure — an evening of churn read for the first time the next morning.
    expect(splitIo({ r: 100, w: 40 }, at(2027, 3, 14, 18), at(2027, 3, 15, 6)))
      .toEqual([["2027-03-14", { r: 50, w: 20 }], ["2027-03-15", { r: 50, w: 20 }]]);
  });

  it("gives a whole intervening day its whole share", () => {
    const parts = splitIo({ r: 96, w: 48 }, at(2027, 3, 14, 12), at(2027, 3, 16, 12));
    expect(parts.map(([k]) => k)).toEqual(["2027-03-14", "2027-03-15", "2027-03-16"]);
    expect(parts[1][1]).toEqual({ r: 48, w: 24 }); // the full day in the middle: half of 48h
  });

  it("sums to exactly the increment, so the rollup cannot drift from the counter", () => {
    // A share that does not divide cleanly: the remainder rides on the last bucket
    // rather than being shed a float at a time, once per poll, forever.
    const d = { r: 1 / 3, w: 7 };
    const parts = splitIo(d, at(2027, 3, 14, 5), at(2027, 3, 16, 19));
    const r = parts.reduce((a, [, p]) => a + p.r, 0);
    const w = parts.reduce((a, [, p]) => a + p.w, 0);
    expect(r).toBe(d.r);
    expect(w).toBe(d.w);
  });

  it("refuses to smear across a window no polling gap explains", () => {
    // A clock jump or a machine that slept for a month. Spreading over it would invent
    // activity on days the app was not running; the end day is where the doubt goes.
    const parts = splitIo({ r: 10, w: 5 }, at(2027, 1, 1), at(2027, 3, 14, 12));
    expect(parts.length).toBeLessThanOrEqual(8);
    expect(parts[parts.length - 1][0]).toBe("2027-03-14");
  });

  it("does not book backwards when the clock goes back", () => {
    expect(splitIo({ r: 4, w: 2 }, at(2027, 3, 16), at(2027, 3, 14, 12)))
      .toEqual([["2027-03-14", { r: 4, w: 2 }]]);
  });
});

// Why the I/O row can be clicked and not appear to change. The three windows really do
// coincide early on, and the note is the only thing standing between "correct" and
// "this button is broken".
describe("ioSameNote — the three I/O windows reading alike", () => {
  const A = "1.0 MB read · 2.0 MB written";
  const B = "9.0 MB read · 3.0 MB written";

  it("explains a first day, where all three are the same by construction", () => {
    // `all` == `today` because one day is recorded; `run` == `today` because ioDelta
    // banks the whole counter on the first poll. Both are right, and together they make
    // every position of the control read identically.
    const n = ioSameNote(A, A, A, 1);
    expect(n).toMatch(/only day recorded/);
    expect(n).toMatch(/this run/);
  });

  it("does not blame the day count once several days are recorded", () => {
    expect(ioSameNote(A, A, A, 5)).toBe("All three windows happen to read the same right now.");
  });

  it("names the run when only the run coincides", () => {
    expect(ioSameNote(A, A, B, 3)).toMatch(/all this run/);
  });

  it("names the record when only the total coincides", () => {
    expect(ioSameNote(A, B, A, 1)).toMatch(/everything recorded/);
  });

  it("says NOTHING once the windows genuinely differ — absent, not empty", () => {
    expect(ioSameNote(A, B, "3.0 MB read · 1.0 MB written", 4)).toBeNull();
  });

  it("compares what is rendered, so a sub-unit difference is still 'the same'", () => {
    // The reader sees `fmtMb` output, not floats. Two figures that round together are
    // one figure as far as "why didn't it change?" is concerned.
    expect(ioSameNote(A, A, A, 2)).not.toBeNull();
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
