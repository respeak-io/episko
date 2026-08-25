import { describe, it, expect, beforeEach } from "vitest";
import { runElapsed, taskStateText, type InputSpec, type Runnable, type Sess } from "../src/types";
import { store } from "./localstorage"; // must precede the subject import
import {
  applyInputs, applyRunner, execCmd, exitWaiters, findDepCycle, lastRunnableById,
  launchWithDeps, prefillInputs, rememberedInput, rememberInput, resolveDeps, resolveRunInputs,
  setTaskLauncher, setTaskLogger, setTaskToast, stopRuleBlocked, taskInputs, taskRunner,
  type TaskLaunchOpts,
} from "../src/tasks";

const run = (o: Partial<Runnable> = {}): Runnable => ({
  id: "npm:test", label: "test", detail: null, source: "npm", sourceFile: "package.json",
  group: null, exec: { mode: "argv", program: "npm", args: ["run", "test"] },
  cwd: "/w/epi", env: {}, background: false, inputs: [],
  dependsOn: [], dependsOrder: "parallel", blocked: null,
  compound: false, defaultFor: null, ...o,
});
const inputSpec = (o: Partial<InputSpec> = {}): InputSpec =>
  ({ id: "name", kind: "promptString", description: "Name", default: null, options: [], password: false, optional: false, ...o });

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
  // An input nobody has to answer is not a prompt, so naming one as the reason
  // would refuse the rule over a dialog that never opens.
  it("passes one whose only input is optional", () => {
    expect(stopRuleBlocked(run({ inputs: [inputSpec({ optional: true })] }))).toBe("");
  });
  it("passes one whose only input has a default", () => {
    expect(stopRuleBlocked(run({ inputs: [inputSpec({ default: "dev" })] }))).toBe("");
  });
  it("still refuses when one input of several needs answering", () => {
    expect(stopRuleBlocked(run({ inputs: [inputSpec({ optional: true }), inputSpec({ id: "env" })] }))).toMatch(/needs someone there/);
  });
});

// The rule behind the two Run buttons: running a task is the common case and must
// not cost a dialog, so the dialog opens only for what nothing can answer.
describe("prefillInputs — what a plain Run can start without asking", () => {
  const withInput = (i: Partial<InputSpec>) =>
    run({ exec: { mode: "shell", line: "just start ${input:services}" }, inputs: [inputSpec({ id: "services", ...i })] });

  it("passes a task with no inputs straight through", () => {
    const r = run();
    expect(prefillInputs(r, "epi")).toBe(r);
  });
  it("fills an optional input with nothing — a just `*name` takes zero or more", () => {
    expect(prefillInputs(withInput({ optional: true }), "epi")?.exec).toMatchObject({ line: "just start " });
  });
  it("fills from the definition's own default", () => {
    expect(prefillInputs(withInput({ default: "api" }), "epi")?.exec).toMatchObject({ line: "just start api" });
  });
  it("prefers what you typed last over the default", () => {
    rememberInput("epi", "npm:test", "services", "web");
    expect(prefillInputs(withInput({ default: "api" }), "epi")?.exec).toMatchObject({ line: "just start web" });
  });
  it("gives up on a required input with no answer anywhere — that is the one case worth a dialog", () => {
    expect(prefillInputs(withInput({}), "epi")).toBeNull();
  });
  it("never prefills a password, even one remembered by mistake", () => {
    rememberInput("epi", "npm:test", "services", "hunter2");
    expect(prefillInputs(withInput({ password: true }), "epi")).toBeNull();
  });
  it("gives up when any one of several inputs is unanswerable", () => {
    const r = run({
      exec: { mode: "shell", line: "x ${input:a} ${input:b}" },
      inputs: [inputSpec({ id: "a", optional: true }), inputSpec({ id: "b" })],
    });
    expect(prefillInputs(r, "epi")).toBeNull();
  });
  it("clears the inputs, so what it returns never prompts again", () => {
    expect(prefillInputs(withInput({ optional: true }), "epi")?.inputs).toEqual([]);
  });
});

// The withParams rule lives in one place so Run, ⌘⇧B and re-run cannot drift:
// the explicit *Run with parameters…* verb always asks, a plain run only when it must.
describe("resolveRunInputs — the attended surfaces' shared first step", () => {
  it("forces the dialog for withParams when there is anything to ask about", () => {
    expect(resolveRunInputs(run({ inputs: [inputSpec({ default: "api" })] }), "epi", true)).toBeNull();
  });
  it("withParams on a task with no inputs has nothing to ask, so it launches", () => {
    const r = run();
    expect(resolveRunInputs(r, "epi", true)).toBe(r);
  });
  it("a plain run prefills — answerable inputs launch, unanswerable ones prompt", () => {
    expect(resolveRunInputs(run({ inputs: [inputSpec({ default: "api" })] }), "epi")).not.toBeNull();
    expect(resolveRunInputs(run({ inputs: [inputSpec()] }), "epi")).toBeNull();
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
    expect(resolveDeps(run({ dependsOn: ["b", "a"] }), new Set())?.map((d) => d.label)).toEqual(["b", "a"]);
  });
  // null and [] are different answers: "I could not resolve these" vs "there are
  // none". Returning [] for both is what used to run a task whose build had been
  // renamed away.
  it("gives up on the whole list when one label matches nothing, and says so", () => {
    seed(run({ id: "npm:a", label: "a" }));
    expect(resolveDeps(run({ label: "test", dependsOn: ["a", "ghost"] }), new Set())).toBeNull();
    expect(toasts).toEqual([expect.stringContaining("no task named")]);
  });
  // The consequence has to be in the toast: "no task named x" alone reads as a
  // lookup failure somebody might shrug at, when the whole chain has just stopped.
  it("says the chain will not run, as well as naming the unknown label", () => {
    seed(run({ id: "npm:a", label: "a" }));
    resolveDeps(run({ label: "test", dependsOn: ["ghost"] }), new Set());
    expect(toasts[0]).toMatch(/will not run/);
    expect(toasts[0]).toContain("ghost");
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
    await expect(launchWithDeps(run(), "epi", {})).resolves.toEqual({ ok: true, id: "run1" });
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
    await expect(p).resolves.toEqual({ ok: true, id: "run2" });
  });
  it("starts parallel dependencies together — VS Code's default", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["a", "b"]); // both up before either has exited
    finish("run2", 0); finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["a", "b", "test"]);
    await expect(p).resolves.toEqual({ ok: true, id: "run3" });
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
    await expect(p).resolves.toEqual({ ok: true, id: "run3" });
  });
  it("does not test a build that didn't happen", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    finish("run1", 1); // the build failed
    await settle();
    expect(labels()).toEqual(["build"]);
    await expect(p).resolves.toEqual({ ok: false, id: null });
    expect(toasts).toEqual([expect.stringContaining("a dependency failed")]);
  });
  it("stops a sequence at the first failure instead of running the rest", async () => {
    seed(run({ id: "npm:a", label: "a" }), run({ id: "npm:b", label: "b" }));
    const p = launchWithDeps(run({ dependsOn: ["a", "b"], dependsOrder: "sequence" }), "epi", {});
    await settle();
    finish("run1", 1);
    await settle();
    expect(labels()).toEqual(["a"]); // b never started
    await expect(p).resolves.toEqual({ ok: false, id: null });
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
    await expect(p).resolves.toEqual({ ok: false, id: null });
  });
  it("treats a dependency that would not start at all as a failure", async () => {
    seed(run({ id: "npm:build", label: "build", blocked: "needs an editor" }));
    launchFails = ["build"];
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", {});
    await settle();
    expect(labels()).toEqual([]);
    await expect(p).resolves.toEqual({ ok: false, id: null });
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
    await expect(p).resolves.toEqual({ ok: true, id: "run3" });
  });
  it("does not run a task whose dependency label matches nothing", async () => {
    // A renamed build is exactly as dangerous as a failed one: testing against
    // whatever happens to be on disk is the outcome the chain exists to prevent.
    const p = launchWithDeps(run({ dependsOn: ["ghost"] }), "epi", {});
    await settle();
    expect(toasts).toEqual([expect.stringContaining("no task named")]);
    expect(labels()).toEqual([]);
    await expect(p).resolves.toEqual({ ok: false, id: null });
  });
  it("launches nothing at all when the chain is a cycle", async () => {
    seed(run({ id: "npm:a", label: "a", dependsOn: ["test"] }), run({ id: "npm:test", label: "test", dependsOn: ["a"] }));
    const p = launchWithDeps(run({ id: "npm:test", label: "test", dependsOn: ["a"] }), "epi", {});
    await settle();
    expect(toasts[0]).toMatch(/dependency cycle/);
    expect(labels()).toEqual([]); // neither member runs half a chain
    await expect(p).resolves.toEqual({ ok: false, id: null });
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
    // `discoveredIn` IS inherited, and this assertion used to say the opposite. It is
    // the directory *discovery ran in*, not the parent's cwd, and a dependency comes
    // out of that same discovery result — so withholding it only made `run.root` fall
    // back to the repo root, which mis-clustered the pane, pointed reveal-source at
    // the wrong folder, and let the cwd preference override a declared `options.cwd`.
    expect(dep.discoveredIn).toBe("/w/epi/sub");
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

describe("launchWithDeps — compound tasks and background dependencies", () => {
  // The shape this exists for, taken from a real tasks.json:
  //   "Dev: Frontend + Backend" -> dependsOn [vite dev, uvicorn --reload], no command
  // Both dependencies are servers that never exit. Awaiting them hung the chain
  // forever; and the compound itself has nothing to spawn.
  const server = (label: string) => run({ id: "vscode:" + label, label, background: true });
  const compound = (deps: string[]) =>
    run({ id: "vscode:dev", label: "Dev: Frontend + Backend", compound: true,
          defaultFor: "build", dependsOn: deps, exec: { mode: "shell", line: "" } });

  it("starts a whole stack of servers without waiting for any of them to exit", async () => {
    seed(server("vite dev"), server("uvicorn"));
    const p = launchWithDeps(compound(["vite dev", "uvicorn"]), "epi", {});
    await settle();
    // Nothing has exited and nothing ever will — yet the chain is complete.
    expect(labels()).toEqual(["vite dev", "uvicorn"]);
    await expect(p).resolves.toEqual({ ok: true, id: null });
  });

  it("launches no pane for the compound itself — its dependencies were the work", async () => {
    seed(server("vite dev"));
    await launchWithDeps(compound(["vite dev"]), "epi", {});
    await settle();
    expect(labels()).not.toContain("Dev: Frontend + Backend");
  });

  it("groups the stack it started, so it folds into one sidebar row", async () => {
    seed(server("vite dev"), server("uvicorn"));
    await launchWithDeps(compound(["vite dev", "uvicorn"]), "epi", {});
    await settle();
    const gids = new Set(launched.map((l) => l.opts.groupId));
    expect(gids.size).toBe(1);
    expect([...gids][0]).toBeTruthy();
    expect(launched[0].opts.groupLabel).toBe("Dev: Frontend + Backend");
  });

  it("still fails the chain when a dependency cannot be launched at all", async () => {
    seed(server("vite dev"));
    launchFails = ["vite dev"];
    const p = launchWithDeps(compound(["vite dev"]), "epi", {});
    await settle();
    await expect(p).resolves.toEqual({ ok: false, id: null });
    expect(toasts).toEqual([expect.stringContaining("a dependency failed")]);
  });

  it("a NON-background dependency is still waited for", async () => {
    // The fix must not turn every dependency into fire-and-forget: "build then test"
    // only means anything if the build's exit code is actually read.
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ label: "test", dependsOn: ["build"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["build"]);   // test has NOT started
    finish("run1", 0);
    await settle();
    expect(labels()).toEqual(["build", "test"]);
    await expect(p).resolves.toEqual({ ok: true, id: "run2" });
  });

  it("a compound nested as a dependency satisfies its parent", async () => {
    // The bug this guards: a compound returns no pane id, and reading that absence
    // as failure would make any chain that depends on one fail for no reason.
    seed(server("vite dev"), compound(["vite dev"]));
    const p = launchWithDeps(
      run({ label: "smoke", dependsOn: ["Dev: Frontend + Backend"] }), "epi", {});
    await settle();
    expect(labels()).toEqual(["vite dev", "smoke"]);
    await expect(p).resolves.toEqual({ ok: true, id: "run2" });
  });

  it("refuses a compound as a run-on-stop rule — a failure would have no pane", () => {
    expect(stopRuleBlocked(compound(["vite dev"]))).toMatch(/no pane to report to/);
  });
});

describe("launchWithDeps — what a dependency inherits", () => {
  it("passes the discovery directory down, so a dep's root is its checkout", () => {
    // Clearing this fell back to the repo root, which put reveal-source in the wrong
    // folder, clustered the pane under the wrong checkout, and let the "run in repo
    // root" preference override a dependency's own declared cwd.
    seed(run({ id: "npm:build", label: "build" }));
    void launchWithDeps(run({ dependsOn: ["build"] }), "epi", { discoveredIn: "/w/wt-feat" });
    return settle().then(() => {
      expect(launched[0].r.label).toBe("build");
      expect(launched[0].opts.discoveredIn).toBe("/w/wt-feat");
    });
  });
  it("still withholds forSession — a dep is not the run being verified", async () => {
    seed(run({ id: "npm:build", label: "build" }));
    const p = launchWithDeps(run({ dependsOn: ["build"] }), "epi", { forSession: "sess-1" });
    await settle();
    expect(launched[0].opts.forSession).toBeUndefined();
    finish("run1", 0);
    await settle();
    // The task that owns the rule keeps it.
    expect(launched[1].opts.forSession).toBe("sess-1");
    await p;
  });
});

describe("taskStateText — a finished run's duration must stop moving", () => {
  // Only `phase` and `run` are read, so the fixture stays to those.
  const t = (run: Partial<NonNullable<Sess["run"]>>, phase: Sess["phase"] = "working"): Sess =>
    ({ phase, kind: "task", run: {
      id: "npm:x", label: "x", source: "npm", sourceFile: "package.json", cmd: "x",
      background: false, startedAt: 1_000_000, exitCode: null, tail: [], root: "/w", ...run,
    } } as Sess);
  const NOW = 1_000_000 + 83_000;   // 1m 23s after the start

  it("freezes a finished run at its exit, not at now", () => {
    // The bug: every repaint measured a *completed* step against Date.now(), so four
    // steps that each took under a second all read the same ever-growing "1m 23s".
    const done = t({ exitCode: 0, endedAt: 1_000_000 + 419 }, "done");
    expect(taskStateText(done, NOW)).toBe("0s");
    // …and it stays put as the clock moves on.
    expect(taskStateText(done, NOW + 600_000)).toBe("0s");
  });
  it("still counts up while the run is actually going", () => {
    expect(taskStateText(t({}), NOW)).toBe("1m 23s");
    expect(taskStateText(t({}), 1_000_000 + 4_000)).toBe("4s");
  });
  it("reads bg for a background run for as long as it lives, then its duration", () => {
    expect(taskStateText(t({ background: true }), NOW)).toBe("bg");
    // A server that finally exits is no longer "bg" — it has a real duration.
    expect(taskStateText(t({ background: true, exitCode: 0, endedAt: 1_000_000 + 60_000 }, "done"), NOW))
      .toBe("1m 0s");
  });
  it("reports a failure by code, which has no duration to show", () => {
    expect(taskStateText(t({ exitCode: 3, endedAt: NOW }, "error"), NOW)).toBe("exit 3");
  });
  it("falls back to now for a run that exited before endedAt was recorded", () => {
    // A pane restored from an older build has no endedAt; better an approximate
    // duration than a blank or a crash.
    expect(taskStateText(t({ exitCode: 0 }, "done"), NOW)).toBe("1m 23s");
  });
  it("says nothing for a pane that is not a run", () => {
    expect(taskStateText({ phase: "idle", kind: "agent" } as Sess, NOW)).toBe("");
  });

  // The inspector's "Took" row, the sidebar column and a tiled pane's caption each had
  // their own `Date.now() - startedAt`, and fixing two of the three is how the bug
  // survived being "fixed". They all call this now, so pin it directly.
  describe("runElapsed — the one source every duration reads", () => {
    const r = (o: Partial<NonNullable<Sess["run"]>>) => t(o).run!;
    it("stops at the exit for a finished run, whatever the clock says", () => {
      const done = r({ exitCode: 0, endedAt: 1_000_000 + 419 });
      expect(runElapsed(done, NOW)).toBe("0s");
      expect(runElapsed(done, NOW + 3_600_000)).toBe("0s");
    });
    it("freezes a FAILED run too — the inspector shows a duration beside the exit code", () => {
      const bad = r({ exitCode: 1, endedAt: 1_000_000 + 2_000 });
      expect(runElapsed(bad, NOW)).toBe("2s");
    });
    it("keeps counting while the run is still going", () => {
      expect(runElapsed(r({}), NOW)).toBe("1m 23s");
    });
  });
});

describe("launchWithDeps — a DAG is walked once, not once per path", () => {
  // The real shape, from a `Dev: Frontend + Backend` that launched 27 panes for 11
  // tasks: several tasks name the same dependency, so every path to it started it
  // again. `uv sync` ran six times, `pnpm install` and `docker compose up` four each.
  const seedDiamond = () => seed(
    run({ id: "vscode:pnpm-install", label: "pnpm install" }),
    run({ id: "vscode:fe-pw", label: "fe playwright", dependsOn: ["pnpm install"] }),
    run({ id: "vscode:vite", label: "vite dev", background: true, dependsOn: ["pnpm install", "fe playwright"] }),
    run({ id: "vscode:uv", label: "uv sync" }),
    run({ id: "vscode:be-pw", label: "be playwright", dependsOn: ["uv sync"] }),
    run({ id: "vscode:uvicorn", label: "uvicorn", background: true, dependsOn: ["uv sync", "be playwright"] }),
  );
  const dev = () => run({
    id: "vscode:dev", label: "Dev", compound: true, dependsOrder: "parallel",
    dependsOn: ["vite dev", "uvicorn"], exec: { mode: "shell", line: "" },
  });
  // Exit whatever has started under these labels, the way the pty-exit listener does.
  const finishAll = async (...ls: string[]) => {
    for (const l of ls) for (const x of launched.filter((y) => y.r.label === l)) finish(x.id, 0);
    await settle();
  };

  it("starts each distinct task exactly once per launch", async () => {
    seedDiamond();
    const p = launchWithDeps(dev(), "epi", {});
    await settle();
    // Both leaves are named by two different dependents. One launch each, and the
    // dependents wait rather than starting their own copy.
    expect(labels().sort()).toEqual(["pnpm install", "uv sync"]);
    await finishAll("pnpm install", "uv sync");
    expect(labels().sort()).toEqual(["be playwright", "fe playwright", "pnpm install", "uv sync"]);
    await finishAll("fe playwright", "be playwright");
    expect(labels().filter((l) => l === "pnpm install")).toHaveLength(1);
    expect(labels().filter((l) => l === "uv sync")).toHaveLength(1);
    expect(labels().sort()).toEqual(
      ["be playwright", "fe playwright", "pnpm install", "uv sync", "uvicorn", "vite dev"]);
    await expect(p).resolves.toEqual({ ok: true, id: null });
  });

  it("lets both dependents share ONE wait on a shared dependency", async () => {
    // exitWaiters holds a single resolver per session id, so two dependents each
    // calling waitForExit on the same pane would clobber one another and one branch
    // would hang for ever. They await one promise now — if they did not, the chain
    // below would never reach the servers.
    seedDiamond();
    const p = launchWithDeps(dev(), "epi", {});
    await settle();
    await finishAll("pnpm install", "uv sync");
    await finishAll("fe playwright", "be playwright");
    expect(labels()).toContain("vite dev");
    expect(labels()).toContain("uvicorn");
    await expect(p).resolves.toEqual({ ok: true, id: null });
  });

  it("still fails every dependent when the shared dependency fails", async () => {
    seedDiamond();
    launchFails = ["pnpm install"];
    const p = launchWithDeps(dev(), "epi", {});
    await settle();
    await finishAll("uv sync");          // let the other half of the fan-out finish
    await finishAll("be playwright");
    // The frontend half never got past its install, so no server on that side.
    expect(labels()).not.toContain("vite dev");
    await expect(p).resolves.toEqual({ ok: false, id: null });
  });

  it("keeps the whole chain in one run group", async () => {
    seedDiamond();
    const p = launchWithDeps(dev(), "epi", {});
    await settle();
    await finishAll("pnpm install", "uv sync");
    await finishAll("fe playwright", "be playwright");
    expect(new Set(launched.map((l) => l.opts.groupId)).size).toBe(1);
    await p;
  });
});

describe("findDepCycle — caught before anything launches", () => {
  it("finds a cycle and names the loop", () => {
    seed(run({ id: "a", label: "a", dependsOn: ["b"] }),
         run({ id: "b", label: "b", dependsOn: ["a"] }));
    expect(findDepCycle(lastRunnableById.get("a")!)).toEqual(["a", "b", "a"]);
  });
  it("finds a cycle that only closes further down", () => {
    seed(run({ id: "a", label: "a", dependsOn: ["b"] }),
         run({ id: "b", label: "b", dependsOn: ["c"] }),
         run({ id: "c", label: "c", dependsOn: ["b"] }));
    expect(findDepCycle(lastRunnableById.get("a")!)).toEqual(["b", "c", "b"]);
  });
  it("does NOT mistake a diamond for a cycle", () => {
    // The whole point: `d` is reachable by two paths and that is perfectly legal.
    seed(run({ id: "a", label: "a", dependsOn: ["b", "c"] }),
         run({ id: "b", label: "b", dependsOn: ["d"] }),
         run({ id: "c", label: "c", dependsOn: ["d"] }),
         run({ id: "d", label: "d" }));
    expect(findDepCycle(lastRunnableById.get("a")!)).toBeNull();
  });
  it("ignores a label that resolves to nothing — that is resolveDeps's error", () => {
    seed(run({ id: "a", label: "a", dependsOn: ["ghost"] }));
    expect(findDepCycle(lastRunnableById.get("a")!)).toBeNull();
  });
  it("stops the launch before a single pane starts", async () => {
    seed(run({ id: "a", label: "a", dependsOn: ["b"] }),
         run({ id: "b", label: "b", dependsOn: ["a"] }));
    const p = launchWithDeps(lastRunnableById.get("a")!, "epi", {});
    await settle();
    expect(labels()).toEqual([]);          // nothing half-started
    expect(toasts).toEqual([expect.stringContaining("dependency cycle")]);
    await expect(p).resolves.toEqual({ ok: false, id: null });
  });
});
