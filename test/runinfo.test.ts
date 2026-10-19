import { describe, it, expect } from "vitest";
import type { Runnable } from "../src/types";
import {
  applyRunInfo, checkRun, cmdHash, describePrompt, describedTally, runSummaryText, taskCmd, type RunInfo,
} from "../src/runinfo";

const run = (o: Partial<Runnable> = {}): Runnable => ({
  id: "just:app", label: "app", detail: null, source: "just", sourceFile: "justfile",
  group: null, exec: { mode: "shell", line: "uv run python apps/standalone/schwaerzwerk_app.py" },
  cwd: "/w/pii", env: {}, background: false, inputs: [],
  dependsOn: [], dependsOrder: "parallel", blocked: null, compound: false, defaultFor: null, ...o,
});
const info = (r: Runnable, o: Partial<RunInfo> = {}): RunInfo => ({ kind: "app", hash: cmdHash(taskCmd(r)), ...o });

describe("cmdHash", () => {
  it("is stable, short, and moves with the command", () => {
    expect(cmdHash("just dev")).toMatch(/^[0-9a-f]{8}$/);
    expect(cmdHash("just dev")).toBe(cmdHash("just dev"));
    expect(cmdHash("just dev")).not.toBe(cmdHash("just dev --no-hmr"));
  });
  it("pins a compound task to what it runs", () => {
    expect(taskCmd(run({ compound: true, dependsOn: ["Frontend", "Backend"] }))).toBe("Frontend + Backend");
  });
});

describe("applyRunInfo", () => {
  it("makes a described app long-running, which no name rule would", () => {
    const r = run();
    const [got] = applyRunInfo([r], { "just:app": info(r, { pages: { App: "http://127.0.0.1:8000" } }) });
    expect(got).toMatchObject({ described: "fresh", kind: "app", background: true, describedPages: { App: "http://127.0.0.1:8000" } });
  });

  it("never turns a declared background task off", () => {
    const r = run({ background: true });
    expect(applyRunInfo([r], { "just:app": info(r, { kind: "script" }) })[0].background).toBe(true);
  });

  it("marks a description of an edited command stale and lets it change nothing", () => {
    const r = run();
    const [got] = applyRunInfo([r], { "just:app": { kind: "server", hash: "00000000" } });
    expect(got.described).toBe("stale");
    expect(got.kind).toBeUndefined();
    expect(got.background).toBe(false);
  });

  it("ignores a kind it does not know, and counts what is described", () => {
    const a = run(), b = run({ id: "just:lint" }), c = run({ id: "just:test" });
    const got = applyRunInfo([a, b, c], { "just:app": info(a), "just:lint": { kind: "check", hash: "x" }, "just:test": info(c, { kind: "nonsense" }) });
    expect(got[2].described).toBeUndefined();
    expect(describedTally(got)).toEqual({ fresh: 1, stale: 1, missing: 1 });
  });
});

describe("the describer", () => {
  it("is handed every task with its command, and the kinds it may use", () => {
    const p = describePrompt({}, [{ id: "just:app", cmd: "uv run python app.py", background: false }]);
    expect(p).toContain("- just:app · uv run python app.py");
    expect(p).toContain("kind, exactly one of: check, test, build, server, app, watch, infra-up, infra-down, deploy, script");
    expect(p).toMatch(/never rewrite it to localhost/);
  });

  it("keeps entries for real tasks, pinned to their command, and drops the rest out loud", () => {
    const a = run(), d = run({ id: "just:down", exec: { mode: "shell", line: "docker compose stop" } });
    const got = checkRun({
      "just:app": { kind: "app", pages: { App: "http://127.0.0.1:8000", Bad: "127.0.0.1" }, stops: "just:nope" },
      "just:down": { kind: "infra-down" },
      "just:ghost": { kind: "script" },
      "just:x": { kind: "rocket" },
    }, [a, d, run({ id: "just:x" })]);
    expect(got.run["just:app"]).toEqual({ kind: "app", pages: { App: "http://127.0.0.1:8000" }, stops: undefined, hash: cmdHash(taskCmd(a)) });
    expect(got.dropped).toEqual(["just:ghost is not a task in this project", 'just:x: "rocket" is not a kind']);
  });

  it("summarises by kind, lists what keeps running and every deploy", () => {
    const text = runSummaryText({
      "just:dev": { kind: "server", pages: { App: "https://app.localhost:8443/ui/" }, hash: "" },
      "just:lint": { kind: "check", hash: "" },
      "just:addon-publish": { kind: "deploy", note: "uploads the add-on to the production portal", hash: "" },
    }, { "just:lint": { kind: "script", hash: "" } });
    expect(text).toContain("Describes 3 tasks: 1 check, 1 server, 1 deploy.");
    expect(text).toContain("- `just:dev` (server): https://app.localhost:8443/ui/");
    expect(text).toContain("- `just:addon-publish`: uploads the add-on to the production portal");
    expect(text).toContain("`just:lint` script → check");
    expect(runSummaryText({}, {})).toBe("");
  });
});
