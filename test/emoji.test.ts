import { describe, expect, it } from "vitest";
import { EM_COLS, EM_HEAD_H, EM_ROW_H, emojiRows, rowWindow } from "../src/emoji";
import type { EmRow } from "../src/emoji";
import { EMOJI_ALL, EMOJI_GROUPS } from "../src/emojidata";

const cells = (rows: EmRow[]) => rows.flatMap((r) => (r.kind === "grid" ? r.cells : []));
const chars = (rows: EmRow[]) => cells(rows).map((c) => c.ch);
const heads = (rows: EmRow[]) => rows.flatMap((r) => (r.kind === "head" ? [r.label] : []));

describe("the generated data", () => {
  it("is one `<char> <name>` per line, in group order", () => {
    expect(EMOJI_ALL.length).toBeGreaterThan(1500);
    for (const s of EMOJI_ALL.slice(0, 50)) expect(s).toMatch(/^\S+ \S/);
    expect(EMOJI_GROUPS.map((g) => g[1])).toEqual([...EMOJI_GROUPS.map((g) => g[1])].sort((a, b) => a - b));
    expect(EMOJI_GROUPS[0][1]).toBe(0);
  });
  // The suggested row is hand-written; a char whose spelling the data does not share (a missing
  // variation selector is the usual one) would have no name and no group to be found under.
  it("names every suggested emoji", () => {
    const known = new Set(EMOJI_ALL.map((s) => s.slice(0, s.indexOf(" "))));
    const suggested = chars(emojiRows("").slice(0, 1 + 64 / EM_COLS));
    expect(suggested).toHaveLength(64);
    for (const ch of suggested) expect(known.has(ch), `${ch} is not in the data`).toBe(true);
  });
});

describe("emojiRows — browsing", () => {
  it("opens on Suggested, then every Unicode group", () => {
    const rows = emojiRows("");
    expect(heads(rows)[0]).toBe("Suggested");
    expect(heads(rows).slice(1)).toEqual(EMOJI_GROUPS.map((g) => g[0]));
    expect(cells(rows)).toHaveLength(64 + EMOJI_ALL.length);
  });
  it("fills rows to the column count, with a short last row per group", () => {
    for (const r of emojiRows("")) if (r.kind === "grid") expect(r.cells.length).toBeLessThanOrEqual(EM_COLS);
    expect(emojiRows("", { cols: 4 }).every((r) => r.kind === "head" || r.cells.length <= 4)).toBe(true);
  });
  // Windows has no regional-indicator glyphs, so those rows would be pairs of letters.
  it("can leave the flags out", () => {
    expect(heads(emojiRows("", { flags: false }))).not.toContain("Flags");
    expect(chars(emojiRows("", { flags: false }))).not.toContain("🇩🇪");
    expect(chars(emojiRows(""))).toContain("🇩🇪");
    expect(chars(emojiRows("germany", { flags: false }))).not.toContain("🇩🇪");
  });
});

describe("emojiRows — searching", () => {
  it("finds by name, best first", () => {
    expect(chars(emojiRows("rocket"))[0]).toBe("🚀");
    expect(chars(emojiRows("crab"))[0]).toBe("🦀");
    expect(chars(emojiRows("penguin"))[0]).toBe("🐧");
  });
  it("drops the group headings, since one ranking crosses them", () => {
    expect(heads(emojiRows("face"))).toEqual([]);
  });
  it("ranks a whole name, then a leading match, then a word, then anywhere", () => {
    const names = cells(emojiRows("fire")).map((c) => c.name);
    expect(names[0]).toBe("fire");
    const rank = (n: string) => (n === "fire" ? 0 : n.startsWith("fire") ? 1 : / fire/.test(n) ? 2 : 3);
    expect(names.map(rank)).toEqual([...names.map(rank)].sort((a, b) => a - b));
  });
  it("is case- and space-insensitive", () => {
    expect(chars(emojiRows("ROCKET"))).toEqual(chars(emojiRows("  rocket ")));
  });
  it("says nothing rather than everything when a query matches no name", () => {
    expect(emojiRows("zzzznope")).toEqual([]);
  });
  // The panel's one field searches AND takes a paste, so an emoji typed into it is the answer.
  it("answers a pasted emoji with itself, including one the list omits", () => {
    expect(chars(emojiRows("🚀"))).toEqual(["🚀"]);
    expect(chars(emojiRows("🧑🏽‍🚀"))).toEqual(["🧑🏽‍🚀"]);
    expect(chars(emojiRows("👩‍💻"))).toEqual(["👩‍💻"]);
  });
  it("keeps a typed `:)` as a last resort, but only when no name matched", () => {
    expect(chars(emojiRows(":)"))).toEqual([":)"]);
    expect(chars(emojiRows("ok"))[0]).not.toBe("ok");
  });
});

describe("rowWindow — the virtual list", () => {
  const rows = emojiRows("");
  it("measures the whole list, whatever it paints", () => {
    const a = rowWindow(rows, 0, 260), b = rowWindow(rows, 4000, 260);
    expect(a.total).toBe(b.total);
    expect(a.total).toBe(rows.reduce((n, r) => n + (r.kind === "head" ? EM_HEAD_H : EM_ROW_H), 0));
  });
  it("paints a screenful and not a list", () => {
    const w = rowWindow(rows, 0, 260);
    expect(w.end - w.start).toBeLessThan(16);
    expect(w.padTop).toBe(0);
  });
  it("keeps the painted rows under the scroll offset", () => {
    for (const top of [0, 33, 260, 1000, 5000]) {
      const w = rowWindow(rows, top, 260);
      expect(w.padTop).toBeLessThanOrEqual(top);
      const painted = rows.slice(w.start, w.end).reduce((n, r) => n + (r.kind === "head" ? EM_HEAD_H : EM_ROW_H), 0);
      expect(w.padTop + painted).toBeGreaterThanOrEqual(Math.min(top + 260, w.total));
    }
  });
  it("stops at the end rather than running past it", () => {
    const w = rowWindow(rows, 1e6, 260);
    expect(w.end).toBe(rows.length);
    expect(w.padTop).toBeLessThanOrEqual(w.total);
  });
  it("holds an empty list without dividing by it", () => {
    expect(rowWindow([], 0, 260)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 });
  });
  // The two spacers plus what is painted must come to the full height, or the scrollbar lies
  // about how much list there is and the last rows cannot be reached.
  it("adds up to the total at every offset", () => {
    for (const top of [0, 33, 260, 1000, 5000, 1e6]) {
      const w = rowWindow(rows, top, 260);
      const painted = rows.slice(w.start, w.end).reduce((n, r) => n + (r.kind === "head" ? EM_HEAD_H : EM_ROW_H), 0);
      expect(w.padTop + painted + w.padBottom).toBe(w.total);
      expect(w.padBottom).toBeGreaterThanOrEqual(0);
    }
  });
});
