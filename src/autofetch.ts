// Auto-fetch: keeping "3 behind" true for the checkout on screen. Pure rules over an
// explicit `now`; ./panes owns the timer, the IPC and what counts as on screen.

export interface AutoFetchPrefs { enabled: boolean; everyMs: number }

// All minutes: a remote read is a network round trip, and below one the previous fetch can
// still be in flight when the next falls due.
export const AUTOFETCH_EVERY = [60_000, 300_000, 900_000, 1_800_000] as const;
export const AUTOFETCH_DEFAULTS: AutoFetchPrefs = { enabled: true, everyMs: 300_000 };

/** Whatever came out of `localStorage` (or the Settings picker), made safe. */
export function clampAutoFetchPrefs(p: Partial<AutoFetchPrefs> | null | undefined): AutoFetchPrefs {
  const every = Number(p?.everyMs);
  return {
    enabled: p?.enabled !== false,
    everyMs: (AUTOFETCH_EVERY as readonly number[]).includes(every) ? every : AUTOFETCH_DEFAULTS.everyMs,
  };
}

/** One repo's last attempt. Keyed by repo, never by checkout: worktrees share refs/remotes. */
export interface FetchState { at: number; ok: boolean; fails: number }

// An unreachable remote costs 45s of a backend worker before git gives up, and the usual
// cause (a laptop off the network) announces its return to nothing, so a failing repo is
// doubled out to ~a day rather than retried on the cadence.
export const FETCH_BACKOFF_MAX = 8;

export function fetchGapMs(p: AutoFetchPrefs, fails: number): number {
  return p.everyMs * 2 ** Math.min(Math.max(fails, 0), FETCH_BACKOFF_MAX);
}

/** Never fetched, or the gap has passed. A clock that jumped back is due, not stuck for hours. */
export function fetchDue(st: FetchState | undefined, p: AutoFetchPrefs, now: number): boolean {
  if (!p.enabled) return false;
  if (!st) return true;
  return now < st.at || now - st.at >= fetchGapMs(p, st.fails);
}

export function noteFetch(st: FetchState | undefined, ok: boolean, now: number): FetchState {
  return { at: now, ok, fails: ok ? 0 : Math.min((st?.fails ?? 0) + 1, FETCH_BACKOFF_MAX) };
}
