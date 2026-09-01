import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ageBucket, basename, cleanTitle, clampTitlePrefs, dialogBody, elidePath, esc, fmtClock, fmtDur,
  fmtDwell, fmtLatency, fmtMb, fmtRate,
  fmtShort, fmtSpan, fmtUntil, hslToHex, relTime, setHome, sparkline, tilde, titleExtra,
  TITLE_DEFAULTS, TITLE_EXTRA_MAX, uDelta,
  uTok, uUsd, uUsd2,
} from "../src/format";

// A fixed epoch for everything that reads the clock, so "2h 10m from now" is a
// number and not a race. 2027-01-15T08:00:00Z.
const NOW_MS = 1800000000000;
const NOW_S = NOW_MS / 1000;
const freeze = () => { vi.useFakeTimers(); vi.setSystemTime(NOW_MS); };
afterEach(() => { vi.useRealTimers(); setHome(""); });

describe("fmtDur — the session-duration readout", () => {
  it("pads seconds to two digits under an hour", () => {
    expect(fmtDur(0)).toBe("0m 00s");
    expect(fmtDur(9_000)).toBe("0m 09s");
    expect(fmtDur(90_000)).toBe("1m 30s");
    expect(fmtDur(3_599_000)).toBe("59m 59s");
  });
  it("drops seconds entirely past the hour mark", () => {
    expect(fmtDur(3_600_000)).toBe("1h 0m");
    expect(fmtDur(3_725_000)).toBe("1h 2m");
    expect(fmtDur(90_000_000)).toBe("25h 0m"); // no day bucket — hours keep climbing
  });
});

describe("fmtDwell — the M:SS dwell/wait clock", () => {
  it("counts M:SS below an hour and clamps a negative span to zero", () => {
    expect(fmtDwell(0)).toBe("0:00");
    expect(fmtDwell(-5_000)).toBe("0:00"); // a clock skew must not print "-1:-1"
    expect(fmtDwell(65_000)).toBe("1:05");
    expect(fmtDwell(3_599_000)).toBe("59:59");
  });
  it("switches to Hh Mm at an hour", () => {
    expect(fmtDwell(3_600_000)).toBe("1h 0m");
    expect(fmtDwell(7_380_000)).toBe("2h 3m");
  });
});

describe("fmtSpan — a raw seconds span", () => {
  it("rounds, clamps at zero, and shows minutes below the hour", () => {
    expect(fmtSpan(0)).toBe("0m");
    expect(fmtSpan(-100)).toBe("0m");
    expect(fmtSpan(59)).toBe("0m");
    expect(fmtSpan(89.6)).toBe("1m"); // rounds to 90s
    expect(fmtSpan(2_700)).toBe("45m");
  });
  it("shows h/m then d/h as the span grows", () => {
    expect(fmtSpan(7_800)).toBe("2h 10m");
    expect(fmtSpan(86_400)).toBe("1d 0h");
    expect(fmtSpan(273_600)).toBe("3d 4h"); // the weekly window can be days out
  });
});

describe("fmtUntil — time left to a reset (epoch seconds)", () => {
  it("counts down from now, and floors at 0m once the reset has passed", () => {
    freeze();
    expect(fmtUntil(NOW_S + 7_800)).toBe("2h 10m");
    expect(fmtUntil(NOW_S + 273_600)).toBe("3d 4h");
    expect(fmtUntil(NOW_S + 90)).toBe("1m");
    expect(fmtUntil(NOW_S - 100)).toBe("0m"); // never negative
  });
});

describe("fmtClock", () => {
  it("renders a wall-clock time of day", () => {
    // Locale- and timezone-dependent ("15:45" or "03:45 PM"), so only the shape
    // is pinned — CI runs this on two OSes.
    expect(fmtClock(NOW_S)).toMatch(/^\d{1,2}:\d{2}/);
  });
});

describe("relTime — sidebar 'last seen'", () => {
  it("returns an em dash for a missing or future timestamp", () => {
    freeze();
    expect(relTime(0)).toBe("—");
    expect(relTime(NOW_MS + 5_000)).toBe("—");
  });
  it("steps just now → m → h → d, rounding at each step", () => {
    freeze();
    expect(relTime(NOW_MS)).toBe("just now");
    expect(relTime(NOW_MS - 20_000)).toBe("just now");
    expect(relTime(NOW_MS - 100_000)).toBe("2m ago"); // 1m40s rounds up, not down
    expect(relTime(NOW_MS - 5 * 60_000)).toBe("5m ago");
    expect(relTime(NOW_MS - 59 * 60_000)).toBe("59m ago");
    expect(relTime(NOW_MS - 90 * 60_000)).toBe("2h ago"); // rounds, not floors
    expect(relTime(NOW_MS - 3 * 3_600_000)).toBe("3h ago");
    expect(relTime(NOW_MS - 25 * 3_600_000)).toBe("1d ago");
    expect(relTime(NOW_MS - 3 * 86_400_000)).toBe("3d ago");
  });
});

describe("fmtLatency — the Pre→Post tool gap", () => {
  it("shows ms below a second and one decimal of seconds above", () => {
    expect(fmtLatency(0)).toBe("0ms");
    expect(fmtLatency(999)).toBe("999ms");
    expect(fmtLatency(999.6)).toBe("1000ms"); // rounds within the ms branch
    expect(fmtLatency(1_000)).toBe("1.0s");
    expect(fmtLatency(1_499)).toBe("1.5s");
  });
});

describe("fmtRate / fmtMb — the inspector's disk-I/O readout", () => {
  it("picks the unit the number is readable in, and keeps a decimal only for MiB/s", () => {
    expect(fmtRate(0)).toBe("0 B/s");
    expect(fmtRate(512)).toBe("512 B/s");
    expect(fmtRate(1023)).toBe("1023 B/s");
    expect(fmtRate(1024)).toBe("1 KiB/s");        // whole KiB — a fractional one is noise
    expect(fmtRate(1024 * 1023)).toBe("1023 KiB/s");
    expect(fmtRate(1024 * 1024)).toBe("1.0 MiB/s"); // …but MiB/s keeps one, 1.2 vs 4.8 matters
    expect(fmtRate(1024 * 1024 * 32.45)).toBe("32.5 MiB/s");
  });
  it("promotes a total to GiB only once it stops reading as MiB", () => {
    expect(fmtMb(0)).toBe("0 MiB");
    expect(fmtMb(1023.4)).toBe("1023 MiB");
    expect(fmtMb(1024)).toBe("1.0 GiB");
    expect(fmtMb(3891.2)).toBe("3.8 GiB");
  });
  /// The units are BINARY, and the labels have to say so — these divide by 1024, so a
  /// "MB" label understated every figure by 4.9% and a "GB" one by 7.4%. Asserted on the
  /// boundary values because that is where a future edit would most plausibly "tidy" the
  /// suffix back to the decimal spelling without touching the arithmetic under it.
  it("labels the binary units it actually computes", () => {
    expect(fmtRate(1024)).toContain("KiB");
    expect(fmtRate(1024 * 1024)).toContain("MiB");
    expect(fmtMb(1)).toContain("MiB");
    expect(fmtMb(1024)).toContain("GiB");
    for (const s of [fmtRate(1024), fmtRate(1024 * 1024), fmtMb(1), fmtMb(1024)]) {
      expect(s).not.toMatch(/(?<!i)[KMG]B/);
    }
  });
});

describe("fmtShort — a task run's elapsed time", () => {
  it("shows seconds, then unpadded m + s, with no hour bucket", () => {
    expect(fmtShort(0)).toBe("0s");
    expect(fmtShort(59_400)).toBe("59s");
    expect(fmtShort(60_000)).toBe("1m 0s");
    expect(fmtShort(90_000)).toBe("1m 30s");
    expect(fmtShort(3_600_000)).toBe("60m 0s");
  });
});

describe("esc", () => {
  it("escapes & and < only — the two that can open a tag", () => {
    expect(esc("a & b < c")).toBe("a &amp; b &lt; c");
    expect(esc("<script>alert(1)</script>")).toBe("&lt;script>alert(1)&lt;/script>");
    expect(esc("")).toBe("");
  });
  it("leaves >, quotes and apostrophes alone (the current contract)", () => {
    // Callers that interpolate into an attribute are relying on the value having
    // no quotes of its own; nothing here escapes them.
    expect(esc(`a > b "q" 'p'`)).toBe(`a > b "q" 'p'`);
  });
  it("double-escapes an already-escaped entity, as a text-node escaper should", () => {
    expect(esc("&amp;")).toBe("&amp;amp;");
  });
});

describe("dialogBody — a confirmation's prose → the in-app dialog's markup", () => {
  it("makes one paragraph per blank line, and keeps single newlines as breaks", () => {
    expect(dialogBody("Move this session?\n\nThe conversation is kept.")).toBe(
      "<p>Move this session?</p><p>The conversation is kept.</p>");
    // The holders message puts the path on a line of its own inside one paragraph;
    // that break is the author's and has to survive.
    expect(dialogBody("still on disk:\nE:/repo/wt")).toBe("<p>still on disk:<br>E:/repo/wt</p>");
  });
  it("turns an all-bullet paragraph into a list, and drops the bullet character", () => {
    // <li> draws its own marker; leaving the • in gives every row two of them.
    expect(dialogBody("  • code (12): has a file open\n  • node (9): sitting here")).toBe(
      "<ul><li>code (12): has a file open</li><li>node (9): sitting here</li></ul>");
  });
  it("does not swallow a lead-in sentence sitting above the bullets", () => {
    // "Held by:" is not a list item, so the paragraph is prose, not a <ul>.
    expect(dialogBody("Held by:\n• code (12)")).toBe("<p>Held by:<br>• code (12)</p>");
  });
  it("renders backticked text as code", () => {
    expect(dialogBody("Episko will run `just --dump` inside it.")).toBe(
      "<p>Episko will run <code>just --dump</code> inside it.</p>");
  });
  it("escapes BEFORE anything else, so a branch name can never be markup", () => {
    // Branch names, task labels and paths all reach these strings unfiltered.
    expect(dialogBody("Remove <img src=x onerror=alert(1)>?")).toBe(
      "<p>Remove &lt;img src=x onerror=alert(1)>?</p>");
    expect(dialogBody("a & b")).toBe("<p>a &amp; b</p>");
    // …including inside the code span: the backticks decide the tag, the content
    // stays inert.
    expect(dialogBody("run `rm <x>`")).toBe("<p>run <code>rm &lt;x></code></p>");
  });
  it("drops blank runs rather than emitting an empty paragraph", () => {
    expect(dialogBody("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>");
    expect(dialogBody("")).toBe("");
    expect(dialogBody("\n \n")).toBe("");
  });
});

describe("tilde — home-dir abbreviation", () => {
  it("is a no-op until the home dir has resolved", () => {
    // setHome hasn't been called this test (afterEach resets it to ""), which is
    // the state during the first frames after launch.
    expect(tilde("/Users/ada/code/x")).toBe("/Users/ada/code/x");
  });
  it("replaces a leading home prefix with ~", () => {
    setHome("/Users/ada");
    expect(tilde("/Users/ada/code/x")).toBe("~/code/x");
    expect(tilde("/Users/ada")).toBe("~");
    expect(tilde("/opt/other")).toBe("/opt/other");
  });
  it("works on Windows paths", () => {
    setHome("C:\\Users\\ada");
    expect(tilde("C:\\Users\\ada\\code\\x")).toBe("~\\code\\x");
  });
  it("replaces only the first occurrence", () => {
    setHome("/Users/ada");
    expect(tilde("/Users/ada/w/Users/ada")).toBe("~/w/Users/ada");
  });
});

describe("basename", () => {
  it("takes the leaf of a posix path, ignoring trailing separators", () => {
    expect(basename("/a/b/c")).toBe("c");
    expect(basename("/a/b/c/")).toBe("c");
    expect(basename("/a/b/c///")).toBe("c");
    expect(basename("single")).toBe("single");
  });
  it("splits on backslashes too, so a Windows path collapses to its leaf", () => {
    // The whole reason it doesn't use a single separator: the sidebar showed the
    // full "E:\proj\sub" as a project name before this.
    expect(basename("E:\\proj\\sub")).toBe("sub");
    expect(basename("E:\\proj\\sub\\")).toBe("sub");
    expect(basename("E:/proj\\mixed")).toBe("mixed");
  });
  it("falls back to the input when there is no leaf left", () => {
    expect(basename("/")).toBe("/");
    expect(basename("")).toBe("");
  });
});

describe("cleanTitle — the OSC title, minus Claude's spinner", () => {
  const sess = { title: "kept", workdir: "/Users/t/proj/app", project: "app-proj" };

  it("strips every spinner family Claude Code has animated", () => {
    // Braille (the original), the eight-spoked asterisk, and — since 2.1.250 — the
    // quadrant circles. Each of these has shipped as a live frame in front of a title.
    for (const frame of ["⠋", "⠙", "⣿", "✳", "✻", "✽", "◐", "◑", "◒", "◓", "◔", "◕", "◴", "◷", "●", "*"]) {
      expect(cleanTitle(`${frame} Fixing the bug`, sess)).toBe("Fixing the bug");
    }
  });

  it("strips a whole leading run, not just one frame", () => {
    expect(cleanTitle("◐ ✳ ⠙  Fixing the bug", sess)).toBe("Fixing the bug");
  });

  it("leaves a decoration that isn't leading alone", () => {
    // Only the animated prefix is noise; the same character mid-title is content.
    expect(cleanTitle("Rendering the ◐ glyph", sess)).toBe("Rendering the ◐ glyph");
  });

  it("keeps the previous title when the terminal sends only decoration", () => {
    // A frame with no summary yet must not blank a title the row is already showing.
    expect(cleanTitle("◐", sess)).toBe("kept");
    expect(cleanTitle("", sess)).toBe("kept");
  });

  it("drops a title that only repeats the folder we already show", () => {
    setHome("/Users/t");
    expect(cleanTitle("/Users/t/proj/app", sess)).toBe("");
    expect(cleanTitle("~/proj/app", sess)).toBe("");
    expect(cleanTitle("app", sess)).toBe("");
    expect(cleanTitle("app-proj", sess)).toBe("");
  });
});

describe("the title scrub as a setting", () => {
  const sess = { title: "kept", workdir: "/Users/t/proj/app", project: "app-proj" };
  const prefs = (extra: string, scrub = true) => ({ scrub, extra });

  describe("clampTitlePrefs — what a hand-edited cc-title may say", () => {
    it("lands on the shipped default for anything missing", () => {
      // Scrubbing is what every install had before this was a setting, so an absent
      // key must read as ON. `!== false`, not `=== true`.
      expect(clampTitlePrefs(null)).toEqual(TITLE_DEFAULTS);
      expect(clampTitlePrefs({})).toEqual({ scrub: true, extra: "" });
      expect(clampTitlePrefs({ scrub: false })).toEqual({ scrub: false, extra: "" });
    });

    it("refuses an extra that is not a string, rather than passing it on", () => {
      // The value is spread into a RegExp character class; `.slice` on a number throws
      // at the first title change, a long way from here.
      for (const bad of [null, undefined, 7, [], {}, true] as unknown[]) {
        expect(clampTitlePrefs({ extra: bad as string }).extra).toBe("");
      }
    });

    it("caps a paste rather than compiling it", () => {
      expect(clampTitlePrefs({ extra: "x".repeat(999) }).extra).toHaveLength(TITLE_EXTRA_MAX);
    });
  });

  describe("titleExtra — what the field was understood to mean", () => {
    const cps = (s: string) => titleExtra(s).map(([a, b]) => [String.fromCodePoint(a), String.fromCodePoint(b)]);

    it("reads single characters and ranges, and ignores the whitespace between them", () => {
      expect(cps("✦✧")).toEqual([["✦", "✦"], ["✧", "✧"]]);
      expect(cps("◐-◗")).toEqual([["◐", "◗"]]);
      expect(cps("  ◐-◗   ✦ ")).toEqual([["◐", "◗"], ["✦", "✦"]]);
    });

    it("counts a range in codepoints, which is the number nothing else on screen says", () => {
      expect(titleExtra("⠀-⣿")).toEqual([[0x2800, 0x28ff]]);
    });

    it("swaps an inverted range instead of dropping it", () => {
      // `◗-◐` can only have meant the same eight codepoints, and an empty result for a
      // value that LOOKS right is the least diagnosable outcome available.
      expect(cps("◗-◐")).toEqual([["◐", "◗"]]);
    });

    it("takes an en or em dash as the range separator too", () => {
      // The field is a place people paste from a chat message, and macOS substitutes
      // both of these for a hyphen as you type.
      expect(cps("◐–◗")).toEqual([["◐", "◗"]]);
      expect(cps("◐—◗")).toEqual([["◐", "◗"]]);
    });

    it("keeps a dangling dash as a literal rather than eating the character before it", () => {
      expect(cps("✦-")).toEqual([["✦", "✦"], ["-", "-"]]);
      expect(cps("-")).toEqual([["-", "-"]]);
    });
  });

  describe("cleanTitle under a preference", () => {
    it("strips a character the built-in table does not know", () => {
      // The whole point of the setting: Claude ships a new spinner family, and this is
      // the answer that does not need an Episko release.
      expect(cleanTitle("✻ Fixing the bug", sess, prefs(""))).toBe("Fixing the bug");
      expect(cleanTitle("§ Fixing the bug", sess, prefs(""))).toBe("§ Fixing the bug");
      expect(cleanTitle("§ Fixing the bug", sess, prefs("§"))).toBe("Fixing the bug");
    });

    it("strips a whole added range", () => {
      for (const c of ["\u2460", "\u2465", "\u2469"]) {
        expect(cleanTitle(`${c} Fixing the bug`, sess, prefs("\u2460-\u2469"))).toBe("Fixing the bug");
      }
      expect(cleanTitle("\u246a Fixing the bug", sess, prefs("\u2460-\u2469"))).toBe("\u246a Fixing the bug");
    });

    it("only ever adds — an addition cannot take a character out of the built-in table", () => {
      // The built-in list is five releases of accumulated answer, and a field that
      // could subtract from it would give "my titles went strange" two possible causes.
      expect(cleanTitle("◐ Fixing the bug", sess, prefs("§"))).toBe("Fixing the bug");
    });

    it("still only strips a LEADING run", () => {
      expect(cleanTitle("Rendering the § glyph", sess, prefs("§"))).toBe("Rendering the § glyph");
    });

    it("adds exactly the codepoints titleExtra named, whatever was typed", () => {
      // The escaping test, and it has to be written this way round to be worth
      // anything. "does a hostile value crash it?" passes trivially — `titleDecor`
      // falls back to the built-in table on a compile failure, so a broken class and a
      // correct one both leave an ordinary title alone. What separates them is whether
      // the characters that carry the class's OWN syntax (`]`, `^`, `\`, `-`) end up
      // as members or as structure. Concatenated raw, `]` closes the class early and
      // `\` swallows the bracket; escaped as \u{…}, both simply join it.
      const probes = ["]", "^", "\\", "-", "z", "Z", "5", "a", "`"];
      for (const extra of ["]", "^", "\\", "[", "-z", "]^\\-", "a-\\", ".*"]) {
        const named = new Set<number>();
        for (const [a, b] of titleExtra(extra)) for (let c = a; c <= b; c++) named.add(c);
        for (const probe of probes) {
          const want = named.has(probe.codePointAt(0)!) ? "T" : `${probe} T`;
          expect(cleanTitle(`${probe} T`, sess, prefs(extra)),
            `extra=${JSON.stringify(extra)} probe=${JSON.stringify(probe)}`).toBe(want);
        }
      }
    });

    it("switched off, hands back exactly what the terminal sent", () => {
      expect(cleanTitle("◐ ✳ Fixing the bug", sess, prefs("", false))).toBe("◐ ✳ Fixing the bug");
    });

    it("switched off, still drops a title that only repeats the folder", () => {
      // A different question — "is this telling me anything the row doesn't already
      // say?" — and nothing to do with somebody else's animation.
      setHome("/Users/t");
      expect(cleanTitle("~/proj/app", sess, prefs("", false))).toBe("");
      expect(cleanTitle("app-proj", sess, prefs("", false))).toBe("");
    });

    it("defaults to the built-in table when no preference is passed", () => {
      // The two-argument call is what every existing call site and test uses.
      expect(cleanTitle("◐ Fixing the bug", sess)).toBe("Fixing the bug");
    });
  });
});

describe("elidePath — the Run header's path", () => {
  it("keeps the last two segments, which is what a worktree is identified by", () => {
    // The real case: the Run picker header, whose 480px popover cannot hold this.
    // Losing the tail (all CSS ellipsis can do) would drop the one part that says
    // which of several checkouts is about to be run in.
    expect(elidePath("~/prog/work/.cc-worktrees/pii-reduction/feat-platform-groundwork"))
      .toBe("~/…/pii-reduction/feat-platform-groundwork");
  });
  it("leaves anything that already fits completely alone", () => {
    expect(elidePath("~/prog/work/muster")).toBe("~/prog/work/muster");
    expect(elidePath("/a/b/c/d/e/f/g", 99)).toBe("/a/b/c/d/e/f/g");
  });
  it("keeps the root on an absolute path instead of doubling the separator", () => {
    expect(elidePath("/Users/fabraham/prog/work/.cc-worktrees/pii/feat-groundwork"))
      .toBe("/Users/…/pii/feat-groundwork");
  });
  it("elides a Windows path with backslashes", () => {
    expect(elidePath("E:\\Programming\\Work\\.cc-worktrees\\repo\\feat-something-long"))
      .toBe("E:\\…\\repo\\feat-something-long");
  });
  it("gives up rather than mangle a path with no middle to drop", () => {
    const twoDeep = "/very-long-single-segment-that-will-not-fit-in-any-header/leaf";
    expect(elidePath(twoDeep)).toBe(twoDeep);
    expect(elidePath("one-enormous-segment-with-no-separators-at-all-abcdefghij"))
      .toBe("one-enormous-segment-with-no-separators-at-all-abcdefghij");
  });
  it("returns the original when eliding would not actually be shorter", () => {
    // head + "…" + last two is longer than the source once the middle is one char.
    expect(elidePath("/a/b/c/d", 4)).toBe("/a/b/c/d");
  });
});

describe("hslToHex", () => {
  it("converts the primaries", () => {
    expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
    expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
    expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
  });
  it("handles the achromatic ends", () => {
    expect(hslToHex(0, 0, 0)).toBe("#000000");
    expect(hslToHex(0, 0, 1)).toBe("#ffffff");
    expect(hslToHex(210, 0, 0.5)).toBe("#808080");
  });
  it("always yields a padded 6-digit hex for the accent palette", () => {
    // accentFor() feeds it (hash % 360, 0.68, 0.63); a channel that lands under
    // 0x10 must not come back as a 5-character colour.
    for (let h = 0; h < 360; h += 7) expect(hslToHex(h, 0.68, 0.63)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("sparkline", () => {
  it("renders nothing for fewer than two points", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([5])).toBe("");
  });
  it("maps a pinned domain onto the fixed 108×24 viewBox", () => {
    expect(sparkline([0, 100], { lo: 0, hi: 100 })).toBe(
      '<svg class="spark" viewBox="0 0 108 24">' +
      '<path class="spk-a" d="M0.0,21.0 L105.0,3.0 L105.0,24 L0,24 Z"></path>' +
      '<path class="spk-l" d="M0.0,21.0 L105.0,3.0"></path>' +
      '<circle class="spk-d" cx="105.0" cy="3.0" r="2.1"></circle></svg>',
    );
  });
  it("clamps values outside the pinned domain instead of overflowing the box", () => {
    expect(sparkline([-50, 150], { lo: 0, hi: 100 })).toBe(sparkline([0, 100], { lo: 0, hi: 100 }));
  });
  it("survives a flat series — the hi<=lo guard is what keeps it out of NaN", () => {
    const svg = sparkline([7, 7, 7]);
    expect(svg).not.toContain("NaN");
    expect(svg).toContain('d="M0.0,21.0 L52.5,21.0 L105.0,21.0"');
  });
  it("scales an unpinned domain to the data's own min/max", () => {
    // Same shape as the pinned 0–100 case, derived from the values alone.
    expect(sparkline([10, 20])).toContain('d="M0.0,21.0 L105.0,3.0"');
  });
});

describe("uUsd / uUsd2 — cost", () => {
  it("rounds to whole dollars below $10k", () => {
    expect(uUsd(0)).toBe("$0");
    expect(uUsd(42.4)).toBe("$42");
    expect(uUsd(42.5)).toBe("$43");
    expect(uUsd(9_999)).not.toContain("k"); // grouping is locale-dependent, the branch is not
  });
  it("switches to one decimal of thousands at $10k and never buckets higher", () => {
    expect(uUsd(10_000)).toBe("$10.0k");
    expect(uUsd(12_345)).toBe("$12.3k");
    expect(uUsd(1_500_000)).toBe("$1500.0k");
  });
  it("uUsd2 always shows exactly two decimals", () => {
    expect(uUsd2(0)).toBe("$0.00");
    expect(uUsd2(3.5)).toBe("$3.50");
    expect(uUsd2(12.3456)).toBe("$12.35");
  });
});

describe("uTok — token counts", () => {
  it("prints raw counts below 1K", () => {
    expect(uTok(0)).toBe("0");
    expect(uTok(999)).toBe("999");
    expect(uTok(999.6)).toBe("1000"); // rounds, but stays in the raw branch
  });
  it("steps K → M → B with widening precision", () => {
    expect(uTok(1_000)).toBe("1K");
    expect(uTok(1_500)).toBe("2K"); // K is whole-number, so it rounds
    expect(uTok(1_500_000)).toBe("1.5M");
    expect(uTok(2_500_000_000)).toBe("2.50B");
  });
});

describe("uDelta — period-over-period change", () => {
  it("says 'new' when there is no previous period to compare against", () => {
    expect(uDelta(10, 0)).toBe('<span class="u-delta u-muted">new</span>');
    expect(uDelta(10, -5)).toBe('<span class="u-delta u-muted">new</span>');
  });
  it("shows the arrow by sign and the percentage by magnitude", () => {
    expect(uDelta(150, 100)).toContain("▲");
    expect(uDelta(150, 100)).toContain("<b>50%</b>");
    expect(uDelta(50, 100)).toContain("▼");
    expect(uDelta(50, 100)).toContain("<b>50%</b>"); // magnitude, not signed
    expect(uDelta(100, 100)).toContain("▲");         // flat reads as up
  });
});

describe("ageBucket — the sheet's time dividers", () => {
  const min = (n: number) => n * 60_000;
  it("bands an age, not a timestamp", () => {
    expect(ageBucket(0)).toBe("Just now");
    expect(ageBucket(min(0.9))).toBe("Just now");
    expect(ageBucket(min(1))).toBe("Last 5 minutes");
    expect(ageBucket(min(4.9))).toBe("Last 5 minutes");
    expect(ageBucket(min(5))).toBe("Last 30 minutes");
    expect(ageBucket(min(29))).toBe("Last 30 minutes");
    expect(ageBucket(min(30))).toBe("Last hour");
    expect(ageBucket(min(59))).toBe("Last hour");
    expect(ageBucket(min(60))).toBe("Earlier");
    expect(ageBucket(min(600))).toBe("Earlier");
  });
  // The bands have to stay in recency order for a list grouped by them to read top-down,
  // which is only true if each boundary hands off to the next band and none overlap.
  it("never goes backwards as an age grows", () => {
    const order = ["Just now", "Last 5 minutes", "Last 30 minutes", "Last hour", "Earlier"];
    let seen = 0;
    for (let m = 0; m < 120; m += 0.5) {
      const i = order.indexOf(ageBucket(min(m)));
      expect(i).toBeGreaterThanOrEqual(seen);
      seen = i;
    }
    expect(seen).toBe(order.length - 1);
  });
});
