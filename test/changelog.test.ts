import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  grouped, parseChangelog, parseSeen, recordSeen, releaseFor, shouldAnnounce, type Release,
} from "../src/changelog";

const SAMPLE = `# Changelog

Preamble prose that is not a release.

## Unreleased

What the next one is about.

+ A new thing.
~ A changed thing.

## 0.12.0 — 2026-07-31

Six branches landed at once.

+ The app draws its own title bar.
! A turn the API killed no longer turns green.

## 0.11.1 — 2026-07-28

! A one-liner.
`;

describe("parseChangelog", () => {
  const log = parseChangelog(SAMPLE);

  it("reads the releases in file order, newest first", () => {
    expect(log.map((r) => r.version)).toEqual(["Unreleased", "0.12.0", "0.11.1"]);
  });
  it("marks Unreleased as not released, and everything else as released", () => {
    expect(log.map((r) => r.released)).toEqual([false, true, true]);
  });
  it("keeps the date as written, and leaves Unreleased without one", () => {
    expect(log[1].date).toBe("2026-07-31");
    expect(log[0].date).toBe("");
  });
  it("takes the first paragraph as the lede and the markers as entries", () => {
    expect(log[1].lede).toBe("Six branches landed at once.");
    expect(log[1].entries).toEqual([
      { mark: "new", text: "The app draws its own title bar." },
      { mark: "fixed", text: "A turn the API killed no longer turns green." },
    ]);
  });
  it("does not treat the preamble as a release", () => {
    expect(log.some((r) => r.lede.includes("Preamble"))).toBe(false);
  });
  it("allows a release with no lede at all", () => {
    expect(log[2].lede).toBe("");
    expect(log[2].entries).toHaveLength(1);
  });

  it("rejects a prose heading rather than inventing a version from it", () => {
    // Somebody will add `## Notes for the team`. It must not become a release, and it
    // must not swallow the release above it either.
    const l = parseChangelog("## 1.0.0 — 2026-01-01\n\n+ Real.\n\n## Notes\n\n+ Not a release.\n");
    expect(l.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(l[0].entries).toHaveLength(1);
  });

  it("joins a wrapped entry instead of dropping its tail", () => {
    const l = parseChangelog("## 1.0.0 — 2026-01-01\n\n+ A long entry that\n  wraps onto a second line.\n");
    expect(l[0].entries[0].text).toBe("A long entry that wraps onto a second line.");
  });

  it("accepts a leading v on the heading, because tags carry one", () => {
    expect(parseChangelog("## v2.0.0 — 2026-02-02\n\n+ x\n")[0].version).toBe("2.0.0");
  });

  it("is an empty list for an empty or structureless file, never a throw", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("just some words\n")).toEqual([]);
  });
});

describe("shouldAnnounce — when What's new opens by itself", () => {
  const log = parseChangelog(SAMPLE);

  it("opens for a version this machine has never had it opened for", () => {
    expect(shouldAnnounce("0.12.0", ["0.11.1"], log)).toBe(true);
  });
  it("stays shut when that version has already been read", () => {
    expect(shouldAnnounce("0.12.0", ["0.12.0"], log)).toBe(false);
  });
  it("stays shut for a version the file has no section for", () => {
    // A local dev build: the screen would open on nothing.
    expect(shouldAnnounce("9.9.9", ["0.12.0"], log)).toBe(false);
  });
  it("never announces Unreleased, which is not a version anyone runs", () => {
    expect(shouldAnnounce("Unreleased", ["0.12.0"], log)).toBe(false);
  });

  // THE REGRESSION. 0.13.0 introduced this screen, so on every existing install the
  // seen-record was absent — the same state a fresh install is in. The old rule read an
  // absent record as "never been here" and stayed shut, so the release that shipped the
  // feature was the one release nobody was shown it for.
  it("opens on an empty record — an absent record is not evidence of anything", () => {
    expect(shouldAnnounce("0.12.0", [], log)).toBe(true);
  });

  // Why a set and not a last-seen string: with one value, going back to a version
  // already read differs from it and would announce a second time.
  it("stays shut on a version read before, even after running a newer one", () => {
    expect(shouldAnnounce("0.11.1", ["0.11.1", "0.12.0"], log)).toBe(false);
  });
  it("still opens for a skipped version reached later", () => {
    expect(shouldAnnounce("0.11.1", ["0.12.0"], log)).toBe(true);
  });
});

describe("the seen record", () => {
  it("reads the list", () => {
    expect(parseSeen('["0.12.0","0.13.0"]', null)).toEqual(["0.12.0", "0.13.0"]);
  });
  it("migrates 0.13.0's single-value key when the list is absent", () => {
    // The whole reason the legacy key is still read: a machine that has opened the
    // screen once must not be told about that version a second time.
    expect(parseSeen(null, "0.13.0")).toEqual(["0.13.0"]);
  });
  it("prefers the list once it exists, and ignores the stale legacy key", () => {
    expect(parseSeen('["0.13.1"]', "0.13.0")).toEqual(["0.13.1"]);
  });
  it("is empty when neither key is set — a genuinely unrecorded machine", () => {
    expect(parseSeen(null, null)).toEqual([]);
  });
  it("falls back rather than throwing on a mangled list", () => {
    expect(parseSeen("{not json", "0.13.0")).toEqual(["0.13.0"]);
    expect(parseSeen('"a string"', null)).toEqual([]);
    expect(parseSeen('["ok", 7, null]', null)).toEqual(["ok"]);
  });

  it("appends, newest last", () => {
    expect(recordSeen(["0.12.0"], "0.13.0")).toEqual(["0.12.0", "0.13.0"]);
  });
  it("never duplicates, and re-reading moves it to the end", () => {
    expect(recordSeen(["0.12.0", "0.13.0"], "0.12.0")).toEqual(["0.13.0", "0.12.0"]);
  });
  it("is bounded, dropping the oldest", () => {
    expect(recordSeen(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
  it("records nothing for an empty version", () => {
    expect(recordSeen(["0.12.0"], "")).toEqual(["0.12.0"]);
  });

  it("survives a round trip, which is what the footer handle depends on", () => {
    // Read 0.13.0 under the old key, then read 0.13.1: neither may announce again.
    const after = recordSeen(parseSeen(null, "0.13.0"), "0.13.1");
    const log = parseChangelog(SAMPLE);
    expect(after).toEqual(["0.13.0", "0.13.1"]);
    expect(shouldAnnounce("0.13.1", after, log)).toBe(false);
    expect(shouldAnnounce("0.13.0", after, log)).toBe(false);
  });
});

describe("releaseFor", () => {
  const log = parseChangelog(SAMPLE);
  it("opens on the running version when the file knows it", () => {
    expect(releaseFor("0.11.1", log)?.version).toBe("0.11.1");
  });
  it("falls back to the newest RELEASED one, not to Unreleased", () => {
    // A dev build's version isn't in the file; Unreleased describes something nobody
    // is running, so it must not be what the screen lands on.
    expect(releaseFor("0.13.0-dev", log)?.version).toBe("0.12.0");
  });
  it("is null for an empty log", () => {
    expect(releaseFor("1.0.0", [])).toBeNull();
  });
});

describe("grouped", () => {
  it("orders the groups the same way every time and drops the empty ones", () => {
    const r = parseChangelog(SAMPLE)[1];
    expect(grouped(r).map((g) => g.mark)).toEqual(["new", "fixed"]);
  });
  it("is empty for a release with no entries", () => {
    expect(grouped({ version: "1.0.0", date: "", lede: "x", entries: [], released: true } as Release)).toEqual([]);
  });
});

// The file is shipped in the bundle and parsed at runtime, so a malformed one is a
// broken feature in a release nobody would notice until after it went out.
describe("the real CHANGELOG.md", () => {
  const log = parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));

  it("parses, and starts with Unreleased", () => {
    expect(log.length).toBeGreaterThan(5);
    expect(log[0].version).toBe("Unreleased");
  });
  it("gives every released section a date and at least one entry", () => {
    for (const r of log.filter((x) => x.released)) {
      expect(r.date, `${r.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.entries.length, `${r.version} has no entries`).toBeGreaterThan(0);
    }
  });
  it("always carries an Unreleased section, even right after a release stamps it empty", () => {
    // Non-EMPTY is a branch policy and belongs to `changelog.mjs check`, which runs on
    // the dev → main PR. Asserting it here would fail on main every time a release is
    // cut, which is the one moment the section is legitimately blank.
    expect(log[0].version).toBe("Unreleased");
    expect(log[0].released).toBe(false);
  });
  it("lists versions newest-first, which is the order the rail renders", () => {
    const rel = log.filter((r) => r.released).map((r) => r.date);
    expect([...rel].sort().reverse()).toEqual(rel);
  });
});
