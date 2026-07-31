import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import { addNote, noteById, noteList, notes, reloadNotes, removeNote, setNoteProject } from "../src/notes";

beforeEach(() => {
  store.clear();
  reloadNotes();
  notes.length = 0;
});

describe("capture", () => {
  it("keeps the newest first and persists", () => {
    addNote("first");
    addNote("second");
    expect(noteList().map((n) => n.text)).toEqual(["second", "first"]);
    expect(JSON.parse(store.get("cc-notes")!)).toHaveLength(2);
  });

  it("refuses an empty jot without making the caller check", () => {
    expect(addNote("   ")).toBeNull();
    expect(addNote("")).toBeNull();
    expect(noteList()).toHaveLength(0);
  });

  it("trims, because a trailing newline from a paste is not part of the thought", () => {
    expect(addNote("  rate-limit /v1/transcribe \n")!.text).toBe("rate-limit /v1/transcribe");
  });

  it("files a note against a project only when asked", () => {
    expect(addNote("unfiled")!.project).toBeNull();
    expect(addNote("filed", "/w/episko")!.project).toBe("/w/episko");
    expect(noteList("/w/episko").map((n) => n.text)).toEqual(["filed"]);
  });

  it("gives two notes jotted in the same millisecond distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, (_, i) => addNote(`n${i}`)!.id));
    expect(ids.size).toBe(50);
  });
});

describe("lifecycle", () => {
  it("returns the note it removed, so dispatch can use its text as the brief", () => {
    const n = addNote("try a departures-board layout")!;
    expect(removeNote(n.id)!.text).toBe("try a departures-board layout");
    expect(noteById(n.id)).toBeNull();
    expect(noteList()).toHaveLength(0);
  });

  it("survives a removal that isn't there", () => {
    expect(removeNote("nope")).toBeNull();
  });

  it("re-files onto and off a project", () => {
    const n = addNote("x")!;
    setNoteProject(n.id, "/w/api");
    expect(noteById(n.id)!.project).toBe("/w/api");
    setNoteProject(n.id, null);
    expect(noteById(n.id)!.project).toBeNull();
  });
});

describe("a corrupt store must not take the app down", () => {
  // These read at import time, so throwing here would break the whole frontend load.
  it("degrades to empty on unparseable JSON", () => {
    store.set("cc-notes", "{not json");
    reloadNotes();
    expect(noteList()).toEqual([]);
  });

  it("drops entries that aren't notes", () => {
    store.set("cc-notes", JSON.stringify([{ id: "a", text: "keep", project: null, created: 1 }, null, { id: 5 }, "x"]));
    reloadNotes();
    expect(noteList().map((n) => n.text)).toEqual(["keep"]);
  });

  it("degrades when the stored value isn't a list at all", () => {
    store.set("cc-notes", JSON.stringify({ nope: true }));
    reloadNotes();
    expect(noteList()).toEqual([]);
  });
});
