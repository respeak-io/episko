import { describe, expect, it } from "vitest";
import { CARRY_TTL, carryDue, carryMark, carryText } from "../src/carryover";

const NOW = 1800000000000;
const pane = (id: string, resumable = true) => ({ id, resumable });
const mark = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ from: "0.41.0", ids: ["a", "b", "c"], active: "b", at: NOW, ...o });

describe("carryMark — what the installing build leaves behind", () => {
  it("lists only the panes a restart can bring back", () => {
    const m = carryMark([pane("a"), pane("shell", false), pane("b")], "a", "0.41.0", NOW);
    expect(m).toEqual({ from: "0.41.0", ids: ["a", "b"], active: "a", at: NOW });
  });
  it("leaves no mark when nothing would come back", () => {
    expect(carryMark([pane("shell", false)], "shell", "0.41.0", NOW)).toBeNull();
    expect(carryMark([], null, "0.41.0", NOW)).toBeNull();
  });
  it("forgets an active pane that is not coming back", () => {
    expect(carryMark([pane("a"), pane("task", false)], "task", "0.41.0", NOW)?.active).toBeNull();
  });
});

describe("carryDue — what the boot after resumes", () => {
  it("resumes every carried id, the active one last so it ends on stage", () => {
    expect(carryDue(mark(), "0.42.0", NOW + 30_000)).toEqual(["a", "c", "b"]);
  });
  it("keeps the order as written without an active pane", () => {
    expect(carryDue(mark({ active: null }), "0.42.0", NOW)).toEqual(["a", "b", "c"]);
  });
  it("resumes nothing when the install never happened", () => {
    expect(carryDue(mark(), "0.41.0", NOW + 30_000)).toEqual([]);
  });
  it("counts any change of version, a channel switch back down included", () => {
    expect(carryDue(mark({ from: "0.42.0-preview.3" }), "0.41.0", NOW)).toEqual(["a", "c", "b"]);
  });
  it("lets a stale mark go, and one from the future", () => {
    expect(carryDue(mark(), "0.42.0", NOW + CARRY_TTL + 1)).toEqual([]);
    expect(carryDue(mark(), "0.42.0", NOW - 120_000)).toEqual([]);
  });
  it("narrows a damaged mark rather than trusting it", () => {
    expect(carryDue(null, "0.42.0", NOW)).toEqual([]);
    expect(carryDue("{", "0.42.0", NOW)).toEqual([]);
    expect(carryDue("null", "0.42.0", NOW)).toEqual([]);
    expect(carryDue(mark({ ids: "a" }), "0.42.0", NOW)).toEqual([]);
    expect(carryDue(mark({ at: "now" }), "0.42.0", NOW)).toEqual([]);
    expect(carryDue(mark({ ids: ["a", 7, "", "a"], active: 7 }), "0.42.0", NOW)).toEqual(["a"]);
  });
});

describe("carryText — the confirmation's account of the restart", () => {
  it("says what comes back and what does not", () => {
    expect(carryText(3, 0, 2)).toBe("The 3 running sessions come back by themselves afterwards, with their conversations."
      + "\n\n2 other panes (terminals, tasks, agents that cannot resume) close for good.");
  });
  it("names a turn the restart interrupts", () => {
    expect(carryText(1, 1, 0)).toBe("The running session comes back by itself afterwards, with its conversation."
      + " It is mid-turn: that turn stops, and it waits for you rather than carrying on.");
    expect(carryText(4, 2, 0)).toContain("2 are mid-turn: those turns stop");
    expect(carryText(4, 1, 0)).toContain("One is mid-turn");
  });
  it("says nothing when nothing is running", () => {
    expect(carryText(0, 0, 0)).toBe("");
    expect(carryText(0, 0, 1)).toBe("1 other pane (a terminal, a task or an agent that cannot resume) closes for good.");
  });
});
