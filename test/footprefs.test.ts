import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOOT, FOOT_SEGS, footHiddenCount, footPrefsJson, footShown, parseFootPrefs,
  toggleFootSeg, type FootPrefs,
} from "../src/footprefs";

describe("the footer's segment table", () => {
  it("names an element for every segment, and never the same one twice", () => {
    const els = FOOT_SEGS.map((s) => s.el);
    expect(els.every(Boolean)).toBe(true);
    expect(new Set(els).size).toBe(els.length);
    expect(new Set(FOOT_SEGS.map((s) => s.id)).size).toBe(FOOT_SEGS.length);
  });
  // The three permanent ones are permanent by ABSENCE from this table — there is no
  // "locked" flag to get wrong. If one ever appears here it becomes hideable, and the
  // promise that the bar can never go blank goes with it.
  it("offers no switch for the repo link, the version or What's new", () => {
    const ids = FOOT_SEGS.map((s) => s.id) as string[];
    for (const forbidden of ["repo", "version", "changelog", "update"]) {
      expect(ids).not.toContain(forbidden);
    }
  });
});

describe("parseFootPrefs — the store and its repair", () => {
  it("shows everything when nothing has been stored", () => {
    expect(parseFootPrefs(null)).toEqual(DEFAULT_FOOT);
    expect(parseFootPrefs("")).toEqual({ hidden: [] });
  });
  it("reads back what it wrote", () => {
    const p: FootPrefs = { hidden: ["limits", "debug"] };
    expect(parseFootPrefs(footPrefsJson(p))).toEqual(p);
  });
  it("accepts a bare array, in case the shape is ever simplified again", () => {
    expect(parseFootPrefs('["io"]')).toEqual({ hidden: ["io"] });
  });
  // A stored id this build no longer knows would otherwise ride along forever — and a
  // segment that got *renamed* would come back switched off for everyone who had hidden
  // whatever it used to be called.
  it("drops an id this build does not have", () => {
    expect(parseFootPrefs('{"hidden":["limits","cpu","ram"]}')).toEqual({ hidden: ["limits"] });
  });
  it("de-duplicates", () => {
    expect(parseFootPrefs('{"hidden":["io","io"]}')).toEqual({ hidden: ["io"] });
  });
  // Falling back to "show everything" rather than "hide everything" is deliberate: the
  // visible state is the one you can see is wrong and fix from the same menu.
  it("falls back to showing everything on anything unparseable", () => {
    for (const junk of ["{", "null", "7", '{"hidden":"limits"}', "[[]]"]) {
      expect(parseFootPrefs(junk).hidden).toEqual([]);
    }
  });
});

describe("toggleFootSeg", () => {
  it("hides a shown segment and shows a hidden one", () => {
    let p: FootPrefs = { hidden: [] };
    expect(footShown(p, "io")).toBe(true);
    p = toggleFootSeg(p, "io");
    expect(footShown(p, "io")).toBe(false);
    expect(p.hidden).toEqual(["io"]);
    p = toggleFootSeg(p, "io");
    expect(footShown(p, "io")).toBe(true);
    expect(p.hidden).toEqual([]);
  });
  it("does not mutate what it was given, so a failed save cannot half-apply", () => {
    const p: FootPrefs = { hidden: ["cost"] };
    const next = toggleFootSeg(p, "limits");
    expect(p.hidden).toEqual(["cost"]);
    expect(next.hidden).toEqual(["cost", "limits"]);
  });
  it("leaves the other segments alone", () => {
    const p = toggleFootSeg({ hidden: ["cost", "debug"] }, "limits");
    expect(footShown(p, "cost")).toBe(false);
    expect(footShown(p, "debug")).toBe(false);
    expect(footShown(p, "sessions")).toBe(true);
  });
  // Hiding every switchable segment is allowed, precisely because the three permanent
  // ones are not in the table — the bar still has the repo link, the version and
  // What's new, so there is always a way back to Settings.
  it("allows every switchable segment to be off at once", () => {
    let p: FootPrefs = { hidden: [] };
    for (const s of FOOT_SEGS) p = toggleFootSeg(p, s.id);
    expect(footHiddenCount(p)).toBe(FOOT_SEGS.length);
    expect(FOOT_SEGS.every((s) => !footShown(p, s.id))).toBe(true);
  });
});
