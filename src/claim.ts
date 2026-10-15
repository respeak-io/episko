// Claiming: what Episko writes when you dispatch an agent at shared work, and who
// decides. A claim is a hint, never a lock; it expires; and the project's
// `.episko/episko.toml` is a ceiling over personal prefs (docs/dashboard.md).

import type { BranchInfo } from "./branches";
import type { WtHead } from "./types";

/** What Episko can write when you dispatch; each is independent. */
export interface ClaimPolicy {
  assign: boolean;  // gh issue edit N --add-assignee @me
  comment: boolean; // one comment per thread, edited in place, never appended
  // No `pushBranch`: a dispatch may cut a branch, but nothing is on it to push until the agent works.
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

// ---------- where the agent runs ----------

/** The project's own folder, a checkout that already exists, or a worktree made for this. */
export type DispatchWhere =
  | { kind: "here" }
  | { kind: "wt"; path: string }
  | { kind: "new"; branch: string; base: string };

interface Thread { kind: string; number: number; title: string; branch: string | null }

/** A PR's own head branch; for an issue, `issue-<n>-` and the title's first few words. */
export function dispatchBranch(t: Thread): string {
  if (t.kind === "pr") return t.branch?.trim() || `pr-${t.number}`;
  const words = t.title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  let slug = "";
  for (const w of words) {
    if ((slug + "-" + w).length > 32) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  return slug ? `issue-${t.number}-${slug}` : `issue-${t.number}`;
}

/** Start-points for a new branch: the trunk, then remote refs, then locals that drift. */
export function dispatchBases(branches: BranchInfo[]): { name: string; note: string }[] {
  const out: { name: string; note: string }[] = [];
  const seen = new Set<string>();
  const add = (name: string, note: string) => { if (name && !seen.has(name)) { seen.add(name); out.push({ name, note }); } };
  add(branches.find((b) => b.base)?.base ?? "", "trunk");
  for (const b of branches) add(b.remote_ref || b.upstream, "remote");
  for (const b of branches) if (!b.remote) add(b.name, b.current ? "local · checked out here" : "local");
  // Empty asks `create_worktree` for the folder's HEAD, the one base that needs no branch list.
  if (!out.length) out.push({ name: "", note: "" });
  return out;
}

/** A PR starts from its own remote head when this clone has it; anything else from the trunk. */
export function defaultBase(t: Thread, bases: { name: string }[]): string {
  const head = t.kind === "pr" && t.branch ? bases.find((b) => b.name.endsWith(`/${t.branch}`)) : undefined;
  return (head ?? bases[0])?.name ?? "";
}

/** A checkout already on the branch this thread would get wins, so a re-dispatch lands beside
 *  its own earlier work; otherwise whatever kind of destination was picked last. */
export function defaultWhere(t: Thread, heads: WtHead[], last: "here" | "new", base: string): DispatchWhere {
  const branch = dispatchBranch(t);
  const on = heads.find((h) => h.exists && h.branch === branch);
  if (on) return on.is_main ? { kind: "here" } : { kind: "wt", path: on.path };
  return last === "new" ? { kind: "new", branch, base } : { kind: "here" };
}

/** Why `where` cannot be launched as it stands, in the user's words; `null` when it can. */
export function whereProblem(where: DispatchWhere, heads: WtHead[]): string | null {
  if (where.kind === "here") return null;
  if (where.kind === "wt") return heads.some((h) => h.path === where.path && h.exists) ? null : "That checkout is gone";
  const b = where.branch.trim();
  if (!b) return "Name the branch";
  if (/\s|\.\.|^[-/]|[/.]$|[~^:?*[\\]/.test(b)) return `${b} is not a branch name git accepts`;
  // git refuses a second checkout of one branch, and the existing one is the better answer anyway.
  const on = heads.find((h) => h.exists && h.branch === b);
  return on ? `${b} is already checked out${on.is_main ? " in this folder" : " in a worktree"}; pick that instead` : null;
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

// ---------- leases: a claim the sync server can expire (docs/sync.md) ----------
// Still a hint: shown, never enforced. It lives while its session does, renewed well inside
// LEASE_MS, so a crashed machine's claim lapses in minutes rather than CLAIM_STALE_MS.

export const LEASE_MS = 10 * 60_000;
export interface Lease { who: string; until: number }
export const leaseKey = (pid: string, kind: "issue" | "pr", number: number) => `${pid}|${kind}#${number}`;
export function narrowLease(v: unknown): Lease | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.who === "string" && typeof o.until === "number" && Number.isFinite(o.until) ? { who: o.who.slice(0, 80), until: o.until } : null;
}
export const leaseLive = (l: Lease | null | undefined, now: number): l is Lease => !!l && l.until > now;
/** A held lease is renewed once half its time has gone, so a missed tick never lets it lapse. */
export const leaseDue = (l: Lease | null | undefined, now: number) => !l || l.until - now < LEASE_MS / 2;

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
