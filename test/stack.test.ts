import { describe, it, expect } from "vitest";
import {
  agoMs, buildStacks, checkoutOf, containerHealth, containerState, exitOf, hostPorts, checkProposal, proposalText, stackSummary, stackTally, taskSlug,
  type Checkout, type Container, type PaneIn, type StackInput,
} from "../src/stack";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const box = (o: Partial<Container> = {}): Container => ({
  id: "c1", name: "docexpostgresdb", state: "running", status: "Up 3 minutes (healthy)",
  ports: "127.0.0.1:5432->5432/tcp", project: "02_backend", service: "postgres",
  workingDir: "/w/docex/02_backend", ...o,
});
const pane = (o: Partial<PaneIn> = {}): PaneIn => ({
  sid: "p1", root: "/w/docex", project: "docex", taskId: "vscode:frontend-vite-dev", label: "Frontend (vite dev)",
  background: true, exit: null, startedAt: NOW - 10 * MIN, ...o,
});
const CHECKOUTS: Checkout[] = [
  { repo: "/w/docex", path: "/w/docex", name: "docex" },
  { repo: "/w/docex", path: "/w/docex-wt/refactor", name: "refactor" },
  { repo: "/w/pii", path: "/w/pii", name: "pii" },
];
const input = (o: Partial<StackInput> = {}): StackInput => ({
  panes: [], ports: new Map(), containers: [], checkouts: CHECKOUTS, configs: new Map(), now: NOW, ...o,
});

describe("reading docker's status line", () => {
  it("finds health, exit code and age", () => {
    expect(containerHealth("Up 3 hours (healthy)")).toBe("healthy");
    expect(containerHealth("Up 3 seconds (health: starting)")).toBe("starting");
    expect(containerHealth("Up 2 minutes (unhealthy)")).toBe("unhealthy");
    expect(containerHealth("Up 7 hours")).toBe("none");
    expect(exitOf("Exited (137) 2 minutes ago")).toBe(137);
    expect(exitOf("Up 1 hour")).toBeNull();
    expect(agoMs("Exited (0) 3 weeks ago")).toBe(3 * 7 * 864e5);
    expect(agoMs("Exited (1) About a minute ago")).toBe(MIN);
    expect(agoMs("Exited (1) Less than a second ago")).toBe(0);
    expect(agoMs("Created")).toBeNull();
  });

  it("collects host ports once each", () => {
    expect(hostPorts("0.0.0.0:8080->8080/tcp, [::]:8080->8080/tcp, 127.0.0.1:5432->5432/tcp")).toEqual([5432, 8080]);
    expect(hostPorts("5432/tcp")).toEqual([]);
  });

  it("blames an exit only when it happened during this stack's life", () => {
    const since = NOW - 10 * MIN;
    expect(containerState(box({ state: "exited", status: "Exited (1) 2 minutes ago" }), since, NOW)).toBe("failing");
    expect(containerState(box({ state: "exited", status: "Exited (1) 3 weeks ago" }), since, NOW)).toBe("stopped");
    expect(containerState(box({ state: "exited", status: "Exited (0) 2 minutes ago" }), since, NOW)).toBe("done");
    expect(containerState(box({ state: "restarting", status: "Restarting (1) 5 seconds ago" }), since, NOW)).toBe("failing");
    expect(containerState(box({ status: "Up 1 minute (unhealthy)" }), since, NOW)).toBe("failing");
    expect(containerState(box({ status: "Up 4 seconds (health: starting)" }), since, NOW)).toBe("starting");
  });
});

describe("checkoutOf", () => {
  it("takes the longest root, and never a sibling that shares a prefix", () => {
    const list: Checkout[] = [{ repo: "/w/a", path: "/w/a", name: "a" }, { repo: "/w/a", path: "/w/a/.wt/x", name: "x" }];
    expect(checkoutOf("/w/a/.wt/x/deploy", list)?.name).toBe("x");
    expect(checkoutOf("/w/a/deploy", list)?.name).toBe("a");
    expect(checkoutOf("/w/ab/deploy", list)).toBeUndefined();
  });
});

describe("buildStacks", () => {
  it("is ready once every prep step passed, every server listens and every container is healthy", () => {
    const [s] = buildStacks(input({
      panes: [
        pane({ sid: "prep", taskId: "vscode:dev-prep", label: "Dev: prep", background: false, exit: 0, groupId: "g", groupLabel: "Dev: Frontend + Backend", startedAt: NOW - 12 * MIN }),
        pane({ sid: "be", label: "Backend (uvicorn --reload)", groupId: "g", groupLabel: "Dev: Frontend + Backend" }),
        pane({ sid: "fe", groupId: "g", groupLabel: "Dev: Frontend + Backend", url: "http://expert.localhost:5176" }),
      ],
      ports: new Map([["be", [8003, 9229]]]),
      containers: [box()],
    }));
    expect(s.label).toBe("Dev: Frontend + Backend");
    expect(s.state).toBe("ready");
    expect(s.members.map((m) => m.state)).toEqual(["done", "serving", "serving"]);
    expect(s.members[1].ports).toEqual([8003]); // the inspector port is not a service
    expect(stackTally([s])).toEqual({ serving: 3, failed: false });
  });

  it("says what it is waiting for, and names what failed", () => {
    const waiting = buildStacks(input({ panes: [pane()], containers: [box({ status: "Up 2 seconds (health: starting)" })] }));
    expect(waiting[0]).toMatchObject({ state: "starting", why: "waiting for Frontend (vite dev) to listen" });

    const prepFailed = buildStacks(input({ panes: [pane({ sid: "db", label: "Backend (branch db)", background: false, exit: 1, groupId: "g" }), pane({ groupId: "g" })] }));
    expect(prepFailed[0]).toMatchObject({ state: "failed", why: "Backend (branch db) exited 1" });

    const crashLoop = buildStacks(input({ panes: [pane({ url: "http://localhost:5173" })], containers: [box({ service: "zot", state: "restarting", status: "Restarting (1) 3 seconds ago" })] }));
    expect(crashLoop[0]).toMatchObject({ state: "failed", why: "zot is restarting" });
    expect(stackTally(crashLoop).failed).toBe(true);
  });

  it("is a stack when a pane listens on a port, whatever its name made discovery guess", () => {
    const [s] = buildStacks(input({ panes: [pane({ taskId: "just:app", label: "app", background: false })], ports: new Map([["p1", [38418]]]) }));
    expect(s).toMatchObject({ label: "app", state: "ready" });
    expect(s.members[0]).toMatchObject({ state: "serving", ports: [38418] });
  });

  it("is not a stack when nothing in it serves, unless [stack] up names it", () => {
    const check = pane({ taskId: "just:test", label: "test", background: false });
    expect(buildStacks(input({ panes: [check] }))).toEqual([]);
    const named = buildStacks(input({ panes: [pane({ taskId: "just:dev", label: "dev", background: false })], configs: new Map([["/w/docex", { up: "just:dev" }]]) }));
    expect(named).toHaveLength(1);
    // A finished one-shot group is history, not a stack.
    expect(buildStacks(input({ panes: [pane({ taskId: "just:dev", background: false, exit: 0 })], configs: new Map([["/w/docex", { up: "just:dev" }]]) }))).toEqual([]);
  });

  it("attaches the repo's containers wherever they were started, and says from where", () => {
    const [s] = buildStacks(input({
      panes: [pane()],
      containers: [box(), box({ id: "c2", service: "mailpit", workingDir: "/w/docex-wt/refactor/02_backend" }), box({ id: "c3", project: "wirksam", workingDir: "/x/wirksam" })],
    }));
    expect(s.boxes.map((b) => [b.c.service, b.from])).toEqual([["mailpit", "refactor"], ["postgres", ""]]);
    expect(s.composeProjects).toEqual(["02_backend"]);
  });

  it("lists every page once: declared, then announced, then proxy routes", () => {
    const [s] = buildStacks(input({
      panes: [
        pane({ sid: "fe", groupId: "g", pages: [{ label: "Frontend", url: "http://wirksam.localhost:5174" }, { label: "Local", url: "http://localhost:5175" }] }),
        pane({ sid: "be", groupId: "g", label: "Backend", pages: [{ label: "docs", url: "http://wirksam.localhost:8788/docs" }] }),
      ],
      containers: [box({ service: "adminer", pages: ["http://adminer.localhost"] })],
      configs: new Map([["/w/docex", { pages: { App: "http://wirksam.localhost:5174/" } }]]),
    }));
    expect(s.pages.map((p) => [p.name, p.from])).toEqual([
      ["App", "declared"], ["localhost:5175", "pane"], ["docs", "pane"], ["adminer · adminer.localhost", "proxy"],
    ]);
  });

  it("waits on a described ready line, takes an app's window as up, and stops with what the tasks say", () => {
    const [waiting] = buildStacks(input({ panes: [pane({ kind: "server", describedPages: { App: "https://app.localhost:8443/ui/" }, stops: "just:down" })] }));
    expect(waiting.state).toBe("starting");
    expect(waiting.pages).toEqual([{ name: "App", url: "https://app.localhost:8443/ui/", from: "described" }]);
    expect(waiting.stops).toBe("just:down");
    expect(buildStacks(input({ panes: [pane({ kind: "server", readyAt: NOW })] }))[0].state).toBe("ready");
    expect(buildStacks(input({ panes: [pane({ kind: "app" })] }))[0].state).toBe("ready");
  });

  it("takes a compose project [stack] names even from outside the repo", () => {
    const [s] = buildStacks(input({
      panes: [pane()], containers: [box({ id: "c3", project: "shared-infra", workingDir: "/x/infra" })],
      configs: new Map([["/w/docex", { compose: ["shared-infra"] }]]),
    }));
    expect(s.boxes).toHaveLength(1);
  });

  it("hides containers that stopped before this run", () => {
    const [s] = buildStacks(input({ panes: [pane()], containers: [box({ state: "exited", status: "Exited (0) 3 weeks ago" })] }));
    expect(s.boxes).toEqual([]);
  });

  it("lists running containers no pane accounts for, per repo, and nothing for a stranger's", () => {
    const left = buildStacks(input({
      containers: [
        box(), box({ id: "c2", service: "redis", workingDir: "/w/docex-wt/refactor/02_backend" }),
        box({ id: "c4", state: "exited", status: "Exited (0) 3 weeks ago" }),
        box({ id: "c3", project: "wirksam", workingDir: "/x/wirksam" }),
      ],
    }));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ state: "leftover", project: "docex", label: "", why: "2 containers up · no dev task running" });
    // Only the worktree is named: the repo's own checkout is where a container is expected to come from.
    expect(left[0].boxes.map((b) => b.from)).toEqual(["", "refactor"]);
    expect(stackTally(left)).toEqual({ serving: 2, failed: false });
  });
});

describe("the [stack] table", () => {
  it("summarises what is set, and nothing when nothing is", () => {
    expect(stackSummary({ up: "just:dev", down: "just:down", compose: ["infra"] })).toBe("starts with just:dev · stops with just:down · compose infra");
    expect(stackSummary({})).toBe("");
  });


  it("slugs a label the way tasks.rs does", () => {
    expect(taskSlug("Dev: Frontend + Backend")).toBe("dev-frontend-backend");
    expect(taskSlug("  Stop containers! ")).toBe("stop-containers");
  });

  it("keeps ids that exist or that the proposal adds, and drops the rest out loud", () => {
    const tasks = [{ id: "vscode:dev-frontend-backend", cmd: "", background: false }];
    const p = {
      stack: { up: "vscode:dev-frontend-backend", down: "episko:stop-containers" },
      tasks: [{ label: "Stop containers", run: "docker compose stop" }],
      why: ["up: the default build task", "down: nothing stopped the containers"],
    };
    expect(checkProposal(p, tasks).dropped).toEqual([]);
    const withPages = checkProposal({ ...p, stack: { ...p.stack, pages: { App: "http://app.localhost:8443/ui/", Bad: "app.localhost" } } }, tasks);
    expect(withPages.stack.pages).toEqual({ App: "http://app.localhost:8443/ui/" });
    expect(withPages.dropped).toEqual(['page Bad = "app.localhost" is not an http(s) address']);
    const bad = checkProposal({ ...p, tasks: [] }, tasks);
    expect(bad.stack.down).toBeUndefined();
    expect(bad.dropped).toEqual(['down = "episko:stop-containers" names no task in this project']);
    const text = proposalText(p, checkProposal(p, tasks));
    expect(text).toContain('- `up = "vscode:dev-frontend-backend"`: the default build task');
    expect(text).toContain("- Stop containers: `docker compose stop`");
    expect(proposalText({ stack: {}, tasks: [], why: [] }, { stack: {}, dropped: [] })).toMatch(/found nothing/);
  });
});
