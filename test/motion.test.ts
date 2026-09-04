import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_FX_CLASSES, DEFAULT_MOTION, VISUAL_FX, fxOn, motionPrefsJson, parseMotionPrefs,
  rootFxClasses, toggleFx, type MotionPrefs,
} from "../src/motion";

const CSS = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("the visual-effects table", () => {
  it("names a class for every effect, and never the same one twice", () => {
    const cls = VISUAL_FX.map((f) => f.cls);
    expect(cls.every(Boolean)).toBe(true);
    expect(new Set(cls).size).toBe(cls.length);
    expect(new Set(VISUAL_FX.map((f) => f.id)).size).toBe(VISUAL_FX.length);
  });
  it("exports every class it can produce, so applyFx can clear what it is not setting", () => {
    for (const f of VISUAL_FX) expect(ALL_FX_CLASSES).toContain(f.cls);
  });
  it("has a stylesheet rule behind every class", () => {
    for (const f of VISUAL_FX) expect(CSS).toContain(`:root.${f.cls}`);
  });
});

describe("parseMotionPrefs — the store and its repair", () => {
  // null is a first run; an empty list on disk is a choice and must not be re-defaulted.
  it("pauses in the background on a first run, and remembers a choice not to", () => {
    expect(parseMotionPrefs(null)).toEqual(DEFAULT_MOTION);
    expect(parseMotionPrefs(null).off).toContain("idle");
    expect(parseMotionPrefs('{"off":[]}')).toEqual({ off: [] });
  });
  it("reads back what it wrote", () => {
    const p: MotionPrefs = { off: ["motion", "blur"] };
    expect(parseMotionPrefs(motionPrefsJson(p))).toEqual(p);
  });
  it("falls back to the defaults on anything unparseable", () => {
    for (const raw of ["", "{", "null", "[]", '{"off":"motion"}', '{"nope":1}']) {
      expect(parseMotionPrefs(raw)).toEqual(DEFAULT_MOTION);
    }
  });
  it("drops an id this build does not know, rather than carrying it forever", () => {
    expect(parseMotionPrefs('{"off":["motion","glitter"]}')).toEqual({ off: ["motion"] });
  });
  it("de-duplicates", () => {
    expect(parseMotionPrefs('{"off":["blur","blur"]}')).toEqual({ off: ["blur"] });
  });
});

describe("fxOn / toggleFx", () => {
  it("treats absence as on", () => {
    expect(fxOn({ off: [] }, "motion")).toBe(true);
    expect(fxOn({ off: ["motion"] }, "motion")).toBe(false);
    expect(fxOn({ off: ["motion"] }, "blur")).toBe(true);
  });
  it("round-trips a flip and never mutates what it was given", () => {
    const p: MotionPrefs = { off: [] };
    const off = toggleFx(p, "blur");
    expect(p.off).toEqual([]);
    expect(fxOn(off, "blur")).toBe(false);
    expect(fxOn(toggleFx(off, "blur"), "blur")).toBe(true);
  });
  it("ignores an id it does not know", () => {
    const p: MotionPrefs = { off: ["blur"] };
    expect(toggleFx(p, "glitter" as never)).toBe(p);
  });
});

describe("rootFxClasses — the whole truth table", () => {
  it("adds nothing when everything is on and the window has focus", () => {
    expect(rootFxClasses({ off: [] }, true)).toEqual([]);
  });
  it("still adds nothing when everything is on and focus is lost", () => {
    // idle ON means keep animating in the background
    expect(rootFxClasses({ off: [] }, false)).toEqual([]);
  });
  it("pauses only once focus is actually lost", () => {
    expect(rootFxClasses({ off: ["idle"] }, true)).toEqual([]);
    expect(rootFxClasses({ off: ["idle"] }, false)).toEqual(["fx-idle"]);
  });
  it("carries the two standing switches regardless of focus", () => {
    for (const focused of [true, false]) {
      expect(rootFxClasses({ off: ["motion"] }, focused)).toEqual(["fx-still"]);
      expect(rootFxClasses({ off: ["blur"] }, focused)).toEqual(["fx-flat"]);
    }
  });
  it("combines all three", () => {
    expect(rootFxClasses({ off: ["motion", "blur", "idle"] }, false))
      .toEqual(["fx-still", "fx-flat", "fx-idle"]);
  });
  // A pause folded into the cancel would restart every glyph in lockstep on refocus.
  it("keeps the cancel and the pause as different classes", () => {
    expect(rootFxClasses({ off: ["motion", "idle"] }, false)).toContain("fx-still");
    expect(rootFxClasses({ off: ["motion", "idle"] }, false)).toContain("fx-idle");
  });
});

// ---------------------------------------------------------------------------
// fx-still is a superset of prefers-reduced-motion, and the two must agree on the substitutes:
// animations that carry a state and get a static stand-in rather than `animation: none`.
describe("fx-still keeps the substitutes the OS's reduce setting defines", () => {
  // Selectors whose `reduce` block supplies a substitute value.
  const SUBSTITUTED = [".srow.lit", ".pgroup.arming .parm", ".wt-sk i", ".u-spin"];

  it("gives every substituted selector the same treatment under fx-still", () => {
    for (const sel of SUBSTITUTED) {
      expect(CSS, `${sel} has a reduce-mode substitute`).toContain(`${sel} { animation: none;`);
      expect(CSS, `${sel} needs the same substitute under :root.fx-still`).toContain(`:root.fx-still ${sel} {`);
    }
  });

  it("adds no fx-still substitute the reduce blocks do not have", () => {
    const declared = [...CSS.matchAll(/:root\.fx-still ([^{,]+?) \{/g)]
      .map((m) => m[1].trim())
      .filter((sel) => !sel.startsWith("*")); // the universal cancel, not a substitute
    expect(declared.length).toBeGreaterThan(0);
    for (const sel of declared) expect(SUBSTITUTED).toContain(sel);
  });

  it("cancels rather than pauses, so nothing is left stranded mid-fade", () => {
    expect(CSS).toContain("animation-iteration-count: 1 !important");
    expect(CSS).toContain(":root.fx-idle *");
    // the pause must leave transitions alone, or a dialog caught mid-fade stays half open
    const idleBlock = CSS.slice(CSS.indexOf(":root.fx-idle *"));
    expect(idleBlock).not.toContain("transition-duration");
  });
});

// A dialog mounted at opacity 0 that keeps its blur is a per-frame GPU cost for nothing.
describe("a closed dialog carries no backdrop", () => {
  it("gates every mounted-but-closed blur on .show", () => {
    // FREE: display:none when closed (no cost) or gated by a parent dialog
    const FREE = ["colorpop", "menupop", "tour-card", "dbg-panel", "gcommit", "run-grp", "bk-h"];
    const blurred = new Set<string>();
    for (const m of CSS.matchAll(/^\.([\w-]+)[^{]*\{[^}]*backdrop-filter/gm)) blurred.add(m[1]);
    for (const cls of blurred) {
      if (FREE.includes(cls)) continue;
      expect(CSS, `.${cls} blurs while closed`).toContain(`.${cls}:not(.show)`);
    }
  });
});
