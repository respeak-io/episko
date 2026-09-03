import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CLAUDE_CLI, type Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject import
import {
  addIo, addUsage, costDelta, dayIo, daySpend, flushIo, flushUsageDetail, installGrown,
  ioCreditBps, ioDayCount, ioDelta, ioExcludedMb, ioSameNote, ioTotal,
  modelFamily,
  resetCostBaselines, resetIoRollup, resetUsageWrites, setTokenDays, setUsageRange, splitIo,
  todayKey, tokenDays, tokenScanAt, uBuckets, uDkey, uModels, usage, usageDetail,
  usageWindow, uSum, type DayUsage, type UDay,
} from "../src/usage";

// Local wall-clock: every key is a calendar day in the user's own timezone.
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(noon(2027, 3, 14));
  // usage and usageDetail are the live module bindings, so they are emptied in place.
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
  ({ id: "s1", kind: "agent", provider: "claude", capabilities: [...CLAUDE_CLI.capabilities], model: "Opus 4.8", project: "epi", workdir: "/w/epi", ...o }) as Sess;

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
    // usageWindow reads by uDkey and addUsage files by todayKey; a disagreement drops today's spend.
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
    // A drift Move session relaunches the pane seconds later and Claude carries its total across.
    costDelta("conv", 28);
    expect(costDelta("conv", 30)).toBeCloseTo(2, 10);
  });
  it("lets two live panes share a conversation without booking each other's totals", () => {
    // Two live panes on one conversation report independent counters; each must measure
    // against its own last reading, or every lower reading re-books the whole total.
    expect(costDelta("conv", 10, true, "p1")).toBe(10);
    expect(costDelta("conv", 0.5, true, "p2")).toBe(0.5); // p2's own counter from ~0, not a reset of p1's
    expect(costDelta("conv", 10.2, true, "p1")).toBeCloseTo(0.2, 10); // p1 unmoved by p2's lower reading
    expect(costDelta("conv", 0.7, true, "p2")).toBeCloseTo(0.2, 10);
  });
  it("hands a conversation's tip to a pane it has never met — the restore path", () => {
    // A restored pane has a new id but Claude carries the total across; measure from the tip.
    costDelta("conv", 100, true, "p1");
    expect(costDelta("conv", 100.2, true, "p2")).toBeCloseTo(0.2, 10);
  });
  it("keeps the per-pane split across a reboot, and sheds a corrupt one to the tip", async () => {
    costDelta("conv", 10, true, "p1");
    costDelta("conv", 0.5, true, "p2");
    vi.resetModules();
    const { costDelta: booted } = await import("../src/usage");
    expect(booted("conv", 0.7, true, "p2")).toBeCloseTo(0.2, 10); // p2's baseline, not p1's tip
    // And an entry whose `o` was hand-mangled still boots, seeding from `t` alone.
    store.set("cc-cost-base", JSON.stringify({ conv: { t: 28, at: Date.now(), o: "junk" } }));
    vi.resetModules();
    const { costDelta: rebooted } = await import("../src/usage");
    expect(rebooted("conv", 30, true, "p3")).toBeCloseTo(2, 10);
  });
  it("treats a drop as the counter restarting, and follows it down", () => {
    // /clear, /compact or a cold start: the new reading is all fresh spend.
    costDelta("conv", 40);
    expect(costDelta("conv", 0.5)).toBe(0.5);
    expect(costDelta("conv", 1.5)).toBeCloseTo(1, 10);
  });
  it("persists the baseline, so quitting and restoring doesn't re-book the total", () => {
    // cc-usage survives the quit; a run-scoped baseline met an empty map on restore and
    // paid the day twice.
    costDelta("conv", 28);
    expect(store.get("cc-cost-base")).toContain("conv");
    const fresh = new Map(Object.entries(JSON.parse(store.get("cc-cost-base")!)));
    expect((fresh.get("conv") as { t: number }).t).toBe(28);
  });
  it("re-reads a persisted baseline on the next boot", async () => {
    // A restart, as far as a unit test can stage one: seed the key and evaluate the module again.
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
    // A repeated statusLine gives a delta of 0 and a reset a negative one; neither is new spend.
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
    // Shell and task panes have no model; attributing to a family would be an invention.
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
      // Claude names a conversation from its content, so the pane is spending before it has a title.
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
      // cc-usage-detail is ~25x the size of cc-usage and both landed on every statusLine;
      // attribution can lag by a minute, money cannot.
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
      // The Usage panel's widest range is 12 months, so a year and a bit is all anything reads.
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
    // The statusLine fires every 3s per session whether or not anything was spent;
    // a change of `at` alone only orders eviction.
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
    // A list summing lower than the footer segment it opened from reads as money going missing.
    const d = daySpend(detail({ projects: { epi: 2 } }), "2027-03-14", 5);
    expect(d.projects.at(-1)).toEqual({ key: "", label: "unattributed", sub: "", usd: 3 });
    expect(d.split).toBe(2);
  });

  it("gives the SESSION list its own remainder — the two splits fall short separately", () => {
    // The day a build introduces the session split: the project split is already whole,
    // the session split starts from that moment.
    const d = daySpend(detail({
      projects: { epi: 5 },
      sess: { a: { usd: 2, title: "late starter", project: "epi" } },
    }), "2027-03-14", 5);
    expect(d.projects.map((r) => r.label)).toEqual(["epi"]);          // complete
    expect(d.sessions.map((r) => r.label)).toEqual(["late starter", "unattributed"]);
    expect(d.sessions.at(-1)!.usd).toBe(3);
  });

  it("does not invent a remainder out of floating-point dust", () => {
    // Both figures sum the same deltas in a different order, so a fully attributed day
    // still differs in the last place.
    const d = daySpend(detail({ projects: { epi: 0.1 + 0.2 } }), "2027-03-14", 0.3);
    expect(d.projects.map((r) => r.label)).toEqual(["epi"]);
  });

  it("leaves a split with nothing in it empty rather than adding a lone mystery row", () => {
    // A day that predates the record: one anonymous row would read as a session nobody can identify.
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
    // Every launch is one: the counters belong to processes this run spawned and start near zero.
    expect(ioDelta({ r: 1, w: 0 }, { r: 900, w: 400 })).toEqual({ r: 0, w: 0 });
  });

  it("accumulates increments into today and persists them", () => {
    addIo({ r: 10, w: 4 });
    addIo({ r: 25, w: 9 });
    expect(dayIo["2027-03-14"]).toEqual({ r: 25, w: 9 });
    flushIo(); // the second reading is inside the write floor
    expect(JSON.parse(store.get("cc-io")!)["2027-03-14"]).toEqual({ r: 25, w: 9 });
  });

  it("spreads an increment measured across a midnight over both days", () => {
    // noon → noon is 24h, half either side of midnight, so the increment splits evenly;
    // the bytes were churned across both days and only the poll landed on the second.
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

  // The poll runs every 4s while a session is on stage; a disk-I/O meter must not be a heavy writer.
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
    // Nothing adds to yesterday again, so a throttled write would drop its last minutes for good.
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

  // The floor decides persistence, not the caller: a 60s sampler must not write more than
  // the 4s poll, and nothing at all on an idle fleet.
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
    // Not `{r:0,w:0}`: a confident zero would claim the disk sat idle; the row renders the two apart.
    expect(ioTotal()).toBeNull();
    addIo({ r: 10, w: 4 });
    vi.setSystemTime(noon(2027, 3, 15));
    addIo({ r: 30, w: 10 });
    expect(ioTotal()).toEqual({ r: 30, w: 10 });
    expect(ioDayCount()).toBe(2);
  });
});

// A Claude Code self-update writes a ~290 MiB binary from a pid the kernel charges to a
// session; the binary's size on disk is what to take back (docs/architecture.md).
describe("addIo — a claude self-update is not session churn", () => {
  const KEY = "2027-03-14";
  const INSTALLED = [{ name: "2.1.232", mb: 292 }];
  const UPDATED = [{ name: "2.1.232", mb: 292 }, { name: "2.1.233", mb: 293 }];

  it("counts a binary that arrived or grew, and nothing else", () => {
    expect(installGrown(UPDATED, new Map([["2.1.232", 292]]))).toBe(293);   // arrival
    expect(installGrown([{ name: "a", mb: 10 }], new Map([["a", 4]]))).toBe(6); // in place
    // A pruned version never wrote anything, and a run's first reading is a baseline, never a credit.
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
    // Write-then-rename: the bytes can land a poll before the version appears in the directory.
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
    // An update installed by a claude outside Episko was never charged to a session;
    // an earlier run's real churn must not pay for it.
    dayIo[KEY] = { r: 0, w: 500 };
    addIo({ r: 1, w: 1 }, INSTALLED);
    vi.advanceTimersByTime(4000);
    addIo({ r: 2, w: 3 }, UPDATED);
    expect(dayIo[KEY].w).toBe(500);   // this run's 3 MiB is the most that could come off
  });

  it("drops a credit nothing ever claims instead of discounting later work", () => {
    // A standing 290 MiB discount would hide the runaway agent this meter exists to show.
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
    // 293 MiB over 4s is a ~73 MiB/s bar beside a total that has already disowned those bytes.
    expect(ioCreditBps(bank)).toBeCloseTo((293 * 1024 * 1024) / 4, 0);
    expect(ioCreditBps({ credited: 5, windowMs: 0 })).toBe(0); // a run's first reading
  });

  it("does not write on every poll while a 290 MiB binary is still landing", () => {
    // A credit spent on the current window takes nothing out of a stored day, so it earns
    // no early write; only the retro half does, once.
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
    // npm and Homebrew installs have no versions directory, so the backend sends an empty list.
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
    // 18:00 → 06:00, six hours either side of midnight: an evening of churn read the next morning.
    expect(splitIo({ r: 100, w: 40 }, at(2027, 3, 14, 18), at(2027, 3, 15, 6)))
      .toEqual([["2027-03-14", { r: 50, w: 20 }], ["2027-03-15", { r: 50, w: 20 }]]);
  });

  it("gives a whole intervening day its whole share", () => {
    const parts = splitIo({ r: 96, w: 48 }, at(2027, 3, 14, 12), at(2027, 3, 16, 12));
    expect(parts.map(([k]) => k)).toEqual(["2027-03-14", "2027-03-15", "2027-03-16"]);
    expect(parts[1][1]).toEqual({ r: 48, w: 24 }); // the full day in the middle: half of 48h
  });

  it("sums to exactly the increment, so the rollup cannot drift from the counter", () => {
    // The remainder rides on the last bucket rather than being shed a float at a time, every poll.
    const d = { r: 1 / 3, w: 7 };
    const parts = splitIo(d, at(2027, 3, 14, 5), at(2027, 3, 16, 19));
    const r = parts.reduce((a, [, p]) => a + p.r, 0);
    const w = parts.reduce((a, [, p]) => a + p.w, 0);
    expect(r).toBe(d.r);
    expect(w).toBe(d.w);
  });

  it("refuses to smear across a window no polling gap explains", () => {
    // A clock jump or a month asleep: spreading would invent activity; the doubt goes on the end day.
    const parts = splitIo({ r: 10, w: 5 }, at(2027, 1, 1), at(2027, 3, 14, 12));
    expect(parts.length).toBeLessThanOrEqual(8);
    expect(parts[parts.length - 1][0]).toBe("2027-03-14");
  });

  it("does not book backwards when the clock goes back", () => {
    expect(splitIo({ r: 4, w: 2 }, at(2027, 3, 16), at(2027, 3, 14, 12)))
      .toEqual([["2027-03-14", { r: 4, w: 2 }]]);
  });
});

// The three I/O windows really do coincide early on; the note is what separates "correct"
// from "this button is broken".
describe("ioSameNote — the three I/O windows reading alike", () => {
  const A = "1.0 MB read · 2.0 MB written";
  const B = "9.0 MB read · 3.0 MB written";

  it("explains a first day, where all three are the same by construction", () => {
    // One recorded day makes all == today; ioDelta banking the whole first poll makes run == today.
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
    // The reader sees `fmtMb` output, not floats; two figures that round together are one figure.
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

  // A 24h-millisecond walk lands at 23:00 the day before across a DST spring-forward, so
  // the short day drops out of the window. Node honours a mid-run TZ change; where the
  // zone does not take, the case is unobservable and the test skips rather than passing.
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
    // The bar chart indexes by a fixed key set; a family with no tokens must read 0, not be missing.
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
