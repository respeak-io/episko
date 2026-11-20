import { describe, expect, it } from "vitest";
import { sourceLogo, sourceLogoIds } from "../src/maintlogos";
import { SOURCES } from "../src/maintsources";

// The table is keyed by manifest source id, which nothing type-checks: a renamed id would draw a globe.
describe("maintlogos", () => {
  it("names only sources the manifest has, and only public ones", () => {
    for (const id of sourceLogoIds()) expect(SOURCES.find((s) => s.id === id)?.cost, id).toBe("public");
  });
  it("draws every mark in the text colour, with nothing that would draw or fetch on its own", () => {
    for (const id of sourceLogoIds()) {
      const svg = sourceLogo(id);
      expect(svg, id).toMatch(/^<svg class="ic solo mark" /);
      expect(svg, id).not.toMatch(/<title|<style|<script|<image|href=|#[0-9a-f]{3,6}\b/i);
    }
  });
  it("falls back to a globe for a public source with no mark", () => {
    expect(sourceLogo("rdap-domain")).toContain('class="ic solo"');
  });
});
