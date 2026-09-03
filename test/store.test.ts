import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import { readList, readObj, safeParse } from "../src/store";

beforeEach(() => store.clear());

// These reads run at module scope in modules main.ts imports, so a throw is a blank window
// before any UI exists to say why — and half of these keys are ones people hand-edit.
describe("readObj", () => {
  it("returns the stored object", () => {
    store.set("cc-x", JSON.stringify({ a: 1, b: 2 }));
    expect(readObj<number>("cc-x")).toEqual({ a: 1, b: 2 });
  });
  it("degrades to {} for a missing, truncated or wrongly shaped value", () => {
    expect(readObj("cc-missing")).toEqual({});
    store.set("cc-x", '{"a":1,');            // a crash mid-write
    expect(readObj("cc-x")).toEqual({});
    for (const bad of ["null", "[]", "[1,2]", '"text"', "7", "true"]) {
      store.set("cc-x", bad);
      expect(readObj("cc-x"), bad).toEqual({});
    }
  });
});

describe("readList", () => {
  it("returns the stored array", () => {
    store.set("cc-l", JSON.stringify(["a", "b"]));
    expect(readList<string>("cc-l")).toEqual(["a", "b"]);
  });
  it("degrades to [] for a missing, truncated or wrongly shaped value", () => {
    expect(readList("cc-missing")).toEqual([]);
    store.set("cc-l", "[1,");
    expect(readList("cc-l")).toEqual([]);
    for (const bad of ["null", "{}", '{"0":"a"}', '"text"', "7"]) {
      store.set("cc-l", bad);
      expect(readList("cc-l"), bad).toEqual([]);
    }
  });
});

describe("safeParse", () => {
  it("answers null instead of throwing, and leaves shape to the caller", () => {
    expect(safeParse(null)).toBeNull();
    expect(safeParse("")).toBeNull();
    expect(safeParse("{oops")).toBeNull();
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
  });
});
