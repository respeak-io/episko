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
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import {
  canShare, clampRange, DASH_RANGE_DEFAULT, dashDays, dashPulse, densePerDay,
  projectCost, projectTier, type ProjectFacts, type ProjectTier,
} from "./dash";
import {
  checkoutsCard, checkoutsOverlay, closeSheet, dashInspector, dashStrip, dayHtml,
  dispatchSheet, ghUnavailable, missingCard, notesCard, notesOverlay, pulseHtml,
  triageCard, triageOverlay, workCard, workLogOffer, workOverlay,
} from "./dashview";
import {
  ALLOW_ALL, claims, claimForSession, DEFAULT_POLICY, dropClaim, recordClaim,
  resolveClaim, type ClaimAllow, type ClaimPolicy,
} from "./claim";
import {
  bucketed, cardRows, closeComment, holderOf, isoDay, quietFor, staleCandidates,
  type GhResult, type GhThread, type KeptIssue,
} from "./ghwork";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote, type SharedNote } from "./notes";
import { GLYPH, GCLASS } from "./sidebarview";
import {
  deterministicHeadline, dayFacts, dayIsClosed, humanAuthors, projectDayFacts, sharedDay,
  type TrailCommit, type TrailDay,
} from "./trail";
import { statusKey, type WtHead } from "./types";
import { usageDetail, usageWindow } from "./usage";
import {
  accentFor, dashMirror, folderDirty, permMode, sessions, setActiveId, setMirror,
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
/// The GitHub half. `gh` is allowed to be missing, logged out, or pointed at a folder
/// that is not a GitHub repo — every one of those is `available: false` and a reason,
/// shown as one quiet row rather than as breakage.
let gh: GhResult = { available: false, reason: null, threads: [], viewer: null };
let kept: KeptIssue[] = [];
let allow: ClaimAllow = ALLOW_ALL;
/// The project's committed notes, and which of ours are in it.
let shared: SharedNote[] = [];
/// The confirm sheet currently up, if any. Both writes here are public, so neither
/// happens without showing exactly what will be written.
let sheet: { kind: "close" | "dispatch"; t: GhThread } | null = null;
/// What this dispatch would write, editable in the sheet before it is sent.
let policy: ClaimPolicy = { ...DEFAULT_POLICY, comment: true, label: "agent: running" };
/// Generated summaries for the open project, keyed by day. Separate from `days` so a
/// reload doesn't drop sentences already paid for in this session.
///
/// **Your** day: built from your sessions and your spend, so it is not reproducible by
/// anyone else and never reaches a file. See `teamSummaries` for the other half.
const summaries = new Map<string, string>();
/// The **project's** day, keyed by day: commits and pull requests only. This is the half
/// that goes into `.episko/digest.md`, and the half a colleague's copy can hand back —
/// which is why `loadDash` seeds it from the committed file before generating anything.
const teamSummaries = new Map<string, string>();
/// Which day rows are expanded. Survives a re-render because it is keyed by day, not
/// by element — the pane rebuilds its innerHTML on every repaint.
const openDays = new Set<string>();
/// Which enlarge overlay is up, if any.
let openView: "checkouts" | "notes" | "work" | "triage" | null = null;

const root = () => dashMirror()?.root ?? "";
const name = () => dashMirror()?.name ?? "";

/**
 * What ＋ Session needs to know, when the dashboard is what's on stage.
 *
 * `requestLaunch` opens the worktree dialog only for a folder it can already tell is a
 * repo, and its two zero-IPC signals — a live session's `branch`, `dirtyByFolder` —
 * both only cover folders something is *running* in. A dashboard is the opposite case:
 * you opened it precisely because nothing is. But it has already paid for
 * `project_facts` and `worktree_heads` for this exact folder, so the answer is on
 * screen; asking git a third time would be a second answer to a settled question.
 *
 * `null` while the first load is still in flight (`openDashboard` clears `facts` on a
 * project change, so this can never be the *previous* project's answer) — the caller
 * then falls back to what it did before, which is a plain launch in the project root.
 */
export function dashLaunchHint(): { branch: string } | null {
  if (!dashMirror() || !facts?.is_repo) return null;
  return { branch: heads.find((h) => h.is_main)?.branch ?? "" };
}

// ---------- data ----------
async function loadDash(): Promise<void> {
  const r = root();
  if (!r) return;
  loading = true;
  summaries.clear();
  teamSummaries.clear();
  renderDash();
  try {
    // `project_facts` first and alone: it decides which of the calls below are even
    // worth making, and a folder that isn't a repo must not be asked for a git log.
    facts = await invoke<ProjectFacts>("project_facts", { dir: r }).catch(() => null);
    tier = projectTier(facts);
    const wantGit = tier !== "none";
    const [hist, commits, wt, digest, sn] = await Promise.all([
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
      wantGit ? invoke<SharedNote[]>("list_shared_notes", { root: r }).catch(() => [] as SharedNote[])
              : Promise.resolve([] as SharedNote[]),
    ]);
    shared = sn;
    heads = wt.filter((w) => w.exists);
    // The GitHub half, only for a repo that has a GitHub remote. Fired after the
    // cheap local reads rather than alongside them: `gh` is a process per call and
    // the timeline should paint without waiting for the network.
    if (tier === "github") {
      void loadGh(r);
    } else {
      gh = { available: false, reason: null, threads: [], viewer: null };
      kept = [];
    }
    // The digest carries the PROJECT's line, not yours — that is the whole point of the
    // split, and seeding `summaries` from it would put a colleague's sentence where your
    // own day belongs while suppressing the one you'd have generated.
    for (const [k, v] of Object.entries(digest)) if (v) teamSummaries.set(k, v);
    hasDigest = Object.keys(digest).length > 0
      || (wantGit && await invoke<boolean>("has_digest", { root: r }).catch(() => false));
    days = dashDays(r, hist, commits, usageWindow(dashRange), (k) => projectCost(usageDetail, k, name()));
  } finally {
    loading = false;
  }
  renderDash();
  if (dashSummaries) void runSummaryQueue();
}

/// Issues, PRs, the project's keep list and its claim ceiling. Separate from
/// `loadDash` so a slow or absent `gh` never delays the timeline.
async function loadGh(r: string, force = false): Promise<void> {
  const [res, k, a] = await Promise.all([
    invoke<GhResult>("gh_threads", { root: r, force }).catch((e) => ({
      available: false, reason: String(e), threads: [], viewer: null,
    } as GhResult)),
    invoke<KeptIssue[]>("list_kept", { root: r }).catch(() => [] as KeptIssue[]),
    invoke<ClaimAllow>("claim_policy", { root: r }).catch(() => ALLOW_ALL),
  ]);
  if (root() !== r) return;   // the user moved on while this was in flight
  gh = res; kept = k; allow = a;
  renderDash();
}

/**
 * Ask for the missing summaries **one at a time**.
 *
 * Each one spawns a `claude -p`; firing a fortnight of those at once would put
 * fourteen CLI processes on the machine at the moment the user clicked a project,
 * which is exactly the kind of thing that makes an app feel like it took the machine
 * away. Sequential is also self-throttling: navigating away stops the queue.
 *
 * A request that arrives while a pass is in flight is **deferred, never dropped**.
 * Dropping it stranded a whole visit: open project A, click project B while A's live
 * call is still awaiting, and B's call here returned at the guard — after which A's
 * loop broke out on `root() !== r`, cleared the flag, and nothing ever restarted. B
 * then showed deterministic headlines for the rest of the visit with a full cache
 * sitting on disk.
 */
let queueRunning = false;
/// Set when a pass was asked for while one was running; the loop below re-runs for it.
let queueAgain = false;
async function runSummaryQueue(): Promise<void> {
  if (queueRunning) { queueAgain = true; return; }
  queueRunning = true;
  try {
    do {
      // Cleared *before* the pass, so a request arriving during it is not swallowed by
      // the pass that was already under way when it came in.
      queueAgain = false;
      await summaryPass();
    } while (queueAgain && dashMirror() && dashSummaries);
  } finally {
    queueRunning = false;
  }
}

/**
 * One pass over the open project's days, in two stages.
 *
 * **Stage 1 is your own line for every day; stage 2 is the project's.** That order is
 * not cosmetic: yours is the day's headline, so filling it first is what makes the
 * timeline look answered, and the project's line is usually already in hand — a pulled
 * `digest.md` seeded it, so stage 2 costs nothing on a repo somebody has been keeping.
 *
 * Within each stage, **closed days first and the open one last** — the difference
 * between a timeline that fills instantly and one that looks unsummarised. A closed day
 * is answered from disk in about a millisecond, while today is `force`d and costs a real
 * model call (up to `TIMEOUT`, and a wedged CLI spends all of it). `days` is newest
 * first, so today led the queue and held six free sentences behind one paid one.
 *
 * `now` is pinned for the pass so the partition and each day's `force` cannot disagree
 * about which day is today if the queue happens to cross midnight.
 */
async function summaryPass(): Promise<void> {
  const r = root();
  const now = Date.now();
  const ordered = [...days.filter((d) => dayIsClosed(d, now)), ...days.filter((d) => !dayIsClosed(d, now))];
  for (const d of ordered) if (!await summariseDay(d, r, now, "me")) return;
  for (const d of ordered) if (!await summariseDay(d, r, now, "project")) return;
}

/**
 * One day, one scope. Returns false when the pass should stop entirely.
 *
 * The two scopes differ in three ways and share everything else, which is why they are
 * one function: what record is built, where the answer is kept, and whether it is
 * written to the repo.
 */
async function summariseDay(d: TrailDay, r: string, now: number, scope: "me" | "project"): Promise<boolean> {
  if (!dashMirror() || root() !== r || !dashSummaries) return false;   // left, or switched off
  const mine = scope === "me";
  const into = mine ? summaries : teamSummaries;
  if (into.has(d.key)) return true;                            // cache or digest already had it
  const closed = dayIsClosed(d, now);
  const allowed = digestOk().includes(r);
  // **The project's line is only bought if something will do with it.** It is shown when
  // the day had more than one human committer, and written when this project keeps a
  // digest; a project that does neither would otherwise pay for a sentence nobody sees
  // and nothing stores. Saying yes to the work log re-runs the queue, which is when the
  // days skipped here get bought and written.
  if (!mine && !sharedDay(d) && !(canShare(tier) && (allowed || hasDigest))) return true;
  // The project's line is only ever about commits, so a day with none has nothing to
  // say and must not be asked — an empty record would spend a call on "quiet day".
  const f = mine ? dayFacts(d) : projectDayFacts(d);
  if (!f.trim()) return true;
  try {
    const line = await invoke<string>("summarize_day", {
      root: r, key: d.key, facts: f, model: "haiku", scope, force: !closed,
    });
    // The project can change while a call is in flight, and both maps are module state
    // the new one has already cleared for itself. Checking only on entry lets this
    // answer land in the *next* project's map under the same day key — where nothing
    // overwrites it, because a pass skips a day it already has.
    if (root() !== r) return false;
    if (!line) return true;
    into.set(d.key, line);
    renderDash();
    // Share it — and only ever this half. A day still being written is not written to
    // the repo either: today's line changes as the day goes on, and each change would
    // dirty a tracked file.
    //
    // **Creating the file needs a yes; contributing to one does not.** A digest already
    // in the repo is a decision the project has taken — somebody wrote and committed it
    // — so a teammate who pulls it should not have to re-consent before their days join
    // it, or the file quietly becomes one person's diary. Hence `create` carries the
    // consent and the condition does not.
    if (!mine && canShare(tier) && closed && (allowed || hasDigest)) {
      void invoke("write_digest", { root: r, key: d.key, line, create: allowed }).catch(() => {});
    }
  } catch (e) {
    // No summary is a fine state — the deterministic headline already reads correctly —
    // so a failure is logged and the loop moves on.
    dlog("warn", `dash: ${scope} summary for ${d.key} failed — ${e}`);
  }
  return true;
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
    // The offer counts closed days with commits — what a work log *would* carry, not
    // what has already been generated. The two differ on purpose: the project's line for
    // a solo day is deliberately not bought until somebody wants a digest, so counting
    // sentences in hand would hide the offer on exactly the projects that have never
    // been asked. A project that has said yes, or already has a digest, is past the
    // question — from there on the queue contributes on its own.
    const unshared = canShare(tier) && !hasDigest && !digestOk().includes(root())
      ? days.filter((d) => dayIsClosed(d) && d.commits.length > 0).length
      : 0;
    spine.innerHTML = days.map((d) =>
      dayHtml(d, summaries.get(d.key) ?? null, deterministicHeadline(d), openDays.has(d.key),
        // Written for every day, shown only where it says something your own line
        // doesn't — see `sharedDay`.
        sharedDay(d) ? teamSummaries.get(d.key) ?? null : null, humanAuthors(d))).join("")
      + workLogOffer(unshared);
  }

  const now = Date.now();
  const holder = (t: GhThread) => holderOf(t, gh.viewer, claims.filter((c) => c.root === root()), now);
  const stale = staleCandidates(gh.threads, kept, now).map((t) => ({ t, why: quietFor(t.updated_at, now) }));
  const prs = gh.threads.filter((t) => t.kind === "pr").length;

  $("dashAside").innerHTML =
    (gh.available ? workCard(cardRows(gh.threads), gh.threads.length, prs, holder) : "")
    + (gh.available ? triageCard(stale, gh.threads.filter((t) => t.kind === "issue").length) : "")
    + checkoutsCard(heads, liveIn, folderDirty)
    + notesCard(noteList(root()))
    + (tier === "github" && !gh.available && gh.reason ? ghUnavailable(gh.reason) : "")
    + missingCard(tier, facts);

  const ovl = $("dashOverlay");
  ovl.classList.toggle("show", openView !== null);
  ovl.dataset.view = openView ?? "";
  if (openView === "checkouts") ovl.innerHTML = checkoutsOverlay(heads, liveIn, folderDirty);
  else if (openView === "notes") {
    const mineShared = new Set(shared.map((n) => n.id));
    // A colleague's note is theirs; ours are the ones we can promote or withdraw.
    const theirs = shared.filter((n) => !noteList(root()).some((x) => x.id === n.id));
    ovl.innerHTML = notesOverlay(noteList(root()), theirs, mineShared, canShare(tier));
  }
  else if (openView === "work") ovl.innerHTML = workOverlay(bucketed(gh.threads, now), facts?.slug ?? name(), gh.threads.length, holder);
  else if (openView === "triage") ovl.innerHTML = triageOverlay(stale, kept, canShare(tier));

  const sh = $("dashSheet");
  sh.classList.toggle("show", sheet !== null);
  $("dashScrim").classList.toggle("show", sheet !== null);
  if (sheet?.kind === "close") sh.innerHTML = closeSheet(sheet.t, closeComment(sheet.t, now), facts?.slug ?? name());
  else if (sheet?.kind === "dispatch") {
    sh.innerHTML = dispatchSheet(sheet.t, policy, allow, permMode, holder(sheet.t));
  }
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
  if (sheet) { sheet = null; renderDash(); return true; }
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
    if (t.closest("[data-dashworklog]")) { void enableDigest(); return; }

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

    // ---- the GitHub half ----
    const work = t.closest<HTMLElement>("[data-dashwork]");
    if (work) {
      const th = gh.threads.find((x) => x.number === +work.dataset.dashwork!);
      // Never straight to a dispatch: it sends a prompt AND writes to a public repo.
      if (th) { sheet = { kind: "dispatch", t: th }; renderDash(); }
      return;
    }
    const close = t.closest<HTMLElement>("[data-dashclose]");
    if (close) {
      const th = gh.threads.find((x) => x.number === +close.dataset.dashclose!);
      if (th) { sheet = { kind: "close", t: th }; renderDash(); }
      return;
    }
    const keep = t.closest<HTMLElement>("[data-dashkeep]");
    if (keep) { void setKept(+keep.dataset.dashkeep!, true); return; }
    const unkeep = t.closest<HTMLElement>("[data-dashunkeep]");
    if (unkeep) { void setKept(+unkeep.dataset.dashunkeep!, false); return; }
    const share = t.closest<HTMLElement>("[data-dashshare]");
    if (share) { void toggleShare(share.dataset.dashshare!); return; }
    const dtext = t.closest<HTMLElement>("[data-dashdispatchtext]");
    if (dtext) { void dispatchText(dtext.dataset.dashdispatchtext!); return; }
    const claimSw = t.closest<HTMLElement>("[data-dashclaim]");
    if (claimSw) { togglePolicy(claimSw.dataset.dashclaim!); return; }
    // A row's title opens it on GitHub — Episko mirrors a little of it, never all.
    const url = t.closest<HTMLElement>("[data-dashurl]");
    if (url?.dataset.dashurl) { void openUrl(url.dataset.dashurl).catch(() => {}); return; }
  });

  // The sheets live outside #dashPane (they sit over the whole stage), so they get
  // their own delegated handler.
  $("dashSheet").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dashsheet]");
    if (!b) return;
    const act = b.dataset.dashsheet!;
    if (act === "cancel") { sheet = null; renderDash(); return; }
    if (act === "close") { void doClose(); return; }
    if (act === "dispatch") { void doDispatch(); return; }
  });
  $("dashScrim").addEventListener("click", () => { sheet = null; renderDash(); });

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
  else if (act === "worklog") void enableDigest();
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

/// One switch in the dispatch sheet. The project's ceiling wins: a switch the project
/// has turned off is shown greyed and does nothing, rather than being hidden — "why
/// can't I assign?" needs an answer, and an absent control gives none.
function togglePolicy(k: string): void {
  const r = resolveClaim(policy, allow);
  if (k === "assign" && r.assign.source !== "project") policy = { ...policy, assign: !policy.assign };
  else if (k === "comment" && r.comment.source !== "project") policy = { ...policy, comment: !policy.comment };
  else if (k === "pushBranch" && r.pushBranch.source !== "project") policy = { ...policy, pushBranch: !policy.pushBranch };
  else if (k === "label" && r.label.source !== "project") {
    policy = { ...policy, label: policy.label ? "" : "agent: running" };
  }
  renderDash();
}

/// Close an issue: comment, then close. **The only destructive write Episko makes to
/// GitHub**, which is why it has a permanent confirm sheet and an editable comment —
/// a stale-close with no reason is the bot behaviour that gets a feature switched off.
async function doClose(): Promise<void> {
  if (sheet?.kind !== "close") return;
  const t = sheet.t, r = root();
  const comment = ($("dashCloseText") as HTMLTextAreaElement | null)?.value ?? "";
  sheet = null;
  renderDash();
  try {
    await invoke("gh_close_issue", { root: r, number: t.number, comment });
    toast(`#${t.number} closed`);
    await loadGh(r, true);
  } catch (e) {
    toast(`Could not close #${t.number}: ${e}`);
  }
}

/// Keep an issue, or take it back off the list. Committed, so it needs the same
/// create-gate as the digest — and it is reviewable and undoable in the ⤢ view because
/// a committed decision nobody can see is worse than no decision.
async function setKept(number: number, keep: boolean): Promise<void> {
  const r = root();
  const who = gh.viewer || "someone";
  try {
    await invoke("set_kept", { root: r, number, who, at: isoDay(Date.now()), keep, create: true });
    kept = await invoke<KeptIssue[]>("list_kept", { root: r }).catch(() => kept);
    toast(keep ? `#${number} kept — nobody on the team is asked again` : `#${number} back in triage`);
    renderDash();
  } catch (e) {
    toast(`Could not write .episko/episko.toml: ${e}`);
  }
}

/// Start an agent on a thread, and say so where colleagues can see it.
///
/// **The prompt is sent**, which breaks the app's usual "Episko prefills, the human
/// presses Enter" rule — deliberately, and only here: that rule exists so nothing is
/// sent you did not read, and a dispatch you confirmed in a sheet *is* the reading.
///
/// The claim is written after the session exists, never before: a claim for an agent
/// that failed to start is worse than no claim, because it stops a colleague picking
/// the work up.
async function doDispatch(): Promise<void> {
  if (sheet?.kind !== "dispatch") return;
  const t = sheet.t, r = root(), n = name();
  sheet = null;
  renderDash();
  const sid = await host.launch(n, r, { colorKey: r });
  if (typeof sid !== "string") { toast("Could not start a session"); return; }

  const eff = resolveClaim(policy, allow);
  if (eff.assign.value || eff.comment.value || eff.label.value || eff.pushBranch.value) {
    void invoke("gh_claim", {
      root: r, number: t.number, kind: t.kind === "pr" ? "pr" : "issue",
      assign: eff.assign.value, comment: eff.comment.value,
      label: eff.label.value, pushBranch: eff.pushBranch.value,
    }).then(() => {
      recordClaim({ threadId: `${r}#${t.number}`, root: r, number: t.number,
        kind: t.kind === "pr" ? "pr" : "issue", sessionId: sid, at: Date.now() });
      void loadGh(r, true);
    }).catch((e) => { dlog("warn", `claim #${t.number} failed — ${e}`); });
  }

  // Sent, not prefilled — see the note above.
  setTimeout(() => {
    const prompt = `Work on ${t.kind === "pr" ? "PR" : "issue"} #${t.number}: ${t.title}\n${t.url}`;
    void invoke("write_pty", { sessionId: sid, data: prompt.replace(/\n/g, " ") + "\r" }).catch(() => {});
  }, 1400);
  toast(`Started on #${t.number}`);
}

/// A session that took a claim has ended — hand the work back, so a colleague is not
/// looking at a claim for an agent that stopped hours ago.
export function releaseClaimFor(sessionId: string): void {
  const rec = claimForSession(sessionId);
  if (!rec) return;
  dropClaim(rec.threadId);
  void invoke("gh_release", { root: rec.root, number: rec.number, kind: rec.kind }).catch(() => {});
}

/// Promote a note into the project, or take it back out. Sharing needs *git*, not
/// GitHub — this is a file, and a file only means anything to a team if it can be
/// committed.
async function toggleShare(id: string): Promise<void> {
  const r = root();
  const n = noteList(r).find((x) => x.id === id);
  if (!n) return;
  const on = shared.some((x) => x.id === id);
  try {
    await invoke("set_shared_note", {
      root: r, id, text: n.text, who: gh.viewer || "someone",
      at: isoDay(Date.now()), share: !on, create: true,
    });
    shared = await invoke<SharedNote[]>("list_shared_notes", { root: r }).catch(() => shared);
    toast(on ? "Note is yours again" : "Shared — commit .episko/notes.toml to send it");
    renderDash();
  } catch (e) {
    toast(`Could not write .episko/notes.toml: ${e}`);
  }
}

/// Start an agent on a colleague's shared note. Prefilled, NOT sent — this is somebody
/// else's sentence, so the person dispatching it reads it before it goes.
async function dispatchText(text: string): Promise<void> {
  const sid = await host.launch(name(), root(), { colorKey: root() });
  if (typeof sid !== "string") return;
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: text.replace(/\n/g, " ") }).catch(() => {});
  }, 1400);
  toast("Dispatched — prefilled, press Enter to send");
}

/**
 * Start writing the shared work log for this project.
 *
 * Reached from the offer at the foot of the timeline and from the inspector's *Share
 * the work log…*. Asked once per project, because creating a committable file in
 * someone's repo is a real side effect — the same stance `tasks.rs` takes with
 * `tasks.toml`.
 *
 * Every closed day whose **project** line is already in hand is written at once, so the
 * first commit carries the history instead of starting blank at today; the rest are
 * bought by the re-run at the end, because a solo day's line is deliberately not
 * generated until somebody wants a digest. `teamSummaries`, never `summaries`: your own
 * line is built from facts nobody else has and does not go in a file — that split is the
 * reason the digest is worth committing at all.
 */
export async function enableDigest(): Promise<void> {
  const r = root();
  if (!r || !canShare(tier)) return;
  allowDigest(r);
  const done = [...teamSummaries.entries()].filter(([k]) => days.some((d) => d.key === k && dayIsClosed(d)));
  // Consent with nothing written yet is still consent: the re-run below buys and writes
  // each remaining day, so this is a state to explain rather than a failure.
  if (!done.length) {
    toast("Work log on — .episko/digest.md is written as each day is summarised");
    host.renderAll();
    void runSummaryQueue();
    return;
  }
  let wrote = 0;
  for (const [k, line] of done) {
    const ok = await invoke("write_digest", { root: r, key: k, line, create: true })
      .then(() => true)
      .catch((e) => { dlog("warn", `digest: ${e}`); return false; });
    if (ok) wrote++;
  }
  // Only claim the file exists once a write has landed. `hasDigest` drives both the
  // `.episko/ shared` chip and whether the queue contributes without asking again, so
  // setting it after a failed create would assert a file that isn't there.
  if (!wrote) { toast("Could not write .episko/digest.md"); return; }
  hasDigest = true;
  toast("Work log written to .episko/digest.md — commit it to share");
  host.renderAll();
  // The days this project never bought a shared line for — the solo ones — now have a
  // file to go in. The queue writes each as it lands rather than blocking the toast on
  // a run of model calls.
  void runSummaryQueue();
}
export const digestAllowed = (r: string) => digestOk().includes(r);
