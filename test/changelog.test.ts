import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  grouped, parseChangelog, releaseFor, shouldAnnounce, type Release,
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
  it("opens when the running version differs from the last one acknowledged", () => {
    expect(shouldAnnounce("0.12.0", "0.11.1", log)).toBe(true);
  });
  it("stays shut on a fresh install — nothing is new to someone who never ran it", () => {
    expect(shouldAnnounce("0.12.0", null, log)).toBe(false);
  });
  it("stays shut when it has already been seen", () => {
    expect(shouldAnnounce("0.12.0", "0.12.0", log)).toBe(false);
  });
  it("stays shut for a version the file has no section for", () => {
    // A local dev build, or a downgrade: the screen would open on nothing.
    expect(shouldAnnounce("9.9.9", "0.12.0", log)).toBe(false);
  });
  it("never announces Unreleased, which is not a version anyone runs", () => {
    expect(shouldAnnounce("Unreleased", "0.12.0", log)).toBe(false);
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
  it("has an Unreleased section with something in it — the CI gate reads this", () => {
    expect(log[0].entries.length).toBeGreaterThan(0);
  });
  it("lists versions newest-first, which is the order the rail renders", () => {
    const rel = log.filter((r) => r.released).map((r) => r.date);
    expect([...rel].sort().reverse()).toEqual(rel);
  });
});
