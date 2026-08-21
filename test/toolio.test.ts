import { describe, expect, it } from "vitest";
import { actClipText, clip, DESC_CAP, descText, DETAIL_CAP, fieldsText, inputText, outputText } from "../src/toolio";
import type { Act } from "../src/types";

// What a tool call was and what came back, out of the raw hook payloads.
//
// **Every payload below is a real one**, captured by pointing a throwaway `--settings`
// file at `/bin/cat` and running claude against it — the same instrumentation Episko
// generates, so these are the exact shapes `applyHook` receives. That matters more here
// than anywhere else in the suite: this module's whole job is knowing what Claude Code
// puts in `tool_response`, and a hand-invented fixture would only ever agree with what
// we assumed it puts there. Two of the three modelled shapes were nothing like the
// guess (a failure has NO `tool_response` at all; an `Edit` reply carries the entire
// pre-change file), and both were found this way.

describe("clip — the cap, applied at capture", () => {
  it("leaves anything under the cap alone, bar trailing whitespace", () => {
    expect(clip("hello\n\n")).toBe("hello");
  });
  it("says how much it dropped, in the string itself", () => {
    const out = clip("x".repeat(DETAIL_CAP + 25));
    expect(out.startsWith("x".repeat(DETAIL_CAP))).toBe(true);
    expect(out).toContain("… 25 more characters");
  });
  it("takes a smaller cap for a caller that wants one", () => {
    expect(clip("abcdef", 3)).toBe("abc\n… 3 more characters");
  });
  // The marker is inside the text rather than a flag beside it, so the <pre>, the copy
  // button and this test cannot disagree about whether what they hold is the whole thing.
  it("carries the truncation into anything that copies the string", () => {
    expect(clip("y".repeat(10), 4)).toMatch(/more characters$/);
  });
});

describe("fieldsText — a payload object as something readable", () => {
  it("keeps a short single-line value on its key's line", () => {
    expect(fieldsText({ file_path: "/a/b.ts" })).toBe("file_path: /a/b.ts");
  });
  it("gives a multi-line value its own block", () => {
    expect(fieldsText({ command: "one\ntwo" })).toBe("command:\none\ntwo");
  });
  it("gives a long single-line value its own block too", () => {
    expect(fieldsText({ q: "z".repeat(80) })).toBe(`q:\n${"z".repeat(80)}`);
  });
  it("prints the primary field bare and first — it IS the call", () => {
    expect(fieldsText({ description: "Echo it", command: "echo hi" }, "command"))
      .toBe("echo hi\ndescription: Echo it");
  });
  // A `command:` label above a heredoc, re-indented, is no longer the thing that ran.
  it("does not indent a block value, so a copied heredoc still terminates", () => {
    const script = "cat <<'EOF'\n  body\nEOF";
    expect(inputText("Bash", { command: script })).toBe(script);
  });
  it("drops absent fields rather than printing ten lines of null", () => {
    expect(fieldsText({ a: 1, b: null, c: "", d: undefined, e: false })).toBe("a: 1\ne: false");
  });
  // An empty collection is not an absent field: `matches: []` is what a search that
  // found nothing came back with, and that is the answer rather than the lack of one.
  it("keeps an empty collection, which is an answer", () => {
    expect(fieldsText({ matches: [] })).toBe("matches: []");
  });
  it("falls back to JSON for anything structured", () => {
    expect(fieldsText({ todos: [{ x: 1 }] })).toBe(`todos:\n${JSON.stringify([{ x: 1 }], null, 2)}`);
  });
  it("keys every field of a tool it has never heard of", () => {
    expect(inputText("mcp__acme__do", { a: "1", b: "2" })).toBe("a: 1\nb: 2");
  });
});

describe("inputText — what was executed", () => {
  it("shows a Bash command whole, not the 64 characters the row label gets", () => {
    const cmd = "grep -rn 'x' . | head -" + "9".repeat(200);
    expect(inputText("Bash", { command: cmd, description: "d" })).toContain(cmd);
  });
  it("survives a payload that is not an object", () => {
    expect(inputText("Bash", null)).toBe("");
    expect(inputText("Bash", undefined)).toBe("");
    expect(inputText("Bash", "raw")).toBe("raw");
  });
  it("caps a Write's content at capture", () => {
    const out = inputText("Write", { file_path: "/a", content: "c".repeat(DETAIL_CAP + 10) });
    expect(out.length).toBeLessThan(DETAIL_CAP + 80);
    expect(out).toContain("more characters");
  });
});

describe("outputText — what came back", () => {
  // ---- the failure case: the highest-value payload, and the one with no tool_response ----
  it("reads a failure out of `error`, since there is no tool_response at all", () => {
    // Real PostToolUseFailure payload, `cat definitely-no-such-file.txt`.
    expect(outputText(null, "Exit code 1\ncat: definitely-no-such-file.txt: No such file or directory"))
      .toBe("Exit code 1\ncat: definitely-no-such-file.txt: No such file or directory");
  });
  it("prefers the error even if a response is somehow also present", () => {
    expect(outputText({ stdout: "partial" }, "boom")).toBe("boom");
  });
  it("ignores a blank error, which is not a failure", () => {
    expect(outputText({ stdout: "ok" }, "   ")).toBe("ok");
  });

  // ---- Bash ----
  it("shows a Bash call's stdout", () => {
    expect(outputText({ stdout: "hello-world", stderr: "", interrupted: false, isImage: false }, null))
      .toBe("hello-world");
  });
  it("labels stderr rather than blending it into stdout", () => {
    expect(outputText({ stdout: "out", stderr: "warn" }, null)).toBe("out\nstderr:\nwarn");
  });
  // "the command printed nothing" and "we kept nothing" look identical as a blank box.
  it("says so when a command printed nothing", () => {
    expect(outputText({ stdout: "", stderr: "" }, null)).toBe("(no output)");
  });
  it("notes an interrupted command", () => {
    expect(outputText({ stdout: "a", stderr: "", interrupted: true }, null)).toBe("a\n(interrupted)");
  });

  // ---- Read ----
  it("shows the file a Read returned", () => {
    const resp = { type: "text", file: { filePath: "/a/data.txt", content: "alpha\nbeta\n", numLines: 3, startLine: 1, totalLines: 3 } };
    expect(outputText(resp, null)).toBe("alpha\nbeta");
  });
  it("says a file was empty rather than showing a blank box", () => {
    expect(outputText({ type: "text", file: { content: "" } }, null)).toBe("(empty file)");
  });

  // ---- Write / Edit ----
  // The reason this shape is modelled by hand at all: `originalFile` is the WHOLE file
  // before the change, so the generic dump would bury the one-line patch beside it and
  // spend the entire cap doing it.
  // No `type` on this payload, deliberately: the real Edit reply has none. Only Write
  // carries the create/update discriminant, which is why the patch itself has to answer.
  it("shows an Edit's patch, never the pre-change file it also carries", () => {
    const resp = {
      filePath: "/a/data.txt", oldString: "alpha", newString: "ALPHA",
      originalFile: "alpha\nbeta\ngamma\n",
      structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-alpha", "+ALPHA", " beta", " gamma"] }],
      userModified: false, replaceAll: false,
    };
    const out = outputText(resp, null);
    expect(out).toBe("updated\n@@ -1,3 +1,3 @@\n-alpha\n+ALPHA\n beta\n gamma");
    expect(out).not.toContain("originalFile");
  });
  it("counts the lines of a created file, which has no patch to show", () => {
    const resp = { type: "create", filePath: "/a/made.txt", content: "made\n", structuredPatch: [], originalFile: null, userModified: false };
    expect(outputText(resp, null)).toBe("created · 2 lines");
  });

  // ---- everything else ----
  it("dumps an unfamiliar response as fields", () => {
    const resp = { matches: [], query: "select:Grep", total_deferred_tools: 139 };
    expect(outputText(resp, null)).toBe("matches: []\nquery: select:Grep\ntotal_deferred_tools: 139");
  });
  it("is empty for a call that has not come back yet", () => {
    expect(outputText(null, null)).toBe("");
    expect(outputText(undefined, undefined)).toBe("");
  });
  it("takes a bare string response as itself", () => {
    expect(outputText("just text", null)).toBe("just text");
  });
  it("caps whatever came back, however big", () => {
    const out = outputText({ stdout: "s".repeat(DETAIL_CAP * 3) }, null);
    expect(out.length).toBeLessThan(DETAIL_CAP + 80);
  });
});

describe("outputText — the shapes that used to read as nothing", () => {
  it("dumps an array response instead of claiming nothing came back", () => {
    // Neither a scalar nor a record, so it reached neither `scalar` nor `fieldsText` and
    // fell out as "" — which the sheet renders as "(nothing returned)" for a call that
    // returned plenty. An MCP tool's content blocks are exactly this shape.
    const out = outputText([{ type: "text", text: "first" }, { type: "text", text: "second" }], null);
    expect(out).toContain("first");
    expect(out).toContain("second");
    expect(out).not.toBe("");
  });
  it("keeps an empty array distinguishable from nothing at all", () => {
    expect(outputText([], null)).toBe("[]");
    expect(outputText(null, null)).toBe("");
  });
  it("falls back to the line count when a patch has no hunk lines", () => {
    // Every hunk string carries a newline after its `@@` header whether or not anything
    // follows, so the old `.includes("\n")` filter passed an empty hunk through and the
    // truthy `body` blocked the `N lines` fallback underneath it.
    const out = outputText({ type: "create", content: "a\nb\nc\n", structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: [] }] }, null);
    expect(out).not.toContain("@@");
    expect(out).toContain("4 lines");
  });
});

describe("actClipText — what Copy hands over", () => {
  const act = (o: Partial<Act> = {}): Act => ({
    tool: "Bash", arg: "pnpm test", time: "14:22", startMs: 0, durMs: 120,
    id: "toolu_01", inp: "pnpm test", desc: "", out: "12 passed", failed: false, ...o,
  });

  // The pasted text has to say which half is which — a command and its output are both
  // just text, and the two are indistinguishable once they leave the card that labelled
  // them.
  it("labels both halves and heads it with the call", () => {
    expect(actClipText(act())).toBe(
      "Bash · pnpm test\n\n# executed\npnpm test\n\n# returned\n12 passed\n",
    );
  });
  it("says failed rather than returned when the call did", () => {
    expect(actClipText(act({ failed: true, out: "Exit code 1" }))).toContain("# failed\nExit code 1");
  });
  // The three fallbacks are distinct facts, and the whole point is that a paste never
  // reads as an empty result when it was really an unfinished one.
  it("distinguishes a call still in flight from one that returned nothing", () => {
    expect(actClipText(act({ durMs: null, out: "" }))).toContain("# returned\nstill running\n");
    expect(actClipText(act({ out: "" }))).toContain("# returned\n(nothing returned)\n");
  });
  it("says so when there were no arguments", () => {
    expect(actClipText(act({ inp: "" }))).toContain("# executed\n(no arguments)");
  });
  it("drops the separator for a call with no argument to show", () => {
    expect(actClipText(act({ arg: "" })).startsWith("Bash\n\n")).toBe(true);
  });
});

describe("descText — Claude's note on why, kept out of what ran", () => {
  // The real shape: Claude Code sends `description` inside `tool_input`, right beside
  // the command. Rendered there it made the Executed block unpasteable — you got the
  // command plus a `description:` line, and `find . | sort` came back needing an edit.
  const bash = { command: 'find . -maxdepth 1 -name "*.md" | sort', description: "List markdown files at top level" };

  it("lifts the description off a tool whose payload has one field that IS the call", () => {
    expect(descText("Bash", bash)).toBe("List markdown files at top level");
    expect(descText("Task", { prompt: "go", description: "Explore the inspector" })).toBe("Explore the inspector");
  });
  it("leaves the input block as the thing that ran, and nothing else", () => {
    expect(inputText("Bash", bash)).toBe('find . -maxdepth 1 -name "*.md" | sort');
  });

  // The reason this is not a blanket "drop every `description`": for a tool with no
  // dominant field, all of them are arguments — an MCP call that creates a calendar
  // event puts the event's own description there, and hiding it would hide an input.
  it("leaves a description that IS an argument alone", () => {
    const ev = { summary: "Standup", description: "Daily sync, 15 minutes" };
    expect(descText("mcp__google_calendar__create_event", ev)).toBe("");
    expect(inputText("mcp__google_calendar__create_event", ev)).toContain("description: Daily sync, 15 minutes");
  });

  it("is empty when there is no description, or no payload at all", () => {
    expect(descText("Bash", { command: "ls" })).toBe("");
    expect(descText("Bash", { command: "ls", description: "   " })).toBe("");
    expect(descText("Bash", null)).toBe("");
    expect(descText("Read", { file_path: "/x", description: "d" })).toBe("");
  });
  it("caps a pathological description", () => {
    const long = descText("Bash", { command: "ls", description: "d".repeat(DESC_CAP * 2) });
    expect(long.length).toBeLessThan(DESC_CAP + 40);
    expect(long).toContain("more characters");
  });

  // The whole point of the split: one copy is annotated for reading, the other is the
  // command itself. The note may appear in the first and must never appear in the second.
  it("puts the note in the header of a copied call, never in the executed block", () => {
    const text = actClipText({
      tool: "Bash", arg: "find .", time: "12:58", startMs: 0, durMs: 193, id: "t1",
      inp: 'find . -maxdepth 1 -name "*.md" | sort', desc: "List markdown files at top level",
      out: "./CHANGELOG.md", failed: false,
    });
    expect(text).toBe(
      'Bash · find .\nList markdown files at top level\n\n# executed\nfind . -maxdepth 1 -name "*.md" | sort\n\n# returned\n./CHANGELOG.md\n',
    );
    expect(text.split("# executed\n")[1]).not.toContain("List markdown files");
  });
});
