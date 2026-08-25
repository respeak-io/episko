// The header's running-server indicator, and the popover behind it.
//
// The IDE convention, and the reason it belongs in the header rather than the
// inspector: a dev server is not a fact about the session you happen to be looking at.
// It is a fact about the machine — a held port, a process that outlives the turn that
// started it, and something you may want to open in a browser while reading a
// completely different pane. So the count is fleet-wide and always on screen, and the
// popover is where the per-session detail lives.
//
// What this module owns: the pill, the popover, the poll that re-reads the logs, and
// the three things a row can do. The rules — what counts as a server, what the log
// says — are ./servers, which is pure and tested. This half is DOM and IPC all the way
// down, like ./footer next door, and untested for the same reason.
//
// **Stopping is handed to the agent, not done behind its back.** Episko could find the
// process (it is a descendant of Episko's own tree) and kill it — but the agent that
// started it holds `TaskStop`, believes the server is up, and will go on telling you so
// after a kill it never saw. So Stop prefills `TaskStop <id>` into the session and lets
// you press Enter, the same contract as `handToTerminal` and `sendOutputToSession`:
// Episko prefills, the human commits, and the agent's model of the world stays true.
// (An *orphan* — a server whose session is gone — has no agent to ask, and killing one
// needs a port→pid lookup this app does not have yet. Its row says so.)
//
// **Two sources, and they are listed by opposite rules.** An agent's background shell is
// invisible — no pane, no row, nothing on screen — so every one of them is listed, URL or
// not. An Episko **task** (`just dev`, a VS Code task, an npm script) already has a pane,
// a sidebar row, a glyph and a phase, so listing it here would only repeat what the
// sidebar says; it appears **only once it has announced a URL**, which is the one thing
// its pane cannot give you — an address you can click. Same reason a failed task never
// appears: the sidebar has already gone red about it. The header is for what is
// otherwise invisible.
//
// Stopping differs with the source too, and honestly so: Episko owns a task's PTY, so ✕
// there really does stop it (`closeSession`, exactly what the pane's own ✕ does). There
// is no agent holding a stale belief to keep true.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, toast } from "./dom";
import { esc, escAttr } from "./format";
import { sessions, activeId } from "./state";
import {
  applyBgLog, bgOutcome, cmdLabel, failedServers, forgetServer, liveServers,
  reconcilePorts, servingUrls, shownServers, type BgRead, type SessionPort,
} from "./servers";
import { isClaude, type BgServer, type Sess } from "./types";

/// A row, resolved. `"bg"` is a shell an agent backgrounded — the record carries
/// everything and the pane knows nothing about it. `"task"` is a runnable Episko itself
/// launched, where the *pane* is the server and there is no record at all.
type Row =
  | { kind: "bg"; s: Sess; at: number; b: BgServer }
  | { kind: "task"; s: Sess; at: number }
  | { kind: "port"; s: Sess; at: number; port: number; name: string };

interface LoosePort { port: number; name: string; at: number }

/// The ports under each pane that no record explains — a server started by hand in a
/// shell pane, or one whose banner nothing could parse. Keyed by session id.
///
/// Computed by the poll, not by the renderer, and that split is load-bearing:
/// `reconcilePorts` **mutates** (step 2 of its ladder adopts a loose port onto a silent
/// record), so calling it from a render pass would have the paint quietly rewriting the
/// state it was asked to draw — at whatever rate telemetry happens to arrive.
let loosePorts = new Map<string, LoosePort[]>();

/// When each port was first seen, keyed `<session>:<port>`.
///
/// A socket has no age of its own — the kernel will tell you it is open, not since
/// when — and `Sess` records no start time either. Without a stamp the rows would have
/// nothing to sort by but the port number, so a server started this morning would sit
/// below one started a minute ago purely because 8080 > 3000. Pruned against each
/// poll's answer, so a port that closes and reopens is honestly new.
const portSeen = new Map<string, number>();

function looseOf(s: Sess): LoosePort[] {
  return loosePorts.get(s.id) ?? [];
}

/// Task panes that are serving. Live only, and only with a URL — see the module header
/// for why a task is listed on a stricter rule than an agent's shell.
function taskRows(): Row[] {
  const out: Row[] = [];
  for (const s of sessions.values()) {
    const r = s.run;
    if (s.kind !== "task" || !r || r.exitCode != null || !r.url) continue;
    out.push({ kind: "task", s, at: r.startedAt });
  }
  return out;
}

/// Everything the popover draws, from both sources: agent-backgrounded shells (running,
/// plus the failures nobody has read yet) and Episko's own serving task panes.
function rows(): Row[] {
  const out: Row[] = [];
  for (const s of sessions.values()) {
    for (const b of shownServers(s.servers)) out.push({ kind: "bg", s, at: b.startedAt, b });
    // A port nothing else here explains. Sorted by port so the rows of one pane keep a
    // stable order; `at` borrows the pane's own start, since a socket carries no age of
    // its own and the pane is the closest true answer.
    for (const p of looseOf(s)) out.push({ kind: "port", s, at: p.at, port: p.port, name: p.name });
  }
  out.push(...taskRows());
  // Oldest first: a dev server you started this morning is the one you have forgotten
  // about, and the one a new arrival should not push off the bottom of the list.
  return out.sort((a, b) => a.at - b.at);
}

/// What the poll re-reads — a separate question from what the popover draws, and
/// deliberately a separate function rather than a mode of `rows`.
///
/// Only agent-backgrounded shells appear here, for two independent reasons: a task's
/// output arrives on the PTY stream so there is no file to poll at all, and a *dead*
/// log has nothing left to say, so re-reading one every four seconds forever is exactly
/// the cost this feature must not have. Returning the records rather than rows is what
/// makes both of those true by construction instead of by a filter somebody can drop.
function livePolled(): BgServer[] {
  const out: BgServer[] = [];
  for (const s of sessions.values()) out.push(...liveServers(s.servers));
  return out;
}

// ---------- the pill ----------

let lastPop = "";

/// The header indicator. Hidden entirely when nothing is running — an always-visible
/// zero would be one more thing to read past, and the whole point is that a server you
/// forgot about should be the thing that catches your eye.
export function renderServers() {
  const shown = rows();
  const el = $("svrBadge");
  if (!shown.length) { el.className = "svr-badge"; closeServersPop(); return; }
  // Through the tested helpers rather than a second `.url`/`.exit` test here: "a server
  // worth pointing at is one that has announced a URL", and "a failure is a non-zero
  // exit nobody asked for", are both rules, and rules live in ./servers.
  let serving = 0, failed = 0;
  for (const s2 of sessions.values()) {
    serving += servingUrls(s2.servers).length;
    failed += failedServers(s2.servers).length;
  }
  // A task row is only ever here because it announced a URL, and a port row because the
  // kernel says the socket is open — so every one of both counts toward green. For the
  // task that is the whole condition for being listed at all; for the port it is the
  // strongest evidence in the feature.
  serving += shown.filter((r) => r.kind !== "bg").length;
  el.className = "svr-badge show";
  $("svrBadgeTxt").textContent = String(shown.length);
  // The title carries what the pill cannot: one line per server, so hovering answers
  // "which ones?" without a click.
  el.title = shown.map((r) => `${r.s.project} · ${rowTitle(r)}`).join("\n");
  // Failure wins the colour. A fleet with two servers up and one crashed is, right then,
  // a thing that needs looking at — and green over the top of that reads as "all fine".
  el.classList.toggle("serving", serving > 0 && !failed);
  el.classList.toggle("failed", failed > 0);
  if ($("svrPop").classList.contains("show")) renderServersPop();
}

// ---------- the popover ----------

/// Which row is expanded. One at a time, and by task id rather than by index, so a
/// server finishing while the popover is open cannot slide the peek onto its neighbour.
let openRow = "";

/// The one line a row is *about*, for the pill's hover list.
function rowTitle(r: Row): string {
  if (r.kind === "task") return `${r.s.run?.url} (${r.s.run?.label ?? "task"})`;
  if (r.kind === "port") return `localhost:${r.port} (${r.name || "listening"})`;
  return r.b.ended ? bgOutcome(r.b) : (r.b.url || cmdLabel(r.b.cmd));
}

/// A row's identity for the expander. Namespaced by source rather than shared, because
/// the two are different things that happen to both be strings.
function rowKey(r: Row): string {
  if (r.kind === "task") return `t:${r.s.id}`;
  if (r.kind === "port") return `p:${r.s.id}:${r.port}`;
  return `b:${r.b.taskId}`;
}

/// The four things a row draws that differ by source, resolved once with the union
/// narrowed. Everything below this point is the same markup for both.
///
/// `label` is deliberately different in kind, not just in value: an agent's row shows
/// the **command**, because that is all there is to know about it, while a task's shows
/// the **name you picked** with the command on its tooltip. The ▶ reuses the app's own
/// Run glyph rather than inventing a marker, since "Episko ran this" is exactly what ▶
/// already means everywhere else — without it a `just dev` row and an agent's `pnpm dev`
/// row read identically.
function rowFacts(r: Row) {
  if (r.kind === "port") {
    // Nothing announced this — it is a socket the kernel says is open under this pane.
    // So the label is the only thing we actually know: the process holding it.
    return {
      url: `http://localhost:${r.port}`, dead: false, outcome: "", tail: undefined,
      label: `<span class="sv-src sv-obs" title="Seen listening under this pane — nothing announced it">◎</span>${esc(r.name || "port " + r.port)}`,
      // No ✕, but the cell stays: the row is a four-column grid, and dropping one
      // column would pull this row's ◨ out of line with every other row's. We know
      // which pid holds the socket; what we do not know is that killing it is what you
      // meant — it sits several hops below a pane that has its own ✕, and this row
      // exists to *tell* you the port is open, not to take responsibility for it.
      x: `<span class="sv-stop sv-none"></span>`,
      go: "Go to the pane this is running under",
    };
  }
  if (r.kind === "task") {
    const t = r.s.run!;
    return {
      url: t.url ?? "", dead: false, outcome: "", tail: t.tail,
      label: `<span class="sv-src" title="Started by Episko · ${escAttr(t.cmd)}">▶</span>${esc(t.label)}`,
      // Ours to stop, so it really is stopped.
      x: `<button class="sv-stop" data-svkill="${r.s.id}" title="Stop this task">✕</button>`,
      go: "Go to this task's pane",
    };
  }
  const b = r.b;
  const dead = !!b.ended;
  return {
    url: b.url ?? "", dead, outcome: bgOutcome(b), tail: b.tail,
    label: esc(cmdLabel(b.cmd)),
    // A dead row has no process left and is merely cleared; a live one is only ever
    // *asked* to stop. Separate attributes rather than one branch in the handler, so the
    // two can never be confused for each other.
    x: dead
      ? `<button class="sv-stop" data-svforget="${b.taskId}" data-svsid="${r.s.id}" title="Dismiss">✕</button>`
      : `<button class="sv-stop" data-svstop="${b.taskId}" data-svsid="${r.s.id}" title="Ask this session's agent to stop it (TaskStop)">✕</button>`,
    go: "Go to the session that started this",
  };
}

function rowHtml(r: Row, open: boolean): string {
  const s = r.s;
  const { url, dead, outcome, tail, label, x, go } = rowFacts(r);
  const peek = open && tail?.length
    ? `<pre class="sv-log">${esc(tail.join("\n"))}</pre>`
    : open ? `<pre class="sv-log sv-log-empty">no output yet</pre>` : "";
  // A dead row keeps its outcome where the URL was, as plain text: the port is gone, and
  // a chip that opens a dead tab is worse than one that does not invite the click.
  const mid = dead
    ? `<span class="sv-url sv-dead">${esc(outcome)}</span>`
    : url
      ? `<button class="sv-url" data-svopen="${escAttr(url)}" title="Open ${escAttr(url)}">${esc(url.replace(/^https?:\/\//, ""))}</button>`
      : `<span class="sv-url sv-pending">starting…</span>`;
  return `<div class="sv-row${open ? " open" : ""}${dead ? " dead" : ""}">
    <button class="sv-head" data-svtoggle="${escAttr(rowKey(r))}" title="Show the last lines of this output">
      <span class="sv-dot${dead ? " down" : url ? " up" : ""}"></span>
      <span class="sv-main">
        <span class="sv-proj">${esc(s.project)}</span>
        <span class="sv-cmd">${label}</span>
      </span>
    </button>
    ${mid}
    <button class="sv-go" data-svgo="${s.id}" title="${go}">◨</button>
    ${x}
    ${peek}
  </div>`;
}

function renderServersPop() {
  const shown = rows();
  const pop = $("svrPop");
  const html = shown.length
    ? `<div class="sv-h">Running servers<span class="sv-hn">${shown.length}</span></div>`
      + shown.map((r) => rowHtml(r, rowKey(r) === openRow)).join("")
      + `<div class="sv-foot">▶ is a task Episko ran and can stop. The rest were backgrounded by an agent, and Stop asks that session to run <code>TaskStop</code>.</div>`
    : "";
  // Same guard, and the same reason, as the attention popover: this repaints on every
  // telemetry event, and an innerHTML assignment between mousedown and mouseup drops
  // the click on the button underneath (docs/architecture.md).
  if (html === lastPop) return;
  lastPop = html;
  pop.innerHTML = html;
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

/// The one thing this module needs from the popover family it joins. A settable hook
/// rather than an import of ./footer, because footer imports settings, which imports
/// enough of the app that a direct import here would close a cycle (CLAUDE.md's seam
/// rule 2). main.ts wires it.
let closeOtherMenus: () => void = () => {};
export function setServersCloseMenus(f: () => void) { closeOtherMenus = f; }

let repaint: () => void = () => {};
export function setServersRepaint(f: () => void) { repaint = f; }

/// ./panes owns a pane's lifecycle and sits above this module, so closing one arrives
/// as a hook like the rest (CLAUDE.md's seam rule 2).
let closePane: (id: string) => void = () => {};
export function setServersCloseSession(f: (id: string) => void) { closePane = f; }

// ---------- the poll ----------

/// Re-read every live server's log. This is the only thing that ever fills in a URL, a
/// peek or an ended state, so the cadence is the feature's latency — but it is also a
/// disk read per server, so it is deliberately slower than anything on the telemetry
/// path and skips finished records entirely.
///
/// A dev server that nobody is hitting writes nothing for hours, which is exactly why
/// `applyBgLog` returns whether anything moved: the common case is N reads that change
/// nothing and must cost no paint.
/// Ask the kernel which ports our panes are listening on, and reconcile that against
/// what the panes have said about themselves.
///
/// This is the half that needs no cooperation from anything: no hook, no log, no output
/// format. It is what lets a shell pane where somebody typed `pnpm dev` by hand show up
/// at all, and what puts a port on a row whose banner nothing could parse.
async function refreshPorts(): Promise<boolean> {
  let seen: SessionPort[];
  try {
    seen = await invoke<SessionPort[]>("session_ports");
  } catch {
    return false; // keep the last answer rather than blanking the list on one bad poll
  }
  const now = Date.now();
  const bySession = new Map<string, SessionPort[]>();
  for (const p of seen) {
    const list = bySession.get(p.sessionId) ?? [];
    list.push(p);
    bySession.set(p.sessionId, list);
    const k = `${p.sessionId}:${p.port}`;
    if (!portSeen.has(k)) portSeen.set(k, now);
  }
  // Prune stamps for ports that have closed, so one that comes back is honestly new
  // rather than claiming the age of the server that held it before.
  const alive = new Set(seen.map((p) => `${p.sessionId}:${p.port}`));
  for (const k of [...portSeen.keys()]) if (!alive.has(k)) portSeen.delete(k);

  let changed = false;
  const next = new Map<string, LoosePort[]>();
  for (const s of sessions.values()) {
    const mine = bySession.get(s.id) ?? [];
    // Runs even with no ports: a record that adopted one earlier keeps its URL, and
    // there is nothing here that needs clearing — a closed port does not un-say what
    // the server announced.
    const { loose, changed: adopted } = reconcilePorts(s.servers, s.run?.url, mine.map((p) => p.port));
    if (adopted) changed = true;
    if (loose.length) {
      next.set(s.id, loose.map((p) => ({
        port: p,
        name: mine.find((x) => x.port === p)?.name ?? "",
        at: portSeen.get(`${s.id}:${p}`) ?? now,
      })));
    }
  }
  // A repaint is owed whenever the *set* of loose rows moved, which is the only part of
  // this the popover draws directly.
  const key = (m: Map<string, LoosePort[]>) =>
    [...m].map(([k, v]) => k + ":" + v.map((p) => p.port).join(",")).sort().join("|");
  if (key(next) !== key(loosePorts)) changed = true;
  loosePorts = next;
  return changed;
}

export async function pollServers() {
  let changed = await refreshPorts();
  const live = livePolled();
  if (!live.length) { if (changed) repaint(); return; }
  for (const b of live) {
    if (!b.transcript) continue; // no address to read; the row still draws
    try {
      // `knownLen` is the whole cost control: the backend compares it against the file's
      // length and, for an append-only log that has not moved, answers without opening
      // it at all. See `read_bg_log`.
      const got = await invoke<BgRead & { missing: boolean }>(
        "read_bg_log", { transcript: b.transcript, taskId: b.taskId, knownLen: b.len ?? 0 },
      );
      // A missing file is normal for a second or two after a shell starts, and
      // permanent if Claude Code's layout ever changes. Either way there is nothing to
      // fold in, and the record keeps whatever it already knew.
      if (got.missing) { if (!b.log && got.path) { b.log = got.path; changed = true; } continue; }
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
  // Buttons first, expander last — the expander is the row's whole background, so
  // `closest()` would hand it back for a click that landed on any of the three.
  const url = t.closest<HTMLElement>("[data-svopen]");
  if (url) { e.stopPropagation(); void openUrl(url.dataset.svopen!).catch((err) => toast("open failed: " + err)); return; }
  const go = t.closest<HTMLElement>("[data-svgo]");
  if (go) { e.stopPropagation(); goToSession(go.dataset.svgo!); return; }
  const stop = t.closest<HTMLElement>("[data-svstop]");
  if (stop) { e.stopPropagation(); askStop(stop.dataset.svsid!, stop.dataset.svstop!); return; }
  const forget = t.closest<HTMLElement>("[data-svforget]");
  if (forget) { e.stopPropagation(); dismiss(forget.dataset.svsid!, forget.dataset.svforget!); return; }
  const kill = t.closest<HTMLElement>("[data-svkill]");
  if (kill) { e.stopPropagation(); stopTask(kill.dataset.svkill!); return; }
  const tog = t.closest<HTMLElement>("[data-svtoggle]");
  if (tog) {
    e.stopPropagation();
    openRow = openRow === tog.dataset.svtoggle ? "" : tog.dataset.svtoggle!;
    lastPop = ""; renderServersPop();
  }
});

/// A hook rather than an import: ./panes owns `setActive`, and it sits above this
/// module in the graph.
let setActiveSession: (id: string) => void = () => {};
export function setServersSetActive(f: (id: string) => void) { setActiveSession = f; }

function goToSession(id: string) {
  if (!sessions.has(id)) { toast("That session is gone"); return; }
  setActiveSession(id);
  closeServersPop();
}

/// Prefill the stop into the session's stdin — deliberately **without** a trailing
/// newline, so you read what is about to be sent and press Enter yourself. Same
/// contract as `sendOutputToSession` in ./taskrun.
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

/// Stop a task Episko itself launched. Unlike the agent's shells this is a real stop:
/// the PTY is ours, `closeSession` kills it and reaps the pane, and it is exactly what
/// the pane's own ✕ does — so the two routes cannot end up meaning different things.
/// No confirm, for the same reason that ✕ has none: a task is a thing you re-run.
function stopTask(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) { toast("That task is gone"); return; }
  const label = s.run?.label ?? "task";
  closePane(sessionId);
  lastPop = "";
  toast(`Stopped ${label}`);
}

/// Clear a finished row. Only ever reachable on one that has actually ended, and
/// `forgetServer` re-checks that rather than trusting the markup: a live server is
/// removed by stopping it, and forgetting one whose port is still held would put the app
/// straight back to lying about what is running.
function dismiss(sessionId: string, taskId: string) {
  const s = sessions.get(sessionId);
  if (!s || !forgetServer(s.servers, taskId)) return;
  lastPop = "";
  repaint();
}
