import { describe, expect, it } from "vitest";
import {
  acctFull, acctReady, addAcct, clampAccts, FULL_PCT, hitUntil, moveAcct, pickAcct, quotaHit, removeAcct, toggleAcct, tokenFromLines, validLabel,
  type AcctReading, type ClaudeAcct,
} from "../src/accounts";

const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const HOUR = 3600;
const list: ClaudeAcct[] = [{ label: "max20", on: true }, { label: "max5", on: true }];
const reading = (o: Partial<AcctReading> = {}): AcctReading => ({ h5: null, h5Reset: null, d7: null, d7Reset: null, ...o });
const TOKEN = "sk-ant-oat01-" + "Ab3_-".repeat(19); // 108 characters, like a real one

describe("clampAccts — the stored order, repaired", () => {
  it("keeps valid labels once each, in order, and defaults to on", () => {
    expect(clampAccts([{ label: "max20" }, { label: "max5", on: false }, { label: "max20", on: false }]))
      .toEqual([{ label: "max20", on: true }, { label: "max5", on: false }]);
  });
  it("drops what a keychain account or a file name could not be", () => {
    expect(clampAccts([{ label: "has space" }, { label: "" }, { label: 5 }, null, "max20"])).toEqual([]);
    expect(clampAccts("garbage")).toEqual([]);
    expect(clampAccts(null)).toEqual([]);
  });
  it("holds at most eight, the slots ./rl keeps", () => {
    expect(clampAccts(Array.from({ length: 12 }, (_, i) => ({ label: `a${i}` })))).toHaveLength(8);
  });
});

describe("the mutators", () => {
  it("adds at the end, once, and only a valid label", () => {
    expect(addAcct(list, "pro").map((a) => a.label)).toEqual(["max20", "max5", "pro"]);
    expect(addAcct(list, "max5")).toBe(list);
    expect(addAcct(list, "bad label")).toBe(list);
  });
  it("moves within bounds and is a no-op at either end", () => {
    expect(moveAcct(list, "max5", -1).map((a) => a.label)).toEqual(["max5", "max20"]);
    expect(moveAcct(list, "max20", -1)).toBe(list);
    expect(moveAcct(list, "max5", 1)).toBe(list);
  });
  it("toggles and removes by label", () => {
    expect(toggleAcct(list, "max20")[0].on).toBe(false);
    expect(removeAcct(list, "max20").map((a) => a.label)).toEqual(["max5"]);
  });
  it("agrees with accounts.rs on what a label is", () => {
    expect(validLabel("work.max-5_b")).toBe(true);
    expect(validLabel("x".repeat(41))).toBe(false);
    expect(validLabel("a\"b")).toBe(false);
  });
});

describe("acctFull — when an account sits out", () => {
  it("is full at the threshold until that window resets", () => {
    expect(acctFull(reading({ d7: FULL_PCT, d7Reset: S + HOUR }), NOW)).toBe(true);
    expect(acctFull(reading({ d7: FULL_PCT - 1, d7Reset: S + HOUR }), NOW)).toBe(false);
    expect(acctFull(reading({ h5: 100, h5Reset: S - 60 }), NOW)).toBe(false); // already reset
  });
  it("a refused turn counts while its hold lasts", () => {
    expect(acctFull(reading({ h5: 20, hitUntil: NOW + 1 }), NOW)).toBe(true);
    expect(acctFull(reading({ h5: 20, hitUntil: NOW - 1 }), NOW)).toBe(false);
  });
  it("an account never seen is worth a try", () => {
    expect(acctFull(null, NOW)).toBe(false);
  });
});

describe("pickAcct — which account a new session takes", () => {
  const readings: Record<string, AcctReading> = {};
  const of = (l: string) => readings[l] ?? null;
  it("takes the first, then the next once the first is full, then the login", () => {
    expect(pickAcct(list, of, NOW)?.label).toBe("max20");
    readings.max20 = reading({ d7: 100, d7Reset: S + 5 * 24 * HOUR });
    expect(pickAcct(list, of, NOW)?.label).toBe("max5");
    readings.max5 = reading({ h5: 99.5, h5Reset: S + HOUR });
    expect(pickAcct(list, of, NOW)).toBeNull();
    delete readings.max20; delete readings.max5;
  });
  it("skips one switched off and the one a session is leaving", () => {
    expect(pickAcct([{ label: "max20", on: false }, list[1]], of, NOW)?.label).toBe("max5");
    expect(pickAcct(list, of, NOW, "max20")?.label).toBe("max5");
  });
  it("skips an account whose token is gone or whose last Check failed", () => {
    expect(acctReady("max20", undefined, null)).toBe(true); // not listed yet
    expect(acctReady("max20", undefined, ["max5"])).toBe(false);
    expect(acctReady("max20", { ok: false }, ["max20"])).toBe(false);
    expect(acctReady("max20", { ok: false, busy: true }, ["max20"])).toBe(true);
    expect(pickAcct(list, of, NOW, undefined, (l) => l !== "max20")?.label).toBe("max5");
  });
  it("tells the quota from a passing 429", () => {
    expect(quotaHit("You've hit your limit · resets 8pm", null)).toBe(true);
    expect(quotaHit("API Error: 429 rate_limit_error", reading({ h5: 40, d7: 20 }))).toBe(false);
    expect(quotaHit("API Error: 429 rate_limit_error", reading({ d7: 95 }))).toBe(true);
    expect(hitUntil(reading({ h5Reset: S + 2 * HOUR }), NOW, false)).toBe(NOW + 15 * 60_000);
  });
  it("holds a refused account to its 5h reset, or an hour when that is unknown", () => {
    expect(hitUntil(reading({ h5Reset: S + 2 * HOUR }), NOW)).toBe(NOW + 2 * HOUR * 1000);
    expect(hitUntil(reading({ h5Reset: S - 10 }), NOW)).toBe(NOW + HOUR * 1000);
    expect(hitUntil(null, NOW)).toBe(NOW + HOUR * 1000);
  });
});

describe("tokenFromLines — reading back what setup-token printed", () => {
  it("finds a token on one line", () => {
    expect(tokenFromLines(["", "  Your OAuth token:", `  ${TOKEN}`, "", "  Store this token securely."])).toBe(TOKEN);
  });
  it("joins a token the terminal broke across lines", () => {
    expect(tokenFromLines([`  ${TOKEN.slice(0, 72)}`, `  ${TOKEN.slice(72)}`, "", "Store this token securely."])).toBe(TOKEN);
  });
  it("stops at a line that is not all token characters", () => {
    expect(tokenFromLines([TOKEN, "Store this token securely."])).toBe(TOKEN);
  });
  it("waits for the rest of a token still being printed", () => {
    expect(tokenFromLines([TOKEN.slice(0, 60)])).toBeNull();
    expect(tokenFromLines(["claude setup-token", "Opening the browser…"])).toBeNull();
  });
  it("takes the last token on screen", () => {
    const other = TOKEN.replace("Ab3", "Zz9");
    expect(tokenFromLines([TOKEN, "", other, "", "~ %"])).toBe(other);
  });
  it("waits for something after a token that ends its line, or a poll mid-wrap saves half", () => {
    expect(tokenFromLines([TOKEN.slice(0, 104), ""])).toBeNull();
    expect(tokenFromLines([TOKEN, "", ""])).toBeNull();
    expect(tokenFromLines([TOKEN.slice(0, 104), TOKEN.slice(104), "~ %"])).toBe(TOKEN);
  });
});
