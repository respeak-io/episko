import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_HEALTH, clampHealth, fileChips, isSourcePath, isTestPath,
  findingsText, noTestChanged, setChips, silencedIn, worstSev, type Chip,
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

  it("does not read a pattern inside a string literal as code doing it", () => {
    // This module's own pattern table earned six chips on itself and its tests ten —
    // every one of them the literal pattern sitting inside quotes.
    const f = file("a.ts",
      add(`const SILENCED = [{ re: /x/, what: "a bare \`except:\`" }];`, 4),
      add(`t.push({ what: "\`as any\`" });`, 5));
    expect(silencedIn(f)).toEqual([]);
  });

  it("still finds the real thing on a line that also carries a string", () => {
    const f = file("a.py", add(`    except:  log("failed to parse")`, 7));
    expect(silencedIn(f).map((s) => s.line)).toEqual([7]);
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

  it("applies no code-shaped rule to something that is not code", () => {
    // The CHANGELOG entry *announcing* the silenced-error rule earned a red chip for
    // containing the word — the exact false positive that teaches you to stop reading.
    const md = file("CHANGELOG.md", add("- a new bare `except:`, an empty `catch`", 25));
    const big = health({ code_lines: 900, code_added: 400, max_nesting: 9, nesting_line: 3 });
    expect(fileChips(md, big, report({ p90_code_lines: 100 }))).toEqual([]);
  });

  it("still reports a duplicated block in a file that is not code", () => {
    // A copy-pasted CI job is a copy-pasted CI job. Only the code-shaped rules go away.
    const yml = file(".github/workflows/ci.yml", add("      run: pnpm test", 12));
    const h = health({ dups: [{ line: 12, other_path: ".github/workflows/release.yml", other_line: 30 }] });
    expect(ids(fileChips(yml, h, report()))).toEqual(["dup"]);
  });

  it("points the complexity and length chips at a line the change added", () => {
    // Their subject is a function, but its declaration can sit hundreds of lines above
    // the hunk — and a patch renders only its hunks, so the click would scroll to
    // nothing and flash nothing: indistinguishable from a control that does not work.
    const f = file("src/a.ts", ctx("untouched", 100), add("  changed();", 260));
    const fn = { name: "run", start: 10, end: 300, code_lines: 254, cognitive: 30 };
    const chips = fileChips(f, health({ worst_fn: fn, longest_fn: fn }), report());
    const cog = chips.find((c) => c.id === "cognitive")!;
    expect(cog.places).toEqual([260]);
    expect(cog.title).toContain("from line 10");
  });

  it("falls back to the declaration when the change added nothing inside the function", () => {
    const f = file("src/a.ts", del("gone", 4));
    const fn = { name: "run", start: 10, end: 300, code_lines: 254, cognitive: 30 };
    expect(fileChips(f, health({ worst_fn: fn }), report()).find((c) => c.id === "cognitive")!.places).toEqual([10]);
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
    expect(c.places).toEqual([42]);
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
    expect(c.places).toEqual([204]);
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
    expect(c.places).toEqual([88]);
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

describe("every line a finding covers", () => {
  // Marking only the first was most of why the old flash read as "something happened
  // somewhere": a `dup ×3` is three separate blocks and a complex function is a span.
  it("lists all three places a duplicated block landed", () => {
    const h = health({ dups: [
      { line: 10, other_path: "a.ts", other_line: 1 },
      { line: 40, other_path: "b.ts", other_line: 2 },
      { line: 90, other_path: "c.ts", other_line: 3 },
    ] });
    const c = fileChips(file("src/x.ts", add("x", 10)), h, report())[0];
    expect(c.lines).toEqual([10, 40, 90]);
    expect(c.places).toEqual([10, 40, 90]);
  });

  it("lists every silenced line, not just the one it scrolls to", () => {
    const f = file("a.py", add("except:", 3), add("x = 1", 4), add("except Exception:", 9));
    const c = fileChips(f, health(), report()).find((x) => x.id === "silenced")!;
    expect(c.lines).toEqual([3, 9]);
  });

  it("spans a complex function across the lines the change added inside it", () => {
    const f = file("src/a.ts", add("a", 20), add("b", 21), ctx("c", 22), add("d", 40), add("e", 500));
    const fn = { name: "big", start: 15, end: 50, code_lines: 30, cognitive: 30 };
    const c = fileChips(f, health({ worst_fn: fn }), report()).find((x) => x.id === "cognitive")!;
    expect(c.lines).toEqual([20, 21, 40]);
    expect(c.lines).not.toContain(500);
  });

  it("gives a finding about the whole file no lines to mark", () => {
    const h = health({ code_lines: 900, code_added: 100 });
    const c = fileChips(file("src/a.ts", add("x", 1)), h, report())!.find((x) => x.id === "grew")!;
    expect(c.lines).toEqual([]);
    expect(c.places).toEqual([]);
  });
});

describe("findingsText", () => {
  const f1 = file("src/a.ts", add("except:", 3));
  const f2 = file("src/b.ts", add("x", 1));

  it("names a file and a line for every finding, so an agent can open it", () => {
    const chips = [fileChips(f1, health(), report()), fileChips(f2, health(), report())];
    const out = findingsText("myproj · main", [f1, f2], chips, []);
    expect(out).toContain("# Code health — myproj · main");
    expect(out).toContain("## src/a.ts");
    expect(out).toContain("(line 3)");
    // A file that earned nothing is not a heading with nothing under it.
    expect(out).not.toContain("## src/b.ts");
  });

  it("flattens a finding's prose onto its own bullet", () => {
    const h = health({ dups: [{ line: 9, other_path: "src/z.ts", other_line: 4 }] });
    const out = findingsText("p", [f2], [fileChips(f2, h, report())], []);
    const bullet = out.split("\n").find((l) => l.startsWith("- "))!;
    expect(bullet).toContain("src/z.ts:4");
    expect(bullet.split("\n")).toHaveLength(1);
  });

  it("counts the places when a finding covers more than one", () => {
    const h = health({ dups: [
      { line: 9, other_path: "a.ts", other_line: 1 },
      { line: 30, other_path: "b.ts", other_line: 2 },
    ] });
    expect(findingsText("p", [f2], [fileChips(f2, h, report())], [])).toContain("2 places");
  });

  it("says so plainly when there is nothing to hand over", () => {
    expect(findingsText("myproj", [f2], [[]], [])).toBe("No code-health findings in myproj.");
  });

  it("carries the whole-change findings under their own heading", () => {
    const set = setChips([f1], report());
    const out = findingsText("p", [f1], [[]], set);
    expect(out).toContain("About the change as a whole");
    expect(out).toContain("no test changed");
  });
});

describe("setChips", () => {
  it("admits that a cut diff means cut findings, not a cleaner change", () => {
    // The viewer's own note says the *diff* is short, which a reader takes to mean the
    // listing is short — not that the measurements are.
    const got = setChips([], report(), true);
    expect(ids(got)).toEqual(["partial"]);
    expect(got[0].text).toBe("findings incomplete");
  });

  it("prefers the diff's cut over the index's when both happened", () => {
    const got = setChips([], report({ truncated: true }), true);
    expect(got.map((c) => c.text)).toEqual(["findings incomplete"]);
  });
});

describe("worstSev", () => {
  it("is null for a file with nothing to say, so the row stays silent", () => {
    expect(worstSev([])).toBeNull();
  });

  it("reports the loudest present", () => {
    const c = (sev: Chip["sev"]): Chip => ({ id: "x", sev, text: "", title: "", places: [], lines: [] });
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

// A fourth source-parsing contract test, for the same reason as the other three: the join
// it guards has nothing between its two halves that can check it.
//
// `is_code_file` in health.rs decides which files the backend measures and counts into
// `p90_code_lines`; `isSourcePath` here decides which of those may carry a chip. health.rs
// says so in its own doc comment ("The frontend keeps the same list … keep them in step"),
// and a comment is exactly as strong as whoever reads it. When they drift the failure is
// silent in the worst direction: the file is measured, the numbers are real, and then
// `fileChips` takes its early return and says nothing at all. `css`, `scss`, `bash` and
// `kts` had drifted out of this half.
describe("the two source-extension lists are one list", () => {
  it("matches `is_code_file` in health.rs, which says they must", () => {
    const rs = readFileSync(new URL("../src-tauri/src/health.rs", import.meta.url), "utf8");
    const fn = rs.slice(rs.indexOf("fn is_code_file"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    const rust = new Set([...body.matchAll(/"(\w+)"/g)].map((m) => m[1]));
    expect(rust.size, "could not read the rust list — has is_code_file been rewritten?")
      .toBeGreaterThan(15);

    // Drive the TS half through its own public predicate rather than re-reading its
    // array: what matters is the answer callers get, not how it is spelled.
    const onlyRust = [...rust].filter((e) => !isSourcePath(`f.${e}`));
    expect(onlyRust, "health.rs measures these; health.ts will never chip them").toEqual([]);
    for (const e of rust) expect(isSourcePath(`a/b/f.${e}`), e).toBe(true);
    for (const e of ["md", "json", "toml", "lock", "svg"]) expect(isSourcePath(`f.${e}`), e).toBe(false);
  });
});

describe("a chip's tooltip reads as a sentence", () => {
  // The singular branch interpolated an empty string straight against the first entry,
  // so one silenced error rendered "This change addsline 42: …". It is the common case,
  // it is shown as the chip's `title`, and `findingsText` flattens it into the text a
  // session is handed — so the typo reached an agent as a prompt.
  it("does not run the count into the first finding when there is only one", () => {
    const f = file("src/a.ts", add("  const x = y as any;", 42));
    const chips = fileChips(f, health(), report());
    const silenced = chips.find((c) => c.id === "silenced");
    expect(silenced, "no silenced chip to check").toBeTruthy();
    expect(silenced!.title).not.toMatch(/adds\s*line/);
    expect(silenced!.title).toContain("an error that is swallowed at line 42");
  });
});
