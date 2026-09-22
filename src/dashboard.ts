// The project dashboard: the pane, its IPC, the summary queue and the delegated events.
// ./dash owns the rules, ./dashview the markup. Nothing here runs until a project is
// clicked: no probe at startup, nothing on renderAll's path. See docs/dashboard.md.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, setHeadPath, takeStage, toast } from "./dom";
import { readList } from "./store";
import { basename, esc, escAttr, fmtDayLong } from "./format";
import { iconFor } from "./icons";
import { extWorking } from "./sidebarview";
import { ask } from "./confirm";
import { dlog } from "./debug";
import {
  bandFacts, canShare, DASH_RANGE_DEFAULT, dashDays, dayCard, densePerDay, mainCheckout, projectCost,
  projectTier, readSeen, saveSeen, seenAt, SINCE_LINES, stampSeen,
  type ProjectFacts, type ProjectTier, type SyncOp,
} from "./dash";
import {
  bandSkeleton, branchesOverlay, cardSkeleton, checkoutCard, closeSheet, dispatchSheet,
  ghUnavailable, liveHereCard, type LiveRow, missingCard, notesOverlay, projectFoot, queueCard, sinceBand,
  triageOverlay, verbTiles, worksetCard, workOverlay,
  type BandLine, type CleanReport, type DashSync,
} from "./dashview";
import { landedCard } from "./landedview";
import { issueOverlay } from "./issueview";
import type { GhIssueRead } from "./issue";
import { filterQueue, foldQueue, plainRows, queueTally, rankQueue, searchQueue, type QueueFilter } from "./queue";
import { foldBots, layoutGraph, parseRefs, ROW_H, type GraphCommit, type GraphMark, type LiteRow } from "./graph";
import {
  advisoryBrief, depTally, groupAdvisories, outdatedBrief, outRows, prBrief,
  renovateDashboard, verifyCommands,
  type Advisory, type DepManifest, type DepPr, type DepReport, type DepTool, type OutdatedRun, type OutRow,
} from "./deps";
import { depSheet, depsOverlay, type DepTab } from "./depsview";
import { discoverTasks, execCmd } from "./tasks";
import {
  applyPick, emptyPick, pickNone, pickState, rangeOutcome, togglePickAll,
  type Pick, type PickCtx, type PickKind,
} from "./pick";
import { openBranchPop } from "./bpop";
import {
  branchRows, checkoutRows, chosenCheckouts, chosenWorktrees, filterRows, localPicks, lockText,
  NO_PROTECT, orderRows, removableCheckouts, remoteFor, remotePicks, selectable,
  switchable, switchOptions, trunkOf, trunkOptions, type BranchFilter, type BranchInfo,
  type BranchRow, type CheckoutRow, type MergedPrs, type ProtectCtx, type SweepResult,
  type WtInfo,
} from "./branches";
import { openMenu } from "./menu";
import { openBranchMenu } from "./projmenu";
import {
  ALLOW_ALL, claims, claimForSession, DEFAULT_POLICY, dropClaim, recordClaim,
  resolveClaim, type ClaimAllow, type ClaimOutcome, type ClaimPolicy,
} from "./claim";
import {
  bucketed, claimComment, closeComment, ghPickable, ghWho, holderOf, isoDay, quietFor,
  releaseComment, staleCandidates, type GhResult, type GhThread, type KeptIssue,
} from "./ghwork";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote, type SharedNote } from "./notes";
import { GLYPH, GCLASS } from "./sidebarview";
import {
  dayFacts, dayIsClosed, isBotAuthor, projectDayFacts, sharedDay,
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
  /** `mark` lights a span in the panel and pages down to it; the verb tiles pass none. */
  openGraph: (root: string, mark?: GraphMark) => void;
  // The working-set overlay, on a folder. `focus` unfolds one file, as the explorer's ↵ does.
  openDiff: (workdir: string, title: string, focus?: string) => void;
  openHistory: (root: string) => void;
  openFolder: (dir: string) => void;
  copyPath: (dir: string) => void;
  /** Clipboard + toast for anything that is not a path (a commit sha, so far). */
  copyText: (text: string, said: string) => void;
  // The two narrow pickers behind the Set up for chips — not the whole project menu, which
  // also offers Appearance, Group and Remove and answers none of what those chips say.
  openAgentPicker: (root: string) => void;
  openGhPicker: (root: string) => void;
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
  copyPath: () => {}, copyText: () => {},
  openAgentPicker: () => {}, openGhPicker: () => {}, setActive: () => {}, renderAll: () => {},
  refreshGit: async () => {}, handToTerminal: () => {}, saveTrunk: () => {},
  setGhAccount: () => {},
};
export function setDashHost(h: DashHost) { host = h; }

// Gap between a dispatched prompt and its Enter: in one burst Claude's REPL treats the
// `\r` as a pasted newline rather than a submit.
const SUBMIT_MS = 250;

// ---------- preferences ----------
// One window, not a preference: the band measures from your last visit and the ribbon is the
// month behind it, so a picker only ever changed how much history was read for the same answer.
export const dashRange = DASH_RANGE_DEFAULT;
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
// The dependency sheet carries its whole brief rather than a row id: the text is what is
// sent, it is editable in the sheet, and re-deriving it on submit would discard the edit.
type Sheet =
  | { kind: "close" | "dispatch"; t: GhThread }
  | { kind: "deps"; title: string; brief: string };
let sheet: Sheet | null = null;
/// What this dispatch would write, editable in the sheet before it is sent.
let policy: ClaimPolicy = { ...DEFAULT_POLICY, comment: true, label: "agent: running" };
// Generated summaries, keyed by day and kept apart from `days` so a reload keeps what was
// paid for. `summaries` is your day (your sessions and spend; never reaches a file);
// `teamSummaries` is the project's (commits and PRs; the half `.episko/digest.md` holds).
const summaries = new Map<string, string>();
const teamSummaries = new Map<string, string>();
let openView: "notes" | "work" | "triage" | "branches" | "deps" | "issue" | null = null;
// When you last opened each project, machine-wide and capped; the band measures from it.
let seen = readSeen();
// This project's stamp as it was BEFORE this visit wrote a new one (see `openDashboard`).
let sinceAt = 0;
let queueFilter: QueueFilter = "all";
// The search narrows the pool the chips then count over; it lives here rather than in the
// markup, because the queue is repainted by every answer that lands while you are typing.
let queueQuery = "";
// Which folded runs are showing their rows. Keyed so a repaint keeps one open, and in
// memory only: what you unfolded to read once is not a preference.
const queueOpen = new Set<string>();
/// ---- the thread reader ----
// Which thread the ⤢ opened, kept apart from `openView` so a failed read still knows what it
// was reading, and `null` data means "not answered yet" rather than "nothing there".
let issueAt: { number: number; kind: string } | null = null;
let issueData: GhIssueRead | null = null;
let issueLoading = false;
let botFold = true;                  // runs of bot commits folded in the Landed card
// One page of `git_graph`, kept in module state: a render never fetches.
let landed: GraphPage | null = null;
let landedLoading = false;

/// ---- the Dependencies view ----------------------------------------------------------
// The GitHub half rides `loadGh`'s timing (fired early, awaited by nothing); the manifests
// and the tool probe are local and cheap. `null` is "not read", which is not "none".
let depReport: DepReport | null = null;
let depLoading = false;
let depManifests: DepManifest[] = [];
let depTools: DepTool[] = [];
let depVerify: string[] = [];      // this project's own checks, for the brief
let depTab: DepTab = "vulns";
let depSel: Pick = emptyPick();
let depOutSel: Pick = emptyPick();
// The one thing on this pane that RUNS something, so it is never on a load path and its
// answer is kept apart from the reads: `depScanned` is the tool whose rows are on screen.
let depRun: OutdatedRun | null = null;
let depScanning = "";
let depScanned = "";
let depScanError = "";

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
// ticked. Each table's anchor rides inside its own `Pick` (./pick), so no two share one.
let branchSel: Pick = emptyPick();
let branchScopes = { local: true, remote: false };
let branchTab: "branches" | "checkouts" = "branches";
let branchFilter: BranchFilter = "all";
let branchQuery = "";
let coSel: Pick = emptyPick();
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
      depLoading = true;
      void loadGh(r);
      void loadDepsGh(r);
    } else {
      gh = { available: false, reason: null, threads: [], viewer: null };
      kept = [];
      depReport = null;
    }
    void loadDepsLocal(r);   // manifests, tools and the project's own checks: no network, any tier
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
    // Fired, not awaited: nothing else waits on either of them.
    if (wantGit) { void loadSync(r); void loadLanded(r); } else { mainWork = null; landed = null; }
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
  depLoading = true;
  renderDash();
  void loadGh(r, true);
  // The advisories and the bots' PRs were answered by the identity you have just stopped
  // using, so they are re-read with the board rather than left beside it a version behind.
  void loadDepsGh(r, true);
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

// Advisories and the bots' pull requests. Fired beside `loadGh` and awaited by nothing,
// for the same reason: it is the network, and the timeline must not wait on it.
async function loadDepsGh(r: string, force = false): Promise<void> {
  const res = await invoke<DepReport>("dep_report", { root: r, force, account: ghAccountFor(r) })
    .catch((e) => ({ available: false, reason: String(e), alerts: [], prs: [], enabled: false } as DepReport));
  if (root() !== r) return;
  depLoading = false;
  depReport = res;
  renderDash();
}

// What the manifests declare, which package managers could be asked, and the checks a brief
// should tell an agent to verify with. All local; the tool probe never runs the project.
async function loadDepsLocal(r: string): Promise<void> {
  const [m, t, tasks] = await Promise.all([
    invoke<DepManifest[]>("dep_manifests", { root: r }).catch(() => [] as DepManifest[]),
    invoke<DepTool[]>("dep_tools", { root: r }).catch(() => [] as DepTool[]),
    discoverTasks(r).catch(() => []),
  ]);
  if (root() !== r) return;
  depManifests = m;
  depTools = t;
  depVerify = verifyCommands(tasks.map((x) => ({ cmd: execCmd(x), group: x.group, blocked: x.blocked })));
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

// One page of the history for the Landed card, re-read with the pane and after a pull: never
// on a timer, and never from a render. `scope: "all"` rather than "head" — git calls a bare
// log fatal on an unborn HEAD, where "all" answers with an empty page the card draws as absent.
type GraphPage = { commits: GraphCommit[]; more: boolean };
const LANDED_PAGE = 40;
// What the section shows, out of that page: what fits under the working set, never the history
// — which is what the ⤢ panel is for. The page stays long because folding a run needs the run.
// Eight until the column has been measured once (`fitLanded`), and never fewer than MIN.
const LANDED_ROWS = 8;
const LANDED_MIN = 3;
async function loadLanded(r: string): Promise<void> {
  landedLoading = true;
  renderDash();
  const page = await invoke<GraphPage>("git_graph",
    { workdir: mainCheckout(heads, r), skip: 0, limit: LANDED_PAGE, scope: "all" }).catch(() => null);
  if (root() !== r) return;   // the user moved on while git was working
  landedLoading = false;      // inside the guard: a stale answer must not take the next project's skeleton down
  landed = page;
  renderDash();
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
    // A push moved the remote refs the Landed card's chips and lane names are read from.
    else if (root() === r) void loadLanded(r);
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

// Which days a pass may buy a sentence for. Your line has exactly one consumer — the band,
// which prints SINCE_LINES of `bandFacts`' keys — so a day past that is a `claude -p` nothing
// can ever show. The project's line has a second one, the committed digest, and that wants the
// whole window wherever it is being written (docs/dashboard.md).
function summaryDays(now: number, scope: "me" | "project"): TrailDay[] {
  if (scope === "project" && canShare(tier) && (hasDigest || digestOk().includes(root()))) return days;
  const keys = new Set(bandFacts(days, sinceAt, now, isBotAuthor).keys.slice(0, SINCE_LINES));
  return days.filter((d) => keys.has(d.key));
}

// One pass, two stages: your line for each day the band can print (the headline), then the
// project's. Within each, closed days first: they answer from disk, while today is forced and
// costs a model call. `now` is pinned so the partition and each day's `force` agree across midnight.
async function summaryPass(): Promise<void> {
  const r = root();
  const now = Date.now();
  const closedFirst = (ds: TrailDay[]) =>
    [...ds.filter((d) => dayIsClosed(d, now)), ...ds.filter((d) => !dayIsClosed(d, now))];
  try {
    stage = "me";
    for (const d of closedFirst(summaryDays(now, "me"))) if (!await summariseDay(d, r, now, "me")) return;
    stage = "project";
    renderDash();   // draw the shared boxes stage 2 fills before the first call goes out
    for (const d of closedFirst(summaryDays(now, "project"))) {
      if (!await summariseDay(d, r, now, "project")) return;
    }
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
    // No summary is a fine state: the band prints one line fewer and nothing else reads it.
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
function paint(id: string, html: string): boolean {
  if (painted.get(id) === html) return false;
  painted.set(id, html);
  $(id).innerHTML = html;
  return true;
}
// Every id in the cache is this module's alone, so nothing else can put the DOM out of step
// with it; the clear is for the project switch, where the markup of the folder you left must
// never count as a hit for the one you opened.
function invalidatePaintCache(): void { painted.clear(); }

/** Whether the next `paint` of `id` would write. Asked BEFORE a layout read, never after. */
const wouldPaint = (id: string, html: string): boolean => painted.get(id) !== html;

// A search box that lives inside painted markup is replaced by its own repaint — and by
// every GitHub answer that lands while you are typing. The value is rendered from state, so
// only the focus and the caret have to come back. Both boxes on this pane go through here.
function keepCaret(box: HTMLElement, sel: string, repaint: () => void): void {
  const cur = box.querySelector<HTMLInputElement>(sel);
  const caret = cur && document.activeElement === cur ? cur.selectionStart : null;
  repaint();
  if (caret === null) return;
  const back = box.querySelector<HTMLInputElement>(sel);
  if (back) { back.focus(); back.setSelectionRange(caret, caret); }
}

// Column C: the queue, GitHub's excuse if it has one, and the missing-card notice. `#dashNext`
// IS the scroller and the assignment rebuilding it resets scrollTop, so a GitHub answer landing
// while you read throws you back to the top of a list that no longer has an 8-row cap. The guard
// is asked first: `scrollTop` is a layout read, and on `renderAll`'s path a read on an unchanged
// pass forces the reflow the cache exists to avoid.
function paintNext(html: string): void {
  if (!wouldPaint("dashNext", html)) return;
  const box = $("dashNext");
  const keep = box.scrollTop;
  keepCaret(box, ".qq", () => { paint("dashNext", html); });
  box.scrollTop = keep;   // after keepCaret: focus() scrolls the box to reveal the field
}

// The overlay, keeping its scroll position: `paint` rebuilds the subtree, and ticking a
// checkbox halfway down the Branches table changes counts and labels too, so there is no
// smaller repaint. Restored only when the same view is still up — and, as above, nothing is
// measured on a pass that is not going to write.
function paintOverlay(view: string, html: string): void {
  const ovl = $("dashOverlay");
  if (!wouldPaint("dashOverlay", html)) { ovl.dataset.view = view; return; }
  const same = ovl.dataset.view === view;
  const keep = same ? ovl.querySelector<HTMLElement>(".ovl-b")?.scrollTop ?? 0 : 0;
  ovl.dataset.view = view;
  keepCaret(ovl, ".bvq", () => { paint("dashOverlay", html); });
  if (keep) {
    const b = ovl.querySelector<HTMLElement>(".ovl-b");
    if (b) b.scrollTop = keep;
  }
}

// ---------- the thread reader ----------
// The queue's ⤢ reads one thread in full. `gh_issue` caches on the same TTL as the board it
// was opened from, so closing a thread and opening it again is free. Guarded on the project
// AND the thread: a second ⤢ while the first is in flight must not paint the wrong body.
async function loadIssue(number: number, kind: string): Promise<void> {
  const r = root();
  issueAt = { number, kind };
  issueData = null;
  issueLoading = true;
  renderDash();
  let res: GhIssueRead | null = null;
  try {
    res = await invoke<GhIssueRead>("gh_issue", { root: r, number, kind, force: false, account: ghAccountFor(r) });
  } catch (e) {
    dlog("warn", `dash: reading #${number} failed: ${e}`);
  }
  if (root() !== r || issueAt?.number !== number) return;
  issueLoading = false;
  issueData = res;
  renderDash();
}

// One derivation for the card and the overlay: grouping and the verdict are the same work,
// and two call sites computing it separately is how two surfaces start disagreeing.
function depsNow(): { adv: Advisory[]; prs: DepPr[]; out: OutRow[] } {
  return {
    adv: groupAdvisories(depReport?.alerts ?? [], depManifests),
    prs: depReport?.prs ?? [],
    out: outRows(depRun, depManifests),
  };
}

// ---------- how many rows Landed draws ----------
// The one measured number on this page, and the measurement is RELATIVE: `free` is the slack
// the last paint left over, never the list's own top. Why that, and why it leaves a column
// that hugs its content alone, is docs/dashboard.md.
let landedFit = LANDED_ROWS;
let landedDrawn = 0;    // rows the last paint actually had; a short page cannot fill the space
let fitting = false;    // the one extra pass a new fit costs must not ask for another
function fitLanded(): boolean {
  const col = $("dashMoved");
  const last = col.lastElementChild as HTMLElement | null;
  if (!last || !col.querySelector(".lgrows")) return false;   // no list drawn: nothing to fit
  const pad = parseFloat(getComputedStyle(col).paddingBottom) || 0;
  const used = last.getBoundingClientRect().bottom
    - col.getBoundingClientRect().top - col.clientTop + col.scrollTop + pad;
  const free = Math.floor((col.clientHeight - used) / ROW_H);
  // Banking room a page of this length cannot use would spend it in one overflowing paint on
  // the next project, which is longer.
  if (free > 0 && landedDrawn < landedFit) return false;
  const n = Math.max(LANDED_MIN, Math.min(LANDED_PAGE, landedFit + free));
  if (n === landedFit) return false;
  landedFit = n;
  return true;
}

const liveIn = (path: string) => [...sessions.values()].filter((s) => (s.workdir || "") === path).length;
const liveHere = () => [...sessions.values()].filter((s) => s.colorKey === root());

export function renderDash(): void {
  if (!dashMirror()) return;
  // The bars are `<i>`s of colour, so aria-busy is what says the pane is working.
  $("dashPane").setAttribute("aria-busy",
    loading || ghLoading || landedLoading || queueRunning ? "true" : "false");
  const now = Date.now();

  // ---- column A: what is running here, this project's verbs, the repo and its checkouts ----
  // Externals count as running here: they are somebody else's terminal in this project, they
  // already have a row in the sidebar, and a section that ignored them said "nothing running"
  // over four live sessions.
  const live: LiveRow[] = [
    ...liveHere().map((s) => ({
      id: s.id,
      label: s.title || s.branch || "session",
      glyph: GLYPH[statusKey(s)] ?? "○",
      cls: GCLASS[statusKey(s)] ?? "g-idle",
      ctx: s.ctxPct != null ? `${Math.round(s.ctxPct)}%` : "",
      branch: s.branch ?? "",
    })),
    ...externals.filter((e) => (e.repo_root || e.cwd) === root()).map((e) => ({
      id: e.session_id,
      label: e.name || basename(e.cwd) || "terminal",
      glyph: "»",
      cls: extWorking(e) ? "g-work" : "g-idle",
      ctx: "",
      branch: e.branch ?? "",
      ext: true,
    })),
  ];
  // The main checkout is read by this pane and swept into `dirtyByFolder` for the dot, so
  // prefer the pane's own: two reads of one folder must not put two numbers on one screen.
  const statFor = (p: string) => (p === worksetDir() ? mainWork : dirtyByFolder.get(p));
  // The Repository card crosses the `loading` branch: it answers from `factsKnown` and the
  // heads probe, both already in hand, and waiting on the transcript scan would hide it.
  paint("dashHere", liveHereCard(live)
    + verbTiles()
    + (loading ? cardSkeleton(2) : checkoutCard(syncNow(), factsKnown, heads, liveIn, statFor))
    + projectFoot(effectiveAgent(root()).label,
      tier === "github" ? ghWho(ghAccountFor(root()), ghLogins).login ?? "" : "", claimsOn(),
      ghPickable(ghLogins)));

  // ---- column B: what moved since you were last here, the working set, what landed ----
  const f = bandFacts(days, sinceAt, now, isBotAuthor);
  // The offer counts closed days with commits, not sentences in hand: a solo day's
  // project line is not bought until somebody wants a digest.
  const unshared = canShare(tier) && !hasDigest && !digestOk().includes(root())
    ? days.filter((d) => dayIsClosed(d) && d.commits.length > 0).length
    : 0;
  // A day stage 2 is going to ask for gets its box before the sentence exists; `stage` says
  // the pass is that far along and `summaryDays` that this day is one it will reach, so a box
  // is never promised for a day the pass is no longer paying for.
  const byKey = new Map(days.map((d) => [d.key, d]));
  const willBuy = new Set(summaryDays(now, "project").map((d) => d.key));
  const pending = (k: string): boolean => {
    const d = byKey.get(k);
    return !!d && dashSummaries && stage === "project" && sharedDay(d)
      && !teamSummaries.has(k) && willBuy.has(k);
  };
  // Which already-paid-for sentence each day has is decided here, never in the view: your
  // own line first, the project's where you have none.
  const lines: BandLine[] = f.keys.map((k) => ({
    key: k,
    text: summaries.get(k) ?? teamSummaries.get(k) ?? "",
    team: !summaries.has(k) && teamSummaries.has(k),
    writing: writing?.key === k || pending(k),
  })).filter((l) => l.text || l.writing).slice(0, SINCE_LINES);
  const layout = layoutGraph(landed?.commits ?? []);
  const rows: LiteRow[] = (botFold
    ? foldBots(layout.rows, isBotAuthor)
    : layout.rows.map((row) => ({ kind: "commit", row } as const))).slice(0, landedFit);
  // Both figures are of the rows SHOWN: the chip would otherwise count commits nothing on the
  // page stands for, and the graph cell would keep a track no visible row reaches.
  const hidden = rows.reduce((n, r) => n + (r.kind === "fold" ? r.fold.commits.length : 0), 0);
  const span = rows.reduce((n, r) => Math.max(n, (r.kind === "commit" ? r.row : r.fold.row).span), 1);
  // The page is its own cheapest source for HEAD, and no HEAD on it means no ring: a page of
  // every ref cannot name the checkout, and row 0 is whichever branch happens to be newest.
  const head = layout.rows.find((r) => parseRefs(r.c.refs).some((c) => c.kind === "head"))?.c.sha ?? "";
  landedDrawn = rows.length;
  const movedChanged = paint("dashMoved", (loading
      ? bandSkeleton(tier)
      : sinceBand(f, lines, densePerDay(days, dashRange, now), dashRange, tier, factsKnown, unshared))
    + worksetCard(worksetDir(), worksetTitle(), mainWork, factsKnown && tier !== "none")
    + landedCard({
      rows, span, head, hidden,
      loading: landedLoading, known: factsKnown && tier !== "none",
    }));

  // ---- column C: one ranked queue over what were four cards ----
  const holder = (t: GhThread) => holderOf(t, gh.viewer, claims.filter((c) => c.root === root()), now);
  const stale = staleCandidates(gh.threads, kept, now).map((t) => ({ t, why: quietFor(t.updated_at, now) }));
  const dn = depsNow();
  const dtally = depTally(dn.adv, dn.prs, dn.out);
  // A note of yours that is also committed is one row, not two; the shared copy is theirs.
  const theirs = shared.filter((n) => !noteList(root()).some((x) => x.id === n.id));
  const items = rankQueue({
    threads: gh.threads, stale, adv: dn.adv, prs: dn.prs, out: dn.out,
    notes: noteList(root()), shared: theirs, holder, now,
  });
  // The search is the pool and the chips narrow it: the tally is of everything the search
  // left, never of what the filter left, so a chip still says what it would reveal.
  const found = searchQueue(items, queueQuery);
  // A search folds nothing: its result is the pool you asked for (docs/dashboard.md).
  const shown = filterQueue(found, queueFilter);
  paintNext(queueCard(queueQuery.trim() ? plainRows(shown) : foldQueue(shown, queueOpen),
      queueTally(found), queueFilter, queueQuery, gh.available || !ghLoading, !depLoading)
    + (tier === "github" && !gh.available && gh.reason
      ? ghUnavailable(gh.reason, ghLogins, ghWho(ghAccountFor(root()), ghLogins)) : "")
    + missingCard(tier, facts));

  const ovl = $("dashOverlay");
  ovl.classList.toggle("show", openView !== null);
  if (openView === null) ovl.dataset.view = "";
  else if (openView === "notes") {
    const mineShared = new Set(shared.map((n) => n.id));
    paintOverlay(openView, notesOverlay(noteList(root()), theirs, mineShared, canShare(tier)));
  }
  else if (openView === "work") paintOverlay(openView, workOverlay(bucketed(gh.threads, now), facts?.slug ?? name(), gh.threads.length, holder));
  else if (openView === "triage") paintOverlay(openView, triageOverlay(stale, kept, canShare(tier)));
  else if (openView === "issue" && issueAt) {
    const t = gh.threads.find((x) => x.number === issueAt!.number);
    paintOverlay(openView, issueOverlay({
      number: issueAt.number, kind: issueAt.kind, slug: facts?.slug ?? name(),
      data: issueData, loading: issueLoading, held: t ? holder(t) : null, now,
    }));
  }
  else if (openView === "deps") {
    paintOverlay(openView, depsOverlay({
      tab: depTab, adv: dn.adv, prs: dn.prs, out: dn.out,
      manifests: depManifests, tools: depTools, tally: dtally,
      picked: depSel.picked, outPicked: depOutSel.picked,
      headState: pickState(pickCtx("advisories"), depSel.picked),
      outHeadState: pickState(pickCtx("stale"), depOutSel.picked),
      slug: facts?.slug ?? name(), loading: depLoading,
      scanning: depScanning, scanned: depScanned, scanError: depScanError,
      // A reason only when it cost us something: an unavailable half with rows anyway
      // (the PR list answered, the alert scope did not) still says why the alerts are absent.
      reason: tier !== "github"
        ? "Advisories and bot pull requests need a GitHub remote. The manifests and the scan below do not."
        : depReport && !depReport.enabled ? depReport.reason ?? "" : "",
      dashboard: renovateDashboard(gh.threads),
    }));
  }
  else if (openView === "branches") {
    const rows = branchRowsNow();
    paintOverlay(openView, branchesOverlay({
      tab: branchTab, rows, checkouts: checkoutRowsNow(),
      root: root(), project: name(),
      picked: branchSel.picked, cpicked: coSel.picked,
      headState: pickState(pickCtx("branches"), branchSel.picked),
      coHeadState: pickState(pickCtx("checkouts"), coSel.picked),
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
  } else if (sheet?.kind === "deps") {
    const agent = effectiveAgent(root());
    const mode = providerPermissionMode(agent.id, permissionModeFor(agent.id));
    paint("dashSheet", depSheet(sheet.title, sheet.brief,
      `${agent.label} · ${mode?.label ?? "terminal config"}`, sheet.brief.split("\n").length));
  }

  // The fit is an INPUT to the markup, so it is measured once the markup is down and only after
  // a pass that wrote: an unchanged paint moved nothing, and a layout read on every renderAll
  // frame would force the reflow the guards exist to avoid.
  if (movedChanged && !landedLoading && !fitting) {
    fitting = true;
    try { if (fitLanded()) renderDash(); } finally { fitting = false; }
  }
}

// Name and location only: a project has no branch chip or session title, and the
// project verbs live in the inspector.
export function renderDashHeader(): void {
  // ✕ leaves the pane rather than closing anything of the project's — this is a place you
  // look, not a session you own — and lands on the home stage, as Escape does.
  const xb = $("btnClose") as HTMLButtonElement;
  xb.hidden = false;
  xb.title = "Close this project view (Esc)";
  ($("btnShelve") as HTMLButtonElement).hidden = true;   // ⇩ is a session verb; every stage taker sets both
  $("hProj").textContent = name();
  const hb = $("hBranch");
  hb.hidden = true;
  $("hTitle").textContent = "";
  setHeadPath(root());
  // The project wears its own icon and colour here, as it does in the sidebar: one glyph store.
  const av = $("hAvatar");
  const ic = iconFor(root());
  av.style.background = ic ? "transparent" : accentFor(root());
  av.innerHTML = ic
    ? `<img class="picon" src="${escAttr(ic)}" alt="" />`
    : esc((name()[0] || "?").toUpperCase());
  // What the folder IS, on its own line: the remote it answers to and whether its work log is
  // committed. Both are facts about the project, not about the session you happen to be in.
  $("hChips").innerHTML = [
    facts?.slug ? `<span class="chip">${esc(facts.slug)}</span>` : "",
    facts?.host && !facts.slug ? `<span class="chip">${esc(facts.host)}</span>` : "",
    !factsKnown ? "" : tier === "none" ? `<span class="chip warn">not a repo</span>` : "",
    hasDigest ? `<span class="chip acc" title="This project has a committed .episko/digest.md">.episko/ shared</span>` : "",
  ].filter(Boolean).join("");
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
    // Read this project's stamp BEFORE writing today's over it: the other order leaves the
    // band measuring from now, so it says nothing has moved for ever and no test sees it.
    sinceAt = seenAt(seen, path);
    seen = stampSeen(seen, path, Date.now());
    saveSeen(seen);
    days = []; heads = []; facts = null; openView = null;
    queueFilter = "all"; queueQuery = ""; queueOpen.clear(); botFold = true;
    landed = null; landedLoading = false;
    issueAt = null; issueData = null; issueLoading = false;
    tier = "none"; factsKnown = false; loading = true; ghLoading = false;
    gh = { available: false, reason: null, threads: [], viewer: null };
    kept = []; shared = []; hasDigest = false; sheet = null; writing = null;
    // Branch state never carries across projects: another repo's merges must not vouch for this one.
    branchData = null; branchPrs = null; branchPrsLoading = false; branchProtect = NO_PROTECT;
    branchSel = emptyPick(); coSel = emptyPick(); branchResult = null; branchBusy = false;
    branchTab = "branches"; branchFilter = "all"; branchQuery = "";
    // Another project's advisories must never be read under this one's name; the scan is
    // dropped with them, since it was an answer about that folder's lockfile.
    depReport = null; depManifests = []; depTools = []; depVerify = []; depLoading = false;
    depSel = emptyPick(); depOutSel = emptyPick(); depTab = "vulns";
    depRun = null; depScanned = ""; depScanError = ""; depScanning = "";
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
  takeStage("home");   // the collapsed rail is dash-only, and renderAll never re-takes the stage
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

// The ribbon's day popover. Everything in it is already in `days`, so a click on the chart
// never reaches disk; `densePerDay` is re-run only to name the day a quiet bar stands for,
// from the same inputs the paint used. ./dash decides what is in the card, ./menu draws it.
function openDayMenu(at: HTMLElement): void {
  const key = at.dataset.dashday!, r = root();
  const when = densePerDay(days, dashRange, Date.now()).find((x) => x.key === key)?.when ?? 0;
  const card = dayCard(days.find((x) => x.key === key));
  openMenu(at, {
    title: fmtDayLong(when),
    sub: card.tally,
    accent: accentFor(r),
    groups: card.groups,
    onPick: (id) => {
      if (id === "graph") host.openGraph(r, { from: when, to: when + 86_400_000, label: fmtDayLong(when) });
      else if (id.startsWith("sha:")) {
        const sha = id.slice(4);
        host.copyText(sha, `${sha.slice(0, 7)} copied`);
      }
    },
  });
}

// ---------- events ----------
// One delegated listener, bound once: the markup is rebuilt wholesale on every change.
export function wireDashboard(): void {
  // The box Landed is fitted to changes on a window resize, on ⌘I and when the rail collapses,
  // and none of the three reaches this module as an event. Observing the column is safe: its
  // own box is the grid's, so painting into it cannot call this back.
  new ResizeObserver(() => { if (dashMirror() && fitLanded()) renderDash(); }).observe($("dashMoved"));

  $("dashPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;

    // Select-all, for every tick-box table on this pane: the header tick and the bar's
    // buttons write the same attribute, so one branch answers four tables.
    const pall = t.closest<HTMLElement>("[data-dashpickall]");
    if (pall) { setSel(pall.dataset.dashpickall as PickKind, (cur, ctx) => togglePickAll(cur, ctx)); return; }
    const pnone = t.closest<HTMLElement>("[data-dashpicknone]");
    if (pnone) { setSel(pnone.dataset.dashpicknone as PickKind, () => pickNone()); return; }

    // A day of the band's ribbon. The click must stop here: main.ts's outside-click closer
    // would otherwise shut the popover this very click just opened.
    const bar = t.closest<HTMLElement>("[data-dashday]");
    if (bar) { e.stopPropagation(); openDayMenu(bar); return; }

    // The Repository card carries the inspector's `data-dashact` verbs: one vocabulary, two hosts.
    const gact = t.closest<HTMLElement>("[data-dashact]");
    if (gact) { dashAction(gact.dataset.dashact!); return; }

    // The queue's chips narrow one list; the ⤢ beside them is what opens a view. An empty
    // chip is `aria-disabled` rather than `disabled` — a disabled control swallows the pointer
    // events ./dom's tooltip listens for, and that tip is what says why the chip is empty —
    // so the inert half is refused here instead.
    const qf = t.closest<HTMLElement>("[data-dashqfilter]");
    if (qf) {
      if (qf.classList.contains("off")) return;
      queueFilter = qf.dataset.dashqfilter as QueueFilter;
      renderDash();
      return;
    }
    // The search's ✕ empties the box and puts the caret back in it: clearing a search is
    // usually the start of the next one.
    if (t.closest("[data-dashqclear]")) {
      queueQuery = "";
      renderDash();
      $("dashNext").querySelector<HTMLInputElement>(".qq")?.focus();
      return;
    }
    // A folded run opens and closes in place; the ranking decided where it sits.
    const qfold = t.closest<HTMLElement>("[data-dashqfold]");
    if (qfold) {
      const k = qfold.dataset.dashqfold!;
      if (!queueOpen.delete(k)) queueOpen.add(k);
      renderDash();
      return;
    }
    // One probe for the Landed card's chip and every folded row: both mean the same thing.
    const fold = t.closest<HTMLElement>("[data-dashfold]");
    if (fold) { botFold = !botFold; renderDash(); return; }

    // Mark read moves the band's floor to now for this visit only. The stored stamp was already
    // written when the pane opened, so there is nothing to save and nothing to undo on the next one.
    const seenBtn = t.closest<HTMLElement>("[data-dashseen]");
    if (seenBtn) { sinceAt = Date.now(); renderDash(); return; }

    if (t.closest("[data-dashworklog]")) { void enableDigest(); return; }

    const view = t.closest<HTMLElement>("[data-dashopen-view]");
    if (view) {
      // Checkouts is a tab of the Branches view, not a view: one table, one selection model.
      const v = view.dataset.dashopenView!;
      const branchy = v === "branches" || v === "checkouts";
      if (branchy) branchTab = v === "checkouts" ? "checkouts" : "branches";
      openView = branchy ? "branches" : (v as typeof openView);
      // Advisories is the wrong first tab where there can never be one; the scan is the
      // only half of this view a non-GitHub project has.
      if (openView === "deps" && tier !== "github") depTab = "stale";
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
    if (co) { pickRow("checkouts", co.dataset.dashco!, e.shiftKey); return; }
    // The Branches tab's row, last of its family: ⇄ and the box both sit inside it.
    const br = t.closest<HTMLElement>("[data-dashbr]");
    if (br) { pickRow("branches", br.dataset.dashbr!, e.shiftKey); return; }

    // ---- Dependencies ----
    // `dashdepopen` is a button INSIDE an advisory row and a whole row on the card, so it
    // is probed before `dashdep`; `return` ends a branch, not the propagation.
    const dopen = t.closest<HTMLElement>("[data-dashdepopen]");
    if (dopen?.dataset.dashdepopen) { void openUrl(dopen.dataset.dashdepopen).catch(() => {}); return; }
    const dtab = t.closest<HTMLElement>("[data-dashdeptab]");
    if (dtab) { depTab = dtab.dataset.dashdeptab as DepTab; renderDash(); return; }
    const dtool = t.closest<HTMLElement>("[data-dashdeptool]");
    if (dtool) { void runOutdated(dtool.dataset.dashdeptool!); return; }
    const drun = t.closest<HTMLElement>("[data-dashdeprun]");
    if (drun) { openDepSheet(drun.dataset.dashdeprun!); return; }
    const dpr = t.closest<HTMLElement>("[data-dashdeppr]");
    if (dpr) { openPrSheet(+dpr.dataset.dashdeppr!); return; }
    const dout = t.closest<HTMLElement>("[data-dashdepout]");
    // No range from the queue's copy of the row: `pickCtx("stale")` is the overlay's order and
    // the queue ranks the same packages differently, so a span there would tick rows between
    // neither of them. A plain toggle means the same thing in both.
    if (dout) { pickRow("stale", dout.dataset.dashdepout!, e.shiftKey && !dout.closest(".qcard")); return; }
    const dep = t.closest<HTMLElement>("[data-dashdep]");
    if (dep) { pickRow("advisories", dep.dataset.dashdep!, e.shiftKey); return; }

    // ---- the GitHub half ----
    const work = t.closest<HTMLElement>("[data-dashwork]");
    if (work) {
      const th = gh.threads.find((x) => x.number === +work.dataset.dashwork!);
      // Never straight to a dispatch: it sends a prompt AND writes to a public repo.
      if (th) { sheet = { kind: "dispatch", t: th }; renderDash(); }
      return;
    }
    // Before `data-dashurl`, which is the whole row: ⤢ reads the thread here rather than
    // handing it to a browser.
    const iss = t.closest<HTMLElement>("[data-dashissue]");
    if (iss) {
      const n = +iss.dataset.dashissue!;
      const th = gh.threads.find((x) => x.number === n);
      openView = "issue";
      void loadIssue(n, th?.kind === "pr" ? "pr" : "issue");
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

  // The two filter boxes; everything else in this pane is a click. A `type="search"` field
  // clears itself with its own ✕, which arrives here as an input event like any other.
  $("dashPane").addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    const q = el.closest<HTMLInputElement>(".bvq");
    if (q) { branchQuery = q.value; renderDash(); return; }
    const s = el.closest<HTMLInputElement>(".qq");
    if (s) { queueQuery = s.value; renderDash(); }
  });

  // The sheets sit over the whole stage, outside #dashPane, so they get their own handler.
  $("dashSheet").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dashsheet]");
    if (!b) return;
    const act = b.dataset.dashsheet!;
    if (act === "cancel") { sheet = null; renderDash(); return; }
    if (act === "close") { void doClose(); return; }
    if (act === "dispatch") { void doDispatch(); return; }
    if (act === "deps") { void doDepDispatch(); return; }
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

  // The form is static markup, outside everything this module paints.
  const jot = () => {
    const box = $("dashNote") as HTMLTextAreaElement;
    if (addNote(box.value, root())) { box.value = ""; renderDash(); }
  };
  ($("dashJot") as HTMLElement).addEventListener("submit", (e) => { e.preventDefault(); jot(); });
  // A textarea swallows Enter, and a note is one line far more often than several: Enter
  // files it, ⇧Enter is how you get the second line, which is what the hint says.
  ($("dashNote") as HTMLElement).addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.key !== "Enter" || k.shiftKey || k.altKey || k.metaKey || k.ctrlKey) return;
    k.preventDefault();
    jot();
  });
}

// A claim is "on" when anything at all would be written: the project's own `[claim]` table can
// veto the preference, so the answer is `resolveClaim`'s, never the stored switch alone.
function claimsOn(): boolean {
  const r = resolveClaim(policy, allow);
  return r.assign.value || r.comment.value || !!r.label.value;
}

function dashAction(act: string): void {
  const r = root(), n = name();
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
  else if (act === "agent") host.openAgentPicker(r);
  else if (act === "ghpick") host.openGhPicker(r);
  // `ghacctclear` is its own verb, so a truncated `ghacct:` can never read as "clear the pin".
  else if (act === "ghacctclear") host.setGhAccount(r, null);
  else if (act.startsWith("ghacct:")) host.setGhAccount(r, act.slice(7));
}

// ---------- Dependencies ----------
// The rules are ./deps (pure, tested); this reads, runs the one command it is allowed to
// run, and hands a brief to an agent. Nothing here writes to GitHub.

const depCtx = () => ({
  project: name(), slug: facts?.slug ?? name(), manifests: depManifests, verify: depVerify,
});

// The one verb on this pane that runs a command in the project. Explicit, one at a time,
// and its answer is kept rather than folded into the reads: a scan is a different fact
// from an advisory, and a stale one must never read as a fresh one.
async function runOutdated(tool: string): Promise<void> {
  const r = root();
  if (!r || depScanning) return;
  depScanning = tool;
  depScanError = "";
  renderDash();
  const res = await invoke<OutdatedRun>("dep_outdated", { root: r, tool })
    .catch((e) => ({ tool, ok: false, reason: String(e), rows: [] } as OutdatedRun));
  if (root() !== r) return;   // the scan outlived the stage; its answer is another folder's
  depScanning = "";           // inside the guard: a stale answer must not unlock the next folder's scan
  if (res.ok) {
    depRun = res;
    depScanned = tool;
    depOutSel = emptyPick();   // a stale tick may name a package this run no longer lists
  } else {
    depScanError = `${tool}: ${res.reason ?? "no answer"}`;
    dlog("warn", `deps · ${depScanError}`);
  }
  renderDash();
}

// Nothing is sent from a click: the brief is long, it is what the agent will act on, and
// the sheet is where you read and trim it (the dispatch rule, docs/dashboard.md).
function openDepSheet(which: string): void {
  const d = depsNow();
  if (which === "stale") {
    const picked = d.out.filter((r) => depOutSel.picked.has(r.pkg));
    if (!picked.length) return;
    sheet = { kind: "deps", title: `Update ${picked.length} package${picked.length === 1 ? "" : "s"}`,
      brief: outdatedBrief(picked, depCtx()) };
  } else {
    const picked = d.adv.filter((a) => depSel.picked.has(a.ghsa));
    if (!picked.length) return;
    sheet = { kind: "deps", title: `Work through ${picked.length} advisor${picked.length === 1 ? "y" : "ies"}`,
      brief: advisoryBrief(picked, depCtx()) };
  }
  renderDash();
}

function openPrSheet(number: number): void {
  const p = (depReport?.prs ?? []).find((x) => x.number === number);
  if (!p) return;
  sheet = { kind: "deps", title: `Review ${p.bot} PR #${p.number}`, brief: prBrief(p, depCtx()) };
  renderDash();
}

// Sent, not prefilled, like the issue dispatch beside it — and for the same reason: the
// sheet was the reading. Newlines go as a CR inside ONE chunk (a paste-newline, never a
// submit) and the submitting one is a write of its own, a beat behind (./taskrun's contract).
async function doDepDispatch(): Promise<void> {
  if (sheet?.kind !== "deps") return;
  const brief = ($("dashDepText") as HTMLTextAreaElement | null)?.value ?? sheet.brief;
  const title = sheet.title;
  sheet = null;
  renderDash();
  const sid = await host.launch(name(), root(), { colorKey: root() });
  if (typeof sid !== "string") return;   // the launch already toasted; no second complaint
  setTimeout(() => {
    void invoke("write_pty", { sessionId: sid, data: brief.replace(/\n/g, "\r") })
      .then(() => new Promise((go) => setTimeout(go, SUBMIT_MS)))
      .then(() => invoke("write_pty", { sessionId: sid, data: "\r" }))
      .catch(() => {});
  }, 1400);
  depSel = emptyPick();
  depOutSel = emptyPick();
  toast(title);
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
  branchSel = emptyPick();
  coSel = emptyPick();
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

// Delete the ticked branches wherever the scopes point. Checkouts first (git refuses to
// delete a branch a worktree holds), then the local refs, then the remote ones: a remote
// delete that ran first would leave the evidence for the local half gone.
async function runClean(): Promise<void> {
  const r = root();
  const rows = branchRowsNow();
  const picks = branchScopes.local ? localPicks(rows, branchSel.picked) : [];
  const rpicks = branchScopes.remote ? remotePicks(rows, branchSel.picked) : [];
  if (!r || branchBusy || (!picks.length && !rpicks.length)) return;
  const remote = remoteFor(rows);
  branchBusy = true;
  renderDash();
  const report: CleanReport = { wts: [], local: null, remote: null, summary: "" };
  try {
    if (picks.length) {
      for (const w of chosenWorktrees(rows, branchSel.picked)) report.wts.push(await removeOne(r, w));
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
    branchSel = emptyPick();
    if (root() === r) {
      await loadBranches(true);        // re-read: the roster and the branch list both moved
      await host.refreshGit();
      void loadLanded(r);              // the sweep moved the refs the Landed chips and lane names read
    }
    renderDash();
  }
}

// Remove the ticked checkouts. Every one reaching here is clean, unlocked and idle, so the
// branch goes with it only where git's safe delete accepts it (`deleteBranch`).
async function runCheckoutClean(): Promise<void> {
  const r = root();
  const rows = chosenCheckouts(checkoutRowsNow(), coSel.picked);
  if (!r || branchBusy || !rows.length) return;
  branchBusy = true;
  renderDash();
  const report: CleanReport = { wts: [], local: null, remote: null, summary: "" };
  for (const c of rows) report.wts.push(await removeOne(r, c.wt));
  const ok = report.wts.filter((w) => w.ok).length;
  report.summary = `${ok} of ${rows.length} checkout${rows.length === 1 ? "" : "s"} removed`;
  branchBusy = false;
  coSel = emptyPick();
  if (root() === r) {
    toast(report.summary);
    branchResult = report;
    await loadBranches(true);
    await host.refreshGit();
    void loadLanded(r);   // `removeOne` deletes the branch too, so the Landed refs moved with it
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

// ---------- selecting rows, in all four tables ----------
// ./pick owns the rule (toggle, shift-extends-and-adds, an off row is never ticked); this
// only says what each table's rows ARE and where its selection is kept. Four tables had
// three answers to "select everything" and shift in exactly one of them.

function pickCtx(kind: PickKind): PickCtx {
  if (kind === "branches") {
    const shown = shownRows();
    return { order: shown.map((r) => r.name), pickable: selectable(shown) };
  }
  if (kind === "checkouts") {
    const rows = checkoutRowsNow();
    return { order: rows.map((c) => c.wt.path), pickable: removableCheckouts(rows) };
  }
  const d = depsNow();
  // Nothing on either dependency table is ever refused: a row you can see is a row an
  // agent can be pointed at, even when the verdict is `unknown`.
  const keys = kind === "stale" ? d.out.map((r) => r.pkg) : d.adv.map((a) => a.ghsa);
  return { order: keys, pickable: new Set(keys) };
}

const selOf = (kind: PickKind): Pick =>
  kind === "branches" ? branchSel : kind === "checkouts" ? coSel : kind === "stale" ? depOutSel : depSel;

function setSel(kind: PickKind, next: (cur: Pick, ctx: PickCtx) => Pick): void {
  const cur = selOf(kind);
  const v = next(cur, pickCtx(kind));
  if (kind === "branches") branchSel = v;
  else if (kind === "checkouts") coSel = v;
  else if (kind === "stale") depOutSel = v;
  else depSel = v;
  renderDash();
}

function pickRow(kind: PickKind, key: string, shift: boolean): void {
  // The rows refuse a text selection in CSS; this clears one anchored outside the table,
  // which is the other half of why a shift-click used to paint a blue blob over it.
  if (shift) window.getSelection()?.removeAllRanges();
  const before = selOf(kind), ctx = pickCtx(kind);
  setSel(kind, (cur, c) => applyPick(cur, key, { ...c, range: shift }));
  // Most branches are not deletable, so a range over ten rows ticks two and the other eight
  // stay as they were. Unsaid, that is indistinguishable from the range not having worked.
  if (!shift || !before.anchor || before.anchor === key) return;
  const { took, refused } = rangeOutcome(ctx, before.anchor, key);
  if (refused) toast(`${took} ticked · ${refused} not offered — see why on the row`);
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
