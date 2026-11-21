import { describe, expect, it } from "vitest";
import { sourceGlyphIds, sourceLogo, sourceMarkIds } from "../src/maintlogos";
import { SOURCES } from "../src/maintsources";

// The tables are keyed by manifest source id, which nothing type-checks: a renamed id would draw nothing.
describe("maintlogos", () => {
  it("gives every manifest source exactly one icon, and names no other id", () => {
    const keys = [...sourceMarkIds(), ...sourceGlyphIds()].sort();
    expect(keys).toEqual(SOURCES.map((s) => s.id).sort());
  });
  it("draws every mark in the text colour, with nothing that would draw or fetch on its own", () => {
    for (const id of sourceMarkIds()) {
      const svg = sourceLogo(id);
      expect(svg, id).toMatch(/^<svg class="ic solo mark" /);
      expect(svg, id).not.toMatch(/<title|<style|<script|<image|href=|#[0-9a-f]{3,6}\b/i);
    }
  });
  it("draws a source that names no service as what it reads, and an unknown id as nothing", () => {
    expect(sourceLogo("rdap-domain")).toMatch(/^<svg class="ic solo" /);
    expect(sourceLogo("no-such-source")).toBe("");
  });
});
