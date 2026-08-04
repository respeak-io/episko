import { describe, it, expect, beforeEach } from "vitest";
import { store } from "./localstorage"; // must precede the subject import
import {
  ALLOW_ALL, CLAIM_STALE_MS, claimForSession, claimIsStale, claims, claimText,
  DEFAULT_POLICY, dropClaim, policyWritesAnything, recordClaim, reloadClaims,
  resolveClaim, type ClaimAllow, type ClaimPolicy,
} from "../src/claim";

const policy = (over: Partial<ClaimPolicy> = {}): ClaimPolicy => ({ ...DEFAULT_POLICY, ...over });
const allow = (over: Partial<ClaimAllow> = {}): ClaimAllow => ({ ...ALLOW_ALL, ...over });

beforeEach(() => {
  store.clear();
  reloadClaims();
  claims.length = 0;
});

describe("the project is a ceiling, not a default", () => {
  it("lets a project switch assignment off for everyone, keeping the rest", () => {
    // The case that motivated the two levels: plenty of teams use assignment as a
    // human planning signal, and an agent stomping it on every speculative run is a
    // real cost — but they may still want the comment.
    const r = resolveClaim(policy({ assign: true, comment: true }), allow({ assign: false }));
    expect(r.assign.value).toBe(false);
    expect(r.assign.source).toBe("project");
    expect(r.comment.value).toBe(true);
    expect(r.comment.source).toBe("personal");
  });

  it("cannot turn anything ON that you did not ask for", () => {
    // A ceiling only ever lowers. A project must not be able to make your machine
    // start commenting on issues because it said so.
    const r = resolveClaim(policy({ assign: false, comment: false }), ALLOW_ALL);
    expect([r.assign.value, r.comment.value]).toEqual([false, false]);
  });

  it("blames the project only when the project is actually the reason", () => {
    // Off because you left it off is yours; off because you were refused is theirs.
    // The settings tab shows this, so getting it backwards would lie to the user.
    expect(resolveClaim(policy({ comment: false }), allow({ comment: false })).comment.source).toBe("personal");
    expect(resolveClaim(policy({ comment: true }), allow({ comment: false })).comment.source).toBe("project");
  });

  it("treats a project with no policy as permitting everything", () => {
    // A repo that never heard of Episko must not silently disable features.
    const r = resolveClaim(policy({ assign: true, comment: true, label: "agent: running" }));
    expect(policyWritesAnything(r)).toBe(true);
    expect(r.label.value).toBe("agent: running");
  });

  it("gates the label like the booleans", () => {
    const r = resolveClaim(policy({ label: "agent: running" }), allow({ label: false }));
    expect(r.label.value).toBe("");
    expect(r.label.source).toBe("project");
  });

  it("knows when a policy would write nothing at all", () => {
    const silent = resolveClaim(policy({ assign: false, comment: false, label: "" }));
    expect(policyWritesAnything(silent)).toBe(false);
  });

  it("defaults to assignment only — one call, reversible, no comment spam", () => {
    expect(DEFAULT_POLICY.assign).toBe(true);
    expect(DEFAULT_POLICY.comment).toBe(false);
  });
});

describe("claims expire", () => {
  const now = 1_000_000_000;

  it("is live inside the window and stale outside it", () => {
    expect(claimIsStale(now - 1000, now)).toBe(false);
    expect(claimIsStale(now - CLAIM_STALE_MS - 1, now)).toBe(true);
  });

  it("says so in the text, rather than presenting a dead claim as live", () => {
    expect(claimText("Frederic", now - 5 * 60_000, now)).toBe("Frederic is on this · 5m ago");
    expect(claimText("Frederic", now - 3 * 3600_000, now)).toMatch(/probably stale/);
  });

  it("reads sensibly at the boundaries", () => {
    expect(claimText("FA", now, now)).toContain("just now");
    expect(claimText("FA", now - 90 * 60_000, now)).toContain("2h ago");
  });
});

describe("the ledger of what we claimed", () => {
  const rec = (over: Partial<Parameters<typeof recordClaim>[0]> = {}) => ({
    threadId: "issue:33", root: "/w/episko", number: 33, kind: "issue" as const,
    sessionId: "s1", at: 1000, ...over,
  });

  it("remembers a claim so an exit can release exactly the right one", () => {
    recordClaim(rec());
    expect(claimForSession("s1")?.number).toBe(33);
    expect(claimForSession("nope")).toBeNull();
  });

  it("keeps one record per thread — re-claiming replaces, never duplicates", () => {
    recordClaim(rec());
    recordClaim(rec({ sessionId: "s2" }));
    expect(claims).toHaveLength(1);
    expect(claimForSession("s2")?.number).toBe(33);
    expect(claimForSession("s1")).toBeNull();
  });

  it("returns what it dropped, so the release call knows the repo and number", () => {
    recordClaim(rec());
    const gone = dropClaim("issue:33");
    expect(gone).toMatchObject({ root: "/w/episko", number: 33, kind: "issue" });
    expect(dropClaim("issue:33")).toBeNull();
  });

  it("persists, because a claim outlives the window that made it", () => {
    recordClaim(rec());
    expect(JSON.parse(store.get("cc-claims")!)).toHaveLength(1);
  });

  it("survives a corrupt store rather than taking the app down at import", () => {
    store.set("cc-claims", "{not json");
    reloadClaims();
    expect(claims).toEqual([]);
  });
});
