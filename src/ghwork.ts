// The GitHub half of the dashboard's rules: ordering, triage, who has what. No DOM, no Tauri;
// ./dashview owns the markup, ./dashboard the fetch. See docs/dashboard.md.

import { claimIsStale, type ClaimRecord } from "./claim";

/// One issue or PR, as `gh_threads` returns it. Mirrors the Rust struct.
export interface GhThread {
  number: number;
  kind: "issue" | "pr" | string;
  title: string;
  url: string;
  assignees: string[];
  labels: string[];
  branch: string | null;
  author: string | null;
  draft: boolean;
  updated_at: string;
}

export interface GhResult {
  available: boolean;
  reason: string | null;
  threads: GhThread[];
  viewer: string | null;
}

/// An issue the project has decided to keep, from `.episko/episko.toml`.
export interface KeptIssue { number: number; who: string; at: string }

// ---------- which of your GitHub accounts ----------

/// One github.com account `gh` is logged in to, as `gh_accounts` returns it.
export interface GhAccount { login: string; active: boolean }

// `gh` has one active account per host, and a private repo the other account owns reads like
// one that does not exist: hence a per-project pin. `known: false` = pinned but gh logged it out.
export interface GhWho {
  login: string | null;
  source: "pinned" | "active" | "none";
  known: boolean;
}

export function ghWho(pinned: string | null, accounts: GhAccount[]): GhWho {
  if (pinned) return { login: pinned, source: "pinned", known: accounts.some((a) => a.login === pinned) };
  const active = accounts.find((a) => a.active);
  return active
    ? { login: active.login, source: "active", known: true }
    : { login: null, source: "none", known: false };
}

export const ghPickable = (accounts: GhAccount[]): boolean => accounts.length > 1;

// ---------- ordering ----------

// "How recent" is the only ordering that survives sixty open issues.
export type Bucket = "today" | "week" | "older";

const DAY = 86_400_000;

export function bucketOf(updatedAt: string, now: number): Bucket {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return "older"; // never newest: a row falsely from today is acted on first
  const age = now - t;
  if (age < DAY) return "today";
  if (age < 7 * DAY) return "week";
  return "older";
}

/** Newest first, ties by number descending so a repaint never reorders. */
export function byRecency(a: GhThread, b: GhThread): number {
  const ta = Date.parse(a.updated_at), tb = Date.parse(b.updated_at);
  const va = Number.isFinite(ta) ? ta : 0, vb = Number.isFinite(tb) ? tb : 0;
  return vb - va || b.number - a.number;
}

/** The buckets in reading order, empty ones dropped. */
export function bucketed(threads: GhThread[], now: number): { bucket: Bucket; rows: GhThread[] }[] {
  const order: Bucket[] = ["today", "week", "older"];
  const by = new Map<Bucket, GhThread[]>(order.map((b) => [b, []]));
  for (const t of [...threads].sort(byRecency)) by.get(bucketOf(t.updated_at, now))!.push(t);
  return order.map((bucket) => ({ bucket, rows: by.get(bucket)! })).filter((g) => g.rows.length);
}

export const CARD_ROWS = 4;
export function cardRows(threads: GhThread[]): GhThread[] {
  return [...threads].sort(byRecency).slice(0, CARD_ROWS);
}

// ---------- narrowing the Open work view ----------
// Every filter ANDs, like GitHub's own label filter: a chip only ever narrows. `free` is a
// facet (nobody holds it), so it counts across kinds rather than beside them.

export type WorkKind = "all" | "iss" | "pr";

export interface WorkFilter {
  kind: WorkKind;
  labels: ReadonlySet<string>;
  free: boolean;
  query: string;
}

export const workKindOf = (t: GhThread): "iss" | "pr" => (t.kind === "pr" ? "pr" : "iss");

function queryHit(t: GhThread, terms: string[]): boolean {
  const hay = [`#${t.number}`, t.title, t.author ?? "", t.branch ?? "", ...t.labels].join(" ").toLowerCase();
  return terms.every((w) => hay.includes(w) || w.replace(/^#/, "") === String(t.number));
}

// `skip` leaves one dimension out, which is what a chip's count needs: what it WOULD show.
function passes(
  t: GhThread, f: WorkFilter, terms: string[], held: (t: GhThread) => boolean,
  skip?: "kind" | "labels" | "free",
): boolean {
  if (skip !== "kind" && f.kind !== "all" && workKindOf(t) !== f.kind) return false;
  if (skip !== "labels") for (const l of f.labels) if (!t.labels.includes(l)) return false;
  if (skip !== "free" && f.free && held(t)) return false;
  return !terms.length || queryHit(t, terms);
}

const termsOf = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

export function filterWork(threads: GhThread[], f: WorkFilter, held: (t: GhThread) => boolean): GhThread[] {
  const terms = termsOf(f.query);
  return threads.filter((t) => passes(t, f, terms, held));
}

export interface WorkTally {
  kinds: Record<WorkKind, number>;
  free: number;
  /** Every label worth a chip, in a stable order: most used across the whole board first. */
  labels: { name: string; n: number; on: boolean }[];
}

export function workTally(threads: GhThread[], f: WorkFilter, held: (t: GhThread) => boolean): WorkTally {
  const terms = termsOf(f.query);
  const kinds: Record<WorkKind, number> = { all: 0, iss: 0, pr: 0 };
  let free = 0;
  const use = new Map<string, number>();
  const n = new Map<string, number>();
  for (const t of threads) {
    for (const l of t.labels) use.set(l, (use.get(l) ?? 0) + 1);
    if (passes(t, f, terms, held, "kind")) { kinds.all++; kinds[workKindOf(t)]++; }
    if (passes(t, f, terms, held, "free") && !held(t)) free++;
    if (passes(t, f, terms, held)) for (const l of t.labels) n.set(l, (n.get(l) ?? 0) + 1);
  }
  // Ordered by the whole board, not the current counts, so a click never reshuffles the row
  // under the pointer. A picked label the refresh took away stays, so it can be unpicked.
  for (const l of f.labels) if (!use.has(l)) use.set(l, 0);
  const labels = [...use.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => ({ name, n: n.get(name) ?? 0, on: f.labels.has(name) }))
    .filter((l) => l.on || l.n);
  return { kinds, free, labels };
}

export const workFiltered = (f: WorkFilter): boolean =>
  f.kind !== "all" || f.labels.size > 0 || f.free || !!f.query.trim();

// ---------- triage ----------

export const STALE_DAYS = 4; // longer than a weekend, shorter than a sprint

export const TRIAGE_ROWS = 3; // a longer list is a chore, and a chore gets dismissed wholesale

// Quietest first. Issues only (a quiet PR needs review, not closing), unassigned, and not on
// the project's committed keep list, where a decision is made once by anyone.
export function staleCandidates(
  threads: GhThread[], kept: KeptIssue[], now: number, limit = TRIAGE_ROWS,
): GhThread[] {
  const skip = new Set(kept.map((k) => k.number));
  return threads
    .filter((t) => t.kind === "issue" && !skip.has(t.number) && !t.assignees.length)
    .filter((t) => {
      const at = Date.parse(t.updated_at);
      return Number.isFinite(at) && now - at >= STALE_DAYS * DAY;
    })
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.number - b.number)
    .slice(0, limit);
}

// Days, not hours: "quiet 3 weeks" is the fact that matters.
export function quietFor(updatedAt: string, now: number): string {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return "never touched";
  const d = Math.floor((now - t) / DAY);
  if (d < 1) return "quiet today";
  if (d < 30) return `quiet ${d} day${d === 1 ? "" : "s"}`;
  const m = Math.round(d / 30);
  return `quiet ${m} month${m === 1 ? "" : "s"}`;
}

// ---------- who has it ----------

// What the row shows instead of a ▶. A claim is a hint, never a lock (./claim), so this
// only describes; nothing here refuses a dispatch.
export interface Holder {
  who: string;
  mine: boolean;  // yours: the row offers to jump to the pane rather than start a second agent
  stale: boolean; // older than CLAIM_STALE_MS
}

// Our local ledger wins (it knows a dispatch not yet pushed), then an assignee, then the
// `agent:` label, which cannot say whose machine.
export function holderOf(
  t: GhThread, viewer: string | null, claims: ClaimRecord[], now: number,
): Holder | null {
  const mineRec = claims.find((c) => c.number === t.number && c.kind === (t.kind === "pr" ? "pr" : "issue"));
  if (mineRec) return { who: viewer || "you", mine: true, stale: claimIsStale(mineRec.at, now) };
  const who = t.assignees[0];
  if (who) return { who, mine: !!viewer && who === viewer, stale: false };
  if (t.labels.some((l) => l.toLowerCase().startsWith("agent:"))) {
    return { who: "an agent", mine: false, stale: false };
  }
  return null;
}

// Prefilled for the user to send, so it reads as a person's and says what would make it wrong.
export function closeComment(t: GhThread, now: number): string {
  return `Closing as stale after ${quietFor(t.updated_at, now)}, with nothing that seems to be waiting on it. `
    + `Reopen if that's wrong.`;
}

// ONE sticky comment per thread, edited in place. It says "hint, not a lock" out loud on purpose.
export function claimComment(who: string, now: number): string {
  return `🤖 An agent${who ? ` from @${who}` : ""} started work on this on ${isoDay(now)}.\n\n`
    + `This is only a hint. Pick it up anyway if you want to, and say so here.`;
}

// Edited, never deleted: the attempt is worth more than a clean thread.
export function releaseComment(who: string, now: number): string {
  return `🤖 The agent${who ? ` from @${who}` : ""} working on this stopped on ${isoDay(now)}, `
    + `without pushing. Free to pick up.`;
}

// Local `YYYY-MM-DD`; day resolution so the committed diff does not churn.
export function isoDay(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
