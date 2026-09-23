import { describe, expect, it } from "vitest";
import { filterQueue, foldQueue, groupKey, plainRows, queueTally, rankQueue, searchQueue, type QueueInput, type QueueRow } from "../src/queue";
import type { Advisory, DepAlert, DepPr, OutRow } from "../src/deps";
import type { GhThread, Holder } from "../src/ghwork";
import type { Note, SharedNote } from "../src/notes";

const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const th = (o: Partial<GhThread> = {}): GhThread => ({
  number: 1, kind: "issue", title: "a thing", url: "", assignees: [], labels: [],
  branch: null, author: null, draft: false, updated_at: ago(0), ...o,
});

const held = (o: Partial<Holder> = {}): Holder => ({ who: "you", mine: true, stale: false, ...o });

const alert = (o: Partial<DepAlert> = {}): DepAlert => ({
  number: 1, state: "open", pkg: "vitest", ecosystem: "npm", manifest: "pnpm-lock.yaml",
  scope: "runtime", relationship: "direct", severity: "high", ghsa: "GHSA-a", cve: null,
  summary: "s", cvss: 7.1, epss: 0.01, range: "< 4.1.11", patched: "4.1.11",
  url: "u", createdAt: ago(3), updatedAt: ago(3), ...o,
});

const adv = (o: Partial<Advisory> = {}): Advisory => ({
  ghsa: "GHSA-a", cve: null, severity: "high", summary: "s", url: "u", epss: 0.01,
  alerts: [alert()], worst: "lockfile", runtime: true, ...o,
});

const pr = (o: Partial<DepPr> = {}): DepPr => ({
  number: 7, title: "Bump vitest from 4.1.0 to 4.1.11", url: "u", author: "dependabot[bot]",
  branch: "dependabot/npm_and_yarn/vitest-4.1.11", labels: [], draft: false,
  updatedAt: ago(1), mergeable: "MERGEABLE", mergeState: "CLEAN",
  checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 }, bot: "dependabot", ...o,
});

const out = (o: Partial<OutRow> = {}): OutRow => ({
  pkg: "vitest", current: "4.1.0", wanted: "4.1.11", latest: "5.0.0", kind: "devDependencies",
  deprecated: false, bump: "major", safe: true, dev: true, ...o,
});

const note = (o: Partial<Note> = {}): Note =>
  ({ id: "n1", text: "jot", project: null, created: NOW, ...o });
const sharedNote = (o: Partial<SharedNote> = {}): SharedNote =>
  ({ id: "s1", text: "theirs", who: "sam", at: "2026-07-30", ...o });

const input = (o: Partial<QueueInput> = {}): QueueInput => ({
  threads: [], stale: [], adv: [], prs: [], out: [], notes: [], shared: [],
  holder: () => null, now: NOW, ...o,
});

describe("rankQueue — the ladder", () => {
  it("puts one of every source in its fixed place", () => {
    const items = rankQueue(input({
      threads: [th({ number: 10 }), th({ number: 11, title: "an issue" })],
      stale: [{ t: th({ number: 12 }), why: "quiet 30 days" }],
      adv: [adv({ ghsa: "GHSA-crit", severity: "critical" }), adv({ ghsa: "GHSA-med", severity: "medium" })],
      prs: [pr({ number: 7 }), pr({ number: 8, draft: true })],
      out: [out()],
      notes: [note()],
      holder: (t) => (t.number === 10 ? held() : null),
    }));
    expect(items.map((i) => i.key)).toEqual([
      "deps:adv:GHSA-crit",
      "work:10",
      "deps:pr:7",
      "deps:pr:8",
      "note:n1",
      "work:11",
      "work:12",
      "deps:out:vitest",
      "deps:adv:GHSA-med",
    ]);
    expect(items.map((i) => i.rank)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("ranks a claim of yours only while it is in flight", () => {
    const one = (h: Holder | null) => rankQueue(input({ threads: [th()], holder: () => h }))[0].rank;
    expect(one(held())).toBe(1);
    expect(one(held({ stale: true }))).toBe(5);
    expect(one(held({ who: "sam", mine: false }))).toBe(5);
    expect(one(null)).toBe(5);
  });

  it("reads a pull request as work whoever opened it, and a bot PR by whether it is mergeable", () => {
    expect(rankQueue(input({ threads: [th({ kind: "pr" })] }))[0].rank).toBe(3);
    expect(rankQueue(input({ prs: [pr()] }))[0].rank).toBe(2);
    const blocked = pr({ checks: { total: 1, passed: 0, failed: 1, pending: 0, skipped: 0 } });
    const row = rankQueue(input({ prs: [blocked] }))[0];
    expect(row.rank).toBe(3);
    expect(row.sub).toBe("dependabot · 1 check failing");
  });

  it("calls only critical and high urgent; the rest wait below everything else", () => {
    const rank = (severity: string) => rankQueue(input({ adv: [adv({ severity })] }))[0].rank;
    expect(rank("critical")).toBe(0);
    expect(rank("high")).toBe(0);
    expect(rank("medium")).toBe(8);
    expect(rank("low")).toBe(8);
    expect(rank("")).toBe(8);
  });
});

describe("rankQueue — a thread suggested for triage", () => {
  const t = th({ number: 4, title: "still needed?" });

  it("is ONE row at its better rank, carrying the suggestion", () => {
    const items = rankQueue(input({ threads: [t], stale: [{ t, why: "quiet 30 days" }] }));
    expect(items).toHaveLength(1);
    expect(items[0].rank).toBe(5);
    expect(items[0].triage).toBe("quiet 30 days");
    expect(items[0].sub).toBe("opened today · quiet 30 days · nobody on it");
  });

  it("keeps the better rank when you already hold it", () => {
    const items = rankQueue(input({
      threads: [t], stale: [{ t, why: "quiet 30 days" }], holder: () => held(),
    }));
    expect(items).toHaveLength(1);
    expect(items[0].rank).toBe(1);
    expect(items[0].triage).toBe("quiet 30 days");
  });

  it("ranks a suggestion with no open-work row of its own at 6", () => {
    const items = rankQueue(input({ stale: [{ t, why: "quiet 30 days" }] }));
    expect(items.map((i) => [i.key, i.rank])).toEqual([["work:4", 6]]);
  });

  // Recency favours the newest issues, so on a busy board the few quiet ones would sink out
  // of the first screenful — which is the only place triage gets answered.
  it("leads its rank, so it stays at the top of it however busy the board is", () => {
    const fresh = Array.from({ length: 9 }, (_, n) => th({ number: 20 + n, updated_at: ago(1) }));
    const quiet = Array.from({ length: 3 }, (_, n) => th({ number: 40 + n, updated_at: ago(30) }));
    const items = rankQueue(input({
      threads: [...fresh, ...quiet], stale: quiet.map((q) => ({ t: q, why: "quiet 30 days" })),
    }));
    expect(items.slice(0, 3).map((i) => i.key)).toEqual(["work:40", "work:41", "work:42"]);
    expect(items.filter((i) => i.triage)).toHaveLength(3);
  });

  it("leads its rank without jumping one: more urgent work still comes first", () => {
    const quiet = th({ number: 9, updated_at: ago(40) });
    const items = rankQueue(input({
      threads: [quiet], stale: [{ t: quiet, why: "quiet 40 days" }], adv: [adv()], prs: [pr()],
    }));
    expect(items.map((i) => i.key)).toEqual(["deps:adv:GHSA-a", "deps:pr:7", "work:9"]);
  });
});

describe("rankQueue — a bot's pull request", () => {
  it("is ONE row wherever it arrived: the deps half owns it", () => {
    const items = rankQueue(input({
      threads: [th({ number: 7, kind: "pr", title: "Bump vitest from 4.1.0 to 4.1.11" })],
      prs: [pr({ number: 7 })],
    }));
    expect(items.map((i) => i.key)).toEqual(["deps:pr:7"]);
    expect(queueTally(items)).toEqual({ all: 1, iss: 0, pr: 1, deps: 0, note: 0, quiet: 0 });
  });

  it("leaves every other thread alone, PR or issue", () => {
    const items = rankQueue(input({
      threads: [th({ number: 8, kind: "pr" }), th({ number: 7 })], prs: [pr({ number: 7 })],
    }));
    expect(items.map((i) => i.key)).toEqual(["deps:pr:7", "work:8", "work:7"]);
  });

  it("says on the advisory that a fix is already open, rather than dropping either row", () => {
    const items = rankQueue(input({ adv: [adv()], prs: [pr()] }));
    expect(items.find((i) => i.advisory)?.sub).toBe("high · → 4.1.11 · #7 open");
    expect(rankQueue(input({ adv: [adv()] }))[0].sub).toBe("high · → 4.1.11");
  });
});

describe("rankQueue — the tie-breaks", () => {
  it("puts the most recently moved first within a rank", () => {
    const items = rankQueue(input({
      notes: [note({ id: "old", created: NOW - 5000 }), note({ id: "new", created: NOW })],
    }));
    expect(items.map((i) => i.key)).toEqual(["note:new", "note:old"]);
  });

  it("falls back to the key so a repaint never reorders a row under the pointer", () => {
    // Nothing a package manager answers carries a timestamp, so every out row shares `moved`.
    const items = rankQueue(input({ out: [out({ pkg: "zod" }), out({ pkg: "acorn" })] }));
    expect(items.map((i) => i.key)).toEqual(["deps:out:acorn", "deps:out:zod"]);
  });

  it("sorts an unreadable timestamp last within its rank, never first", () => {
    const items = rankQueue(input({
      threads: [th({ number: 1, updated_at: "not a date" }), th({ number: 2, updated_at: ago(9) })],
    }));
    expect(items.map((i) => i.key)).toEqual(["work:2", "work:1"]);
  });
});

describe("rankQueue — notes", () => {
  it("carries a colleague's shared note beside your own", () => {
    const items = rankQueue(input({ notes: [note()], shared: [sharedNote()] }));
    expect(items.map((i) => i.kind)).toEqual(["note", "note"]);
    expect(items.find((i) => i.shared)?.key).toBe("note:shared:s1");
    expect(items.find((i) => i.shared)?.sub).toBe("sam · 2026-07-30");
  });
});

describe("filterQueue", () => {
  const items = rankQueue(input({ threads: [th()], adv: [adv()], notes: [note()] }));

  it("is identity for \"all\"", () => {
    expect(filterQueue(items, "all")).toBe(items);
  });

  it("keeps one kind, in the order it already had", () => {
    expect(filterQueue(items, "deps").map((i) => i.kind)).toEqual(["deps"]);
    expect(filterQueue(items, "iss").map((i) => i.key)).toEqual(["work:1"]);
    expect(filterQueue(items, "note").map((i) => i.key)).toEqual(["note:n1"]);
  });
});

describe("queueTally", () => {
  it("counts the kinds a filter is hiding, so a chip says what it would reveal", () => {
    const items = rankQueue(input({
      threads: [th({ number: 1 }), th({ number: 2 })], adv: [adv()], notes: [note()],
    }));
    expect(queueTally(items)).toEqual({ all: 4, iss: 2, pr: 0, deps: 1, note: 1, quiet: 0 });
    expect(queueTally(filterQueue(items, "iss"))).toEqual({ all: 2, iss: 2, pr: 0, deps: 0, note: 0, quiet: 0 });
  });
});

describe("an empty queue", () => {
  it("fabricates no row and no count", () => {
    expect(rankQueue(input())).toEqual([]);
    expect(queueTally([])).toEqual({ all: 0, iss: 0, pr: 0, deps: 0, note: 0, quiet: 0 });
  });
});

describe("searchQueue", () => {
  const items = rankQueue(input({
    threads: [
      th({ number: 37, title: "ConPTY output amplification", labels: ["performance"] }),
      th({ number: 91, kind: "pr", title: "worktree roster" }),
    ],
    adv: [adv({ summary: "Prototype pollution in axios", alerts: [alert({ pkg: "axios" })] })],
    notes: [note({ text: "check the bg_root probe" })],
  }));

  it("matches a row on everything it says, its number included", () => {
    expect(searchQueue(items, "conpty").map((i) => i.key)).toEqual(["work:37"]);
    expect(searchQueue(items, "#37").map((i) => i.key)).toEqual(["work:37"]);
    expect(searchQueue(items, "bg_root").map((i) => i.key)).toEqual(["note:n1"]);
  });

  it("matches the words a chip stands for, which no field spells out", () => {
    // `adv` and `pr` are drawn from the kind, and a quiet row says so nowhere.
    // A plain substring match, so these say a chip's word REACHES its rows, not that it is
    // the only thing it reaches: "pr" is inside "Prototype" too, and that is a filter box.
    expect(searchQueue(items, "adv").map((i) => i.key)).toEqual(["deps:adv:GHSA-a"]);
    expect(searchQueue(items, "axios").map((i) => i.key)).toEqual(["deps:adv:GHSA-a"]);
    expect(searchQueue(items, "pr").map((i) => i.key)).toContain("work:91");
    const quiet = rankQueue(input({ stale: [{ t: th({ number: 5 }), why: "quiet 2 months" }] }));
    expect(searchQueue(quiet, "quiet").map((i) => i.key)).toEqual(["work:5"]);
  });

  it("narrows on every term rather than widening", () => {
    expect(searchQueue(items, "axios pollution")).toHaveLength(1);
    expect(searchQueue(items, "axios conpty")).toEqual([]);
  });

  it("is the pool the chips then count over", () => {
    // The tally is of what the search left, so a chip still says what it would reveal.
    expect(queueTally(searchQueue(items, "axios"))).toEqual({ all: 1, iss: 0, pr: 0, deps: 1, note: 0, quiet: 0 });
  });

  it("hands back the list untouched when nothing was typed", () => {
    expect(searchQueue(items, "   ")).toBe(items);
    expect(searchQueue(items, "")).toBe(items);
  });
});

describe("folding a run", () => {
  const bots = (n: number, bot: string, o: Partial<DepPr> = {}) =>
    Array.from({ length: n }, (_, k) => pr({ number: 100 + k, bot, updatedAt: ago(k), ...o }));
  const folds = (rows: QueueRow[]) => rows.filter((r) => r.kind === "fold").map((r) => r.fold);

  it("names what a row is one of, and nothing else", () => {
    const items = rankQueue(input({
      threads: [th({ number: 1, kind: "pr" })], adv: [adv()], prs: [pr()], out: [out()], notes: [note()],
    }));
    const by = new Map(items.map((i) => [i.key, groupKey(i)]));
    expect(by.get("deps:pr:7")).toBe("bot:dependabot");
    expect(by.get("deps:out:vitest")).toBe("out");
    expect(by.get("work:1")).toBeNull();
    expect(by.get("deps:adv:GHSA-a")).toBeNull();
    expect(by.get("note:n1")).toBeNull();
  });

  it("stands a run of three or more behind one row, and leaves a pair alone", () => {
    const three = foldQueue(rankQueue(input({ prs: bots(3, "dependabot") })), new Set());
    expect(three).toHaveLength(1);
    expect(folds(three)[0]).toMatchObject({
      key: "2:bot:dependabot", open: false,
      title: "3 pull requests from dependabot", sub: "all ready to merge",
    });
    const two = foldQueue(rankQueue(input({ prs: bots(2, "dependabot") })), new Set());
    expect(two.map((r) => r.kind)).toEqual(["item", "item"]);
  });

  it("pulls a bot's pull requests together first, or two bots interleave and neither folds", () => {
    // Both bots run nightly, so recency alone lands them d, r, d, r, d, r.
    const prs = [
      pr({ number: 1, bot: "dependabot", updatedAt: ago(1) }), pr({ number: 2, bot: "renovate", updatedAt: ago(1.5) }),
      pr({ number: 3, bot: "dependabot", updatedAt: ago(2) }), pr({ number: 4, bot: "renovate", updatedAt: ago(2.5) }),
      pr({ number: 5, bot: "dependabot", updatedAt: ago(3) }), pr({ number: 6, bot: "renovate", updatedAt: ago(3.5) }),
    ];
    const items = rankQueue(input({ prs }));
    expect(items.map((i) => i.pr!.number)).toEqual([1, 3, 5, 2, 4, 6]);
    expect(folds(foldQueue(items, new Set())).map((f) => f.key))
      .toEqual(["2:bot:dependabot", "2:bot:renovate"]);
  });

  it("never folds across a rank: what is ready and what is blocked are two piles", () => {
    const items = rankQueue(input({
      prs: [...bots(3, "dependabot"), ...bots(3, "dependabot", { draft: true }).map((p, k) => ({ ...p, number: 200 + k }))],
    }));
    expect(folds(foldQueue(items, new Set())).map((f) => [f.key, f.sub])).toEqual([
      ["2:bot:dependabot", "all ready to merge"],
      ["3:bot:dependabot", "draft"],
    ]);
  });

  it("keeps a group inside its rank, so nothing overtakes an advisory", () => {
    const items = rankQueue(input({
      adv: [adv({ ghsa: "GHSA-crit", severity: "critical" })],
      prs: bots(3, "dependabot"), out: [out({ pkg: "a" }), out({ pkg: "b" }), out({ pkg: "c", bump: "minor" })],
      notes: [note()],
    }));
    expect(items.map((i) => i.rank)).toEqual([0, 2, 2, 2, 4, 7, 7, 7]);
    const rows = foldQueue(items, new Set());
    expect(rows.map((r) => (r.kind === "fold" ? r.fold.key : r.item.key)))
      .toEqual(["deps:adv:GHSA-crit", "2:bot:dependabot", "note:n1", "7:out"]);
    expect(folds(rows)[1]).toMatchObject({ title: "3 packages out of date", sub: "2 major · 1 minor" });
  });

  it("opens only the keys it was given, and keeps its rows inside the fold", () => {
    const items = rankQueue(input({ prs: bots(3, "dependabot") }));
    const rows = foldQueue(items, new Set(["2:bot:dependabot"]));
    // One row out, open, carrying its three: the view draws them, so none is emitted twice.
    expect(rows).toHaveLength(1);
    expect(folds(rows)[0].open).toBe(true);
    expect(folds(rows)[0].items.map((i) => i.key)).toEqual(items.map((i) => i.key));
    expect(foldQueue(items, new Set(["2:bot:renovate"]))[0]).toMatchObject({ kind: "fold" });
    expect(folds(foldQueue(items, new Set(["2:bot:renovate"])))[0].open).toBe(false);
  });

  it("says what is holding a blocked run up, busiest first and never past two", () => {
    const blocked = (o: Partial<DepPr>, k: number) => pr({ number: 300 + k, updatedAt: ago(k), ...o });
    const items = rankQueue(input({
      prs: [
        blocked({ mergeState: "BEHIND" }, 0), blocked({ mergeState: "BEHIND" }, 1),
        blocked({ draft: true }, 2), blocked({ mergeable: "CONFLICTING" }, 3),
        blocked({ checks: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0 } }, 4),
      ],
    }));
    expect(folds(foldQueue(items, new Set()))[0].sub)
      .toBe("behind the base branch · 1 check failing · +2 more");
  });

  it("calls a run with no verdict yet what the rows themselves call it", () => {
    const none = { total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 };
    const items = rankQueue(input({ prs: bots(3, "dependabot", { checks: none }) }));
    expect(folds(foldQueue(items, new Set()))[0].sub).toBe("no check has run");
  });

  it("folds nothing when the list is the one a search left", () => {
    const items = rankQueue(input({ prs: bots(4, "dependabot") }));
    expect(plainRows(items).map((r) => r.kind)).toEqual(["item", "item", "item", "item"]);
    expect(plainRows(items).map((r) => (r.kind === "item" ? r.item.key : ""))).toEqual(items.map((i) => i.key));
  });
});
