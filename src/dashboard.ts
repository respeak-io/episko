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
import { $, takeStage, toast } from "./dom";
import { dlog } from "./debug";
import {
  canShare, clampRange, DASH_RANGE_DEFAULT, dashDays, dashPulse, densePerDay,
  mainCheckout, projectCost, projectTier, type ProjectFacts, type ProjectTier,
} from "./dash";
import {
  branchesOverlay, cardSkeleton, checkoutsCard, checkoutsOverlay, closeSheet, dashInspector,
  dashStrip, dayHtml, dispatchSheet, ghUnavailable, missingCard, notesCard, notesOverlay,
  pulseHtml, pulseSkeleton, spineSkeleton, triageCard, triageOverlay, workCard,
  workLogOffer, workOverlay, type DashPull,
} from "./dashview";
import {
  chosenWorktrees, localCands, remoteCands, remoteFor, remotePicks, selectable, sweepPicks,
  trunkOf, trunkOptions, type BranchInfo, type MergedPrs, type SweepResult, type WtInfo,
} from "./branches";
import {
  ALLOW_ALL, claims, claimForSession, DEFAULT_POLICY, dropClaim, recordClaim,
  resolveClaim, type ClaimAllow, type ClaimOutcome, type ClaimPolicy,
} from "./claim";
import {
  bucketed, cardRows, claimComment, closeComment, holderOf, isoDay, quietFor,
  releaseComment, staleCandidates, type GhResult, type GhThread, type KeptIssue,
} from "./ghwork";
import type { HistEntry } from "./history";
import { addNote, noteList, removeNote, type SharedNote } from "./notes";
import { GLYPH, GCLASS } from "./sidebarview";
import {
  deterministicHeadline, dayFacts, dayIsClosed, humanAuthors, projectDayFacts, sharedDay,
  type TrailCommit, type TrailDay,
} from "./trail";
import { statusKey, type DiffStat, type GitActionResult, type WtHead } from "./types";
import { usageDetail, usageWindow } from "./usage";
import {
  accentFor, cmpBase, dashMirror, externals, folderDirty, permMode, sessions, setActiveId,
  setMirror,
} from "./state";

// What this pane does but does not own. Same host-object shape as ./settings and
// ./palui: a control surface that touches many things it isn't responsible for takes
// one host rather than a dozen setters.
export interface DashHost {
  // `string | null`, NOT `unknown`: three call sites below guard on `typeof sid !==
  // "string"` to decide whether to type a prompt in and write a claim, so a host whose
  // launch resolves to `undefined` makes all three permanently take the failure branch
  // — which shipped, silently, because `unknown` accepted a `void`-returning launch.
  launch: (project: string, workdir: string, opts?: { colorKey?: string }) => Promise<string | null>;
  /// "Where should this session start?" — a plain launch in a folder that isn't a repo,
  /// the new-session dialog in one that is. `launch` above is the unconditional verb and
  /// is what a *dispatch* wants (it has already decided); this is what a **person**
  /// clicking ＋ wants, which is why the two are separate host entries rather than one.
  requestLaunch: (project: string, path: string, known: { branch: string } | null) => void;
  openTerminal: (dir: string) => void;
  /// Prefill a command in a terminal rather than running it. `git_action` refuses the
  /// cases it cannot finish safely from a button — a diverged branch, a branch with no
  /// upstream, a `-D` the Branches view will not force — and names the command that
  /// *would* work; without somewhere to put that command the refusal is a dead end,
  /// which is worse than not offering the verb. Needs a pane, which is panes.ts's
  /// business.
  handToTerminal: (project: string, dir: string, cmd: string) => void;
  openRun: (root: string) => void;
  openGraph: (root: string) => void;
  openHistory: (root: string) => void;
  openFolder: (dir: string) => void;
  copyPath: (dir: string) => void;
  setActive: (id: string) => void;
  renderAll: () => void;
  // ---- what the Branches view needs and this module doesn't own ----
  /// Re-read the ⑃ roster the sidebar draws: a cleanup removes checkouts, and `renderAll`
  /// only paints that roster, it never re-reads it.
  refreshGit: () => Promise<void>;
  /// The shared branch popover (the ⑃ dialog owns the element), used here to change the
  /// trunk everything is measured against.
  pickTrunk: (
    anchor: HTMLElement, items: { name: string; note: string }[], current: string,
    onPick: (ref: string) => void,
  ) => void;
  /// Persist that choice. A stored preference, so the write belongs to actions.ts.
  saveTrunk: (repoDir: string, ref: string) => void;
}
let host: DashHost = {
  launch: async () => null, requestLaunch: () => {}, openTerminal: () => {},
  openRun: () => {}, openGraph: () => {}, openHistory: () => {}, openFolder: () => {},
  copyPath: () => {}, setActive: () => {}, renderAll: () => {},
  refreshGit: async () => {}, handToTerminal: () => {}, pickTrunk: () => {}, saveTrunk: () => {},
};
export function setDashHost(h: DashHost) { host = h; }

/// How long to wait between typing a dispatched prompt and sending the Enter that
/// submits it. It exists because the two must not arrive in one read: Claude's REPL
/// treats a burst as a paste and folds the `\r` into the buffer as a newline. Anything
/// clear of a single event-loop turn does it; this is a keystroke's worth of slack.
const SUBMIT_MS = 250;

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
/// Where the main checkout's branch sat against its upstream at the last fetch — the
/// only thing ⇣ Pull says before it runs, and deliberately the *stale* number: see
/// `pullState`. Null until the probe answers, and for a folder git could not read.
let mainStat: DiffStat | null = null;
/// The root of the pull in flight, if any — **a path, not a boolean**, so switching
/// project mid-pull doesn't put "Pulling…" on a dashboard where nothing is. Not folded
/// into `loading`: those are the reads that fill the pane, this is a write the user
/// asked for, and it must not blank the timeline. One at a time app-wide, which is
/// deliberate: two `git fetch`es at once on one machine buy nothing.
let pulling: string | null = null;
/**
 * The waits, and they are deliberately separate flags rather than one `isLoading` —
 * three here, plus `writing`/`stage` down with the summary queue. Each starts at a
 * different moment, ends at a different moment, and darkens a different part of the
 * screen; one flag over the lot would either skeleton a surface that already has its
 * answer or leave one that doesn't looking settled.
 */
let loading = false;                 // the local reads: facts, history, git log, digest
/// Whether `project_facts` has answered **for the project now on screen**. Not the same
/// question as `loading`: a range change reloads the timeline without putting the tier
/// back in doubt, so the inspector's repo verbs must not blink for it. False only
/// between clicking a new project and its facts landing — during which `tier` reads
/// `none`, which is an assertion this has no basis for yet.
let factsKnown = false;
/// The GitHub half, which fires *after* the local reads and used to be entirely silent:
/// the Open work card was simply not there yet, which on a repo whose issues are the
/// point reads as `gh` being broken rather than as `gh` being slow.
let ghLoading = false;
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
/// Which day rows are expanded. Survives a re-render because it is keyed by day, not by
/// element — a repaint that changes anything replaces the whole timeline (see `paint`).
const openDays = new Set<string>();
/// Which enlarge overlay is up, if any.
let openView: "checkouts" | "notes" | "work" | "triage" | "branches" | null = null;

/// ---- the Branches view ----------------------------------------------------------
/// Everything the cleanup needs, read when the view opens rather than with the rest of
/// the dashboard: three git calls and a network one, for a surface most visits never
/// open. `null` means "not read yet", which is what the skeleton is drawn from.
let branchData: { branches: BranchInfo[]; worktrees: WtInfo[] } | null = null;
let branchPrs: MergedPrs | null = null;
let branchPrsLoading = false;
/// Ticked, per half. Two sets and not one: a name can be a local branch AND a remote-only
/// row in different repos, and more to the point the two halves run different commands —
/// sharing a set would let a click on one side arm the other.
let branchPick = new Set<string>();
let branchRPick = new Set<string>();
let branchBusy = false;
/// What the last run did, held on screen until dismissed. A bulk result is a list, and
/// half of it — what was kept, and why — is the part you act on next.
let branchResult: { swept: SweepResult; wts: { label: string; ok: boolean; note: string }[]; remote?: string } | null = null;
/// The one day whose sentence is out at the model right now, and in which scope. One at
/// a time by construction — `runSummaryQueue` is sequential — so this is a value, not a
/// set, and the mark it draws walks down the timeline as the queue does.
let writing: { key: string; scope: "me" | "project" } | null = null;
/// Which half of a pass is running. It is what lets a *shared* box be drawn before its
/// sentence exists: during stage 2 every shared day with no line yet is genuinely queued
/// for one. Gated on the stage rather than on the whole queue because stage 1 can be a
/// fortnight of calls, and a screenful of boxes shimmering through all of it promises
/// something that is true but not yet happening.
let stage: "me" | "project" | null = null;

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
  // `openDashboard` sets `loading` before this is even called, so bailing without
  // clearing it would leave the pane shimmering at a skeleton nothing is filling.
  if (!r) { loading = false; return; }
  loading = true;
  ghLoading = false;
  summaries.clear();
  teamSummaries.clear();
  renderDash();
  try {
    // `project_facts` first and alone: it decides which of the calls below are even
    // worth making, and a folder that isn't a repo must not be asked for a git log.
    const f = await invoke<ProjectFacts>("project_facts", { dir: r }).catch(() => null);
    // Everything below is an answer *about `r`*, and a load for another project may have
    // started while this one was awaiting — in which case that load owns the state and
    // this one must touch none of it, `loading` included. The same guard `loadGh` has
    // always had, needed at both awaits here because both write module state; without it
    // a stale continuation lands the previous project's tier under the new one's name
    // and, worse, declares it *known*.
    if (root() !== r) return;
    facts = f;
    tier = projectTier(facts);
    factsKnown = true;
    // **The GitHub half starts HERE — first, not last.** It used to be fired after the
    // reads below, on the reasoning that `gh` is a process per call and the timeline
    // should paint without waiting for the network. That reasoning is satisfied by not
    // *awaiting* it, which is already the case; firing it late only meant the network
    // could not begin until a scan of every transcript on the machine had finished — for
    // a card that has nothing to do with any of them. Measured on this machine: ~1–2s of
    // local reads in front of ~1.3s of `gh`, for a total nobody could explain by looking
    // at either half. It needs the tier and the root, both of which are known one line up.
    if (tier === "github") {
      ghLoading = true;
      void loadGh(r);
    } else {
      gh = { available: false, reason: null, threads: [], viewer: null };
      kept = [];
    }
    // The tier is what the inspector's repo verbs and the strip's hang off, and they are
    // painted by `renderAll`, not by us — so say so now rather than at the end of the
    // reads below, which are several seconds of history scanning away.
    host.renderAll();
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
    if (root() !== r) return;
    shared = sn;
    heads = wt.filter((w) => w.exists);
    // One `git status --porcelain=v2 --branch` for the main checkout, so ⇣ Pull can say
    // what it is about to do. Fired rather than awaited: it is the only thing on the
    // pane that nothing else waits for, and the timeline should not.
    if (wantGit) void loadSync(r); else mainStat = null;
    // The digest carries the PROJECT's line, not yours — that is the whole point of the
    // split, and seeding `summaries` from it would put a colleague's sentence where your
    // own day belongs while suppressing the one you'd have generated.
    for (const [k, v] of Object.entries(digest)) if (v) teamSummaries.set(k, v);
    hasDigest = Object.keys(digest).length > 0
      || (wantGit && await invoke<boolean>("has_digest", { root: r }).catch(() => false));
    days = dashDays(r, hist, commits, usageWindow(dashRange), (k) => projectCost(usageDetail, k, name()));
  } finally {
    // Guarded like every other write above: clearing it unconditionally would take the
    // *next* project's skeletons down while its own load is still running.
    if (root() === r) loading = false;
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
  // Cleared inside the guard, never before it: a stale call landing after the user has
  // moved to another GitHub project would otherwise take that project's skeleton down
  // and leave its own, still-running, call with nothing on screen saying so.
  ghLoading = false;
  gh = res; kept = k; allow = a;
  renderDash();
}

/**
 * Where the main checkout stands against its remote, for the ⇣ Pull verb.
 *
 * `git_diffstat` and not `upstream_state` because there is no command for the latter on
 * its own — and no reason to want one: the diffstat is a single `git status
 * --porcelain=v2 --branch`, which carries the upstream and the ahead/behind counts, and
 * skips its `--numstat` walk entirely on a clean tree. One process, whichever it is.
 *
 * Deliberately **not** a fetch. A network call per project click would make opening a
 * dashboard cost a remote round trip, on a pane whose one invariant is that it costs
 * nothing to not open — and it can hang for the full 45s timeout on an unreachable
 * remote. So the numbers this reads are as old as the last fetch, every wording says so,
 * and the verb fetches for itself.
 */
async function loadSync(r: string): Promise<void> {
  const g = await invoke<DiffStat | null>("git_diffstat", { workdir: mainCheckout(heads, r) })
    .catch(() => null);
  if (root() !== r) return;   // the user moved on while this was in flight
  mainStat = g;
  renderDashInspector();
}

/**
 * Pull the project's main checkout, from the dashboard — the routine half of git,
 * without opening a session or dropping to a shell for it.
 *
 * **It fetches first, always, and that is the point.** Nothing on a dashboard runs git
 * on a schedule, so the ahead/behind this pane knows about is as old as the last time
 * anything happened in that folder — and `git_action("pull")` short-circuits on exactly
 * that stale count, answering "already up to date" without ever reaching the remote. A
 * button that reports success for doing nothing is worse than no button. So: fetch,
 * re-read, and only then decide.
 *
 * Everything unsafe stays refused by the backend, which is where the rule belongs: the
 * pull is `--ff-only`, a diverged or upstream-less branch is declined *before* git runs,
 * and the command that would work comes back as `suggest` for a prefilled terminal.
 * Nothing here can leave a working tree in a state this pane cannot explain — which
 * matters more here than in a session's inspector, because the main checkout is the one
 * folder you are least likely to be looking at while it changes.
 */
async function pullMain(): Promise<void> {
  const r = root(), n = name();
  if (!r || pulling || tier === "none") return;
  const dir = mainCheckout(heads, r);
  pulling = r;
  renderDashInspector();
  /// Set when the whole pane is being re-read, so the `finally` doesn't spend a second
  /// git process on the state `loadDash` is already on its way to reading.
  let reloading = false;
  // A refusal is not an error: the backend declined a case it can't finish safely and
  // named the command that would, so hand that over rather than ending in a toast.
  const report = (op: string, res: GitActionResult): boolean => {
    dlog(res.ok ? "info" : "warn", `dash git ${op} · ${n} · ${res.summary}`);
    if (res.ok) { toast(`${op}: ${res.summary}`); return true; }
    if (res.suggest) {
      toast(`${op}: ${res.summary} → opening a terminal`);
      host.handToTerminal(n, dir, res.suggest);
    } else toast(`${op}: ${res.summary}`);
    return false;
  };
  try {
    if (!report("fetch", await invoke<GitActionResult>("git_action", { workdir: dir, op: "fetch" }))) return;
    // Now the counts mean something. `upstream` is what separates the two zeroes: a
    // branch that tracks nothing also reads 0 behind, and calling that "up to date"
    // would swallow the one case with a real answer — the backend's refusal names the
    // `--set-upstream-to` that fixes it.
    const g = await invoke<DiffStat | null>("git_diffstat", { workdir: dir }).catch(() => null);
    if (root() !== r) return;
    mainStat = g;
    if (g?.upstream && g.behind === 0) {
      toast(`pull: already up to date with ${g.upstream}`);
      return;
    }
    if (!report("pull", await invoke<GitActionResult>("git_action", { workdir: dir, op: "pull" }))) return;
    // New commits, and possibly a colleague's `.episko/digest.md` and notes with them —
    // which is the whole payoff of pulling from here. Re-read rather than patch: this is
    // the same reload a range change does, and the pane has no other way to be right.
    if (root() === r) { reloading = true; void loadDash(); }
  } catch (e) {
    dlog("error", `dash pull failed — ${e}`);
    toast(`git pull: ${e}`);
  } finally {
    pulling = null;
    if (root() === r) {
      // However it went, say where the branch stands now — a fetch that failed on a
      // dead remote leaves the pre-click numbers on screen otherwise, reading as though
      // the click never happened.
      if (!reloading) void loadSync(r);
      renderDashInspector();
    }
  }
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
    // A pass that answered every day from cache never renders on its own, so the marks
    // it drew on the way in would sit there until something else repainted.
    renderDash();
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
  try {
    stage = "me";
    for (const d of ordered) if (!await summariseDay(d, r, now, "me")) return;
    stage = "project";
    // The shared boxes this stage is about to fill, drawn before the first call goes
    // out: the box is a block that would otherwise appear from nothing, and its heading
    // — that this day had more than one human committer, and who — has been known since
    // the timeline was assembled.
    renderDash();
    for (const d of ordered) if (!await summariseDay(d, r, now, "project")) return;
  } finally {
    stage = null;
  }
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
  // Marked only from here, past every early return above: a day answered from cache or
  // skipped by the sharing rule is not waiting on anything, and marking it would put a
  // "writing…" on rows that will never change.
  writing = { key: d.key, scope };
  renderDash();
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
  } finally {
    // Cleared and repainted however the call went, so a failed or empty one doesn't
    // leave its row claiming to still be writing. Safe to null unconditionally: the
    // queue is sequential, so nothing newer can have claimed the slot.
    writing = null;
    if (root() === r) renderDash();
  }
  return true;
}

// ---------- render ----------
/**
 * Assign only when the markup actually changed — the same "build always, assign only on
 * a change" guard ./sidebar and ./tray already use, and the same non-claim: no DOM is
 * compared or patched, so the render-everything rule is intact.
 *
 * It is needed *more* here than on the sidebar. `renderDash` sits on `renderAll`'s path,
 * `renderAll` fires on **every telemetry event**, and a handful of live agents put that
 * at several times a second — while almost nothing on screen changes: `shortAge` is
 * minute-granular, `gh_threads` is cached 60s, and the notes are localStorage. The cost
 * was never the string building, it was that an `innerHTML` assignment **destroys the
 * node under the pointer**:
 *
 *   • `▶ Start` lost and re-acquired `:hover` on every hook, restarting its `.14s`
 *     colour transition from the top — a button that visibly pulsed while the mouse sat
 *     still on it, which is what sent somebody looking for an animation bug.
 *   • `#dashNote` is an `<input>` inside `#dashAside`. A replaced input is an empty one,
 *     so jotting a note while anything was running lost the text between keystrokes.
 *
 * Both are the same defect, and neither is visible on an idle fleet — which is exactly
 * the state a dashboard gets developed in.
 */
const painted = new Map<string, string>();
function paint(id: string, html: string): void {
  if (painted.get(id) === html) return;
  painted.set(id, html);
  $(id).innerHTML = html;
}
/**
 * The cache is "what *this module* last wrote", so it may only be trusted while the
 * dashboard has held the stage continuously. `#inspector` is what makes that more than
 * paranoia: ./inspector and ./mirror write it too, so a session visited in between
 * leaves an entry describing markup that is no longer on screen. `openDashboard` is the
 * only place the dash mirror is ever set, so clearing there covers every route back in.
 */
function invalidatePaintCache(): void { painted.clear(); }

/**
 * The overlay, keeping its scroll position.
 *
 * `paint` rebuilds the whole subtree whenever the string differs, which destroys the
 * element the scroll lives on — fine for a surface that only changes when its data does,
 * and wrong for one you *interact* with: ticking a checkbox halfway down the Branches
 * table threw the view back to the top, every time. The guard against the cheap fix
 * (paint less) is that the counts, the button label and the row highlight all change with
 * that tick, so there is no smaller correct repaint; what has to survive is the scroll.
 *
 * Restored only when the same view is still up — a *different* overlay opening should of
 * course start at its own top.
 */
function paintOverlay(view: string, html: string): void {
  const ovl = $("dashOverlay");
  const keep = ovl.dataset.view === view ? ovl.querySelector<HTMLElement>(".ovl-b")?.scrollTop ?? 0 : 0;
  ovl.dataset.view = view;
  paint("dashOverlay", html);
  if (keep) {
    const b = ovl.querySelector<HTMLElement>(".ovl-b");
    if (b) b.scrollTop = keep;
  }
}

const liveIn = (path: string) => [...sessions.values()].filter((s) => (s.workdir || "") === path).length;
const liveHere = () => [...sessions.values()].filter((s) => s.colorKey === root());

export function renderDash(): void {
  if (!dashMirror()) return;
  // One place says the pane is working, because the bars themselves say nothing: they
  // are `<i>`s of colour, and a reader not looking at them needs the state, not the
  // shape. Every wait counts, including the two that leave real content on screen.
  $("dashPane").setAttribute("aria-busy", loading || ghLoading || queueRunning ? "true" : "false");
  const p = dashPulse(days);
  const dense = densePerDay(days, dashRange, Date.now());
  // A row of zeros is not an empty answer, it is a wrong one — `dashPulse([])` counts no
  // commits, no sessions and no contributors for a project that may have had plenty, and
  // reads as "nothing happened here" rather than "nothing has been read yet".
  paint("dashPulse", loading ? pulseSkeleton(dashRange) : pulseHtml(p, tier, dashRange, dense));

  let spine: string;
  if (loading) {
    spine = spineSkeleton();
  } else if (!days.length) {
    spine = `<div class="db-empty">Nothing in the last ${dashRange} days.
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
    spine = days.map((d) =>
      dayHtml(d, summaries.get(d.key) ?? null, deterministicHeadline(d), openDays.has(d.key),
        // Written for every day, shown only where it says something your own line
        // doesn't — see `sharedDay`.
        sharedDay(d) ? teamSummaries.get(d.key) ?? null : null, humanAuthors(d),
        {
          mine: writing?.scope === "me" && writing.key === d.key,
          // The whole of stage 2, not just the call in flight: every shared day without
          // a line is queued for one, and `sharedDay` is exactly the condition under
          // which `summariseDay` buys it — so the box drawn here is one that will fill.
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

  // **The GitHub cards cross the `loading` branch, and they are the second half of
  // firing `loadGh` first.** Moving the call to the front of `loadDash` only helps if an
  // answer that arrives early can be *shown* early — and this used to switch the entire
  // column on `loading`, so a result already in hand sat hidden behind a scan of every
  // transcript on the machine that it has nothing to do with. They now carry their own
  // state (skeleton → cards) through both branches, which is the same exemption Notes
  // have always had and for the same reason: a card that no longer needs the wait must
  // not sit in it.
  //
  // It also gives the GitHub half a skeleton **of its own** during the long read. One
  // generic `cardSkeleton` stood in for up to four cards, so the card people open the
  // dashboard for was not pending, it was simply absent — which reads as nothing being
  // there rather than as something being on its way.
  const ghCards = ghLoading
    ? cardSkeleton()
    : gh.available
      ? workCard(cardRows(gh.threads), gh.threads.length, prs, holder)
        + triageCard(stale, gh.threads.filter((t) => t.kind === "issue").length)
      : "";
  // Notes survive the wait because they never needed the wait: they are localStorage and
  // are already correct, and the jot box is the one thing here you might have opened the
  // project to type into. What is left in the loading branch is either unread or, in
  // `missingCard`'s case, a statement about a tier that hasn't been answered.
  paint("dashAside", loading
    ? ghCards + cardSkeleton() + notesCard(noteList(root()))
    : ghCards
      + checkoutsCard(heads, liveIn, folderDirty)
      + notesCard(noteList(root()))
      + (tier === "github" && !gh.available && gh.reason ? ghUnavailable(gh.reason) : "")
      + missingCard(tier, facts));

  const ovl = $("dashOverlay");
  ovl.classList.toggle("show", openView !== null);
  if (openView === null) ovl.dataset.view = "";
  else if (openView === "checkouts") paintOverlay(openView, checkoutsOverlay(heads, liveIn, folderDirty));
  else if (openView === "notes") {
    const mineShared = new Set(shared.map((n) => n.id));
    // A colleague's note is theirs; ours are the ones we can promote or withdraw.
    const theirs = shared.filter((n) => !noteList(root()).some((x) => x.id === n.id));
    paintOverlay(openView, notesOverlay(noteList(root()), theirs, mineShared, canShare(tier)));
  }
  else if (openView === "work") paintOverlay(openView, workOverlay(bucketed(gh.threads, now), facts?.slug ?? name(), gh.threads.length, holder));
  else if (openView === "triage") paintOverlay(openView, triageOverlay(stale, kept, canShare(tier)));
  else if (openView === "branches") {
    const local = localCandsNow(), remote = remoteCandsNow();
    paintOverlay(openView, branchesOverlay({
      local, remote, picked: branchPick, rpicked: branchRPick,
      trunk: trunkOf(branchData?.branches ?? []), remoteName: remoteFor(remote),
      prs: branchPrs, prsLoading: branchPrsLoading,
      busy: branchBusy, loading: branchData === null, result: branchResult,
    }));
  }

  $("dashSheet").classList.toggle("show", sheet !== null);
  $("dashScrim").classList.toggle("show", sheet !== null);
  if (sheet?.kind === "close") paint("dashSheet", closeSheet(sheet.t, closeComment(sheet.t, now), facts?.slug ?? name()));
  else if (sheet?.kind === "dispatch") {
    paint("dashSheet", dispatchSheet(sheet.t, policy, allow, permMode, holder(sheet.t)));
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
  // Null until the tier is known, so the verb never appears and then vanishes on a
  // folder that turns out not to be a repo — the same `factsKnown` gate the rest of the
  // repo verbs sit behind, passed as absence rather than as a fourth flag.
  const pull: DashPull | null = factsKnown && tier !== "none"
    ? { branch: heads.find((h) => h.is_main)?.branch ?? "", g: mainStat, busy: pulling === root() }
    : null;
  paint("inspector", dashInspector(root(), tier, facts, live, hasDigest, factsKnown, pull));
  paint("dashStrip", dashStrip(accentFor(root()), (name()[0] || "?").toUpperCase(), tier,
    live.map((s) => ({ id: s.id, glyph: s.glyph, cls: s.cls, label: s.label })), factsKnown, pull));
}

// ---------- open / close ----------
export function openDashboard(project: string, path: string): void {
  const changed = root() !== path;
  // Unconditionally, including when the project is unchanged: `#inspector` belongs to
  // whatever holds the stage, so a session visited in between has overwritten markup
  // this module still believes it put there. See `invalidatePaintCache`.
  invalidatePaintCache();
  setMirror({ kind: "dash", root: path, name: project });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("dash");
  document.documentElement.style.setProperty("--accent", accentFor(path));
  // A new project inherits nothing. Everything below is an *answer about a folder*, so
  // leaving any of it in place shows the previous project's answer under this one's name
  // — and `renderAll` below paints before `loadDash` has reached its first await, so
  // there is a real frame in which it would. `loading` is part of the reset for the same
  // reason: it is what the paint reads to know it has nothing yet.
  if (changed) {
    days = []; heads = []; facts = null; openDays.clear(); openView = null;
    tier = "none"; factsKnown = false; loading = true; ghLoading = false;
    gh = { available: false, reason: null, threads: [], viewer: null };
    kept = []; shared = []; hasDigest = false; sheet = null; writing = null;
    // The Branches view is per repo in every part: its rows, its ticks, and the merged
    // pull requests that vouch for them. Carrying any of it across would offer to delete
    // one project's branches on the strength of another's merges.
    branchData = null; branchPrs = null; branchPrsLoading = false;
    branchPick = new Set(); branchRPick = new Set(); branchResult = null; branchBusy = false;
    // `pulling` is NOT in this reset: it names the folder a real git process is running
    // in, which switching project does not stop. Clearing it would re-enable the button
    // and let a second fetch start behind the first. Its own `finally` clears it.
    mainStat = null;
  }
  host.renderAll();
  void loadDash();
}

export function closeDashboard(): void {
  if (!dashMirror()) return;
  setMirror(null);
  openView = null;
  // Takes the collapsed rail with it — that is a dashboard-only mode, and left set the
  // next session gets a 44px inspector holding the wrong buttons. It also brings the
  // empty card back: `renderAll` never touches it, so closing the last thing on the
  // stage by hand used to leave a blank one.
  takeStage("none");
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
    if (view) {
      openView = view.dataset.dashopenView as typeof openView;
      renderDash();
      if (openView === "branches") void loadBranches();
      return;
    }
    if (t.closest("[data-dashclose-view]")) { openView = null; branchResult = null; renderDash(); return; }

    // ---- the Branches view ----
    const brpick = t.closest<HTMLElement>("[data-dashbrpick]");
    if (brpick) {
      // "<half>:<branch>" — a branch name may contain ":" nowhere git allows, but it may
      // contain "/", so split on the FIRST colon only.
      const raw = brpick.dataset.dashbrpick!;
      const cut = raw.indexOf(":");
      const half = raw.slice(0, cut), n = raw.slice(cut + 1);
      const set = half === "remote" ? branchRPick : branchPick;
      if (set.has(n)) set.delete(n); else set.add(n);
      renderDash();
      return;
    }
    const brall = t.closest<HTMLElement>("[data-dashbrall]");
    if (brall) {
      if (brall.dataset.dashbrall === "remote") branchRPick = selectable(remoteCandsNow());
      else branchPick = selectable(localCandsNow());
      renderDash();
      return;
    }
    const brnone = t.closest<HTMLElement>("[data-dashbrnone]");
    if (brnone) {
      if (brnone.dataset.dashbrnone === "remote") branchRPick = new Set(); else branchPick = new Set();
      renderDash();
      return;
    }
    const brrun = t.closest<HTMLElement>("[data-dashbrrun]");
    if (brrun) {
      if (brrun.dataset.dashbrrun === "remote") void runRemoteClean(); else void runLocalClean();
      return;
    }
    if (t.closest("[data-dashbrdone]")) { branchResult = null; renderDash(); return; }
    if (t.closest("[data-dashbrterm]")) {
      const cmd = branchResult?.swept.suggest;
      // Never run from a click, same rule as the single-branch delete: a `-D` goes to a
      // terminal where it can be read first.
      if (cmd) { openView = null; branchResult = null; renderDash(); host.handToTerminal(name(), root(), cmd); }
      return;
    }
    const brtrunk = t.closest<HTMLElement>("[data-dashbrtrunk]");
    if (brtrunk) { host.pickTrunk(brtrunk, trunkOptions(branchData?.branches ?? []), cmpBase[root()] ?? "", (ref) => {
      host.saveTrunk(root(), ref);
      branchData = null;                 // the numbers are git's, so they have to be re-read
      renderDash();
      void loadBranches(true);
    }); return; }

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
  // ONE ＋, not two. It used to be a bare launch in the project root beside a separate
  // "New worktree session…", which made the row you wanted depend on knowing whether the
  // folder was a repo — a question the dashboard has already answered on screen. This is
  // the same call the header's ＋ Session makes, so both ＋ in this view now mean the
  // same thing: dialog on a repo, plain launch on a folder that has no branches to pick.
  if (act === "launch") host.requestLaunch(n, r, dashLaunchHint());
  else if (act === "terminal") host.openTerminal(r);
  else if (act === "run") host.openRun(r);
  else if (act === "pull") void pullMain();
  else if (act === "graph") host.openGraph(r);
  else if (act === "cleanup") openBranchesView(n, r);
  else if (act === "history") host.openHistory(r);
  else if (act === "folder") host.openFolder(r);
  else if (act === "copypath") host.copyPath(r);
  else if (act === "worklog") void enableDigest();
}

// ---------- the Branches view ----------
// The cleanup that used to live in the ⑃ dialog's detail column. It moved because the
// decision is a table — one row per branch, a checkbox down the side — and the dialog
// could only give it half a column beside a second list. The rules stayed in ./branches
// (pure, tested); what is here is the reading, the running and the reporting.

/// Read what the view needs. Three local git calls and one network call, and only ever
/// when the view is actually opened — the dashboard's own invariant, one level down.
async function loadBranches(force = false): Promise<void> {
  const r = root();
  if (!r || (branchData && !force)) return;
  const [branches, worktrees] = await Promise.all([
    invoke<BranchInfo[]>("git_branch_list", { repoDir: r, base: cmpBase[r] ?? null }).catch(() => [] as BranchInfo[]),
    invoke<WtInfo[]>("list_worktrees", { repoDir: r }).catch(() => [] as WtInfo[]),
  ]);
  if (root() !== r) return;                      // the stage moved to another project
  branchData = { branches, worktrees };
  // **Nothing is ticked on arrival.** This is the Branches view — you open it to look at
  // your branches, and deleting them is something you opt into. Landing on a full set of
  // ticks and a "Delete 4" makes the destructive reading the default one, and turns the
  // careful part (reading the rows) into work you have to undo. `All` is one click away.
  // Fresh reads also mean a fresh selection: a name ticked before a refresh may not exist.
  branchPick = new Set();
  branchRPick = new Set();
  renderDash();
  if (branchPrs || branchPrsLoading) return;
  branchPrsLoading = true;
  const prs = await invoke<MergedPrs>("gh_merged_prs", { root: r, force: false }).catch(() => null);
  branchPrsLoading = false;
  // Guarded on the PROJECT, not on a load counter: this lands a beat after the git reads
  // and must not be discarded because they finished in the meantime. Nothing asks twice.
  if (root() !== r) return;
  branchPrs = prs ?? { available: false, reason: "gh could not be reached", prs: [] };
  // The answer can only ADD rows (a squash-merged branch is invisible until now). They
  // arrive unticked like everything else — a row appearing under the pointer *already
  // selected* is the worst version of a late answer.
  renderDash();
}

const localCandsNow = () => branchData ? localCands({
  branches: branchData.branches,
  worktrees: branchData.worktrees,
  prs: branchPrs?.prs ?? [],
  liveIn: (p) => [...sessions.values()].filter((s) => s.workdir === p).length,
  externalIn: (p) => externals.some((e) => e.cwd === p),
}) : [];
const remoteCandsNow = () => branchData ? remoteCands(branchData.branches, branchPrs?.prs ?? []) : [];

/// Delete the ticked local branches — checkouts first, because git refuses to delete a
/// branch any worktree holds, so a branch whose checkout is still there cannot go.
///
/// Every checkout reaching this point is clean, unlocked and has nothing running (that is
/// what `block` guarantees), which is why no session is closed and nothing is forced: a
/// bulk button must never be the thing that kills an agent.
async function runLocalClean(): Promise<void> {
  const r = root();
  const cands = localCandsNow();
  const picks = sweepPicks(cands, branchPick);
  if (!r || branchBusy || !picks.length) return;
  branchBusy = true;
  renderDash();
  const wts: { label: string; ok: boolean; note: string }[] = [];
  try {
    for (const w of chosenWorktrees(cands, branchPick)) {
      const label = w.path.split(/[/\\]/).filter(Boolean).pop() ?? w.path;
      try {
        const res = await invoke<{ ok: boolean; summary: string; stranded?: unknown }>(
          "remove_worktree", { repoDir: r, path: w.path, branch: w.branch, deleteBranch: true });
        dlog(res.ok ? "info" : "warn", `branches · worktree ${label} · ${res.summary}`);
        // A stranded removal is `ok: true` — the worktree really is unregistered and only
        // its folder is left, so the branch below it is now deletable.
        wts.push({ label, ok: res.ok, note: res.stranded ? "removed — folder still on disk" : res.summary });
      } catch (e) {
        wts.push({ label, ok: false, note: String(e) });
      }
    }
    const swept = await invoke<SweepResult>("sweep_branches", { repoDir: r, picks });
    dlog("info", `branches · ${swept.summary}`);
    toast(swept.summary);
    branchResult = { swept, wts };
  } catch (e) {
    dlog("error", `branches clean failed: ${e}`);
    toast("branches: " + e);
  } finally {
    branchBusy = false;
    await loadBranches(true);          // re-read: the roster and the branch list both moved
    await host.refreshGit();
    renderDash();
  }
}

/// Delete the ticked branches on the remote. No worktrees (nothing here is checked out),
/// no local refs (a remote-only row has none), and no force of any kind.
async function runRemoteClean(): Promise<void> {
  const r = root();
  const cands = remoteCandsNow();
  const picks = remotePicks(cands, branchRPick);
  if (!r || branchBusy || !picks.length) return;
  const remote = remoteFor(cands);
  branchBusy = true;
  renderDash();
  try {
    const swept = await invoke<SweepResult>("delete_remote_branches", { repoDir: r, remote, picks });
    dlog(swept.deleted.length ? "info" : "warn", `branches · ${remote} · ${swept.summary}`);
    toast(swept.summary);
    branchResult = { swept, wts: [], remote };
    // A remote delete leaves our refs/remotes alone until something prunes them, so the
    // re-read has to fetch first — otherwise the rows just deleted stay on screen.
    await invoke("git_action", { workdir: r, op: "fetch" }).catch(() => {});
  } catch (e) {
    dlog("error", `remote clean failed: ${e}`);
    toast("remote: " + e);
  } finally {
    branchBusy = false;
    await loadBranches(true);
    renderDash();
  }
}

/// Open the view, from anywhere. Exported because the ⑃ dialog's brooms point here now:
/// they are where a person already looks for this, but the surface is this one.
export function openBranchesView(project: string, path: string): void {
  if (root() !== path) openDashboard(project, path);
  openView = "branches";
  branchResult = null;
  renderDash();
  void loadBranches();
}

/// Turn a note into a running agent. The text is typed in **without a trailing
/// newline**: Episko prefills, the human presses Enter — the same rule as the
/// run-on-stop handoff, and for the same reason.
async function dispatchNote(id: string): Promise<void> {
  const n = noteList(root()).find((x) => x.id === id);
  if (!n) return;
  const sid = await host.launch(name(), root(), { colorKey: root() });
  // The note is consumed only if there is something to consume it into — a launch that
  // failed has already toasted why, and eating the text on top of that would lose it.
  if (typeof sid !== "string") return;
  removeNote(id);
  renderDash();
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
  // No toast: `launch` already showed the actual spawn error, and a second one would
  // replace the reason with a vaguer restatement of it. No claim either — see above.
  if (typeof sid !== "string") return;

  const eff = resolveClaim(policy, allow);
  // Pass EVERY argument the command declares, including `body` when `comment` is off.
  // Tauri rejects the whole invoke on one missing key, so omitting `body` did not mean
  // "no comment" — it meant no assign and no label either, for three releases, reported
  // only as a `dlog` warning behind a toast that said "Started on #232".
  if (eff.assign.value || eff.comment.value || eff.label.value) {
    const kind = t.kind === "pr" ? "pr" : "issue";
    void invoke<ClaimOutcome>("gh_claim", {
      root: r, number: t.number, kind,
      assign: eff.assign.value, comment: eff.comment.value,
      label: eff.label.value, body: claimComment(gh.viewer || "", Date.now()),
    }).then((out) => {
      // Record what actually landed, not what was asked for — the release undoes this.
      recordClaim({ threadId: `${r}#${t.number}`, root: r, number: t.number,
        kind, sessionId: sid, at: Date.now(),
        wrote: { assigned: out.assigned, label: out.labeled ? eff.label.value : "" } });
      if (out.problems.length) {
        dlog("warn", `claim #${t.number} partial — ${out.problems.join("; ")}`);
        toast(`Started on #${t.number} — but the claim didn't fully land: ${out.problems.join("; ")}`);
      }
      void loadGh(r, true);
    }).catch((e) => {
      dlog("warn", `claim #${t.number} failed — ${e}`);
      toast(`Started on #${t.number} — but nothing could be written to it: ${e}`);
    });
  }

  // Sent, not prefilled — see the note above. The carriage return goes in a write of its
  // OWN, a beat behind the text: Claude's REPL reads a burst that arrives in one chunk
  // as a *paste*, and a `\r` inside a paste is a newline in the buffer, not a submit. So
  // the prompt landed in the input box and sat there — which is exactly the waiting this
  // path exists to remove. A lone `\r` has no burst to be folded into.
  setTimeout(() => {
    const prompt = `Work on ${t.kind === "pr" ? "PR" : "issue"} #${t.number}: ${t.title}\n${t.url}`;
    void invoke("write_pty", { sessionId: sid, data: prompt.replace(/\n/g, " ") })
      .then(() => new Promise((r2) => setTimeout(r2, SUBMIT_MS)))
      .then(() => invoke("write_pty", { sessionId: sid, data: "\r" }))
      .catch(() => {});
  }, 1400);
  toast(`Started on #${t.number}`);
}

/// A session that took a claim has ended — hand the work back, so a colleague is not
/// looking at a claim for an agent that stopped hours ago.
export function releaseClaimFor(sessionId: string): void {
  const rec = claimForSession(sessionId);
  if (!rec) return;
  dropClaim(rec.threadId);
  // `label` and `body` are required arguments, and leaving them off made every release
  // since the feature shipped fail the same way `gh_claim` did — silently, because the
  // only handler was a bare `.catch(() => {})`. A release that never runs is the
  // graveyard-of-dead-claims failure this function exists to prevent.
  //
  // `unassign` is what we *wrote*, never a blanket `@me`: a ledger entry from before
  // `wrote` existed says nothing about who assigned the issue, and guessing there means
  // stripping an assignment a human made by hand.
  void invoke<ClaimOutcome>("gh_release", {
    root: rec.root, number: rec.number, kind: rec.kind,
    unassign: rec.wrote?.assigned ?? false,
    label: rec.wrote?.label ?? "",
    body: releaseComment(gh.viewer || "", Date.now()),
  }).then((out) => {
    if (out.problems.length) dlog("warn", `release #${rec.number} partial — ${out.problems.join("; ")}`);
  }).catch((e) => { dlog("warn", `release #${rec.number} failed — ${e}`); });
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
