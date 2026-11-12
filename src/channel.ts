// A preview build's storage rule: which `cc-` keys it keeps to itself, so going back to a stable
// build finds its settings as it left them (docs/releases.md § Preview builds). Pure: the store is
// handed in. test/channel.test.ts holds every key in exactly one of the two lists.

export type Channel = "stable" | "preview";
/** `own`: a preview reads stable's value until it writes its own. `shared`: one copy, written through. */
export type Carry = "own" | "shared";

// What you choose. Every synced pref is here, which is why a preview never sends one.
const OWN = [
  "cc-keys", "cc-sound", "cc-motion", "cc-foot", "cc-title", "cc-term-engine", "cc-term-font", "cc-term-split",
  "cc-drift-auto", "cc-copy-chord", "cc-close-ask", "cc-agent", "cc-diff-mode", "cc-diff-tree", "cc-scrollback",
  "cc-sort", "cc-fleet-sort", "cc-fleet-layout", "cc-fleet-group", "cc-fleet-range", "cc-peek", "cc-outline",
  "cc-markdown", "cc-pr-links", "cc-shelved-tree", "cc-worktree-group", "cc-dash-summaries",
  "cc-perm-modes", "cc-perm-mode", "cc-trusted", "cc-autofetch", "cc-proj-prefs", "cc-agent-tools",
  "cc-task-prefs", "cc-task-onstop", "cc-task-runner", "cc-task-pins", "cc-task-hidden", "cc-revive", "cc-attn",
  "cc-caffeinate", "cc-caf-timer", "cc-caf-await", "cc-memory-sync", "cc-vitals", "cc-pane-priority",
  // A preview's version is not stable's, so What's new keeps a separate tally for each.
  "cc-seen-versions", "cc-seen-version",
];

// What a return to stable must not lose: spend, sessions, notes, accounts, projects and sync's books.
const SHARED = [
  "cc-usage", "cc-usage-detail", "cc-io", "cc-usage-tokens", "cc-agent-usage-tokens", "cc-usage-tokens-at",
  "cc-cost-base", "cc-agent-token-base", "cc-cmp-base", "cc-forecast-log", "cc-rl-accounts", "cc-claude-accounts",
  "cc-favorites", "cc-proj-order", "cc-proj-groups", "cc-custom-icons", "cc-colors", "cc-agent-by-project",
  "cc-gh-account", "cc-episko-share", "cc-proj-ids", "cc-icons", "cc-icons-v",
  "cc-restore", "cc-handoff", "cc-notes", "cc-team-notes", "cc-claims", "cc-team-claims", "cc-review-drafts",
  "cc-review-viewed", "cc-task-inputs", "cc-digest-ok", "cc-digest-no", "cc-dash-seen", "cc-branch-lists", "cc-frecency", "cc-tour",
  "cc-legacy-import-done", "cc-channel",
  // Shared, or a preview that went back to stable would leave stable asking for the preview again.
  "cc-update-channel",
  "cc-usage-peers", "cc-detail-peers", "cc-sync-stamps", "cc-sync-dirty", "cc-sync-sent", "cc-sync-limits",
  "cc-sync-seed", "cc-sync-roster", "cc-sync-devices", "cc-sync-pending", "cc-sync-exclude", "cc-sync-memory",
];

export const CARRY: Readonly<Record<string, Carry>> = Object.fromEntries([
  ...OWN.map((k) => [k, "own"] as const), ...SHARED.map((k) => [k, "shared"] as const),
]);
/** An unlisted key behaves as it does on stable. */
export const carryOf = (key: string): Carry => CARRY[key] ?? "shared";

export const PREVIEW_PREFIX = "preview:";
// A removal made in the preview, so stable's value does not show through again.
const GONE = "\u0000gone";

export interface Store { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }

const isolated = (channel: Channel, key: string) => channel === "preview" && carryOf(key) === "own";

/** The store as `channel` sees it. Stable's own keys are never written by a preview. */
export function overlay(base: Store, channel: Channel): Store {
  if (channel === "stable") return base;
  return {
    get(k) {
      if (!isolated(channel, k)) return base.get(k);
      const v = base.get(PREVIEW_PREFIX + k);
      return v === null ? base.get(k) : v === GONE ? null : v;
    },
    set: (k, v) => (isolated(channel, k) ? base.set(PREVIEW_PREFIX + k, v) : base.set(k, v)),
    remove: (k) => (isolated(channel, k) ? base.set(PREVIEW_PREFIX + k, GONE) : base.remove(k)),
  };
}

/** Whether a write to `key` may go to the user's other machines. */
export const leaves = (key: string, channel: Channel): boolean => !isolated(channel, key);

export interface ChannelMark { channel: Channel; version: string; since: number }
/** `cc-channel`: which build last ran here, and since when it has been that channel. */
export function nextMark(prev: unknown, channel: Channel, version: string, now: number): ChannelMark {
  const p = prev && typeof prev === "object" ? (prev as Partial<ChannelMark>) : {};
  const since = p.channel === channel && typeof p.since === "number" && Number.isFinite(p.since) ? p.since : now;
  return { channel, version, since };
}

/** The build that ran here last, when it was the other channel: the run to offer settings across. */
export function switchedFrom(prev: unknown, channel: Channel): Channel | null {
  const c = prev && typeof prev === "object" ? (prev as Partial<ChannelMark>).channel : undefined;
  return (c === "stable" || c === "preview") && c !== channel ? c : null;
}

/** The settings a preview holds a value of its own for, that stable's value differs from. */
export function differing(base: Store): string[] {
  return OWN.filter((k) => {
    const p = base.get(PREVIEW_PREFIX + k);
    return p !== null && (p === GONE ? null : p) !== base.get(k);
  });
}
/** Stable takes the preview's values, and the preview's copies go, since they would say the same. */
export function adopt(base: Store, keys: readonly string[]) {
  for (const k of keys) {
    const p = base.get(PREVIEW_PREFIX + k);
    if (p === null) continue;
    if (p === GONE) base.remove(k); else base.set(k, p);
    base.remove(PREVIEW_PREFIX + k);
  }
}
/** The preview forgets its own values and reads stable's again. */
export function drop(base: Store, keys: readonly string[]) {
  for (const k of keys) base.remove(PREVIEW_PREFIX + k);
}

/** `cc-update-channel`: what a person chose. A build nobody chose for is on its own channel. */
export const parseChannel = (raw: string | null, fallback: Channel): Channel =>
  raw === "stable" || raw === "preview" ? raw : fallback;
export const isPreviewVersion = (version: string) => version.includes("-preview.");
/** What an offered update does, as the footer chip says it. */
export function updateVerb(build: Channel, want: Channel, version: string): string {
  const pre = isPreviewVersion(version);
  if (pre && build === "stable") return `switch to preview v${version}`;
  if (!pre && build === "preview" && want === "stable") return `back to stable v${version}`;
  return `update to v${version}`;
}
