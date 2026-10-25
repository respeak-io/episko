// The header's running-server pill, its popover and the poll behind it. The rules (what
// counts as a server, what a log says) are ./servers'; this half is DOM and IPC, untested.
// Which sources are listed, and how each is stopped, is in CLAUDE.md's app-wide rules.

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "./confirm";
import { $, FILE_MANAGER, toast } from "./dom";
import { basename, esc, escAttr, fmtMb } from "./format";
import { FAVORITES, sessions, activeId, worktreesByRepo } from "./state";
import {
  applyBgLog, applyBgMiss, bgKind, bgLogPath, bgOutcome, bgPeekEmpty, bgRetire, cmdLabel,
  failedServers, forgetServer, leftKey, leftLead, leftMem, leftShown, liveServers, markKilled, portOf,
  procLabel, reconcilePorts, servingUrls, shownServers, usefulPort, type BgRead, type LeftBehind, type SessionPort,
} from "./servers";
import { isClaude, type BgServer, type Sess } from "./types";
import { buildStacks, stackTally, type Checkout, type Container, type PaneIn, type Stack, type StackCfg } from "./stack";
import { stackHtml } from "./stackview";
import { discoverTasks, launchWithDeps } from "./tasks";

// A row: "bg" is a shell an agent backgrounded (the record is all there is), "task" a
// runnable Episko launched (the pane is the server), "port" a socket nothing announced. A
// port row's pane may be closed already (`orphan`), so it carries its own id and project.
// "left" is a process tree still running after its pane closed or its parent died; `sid`
// is null for one found by its folder, which no pane of this run ever held.
type Row =
  | { kind: "bg"; s: Sess; at: number; b: BgServer }
  | { kind: "task"; s: Sess; at: number }
  | { kind: "port"; sid: string; project: string; at: number; port: number; name: string; pid: number; orphan: boolean }
  | { kind: "left"; sid: string | null; project: string; at: number; g: LeftBehind };

interface LoosePort { port: number; name: string; pid: number; orphan: boolean; at: number }

// Ports under each pane that no record explains, keyed by session id. Filled by the poll,
// never by a render pass: `reconcilePorts` mutates.
let loosePorts = new Map<string, LoosePort[]>();

// First-seen stamps keyed `<session>:<port>`: a socket has no age of its own, and rows sort by age.
const portSeen = new Map<string, number>();

// Every listener the last poll saw, `<session>:<port>` → pid, loose or claimed: what a
// server row's kill needs once its agent can no longer be asked.
let portPids = new Map<string, number>();

// Pane id → project, kept past the pane: an orphan's row still has to say whose it was.
const paneProject = new Map<string, string>();

// What the last `left_behind` found, past the grace, and when each tree was first seen.
let leftTrees: LeftBehind[] = [];
const leftSeen = new Map<string, number>();

const sidOf = (r: Row) => r.kind === "port" ? r.sid : r.kind === "left" ? r.sid ?? "" : r.s.id;
const projectOf = (r: Row) => r.kind === "port" || r.kind === "left" ? r.project : r.s.project;

function taskRows(): Row[] {
  const out: Row[] = [];
  for (const s of sessions.values()) {
    const r = s.run;
    if (s.kind !== "task" || !r || r.exitCode != null || !r.url) continue;
    out.push({ kind: "task", s, at: r.startedAt });
  }
  return out;
}

function rows(): Row[] {
  const inStack = stackPanes();
  return allRows().filter((r) => r.kind === "bg" || !inStack.has(sidOf(r))); // a stack lists its own panes
}

function allRows(): Row[] {
  const out: Row[] = [];
  for (const s of sessions.values()) {
    for (const b of shownServers(s.servers)) out.push({ kind: "bg", s, at: b.startedAt, b });
  }
  for (const [sid, list] of loosePorts) {
    const project = sessions.get(sid)?.project ?? paneProject.get(sid) ?? "closed pane";
    for (const p of list) out.push({ kind: "port", sid, project, ...p });
  }
  for (const g of leftTrees) {
    const project = (g.sessionId && (sessions.get(g.sessionId)?.project ?? paneProject.get(g.sessionId)))
      || (g.root ? basename(g.root) : "unknown project");
    out.push({ kind: "left", sid: g.sessionId, project, at: leftSeen.get(leftKey(g)) ?? Date.now(), g });
  }
  out.push(...taskRows());
  return out.sort((a, b) => a.at - b.at); // oldest first: the forgotten server must not scroll off
}

// What the poll re-reads: live agent-backgrounded shells only. A task's output is on the
// PTY stream, and a dead log has nothing left to say (CLAUDE.md: liveServers vs shownServers).
function livePolled(): BgServer[] {
  const out: BgServer[] = [];
  for (const s of sessions.values()) out.push(...liveServers(s.servers));
  return out;
}

// ---------- the pill ----------

let lastPop = "";

// A task or loose port is always a server; an agent's shell splits on its URL alone (`bgKind`).
// Never guess from `dev`/`serve` in the command: that fires on `npm ci`, `pytest`, `gh run watch`.
// A left-behind tree has its own heading: it holds no port, or it would be a port row.
const isServerRow = (r: Row) => r.kind === "left" ? false : r.kind !== "bg" || bgKind(r.b) === "server";

// Hidden when nothing is running, so a forgotten server is what catches the eye.
export function renderServers() {
  const shown = rows();
  const stacks = currentStacks();
  const tally = stackTally(stacks);
  const el = $("svrBadge");
  // Keyed on every row, not the server count: hiding the pill would force the popover shut over the jobs.
  if (!shown.length && !stacks.length) { el.className = "svr-badge"; closeServersPop(); return; }
  let serving = 0, failed = 0;
  for (const s2 of sessions.values()) {
    serving += servingUrls(s2.servers).length;
    failed += failedServers(s2.servers).length;
  }
  serving += shown.filter((r) => r.kind === "task" || r.kind === "port").length; // serving by definition
  serving += tally.serving;
  if (tally.failed) failed++;
  const servers = shown.filter(isServerRow).length + tally.serving;
  const jobs = shown.length - servers;
  el.className = "svr-badge show";
  // The number is the server count; with none up it shows the jobs instead of a bare 0,
  // and `jobs-only` keeps that from reading as "4 servers".
  $("svrBadgeTxt").textContent = String(servers || jobs);
  el.classList.toggle("jobs-only", servers === 0);
  // One line per row, jobs prefixed, so the hover list and the number agree.
  el.title = [
    ...stacks.map((st) => `stack · ${st.project}${st.label ? ` · ${st.label}` : ""}: ${st.why || st.state}`),
    ...shown.map((r) => `${isServerRow(r) ? "" : r.kind === "left" ? "left behind · " : "job · "}${projectOf(r)} ·${rowTitle(r)}`),
  ].join("\n");
  el.classList.toggle("serving", serving > 0 && !failed); // failure wins the colour
  el.classList.toggle("failed", failed > 0);
  if ($("svrPop").classList.contains("show")) renderServersPop();
}

// ---------- the popover ----------

let openRow = ""; // the expanded row, by key rather than index so a finishing server cannot shift the peek

function rowTitle(r: Row): string {
  if (r.kind === "task") return `${r.s.run?.url} (${r.s.run?.label ?? "task"})`;
  if (r.kind === "port") return `localhost:${r.port} (${r.name || "listening"})`;
  if (r.kind === "left") return ` ${procLabel(leftLead(r.g))} (${fmtMb(leftMem(r.g) / 1048576)})`;
  return r.b.ended ? bgOutcome(r.b) : (r.b.url || cmdLabel(r.b.cmd));
}

function rowKey(r: Row): string {
  if (r.kind === "task") return `t:${r.s.id}`;
  if (r.kind === "port") return `p:${r.sid}:${r.port}`;
  if (r.kind === "left") return `l:${leftKey(r.g)}`;
  return `b:${r.b.taskId}`;
}

// The per-source facts a row draws, resolved once. An agent's row shows the command; a
// task's shows the name you picked, marked with the app's own ▶ Run glyph.
function rowFacts(r: Row): { url: string; dead: boolean; outcome: string; tail?: string[]; label: string; x: string; go: string; note?: string } {
  if (r.kind === "left") {
    const g = r.g, n = g.procs.length;
    const why = g.sessionId
      ? sessions.has(g.sessionId)
        ? "Started under this pane, and still running after the process that started it died"
        : "Still running after the pane that started it closed"
      : `No pane of this Episko run started it; it runs in ${g.root}`;
    return {
      url: "", dead: false, outcome: "",
      tail: g.procs.map((p) => `${String(p.pid).padStart(6)}  ${fmtMb(p.mem / 1048576).padStart(9)}  ${p.cmd.join(" ") || p.name}`),
      label: `<span class="sv-src sv-obs" title="${escAttr(why)}">⊘</span>${esc(procLabel(leftLead(g)))}${n > 1 ? ` <span class="sv-orphan">+${n - 1}</span>` : ""}`,
      x: `<button class="sv-stop sv-kill" data-svleft="${leftKey(g)}" title="Kill pid ${g.pid} and the ${n === 1 ? "process" : `${n} processes`} in its tree">✕</button>`,
      go: "Go to the pane that started this",
      note: fmtMb(leftMem(g) / 1048576),
    };
  }
  if (r.kind === "port") {
    // A socket the kernel says is open under this pane; the process holding it is all we know.
    const seen = r.orphan
      ? "Still listening after the pane that started it closed"
      : "Seen listening under this pane — nothing announced it";
    return {
      url: `http://localhost:${r.port}`, dead: false, outcome: "", tail: undefined,
      label: `<span class="sv-src sv-obs" title="${seen}">◎</span>${esc(r.name || "port " + r.port)}${r.orphan ? ` <span class="sv-orphan">orphaned</span>` : ""}`,
      x: killBtn(r.sid, r.pid, r.port, r.name),
      go: "Go to the pane this is running under",
    };
  }
  if (r.kind === "task") {
    const t = r.s.run!;
    return {
      url: t.url ?? "", dead: false, outcome: "", tail: t.tail,
      label: `<span class="sv-src" title="Started by Episko · ${escAttr(t.cmd)}">▶</span>${esc(t.label)}`,
      x: `<button class="sv-stop" data-svkill="${r.s.id}" title="Stop this task">✕</button>`,
      go: "Go to this task's pane",
    };
  }
  const b = r.b;
  const dead = !!b.ended;
  return {
    url: b.url ?? "", dead, outcome: bgOutcome(b), tail: b.tail,
    label: esc(cmdLabel(b.cmd)),
    // A dead row is cleared, a live one asked while its agent can hear and killed by its port
    // once it cannot; separate attributes so the three cannot be confused.
    x: dead
      ? `<button class="sv-stop" data-svforget="${b.taskId}" data-svsid="${r.s.id}" title="Clear this row (stops nothing: it has already ended)">✕</button>`
      : bgKiller(r.s, b) ?? `<button class="sv-stop" data-svstop="${b.taskId}" data-svsid="${r.s.id}" title="Ask this session's agent to stop it (TaskStop)">✕</button>`,
    go: "Go to the session that started this",
  };
}

// The kill ✕: pid and port travel as one value, since both must still match at the kernel.
function killBtn(sid: string, pid: number, port: number, name: string): string {
  return `<button class="sv-stop sv-kill" data-svport="${pid}:${port}" data-svsid="${sid}" title="Kill ${escAttr(name || "the process")} (pid ${pid}) and free port ${port}">✕</button>`;
}

// While its agent can be asked, a server is asked (it holds TaskStop and believes the server
// is up); once it cannot, the kernel's pid for its port is the only handle left.
function bgKiller(s: Sess, b: BgServer): string | null {
  if (canAsk(s) || !b.url) return null;
  const port = portOf(b.url);
  const pid = portPids.get(`${s.id}:${port}`);
  return pid ? killBtn(s.id, pid, port, cmdLabel(b.cmd, 30)) : null;
}

const canAsk = (s: Sess) => isClaude(s) && s.phase !== "ended";

function rowHtml(r: Row, open: boolean): string {
  const sid = sidOf(r);
  const { url, dead, outcome, tail, label, x, go, note } = rowFacts(r);
  // An empty peek says which silence this is: `bgPeekEmpty` carries the backend's reason.
  // A task or a port has no log file, so those keep the literal.
  const peek = open && tail?.length
    ? `<pre class="sv-log">${esc(tail.join("\n"))}</pre>`
    : open
      ? `<pre class="sv-log sv-log-empty">${esc(r.kind === "bg" ? bgPeekEmpty(r.b) : "no output yet")}</pre>`
      : "";
  // `bgLogPath` falls back to the first candidate tried, so a row that resolved nothing still
  // says where to look. Both are children of `.sv-row`, never of `.sv-head`: the head is
  // itself a <button>, and a button nested in a button is invalid markup.
  const p = r.kind === "bg" ? bgLogPath(r.b) : "";
  const logs = p
    ? `<button class="sv-path" data-svreveal="${escAttr(p)}" title="Reveal in ${FILE_MANAGER}">⌂</button>`
      + `<button class="sv-path" data-svcopy="${escAttr(p)}" title="Copy the log path">⧉</button>`
    // Empty cells rather than missing ones: the row is a grid.
    : `<span class="sv-path sv-none"></span><span class="sv-path sv-none"></span>`;
  // A dead row shows its outcome as plain text: a chip that opens a dead tab is worse than none.
  const mid = dead
    ? `<span class="sv-url sv-dead">${esc(outcome)}</span>`
    : note
      ? `<span class="sv-url sv-pending" title="Memory held by the whole tree">${esc(note)}</span>`
    : url
      ? `<button class="sv-url" data-svopen="${escAttr(url)}" title="Open ${escAttr(url)}">${esc(url.replace(/^https?:\/\//, ""))}</button>`
      : `<span class="sv-url sv-pending">starting…</span>`;
  return `<div class="sv-row${open ? " open" : ""}${dead ? " dead" : ""}">
    <button class="sv-head" data-svtoggle="${escAttr(rowKey(r))}" title="Show the last lines of this output">
      <span class="sv-dot${dead ? " down" : url ? " up" : ""}"></span>
      <span class="sv-main">
        <span class="sv-proj">${esc(projectOf(r))}</span>
        <span class="sv-cmd">${label}</span>
      </span>
    </button>
    ${mid}
    ${logs}
    ${sid && sessions.has(sid) ? `<button class="sv-go" data-svgo="${sid}" title="${go}">◨</button>` : `<span class="sv-go sv-none"></span>`}
    ${x}
    ${peek}
  </div>`;
}

function renderServersPop() {
  const shown = rows();
  const stacks = currentStacks();
  const pop = $("svrPop");
  // Partitioned here so `rows()` stays the single ordering, and it holds within each section.
  const servers = shown.filter(isServerRow);
  const jobs = shown.filter((r) => !isServerRow(r) && r.kind !== "left");
  const left = shown.filter((r) => r.kind === "left");
  // The servers heading stands at zero: "Running servers 0" over a list of jobs answers the pill.
  const stackPart = stacks.length
    ? `<div class="sv-h">Stacks<span class="sv-hn">${stacks.length}</span></div>`
      + stacks.map((st) => stackHtml(st, downLabel(st))).join("")
    : "";
  const html = stackPart + (shown.length
    ? `<div class="sv-h${stackPart ? " sv-h2" : ""}">Running servers<span class="sv-hn">${servers.length}</span></div>`
      + servers.map((r) => rowHtml(r, rowKey(r) === openRow)).join("")
      + (jobs.length
        ? `<div class="sv-h sv-h2">Background jobs<span class="sv-hn">${jobs.length}</span></div>`
          + jobs.map((r) => rowHtml(r, rowKey(r) === openRow)).join("")
        : "")
      + (left.length
        ? `<div class="sv-h sv-h2">Left behind<span class="sv-hn">${left.length}</span></div>`
          + left.map((r) => rowHtml(r, rowKey(r) === openRow)).join("")
        : "")
      + `<div class="sv-foot">A stack is a dev task's panes plus the Compose containers of its repo; ⏹ stops the containers. ▶ is a task Episko ran and can stop. ◎ is a port the kernel says a pane's process is listening on, and ✕ kills that process. The rest were backgrounded by an agent: ✕ asks that session to run <code>TaskStop</code>, or kills the process once the session can no longer be asked. A background job is one that has announced no address — a build, a test run, or anything Claude backgrounded itself after it ran past its own 120-second timeout. ⊘ is left behind: still running after its pane closed or the process that started it died, as a watcher does on Windows; ✕ kills it and everything it started.</div>`
    : "");
  // innerHTML guard: an assignment between mousedown and mouseup drops the click (docs/architecture.md).
  if (html === lastPop) return;
  lastPop = html;
  // An innerHTML write resets scrollTop; keep the reader's place across the poll's repaints.
  const at = pop.scrollTop;
  pop.innerHTML = html;
  pop.scrollTop = at;
}

export function openServersPop() {
  const r = $("svrBadge").getBoundingClientRect();
  const pop = $("svrPop");
  closeOtherMenus();
  lastPop = ""; // a fresh open always paints, even onto identical markup
  renderServersPop();
  pop.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  pop.style.left = "auto";
  pop.style.top = (r.bottom + 6) + "px";
  pop.classList.add("show");
}
export function closeServersPop() { $("svrPop").classList.remove("show"); openRow = ""; }

// Settable hooks rather than imports: ./footer and ./panes sit above this module
// (CLAUDE.md's seam rule 2). main.ts wires them.
let closeOtherMenus: () => void = () => {};
export function setServersCloseMenus(f: () => void) { closeOtherMenus = f; }

let repaint: () => void = () => {};
export function setServersRepaint(f: () => void) { repaint = f; }

let closePane: (id: string) => void = () => {};
export function setServersCloseSession(f: (id: string) => void) { closePane = f; }

// ---------- stacks ----------

// The last `compose_containers` answer. Docker is optional: without it a stack is its panes alone.
let containers: Container[] = [];
let dockerAt = 0, dockerOk = true;
// Ports per pane from the last `session_ports`, every one of them: a stack member's are its own.
let portsBySid = new Map<string, number[]>();
// Checkout → its `[stack]` table, re-read on a slow clock: the file is hand-edited, not watched.
const configs = new Map<string, { cfg: StackCfg; at: number }>();
const CONFIG_MS = 30_000;

// Every checkout Episko knows, so a container's `working_dir` can be traced to a repo.
function checkouts(): Checkout[] {
  const out = new Map<string, Checkout>();
  const add = (repo: string, path: string) => { if (path && !out.has(path)) out.set(path, { repo, path, name: basename(path) }); };
  for (const [repo, heads] of worktreesByRepo) { add(repo, repo); for (const h of heads) add(repo, h.path); }
  for (const f of FAVORITES) add(f.path, f.path);
  for (const s2 of sessions.values()) { add(s2.colorKey, s2.colorKey); add(s2.colorKey, s2.workdir); }
  return [...out.values()];
}

function stackInput(): PaneIn[] {
  const out: PaneIn[] = [];
  for (const s2 of sessions.values()) {
    const r = s2.run;
    if (s2.kind !== "task" || !r) continue;
    out.push({
      sid: s2.id, root: r.root, project: s2.project, taskId: r.id, label: r.label, background: r.background,
      exit: r.exitCode, url: r.url, startedAt: r.startedAt, groupId: r.groupId, groupLabel: r.groupLabel, groupRoot: r.groupRoot,
      pages: r.pages, kind: r.kind, readyAt: r.readyAt, describedPages: r.describedPages, stops: r.stops,
    });
  }
  return out;
}

/** Useful ports a pane's process tree listens on, as of the last poll. */
export function portsOf(sid: string): number[] {
  return (portsBySid.get(sid) ?? []).filter(usefulPort);
}

export function currentStacks(): Stack[] {
  const cfg = new Map([...configs].map(([k, v]) => [k, v.cfg]));
  return buildStacks({ panes: stackInput(), ports: portsBySid, containers, checkouts: checkouts(), configs: cfg, now: Date.now() });
}

function stackPanes(): Set<string> {
  return new Set(currentStacks().flatMap((st) => st.members.map((m) => m.sid)));
}

// Every 4s while a dev task runs (health flips are the point), every 20s otherwise for
// leftovers, every 60s once docker has said no: a missing CLI must cost nothing.
async function refreshContainers(): Promise<boolean> {
  const now = Date.now();
  const live = stackInput().some((p) => p.exit == null);
  if (now - dockerAt < (!dockerOk ? 60_000 : live ? 0 : 20_000)) return false;
  dockerAt = now;
  for (const root of new Set(stackInput().map((p) => p.root))) {
    const had = configs.get(root);
    if (had && now - had.at < CONFIG_MS) continue;
    const cfg = await invoke<StackCfg>("stack_config", { dir: root }).catch(() => ({}) as StackCfg);
    configs.set(root, { cfg, at: now });
  }
  try {
    const got = await invoke<{ available: boolean; error: string; list: Container[] }>("compose_containers");
    dockerOk = got.available;
    const next = got.available ? got.list : [];
    const sig = (l: Container[]) => l.map((c) => `${c.id}${c.state}${c.status.replace(/\d+ \w+ ago|About an? \w+ ago/, "")}`).join("|");
    const moved = sig(next) !== sig(containers);
    containers = next;
    return moved;
  } catch {
    return false;
  }
}

/** A fresh reading for an agent asking now: ports and Docker re-read, not the last poll's. */
export async function refreshStacksNow(): Promise<Stack[]> {
  dockerAt = 0;
  await pollServers();
  return currentStacks();
}

function downLabel(st: Stack): string {
  const down = configs.get(st.checkout)?.cfg.down ?? st.stops;
  return down ? `Run ${down} to stop the containers` : `Stop the containers (docker compose -p ${st.composeProjects.join(", ")} stop)`;
}

// Closing a pane is what its own ✕ does; the containers stay, and the block becomes a leftover.
function closeStack(key: string) {
  const st = currentStacks().find((x) => x.key === key);
  if (!st) return;
  for (const m of st.members) closePane(m.sid);
  lastPop = "";
  toast(`Closed ${st.label}`);
}

// `[stack] down` is the project's own answer and runs as a task; without one, Compose's
// `stop`, which keeps containers and volumes. Shared by every checkout, hence the question.
async function stackDown(key: string) {
  const st = currentStacks().find((x) => x.key === key);
  if (!st) return;
  const down = configs.get(st.checkout)?.cfg.down ?? st.stops;
  if (down) {
    const repo = checkouts().find((c) => c.path === st.checkout)?.repo ?? st.checkout;
    const task = (await discoverTasks(st.checkout, repo, true)).find((r) => r.id === down);
    if (!task) { toast(`[stack] down names ${down}, which ${st.project} does not define`); return; }
    await launchWithDeps(task, st.project, { colorKey: repo, discoveredIn: st.checkout });
    return;
  }
  const ok = await ask(
    `Stop ${st.boxes.length} container${st.boxes.length === 1 ? "" : "s"} of ${st.composeProjects.join(", ")}?\n\nEvery checkout of this repo shares them. Nothing is removed: \`docker compose stop\` keeps the containers and their volumes.`,
    { title: "Stop the containers", kind: "warning", okLabel: "Stop", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  for (const project of st.composeProjects) {
    try { await invoke("compose_stop", { project }); } catch (err) { toast(String(err)); }
  }
  dockerAt = 0;
  lastPop = "";
  await pollServers();
  repaint();
}

// ---------- the poll ----------

// Ask the kernel which ports our panes hold and reconcile against what the panes said. This
// needs no hook, log or output format, so it is what lists a `pnpm dev` typed by hand.
async function refreshPorts(): Promise<boolean> {
  let seen: SessionPort[];
  try {
    seen = await invoke<SessionPort[]>("session_ports");
  } catch {
    return false; // keep the last answer rather than blanking the list on one bad poll
  }
  const now = Date.now();
  portsBySid = new Map();
  for (const p of seen) portsBySid.set(p.sessionId, [...(portsBySid.get(p.sessionId) ?? []), p.port]);
  const bySession = new Map<string, SessionPort[]>();
  for (const p of seen) {
    const list = bySession.get(p.sessionId) ?? [];
    list.push(p);
    bySession.set(p.sessionId, list);
    const k = `${p.sessionId}:${p.port}`;
    if (!portSeen.has(k)) portSeen.set(k, now);
  }
  // Prune closed ports, so one that comes back is honestly new.
  const alive = new Set(seen.map((p) => `${p.sessionId}:${p.port}`));
  for (const k of [...portSeen.keys()]) if (!alive.has(k)) portSeen.delete(k);

  portPids = new Map(seen.map((p) => [`${p.sessionId}:${p.port}`, p.pid]));
  for (const s of sessions.values()) paneProject.set(s.id, s.project);

  let changed = false;
  const next = new Map<string, LoosePort[]>();
  const addLoose = (sid: string, mine: SessionPort[], ports: number[]) => {
    if (!ports.length) return;
    next.set(sid, ports.map((port) => {
      const p = mine.find((x) => x.port === port)!;
      return { port, name: p.name, pid: p.pid, orphan: p.orphan, at: portSeen.get(`${sid}:${port}`) ?? now };
    }));
  };
  for (const s of sessions.values()) {
    const mine = bySession.get(s.id) ?? [];
    // Runs even with no ports: a closed port does not un-say what the server announced.
    const { loose, changed: adopted } = reconcilePorts(s.servers, s.run?.url, mine.map((p) => p.port));
    if (adopted) changed = true;
    addLoose(s.id, mine, loose);
  }
  // A pane closed outright has no records left to explain its ports: every useful one is loose.
  for (const [sid, mine] of bySession) {
    if (!sessions.has(sid)) addLoose(sid, mine, reconcilePorts([], undefined, mine.map((p) => p.port)).loose);
  }
  // A repaint is owed whenever the set of loose rows moved.
  const key = (m: Map<string, LoosePort[]>) =>
    [...m].map(([k, v]) => k + ":" + v.map((p) => p.port).join(",")).sort().join("|");
  if (key(next) !== key(loosePorts)) changed = true;
  loosePorts = next;
  return changed;
}

// Re-read every live log: the only thing that fills in a URL, a peek or an ended state, and
// a disk read per server, so slower than anything on the telemetry path.
// Process trees our panes left running (docs/stack.md). The folders are every checkout we
// know, so a stray from before this run is found by where it runs.
async function refreshLeft(): Promise<boolean> {
  let got: LeftBehind[];
  try {
    got = await invoke<LeftBehind[]>("left_behind", { roots: checkouts().map((c) => c.path) });
  } catch {
    return false;
  }
  const next = leftShown(got, leftSeen, Date.now());
  const sig = (l: LeftBehind[]) => l.map((g) => `${leftKey(g)}/${g.procs.length}`).join("|");
  const moved = sig(next) !== sig(leftTrees);
  leftTrees = next;
  return moved;
}

export async function pollServers() {
  let changed = await refreshPorts();
  if (await refreshLeft()) changed = true;
  if (await refreshContainers()) changed = true;
  const live = livePolled();
  if (!live.length) { if (changed) repaint(); return; }
  for (const b of live) {
    if (!b.transcript) continue; // no address to read; the row still draws
    try {
      // `knownLen` lets `read_bg_log` answer an unchanged log without opening it.
      const got = await invoke<BgRead & { missing: boolean }>(
        "read_bg_log", { transcript: b.transcript, taskId: b.taskId, knownLen: b.len ?? 0 },
      );
      // A miss is normal for a second after a shell starts. `applyBgMiss` keeps the backend's
      // reason and candidates for the peek; `bgRetire` ends only a record whose log never
      // appeared, since a `noRoot` or `ambiguous` miss is an outage on our side.
      if (got.missing) {
        if (applyBgMiss(b, got, Date.now())) changed = true;
        if (bgRetire(b, Date.now())) changed = true;
        continue;
      }
      if (applyBgLog(b, got, Date.now())) changed = true;
    } catch { /* the row survives a failed read; the next poll tries again */ }
  }
  if (changed) repaint();
}

// ---------- what a row can do ----------

$("svrBadge").addEventListener("click", (e) => {
  e.stopPropagation();
  $("svrPop").classList.contains("show") ? closeServersPop() : openServersPop();
});

$("svrPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  // Buttons first, expander last: the expander is the row's whole background (test/dispatch.test.ts).
  const url = t.closest<HTMLElement>("[data-svopen]");
  if (url) { e.stopPropagation(); void openUrl(url.dataset.svopen!).catch((err) => toast("open failed: " + err)); return; }
  const go = t.closest<HTMLElement>("[data-svgo]");
  if (go) { e.stopPropagation(); goToSession(go.dataset.svgo!); return; }
  const stop = t.closest<HTMLElement>("[data-svstop]");
  if (stop) { e.stopPropagation(); askStop(stop.dataset.svsid!, stop.dataset.svstop!); return; }
  const forget = t.closest<HTMLElement>("[data-svforget]");
  if (forget) { e.stopPropagation(); dismiss(forget.dataset.svsid!, forget.dataset.svforget!); return; }
  const port = t.closest<HTMLElement>("[data-svport]");
  if (port) { e.stopPropagation(); void killPort(port.dataset.svsid!, port.dataset.svport!); return; }
  const left = t.closest<HTMLElement>("[data-svleft]");
  if (left) { e.stopPropagation(); void killLeft(left.dataset.svleft!); return; }
  const kill = t.closest<HTMLElement>("[data-svkill]");
  if (kill) { e.stopPropagation(); stopTask(kill.dataset.svkill!); return; }
  const stk = t.closest<HTMLElement>("[data-svstack]");
  if (stk) { e.stopPropagation(); closeStack(stk.dataset.svstack!); return; }
  const down = t.closest<HTMLElement>("[data-svdown]");
  if (down) { e.stopPropagation(); void stackDown(down.dataset.svdown!); return; }
  // Neither closes the popover: you are still reading the row. A path that no longer
  // resolves surfaces the backend's error; a silent no-op reads as a dead button.
  const rev = t.closest<HTMLElement>("[data-svreveal]");
  if (rev) { e.stopPropagation(); void invoke("reveal_file", { path: rev.dataset.svreveal! }).catch((err) => toast(String(err))); return; }
  // Never navigator.clipboard (an OS permission prompt); a denied copy at least shows the path.
  const cp = t.closest<HTMLElement>("[data-svcopy]");
  if (cp) { e.stopPropagation(); void writeText(cp.dataset.svcopy!).then(() => toast("Path copied")).catch(() => toast(cp.dataset.svcopy!)); return; }
  const tog = t.closest<HTMLElement>("[data-svtoggle]");
  if (tog) {
    e.stopPropagation();
    openRow = openRow === tog.dataset.svtoggle ? "" : tog.dataset.svtoggle!;
    lastPop = ""; renderServersPop();
  }
});

let setActiveSession: (id: string) => void = () => {};
export function setServersSetActive(f: (id: string) => void) { setActiveSession = f; }

function goToSession(id: string) {
  if (!sessions.has(id)) { toast("That session is gone"); return; }
  setActiveSession(id);
  closeServersPop();
}

// Prefilled without a trailing newline: you read it and press Enter (the sendOutputToSession contract).
function askStop(sessionId: string, taskId: string) {
  const s = sessions.get(sessionId);
  if (!s) { toast("That session is gone — nothing here can stop it"); return; }
  if (!isClaude(s)) { toast("Only a Claude session can be asked to stop a task"); return; }
  if (s.phase === "ended") { toast("That session has ended — its agent can no longer be asked"); return; }
  const msg = `Stop the background task ${taskId} (use the TaskStop tool). Don't start it again.`;
  if (activeId !== sessionId) setActiveSession(sessionId);
  invoke("write_pty", { sessionId, data: msg })
    .then(() => { closeServersPop(); toast("Prefilled in the session. Press Enter to send"); })
    .catch((e) => toast("send failed: " + e));
}

// A real stop: the PTY is ours, and `closePane` is what the pane's own ✕ does. No confirm,
// for the same reason that ✕ has none: a task is a thing you re-run.
function stopTask(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) { toast("That task is gone"); return; }
  const label = s.run?.label ?? "task";
  closePane(sessionId);
  lastPop = "";
  toast(`Stopped ${label}`);
}

// The one stop Episko makes behind an agent's back, so it asks first. The backend re-checks
// that the pid still holds the port and descends from a pane of ours before killing anything.
async function killPort(sid: string, pidPort: string) {
  const [pid, port] = pidPort.split(":").map(Number);
  const ok = await ask(
    `Kill pid ${pid} and everything it started, freeing port ${port}?\n\nAn agent that started it may still believe it is running.`,
    { title: `Kill the process on :${port}`, kind: "warning", okLabel: "Kill", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  try {
    const freed = await invoke<boolean>("kill_listener", { pid, port });
    const s = sessions.get(sid);
    if (s) markKilled(s.servers, port, Date.now());
    toast(freed ? `Killed pid ${pid}: port ${port} is free` : `Killed pid ${pid}, but port ${port} is still taken`);
  } catch (err) {
    toast(String(err));
  }
  lastPop = "";
  await pollServers();
  repaint();
}

// Asked first, like a port kill. The backend kills only a tree its last poll reported with
// this very start time, so a pid reused since cannot be hit.
async function killLeft(key: string) {
  const g = leftTrees.find((x) => leftKey(x) === key);
  if (!g) { toast("That process has already gone"); return; }
  const n = g.procs.length;
  const ok = await ask(
    `Kill ${procLabel(leftLead(g), 80)}${n > 1 ? ` and the ${n - 1} other process${n === 2 ? "" : "es"} in its tree` : ""}?\n\nIt holds ${fmtMb(leftMem(g) / 1048576)}. Nothing in Episko is attached to it any more.`,
    { title: `Kill pid ${g.pid}`, kind: "warning", okLabel: "Kill", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  try {
    const all = await invoke<boolean>("kill_left_behind", { pid: g.pid, started: g.started });
    toast(all ? `Killed pid ${g.pid}` : `Killed pid ${g.pid}, but part of its tree is still running`);
  } catch (err) {
    toast(String(err));
  }
  lastPop = "";
  await pollServers();
  repaint();
}

// `forgetServer` re-checks that the row has ended rather than trusting the markup.
function dismiss(sessionId: string, taskId: string) {
  const s = sessions.get(sessionId);
  if (!s || !forgetServer(s.servers, taskId)) return;
  lastPop = "";
  repaint();
}
