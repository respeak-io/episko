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
// and the log the process is writing lives beside the session's transcript, at
// `<tmp>/claude/<slug>/<uuid>/tasks/<backgroundTaskId>.output` — which is what
// `read_bg_log` resolves. That file is the whole feature: it carries the URL the
// server printed, its last lines, and a closing sentinel when the process dies.
//
// This module is the pure half — payload in, records out, log text in, facts out. It
// owns no DOM, no IPC and no timers; ./serversui owns those. Same split, and the same
// reason for it, as ./gitwatch beside it.
//
// **Two directions of error, and they cost differently.** A false positive is a row for
// something that was never a server (`sleep 45` backgrounded by an agent is a perfectly
// ordinary thing to do): it appears in the popover with no URL, and it leaves when the
// sentinel lands. That is noise. A false negative is the state this feature exists to
// end — a port held by nothing you can name. So this leans inclusive: **every**
// backgrounded shell becomes a record, and the URL is what promotes one to a server.

import type { BgServer } from "./types";

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
  list.push({
    taskId,
    cmd: bgCmd(input),
    // Captured now, deliberately: see the `transcript` note on `BgServer`.
    transcript: typeof transcript === "string" ? transcript : "",
    startedAt: now,
  });
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

/// The sentinel Claude Code appends when a background shell finishes: `[exited with
/// code N]`, or `[killed]` when it was stopped rather than allowed to end. Returns the
/// exit code (null for a kill), or `undefined` while the process is still running.
///
/// This is the liveness answer, and it is better than the two obvious alternatives. An
/// mtime says only when the file was last written, and a dev server that nobody is
/// hitting writes nothing for hours; a process-table lookup would need the pid, which
/// no payload carries. The sentinel is the process's own last word.
export function bgSentinel(text: string): number | null | undefined {
  const m = /^\[exited with code (-?\d+)\]\s*$/m.exec(text);
  if (m) return Number(m[1]);
  if (/^\[killed\]\s*$/m.test(text)) return null;
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

/// One `read_bg_log` answer, as the command returns it.
export interface BgRead { path: string; text: string; len: number; unchanged: boolean }

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
  if (read.unchanged) { rec.len = read.len; return changed; }
  rec.len = read.len;
  const url = serverUrl(text);
  if (url && rec.url !== url) { rec.url = url; changed = true; }
  const tail = logTail(text);
  if (tail.join("\n") !== (rec.tail ?? []).join("\n")) { rec.tail = tail; changed = true; }
  const sent = bgSentinel(text);
  // `undefined` means "still running", which must never *clear* an end: a record ended
  // by the agent's own TaskStop is ended before the process has written its last line,
  // and re-reading the file in that window would otherwise un-end it every poll.
  if (sent !== undefined && !rec.ended) { rec.ended = now; rec.exit = sent; changed = true; }
  return changed;
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

  const silent = live.filter((b) => !b.url);
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

/// What a finished record says about how it went, for the row.
export function bgOutcome(b: BgServer): string {
  if (!b.ended) return "";
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
