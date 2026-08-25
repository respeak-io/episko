import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLogo, agentLogoIds } from "../src/providers/logos";

// Provider support crosses a JSON capability matrix, a frontend adapter registry and
// shared UI code. TypeScript cannot prove those files agree, so this suite checks the
// joins from source — the same kind of guard as dispatch.test.ts and ipc.test.ts.

const SRC = new URL("../src/", import.meta.url);
const SRC_PATH = fileURLToPath(SRC);
const read = (file: string) => readFileSync(new URL(file, SRC), "utf8");
function tsFiles(dir = SRC_PATH): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? tsFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
const manifest = JSON.parse(read("providers/manifest.json")) as Record<string, { capabilities: string[] }>;
const types = read("types.ts");
const registry = read("providers/index.ts");
const pty = readFileSync(new URL("../src-tauri/src/pty.rs", import.meta.url), "utf8");

const quoted = (source: string) => [...source.matchAll(/["']([a-z][a-z0-9-]*)["']/g)].map((m) => m[1]);
const capabilityBlock = /export const AGENT_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(types)?.[1] ?? "";
const knownCapabilities = new Set(quoted(capabilityBlock));
const registryBlock = /export const PROVIDER_ADAPTERS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(registry)?.[1] ?? "";
const registryIds = [...registryBlock.matchAll(/\{\s*id:\s*["']([a-z0-9]+)["']/g)].map((m) => m[1]);

describe("provider integration contract", () => {
  it("has an explicit logo for Claude and every backend catalogue agent", () => {
    const catalogueBlock = /const AGENTS:[\s\S]*?=\s*&\[([\s\S]*?)\n\];/.exec(pty)?.[1] ?? "";
    const catalogueIds = [...catalogueBlock.matchAll(/\bid:\s*"([a-z0-9]+)"/g)].map((match) => match[1]);
    expect([...agentLogoIds()].sort()).toEqual(["claude", ...catalogueIds].sort());
    for (const id of agentLogoIds()) expect(agentLogo(id), `${id} has no SVG mark`).toContain("<svg");
  });

  it("has one adapter entry for every provider in the shared capability matrix", () => {
    expect(registryIds.length).toBeGreaterThan(0);
    expect([...registryIds].sort()).toEqual(Object.keys(manifest).sort());
  });

  it("advertises only known, unique capabilities and makes integration explicit", () => {
    expect(knownCapabilities.size).toBeGreaterThan(0);
    for (const [provider, entry] of Object.entries(manifest)) {
      expect(new Set(entry.capabilities).size, `${provider} repeats a capability`).toBe(entry.capabilities.length);
      expect(entry.capabilities, `${provider} is integrated without session-state`).toContain("session-state");
      expect(
        entry.capabilities.filter((capability) => !knownCapabilities.has(capability)),
        `${provider} advertises a capability the Sess model cannot gate`,
      ).toEqual([]);
    }
  });

  it("backs structured capability claims with registry services", () => {
    for (const [provider, entry] of Object.entries(manifest)) {
      const adapter = new RegExp(
        `\\{\\s*id:\\s*["']${provider}["']([^}]*)\\}`,
      ).exec(registryBlock)?.[1] ?? "";
      expect(adapter, `${provider} has no readable registry entry`).not.toBe("");
      if (provider !== "claude" && entry.capabilities.includes("session-state")) {
        expect(adapter, `${provider} claims session-state without an event adapter`).toMatch(/\bevents\s*:/);
      }
      if (entry.capabilities.includes("history")) {
        expect(adapter, `${provider} claims history without a history adapter`).toMatch(/\bhistory\s*:/);
      }
      if (entry.capabilities.includes("launch-permissions")) {
        expect(adapter, `${provider} claims launch permissions without provider-owned choices`).toMatch(/\bpermissionModes\s*:/);
      }
    }
  });

  it("keeps vendor comparisons at documented integration boundaries", () => {
    const allowed = new Set([
      // Provider identity is the point of these modules: launch/protocol routing,
      // Claude's external-session bridge and account-specific usage semantics.
      "grouping.ts", "history.ts", "panes.ts", "tour.ts", "types.ts", "usage.ts",
    ]);
    const comparison = /(?:(?:\bprovider|\.provider)\s*(?:===|!==)\s*["'][a-z0-9-]+["']|["'][a-z0-9-]+["']\s*(?:===|!==)\s*(?:\bprovider|[a-zA-Z0-9_]+\.provider))/g;
    const violations: string[] = [];
    for (const path of tsFiles()) {
      const file = relative(SRC_PATH, path).replaceAll("\\", "/");
      if (file.startsWith("providers/")) continue;
      if (allowed.has(file)) continue;
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(comparison)) {
        const line = source.slice(0, match.index).split("\n").length;
        violations.push(`${file}:${line} ${match[0]}`);
      }
    }
    expect(
      violations,
      "Shared code must ask for a capability or call src/providers; do not add a provider-specific UI branch",
    ).toEqual([]);
  });

  it("keeps non-Claude vendor ids entirely inside provider adapters", () => {
    const vendors = Object.keys(manifest).filter((provider) => provider !== "claude");
    const violations: string[] = [];
    for (const path of tsFiles()) {
      const file = relative(SRC_PATH, path).replaceAll("\\", "/");
      if (file.startsWith("providers/")) continue;
      const source = readFileSync(path, "utf8");
      for (const vendor of vendors) {
        const literal = new RegExp(`["']${vendor}["']`, "g");
        for (const match of source.matchAll(literal)) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${file}:${line} ${match[0]}`);
        }
      }
    }
    expect(
      violations,
      "Vendor ids belong in src/providers; shared code must use the registry",
    ).toEqual([]);
  });
});
