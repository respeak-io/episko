import { describe, expect, it } from "vitest";
import "./localstorage"; // must precede the subject imports
import { CLAIM_STALE_MS, type ClaimRecord } from "../src/claim";
import {
  bucketOf, bucketed, cardRows, closeComment, ghPickable, ghWho, holderOf, isoDay, quietFor,
  staleCandidates, STALE_DAYS, type GhAccount, type GhThread, type KeptIssue,
} from "../src/ghwork";

const NOW = new Date(2026, 6, 31, 14, 0, 0).getTime();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const th = (o: Partial<GhThread> = {}): GhThread => ({
  number: 1, kind: "issue", title: "a thing", url: "", assignees: [], labels: [],
  branch: null, author: null, draft: false, updated_at: ago(0), ...o,
});
const rec = (o: Partial<ClaimRecord> = {}): ClaimRecord => ({
  threadId: "t", root: "/w/epi", number: 1, kind: "issue", sessionId: "s", at: NOW, ...o,
});

describe("bucketOf", () => {
  it("splits by recency, which is the only ordering that survives 60 open issues", () => {
    expect(bucketOf(ago(0), NOW)).toBe("today");
    expect(bucketOf(ago(3), NOW)).toBe("week");
    expect(bucketOf(ago(20), NOW)).toBe("older");
  });
  it("sorts an unparseable timestamp oldest, never newest", () => {
    // A row quietly claiming to be from today is the one you would act on first.
    expect(bucketOf("", NOW)).toBe("older");
    expect(bucketOf("not a date", NOW)).toBe("older");
  });
});

describe("bucketed", () => {
  it("groups in reading order and drops the empty groups", () => {
    const g = bucketed([th({ number: 1, updated_at: ago(0) }), th({ number: 2, updated_at: ago(40) })], NOW);
    expect(g.map((x) => x.bucket)).toEqual(["today", "older"]);
  });
  it("orders newest first within a group, ties by number so a repaint never reorders", () => {
    const same = ago(2);
    const g = bucketed([th({ number: 5, updated_at: same }), th({ number: 9, updated_at: same })], NOW);
    expect(g[0].rows.map((r) => r.number)).toEqual([9, 5]);
  });
  it("keeps issues and PRs in one list — they compete for the same rows", () => {
    const g = bucketed([th({ number: 1, kind: "pr" }), th({ number: 2, kind: "issue" })], NOW);
    expect(g[0].rows).toHaveLength(2);
  });
});

describe("cardRows", () => {
  it("takes the four most recently active", () => {
    const rows = cardRows(Array.from({ length: 9 }, (_, i) => th({ number: i, updated_at: ago(i) })));
    expect(rows.map((r) => r.number)).toEqual([0, 1, 2, 3]);
  });
  it("does not mutate its input", () => {
    const list = [th({ number: 1, updated_at: ago(5) }), th({ number: 2, updated_at: ago(0) })];
    cardRows(list);
    expect(list.map((t) => t.number)).toEqual([1, 2]);
  });
});

describe("staleCandidates — what triage dares suggest", () => {
  const kept: KeptIssue[] = [];
  it("offers the quietest first", () => {
    const out = staleCandidates(
      [th({ number: 1, updated_at: ago(5) }), th({ number: 2, updated_at: ago(30) }), th({ number: 3, updated_at: ago(9) })],
      kept, NOW);
    expect(out.map((t) => t.number)).toEqual([2, 3, 1]);
  });

  it("NEVER offers a pull request", () => {
    // A quiet PR needs review or a rebase; offering to close it would be wrong.
    const out = staleCandidates([th({ number: 1, kind: "pr", updated_at: ago(40) })], kept, NOW);
    expect(out).toEqual([]);
  });

  it("leaves an assigned issue alone — somebody said they are on it", () => {
    const out = staleCandidates([th({ number: 1, updated_at: ago(40), assignees: ["FAbrahamDev"] })], kept, NOW);
    expect(out).toEqual([]);
  });

  it("respects the project's committed keep list, whoever added it", () => {
    const out = staleCandidates([th({ number: 24, updated_at: ago(40) })], [{ number: 24, who: "Frederic", at: "2026-07-01" }], NOW);
    expect(out).toEqual([]);
  });

  it("ignores anything touched inside the quiet threshold", () => {
    expect(staleCandidates([th({ updated_at: ago(STALE_DAYS - 1) })], kept, NOW)).toEqual([]);
    expect(staleCandidates([th({ updated_at: ago(STALE_DAYS) })], kept, NOW)).toHaveLength(1);
  });

  it("caps the list, because triage is a side task and a chore gets dismissed wholesale", () => {
    const many = Array.from({ length: 20 }, (_, i) => th({ number: i, updated_at: ago(10 + i) }));
    expect(staleCandidates(many, kept, NOW)).toHaveLength(3);
  });

  it("drops an unparseable timestamp rather than treating it as ancient", () => {
    // "Never touched" would otherwise top the list and be the first thing suggested.
    expect(staleCandidates([th({ updated_at: "" })], kept, NOW)).toEqual([]);
  });
});

describe("quietFor", () => {
  it("speaks days, then months", () => {
    expect(quietFor(ago(0), NOW)).toBe("quiet today");
    expect(quietFor(ago(1), NOW)).toBe("quiet 1 day");
    expect(quietFor(ago(9), NOW)).toBe("quiet 9 days");
    expect(quietFor(ago(60), NOW)).toBe("quiet 2 months");
  });
  it("says so plainly when there is no timestamp", () => {
    expect(quietFor("", NOW)).toBe("never touched");
  });
});

describe("holderOf — a hint, never a lock", () => {
  it("prefers our own ledger: it knows a dispatch nothing has been pushed for yet", () => {
    const h = holderOf(th({ number: 7 }), "tim", [rec({ number: 7 })], NOW);
    expect(h).toMatchObject({ mine: true, stale: false });
  });
  it("marks our own claim stale once it has aged out", () => {
    const h = holderOf(th({ number: 7 }), "tim", [rec({ number: 7, at: NOW - CLAIM_STALE_MS - 1 })], NOW);
    expect(h?.stale).toBe(true);
  });
  it("falls back to the assignee, and knows when that is you", () => {
    expect(holderOf(th({ assignees: ["fred"] }), "tim", [], NOW)).toMatchObject({ who: "fred", mine: false });
    expect(holderOf(th({ assignees: ["tim"] }), "tim", [], NOW)).toMatchObject({ who: "tim", mine: true });
  });
  it("reads an agent label as a machine, which cannot say whose", () => {
    expect(holderOf(th({ labels: ["agent: running"] }), "tim", [], NOW)).toMatchObject({ who: "an agent", mine: false });
  });
  it("is null when nobody has it", () => {
    expect(holderOf(th(), "tim", [], NOW)).toBeNull();
    expect(holderOf(th({ labels: ["bug"] }), "tim", [], NOW)).toBeNull();
  });
  it("does not confuse an issue with a PR of the same number", () => {
    expect(holderOf(th({ number: 7, kind: "pr" }), "tim", [rec({ number: 7, kind: "issue" })], NOW)).toBeNull();
  });
});

describe("closeComment", () => {
  it("says why, and says what would make it wrong", () => {
    const c = closeComment(th({ updated_at: ago(9) }), NOW);
    expect(c).toContain("quiet 9 days");
    expect(c.toLowerCase()).toContain("reopen");
  });
});

describe("isoDay", () => {
  it("is day resolution — an hour churns a committed diff for nothing", () => {
    expect(isoDay(new Date(2026, 6, 31, 23, 59).getTime())).toBe("2026-07-31");
    expect(isoDay(new Date(2026, 0, 5, 0, 1).getTime())).toBe("2026-01-05");
  });
});

// The two-account case. `gh` keeps one ACTIVE account per host and switches it globally, so a
// work identity and a personal one are only both right with a per-project answer; GitHub's
// "could not resolve to a Repository" names no account, so every surface says which it used.
describe("ghWho", () => {
  const ACCTS: GhAccount[] = [{ login: "octo", active: true }, { login: "octo-work", active: false }];

  it("follows gh's active account when the project pins nothing", () => {
    expect(ghWho(null, ACCTS)).toEqual({ login: "octo", source: "active", known: true });
  });

  it("uses the pin over the active account — that is the whole feature", () => {
    expect(ghWho("octo-work", ACCTS)).toEqual({ login: "octo-work", source: "pinned", known: true });
  });

  /// The distinction the row underneath the picker is made of: pinning the account that
  /// is *already* active changes nothing today and everything the day `gh auth switch`
  /// is run in a terminal, so the two must not read the same.
  it("tells a pin apart from the same login inherited", () => {
    expect(ghWho("octo", ACCTS).source).toBe("pinned");
    expect(ghWho(null, ACCTS).source).toBe("active");
  });

  /// A pin gh has forgotten (`gh auth logout`) stays in force: the backend refuses the
  /// read rather than quietly answering as somebody else, which is exactly what the pin
  /// was set to prevent. So it must still report as pinned, and say it is unknown — a
  /// silent fall-back would leave the picker ticking an account that is not being used.
  it("keeps a pin gh no longer knows, and marks it unknown", () => {
    expect(ghWho("gone", ACCTS)).toEqual({ login: "gone", source: "pinned", known: false });
  });

  it("has no answer at all when gh has no accounts", () => {
    expect(ghWho(null, [])).toEqual({ login: null, source: "none", known: false });
    // …but a pin still stands: gh being unreadable is not a reason to forget a setting.
    expect(ghWho("octo", [])).toMatchObject({ login: "octo", source: "pinned", known: false });
  });
});

describe("ghPickable", () => {
  it("offers the choice only where there is one", () => {
    expect(ghPickable([])).toBe(false);
    expect(ghPickable([{ login: "octo", active: true }])).toBe(false);
    expect(ghPickable([{ login: "octo", active: true }, { login: "octo-work", active: false }])).toBe(true);
  });
});
