// Handing a stopped session to another machine, the frontend's half (docs/handoff.md): the
// records `cc-handoff` keeps, how a server event moves one, and the sheet's rules. No DOM, no
// Tauri; the server is the authority and every rule here only reads what it said.
import { basename } from "./format";
import { liveJobs, type Restorable, type Sess } from "./types";

export type HandoffState = "uploading" | "offered" | "claimed" | "done" | "declined" | "recalled" | "expired" | "unknown";
/** `packing` is before the offer; `returned` and `refused` are local verdicts the server never states. */
export type RecState = HandoffState | "packing" | "returned" | "refused";
export interface HandoffCaps { enabled: boolean; max_bytes: number; part_bytes: number; ttl_ms: number }
export interface HandoffInfo {
  id: string; from_user: string; from_device: string; to_user: string; to_device: string | null;
  state: HandoffState; taker: string | null; meta: unknown; size: number; parts: number; sha256: string;
  have: number[]; created: number; expires: number; updated: number;
}
export interface Brief { summary: string; state: string; next_steps: string[]; open_questions: string[]; memories: string[] }
export interface GitMeta { via: "none" | "branch" | "bundle"; branch: string | null; head: string; snap: boolean }
export interface HandoffMeta {
  resumeId: string; provider: string; projectId: string | null; title: string; project: string;
  brief: Brief | null; git: GitMeta | null;
}
export interface Peer { user: string; device?: string; label?: string }
export interface HandoffRec {
  id: string; dir: "out" | "in"; resumeId: string; peer: Peer; state: RecState;
  title?: string; colorKey?: string; checkout?: string;
  progress?: { done: number; total: number }; reason?: string; info?: HandoffInfo;
  /** When the outcome stopped being knowable; cleared by the next word from a handoff server. */
  unknownSince?: number;
  /** A sender's `done` was archived; the row stays until dismissed. */
  settled?: boolean;
  /** Another of my machines claimed an offer made to all of them. */
  takenBy?: string;
  at: number;
}
export type HandoffEv =
  | { kind: "list"; records: unknown }
  | { kind: "info"; info: unknown }
  | { kind: "progress"; id: string; dir: "out" | "in"; done: number; total: number }
  | { kind: "ready"; id: string }
  | { kind: "refused"; id: string; reason: string; message: string };
export interface Me { user: string; device: string }

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KEEP_CLOSED_MS = 7 * DAY;
const DEFAULT_TTL_MS = 72 * HOUR;
/** Past this a bundle is preset only if nothing smaller will do. */
export const BUNDLE_PRESET_MAX = 8 << 20;
export const UNTRACKED_MAX = 2000;
const STATES: readonly HandoffState[] = ["uploading", "offered", "claimed", "done", "declined", "recalled", "expired"];
const REC_STATES: readonly RecState[] = [...STATES, "unknown", "packing", "returned", "refused"];
const CLOSED: readonly RecState[] = ["done", "declined", "recalled", "expired", "returned", "refused"];
/** Server states in which the sender still waits on the server's word. */
const OPEN: readonly RecState[] = ["uploading", "offered", "claimed", "unknown"];
const PERMANENT = new Set(["too_large", "bad_target", "conflict", "off"]);

const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const sameUser = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const strList = (v: unknown, max: number, len: number): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, len).trim()).filter(Boolean).slice(0, max) : [];

export function narrowInfo(x: unknown): HandoffInfo | null {
  const o = obj(x);
  if (!o || !str(o.id) || !str(o.from_device) || !str(o.to_user)) return null;
  const state = STATES.includes(o.state as HandoffState) ? o.state as HandoffState : "unknown";
  return {
    id: str(o.id), from_user: str(o.from_user), from_device: str(o.from_device), to_user: str(o.to_user),
    to_device: str(o.to_device) || null, state, taker: str(o.taker) || null, meta: o.meta ?? null,
    size: num(o.size), parts: num(o.parts), sha256: str(o.sha256, 64),
    have: Array.isArray(o.have) ? o.have.filter((n): n is number => typeof n === "number") : [],
    created: num(o.created), expires: num(o.expires), updated: num(o.updated),
  };
}

/** Welcome's `handoff`: absent is an older server, kept apart from one that has it off. */
export function narrowCaps(x: unknown): HandoffCaps | undefined {
  const o = obj(x);
  if (!o || typeof o.enabled !== "boolean") return undefined;
  return { enabled: o.enabled, max_bytes: num(o.max_bytes), part_bytes: num(o.part_bytes), ttl_ms: num(o.ttl_ms) };
}

/** Which of Welcome's devices said, at their last hello, that they speak handoff. */
export function capableDevices(devices: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(devices)) for (const d of devices) if (obj(d)?.handoff === true && str(obj(d)?.device)) out.add(str(obj(d)?.device));
  return out;
}

/** The same bounds the backend cuts a model's answer to; an edited brief is held to them too. */
export function clampBrief(b: unknown): Brief {
  const o = obj(b) ?? {};
  return {
    summary: str(o.summary, 600).trim(), state: str(o.state, 400).trim(),
    next_steps: strList(o.next_steps, 6, 200), open_questions: strList(o.open_questions, 6, 200),
    memories: strList(o.memories, 10, 120),
  };
}

function narrowGit(x: unknown): GitMeta | null {
  const o = obj(x);
  if (!o || !str(o.head) || !["none", "branch", "bundle"].includes(o.via as string)) return null;
  return { via: o.via as GitMeta["via"], branch: str(o.branch) || null, head: str(o.head, 64), snap: o.snap === true };
}

/** null for a meta this version cannot read, which the sheet calls "from a newer Episko". */
export function narrowMeta(x: unknown): HandoffMeta | null {
  const o = obj(x);
  if (!o || o.v !== 1 || !str(o.resume_id)) return null;
  return {
    resumeId: str(o.resume_id), provider: str(o.provider) || "claude", projectId: str(o.project_id) || null,
    title: str(o.title), project: str(o.project), brief: o.brief === undefined ? null : clampBrief(o.brief),
    git: narrowGit(o.git),
  };
}

function narrowRec(x: unknown): HandoffRec | null {
  const o = obj(x);
  if (!o || !str(o.id) || (o.dir !== "out" && o.dir !== "in")) return null;
  const peer = obj(o.peer);
  if (!peer || !str(peer.user) || !REC_STATES.includes(o.state as RecState)) return null;
  const rec: HandoffRec = {
    id: str(o.id), dir: o.dir, resumeId: str(o.resumeId), state: o.state as RecState, at: num(o.at),
    peer: { user: str(peer.user), ...(str(peer.device) ? { device: str(peer.device) } : {}), ...(str(peer.label) ? { label: str(peer.label) } : {}) },
  };
  for (const k of ["title", "colorKey", "checkout", "reason"] as const) if (str(o[k], 400)) rec[k] = str(o[k], 400);
  const info = narrowInfo(o.info);
  if (info) rec.info = info;
  const p = obj(o.progress);
  if (p) rec.progress = { done: num(p.done), total: num(p.total) };
  if (num(o.unknownSince)) rec.unknownSince = num(o.unknownSince);
  if (o.settled === true) rec.settled = true;
  if (str(o.takenBy)) rec.takenBy = str(o.takenBy);
  return rec;
}

/** `cc-handoff`, narrowed; a closed record past its week is dropped, like the server's. */
export function readHandoffs(raw: unknown, now: number): HandoffRec[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: HandoffRec[] = [];
  for (const x of raw) {
    const r = narrowRec(x);
    if (!r || seen.has(r.id) || (CLOSED.includes(r.state) && now - r.at > KEEP_CLOSED_MS)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

const fromInfo = (info: HandoffInfo, me: Me): "out" | "in" | null => {
  if (info.from_device === me.device) return "out";
  if (sameUser(info.to_user, me.user) && (!info.to_device || info.to_device === me.device)) return "in";
  return null;
};

function applyInfo(list: HandoffRec[], info: HandoffInfo, me: Me, now: number): HandoffRec[] {
  const dir = fromInfo(info, me);
  if (!dir) return list;
  const i = list.findIndex((r) => r.id === info.id);
  const prev = i < 0 ? null : list[i];
  if (prev && prev.info && prev.info.updated > info.updated) return list; // out of order
  if (prev && prev.state === info.state && prev.info?.updated === info.updated && !prev.unknownSince) return list;
  if (!prev) {
    // Only an open record can be rebuilt from the server: a closed one has lost its meta.
    const meta = narrowMeta(info.meta);
    const fresh = dir === "out" ? info.state === "uploading" || info.state === "offered" || info.state === "claimed" : info.state === "offered";
    if (!meta || !fresh) return list;
    const peer: Peer = dir === "out"
      ? { user: info.to_user, ...(info.to_device ? { device: info.to_device } : {}) }
      : { user: info.from_user, device: info.from_device };
    return [...list, { id: info.id, dir, resumeId: meta.resumeId, peer, state: info.state, title: meta.title, info, at: now }];
  }
  // Somebody else's machine took an offer to all of mine: gone once it closes either way.
  if (dir === "in" && info.taker && info.taker !== me.device && CLOSED.includes(info.state)) return list.filter((r) => r.id !== info.id);
  if (dir === "in" && (info.state === "declined" || info.state === "recalled" || info.state === "expired")) return list.filter((r) => r.id !== info.id);
  const next: HandoffRec = { ...prev, state: info.state, info, at: now };
  delete next.unknownSince;
  if (info.state !== "uploading" && info.state !== "claimed") delete next.progress;
  if (dir === "in" && info.taker && info.taker !== me.device) next.takenBy = info.taker;
  const out = [...list];
  out[i] = next;
  return out;
}

/** One server event onto the records. Idempotent, and a `list` is the whole truth for this user. */
export function reduce(list: HandoffRec[], ev: HandoffEv, me: Me, now: number): HandoffRec[] {
  switch (ev.kind) {
    case "info": {
      const info = narrowInfo(ev.info);
      return info ? applyInfo(list, info, me, now) : list;
    }
    case "list": {
      const infos = Array.isArray(ev.records) ? ev.records.map(narrowInfo).filter((x): x is HandoffInfo => !!x) : [];
      let next = list;
      for (const info of infos) next = applyInfo(next, info, me, now);
      const known = new Set(infos.map((x) => x.id));
      return next.flatMap((r): HandoffRec[] => {
        if (known.has(r.id)) return [r];
        // A sender's record the server no longer holds: the session is back, after a confirm.
        if (r.dir === "out") return OPEN.includes(r.state) ? [{ ...r, state: "returned", at: now }] : [r];
        return r.state === "done" ? [r] : []; // a received blob outlives the server's row
      });
    }
    case "progress":
      return list.map((r) => r.id === ev.id && r.dir === ev.dir && (r.progress?.done !== ev.done || r.progress?.total !== ev.total)
        ? { ...r, progress: { done: ev.done, total: ev.total }, at: now } : r);
    case "ready":
      return list.map((r) => r.id === ev.id && r.dir === "in" && r.state !== "done" ? { ...r, state: "done", at: now } : r);
    case "refused":
      return list.map((r) => {
        if (r.id !== ev.id || r.reason === ev.message) return r;
        // An offer the server will never take is the sender's again, with nothing to confirm.
        const dead = r.dir === "out" && (r.state === "packing" || r.state === "uploading") && PERMANENT.has(ev.reason);
        return { ...r, reason: ev.message, ...(dead ? { state: "refused" as const } : {}), at: now };
      });
  }
}

/** `undefined`/`null` is a server that cannot be heard (lock); `enabled: false` hands every open offer back. */
export function onCaps(list: HandoffRec[], caps: HandoffCaps | null | undefined, now: number): HandoffRec[] {
  return list.map((r) => {
    if (r.dir !== "out" || !OPEN.includes(r.state)) return r;
    if (caps && !caps.enabled) return { ...r, state: "returned", at: now };
    if (caps) {
      if (!r.unknownSince) return r;
      const next = { ...r };
      delete next.unknownSince;
      return next;
    }
    const since = r.unknownSince ?? now;
    const bound = (r.info?.expires || since + DEFAULT_TTL_MS) + HOUR;
    if (now > bound) return { ...r, state: "returned", at: now };
    return r.unknownSince ? r : { ...r, unknownSince: since };
  });
}

/** `claude` is `isClaude(s)`: only its transcript format is moved, so v1 hands over nothing else. */
export interface GateTarget { claude: boolean; external?: boolean; workdir?: string; canResume: boolean }
/** Why "Send to…" is greyed, or null when it may open. */
export function sendGate(t: GateTarget, caps: HandoffCaps | null | undefined, connected: boolean, peers: number): string | null {
  if (!t.claude) return "Only a Claude session can be handed over";
  if (t.external) return "This session runs in another terminal, which Episko can't stop";
  if (!t.workdir) return "This session has no folder to hand over";
  if (!t.canResume) return "This session can't be resumed yet";
  if (!connected) return "Sync isn't connected";
  if (!caps) return "This sync server doesn't know about handoff";
  if (!caps.enabled) return "Handoff is off on this sync server";
  if (peers < 1) return "No other machine or teammate on this server can take it";
  return null;
}

export interface Device { user: string; device: string; label: string }
export interface Target { user: string; device?: string; label: string; mine: boolean; online: boolean; ready: boolean }
/** Your other machines first (one row each), then each teammate as one row: any of theirs may pick it up. */
export function targets(devices: readonly Device[], capable: ReadonlySet<string>, me: Me, online: ReadonlySet<string>): Target[] {
  const mine: Target[] = [];
  const team = new Map<string, Target>();
  for (const d of devices) {
    if (d.device === me.device) continue;
    const ready = capable.has(d.device);
    const live = online.has(d.device);
    if (sameUser(d.user, me.user)) {
      mine.push({ user: d.user, device: d.device, label: d.label || `machine ${d.device.slice(0, 6)}`, mine: true, online: live, ready });
      continue;
    }
    const key = d.user.toLowerCase();
    const t = team.get(key) ?? { user: d.user, label: d.user, mine: false, online: false, ready: false };
    team.set(key, { ...t, online: t.online || live, ready: t.ready || ready });
  }
  const order = (a: Target, b: Target) => Number(b.ready) - Number(a.ready) || Number(b.online) - Number(a.online) || a.label.localeCompare(b.label);
  return [...mine.sort(order), ...[...team.values()].sort(order)];
}

export interface HandoffGit {
  kind: string; branch: string | null; upstream: string | null; head: string | null; ahead: number; dirty: number;
  untracked: number; remote: string | null; project_id: string | null; fetched: boolean; est_bytes: number;
}
export interface GitOption { id: "none" | "branch" | "bundle"; label: string; disabled?: string }
/** What the code can travel as. A dirty tree has no preset: Send waits until somebody chooses. */
export function gitChoices(g: HandoffGit, maxBytes: number): { options: GitOption[]; preset: string | null; note: string } {
  const remote = g.remote || "the remote";
  const branch: GitOption = { id: "branch", label: `Push it as a branch to ${remote}` };
  if (!g.remote) branch.disabled = "There is no remote to push to";
  const bundle: GitOption = { id: "bundle", label: "Pack it into the handoff" };
  if (g.untracked > UNTRACKED_MAX) bundle.disabled = `${g.untracked} untracked files are too many to pack`;
  else if (maxBytes > 0 && g.est_bytes > maxBytes) bundle.disabled = "Too large for this sync server";
  const none: GitOption = { id: "none", label: "Send only the conversation" };
  const stale = g.fetched ? "" : ` Couldn't reach ${remote}, so this may be out of date.`;
  const usable = (o: GitOption) => (o.disabled ? null : o.id);
  switch (g.kind) {
    case "clean":
      return { options: [{ id: "none", label: `Nothing to send: ${g.branch ?? "this commit"} is on ${remote}` }], preset: "none", note: stale.trim() };
    case "unpushed": {
      const preset = g.est_bytes < BUNDLE_PRESET_MAX ? usable(bundle) ?? usable(branch) : usable(branch) ?? usable(bundle);
      return { options: [branch, bundle, none], preset, note: `${g.ahead} commit${g.ahead === 1 ? "" : "s"} not on ${remote}.${stale}` };
    }
    case "dirty":
      return { options: [branch, bundle, none], preset: null, note: `${g.dirty + g.untracked} changed file${g.dirty + g.untracked === 1 ? "" : "s"}: choose how they travel.${stale}` };
    case "detached":
    case "unborn":
      return { options: [bundle, none], preset: null, note: g.kind === "detached" ? "Not on a branch." : "No commits yet." };
    default:
      return { options: [none], preset: "none", note: "Not a git checkout: only the conversation travels." };
  }
}

/** What stops with the pane and does not come back on the other machine. */
export function lostOnHandoff(s: Sess): { jobs: number; servers: string[] } {
  return { jobs: liveJobs(s), servers: s.servers.filter((b) => !b.ended && b.url).map((b) => b.url as string) };
}

export interface MemoryFile { name: string; type: string; description: string }
export interface MemoryRow extends MemoryFile { ticked: boolean; suggested: boolean }
const TEAM_TYPES = new Set(["project", "reference"]);
/** A teammate is offered project and reference memories only, all unticked; never user or feedback. */
export function memoryOffer(files: readonly MemoryFile[], same: boolean, suggested: readonly string[]): MemoryRow[] {
  const hint = new Set(suggested);
  return files
    .filter((f) => same || TEAM_TYPES.has(f.type))
    .map((f) => ({ ...f, suggested: hint.has(f.name), ticked: same && hint.has(f.name) }));
}

export const peerName = (p: Peer) => p.label || p.user;

/** Why a session is not resumable here because of a handoff, or null. */
export function handoffBusy(list: readonly HandoffRec[], resumeId: string): string | null {
  const id = resumeId.toLowerCase();
  const r = list.find((x) => x.dir === "out" && x.resumeId.toLowerCase() === id && (x.state === "packing" || x.state === "done" || OPEN.includes(x.state)));
  if (!r) return null;
  const who = peerName(r.peer);
  if (r.state === "done") return `handed to ${who}`;
  if (r.unknownSince) return "outcome unknown until sync reconnects";
  if (r.state === "packing") return `preparing for ${who}`;
  if (r.state === "claimed") return `${who} is picking it up`;
  return `sending to ${who}`;
}

export interface Installed { workdir: string; resume_id: string; branch: string | null; worktree: boolean }
/** The roster row a received session resumes from. */
export function restorableFor(info: HandoffInfo, inst: Installed, id: string, colorKey: string): Restorable {
  const meta = narrowMeta(info.meta);
  return {
    id, resumeId: inst.resume_id, provider: meta?.provider ?? "claude",
    project: meta?.project || basename(colorKey), workdir: inst.workdir, colorKey,
    worktree: inst.worktree ? inst.branch ?? basename(inst.workdir) : null, branch: inst.branch ?? "",
    title: meta?.title ?? "", lastActivity: info.updated,
  };
}

/** Incoming offers by the checkout their project lives in here; null is "not cloned here". */
export function incomingByProject(list: readonly HandoffRec[], pathsOfId: (id: string) => string[]): Map<string | null, HandoffRec[]> {
  const out = new Map<string | null, HandoffRec[]>();
  for (const r of list) {
    if (r.dir !== "in") continue;
    const pid = narrowMeta(r.info?.meta)?.projectId;
    const key = (pid && pathsOfId(pid)[0]) || null;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

const pct = (p?: { done: number; total: number }) => (p && p.total ? ` ${Math.floor((100 * p.done) / p.total)}%` : "");
export type RowAction = "cancel" | "takeback" | "dismiss" | "resume" | "open" | "giveback" | "retry";
/** A row's tag, title and verbs. `name` turns a device id into its label. */
export function rowText(r: HandoffRec, now: number, name: (device: string) => string = (d) => `machine ${d.slice(0, 6)}`): { tag: string; title: string; actions: RowAction[] } {
  const who = peerName(r.peer);
  const title = r.title || narrowMeta(r.info?.meta)?.title || "A session";
  const left = r.info?.expires ? Math.ceil((r.info.expires - now) / HOUR) : 0;
  if (r.dir === "out") {
    if (r.unknownSince && OPEN.includes(r.state)) return { tag: `→ ${who} · outcome unknown`, title, actions: [] };
    switch (r.state) {
      case "packing": return { tag: `preparing for ${who}…`, title, actions: ["cancel"] };
      case "uploading": return { tag: `→ ${who} · sending${pct(r.progress)}`, title, actions: ["takeback"] };
      case "offered": return { tag: `→ ${who} · waiting${left > 0 ? `, ${left}h left` : ""}`, title, actions: ["takeback"] };
      case "claimed": return { tag: `${who} is picking it up`, title, actions: [] };
      case "done": return { tag: `handed to ${who}`, title, actions: ["dismiss"] };
      case "returned": return { tag: `back from ${who}?`, title, actions: ["resume"] };
      default: return { tag: r.reason ? `not sent: ${r.reason}` : `not taken by ${who}`, title, actions: ["resume"] };
    }
  }
  if (r.takenBy) return { tag: `taken on ${name(r.takenBy)}`, title, actions: [] };
  switch (r.state) {
    case "claimed": return { tag: `receiving from ${who}${pct(r.progress)}`, title, actions: ["giveback"] };
    case "done": return { tag: `from ${who} · ready`, title, actions: ["retry"] };
    default: return { tag: `from ${who}`, title, actions: ["open"] };
  }
}
