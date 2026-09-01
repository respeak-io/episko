import { describe, expect, it } from "vitest";
import {
  applyBg, applyBgLog, applyBgMiss, BG_RETIRE_MS, bgBlind, bgKind, bgLogPath, bgOutcome,
  bgPeekEmpty, bgRetire, bgSentinel, bgStopId, bgTaskId, bgTimedOut, cmdLabel, endBg,
  failedServers, forgetServer, isJob, liveServers, logLines, logTail, serverUrl,
  portOf, reconcilePorts, servingUrls, shownServers, taskServerUrl, usefulPort,
  type BgRead,
} from "../src/servers";
import type { BgMissReason, BgServer } from "../src/types";

// The payload shapes below are not invented. They were captured off the real CLI by
// running a session with a stdin-dumping PostToolUse hook and backgrounding a shell,
// and the log excerpts are real vite / uvicorn / pnpm output taken off disk. That
// matters more here than in most suites: every field this module reads belongs to a
// format nobody in this repo controls, so a fixture written from memory would only
// prove that the code agrees with the guess it was written from.
//
// `timedOutAfterMs` was added to that rule the same way, and it is worth saying where
// from: **143** real background payloads were read out of `~/.claude/projects` on this
// machine. 131 were shells the model asked for (`run_in_background: true`); the other
// **12** carry `timedOutAfterMs: 120000` and no `run_in_background` at all — Claude Code
// backgrounding a foreground command that outlived its own timeout. The servers among
// the 131 are `pnpm dev`, `pnpm tauri dev` and `just saas-start`; the rest are `npm ci`,
// `pytest`, `vue-tsc`, `gh run watch` polls and `until …; do sleep …; done` waits, which
// is why no rule below reads the command string.

/** A PostToolUse payload for a shell the agent backgrounded, as the hook delivers it. */
const started = (id: string, cmd = "pnpm dev") => ({
  tool: "Bash",
  input: { command: cmd, description: "Start the dev server", run_in_background: true },
  response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
});

/** The same payload for a command Claude backgrounded itself, at the 120s timeout. Note
 *  what is NOT in the input: the model never asked for this. */
const autoBg = (id: string, cmd: string) => ({
  tool: "Bash",
  input: { command: cmd, description: "Run the check" },
  response: {
    stdout: "", stderr: "", interrupted: false, isImage: false,
    timedOutAfterMs: 120000, backgroundTaskId: id,
  },
});

/** A record as `applyBg` builds one. */
const mk = (id: string, over: Partial<BgServer> = {}): BgServer =>
  ({ taskId: id, cmd: "pnpm dev", transcript: "t", startedAt: 0, ...over });

/** A `read_bg_log` answer that RESOLVED, as the command shapes it. `missing` is
 *  intersected in at the invoke site and never reaches these rules. */
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
    // The input says the agent asked for a background shell; the response says whether
    // it got one. Only the second is a fact, and only the second carries the handle
    // TaskStop needs — so an input-only payload must produce no record at all.
    expect(bgTaskId("Bash", { stdout: "", stderr: "" })).toBe("");
  });

  it("ignores the tools that OPERATE on a shell rather than create one", () => {
    // TaskOutput's response can echo the same id. Reading that as a start is how a
    // record the sentinel had already retired would come back from the dead.
    expect(bgTaskId("TaskOutput", { backgroundTaskId: "bczk8s47b" })).toBe("");
    expect(bgTaskId("TaskStop", { backgroundTaskId: "bczk8s47b" })).toBe("");
  });

  it("reads TaskStop's id from its input", () => {
    expect(bgStopId("TaskStop", { task_id: "bc1sxie6v" })).toBe("bc1sxie6v");
    expect(bgStopId("Bash", { task_id: "bc1sxie6v" })).toBe("");
    expect(bgStopId("TaskStop", {})).toBe("");
  });

  it("reads the timeout Claude Code stamps on a command it auto-backgrounded", () => {
    // Twelve of the 143 captured payloads are this: a command that crossed 120s in the
    // foreground and was backgrounded out from under the model. One of them was a
    // one-shot `python3 -c …` that had already done its work, and it reached the header
    // pill as a "running server" — the false positive that started this.
    const p = autoBg("bc4t2mzq1", "python3 -c 'import time; time.sleep(600)'");
    expect(p.input).not.toHaveProperty("run_in_background");
    expect(bgTimedOut(p.response)).toBe(120000);

    const list: BgServer[] = [];
    applyBg(list, p.tool, p.input, p.response, "t.jsonl", 1_000);
    expect(list[0].timedOut).toBe(120000);
    expect(isJob(list[0])).toBe(true);
  });

  it("leaves the timeout unset on a background the agent actually asked for", () => {
    // The ABSENCE case, and the pair above is worth nothing without it. A rule that
    // answers "timed out" for everything — a bad default, a `Number()` of a missing
    // field, reading `run_in_background` instead — passes the test above unchanged.
    // Every record then becomes a job: no silent one may ever adopt a loose port again
    // and the popover files every dev server under the wrong heading, with tsc, vitest
    // and the rest of this suite all green.
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
    // A stop is a kill, not an exit: there is no code, and `null` is what the log's own
    // `[killed]` sentinel means too. It carries no `endReason` either, deliberately —
    // unqualified `exit: null` has always meant "somebody asked for this".
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
    // A health check the process logged is not the address of the process.
    const log = "Uvicorn running on http://127.0.0.1:8787\nGET http://localhost:9999/ping 200\n";
    expect(serverUrl(log)).toBe("http://127.0.0.1:8787");
  });

  it("takes the LAST announcement, so a self-restart wins over the stale line", () => {
    // vite reprints its banner when the config changes, sometimes on a new port. The
    // line above it points at a port nothing is on any more.
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
    // Still running is `undefined` — distinct from a kill, because one of them must
    // never end a record and the other must.
    expect(bgSentinel(VITE)).toBeUndefined();
  });

  it("reads [exited with code unknown] as an ending, without calling it a failure", () => {
    // Claude Code's reaper writes this whenever it has no status for the shell it just
    // reaped. The old `number | null | undefined` had nowhere to put it: `null` already
    // means "killed, somebody asked for this", so folding an unknown exit into it would
    // report back a request nobody ever made.
    expect(bgSentinel("gone\n[exited with code unknown]\n")).toEqual({ kind: "unknown" });

    const b = mk("b1");
    expect(applyBgLog(b, read("gone\n[exited with code unknown]\n"), 20)).toBe(true);
    expect(b.ended).toBe(20);
    expect(b.exit).toBeNull();
    expect(b.endReason).toBe("unknown");
    expect(bgOutcome(b)).toBe("ended");
    // `exit: null` is what keeps the header pill from going red for a shell that never
    // failed — nobody can act on "it ended and we do not know how".
    expect(failedServers([b])).toEqual([]);
  });

  it("is not fooled by the two bracket lines that are NOT endings", () => {
    // Both are written into a log that is still being appended to. Ending on either
    // would take a live dev server off the count while it is still serving, and the
    // 5GB one lands on exactly the long-running processes this feature is about.
    expect(bgSentinel("...\n[output truncated: exceeded 5GB disk cap]\n")).toBeUndefined();
    expect(bgSentinel("[output omitted: it could not be written to disk]\n")).toBeUndefined();
  });

  it("collapses a redrawn line to what a terminal would have shown", () => {
    // Every progress bar in the ecosystem redraws with \r. Splitting on \n alone turns
    // one install spinner into hundreds of lines and pushes the real output out of the
    // peek entirely.
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
    // Leading indentation is kept: a peek that reflows its own output reads as a
    // different program's. Only the trailing edge (and \r redraws) are tidied.
    expect(b.tail).toEqual(["  ➜  Local:   http://localhost:5555/"]);
    // …and the rank the root resolved under, which is what says "moved" out loud one
    // release before the fallback stops matching too.
    expect(b.rootRank).toBe(0);
  });

  it("reports NO change on an identical re-read", () => {
    // The poll re-reads every live server every few seconds, and a dev server nobody is
    // hitting writes nothing for hours. If this returned true the app would repaint
    // itself forever over a file that never moved.
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
    // TaskStop ends the record at the click; the process writes its `[killed]` line a
    // moment later, and until it does the file still reads as running. A poll landing in
    // that window must not resurrect the row — it would flicker back into the count.
    const b = mk("b1", { ended: 50, exit: null, log: "/tmp/x.output", tail: ["still going"] });
    expect(applyBgLog(b, read("still going\n"), 60)).toBe(false);
    expect(b.ended).toBe(50);
    expect(b.exit).toBeNull();
  });
});

describe("a read that found nothing", () => {
  it("folds a missing read's reason and tried list without touching the peek", () => {
    // The row has to be able to say WHERE it looked. Before this a total miss came back
    // with an empty path and was dropped on the floor, so every one of them read "no
    // output yet" for the life of the session with nothing to reveal and nothing to copy.
    const b = mk("a", { url: "http://localhost:5173", tail: ["serving"] });
    const tried = ["/tmp/claude-501/-p-proj/8191/tasks/a.output", "/tmp/claude/-p-proj/8191/tasks/a.output"];
    expect(applyBgMiss(b, miss("noRoot", { tried }), 10)).toBe(true);
    expect(b.reason).toBe("noRoot");
    expect(b.tried).toEqual(tried);
    expect(b.rootRank).toBe(-1);
    // What the row already knows is left alone. A probe that lost the log is not
    // evidence that the server stopped serving.
    expect(b.url).toBe("http://localhost:5173");
    expect(b.tail).toEqual(["serving"]);
    expect(b.ended).toBeUndefined();
    // The reveal falls back to the first place we looked: "I looked here and it is not
    // there" is a sentence somebody can act on, and a dead button is not.
    expect(bgLogPath(b)).toBe(tried[0]);
    // The poll asks again every four seconds, and the backend builds a fresh array each
    // time — an identical answer must move nothing, or a blind fleet repaints forever.
    expect(applyBgMiss(b, miss("noRoot", { tried: [...tried] }), 14)).toBe(false);
  });

  it("keeps the file a notYet is waiting for, and forgets the search once it lands", () => {
    // `notYet` is the one miss that has a path: the root was found and the log simply is
    // not in it yet, which is every background shell for its first second or two.
    const b = mk("a");
    const path = "/tmp/claude-501/-p-proj/8191/tasks/a.output";
    expect(applyBgMiss(b, miss("notYet", { path, tried: [path], rootRank: 0 }), 10)).toBe(true);
    expect(b.log).toBe(path);
    expect(b.reason).toBe("notYet");

    // …and the moment a read resolves, the stale search goes with it. A row still
    // offering to reveal the places the log turned out not to be is a row that lies.
    applyBgLog(b, read("  ➜  Local:   http://localhost:5555/\n"), 20);
    expect(b.reason).toBe("none");
    expect(b.tried).toEqual([]);
    expect(bgLogPath(b)).toBe("/tmp/x.output");
  });

  it("says which silence a row is in", () => {
    // Six silences that used to read as one, and "no output yet" is true for exactly one
    // of them. For the whole life of this feature it was also what a log the app was
    // hunting for in a directory Claude Code has never written to said, every four
    // seconds, for as long as the session lasted.
    expect(bgPeekEmpty(mk("a", { reason: "noRoot", tried: ["/a", "/b", "/c"] })))
      .toBe("no log found — looked in 3 places");
    expect(bgPeekEmpty(mk("a", { reason: "ambiguous" }))).toBe("two logs match — refusing to guess");
    expect(bgPeekEmpty(mk("a", { reason: "notYet" }))).toBe("no log file yet");
    expect(bgPeekEmpty(mk("a", { reason: "unreadable" }))).toBe("the log could not be read");
    expect(bgPeekEmpty(mk("a", { reason: "badId" }))).toBe("no log address for this shell");
    // The file is there and is genuinely empty, which is the one case the old wording
    // was right about — and a record nothing has read yet says the same thing.
    expect(bgPeekEmpty(mk("a", { reason: "none" }))).toBe("no output yet");
    expect(bgPeekEmpty(mk("a"))).toBe("no output yet");

    // Blind is the pair the header says out loud: a fleet nobody can hear must never
    // look like a quiet one. Waiting is not blind.
    expect(bgBlind(mk("a", { reason: "noRoot" }))).toBe(true);
    expect(bgBlind(mk("a", { reason: "ambiguous" }))).toBe(true);
    expect(bgBlind(mk("a", { reason: "notYet" }))).toBe(false);
    expect(bgBlind(mk("a"))).toBe(false);
  });
});

describe("a shell whose log never appears", () => {
  it("retires a record whose root was found and whose log never appeared", () => {
    // No URL, no peek, and — measured over eleven real logs, of which exactly one had a
    // sentinel — nothing coming to end it either. Before this the row sat at "starting…"
    // for the life of the session.
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

    // A record that has an address is never retired, whatever its log is doing:
    // something answered, and that is better evidence than a file we cannot find.
    const serving = mk("b", { reason: "notYet", url: "http://localhost:5173" });
    expect(bgRetire(serving, BG_RETIRE_MS + 1)).toBe(false);
  });

  it("never retires a record the probe could not find a root for — that is an outage, not an ending", () => {
    // The ordering trap this rule exists for. Arm retirement on every miss and the
    // feature goes from "rows that never leave" to "rows that always leave" the moment
    // the probe breaks — the same silence one layer along, and much harder to notice.
    for (const reason of ["noRoot", "ambiguous"] as const) {
      const b = mk("a", { reason });
      expect(bgRetire(b, BG_RETIRE_MS * 100)).toBe(false);
      expect(b.ended).toBeUndefined();
    }
  });

  it("counts the ten minutes from when the log went missing, not from when the shell started", () => {
    // The `sleep 900` case, and the one an age test gets exactly backwards. This record
    // has been read all afternoon; then a /tmp reaper — or an agent tidying up after
    // itself — takes the file. It is already an hour old at that moment, so retiring on
    // AGE ends it on the very next poll and labels it "log never appeared" about a log
    // that appeared and was read for an hour.
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

    // ...and a log that comes back resets the clock, so the next absence gets its own
    // ten minutes rather than inheriting the last one's.
    const c = mk("c", { startedAt: 0 });
    applyBgMiss(c, miss("notYet", { path: "/tmp/x.output", tried: ["/tmp/x.output"] }), 1_000);
    applyBgLog(c, read("back\n"), 2_000);
    expect(c.missSince).toBeUndefined();
    applyBgMiss(c, miss("notYet", { path: "/tmp/x.output", tried: ["/tmp/x.output"] }), 3_000);
    expect(bgRetire(c, 3_000 + BG_RETIRE_MS)).toBe(false);
    expect(bgRetire(c, 3_000 + BG_RETIRE_MS + 1)).toBe(true);
  });

  it("says nothing about a record whose log has not appeared in four seconds", () => {
    // The log lands seconds AFTER the record does. A rule that fires on ordinary
    // behaviour is worse than no rule.
    const b = mk("a", { reason: "notYet" });
    expect(bgRetire(b, 4_000)).toBe(false);
    expect(b.ended).toBeUndefined();
    expect(liveServers([b])).toHaveLength(1);
  });
});

describe("a server Episko itself ran (just / VS Code task / npm script)", () => {
  // Real output from `just dev`, `npm run dev` and uvicorn, one line at a time — which
  // is how it actually arrives, on the PTY stream.
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
    // This is the whole reason it latches. `run.tail` is a rolling 40 lines, so within
    // seconds of the first HMR update the banner is gone from it — a URL rescanned from
    // the tail would appear and then silently vanish, which is worse than never showing.
    const hmr = Array.from({ length: 60 }, (_, i) => `18:0${i % 6}:0${i % 9} [vite] hmr update /src/App.vue`);
    expect(feed(hmr, "http://localhost:5555")).toBe("http://localhost:5555");
  });

  it("follows a restart onto a new port", () => {
    // vite reprints its banner when the config changes, sometimes elsewhere. The old
    // line names a port nothing is on any more.
    expect(feed(["  ➜  Local:   http://localhost:5556/"], "http://localhost:5555"))
      .toBe("http://localhost:5556");
  });

  it("refuses to latch onto a URL that is not an announcement", () => {
    // Stricter than `serverUrl`, and deliberately: that one sees a whole log and can
    // prefer an announcement *over* a stray URL, so its any-URL fallback is a safety
    // net. This one sees one line with no context and its answer sticks, so a health
    // check the task logged would put a wrong address on the row permanently.
    expect(feed(['  "GET /api/health" -> http://localhost:9999/ 200'])).toBeUndefined();
    expect(feed(["curl http://localhost:9999/ping"])).toBeUndefined();
    // …and a real announcement afterwards still wins.
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
    // The record's own URL is better than a bare port: it carries the scheme, and any
    // base path the server announced.
    const list = [mk("a", { url: "http://localhost:5555" })];
    const got = reconcilePorts(list, undefined, [5555]);
    expect(got.loose).toEqual([]);
    expect(got.changed).toBe(false);
  });

  it("matches a task's URL too, not just an agent's", () => {
    expect(reconcilePorts([], "http://localhost:1420", [1420]).loose).toEqual([]);
  });

  it("adopts one loose port onto the one record that never said anything", () => {
    // The payoff: a background shell we watched start, and exactly one unexplained
    // socket under the same pane. That is its server, and now the row has an address
    // instead of "starting…" forever.
    const silent = mk("a");
    const got = reconcilePorts([silent], undefined, [5555]);
    expect(got.changed).toBe(true);
    expect(silent.url).toBe("http://localhost:5555");
    expect(got.loose).toEqual([]);
  });

  it("refuses to guess when either side is ambiguous", () => {
    // Two silent records and one port, or one record and two ports: there is no way to
    // tell which belongs to which, and a row pointing at the wrong port is worse than
    // one still saying "starting…". Fail closed, like checkoutDrift in ./gitwatch.
    const two = [mk("a"), mk("b")];
    expect(reconcilePorts(two, undefined, [5555]).changed).toBe(false);
    expect(two.every((b) => !b.url)).toBe(true);

    const one = [mk("a")];
    expect(reconcilePorts(one, undefined, [5555, 8787]).changed).toBe(false);
    expect(one[0].url).toBeUndefined();
    // …and both ports are then reported as unexplained, so neither is lost.
    expect(reconcilePorts(one, undefined, [5555, 8787]).loose).toEqual([5555, 8787]);
  });

  it("never lets an auto-backgrounded command adopt a loose port", () => {
    // The false positive that started this: a `python3 -c …` Claude backgrounded when it
    // crossed 120s, sitting silent under a pane that also had a dev server on 5173. The
    // one-and-one rule would hand it that port and put a live address on a row whose
    // process serves nothing at all.
    const job = mk("a", { cmd: "python3 -c 'import time; time.sleep(600)'", timedOut: 120000 });
    const got = reconcilePorts([job], undefined, [5173]);
    expect(got.changed).toBe(false);
    expect(job.url).toBeUndefined();
    // The port is still reported unexplained, so whatever is really on it gets a row.
    expect(got.loose).toEqual([5173]);
  });

  it("adopts once the only other silent record turns out to be a job", () => {
    // The WIN direction, and it needs a test of its own: two silent records against one
    // port is a fail-closed no-op, so cutting the job out is what leaves a 1-and-1 pair
    // that can adopt. "Refuses to guess when either side is ambiguous" above passes with
    // or without the exclusion and therefore guards neither half of this.
    const server = mk("a"), job = mk("b", { cmd: "pytest -q", timedOut: 120000 });
    const got = reconcilePorts([server, job], undefined, [5173]);
    expect(got.changed).toBe(true);
    expect(server.url).toBe("http://localhost:5173");
    expect(job.url).toBeUndefined();
    expect(got.loose).toEqual([]);
  });

  it("ignores a record that has already ended", () => {
    // A crashed shell must not adopt the port of whatever replaced it — which is the
    // exact shape of "restart the dev server after it failed to bind".
    const dead = mk("a", { ended: 5, exit: 1 });
    const got = reconcilePorts([dead], undefined, [5555]);
    expect(dead.url).toBeUndefined();
    expect(got.loose).toEqual([5555]);
  });

  it("drops the sockets that are not servers", () => {
    // Measured on a real machine: one `wrangler dev` held five listening sockets — the
    // server on 8788, Node's inspector on 9229, and three kernel-assigned control
    // channels in the 63xxx range. Listing all five puts four pieces of noise in front
    // of the one useful row.
    expect(usefulPort(8788)).toBe(true);
    expect(usefulPort(3000)).toBe(true);
    expect(usefulPort(9229)).toBe(false); // node --inspect
    expect(usefulPort(9230)).toBe(false); // …and its worker
    expect(usefulPort(63720)).toBe(false); // kernel-assigned
    expect(usefulPort(0)).toBe(false);
    expect(reconcilePorts([], undefined, [8788, 9229, 63720, 63721, 63199]).loose).toEqual([8788]);
  });

  it("never adopts a control socket onto a silent record", () => {
    // The dangerous half: a record with no URL and one loose ephemeral port would
    // otherwise be handed an address that serves nothing at all.
    const silent = mk("a");
    expect(reconcilePorts([silent], undefined, [63720]).changed).toBe(false);
    expect(silent.url).toBeUndefined();
  });

  it("reports a port nothing here can explain", () => {
    // The whole reason this exists: somebody typed `pnpm dev` in a shell pane, or a
    // server printed a banner in a format nothing parses. No hook, no log, no record —
    // and the kernel still knows.
    expect(reconcilePorts([], undefined, [8100]).loose).toEqual([8100]);
  });

  it("counts one server once however many addresses it bound", () => {
    // The backend dedupes by (session, port), but a caller handing the same port twice
    // must not produce two rows either.
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
    // The backend never opened the file, so `text: ""` means "I didn't look", not "the
    // log is empty". Treating it as content would blank the URL and the peek on every
    // poll — the row would flicker between knowing its port and not.
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
    // The commonest real failure: a dev server exits on EADDRINUSE two seconds after
    // starting. If it dropped off the list the count would go 1 → 0 and say nothing.
    const list = [mk("crashed", { ended: 5, exit: 1 })];
    expect(failedServers(list).map((b) => b.taskId)).toEqual(["crashed"]);
    expect(shownServers(list).map((b) => b.taskId)).toEqual(["crashed"]);
    // But the poll must not keep re-reading a dead log for the rest of the session.
    expect(liveServers(list)).toEqual([]);
  });

  it("does not keep an ending somebody asked for", () => {
    // `exit: 0` is a background one-shot that simply finished; `exit: null` is a kill —
    // the agent's TaskStop, or the session ending. Reporting either back is noise.
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
    // Three of the four endings carry `exit: null`, and each would otherwise read as
    // "stopped" — which claims a request. Only the unnamed one means that.
    const gone = mk("a");
    expect(endBg(gone, 5, "session", null)).toBe(true);
    expect(bgOutcome(gone)).toBe("session ended");
    expect(failedServers([gone])).toEqual([]);
    expect(shownServers([gone])).toEqual([]);

    // An ending never moves once it has landed. The log's `[killed]` arrives a poll
    // after the TaskStop that caused it, and re-ending would restamp the time and
    // relabel the ending on every read from then on.
    expect(endBg(gone, 99, "sentinel", 1)).toBe(false);
    expect(gone.ended).toBe(5);
    expect(gone.exit).toBeNull();
    expect(gone.endReason).toBe("session");
  });

  it("is dismissable, and a LIVE one is not", () => {
    // The guard is the point: forgetting a running server would put the app straight
    // back to saying nothing about a port that is still held.
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
    // A `sleep 45` an agent backgrounded is live and listed, but it is not something you
    // can go and look at — counting it green would make the pill mean "the agent is
    // busy", which the phase glyphs already say better.
    const list = [mk("a"), mk("c", { url: "http://localhost:3000" }), mk("d", { url: "http://localhost:4000", ended: 9 })];
    expect(servingUrls(list).map((b) => b.taskId)).toEqual(["c"]);
  });

  it("splits the list on evidence: a URL is a server, everything else is a job", () => {
    // Never on the command string. `pnpm dev` and `npm ci` are the same text to a rule,
    // and of the 143 captured payloads most are the second kind — a heading that guessed
    // from the command would be wrong about them out loud.
    expect(bgKind(mk("a", { url: "http://localhost:5173" }))).toBe("server");
    expect(bgKind(mk("a", { cmd: "pnpm dev" }))).toBe("job"); // …until it says otherwise

    // An adopted port counts, which is the point of adopting one: the record said
    // nothing, the kernel did, and the row is a server either way.
    const adopted = mk("a");
    reconcilePorts([adopted], undefined, [5173]);
    expect(bgKind(adopted)).toBe("server");

    // And a command Claude backgrounded on its own timeout is still a server the moment
    // it announces one. `timedOutAfterMs` decides who may adopt a port, never the
    // heading — the two questions are different and must not collapse into each other.
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
