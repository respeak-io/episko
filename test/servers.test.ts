import { describe, expect, it } from "vitest";
import {
  applyBg, applyBgLog, applyBgMiss, BG_RETIRE_MS, bgBlind, bgKind, bgLogPath, bgOutcome,
  bgPeekEmpty, bgRetire, bgSentinel, bgStopId, bgTaskId, bgTimedOut, cmdLabel, endBg,
  failedServers, forgetServer, isJob, liveServers, logLines, logTail, serverUrl,
  portOf, reconcilePorts, servingUrls, shownServers, taskServerUrl, usefulPort,
  type BgRead,
} from "../src/servers";
import type { BgMissReason, BgServer } from "../src/types";

// Every payload and log excerpt below was captured off the real CLI and real vite/uvicorn/pnpm
// output: each field this module reads belongs to a format nobody in this repo controls.

/** A PostToolUse payload for a shell the agent backgrounded, as the hook delivers it. */
const started = (id: string, cmd = "pnpm dev") => ({
  tool: "Bash",
  input: { command: cmd, description: "Start the dev server", run_in_background: true },
  response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
});

/** A command Claude backgrounded itself at the 120s timeout; the input never asked for it. */
const autoBg = (id: string, cmd: string) => ({
  tool: "Bash",
  input: { command: cmd, description: "Run the check" },
  response: {
    stdout: "", stderr: "", interrupted: false, isImage: false,
    timedOutAfterMs: 120000, backgroundTaskId: id,
  },
});

const mk = (id: string, over: Partial<BgServer> = {}): BgServer =>
  ({ taskId: id, cmd: "pnpm dev", transcript: "t", startedAt: 0, ...over });

/** A resolved `read_bg_log` answer; `missing` is intersected in at the invoke site, never here. */
const read = (text: string, unchanged = false): BgRead =>
  ({ path: "/tmp/x.output", text, len: text.length, unchanged, reason: "none", tried: [], rootRank: 0, discovered: false });

/** One that found nothing. Exactly one of `path` and `tried` is ever the answer. */
const miss = (reason: BgMissReason, over: Partial<BgRead> = {}): BgRead =>
  ({ path: "", text: "", len: 0, unchanged: false, reason, tried: [], rootRank: -1, discovered: false, ...over });

describe("recognising a backgrounded shell", () => {
  it("reads the id off the RESPONSE, which is the only place it exists", () => {
    const p = started("bczk8s47b");
    expect(bgTaskId(p.tool, p.response)).toBe("bczk8s47b");
  });

  it("does not invent one from `run_in_background` alone", () => {
    // Only the response says whether it got one, and only it carries the handle TaskStop needs.
    expect(bgTaskId("Bash", { stdout: "", stderr: "" })).toBe("");
  });

  it("ignores the tools that OPERATE on a shell rather than create one", () => {
    // TaskOutput echoes the same id; reading it as a start would resurrect a retired record.
    expect(bgTaskId("TaskOutput", { backgroundTaskId: "bczk8s47b" })).toBe("");
    expect(bgTaskId("TaskStop", { backgroundTaskId: "bczk8s47b" })).toBe("");
  });

  it("reads TaskStop's id from its input", () => {
    expect(bgStopId("TaskStop", { task_id: "bc1sxie6v" })).toBe("bc1sxie6v");
    expect(bgStopId("Bash", { task_id: "bc1sxie6v" })).toBe("");
    expect(bgStopId("TaskStop", {})).toBe("");
  });

  it("reads the timeout Claude Code stamps on a command it auto-backgrounded", () => {
    const p = autoBg("bc4t2mzq1", "python3 -c 'import time; time.sleep(600)'");
    expect(p.input).not.toHaveProperty("run_in_background");
    expect(bgTimedOut(p.response)).toBe(120000);

    const list: BgServer[] = [];
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", 1_000);
    expect(list[0].timedOut).toBe(120000);
    expect(isJob(list[0])).toBe(true);
  });

  it("leaves the timeout unset on a background the agent actually asked for", () => {
    // The absence case: a rule answering "timed out" for everything passes the test above.
    const p = started("bs0hhu7b4");
    expect(bgTimedOut(p.response)).toBe(0);
    expect(bgTimedOut({})).toBe(0);
    expect(bgTimedOut(null)).toBe(0);

    const list: BgServer[] = [];
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", 1_000);
    expect(list[0].timedOut).toBeUndefined();
    expect(isJob(list[0])).toBe(false);
  });
});

describe("applyBg", () => {
  const now = 1_000;

  it("records a started shell, with the transcript path captured AT START", () => {
    const list: BgServer[] = [];
    const p = started("bs0hhu7b4");
    const tr = "/h/.claude/projects/E--proj/819131de-4c0e-4a7e-a5c5-2d4a5550a104.jsonl";
    expect(applyBg(list, p.tool, p.input, p.response, tr, now)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ taskId: "bs0hhu7b4", cmd: "pnpm dev", transcript: tr, startedAt: now });
  });

  it("does not duplicate a shell it already holds", () => {
    const list: BgServer[] = [];
    const p = started("bs0hhu7b4");
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", now);
    expect(applyBg(list, p.tool, p.input, p.response, "t.jsonl", now + 5)).toBe(false);
    expect(list).toHaveLength(1);
    expect(list[0].startedAt).toBe(now); // the first sighting is the start
  });

  it("ends the record TaskStop names, and reports it as a kill", () => {
    const list: BgServer[] = [];
    const p = started("bs0hhu7b4");
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", now);
    expect(applyBg(list, "TaskStop", { task_id: "bs0hhu7b4" }, {}, "t.jsonl", now + 90)).toBe(true);
    expect(list[0].ended).toBe(now + 90);
    // A stop is a kill, not an exit; an unqualified `exit: null` means "somebody asked for this".
    expect(list[0].exit).toBeNull();
    expect(list[0].endReason).toBeUndefined();
    expect(bgOutcome(list[0])).toBe("stopped");
  });

  it("ignores a TaskStop for a shell it never saw, and a second stop", () => {
    const list: BgServer[] = [];
    expect(applyBg(list, "TaskStop", { task_id: "ghost" }, {}, "t.jsonl", now)).toBe(false);
    const p = started("bs0hhu7b4");
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", now);
    applyBg(list, "TaskStop", { task_id: "bs0hhu7b4" }, {}, "t.jsonl", now + 5);
    expect(applyBg(list, "TaskStop", { task_id: "bs0hhu7b4" }, {}, "t.jsonl", now + 9)).toBe(false);
    expect(list[0].ended).toBe(now + 5); // the FIRST stop is when it ended
  });

  it("says nothing changed for the tool calls that are neither event", () => {
    const list: BgServer[] = [];
    expect(applyBg(list, "Read", { file_path: "/a" }, { type: "text" }, "t.jsonl", now)).toBe(false);
    expect(applyBg(list, "Bash", { command: "ls" }, { stdout: "a\nb" }, "t.jsonl", now)).toBe(false);
    expect(list).toHaveLength(0);
  });
});

describe("reading the log", () => {
  // Real vite output, byte for byte off a running session's log file.
  const VITE = `
> frontend@0.0.0 dev E:\\proj\\frontend
> vite

  VITE v8.1.5  ready in 1114 ms

  ➜  Local:   http://localhost:5555/
  ➜  Network: use --host to expose
  ➜  Vue DevTools: Open http://localhost:5555/__devtools__/ as a separate window
18:03:56 [vite] (client) hmr update /src/App.vue
`;

  it("finds the URL a dev server printed", () => {
    expect(serverUrl(VITE)).toBe("http://localhost:5555");
  });

  it("finds uvicorn's, which announces itself in a different shape entirely", () => {
    expect(serverUrl("INFO:     Uvicorn running on http://127.0.0.1:8787 (Press CTRL+C to quit)"))
      .toBe("http://127.0.0.1:8787");
  });

  it("rewrites the bind addresses no browser will open", () => {
    expect(serverUrl("Listening on http://0.0.0.0:3000")).toBe("http://localhost:3000");
    expect(serverUrl("server started at http://[::]:8080")).toBe("http://localhost:8080");
  });

  it("prefers the announcement over a URL the agent merely mentioned", () => {
    const log = "Uvicorn running on http://127.0.0.1:8787\nGET http://localhost:9999/ping 200\n";
    expect(serverUrl(log)).toBe("http://127.0.0.1:8787");
  });

  it("takes the LAST announcement, so a self-restart wins over the stale line", () => {
    // vite reprints its banner on a config change, sometimes on a new port.
    const log = VITE + "\n[vite] config changed, restarting\n\n  ➜  Local:   http://localhost:5556/\n";
    expect(serverUrl(log)).toBe("http://localhost:5556");
  });

  it("returns nothing for output that names no server", () => {
    expect(serverUrl("306 passed (10.0m)\n")).toBe("");
    // A remote URL is not a local server, however loudly the line announces it.
    expect(serverUrl("Local build ready, deployed to https://example.com/")).toBe("");
  });

  it("reads the closing sentinel, and distinguishes an exit from a kill", () => {
    expect(bgSentinel("done\n[exited with code 0]\n")).toEqual({ kind: "exit", code: 0 });
    expect(bgSentinel("boom\n[exited with code 1]\n")).toEqual({ kind: "exit", code: 1 });
    expect(bgSentinel("\n[killed]")).toEqual({ kind: "killed" });
    // Still running is `undefined`, distinct from a kill: only one of them may end a record.
    expect(bgSentinel(VITE)).toBeUndefined();
  });

  it("reads [exited with code unknown] as an ending, without calling it a failure", () => {
    // Written when the reaper has no status; `exit: null` alone means killed, so `endReason` carries it.
    expect(bgSentinel("gone\n[exited with code unknown]\n")).toEqual({ kind: "unknown" });

    const b = mk("b1");
    expect(applyBgLog(b, read("gone\n[exited with code unknown]\n"), 20)).toBe(true);
    expect(b.ended).toBe(20);
    expect(b.exit).toBeNull();
    expect(b.endReason).toBe("unknown");
    expect(bgOutcome(b)).toBe("ended");
    // `exit: null` keeps the header pill from going red for a shell that never failed.
    expect(failedServers([b])).toEqual([]);
  });

  it("is not fooled by the two bracket lines that are NOT endings", () => {
    // Both are written into a log still being appended to; ending on either drops a live server.
    expect(bgSentinel("...\n[output truncated: exceeded 5GB disk cap]\n")).toBeUndefined();
    expect(bgSentinel("[output omitted: it could not be written to disk]\n")).toBeUndefined();
  });

  it("collapses a redrawn line to what a terminal would have shown", () => {
    // Progress bars redraw with \r; splitting on \n alone turns one spinner into hundreds of lines.
    expect(logLines("Progress: 1%\rProgress: 50%\rProgress: 100%\ndone")).toEqual(["Progress: 100%", "done"]);
  });

  it("takes the tail, not the head", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const tail = logTail(text, 3);
    expect(tail).toEqual(["line 37", "line 38", "line 39"]);
  });
});

describe("applyBgLog", () => {
  it("folds in the path, the URL and the peek, and says something changed", () => {
    const b = mk("b1");
    expect(applyBgLog(b, read("  ➜  Local:   http://localhost:5555/\n"), 10)).toBe(true);
    expect(b.log).toBe("/tmp/x.output");
    expect(b.url).toBe("http://localhost:5555");
    // Leading indentation is kept; only the trailing edge and \r redraws are tidied.
    expect(b.tail).toEqual(["  ➜  Local:   http://localhost:5555/"]);
    expect(b.rootRank).toBe(0);
  });

  it("reports NO change on an identical re-read", () => {
    // The poll re-reads every live log every few seconds; true here would repaint forever.
    const b = mk("b1");
    const text = "  ➜  Local:   http://localhost:5555/\n";
    applyBgLog(b, read(text), 10);
    expect(applyBgLog(b, read(text), 20)).toBe(false);
  });

  it("ends a record when the sentinel appears, and keeps the exit code", () => {
    const b = mk("b1");
    applyBgLog(b, read("starting\n"), 10);
    expect(b.ended).toBeUndefined();
    expect(applyBgLog(b, read("starting\nboom\n[exited with code 1]\n"), 20)).toBe(true);
    expect(b.ended).toBe(20);
    expect(b.exit).toBe(1);
    expect(b.endReason).toBe("sentinel");
    expect(bgOutcome(b)).toBe("exited 1");
  });

  it("never un-ends a record the agent's TaskStop already ended", () => {
    // The `[killed]` line lands a poll after the TaskStop; a poll in between must not resurrect the row.
    const b = mk("b1", { ended: 50, exit: null, log: "/tmp/x.output", tail: ["still going"] });
    expect(applyBgLog(b, read("still going\n"), 60)).toBe(false);
    expect(b.ended).toBe(50);
    expect(b.exit).toBeNull();
  });
});

describe("a read that found nothing", () => {
  it("folds a missing read's reason and tried list without touching the peek", () => {
    // The row has to be able to say where it looked.
    const b = mk("a", { url: "http://localhost:5173", tail: ["serving"] });
    const tried = ["/tmp/claude-501/-p-proj/8191/tasks/a.output", "/tmp/claude/-p-proj/8191/tasks/a.output"];
    expect(applyBgMiss(b, miss("noRoot", { tried }), 10)).toBe(true);
    expect(b.reason).toBe("noRoot");
    expect(b.tried).toEqual(tried);
    expect(b.rootRank).toBe(-1);
    // A probe that lost the log is not evidence that the server stopped serving.
    expect(b.url).toBe("http://localhost:5173");
    expect(b.tail).toEqual(["serving"]);
    expect(b.ended).toBeUndefined();
    // The reveal falls back to the first place looked, which is something a person can act on.
    expect(bgLogPath(b)).toBe(tried[0]);
    // The backend builds a fresh `tried` array each poll; an identical answer must move nothing.
    expect(applyBgMiss(b, miss("noRoot", { tried: [...tried] }), 14)).toBe(false);
  });

  it("keeps the file a notYet is waiting for, and forgets the search once it lands", () => {
    // `notYet` is the one miss with a path: the root was found and the log is not in it yet.
    const b = mk("a");
    const path = "/tmp/claude-501/-p-proj/8191/tasks/a.output";
    expect(applyBgMiss(b, miss("notYet", { path, tried: [path], rootRank: 0 }), 10)).toBe(true);
    expect(b.log).toBe(path);
    expect(b.reason).toBe("notYet");

    applyBgLog(b, read("  ➜  Local:   http://localhost:5555/\n"), 20);
    expect(b.reason).toBe("none");
    expect(b.tried).toEqual([]);
    expect(bgLogPath(b)).toBe("/tmp/x.output");
  });

  it("says which silence a row is in", () => {
    expect(bgPeekEmpty(mk("a", { reason: "noRoot", tried: ["/a", "/b", "/c"] })))
      .toBe("no log found — looked in 3 places");
    expect(bgPeekEmpty(mk("a", { reason: "ambiguous" }))).toBe("two logs match — refusing to guess");
    expect(bgPeekEmpty(mk("a", { reason: "notYet" }))).toBe("no log file yet");
    expect(bgPeekEmpty(mk("a", { reason: "unreadable" }))).toBe("the log could not be read");
    expect(bgPeekEmpty(mk("a", { reason: "badId" }))).toBe("no log address for this shell");
    // A genuinely empty file and a record nothing has read yet say the same thing.
    expect(bgPeekEmpty(mk("a", { reason: "none" }))).toBe("no output yet");
    expect(bgPeekEmpty(mk("a"))).toBe("no output yet");

    // Blind is what the header says out loud; waiting is not blind.
    expect(bgBlind(mk("a", { reason: "noRoot" }))).toBe(true);
    expect(bgBlind(mk("a", { reason: "ambiguous" }))).toBe(true);
    expect(bgBlind(mk("a", { reason: "notYet" }))).toBe(false);
    expect(bgBlind(mk("a"))).toBe(false);
  });
});

describe("a shell whose log never appears", () => {
  it("retires a record whose root was found and whose log never appeared", () => {
    const b = mk("a", { reason: "notYet" });
    expect(bgRetire(b, BG_RETIRE_MS)).toBe(false); // at the deadline is not past it
    expect(bgRetire(b, BG_RETIRE_MS + 1)).toBe(true);
    expect(b.ended).toBe(BG_RETIRE_MS + 1);
    expect(b.endReason).toBe("stale");
    // `exit: null`, so nothing downstream reads a record that never failed as a failure.
    expect(b.exit).toBeNull();
    expect(bgOutcome(b)).toBe("log never appeared");
    expect(shownServers([b])).toEqual([]);
    expect(failedServers([b])).toEqual([]);

    // A record with an address is never retired: something answered, which beats a missing file.
    const serving = mk("b", { reason: "notYet", url: "http://localhost:5173" });
    expect(bgRetire(serving, BG_RETIRE_MS + 1)).toBe(false);
  });

  it("never retires a record the probe could not find a root for — that is an outage, not an ending", () => {
    // Retiring on every miss would empty the list the moment the probe breaks.
    for (const reason of ["noRoot", "ambiguous"] as const) {
      const b = mk("a", { reason });
      expect(bgRetire(b, BG_RETIRE_MS * 100)).toBe(false);
      expect(b.ended).toBeUndefined();
    }
  });

  it("counts the ten minutes from when the log went missing, not from when the shell started", () => {
    // A log read for an hour then lost to a /tmp reaper is already old; retiring on age ends it at once.
    const hour = 60 * 60_000;
    const b = mk("a", { startedAt: 0 });
    applyBgLog(b, read("still going\n"), 1_000);
    expect(b.missSince).toBeUndefined();

    applyBgMiss(b, miss("notYet", { path: "/tmp/x.output", tried: ["/tmp/x.output"], rootRank: 0 }), hour);
    expect(b.missSince).toBe(hour);
    expect(bgRetire(b, hour + 4_000)).toBe(false);
    expect(bgRetire(b, hour + BG_RETIRE_MS)).toBe(false);
    expect(bgRetire(b, hour + BG_RETIRE_MS + 1)).toBe(true);
    expect(b.endReason).toBe("stale");

    // A log that comes back resets the clock, so the next absence gets its own ten minutes.
    const c = mk("c", { startedAt: 0 });
    applyBgMiss(c, miss("notYet", { path: "/tmp/x.output", tried: ["/tmp/x.output"] }), 1_000);
    applyBgLog(c, read("back\n"), 2_000);
    expect(c.missSince).toBeUndefined();
    applyBgMiss(c, miss("notYet", { path: "/tmp/x.output", tried: ["/tmp/x.output"] }), 3_000);
    expect(bgRetire(c, 3_000 + BG_RETIRE_MS)).toBe(false);
    expect(bgRetire(c, 3_000 + BG_RETIRE_MS + 1)).toBe(true);
  });

  it("says nothing about a record whose log has not appeared in four seconds", () => {
    // The log lands seconds after the record does.
    const b = mk("a", { reason: "notYet" });
    expect(bgRetire(b, 4_000)).toBe(false);
    expect(b.ended).toBeUndefined();
    expect(liveServers([b])).toHaveLength(1);
  });
});

describe("a server Episko itself ran (just / VS Code task / npm script)", () => {
  // Real output, fed one line at a time as it arrives on the PTY stream.
  const feed = (lines: string[], start?: string) =>
    lines.reduce<string | undefined>((u, l) => taskServerUrl(u, l), start);

  it("latches the URL as the output streams", () => {
    expect(feed([
      "> frontend@0.0.0 dev",
      "> vite",
      "",
      "  VITE v8.1.5  ready in 1114 ms",
      "  ➜  Local:   http://localhost:5555/",
    ])).toBe("http://localhost:5555");
  });

  it("KEEPS it once the banner has scrolled out of the tail", () => {
    // `run.tail` is a rolling 40 lines; a URL rescanned from it would appear and then vanish.
    const hmr = Array.from({ length: 60 }, (_, i) => `18:0${i % 6}:0${i % 9} [vite] hmr update /src/App.vue`);
    expect(feed(hmr, "http://localhost:5555")).toBe("http://localhost:5555");
  });

  it("follows a restart onto a new port", () => {
    expect(feed(["  ➜  Local:   http://localhost:5556/"], "http://localhost:5555"))
      .toBe("http://localhost:5556");
  });

  it("refuses to latch onto a URL that is not an announcement", () => {
    // Stricter than `serverUrl`: this one sees a single line and its answer sticks.
    expect(feed(['  "GET /api/health" -> http://localhost:9999/ 200'])).toBeUndefined();
    expect(feed(["curl http://localhost:9999/ping"])).toBeUndefined();
    expect(feed(["curl http://localhost:9999/ping", "Listening on http://localhost:4000"]))
      .toBe("http://localhost:4000");
  });

  it("says nothing for a task that is not a server at all", () => {
    expect(feed(["> tsc --watch", "Found 0 errors. Watching for file changes."])).toBeUndefined();
    expect(feed(["306 passed (10.0m)"])).toBeUndefined();
  });
});

describe("reconciling what a pane SAID against what it is listening on", () => {
  it("reads a port off a URL, defaults included", () => {
    expect(portOf("http://localhost:5555")).toBe(5555);
    expect(portOf("http://localhost")).toBe(80);
    expect(portOf("https://localhost")).toBe(443);
    expect(portOf("")).toBe(0);
  });

  it("leaves alone a port a record already names", () => {
    // The record's own URL carries the scheme and any base path; a bare port does not.
    const list = [mk("a", { url: "http://localhost:5555" })];
    const got = reconcilePorts(list, undefined, [5555]);
    expect(got.loose).toEqual([]);
    expect(got.changed).toBe(false);
  });

  it("matches a task's URL too, not just an agent's", () => {
    expect(reconcilePorts([], "http://localhost:1420", [1420]).loose).toEqual([]);
  });

  it("adopts one loose port onto the one record that never said anything", () => {
    const silent = mk("a");
    const got = reconcilePorts([silent], undefined, [5555]);
    expect(got.changed).toBe(true);
    expect(silent.url).toBe("http://localhost:5555");
    expect(got.loose).toEqual([]);
  });

  it("refuses to guess when either side is ambiguous", () => {
    // Fail closed, like checkoutDrift in ./gitwatch: a wrong port is worse than "starting…".
    const two = [mk("a"), mk("b")];
    expect(reconcilePorts(two, undefined, [5555]).changed).toBe(false);
    expect(two.every((b) => !b.url)).toBe(true);

    const one = [mk("a")];
    expect(reconcilePorts(one, undefined, [5555, 8787]).changed).toBe(false);
    expect(one[0].url).toBeUndefined();
    expect(reconcilePorts(one, undefined, [5555, 8787]).loose).toEqual([5555, 8787]);
  });

  it("never lets an auto-backgrounded command adopt a loose port", () => {
    const job = mk("a", { cmd: "python3 -c 'import time; time.sleep(600)'", timedOut: 120000 });
    const got = reconcilePorts([job], undefined, [5173]);
    expect(got.changed).toBe(false);
    expect(job.url).toBeUndefined();
    // The port is still reported unexplained, so whatever is really on it gets a row.
    expect(got.loose).toEqual([5173]);
  });

  it("adopts once the only other silent record turns out to be a job", () => {
    // The fail-closed case passes with or without the job exclusion, so it guards neither half of this.
    const server = mk("a"), job = mk("b", { cmd: "pytest -q", timedOut: 120000 });
    const got = reconcilePorts([server, job], undefined, [5173]);
    expect(got.changed).toBe(true);
    expect(server.url).toBe("http://localhost:5173");
    expect(job.url).toBeUndefined();
    expect(got.loose).toEqual([]);
  });

  it("ignores a record that has already ended", () => {
    // A crashed shell must not adopt the port of whatever replaced it.
    const dead = mk("a", { ended: 5, exit: 1 });
    const got = reconcilePorts([dead], undefined, [5555]);
    expect(dead.url).toBeUndefined();
    expect(got.loose).toEqual([5555]);
  });

  it("drops the sockets that are not servers", () => {
    // One real `wrangler dev` holds five listening sockets, of which one is the server.
    expect(usefulPort(8788)).toBe(true);
    expect(usefulPort(3000)).toBe(true);
    expect(usefulPort(9229)).toBe(false); // node --inspect
    expect(usefulPort(9230)).toBe(false); // …and its worker
    expect(usefulPort(63720)).toBe(false); // kernel-assigned
    expect(usefulPort(0)).toBe(false);
    expect(reconcilePorts([], undefined, [8788, 9229, 63720, 63721, 63199]).loose).toEqual([8788]);
  });

  it("never adopts a control socket onto a silent record", () => {
    const silent = mk("a");
    expect(reconcilePorts([silent], undefined, [63720]).changed).toBe(false);
    expect(silent.url).toBeUndefined();
  });

  it("reports a port nothing here can explain", () => {
    // A server typed by hand into a shell pane has no hook, log or record; the kernel still knows.
    expect(reconcilePorts([], undefined, [8100]).loose).toEqual([8100]);
  });

  it("counts one server once however many addresses it bound", () => {
    expect(reconcilePorts([], undefined, [3000, 3000, 3000]).loose).toEqual([3000]);
  });
});

describe("the poll's cheap path", () => {
  it("keeps the length the backend reports, so the next read can be skipped", () => {
    const b = mk("b1");
    applyBgLog(b, read("hello\n"), 10);
    expect(b.len).toBe(6);
  });

  it("folds NOTHING from an unchanged read, whose text is empty by construction", () => {
    // `text: ""` on an unchanged read means "I didn't look", not "the log is empty".
    const b = mk("b1");
    applyBgLog(b, read("  Local: http://localhost:5555/\n"), 10);
    expect(b.url).toBe("http://localhost:5555");

    expect(applyBgLog(b, { ...read("", true), len: 33 }, 20)).toBe(false);
    expect(b.url).toBe("http://localhost:5555");
    expect(b.tail).toEqual(["  Local: http://localhost:5555/"]);
    expect(b.ended).toBeUndefined(); // and an unchanged read must not read as a death
  });
});

describe("a server that died on its own", () => {
  it("stays on the list, because vanishing is the silence the feature exists to end", () => {
    // The commonest failure is EADDRINUSE two seconds in; dropping the row would say nothing.
    const list = [mk("crashed", { ended: 5, exit: 1 })];
    expect(failedServers(list).map((b) => b.taskId)).toEqual(["crashed"]);
    expect(shownServers(list).map((b) => b.taskId)).toEqual(["crashed"]);
    // But the poll must not keep re-reading a dead log for the rest of the session.
    expect(liveServers(list)).toEqual([]);
  });

  it("does not keep an ending somebody asked for", () => {
    // `exit: 0` is a one-shot that finished, `exit: null` a kill; neither is news.
    const list = [mk("clean", { ended: 5, exit: 0 }), mk("killed", { ended: 5, exit: null })];
    expect(failedServers(list)).toEqual([]);
    expect(shownServers(list)).toEqual([]);
  });

  it("names what happened", () => {
    expect(bgOutcome(mk("a", { ended: 5, exit: 1 }))).toBe("exited 1");
    expect(bgOutcome(mk("a", { ended: 5, exit: 0 }))).toBe("finished");
    expect(bgOutcome(mk("a", { ended: 5, exit: null }))).toBe("stopped");
    expect(bgOutcome(mk("a"))).toBe(""); // still running says nothing
  });

  it("names an ending the process never announced, without claiming somebody asked for it", () => {
    // Three of the four endings carry `exit: null`; only the unnamed one means "somebody asked".
    const gone = mk("a");
    expect(endBg(gone, 5, "session", null)).toBe(true);
    expect(bgOutcome(gone)).toBe("session ended");
    expect(failedServers([gone])).toEqual([]);
    expect(shownServers([gone])).toEqual([]);

    // An ending never moves once landed: the log's `[killed]` arrives a poll after the TaskStop.
    expect(endBg(gone, 99, "sentinel", 1)).toBe(false);
    expect(gone.ended).toBe(5);
    expect(gone.exit).toBeNull();
    expect(gone.endReason).toBe("session");
  });

  it("is dismissable, and a LIVE one is not", () => {
    const list = [mk("live"), mk("crashed", { ended: 5, exit: 1 })];
    expect(forgetServer(list, "live")).toBe(false);
    expect(list).toHaveLength(2);
    expect(forgetServer(list, "crashed")).toBe(true);
    expect(list.map((b) => b.taskId)).toEqual(["live"]);
    expect(forgetServer(list, "crashed")).toBe(false); // and again is a no-op
  });
});

describe("what the header counts", () => {
  it("counts the running ones and drops the finished", () => {
    const list = [mk("a"), mk("b", { ended: 5, exit: 0 }), mk("c", { url: "http://localhost:3000" })];
    expect(liveServers(list).map((b) => b.taskId)).toEqual(["a", "c"]);
  });

  it("badges only the ones that have announced a URL", () => {
    // A backgrounded `sleep 45` is live and listed, but not something you can go and look at.
    const list = [mk("a"), mk("c", { url: "http://localhost:3000" }), mk("d", { url: "http://localhost:4000", ended: 9 })];
    expect(servingUrls(list).map((b) => b.taskId)).toEqual(["c"]);
  });

  it("splits the list on evidence: a URL is a server, everything else is a job", () => {
    // Never on the command string: `pnpm dev` and `npm ci` are the same text to a rule.
    expect(bgKind(mk("a", { url: "http://localhost:5173" }))).toBe("server");
    expect(bgKind(mk("a", { cmd: "pnpm dev" }))).toBe("job"); // …until it says otherwise

    // An adopted port counts; the kernel said what the record did not.
    const adopted = mk("a");
    reconcilePorts([adopted], undefined, [5173]);
    expect(bgKind(adopted)).toBe("server");

    // `timedOutAfterMs` decides who may adopt a port, never the heading; the two must not collapse.
    expect(bgKind(mk("a", { timedOut: 120000, url: "http://localhost:5173" }))).toBe("server");
    expect(isJob(mk("a", { timedOut: 120000, url: "http://localhost:5173" }))).toBe(true);
  });
});

describe("cmdLabel", () => {
  it("drops the cd an agent nearly always prefixes", () => {
    expect(cmdLabel("cd E:/Programming/projects/wirksam/frontend && pnpm dev")).toBe("pnpm dev");
    expect(cmdLabel('cd "E:/a b/c" && npm run dev')).toBe("npm run dev");
  });

  it("drops the redirect the agent added, not the command", () => {
    expect(cmdLabel('cd "E:/p" && npx vite --port 3000 > "E:/tmp/vite.log" 2>&1')).toBe("npx vite --port 3000");
    expect(cmdLabel("pnpm preview --port 4173 2>&1")).toBe("pnpm preview --port 4173");
  });

  it("truncates rather than wrapping a row", () => {
    expect(cmdLabel("pnpm --filter @acme/web dev --host --port 5173 --strictPort", 20)).toHaveLength(20);
  });
});
