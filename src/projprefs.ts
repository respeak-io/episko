// A project's own answers to settings that are otherwise global (docs/settings.md § Project
// settings). Pure: the store, its repair, and resolving a project against the global value.
// Personal and local-only — every field here changes what runs or what is permitted.
import { AUTOFETCH_EVERY, type AutoFetchPrefs } from "./autofetch";
import { nfcPath } from "./format";

/** An absent field is "follow Settings"; there is no stored value meaning the same thing. */
export interface ProjPref {
  perm?: Record<string, string>;   // provider → permission mode id
  fetch?: boolean;
  fetchEvery?: number;
}
export type ProjPrefStore = Record<string, ProjPref>;

const isEvery = (n: unknown): n is number => (AUTOFETCH_EVERY as readonly number[]).includes(n as number);

function clampOne(v: unknown): ProjPref | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: ProjPref = {};
  if (o.perm && typeof o.perm === "object" && !Array.isArray(o.perm)) {
    const perm = Object.fromEntries(Object.entries(o.perm).filter(([, m]) => typeof m === "string" && m));
    if (Object.keys(perm).length) out.perm = perm as Record<string, string>;
  }
  if (typeof o.fetch === "boolean") out.fetch = o.fetch;
  if (isEvery(o.fetchEvery)) out.fetchEvery = o.fetchEvery;
  return Object.keys(out).length ? out : null;
}

/** Whatever came off `cc-proj-prefs`, made safe; a project left with nothing set is dropped. */
export function clampProjPrefs(raw: unknown): ProjPrefStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProjPrefStore = {};
  for (const [k, v] of Object.entries(raw)) {
    const p = clampOne(v);
    if (p) out[nfcPath(k)] = p;
  }
  return out;
}

export const permOverride = (s: ProjPrefStore, key: string, provider: string): string | undefined =>
  s[key]?.perm?.[provider];

/** The auto-fetch rule this project runs on: each half falls back to Settings on its own. */
export function fetchFor(global: AutoFetchPrefs, s: ProjPrefStore, key: string): AutoFetchPrefs {
  const p = s[key];
  return { enabled: p?.fetch ?? global.enabled, everyMs: p?.fetchEvery ?? global.everyMs };
}

// Mutations return a new store, so state.ts's setter stays an assignment.
function put(s: ProjPrefStore, key: string, next: ProjPref): ProjPrefStore {
  const out = { ...s };
  const clean = clampOne(next);
  if (clean) out[key] = clean; else delete out[key];
  return out;
}

/** `null` clears the override, which is the only way back to following Settings. */
export function withPerm(s: ProjPrefStore, key: string, provider: string, mode: string | null): ProjPrefStore {
  const perm = { ...s[key]?.perm };
  if (mode) perm[provider] = mode; else delete perm[provider];
  return put(s, key, { ...s[key], perm });
}

export function withFetch(s: ProjPrefStore, key: string, patch: { fetch?: boolean | null; fetchEvery?: number | null }): ProjPrefStore {
  const next: ProjPref = { ...s[key] };
  if (patch.fetch !== undefined) { if (patch.fetch === null) delete next.fetch; else next.fetch = patch.fetch; }
  if (patch.fetchEvery !== undefined) { if (patch.fetchEvery === null) delete next.fetchEvery; else next.fetchEvery = patch.fetchEvery; }
  return put(s, key, next);
}

export type OverrideKind = "perm" | "fetch";

/** The projects that answer this one themselves, so a global row can say who ignores it. */
export function overriders(s: ProjPrefStore, kind: OverrideKind, provider = ""): string[] {
  return Object.entries(s).filter(([, p]) => kind === "perm"
    ? !!p.perm?.[provider]
    : p.fetch !== undefined || p.fetchEvery !== undefined).map(([k]) => k);
}

