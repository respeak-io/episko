import { describe, expect, it } from "vitest";
import {
  bindableCombo, bindKey, clampKeyBinds, comboClash, comboKeys, comboMatches, comboOf,
  comboText, activeBind, clampKeyPrefs, defaultKeyBinds, defaultKeyPrefs, DIGIT_KEY,
  digitOf, formatCombo, isDefaultBind, isDefaultKeyBinds, isDefaultKeyPrefs, KEY_ACTIONS,
  KEY_ACTION_IDS, KEY_GROUPS, keyActionDef, keyOverrides, matchAction, parseCombo,
  resetKey, serializeKeyPrefs, shortcutRows, unbindKey,
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
  it("ships a parseable, bindable chord for every action", () => {
    for (const d of KEY_ACTIONS) {
      const c = parseCombo(d.combo);
      expect(c, `${d.id} (${d.combo})`).not.toBeNull();
      expect(bindableCombo(c), `${d.id} needs a modifier`).toBe(true);
    }
  });

  it("ships no two actions on the same chord", () => {
    const binds = defaultKeyBinds();
    for (const a of KEY_ACTION_IDS) {
      for (const b of KEY_ACTION_IDS) {
        if (a === b) continue;
        expect(comboClash(binds[a], binds[b]), `${a} and ${b} collide`).toBe(false);
      }
    }
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
  it("reveals the folder on the shifted Enter, leaving plain mod+Enter free", () => {
    expect(keyActionDef("reveal").combo).toBe("mod+shift+enter");
    const binds = defaultKeyBinds();
    expect(comboMatches(binds.reveal, cmd("Enter", { shiftKey: true }))).toBe(true);
    expect(comboMatches(binds.reveal, cmd("Enter"))).toBe(false);
    expect(matchAction(on(binds), cmd("Enter"))).toBeNull();
  });
});

describe("parseCombo / formatCombo", () => {
  it("round-trips every default", () => {
    for (const d of KEY_ACTIONS) expect(formatCombo(combo(d.combo))).toBe(d.combo);
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
    expect(comboMatches(combo("mod+shift+="), cmd("+", { shiftKey: true }))).toBe(true);
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
    for (const k of ["Escape", "Tab", "ArrowUp", "F5", "Backspace"]) {
      expect(comboOf(cmd(k)), k).toBeNull();
    }
    expect(comboOf(cmd("Enter"))).toEqual(combo("mod+enter"));
  });

  it("only collapses a digit to the pseudo-key when asked", () => {
    expect(comboOf(cmd("3"))).toEqual(combo("mod+3"));
    expect(comboOf(cmd("3"), { digits: true })).toEqual(combo("mod+digit"));
    // 0 is the font reset, not a session — it must survive the collapse.
    expect(comboOf(cmd("0"), { digits: true })).toEqual(combo("mod+0"));
  });
});

describe("matching is exact", () => {
  const binds = defaultKeyBinds();

  // The whole reason this module exists. The old if-chain tested `meta && key === "b"`
  // without `!e.shiftKey`, so ⌘⇧B only reached the build task because its branch sat
  // above ⌘B's — a shifted binding written below its unshifted twin silently never
  // fired, and the handler carried a comment warning about it.
  it("does not let an unshifted binding swallow its shifted twin", () => {
    expect(matchAction(on(binds), cmd("b"))).toBe("sidebar");
    expect(matchAction(on(binds), cmd("B", { shiftKey: true }))).toBe("buildTask");
    expect(matchAction(on(binds), cmd("t"))).toBe("terminal");
    expect(matchAction(on(binds), cmd("T", { shiftKey: true }))).toBe("testTask");
  });

  it("is order-independent — reversing the table changes nothing", () => {
    const reversed = {} as KeyBinds;
    for (const id of [...KEY_ACTION_IDS].reverse()) reversed[id] = binds[id];
    for (const ev of [cmd("b"), cmd("B", { shiftKey: true }), cmd("k"), cmd(",")]) {
      expect(matchAction(on(reversed), ev)).toBe(matchAction(on(binds), ev));
    }
  });

  it("ignores a chord with no modifier at all", () => {
    expect(matchAction(on(binds), press("b"))).toBeNull();
    expect(matchAction(on(binds), press("k"))).toBeNull();
  });

  it("does not fire an unbound action", () => {
    expect(matchAction(on(unbindKey(binds, "sidebar")), cmd("b"))).toBeNull();
  });

  it("routes every digit to the switcher, and says which one", () => {
    for (let n = 1; n <= 9; n++) {
      expect(matchAction(on(binds), cmd(String(n)))).toBe("sessionSwitch");
      expect(digitOf(cmd(String(n)))).toBe(n);
    }
    expect(matchAction(on(binds), cmd("0"))).toBe("fontReset");
    expect(digitOf(cmd("0"))).toBe(0);
    expect(digitOf(cmd("k"))).toBe(0);
  });

  // An explicit chord must beat the range one, or binding ⌘3 to anything would be
  // shadowed by the switcher and look like the binding simply didn't take.
  it("lets a literal digit binding win over the switcher's range", () => {
    const { binds: next } = bindKey(binds, "settings", combo("mod+3"));
    expect(matchAction(on(next), cmd("3"))).toBe("settings");
    expect(matchAction(on(next), cmd("4"))).toBe("sessionSwitch");
  });

  it("distinguishes alt from no alt", () => {
    expect(matchAction(on(binds), cmd("k", { altKey: true }))).toBeNull();
    const { binds: next } = bindKey(binds, "palette", combo("mod+alt+k"));
    expect(matchAction(on(next), cmd("k", { altKey: true }))).toBe("palette");
    expect(matchAction(on(next), cmd("k"))).toBeNull();
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
    const { binds, took } = bindKey(defaultKeyBinds(), "sidebar", combo("mod+i"));
    expect(took).toEqual(["inspector"]);
    expect(binds.inspector).toBeNull();
    expect(matchAction(on(binds), cmd("i"))).toBe("sidebar");
  });

  // Taking ONE digit must not cost the other eight: that was the obvious rule and it
  // is the wrong one — you would lose the whole switcher to carve out a single key.
  it("carves a single digit out of the switcher instead of taking the range", () => {
    const { binds, took } = bindKey(defaultKeyBinds(), "palette", combo("mod+4"));
    expect(took).toEqual([]);
    expect(binds.sessionSwitch).toEqual(combo("mod+digit"));
    expect(matchAction(on(binds), cmd("4"))).toBe("palette");
    expect(matchAction(on(binds), cmd("5"))).toBe("sessionSwitch");
  });

  it("still takes the range when the range itself is claimed", () => {
    const { binds, took } = bindKey(defaultKeyBinds(), "palette", combo("mod+digit"));
    expect(took).toEqual(["sessionSwitch"]);
    expect(binds.sessionSwitch).toBeNull();
  });

  it("rebinding an action to its own chord displaces nobody", () => {
    const { took } = bindKey(defaultKeyBinds(), "sidebar", combo("mod+b"));
    expect(took).toEqual([]);
  });

  it("resetKey takes the default back from whoever holds it", () => {
    const { binds } = bindKey(defaultKeyBinds(), "sidebar", combo("mod+i"));
    const back = resetKey(binds, "inspector");
    expect(back.inspector).toEqual(combo("mod+i"));
    expect(back.sidebar).toBeNull(); // it had the chord; now it doesn't
  });
});

// The other half of "off", and a different question from the master switch: this one
// is per row, and it is what `unbindKey` / the picker's ⊘ do.
describe("turning a single shortcut off", () => {
  const oneOff = on(unbindKey(defaultKeyBinds(), "sidebar"));

  it("stops that one firing and leaves every other alone", () => {
    expect(matchAction(oneOff, cmd("b"))).toBeNull();
    expect(matchAction(oneOff, cmd("k"))).toBe("palette");
    expect(matchAction(oneOff, cmd("B", { shiftKey: true }))).toBe("buildTask");
    expect(matchAction(oneOff, cmd("3"))).toBe("sessionSwitch");
  });

  it("stops advertising that one, and only that one", () => {
    expect(activeBind(oneOff, "sidebar")).toBeNull();
    expect(activeBind(oneOff, "palette")).toEqual(combo("mod+k"));
    const labels = shortcutRows(oneOff, true).map((r) => r.label);
    expect(labels).not.toContain(keyActionDef("sidebar").label);
    expect(labels).toContain(keyActionDef("palette").label);
  });

  it("is a change to that row, so its own ⟲ lights up and Reset all does too", () => {
    expect(isDefaultBind(oneOff.binds, "sidebar")).toBe(false);
    expect(isDefaultBind(oneOff.binds, "palette")).toBe(true);
    expect(isDefaultKeyPrefs(oneOff)).toBe(false);
  });

  it("comes back on its own without disturbing the rest", () => {
    const back = on(resetKey(oneOff.binds, "sidebar"));
    expect(matchAction(back, cmd("b"))).toBe("sidebar");
    expect(isDefaultKeyPrefs(back)).toBe(true);
  });

  // Every row off is NOT the same state as the master switch off — the switch is
  // remembered separately, so flipping it back must not resurrect rows the user
  // turned off one at a time.
  it("stays off row-by-row across a master-switch round trip", () => {
    const p = { enabled: false, binds: unbindKey(defaultKeyBinds(), "sidebar") };
    const restored = clampKeyPrefs(serializeKeyPrefs(p));
    expect(restored.enabled).toBe(false);
    expect(matchAction({ ...restored, enabled: true }, cmd("b"))).toBeNull();
    expect(matchAction({ ...restored, enabled: true }, cmd("k"))).toBe("palette");
  });
});

describe("the master switch", () => {
  const off = { enabled: false, binds: defaultKeyBinds() };

  it("stops every shortcut firing, including the digits", () => {
    for (const ev of [cmd("k"), cmd("b"), cmd("B", { shiftKey: true }), cmd(","), cmd("3"), cmd("0")]) {
      expect(matchAction(off, ev), ev.key).toBeNull();
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
    const p = { enabled: false, binds: bindKey(defaultKeyBinds(), "palette", combo("mod+alt+p")).binds };
    expect(p.binds.palette).toEqual(combo("mod+alt+p"));
    // Switching back on restores exactly what was set, with nothing to redo.
    const back = { ...p, enabled: true };
    expect(matchAction(back, cmd("p", { altKey: true }))).toBe("palette");
    expect(matchAction(back, cmd("b"))).toBe("sidebar");
  });

  it("survives a round trip through storage", () => {
    const p = { enabled: false, binds: unbindKey(defaultKeyBinds(), "history") };
    const stored = serializeKeyPrefs(p);
    expect(stored).toEqual({ enabled: false, binds: { history: "" } });
    expect(clampKeyPrefs(stored)).toEqual(p);
  });

  it("counts as a change worth persisting even with every chord standard", () => {
    expect(isDefaultKeyPrefs(defaultKeyPrefs())).toBe(true);
    expect(isDefaultKeyPrefs(off)).toBe(false);
  });
});

describe("clampKeyPrefs", () => {
  it("comes up switched ON from anything that does not explicitly say otherwise", () => {
    for (const raw of [null, undefined, {}, [], "nonsense", 42, { enabled: "no" }, { enabled: 1 }]) {
      expect(clampKeyPrefs(raw).enabled, String(raw)).toBe(true);
    }
    expect(clampKeyPrefs({ enabled: false }).enabled).toBe(false);
  });

  // A dead keyboard with no visible cause is the worst failure this feature has, so
  // only the exact value the app writes may produce it.
  it("never leaves a corrupt blob with the shortcuts switched off", () => {
    expect(clampKeyPrefs({ enabled: null }).enabled).toBe(true);
    expect(clampKeyPrefs({ enabled: "false" }).enabled).toBe(true);
    expect(clampKeyPrefs({ binds: "junk" })).toEqual(defaultKeyPrefs());
  });

  // The shape this feature briefly used before the switch existed: the overrides map
  // WAS the whole stored value.
  it("reads a bare overrides map as the chords, switched on", () => {
    const flat = clampKeyPrefs({ palette: "mod+alt+p" });
    expect(flat.enabled).toBe(true);
    expect(flat.binds.palette).toEqual(combo("mod+alt+p"));
  });

  it("prefers the nested chords once the blob has a shape", () => {
    const p = clampKeyPrefs({ enabled: true, binds: { palette: "mod+alt+p" } });
    expect(p.binds.palette).toEqual(combo("mod+alt+p"));
    // `enabled` present but no `binds`: the rest of the object is not a chord map.
    expect(clampKeyPrefs({ enabled: false })).toEqual({ enabled: false, binds: defaultKeyBinds() });
  });
});

describe("what gets persisted", () => {
  it("writes nothing while everything is standard", () => {
    expect(keyOverrides(defaultKeyBinds())).toEqual({});
    expect(isDefaultKeyBinds(defaultKeyBinds())).toBe(true);
  });

  // This is what lets a shipped default be improved later: an install that never
  // touched that row has no entry for it and picks the new one up.
  it("writes only the rows that differ", () => {
    const { binds } = bindKey(defaultKeyBinds(), "palette", combo("mod+alt+p"));
    expect(keyOverrides(binds)).toEqual({ palette: "mod+alt+p" });
    expect(isDefaultBind(binds, "palette")).toBe(false);
    expect(isDefaultBind(binds, "sidebar")).toBe(true);
  });

  it("spells a cleared row as an empty string, so it survives a reload", () => {
    const binds = unbindKey(defaultKeyBinds(), "sidebar");
    expect(keyOverrides(binds)).toEqual({ sidebar: "" });
    expect(clampKeyBinds(keyOverrides(binds)).sidebar).toBeNull();
  });

  it("round-trips a full set of changes", () => {
    let binds = bindKey(defaultKeyBinds(), "sidebar", combo("mod+alt+s")).binds;
    binds = unbindKey(binds, "history");
    binds = bindKey(binds, "palette", combo("mod+i")).binds; // takes it from inspector
    expect(clampKeyBinds(keyOverrides(binds))).toEqual(binds);
  });
});

describe("clampKeyBinds", () => {
  it("gives a working set back from anything, rather than throwing", () => {
    for (const raw of [null, undefined, {}, [], "nonsense", 42]) {
      expect(clampKeyBinds(raw), String(raw)).toEqual(defaultKeyBinds());
    }
  });

  it("ignores an action it has never heard of", () => {
    expect(clampKeyBinds({ teleport: "mod+z" })).toEqual(defaultKeyBinds());
  });

  it("falls back to the default when a stored chord is corrupt", () => {
    expect(clampKeyBinds({ palette: "!!!" }).palette).toEqual(combo("mod+k"));
    expect(clampKeyBinds({ palette: "k" }).palette).toEqual(combo("mod+k")); // no modifier
  });

  it("refuses the digit range for anything but the switcher", () => {
    expect(clampKeyBinds({ palette: "mod+digit" }).palette).toEqual(combo("mod+k"));
    expect(clampKeyBinds({ sessionSwitch: "mod+alt+digit" }).sessionSwitch).toEqual(combo("mod+alt+digit"));
  });

  // A hand-edited cc-keys is the realistic corruption. Two actions on one chord would
  // fire whichever the table reached first, which is exactly the silent ambiguity the
  // exact matcher was written to remove.
  it("never lets two actions share a chord, whatever the file says", () => {
    const binds = clampKeyBinds({ palette: "mod+b" });
    expect(binds.palette).toEqual(combo("mod+b"));
    expect(binds.sidebar).toBeNull(); // later in the table, so it loses
    for (const a of KEY_ACTION_IDS) {
      for (const b of KEY_ACTION_IDS) {
        if (a !== b) expect(comboClash(binds[a], binds[b]), `${a}/${b}`).toBe(false);
      }
    }
  });
});

describe("chords on screen", () => {
  it("spells the modifiers per platform and the key once", () => {
    expect(comboKeys(combo("mod+shift+b"), true)).toEqual(["⌘", "⇧", "B"]);
    expect(comboKeys(combo("mod+shift+b"), false)).toEqual(["Ctrl", "⇧", "B"]);
    expect(comboKeys(combo("mod+alt+k"), true)).toEqual(["⌘", "⌥", "K"]);
    expect(comboKeys(combo("mod+alt+k"), false)).toEqual(["Ctrl", "Alt", "K"]);
    expect(comboKeys(null, true)).toEqual([]);
  });

  it("names the keys nobody would recognise from their stored form", () => {
    expect(comboKeys(combo("mod+enter"), true)).toEqual(["⌘", "⏎"]);
    expect(comboKeys(combo("mod+digit"), true)).toEqual(["⌘", "1–9"]);
    expect(comboKeys(combo("mod+="), true)).toEqual(["⌘", "+"]);
    expect(comboKeys(combo("mod+-"), true)).toEqual(["⌘", "−"]);
  });

  it("joins for a toast the way each platform writes a chord", () => {
    expect(comboText(combo("mod+shift+h"), true)).toBe("⌘⇧H");
    expect(comboText(combo("mod+shift+h"), false)).toBe("Ctrl+⇧+H");
    expect(comboText(null, true)).toBe("");
  });
});

describe("shortcutRows", () => {
  const rows = (b: KeyBinds) => shortcutRows(on(b), true);

  it("collapses the three font actions into one row of alternatives", () => {
    const font = rows(defaultKeyBinds()).find((r) => r.label === "Terminal font size");
    expect(font?.chords).toEqual([["⌘", "+"], ["⌘", "−"], ["⌘", "0"]]);
  });

  // A cheat sheet listing a shortcut that no longer fires is worse than no cheat sheet.
  it("drops an action the user cleared", () => {
    const binds = unbindKey(defaultKeyBinds(), "sidebar");
    expect(rows(binds).some((r) => r.label === keyActionDef("sidebar").label)).toBe(false);
    expect(rows(defaultKeyBinds()).some((r) => r.label === keyActionDef("sidebar").label)).toBe(true);
  });

  it("follows a rebind instead of advertising the default", () => {
    const { binds } = bindKey(defaultKeyBinds(), "palette", combo("mod+alt+p"));
    const row = rows(binds).find((r) => r.label === keyActionDef("palette").label);
    expect(row?.chords).toEqual([["⌘", "⌥", "P"]]);
  });

  it("lists one row per bound action, bar the merged font group", () => {
    const ids = KEY_ACTION_IDS.filter((id: KeyAction) => !keyActionDef(id).rowLabel);
    expect(rows(defaultKeyBinds()).length).toBe(ids.length + 1);
  });
});
