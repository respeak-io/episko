import { describe, it, expect, afterEach, vi } from "vitest";
import {
  basename, elidePath, esc, fmtClock, fmtDur, fmtDwell, fmtLatency, fmtShort, fmtSpan,
  fmtUntil, hslToHex, relTime, setHome, sparkline, tilde, uDelta, uTok, uUsd, uUsd2,
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
