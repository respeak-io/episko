import { describe, expect, it } from "vitest";
import { RESET_EVERY_MS, RESET_QUIET_MS, resetDue } from "../src/compositorreset";

const NOW = 10 * RESET_EVERY_MS;

describe("resetDue", () => {
  it("never fires while the window has focus", () => {
    expect(resetDue({ now: NOW, unfocusedSince: null, lastResetAt: null })).toBe(false);
  });

  it("waits out a quick Alt-Tab", () => {
    expect(resetDue({ now: NOW, unfocusedSince: NOW - RESET_QUIET_MS + 1, lastResetAt: null })).toBe(false);
    expect(resetDue({ now: NOW, unfocusedSince: NOW - RESET_QUIET_MS, lastResetAt: null })).toBe(true);
  });

  it("holds the gap between resets, however long the window stays unfocused", () => {
    const unfocusedSince = NOW - 2 * RESET_EVERY_MS;
    expect(resetDue({ now: NOW, unfocusedSince, lastResetAt: NOW - RESET_EVERY_MS + 1 })).toBe(false);
    expect(resetDue({ now: NOW, unfocusedSince, lastResetAt: NOW - RESET_EVERY_MS })).toBe(true);
  });
});
