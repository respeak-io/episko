// The Trail's pane. ./trail owns the rules, this owns the markup, the data fetch and
// the events — the same split as ./history + ./historyui and ./palette + ./palui.
//
// Two halves, and the split is the whole idea:
//
//   left  — **derived**, read-only, never typed. Days assembled from Claude's own
//           transcripts, the usage rollup and git. If you never open it, it is still
//           correct, which is what a board that must be maintained can never be.
//   right — **notes**, the only thing here you write, and the only thing that can be
//           handed to an agent. Yesterday's unfinished thread and tomorrow's brief are
//           one keystroke apart; that arrow is the reason the two share a screen.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import { esc, relTime, uUsd2 } from "./format";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote, setNoteProject, type Note } from "./notes";
import { activeProjectCtx, launch } from "./panes";
import { accentFor, FAVORITES, sessions, setActiveId, setMirror, trailOpen, trailProject } from "./state";
import {
  dayByProject, dayFacts, dayIsClosed, deterministicHeadline, trailDays,
  type DayProject, type TrailCommit, type TrailDay, type TrailEvent,
} from "./trail";
import { usageWindow } from "./usage";

// ---------- preferences ----------
// Personal, like every other cc-* key. The window is a preference rather than a
// constant because "how far back is useful" is genuinely per-person: a week for
// someone who ships daily, a month for someone picking a thread back up.
const RANGES = [7, 14, 30, 90];
export let trailRange = +(localStorage.getItem("cc-trail-range") || 14) || 14;
export function setTrailRange(n: number) {
  trailRange = RANGES.includes(n) ? n : 14;
  localStorage.setItem("cc-trail-range", String(trailRange));
  // A wider window is a different set of days and a different git query, so it has to
  // re-fetch — repainting the days already in memory would silently show the old span.
  if (trailOpen()) void loadTrail();
}
/// Generated day summaries cost money, so they are opt-in and the switch is honest
/// about it. Off means the deterministic headline stands, which is a complete view.
export let trailSummaries = (localStorage.getItem("cc-trail-summaries") ?? "1") === "1";
export function setTrailSummaries(on: boolean) {
  trailSummaries = on;
  localStorage.setItem("cc-trail-summaries", on ? "1" : "0");
  if (trailOpen()) { if (on) void runSummaryQueue(); else renderDays(); }
}

// ---------- state ----------
let days: TrailDay[] = [];
let loading = false;
/// The project that was on screen when the Trail was opened.
///
/// Load-bearing, and the reason it exists at all: opening the Trail clears `activeId`
/// (it owns the stage, like every other mirror), so asking `activeProjectCtx()` while
/// it is open always answers null. Without this, every note jotted *from the Trail*
/// would be filed against nothing — and an unfiled note cannot be dispatched, which
/// would leave the one interaction this pane exists for dead on arrival.
let openedFrom: string | null = null;
/// Generated summaries, keyed by day. Separate from `days` so a reload of the history
/// doesn't drop sentences already paid for in this session.
const summaries = new Map<string, string>();

// ---------- data ----------
/// Every project root worth asking git about: the user's favourites plus the roots of
/// anything currently open. Deduped here, and deduped *again* by repository in the
/// backend, since several worktrees of one repo resolve to one history.
function projectRoots(): string[] {
  const roots = new Set<string>(FAVORITES.map((f) => f.path));
  for (const s of sessions.values()) roots.add(s.colorKey);
  return [...roots];
}

async function loadTrail(): Promise<void> {
  loading = true;
  renderDays();
  try {
    // History is capped: the Trail only shows `trailRange` days, and the backend
    // returns newest-first, so a limit generous enough to cover a busy month costs
    // one bounded scan rather than the whole ~1GB corpus.
    const roots = projectRoots();
    const [hist, commits, events] = await Promise.all([
      invoke<HistEntry[]>("list_session_history", { limit: 600 }).catch((e) => {
        dlog("warn", `trail: history scan failed — ${e}`);
        return [] as HistEntry[];
      }),
      invoke<TrailCommit[]>("git_log_days", { roots, days: trailRange }).catch((e) => {
        dlog("warn", `trail: git log failed — ${e}`);
        return [] as TrailCommit[];
      }),
      // Per repo, because gh resolves the repo from the working directory. Each event
      // is stamped with the root it came from — that is what lets `dayByProject` file
      // it under the right project without re-deriving anything.
      Promise.all(roots.map((root) =>
        invoke<TrailEvent[]>("gh_day_activity", { root, force: false })
          .then((evs) => evs.map((e) => ({ ...e, root })))
          .catch(() => [] as (TrailEvent & { root: string })[])))
        .then((lists) => lists.flat()),
    ]);
    days = trailDays(hist, usageWindow(trailRange), commits, events);
  } finally {
    loading = false;
  }
  renderDays();
  if (trailSummaries) void runSummaryQueue();
}

/// Ask for the missing summaries **one at a time**.
///
/// Each one spawns a `claude -p`; firing fourteen of those at once would put fourteen
/// CLI processes on the machine at the moment the user opened a panel, which is
/// exactly the kind of thing that makes an app feel like it took the machine away.
/// Sequential is also naturally self-throttling: navigating away stops the queue.
let queueRunning = false;
async function runSummaryQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (const d of days) {
      if (!trailOpen() || !trailSummaries) break;      // the user left, or turned it off
      if (summaries.has(d.key)) continue;
      const facts = dayFacts(d);
      if (!facts.trim()) continue;
      try {
        const line = await invoke<string>("summarize_day", {
          key: d.key, facts, model: "haiku", force: !dayIsClosed(d),
        });
        if (line) { summaries.set(d.key, line); renderDays(); }
      } catch (e) {
        // No summary is a fine state — the deterministic headline already reads
        // correctly — so a failure is logged and the loop moves on rather than
        // surfacing as breakage or retrying in a hot loop.
        dlog("warn", `trail: summary for ${d.key} failed — ${e}`);
      }
    }
  } finally {
    queueRunning = false;
  }
}

// ---------- markup ----------
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayGutter(d: TrailDay): string {
  const dt = new Date(d.when);
  return `<div class="td-gut">
    <span class="td-day">${WEEKDAY[dt.getDay()]} ${dt.getDate()}</span>
    ${d.cost > 0 ? `<span class="td-cost">${esc(uUsd2(d.cost))}</span>` : ""}
  </div>`;
}

// The two kinds of thing a day contains, named in the app's OWN vocabulary.
//
// This is the second attempt. Glyphs (✓ / ⎇) produced "what does the check mean versus
// the fork?"; replacing them with `chat` and `code` produced "what is the difference
// between chat and code?" — shorter, and still a word the rest of Episko never uses.
// "Session" and "commit" are what the sidebar, History and git already call these, so
// there is nothing left to learn.
function sessionRow(s: TrailDay["sessions"][number]): string {
  const live = sessions.has(s.id);
  return `<div class="td-item" data-sess="${esc(s.id)}" data-cwd="${esc(s.cwd)}">
    <span class="td-kind sess${live ? " on" : ""}"
      title="${live ? "A Claude session — still running" : "A Claude session"}">session</span>
    <span class="td-t">${esc(s.title)}</span>
    <span class="td-r">${s.branch ? esc(s.branch) : ""}</span>
  </div>`;
}

/// A commit, with the issue or PR it mentions. `fix: …(#42)` and `Merge pull request
/// #30` both carry their number in the subject, which is the only link git has to
/// GitHub — so it is read from there rather than guessed.
function commitRow(c: TrailCommit, evByNumber: Map<number, TrailEvent>): string {
  const refs = [...new Set([...c.subject.matchAll(/#(\d+)/g)].map((m) => +m[1]))].slice(0, 2);
  const chips = refs.map((n) => {
    const e = evByNumber.get(n);
    return e ? `<a class="td-ev ${esc(e.event)}" href="${esc(e.url)}" data-ext="1"
        title="${esc(e.event)} ${esc(e.kind)} #${n} — ${esc(e.title)}">${EVENT_GLYPH[e.event] ?? "·"} #${n}</a>`
      : `<span class="td-ev">#${n}</span>`;
  }).join("");
  return `<div class="td-item">
    <span class="td-kind commit" title="A git commit">commit</span>
    <span class="td-t">${esc(c.subject)}</span>
    ${chips ? `<span class="td-evs-inline">${chips}</span>` : ""}
    <span class="td-r">${esc(c.author)}</span>
  </div>`;
}

/// What landed. A chip rather than a row: these are the outcomes of a day, and they
/// want to be countable at a glance rather than read one by one.
const EVENT_GLYPH: Record<string, string> = { merged: "⛙", closed: "✓", opened: "＋" };
function eventChip(e: TrailEvent): string {
  return `<a class="td-ev ${esc(e.event)}" href="${esc(e.url)}" data-ext="1"
    title="${esc(e.event)} ${esc(e.kind)} #${e.number} — ${esc(e.title)}">${EVENT_GLYPH[e.event] ?? "·"} #${e.number}</a>`;
}

/// One project's slice of a day. The grouping is the point: a flat list of everything
/// reads as noise the moment two projects are in play, because you cannot tell which
/// commits belong to which sessions.
/// Number → the event it belongs to, so a commit can carry the state of the thing it
/// references rather than a bare "#42".
function evIndex(events: TrailEvent[]): Map<number, TrailEvent> {
  const m = new Map<number, TrailEvent>();
  // A merge beats an opening for the same number: it is the later, more useful fact.
  for (const e of events) {
    const cur = m.get(e.number);
    if (!cur || e.event !== "opened") m.set(e.number, e);
  }
  return m;
}

function projectBlock(g: DayProject): string {
  return `<div class="td-proj">
    <div class="td-proj-h">
      <i class="td-dot" style="background:${esc(accentFor(g.colorKey))}"></i>
      <span class="td-proj-n">${esc(g.project)}</span>
      ${g.events.length ? `<span class="td-evs">${g.events.map(eventChip).join("")}</span>` : ""}
    </div>
    <div class="td-items">
      ${g.sessions.map(sessionRow).join("")}
      ${g.commits.map((c) => commitRow(c, evIndex(g.events))).join("")}
    </div>
  </div>`;
}

function dayBlock(d: TrailDay): string {
  const generated = summaries.get(d.key);
  const headline = generated || deterministicHeadline(d);
  const groups = dayByProject(d, projectNameOf);
  return `<div class="td-day-block">
    ${dayGutter(d)}
    <div class="td-body">
      <p class="td-sum${generated ? " td-gen" : ""}">${esc(headline)}</p>
      ${groups.map(projectBlock).join("")}
    </div>
  </div>`;
}

/// colorKey → the name the sidebar shows.
function projectNameOf(colorKey: string): string {
  if (!colorKey) return "elsewhere";
  const fav = FAVORITES.find((f) => f.path === colorKey);
  if (fav) return fav.name;
  for (const s of sessions.values()) if (s.colorKey === colorKey) return s.project;
  return colorKey.split(/[/\\]/).pop() || colorKey;
}

/// The days this altitude shows. Filtering here rather than at fetch time means
/// switching altitude is instant and costs no `gh` call or history scan.
function visibleDays(): TrailDay[] {
  const p = trailProject();
  if (!p) return days;
  return days
    .map((d) => ({
      ...d,
      sessions: d.sessions.filter((s) => s.colorKey === p),
      commits: d.commits.filter((c) => c.root === p),
      events: (d.events ?? []).filter((e) => (e as TrailEvent & { root?: string }).root === p),
      // Cost is per-day across the whole fleet, so it cannot honestly be attributed to
      // one project here — zero it rather than show another project's spend.
      cost: 0,
    }))
    .filter((d) => d.sessions.length || d.commits.length || d.events.length);
}

function renderChrome(): void {
  const p = trailProject();
  $("trailRange").textContent = `derived · last ${trailRange} days${p ? ` · ${projectNameOf(p)}` : ""}`;
  ($("trailWindow") as HTMLSelectElement).innerHTML = RANGES
    .map((r) => `<option value="${r}"${r === trailRange ? " selected" : ""}>${r} days</option>`).join("");
  // Every project that has a favourite or a session, not only ones with history in
  // this window — you need to be able to select an empty project to file a note to it.
  const keys = new Set<string>([...FAVORITES.map((f) => f.path)]);
  for (const s of sessions.values()) keys.add(s.colorKey);
  for (const d of days) { for (const x of d.sessions) keys.add(x.colorKey); for (const c of d.commits) keys.add(c.root); }
  ($("trailScope") as HTMLSelectElement).innerHTML =
    `<option value=""${p ? "" : " selected"}>All projects</option>` +
    [...keys].filter(Boolean).sort().map((k) =>
      `<option value="${esc(k)}"${k === p ? " selected" : ""}>${esc(projectNameOf(k))}</option>`).join("");
}

function renderDays(): void {
  renderChrome();
  const host = $("trailDays");
  if (loading) { host.innerHTML = `<div class="td-empty">Reading your history…</div>`; return; }
  if (!days.length) {
    host.innerHTML = `<div class="td-empty">Nothing in the last ${trailRange} days.
      Sessions, commits and spend appear here on their own — there is nothing to fill in.</div>`;
    return;
  }
  const vis = visibleDays();
  if (!vis.length) { host.innerHTML = `<div class="td-empty">Nothing in this project in the last ${trailRange} days.</div>`; return; }
  host.innerHTML = vis.map(dayBlock).join("");
}

function noteRow(n: Note): string {
  // A real <select>, not a chip with a popover: filing a note has to be possible from
  // the row itself (dispatch needs a project, and a note jotted with nothing on screen
  // has none), and the native control gets keyboard and accessibility for free.
  const known = FAVORITES.some((f) => f.path === n.project);
  const opts = [
    `<option value=""${n.project ? "" : " selected"}>unfiled</option>`,
    ...FAVORITES.map((f) => `<option value="${esc(f.path)}"${f.path === n.project ? " selected" : ""}>${esc(f.name)}</option>`),
    // A note filed against a folder that is no longer a favourite keeps its filing
    // rather than silently reverting to unfiled.
    ...(n.project && !known ? [`<option value="${esc(n.project)}" selected>${esc(n.project.split(/[/\\]/).pop()!)}</option>`] : []),
  ].join("");
  return `<div class="td-note">
    <div class="td-note-b">
      <span class="td-note-t">${esc(n.text)}</span>
      <span class="td-note-m">
        <select class="td-note-proj" data-file="${esc(n.id)}" title="Which project this belongs to">${opts}</select>
        <span>${esc(relTime(n.created))}</span>
      </span>
    </div>
    <button class="mini-act go" data-dispatch="${esc(n.id)}" title="Start an agent on this">↗ dispatch</button>
    <button class="mini-act" data-drop="${esc(n.id)}" title="Delete this note">✕</button>
  </div>`;
}

function renderNotes(): void {
  const list = noteList(trailProject() ?? undefined);
  $("trailNoteCount").textContent = `${list.length} open`;
  $("trailNotes").innerHTML = list.length
    ? list.map(noteRow).join("")
    : `<div class="td-empty">Nothing queued. Jot the next thing above — one field, one key.</div>`;
}

export function renderTrail(): void {
  renderDays();
  renderNotes();
}

// ---------- dispatch ----------
/// Turn a note into a running agent.
///
/// The note names the work; the project it was filed against says where. An unfiled
/// note has no such answer, so it asks rather than guessing — starting an agent in the
/// wrong repo is worse than one more click.
///
/// The text is typed in **without a trailing newline**: Episko prefills, the human
/// presses Enter. Same rule as the run-on-stop handoff, and for the same reason — the
/// decision to actually send a prompt stays with the person.
async function dispatchNote(id: string): Promise<void> {
  const n = noteList().find((x) => x.id === id);
  if (!n) return;
  const fav = n.project ? FAVORITES.find((f) => f.path === n.project) : null;
  const root = n.project;
  if (!root) {
    toast("Pick a project for this note first — the dropdown on its row");
    return;
  }
  const project = fav ? fav.name : root.split(/[/\\]/).pop() || root;
  const sid = await launch(project, root, { colorKey: root });
  removeNote(id);
  renderNotes();
  if (typeof sid !== "string") { toast("Dispatched — the note is now a session"); return; }
  // Claude's REPL needs a moment before it will accept input; the shell handoff makes
  // the same bet with a shorter wait. Failing to type is harmless — the session is
  // already open and the note text is in the toast.
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: n.text.replace(/\n/g, " ") }).catch(() => {});
  }, 1400);
  toast("Dispatched — prefilled, press Enter to send");
}

// ---------- open / close ----------
export function openTrail(project: string | null = null): void {
  // Read the context BEFORE clearing activeId, or there is nothing left to read.
  openedFrom = project ?? activeProjectCtx()?.path ?? null;
  setMirror({ kind: "trail", project });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = true;
  ($("trailPane") as HTMLElement).hidden = false;
  // The Trail spans every project, so it wears the app's own accent — *removing* the
  // inline override rather than setting one, which lets the stylesheet's :root value
  // come back. Setting `accentFor("")` instead would hash the empty string into some
  // arbitrary hue, and leaving the previous project's tint would imply a scope this
  // view doesn't have.
  document.documentElement.style.removeProperty("--accent");
  renderTrail();
  void loadTrail();
}

export function closeTrail(): void {
  if (!trailOpen()) return;
  setMirror(null);
  ($("trailPane") as HTMLElement).hidden = true;
}

/// Header/inspector for the Trail. It is not a session, so the session chrome is
/// emptied rather than left showing whatever was on screen before.
export function renderTrailHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = "Trail";
  const hb = $("hBranch");
  hb.textContent = "all projects"; hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = "what you've been working on";
  $("hPath").textContent = "";
}

/// The Trail hides the inspector (see `.app.ov`), so this only runs if that mode is
/// ever turned off. Kept minimal rather than deleted: renderAll still calls it.
export function renderTrailInspector(): void {
  const pill = $("iPill"); pill.className = "pill idle";
  $("iPillTxt").textContent = "derived";
  const win = usageWindow(trailRange);
  const spend = win.reduce((s, d) => s + d.cost, 0);
  const nSess = days.reduce((s, d) => s + d.sessions.length, 0);
  const nComm = days.reduce((s, d) => s + d.commits.length, 0);
  $("inspector").innerHTML = `
    <div class="td-stats">
      <div class="td-stat"><span class="label">Spend</span><b>${esc(uUsd2(spend))}</b></div>
      <div class="td-stat"><span class="label">Days</span><b>${days.length}</b></div>
      <div class="td-stat"><span class="label">Sessions</span><b>${nSess}</b></div>
      <div class="td-stat"><span class="label">Commits</span><b>${nComm}</b></div>
    </div>
    <div class="isec">
      <span class="label">Window</span>
      <div class="seg-row" id="trailRanges">
        ${RANGES.map((r) => `<button class="seg-btn${r === trailRange ? " on" : ""}" data-range="${r}">${r}d</button>`).join("")}
      </div>
    </div>
    <p class="ihint">Everything on the left is read from your transcripts, git and the usage
    rollup — nothing here is typed by hand except the notes.</p>`;
}

// ---------- events ----------
/// One delegated listener on the pane, bound once at import: the pane's contents are
/// re-rendered wholesale on every change (the app's render-everything pattern), so
/// per-element handlers would be rebound on each repaint and leak.
export function wireTrail(): void {
  $("trailPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const drop = t.closest<HTMLElement>("[data-drop]");
    if (drop) { removeNote(drop.dataset.drop!); renderNotes(); return; }
    const disp = t.closest<HTMLElement>("[data-dispatch]");
    if (disp) { void dispatchNote(disp.dataset.dispatch!); return; }
  });

  // Filing a note. Deliberately NOT followed by a re-render: re-rendering the list
  // under a <select> the user is still interacting with would destroy the element
  // mid-gesture. The store is updated; the row already shows the new value.
  $("trailPane").addEventListener("change", (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("[data-file]");
    if (!sel) return;
    setNoteProject(sel.dataset.file!, sel.value || null);
  });

  ($("trailJot") as HTMLFormElement).addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("trailInput") as HTMLInputElement;
    // Filed against whatever was on screen when the Trail was opened (see `openedFrom`),
    // or nothing at all — an unfiled note is still worth keeping, and the jot box must
    // never refuse a thought because it doesn't yet know where it belongs.
    if (addNote(input.value, openedFrom)) { input.value = ""; renderNotes(); }
  });

  $("trailScope").addEventListener("change", (e) => {
    // Re-open rather than mutate: the scope lives in `mirror`, and one entry point
    // keeps the days, the notes and what a new note gets filed against in step.
    openTrail((e.target as HTMLSelectElement).value || null);
  });

  $("trailWindow").addEventListener("change", (e) => {
    setTrailRange(+(e.target as HTMLSelectElement).value);
  });

  // Chips and commit references open on GitHub — Episko mirrors a little of it, never
  // all of it, so "read the whole thing" means the browser.
  $("trailPane").addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[data-ext]");
    if (!a) return;
    e.preventDefault();
    void openUrl(a.href).catch((err) => dlog("warn", `open ${a.href} failed — ${err}`));
  });
}
