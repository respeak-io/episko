// An agent's background shells (`Bash{run_in_background:true}`): payload in, records out,
// log text in, facts out. Pure; ./serversui owns the DOM, IPC and timers. Every backgrounded
// shell is a record, only a URL makes it a server, and no rule reads the command text.

import type { BgEnd, BgKind, BgMissReason, BgServer } from "./types";

const NOT_A_START = new Set(["TaskStop", "TaskOutput"]); // their responses carry the same id; not a start

// Keyed on the response field, not `run_in_background`: the id is the handle TaskStop takes.
export function bgTaskId(tool: string, response: unknown): string {
  if (NOT_A_START.has(tool)) return "";
  const r = response as Record<string, unknown> | null | undefined;
  const id = r?.backgroundTaskId;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

export function bgStopId(tool: string, input: unknown): string {
  if (tool !== "TaskStop") return "";
  const i = input as Record<string, unknown> | null | undefined;
  const id = i?.task_id;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

// Claude Code auto-backgrounds any Bash command past its 120s timeout, and those arrive as
// records too. A number rather than a boolean so a row can say `after 2m`; rules ask `isJob`.
export function bgTimedOut(response: unknown): number {
  const r = response as Record<string, unknown> | null | undefined;
  const ms = r?.timedOutAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function bgCmd(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  const c = i?.command;
  return typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "";
}

export function applyBg(
  list: BgServer[], tool: string, input: unknown, response: unknown,
  transcript: unknown, now: number,
): boolean { // mutates in place; the boolean keeps the render pass quiet for every other tool call
  const stopped = bgStopId(tool, input);
  if (stopped) {
    const rec = list.find((b) => b.taskId === stopped);
    if (!rec || rec.ended) return false;
    rec.ended = now; rec.exit = null; // TaskStop is a kill; set now rather than on the sentinel
    return true;
  }
  const taskId = bgTaskId(tool, response);
  if (!taskId) return false;
  if (list.some((b) => b.taskId === taskId)) return false; // TaskOutput echoing, or a hook seen twice
  const rec: BgServer = {
    taskId,
    cmd: bgCmd(input),
    transcript: typeof transcript === "string" ? transcript : "", // captured now; see BgServer.transcript
    startedAt: now,
  };
  const timedOut = bgTimedOut(response); // only the start payload carries it
  if (timedOut > 0) rec.timedOut = timedOut;
  list.push(rec);
  return true;
}

// ---------- reading the log ----------

// Keep only what follows the last `\r`, as a terminal does: progress bars redraw their line that way.
export function logLines(text: string): string[] {
  return text.split("\n").map((l) => {
    const i = l.lastIndexOf("\r");
    return (i >= 0 ? l.slice(i + 1) : l).trimEnd();
  });
}

// A third ending exists (`[exited with code unknown]`), and it must not read as a kill.
export type BgEndSignal = { kind: "exit"; code: number } | { kind: "killed" } | { kind: "unknown" };

// The ending the log announces, or `undefined` while running. Most abandoned shells are
// never reaped and write no sentinel, so bgRetire and the `session` ending exist beside
// this. Whole-line matches, so `[output truncated: …]` never ends a live server.
export function bgSentinel(text: string): BgEndSignal | undefined {
  const m = /^\[exited with code (-?\d+)\]\s*$/m.exec(text);
  if (m) return { kind: "exit", code: Number(m[1]) };
  if (/^\[exited with code unknown\]\s*$/m.test(text)) return { kind: "unknown" };
  if (/^\[killed\]\s*$/m.test(text)) return { kind: "killed" };
  return undefined;
}

// A server announcing itself (`Local:`, `running on`, `listening`); NOT `Vue DevTools: Open http://…`.
const ANNOUNCE = /\b(local|listening|running|serving|server|ready|started|available)\b/i;

// Origins only, so vite's `/` and `/__devtools__/` collapse; `0.0.0.0` and `[::]` become localhost.
function origins(line: string): string[] {
  const out: string[] = [];
  const re = /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::(\d{1,5}))?/gi;
  for (const m of line.matchAll(re)) {
    const scheme = m[0].slice(0, m[0].indexOf(":"));
    const host = /0\.0\.0\.0|\[::\]/.test(m[1]) ? "localhost" : m[1];
    out.push(m[2] ? `${scheme}://${host}:${m[2]}` : `${scheme}://${host}`);
  }
  return out;
}

// Announcement lines beat a stray `curl http://localhost:…`; within the set the last wins,
// since a server that restarts on a config change prints a fresh line.
export function serverUrl(text: string): string {
  const lines = logLines(text);
  const announced: string[] = [], any: string[] = [];
  for (const l of lines) {
    const o = origins(l);
    if (!o.length) continue;
    (ANNOUNCE.test(l) ? announced : any).push(...o);
  }
  const pick = announced.length ? announced : any;
  return pick.length ? pick[pick.length - 1] : "";
}

// No any-URL fallback, unlike `serverUrl`: this answer latches, so a stray URL would stick to a row.
function announcedOn(line: string): string {
  return ANNOUNCE.test(line) ? (origins(line).pop() ?? "") : "";
}

// Folded per line as it streams (`run.tail` is a rolling 40 lines); a later announcement wins.
export function taskServerUrl(prev: string | undefined, line: string): string | undefined {
  return announcedOn(line) || prev;
}

export function logTail(text: string, n = 12): string[] {
  const lines = logLines(text).filter((l) => l.trim());
  return lines.slice(Math.max(0, lines.length - n));
}

// One `read_bg_log` answer: the backend's `BgLog` minus `missing` (test/ipc.test.ts holds them in step).
// Exactly one of `path` and `tried` is ever the answer; a `notYet` miss names in `path` the file it awaits.
export interface BgRead {
  path: string; text: string; len: number; unchanged: boolean;
  reason: BgMissReason; tried: string[]; rootRank: number; discovered: boolean;
}

export function applyBgLog(rec: BgServer, read: BgRead, now: number): boolean {
  let changed = false;
  const { path, text } = read;
  if (path && rec.log !== path) { rec.log = path; changed = true; }
  if (rec.reason && rec.reason !== "none") { rec.reason = "none"; rec.tried = []; changed = true; }
  rec.missSince = undefined; // bgRetire's clock, stamped in applyBgMiss; nothing drawn reads it
  rec.rootRank = read.rootRank; // not a change: a new root means a new path, reported above
  if (read.unchanged) { rec.len = read.len; return changed; } // no text was read; folds nothing
  rec.len = read.len;
  const url = serverUrl(text);
  if (url && rec.url !== url) { rec.url = url; changed = true; }
  const tail = logTail(text);
  if (tail.join("\n") !== (rec.tail ?? []).join("\n")) { rec.tail = tail; changed = true; }
  const sent = bgSentinel(text);
  // `undefined` (still running) must never clear an end; endBg guards that.
  if (sent) {
    const end: BgEnd = sent.kind === "unknown" ? "unknown" : "sentinel";
    if (endBg(rec, now, end, sent.kind === "exit" ? sent.code : null)) changed = true;
  }
  return changed;
}

// A read that found nothing. `reason` and `tried` come off `read_bg_log` verbatim (this module
// cannot see a filesystem); `missSince`, bgRetire's clock, is stamped on the first miss only.
export function applyBgMiss(rec: BgServer, read: BgRead, now: number): boolean {
  let changed = false;
  rec.missSince ??= now; // every miss, not just notYet; moves no pixel
  if (read.path && rec.log !== read.path) { rec.log = read.path; changed = true; }
  if (rec.reason !== read.reason) { rec.reason = read.reason; changed = true; }
  if ((rec.tried ?? []).join("\n") !== read.tried.join("\n")) { rec.tried = read.tried; changed = true; }
  rec.rootRank = read.rootRank;
  return changed;
}

// Every ending but the agent's own TaskStop (applyBg) is set here. Never overwrites: a TaskStop
// ends a record before its last line lands, and a poll in that window must not re-end it.
export function endBg(rec: BgServer, now: number, end: BgEnd, exit: number | null): boolean {
  if (rec.ended) return false;
  rec.ended = now; rec.exit = exit; rec.endReason = end;
  return true;
}

export const BG_RETIRE_MS = 10 * 60_000; // how long a findable-but-absent log is given

// Retire a record whose log never appeared, as `stale`. On `notYet` only (`noRoot` and `ambiguous`
// are an outage, not an ending), never with a URL, and measured from when the log went missing
// rather than `startedAt`, or a log read for an hour and then removed would retire on the next poll.
export function bgRetire(rec: BgServer, now: number): boolean {
  if (rec.ended || rec.url) return false;
  if (rec.reason !== "notYet") return false;
  if (now - (rec.missSince ?? rec.startedAt) <= BG_RETIRE_MS) return false;
  return endBg(rec, now, "stale", null);
}

// ---------- the ports the kernel says are open ----------

/** One TCP port a session's process tree is listening on, from `session_ports`. */
export interface SessionPort { sessionId: string; port: number; pid: number; name: string }

export function portOf(url: string): number {
  const m = /^(https?):\/\/[^/:]+(?::(\d{1,5}))?/i.exec(url);
  if (!m) return 0;
  return m[2] ? Number(m[2]) : m[1].toLowerCase() === "https" ? 443 : 80;
}

const DEBUG_PORTS = new Set([9229, 9230]); // Node's inspector and its worker variant: never a page
const EPHEMERAL_FROM = 49152; // IANA dynamic range: a port in it was chosen by the kernel, not a person

// A port somebody chose. One `wrangler dev` holds five sockets, four of them noise; a real
// server on an ephemeral port (`vite --port 0`) has to announce itself, so the log has it.
export function usefulPort(port: number): boolean {
  return port > 0 && port < EPHEMERAL_FROM && !DEBUG_PORTS.has(port);
}

// A command Claude backgrounded on its own timeout may never adopt a loose port. That is
// the one thing `timedOutAfterMs` decides; the popover's heading is `bgKind`'s question.
export function isJob(b: BgServer): boolean {
  return (b.timedOut ?? 0) > 0;
}

// What a session said against what it is listening on; returns the ports nothing accounts for.
// The ladder in CLAUDE.md: a port a record names is that record's; ONE silent record and ONE loose
// port are each other (fail closed on any ambiguity; a job is never a candidate); the rest get rows.
export function reconcilePorts(
  records: BgServer[], taskUrl: string | undefined, ports: readonly number[],
): { loose: number[]; changed: boolean } {
  const live = liveServers(records);
  const claimed = new Set<number>();
  if (taskUrl) claimed.add(portOf(taskUrl));
  for (const b of live) if (b.url) claimed.add(portOf(b.url));
  const loose = [...new Set(ports)]
    .filter((p) => usefulPort(p) && !claimed.has(p)) // applies to adoption too: never adopt a control socket
    .sort((a, b) => a - b);

  const silent = live.filter((b) => !b.url && !isJob(b));
  if (loose.length === 1 && silent.length === 1) {
    silent[0].url = `http://localhost:${loose[0]}`;
    return { loose: [], changed: true };
  }
  return { loose, changed: false };
}

// ---------- what the header asks ----------

export function liveServers(list: readonly BgServer[]): BgServer[] {
  return list.filter((b) => !b.ended); // what the indicator counts and the poll re-reads
}

export function servingUrls(list: readonly BgServer[]): BgServer[] {
  return liveServers(list).filter((b) => b.url); // worth a badge; a live `sleep 45` is listed, not counted
}

// A non-zero exit stays until dismissed, the rule task panes follow (docs/tasks.md); an
// exit of 0 is not news and a null one was asked for.
export function failedServers(list: readonly BgServer[]): BgServer[] {
  return list.filter((b) => b.ended && b.exit != null && b.exit !== 0);
}

export function shownServers(list: readonly BgServer[]): BgServer[] {
  return [...liveServers(list), ...failedServers(list)]; // the popover's list; the poll re-reads liveServers
}

export function forgetServer(list: BgServer[], taskId: string): boolean {
  const i = list.findIndex((b) => b.taskId === taskId && b.ended); // ended only; a live one is stopped
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

// On evidence: a URL, printed or adopted, is a server and everything else a job. Not
// `isJob`'s question: a `pnpm dev` Claude auto-backgrounded is a server once it prints its URL.
export function bgKind(b: BgServer): BgKind {
  return b.url ? "server" : "job";
}

export function bgBlind(b: BgServer): boolean {
  return b.reason === "noRoot" || b.reason === "ambiguous"; // an outage, which the header says out loud
}

export function bgLogPath(b: BgServer): string {
  return b.log || b.tried?.[0] || ""; // a candidate is worth offering: "not here" is debuggable
}

export function bgPeekEmpty(b: BgServer): string {
  switch (b.reason) {
    case "noRoot": return `no log found — looked in ${b.tried?.length ?? 0} places`;
    case "ambiguous": return "two logs match — refusing to guess";
    case "notYet": return "no log file yet";
    case "unreadable": return "the log could not be read";
    case "badId": return "no log address for this shell";
    default: return "no output yet"; // "none" or never read: the file is there and empty
  }
}

// Three endings carry `exit: null`; only the unnamed one (the agent's own TaskStop) reads as "stopped".
export function bgOutcome(b: BgServer): string {
  if (!b.ended) return "";
  switch (b.endReason) {
    case "unknown": return "ended";
    case "stale": return "log never appeared";
    case "session": return "session ended";
  }
  return b.exit == null ? "stopped" : b.exit === 0 ? "finished" : `exited ${b.exit}`;
}

export function cmdLabel(cmd: string, max = 52): string {
  let c = cmd.trim();
  const m = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/s.exec(c);
  if (m) c = m[1].trim(); // drop the leading `cd … &&`: the row already says which project
  // A shell redirect to a log file is plumbing the agent added, never the command.
  c = c.replace(/\s*(?:\d?>>?|2>&1)\s*(?:"[^"]*"|'[^']*'|\S+)?\s*/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
}
