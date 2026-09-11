import { describe, expect, it } from "vitest";
import { highlight, isSearching, matchRow, parseQuery, SEARCH_FILTERS, type SearchRow } from "../src/setsearch";

const row = (over: Partial<SearchRow> = {}): SearchRow => ({
  id: "engine", tab: "launching", tabLabel: "Launching", group: "work", groupLabel: "Work",
  label: "Launch engine", hint: "Where a new session's terminal opens.",
  more: "A session in an external tab is mirrored into its pane.", value: "Embedded",
  options: ["Embedded", "Ghostty", "Terminal"], aliases: ["iterm", "external"], key: "cc-term-engine",
  changed: false, isNew: false, mac: false, ...over,
});

describe("parseQuery", () => {
  it("splits words from the @ words and lowercases both", () => {
    const q = parseQuery("  Ghostty @changed @in:Sidebar @key:cc-peek @mac @new ");
    expect(q.words).toEqual(["ghostty"]);
    expect(q).toMatchObject({ changed: true, isNew: true, mac: true, inTab: "sidebar", key: "cc-peek", unknown: [] });
  });
  it("keeps an @ word it does not know, so the UI can say so", () => {
    expect(parseQuery("@foo dark").unknown).toEqual(["@foo"]);
    expect(parseQuery("@in: dark").unknown).toEqual(["@in:"]);
  });
  it("is searching on a filter alone, and not on whitespace", () => {
    expect(isSearching(parseQuery("@changed"))).toBe(true);
    expect(isSearching(parseQuery("   "))).toBe(false);
  });
  it("lists the three chips", () => { expect(SEARCH_FILTERS).toEqual(["@changed", "@new", "@mac"]); });
});

describe("matchRow", () => {
  it("matches the label first and does not report it as a hidden hit", () => {
    const h = matchRow(row(), parseQuery("launch"))!;
    expect(h.score).toBe(14);          // label 10 + prefix 4
    expect(h.why).toEqual([]);
    expect(h.fuzzy).toBe(false);
  });
  it("finds an option and says which word did it", () => {
    const h = matchRow(row(), parseQuery("ghostty"))!;
    expect(h.why).toEqual([{ word: "ghostty", field: "option" }]);
  });
  it("finds an alias, the key and a line inside a panel", () => {
    expect(matchRow(row(), parseQuery("iterm"))!.why[0].field).toBe("alias");
    expect(matchRow(row(), parseQuery("cc-term"))!.why[0].field).toBe("key");
    const h = matchRow(row({ lines: ["Command palette ⌘K", "Toggle sidebar ⌘B"], aliases: ["palette"] }), parseQuery("palette"))!;
    expect(h.lines).toEqual([0]); // the line wins over an alias of the same word, so the panel opens
    expect(h.why).toEqual([{ word: "palette", field: "line", line: "Command palette ⌘K" }]);
  });
  it("needs every word, each in any field", () => {
    expect(matchRow(row(), parseQuery("engine mirrored"))).not.toBeNull();
    expect(matchRow(row(), parseQuery("engine banana"))).toBeNull();
  });
  it("falls back to letters in the label, and flags it", () => {
    const h = matchRow(row(), parseQuery("lnche"))!;
    expect(h.fuzzy).toBe(true);
    expect(matchRow(row(), parseQuery("zzz"))).toBeNull();
  });
  it("applies the filters before any word", () => {
    expect(matchRow(row(), parseQuery("@changed"))).toBeNull();
    expect(matchRow(row({ changed: true }), parseQuery("@changed"))).not.toBeNull();
    expect(matchRow(row(), parseQuery("@new"))).toBeNull();
    expect(matchRow(row({ isNew: true }), parseQuery("@new engine"))).not.toBeNull();
    expect(matchRow(row(), parseQuery("@mac"))).toBeNull();
    expect(matchRow(row({ mac: true }), parseQuery("@mac"))).not.toBeNull();
  });
  it("scopes @in: to a section or a heading, by id or by label", () => {
    expect(matchRow(row(), parseQuery("@in:launch"))).not.toBeNull();
    expect(matchRow(row(), parseQuery("@in:work"))).not.toBeNull();
    expect(matchRow(row(), parseQuery("@in:sidebar"))).toBeNull();
    expect(matchRow(row(), parseQuery("@key:cc-peek"))).toBeNull();
  });
  it("matches the section name and the current value", () => {
    expect(matchRow(row(), parseQuery("launching"))!.why).toEqual([]);
    expect(matchRow(row(), parseQuery("embedded"))).not.toBeNull();
  });
});

describe("highlight", () => {
  it("escapes first and marks every word, case-insensitively", () => {
    expect(highlight("Usage & spend <b>", ["spend", "usage"]))
      .toBe('<mark class="set-hit">Usage</mark> &amp; <mark class="set-hit">spend</mark> &lt;b>');
  });
  it("never nests a mark inside a mark", () => {
    expect(highlight("mark this", ["mark", "ark"])).toBe('<mark class="set-hit">mark</mark> this');
  });
  it("treats a word as text, not a pattern", () => {
    expect(highlight("a.b (c)", ["a.b", "(c)"])).toBe('<mark class="set-hit">a.b</mark> <mark class="set-hit">(c)</mark>');
    expect(highlight("axb", ["a.b"])).toBe("axb");
  });
});
