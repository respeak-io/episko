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
    // The whole point of ALL_FX_CLASSES is that `applyFx` removes classes it does not
    // know it set. An effect missing from it would leave its class stuck on <html>
    // forever after one toggle — switched off with no way back short of a restart.
    for (const f of VISUAL_FX) expect(ALL_FX_CLASSES).toContain(f.cls);
  });
  // Each class must actually appear in the stylesheet. A pref whose class nothing reads
  // is a switch that visibly does nothing, and `tsc` has no opinion about a string.
  it("has a stylesheet rule behind every class", () => {
    for (const f of VISUAL_FX) expect(CSS).toContain(`:root.${f.cls}`);
  });
});

describe("parseMotionPrefs — the store and its repair", () => {
  // A first run pauses in the background; someone who has switched that on has an empty
  // list on disk and must not be re-defaulted at every start. The two cases look alike
  // and are not, which is the only reason this module has a `raw === null` branch.
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
    expect(p.off).toEqual([]); // the input is untouched
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
    // `idle` ON is the expensive answer — it means "keep animating in the background".
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
  // fx-still cancels and fx-idle pauses, so the two must stay separate classes: folding
  // the pause into the cancel would restart every session's glyph in lockstep on return.
  it("keeps the cancel and the pause as different classes", () => {
    expect(rootFxClasses({ off: ["motion", "idle"] }, false)).toContain("fx-still");
    expect(rootFxClasses({ off: ["motion", "idle"] }, false)).toContain("fx-idle");
  });
});

// ---------------------------------------------------------------------------
// The contract half: this reads styles.css rather than calling anything.
//
// `fx-still` is a deliberate superset of `prefers-reduced-motion: reduce`: it flattens
// every transition where reduce names eight and tames a ninth. The bulk of it is
// drift-proof by construction — the universal rule ends every animation, including ones
// added later. What is NOT drift-proof, and what the two modes MUST agree on, is the
// short list of places where an animation carries a *state* rather than decorating one,
// where ending it instantly would delete information and a static substitute has to take
// over. Those exist twice: once in a `reduce` block, once under `fx-still`. Two lists
// that must agree is exactly the shape this repo keeps getting bitten by.
describe("fx-still keeps the substitutes the OS's reduce setting defines", () => {
  // Selectors whose `reduce` block supplies a substitute value, not just `animation: none`.
  const SUBSTITUTED = [".srow.lit", ".pgroup.arming .parm", ".wt-sk i", ".u-spin"];

  it("gives every substituted selector the same treatment under fx-still", () => {
    for (const sel of SUBSTITUTED) {
      expect(CSS, `${sel} has a reduce-mode substitute`).toContain(`${sel} { animation: none;`);
      expect(CSS, `${sel} needs the same substitute under :root.fx-still`).toContain(`:root.fx-still ${sel} {`);
    }
  });

  // The reverse direction: a substitute under fx-still that no reduce block asked for
  // means the two modes have started to look different, which is the drift this guards.
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
    // The pause must not touch transitions: a dialog caught mid-fade would stay at half
    // opacity until you clicked back into the window.
    const idleBlock = CSS.slice(CSS.indexOf(":root.fx-idle *"));
    expect(idleBlock).not.toContain("transition-duration");
  });
});

// Seventeen dialogs stay mounted at opacity 0 so they can fade. Each one that keeps a
// `backdrop-filter` while closed is a live render surface for a panel nobody can see.
describe("a closed dialog carries no backdrop", () => {
  it("gates every mounted-but-closed blur on .show", () => {
    // Every rule that declares a blur, minus the ones that are display:none when closed
    // (those cost nothing already) and the sub-headers whose parent dialog gates them.
    const FREE = ["colorpop", "menupop", "tour-card", "dbg-panel", "gcommit", "run-grp", "bk-h"];
    const blurred = new Set<string>();
    for (const m of CSS.matchAll(/^\.([\w-]+)[^{]*\{[^}]*backdrop-filter/gm)) blurred.add(m[1]);
    for (const cls of blurred) {
      if (FREE.includes(cls)) continue;
      expect(CSS, `.${cls} blurs while closed`).toContain(`.${cls}:not(.show)`);
    }
  });
});
