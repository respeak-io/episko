import { describe, it, expect } from "vitest";
import {
  cleanPrompt, clampOutlinePrefs, clearsOutline, notePrompt, OUTLINE_DEFAULTS,
  promptLabel, PROMPT_CAP,
} from "../src/outline";
import type { Prompt } from "../src/types";

const NOW = 1800000000000;

describe("a stored preference is narrowed, never trusted", () => {
  it("falls back to the defaults for junk", () => {
    expect(clampOutlinePrefs(null)).toEqual(OUTLINE_DEFAULTS);
    expect(clampOutlinePrefs({} as any)).toEqual(OUTLINE_DEFAULTS);
    expect(clampOutlinePrefs({ lines: 99 } as any).lines).toBe(OUTLINE_DEFAULTS.lines);
    expect(clampOutlinePrefs({ lines: "3" } as any).lines).toBe(3);
  });
  it("keeps both switches off once they are off", () => {
    expect(clampOutlinePrefs({ enabled: false, hover: false, lines: 1 }))
      .toEqual({ enabled: false, hover: false, lines: 1 });
  });
});

describe("a prompt is normalised before it is listed", () => {
  it("drops trailing blanks and collapses blank runs", () => {
    expect(cleanPrompt("  hi   \n\n\n\nthere \n ")).toBe("hi\n\nthere");
    expect(cleanPrompt("a\r\nb")).toBe("a\nb");
  });
  it("has nothing to say about a non-string or an empty one", () => {
    expect(cleanPrompt(undefined)).toBe("");
    expect(cleanPrompt(42)).toBe("");
    expect(cleanPrompt("   \n  ")).toBe("");
  });
  it("caps a pasted wall of text", () => {
    const out = cleanPrompt("x".repeat(9000));
    expect(out.length).toBe(4001);
    expect(out.endsWith("…")).toBe(true);
  });
  it("labels a prompt by its first non-blank line", () => {
    expect(promptLabel("\n\nfix the header\nand the footer")).toBe("fix the header");
    expect(promptLabel("y".repeat(300)).length).toBe(121);
  });
});

describe("notePrompt lists what you asked", () => {
  it("returns the entry so the caller can anchor it", () => {
    const list: Prompt[] = [];
    const p = notePrompt(list, "why is it red?", NOW);
    expect(p).toMatchObject({ text: "why is it red?", at: NOW });
    expect(list).toEqual([p]);
    expect(p!.id).toBeTruthy();
  });
  it("ignores a blank submit", () => {
    const list: Prompt[] = [];
    expect(notePrompt(list, "  ", NOW)).toBeNull();
    expect(list).toEqual([]);
  });
  it("collapses one message reported twice, but not the same question asked twice", () => {
    const list: Prompt[] = [];
    notePrompt(list, "run the tests", NOW);
    expect(notePrompt(list, "run the tests", NOW + 40)).toBeNull();
    expect(notePrompt(list, "run the tests", NOW + 60_000)).not.toBeNull();
    expect(list).toHaveLength(2);
  });
  it("mints an id per entry, so two identical prompts are two anchors", () => {
    const list: Prompt[] = [];
    const a = notePrompt(list, "go", NOW)!;
    const b = notePrompt(list, "go", NOW + 60_000)!;
    expect(a.id).not.toBe(b.id);
  });
  it("keeps the newest PROMPT_CAP and drops from the front", () => {
    const list: Prompt[] = [];
    for (let i = 0; i < PROMPT_CAP + 5; i++) notePrompt(list, `q${i}`, NOW + i * 60_000);
    expect(list).toHaveLength(PROMPT_CAP);
    expect(list[0].text).toBe("q5");
    expect(list[list.length - 1].text).toBe(`q${PROMPT_CAP + 4}`);
  });
});

describe("only /clear starts a new outline", () => {
  it("keeps the list through a compact or a resume", () => {
    expect(clearsOutline("clear")).toBe(true);
    expect(clearsOutline("compact")).toBe(false);
    expect(clearsOutline("resume")).toBe(false);
    expect(clearsOutline("startup")).toBe(false);
    expect(clearsOutline(undefined)).toBe(false);
  });
});
