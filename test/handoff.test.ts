import { describe, it, expect } from "vitest";
import {
  capableDevices, clampBrief, gitChoices, handoffBusy, incomingByProject, lostOnHandoff, memoryOffer, narrowCaps,
  narrowInfo, narrowMeta, onCaps, readHandoffs, reduce, restorableFor, rowText, sendGate, targets,
  type HandoffCaps, type HandoffEv, type HandoffGit, type HandoffInfo, type HandoffRec, type Me,
} from "../src/handoff";
import type { Sess } from "../src/types";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ID = "11111111-2222-4333-8444-555555555555";
const RESUME = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ANNA: Me = { user: "anna", device: "a1" };
const BEN: Me = { user: "ben", device: "b1" };
const ON: HandoffCaps = { enabled: true, max_bytes: 64 << 20, part_bytes: 512 << 10, ttl_ms: 72 * HOUR };

const meta = (o: Record<string, unknown> = {}) => ({ v: 1, resume_id: RESUME, provider: "claude", project_id: "pid", title: "Fix the parser", ...o });
const info = (o: Partial<HandoffInfo> = {}): HandoffInfo => ({
  id: ID, from_user: "anna", from_device: "a1", to_user: "ben", to_device: null, state: "offered", taker: null,
  meta: meta(), size: 10, parts: 1, sha256: "ab", have: [], created: NOW, expires: NOW + 72 * HOUR, updated: NOW, ...o,
});
const out = (o: Partial<HandoffRec> = {}): HandoffRec => ({
  id: ID, dir: "out", resumeId: RESUME, peer: { user: "ben" }, state: "packing", at: NOW, ...o,
});
const ev = (i: Partial<HandoffInfo>): HandoffEv => ({ kind: "info", info: info(i) });
const run = (list: HandoffRec[], evs: HandoffEv[], me: Me, now = NOW) => evs.reduce((l, e) => reduce(l, e, me, now), list);

describe("reduce: the sender's record follows the server", () => {
  const steps: [Partial<HandoffInfo>, string][] = [
    [{ state: "uploading", updated: NOW + 1 }, "uploading"],
    [{ state: "offered", updated: NOW + 2 }, "offered"],
    [{ state: "claimed", taker: "b1", updated: NOW + 3 }, "claimed"],
    [{ state: "done", taker: "b1", updated: NOW + 4 }, "done"],
  ];
  it("walks packing → uploading → offered → claimed → done", () => {
    let l = [out()];
    for (const [i, want] of steps) {
      l = reduce(l, ev(i), ANNA, NOW);
      expect(l[0].state).toBe(want);
    }
  });
  for (const from of ["uploading", "offered", "claimed"] as const) {
    for (const end of ["declined", "recalled", "expired"] as const) {
      it(`ends ${from} → ${end} without dropping the record, and frees the session`, () => {
        const l = run([out({ state: from })], [ev({ state: end, updated: NOW + 5 })], ANNA);
        expect(l).toHaveLength(1);
        expect(l[0].state).toBe(end);
        expect(handoffBusy(l, RESUME)).toBeNull();
      });
    }
  }
  it("is idempotent: the same event twice is the same list", () => {
    for (const [i] of steps) {
      const once = reduce([out()], ev(i), ANNA, NOW);
      expect(reduce(once, ev(i), ANNA, NOW)).toEqual(once);
    }
  });
  it("ignores an event older than the one it already holds", () => {
    const l = run([out()], [ev({ state: "claimed", updated: NOW + 9 }), ev({ state: "offered", updated: NOW + 2 })], ANNA);
    expect(l[0].state).toBe("claimed");
  });
  it("rebuilds an open record it lost from the server's meta, never a closed one", () => {
    expect(reduce([], ev({ state: "offered" }), ANNA, NOW)[0]).toMatchObject({ dir: "out", resumeId: RESUME, peer: { user: "ben" } });
    expect(reduce([], ev({ state: "done", meta: {} }), ANNA, NOW)).toEqual([]);
  });
  it("does not touch a handoff between two other machines", () => {
    expect(reduce([], ev({ from_device: "a2", from_user: "anna", to_user: "carl" }), ANNA, NOW)).toEqual([]);
  });
  it("records progress per direction", () => {
    const l = reduce([out({ state: "uploading" })], { kind: "progress", id: ID, dir: "out", done: 2, total: 4 }, ANNA, NOW);
    expect(l[0].progress).toEqual({ done: 2, total: 4 });
    expect(reduce(l, { kind: "progress", id: ID, dir: "in", done: 3, total: 4 }, ANNA, NOW)).toEqual(l);
  });
  it("hands back an offer the server refused for good, and only notes a passing refusal", () => {
    const dead = reduce([out({ state: "uploading" })], { kind: "refused", id: ID, reason: "too_large", message: "too big" }, ANNA, NOW);
    expect(dead[0]).toMatchObject({ state: "refused", reason: "too big" });
    const passing = reduce([out({ state: "uploading" })], { kind: "refused", id: ID, reason: "quota", message: "full" }, ANNA, NOW);
    expect(passing[0]).toMatchObject({ state: "uploading", reason: "full" });
  });
  it("lets the server's word override a local `returned`", () => {
    expect(reduce([out({ state: "returned" })], ev({ state: "done" }), ANNA, NOW)[0].state).toBe("done");
  });
  it("never reopens a local `returned` or `refused` into an open state", () => {
    for (const st of ["returned", "refused"] as const) {
      expect(reduce([out({ state: st })], ev({ state: "offered", updated: NOW + 1 }), ANNA, NOW)[0].state).toBe(st);
    }
  });
  it("keeps an offer returned when a server with handoff off still lists it", () => {
    const off = onCaps([out({ state: "offered", info: info() })], { ...ON, enabled: false }, NOW);
    const l = reduce(off, { kind: "list", records: [info({ updated: NOW + 1 })] }, ANNA, NOW + 1);
    expect(l[0].state).toBe("returned");
    expect(handoffBusy(l, RESUME)).toBeNull();
  });
});

describe("reduce: the recipient's record", () => {
  it("appears on offered, is claimed, made ready, and stays done", () => {
    let l = reduce([], ev({ state: "offered" }), BEN, NOW);
    expect(l[0]).toMatchObject({ dir: "in", state: "offered", peer: { user: "anna", device: "a1" } });
    l = run(l, [ev({ state: "claimed", taker: "b1", updated: NOW + 1 }), { kind: "ready", id: ID }], BEN);
    expect(l[0].state).toBe("done");
    expect(run(l, [{ kind: "ready", id: ID }, ev({ state: "done", taker: "b1", updated: NOW + 2 })], BEN)[0].state).toBe("done");
  });
  it("never shows an unsealed upload", () => {
    expect(reduce([], ev({ state: "uploading" }), BEN, NOW)).toEqual([]);
  });
  it("matches the recipient's name without case, and respects a named device", () => {
    expect(reduce([], ev({ to_user: "Ben" }), BEN, NOW)).toHaveLength(1);
    expect(reduce([], ev({ to_device: "b2" }), BEN, NOW)).toEqual([]);
  });
  it("leaves when declined, recalled or expired, offered or claimed by me", () => {
    const offered = reduce([], ev({ state: "offered" }), BEN, NOW);
    const claimed = reduce(offered, ev({ state: "claimed", taker: "b1", updated: NOW + 1 }), BEN, NOW);
    expect(claimed[0].state).toBe("claimed");
    for (const l of [offered, claimed]) {
      for (const s of ["declined", "recalled", "expired"] as const) expect(reduce(l, ev({ state: s, taker: "b1", updated: NOW + 2 }), BEN, NOW)).toEqual([]);
    }
  });
  it("says another of my machines took it, then leaves once it closes", () => {
    let l = reduce([], ev({ state: "offered" }), BEN, NOW);
    l = reduce(l, ev({ state: "claimed", taker: "b2", updated: NOW + 1 }), BEN, NOW);
    expect(rowText(l[0], NOW, (d) => (d === "b2" ? "Laptop" : d)).tag).toBe("taken on Laptop");
    expect(reduce(l, ev({ state: "done", taker: "b2", updated: NOW + 2 }), BEN, NOW)).toEqual([]);
  });
});

describe("reduce: a list is the whole truth", () => {
  it("returns a sender's open record the server no longer holds", () => {
    const l = reduce([out({ state: "offered" }), out({ id: "x", state: "packing" })], { kind: "list", records: [] }, ANNA, NOW);
    expect(l.map((r) => r.state)).toEqual(["returned", "packing"]);
  });
  it("drops an incoming offer that is gone, but keeps a received blob", () => {
    const inc: HandoffRec = { id: "i1", dir: "in", resumeId: RESUME, peer: { user: "anna" }, state: "offered", at: NOW };
    const l = reduce([inc, { ...inc, id: "i2", state: "done" }], { kind: "list", records: [] }, BEN, NOW);
    expect(l.map((r) => r.id)).toEqual(["i2"]);
  });
  it("applies every record it carries, and twice is once", () => {
    const e: HandoffEv = { kind: "list", records: [info({ state: "claimed", taker: "b1" }), { junk: true }] };
    const once = reduce([out({ state: "offered" })], e, ANNA, NOW);
    expect(once[0].state).toBe("claimed");
    expect(reduce(once, e, ANNA, NOW)).toEqual(once);
  });
});

describe("onCaps: what the server's capabilities do to an open offer", () => {
  const open = [out({ state: "offered", info: info() }), out({ id: "p", state: "packing" }), out({ id: "d", state: "done" })];
  it("locks while the server cannot be heard, and unlocks on its next word", () => {
    const locked = onCaps(open, undefined, NOW);
    expect(locked[0].unknownSince).toBe(NOW);
    expect(handoffBusy(locked, RESUME)).toBe("outcome unknown until sync reconnects");
    expect(onCaps(locked, undefined, NOW + 5)[0].unknownSince).toBe(NOW);
    expect(onCaps(locked, ON, NOW + 5)[0].unknownSince).toBeUndefined();
  });
  it("returns every open offer when the server has handoff off", () => {
    expect(onCaps(open, { ...ON, enabled: false }, NOW).map((r) => r.state)).toEqual(["returned", "packing", "done"]);
  });
  it("returns an unknown offer only past its expiry plus an hour", () => {
    const locked = onCaps(open, null, NOW);
    expect(onCaps(locked, null, NOW + 72 * HOUR + HOUR - 1)[0].state).toBe("offered");
    expect(onCaps(locked, null, NOW + 72 * HOUR + HOUR + 1)[0].state).toBe("returned");
  });
});

describe("sendGate", () => {
  const ok = { claude: true, workdir: "/w/epi", canResume: true };
  it("names the first reason a session cannot go", () => {
    expect(sendGate({ ...ok, claude: false }, ON, true, 1)).toMatch(/Claude/);
    expect(sendGate({ ...ok, external: true }, ON, true, 1)).toMatch(/another terminal/);
    expect(sendGate({ ...ok, workdir: "" }, ON, true, 1)).toMatch(/folder/);
    expect(sendGate({ ...ok, canResume: false }, ON, true, 1)).toMatch(/resumed/);
    expect(sendGate(ok, ON, false, 1)).toMatch(/connected/);
    expect(sendGate(ok, undefined, true, 1)).toMatch(/doesn't know/);
    expect(sendGate(ok, { ...ON, enabled: false }, true, 1)).toMatch(/off/);
    expect(sendGate(ok, ON, true, 0)).toMatch(/No other machine/);
    expect(sendGate(ok, ON, true, 1)).toBeNull();
  });
});

describe("targets", () => {
  const devices = [
    { user: "anna", device: "a1", label: "This Mac" },
    { user: "anna", device: "a3", label: "Old PC" },
    { user: "anna", device: "a2", label: "Laptop" },
    { user: "ben", device: "b1", label: "Ben's Mac" },
    { user: "Ben", device: "b2", label: "Ben's PC" },
    { user: "carl", device: "c1", label: "Carl" },
  ];
  it("puts my other machines first, then one row per teammate, ready ones on top", () => {
    const t = targets(devices, new Set(["a2", "b2"]), ANNA, new Set(["b1"]));
    expect(t.map((x) => x.label)).toEqual(["Laptop", "Old PC", "ben", "carl"]);
    expect(t.find((x) => x.label === "Old PC")).toMatchObject({ mine: true, ready: false });
    expect(t.find((x) => x.user === "ben")).toMatchObject({ ready: true, online: true, mine: false });
    expect(t.find((x) => x.user === "ben")?.device).toBeUndefined();
    expect(t.find((x) => x.user === "carl")?.ready).toBe(false);
  });
  it("reads which devices speak handoff off the welcome", () => {
    expect([...capableDevices([{ device: "a", handoff: true }, { device: "b" }, null])]).toEqual(["a"]);
    expect(narrowCaps(undefined)).toBeUndefined();
    expect(narrowCaps({ enabled: false })?.enabled).toBe(false);
  });
});

describe("gitChoices", () => {
  const g = (o: Partial<HandoffGit> = {}): HandoffGit => ({
    kind: "clean", branch: "feat", upstream: "origin/feat", head: "abc", ahead: 0, dirty: 0, untracked: 0,
    remote: "origin", project_id: "pid", fetched: true, est_bytes: 1000, ...o,
  });
  it("presets nothing when the tree is dirty", () => {
    const c = gitChoices(g({ kind: "dirty", dirty: 2 }), ON.max_bytes);
    expect(c.preset).toBeNull();
    expect(c.options.map((o) => o.id)).toEqual(["branch", "bundle", "none"]);
  });
  it("presets a small unpushed history as a bundle and a big one as a branch", () => {
    expect(gitChoices(g({ kind: "unpushed", ahead: 2 }), ON.max_bytes).preset).toBe("bundle");
    expect(gitChoices(g({ kind: "unpushed", ahead: 2, est_bytes: 20 << 20 }), ON.max_bytes).preset).toBe("branch");
  });
  it("disables a bundle that is too large or too wide, and a branch with no remote", () => {
    const c = gitChoices(g({ kind: "unpushed", est_bytes: 100 << 20, remote: null }), ON.max_bytes);
    expect(c.options.find((o) => o.id === "bundle")?.disabled).toMatch(/Too large/);
    expect(c.options.find((o) => o.id === "branch")?.disabled).toMatch(/no remote/);
    expect(c.preset).toBeNull();
    expect(gitChoices(g({ kind: "dirty", untracked: 2001 }), 0).options[1].disabled).toMatch(/untracked/);
  });
  it("sends nothing for a pushed checkout or a folder that is no repo", () => {
    expect(gitChoices(g(), ON.max_bytes).preset).toBe("none");
    expect(gitChoices(g({ kind: "norepo" }), ON.max_bytes)).toMatchObject({ preset: "none", options: [{ id: "none" }] });
    expect(gitChoices(g({ kind: "detached" }), ON.max_bytes).options.map((o) => o.id)).toEqual(["bundle", "none"]);
    expect(gitChoices(g({ fetched: false }), ON.max_bytes).note).toMatch(/Couldn't reach/);
  });
});

describe("lostOnHandoff and memoryOffer", () => {
  it("counts jobs and the servers that will stop", () => {
    const s = { servers: [{ url: "http://localhost:5173" }, {}, { ended: 1, url: "http://x" }] } as unknown as Sess;
    expect(lostOnHandoff(s)).toEqual({ jobs: 1, servers: ["http://localhost:5173"] });
  });
  const files = [
    { name: "a.md", type: "project", description: "" }, { name: "b.md", type: "user", description: "" },
    { name: "c.md", type: "feedback", description: "" }, { name: "d.md", type: "reference", description: "" },
  ];
  it("offers a teammate project and reference memories only, unticked, suggestions marked", () => {
    const rows = memoryOffer(files, false, ["a.md", "b.md"]);
    expect(rows.map((r) => r.name)).toEqual(["a.md", "d.md"]);
    expect(rows.every((r) => !r.ticked)).toBe(true);
    expect(rows[0].suggested).toBe(true);
  });
  it("offers my own machine everything, the suggested ones ticked", () => {
    const rows = memoryOffer(files, true, ["c.md"]);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.ticked).map((r) => r.name)).toEqual(["c.md"]);
  });
});

describe("handoffBusy", () => {
  it("names who has it while it is out, and frees it once it came back", () => {
    expect(handoffBusy([out()], RESUME)).toBe("preparing for ben");
    expect(handoffBusy([out({ state: "offered" })], RESUME.toUpperCase())).toBe("sending to ben");
    expect(handoffBusy([out({ state: "claimed" })], RESUME)).toBe("ben is picking it up");
    expect(handoffBusy([out({ state: "done" })], RESUME)).toBe("handed to ben");
    for (const s of ["returned", "declined", "recalled", "expired", "refused"] as const) expect(handoffBusy([out({ state: s })], RESUME)).toBeNull();
    expect(handoffBusy([{ ...out({ state: "offered" }), dir: "in" }], RESUME)).toBeNull();
  });
  it("frees a settled send, and a session that came back after it was handed out", () => {
    expect(handoffBusy([out({ state: "done", settled: true })], RESUME)).toBeNull();
    const back: HandoffRec = { id: "i1", dir: "in", resumeId: RESUME, peer: { user: "ben" }, state: "done", at: NOW + 1 };
    expect(handoffBusy([out({ state: "done" }), back], RESUME)).toBeNull();
    expect(handoffBusy([{ ...back, at: NOW - 1 }, out({ state: "offered" })], RESUME)).toBe("sending to ben");
  });
});

describe("restorableFor and incomingByProject", () => {
  it("builds the roster row a received session resumes from", () => {
    const r = restorableFor(info({ updated: NOW + 7 }), { workdir: "/w/epi-feat", resume_id: RESUME, branch: "feat", worktree: true }, "new-id", "/w/epi");
    expect(r).toEqual({
      id: "new-id", resumeId: RESUME, provider: "claude", project: "epi", workdir: "/w/epi-feat", colorKey: "/w/epi",
      worktree: "feat", branch: "feat", title: "Fix the parser", lastActivity: NOW + 7,
    });
    expect(restorableFor(info(), { workdir: "/w/epi", resume_id: RESUME, branch: null, worktree: false }, "n", "/w/epi").worktree).toBeNull();
  });
  it("files incoming offers under their project's checkout, or under null when not cloned", () => {
    const l = reduce(reduce([], ev({}), BEN, NOW), ev({ id: "x", meta: meta({ project_id: "other" }) }), BEN, NOW);
    const m = incomingByProject(l, (pid) => (pid === "pid" ? ["/w/epi"] : []));
    expect(m.get("/w/epi")?.map((r) => r.id)).toEqual([ID]);
    expect(m.get(null)?.map((r) => r.id)).toEqual(["x"]);
  });
});

describe("narrowing", () => {
  it("reads garbage, null, [] and stale records as nothing", () => {
    expect(readHandoffs("x", NOW)).toEqual([]);
    expect(readHandoffs(null, NOW)).toEqual([]);
    expect(readHandoffs([], NOW)).toEqual([]);
    expect(readHandoffs([null, 3, { id: ID }, { ...out(), dir: "sideways" }, { ...out(), state: "zz" }], NOW)).toEqual([]);
  });
  it("drops a closed record past its week and a duplicate id, and keeps an open one", () => {
    const old = NOW - 8 * 24 * HOUR;
    const l = readHandoffs([out({ state: "offered", at: old }), out({ state: "done", at: old }), out({ id: "d", state: "done", at: old }), out({ id: "n" })], NOW);
    expect(l.map((r) => `${r.id}:${r.state}`)).toEqual([`${ID}:offered`, "n:packing"]);
  });
  it("round-trips a full record", () => {
    const r = out({ state: "uploading", info: info(), progress: { done: 1, total: 2 }, unknownSince: NOW, title: "t", takenBy: "b2" });
    expect(readHandoffs(JSON.parse(JSON.stringify([r])), NOW)).toEqual([r]);
  });
  it("reads an unknown server state as unknown and a newer meta as unreadable", () => {
    expect(narrowInfo({ ...info(), state: "archived" })?.state).toBe("unknown");
    expect(narrowMeta({ ...meta(), v: 2 })).toBeNull();
    expect(narrowMeta(meta({ brief: { summary: "x".repeat(900), next_steps: ["a", 3, ""] } }))?.brief).toMatchObject({ next_steps: ["a"] });
  });
  it("clamps a brief to the backend's bounds", () => {
    const b = clampBrief({ summary: "s".repeat(700), state: 4, memories: Array(20).fill("m") });
    expect(b.summary).toHaveLength(600);
    expect(b.state).toBe("");
    expect(b.memories).toHaveLength(10);
    expect(clampBrief(null)).toEqual({ summary: "", state: "", next_steps: [], open_questions: [], memories: [] });
  });
});

describe("rowText", () => {
  it("says where a sent session stands", () => {
    expect(rowText(out({ state: "uploading", progress: { done: 1, total: 4 } }), NOW).tag).toBe("→ ben · sending 25%");
    expect(rowText(out({ state: "offered", info: info() }), NOW)).toMatchObject({ tag: "→ ben · waiting, 72h left", actions: ["takeback"] });
    expect(rowText(out({ state: "done" }), NOW).actions).toEqual(["dismiss"]);
    expect(rowText(out({ state: "offered", unknownSince: NOW }), NOW).tag).toBe("→ ben · outcome unknown");
  });
});
