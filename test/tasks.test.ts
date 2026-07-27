import { describe, it, expect, beforeEach } from "vitest";
import type { InputSpec, Runnable } from "../src/types";
import { store } from "./localstorage"; // must precede the subject import
import {
  applyInputs, applyRunner, execCmd, exitWaiters, lastRunnableById, launchWithDeps,
  rememberedInput, rememberInput, resolveDeps, setTaskLauncher, setTaskLogger,
  setTaskToast, stopRuleBlocked, taskInputs, taskRunner,
  type TaskLaunchOpts,
} from "../src/tasks";

const run = (o: Partial<Runnable> = {}): Runnable => ({
  id: "npm:test", label: "test", detail: null, source: "npm", sourceFile: "package.json",
  group: null, exec: { mode: "argv", program: "npm", args: ["run", "test"] },
  cwd: "/w/epi", env: {}, background: false, inputs: [],
  dependsOn: [], dependsOrder: "parallel", blocked: null, ...o,
});
const inputSpec = (o: Partial<InputSpec> = {}): InputSpec =>
  ({ id: "name", kind: "promptString", description: "Name", default: null, options: [], password: false, ...o });

// What the launcher hook recorded, and the toast/debug lines the chain emitted.
let launched: { id: string; r: Runnable; project: string; opts: TaskLaunchOpts }[] = [];
let toasts: string[] = [];
let logs: string[] = [];
let launchFails: string[] = []; // labels whose launch returns null (a blocked task)

// launchWithDeps is all microtasks — no timers, no I/O — so draining the microtask
// queue is enough to let a chain advance as far as it can.
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
// Finish a started run the way the pty-exit listener does.
const finish = (id: string, code: number) => { const w = exitWaiters.get(id); exitWaiters.delete(id); w?.(code); };
const labels = () => launched.map((l) => l.r.label);
const seed = (...list: Runnable[]) => { for (const r of list) lastRunnableById.set(r.id, r); };

beforeEach(() => {
  launched = []; toasts = []; logs = []; launchFails = [];
  lastRunnableById.clear();
  exitWaiters.clear();
  for (const k of Object.keys(taskRunner)) delete taskRunner[k];
  for (const k of Object.keys(taskInputs)) delete taskInputs[k];
  store.clear();
  let n = 0;
  setTaskLauncher(async (r, project, opts) => {
    if (launchFails.includes(r.label)) return null;
    const id = `run${++n}`;
    launched.push({ id, r, project, opts });
    return id;
  });
  setTaskToast((m) => { toasts.push(m); });
  setTaskLogger((lvl, m) => { logs.push(`${lvl} ${m}`); });
});

describe("stopRuleBlocked — unattended means unattended", () => {
  it("passes a plain task", () => {
    expect(stopRuleBlocked(run())).toBe("");
  });
  it("refuses a task discovery already blocked, quoting its reason verbatim", () => {
    expect(stopRuleBlocked(run({ blocked: "needs an editor (${file})" }))).toBe("needs an editor (${file})");
  });
  it("refuses a background task — it never finishes a turn", () => {
    expect(stopRuleBlocked(run({ background: true }))).toMatch(/never finishes a turn/);
  });
  it("refuses one that asks for input — nobody is there to answer", () => {
    expect(stopRuleBlocked(run({ inputs: [inputSpec()] }))).toMatch(/needs someone there/);
  });
  it("reports the discovery reason first when a task is blocked AND background", () => {
    expect(stopRuleBlocked(run({ blocked: "unsupported type", background: true }))).toBe("unsupported type");
  });
  it("reports background before input when a task is both", () => {
    expect(stopRuleBlocked(run({ background: true, inputs: [inputSpec()] }))).toMatch(/never finishes a turn/);
  });
});

describe("execCmd — the command as a human reads it", () => {
  it("shows a shell task's line as written", () => {
    expect(execCmd(run({ exec: { mode: "shell", line: "cargo test && echo ok" } }))).toBe("cargo test && echo ok");
  });
  it("joins an argv task back into one line", () => {
    expect(execCmd(run())).toBe("npm run test");
  });
  it("shows a bare program with no arguments", () => {
    expect(execCmd(run({ exec: { mode: "argv", program: "just", args: [] } }))).toBe("just");
  });
});

describe("applyRunner — the per-project package-runner override", () => {
  it("returns the list untouched when the project has no override", () => {
    const list = [run()];
    expect(applyRunner(list, "/w/epi")).toBe(list); // the same array, not a rebuilt copy
  });
  it("swaps the program of an npm task", () => {
    taskRunner["/w/epi"] = "pnpm";
    const out = applyRunner([run()], "/w/epi");
    expect(out[0].exec).toEqual({ mode: "argv", program: "pnpm", args: ["run", "test"] });
  });
  it("leaves tasks from other providers alone", () => {
    taskRunner["/w/epi"] = "pnpm";
    const out = applyRunner([run({ source: "just", exec: { mode: "argv", program: "just", args: ["build"] } })], "/w/epi");
    expect(out[0].exec).toMatchObject({ program: "just" });
  });
  it("leaves a shell-mode npm task alone — there is no program to swap", () => {
    taskRunner["/w/epi"] = "yarn";
    const out = applyRunner([run({ exec: { mode: "shell", line: "npm run test" } })], "/w/epi");
    expect(out[0].exec).toEqual({ mode: "shell", line: "npm run test" });
  });
  it("does not mutate the discovered task it was handed", () => {
    taskRunner["/w/epi"] = "bun";
    const orig = run();
    applyRunner([orig], "/w/epi");
    expect(orig.exec).toMatchObject({ program: "npm" });
  });
  it("applies only to the project it was set for", () => {
    taskRunner["/w/epi"] = "pnpm";
    expect(applyRunner([run()], "/w/other")[0].exec).toMatchObject({ program: "npm" });
  });
});

describe("remembered ${input:…} values", () => {
  it("gives back what was typed last", () => {
    rememberInput("epi", "npm:test", "name", "release");
    expect(rememberedInput("epi", "npm:test", "name")).toBe("release");
  });
  it("has nothing to give for an input never answered", () => {
    expect(rememberedInput("epi", "npm:test", "name")).toBeUndefined();
  });
  it("keys on all three of project, task and input", () => {
    rememberInput("epi", "npm:test", "name", "v1");
    expect(rememberedInput("other", "npm:test", "name")).toBeUndefined();
    expect(rememberedInput("epi", "npm:build", "name")).toBeUndefined();
    expect(rememberedInput("epi", "npm:test", "other")).toBeUndefined();
  });
  it("persists straight away, so the next launch sees it", () => {
    rememberInput("epi", "npm:test", "name", "v1");
    expect(JSON.parse(store.get("cc-task-inputs")!)).toEqual({ "epi␟npm:test␟name": "v1" });
  });
  it("overwrites rather than accumulating", () => {
    rememberInput("epi", "npm:test", "name", "v1");
    rememberInput("epi", "npm:test", "name", "v2");
    expect(rememberedInput("epi", "npm:test", "name")).toBe("v2");
    expect(Object.keys(taskInputs)).toHaveLength(1);
  });
});

describe("applyInputs — filling in what only a human knows", () => {
  it("substitutes into a shell line", () => {
    const out = applyInputs(run({ exec: { mode: "shell", line: "deploy --to ${input:env}" } }), { env: "prod" });
    expect(out.exec).toEqual({ mode: "shell", line: "deploy --to prod" });
  });
  it("substitutes into the program and every argument", () => {
    const r = run({ exec: { mode: "argv", program: "${input:bin}", args: ["run", "${input:script}"] } });
    const out = applyInputs(r, { bin: "pnpm", script: "build" });
    expect(out.exec).toEqual({ mode: "argv", program: "pnpm", args: ["run", "build"] });
  });
  it("substitutes into cwd and every env value", () => {
    const r = run({ cwd: "/w/${input:dir}", env: { TARGET: "${input:env}", FIXED: "keep" } });
    const out = applyInputs(r, { dir: "sub", env: "prod" });
    expect(out.cwd).toBe("/w/sub");
    expect(out.env).toEqual({ TARGET: "prod", FIXED: "keep" });
  });
  it("replaces every occurrence, not just the first", () => {
    const out = applyInputs(run({ exec: { mode: "shell", line: "cp ${input:x} ${input:x}.bak" } }), { x: "f" });
    expect(out.exec).toMatchObject({ line: "cp f f.bak" });
  });
  it("leaves a placeholder intact when nothing answered it", () => {
    // Better a literal ${input:…} reaching the shell than a silent empty string,
    // which would turn `deploy --to ${input:env}` into `deploy --to`.
    const out = applyInputs(run({ exec: { mode: "shell", line: "deploy ${input:env}" } }), {});
    expect(out.exec).toMatchObject({ line: "deploy ${input:env}" });
  });
  it("substitutes an empty answer as empty — answered is not the same as unanswered", () => {
    const out = applyInputs(run({ exec: { mode: "shell", line: "deploy ${input:env}" } }), { env: "" });
    expect(out.exec).toMatchObject({ line: "deploy " });
  });
  it("does not re-expand a placeholder that came from a value", () => {
    const out = applyInputs(run({ exec: { mode: "shell", line: "echo ${input:a}" } }), { a: "${input:b}", b: "nope" });
    expect(out.exec).toMatchObject({ line: "echo ${input:b}" });
  });
  it("clears the inputs, so the filled task never prompts again", () => {
    const out = applyInputs(run({ inputs: [inputSpec()] }), { name: "x" });
    expect(out.inputs).toEqual([]);
  });
  it("keeps everything else about the task", () => {
    const r = run({ id: "vscode:deploy", label: "deploy", dependsOn: ["build"], background: true });
    expect(applyInputs(r, {})).toMatchObject({ id: "vscode:deploy", label: "deploy", dependsOn: ["build"], background: true });
  });
  it("does not mutate the discovered task", () => {
    const r = run({ exec: { mode: "shell", line: "deploy ${input:env}" }, env: { E: "${input:env}" } });
    applyInputs(r, { env: "prod" });
    expect(r.exec).toMatchObject({ line: "deploy ${input:env}" });
    expect(r.env).toEqual({ E: "${input:env}" });
  });
});

describe("resolveDeps — VS Code names dependencies by label", () => {
  it("finds a dependency by its label", () => {
    const build = run({ id: "npm:build", label: "build" });
    seed(build);
    expect(resolveDeps(run({ dependsOn: ["build"] }), new Set())).toEqual([build]);
  });
  it("prefers a match from the same provider", () => {
    const mine = run({ id: "npm:build", label: "build", source: "npm" });
    const theirs = run({ id: "just:build", label: "build", source: "just" });
    seed(theirs, mine); // the other provider was discovered first
    expect(resolveDeps(run({ source: "npm", dependsOn: ["build"] }), new Set())).toEqual([mine]);
  });
  it("falls back to another provider when its own has no such label", () => {
    const theirs = run({ id: "just:build", label: "build", source: "just" });
    seed(theirs);
    expect(resolveDeps(run({ source: "npm", dependsOn: ["build"] }), new Set())).toEqual([theirs]);
  });
  it("resolves each label, in the order declared", () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    expect(resolveDeps(run({ dependsOn: ["b", "a"] }), new Set()).map((d) => d.label)).toEqual(["b", "a"]);
  });
  // null and [] are different answers: "I could not resolve these" vs "there are
  // none". Returning [] for both is what used to run a task whose build had been
  // renamed away.
  it("gives up on the whole list when one label matches nothing, and says so", () => {
    seed(run({ id: "npm:a", label: "a" }));
    expect(resolveDeps(run({ label: "test", dependsOn: ["a", "ghost"] }), new Set())).toBeNull();
    expect(toasts).toEqual([expect.stringContaining("no task named")]);
  });
  it("says the task is not running, not merely that the label is unknown", () => {
    seed(run({ id: "npm:a", label: "a" }));
    resolveDeps(run({ label: "test", dependsOn: ["ghost"] }), new Set());
    expect(toasts[0]).toMatch(/not running it/);
  });
  it("refuses a cycle rather than recursing until the stack gives out", () => {
    seed(run({ id: "npm:a", label: "a" }));
    expect(resolveDeps(run({ label: "test", dependsOn: ["a"] }), new Set(["npm:a"]))).toBeNull();
    expect(toasts).toEqual([expect.stringContaining("dependency cycle")]);
  });
  it("returns an empty list — not null — for a task that declares no dependencies", () => {
    expect(resolveDeps(run(), new Set())).toEqual([]);
    expect(toasts).toEqual([]);
  });
});

describe("launchWithDeps — the chain", () => {
  it("launches straight away when there is nothing to wait for", async () => {
    await expect(launchWithDeps(run(), "epi", {})).resolves.toBe("run1");
    expect(labels()).toEqual(["test"]);
  });
  it("runs dependencies before the task itself", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["build"]); // the task itself is still waiting
    finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["build", "test"]);
    await expect(p).resolves.toBe("run2");
  });
  it("starts parallel dependencies together — VS Code's default", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["a", "b"]); // both up before either has exited
    finish("run2", 0); finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["a", "b", "test"]);
    await expect(p).resolves.toBe("run3");
  });
  it("holds each sequence dependency until the previous one exits", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"], dependsOrder: "sequence" }), "epi", {});
    await settle();
    expect(labels()).toEqual(["a"]);
    finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["a", "b"]);
    finish("run2", 0);
    await settle();
    await expect(p).resolves.toBe("run3");
  });
  it("does not test a build that didn't happen", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    finish("run1", 1); // the build failed
    await settle();
    expect(labels()).toEqual(["build"]);
    await expect(p).resolves.toBeNull();
    expect(toasts).toEqual([expect.stringContaining("a dependency failed")]);
  });
  it("stops a sequence at the first failure instead of running the rest", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"], dependsOrder: "sequence" }), "epi", {});
    await settle();
    finish("run1", 1);
    await settle();
    expect(labels()).toEqual(["a"]); // b never started
    await expect(p).resolves.toBeNull();
  });
  it("still waits for every parallel dependency before giving up", async () => {
    // Parallel means they all run; the *result* is the conjunction.
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"] }), "epi", {});
    await settle();
    finish("run1", 1);
    await settle();
    expect(labels()).toEqual(["a", "b"]);
    finish("run2", 0);
    await settle();
    await expect(p).resolves.toBeNull();
  });
  it("treats a dependency that would not start at all as a failure", async () => {
    seed(run({ id: "npm:build", label: "build", blocked: "needs an editor" }));
    launchFails = ["build"];
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    expect(labels()).toEqual([]);
    await expect(p).resolves.toBeNull();
  });
  it("runs the whole chain when a dependency has dependencies of its own", async () => {
    seed(run({ id: "npm:gen", label: "gen" }), run({ id: "npm:build", label: "build", dependsOn: ["gen"] }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["gen"]);
    finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["gen", "build"]);
    finish("run2", 0);
    await settle();
    expect(labels()).toEqual(["gen", "build", "test"]);
    await expect(p).resolves.toBe("run3");
  });
  it("does not run a task whose dependency label matches nothing", async () => {
    // A renamed build is exactly as dangerous as a failed one: testing against
    // whatever happens to be on disk is the outcome the chain exists to prevent.
    const p = launchWithDeps(run({ dependsOn: ["ghost"] }), "epi", {});
    await settle();
    expect(toasts).toEqual([expect.stringContaining("no task named")]);
    expect(labels()).toEqual([]);
    await expect(p).resolves.toBeNull();
  });
  it("launches nothing at all when the chain is a cycle", async () => {
    seed(run({ id: "npm:a", label: "a", dependsOn: ["test"] }), run({ id: "npm:test", label: "test", dependsOn: ["a"] }));
    const p = launchWithDeps(run({ id: "npm:test", label: "test", dependsOn: ["a"] }), "epi", {});
    await settle();
    expect(toasts[0]).toMatch(/dependency cycle/);
    expect(labels()).toEqual([]); // neither member runs half a chain
    await expect(p).resolves.toBeNull();
  });
  it("narrates an unresolved dependency to the debug console", async () => {
    const p = launchWithDeps(run({ dependsOn: ["ghost"] }), "epi", {});
    await settle();
    await p;
    expect(logs).toContain("warn task npm:test skipped: dependency unresolved");
  });
  it("hands a dependency the stage behaviour but not the parent's identity", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    void launchWithDeps(run({ dependsOn: ["build"] }), "epi",
      { focus: false, colorKey: "/w/epi", forSession: "sid", discoveredIn: "/w/epi/sub" });
    await settle();
    const dep = launched[0].opts;
    expect(dep.focus).toBe(false);            // an unattended run stays unattended…
    expect(dep.colorKey).toBe("/w/epi");
    expect(dep.forSession).toBeUndefined();   // …but the build step isn't verifying a turn
    expect(dep.discoveredIn).toBeUndefined(); // and must resolve its own source root
  });
  it("keeps the parent's own identity intact", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", { forSession: "sid", discoveredIn: "/w/epi" });
    await settle();
    finish("run1", 0);
    await settle();
    await p;
    expect(launched[1].opts).toMatchObject({ forSession: "sid", discoveredIn: "/w/epi" });
  });
  it("passes the project through to every run in the chain", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    finish("run1", 0);
    await settle();
    await p;
    expect(launched.map((l) => l.project)).toEqual(["epi", "epi"]);
  });
  it("narrates the chain to the debug console", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"], dependsOrder: "sequence" }), "epi", {});
    await settle();
    expect(logs).toEqual(["info task npm:test · 2 deps (sequence)"]);
    finish("run1", 1);
    await settle();
    await p;
    expect(logs).toContain("warn task npm:test skipped: dependency failed");
  });
});
