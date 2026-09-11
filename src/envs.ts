// Environments: what `env.rs`'s facts mean. The backend answers which files exist and which
// one each target matches; the naming rules, the tones and what a chip says are here
// (docs/environments.md). No DOM, no Tauri — ./envui owns the surfaces and the polling.

export type EnvTone = "danger" | "warn" | "safe" | "none";
export type EnvState = "missing" | "preset" | "modified";

/** One naming rule. `match` is RegExp source, always compiled case-insensitively. */
export interface EnvTag { match: string; tone?: string | null; label?: string | null }

export interface EnvPreset { path: string; name: string; vars: number; mtimeMs: number; active: boolean }

/** One environment: a target file and the presets beside it. A monorepo has one per package. */
export interface EnvGroup { dir: string; target: string; state: EnvState; presets: EnvPreset[] }

/** A project's `[env]` table. A null field is one the project did not speak about. */
export interface EnvPolicy {
  targets: string[] | null;
  presets: string[] | null;
  ignore: string[] | null;
  tags: EnvTag[];
}

export interface EnvScan {
  groups: EnvGroup[];
  policy: EnvPolicy;
  policyReadable: boolean;
}

// ---------- preferences ----------

export interface EnvPrefs {
  enabled: boolean;
  /** The stage-header chip. The status-bar half is a `FOOT_SEGS` entry, like every other segment. */
  header: boolean;
  targets: string[];
  presets: string[];
  ignore: string[];
  tags: EnvTag[];
}

// Ordered, because the first rule that matches wins: `preprod` has to be asked before `prod`.
export const ENV_DEFAULT_TAGS: EnvTag[] = [
  { match: "preprod|pre-prod", tone: "warn" },
  { match: "prod|live", tone: "danger" },
  { match: "stag|uat|qa", tone: "warn" },
  { match: "dev|local|test", tone: "safe" },
];

export const ENV_DEFAULTS: EnvPrefs = {
  // Off until asked for: it reads files in every open checkout and puts a chip in the header,
  // and nobody installed Episko for this (Diagnostics ships the same way).
  enabled: false,
  header: true,
  // The root, one level under it, and the two nested layouts a JS monorepo uses. `*/.env` is
  // the one that earns its keep: `frontend/` beside `backend/` is the commonest shape there is,
  // and the alternative was every such repo reporting only what sits beside its root .env.
  targets: [".env", "*/.env", "apps/*/.env", "packages/*/.env", "services/*/.env"],
  presets: [".env.*", "*.env", "envs/*", "env/*"],
  // Suffixes, not exact names: `.env.hetzner.template` is as much a template as `.env.template`,
  // and a list of exact names offers it as an environment you could switch to.
  ignore: [".env.local", "*.example", "*.sample", "*.template", "*.bak"],
  tags: ENV_DEFAULT_TAGS,
};

const TONES: readonly string[] = ["danger", "warn", "safe", "none"];
const MAX_LIST = 24;
/** Long enough for anything hand-written, short enough that a pathological one cannot run away. */
export const ENV_RX_MAX = 200;

/** The filename alone. A local one-liner rather than ./format, so this module imports nothing. */
const fileOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// The fallback is narrowed too, and copied: a default that skipped the shaping would be a
// second shape of the same value, and the shared array would be one mutation from corrupt.
function strList(v: unknown, fallback: string[]): string[] {
  const src = Array.isArray(v) ? v : fallback;
  return src.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((s) => s.trim()).slice(0, MAX_LIST);
}

function tagList(v: unknown, fallback: EnvTag[]): EnvTag[] {
  const out: EnvTag[] = [];
  for (const t of Array.isArray(v) ? v : fallback) {
    const match = typeof (t as EnvTag)?.match === "string" ? (t as EnvTag).match.trim() : "";
    if (!match) continue;
    const tone = (t as EnvTag).tone;
    const label = (t as EnvTag).label;
    out.push({
      match: match.slice(0, ENV_RX_MAX),
      tone: typeof tone === "string" && TONES.includes(tone) ? tone : "warn",
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, 40) : null,
    });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/** Whatever came out of `localStorage` or a field in the dialog, made safe. */
export function clampEnvPrefs(p: Partial<EnvPrefs> | null | undefined): EnvPrefs {
  return {
    // `=== true`, not `!== false`: this one is off until somebody turns it on.
    enabled: p?.enabled === true,
    header: p?.header !== false,
    targets: strList(p?.targets, ENV_DEFAULTS.targets),
    presets: strList(p?.presets, ENV_DEFAULTS.presets),
    ignore: strList(p?.ignore, ENV_DEFAULTS.ignore),
    tags: tagList(p?.tags, ENV_DEFAULT_TAGS),
  };
}

/** The rules alone: what the dialog edits, and what a project's own table replaces. */
export type EnvRules = Pick<EnvPrefs, "targets" | "presets" | "ignore" | "tags">;

export const envRulesOf = (p: EnvPrefs): EnvRules =>
  ({ targets: p.targets, presets: p.presets, ignore: p.ignore, tags: p.tags });

/** A project's table read back as rules, falling through to the app's where it said nothing. */
export function rulesFrom(policy: EnvPolicy | null | undefined, fallback: EnvRules): EnvRules {
  return clampEnvPrefs({
    ...ENV_DEFAULTS,
    targets: policy?.targets ?? fallback.targets,
    presets: policy?.presets ?? fallback.presets,
    ignore: policy?.ignore ?? fallback.ignore,
    tags: policy?.tags?.length ? policy.tags : fallback.tags,
  });
}

export function isDefaultEnvRules(r: EnvRules): boolean {
  return JSON.stringify(clampEnvPrefs({ ...ENV_DEFAULTS, ...r }))
    === JSON.stringify(clampEnvPrefs(ENV_DEFAULTS));
}

// ---------- the rules ----------

// A rule is user-typed, so it may not compile at all; cached because the dialog recompiles the
// whole table on every keystroke of its live preview.
const rxCache = new Map<string, RegExp | null>();

/** The compiled rule, or null when the pattern is empty, over-long or not valid RegExp source. */
export function envRegex(src: string): RegExp | null {
  const key = src ?? "";
  const hit = rxCache.get(key);
  if (hit !== undefined) return hit;
  let rx: RegExp | null = null;
  if (key && key.length <= ENV_RX_MAX) {
    try { rx = new RegExp(key, "i"); } catch { rx = null; }
  }
  if (rxCache.size > 400) rxCache.clear();
  rxCache.set(key, rx);
  return rx;
}

export interface EnvMark {
  tone: EnvTone;
  /** What to show: the rule's own label when it gave one, else the preset's name. */
  label: string;
  /** The pattern that decided, for the tooltip. Empty when no rule matched. */
  rule: string;
}

/** The first rule that matches wins, which is why `ENV_DEFAULT_TAGS` is ordered. */
export function envMark(name: string, tags: EnvTag[]): EnvMark {
  for (const t of tags) {
    const rx = envRegex(t.match);
    if (!rx || !rx.test(name)) continue;
    const tone = typeof t.tone === "string" && TONES.includes(t.tone) ? t.tone as EnvTone : "warn";
    return { tone, label: t.label?.trim() || name, rule: t.match };
  }
  return { tone: "none", label: name, rule: "" };
}

/** The project's rules when it has any, else the app's. One answer, so every surface agrees. */
export function effectiveTags(prefs: EnvPrefs, scan: EnvScan | null): EnvTag[] {
  const own = scan?.policy?.tags;
  return own && own.length ? own : prefs.tags;
}

export type EnvSource = "project" | "app";

/** Which side each field came from, for the dialog's "where these rules live" line. */
export function envOrigin(policy: EnvPolicy | null | undefined): Record<keyof EnvPolicy, EnvSource> {
  return {
    targets: policy?.targets ? "project" : "app",
    presets: policy?.presets ? "project" : "app",
    ignore: policy?.ignore ? "project" : "app",
    tags: policy?.tags?.length ? "project" : "app",
  };
}

/** Whether the project said anything at all, which is what decides create against replace. */
export const hasProjectRules = (p: EnvPolicy | null | undefined): boolean =>
  Object.values(envOrigin(p)).some((s) => s === "project");

export const activePreset = (g: EnvGroup | null): EnvPreset | null => g?.presets.find((p) => p.active) ?? null;

/** The one state that destroys something irreplaceable: content no preset holds a copy of. */
export const needsBackup = (g: EnvGroup | null): boolean => g?.state === "modified";

export interface EnvChip { text: string; tone: EnvTone; title: string }

/** What one environment's chip would say. */
export function groupChip(g: EnvGroup, tags: EnvTag[]): EnvChip {
  if (g.state === "missing") {
    return { text: `no ${fileOf(g.target)}`, tone: "none", title: `${g.target} is not there · pick a preset to create it` };
  }
  if (g.state === "modified") {
    return {
      text: "modified", tone: "warn",
      title: `${g.target} matches no preset — it holds changes nothing else has a copy of`,
    };
  }
  const p = activePreset(g)!;
  const m = envMark(p.name, tags);
  const why = m.rule ? `\nmatched by /${m.rule}/i` : "";
  return { text: m.label, tone: m.tone, title: `${g.target} is ${p.path}${why}` };
}

export interface EnvRow { preset: EnvPreset; mark: EnvMark }

/** The picker's rows for one environment, and the dashboard card's, in one order. */
export function presetRows(g: EnvGroup, tags: EnvTag[]): EnvRow[] {
  return g.presets
    .map((preset) => ({ preset, mark: envMark(preset.name, tags) }))
    .sort((a, b) => a.preset.name.localeCompare(b.preset.name));
}

export interface EnvSection { group: EnvGroup; chip: EnvChip; rows: EnvRow[] }

/** Everything every surface draws, resolved once so the picker, the card and the chip agree. */
export function envSections(scan: EnvScan | null, prefs: EnvPrefs): EnvSection[] {
  if (!prefs.enabled || !scan) return [];
  const tags = effectiveTags(prefs, scan);
  return scan.groups.map((group) => ({ group, chip: groupChip(group, tags), rows: presetRows(group, tags) }));
}

// Which environment the one chip speaks for: the most worth knowing about, never the first
// found. `none` outranks `safe`, because an environment no rule claims is still unaccounted for.
const TONE_RANK: Record<EnvTone, number> = { danger: 3, warn: 2, none: 1, safe: 0 };

/** The chip for a whole checkout, which in a monorepo speaks for several environments. */
export function envChip(scan: EnvScan | null, prefs: EnvPrefs): EnvChip | null {
  const secs = envSections(scan, prefs);
  if (!secs.length) return null;
  const worst = [...secs].sort((a, b) => TONE_RANK[b.chip.tone] - TONE_RANK[a.chip.tone])[0];
  if (secs.length === 1) return worst.chip;
  return {
    text: `${worst.chip.text} +${secs.length - 1}`,
    tone: worst.chip.tone,
    title: secs.map((s) => `${s.group.target} → ${s.chip.text}`).join("\n"),
  };
}

export const isDanger = (c: EnvChip | null | undefined): boolean => c?.tone === "danger";

/** Where a new preset goes, learned from the ones already beside this target: a package that
 *  keeps them in `envs/` must not grow a `.env.mine` beside its target. "" when unusable. */
export function presetDest(g: EnvGroup, name: string): string {
  const safe = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  if (!safe) return "";
  const targetFile = fileOf(g.target);
  const model = g.presets[0]?.path ?? "";
  const cut = model.lastIndexOf("/");
  const dir = cut < 0 ? "" : `${model.slice(0, cut)}/`;
  const base = cut < 0 ? model : model.slice(cut + 1);
  if (base.startsWith(`${targetFile}.`)) return `${dir}${targetFile}.${safe}`;
  if (base.endsWith(".env")) return `${dir}${safe}.env`;
  if (base && !base.includes(".")) return `${dir}${safe}`;
  // Nothing to copy: beside the target itself, wherever that is.
  return `${g.dir ? `${g.dir}/` : ""}${targetFile}.${safe}`;
}
