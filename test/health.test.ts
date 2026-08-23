import { describe, it, expect } from "vitest";
import {
  DEFAULT_HEALTH, clampHealth, fileChips, isSourcePath, isTestPath,
  noTestChanged, setChips, silencedIn, worstSev, type Chip,
} from "../src/health";
import type { DiffFile, DiffLine } from "../src/diff";
import type { FileHealth, HealthReport } from "../src/types";

// Every rule in this module fails *quietly*: a threshold set too low puts a chip on
// every file, which reads as noise and gets ignored, and one set too high produces
// nothing, which reads as a clean change. Neither throws and neither is visible in a
// screenshot of a diff you don't already know the answer to.

const add = (text: string, newNo = 1): DiffLine => ({ kind: "add", text, oldNo: null, newNo });
const ctx = (text: string, n = 1): DiffLine => ({ kind: "ctx", text, oldNo: n, newNo: n });
const del = (text: string, n = 1): DiffLine => ({ kind: "del", text, oldNo: n, newNo: null });

const file = (path: string, ...lines: DiffLine[]): DiffFile => ({
  path, oldPath: path, status: "modified", binary: false,
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
  hunks: [{ header: "", lines }],
});

const health = (over: Partial<FileHealth> = {}): FileHealth => ({
  path: "a.ts", code_lines: 100, code_added: 0, max_nesting: 0, nesting_line: 0,
  worst_fn: null, longest_fn: null, dups: [], measured: true, ...over,
});
const report = (over: Partial<HealthReport> = {}): HealthReport => ({
  files: [], p90_code_lines: 400, indexed: 100, truncated: false, prefs: {}, ...over,
});
const ids = (c: Chip[]) => c.map((x) => x.id);

describe("clampHealth", () => {
  it("falls back on anything missing or unusable", () => {
    expect(clampHealth(undefined)).toEqual(DEFAULT_HEALTH);
    expect(clampHealth({ cognitive: "nonsense" })).toEqual(DEFAULT_HEALTH);
  });

  it("refuses a threshold of zero rather than honouring it", () => {
    // A hand-written `.episko/episko.toml` must not be able to turn every file red.
    expect(clampHealth({ cognitive: 0, nesting: -3 })).toEqual(DEFAULT_HEALTH);
  });

  it("takes a number, and a string that is one", () => {
    expect(clampHealth({ cognitive: 25 }).cognitive).toBe(25);
    expect(clampHealth({ longFn: "80" }).longFn).toBe(80);
  });
});

describe("silencedIn", () => {
  it("finds an error being swallowed on an added line", () => {
    const f = file("a.py", add("    except Exception:", 12), add("        rate = 0", 13));
    expect(silencedIn(f)).toEqual([{ line: 12, what: "`except Exception`" }]);
  });

  it("ignores what was already there — this is about the change, not the file", () => {
    const f = file("a.py", ctx("except:", 4), del("except:", 5));
    expect(silencedIn(f)).toEqual([]);
  });

  it("does not fire on prose that merely mentions the pattern", () => {
    const f = file("a.ts", add("// never write `as any` here", 3));
    expect(silencedIn(f)).toEqual([]);
  });

  it("does fire on the ones that are comments by nature", () => {
    // @ts-ignore only ever appears in a comment; skipping comment lines would make the
    // rule unreachable rather than conservative.
    const f = file("a.ts", add("  // @ts-ignore", 9), add("  # noqa", 10));
    expect(silencedIn(f).map((s) => s.what)).toEqual(["`@ts-ignore`", "`# noqa`"]);
  });

  it("reports one finding per line even when two patterns match", () => {
    expect(silencedIn(file("a.ts", add("} catch (e) {} // eslint-disable-line", 7)))).toHaveLength(1);
  });

  it("keeps them in the order they appear, so the chip goes to the first", () => {
    const f = file("a.ts", add("const x = y as any;", 30), add("// @ts-ignore", 8));
    expect(silencedIn(f).map((s) => s.line)).toEqual([30, 8]);
  });
});

describe("test and source paths", () => {
  it("recognises where tests live in the languages here", () => {
    for (const p of ["test/diff.test.ts", "src/__tests__/a.ts", "api/test_billing.py",
                     "pkg/thing_test.go", "spec/models_spec.rb"]) {
      expect(isTestPath(p), p).toBe(true);
    }
  });

  it("does not call an ordinary file a test for containing the word", () => {
    expect(isTestPath("src/latest.ts")).toBe(false);
    expect(isTestPath("src/protest/main.go")).toBe(false);
  });

  it("counts code as source and everything else as not", () => {
    expect(isSourcePath("src/a.ts")).toBe(true);
    expect(isSourcePath("api/b.py")).toBe(true);
    expect(isSourcePath("CHANGELOG.md")).toBe(false);
    expect(isSourcePath("Cargo.lock")).toBe(false);
  });
});

describe("noTestChanged", () => {
  it("is true when source moved and no test did", () => {
    expect(noTestChanged([file("src/a.ts", add("x"))])).toBe(true);
  });

  it("is false when a test moved with it", () => {
    expect(noTestChanged([file("src/a.ts", add("x")), file("test/a.test.ts", add("y"))])).toBe(false);
  });

  it("is false for a change that touched no source at all", () => {
    // A documentation change needing no test is not worth a line of UI.
    expect(noTestChanged([file("CHANGELOG.md", add("- a note"))])).toBe(false);
    expect(noTestChanged([])).toBe(false);
  });

  it("does not count the test file itself as the source that needs one", () => {
    expect(noTestChanged([file("test/a.test.ts", add("y"))])).toBe(false);
  });
});

describe("fileChips", () => {
  const clean = file("src/a.ts", add("const x = 1;", 5));

  it("says nothing about a file that earned nothing", () => {
    expect(fileChips(clean, health(), report())).toEqual([]);
  });

  it("still applies the patch-only rules while the measurement is missing", () => {
    // In flight, or a file the backend could not read. The patch is enough for this one.
    const f = file("a.py", add("except:", 3));
    expect(ids(fileChips(f, undefined, null))).toEqual(["silenced"]);
  });

  it("claims nothing measured when the backend could not read the file", () => {
    // `measured: false` carries a row of zeroes, and a zero must never be shown as a
    // finding of "0" — an unmeasured file has to look different from a clean one.
    const h = health({ measured: false, code_lines: 0, max_nesting: 0 });
    expect(fileChips(clean, h, report())).toEqual([]);
  });

  it("names where a duplicated block already lives", () => {
    const h = health({ dups: [{ line: 42, other_path: "src/refunds.ts", other_line: 12 }] });
    const [c] = fileChips(clean, h, report());
    expect(c.id).toBe("dup");
    expect(c.sev).toBe("bad");
    expect(c.line).toBe(42);
    expect(c.title).toContain("src/refunds.ts:12");
  });

  it("counts several duplicate partners in the chip's text", () => {
    const h = health({ dups: [
      { line: 42, other_path: "a.ts", other_line: 1 },
      { line: 60, other_path: "b.ts", other_line: 2 },
    ] });
    expect(fileChips(clean, h, report())[0].text).toBe("dup ×2");
  });

  it("measures size against the project, not against a constant", () => {
    const big = health({ code_lines: 500, code_added: 100 });
    expect(ids(fileChips(clean, big, report({ p90_code_lines: 400 })))).toContain("grew");
    // The same file in a project of larger files is not remarkable.
    expect(ids(fileChips(clean, big, report({ p90_code_lines: 900 })))).not.toContain("grew");
  });

  it("does not call a big file out when this change barely touched it", () => {
    // Otherwise the largest file in the project carries a chip forever — including on
    // the commit that made it smaller.
    const h = health({ code_lines: 900, code_added: 2 });
    expect(ids(fileChips(clean, h, report({ p90_code_lines: 400 })))).not.toContain("grew");
  });

  it("says nothing about size when the project has no distribution yet", () => {
    const h = health({ code_lines: 900, code_added: 100 });
    expect(ids(fileChips(clean, h, report({ p90_code_lines: 0 })))).not.toContain("grew");
  });

  it("calls out the worst function the change touched", () => {
    const h = health({ worst_fn: { name: "build", start: 204, end: 260, code_lines: 40, cognitive: 24 } });
    const c = fileChips(clean, h, report()).find((x) => x.id === "cognitive")!;
    expect(c.text).toBe("cognitive 24");
    expect(c.line).toBe(204);
    expect(c.title).toContain("build");
  });

  it("leaves a function just under the threshold alone", () => {
    const h = health({ worst_fn: { name: "ok", start: 1, end: 9, code_lines: 8, cognitive: 14 } });
    expect(ids(fileChips(clean, h, report()))).not.toContain("cognitive");
  });

  it("does not report one function twice as complex and as long", () => {
    const fn = { name: "big", start: 10, end: 200, code_lines: 150, cognitive: 30 };
    const got = ids(fileChips(clean, health({ worst_fn: fn, longest_fn: fn }), report()));
    expect(got).toContain("cognitive");
    expect(got).not.toContain("longfn");
  });

  it("reports a long function when a different one is the complex one", () => {
    const got = ids(fileChips(clean, health({
      worst_fn: { name: "hard", start: 10, end: 20, code_lines: 10, cognitive: 30 },
      longest_fn: { name: "long", start: 90, end: 300, code_lines: 180, cognitive: 4 },
    }), report()));
    expect(got).toEqual(expect.arrayContaining(["cognitive", "longfn"]));
  });

  it("points the nesting chip at the line that reached it", () => {
    const c = fileChips(clean, health({ max_nesting: 6, nesting_line: 88 }), report())
      .find((x) => x.id === "nesting")!;
    expect(c.text).toBe("nesting 6");
    expect(c.line).toBe(88);
  });

  it("honours a raised threshold instead of the default", () => {
    const h = health({ max_nesting: 6, nesting_line: 88 });
    const prefs = { ...DEFAULT_HEALTH, nesting: 8 };
    expect(ids(fileChips(clean, h, report(), prefs))).not.toContain("nesting");
  });

  it("takes a project's own thresholds off the report, the way the viewer does", () => {
    // The whole path a `[health]` table travels: Rust reads the file, puts it on the
    // report, ./diffview clamps it, and the rules use it instead of the defaults.
    const h = health({ max_nesting: 6, nesting_line: 88 });
    const rep = report({ prefs: { nesting: 8 } });
    expect(ids(fileChips(clean, h, rep, clampHealth(rep.prefs)))).not.toContain("nesting");
    // …and a table that says nothing about a key still gets that key's default.
    const partial = report({ prefs: { longFn: 200 } });
    expect(ids(fileChips(clean, h, partial, clampHealth(partial.prefs)))).toContain("nesting");
  });

  it("puts what you would want to know before merging first", () => {
    const f = file("a.py", add("except:", 3));
    const h = health({ dups: [{ line: 9, other_path: "b.py", other_line: 1 }], max_nesting: 7, nesting_line: 9 });
    const chips = fileChips(f, h, report());
    expect(chips[0].sev).toBe("bad");
    expect(worstSev(chips)).toBe("bad");
  });
});

describe("worstSev", () => {
  it("is null for a file with nothing to say, so the row stays silent", () => {
    expect(worstSev([])).toBeNull();
  });

  it("reports the loudest present", () => {
    const c = (sev: Chip["sev"]): Chip => ({ id: "x", sev, text: "", title: "", line: 0 });
    expect(worstSev([c("info"), c("warn")])).toBe("warn");
    expect(worstSev([c("info")])).toBe("info");
  });
});

describe("setChips", () => {
  it("says once that no test moved, rather than once per file", () => {
    const files = [file("src/a.ts", add("x")), file("src/b.ts", add("y"))];
    expect(ids(setChips(files, report()))).toEqual(["notest"]);
  });

  it("admits a partial sweep instead of letting it read as clean", () => {
    const got = setChips([], report({ truncated: true, indexed: 6000 }));
    expect(ids(got)).toEqual(["partial"]);
    expect(got[0].title).toContain("6000");
  });

  it("has nothing to say about a tidy change", () => {
    expect(setChips([file("src/a.ts", add("x")), file("test/a.test.ts", add("y"))], report())).toEqual([]);
  });
});
