// The GitHub half of the dashboard's rules — how open work is ordered, which issues
// triage dares suggest closing, and who already has one.
//
// No DOM and no Tauri, so it unit-tests in isolation like ./dash and ./claim;
// ./dashview owns the markup and ./dashboard the fetch. See test/ghwork.test.ts.

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

// ---------- ordering ----------

/// When something last moved, as a bucket. The overlay groups by these because "how
/// recent" is the only ordering that survives a repo with sixty open issues — a flat
/// list sorted by number tells you nothing about what is alive.
export type Bucket = "today" | "week" | "older";

const DAY = 86_400_000;

export function bucketOf(updatedAt: string, now: number): Bucket {
  const t = Date.parse(updatedAt);
  // An unparseable timestamp sorts oldest rather than newest: a row that quietly
  // claims to be from today would be the one thing you act on first.
  if (!Number.isFinite(t)) return "older";
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

/// The compact card shows this many, most recently active first. Issues and PRs
/// together: they were competing for the same rows, the enlarged view already showed
/// them as one list, and a kind chip separates them more cheaply than a heading.
export const CARD_ROWS = 4;
export function cardRows(threads: GhThread[]): GhThread[] {
  return [...threads].sort(byRecency).slice(0, CARD_ROWS);
}

// ---------- triage ----------

/// How quiet an issue has to be before it is worth asking about. Four days is longer
/// than a weekend and shorter than a sprint — below it, triage would nag about work
/// somebody put down on Friday.
export const STALE_DAYS = 4;

/// How many the card offers at once. Three, because triage is a side task: a list of
/// twenty is a chore, and a chore gets dismissed wholesale rather than considered.
export const TRIAGE_ROWS = 3;

/**
 * The quietest open issues worth asking about, quietest first.
 *
 * **Issues only, never pull requests.** A PR that has gone quiet needs review or a
 * rebase, not closing, and offering to close it would be actively wrong.
 *
 * **Drafts and assigned issues are left alone**: somebody has said they are on it,
 * and a bot second-guessing that is exactly the behaviour that makes a team switch
 * triage off. `kept` is the project's committed decision list — the whole point is
 * that a decision is made once, by anyone, and never surfaces again.
 */
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
    // Quietest first — the oldest is the one most likely to be genuinely done with.
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.number - b.number)
    .slice(0, limit);
}

/// How long an issue has been quiet, for the row's subtitle. Days, because an hour is
/// noise at this timescale and "quiet 3 weeks" is the fact that matters.
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

/// What the row shows instead of a ▶. A claim is a hint, never a lock — see ./claim —
/// so this only ever *describes*; nothing here refuses a dispatch.
export interface Holder {
  who: string;
  /// Yours, so the row can offer to jump to the pane rather than start a second agent.
  mine: boolean;
  /// A claim older than CLAIM_STALE_MS. Presenting a dead claim as live is the failure
  /// that makes people stop trusting the signal.
  stale: boolean;
}

/**
 * Who is on this, from the three signals that can say so.
 *
 * Order matters and is not arbitrary: **our own local ledger wins**, because it knows
 * a dispatch that has not been pushed anywhere yet; then an assignee, which is the
 * explicit human signal; then the `agent:` label, which only says *a machine* is on
 * it and cannot say whose. An assignee that is you still reads as yours.
 */
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

/// The comment Episko posts when closing a stale issue. Prefilled and editable — the
/// user sends it, so it has to read as something a person would write, and it has to
/// say what would make closing it wrong.
export function closeComment(t: GhThread, now: number): string {
  return `Closing as stale — ${quietFor(t.updated_at, now)}, and nothing seems to be waiting on it. `
    + `Reopen if that's wrong.`;
}

/// The sticky claim comment — ONE per thread, edited in place, so it says what is true
/// now rather than accumulating a log of every dispatch.
///
/// It says "hint, not a lock" out loud because that is the rule the whole module is
/// built on, and a machine comment that reads like a reservation is the one that makes
/// a team switch claiming off.
export function claimComment(who: string, now: number): string {
  return `🤖 An agent${who ? ` from @${who}` : ""} started work on this on ${isoDay(now)}.\n\n`
    + `This is a hint, not a lock — pick it up anyway if you want to, and say so here.`;
}

/// The same comment once the agent has stopped. The comment is *edited*, never deleted:
/// a claim that vanishes leaves a reader wondering whether they imagined it, and the
/// fact that something was attempted is worth more than a clean thread.
export function releaseComment(who: string, now: number): string {
  return `🤖 The agent${who ? ` from @${who}` : ""} working on this stopped on ${isoDay(now)}, `
    + `without pushing. Free to pick up.`;
}

/// Today, as `YYYY-MM-DD` local — what the keep list and shared notes record. Day
/// resolution on purpose: an hour adds nothing and churns the committed diff.
export function isoDay(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
