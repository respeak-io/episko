// Claude subscriptions in priority order (docs/accounts.md): the store, its repair, which one a
// launch takes, and the token read back off a `claude setup-token` pane. An entry names a label
// whose token accounts.rs holds; the token itself never reaches the webview.

export interface ClaudeAcct { label: string; on: boolean }
/** What ./rl last saw for one account; `hitUntil` is a refused turn the windows did not show. */
export interface AcctReading { h5: number | null; h5Reset: number | null; d7: number | null; d7Reset: number | null; hitUntil?: number }

const MAX_ACCTS = 8; // ./rl keeps a slot per account, with room left for the login's
// accounts.rs's `valid_label`: the label is a keychain account and a file name.
export const validLabel = (l: unknown): l is string => typeof l === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(l);

export function clampAccts(raw: unknown): ClaudeAcct[] {
  const out: ClaudeAcct[] = [];
  for (const a of Array.isArray(raw) ? raw : []) {
    const label = (a as Partial<ClaudeAcct> | null)?.label;
    if (!validLabel(label) || out.some((x) => x.label === label)) continue;
    out.push({ label, on: (a as Partial<ClaudeAcct>).on !== false });
    if (out.length >= MAX_ACCTS) break;
  }
  return out;
}

export function addAcct(list: ClaudeAcct[], label: string): ClaudeAcct[] {
  if (!validLabel(label) || list.some((a) => a.label === label) || list.length >= MAX_ACCTS) return list;
  return [...list, { label, on: true }];
}
export const removeAcct = (list: ClaudeAcct[], label: string) => list.filter((a) => a.label !== label);
export const toggleAcct = (list: ClaudeAcct[], label: string) => list.map((a) => (a.label === label ? { ...a, on: !a.on } : a));
export function moveAcct(list: ClaudeAcct[], label: string, by: -1 | 1): ClaudeAcct[] {
  const i = list.findIndex((a) => a.label === label), j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// A session started at 99% gets one turn at best, so that counts as full.
export const FULL_PCT = 99;
/** Full until its window resets; a window with no reset time stays full until the next reading. */
export function acctFull(r: AcctReading | null, now: number): boolean {
  if (!r) return false; // never seen: worth a try
  if ((r.hitUntil ?? 0) > now) return true;
  const full = (p: number | null, reset: number | null) => p != null && p >= FULL_PCT && (reset == null || reset * 1000 > now);
  return full(r.h5, r.h5Reset) || full(r.d7, r.d7Reset);
}

/**
 * Whether a launch can use the account at all: its token was there when last listed (`found` is
 * null before the first listing) and its last Check did not fail. A pick never lands on a 401.
 */
export function acctReady(label: string, check: { ok: boolean; busy?: boolean } | undefined, found: string[] | null): boolean {
  if (found && !found.includes(label)) return false;
  return !check || check.ok || !!check.busy;
}

/** The account a new session starts on: the first switched on, ready and not full. Null is the login. */
export function pickAcct(list: ClaudeAcct[], readingOf: (label: string) => AcctReading | null, now: number, skip?: string, ready: (label: string) => boolean = () => true): ClaudeAcct | null {
  return list.find((a) => a.on && a.label !== skip && ready(a.label) && !acctFull(readingOf(a.label), now)) ?? null;
}

/**
 * Whether a refused turn was the quota rather than a passing 429, which `rate_limit` also names:
 * the message gives a reset time, or a window was nearly full already.
 */
export function quotaHit(detail: string, r: AcctReading | null): boolean {
  return /\bresets?\b|usage limit/i.test(detail) || Math.max(r?.h5 ?? 0, r?.d7 ?? 0) >= 90;
}

const SHORT_HOLD_MS = 15 * 60_000;
/** How long a refused turn keeps an account out of the pick: the quota to its 5h reset (an hour if unknown), a passing 429 a quarter of an hour. */
export function hitUntil(r: AcctReading | null, now: number, quota = true): number {
  if (!quota) return now + SHORT_HOLD_MS;
  const reset = r?.h5Reset != null ? r.h5Reset * 1000 : 0;
  return reset > now ? reset : now + 3_600_000;
}

const TOKEN_START = /sk-ant-oat01-[A-Za-z0-9_-]+/;
const TOKEN_ONLY = /^[A-Za-z0-9_-]+$/;
/**
 * The token `claude setup-token` printed, from a pane's lines (soft wraps joined). A hard wrap
 * continues on lines of nothing but token characters, and a token is whole only once something
 * follows it: a poll between the two halves of a wrap would otherwise save the first.
 */
export function tokenFromLines(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = TOKEN_START.exec(lines[i]);
    if (!m) continue;
    let tok = m[0], j = i + 1;
    if (lines[i].slice(m.index + tok.length).trim() === "") {
      for (; j < lines.length && TOKEN_ONLY.test(lines[j].trim()); j++) tok += lines[j].trim();
      if (!lines.slice(j).some((l) => l.trim())) return null;
    }
    return tok.length >= 100 ? tok : null;
  }
  return null;
}
