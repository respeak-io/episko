// The project dashboard — what a project *is*, rather than which of its sessions you
// happened to land in.
//
// WHY THIS EXISTS. Left-clicking a project used to select whichever session sorted
// first, so one click did two different things depending on state, and the answer to
// "what is going on in this repo" lived in a right-click menu nobody opens. This pane
// is the answer: the last week assembled from evidence Episko already keeps, the
// checkouts that exist, and the notes you left yourself.
//
// ./dash owns the rules and is pure; ./dashview owns the markup; this owns the pane,
// the IPC, the summary queue and the delegated events — the same three-way split as
// ./palette + ./palui and ./graph + ./graphview.
//
// THE ONE INVARIANT: **nothing here runs until a project is clicked.** No probe at
// startup, nothing on renderAll's path. A dashboard that cost anything to *not* open
// would tax every session in the app for a view most ticks never show.

import { invoke } from "@tauri-apps/api/core";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import {
  canShare, clampRange, DASH_RANGE_DEFAULT, dashDays, dashPulse, densePerDay,
  projectCost, projectTier, type ProjectFacts, type ProjectTier,
} from "./dash";
import {
  checkoutsCard, checkoutsOverlay, dashInspector, dashStrip, dayHtml, missingCard,
  notesCard, notesOverlay, pulseHtml,
} from "./dashview";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote } from "./notes";
import { GLYPH, GCLASS } from "./sidebarview";
import { deterministicHeadline, dayFacts, dayIsClosed, type TrailCommit, type TrailDay } from "./trail";
import { statusKey, type WtHead } from "./types";
import { usageDetail, usageWindow } from "./usage";
import {
  accentFor, dashMirror, folderDirty, sessions, setActiveId, setMirror,
} from "./state";

// What this pane does but does not own. Same host-object shape as ./settings and
// ./palui: a control surface that touches many things it isn't responsible for takes
// one host rather than a dozen setters.
export interface DashHost {
  launch: (project: string, workdir: string, opts?: { colorKey?: string }) => Promise<unknown>;
  openWorktreeDialog: (project: string, root: string) => void;
  openTerminal: (dir: string) => void;
  openRun: (root: string) => void;
  openGraph: (root: string) => void;
  openHistory: (root: string) => void;
  openFolder: (dir: string) => void;
  copyPath: (dir: string) => void;
  setActive: (id: string) => void;
  renderAll: () => void;
}
let host: DashHost = {
  launch: async () => {}, openWorktreeDialog: () => {}, openTerminal: () => {},
  openRun: () => {}, openGraph: () => {}, openHistory: () => {}, openFolder: () => {},
  copyPath: () => {}, setActive: () => {}, renderAll: () => {},
};
export function setDashHost(h: DashHost) { host = h; }

// ---------- preferences ----------
export let dashRange = clampRange(+(localStorage.getItem("cc-dash-range") || DASH_RANGE_DEFAULT));
export function setDashRange(n: number) {
  dashRange = clampRange(n);
  localStorage.setItem("cc-dash-range", String(dashRange));
  if (dashMirror()) void loadDash();
}
/// Generated day summaries cost money, so they are opt-in and the switch is honest
/// about it. Off means the deterministic headline stands, which is a complete view.
export let dashSummaries = (localStorage.getItem("cc-dash-summaries") ?? "1") === "1";
export function setDashSummaries(on: boolean) {
  dashSummaries = on;
  localStorage.setItem("cc-dash-summaries", on ? "1" : "0");
  if (dashMirror()) { if (on) void runSummaryQueue(); else renderDash(); }
}
/// Projects whose `.episko/digest.md` the user has agreed to create. Asked once per
/// project, because a new committable file in someone's repo is a real side effect —
/// the same stance `tasks.rs` takes with `tasks.toml`.
const OK_KEY = "cc-digest-ok";
const digestOk = (): string[] => { try { return JSON.parse(localStorage.getItem(OK_KEY) || "[]"); } catch { return []; } };
function allowDigest(root: string) {
  const l = digestOk();
  if (!l.includes(root)) localStorage.setItem(OK_KEY, JSON.stringify([...l, root]));
}

// ---------- state ----------
let facts: ProjectFacts | null = null;
let tier: ProjectTier = "none";
let days: TrailDay[] = [];
let heads: WtHead[] = [];
let hasDigest = false;
let loading = false;
/// Generated summaries for the open project, keyed by day. Separate from `days` so a
/// reload doesn't drop sentences already paid for in this session.
const summaries = new Map<string, string>();
/// Which day rows are expanded. Survives a re-render because it is keyed by day, not
/// by element — the pane rebuilds its innerHTML on every repaint.
const openDays = new Set<string>();
/// Which enlarge overlay is up, if any.
let openView: "checkouts" | "notes" | null = null;

const root = () => dashMirror()?.root ?? "";
const name = () => dashMirror()?.name ?? "";

// ---------- data ----------
async function loadDash(): Promise<void> {
  const r = root();
  if (!r) return;
  loading = true;
  summaries.clear();
  renderDash();
  try {
    // `project_facts` first and alone: it decides which of the calls below are even
    // worth making, and a folder that isn't a repo must not be asked for a git log.
    facts = await invoke<ProjectFacts>("project_facts", { dir: r }).catch(() => null);
    tier = projectTier(facts);
    const wantGit = tier !== "none";
    const [hist, commits, wt, digest] = await Promise.all([
      invoke<HistEntry[]>("list_session_history", { limit: 400 }).catch((e) => {
        dlog("warn", `dash: history scan failed — ${e}`);
        return [] as HistEntry[];
      }),
      wantGit ? invoke<TrailCommit[]>("git_log_days", { roots: [r], days: dashRange }).catch(() => [] as TrailCommit[])
              : Promise.resolve([] as TrailCommit[]),
      wantGit ? invoke<WtHead[]>("worktree_heads", { dir: r }).catch(() => [] as WtHead[])
              : Promise.resolve([] as WtHead[]),
      // The committed work log, read BEFORE anything is generated: the second person
      // to open a week pays nothing for it.
      wantGit ? invoke<Record<string, string>>("read_digest", { root: r }).catch(() => ({}))
              : Promise.resolve({} as Record<string, string>),
    ]);
    heads = wt.filter((w) => w.exists);
    for (const [k, v] of Object.entries(digest)) if (v) summaries.set(k, v);
    hasDigest = Object.keys(digest).length > 0
      || (wantGit && await invoke<boolean>("has_digest", { root: r }).catch(() => false));
    days = dashDays(r, hist, commits, usageWindow(dashRange), (k) => projectCost(usageDetail, k, name()));
  } finally {
    loading = false;
  }
  renderDash();
  if (dashSummaries) void runSummaryQueue();
}

/**
 * Ask for the missing summaries **one at a time**.
 *
 * Each one spawns a `claude -p`; firing a fortnight of those at once would put
 * fourteen CLI processes on the machine at the moment the user clicked a project,
 * which is exactly the kind of thing that makes an app feel like it took the machine
 * away. Sequential is also self-throttling: navigating away stops the queue.
 */
let queueRunning = false;
async function runSummaryQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  const r = root();
  try {
    for (const d of days) {
      if (!dashMirror() || root() !== r || !dashSummaries) break;   // left, or switched off
      if (summaries.has(d.key)) continue;                           // digest or cache already had it
      const f = dayFacts(d);
      if (!f.trim()) continue;
      try {
        const line = await invoke<string>("summarize_day", {
          root: r, key: d.key, facts: f, model: "haiku", force: !dayIsClosed(d),
        });
        if (!line) continue;
        summaries.set(d.key, line);
        renderDash();
        // Share it, if this project has said yes. A day still being written is not
        // written to the repo — today's line changes as the day goes on, and each
        // change would dirty a tracked file.
        if (canShare(tier) && dayIsClosed(d) && digestOk().includes(r)) {
          void invoke("write_digest", { root: r, key: d.key, line, create: true }).catch(() => {});
        }
      } catch (e) {
        // No summary is a fine state — the deterministic headline already reads
        // correctly — so a failure is logged and the loop moves on.
        dlog("warn", `dash: summary for ${d.key} failed — ${e}`);
      }
    }
  } finally {
    queueRunning = false;
  }
}

// ---------- render ----------
const liveIn = (path: string) => [...sessions.values()].filter((s) => (s.workdir || "") === path).length;
const liveHere = () => [...sessions.values()].filter((s) => s.colorKey === root());

export function renderDash(): void {
  if (!dashMirror()) return;
  const p = dashPulse(days);
  const dense = densePerDay(days, dashRange, Date.now());
  $("dashPulse").innerHTML = pulseHtml(p, tier, dashRange, dense);

  const spine = $("dashSpine");
  if (loading) {
    spine.innerHTML = `<div class="db-empty">Reading this project's history…</div>`;
  } else if (!days.length) {
    spine.innerHTML = `<div class="db-empty">Nothing in the last ${dashRange} days.
      Sessions, commits and spend appear here on their own — there is nothing to fill in.</div>`;
  } else {
    spine.innerHTML = days.map((d) =>
      dayHtml(d, summaries.get(d.key) ?? null, deterministicHeadline(d), openDays.has(d.key))).join("");
  }

  $("dashAside").innerHTML =
    checkoutsCard(heads, liveIn, folderDirty)
    + notesCard(noteList(root()))
    + missingCard(tier, facts);

  const ovl = $("dashOverlay");
  ovl.classList.toggle("show", openView !== null);
  if (openView === "checkouts") ovl.innerHTML = checkoutsOverlay(heads, liveIn, folderDirty);
  else if (openView === "notes") ovl.innerHTML = notesOverlay(noteList(root()), canShare(tier));
}

/// Header for the dashboard. Name and location only — no branch chip and no session
/// title, because a project has neither, and no History/Terminal/Run because those act
/// on the project and live in the inspector. The header acts on what is on the stage.
export function renderDashHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = false;
  $("hProj").textContent = name();
  const hb = $("hBranch");
  hb.hidden = true;
  $("hTitle").textContent = "";
  $("hPath").textContent = root();
}

export function renderDashInspector(): void {
  const pill = $("iPill");
  const n = liveHere().length;
  pill.className = n ? "pill working" : "pill idle";
  $("iPillTxt").textContent = n ? `${n} live` : "project";
  const live = liveHere().map((s) => ({
    id: s.id,
    label: s.title || s.branch || "session",
    glyph: GLYPH[statusKey(s)] ?? "○",
    cls: GCLASS[statusKey(s)] ?? "g-idle",
    ctx: s.ctxPct != null ? `${Math.round(s.ctxPct)}%` : "",
  }));
  $("inspector").innerHTML = dashInspector(root(), tier, facts, live, hasDigest);
  $("dashStrip").innerHTML = dashStrip(accentFor(root()), (name()[0] || "?").toUpperCase(), tier,
    live.map((s) => ({ id: s.id, glyph: s.glyph, cls: s.cls, label: s.label })));
}

// ---------- open / close ----------
export function openDashboard(project: string, path: string): void {
  const changed = root() !== path;
  setMirror({ kind: "dash", root: path, name: project });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = true;
  ($("dashPane") as HTMLElement).hidden = false;
  document.documentElement.style.setProperty("--accent", accentFor(path));
  if (changed) { days = []; heads = []; facts = null; openDays.clear(); openView = null; }
  host.renderAll();
  void loadDash();
}

export function closeDashboard(): void {
  if (!dashMirror()) return;
  setMirror(null);
  openView = null;
  ($("dashPane") as HTMLElement).hidden = true;
  // The collapsed rail is a dashboard-only mode: left set, the next session would get
  // a 44px inspector holding the wrong buttons.
  $("app").classList.remove("insp-mini");
}

/// Esc steps out one layer at a time — the enlarge overlay first, then the pane. Same
/// rule as the commit graph's message overlay, which is why main.ts calls this rather
/// than closeDashboard.
export function dashEscape(): boolean {
  if (!dashMirror()) return false;
  if (openView) { openView = null; renderDash(); return true; }
  closeDashboard();
  host.renderAll();
  return true;
}

// ---------- events ----------
/// One delegated listener on the pane, bound once at import: the contents are
/// re-rendered wholesale on every change, so per-element handlers would be rebound on
/// each repaint and leak.
export function wireDashboard(): void {
  $("dashPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const range = t.closest<HTMLElement>("[data-dashrange]");
    if (range) { setDashRange(+range.dataset.dashrange!); return; }

    const more = t.closest<HTMLElement>("[data-dashopen]");
    if (more) {
      const k = more.dataset.dashopen!;
      if (openDays.has(k)) openDays.delete(k); else openDays.add(k);
      renderDash();
      return;
    }
    const view = t.closest<HTMLElement>("[data-dashopen-view]");
    if (view) { openView = view.dataset.dashopenView as typeof openView; renderDash(); return; }
    if (t.closest("[data-dashclose-view]")) { openView = null; renderDash(); return; }

    const drop = t.closest<HTMLElement>("[data-dashdrop]");
    if (drop) { removeNote(drop.dataset.dashdrop!); renderDash(); return; }
    const disp = t.closest<HTMLElement>("[data-dashdispatch]");
    if (disp) { void dispatchNote(disp.dataset.dashdispatch!); return; }

    const wtadd = t.closest<HTMLElement>("[data-dashwtadd]");
    if (wtadd) { void host.launch(name(), wtadd.dataset.dashwtadd!, { colorKey: root() }); return; }
    const wtterm = t.closest<HTMLElement>("[data-dashwtterm]");
    if (wtterm) { host.openTerminal(wtterm.dataset.dashwtterm!); return; }
  });

  ($("dashJotHost") as HTMLElement).addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest("#dashJot");
    if (!form) return;
    e.preventDefault();
    const input = $("dashNote") as HTMLInputElement;
    if (addNote(input.value, root())) { input.value = ""; renderDash(); }
  });

  // The inspector and its collapsed strip both emit data-dashact; one handler for the
  // pair, bound on the persistent hosts rather than on the markup they rebuild.
  for (const id of ["inspector", "dashStrip"]) {
    $(id).addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-dashact]");
      if (!a || !dashMirror()) return;
      dashAction(a.dataset.dashact!);
    });
  }
}

function dashAction(act: string): void {
  const r = root(), n = name();
  if (act === "launch") void host.launch(n, r, { colorKey: r });
  else if (act === "worktree") host.openWorktreeDialog(n, r);
  else if (act === "terminal") host.openTerminal(r);
  else if (act === "run") host.openRun(r);
  else if (act === "graph") host.openGraph(r);
  else if (act === "history") host.openHistory(r);
  else if (act === "folder") host.openFolder(r);
  else if (act === "copypath") host.copyPath(r);
}

/// Turn a note into a running agent. The text is typed in **without a trailing
/// newline**: Episko prefills, the human presses Enter — the same rule as the
/// run-on-stop handoff, and for the same reason.
async function dispatchNote(id: string): Promise<void> {
  const n = noteList(root()).find((x) => x.id === id);
  if (!n) return;
  const sid = await host.launch(name(), root(), { colorKey: root() });
  removeNote(id);
  renderDash();
  if (typeof sid !== "string") { toast("Dispatched — the note is now a session"); return; }
  // Claude's REPL needs a moment before it will accept input. Failing to type is
  // harmless: the session is open and the note text is in the toast.
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: n.text.replace(/\n/g, " ") }).catch(() => {});
  }, 1400);
  toast("Dispatched — prefilled, press Enter to send");
}

/// Offer to start writing the shared work log. Called from the ⤢ notes overlay's
/// footer and from Settings; asks once per project because it creates a committable
/// file in someone's repo.
export async function enableDigest(): Promise<void> {
  const r = root();
  if (!r || !canShare(tier)) return;
  allowDigest(r);
  const done = [...summaries.entries()].filter(([k]) => days.some((d) => d.key === k && dayIsClosed(d)));
  for (const [k, line] of done) {
    await invoke("write_digest", { root: r, key: k, line, create: true }).catch((e) => dlog("warn", `digest: ${e}`));
  }
  hasDigest = true;
  toast(`Work log written to .episko/digest.md — commit it to share`);
  host.renderAll();
}
export const digestAllowed = (r: string) => digestOk().includes(r);
