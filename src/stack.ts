// A dev stack: the panes one dev task brought up plus the Compose containers of its repo, and
// the one state that sums them. Pure; ./serversui polls and paints. Ready and failed are read
// off facts Episko already has (exit codes, listening ports, Docker health), so a stack needs
// no config to be watched; `[stack]` only names what cannot be inferred (docs/stack.md).

import { usefulPort } from "./servers";

/** One row of `compose_containers` (stack.rs). */
export interface Container {
  id: string; name: string; state: string; status: string; ports: string;
  project: string; service: string; workingDir: string;
  pages?: string[]; // Traefik's Host(...) rules, as URLs
}
export interface StackCfg { up?: string | null; down?: string | null; compose?: string[]; pages?: Record<string, string> }

/** Where a path lives: the checkout holding it and the repo that checkout belongs to. */
export interface Checkout { repo: string; path: string; name: string }

/** A task pane as the stack reads it; ./serversui flattens `Sess.run` into this. */
export interface PaneIn {
  sid: string; root: string; project: string; taskId: string; label: string;
  background: boolean; exit: number | null; url?: string; startedAt: number;
  groupId?: string; groupLabel?: string; groupRoot?: string;
  pages?: { label: string; url: string }[];
  kind?: string; readyAt?: number; describedPages?: Record<string, string>; stops?: string;
}

/** One address worth opening, and who said so: `[stack]`, a pane's own banner, or a proxy rule. */
export interface StackPage { name: string; url: string; from: "declared" | "described" | "pane" | "proxy" }

export type Health = "healthy" | "unhealthy" | "starting" | "none";
export type CState = "up" | "starting" | "failing" | "done" | "stopped";
export type MState = "running" | "serving" | "done" | "failed";
export type StackState = "starting" | "ready" | "failed" | "leftover";

export interface Member { sid: string; label: string; background: boolean; state: MState; url?: string; ports: number[]; exit: number | null }
export interface Box {
  c: Container; state: CState; health: Health; hostPorts: number[];
  from: string; // the checkout it was started from when that is not the stack's own, else ""
}
export interface Stack {
  key: string; project: string; checkout: string; label: string;
  members: Member[]; boxes: Box[]; composeProjects: string[];
  pages: StackPage[];
  stops?: string; // what the stack's own tasks say stops them, when [stack] down does not
  state: StackState; why: string; startedAt: number;
}

// ---------- reading a container ----------

export function containerHealth(status: string): Health {
  if (/\(healthy\)/i.test(status)) return "healthy";
  if (/\(unhealthy\)/i.test(status)) return "unhealthy";
  if (/\(health: starting\)/i.test(status)) return "starting";
  return "none";
}

export function exitOf(status: string): number | null {
  const m = /^Exited \((-?\d+)\)/i.exec(status.trim());
  return m ? Number(m[1]) : null;
}

// Docker's HumanDuration ("Less than a second", "About a minute", "3 weeks"), approximately.
const UNIT_MS: Record<string, number> = {
  second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6,
};
export function agoMs(status: string): number | null {
  const m = /(less than a second|about an? (\w+)|(\d+) (\w+?)s?) ago\s*$/i.exec(status.trim());
  if (!m) return null;
  if (/^less/i.test(m[1])) return 0;
  const unit = (m[2] ?? m[4]).toLowerCase().replace(/s$/, "");
  const n = m[3] ? Number(m[3]) : 1;
  return UNIT_MS[unit] != null ? n * UNIT_MS[unit] : null;
}

/** Host ports a container publishes: `127.0.0.1:5432->5432/tcp, [::]:8080->8080/tcp` → [5432, 8080]. */
export function hostPorts(ports: string): number[] {
  const out = new Set<number>();
  for (const m of ports.matchAll(/:(\d{1,5})(?:-\d+)?->/g)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

// An exited container is a failure only if it died during this stack's life: an `Exited (1)`
// from three weeks ago would otherwise paint every later run red. Unknown age counts as old.
export function containerState(c: Container, since: number, now: number): CState {
  const s = c.state.toLowerCase();
  if (s === "restarting" || s === "dead") return "failing"; // `restart: unless-stopped` over a crash
  if (s === "running") {
    const h = containerHealth(c.status);
    return h === "unhealthy" ? "failing" : h === "starting" ? "starting" : "up";
  }
  if (s === "exited") {
    const ago = agoMs(c.status);
    const recent = ago != null && now - ago >= since - 60_000; // the minute covers Docker's rounding
    const code = exitOf(c.status);
    if (recent && code != null && code !== 0) return "failing";
    return recent ? "done" : "stopped"; // a migration or init container that ran and left is done
  }
  return "stopped"; // created, paused
}

// ---------- whose is it ----------

const trim = (p: string) => p.replace(/[\\/]+$/, "");
const under = (p: string, root: string) => {
  const a = trim(p), r = trim(root);
  return !!r && (a === r || a.startsWith(r + "/") || a.startsWith(r + "\\"));
};

/** The checkout holding `dir`: the longest root that contains it, so a worktree inside the repo wins. */
export function checkoutOf(dir: string, checkouts: readonly Checkout[]): Checkout | undefined {
  let best: Checkout | undefined;
  for (const c of checkouts) if (under(dir, c.path) && (!best || c.path.length > best.path.length)) best = c;
  return best;
}

// ---------- the stack ----------

export interface StackInput {
  panes: readonly PaneIn[];
  ports: ReadonlyMap<string, readonly number[]>; // pane id → ports its process tree listens on
  containers: readonly Container[];
  checkouts: readonly Checkout[];
  configs: ReadonlyMap<string, StackCfg>; // checkout path → its [stack] table
  now: number;
}

function memberOf(p: PaneIn, ports: readonly number[]): Member {
  const useful = ports.filter(usefulPort);
  const state: MState = p.exit != null
    ? (p.exit === 0 && !p.background ? "done" : "failed") // a server that exits, even 0, is down
    // An app is a window, not a port: up once it runs, unless its description names a ready line.
    : (p.background || useful.length) && (p.url || useful.length || p.readyAt || (p.kind === "app" && !p.describedPages)) ? "serving" : "running";
  return { sid: p.sid, label: p.label, background: p.background, state, url: p.url, ports: useful, exit: p.exit };
}

// A group (or a lone pane) is a stack when it holds a server, when `[stack] up` names it, or when
// a live pane in it is listening on a port: evidence beats classification, so an undescribed
// `just app` that serves 127.0.0.1:38418 is a stack whatever its name made tasks.rs guess.
function isStack(group: readonly PaneIn[], cfg: StackCfg | undefined, ports: StackInput["ports"]): boolean {
  if (group.some((p) => p.background)) return true;
  if (group.some((p) => p.exit == null && (ports.get(p.sid) ?? []).some(usefulPort))) return true;
  const up = cfg?.up;
  return !!up && group.some((p) => p.taskId === up || p.groupRoot === up);
}

const boxOrder = (a: Box, b: Box) => a.c.service.localeCompare(b.c.service);

// Generic banner words name nothing; the address is the better name then (./servers' pageName).
const GENERIC = new Set(["local", "ready", "running", "listening", "serving", "server", "started", "available", "network", "url", "at", "on", "open"]);
const bare = (u: string) => u.replace(/^https?:\/\//, "");

// Declared first (the team wrote them down on purpose), then what panes announced, then proxy
// routes; one row per URL, so a page both declared and announced keeps its declared name.
function stackPages(cfg: StackCfg | undefined, group: readonly PaneIn[], boxes: readonly Box[]): StackPage[] {
  const out: StackPage[] = [];
  const add = (name: string, url: string, from: StackPage["from"]) => {
    if (/^https?:\/\//i.test(url) && !out.some((p) => p.url.replace(/\/$/, "") === url.replace(/\/$/, ""))) out.push({ name, url, from });
  };
  for (const [name, url] of Object.entries(cfg?.pages ?? {})) add(name, url, "declared");
  for (const p of group) if (p.exit == null) for (const [name, url] of Object.entries(p.describedPages ?? {})) add(name, url, "described");
  for (const p of group) {
    if (p.exit != null) continue;
    for (const pg of p.pages ?? []) add(pg.label && !GENERIC.has(pg.label.toLowerCase()) ? pg.label : bare(pg.url), pg.url, "pane");
  }
  for (const b of boxes) if (b.state === "up" || b.state === "starting") for (const u of b.c.pages ?? []) add(`${b.c.service} · ${bare(u)}`, u, "proxy");
  return out;
}

function sumUp(members: Member[], boxes: Box[]): { state: StackState; why: string } {
  const bad = members.find((m) => m.state === "failed");
  if (bad) return { state: "failed", why: bad.exit != null && bad.exit !== 0 ? `${bad.label} exited ${bad.exit}` : `${bad.label} stopped` };
  const sick = boxes.find((b) => b.state === "failing");
  if (sick) return { state: "failed", why: `${sick.c.service} ${sick.c.state === "restarting" ? "is restarting" : sick.health === "unhealthy" ? "is unhealthy" : `exited ${exitOf(sick.c.status) ?? ""}`.trim()}` };
  const prep = members.find((m) => m.state === "running" && !m.background);
  if (prep) return { state: "starting", why: `${prep.label} running` };
  const quiet = members.find((m) => m.state === "running");
  if (quiet) return { state: "starting", why: `waiting for ${quiet.label} to listen` };
  const warm = boxes.find((b) => b.state === "starting");
  if (warm) return { state: "starting", why: `${warm.c.service} health check starting` };
  return { state: "ready", why: "" };
}

/**
 * Every stack worth a block: one per dev-task launch with a pane still up or failed, and one per
 * repo whose containers outlived every pane (`leftover`). Containers attach by repo, not checkout,
 * because Compose projects are per machine: a worktree's run shares the main checkout's database.
 */
export function buildStacks(inp: StackInput): Stack[] {
  const groups = new Map<string, PaneIn[]>();
  for (const p of inp.panes) {
    const k = p.groupId ?? p.sid;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const repoOf = (dir: string) => checkoutOf(dir, inp.checkouts)?.repo ?? trim(dir);
  const claimed = new Set<string>();
  const stacks: Stack[] = [];

  for (const [key, group] of groups) {
    const root = group[0].root;
    const cfg = inp.configs.get(root);
    if (!isStack(group, cfg, inp.ports)) continue;
    const members = group
      .slice().sort((a, b) => a.startedAt - b.startedAt)
      .map((p) => memberOf(p, inp.ports.get(p.sid) ?? []));
    if (members.every((m) => m.state === "done")) continue; // it ran and finished: not a stack any more
    const startedAt = Math.min(...group.map((p) => p.startedAt));
    const repo = repoOf(root);
    const named = new Set(cfg?.compose ?? []);
    const boxes = inp.containers
      .filter((c) => named.has(c.project) || repoOf(c.workingDir) === repo)
      .map((c): Box => {
        claimed.add(c.id);
        const at = checkoutOf(c.workingDir, inp.checkouts);
        return {
          c, state: containerState(c, startedAt, inp.now), health: containerHealth(c.status), hostPorts: hostPorts(c.ports),
          from: at && trim(at.path) !== trim(root) ? at.name : "",
        };
      })
      .filter((b) => b.state !== "stopped")
      .sort(boxOrder);
    stacks.push({
      key, project: group[0].project, checkout: root,
      label: group[0].groupLabel ?? (members.length === 1 ? members[0].label : group[0].label),
      members, boxes, composeProjects: [...new Set(boxes.map((b) => b.c.project))],
      pages: stackPages(cfg, group, boxes),
      stops: cfg?.down ?? group.find((p) => p.stops)?.stops,
      ...sumUp(members, boxes), startedAt,
    });
  }

  // Containers nobody's pane accounts for, by repo; a repo Episko does not know is not ours to list.
  const left = new Map<string, Box[]>();
  for (const c of inp.containers) {
    if (claimed.has(c.id)) continue;
    const at = checkoutOf(c.workingDir, inp.checkouts);
    if (!at) continue;
    const state = containerState(c, Infinity, inp.now);
    if (state !== "up" && state !== "starting" && state !== "failing") continue; // only what is still running
    // Only a worktree is worth naming; the repo's own checkout is where a container is expected to come from.
    const from = trim(at.path) === trim(at.repo) ? "" : at.name;
    left.set(at.repo, [...(left.get(at.repo) ?? []), { c, state, health: containerHealth(c.status), hostPorts: hostPorts(c.ports), from }]);
  }
  for (const [repo, boxes] of left) {
    const home = inp.checkouts.find((c) => trim(c.path) === trim(repo)) ?? checkoutOf(boxes[0].c.workingDir, inp.checkouts)!;
    boxes.sort(boxOrder);
    stacks.push({
      key: `left:${repo}`, project: home.name, checkout: home.path, label: "",
      members: [], boxes, composeProjects: [...new Set(boxes.map((b) => b.c.project))],
      pages: stackPages(undefined, [], boxes),
      state: "leftover", why: `${boxes.length} container${boxes.length === 1 ? "" : "s"} up · no dev task running`,
      startedAt: 0,
    });
  }
  return stacks;
}

/** What a stack adds to the header pill: everything serving, and whether any of it is failing. */
export function stackTally(stacks: readonly Stack[]): { serving: number; failed: boolean } {
  let serving = 0, failed = false;
  for (const s of stacks) {
    serving += s.members.filter((m) => m.state === "serving").length;
    serving += s.boxes.filter((b) => b.state === "up").length;
    if (s.state === "failed") failed = true;
  }
  return { serving, failed };
}

// ---------- the [stack] table ----------

/** One line for the project settings row; empty when there is no table. */
export function stackSummary(cfg: StackCfg): string {
  return [
    cfg.up && `starts with ${cfg.up}`, cfg.down && `stops with ${cfg.down}`,
    cfg.compose?.length && `compose ${cfg.compose.join(", ")}`,
    Object.keys(cfg.pages ?? {}).length && `pages ${Object.keys(cfg.pages ?? {}).join(", ")}`,
  ].filter(Boolean).join(" · ");
}

// tasks.rs's `slugify`, so a proposed task's id is the one discovery will give it.
export function taskSlug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** What `propose_stack` hands back: the table, the tasks it adds, one reason per value. */
export interface StackProposal {
  stack: StackCfg; tasks: { label: string; run: string }[]; why: string[];
  run?: Record<string, { kind: string; pages?: Record<string, string>; ready?: string | null; stops?: string | null; brings_up?: string[]; note?: string | null; hash?: string }>;
}
export interface TaskRef { id: string; cmd: string; background: boolean }

/** Values pointing at no task this project has (or will have) are dropped, and said so. */
export function checkProposal(p: StackProposal, tasks: readonly TaskRef[]): { stack: StackCfg; dropped: string[] } {
  const known = new Set([...tasks.map((t) => t.id), ...p.tasks.map((t) => `episko:${taskSlug(t.label)}`)]);
  const stack: StackCfg = { ...p.stack };
  const dropped: string[] = [];
  for (const k of ["up", "down"] as const) {
    const v = stack[k];
    if (v && !known.has(v)) { dropped.push(`${k} = "${v}" names no task in this project`); stack[k] = undefined; }
  }
  const pages = Object.entries(stack.pages ?? {}).filter(([n, u]) => {
    const ok = /^https?:\/\/\S+$/i.test(u);
    if (!ok) dropped.push(`page ${n} = "${u}" is not an http(s) address`);
    return ok;
  });
  stack.pages = Object.fromEntries(pages);
  return { stack, dropped };
}

const why = (p: StackProposal, key: string) => p.why.find((w) => w.toLowerCase().startsWith(key + ":"))?.slice(key.length + 1).trim();

/** The review dialog's text, in ./format's `dialogBody` dialect: blank lines, bullets, backticks. */
export function proposalText(p: StackProposal, checked: { stack: StackCfg; dropped: string[] }): string {
  const lines: string[] = [];
  const s = checked.stack;
  for (const k of ["up", "down"] as const) {
    if (s[k]) lines.push(`- \`${k} = "${s[k]}"\`${why(p, k) ? `: ${why(p, k)}` : ""}`);
  }
  for (const [n, u] of Object.entries(s.pages ?? {})) lines.push(`- page ${n}: \`${u}\``);
  if (Object.keys(s.pages ?? {}).length && why(p, "pages")) lines.push(`  ${why(p, "pages")}`);
  if (s.compose?.length) lines.push(`- \`compose = [${s.compose.map((c) => `"${c}"`).join(", ")}]\`${why(p, "compose") ? `: ${why(p, "compose")}` : ""}`);
  const out = [lines.length ? `For \`.episko/episko.toml\`:\n\n${lines.join("\n")}` : "Claude found nothing it could support for `[stack]`."];
  if (p.tasks.length) {
    out.push(`New in \`.episko/tasks.toml\`:\n\n${p.tasks.map((t) => `- ${t.label}: \`${t.run}\``).join("\n")}${why(p, "task") ? `\n\n${why(p, "task")}` : ""}`);
  }
  if (checked.dropped.length) out.push(`Left out:\n\n${checked.dropped.map((d) => `- ${d}`).join("\n")}`);
  out.push("Nothing is committed. Review it in git like any other change.");
  return out.join("\n\n");
}
