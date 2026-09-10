// The project dashboard: the pane, its IPC, the summary queue and the delegated events.
// ./dash owns the rules, ./dashview the markup. Nothing here runs until a project is
// clicked: no probe at startup, nothing on renderAll's path. See docs/dashboard.md.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, takeStage, toast } from "./dom";
import { readList } from "./store";
import { basename } from "./format";
import { ask } from "./confirm";
import { dlog } from "./debug";
import {
  canShare, clampRange, DASH_RANGE_DEFAULT, dashDays, dashPulse, densePerDay,
  mainCheckout, projectCost, projectTier, type ProjectFacts, type ProjectTier,
  type SyncOp,
} from "./dash";
import {
  branchesOverlay, cardSkeleton, checkoutsCard, closeSheet, dashInspector,
  dashStrip, dayHtml, dispatchSheet, ghUnavailable, missingCard, notesCard, notesOverlay,
  pulseHtml, pulseSkeleton, repoCard, spineSkeleton, triageCard, triageOverlay, workCard,
  workLogOffer, worksetCard, workOverlay, type CleanReport, type DashSync,
} from "./dashview";
import { openBranchPop } from "./bpop";
import {
  branchRows, checkoutRows, chosenCheckouts, chosenWorktrees, filterRows, localPicks, lockText,
  NO_PROTECT, orderRows, rangePick, removableCheckouts, remoteFor, remotePicks, selectable,
  switchable, switchOptions, trunkOf, trunkOptions, type BranchFilter, type BranchInfo,
  type BranchRow, type CheckoutRow, type MergedPrs, type ProtectCtx, type SweepResult,
  type WtInfo,
} from "./branches";
import { openBranchMenu } from "./projmenu";
import {
  ALLOW_ALL, claims, claimForSession, DEFAULT_POLICY, dropClaim, recordClaim,
  resolveClaim, type ClaimAllow, type ClaimOutcome, type ClaimPolicy,
} from "./claim";
import {
  bucketed, cardRows, claimComment, closeComment, ghWho, holderOf, isoDay, quietFor,
  releaseComment, staleCandidates, type GhResult, type GhThread, type KeptIssue,
} from "./ghwork";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote, type SharedNote } from "./notes";
import { GLYPH, GCLASS } from "./sidebarview";
import {
  deterministicHeadline, dayFacts, dayIsClosed, humanAuthors, projectDayFacts, sharedDay,
  type TrailCommit, type TrailDay,
} from "./trail";
import { statusKey, type GitActionResult, type WorkingSet, type WtHead } from "./types";
import { usageDetail, usageWindow } from "./usage";
import {
  accentFor, cmpBase, dashMirror, dirtyByFolder, effectiveAgent, externals, ghAccountFor, ghLogins,
  permissionModeFor, removingWt, sessions, setActiveId, setMirror,
} from "./state";
import { providerPermissionMode } from "./providers";
import { copyText, refreshGhAccounts } from "./actions";

// What this pane does but does not own; one host object rather than a dozen setters.
export interface DashHost {
  // `string | null`, never `unknown`: call sites guard on `typeof sid !== "string"`, and
  // a `void`-returning launch would make all of them take the failure branch silently.
  launch: (project: string, workdir: string, opts?: { colorKey?: string; agent?: string; worktree?: string | null; branch?: string }) => Promise<string | null>;
  // What a person's ＋ wants: the new-session dialog on a repo, a plain launch elsewhere.
  // `launch` above is the unconditional verb a dispatch wants.
  requestLaunch: (project: string, path: string, known: { branch: string } | null) => void;
  openTerminal: (dir: string) => void;
  // Prefill, never run: `git_action` refuses what it cannot finish safely and names the
  // command that would; this is where that command goes.
  handToTerminal: (project: string, dir: string, cmd: string) => void;
  // The switch itself; every guard lives behind it (./worktree's `switchCheckout`).
  switchBranch: (project: string, dir: string, branch: string, base: string | null) => Promise<boolean>;
  openRun: (root: string) => void;
  openGraph: (root: string) => void;
  // The working-set overlay, on a folder. `focus` unfolds one file, as the explorer's ↵ does.
  openDiff: (workdir: string, title: string, focus?: string) => void;
  openHistory: (root: string) => void;
  openFolder: (dir: string) => void;
  copyPath: (dir: string) => void;
  setActive: (id: string) => void;
  renderAll: () => void;
  // ---- what the Branches view needs and this module doesn't own ----
  refreshGit: () => Promise<void>;   // re-read the ⑃ roster; renderAll only paints it
  saveTrunk: (repoDir: string, ref: string) => void;   // a stored preference, so the write is actions.ts's
  // Pin the project to a GitHub account (`null` follows gh's active one). A stored
  // preference like `saveTrunk`; the write also drops the previous account's cached reads.
  setGhAccount: (root: string, login: string | null) => void;
}
let host: DashHost = {
  launch: async () => null, requestLaunch: () => {}, openTerminal: () => {},
  switchBranch: async () => false,
  openRun: () => {}, openGraph: () => {}, openDiff: () => {}, openHistory: () => {}, openFolder: () => {},
  copyPath: () => {}, setActive: () => {}, renderAll: () => {},
  refreshGit: async () => {}, handToTerminal: () => {}, saveTrunk: () => {},
  setGhAccount: () => {},
};
export function setDashHost(h: DashHost) { host = h; }

// Gap between a dispatched prompt and its Enter: in one burst Claude's REPL treats the
// `\r` as a pasted newline rather than a submit.
const SUBMIT_MS = 250;

// ---------- preferences ----------
export let dashRange = clampRange(+(localStorage.getItem("cc-dash-range") || DASH_RANGE_DEFAULT));
export function setDashRange(n: number) {
  dashRange = clampRange(n);
  localStorage.setItem("cc-dash-range", String(dashRange));
  if (dashMirror()) void loadDash();
}
// Generated day summaries cost money, hence the switch.
export let dashSummaries = (localStorage.getItem("cc-dash-summaries") ?? "1") === "1";
export function setDashSummaries(on: boolean) {
  dashSummaries = on;
  localStorage.setItem("cc-dash-summaries", on ? "1" : "0");
  if (dashMirror()) { if (on) void runSummaryQueue(); else renderDash(); }
}
// Projects that said yes to creating `.episko/digest.md` (asked once, as tasks.rs does for tasks.toml).
const OK_KEY = "cc-digest-ok";
const digestOk = (): string[] => readList<string>(OK_KEY).filter((x) => typeof x === "string");
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
// The main checkout: its working set, and its position against the upstream as of the last
// fetch (stale on purpose; see `loadSync`). `WorkingSet extends DiffStat`, so the Repository
// card reads the same object the Working set card lists. Three states, ./state's map's own:
// `undefined` not read yet, `null` read and answerless (an unborn HEAD is a repo with no
// working set), a value. Merging the first two would skeleton a fresh `git init` forever.
let mainWork: WorkingSet | null | undefined;
// The remote op in flight and the folder it runs in; a path so that switching project
// mid-pull shows "Pulling…" only where it is true. One at a time app-wide, and never
// folded into `loading`: a write must not blank the timeline.
let syncing: { root: string; op: SyncOp } | null = null;
// Separate wait flags, not one `isLoading`: each starts and ends at a different moment
// and skeletons a different part of the screen.
let loading = false;                 // the local reads: facts, history, git log, digest
// Whether `project_facts` has answered for the project on screen. Not `loading`: a range
// change reloads the timeline without putting the tier back in doubt.
let factsKnown = false;
let ghLoading = false;               // the GitHub half, which lands after the local reads
// A missing, logged-out or non-GitHub `gh` is `available: false` plus a reason, shown as
// one quiet row rather than as breakage.
let gh: GhResult = { available: false, reason: null, threads: [], viewer: null };
let kept: KeptIssue[] = [];
let allow: ClaimAllow = ALLOW_ALL;
let shared: SharedNote[] = [];       // the project's committed notes
// The confirm sheet up, if any: both writes are public, so nothing is written unseen.
let sheet: { kind: "close" | "dispatch"; t: GhThread } | null = null;
/// What this dispatch would write, editable in the sheet before it is sent.
let policy: ClaimPolicy = { ...DEFAULT_POLICY, comment: true, label: "agent: running" };
// Generated summaries, keyed by day and kept apart from `days` so a reload keeps what was
// paid for. `summaries` is your day (your sessions and spend; never reaches a file);
// `teamSummaries` is the project's (commits and PRs; the half `.episko/digest.md` holds).
const summaries = new Map<string, string>();
const teamSummaries = new Map<string, string>();
const openDays = new Set<string>();   // keyed by day, so it survives the timeline repaint
let openView: "notes" | "work" | "triage" | "branches" | null = null;

/// ---- the Branches view ----------------------------------------------------------
// Read when the view opens, not with the dashboard: three git calls and a network one
// for a surface most visits never open. `null` means not read yet (the skeleton).
let branchData: { branches: BranchInfo[]; worktrees: WtInfo[] } | null = null;
// Both lists at once: the committed one refuses the delete (git.rs re-reads it), GitHub's is
// read-only evidence about the remote ref. `branchLock` decides which one a row is wearing.
let branchProtect: ProtectCtx = NO_PROTECT;
let branchPrs: MergedPrs | null = null;
let branchPrsLoading = false;
// Two sets, not one: the halves run different commands, so a tick on one side must not arm the other.
// One selection for one table; the scopes decide where a delete lands, never what may be
// ticked. `branchLast` anchors a shift-click against the order actually on screen.
let branchPick = new Set<string>();
let branchScopes = { local: true, remote: false };
let branchTab: "branches" | "checkouts" = "branches";
let branchFilter: BranchFilter = "all";
let branchQuery = "";
let branchLast = "";
let coPick = new Set<string>();
let branchBusy = false;
let branchResult: CleanReport | null = null;
// The one day out at the model right now; a value, not a set, because `runSummaryQueue` is sequential.
let writing: { key: string; scope: "me" | "project" } | null = null;
// Which half of a pass is running; lets a shared box be drawn before its sentence exists.
// Gated on the stage, not the queue, since stage 1 can be a fortnight of calls.
let stage: "me" | "project" | null = null;

const root = () => dashMirror()?.root ?? "";
const name = () => dashMirror()?.name ?? "";

// What ＋ Session needs when the dashboard holds the stage: `requestLaunch`'s zero-IPC
// signals only cover folders something is running in, and this pane has already paid
// for `project_facts` and `worktree_heads`. Null while the first load is in flight.
export function dashLaunchHint(): { branch: string } | null {
  if (!dashMirror() || !facts?.is_repo) return null;
  return { branch: heads.find((h) => h.is_main)?.branch ?? "" };
}

// ---------- data ----------
async function loadDash(): Promise<void> {
  const r = root();
  if (!r) { loading = false; return; }   // openDashboard already set loading
  loading = true;
  ghLoading = false;
  summaries.clear();
  teamSummaries.clear();
  renderDash();
  try {
    // `project_facts` first and alone: it decides which of the calls below are worth making.
    const f = await invoke<ProjectFacts>("project_facts", { dir: r }).catch(() => null);
    if (root() !== r) return;   // another project's load owns the state now
    facts = f;
    tier = projectTier(facts);
    factsKnown = true;
    // The GitHub half starts here, before the local reads: it is not awaited, and firing it
    // later would only queue the network behind the transcript scan.
    if (tier === "github") {
      ghLoading = true;
      void loadGh(r);
    } else {
      gh = { available: false, reason: null, threads: [], viewer: null };
      kept = [];
    }
    host.renderAll();   // the tier is painted by renderAll; say so before the slow reads below
    const wantGit = tier !== "none";
    const [hist, commits, wt, digest, sn] = await Promise.all([
      invoke<HistEntry[]>("list_session_history", { limit: 400 }).catch((e) => {
        dlog("warn", `dash: history scan failed: ${e}`);
        return [] as HistEntry[];
      }),
      wantGit ? invoke<TrailCommit[]>("git_log_days", { roots: [r], days: dashRange }).catch(() => [] as TrailCommit[])
              : Promise.resolve([] as TrailCommit[]),
      wantGit ? invoke<WtHead[]>("worktree_heads", { dir: r }).catch(() => [] as WtHead[])
              : Promise.resolve([] as WtHead[]),
      // the committed work log, read before anything is generated
      wantGit ? invoke<Record<string, string>>("read_digest", { root: r }).catch(() => ({}))
              : Promise.resolve({} as Record<string, string>),
      wantGit ? invoke<SharedNote[]>("list_shared_notes", { root: r }).catch(() => [] as SharedNote[])
              : Promise.resolve([] as SharedNote[]),
    ]);
    if (root() !== r) return;
    shared = sn;
    heads = wt.filter((w) => w.exists);
    if (wantGit) void loadSync(r); else mainWork = null;   // fired, not awaited: nothing else waits on it
    // The digest is the project's line, never yours: it seeds `teamSummaries` only.
    for (const [k, v] of Object.entries(digest)) if (v) teamSummaries.set(k, v);
    const anyDigest = Object.keys(digest).length > 0
      || (wantGit && await invoke<boolean>("has_digest", { root: r }).catch(() => false));
    if (root() !== r) return;   // a second await, so the stage may have moved again since
    hasDigest = anyDigest;
    days = dashDays(r, hist, commits, usageWindow(dashRange), (k) => projectCost(usageDetail, k, name()));
  } finally {
    if (root() === r) loading = false;   // guarded: the next project's load may be running
  }
  renderDash();
  if (dashSummaries) void runSummaryQueue();
}

// Re-read the GitHub half after the account preference changes (./actions calls back
// through here). Silent when the dashboard is closed or on another project.
export function reloadDashGh(r: string): void {
  if (!dashMirror() || r !== root()) return;
  ghLoading = true;
  renderDash();
  void loadGh(r, true);
}

// Issues, PRs, the keep list and the claim ceiling. Separate from `loadDash` so a slow
// or absent `gh` never delays the timeline.
async function loadGh(r: string, force = false): Promise<void> {
  // The account list rides along: the picker is drawn in the same pass as the result.
  const [res, k, a] = await Promise.all([
    invoke<GhResult>("gh_threads", { root: r, force, account: ghAccountFor(r) }).catch((e) => ({
      available: false, reason: String(e), threads: [], viewer: null,
    } as GhResult)),
    invoke<KeptIssue[]>("list_kept", { root: r }).catch(() => [] as KeptIssue[]),
    invoke<ClaimAllow>("claim_policy", { root: r }).catch(() => ALLOW_ALL),
    refreshGhAccounts(),
  ]);
  if (root() !== r) return;   // the user moved on while this was in flight
  ghLoading = false;   // inside the guard: a stale call must not take another project's skeleton down
  gh = res; kept = k; allow = a;
  renderDash();
}

// The main checkout against its remote, for ⇣ Pull and ⇡ Push, and the files behind the
// Working set card: one `git status --porcelain=v2 --branch` via `git_working_set`, and
// never a fetch, which could hang 45s on a dead remote. So the numbers are as old as the
// last fetch, and the verb fetches itself. `git_working_set` is `git_diffstat`'s own
// process with the entries kept, so naming the files costs nothing over counting them.
async function loadSync(r: string): Promise<void> {
  worksetSweptAt = Date.now();   // the gate is time since the last read, not since the last tick
  const g = await invoke<WorkingSet | null>("git_working_set", { workdir: mainCheckout(heads, r) })
    .catch(() => null);
  if (root() !== r) return;   // the user moved on while this was in flight
  mainWork = g;
  renderDash();   // the Repository and Working set cards are where this lands
}

// The working set goes stale under a running agent, and this pane runs nothing else on a
// schedule; main.ts drives it beside the sidebar dot's sweep. One local `git status` per
// sweep, only while a dashboard is up, and never across a git op that is mid-flight.
const WORKSET_SWEEP_MS = 15_000;
let worksetSweptAt = 0;
export function refreshDashWorkset(): void {
  const r = root();
  if (!r || !factsKnown || tier === "none" || syncing) return;
  if (Date.now() - worksetSweptAt < WORKSET_SWEEP_MS) return;
  void loadSync(r);
}

// Which checkout the Working set card reads, and what the overlay calls it.
const worksetDir = () => (root() ? mainCheckout(heads, root()) : "");
const worksetTitle = () => {
  const b = heads.find((h) => h.is_main)?.branch ?? "";
  return b ? `${name()} · ${b}` : name();
};

// Null until the tier is known, so the card never appears then vanishes on a non-repo;
// `busy` is keyed to this project, so a fetch in one repo cannot grey another's buttons.
function syncNow(): DashSync | null {
  if (!factsKnown || tier === "none") return null;
  return {
    branch: heads.find((h) => h.is_main)?.branch ?? "",
    g: mainWork ?? null,
    busy: syncing?.root === root() ? syncing.op : "",
  };
}

// Pull or push the main checkout. Fetch first, always: nothing here runs git on a schedule,
// and `git_action` short-circuits on a stale ahead/behind. Anything unsafe is refused by
// the backend, which hands back the working command as `suggest`.
async function syncMain(op: SyncOp): Promise<void> {
  const r = root(), n = name();
  if (!r || syncing || tier === "none") return;
  const dir = mainCheckout(heads, r);
  syncing = { root: r, op };
  renderDash();
  let reloading = false;   // the pane is being re-read; skip the finally's re-probe
  let settled = false;     // mainWork already holds the post-op truth
  // A refusal is not an error: the backend names the command that would work, so hand it
  // over. `verb` rather than `op` because the opening fetch reports under its own name.
  const report = (verb: string, res: GitActionResult): boolean => {
    dlog(res.ok ? "info" : "warn", `dash git ${verb} · ${n} · ${res.summary}`);
    if (res.ok) { toast(`${verb}: ${res.summary}`); return true; }
    if (res.suggest) {
      toast(`${verb}: ${res.summary} → opening a terminal`);
      host.handToTerminal(n, dir, res.suggest);
    } else toast(`${verb}: ${res.summary}`);
    return false;
  };
  try {
    if (!report("fetch", await invoke<GitActionResult>("git_action", { workdir: dir, op: "fetch" }))) return;
    // `upstream` separates the two zeroes: a branch that tracks nothing also reads 0 behind
    // and 0 ahead, and the backend's refusal is what names the `--set-upstream-to`.
    const g = await invoke<WorkingSet | null>("git_working_set", { workdir: dir }).catch(() => null);
    if (root() !== r) return;
    mainWork = g;
    if (g?.upstream && (op === "pull" ? g.behind === 0 : g.ahead === 0)) {
      toast(op === "pull"
        ? `pull: already up to date with ${g.upstream}`
        : `push: nothing to send to ${g.upstream}`);
      settled = true;
      return;
    }
    if (!report(op, await invoke<GitActionResult>("git_action", { workdir: dir, op }))) return;
    // A pull can bring a colleague's digest and notes, so it re-reads the whole pane; a
    // push changes nothing the timeline reads, and the finally re-reads the counts.
    if (op === "pull" && root() === r) { reloading = true; void loadDash(); }
  } catch (e) {
    dlog("error", `dash ${op} failed: ${e}`);
    toast(`git ${op}: ${e}`);
  } finally {
    syncing = null;
    if (root() === r) {
      if (!reloading && !settled) void loadSync(r);   // a failed fetch must not leave the old numbers up
      renderDash();
    }
  }
}

// The ⑃ dialog switched this project's main checkout. Half the pane reads through HEAD
// (the git log, the ⇣ ⇡ rows, the Checkouts card), so this is the same full re-read a
// pull does. Guarded on the project: the dialog is reachable from the sidebar too.
export function dashBranchSwitched(repoDir: string): void {
  if (!dashMirror() || root() !== repoDir) return;
  void loadDash();
}

// Ask for the missing summaries one at a time: each spawns a `claude -p`, and navigating
// away stops the queue. A request arriving mid-pass is deferred, never dropped, or a
// project opened while another's call is in flight never gets its summaries.
let queueRunning = false;
let queueAgain = false;   // a pass was asked for while one ran; the loop re-runs
async function runSummaryQueue(): Promise<void> {
  if (queueRunning) { queueAgain = true; return; }
  queueRunning = true;
  try {
    do {
      queueAgain = false;   // cleared before the pass, so a request during it is not swallowed
      await summaryPass();
    } while (queueAgain && dashMirror() && dashSummaries);
  } finally {
    queueRunning = false;
    renderDash();   // a pass answered from cache never renders on its own
  }
}

// One pass, two stages: your line for every day (the headline), then the project's. Within
// each, closed days first: they answer from disk, while today is forced and costs a model
// call. `now` is pinned so the partition and each day's `force` agree across midnight.
async function summaryPass(): Promise<void> {
  const r = root();
  const now = Date.now();
  const ordered = [...days.filter((d) => dayIsClosed(d, now)), ...days.filter((d) => !dayIsClosed(d, now))];
  try {
    stage = "me";
    for (const d of ordered) if (!await summariseDay(d, r, now, "me")) return;
    stage = "project";
    renderDash();   // draw the shared boxes stage 2 fills before the first call goes out
    for (const d of ordered) if (!await summariseDay(d, r, now, "project")) return;
  } finally {
    stage = null;
  }
}

// One day, one scope. Returns false when the pass should stop entirely.
async function summariseDay(d: TrailDay, r: string, now: number, scope: "me" | "project"): Promise<boolean> {
  if (!dashMirror() || root() !== r || !dashSummaries) return false;   // left, or switched off
  const mine = scope === "me";
  const into = mine ? summaries : teamSummaries;
  if (into.has(d.key)) return true;                            // cache or digest already had it
  const closed = dayIsClosed(d, now);
  const allowed = digestOk().includes(r);
  // The project's line is only bought if something will use it: shown when the day had
  // more than one human committer, written when the project keeps a digest.
  if (!mine && !sharedDay(d) && !(canShare(tier) && (allowed || hasDigest))) return true;
  // The project's line is only about commits; an empty record would buy "quiet day".
  const f = mine ? dayFacts(d) : projectDayFacts(d);
  if (!f.trim()) return true;
  writing = { key: d.key, scope };   // past every early return: a cached or skipped day is not waiting
  renderDash();
  try {
    const line = await invoke<string>("summarize_day", {
      root: r, key: d.key, facts: f, model: "haiku", scope, force: !closed,
    });
    if (root() !== r) return false;   // both maps are the next project's now
    if (!line) return true;
    into.set(d.key, line);
    // Only this half is shared, and only a closed day (today's line changes as the day
    // goes on). Creating the file needs a yes; contributing to one already in the repo
    // does not, or a pulled digest becomes one person's diary.
    if (!mine && canShare(tier) && closed && (allowed || hasDigest)) {
      void invoke("write_digest", { root: r, key: d.key, line, create: allowed }).catch(() => {});
    }
  } catch (e) {
    // No summary is a fine state: the deterministic headline stands.
    dlog("warn", `dash: ${scope} summary for ${d.key} failed: ${e}`);
  } finally {
    writing = null;   // safe unconditionally: the queue is sequential
    if (root() === r) renderDash();
  }
  return true;
}

// ---------- render ----------
// Assign only when the markup changed: `renderDash` is on `renderAll`'s path, and an
// `innerHTML` assignment destroys the node under the pointer (docs/architecture.md).
const painted = new Map<string, string>();
function paint(id: string, html: string): void {
  if (painted.get(id) === html) return;
  painted.set(id, html);
  $(id).innerHTML = html;
}
// The cache is what this module last wrote, and `#inspector` is written by ./inspector
// and ./mirror too, so it is only valid while the dashboard has held the stage.
function invalidatePaintCache(): void { painted.clear(); }

// The overlay, keeping its scroll position: `paint` rebuilds the subtree, and ticking a
// checkbox halfway down the Branches table changes counts and labels too, so there is no
// smaller repaint. Restored only when the same view is still up.
function paintOverlay(view: string, html: string): void {
  const ovl = $("dashOverlay");
  const same = ovl.dataset.view === view;
  const keep = same ? ovl.querySelector<HTMLElement>(".ovl-b")?.scrollTop ?? 0 : 0;
  // The filter box lives inside the painted markup, so every keystroke would otherwise
  // replace the element under the caret. Its value is rendered from state, so only the
  // focus and the caret have to come back.
  const q = ovl.querySelector<HTMLInputElement>(".bvq");
  const caret = same && q && document.activeElement === q ? q.selectionStart : null;
  ovl.dataset.view = view;
  paint("dashOverlay", html);
  if (keep) {
    const b = ovl.querySelector<HTMLElement>(".ovl-b");
    if (b) b.scrollTop = keep;
  }
  if (caret !== null) {
    const n = ovl.querySelector<HTMLInputElement>(".bvq");
    if (n) { n.focus(); n.setSelectionRange(caret, caret); }
  }
}

const liveIn = (path: string) => [...sessions.values()].filter((s) => (s.workdir || "") === path).length;
const liveHere = () => [...sessions.values()].filter((s) => s.colorKey === root());

export function renderDash(): void {
  if (!dashMirror()) return;
  // The bars are `<i>`s of colour, so aria-busy is what says the pane is working.
  $("dashPane").setAttribute("aria-busy", loading || ghLoading || queueRunning ? "true" : "false");
  const p = dashPulse(days);
  const dense = densePerDay(days, dashRange, Date.now());
  // A row of zeros is a wrong answer, not an empty one: `dashPulse([])` reads as "nothing happened here".
  paint("dashPulse", loading ? pulseSkeleton(dashRange) : pulseHtml(p, tier, dashRange, dense));

  let spine: string;
  if (loading) {
    spine = spineSkeleton();
  } else if (!days.length) {
    spine = `<div class="db-empty">Nothing in the last ${dashRange} days.
      Sessions, commits and spend appear here on their own. There is nothing to fill in.</div>`;
  } else {
    // The offer counts closed days with commits, not sentences in hand: a solo day's
    // project line is not bought until somebody wants a digest.
    const unshared = canShare(tier) && !hasDigest && !digestOk().includes(root())
      ? days.filter((d) => dayIsClosed(d) && d.commits.length > 0).length
      : 0;
    spine = days.map((d) =>
      dayHtml(d, summaries.get(d.key) ?? null, deterministicHeadline(d), openDays.has(d.key),
        // shown only where it says something your own line doesn't (see `sharedDay`)
        sharedDay(d) ? teamSummaries.get(d.key) ?? null : null, humanAuthors(d),
        {
          mine: writing?.scope === "me" && writing.key === d.key,
          // the whole of stage 2: every shared day without a line is queued for one
          team: dashSummaries && sharedDay(d) && !teamSummaries.has(d.key)
            && (stage === "project" || writing?.scope === "project"),
        })).join("")
      + workLogOffer(unshared);
  }
  paint("dashSpine", spine);

  const now = Date.now();
  const holder = (t: GhThread) => holderOf(t, gh.viewer, claims.filter((c) => c.root === root()), now);
  const stale = staleCandidates(gh.threads, kept, now).map((t) => ({ t, why: quietFor(t.updated_at, now) }));
  const prs = gh.threads.filter((t) => t.kind === "pr").length;

  // The GitHub cards cross the `loading` branch with a skeleton of their own: an answer
  // that arrives early must be shown early, not hidden behind the transcript scan.
  const ghCards = ghLoading
    ? cardSkeleton()
    : gh.available
      ? workCard(cardRows(gh.threads), gh.threads.length, prs, holder)
        + triageCard(stale, gh.threads.filter((t) => t.kind === "issue").length)
      : "";
  // Notes and the Repository card cross the wait too: notes are localStorage and already
  // correct; the repo card answers from `factsKnown` and the heads probe, and goes first.
  const repo = repoCard(syncNow(), factsKnown);
  // Above the Repository card: the numbers sit directly over the buttons they gate, and
  // ⇄ Switch's tooltip is what still names the refusal. It crosses the `loading` branch
  // for the same reason the repo card does — one local git read, already answered.
  const wset = worksetCard(worksetDir(), worksetTitle(), mainWork, factsKnown && tier !== "none");
  // The main checkout is read by this pane and swept into `dirtyByFolder` for the dot, so
  // prefer the pane's own: two reads of one folder must not put two numbers on one screen.
  const statFor = (p: string) => (p === worksetDir() ? mainWork : dirtyByFolder.get(p));
  paint("dashAside", loading
    ? wset + repo + ghCards + cardSkeleton() + notesCard(noteList(root()))
    : wset + repo + ghCards
      + checkoutsCard(heads, liveIn, statFor)
      + notesCard(noteList(root()))
      + (tier === "github" && !gh.available && gh.reason
        ? ghUnavailable(gh.reason, ghLogins, ghWho(ghAccountFor(root()), ghLogins)) : "")
      + missingCard(tier, facts));

  const ovl = $("dashOverlay");
  ovl.classList.toggle("show", openView !== null);
  if (openView === null) ovl.dataset.view = "";
  else if (openView === "notes") {
    const mineShared = new Set(shared.map((n) => n.id));
    const theirs = shared.filter((n) => !noteList(root()).some((x) => x.id === n.id));
    paintOverlay(openView, notesOverlay(noteList(root()), theirs, mineShared, canShare(tier)));
  }
  else if (openView === "work") paintOverlay(openView, workOverlay(bucketed(gh.threads, now), facts?.slug ?? name(), gh.threads.length, holder));
  else if (openView === "triage") paintOverlay(openView, triageOverlay(stale, kept, canShare(tier)));
  else if (openView === "branches") {
    const rows = branchRowsNow();
    paintOverlay(openView, branchesOverlay({
      tab: branchTab, rows, checkouts: checkoutRowsNow(),
      root: root(), project: name(),
      picked: branchPick, cpicked: coPick,
      filter: branchFilter, query: branchQuery, now,
      scopes: branchScopes,
      trunk: trunkOf(branchData?.branches ?? []), remoteName: remoteFor(rows),
      protect: branchProtect,
      prs: branchPrs, prsLoading: branchPrsLoading,
      busy: branchBusy, loading: branchData === null, result: branchResult,
    }));
  }

  $("dashSheet").classList.toggle("show", sheet !== null);
  $("dashScrim").classList.toggle("show", sheet !== null);
  if (sheet?.kind === "close") paint("dashSheet", closeSheet(sheet.t, closeComment(sheet.t, now), facts?.slug ?? name()));
  else if (sheet?.kind === "dispatch") {
    const agent = effectiveAgent(root());
    const mode = providerPermissionMode(agent.id, permissionModeFor(agent.id));
    paint("dashSheet", dispatchSheet(sheet.t, policy, allow, `${agent.label} · ${mode?.label ?? "terminal config"}`, holder(sheet.t)));
  }
}

// Name and location only: a project has no branch chip or session title, and the
// project verbs live in the inspector.
export function renderDashHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = false;
  ($("btnShelve") as HTMLButtonElement).hidden = true;   // ⇩ is a session verb; every stage taker sets both
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
  paint("inspector", dashInspector(root(), tier, facts, live, hasDigest, factsKnown));
  paint("dashStrip", dashStrip(accentFor(root()), (name()[0] || "?").toUpperCase(), tier,
    live.map((s) => ({ id: s.id, glyph: s.glyph, cls: s.cls, label: s.label })), factsKnown));
}

// ---------- open / close ----------
export function openDashboard(project: string, path: string): void {
  const changed = root() !== path;
  invalidatePaintCache();   // unconditionally: a session visited in between overwrote #inspector
  setMirror({ kind: "dash", root: path, name: project });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("dash");
  document.documentElement.style.setProperty("--accent", accentFor(path));
  // A new project inherits nothing: everything below is an answer about a folder, and
  // `renderAll` paints before `loadDash` reaches its first await.
  if (changed) {
    days = []; heads = []; facts = null; openDays.clear(); openView = null;
    tier = "none"; factsKnown = false; loading = true; ghLoading = false;
    gh = { available: false, reason: null, threads: [], viewer: null };
    kept = []; shared = []; hasDigest = false; sheet = null; writing = null;
    // Branch state never carries across projects: another repo's merges must not vouch for this one.
    branchData = null; branchPrs = null; branchPrsLoading = false; branchProtect = NO_PROTECT;
    branchPick = new Set(); coPick = new Set(); branchResult = null; branchBusy = false;
    branchTab = "branches"; branchFilter = "all"; branchQuery = ""; branchLast = "";
    // `syncing` is not reset: it names a folder a real git process is still running in.
    mainWork = undefined;
  }
  host.renderAll();
  void loadDash();
}

export function closeDashboard(): void {
  if (!dashMirror()) return;
  setMirror(null);
  openView = null;
  takeStage("none");   // the collapsed rail is dash-only, and renderAll never restores #empty
}

// Esc steps out one layer at a time: sheet, overlay, then the pane. Same rule as the
// commit graph's overlay, which is why main.ts calls this rather than closeDashboard.
export function dashEscape(): boolean {
  if (!dashMirror()) return false;
  if (sheet) { sheet = null; renderDash(); return true; }
  if (openView) { openView = null; renderDash(); return true; }
  closeDashboard();
  host.renderAll();
  return true;
}

// ---------- events ----------
// One delegated listener, bound once: the markup is rebuilt wholesale on every change.
export function wireDashboard(): void {
  $("dashPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const range = t.closest<HTMLElement>("[data-dashrange]");
    if (range) { setDashRange(+range.dataset.dashrange!); return; }

    // The Repository card carries the inspector's `data-dashact` verbs: one vocabulary, two hosts.
    const gact = t.closest<HTMLElement>("[data-dashact]");
    if (gact) { dashAction(gact.dataset.dashact!); return; }

    const more = t.closest<HTMLElement>("[data-dashopen]");
    if (more) {
      const k = more.dataset.dashopen!;
      if (openDays.has(k)) openDays.delete(k); else openDays.add(k);
      renderDash();
      return;
    }
    if (t.closest("[data-dashworklog]")) { void enableDigest(); return; }

    const view = t.closest<HTMLElement>("[data-dashopen-view]");
    if (view) {
      // Checkouts is a tab of the Branches view, not a view: one table, one selection model.
      const v = view.dataset.dashopenView!;
      const branchy = v === "branches" || v === "checkouts";
      if (branchy) branchTab = v === "checkouts" ? "checkouts" : "branches";
      openView = branchy ? "branches" : (v as typeof openView);
      renderDash();
      if (branchy) void loadBranches();
      return;
    }
    if (t.closest("[data-dashclose-view]")) { openView = null; branchResult = null; renderDash(); return; }

    // ---- the Branches view ----
    // Every nested control is probed before the row that contains it; a row-level probe
    // placed first would swallow the click meant for the button inside it.
    const brtab = t.closest<HTMLElement>("[data-dashbrtab]");
    if (brtab) { branchTab = brtab.dataset.dashbrtab as typeof branchTab; renderDash(); return; }

    const brfilter = t.closest<HTMLElement>("[data-dashbrfilter]");
    if (brfilter) { branchFilter = brfilter.dataset.dashbrfilter as BranchFilter; renderDash(); return; }

    // `All` ticks what the filter is showing, which is what makes the chips quick-selects.
    if (t.closest("[data-dashbrall]")) {
      for (const n of selectable(shownRows())) branchPick.add(n);
      renderDash();
      return;
    }
    if (t.closest("[data-dashbrnone]")) { branchPick = new Set(); branchLast = ""; renderDash(); return; }

    const brscope = t.closest<HTMLElement>("[data-dashbrscope]");
    if (brscope) {
      const k = brscope.dataset.dashbrscope as "local" | "remote";
      branchScopes = { ...branchScopes, [k]: !branchScopes[k] };
      renderDash();
      return;
    }
    const brsw = t.closest<HTMLElement>("[data-dashbrsw]");
    if (brsw) { void switchTo(brsw.dataset.dashbrsw!); return; }

    // The same menu the right-click opens, at the button rather than at the pointer. The click
    // must stop here: main.ts's outside-click closer would otherwise shut the menu this opened.
    const brmenu = t.closest<HTMLElement>("[data-dashbrmenu]");
    if (brmenu) {
      e.stopPropagation();
      const box = brmenu.getBoundingClientRect();
      openRowMenu(brmenu.dataset.dashbrmenu!, box.left, box.bottom + 4);
      return;
    }

    const brswitch = t.closest<HTMLElement>("[data-dashswitch]");
    if (brswitch) { void openSwitchPop(brswitch); return; }

    if (t.closest("[data-dashbrrun]")) { void runClean(); return; }
    if (t.closest("[data-dashbrdone]")) { branchResult = null; renderDash(); return; }
    if (t.closest("[data-dashbrterm]")) {
      const cmd = branchResult?.local?.suggest;
      // Never run from a click: a `-D` goes to a terminal where it can be read first.
      if (cmd) { openView = null; branchResult = null; renderDash(); host.handToTerminal(name(), root(), cmd); }
      return;
    }
    const brtrunk = t.closest<HTMLElement>("[data-dashbrtrunk]");
    if (brtrunk) { openBranchPop(brtrunk, trunkOptions(branchData?.branches ?? []).map((o) => ({ ...o })), cmpBase[root()] ?? "", (ref) => {
      host.saveTrunk(root(), ref);
      branchData = null;                 // the numbers are git's, so they have to be re-read
      renderDash();
      void loadBranches(true);
    }); return; }

    // ---- the Checkouts tab ----
    if (t.closest("[data-dashcoall]")) { coPick = removableCheckouts(checkoutRowsNow()); renderDash(); return; }
    if (t.closest("[data-dashconone]")) { coPick = new Set(); renderDash(); return; }
    if (t.closest("[data-dashcorun]")) { void runCheckoutClean(); return; }

    const drop = t.closest<HTMLElement>("[data-dashdrop]");
    if (drop) { removeNote(drop.dataset.dashdrop!); renderDash(); return; }
    const disp = t.closest<HTMLElement>("[data-dashdispatch]");
    if (disp) { void dispatchNote(disp.dataset.dashdispatch!); return; }

    const wtadd = t.closest<HTMLElement>("[data-dashwtadd]");
    if (wtadd) { void host.launch(name(), wtadd.dataset.dashwtadd!, { colorKey: root() }); return; }
    const wtterm = t.closest<HTMLElement>("[data-dashwtterm]");
    if (wtterm) { host.openTerminal(wtterm.dataset.dashwtterm!); return; }
    // After both buttons: they are nested inside the row, and this branch would swallow them.
    // Only a dirty checkout carries the attribute, so this never opens an empty overlay.
    const wt = t.closest<HTMLElement>("[data-dashwt]");
    if (wt) {
      const dir = wt.dataset.dashwt!;
      const w = heads.find((h) => h.path === dir);
      host.openDiff(dir, `${name()} · ${w?.branch || basename(dir)}`);
      return;
    }
    // The Checkouts tab's row, after the ＋/❯ nested in it, like the card's row above.
    const co = t.closest<HTMLElement>("[data-dashco]");
    if (co) { toggleCheckout(co.dataset.dashco!); return; }
    // The Branches tab's row, last of its family: ⇄ and the box both sit inside it.
    const br = t.closest<HTMLElement>("[data-dashbr]");
    if (br) { toggleBranch(br.dataset.dashbr!, e.shiftKey); return; }

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
    const url = t.closest<HTMLElement>("[data-dashurl]");
    if (url?.dataset.dashurl) { void openUrl(url.dataset.dashurl).catch(() => {}); return; }
  });

  // The Branches view's filter box; everything else in this pane is a click.
  $("dashPane").addEventListener("input", (e) => {
    const q = (e.target as HTMLElement).closest<HTMLInputElement>(".bvq");
    if (!q) return;
    branchQuery = q.value;
    renderDash();
  });

  // The sheets sit over the whole stage, outside #dashPane, so they get their own handler.
  $("dashSheet").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dashsheet]");
    if (!b) return;
    const act = b.dataset.dashsheet!;
    if (act === "cancel") { sheet = null; renderDash(); return; }
    if (act === "close") { void doClose(); return; }
    if (act === "dispatch") { void doDispatch(); return; }
  });
  // A branch row's menu. Checkout rows carry `data-wt` instead and are answered by ./projmenu's
  // document-level handler, which is the same menu a ⑃ cluster header opens.
  $("dashPane").addEventListener("contextmenu", (e) => {
    const br = (e.target as HTMLElement).closest<HTMLElement>("[data-dashbr]");
    if (!br?.dataset.dashbr) return;
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(br.dataset.dashbr, e.clientX, e.clientY);
  });

  $("dashScrim").addEventListener("click", () => { sheet = null; renderDash(); });

  ($("dashJotHost") as HTMLElement).addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest("#dashJot");
    if (!form) return;
    e.preventDefault();
    const input = $("dashNote") as HTMLInputElement;
    if (addNote(input.value, root())) { input.value = ""; renderDash(); }
  });

  // The inspector and its strip both emit data-dashact; one handler, bound on the persistent hosts.
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
  // One ＋, the same call the header's ＋ Session makes: dialog on a repo, plain launch on a folder.
  if (act === "launch") host.requestLaunch(n, r, dashLaunchHint());
  else if (act === "terminal") host.openTerminal(r);
  else if (act === "run") host.openRun(r);
  else if (act === "pull") void syncMain("pull");
  else if (act === "push") void syncMain("push");
  else if (act === "graph") host.openGraph(r);
  else if (act === "cleanup") openBranchesView(n, r);
  else if (act === "history") host.openHistory(r);
  else if (act === "folder") host.openFolder(r);
  else if (act === "copypath") host.copyPath(r);
  else if (act === "worklog") void enableDigest();
  // `ghacctclear` is its own verb, so a truncated `ghacct:` can never read as "clear the pin".
  else if (act === "ghacctclear") host.setGhAccount(r, null);
  else if (act.startsWith("ghacct:")) host.setGhAccount(r, act.slice(7));
}

// ---------- the Branches view ----------
// The reading, the running and the reporting; the rules are ./branches (pure, tested).

async function loadBranches(force = false): Promise<void> {
  const r = root();
  if (!r || (branchData && !force)) return;
  const [branches, worktrees, protect] = await Promise.all([
    invoke<BranchInfo[]>("git_branch_list", { repoDir: r, base: cmpBase[r] ?? null }).catch(() => [] as BranchInfo[]),
    invoke<WtInfo[]>("list_worktrees", { repoDir: r }).catch(() => [] as WtInfo[]),
    readProtect(r),
  ]);
  if (root() !== r) return;                      // the stage moved to another project
  branchData = { branches, worktrees };
  branchProtect = protect;
  // Nothing is ticked on arrival: deleting is opt-in, and a stale tick may name a branch that is gone.
  branchPick = new Set();
  coPick = new Set();
  branchLast = "";
  renderDash();
  if (branchPrs || branchPrsLoading) return;
  branchPrsLoading = true;
  const [prs, ghLocks] = await Promise.all([
    invoke<MergedPrs>("gh_merged_prs", { root: r, force: false, account: ghAccountFor(r) }).catch(() => null),
    invoke<GhProtected>("gh_protected_branches", { root: r, force: false, account: ghAccountFor(r) }).catch(() => null),
  ]);
  branchPrsLoading = false;
  if (root() !== r) return;   // guarded on the project, not a load counter: this lands after the git reads
  branchPrs = prs ?? { available: false, reason: "gh could not be reached", prs: [] };
  // gh being unreachable is already said once, by the merged-PR note; an empty list here just
  // means GitHub protects nothing we could see.
  branchProtect = { ...branchProtect, github: ghLocks?.available ? ghLocks.names : [] };
  renderDash();   // the answer can only add rows, and they arrive unticked like the rest
}

const branchRowsNow = (): BranchRow[] => branchData ? branchRows({
  branches: branchData.branches,
  worktrees: branchData.worktrees,
  prs: branchPrs?.prs ?? [],
  liveIn: (p) => [...sessions.values()].filter((s) => s.workdir === p).length,
  externalIn: (p) => externals.some((e) => e.cwd === p),
  protect: branchProtect,
}) : [];

const checkoutRowsNow = (): CheckoutRow[] => branchData ? checkoutRows({
  worktrees: branchData.worktrees,
  liveIn: (p) => [...sessions.values()].filter((s) => s.workdir === p).length,
  externalIn: (p) => externals.some((e) => e.cwd === p),
  protect: branchProtect,
}) : [];

// What the table is showing right now, which is what `All` and a shift-click range mean.
const shownRows = () => orderRows(filterRows(branchRowsNow(), branchFilter, branchQuery, Date.now()));

function toggleBranch(name: string, range: boolean): void {
  const shown = shownRows();
  const pickable = selectable(shown);
  if (!pickable.has(name)) return;   // an off row is shown for its reason, never ticked
  // Shift takes everything between the last tick and this one, in the order on screen, and
  // adds rather than toggles: a range that flipped each row would undo half of itself.
  if (range && branchLast && branchLast !== name) {
    for (const n of rangePick(shown.map((r) => r.name), branchLast, name)) {
      if (pickable.has(n)) branchPick.add(n);
    }
  } else if (branchPick.has(name)) branchPick.delete(name);
  else branchPick.add(name);
  branchLast = name;
  renderDash();
}

function toggleCheckout(path: string): void {
  if (!removableCheckouts(checkoutRowsNow()).has(path)) return;
  if (coPick.has(path)) coPick.delete(path); else coPick.add(path);
  renderDash();
}

// Delete the ticked branches wherever the scopes point. Checkouts first (git refuses to
// delete a branch a worktree holds), then the local refs, then the remote ones: a remote
// delete that ran first would leave the evidence for the local half gone.
async function runClean(): Promise<void> {
  const r = root();
  const rows = branchRowsNow();
  const picks = branchScopes.local ? localPicks(rows, branchPick) : [];
  const rpicks = branchScopes.remote ? remotePicks(rows, branchPick) : [];
  if (!r || branchBusy || (!picks.length && !rpicks.length)) return;
  const remote = remoteFor(rows);
  branchBusy = true;
  renderDash();
  const report: CleanReport = { wts: [], local: null, remote: null, summary: "" };
  try {
    if (picks.length) {
      for (const w of chosenWorktrees(rows, branchPick)) report.wts.push(await removeOne(r, w));
      report.local = await invoke<SweepResult>("sweep_branches", { repoDir: r, picks });
      dlog("info", `branches · ${report.local.summary}`);
    }
    if (rpicks.length) {
      const swept = await invoke<SweepResult>("delete_remote_branches", { repoDir: r, remote, picks: rpicks });
      dlog(swept.deleted.length ? "info" : "warn", `branches · ${remote} · ${swept.summary}`);
      report.remote = { swept, remote };
      // A remote delete leaves refs/remotes alone until a fetch prunes them.
      await invoke("git_action", { workdir: r, op: "fetch" }).catch(() => {});
    }
    report.summary = [report.local?.summary, report.remote?.swept.summary].filter(Boolean).join(" · ");
    // Guarded on the project throughout: a sweep outlives a stage switch, and its result
    // and toast belong to the repo it ran in, not to whatever is on screen when it lands.
    if (root() !== r) return;
    toast(report.summary);
    branchResult = report;
  } catch (e) {
    dlog("error", `branches clean failed: ${e}`);
    if (root() === r) toast("branches: " + e);
  } finally {
    branchBusy = false;
    branchPick = new Set();
    if (root() === r) {
      await loadBranches(true);        // re-read: the roster and the branch list both moved
      await host.refreshGit();
    }
    renderDash();
  }
}

// Remove the ticked checkouts. Every one reaching here is clean, unlocked and idle, so the
// branch goes with it only where git's safe delete accepts it (`deleteBranch`).
async function runCheckoutClean(): Promise<void> {
  const r = root();
  const rows = chosenCheckouts(checkoutRowsNow(), coPick);
  if (!r || branchBusy || !rows.length) return;
  branchBusy = true;
  renderDash();
  const report: CleanReport = { wts: [], local: null, remote: null, summary: "" };
  for (const c of rows) report.wts.push(await removeOne(r, c.wt));
  const ok = report.wts.filter((w) => w.ok).length;
  report.summary = `${ok} of ${rows.length} checkout${rows.length === 1 ? "" : "s"} removed`;
  branchBusy = false;
  coPick = new Set();
  if (root() === r) {
    toast(report.summary);
    branchResult = report;
    await loadBranches(true);
    await host.refreshGit();
  }
  renderDash();
}

/** One `remove_worktree`, reported the way both runs above report it. The rail is marked for
 *  the whole call, so a batch spins each folder where it lives rather than dropping it. */
async function removeOne(repoDir: string, w: WtInfo): Promise<{ label: string; ok: boolean; note: string }> {
  const label = w.path.split(/[/\\]/).filter(Boolean).pop() ?? w.path;
  removingWt.set(w.path, repoDir);
  host.renderAll();
  try {
    const res = await invoke<{ ok: boolean; summary: string; stranded?: unknown }>(
      "remove_worktree", { repoDir, path: w.path, branch: w.branch, deleteBranch: true });
    dlog(res.ok ? "info" : "warn", `branches · worktree ${label} · ${res.summary}`);
    // A stranded removal is `ok: true`: the worktree is unregistered, so the branch is deletable.
    return { label, ok: res.ok, note: res.stranded ? "removed; folder still on disk" : res.summary };
  } catch (e) {
    return { label, ok: false, note: String(e) };
  } finally {
    removingWt.delete(w.path);
  }
}

/** The Repository card's branch chip. The list is git's, so it is read before the popover
 *  opens rather than shown stale: this control is reachable without the Branches view. */
async function openSwitchPop(anchor: HTMLElement): Promise<void> {
  const r = root();
  await loadBranches();
  if (root() !== r) return;
  const here = heads.find((h) => h.is_main)?.branch ?? "";
  openBranchPop(anchor, switchOptions(branchData?.branches ?? [], branchData?.worktrees ?? [], r),
    here, (n) => void switchTo(n));
}

// The ⇄ on a row, and the picker on the Repository card: one switch, every guard in the
// backend, and the refusal handed to a terminal rather than swallowed.
async function switchTo(branch: string): Promise<void> {
  const r = root();
  if (!r || branchBusy) return;
  const target = switchable(switchOptions(branchData?.branches ?? [], branchData?.worktrees ?? [], r))
    .find((o) => o.name === branch);
  if (!target) { toast(`${branch} is checked out elsewhere`); return; }
  await host.switchBranch(name(), r, branch, target.base ?? null);
  branchData = null;
  renderDash();
  void loadBranches(true);
}

// ---------- the lock, and the row menu that sets it ----------

/// What `git::list_protected_branches` answers; `readable: false` is a file that exists and
/// does not parse, which protects nothing and must not read as an empty list.
interface ProtectList { patterns: string[]; readable: boolean }
interface GhProtected { available: boolean; reason: string | null; names: string[] }

async function readProtect(r: string): Promise<ProtectCtx> {
  const list = await invoke<ProtectList>("list_protected_branches", { repoDir: r })
    .catch(() => ({ patterns: [], readable: true } as ProtectList));
  // GitHub's half arrives later, with the merged PRs; the committed one is local and instant.
  return { patterns: list.patterns, readable: list.readable, github: branchProtect.github };
}

/** The lock is committed, so the very first one asks (`withConsent`): a new file in someone's
 *  repo is a real side effect. Only an exact name is ever written — a glob is hand-edited,
 *  and the menu row says so rather than offering a click that would unprotect its siblings. */
async function setProtect(branch: string, protect: boolean): Promise<void> {
  const r = root();
  if (!r) return;
  try {
    const wrote = await withConsent(
      (create) => invoke("set_protected_branch", { repoDir: r, branch, protect, create }),
      ".episko/episko.toml",
      "Protecting a branch stops Episko deleting it, for everyone who pulls the repo.");
    if (!wrote) return;
    branchProtect = await readProtect(r);
    toast(protect ? `${branch} is protected` : `${branch} is no longer protected`);
    renderDash();
  } catch (e) {
    toast(`Could not write .episko/episko.toml: ${e}`);
  }
}

/** ＋ on a row: a session on this branch wherever it already lives, and a worktree for it
 *  where it lives nowhere. A remote-only row cuts its local ref from the remote one, which is
 *  the `base` rule `switch_branch` and the ⑃ dialog already share. */
async function newSessionOn(r: BranchRow): Promise<void> {
  const proj = root();
  if (!proj || branchBusy) return;
  const title = name();
  if (r.wt) {
    void host.launch(title, r.wt.path, { colorKey: proj, worktree: r.wt.branch, branch: r.name });
    return;
  }
  if (r.br.current) {
    void host.launch(title, proj, { colorKey: proj, worktree: null, branch: r.name });
    return;
  }
  branchBusy = true;
  renderDash();
  try {
    const base = r.hasLocal ? null : (r.br.upstream || r.remoteRef || null);
    const path = await invoke<string>("create_worktree", { repoDir: proj, branch: r.name, base });
    void host.launch(title, path, { colorKey: proj, worktree: r.name, branch: r.name });
    toast(`Worktree ${r.name} created`);
    await host.refreshGit();
  } catch (e) {
    dlog("error", `branches · worktree ${r.name}: ${e}`);
    toast("worktree: " + e);
  } finally {
    branchBusy = false;
    await loadBranches(true);
    renderDash();
  }
}

// Where a session on this row would start: its own worktree, the project's folder when the
// branch is checked out there, and nowhere at all until one is made.
const dirOf = (r: BranchRow) => r.wt ? r.wt.path : r.br.current ? root() : "";

function openRowMenu(branch: string, x: number, y: number): void {
  const proj = root();
  const r = branchRowsNow().find((q) => q.name === branch);
  if (!proj || !r) return;
  const dir = dirOf(r);
  // Why this checkout cannot move to the branch, in `switchOptions`' own words; a row that is
  // simply absent from the list is one this folder was never offered.
  const opt = switchOptions(branchData?.branches ?? [], branchData?.worktrees ?? [], proj)
    .find((o) => o.name === branch);
  openBranchMenu({
    branch,
    root: proj,
    dir,
    live: dir ? [...sessions.values()].filter((sess) => sess.workdir === dir).length : 0,
    lock: r.lock ? { by: r.lock.by, exact: r.lock.exact, text: lockText(r.lock) } : null,
    // `current` is git's answer for `root` itself, which is the folder `switchTo` moves — not
    // the roster's `is_main`, which names a different folder when the project IS a worktree.
    hereBranch: branchData?.branches.find((b) => b.current)?.name ?? "",
    switchNote: !opt ? `${basename(proj)}/ was not offered this branch`
      // `switchOptions` writes its notes for a picker anchored on a folder, so its "here" is
      // said again here, where the label has just named which folder that is.
      : r.br.current ? "it is already checked out there"
      : opt.disabled ? opt.note : "",
  }, x, y, (act) => { void runRowAct(act, branch); });
}

async function runRowAct(act: string, branch: string): Promise<void> {
  const r = branchRowsNow().find((q) => q.name === branch);
  if (!r) return;
  if (act === "brcopy") { void copyText(branch, "Branch name copied"); return; }
  if (act === "brswitch") { void switchTo(branch); return; }
  if (act === "brterm") { const d = dirOf(r); if (d) host.openTerminal(d); return; }
  if (act === "brlaunch") { await newSessionOn(r); return; }
  if (act === "brprotect" || act === "brunprotect") await setProtect(branch, act === "brprotect");
}

// Open the view from anywhere; the ⑃ dialog's brooms point here.
export function openBranchesView(project: string, path: string): void {
  if (root() !== path) openDashboard(project, path);
  openView = "branches";
  branchResult = null;
  renderDash();
  void loadBranches();
}

// Turn a note into a running agent. Prefilled without a trailing newline: the human presses Enter.
async function dispatchNote(id: string): Promise<void> {
  const n = noteList(root()).find((x) => x.id === id);
  if (!n) return;
  const sid = await host.launch(name(), root(), { colorKey: root() });
  if (typeof sid !== "string") return;   // a failed launch already toasted; don't eat the note too
  removeNote(id);
  renderDash();
  // Claude's REPL needs a moment before it accepts input; failing to type is harmless.
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: n.text.replace(/\n/g, " ") }).catch(() => {});
  }, 1400);
  toast("Dispatched and prefilled. Press Enter to send");
}

// The project's ceiling wins: a switch the project turned off is greyed, not hidden.
function togglePolicy(k: string): void {
  const r = resolveClaim(policy, allow);
  if (k === "assign" && r.assign.source !== "project") policy = { ...policy, assign: !policy.assign };
  else if (k === "comment" && r.comment.source !== "project") policy = { ...policy, comment: !policy.comment };
  else if (k === "label" && r.label.source !== "project") {
    policy = { ...policy, label: policy.label ? "" : "agent: running" };
  }
  renderDash();
}

// Comment, then close. The only destructive write Episko makes to GitHub, hence the
// permanent confirm sheet and the editable comment.
async function doClose(): Promise<void> {
  if (sheet?.kind !== "close") return;
  const t = sheet.t, r = root();
  const comment = ($("dashCloseText") as HTMLTextAreaElement | null)?.value ?? "";
  sheet = null;
  renderDash();
  try {
    await invoke("gh_close_issue", { root: r, number: t.number, comment, account: ghAccountFor(r) });
    toast(`#${t.number} closed`);
    await loadGh(r, true);
  } catch (e) {
    toast(`Could not close #${t.number}: ${e}`);
  }
}

// Committed, so it needs the same create-gate as the digest; reviewable and undoable in the ⤢ view.
// A new committable file is never created without asking (CLAUDE.md). The backend refuses a
// missing file when `create` is false, and that refusal is the only "does it exist?" this side
// can trust; a yes is the write, and a no leaves the repo as it was.
async function withConsent(write: (create: boolean) => Promise<unknown>, file: string, why: string): Promise<boolean> {
  try {
    await write(false);
    return true;
  } catch (e) {
    if (!String(e).includes("no .episko/")) throw e;
    const ok = await ask(`Create ${file}?\n\n${why}\n\nIt is committed with the project, so your colleagues get it too.`,
      { title: "A new file in the repo", kind: "info", okLabel: "Create", cancelLabel: "Cancel" });
    if (!ok) return false;
    await write(true);
    return true;
  }
}

async function setKept(number: number, keep: boolean): Promise<void> {
  const r = root();
  const who = gh.viewer || "someone";
  try {
    const wrote = await withConsent(
      (create) => invoke("set_kept", { root: r, number, who, at: isoDay(Date.now()), keep, create }),
      ".episko/episko.toml",
      "Keeping an issue out of triage is a decision for the whole team, so it is recorded in the project.");
    if (!wrote) return;
    kept = await invoke<KeptIssue[]>("list_kept", { root: r }).catch(() => kept);
    toast(keep ? `#${number} kept. Nobody on the team is asked again` : `#${number} back in triage`);
    renderDash();
  } catch (e) {
    toast(`Could not write .episko/episko.toml: ${e}`);
  }
}

// Start an agent on a thread and say so where colleagues can see it. The prompt is sent,
// the one exception to "Episko prefills, the human presses Enter": the sheet was the
// reading. The claim is written after the session exists, never before.
async function doDispatch(): Promise<void> {
  if (sheet?.kind !== "dispatch") return;
  const t = sheet.t, r = root(), n = name();
  sheet = null;
  renderDash();
  // Follows the project provider preference; claim release rides the provider-neutral `pty-exit`.
  const sid = await host.launch(n, r, { colorKey: r });
  if (typeof sid !== "string") return;   // launch already toasted the spawn error; no claim either

  const eff = resolveClaim(policy, allow);
  // Pass every argument the command declares, `body` included: Tauri rejects the whole
  // invoke on one missing key (test/ipc.test.ts).
  if (eff.assign.value || eff.comment.value || eff.label.value) {
    const kind = t.kind === "pr" ? "pr" : "issue";
    void invoke<ClaimOutcome>("gh_claim", {
      root: r, number: t.number, kind,
      assign: eff.assign.value, comment: eff.comment.value,
      label: eff.label.value, body: claimComment(gh.viewer || "", Date.now()),
    }).then((out) => {
      // Record what actually landed, not what was asked for — the release undoes this.
      recordClaim({ threadId: `${r}#${t.number}`, root: r, number: t.number,
        kind, sessionId: sid, at: Date.now(), who: gh.viewer || "",
        wrote: { assigned: out.assigned, label: out.labeled ? eff.label.value : "" } });
      if (out.problems.length) {
        dlog("warn", `claim #${t.number} partial: ${out.problems.join("; ")}`);
        toast(`Started on #${t.number}, but the claim didn't fully land: ${out.problems.join("; ")}`);
      }
      void loadGh(r, true);
    }).catch((e) => {
      dlog("warn", `claim #${t.number} failed: ${e}`);
      toast(`Started on #${t.number}, but nothing could be written to it: ${e}`);
    });
  }

  // Sent, not prefilled. The `\r` goes in a write of its own, a beat behind the text: a
  // burst arriving in one chunk is read as a paste, and a `\r` inside a paste is a newline.
  setTimeout(() => {
    const prompt = `Work on ${t.kind === "pr" ? "PR" : "issue"} #${t.number}: ${t.title}\n${t.url}`;
    void invoke("write_pty", { sessionId: sid, data: prompt.replace(/\n/g, " ") })
      .then(() => new Promise((r2) => setTimeout(r2, SUBMIT_MS)))
      .then(() => invoke("write_pty", { sessionId: sid, data: "\r" }))
      .catch(() => {});
  }, 1400);
  toast(`Started on #${t.number}`);
}

export function releaseClaimFor(sessionId: string): void {
  const rec = claimForSession(sessionId);
  if (!rec) return;
  dropClaim(rec.threadId);
  // `label` and `body` are required arguments (Tauri rejects the invoke without them).
  // `unassign` is only what we wrote, never `@me`: guessing strips assignments a human made.
  void invoke<ClaimOutcome>("gh_release", {
    root: rec.root, number: rec.number, kind: rec.kind,
    unassign: rec.wrote?.assigned ?? false,
    label: rec.wrote?.label ?? "",
    // The claim's own signature: this runs on `pty-exit`, when `gh.viewer` may belong to
    // another project's GitHub half, or to none. An older ledger entry has no `who`.
    body: releaseComment(rec.who ?? (rec.root === root() ? gh.viewer || "" : ""), Date.now()),
  }).then((out) => {
    if (out.problems.length) dlog("warn", `release #${rec.number} partial: ${out.problems.join("; ")}`);
  }).catch((e) => { dlog("warn", `release #${rec.number} failed: ${e}`); });
}

// Promote a note into the project or take it back. Sharing needs git, not GitHub: it is a file.
async function toggleShare(id: string): Promise<void> {
  const r = root();
  const n = noteList(r).find((x) => x.id === id);
  if (!n) return;
  const on = shared.some((x) => x.id === id);
  try {
    const wrote = await withConsent((create) => invoke("set_shared_note", {
      root: r, id, text: n.text, who: gh.viewer || "someone",
      at: isoDay(Date.now()), share: !on, create,
    }), ".episko/notes.toml", "A shared note is written into the project rather than kept on your machine.");
    if (!wrote) return;
    shared = await invoke<SharedNote[]>("list_shared_notes", { root: r }).catch(() => shared);
    toast(on ? "Note is yours again" : "Shared. Commit .episko/notes.toml to send it");
    renderDash();
  } catch (e) {
    toast(`Could not write .episko/notes.toml: ${e}`);
  }
}

// Start an agent on a colleague's note. Prefilled, not sent: it is somebody else's sentence.
async function dispatchText(text: string): Promise<void> {
  const sid = await host.launch(name(), root(), { colorKey: root() });
  if (typeof sid !== "string") return;
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: text.replace(/\n/g, " ") }).catch(() => {});
  }, 1400);
  toast("Dispatched and prefilled. Press Enter to send");
}

// Start writing the shared work log; asked once per project (see `OK_KEY`). Every closed
// day whose project line is in hand is written at once so the first commit carries history;
// the rest come from the re-run. `teamSummaries`, never `summaries`: your line stays private.
export async function enableDigest(): Promise<void> {
  const r = root();
  if (!r || !canShare(tier)) return;
  allowDigest(r);
  const done = [...teamSummaries.entries()].filter(([k]) => days.some((d) => d.key === k && dayIsClosed(d)));
  // Consent with nothing written yet is still consent: the re-run writes each day as it lands.
  if (!done.length) {
    toast("Work log on. .episko/digest.md is written as each day is summarised");
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
  // Only claim the file exists once a write landed: `hasDigest` drives the chip and the queue's consent.
  if (!wrote) { toast("Could not write .episko/digest.md"); return; }
  hasDigest = true;
  toast("Work log written to .episko/digest.md. Commit it to share");
  host.renderAll();
  void runSummaryQueue();   // the solo days now have a file to go in
}
export const digestAllowed = (r: string) => digestOk().includes(r);
