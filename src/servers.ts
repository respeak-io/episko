// The dev servers an agent starts and walks away from.
//
// Claude Code's answer to "start the dev server" is `Bash{run_in_background:true}`: it
// spawns the process, hands the model a `backgroundTaskId`, and pipes the output to a
// file only the model ever reads. Nothing about that reaches the human. You find out
// there is a server when you go looking for the port, or when the next one refuses to
// bind — a machine picked at random for this feature had **eleven** of them listening,
// most of them orphans of sessions that had long since ended.
//
// Episko needs no new instrumentation to see them, because the hook that carries them
// is one it already registers. A backgrounded shell's PostToolUse payload reads:
//
//   tool_input:    { command: "pnpm dev", run_in_background: true }
//   tool_response: { stdout: "", …, backgroundTaskId: "bczk8s47b" }
//
// and the log the process is writing lives under Claude Code's own temp root, at
// `<root>/<slug>/<uuid>/tasks/<backgroundTaskId>.output` — the last two components of
// `transcript_path` hung off a directory **nothing here may spell**. It is not
// `$TMPDIR/claude`, which is what this module's header used to claim and what the
// backend probed for; on this machine it is `${CLAUDE_CODE_TMPDIR ?? "/tmp"}/claude-<uid>`,
// and on Windows nobody here has observed it at all. `read_bg_log` probes a table of
// candidates and reports which one won, which is why a record carries a `reason` and a
// `tried` list rather than a bare "missing".
//
// That file is most of the feature: it carries the URL the server printed and its last
// lines. It carries a closing sentinel too — but only sometimes. Of **eleven** real logs
// measured on one machine, exactly ONE ended with `[exited with code N]`: a shell
// abandoned when its session ends is never reaped and writes nothing at all. So no rule
// below may wait on the sentinel to decide a record is over; that is what `bgRetire` and
// the `session` ending are for.
//
// This module is the pure half — payload in, records out, log text in, facts out. It
// owns no DOM, no IPC and no timers; ./serversui owns those. Same split, and the same
// reason for it, as ./gitwatch beside it.
//
// **Two directions of error, and they cost differently.** A false positive is a row for
// something that was never a server (`sleep 45` backgrounded by an agent is a perfectly
// ordinary thing to do, and measured over 143 real payloads the backgrounded commands
// are mostly `npm ci`, `pytest`, `gh run watch` and `until …; do sleep …; done` waits).
// That is noise. A false negative is the state this feature exists to end — a port held
// by nothing you can name. So this leans inclusive: **every** backgrounded shell becomes
// a record, and the URL is what promotes one to a server.
//
// The noise is then paid for twice over rather than by guessing at the command string.
// `bgKind` splits the popover on **evidence** — a URL, announced or adopted — so a job
// is listed under its own heading instead of masquerading as a server; `isJob` keeps the
// twelve-in-143 commands Claude auto-backgrounded on its own 120s timeout (a one-shot
// `python3 -c …` reached the header pill exactly this way) from adopting a loose port;
// and `bgRetire` drops a record whose log never appeared. None of the three reads the
// command text, because `pnpm dev` and `npm ci` are the same string to a rule.

import type { BgEnd, BgKind, BgMissReason, BgServer } from "./types";

/// The tools that *operate* on a background shell rather than creating one. Their
/// responses can carry the same id, and reading one as a start would resurrect a
/// record the sentinel had already retired.
const NOT_A_START = new Set(["TaskStop", "TaskOutput"]);

/// The id Claude Code gave a shell it just backgrounded, or "".
///
/// Keyed on the **response field**, not on `tool_input.run_in_background`, and not on
/// the tool being named `Bash`. The id is the thing we actually need (it is the handle
/// `TaskStop` takes), so a payload that carries it is usable whatever produced it, and
/// a payload that doesn't is not — whatever the input said it intended.
export function bgTaskId(tool: string, response: unknown): string {
  if (NOT_A_START.has(tool)) return "";
  const r = response as Record<string, unknown> | null | undefined;
  const id = r?.backgroundTaskId;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

/// The id an agent just asked Claude Code to kill, or "". The one event that ends a
/// record *before* the log's sentinel does — and it usually beats it, since the
/// sentinel only appears once the process has actually gone.
export function bgStopId(tool: string, input: unknown): string {
  if (tool !== "TaskStop") return "";
  const i = input as Record<string, unknown> | null | undefined;
  const id = i?.task_id;
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

/// How long Claude Code let a command run in the foreground before backgrounding it
/// behind the agent's back, in ms — or 0 for a background shell somebody meant.
///
/// Claude Code auto-backgrounds **any** Bash command that outlives its 120s timeout.
/// `run_in_background` is never set on those, the model never asked for one, and the
/// PostToolUse payload is otherwise identical to a real background shell's — so they
/// arrive here as records too. Measured over 143 real background payloads: 12 of them,
/// among which a one-shot `python3 -c …` that reached the header pill as a "running
/// server". The number is kept rather than a boolean because it is the *evidence*, and
/// a row can say `after 2m`; every rule asks `isJob` instead.
export function bgTimedOut(response: unknown): number {
  const r = response as Record<string, unknown> | null | undefined;
  const ms = r?.timedOutAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/// The command a backgrounded shell ran, tidied to one line for a row label.
function bgCmd(input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  const c = i?.command;
  return typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "";
}

/// Fold one completed tool call into a session's server list. Mutates in place and
/// returns whether anything changed, exactly like `applyTouch` in ./files next door —
/// the caller owns the array, and the boolean is what lets the render pass stay quiet
/// for the overwhelming majority of tool calls, which are neither of these two events.
export function applyBg(
  list: BgServer[], tool: string, input: unknown, response: unknown,
  transcript: unknown, now: number,
): boolean {
  const stopped = bgStopId(tool, input);
  if (stopped) {
    const rec = list.find((b) => b.taskId === stopped);
    // `exit: null` is what `[killed]` means, and an agent's TaskStop is a kill. Setting
    // it here rather than waiting for the sentinel is what makes the count drop on the
    // click that caused it instead of on the next poll.
    if (!rec || rec.ended) return false;
    rec.ended = now; rec.exit = null;
    return true;
  }
  const taskId = bgTaskId(tool, response);
  if (!taskId) return false;
  // A repeat of an id we already hold is not a new shell — it is `TaskOutput`'s
  // response echoing, or a hook we saw twice. Leave the record alone.
  if (list.some((b) => b.taskId === taskId)) return false;
  const rec: BgServer = {
    taskId,
    cmd: bgCmd(input),
    // Captured now, deliberately: see the `transcript` note on `BgServer`.
    transcript: typeof transcript === "string" ? transcript : "",
    startedAt: now,
  };
  // Read on the start payload and never again — this is the only hook that carries it,
  // and it is what separates a shell the agent asked for from one Claude backgrounded
  // out from under it.
  const timedOut = bgTimedOut(response);
  if (timedOut > 0) rec.timedOut = timedOut;
  list.push(rec);
  return true;
}

// ---------- reading the log ----------

/// Lines as a terminal would have shown them. A background log is raw process output:
/// no ANSI (Claude Code strips it on the way to the file) but plenty of `\r`, because
/// every progress bar in the ecosystem redraws its line that way. Keeping only what
/// follows the last `\r` is what a terminal does, and it is the difference between a
/// four-line peek and four hundred lines of the same install spinner.
export function logLines(text: string): string[] {
  return text.split("\n").map((l) => {
    const i = l.lastIndexOf("\r");
    return (i >= 0 ? l.slice(i + 1) : l).trimEnd();
  });
}

/// What a log's closing line says about the ending. A union rather than the
/// `number | null | undefined` this used to be, because Claude Code's reaper writes a
/// **third** thing — `[exited with code unknown]`, whenever it reaps a shell it has no
/// status for — and there was nowhere left to put it. `null` already meant "killed,
/// somebody asked for this", the one ending the popover drops without comment, so
/// folding an unknown exit into it would report back a request nobody ever made.
export type BgEndSignal = { kind: "exit"; code: number } | { kind: "killed" } | { kind: "unknown" };

/// The ending the log itself announces, or `undefined` while the process is still
/// running.
///
/// This is the liveness answer where it exists, and it is better than the two obvious
/// alternatives. An mtime says only when the file was last written, and a dev server
/// that nobody is hitting writes nothing for hours; a process-table lookup would need
/// the pid, which no payload carries. But it is **not** reliable enough to be the only
/// one: measured over eleven real logs, exactly ONE carried a sentinel at all — a shell
/// abandoned when its session ends is never reaped and writes nothing, which is why
/// `bgRetire` and the `session` ending exist beside this.
///
/// Every pattern here is anchored to a whole line and matched in full, which is what
/// keeps the two bracket lines that are *not* endings — `[output truncated: exceeded 5GB
/// disk cap]` and `[output omitted: it could not be written to disk]` — from ending a
/// server that is still serving.
export function bgSentinel(text: string): BgEndSignal | undefined {
  const m = /^\[exited with code (-?\d+)\]\s*$/m.exec(text);
  if (m) return { kind: "exit", code: Number(m[1]) };
  if (/^\[exited with code unknown\]\s*$/m.test(text)) return { kind: "unknown" };
  if (/^\[killed\]\s*$/m.test(text)) return { kind: "killed" };
  return undefined;
}

/// Lines that read as a server announcing itself, rather than merely mentioning a URL.
/// `Local:` (vite, next, astro), `running on` (uvicorn, gunicorn), `listening`,
/// `started server`, `ready`… — and NOT `Vue DevTools: Open http://…`, which is the
/// line that makes "take the last URL in the file" the wrong rule.
const ANNOUNCE = /\b(local|listening|running|serving|server|ready|started|available)\b/i;

/// Every localhost origin in one line, normalised. Paths are dropped on purpose: the
/// origin is the whole of what a row needs, and dropping the path is also what makes
/// vite's two announcements (`/` and `/__devtools__/`) collapse into one answer instead
/// of competing. `0.0.0.0` and `[::]` are rewritten, since neither is a thing a browser
/// will open.
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

/// The URL a background process is serving on, or "".
///
/// Announcement lines are preferred over any other line carrying a localhost URL (an
/// agent's own `curl http://localhost:9999` should not name the server), and within the
/// chosen set the **last** wins — a dev server that restarts itself on a config change
/// prints a fresh line, and the stale one above it would send you to a dead port.
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

/// The origin one line announces, or "". Stricter than `serverUrl`: the line must read
/// as an announcement, with no any-URL fallback.
///
/// The two rules differ because what they are asked about differs. `serverUrl` sees a
/// whole log and can prefer an announcement *over* a stray URL, so falling back to any
/// localhost origin when there is no announcement at all is a safety net for a server
/// that prints a bare `http://localhost:3000`. This one sees a single line with no
/// context and its answer **latches**, so a stray URL — an agent's own `curl`, a health
/// check the process logged — would put a wrong address on a row permanently. When it
/// cannot tell, it says nothing and waits for a line that can.
function announcedOn(line: string): string {
  return ANNOUNCE.test(line) ? (origins(line).pop() ?? "") : "";
}

/// The URL an Episko task pane is serving on, folded one output line at a time.
///
/// `just dev`, a VS Code task, an npm script — Episko runs these itself, in a PTY it
/// owns, so there is no log file and no `backgroundTaskId`; the evidence is the pane's
/// own output as it arrives. It has to be captured *as it streams* because `run.tail`
/// is a rolling 40 lines and a dev server's banner scrolls out of it within seconds of
/// the first HMR update — a URL rescanned from the tail would show for a moment and
/// then disappear, which is worse than never showing it.
///
/// A later announcement still wins: vite reprints its banner when the config changes,
/// sometimes on a different port, and the line above it names a port nothing is on.
export function taskServerUrl(prev: string | undefined, line: string): string | undefined {
  return announcedOn(line) || prev;
}

/// The last `n` non-empty lines, for the row's peek.
export function logTail(text: string, n = 12): string[] {
  const lines = logLines(text).filter((l) => l.trim());
  return lines.slice(Math.max(0, lines.length - n));
}

/// One `read_bg_log` answer, as the command returns it. A field-for-field mirror of the
/// backend's `BgLog` minus `missing`, which the invoke site intersects in — and the two
/// halves are held together from source by `test/ipc.test.ts`, because a snake_case
/// field arriving at a camelCase interface is a silent `undefined` that every rule below
/// then reads as "no", with tsc, vitest and cargo all green.
///
/// **Exactly one of `path` and `tried` is ever the answer.** A read that resolved names
/// its file; a `notYet` names the file it is waiting for; the three that could not
/// address a file at all name every candidate they tested instead. The old shape had a
/// bare boolean, so a total miss came back with an empty `path` and nothing else — the
/// row could not say where it had looked, and there was nothing to reveal or copy.
export interface BgRead {
  path: string; text: string; len: number; unchanged: boolean;
  reason: BgMissReason; tried: string[]; rootRank: number; discovered: boolean;
}

/// Fold one log read into a record. Mutates in place, returns whether anything the UI
/// draws actually moved — the poll runs on every live server every few seconds, and a
/// dev server that nobody is hitting produces an identical read every time.
///
/// An `unchanged` read is the steady state and folds nothing: the backend did not even
/// open the file, so `text` is empty and treating it as content would blank the peek
/// and the URL on every poll.
export function applyBgLog(rec: BgServer, read: BgRead, now: number): boolean {
  let changed = false;
  const { path, text } = read;
  if (path && rec.log !== path) { rec.log = path; changed = true; }
  // The read resolved, so whatever the last miss said about this record is history and
  // must go with it: a stale `tried` list would leave the row offering to reveal the
  // places the log turned out not to be.
  if (rec.reason && rec.reason !== "none") { rec.reason = "none"; rec.tried = []; changed = true; }
  // The clock retirement runs on, cleared here and stamped in `applyBgMiss`. Nothing the
  // UI draws reads it, so it never flags a change.
  rec.missSince = undefined;
  // Assigned without flagging a change, deliberately. The rank only ever moves when the
  // root does, and a different root means a different `path` — which the line above has
  // already reported. Flagging it here would be a second vote for one event.
  rec.rootRank = read.rootRank;
  if (read.unchanged) { rec.len = read.len; return changed; }
  rec.len = read.len;
  const url = serverUrl(text);
  if (url && rec.url !== url) { rec.url = url; changed = true; }
  const tail = logTail(text);
  if (tail.join("\n") !== (rec.tail ?? []).join("\n")) { rec.tail = tail; changed = true; }
  const sent = bgSentinel(text);
  // `undefined` means "still running", which must never *clear* an end: a record ended
  // by the agent's own TaskStop is ended before the process has written its last line,
  // and re-reading the file in that window would otherwise un-end it every poll. That
  // guard is `endBg`'s now. An unknown ending keeps `exit: null` and says what it was in
  // `endReason` instead, so nothing downstream reads it as a failure.
  if (sent) {
    const end: BgEnd = sent.kind === "unknown" ? "unknown" : "sentinel";
    if (endBg(rec, now, end, sent.kind === "exit" ? sent.code : null)) changed = true;
  }
  return changed;
}

/// Fold a read that found NOTHING. The poll's other branch, and the one that used to
/// throw its answer away: a miss set `log` from `path` and returned, so a row could not
/// say which silence it was in, and a total miss — which is what every read was while
/// the backend probed a directory Claude Code has never written to — left the record
/// with no log to reveal, no candidate to copy and no reason to show.
///
/// Nothing here is inferred. `reason` and `tried` come off `read_bg_log` verbatim,
/// because this module cannot see a filesystem and an opinion it formed about one would
/// be exactly the guess that shipped the bug.
///
/// `now` is stamped in exactly one place: the FIRST poll that found nothing. That is the
/// clock `bgRetire` runs on, and it has to start here rather than at `startedAt` — a
/// record whose log has been read all afternoon is already older than the retirement
/// window the instant its file goes, and would be given up on within four seconds.
export function applyBgMiss(rec: BgServer, read: BgRead, now: number): boolean {
  let changed = false;
  // Not part of `changed`: it moves no pixel. It is stamped for every miss, not just a
  // `notYet` one, because an outage that turns into a `notYet` is still a log that has
  // been absent since here — and `bgRetire` is what decides which reasons may end a row.
  rec.missSince ??= now;
  // Only `notYet` carries a path, and it is the file being waited for — worth keeping,
  // since it is what the row's *reveal* opens once the log finally lands.
  if (read.path && rec.log !== read.path) { rec.log = read.path; changed = true; }
  if (rec.reason !== read.reason) { rec.reason = read.reason; changed = true; }
  // Compared by content rather than by identity: the backend builds a fresh array every
  // poll, so `!==` would report a change on every tick of a fleet that is standing still.
  if ((rec.tried ?? []).join("\n") !== read.tried.join("\n")) { rec.tried = read.tried; changed = true; }
  rec.rootRank = read.rootRank;
  return changed;
}

/// End a record, naming which of the four endings it was. The single place `ended` is
/// set from a log or a lifecycle event, so the "never un-end" rule lives once.
///
/// It never overwrites an existing `ended`, and that guard is load-bearing rather than
/// defensive: a record ended by the agent's own `TaskStop` is ended before the process
/// has written its last line, and a poll landing in that window would otherwise re-end
/// it — restamping the time and relabelling the ending on every read.
export function endBg(rec: BgServer, now: number, end: BgEnd, exit: number | null): boolean {
  if (rec.ended) return false;
  rec.ended = now; rec.exit = exit; rec.endReason = end;
  return true;
}

/// How long a record with a findable-but-absent log is given before it is retired.
export const BG_RETIRE_MS = 10 * 60_000;

/// Should this record be given up on? Ends it as `stale` if so.
///
/// A shell whose log never appears has nothing left to say: no URL, no peek, and no
/// sentinel to end it — so before this it sat at "starting…" for the life of the
/// session, which is the symptom the whole fix is about.
///
/// **It fires on `notYet` and on nothing else.** That is the entire safety of the rule:
/// `notYet` means the backend *found* a root holding this session and the file simply is
/// not in it, which after ten minutes is an answer. `noRoot` and `ambiguous` mean the
/// probe could not say where to look — an outage, not an ending — and retiring on those
/// would take this feature from "rows that never leave" to "rows that always leave",
/// which is the same silence one layer along and much harder to notice.
///
/// A record that has a URL is never retired whatever its log is doing: something
/// answered, and that is better evidence than a file we cannot find.
///
/// **The ten minutes are measured from when the log went MISSING**, not from when the
/// shell started. The two are the same number for the case this rule is named after, and
/// wildly different for the one that would have gone wrong: a `sleep 900` whose log is
/// read for eleven minutes and then removed — by a `/tmp` reaper, or by an agent tidying
/// up after itself — is already past the window the moment it first misses, so an age
/// test would end it on the very next poll and label a log that appeared and was read
/// all afternoon "log never appeared". `missSince` falls back to `startedAt` so a record
/// that has never been through `applyBgMiss` still retires on its age.
export function bgRetire(rec: BgServer, now: number): boolean {
  if (rec.ended || rec.url) return false;
  if (rec.reason !== "notYet") return false;
  if (now - (rec.missSince ?? rec.startedAt) <= BG_RETIRE_MS) return false;
  return endBg(rec, now, "stale", null);
}

// ---------- the ports the kernel says are open ----------

/// One TCP port a session's process tree is listening on, from `session_ports`.
export interface SessionPort { sessionId: string; port: number; pid: number; name: string }

/// The port a URL names, or 0. Absent ports are the scheme's default, which is what
/// makes `http://localhost` and `http://localhost:80` the same server.
export function portOf(url: string): number {
  const m = /^(https?):\/\/[^/:]+(?::(\d{1,5}))?/i.exec(url);
  if (!m) return 0;
  return m[2] ? Number(m[2]) : m[1].toLowerCase() === "https" ? 443 : 80;
}

/// Node's inspector, and the worker variant beside it. Both are debugger control
/// channels that speak a WebSocket protocol to a devtools client — never a page, and
/// `node --inspect` is a thing agents reach for constantly.
const DEBUG_PORTS = new Set([9229, 9230]);

/// IANA's dynamic/private range, and the floor of the ephemeral range Windows and macOS
/// hand out. A port in it was chosen by the *kernel*, not by a person or a config file.
const EPHEMERAL_FROM = 49152;

/// Is this port worth putting in front of somebody?
///
/// The scan finds every listening socket under a pane, and a dev server is rarely just
/// one: a single `wrangler dev` measured on this machine held **five** — the server you
/// want on 8788, Node's inspector on 9229, and three kernel-assigned control channels in
/// the 63xxx range. Listing all five would put four pieces of noise in front of one
/// useful row, on the surface whose whole value is that you can trust the count.
///
/// So the rule is: a server you would open is on a port somebody *chose*. An ephemeral
/// port is by definition one nobody chose, which is what makes this a principle rather
/// than a denylist — the two named ports are the only hardcoded exceptions, and both are
/// debugger endpoints rather than servers.
///
/// The cost is a real server on an ephemeral port (`vite --port 0`) going unlisted here.
/// That is the right way round: this scan is the *fallback* for servers nobody
/// announced, and a server on a random port has to announce itself to be reachable at
/// all — so the log path already has it.
export function usefulPort(port: number): boolean {
  return port > 0 && port < EPHEMERAL_FROM && !DEBUG_PORTS.has(port);
}

/// Is this record a command Claude backgrounded on its own timeout rather than a shell
/// the agent asked for? Such a record may never adopt a loose port.
///
/// The one thing `timedOutAfterMs` is allowed to decide, and it is deliberately not the
/// popover's heading (`bgKind` answers that, off evidence). The two questions are
/// different: *is this a server?* has a real answer — a URL — while this one asks only
/// whether a record may be handed an address it never claimed. A `pytest` run that
/// crossed 120s is live, listening on nothing, and sitting in exactly the position that
/// the one-silent-one-loose rule would hand a port to.
export function isJob(b: BgServer): boolean {
  return (b.timedOut ?? 0) > 0;
}

/// Reconcile what a session *said* against what it is actually listening on, and
/// return the ports nothing here accounts for.
///
/// This is the join that makes the whole feature trustworthy. A parsed log line is a
/// guess about somebody else's output format; a listening socket is the kernel's
/// answer. Three steps, in order, each narrower than the last:
///
/// 1. **A port some record already names is that record's.** Nothing to do — the
///    record's own URL is better than a bare port, since it carries the scheme and any
///    base path the server announced.
/// 2. **One silent record, one loose port → they are each other.** A shell that
///    started something we never got a URL for, and exactly one unexplained port under
///    the same pane, is that pane's server essentially always. **Exactly one on both
///    sides**: with two of either there is no way to tell which belongs to which, and a
///    row pointing at the wrong port is worse than a row still saying "starting…". Same
///    fail-closed rule as `checkoutDrift` in ./gitwatch.
///
///    A job (`isJob`) is not a candidate. Claude backgrounds anything past 120s, so a
///    `pytest` or an `npm ci` sits here silent and eligible, and handing it the vite port
///    running in the same pane would put a live address on a row that serves nothing.
///    Cutting them out also *unblocks* the rule in the commoner direction: two silent
///    records against one loose port is a fail-closed no-op, and when one of the two is
///    a timed-out job the remaining pair is 1-and-1 and adopts.
/// 3. **Whatever is left is a server nobody modelled** — one started by hand in a shell
///    pane, or one whose banner we cannot parse. It gets a row of its own, which is the
///    only way those have ever been visible at all.
export function reconcilePorts(
  records: BgServer[], taskUrl: string | undefined, ports: readonly number[],
): { loose: number[]; changed: boolean } {
  const live = liveServers(records);
  const claimed = new Set<number>();
  if (taskUrl) claimed.add(portOf(taskUrl));
  for (const b of live) if (b.url) claimed.add(portOf(b.url));
  // `usefulPort` first, and it applies to adoption too: a record with no URL must never
  // adopt a kernel-assigned control socket, which would put an address on the row that
  // serves nothing.
  const loose = [...new Set(ports)]
    .filter((p) => usefulPort(p) && !claimed.has(p))
    .sort((a, b) => a - b);

  const silent = live.filter((b) => !b.url && !isJob(b));
  if (loose.length === 1 && silent.length === 1) {
    silent[0].url = `http://localhost:${loose[0]}`;
    return { loose: [], changed: true };
  }
  return { loose, changed: false };
}

// ---------- what the header asks ----------

/// The records still running. Everything the indicator counts, and everything the poll
/// re-reads; a finished one keeps its row but costs nothing further.
export function liveServers(list: readonly BgServer[]): BgServer[] {
  return list.filter((b) => !b.ended);
}

/// The ones worth a badge: a background shell that has announced a URL. A `sleep 45` an
/// agent backgrounded is live, and listed, but it is not something you can go and look
/// at — counting it would make the indicator mean "the agent is doing something", which
/// the phase glyphs already say better.
export function servingUrls(list: readonly BgServer[]): BgServer[] {
  return liveServers(list).filter((b) => b.url);
}

/// The ones that died on their own, with something to say about it.
///
/// Without this the feature has a hole exactly where it hurts: a dev server that exits
/// on `EADDRINUSE` two seconds after starting would take the count from 1 back to 0 and
/// say nothing, which is the *same* silence the whole feature exists to end. So a
/// non-zero exit stays on the list until it is dismissed — the rule task panes already
/// follow, where "successful runs auto-dismiss, failures persist" (docs/tasks.md).
///
/// Two endings are deliberately excluded. `exit === 0` is a background shell that
/// simply finished, which is what a one-shot `pnpm build` in the background looks like
/// and is not news. `exit === null` is a kill — the agent's `TaskStop`, or the session
/// ending — which is somebody having *asked* for this, and a row reporting back an
/// outcome you requested is noise.
export function failedServers(list: readonly BgServer[]): BgServer[] {
  return list.filter((b) => b.ended && b.exit != null && b.exit !== 0);
}

/// Everything the popover draws: still running, plus the failures nobody has read yet.
/// Distinct from `liveServers`, which is what the poll re-reads — a dead log has
/// nothing left to say and must not be read forever.
export function shownServers(list: readonly BgServer[]): BgServer[] {
  return [...liveServers(list), ...failedServers(list)];
}

/// Drop one record. Only ever a *failed* one, from its dismiss button: a live server is
/// removed by stopping it, and forgetting one while its port is still held would put
/// the app back to lying about what is running.
export function forgetServer(list: BgServer[], taskId: string): boolean {
  const i = list.findIndex((b) => b.taskId === taskId && b.ended);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}

/// Which heading a record goes under, decided on **evidence**: a URL — printed by the
/// process or adopted off a listening socket — is a server, and everything else is a
/// job. Nothing here reads the command, because `pnpm dev` and `npm ci` are the same
/// string to a rule, and a rule that fires on ordinary commands is worse than no rule
/// (./health's, one floor down).
///
/// Deliberately not `isJob`'s question. `timedOutAfterMs` says how a shell came to be
/// backgrounded, which is a fine reason to refuse it a port and a terrible reason to
/// call it a job on screen: an agent's `pnpm dev` that Claude backgrounded on the
/// timeout is still a server, and it says so the moment it prints its URL.
export function bgKind(b: BgServer): BgKind {
  return b.url ? "server" : "job";
}

/// Is this row's silence an outage rather than an answer? True when the backend could
/// not resolve a root at all, which is the state the header says out loud rather than
/// letting it read as a quiet fleet — `serve_telemetry`'s red badge, one level down.
export function bgBlind(b: BgServer): boolean {
  return b.reason === "noRoot" || b.reason === "ambiguous";
}

/// The path a row's reveal/copy acts on: the resolved log if there is one, else the
/// first place the backend looked. A candidate is worth offering — "I looked here and
/// it is not there" is a debuggable sentence, and an empty string is not.
export function bgLogPath(b: BgServer): string {
  return b.log || b.tried?.[0] || "";
}

/// What the peek says when it has no lines to show. Six silences that used to read as
/// one — "no output yet" — which is true for exactly one of them and a lie for the rest:
/// the log the app spent this feature's whole life failing to find said "no output yet"
/// every four seconds for the life of the session.
export function bgPeekEmpty(b: BgServer): string {
  switch (b.reason) {
    case "noRoot": return `no log found — looked in ${b.tried?.length ?? 0} places`;
    case "ambiguous": return "two logs match — refusing to guess";
    case "notYet": return "no log file yet";
    case "unreadable": return "the log could not be read";
    case "badId": return "no log address for this shell";
    // "none" and a record that has never been read: the file is there and genuinely has
    // nothing in it, which is what a dev server looks like for its first second.
    default: return "no output yet";
  }
}

/// What a finished record says about how it went, for the row.
///
/// Three of the four endings carry `exit: null`, so the code alone cannot answer — and
/// each of the three would otherwise read as "stopped", which claims somebody asked for
/// it. Only the unnamed ending keeps that reading, because unqualified `exit: null` has
/// always meant the agent's own `TaskStop`.
export function bgOutcome(b: BgServer): string {
  if (!b.ended) return "";
  switch (b.endReason) {
    case "unknown": return "ended";
    case "stale": return "log never appeared";
    case "session": return "session ended";
  }
  return b.exit == null ? "stopped" : b.exit === 0 ? "finished" : `exited ${b.exit}`;
}

/// The short label a row shows for the command. A backgrounded dev server is nearly
/// always `cd <somewhere> && <the interesting part>`, and the `cd` is both the longest
/// and the least informative half — the row already says which project it belongs to.
export function cmdLabel(cmd: string, max = 52): string {
  let c = cmd.trim();
  const m = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*(.+)$/s.exec(c);
  if (m) c = m[1].trim();
  // A shell redirect to a log file is plumbing the agent added, never the command.
  c = c.replace(/\s*(?:\d?>>?|2>&1)\s*(?:"[^"]*"|'[^']*'|\S+)?\s*/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
}
