import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  grouped, inlineMd, parseChangelog, parseSeen, recordSeen, releaseFor, shouldAnnounce, type Release,
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
    // It must neither become a release nor hand its entries to the release above it.
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

  // Don't reintroduce the fresh-install guard: an absent record must open the screen (docs/releases.md).
  it("opens on an empty record — an absent record is not evidence of anything", () => {
    expect(shouldAnnounce("0.12.0", [], log)).toBe(true);
  });

  // A set, not a last-seen string: with one value, going back to a read version would announce again.
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
    // The legacy key is still read so a machine that opened the screen once is not told again.
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
    // A dev build's version isn't in the file, and Unreleased is what nobody is running.
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

// CHANGELOG.md ships in the bundle and is parsed at runtime, so a malformed one breaks a release.
describe("the real CHANGELOG.md", () => {
  const log = parseChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"));

  it("parses, and leads with Unreleased while it has something in it", () => {
    expect(log.length).toBeGreaterThan(5);
    // On dev this is Unreleased; on main right after a cut it is dropped and the newest
    // release leads. Either is fine; a blank row at the top of the rail is not.
    expect(log[0].entries.length).toBeGreaterThan(0);
  });
  it("gives every released section a date and at least one entry", () => {
    for (const r of log.filter((x) => x.released)) {
      expect(r.date, `${r.version} has no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.entries.length, `${r.version} has no entries`).toBeGreaterThan(0);
    }
  });
  it("shows no section that would render as a blank page", () => {
    // Whether Unreleased is non-empty is branch policy and belongs to `changelog.mjs check`
    // on the PR; asserting it here would fail on main at every cut. Only blankness is asserted.
    for (const r of log) {
      expect(r.entries.length > 0 || r.lede !== "", `${r.version} is empty`).toBe(true);
    }
  });
  it("lists versions newest-first, which is the order the rail renders", () => {
    const rel = log.filter((r) => r.released).map((r) => r.date);
    expect([...rel].sort().reverse()).toEqual(rel);
  });

  it("leaves no markdown unrendered in any entry or lede", () => {
    // After `inlineMd` no marker may survive anywhere in the file; the samples missed italics once.
    for (const r of log) {
      for (const text of [r.lede, ...r.entries.map((e) => e.text)]) {
        // A `*` inside a code span is rendered output, not a leftover marker.
        const stray = inlineMd(text).replace(/<code>[\s\S]*?<\/code>/g, "");
        expect(stray, `${r.version}: unrendered markup`).not.toMatch(/[*`]/);
      }
    }
  });
});

describe("inlineMd — the little markup an entry may carry", () => {
  it("renders bold, italic and code", () => {
    expect(inlineMd("**bold**")).toBe("<b>bold</b>");
    expect(inlineMd("*italic*")).toBe("<i>italic</i>");
    expect(inlineMd("`code`")).toBe("<code>code</code>");
    expect(inlineMd("a **b** and *c* and `d`")).toBe("a <b>b</b> and <i>c</i> and <code>d</code>");
  });

  it("does not let the italic rule eat a bold run", () => {
    // `**x**` handed to the italic rule first becomes an empty emphasis around `x*`, so bold
    // is applied first and both patterns are anchored on runs containing no `*`.
    expect(inlineMd("**A day gets two sentences.** Then *this*."))
      .toBe("<b>A day gets two sentences.</b> Then <i>this</i>.");
    expect(inlineMd("**bold**")).not.toContain("<i>");
  });

  it("renders italics nested inside bold, which the real file uses", () => {
    // 0.13.6's entry, verbatim in shape; a bold rule anchored on a `*`-free run skips it entirely.
    expect(inlineMd("**The *Reveal idle checkouts on hover* switch sits beside its label**, not underneath."))
      .toBe("<b>The <i>Reveal idle checkouts on hover</i> switch sits beside its label</b>, not underneath.");
  });

  it("keeps two bold runs on one line separate", () => {
    // Bold is non-greedy: `.+` would swallow everything between the first `**` and the last.
    expect(inlineMd("**one** middle **two**")).toBe("<b>one</b> middle <b>two</b>");
  });

  it("escapes before it renders, so a changelog can never inject", () => {
    expect(inlineMd("<script>alert(1)</script>")).toBe("&lt;script>alert(1)&lt;/script>");
    expect(inlineMd("**<b>**")).toBe("<b>&lt;b></b>");
    expect(inlineMd("a & b")).toBe("a &amp; b");
  });

  it("treats a code span as opaque, so markers inside it stay literal", () => {
    expect(inlineMd("literal `*` and `**` markers"))
      .toBe("literal <code>*</code> and <code>**</code> markers");
    expect(inlineMd("`a * b` stays put")).toBe("<code>a * b</code> stays put");
    expect(inlineMd("**bold with `*` inside**")).toBe("<b>bold with <code>*</code> inside</b>");
  });

  it("leaves an unpaired marker alone rather than swallowing the rest of the line", () => {
    expect(inlineMd("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(inlineMd("a `b")).toBe("a `b");
  });
});
