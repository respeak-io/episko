import { describe, it, expect } from "vitest";
import {
  cleanPrompt, clampOutlinePrefs, clearsOutline, huntFromTop, isEnvelope, lineHasPrompt, normLine, notePrompt,
  OUTLINE_DEFAULTS, promptKeys, promptLabel, PROMPT_CAP, screenShift, seedPrompts,
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
  it("drops a turn Claude submitted for you, task notifications included", () => {
    // `UserPromptSubmit` fires for these exactly as if you had pressed Enter, and six of them
    // filled a pane's outline with <task-notification> where its questions should have been.
    const list: Prompt[] = [];
    expect(notePrompt(list, "<task-notification>\n<task-id>bm3pk5smg</task-id>", NOW)).toBeNull();
    expect(notePrompt(list, "<bash-input>curl -i localhost:3000</bash-input>", NOW)).toBeNull();
    expect(notePrompt(list, "[Image: source: C:/Users/x/1.png]", NOW)).toBeNull();
    expect(notePrompt(list, "[Image #1] why is it red?", NOW)).not.toBeNull();
    expect(list.map((p) => p.text)).toEqual(["[Image #1] why is it red?"]);
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

describe("a resumed pane gets its questions back from the transcript", () => {
  const msg = (role: string, text: string, at?: string) => ({ role, text, at: at ?? null });

  it("keeps the user turns, in order, in front of what the pane already saw", () => {
    const list: Prompt[] = [];
    notePrompt(list, "asked after the resume", NOW);
    seedPrompts(list, [
      msg("user", "first question", "2026-09-03T10:15:00.000Z"),
      msg("assistant", "an answer nobody asked for"),
      msg("user", "second question"),
    ]);
    expect(list.map((p) => p.text))
      .toEqual(["first question", "second question", "asked after the resume"]);
    expect(list[0]).toMatchObject({ restored: true, at: Date.parse("2026-09-03T10:15:00.000Z") });
    expect(list[1]).toMatchObject({ restored: true, at: 0 }); // no timestamp, so no clock
    expect(list[2].restored).toBeUndefined();
  });

  it("refuses a second seeding rather than double the list", () => {
    const list: Prompt[] = [];
    expect(seedPrompts(list, [msg("user", "only once")])).toHaveLength(1);
    expect(seedPrompts(list, [msg("user", "only once")])).toEqual([]);
    expect(list).toHaveLength(1);
  });

  it("keeps a question genuinely asked twice", () => {
    const list: Prompt[] = [];
    seedPrompts(list, [msg("user", "continue"), msg("user", "continue")]);
    expect(list.map((p) => p.text)).toEqual(["continue", "continue"]);
  });

  it("drops the turns Claude writes as you, and only at the start of one", () => {
    expect(isEnvelope("<command-name>/model</command-name>")).toBe(true);
    expect(isEnvelope("<task-notification>\n<task-id>wai24prh6</task-id>")).toBe(true);
    expect(isEnvelope("Caveat: The messages below were generated by the user while…")).toBe(true);
    expect(isEnvelope("why does <system-reminder> show up in my prompt?")).toBe(false);
    const list: Prompt[] = [];
    seedPrompts(list, [
      msg("user", "<system-reminder>be nice</system-reminder>"),
      msg("user", "[Request interrupted by user]"),
      msg("user", "  "),
      msg("user", "a real question"),
    ]);
    expect(list.map((p) => p.text)).toEqual(["a real question"]);
  });

  it("stays inside the cap, dropping the oldest restored turns", () => {
    const list: Prompt[] = [];
    seedPrompts(list, Array.from({ length: PROMPT_CAP + 4 }, (_, i) => msg("user", `q${i}`)));
    expect(list).toHaveLength(PROMPT_CAP);
    expect(list[0].text).toBe("q4");
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

describe("finding the question in the scrollback", () => {
  const hit = (row: string, text: string) =>
    promptKeys(text).some((k) => lineHasPrompt(normLine(row), k));

  it("reads a row without the REPL's own marker or padding", () => {
    expect(normLine("> fix   the header   ")).toBe("fix the header");
    expect(normLine("│ ┃ still the header")).toBe("still the header");
  });
  it("strips the marker off both sides, so a quoted question still matches", () => {
    expect(hit("> > quoting something back at you", "> quoting something back at you")).toBe(true);
    expect(hit("> - and a bullet leads this one", "- and a bullet leads this one")).toBe(true);
  });
  it("keys on the first line that says anything, capped", () => {
    expect(promptKeys("\n\n  fix the header\nand the footer")[0].key).toBe("fix the header");
    expect(promptKeys("z".repeat(200)).map((k) => k.key.length)).toEqual([60, 24]);
    expect(promptKeys("   \n  ")).toEqual([]);
  });
  it("falls back to the start of a question the terminal wrapped short", () => {
    const q = "can you look at the retry ladder again, and the backoff with it";
    expect(hit("> can you look at the retry", q)).toBe(true);
    expect(hit("> can you look at", q)).toBe(false); // shorter than the retry key: too little to go on
  });
  it("matches a question wherever the row puts it", () => {
    expect(hit("  > can you look at the retry ladder again", "can you look at the retry ladder again"))
      .toBe(true);
    expect(hit("> a different question entirely", "can you look at the retry ladder again"))
      .toBe(false);
  });
  it("makes a short question lead its row, since `includes` would match anything", () => {
    expect(promptKeys("go on")[0].strict).toBe(true);
    expect(promptKeys("have another go at it")[0].strict).toBe(false);
    expect(hit("> go on", "go on")).toBe(true);
    expect(hit("> now tell it to go on", "go on")).toBe(false);
  });
});

describe("how far a screen moved between two readings", () => {
  const screen = (...rows: string[]) => rows;
  const conv = ["one fine morning", "", "we talked about the retry ladder", "and then the backoff",
    "", "a fifth line with words", "and a sixth", "the seventh"];

  it("reads the shift when the view scrolled back", () => {
    const before = screen(...conv);
    const after = screen("earlier", "still earlier", ...conv.slice(0, 6));
    expect(screenShift(before, after)).toBe(2);
  });
  it("says 0 when a wheel changed nothing, which is the top", () => {
    expect(screenShift(conv, conv)).toBe(0);
  });
  it("says nothing at all when too little lines up", () => {
    expect(screenShift(conv, screen("a", "completely", "different", "screen", "entirely"))).toBeNull();
    expect(screenShift(["", "  ", ""], ["", "  ", ""])).toBeNull(); // blank rows anchor nothing
  });
});

describe("which end of the conversation a hunt pages in from", () => {
  const ask = (id: string, at: number, restored = false): Prompt => ({ id, text: id, at, restored });
  const HOUR = 3_600_000;

  it("goes to the live end when the list cannot see the start of the conversation", () => {
    // The click that reported this: a resumed pane whose seed restored nothing lists one
    // question, and "the first of one" sent the hunt to the top of a day it never crossed.
    const p = ask("p2", NOW - 9 * 60_000);
    expect(huntFromTop([p], p, NOW, true)).toBe(false);
  });

  it("goes to the top for the first question of a pane that started the conversation", () => {
    const first = ask("p1", NOW - 6 * HOUR), last = ask("p2", NOW - 60_000);
    expect(huntFromTop([first, last], first, NOW, false)).toBe(true);
    expect(huntFromTop([first, last], last, NOW, false)).toBe(false);
  });

  it("trusts a resumed list once the seed has restored what came before it", () => {
    const seeded = ask("p1", NOW - 14 * HOUR, true), asked = ask("p2", NOW - 9 * 60_000);
    expect(huntFromTop([seeded, asked], asked, NOW, true)).toBe(false);
    expect(huntFromTop([seeded, asked], seeded, NOW, true)).toBe(true);
  });

  it("falls back to the list's own order when there is no clock to measure with", () => {
    const seeded = ask("p1", 0, true), asked = ask("p2", NOW - 1000);
    expect(huntFromTop([seeded, asked], seeded, NOW, true)).toBe(true);
    expect(huntFromTop([seeded, asked], asked, NOW, true)).toBe(false);
  });
});
