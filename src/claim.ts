// Claiming — what Episko writes down when you dispatch an agent at shared work, and
// who gets to decide. No DOM and no Tauri, so it unit-tests like ./thread and ./trail.
//
// THE PROBLEM IT SOLVES. A colleague dispatching an agent is invisible to you and has
// to be: Episko's telemetry server binds to localhost, live pane state is deliberately
// never committed, and git only knows what has been *pushed*. So between "Frederic
// dispatched" and "Frederic pushed" there is a blind window of minutes to hours — and
// that window is exactly when two people pick up the same issue. A claim collapses it
// to one fetch interval by writing the dispatch somewhere shared.
//
// THREE RULES, and they are what keep this from becoming the annoying-bot problem:
//
//   1. **A claim is a hint, never a lock.** Nothing here refuses a dispatch. Someone
//      else's claim is shown, warned about once, and then you proceed — two people
//      may well both want a go at a hard bug. Same instinct as `blocked: Some(reason)`
//      rendering greyed instead of vanishing.
//   2. **Claims expire.** A claim carries a timestamp and reads as stale after
//      CLAIM_STALE_MS. A laptop that went to sleep must not block a colleague forever;
//      skip this and the feature rots into a graveyard of dead claims.
//   3. **Two levels decide, and the project is a ceiling.** What *you* do on dispatch
//      is personal (`cc-claim-prefs`). What the *project* permits is committed
//      (`.episko/episko.toml`). Assignment in particular is a human planning signal in
//      plenty of teams, so a project must be able to switch it off for everyone while
//      leaving the rest on — the effective setting is the AND of the two.

/// What Episko can write when you dispatch. Each is independent: a team may want a
/// comment and no assignment, or a label and nothing else.
export interface ClaimPolicy {
  /// `gh issue edit N --add-assignee @me`. The native "I'm on this".
  assign: boolean;
  /// One comment per thread, EDITED in place (`--edit-last --create-if-none`), never
  /// appended. The difference between a useful bot and an annoying one.
  comment: boolean;
  /// Push the dispatch branch immediately, so the claim and the presence signal become
  /// the same mechanism — `for-each-ref` already reads it. Off by default: whether a
  /// bare branch push starts CI is repo-dependent.
  pushBranch: boolean;
  /// A label like `agent: running`. Empty means off. Distinct from `assign` on purpose:
  /// assignment says a *human* owns this, a label says a *machine* is on it right now.
  label: string;
}

export const DEFAULT_POLICY: ClaimPolicy = {
  assign: true,      // one API call, reversible, and the clearest signal there is
  comment: false,    // expressive but social — opt in
  pushBranch: false, // repo-dependent (CI triggers)
  label: "",
};

/// What a project permits, from `.episko/episko.toml`. **Absent means everything is
/// allowed** — a project that has never heard of Episko must not silently disable
/// features, and a missing file is not a policy.
export interface ClaimAllow {
  assign: boolean;
  comment: boolean;
  pushBranch: boolean;
  label: boolean;
}
export const ALLOW_ALL: ClaimAllow = { assign: true, comment: true, pushBranch: true, label: true };

/// Where an effective value came from — so the settings tab can say *why* something is
/// off, rather than showing a switch that silently does nothing when you flip it.
export type PolicySource = "personal" | "project";
export interface Resolved<T> { value: T; source: PolicySource }
export interface ResolvedPolicy {
  assign: Resolved<boolean>;
  comment: Resolved<boolean>;
  pushBranch: Resolved<boolean>;
  label: Resolved<string>;
}

/**
 * The effective policy: your preference, bounded by what the project permits.
 *
 * `source` is "project" only when the project is the reason a value is off — i.e. when
 * you asked for it and were refused. A value you simply left off is yours.
 */
export function resolveClaim(personal: ClaimPolicy, allow: ClaimAllow = ALLOW_ALL): ResolvedPolicy {
  const bool = (want: boolean, permitted: boolean): Resolved<boolean> =>
    want && !permitted ? { value: false, source: "project" } : { value: want, source: "personal" };
  return {
    assign: bool(personal.assign, allow.assign),
    comment: bool(personal.comment, allow.comment),
    pushBranch: bool(personal.pushBranch, allow.pushBranch),
    label: personal.label && !allow.label
      ? { value: "", source: "project" }
      : { value: personal.label, source: "personal" },
  };
}

/** Does the effective policy write anything at all? */
export function policyWritesAnything(r: ResolvedPolicy): boolean {
  return r.assign.value || r.comment.value || r.pushBranch.value || !!r.label.value;
}

// ---------- staleness ----------

/// After this long with no refresh a claim is advisory only. Thirty minutes is longer
/// than a normal turn and far shorter than a working day, which is the window that
/// makes "someone is on this" true rather than merely recorded.
export const CLAIM_STALE_MS = 30 * 60_000;

export function claimIsStale(claimedAt: number, now = Date.now()): boolean {
  return now - claimedAt > CLAIM_STALE_MS;
}

/// How a claim reads on a row. A stale claim says so — presenting a dead claim as live
/// is the failure that makes people stop trusting the signal.
export function claimText(who: string, claimedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - claimedAt) / 60_000));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  return claimIsStale(claimedAt, now) ? `${who} claimed this ${ago} — probably stale` : `${who} is on this · ${ago}`;
}

// ---------- the local ledger ----------
// What *we* claimed, so it can be released when the agent ends. Machine-local by
// definition — it is a list of this machine's outstanding promises, meaningless to a
// teammate — so it lives in localStorage rather than in any committed file.

export interface ClaimRecord {
  /// The thread this claim belongs to, so releasing needs no re-derivation.
  threadId: string;
  root: string;
  number: number;
  kind: "issue" | "pr";
  /// The session that took it, so an exit can release exactly the right claim.
  sessionId: string;
  at: number;
}

const LEDGER = "cc-claims";

function readLedger(): ClaimRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER) || "[]");
    return Array.isArray(raw) ? raw.filter((r): r is ClaimRecord => !!r && typeof r.threadId === "string") : [];
  } catch {
    return [];
  }
}

export let claims: ClaimRecord[] = readLedger();
function save() { localStorage.setItem(LEDGER, JSON.stringify(claims)); }

export function recordClaim(rec: ClaimRecord): void {
  claims = claims.filter((c) => c.threadId !== rec.threadId);
  claims.push(rec);
  save();
}

/** The claim a session took, if any — what an exit needs in order to release it. */
export function claimForSession(sessionId: string): ClaimRecord | null {
  return claims.find((c) => c.sessionId === sessionId) ?? null;
}

export function dropClaim(threadId: string): ClaimRecord | null {
  const i = claims.findIndex((c) => c.threadId === threadId);
  if (i < 0) return null;
  const [c] = claims.splice(i, 1);
  save();
  return c;
}

/// Test seam, matching ./notes: the store is read once at import like its neighbours.
export function reloadClaims(): void { claims = readLedger(); }
