import { describe, expect, it } from "vitest";
import {
  bindableCombo, bindKey, clampKeyBinds, comboClash, comboKeys, comboMatches, comboOf,
  comboText, activeBind, clampKeyPrefs, defaultKeyBinds, defaultKeyPrefs, DIGIT_KEY,
  digitOf, formatCombo, isDefaultBind, isDefaultKeyBinds, isDefaultKeyPrefs, KEY_ACTIONS,
  KEY_ACTION_IDS, KEY_GROUPS, keyActionDef, keyOverrides, matchAction, parseCombo,
  resetKey, serializeKeyPrefs, shippedCombo, shortcutRows, unbindKey,
  type Combo, type KeyAction, type KeyBinds, type KeyLike,
} from "../src/keys";

/** A keypress, spelled the way the app's handlers see one. */
const press = (key: string, mods: Partial<KeyLike> = {}): KeyLike =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const cmd = (key: string, mods: Partial<KeyLike> = {}) => press(key, { metaKey: true, ...mods });
const combo = (s: string): Combo => parseCombo(s)!;
/** Shortcuts switched on, with these chords — what every test below assumes unless
 *  it is the master switch itself under test. */
const on = (binds: KeyBinds) => ({ enabled: true, binds });

describe("the table itself", () => {
  it("ships a parseable, bindable chord for every action, on both platforms", () => {
    for (const d of KEY_ACTIONS) {
      for (const s of [d.combo, d.pc].filter((x): x is string => !!x)) {
        const c = parseCombo(s);
        expect(c, `${d.id} (${s})`).not.toBeNull();
        expect(bindableCombo(c), `${d.id} needs a modifier`).toBe(true);
      }
    }
  });

  it("ships no two actions on the same chord, on either platform", () => {
    for (const mac of [true, false]) {
      const binds = defaultKeyBinds(mac);
      for (const a of KEY_ACTION_IDS) {
        for (const b of KEY_ACTION_IDS) {
          if (a === b) continue;
          expect(comboClash(binds[a], binds[b]), `${a} and ${b} collide (mac: ${mac})`).toBe(false);
        }
      }
    }
  });

  // Ctrl+[ is the Escape byte to every terminal pane, so the ⌘ chord cannot simply cross over.
  it("ships back/forward on ⌘[ ⌘] on macOS and Ctrl+Alt+arrows elsewhere", () => {
    expect(formatCombo(defaultKeyBinds(true).navBack!)).toBe("mod+[");
    expect(formatCombo(defaultKeyBinds(true).navForward!)).toBe("mod+]");
    expect(formatCombo(defaultKeyBinds(false).navBack!)).toBe("mod+alt+left");
    expect(formatCombo(defaultKeyBinds(false).navForward!)).toBe("mod+alt+right");
    expect(matchAction(on(defaultKeyBinds(true)), cmd("["), true)).toBe("navBack");
    expect(matchAction(on(defaultKeyBinds(false)), press("ArrowLeft", { ctrlKey: true, altKey: true, code: "ArrowLeft" }), false)).toBe("navBack");
    // Alt+←/→ alone is a terminal's word jump and must reach the pane.
    expect(matchAction(on(defaultKeyBinds(false)), press("ArrowLeft", { altKey: true, code: "ArrowLeft" }), false)).toBeNull();
    expect(matchAction(on(defaultKeyBinds(false)), press("ArrowRight", { ctrlKey: true, altKey: true, code: "ArrowRight" }), false)).toBe("navForward");
    // An action with no `pc` ships the same chord everywhere.
    expect(shippedCombo(keyActionDef("palette"), false)).toBe("mod+k");
  });

  // The picker renders from KEY_GROUPS and nothing else, so an action added to the
  // table but not to a group would be dispatchable and invisible — bindable in theory,
  // unreachable in the one window that exists to rebind it.
  it("puts every action in exactly one settings group", () => {
    const listed = KEY_GROUPS.flatMap((g) => g.actions);
    expect([...listed].sort()).toEqual([...KEY_ACTION_IDS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps the digit pseudo-key for the switcher alone", () => {
    for (const d of KEY_ACTIONS) {
      if (d.id === "sessionSwitch") expect(d.combo).toContain(DIGIT_KEY);
      else expect(d.combo).not.toContain(DIGIT_KEY);
    }
  });

  // The one binding this release moved. It is here rather than in a comment because
  // plain ⌘⏎ is the run picker's pin, and the reveal listener standing on it again
  // would take that back without anything failing.
  it("puts the other terminal layout on the alt of the terminal chord", () => {
    expect(keyActionDef("terminal").combo).toBe("mod+t");
    expect(keyActionDef("terminalOther").combo).toBe("mod+alt+t");
    const binds = defaultKeyBinds(false);
    expect(matchAction(on(binds), cmd("t"), false)).toBe("terminal");
    expect(matchAction(on(binds), cmd("†", { altKey: true, code: "KeyT" }), false)).toBe("terminalOther");
  });

  it("reveals the folder on the shifted Enter, leaving plain mod+Enter free", () => {
    expect(keyActionDef("reveal").combo).toBe("mod+shift+enter");
    const binds = defaultKeyBinds(false);
    expect(comboMatches(binds.reveal, cmd("Enter", { shiftKey: true }), false)).toBe(true);
    expect(comboMatches(binds.reveal, cmd("Enter"), false)).toBe(false);
    expect(matchAction(on(binds), cmd("Enter"), false)).toBeNull();
  });
});

describe("parseCombo / formatCombo", () => {
  it("round-trips every default", () => {
    for (const d of KEY_ACTIONS) {
      expect(formatCombo(combo(d.combo))).toBe(d.combo);
      if (d.pc) expect(formatCombo(combo(d.pc))).toBe(d.pc);
    }
  });

  it("takes the modifiers in any order and any spelling", () => {
    const canon = "mod+alt+shift+b";
    for (const s of ["shift+alt+mod+b", "CMD+Option+Shift+B", "ctrl+alt+shift+b", " meta + opt + shift + b "]) {
      expect(formatCombo(combo(s))).toBe(canon);
    }
  });

  it("refuses junk rather than binding it", () => {
    for (const s of ["", "   ", "mod", "shift", "mod+b+c", "mod+escape", "mod+arrowup", null, 7, {}]) {
      expect(parseCombo(s as never), String(s)).toBeNull();
    }
  });

  // "mod++" is what a naive formatter writes for ⌘+, and splitting it on "+" leaves
  // two empty parts. It has to survive, because the font stepper is bound to that key.
  it("survives the plus key written literally", () => {
    expect(formatCombo(combo("mod++"))).toBe("mod+=");
    expect(formatCombo(combo("mod+_"))).toBe("mod+-");
  });

  // A hand-edited `cc-keys` can say `mod+shift+=`; a real Shift+= press arrives as "+" and
  // folds to an unshifted "=", so keeping the shift would store a chord that never fires.
  it("drops a shift the key itself cannot carry", () => {
    expect(formatCombo(combo("mod+shift+="))).toBe("mod+=");
    expect(formatCombo(combo("mod+shift+-"))).toBe("mod+-");
    expect(comboMatches(combo("mod+shift+="), cmd("+", { shiftKey: true }), false)).toBe(true);
  });
});

describe("comboOf", () => {
  it("folds both modifiers into one, because every handler always accepted both", () => {
    expect(comboOf(press("k", { metaKey: true }))).toEqual(combo("mod+k"));
    expect(comboOf(press("k", { ctrlKey: true }))).toEqual(combo("mod+k"));
  });

  it("lowercases the letter the OS shifted for us", () => {
    // A shifted letter arrives as "B", not "b" — comparing raw would make ⌘⇧B unmatchable.
    expect(comboOf(cmd("B", { shiftKey: true }))).toEqual(combo("mod+shift+b"));
  });

  // ⌘+ is Shift+= on a US layout, so the event says key "+" AND shiftKey true. Storing
  // that verbatim would never match the `mod+=` the font stepper has always used.
  it("folds a shift-produced character back onto its unshifted key", () => {
    expect(comboOf(cmd("+", { shiftKey: true }))).toEqual(combo("mod+="));
    expect(comboOf(cmd("="))).toEqual(combo("mod+="));
    expect(comboOf(cmd("_", { shiftKey: true }))).toEqual(combo("mod+-"));
  });

  it("says 'not yet' to a bare modifier, so a recorder keeps waiting", () => {
    for (const k of ["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Dead"]) {
      expect(comboOf(press(k, { metaKey: true })), k).toBeNull();
    }
  });

  it("refuses the named keys this layer will not bind", () => {
    for (const k of ["Escape", "Tab", "ArrowUp", "ArrowDown", "F5", "Backspace"]) {
      expect(comboOf(cmd(k)), k).toBeNull();
    }
    expect(comboOf(cmd("Enter"))).toEqual(combo("mod+enter"));
  });

  // Alt+arrows are the browser's back/forward. Under alt the physical-key path must not eat them.
  it("binds left and right, alt included", () => {
    expect(comboOf(press("ArrowLeft", { altKey: true, code: "ArrowLeft" }))).toEqual(combo("alt+left"));
    expect(comboOf(cmd("ArrowRight"))).toEqual(combo("mod+right"));
    expect(parseCombo("alt+arrowleft")).toBeNull();
  });

  // A Mac reports the option-layer character with ⌥ held: ⌘⌥T arrives as key "†" and ⌘⌥E as
  // "Dead". Both recorded and matched nothing until the physical key was read instead.
  it("reads the physical key under alt, where the reported character is the option layer's", () => {
    expect(comboOf(cmd("†", { altKey: true, code: "KeyT" }))).toEqual(combo("mod+alt+t"));
    expect(comboOf(cmd("Dead", { altKey: true, code: "KeyE" }))).toEqual(combo("mod+alt+e"));
    expect(comboOf(cmd("#", { altKey: true, code: "Digit3" }))).toEqual(combo("mod+alt+3"));
    expect(comboOf(cmd("Ø", { altKey: true, shiftKey: true, code: "KeyO" }))).toEqual(combo("mod+alt+shift+o"));
  });

  it("ignores the physical key without alt, so ⌘B stays the B key on every layout", () => {
    // A QWERTZ Z sits on the KeyY position; `key` is the letter the layout means.
    expect(comboOf(cmd("z", { code: "KeyY" }))).toEqual(combo("mod+z"));
    expect(comboOf(press("Alt", { altKey: true, code: "AltLeft" }))).toBeNull();
  });

  it("only collapses a digit to the pseudo-key when asked", () => {
    expect(comboOf(cmd("3"))).toEqual(combo("mod+3"));
    expect(comboOf(cmd("3"), { digits: true })).toEqual(combo("mod+digit"));
    // 0 is the font reset, not a session — it must survive the collapse.
    expect(comboOf(cmd("0"), { digits: true })).toEqual(combo("mod+0"));
  });
});

describe("matching is exact", () => {
  const binds = defaultKeyBinds(false);

  // The whole reason this module exists. The old if-chain tested `meta && key === "b"`
  // without `!e.shiftKey`, so ⌘⇧B only reached the build task because its branch sat
  // above ⌘B's — a shifted binding written below its unshifted twin silently never
  // fired, and the handler carried a comment warning about it.
  it("does not let an unshifted binding swallow its shifted twin", () => {
    expect(matchAction(on(binds), cmd("b"), false)).toBe("sidebar");
    expect(matchAction(on(binds), cmd("B", { shiftKey: true }), false)).toBe("buildTask");
    expect(matchAction(on(binds), cmd("t"), false)).toBe("terminal");
    expect(matchAction(on(binds), cmd("T", { shiftKey: true }), false)).toBe("testTask");
  });

  it("is order-independent — reversing the table changes nothing", () => {
    const reversed = {} as KeyBinds;
    for (const id of [...KEY_ACTION_IDS].reverse()) reversed[id] = binds[id];
    for (const ev of [cmd("b"), cmd("B", { shiftKey: true }), cmd("k"), cmd(",")]) {
      expect(matchAction(on(reversed), ev, false)).toBe(matchAction(on(binds), ev, false));
    }
  });

  it("ignores a chord with no modifier at all", () => {
    expect(matchAction(on(binds), press("b"), false)).toBeNull();
    expect(matchAction(on(binds), press("k"), false)).toBeNull();
  });

  it("does not fire an unbound action", () => {
    expect(matchAction(on(unbindKey(binds, "sidebar")), cmd("b"), false)).toBeNull();
  });

  it("routes every digit to the switcher, and says which one", () => {
    for (let n = 1; n <= 9; n++) {
      expect(matchAction(on(binds), cmd(String(n)), false)).toBe("sessionSwitch");
      expect(digitOf(cmd(String(n)))).toBe(n);
    }
    expect(matchAction(on(binds), cmd("0"), false)).toBe("fontReset");
    expect(digitOf(cmd("0"))).toBe(0);
    expect(digitOf(cmd("k"))).toBe(0);
  });

  // An explicit chord must beat the range one, or binding ⌘3 to anything would be
  // shadowed by the switcher and look like the binding simply didn't take.
  it("lets a literal digit binding win over the switcher's range", () => {
    const { binds: next } = bindKey(binds, "settings", combo("mod+3"));
    expect(matchAction(on(next), cmd("3"), false)).toBe("settings");
    expect(matchAction(on(next), cmd("4"), false)).toBe("sessionSwitch");
  });

  it("distinguishes alt from no alt", () => {
    expect(matchAction(on(binds), cmd("k", { altKey: true }), false)).toBeNull();
    const { binds: next } = bindKey(binds, "palette", combo("mod+alt+k"));
    expect(matchAction(on(next), cmd("k", { altKey: true }), false)).toBe("palette");
    expect(matchAction(on(next), cmd("k"), false)).toBeNull();
  });
});

describe("comboClash", () => {
  it("is plain equality for ordinary keys", () => {
    expect(comboClash(combo("mod+b"), combo("mod+b"))).toBe(true);
    expect(comboClash(combo("mod+b"), combo("mod+shift+b"))).toBe(false);
    expect(comboClash(combo("mod+b"), combo("mod+alt+b"))).toBe(false);
    expect(comboClash(combo("mod+b"), null)).toBe(false);
  });

  // Deliberately NOT a clash — see the comboClash comment. The literal wins for its
  // own digit and the range keeps the rest, which is `matchAction`'s two passes.
  it("does not treat one digit as colliding with the switcher's range", () => {
    for (let n = 1; n <= 9; n++) expect(comboClash(combo("mod+digit"), combo(`mod+${n}`))).toBe(false);
    expect(comboClash(combo("mod+digit"), combo("mod+digit"))).toBe(true);
  });
});

describe("bindKey takes the chord rather than refusing it", () => {
  it("leaves the loser unbound and names it", () => {
    const { binds, took } = bindKey(defaultKeyBinds(false), "sidebar", combo("mod+i"));
    expect(took).toEqual(["inspector"]);
    expect(binds.inspector).toBeNull();
    expect(matchAction(on(binds), cmd("i"), false)).toBe("sidebar");
  });

  // Taking ONE digit must not cost the other eight: that was the obvious rule and it
  // is the wrong one — you would lose the whole switcher to carve out a single key.
  it("carves a single digit out of the switcher instead of taking the range", () => {
    const { binds, took } = bindKey(defaultKeyBinds(false), "palette", combo("mod+4"));
    expect(took).toEqual([]);
    expect(binds.sessionSwitch).toEqual(combo("mod+digit"));
    expect(matchAction(on(binds), cmd("4"), false)).toBe("palette");
    expect(matchAction(on(binds), cmd("5"), false)).toBe("sessionSwitch");
  });

  it("still takes the range when the range itself is claimed", () => {
    const { binds, took } = bindKey(defaultKeyBinds(false), "palette", combo("mod+digit"));
    expect(took).toEqual(["sessionSwitch"]);
    expect(binds.sessionSwitch).toBeNull();
  });

  it("rebinding an action to its own chord displaces nobody", () => {
    const { took } = bindKey(defaultKeyBinds(false), "sidebar", combo("mod+b"));
    expect(took).toEqual([]);
  });

  it("resetKey takes the default back from whoever holds it", () => {
    const { binds } = bindKey(defaultKeyBinds(false), "sidebar", combo("mod+i"));
    const back = resetKey(binds, "inspector", false);
    expect(back.inspector).toEqual(combo("mod+i"));
    expect(back.sidebar).toBeNull(); // it had the chord; now it doesn't
  });
});

// The other half of "off", and a different question from the master switch: this one
// is per row, and it is what `unbindKey` / the picker's ⊘ do.
describe("turning a single shortcut off", () => {
  const oneOff = on(unbindKey(defaultKeyBinds(false), "sidebar"));

  it("stops that one firing and leaves every other alone", () => {
    expect(matchAction(oneOff, cmd("b"), false)).toBeNull();
    expect(matchAction(oneOff, cmd("k"), false)).toBe("palette");
    expect(matchAction(oneOff, cmd("B", { shiftKey: true }), false)).toBe("buildTask");
    expect(matchAction(oneOff, cmd("3"), false)).toBe("sessionSwitch");
  });

  it("stops advertising that one, and only that one", () => {
    expect(activeBind(oneOff, "sidebar")).toBeNull();
    expect(activeBind(oneOff, "palette")).toEqual(combo("mod+k"));
    const labels = shortcutRows(oneOff, true).map((r) => r.label);
    expect(labels).not.toContain(keyActionDef("sidebar").label);
    expect(labels).toContain(keyActionDef("palette").label);
  });

  it("is a change to that row, so its own ⟲ lights up and Reset all does too", () => {
    expect(isDefaultBind(oneOff.binds, "sidebar", false)).toBe(false);
    expect(isDefaultBind(oneOff.binds, "palette", false)).toBe(true);
    expect(isDefaultKeyPrefs(oneOff, false)).toBe(false);
  });

  it("comes back on its own without disturbing the rest", () => {
    const back = on(resetKey(oneOff.binds, "sidebar", false));
    expect(matchAction(back, cmd("b"), false)).toBe("sidebar");
    expect(isDefaultKeyPrefs(back, false)).toBe(true);
  });

  // Every row off is NOT the same state as the master switch off — the switch is
  // remembered separately, so flipping it back must not resurrect rows the user
  // turned off one at a time.
  it("stays off row-by-row across a master-switch round trip", () => {
    const p = { enabled: false, binds: unbindKey(defaultKeyBinds(false), "sidebar") };
    const restored = clampKeyPrefs(serializeKeyPrefs(p, false), false);
    expect(restored.enabled).toBe(false);
    expect(matchAction({ ...restored, enabled: true }, cmd("b"), false)).toBeNull();
    expect(matchAction({ ...restored, enabled: true }, cmd("k"), false)).toBe("palette");
  });
});

describe("the master switch", () => {
  const off = { enabled: false, binds: defaultKeyBinds(false) };

  it("stops every shortcut firing, including the digits", () => {
    for (const ev of [cmd("k"), cmd("b"), cmd("B", { shiftKey: true }), cmd(","), cmd("3"), cmd("0")]) {
      expect(matchAction(off, ev, false), ev.key).toBeNull();
    }
  });

  // The bug this shape prevents: reading `binds` at a display site would leave the
  // footer sheet, the palette hints and the sidebar's tooltips advertising chords the
  // app has stopped answering. `activeBind` is the only door, so they cannot diverge.
  it("makes every chord read as unbound, so nothing advertises one", () => {
    for (const id of KEY_ACTION_IDS) expect(activeBind(off, id), id).toBeNull();
    expect(shortcutRows(off, true)).toEqual([]);
    expect(comboKeys(activeBind(off, "palette"), true)).toEqual([]);
    expect(comboText(activeBind(off, "sidebar"), true)).toBe("");
  });

  it("keeps the chords rather than clearing them", () => {
    const p = { enabled: false, binds: bindKey(defaultKeyBinds(false), "palette", combo("mod+alt+p")).binds };
    expect(p.binds.palette).toEqual(combo("mod+alt+p"));
    // Switching back on restores exactly what was set, with nothing to redo.
    const back = { ...p, enabled: true };
    expect(matchAction(back, cmd("p", { altKey: true }), false)).toBe("palette");
    expect(matchAction(back, cmd("b"), false)).toBe("sidebar");
  });

  it("survives a round trip through storage", () => {
    const p = { enabled: false, binds: unbindKey(defaultKeyBinds(false), "history") };
    const stored = serializeKeyPrefs(p, false);
    expect(stored).toEqual({ enabled: false, binds: { history: "" } });
    expect(clampKeyPrefs(stored, false)).toEqual(p);
  });

  it("counts as a change worth persisting even with every chord standard", () => {
    expect(isDefaultKeyPrefs(defaultKeyPrefs(false), false)).toBe(true);
    expect(isDefaultKeyPrefs(off, false)).toBe(false);
  });
});

describe("clampKeyPrefs", () => {
  it("comes up switched ON from anything that does not explicitly say otherwise", () => {
    for (const raw of [null, undefined, {}, [], "nonsense", 42, { enabled: "no" }, { enabled: 1 }]) {
      expect(clampKeyPrefs(raw, false).enabled, String(raw)).toBe(true);
    }
    expect(clampKeyPrefs({ enabled: false }, false).enabled).toBe(false);
  });

  // A dead keyboard with no visible cause is the worst failure this feature has, so
  // only the exact value the app writes may produce it.
  it("never leaves a corrupt blob with the shortcuts switched off", () => {
    expect(clampKeyPrefs({ enabled: null }, false).enabled).toBe(true);
    expect(clampKeyPrefs({ enabled: "false" }, false).enabled).toBe(true);
    expect(clampKeyPrefs({ binds: "junk" }, false)).toEqual(defaultKeyPrefs(false));
  });

  // The shape this feature briefly used before the switch existed: the overrides map
  // WAS the whole stored value.
  it("reads a bare overrides map as the chords, switched on", () => {
    const flat = clampKeyPrefs({ palette: "mod+alt+p" }, false);
    expect(flat.enabled).toBe(true);
    expect(flat.binds.palette).toEqual(combo("mod+alt+p"));
  });

  it("prefers the nested chords once the blob has a shape", () => {
    const p = clampKeyPrefs({ enabled: true, binds: { palette: "mod+alt+p" } }, false);
    expect(p.binds.palette).toEqual(combo("mod+alt+p"));
    // `enabled` present but no `binds`: the rest of the object is not a chord map.
    expect(clampKeyPrefs({ enabled: false }, false)).toEqual({ enabled: false, binds: defaultKeyBinds(false) });
  });
});

describe("what gets persisted", () => {
  it("writes nothing while everything is standard", () => {
    expect(keyOverrides(defaultKeyBinds(false), false)).toEqual({});
    expect(isDefaultKeyBinds(defaultKeyBinds(false), false)).toBe(true);
  });

  // This is what lets a shipped default be improved later: an install that never
  // touched that row has no entry for it and picks the new one up.
  it("writes only the rows that differ", () => {
    const { binds } = bindKey(defaultKeyBinds(false), "palette", combo("mod+alt+p"));
    expect(keyOverrides(binds, false)).toEqual({ palette: "mod+alt+p" });
    expect(isDefaultBind(binds, "palette", false)).toBe(false);
    expect(isDefaultBind(binds, "sidebar", false)).toBe(true);
  });

  it("spells a cleared row as an empty string, so it survives a reload", () => {
    const binds = unbindKey(defaultKeyBinds(false), "sidebar");
    expect(keyOverrides(binds, false)).toEqual({ sidebar: "" });
    expect(clampKeyBinds(keyOverrides(binds, false), false).sidebar).toBeNull();
  });

  it("round-trips a full set of changes", () => {
    let binds = bindKey(defaultKeyBinds(false), "sidebar", combo("mod+alt+s")).binds;
    binds = unbindKey(binds, "history");
    binds = bindKey(binds, "palette", combo("mod+i")).binds; // takes it from inspector
    expect(clampKeyBinds(keyOverrides(binds, false), false)).toEqual(binds);
  });
});

describe("clampKeyBinds", () => {
  it("gives a working set back from anything, rather than throwing", () => {
    for (const raw of [null, undefined, {}, [], "nonsense", 42]) {
      expect(clampKeyBinds(raw, false), String(raw)).toEqual(defaultKeyBinds(false));
    }
  });

  it("ignores an action it has never heard of", () => {
    expect(clampKeyBinds({ teleport: "mod+z" }, false)).toEqual(defaultKeyBinds(false));
  });

  it("falls back to the default when a stored chord is corrupt", () => {
    expect(clampKeyBinds({ palette: "!!!" }, false).palette).toEqual(combo("mod+k"));
    expect(clampKeyBinds({ palette: "k" }, false).palette).toEqual(combo("mod+k")); // no modifier
  });

  it("refuses the digit range for anything but the switcher", () => {
    expect(clampKeyBinds({ palette: "mod+digit" }, false).palette).toEqual(combo("mod+k"));
    expect(clampKeyBinds({ sessionSwitch: "mod+alt+digit" }, false).sessionSwitch).toEqual(combo("mod+alt+digit"));
  });

  // A hand-edited cc-keys is the realistic corruption. Two actions on one chord would
  // fire whichever the table reached first, which is exactly the silent ambiguity the
  // exact matcher was written to remove.
  it("never lets two actions share a chord, whatever the file says", () => {
    const binds = clampKeyBinds({ palette: "mod+b" }, false);
    expect(binds.palette).toEqual(combo("mod+b"));
    expect(binds.sidebar).toBeNull(); // only its default wanted mod+b, so it loses
    for (const a of KEY_ACTION_IDS) {
      for (const b of KEY_ACTION_IDS) {
        if (a !== b) expect(comboClash(binds[a], binds[b]), `${a}/${b}`).toBe(false);
      }
    }
  });

  // Order in the table must not decide it: palette sits above sidebar.
  it("settles a chord the user stored before any shipped default", () => {
    const binds = clampKeyBinds({ sidebar: "mod+k" }, false);
    expect(binds.sidebar).toEqual(combo("mod+k"));
    expect(binds.palette).toBeNull();
  });

  // ⌘[ / ⌘] were free and bindable before back/forward shipped on them; an upgrade must not
  // silently switch off what a Mac user had put there.
  it("keeps a Mac user's own ⌘[ ⌘] when a release ships a default on them", () => {
    const binds = clampKeyBinds({ fontDown: "mod+[", fontUp: "mod+]" }, true);
    expect(binds.fontDown).toEqual(combo("mod+["));
    expect(binds.fontUp).toEqual(combo("mod+]"));
    expect(binds.navBack).toBeNull();
    expect(binds.navForward).toBeNull();
  });
});

describe("the stored value, per platform", () => {
  const ship = (mac: boolean) => (mac ? { back: "mod+[", fwd: "mod+]" } : { back: "mod+alt+left", fwd: "mod+alt+right" });
  for (const mac of [true, false]) {
    it(`clamps, stores and resets against the ${mac ? "Mac" : "PC"} defaults`, () => {
      const dflt = defaultKeyBinds(mac);
      expect(clampKeyBinds({}, mac)).toEqual(dflt);
      expect(formatCombo(clampKeyBinds({ navBack: "!!!" }, mac).navBack!)).toBe(ship(mac).back);
      expect(keyOverrides(dflt, mac)).toEqual({});
      expect(isDefaultKeyPrefs(defaultKeyPrefs(mac), mac)).toBe(true);
      const moved = bindKey(dflt, "navBack", combo("mod+alt+b")).binds;
      expect(keyOverrides(moved, mac)).toEqual({ navBack: "mod+alt+b" });
      expect(isDefaultBind(moved, "navBack", mac)).toBe(false);
      const back = resetKey(moved, "navBack", mac);
      expect(formatCombo(back.navBack!)).toBe(ship(mac).back);
      expect(formatCombo(back.navForward!)).toBe(ship(mac).fwd);
      expect(isDefaultKeyBinds(back, mac)).toBe(true);
      expect(clampKeyPrefs(serializeKeyPrefs(on(moved), mac), mac)).toEqual(on(moved));
    });
  }
});

describe("brackets on a Mac", () => {
  const mac = on(defaultKeyBinds(true));
  // Ctrl+[ is ESC and Ctrl+] is ^] to a terminal pane; only ⌘ may navigate.
  it("leaves Ctrl+[ and Ctrl+] to the terminal", () => {
    expect(matchAction(mac, press("[", { ctrlKey: true, code: "BracketLeft" }), true)).toBeNull();
    expect(matchAction(mac, press("]", { ctrlKey: true, code: "BracketRight" }), true)).toBeNull();
    expect(matchAction(mac, cmd("[", { code: "BracketLeft" }), true)).toBe("navBack");
    expect(matchAction(mac, cmd("]", { code: "BracketRight" }), true)).toBe("navForward");
    expect(bindableCombo(comboOf(press("[", { ctrlKey: true }), { mac: true }))).toBe(false);
  });

  // German, French, Nordic: [ is ⌥5 and ] is ⌥6, so the ⌥ belongs to the character.
  it("matches ⌘[ typed with ⌥ on a layout that needs it", () => {
    expect(matchAction(mac, cmd("[", { altKey: true, code: "Digit5" }), true)).toBe("navBack");
    expect(matchAction(mac, cmd("]", { altKey: true, code: "Digit6" }), true)).toBe("navForward");
    expect(comboOf(cmd("[", { altKey: true, code: "Digit5" }), { mac: true })).toEqual(combo("mod+["));
    // On a layout with a bracket key of its own, ⌥ is still a modifier.
    expect(matchAction(mac, cmd("[", { altKey: true, code: "BracketLeft" }), true)).toBeNull();
  });

  it("changes nothing off macOS", () => {
    expect(comboOf(press("[", { ctrlKey: true }))).toEqual(combo("mod+["));
    expect(comboOf(cmd("[", { altKey: true, code: "Digit5" }))).toEqual(combo("mod+alt+5"));
  });
});

describe("chords on screen", () => {
  it("spells the modifiers per platform and the key once", () => {
    expect(comboKeys(combo("mod+shift+b"), true)).toEqual(["⌘", "⇧", "B"]);
    expect(comboKeys(combo("mod+shift+b"), false)).toEqual(["Ctrl", "Shift", "B"]);
    expect(comboKeys(combo("mod+alt+k"), true)).toEqual(["⌘", "⌥", "K"]);
    expect(comboKeys(combo("mod+alt+k"), false)).toEqual(["Ctrl", "Alt", "K"]);
    expect(comboKeys(null, true)).toEqual([]);
  });

  it("names the keys nobody would recognise from their stored form", () => {
    expect(comboKeys(combo("mod+enter"), true)).toEqual(["⌘", "⏎"]);
    expect(comboKeys(combo("mod+digit"), true)).toEqual(["⌘", "1–9"]);
    expect(comboKeys(combo("mod+="), true)).toEqual(["⌘", "+"]);
    expect(comboKeys(combo("mod+-"), true)).toEqual(["⌘", "−"]);
    expect(comboKeys(combo("alt+left"), false)).toEqual(["Alt", "←"]);
    expect(comboText(combo("alt+right"), false)).toBe("Alt+→");
  });

  it("joins for a toast the way each platform writes a chord", () => {
    expect(comboText(combo("mod+shift+h"), true)).toBe("⌘⇧H");
    expect(comboText(combo("mod+shift+h"), false)).toBe("Ctrl+Shift+H");
    expect(comboText(null, true)).toBe("");
  });
});

describe("shortcutRows", () => {
  const rows = (b: KeyBinds) => shortcutRows(on(b), true);

  it("collapses the three font actions into one row of alternatives", () => {
    const font = rows(defaultKeyBinds(false)).find((r) => r.label === "Terminal font size");
    expect(font?.chords).toEqual([["⌘", "+"], ["⌘", "−"], ["⌘", "0"]]);
  });

  // A cheat sheet listing a shortcut that no longer fires is worse than no cheat sheet.
  it("drops an action the user cleared", () => {
    const binds = unbindKey(defaultKeyBinds(false), "sidebar");
    expect(rows(binds).some((r) => r.label === keyActionDef("sidebar").label)).toBe(false);
    expect(rows(defaultKeyBinds(false)).some((r) => r.label === keyActionDef("sidebar").label)).toBe(true);
  });

  it("follows a rebind instead of advertising the default", () => {
    const { binds } = bindKey(defaultKeyBinds(false), "palette", combo("mod+alt+p"));
    const row = rows(binds).find((r) => r.label === keyActionDef("palette").label);
    expect(row?.chords).toEqual([["⌘", "⌥", "P"]]);
  });

  it("lists one row per bound action, bar the merged groups", () => {
    const ids = KEY_ACTION_IDS.filter((id: KeyAction) => !keyActionDef(id).rowLabel);
    const merged = new Set(KEY_ACTIONS.map((d) => d.rowLabel).filter(Boolean)).size;
    expect(rows(defaultKeyBinds(false)).length).toBe(ids.length + merged);
  });
});
