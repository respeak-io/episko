import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import {
  bumpFrec, forgetFrec, frecency, frecScore, fuzzy, parsePal, scoreItem, type PalItem,
} from "../src/palette";

const NOW_MS = 1800000000000; // 2027-01-15T08:00:00Z
const DAY = 86400000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  for (const k of Object.keys(frecency)) delete frecency[k];
  store.clear();
});
afterEach(() => { vi.useRealTimers(); });

const item = (o: Partial<PalItem> = {}): PalItem =>
  ({ kind: "command", key: "k", label: "Label", labelHtml: "Label", run: () => {}, ...o });
// Scores are a weighted sum; comparing two candidates is what the palette actually
// does, so most assertions here are relative rather than magic numbers.
const score = (text: string, q: string) => fuzzy(text, q)!.score;

describe("fuzzy — subsequence matching", () => {
  it("matches characters in order, not necessarily adjacent", () => {
    expect(fuzzy("Respeak", "rsp")).not.toBeNull();
    expect(fuzzy("Respeak", "per")).toBeNull(); // no r left after the p — order is not optional
  });
  it("is case-insensitive both ways", () => {
    expect(fuzzy("Respeak", "RESP")).not.toBeNull();
    expect(fuzzy("RESPEAK", "resp")).not.toBeNull();
  });
  it("returns a zero-score pass-through for an empty query", () => {
    // The unfiltered palette: everything matches, nothing is highlighted, and the
    // caller's own ordering survives because every score is identical.
    expect(fuzzy("anything", "")).toEqual({ score: 0, html: "anything" });
  });
  it("still escapes on that pass — an empty query is not a raw-HTML shortcut", () => {
    expect(fuzzy("a<b&c", "")).toEqual({ score: 0, html: "a&lt;b&amp;c" });
  });
  it("rejects a query with a character the text hasn't got", () => {
    expect(fuzzy("Respeak", "resz")).toBeNull();
  });
  it("consumes each match, so a repeated letter needs a repeat in the text", () => {
    expect(fuzzy("aba", "aa")).not.toBeNull();
    expect(fuzzy("ab", "aa")).toBeNull();
  });
});

describe("fuzzy — the highlight it hands to the palette", () => {
  it("wraps every matched character and leaves the rest alone", () => {
    expect(fuzzy("abc", "ac")!.html).toBe(`<b class="hit">a</b>b<b class="hit">c</b>`);
  });
  it("escapes the text it wraps, matched characters included", () => {
    // The result goes straight into innerHTML, so a project called "a<b" must not
    // become a tag.
    expect(fuzzy("a<b&c", "a<")!.html)
      .toBe(`<b class="hit">a</b><b class="hit">&lt;</b>b&amp;c`);
  });
  it("preserves the original casing in the output", () => {
    expect(fuzzy("Respeak", "resp")!.html).toContain(`<b class="hit">R</b>`);
  });
});

describe("fuzzy — what makes one match better than another", () => {
  it("rewards a contiguous run over a scattered one", () => {
    expect(score("abc", "ab")).toBeGreaterThan(score("abc", "ac"));
  });
  it("lets contiguity outweigh starting earlier", () => {
    // Both texts match "ab" mid-string with no word-start bonus in play, so the run
    // is the only thing between them: "zzab" matches adjacently but starts a
    // character later than "zazb", and still wins. The bonus has to both grow along
    // a run and reset on a gap for this to hold.
    expect(score("zzab", "ab")).toBeGreaterThan(score("zazb", "ab"));
  });
  it("rewards a match at a word start", () => {
    expect(score("x b", "b")).toBeGreaterThan(score("xyb", "b"));
    expect(score("my-project", "p")).toBeGreaterThan(score("myproject", "p"));
  });
  it("counts the start of the string as a word start", () => {
    expect(score("bx", "b")).toBeGreaterThan(score("xb", "b"));
  });
  it("treats space, slash, dot, underscore, hyphen and · as word starts", () => {
    for (const sep of [" ", "/", ".", "_", "-", "·"]) {
      expect(score(`x${sep}b`, "b"), sep).toBeGreaterThan(score("xyb", "b"));
    }
  });
  it("mildly penalises a match found further along", () => {
    // Two matches that are otherwise identical: the earlier one wins.
    expect(score("b----------", "b")).toBeGreaterThan(score("----------b", "b"));
  });
  it("prefers the whole query landing early over a single late word start", () => {
    expect(score("respeak", "resp")).toBeGreaterThan(score("x-response", "resp"));
  });
});

// Both path separators, because a palette subtitle carries a *native* path
// (`tilde(p.path)` on a launch row). Treating only `/` as a word start meant no
// path segment was ever a word start on Windows, which did not merely lower the
// score — it inverted the ranking. Regression-guarded on both platforms below.
describe("fuzzy — path separators", () => {
  it("gives a segment start its word-start bonus after either separator", () => {
    expect(score("a/b", "b")).toBeGreaterThan(score("ayb", "b"));
    expect(score("a\\b", "b")).toBeGreaterThan(score("ayb", "b"));
  });
  it("scores a native path the same either way, bar the drive prefix's length", () => {
    // What is left between them is only the position penalty for starting one index
    // later: 4 matched characters × 0.02. A missing word-start bonus would cost 4.0,
    // fifty times more — which is what made the ranking invert.
    const gap = score("~/code/Respeak", "resp") - score("E:\\code\\Respeak", "resp");
    expect(gap).toBeCloseTo(0.08, 10);
  });
  it("ranks the exactly-named folder first on both platforms", () => {
    const exact = "Respeak", incidental = "x-response-log";
    expect(score(`~/code/${exact}`, "resp")).toBeGreaterThan(score(`~/code/${incidental}`, "resp"));
    expect(score(`E:\\code\\${exact}`, "resp")).toBeGreaterThan(score(`E:\\code\\${incidental}`, "resp"));
  });
});

describe("scoreItem — matching a row's label, then its subtitle", () => {
  it("returns the row with its highlight and score when the label matches", () => {
    const r = scoreItem(item({ label: "Launch Respeak" }), "resp")!;
    expect(r.labelHtml).toContain(`<b class="hit">R</b>`);
    expect(r.score).toBeGreaterThan(0);
  });
  it("falls back to the subtitle so a path or status still filters", () => {
    const r = scoreItem(item({ label: "Launch Respeak", sub: "~/code/respeak" }), "code")!;
    expect(r).not.toBeNull();
    expect(r.labelHtml).toBe("Launch Respeak"); // a sub match highlights nothing
  });
  it("ranks a subtitle match below an equivalent label match", () => {
    const viaLabel = scoreItem(item({ label: "code" }), "code")!;
    const viaSub = scoreItem(item({ label: "zzzz", sub: "code" }), "code")!;
    expect(viaSub.score).toBe(viaLabel.score! - 2);
  });
  it("returns null when neither matches", () => {
    expect(scoreItem(item({ label: "Launch Respeak", sub: "~/code" }), "zzz")).toBeNull();
  });
  it("keeps every other field of the row intact", () => {
    const run = () => {};
    const r = scoreItem(item({ kind: "launch", key: "launch:/p", label: "Launch p", glyph: "▶", run }), "p")!;
    expect(r).toMatchObject({ kind: "launch", key: "launch:/p", glyph: "▶", run });
  });
  it("passes everything through on an empty term, without consulting the subtitle", () => {
    const r = scoreItem(item({ label: "Anything", sub: "zzz" }), "")!;
    expect(r.score).toBe(0);
    expect(r.labelHtml).toBe("Anything");
  });
});

describe("parsePal — the prefixes that scope the search", () => {
  it("reads a bare query as searching everything", () => {
    expect(parsePal("respeak")).toEqual({ mode: "all", term: "respeak" });
  });
  it("scopes to commands with > or the ⟩ the palette renders", () => {
    expect(parsePal(">kill")).toEqual({ mode: "cmd", term: "kill" });
    expect(parsePal("⟩kill")).toEqual({ mode: "cmd", term: "kill" });
  });
  it("scopes to sessions with @ and to state with /", () => {
    expect(parsePal("@epi")).toEqual({ mode: "sess", term: "epi" });
    expect(parsePal("/done")).toEqual({ mode: "filter", term: "done" });
  });
  it("ignores leading whitespace before the sigil", () => {
    expect(parsePal("   >kill")).toEqual({ mode: "cmd", term: "kill" });
  });
  it("trims the term, so a sigil alone opens the whole scope", () => {
    expect(parsePal("> kill ")).toEqual({ mode: "cmd", term: "kill" });
    expect(parsePal(">")).toEqual({ mode: "cmd", term: "" });
    expect(parsePal("")).toEqual({ mode: "all", term: "" });
    expect(parsePal("   ")).toEqual({ mode: "all", term: "" });
  });
  it("only reads a sigil at the front", () => {
    expect(parsePal("a>b")).toEqual({ mode: "all", term: "a>b" });
  });
});

describe("frecency — recency × frequency, with a 30-day half-life", () => {
  it("scores an unknown key zero", () => {
    expect(frecScore("never-used")).toBe(0);
  });
  it("counts uses", () => {
    bumpFrec("cmd:kill");
    expect(frecScore("cmd:kill")).toBe(1);
    bumpFrec("cmd:kill");
    expect(frecScore("cmd:kill")).toBe(2);
  });
  it("halves the score every 30 days", () => {
    bumpFrec("cmd:kill");
    vi.setSystemTime(NOW_MS + 30 * DAY);
    expect(frecScore("cmd:kill")).toBeCloseTo(0.5, 10);
    vi.setSystemTime(NOW_MS + 60 * DAY);
    expect(frecScore("cmd:kill")).toBeCloseTo(0.25, 10);
  });
  it("lets recent use beat sheer volume", () => {
    // The whole point of frecency over a plain counter.
    bumpFrec("old"); bumpFrec("old"); bumpFrec("old"); bumpFrec("old");
    vi.setSystemTime(NOW_MS + 90 * DAY);
    bumpFrec("new");
    expect(frecScore("new")).toBeGreaterThan(frecScore("old"));
  });
  it("resets the decay clock on each use, rather than averaging", () => {
    bumpFrec("k");
    vi.setSystemTime(NOW_MS + 30 * DAY);
    bumpFrec("k");                       // n = 2, and the age goes back to zero
    expect(frecScore("k")).toBe(2);
  });

  it("never records a session key — sessions are transient, their ids are not reused", () => {
    bumpFrec("session:abc");
    expect(frecency["session:abc"]).toBeUndefined();
    expect(frecScore("session:abc")).toBe(0);
  });
  it("ignores an empty key", () => {
    bumpFrec("");
    expect(frecency).toEqual({});
  });
  it("persists, so the ranking survives a restart", () => {
    bumpFrec("cmd:kill");
    expect(JSON.parse(store.get("cc-frecency")!)).toEqual({ "cmd:kill": { n: 1, t: NOW_MS } });
  });
});

// The ✕ on a Run picker "recent" row. It drops the history rather than flagging the
// row hidden, so there is nothing to keep in sync and nothing that could resurrect
// a stale score later.
describe("forgetFrec — dropping one thing's history", () => {
  it("takes the key back to never-used", () => {
    bumpFrec("task:npm:dev"); bumpFrec("task:npm:dev");
    forgetFrec("task:npm:dev");
    expect(frecScore("task:npm:dev")).toBe(0);
    expect(frecency["task:npm:dev"]).toBeUndefined();
  });
  it("leaves every other key alone", () => {
    bumpFrec("task:npm:dev"); bumpFrec("task:npm:test");
    forgetFrec("task:npm:dev");
    expect(frecScore("task:npm:test")).toBe(1);
  });
  it("persists, so the row doesn't come back on the next launch", () => {
    bumpFrec("task:npm:dev"); bumpFrec("task:npm:test");
    forgetFrec("task:npm:dev");
    expect(JSON.parse(store.get("cc-frecency")!)).toEqual({ "task:npm:test": { n: 1, t: NOW_MS } });
  });
  it("is undone by using the thing again, from zero", () => {
    // The whole undo story: forgetting is not a tombstone, so a task you forget and
    // then run is simply a task used once.
    bumpFrec("task:npm:dev"); bumpFrec("task:npm:dev"); bumpFrec("task:npm:dev");
    forgetFrec("task:npm:dev");
    bumpFrec("task:npm:dev");
    expect(frecScore("task:npm:dev")).toBe(1);
  });
  it("ignores a key it has never seen, without writing", () => {
    forgetFrec("task:never");
    expect(frecency).toEqual({});
    expect(store.get("cc-frecency")).toBeUndefined();
  });
});
