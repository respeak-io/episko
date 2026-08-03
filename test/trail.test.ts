import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import type { HistEntry } from "../src/history";
import { usage, usageWindow, type UDay } from "../src/usage";
import {
  dayByProject, dayFacts, dayIsClosed, dayItems, dayKeyOf, deterministicHeadline, dominantProject,
  humanAuthors, projectDayFacts, sharedDay,
  trailDays, trailSession, type TrailCommit, type TrailDay,
} from "../src/trail";

// Local wall-clock, like usage.test.ts: every key the Trail produces is a *calendar*
// day in the user's own timezone, so fixtures are built the way the code reads them.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0);
/// Both backend timestamps are UNIX **seconds**, so fixtures speak seconds too — the
/// bug this guards against is a Date built from seconds, which lands in 1970.
const secs = (d: Date) => Math.floor(d.getTime() / 1000);

const hist = (over: Partial<HistEntry> & { mtime: number }): HistEntry => ({
  session_id: "s1", cwd: "/w/episko", project: "episko", branch: "dev",
  title: "", last_prompt: "", bytes: 10, exists: true, repo_root: "/w/episko",
  ...over,
});

const commit = (over: Partial<TrailCommit> & { when: number }): TrailCommit => ({
  sha: "abc1234", author: "Tim Rietz", subject: "fix: a thing", root: "/w/episko", ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(2027, 3, 14));
  for (const k of Object.keys(usage)) delete usage[k];
  store.clear();
});
afterEach(() => vi.useRealTimers());

describe("day grouping", () => {
  it("groups sessions and commits into the local calendar day they happened", () => {
    const days = usageWindow(3); // 12th, 13th, 14th
    const out = trailDays(
      [hist({ mtime: secs(at(2027, 3, 13, 9)), title: "morning" }),
       hist({ mtime: secs(at(2027, 3, 13, 21)), title: "evening", session_id: "s2" })],
      days,
      [commit({ when: secs(at(2027, 3, 12, 15)) })],
    );
    expect(out.map((d) => d.key)).toEqual(["2027-03-13", "2027-03-12"]); // newest first
    expect(out[0].sessions.map((s) => s.title)).toEqual(["evening", "morning"]); // newest first within a day
    expect(out[1].commits).toHaveLength(1);
  });

  it("splits either side of local midnight rather than by UTC", () => {
    // 23:30 and 00:30 are 1h apart but belong to different calendar days. A UTC-based
    // grouper would put them together (or apart) depending on the runner's offset.
    const days = usageWindow(3);
    const out = trailDays(
      [hist({ mtime: secs(at(2027, 3, 12, 23, 30)), session_id: "late" }),
       hist({ mtime: secs(at(2027, 3, 13, 0, 30)), session_id: "early" })],
      days, [],
    );
    expect(out.map((d) => d.key)).toEqual(["2027-03-13", "2027-03-12"]);
    expect(out[0].sessions[0].id).toBe("early");
    expect(out[1].sessions[0].id).toBe("late");
  });

  it("uses the same day key as the Usage tab, so costs can never disagree", () => {
    // The join is by key; if these two ever drifted the Trail would show a day's
    // sessions against another day's spend.
    expect(dayKeyOf(at(2027, 3, 13, 23, 59).getTime())).toBe(usageWindow(2)[0].key);
  });

  it("joins each day to its cost from the usage rollup", () => {
    usage["2027-03-13"] = 12.5;
    const out = trailDays([hist({ mtime: secs(at(2027, 3, 13)) })], usageWindow(2), []);
    expect(out[0].cost).toBe(12.5);
  });

  it("drops days with nothing in them, but keeps a day that only cost money", () => {
    usage["2027-03-12"] = 3;
    const out = trailDays([hist({ mtime: secs(at(2027, 3, 14)) })], usageWindow(5), []);
    expect(out.map((d) => d.key)).toEqual(["2027-03-14", "2027-03-12"]);
  });

  it("ignores sessions and commits outside the window rather than inventing days", () => {
    const out = trailDays(
      [hist({ mtime: secs(at(2020, 1, 1)) })],
      usageWindow(3),
      [commit({ when: secs(at(2020, 1, 1)) })],
    );
    expect(out).toEqual([]);
  });

  it("reads mtime as seconds", () => {
    // Guards the units trap directly: seconds treated as ms lands in January 1970 and
    // silently falls outside every window.
    const s = trailSession(hist({ mtime: secs(at(2027, 3, 13, 8)) }));
    expect(new Date(s.when).getFullYear()).toBe(2027);
  });
});

describe("headlines", () => {
  const day = (over: Partial<TrailDay>): TrailDay => ({
    key: "2027-03-13", when: at(2027, 3, 13, 0).getTime(), cost: 0, tokens: 0,
    sessions: [], commits: [], events: [], ...over,
  });
  const sess = (project: string, title = "t") =>
    ({ id: title, title, project, colorKey: project, branch: "dev", cwd: "/w", when: 0, exists: true });

  it("says 'mostly X' only when X really dominates", () => {
    expect(deterministicHeadline(day({ sessions: [sess("episko"), sess("episko"), sess("web")] })))
      .toContain("Mostly episko");
    // 2 of 4 is not "mostly" — a headline that overclaims is worse than a plain count.
    expect(deterministicHeadline(day({ sessions: [sess("a"), sess("a"), sess("b"), sess("b")] })))
      .toBe("4 sessions across 2 projects.");
  });

  it("degrades sensibly when there is little to say", () => {
    expect(deterministicHeadline(day({}))).toBe("Quiet day.");
    expect(deterministicHeadline(day({ cost: 2 }))).toBe("Agent time, nothing committed.");
    expect(deterministicHeadline(day({ commits: [commit({ when: 0 })] }))).toBe("1 commit.");
  });

  it("breaks ties deterministically so a repaint never reorders", () => {
    const d = day({ sessions: [sess("beta"), sess("alpha")] });
    expect(dominantProject(d)).toBe(dominantProject(d));
  });
});

describe("summarising", () => {
  it("sends titles and subjects, never transcript bodies", () => {
    const facts = dayFacts({
      key: "2027-03-13", when: 0, cost: 4.2, tokens: 0,
      sessions: [{ id: "a", title: "Usage forecast colours", project: "episko", colorKey: "k", branch: "dev", cwd: "/w", when: 0, exists: true }],
      commits: [commit({ when: 0, subject: "fix: the thing" })], events: [],
    });
    expect(facts).toContain("spend: $4.20");
    expect(facts).toContain("session: Usage forecast colours [episko/dev]");
    expect(facts).toContain("commit: fix: the thing");
  });

  it("bounds a heavy day so the prompt cannot grow without limit", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ({ id: `s${i}`, title: `t${i}`, project: "p", colorKey: "p", branch: "", cwd: "/w", when: 0, exists: true }));
    const facts = dayFacts({ key: "k", when: 0, cost: 0, tokens: 0, sessions: many, commits: [], events: [] }, 5);
    expect(facts).toContain("… and 25 more sessions");
    expect(facts.split("\n").filter((l) => l.startsWith("session:"))).toHaveLength(5);
  });

  it("treats today as still open and every earlier day as final", () => {
    const mk = (key: string) => ({ key, when: 0, cost: 0, tokens: 0, sessions: [], commits: [], events: [] });
    expect(dayIsClosed(mk("2027-03-14"))).toBe(false); // today — may still change
    expect(dayIsClosed(mk("2027-03-13"))).toBe(true);  // over — cache forever
  });
});

describe("a day is split by project", () => {
  const names = (k: string) => k.split("/").pop() || k;
  const s = (id: string, colorKey: string) =>
    ({ id, title: id, project: names(colorKey), colorKey, branch: "", cwd: "/w", when: 1, exists: true });
  const c = (subject: string, root: string): TrailCommit =>
    ({ sha: "a", author: "T", when: 1, subject, root });
  const ev = (n: number, event: "opened" | "closed" | "merged", root: string) =>
    ({ number: n, kind: "pr", event, title: `#${n}`, url: "u", at: "2027-03-13T10:00:00Z", root });
  const day = (over: Partial<TrailDay>): TrailDay =>
    ({ key: "2027-03-13", when: 0, cost: 0, tokens: 0, sessions: [], commits: [], events: [], ...over });

  it("files sessions, commits and events under the project they belong to", () => {
    const groups = dayByProject(day({
      sessions: [s("s1", "/w/episko"), s("s2", "/w/api")],
      commits: [c("fix a", "/w/episko"), c("fix b", "/w/episko")],
      events: [ev(42, "merged", "/w/api")] as never,
    }), names);
    expect(groups.map((g) => g.project)).toEqual(["episko", "api"]); // busiest first
    expect(groups[0].commits).toHaveLength(2);
    expect(groups[1].events).toHaveLength(1);
  });

  it("gives a project a group even when only an event happened there", () => {
    // A PR merging on a day you touched nothing else IS what happened that day.
    const groups = dayByProject(day({ events: [ev(9, "merged", "/w/api")] as never }), names);
    expect(groups.map((g) => g.project)).toEqual(["api"]);
  });

  it("orders identically on a repaint of unchanged state", () => {
    const d = day({ sessions: [s("a", "/w/beta"), s("b", "/w/alpha")] });
    expect(dayByProject(d, names).map((g) => g.project)).toEqual(dayByProject(d, names).map((g) => g.project));
  });
});

describe("the project's own day, as opposed to yours", () => {
  const day = (over: Partial<TrailDay>): TrailDay =>
    ({ key: "2027-03-13", when: 0, cost: 0, tokens: 0, sessions: [], commits: [], events: [], ...over });
  const by = (author: string, subject = "fix: a thing"): TrailCommit =>
    ({ sha: "a", author, when: 1, subject, root: "/w/episko" });

  it("does not count a bot as company", () => {
    // A release tag pushed by CI is not a colleague, and a day it touched is still
    // a day you worked alone.
    expect(humanAuthors(day({ commits: [by("Tim"), by("github-actions[bot]")] }))).toEqual(["Tim"]);
    expect(sharedDay(day({ commits: [by("Tim"), by("github-actions[bot]")] }))).toBe(false);
    expect(sharedDay(day({ commits: [by("Tim"), by("Frederic")] }))).toBe(true);
  });

  it("orders the byline busiest-first and breaks ties by name", () => {
    const d = day({ commits: [by("Frederic"), by("Tim"), by("Tim")] });
    expect(humanAuthors(d)).toEqual(["Tim", "Frederic"]);
    expect(humanAuthors(d)).toEqual(humanAuthors(d)); // stable across repaints
  });

  it("shows nothing to share on a day nobody committed", () => {
    expect(sharedDay(day({ sessions: [] }))).toBe(false);
    expect(projectDayFacts(day({}))).toBe("");
  });

  it("keeps every per-machine fact out of the record that gets committed", () => {
    // The whole reason this function exists: sessions and spend differ per person, so
    // a sentence built from them cannot be a shared one — and $ must not reach a file
    // that gets pushed.
    const d = day({
      cost: 58.23,
      sessions: [{ id: "a", title: "Usage forecast colours", project: "episko", colorKey: "k", branch: "dev", cwd: "/w", when: 0, exists: true }],
      commits: [by("Tim", "feat: the dashboard header acts on its project")],
      events: [{ number: 58, kind: "pr", event: "merged", title: "dev → main", url: "u", at: "" }],
    });
    const facts = projectDayFacts(d);
    expect(facts).toContain("commit: feat: the dashboard header acts on its project");
    expect(facts).toContain("merged pr #58: dev → main");
    expect(facts).toContain("contributors: Tim");
    expect(facts).not.toContain("58.23");
    expect(facts).not.toContain("session:");
    expect(facts).not.toContain("Usage forecast colours");
  });

  it("bounds a heavy day like dayFacts does", () => {
    const many = Array.from({ length: 30 }, (_, i) => by("Tim", `c${i}`));
    const facts = projectDayFacts(day({ commits: many }), 5);
    expect(facts).toContain("… and 25 more commits");
    expect(facts.split("\n").filter((l) => l.startsWith("commit:"))).toHaveLength(5);
  });
});

describe("what a day closed", () => {
  const day = (events: unknown[]): TrailDay =>
    ({ key: "k", when: 0, cost: 0, tokens: 0, sessions: [], commits: [], events: events as never });

  it("names merges and closures in the headline, which is what a day is remembered by", () => {
    const h = deterministicHeadline(day([
      { number: 1, kind: "pr", event: "merged", title: "x", url: "u", at: "" },
      { number: 2, kind: "issue", event: "closed", title: "y", url: "u", at: "" },
    ]));
    expect(h).toContain("1 merged");
    expect(h).toContain("1 closed");
  });

  it("mentions openings only when nothing landed", () => {
    expect(deterministicHeadline(day([{ number: 3, kind: "issue", event: "opened", title: "z", url: "u", at: "" }])))
      .toContain("1 opened");
    const both = deterministicHeadline(day([
      { number: 1, kind: "pr", event: "merged", title: "x", url: "u", at: "" },
      { number: 3, kind: "issue", event: "opened", title: "z", url: "u", at: "" },
    ]));
    expect(both).toContain("1 merged");
    expect(both).not.toContain("opened");
  });

  it("buckets an event into its own local day and drops an unparseable one", () => {
    const days = usageWindow(3);
    const out = trailDays([], days, [], [
      { number: 1, kind: "pr", event: "merged", title: "x", url: "u", at: "2027-03-13T09:00:00Z" },
      { number: 2, kind: "pr", event: "merged", title: "y", url: "u", at: "nonsense" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].events.map((e) => e.number)).toEqual([1]);
  });

  it("hands the model what landed, not only what ran", () => {
    const facts = dayFacts(day([{ number: 46, kind: "pr", event: "merged", title: "notice drift", url: "u", at: "" }]));
    expect(facts).toContain("merged pr #46: notice drift");
  });
});

describe("a day reads as one story, not two lists", () => {
  const names = (k: string) => k.split("/").pop() || k;
  const sess = (id: string, whenMs: number) =>
    ({ id, title: id, project: "e", colorKey: "/w/e", branch: "", cwd: "/w", when: whenMs, exists: true });
  const cmt = (sha: string, whenSecs: number): TrailCommit =>
    ({ sha, author: "T", when: whenSecs, subject: sha, root: "/w/e" });

  it("interleaves sessions and commits by time — a session is the cause of the commit", () => {
    const t = (h: number) => at(2027, 3, 13, h).getTime();
    const g = { colorKey: "/w/e", project: "e",
      sessions: [sess("morning", t(9)), sess("evening", t(18))],
      commits: [cmt("noon", Math.floor(t(12) / 1000)), cmt("late", Math.floor(t(20) / 1000))],
      events: [] };
    expect(dayItems(g).map((i) => (i.kind === "session" ? i.session.id : i.commit.sha)))
      .toEqual(["late", "evening", "noon", "morning"]);
  });

  it("converts commit seconds to ms, or every commit sinks to 1970", () => {
    // The units trap again: sorted unconverted, a 2027 commit compares as ~1970 and
    // lands below every session no matter when it actually happened.
    const t = at(2027, 3, 13, 12).getTime();
    const g = { colorKey: "/w/e", project: "e",
      sessions: [sess("s", t - 3600e3)], commits: [cmt("c", Math.floor(t / 1000))], events: [] };
    const first = dayItems(g)[0];
    expect(first.kind).toBe("commit");
    expect(new Date(first.when).getFullYear()).toBe(2027);
  });

  it("is stable across repaints when timestamps tie", () => {
    const g = { colorKey: "/w/e", project: "e",
      sessions: [sess("b", 5000), sess("a", 5000)], commits: [cmt("z", 5)], events: [] };
    expect(dayItems(g).map((i) => i.when)).toEqual(dayItems(g).map((i) => i.when));
    expect(dayItems(g).map((i) => (i.kind === "session" ? i.session.id : i.commit.sha)))
      .toEqual(dayItems(g).map((i) => (i.kind === "session" ? i.session.id : i.commit.sha)));
  });
});
