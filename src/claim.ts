// Claiming: what Episko writes when you dispatch an agent at shared work, and who
// decides. A claim is a hint, never a lock; it expires; and the project's
// `.episko/episko.toml` is a ceiling over personal prefs (docs/dashboard.md).

/** What Episko can write when you dispatch; each is independent. */
export interface ClaimPolicy {
  assign: boolean;  // gh issue edit N --add-assignee @me
  comment: boolean; // one comment per thread, edited in place, never appended
  // No `pushBranch`: dispatch creates no branch to push, so the switch could never act.
  // Unlike `assign` (a human owns this), a label says a machine is on it now. Empty is off.
  label: string;
}

export const DEFAULT_POLICY: ClaimPolicy = {
  assign: true,   // one API call, reversible, and the clearest signal there is
  comment: false, // expressive but social — opt in
  label: "",
};

/** What a project permits, from `.episko/episko.toml`. Absent means everything is allowed. */
export interface ClaimAllow {
  assign: boolean;
  comment: boolean;
  label: boolean;
}
export const ALLOW_ALL: ClaimAllow = { assign: true, comment: true, label: true };

export type PolicySource = "personal" | "project";
export interface Resolved<T> { value: T; source: PolicySource }
export interface ResolvedPolicy {
  assign: Resolved<boolean>;
  comment: Resolved<boolean>;
  label: Resolved<string>;
}

/** `source` is "project" only when the project refused something you asked for. */
export function resolveClaim(personal: ClaimPolicy, allow: ClaimAllow = ALLOW_ALL): ResolvedPolicy {
  const bool = (want: boolean, permitted: boolean): Resolved<boolean> =>
    want && !permitted ? { value: false, source: "project" } : { value: want, source: "personal" };
  return {
    assign: bool(personal.assign, allow.assign),
    comment: bool(personal.comment, allow.comment),
    label: personal.label && !allow.label
      ? { value: "", source: "project" }
      : { value: personal.label, source: "personal" },
  };
}

export function policyWritesAnything(r: ResolvedPolicy): boolean {
  return r.assign.value || r.comment.value || !!r.label.value;
}

// What `gh_claim`/`gh_release` managed to write. Each part is best-effort, so a partial
// failure is normal; read it, since a claim that silently wrote nothing is worse than none.
export interface ClaimOutcome {
  assigned: boolean;
  commented: boolean;
  labeled: boolean;
  problems: string[]; // in the user's words, not gh's
}

// ---------- staleness ----------

/** Advisory-only after this: longer than a turn, far shorter than a working day. */
export const CLAIM_STALE_MS = 30 * 60_000;

export function claimIsStale(claimedAt: number, now = Date.now()): boolean {
  return now - claimedAt > CLAIM_STALE_MS;
}

export function claimText(who: string, claimedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - claimedAt) / 60_000));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  return claimIsStale(claimedAt, now) ? `${who} claimed this ${ago}, probably stale` : `${who} is on this · ${ago}`;
}

// ---------- the local ledger ----------
// What we claimed, to release when the agent ends. Machine-local, so localStorage.

export interface ClaimRecord {
  threadId: string;
  root: string;
  number: number;
  kind: "issue" | "pr";
  sessionId: string; // the session that took it; its exit releases the claim
  at: number;
  // What the claim actually wrote, so a release undoes exactly that. Absent (a ledger
  // from before this existed) means "unknown", which reads as "touch nothing".
  wrote?: { assigned: boolean; label: string };
  // Who signed the claim. Kept here because the release runs on `pty-exit`, long after
  // the dashboard may have moved to another project's GitHub half.
  who?: string;
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

// Test seam: the store is read once at import.
export function reloadClaims(): void { claims = readLedger(); }
