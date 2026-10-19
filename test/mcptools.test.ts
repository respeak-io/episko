import { describe, it, expect } from "vitest";
import type { InputSpec, Runnable } from "../src/types";
import "./localstorage"; // must precede the subject import: ./tasks reads its prefs at load
import {
  OUTPUT_CAP, WAIT_DEFAULT_S, WAIT_MAX_S, WAIT_UP_S, appendOutput, fillInputs, missingText, refuseRun,
  otherRunsText, reportText, runnablesText, runsOn, stacksText, upText, waitSeconds,
} from "../src/mcptools";

const run = (o: Partial<Runnable> = {}): Runnable => ({
  id: "npm:test", label: "test", detail: null, source: "npm", sourceFile: "package.json",
  group: null, exec: { mode: "argv", program: "pnpm", args: ["test"] },
  cwd: "/w/epi", env: {}, background: false, inputs: [],
  dependsOn: [], dependsOrder: "parallel", blocked: null,
  compound: false, defaultFor: null, ...o,
});
const input = (o: Partial<InputSpec> = {}): InputSpec =>
  ({ id: "name", kind: "promptString", description: "Name", default: null, options: [], password: false, optional: false, ...o });
const none = () => undefined;

describe("refuseRun", () => {
  it("lets a plain one-shot task through", () => expect(refuseRun(run())).toBe(""));
  it("refuses only what cannot run at all; a server or a compound dev task is started", () => {
    expect(refuseRun(run({ blocked: "needs an editor" }))).toContain("needs an editor");
    expect(refuseRun(run({ background: true }))).toBe("");
    expect(refuseRun(run({ compound: true, dependsOn: ["lint", "test"] }))).toBe("");
  });
  it("answers a server, an app or a compound once it is up, not once it exits", () => {
    expect(runsOn(run({ background: true }))).toBe(true);
    expect(runsOn(run({ compound: true }))).toBe(true);
    expect(runsOn(run())).toBe(false);
    expect(waitSeconds(undefined, true)).toBe(WAIT_UP_S);
  });
});

describe("fillInputs", () => {
  const r = run({ exec: { mode: "shell", line: "deploy ${input:env} ${input:tag}" }, inputs: [input({ id: "env" }), input({ id: "tag", default: "latest" })] });

  it("prefers the agent's value, then what the user typed last, then the default", () => {
    const a = fillInputs(r, { env: "prod" }, (id) => (id === "env" ? "staging" : undefined));
    expect("ready" in a && a.ready.exec).toEqual({ mode: "shell", line: "deploy prod latest" });
    const b = fillInputs(r, {}, (id) => (id === "env" ? "staging" : undefined));
    expect("ready" in b && b.ready.exec).toEqual({ mode: "shell", line: "deploy staging latest" });
  });

  it("names every input nobody answered, and never reuses a password", () => {
    const res = fillInputs(run({ inputs: [input({ id: "env" }), input({ id: "pw", password: true })] }), { env: 1 }, () => "remembered");
    expect("missing" in res && res.missing.map((i) => i.id)).toEqual(["pw"]);
    const res2 = fillInputs(run({ inputs: [input({ id: "env" })] }), "nonsense", none);
    expect("missing" in res2 && res2.missing.map((i) => i.id)).toEqual(["env"]);
  });

  it("answers an optional input with empty, and passes a task without inputs through untouched", () => {
    const res = fillInputs(run({ exec: { mode: "shell", line: "x ${input:o}" }, inputs: [input({ id: "o", optional: true })] }), undefined, none);
    expect("ready" in res && res.ready.exec).toEqual({ mode: "shell", line: "x " });
    const plain = run();
    expect(fillInputs(plain, {}, none)).toEqual({ ready: plain });
  });

  it("lists what is missing with its choices", () => {
    expect(missingText(run(), [input({ id: "env", description: "Where", options: ["dev", "prod"] })]))
      .toContain("- env: Where (one of: dev, prod)");
  });
});

describe("runnablesText", () => {
  it("lists id, command and what makes a task different", () => {
    const text = runnablesText([
      run({ group: "test" }),
      run({ id: "npm:dev", background: true }),
      run({ id: "vscode:all", compound: true, dependsOn: ["build", "test"] }),
      run({ id: "just:__untrusted", blocked: "untrusted folder" }),
    ]);
    expect(text).toContain("- npm:test · pnpm test [test]");
    expect(text).toContain("- npm:dev · pnpm test [long-running]");
    expect(runnablesText([run({ id: "just:release", kind: "deploy", note: "pushes main and tags a release" })]))
      .toContain("[deploy; pushes main and tags a release]");
    expect(runnablesText([run({ id: "just:app", kind: "app", background: true })])).toContain("[app]");
    expect(text).toContain("- vscode:all · build + test [runs other tasks]");
    expect(text).toContain("[blocked: untrusted folder]");
  });
  it("says so when there is nothing", () => expect(runnablesText([])).toMatch(/no runnable tasks/));
});

describe("appendOutput", () => {
  it("strips colour and OSC titles", () => {
    expect(appendOutput("", "\x1b[31mFAIL\x1b[0m a.test.ts\x1b]0;title\x07\n").text).toBe("FAIL a.test.ts\n");
  });

  it("keeps only a progress line's last state, even across chunks", () => {
    let o = appendOutput("", "start\n 10%\r");
    expect(o.text).toBe("start\n 10%\r"); // a trailing \r may still be overwritten
    o = appendOutput(o.text, " 50%\r100%\ndone\n");
    expect(o.text).toBe("start\n100%\ndone\n");
    expect(appendOutput("", "a\r\nb\r\n").text).toBe("a\nb\n");
  });

  it("drops the head at a line boundary past the cap", () => {
    const o = appendOutput("first line\n", "x".repeat(20) + "\nlast\n", 25);
    expect(o.cut).toBe(true);
    expect(o.text).toBe("last\n");
    expect(appendOutput("", "y".repeat(OUTPUT_CAP)).cut).toBe(false);
  });
});

describe("waitSeconds", () => {
  it("defaults, floors and clamps", () => {
    expect(waitSeconds(undefined)).toBe(WAIT_DEFAULT_S);
    expect(waitSeconds("30")).toBe(WAIT_DEFAULT_S);
    expect(waitSeconds(12.7)).toBe(12);
    expect(waitSeconds(-5)).toBe(0);
    expect(waitSeconds(99_999)).toBe(WAIT_MAX_S);
    expect(waitSeconds(90)).toBe(45); // the client cuts a call off at ~60s, answer or not
  });
});

describe("reportText", () => {
  const base = { id: "npm:test", cmd: "pnpm test", handle: "h1", elapsedMs: 4200, output: "ok\n", cut: false };
  it("reports an exit with its output", () => {
    expect(reportText({ ...base, exit: 1 })).toBe("npm:test exited 1 after 4s (`pnpm test`).\n\nOutput:\nok");
  });
  it("hands back the handle while still running", () => {
    expect(reportText({ ...base, exit: null })).toContain('task_status with handle "h1"');
    expect(reportText({ ...base, exit: null, ports: [38418] })).toContain("listening on 127.0.0.1:38418");
  });
  it("says when the output was cut or empty", () => {
    expect(reportText({ ...base, exit: 0, cut: true })).toContain("the end of it");
    expect(reportText({ ...base, exit: 0, output: " \n" })).toContain("(no output)");
  });
});

describe("a server's answer and stack_status", () => {
  const stack = (o = {}) => ({
    key: "g", project: "wirksam", checkout: "/w/wirksam", label: "dev", composeProjects: ["wirksam"],
    members: [{ sid: "p1", label: "dev", background: true, state: "serving" as const, url: "http://wirksam.localhost:47300", ports: [47300], exit: null }],
    boxes: [{ c: { id: "c", name: "wirksam-db-1", state: "running", status: "Up (healthy)", ports: "", project: "wirksam", service: "db", workingDir: "/w/wirksam" }, state: "up" as const, health: "healthy" as const, hostPorts: [8432], from: "" }],
    pages: [{ name: "Frontend", url: "http://wirksam.localhost:47300", from: "described" as const }],
    state: "ready" as const, why: "", startedAt: 0, ...o,
  });

  it("says up with where, still coming up with what it waits on, or what failed", () => {
    expect(upText("just:dev", "just dev", "p1", 9000, stack(), "")).toMatch(/^just:dev is up after 9s .*keeps running/s);
    expect(upText("just:dev", "just dev", "p1", 9000, stack(), "")).toContain("- Frontend: http://wirksam.localhost:47300");
    expect(upText("just:dev", "just dev", "p1", 9000, stack({ state: "starting", why: "db health check starting" }), ""))
      .toContain('not yet known to be up (`just dev`): db health check starting. It keeps running in its pane; call task_status with handle "p1"');
    expect(upText("just:app", "just app", "p1", 45000, undefined, "", [38418])).toContain("- listening: http://127.0.0.1:38418");
    expect(upText("just:dev", "just dev", "p1", 9000, stack({ state: "failed", why: "db is restarting" }), "")).toContain("failed to come up after 9s");
  });

  it("lists every stack of the repo, saying which checkout and who started a container", () => {
    const text = stacksText([stack(), stack({ checkout: "/w/wt/feat", boxes: [], members: [], label: "", state: "leftover", why: "1 container up" })], "/w/wirksam");
    expect(text).toContain("wirksam · dev (this checkout): ready");
    expect(text).toContain("  pane dev: serving at http://wirksam.localhost:47300");
    expect(text).toContain("  container db (wirksam-db-1): up, healthy, ports :8432");
    expect(text).toContain("wirksam (checkout /w/wt/feat): leftover, 1 container up");
    expect(stacksText([], "/w")).toMatch(/Nothing of this repository/);
    expect(otherRunsText([{ handle: "p9", id: "just:app", label: "app", checkout: "/w/wt/zoom", startedAt: 0, ports: [] }], "/w", 30_000))
      .toBe('Other running tasks:\n  just:app (app) in checkout /w/wt/zoom: running 30s, handle "p9", no listening port');
  });
});
