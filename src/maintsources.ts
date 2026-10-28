// Maintenance's manifest as TypeScript: the seven facets, the sources and markers both sides read
// from ./maintmanifest.json, and which of them a mode may run. No DOM, no Tauri, and no vendor
// named here: a new adapter is a manifest row (docs/maintenance.md).

import manifest from "./maintmanifest.json";

export const FACETS = ["ci", "security", "deps", "release", "git", "prod", "work"] as const;
export type Facet = (typeof FACETS)[number];

export const COSTS = ["local", "forge", "public", "tool", "remote"] as const;
export type Cost = (typeof COSTS)[number];

// The closed vocabulary `sees`/`blind` may use; maint.rs's MAINT_CAPS mirrors it, and a test holds them.
export const MAINT_CAPS = [
  "ci.default-branch", "ci.per-workflow", "ci.failing-since", "ci.disabled", "ci.external", "ci.other-branches",
  "git.unpushed", "git.local-only", "git.merged", "git.gone", "git.branch-age", "git.worktree-age",
  "git.squash-merged", "rel.unreleased", "rel.last", "rel.published", "rel.changelog",
  "sec.dependency", "sec.code", "sec.secret", "deps.update-prs", "deps.pr-checks",
  "work.issues", "work.prs", "work.review-requested", "prod.status", "prod.cert", "prod.host",
] as const;
export type MaintCap = (typeof MAINT_CAPS)[number];

export type Mode = "scan" | "explicit";

export interface FacetDef { id: Facet; label: string; none: string }
export interface SourceDef {
  id: string; facet: Facet; label: string; cost: Cost;
  forge: string[]; detect: string[]; sees: MaintCap[]; blind: MaintCap[];
  sends: string | null; // what a public source sends; maint.rs refuses a public one without it
  settings: string | null; // the forge page that switches it on, `{path}` the repository's
}
export interface MarkerDef { facet: Facet; label: string; forge: string[]; detect: string[] }
export interface BotDef { id: string; logins: string[]; branch: string; dashboard: string | null; config: string[] }

/** Which public sources this machine may call, and which it skips. Per machine: it changes what runs. */
export interface MaintPrefs { public: string[]; off: string[] }
export const MAINT_PREFS_DEFAULT: MaintPrefs = { public: [], off: [] };

const among = <T extends string>(all: readonly T[], v: string, what: string): T => {
  if (!(all as readonly string[]).includes(v)) throw new Error(`maintmanifest.json: unknown ${what} ${JSON.stringify(v)}`);
  return v as T;
};

/** A misspelt capability must fail, not quietly drop a line from the coverage card. */
export function capsOf(list: readonly string[]): MaintCap[] {
  return list.map((c) => among(MAINT_CAPS, c, "capability"));
}

export const FACET_DEFS: readonly FacetDef[] = FACETS.map((id, i) => {
  const f = manifest.facets[i];
  if (manifest.facets.length !== FACETS.length || f?.id !== id) {
    throw new Error("maintmanifest.json: facets must be the seven, in card order");
  }
  return { id, label: f.label, none: f.none };
});

export const SOURCES: readonly SourceDef[] = Object.entries(manifest.sources).map(([id, s]) => ({
  id, facet: among(FACETS, s.facet, "facet"), label: s.label, cost: among(COSTS, s.cost, "cost"),
  forge: s.forge, detect: s.detect, sees: capsOf(s.sees), blind: capsOf(s.blind),
  sends: "sends" in s && typeof s.sends === "string" ? s.sends : null,
  settings: "settings" in s && typeof s.settings === "string" ? s.settings : null,
}));

export const MARKERS: readonly MarkerDef[] = manifest.markers.map((m) => ({
  facet: among(FACETS, m.facet, "facet"), label: m.label, forge: m.forge, detect: m.detect,
}));

export const BOTS: readonly BotDef[] = manifest.bots.map((b) => ({
  id: b.id, logins: b.logins, branch: b.branch, dashboard: b.dashboard ?? null, config: b.config,
}));

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** For a report off the wire, whose id may be one this build does not know. */
export const findSource = (id: string): SourceDef | null => BY_ID.get(id) ?? null;

export function sourceDef(id: string): SourceDef {
  const d = BY_ID.get(id);
  if (!d) throw new Error(`${id} is not a maintenance source`);
  return d;
}

export const facetDef = (f: Facet): FacetDef => FACET_DEFS[FACETS.indexOf(f)];

/** The sentence every door to a public source carries: who receives what, and that nothing else leaves. */
export const disclosure = (s: SourceDef): string | null =>
  s.sends ? `${s.label} receives ${s.sends}. Nothing else leaves this machine.` : null;
export const facetSources = (f: Facet): SourceDef[] => SOURCES.filter((s) => s.facet === f);

// maint.rs's `permitted`, mirrored for the buttons. Rust refuses on its own; this only decides what to offer.
export function permitted(cost: Cost, mode: Mode, publicOk: boolean): boolean {
  if (cost === "local" || cost === "forge") return true;
  if (cost === "public") return mode === "explicit" || publicOk;
  return mode === "explicit";
}

/** The detected sources a mode may run on this machine, in detection order. */
export function runnable(det: { sources: readonly string[] }, prefs: MaintPrefs, mode: Mode): string[] {
  return det.sources.filter((id) => {
    const d = BY_ID.get(id);
    return !!d && !prefs.off.includes(id) && permitted(d.cost, mode, prefs.public.includes(id));
  });
}
