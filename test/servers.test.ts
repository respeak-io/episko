import { describe, expect, it } from "vitest";
import {
  applyBg, applyBgLog, bgOutcome, bgSentinel, bgStopId, bgTaskId, cmdLabel,
  failedServers, forgetServer, liveServers, logLines, logTail, serverUrl,
  portOf, reconcilePorts, servingUrls, shownServers, taskServerUrl, usefulPort,
} from "../src/servers";
import type { BgServer } from "../src/types";

// The payload shapes below are not invented. They were captured off the real CLI by
// running a session with a stdin-dumping PostToolUse hook and backgrounding a shell,
// and the log excerpts are real vite / uvicorn / pnpm output taken off disk. That
// matters more here than in most suites: every field this module reads belongs to a
// format nobody in this repo controls, so a fixture written from memory would only
// prove that the code agrees with the guess it was written from.

/** A PostToolUse payload for a shell the agent backgrounded, as the hook delivers it. */
const started = (id: string, cmd = "pnpm dev") => ({
  tool: "Bash",
  input: { command: cmd, description: "Start the dev server", run_in_background: true },
  response: { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
});

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
    // `[killed]` sentinel means too.
    expect(list[0].exit).toBeNull();
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
    expect(bgSentinel("done\n[exited with code 0]\n")).toBe(0);
    expect(bgSentinel("boom\n[exited with code 1]\n")).toBe(1);
    expect(bgSentinel("\n[killed]")).toBeNull();
    // Still running is `undefined` — distinct from a kill's null, because one of them
    // must never end a record and the other must.
    expect(bgSentinel(VITE)).toBeUndefined();
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
  const rec = (): BgServer => ({ taskId: "b1", cmd: "pnpm dev", transcript: "t.jsonl", startedAt: 0 });
  /** A `read_bg_log` answer, as the command shapes it. */
  const read = (text: string, unchanged = false) =>
    ({ path: "/tmp/x.output", text, len: text.length, unchanged });

  it("folds in the path, the URL and the peek, and says something changed", () => {
    const b = rec();
    expect(applyBgLog(b, read("  ➜  Local:   http://localhost:5555/\n"), 10)).toBe(true);
    expect(b.log).toBe("/tmp/x.output");
    expect(b.url).toBe("http://localhost:5555");
    // Leading indentation is kept: a peek that reflows its own output reads as a
    // different program's. Only the trailing edge (and \r redraws) are tidied.
    expect(b.tail).toEqual(["  ➜  Local:   http://localhost:5555/"]);
  });

  it("reports NO change on an identical re-read", () => {
    // The poll re-reads every live server every few seconds, and a dev server nobody is
    // hitting writes nothing for hours. If this returned true the app would repaint
    // itself forever over a file that never moved.
    const b = rec();
    const text = "  ➜  Local:   http://localhost:5555/\n";
    applyBgLog(b, read(text), 10);
    expect(applyBgLog(b, read(text), 20)).toBe(false);
  });

  it("ends a record when the sentinel appears, and keeps the exit code", () => {
    const b = rec();
    applyBgLog(b, read("starting\n"), 10);
    expect(b.ended).toBeUndefined();
    expect(applyBgLog(b, read("starting\nboom\n[exited with code 1]\n"), 20)).toBe(true);
    expect(b.ended).toBe(20);
    expect(b.exit).toBe(1);
  });

  it("never un-ends a record the agent's TaskStop already ended", () => {
    // TaskStop ends the record at the click; the process writes its `[killed]` line a
    // moment later, and until it does the file still reads as running. A poll landing in
    // that window must not resurrect the row — it would flicker back into the count.
    const b = rec();
    b.ended = 50; b.exit = null; b.log = "/tmp/x.output"; b.tail = ["still going"];
    expect(applyBgLog(b, read("still going\n"), 60)).toBe(false);
    expect(b.ended).toBe(50);
    expect(b.exit).toBeNull();
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
  const mk = (id: string, over: Partial<BgServer> = {}): BgServer =>
    ({ taskId: id, cmd: "pnpm dev", transcript: "t", startedAt: 0, ...over });

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
  const rec = (): BgServer => ({ taskId: "b1", cmd: "pnpm dev", transcript: "t.jsonl", startedAt: 0 });

  it("keeps the length the backend reports, so the next read can be skipped", () => {
    const b = rec();
    applyBgLog(b, { path: "/tmp/x.output", text: "hello\n", len: 6, unchanged: false }, 10);
    expect(b.len).toBe(6);
  });

  it("folds NOTHING from an unchanged read, whose text is empty by construction", () => {
    // The backend never opened the file, so `text: ""` means "I didn't look", not "the
    // log is empty". Treating it as content would blank the URL and the peek on every
    // poll — the row would flicker between knowing its port and not.
    const b = rec();
    applyBgLog(b, { path: "/tmp/x.output", text: "  Local: http://localhost:5555/\n", len: 33, unchanged: false }, 10);
    expect(b.url).toBe("http://localhost:5555");

    expect(applyBgLog(b, { path: "/tmp/x.output", text: "", len: 33, unchanged: true }, 20)).toBe(false);
    expect(b.url).toBe("http://localhost:5555");
    expect(b.tail).toEqual(["  Local: http://localhost:5555/"]);
    expect(b.ended).toBeUndefined(); // and an unchanged read must not read as a death
  });
});

describe("a server that died on its own", () => {
  const mk = (id: string, over: Partial<BgServer> = {}): BgServer =>
    ({ taskId: id, cmd: "pnpm dev", transcript: "t", startedAt: 0, ...over });

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
  const mk = (id: string, over: Partial<BgServer> = {}): BgServer =>
    ({ taskId: id, cmd: "pnpm dev", transcript: "t", startedAt: 0, ...over });

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
