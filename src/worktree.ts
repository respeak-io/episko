// The new-session dialog: where a session starts (the repo root, a worktree, a branch, or
// a new worktree), the branch chooser popover, and the worktree removal/switch flows.
// Acting on panes (launch, close, stage, repaint) is main.ts's and arrives as hooks.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, toast } from "./dom";
import { ask } from "./confirm";
import { dlog } from "./debug";
import { basename, esc } from "./format";
import { agentCapabilitySummary, CLAUDE_CLI, isAgent, isExited, midFlight, type DiffStat, type GitActionResult, type Phase, type PurgeResult, type Sess, type StatusFile, type Stranded, type WorkingSet } from "./types";
import { extWorking } from "./sidebarview";
import {
  remoteOf as branchRemoteOf, trunkOf, trunkOptions, type BranchInfo, type WtInfo,
} from "./branches";
import {
  cmpBase, effectiveAgent, engineDef, externals, permissionModeFor, sessions, termEngine,
  worktreesByRepo,
} from "./state";
import { providerPermissionMode } from "./providers";
import { agentLogo } from "./providers/logos";
import { waitForExit } from "./tasks";

type LaunchOpts = { colorKey?: string; worktree?: string | null; branch?: string; resume?: string };
// Must match panes.ts's signature (it resolves to the session id), so a caller that needs
// the id can't be handed a hook that quietly drops it.
let launch: (project: string, workdir: string, opts?: LaunchOpts) => Promise<string | null> = async () => null;
export function setWtLaunch(fn: typeof launch) { launch = fn; }
let closeSession: (id: string) => void = () => {};
export function setWtCloseSession(fn: typeof closeSession) { closeSession = fn; }
let setActive: (id: string) => void = () => {};
export function setWtSetActive(fn: typeof setActive) { setActive = fn; }
let renderAll: () => void = () => {};
export function setWtRenderAll(fn: typeof renderAll) { renderAll = fn; }
let handToTerminal: (project: string, workdir: string, cmd: string, opts?: { colorKey?: string; worktree?: string | null; branch?: string }) => Promise<void> = async () => {};
export function setWtHandToTerminal(fn: typeof handToTerminal) { handToTerminal = fn; }
// A removal is the one checkout change the app makes itself, so the ⑃ roster must not wait
// for the poll to notice. A hook because panes.ts already imports this module.
let refreshGitViews: () => Promise<void> = async () => {};
export function setWtRefreshGit(fn: typeof refreshGitViews) { refreshGitViews = fn; }
// The persisted write is actions.ts's; importing it would close a cycle (actions → panes → worktree).
let saveCmpBase: (repoDir: string, ref: string) => void = () => {};
export function setWtSaveCmpBase(fn: typeof saveCmpBase) { saveCmpBase = fn; }
// The dashboard's timeline is a `git log` of this folder and nothing re-reads it on a
// schedule, so a root switch tells it outright rather than waiting to be found.
let onBranchSwitched: (repoDir: string) => void = () => {};
export function setWtOnBranchSwitched(fn: typeof onBranchSwitched) { onBranchSwitched = fn; }

type CommitInfo = { short: string; subject: string; author: string; rel: string };

// Every answer to "where should this session run?" is a directory, so every answer is a row.
type DestKind = "repo" | "wt" | "branch" | "remote" | "create";
interface Dest {
  kind: DestKind;
  group: string;          // "" pins the row above every group (the create row)
  ic: string;
  label: string;          // primary line
  sub: string;            // secondary line ("" = none)
  dir: string;            // the directory this destination runs in (or would create)
  branch: string;         // "" when the checkout is detached
  tags: [string, string][];
  meta: string;           // right-aligned html (ahead/behind + age, branches only)
  stale: boolean;
  verb: string;           // what ⏎ does, spelled out in the footer
  wt?: WtInfo;
  br?: BranchInfo;
  clash?: WtInfo;         // a worktree already owns the folder this row would create
}

let wtCtx: { project: string; repoDir: string } | null = null;
let wtWts: WtInfo[] = [];
// Kept apart: every reader of wtBranches (base chooser, switch chooser, delete) is only
// correct for branches that exist locally. A remote-only row doesn't exist yet.
let wtBranches: BranchInfo[] = [];
let wtRemotes: BranchInfo[] = [];
let wtRepoBranch = "";
let wtLoading = true;          // git hasn't answered yet — draw skeleton rows
let wtRows: Dest[] = [];
let wtSel = 0;
let wtArmed = "";              // path of the worktree whose removal is armed
let wtBusy = false;            // a create/remove is in flight
let wtBase = "";               // start-point for a NEW branch ("" = the repo's HEAD)
let wtSwitchTo = "";           // target of an armed root-folder branch switch
let wtGen = 0;                 // bumps on every open/refresh; stales in-flight fetches
let wtAgeT: number | undefined;
let wtLoadedAt = 0;
const wtCommits = new Map<string, CommitInfo | null>();
// Keyed by folder; the whole working set rather than its counts, because the pane names the files.
const wtDirty = new Map<string, WorkingSet | null>();

/** Mirrors create_worktree's path scheme. Lossy, so never derive a branch back from a folder. */
function wtSlug(branch: string): string {
  return branch.trim().replace(/[^\p{L}\p{N}\-_/.]/gu, "-").replace(/\//g, "-");
}
function parentOf(p: string) { const q = p.replace(/[/\\]+$/, ""); const i = Math.max(q.lastIndexOf("/"), q.lastIndexOf("\\")); return i > 0 ? q.slice(0, i) : q; }
const wtNorm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** Where `create_worktree` would put a checkout for `branch` in this repo. */
function wtTargetDir(repoDir: string, branch: string) {
  return `${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}/${wtSlug(branch)}`;
}

// The folder is the identity (what exists, what removal deletes); the branch is only a
// label, and `git switch` inside a session rewrites it at will.
type WtState = "aligned" | "diverged" | "detached" | "foreign";
function wtStateOf(w: WtInfo, repoDir: string): WtState {
  const base = wtNorm(`${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}`);
  if (!wtNorm(w.path).startsWith(base + "/")) return "foreign";
  if (!w.branch || w.branch === "(detached)") return "detached";
  return wtSlug(w.branch) === basename(w.path) ? "aligned" : "diverged";
}
/** Its branch when it has one, else its folder: a row still has to be nameable. */
function wtLabelOf(w: WtInfo) {
  return w.branch && w.branch !== "(detached)" ? w.branch : basename(w.path) + "/";
}
// Through `wtNorm` like every other path comparison here: on Windows one side of this can
// arrive with backslashes or a trailing slash, and a miss means a live pane is not closed.
const wtSessionsIn = (path: string) => [...sessions.values()].filter((s) => wtNorm(s.workdir) === wtNorm(path));

/** Head ellipsises, tail pinned: sibling branches often differ only in their suffix. */
function wtName(name: string) {
  const TAIL = 9;
  if (name.length <= TAIL + 4) return `<span class="hd">${esc(name)}</span>`;
  return `<span class="hd">${esc(name.slice(0, name.length - TAIL))}</span><span class="tl">${esc(name.slice(-TAIL))}</span>`;
}

/** Standing against its own upstream. In sync shows nothing; silence is the clean state. */
function wtSyncMeta(b: BranchInfo): string {
  if (b.gone) return `<span class="wt-tag gone" title="${esc(b.upstream)} no longer exists on the remote, so this branch is local-only now">gone</span>`;
  if (!b.upstream) return `<span class="wt-tag det" title="No remote branch tracks this. It has never been pushed">local</span>`;
  return (b.ahead ? `<span class="wt-ab wt-ahead" title="${b.ahead} commit(s) not yet pushed to ${esc(b.upstream)}">↑${b.ahead}</span>` : "")
    + (b.behind ? `<span class="wt-ab wt-behind" title="${b.behind} commit(s) on ${esc(b.upstream)} not pulled yet">↓${b.behind}</span>` : "");
}

/** A remote-only branch against its remote's default. Empty `base` means it could not be
 *  measured (no default ref, a second remote, an old git); silence beats a false `↑0 ↓0`. */
function wtBaseMeta(b: BranchInfo): string {
  if (!b.base) return `<span class="wt-tag rem" title="Only on ${esc(b.upstream)}, no local branch yet">${esc(wtRemoteOf(b))}</span>`;
  if (!b.ahead && !b.behind) return `<span class="wt-tag merged" title="Identical to ${esc(b.base)}">even</span>`;
  return (b.ahead ? `<span class="wt-ab wt-ahead" title="${b.ahead} commit(s) ${esc(b.base)} doesn't have">↑${b.ahead}</span>` : "")
    + (b.behind ? `<span class="wt-ab wt-behind" title="${b.behind} commit(s) on ${esc(b.base)} that this branch doesn't have">↓${b.behind}</span>` : "");
}

/** The same fact as wtSyncMeta, spelled out for the detail pane. */
function wtUpstreamHtml(b: BranchInfo): string {
  if (b.gone) return `<span class="em">${esc(b.upstream)}</span>: deleted on the remote, local-only now`;
  if (!b.upstream) return `<span class="dim">none, never pushed</span>`;
  if (!b.ahead && !b.behind) return `<span class="em">${esc(b.upstream)}</span> <span class="good">· in sync</span>`;
  return `<span class="em">${esc(b.upstream)}</span>`
    + (b.ahead ? ` · <span class="warn">↑${b.ahead} unpushed</span>` : "")
    + (b.behind ? ` · ↓${b.behind} unpulled` : "");
}

// Two doors. `launch` lists every branch as a destination; `manage` (the ⑃ cluster menu)
// lists only the checkouts until you type, and hides the engine chip. Same machinery, and
// ⏎ still starts a session in both: changing what Enter does between modes is a worse trap.
type WtMode = "launch" | "manage";
let wtMode: WtMode = "launch";
// `armSwitch` opens onto the root's switch card rather than switching: every guard, the
// picker and the dirty-tree handoff live in that card.
export async function openWt(project: string, repoDir: string, knownBranch?: string | null, opts: { manage?: boolean; focusDir?: string; armSwitch?: boolean } = {}) {
  wtCtx = { project, repoDir };
  wtSel = 0; wtArmed = ""; wtBusy = false; wtBase = ""; wtSwitchTo = ""; wtFetchedAt = 0;
  wtRepoBranch = knownBranch || "";   // seeded by requestLaunch, which already asked
  wtMode = opts.manage ? "manage" : "launch";
  const manage = wtMode === "manage";
  const q = $("wtQ") as HTMLInputElement;
  q.value = "";
  q.placeholder = manage ? "Filter checkouts, or type a branch to add one…" : "Filter, or type a new branch name…";
  const title = manage ? "Worktrees" : "New session";
  $("wtTitle").textContent = title;   // every one of these resets: the element is shared
  $("wtDlg").setAttribute("aria-label", title);
  $("wtList").setAttribute("aria-label", manage ? "Checkouts" : "Session destinations");
  $("wtProj").textContent = project;
  $("wtPath").textContent = repoDir;
  const ag = effectiveAgent(repoDir);
  const launchEngine = ag.capabilities.includes("external-terminal") ? termEngine : "embedded";
  const eng = engineDef(launchEngine);
  $("wtEng").textContent = `${launchEngine === "embedded" ? "▤" : "⧉"} ${eng.label}`;
  ($("wtEng") as HTMLElement).title = launchEngine === termEngine
    ? `New sessions open in ${eng.label}`
    : `${ag.label} sessions currently stay embedded`;
  ($("wtEng") as HTMLElement).style.display = manage ? "none" : "";
  // The agent chip and the mode chip show only when they differ from the default (Claude,
  // ask-me), so a chip means "something is different here". Both hidden in manage mode.
  const agEl = $("wtAgent") as HTMLElement;
  agEl.hidden = manage || ag.id === CLAUDE_CLI.id;
  agEl.innerHTML = `<span class="agent-logo" aria-hidden="true">${agentLogo(ag.id)}</span>${esc(ag.label)}`;
  agEl.title = `${ag.label} runs here — ${agentCapabilitySummary(ag)}. Change it on the `
    + `project's own menu, or in Settings › Sessions.`;
  const pm = providerPermissionMode(ag.id, permissionModeFor(ag.id));
  const modeEl = $("wtMode") as HTMLElement;
  // Terminal-only providers manage permissions in their own TUI.
  modeEl.hidden = manage || !ag.capabilities.includes("launch-permissions") || !pm || pm.id === "default";
  modeEl.textContent = pm ? `${pm.glyph} ${pm.label}` : "";
  modeEl.title = pm ? `${ag.label} starts in ${pm.label} mode: ${pm.sub} (Settings › Sessions)` : "";
  $("scrim").classList.add("show"); $("wtDlg").classList.add("show");
  setTimeout(() => q.focus(), 30);
  clearInterval(wtAgeT); wtAgeT = window.setInterval(wtTickAge, 1000);
  await wtLoad();
  // After the first read, which builds the rows. `>= 0` because index 0 is the repo row and
  // re-selecting it matters once `armSwitch` arms a card on it; the arm must precede the
  // render or the card only appears on the next keystroke.
  const focus = opts.armSwitch ? repoDir : opts.focusDir;
  if (focus && wtCtx) {   // …and not if it was closed while the read was in flight
    const i = wtRows.findIndex((d) => d.dir === focus);
    if (i >= 0) { wtSel = i; if (opts.armSwitch) wtArmed = repoDir; wtRender(); }
  }
}

// Draws its shape first and fills in; the repo row is real from the first frame, so ⏎
// works at t=0. wtReadLocal is local git, instant. wtMaybeFetch is network: ahead/behind,
// `gone` and the Remote branches group all read refs/remotes/*, which only `git fetch` moves.
async function wtLoad(quiet = false) {
  await wtReadLocal(quiet);
  void wtMaybeFetch();
}

// The repo changed under the open dialog (an agent added or removed a worktree). A no-op
// when closed, so the caller needn't check; local read only, never the network.
export async function refreshWtDialog() {
  if (!wtCtx) return;
  await wtReadLocal(true);
}

// Throttled and best-effort: runs in the background, never blocks the list, and stays
// silent on failure (offline, no remote, auth). A stale number beats a toast per alt-tab.
const WT_FETCH_MIN_MS = 60_000;
let wtFetchedAt = 0;
let wtFetching = false;
async function wtMaybeFetch(force = false) {
  if (!wtCtx || wtFetching) return;
  if (!force && Date.now() - wtFetchedAt < WT_FETCH_MIN_MS) return;
  const gen = wtGen, { repoDir } = wtCtx;
  wtFetching = true;
  $("wtRefresh").classList.add("spin");
  try {
    await invoke<GitActionResult>("git_action", { workdir: repoDir, op: "fetch" });
  } catch { /* offline / no remote / auth — the local read still stands */ }
  wtFetching = false;
  wtFetchedAt = Date.now();
  $("wtRefresh").classList.remove("spin");
  if (gen !== wtGen || !wtCtx || wtCtx.repoDir !== repoDir) return; // dialog moved on
  await wtReadLocal(true);
}

// `quiet`: a list is already on screen, so no skeletons, no repeat toast, one render at the end.
async function wtReadLocal(quiet = false) {
  if (!wtCtx) return;
  const { repoDir } = wtCtx;
  const gen = ++wtGen;
  // Re-derive the lazily fetched facts: a quiet refresh usually follows something that moved them.
  wtCommits.clear(); wtDirty.clear();
  if (!quiet) { wtLoading = true; wtRender(); }
  const [wts, branches, head] = await Promise.all([
    invoke<WtInfo[]>("list_worktrees", { repoDir }).catch(() => [] as WtInfo[]),
    invoke<BranchInfo[]>("git_branch_list", { repoDir, base: cmpBase[repoDir] ?? null }).catch(() => [] as BranchInfo[]),
    invoke<string | null>("git_branch", { workdir: repoDir }).catch(() => null),
  ]);
  if (gen !== wtGen || !wtCtx || wtCtx.repoDir !== repoDir) return; // dialog moved on
  wtWts = wts; wtRepoBranch = head || wtRepoBranch;
  wtBranches = branches.filter((b) => !b.remote);
  wtRemotes = branches.filter((b) => b.remote);
  wtLoading = false;
  wtLoadedAt = Date.now();
  if (!wts.length && !quiet) toast(`${basename(repoDir)} isn't a git repository`);
  wtRender();
}

function wtTickAge() {
  if (!$("wtDlg").classList.contains("show")) { clearInterval(wtAgeT); return; }
  if (wtLoading) { $("wtAge").textContent = "…"; return; }
  const s = Math.round((Date.now() - wtLoadedAt) / 1000);
  $("wtAge").textContent = s < 5 ? "now" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
}

// One array; both the list and the detail pane read only from this.
function wtBuild(): Dest[] {
  if (!wtCtx) return [];
  const { repoDir } = wtCtx;
  const raw = ($("wtQ") as HTMLInputElement).value;
  const q = raw.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const out: Dest[] = [];

  // Remote-only names count as known: typing one must land on its row, not on "create",
  // which would cut an unrelated branch off HEAD under the same name.
  const known = [...wtWts.map((w) => w.branch), ...wtBranches.map((b) => b.name),
    ...wtRemotes.map((b) => b.name), wtRepoBranch];
  const exact = known.some((n) => n && n.toLowerCase() === q);

  if (q && !exact) {
    const want = wtSlug(raw);
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === want);
    out.push({
      kind: "create", group: "", ic: "＋", label: raw.trim(),
      sub: clash ? `folder ${basename(clash.path)}/ is already taken` : `new worktree off ${wtBase || wtRepoBranch || "HEAD"}`,
      dir: wtTargetDir(repoDir, raw), branch: raw.trim(), tags: [], meta: "", stale: false, clash,
      verb: clash ? "blocked: that folder exists" : "create worktree & start session",
    });
  }

  const repoSess = wtSessionsIn(repoDir).length;
  if (hit(wtRepoBranch) || hit(basename(repoDir)) || hit("repo")) {
    out.push({
      kind: "repo", group: "Repo", ic: "⌂",
      label: wtRepoBranch || basename(repoDir), sub: repoDir,
      dir: repoDir, branch: wtRepoBranch,
      tags: repoSess ? [["open", `${repoSess} open`]] : [], meta: "", stale: false,
      verb: "start session in the repo, no worktree",
    });
  }

  for (const w of wtWts) {
    if (w.is_main) continue;
    // Searchable by branch or folder: after a `git switch` inside the checkout they differ.
    if (!hit(`${w.branch} ${basename(w.path)} ${w.path}`)) continue;
    const st = wtStateOf(w, repoDir);
    const open = wtSessionsIn(w.path).length;
    const tags: [string, string][] = [];
    if (open) tags.push(["open", `${open} open`]);
    if (!w.exists) tags.push(["missing", "missing"]);
    if (w.locked) tags.push(["locked", "locked"]);
    if (st === "diverged") tags.push(["moved", "moved"]);
    if (st === "detached") tags.push(["det", "detached"]);
    if (st === "foreign") tags.push(["ext", "outside"]);
    if (w.dirty) tags.push(["dirty", "uncommitted"]);
    // `merged` is skipped for a detached checkout: never imply one is a safe cleanup.
    if (w.merged && st !== "detached") tags.push(["merged", "merged"]);
    out.push({
      kind: "wt", group: "Worktrees", ic: "⑃", wt: w,
      label: wtLabelOf(w),
      sub: st === "diverged" ? `in ${basename(w.path)}/` : st === "foreign" ? w.path : "",
      dir: w.path, branch: w.branch === "(detached)" ? "" : w.branch,
      tags, meta: "", stale: false,
      verb: !w.exists ? "folder is gone, remove it instead"
        : open ? "start another session in this worktree"
        : "start session in this worktree",
    });
  }

  // Branches a NEW worktree could start on; current and checked-out ones are excluded since
  // git refuses a second checkout. Manage mode gates them on a query rather than dropping
  // them: the create row suppresses itself for an existing name, so this is how you add one.
  const STALE = 45 * 86400, now = Date.now() / 1000;
  for (const b of wtMode === "manage" && !q ? [] : wtBranches) {
    if (b.current || b.checked_out || !hit(b.name)) continue;
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === wtSlug(b.name));
    out.push({
      kind: "branch", group: "Branches", ic: "⌥", br: b, clash,
      label: b.name, sub: "", dir: wtTargetDir(repoDir, b.name), branch: b.name,
      tags: [], stale: b.unix > 0 && now - b.unix > STALE,
      meta: wtSyncMeta(b) + `<span class="wt-when">${esc(b.rel || "")}</span>`,
      verb: clash ? "blocked: that folder exists" : "create a worktree on this branch & start",
    });
  }

  // Remote-only branches last: the least likely destination, and the only ones that bring
  // a new name into the repo.
  for (const b of wtRemotes) {
    if (!hit(`${b.name} ${b.upstream}`)) continue;
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === wtSlug(b.name));
    out.push({
      kind: "remote", group: "Remote branches", ic: "⇣", br: b, clash,
      label: b.name, sub: "", dir: wtTargetDir(repoDir, b.name), branch: b.name,
      tags: [], stale: b.unix > 0 && now - b.unix > STALE,
      // Standing vs the default branch plus author, as GitHub's branches view shows it, but
      // only on the hovered/selected row: on every row it squeezes the name to `fea…audit-log`.
      meta: `<span class="wt-rmeta">${wtBaseMeta(b)}`
        + (b.author ? `<span class="wt-who" title="${esc(b.author)} wrote the last commit on this branch">${esc(b.author)}</span>` : "")
        + `</span><span class="wt-when">${esc(b.rel || "")}</span>`,
      verb: clash ? "blocked: that folder exists" : `check ${b.upstream} out into a worktree & start`,
    });
  }
  return out;
}

/** ./branches owns the trunk, so this chip and the Branches view's footer never name different trunks. */
const wtTrunk = () => trunkOf(wtBranches.concat(wtRemotes));
const wtTrunkOptions = (): BranchPick[] => trunkOptions(wtBranches.concat(wtRemotes));
const wtRemoteOf = branchRemoteOf;

function wtRender() {
  wtRows = wtBuild();
  if (wtSel >= wtRows.length) wtSel = Math.max(0, wtRows.length - 1);
  const cur = wtRows[wtSel];
  if (!cur || cur.kind === "create" || cur.dir !== wtArmed) wtArmed = "";

  // Worktrees is the one group drawn when empty: its absence reads as "still loading" after
  // the skeleton. Two gates: no filter typed (.wt-empty covers that), and git answered
  // (`list_worktrees` returns [] for a non-repo and always lists main for a real one).
  const noWts = !wtLoading && !($("wtQ") as HTMLInputElement).value.trim()
    && wtWts.length > 0 && !wtWts.some((w) => !w.is_main);
  const noneHtml = `<div class="wt-gh">Worktrees<span class="rule"></span></div>`
    + `<div class="wt-none"><b>No worktrees yet</b>Type a branch name above to make one</div>`;
  // Emitted where the group would have been, so it can't drift below Branches; the end of
  // the list is the fallback when the repo row is the only other one.
  const afterWt = new Set(["Branches", "Remote branches"]);
  let noneDone = !noWts;

  let html = "", lastGroup: string | null = null;
  wtRows.forEach((d, i) => {
    if (!noneDone && afterWt.has(d.group)) { html += noneHtml; noneDone = true; }
    if (d.group && d.group !== lastGroup) {
      lastGroup = d.group;
      const n = wtRows.filter((x) => x.group === d.group).length;
      // The trunk the numbers are measured against, changeable here: git's own default is
      // wrong for a `develop` trunk, a stale origin/HEAD, or a release line.
      const cmp = d.group === "Remote branches" && wtTrunk()
        ? `<button class="wt-cmp" type="button" data-wtpick="cmp" title="Branches are measured against this&#10;Click to compare against another branch">vs ${esc(wtTrunk())}</button>`
        : "";
      html += `<div class="wt-gh">${d.group}<span class="gc">${n}</span><span class="rule"></span>${cmp}</div>`;
    }
    html += `<button class="wt-item${d.kind === "create" ? " create" : ""}${d.stale ? " stale" : ""}${i === wtSel ? " on" : ""}"`
      + ` type="button" role="option" aria-selected="${i === wtSel}" data-wti="${i}" title="${esc(d.dir)}&#10;Double-click to ${esc(d.verb)}">`
      + `<span class="wt-ic">${d.ic}</span>`
      + `<span class="wt-main"><span class="wt-br">${wtName(d.label)}</span>`
      + (d.sub ? `<span class="wt-sub2">${esc(d.sub)}</span>` : "")
      + `</span><span class="wt-meta">`
      + d.tags.map(([k, t]) => `<span class="wt-tag ${k}">${esc(t)}</span>`).join("")
      + `${d.meta}</span></button>`;
  });
  if (!noneDone) html += noneHtml;
  if (wtLoading) {
    html += `<div class="wt-gh">Worktrees<span class="rule"></span></div>`
      + [44, 62, 37].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("")
      + `<div class="wt-gh">Branches<span class="rule"></span></div>`
      + [55, 41].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("");
  } else if (!wtRows.length) {
    html += `<div class="wt-empty"><b>Nothing matches that</b>Clear the filter, or type a branch name to create one</div>`;
  }
  $("wtList").innerHTML = html;
  $("wtCount").textContent = wtLoading || !wtRows.length ? ""
    : `${wtRows.length} ${wtMode === "manage" ? (wtRows.length === 1 ? "checkout" : "checkouts") : "destinations"}`;
  $("wtVerb").textContent = cur ? cur.verb : "—";
  $("wtDetail").innerHTML = wtDetailHtml(cur);
  $("wtList").querySelector(".wt-item.on")?.scrollIntoView({ block: "nearest" });
  void wtPrefetch(cur);
}

// Git facts for the HIGHLIGHTED row only: one `git log` per row would cost more than the pane is worth.
async function wtPrefetch(d: Dest | undefined) {
  if (!d || !wtCtx) return;
  const gen = wtGen, { repoDir } = wtCtx;
  const jobs: Promise<unknown>[] = [];
  const ck = wtCommitKey(d);
  if (ck && !wtCommits.has(ck)) {
    const [dir, rev] = ck.split("\n");
    jobs.push(invoke<CommitInfo | null>("git_commit_info", { dir, rev }).catch(() => null)
      .then((c) => { wtCommits.set(ck, c); }));
  }
  // list_worktrees skips `dirty` for the main worktree and gives a bare boolean for the
  // rest, so both ask for the working set. A folder that is gone has nothing to read.
  const wsDir = d.kind === "repo" ? repoDir : d.kind === "wt" && d.wt!.exists ? d.dir : "";
  if (wsDir && !wtDirty.has(wsDir)) {
    jobs.push(invoke<WorkingSet | null>("git_working_set", { workdir: wsDir }).catch(() => null)
      .then((g) => { wtDirty.set(wsDir, g); }));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (gen !== wtGen) return;                    // refreshed under us
  if (wtRows[wtSel] !== d) return;              // selection moved on
  $("wtDetail").innerHTML = wtDetailHtml(d);
}
/** `<dir>\n<rev>` for git_commit_info, newline-joined because git forbids newlines in ref
 *  names and a path may contain spaces. "" when there is nothing to ask about. */
function wtCommitKey(d: Dest): string {
  if (!wtCtx) return "";
  if (d.kind === "repo") return `${d.dir}\n`;
  if (d.kind === "wt") return d.wt!.exists ? `${d.dir}\n` : "";
  if (d.kind === "branch") return `${wtCtx.repoDir}\n${d.branch}`;
  // A remote-only row has no local ref to name, so ask about the remote-tracking one.
  if (d.kind === "remote") return `${wtCtx.repoDir}\n${d.br!.upstream}`;
  return "";
}

// Shared with the diff viewer's file headers, so one letter means one thing. `?` borrows `added`'s green.
const WT_FCLASS: Record<string, string> = {
  M: "s-mod", A: "s-add", "?": "s-add", D: "s-del", R: "s-ren", C: "s-ren", U: "s-del",
};
const WT_FILES_SHOWN = 10; // the pane is a paragraph of facts, not a diff viewer

function wtFileHtml(f: StatusFile): string {
  const name = f.from
    ? `<span class="from">${esc(f.from)}</span> → ${wtPathHtml(f.path)}`
    : wtPathHtml(f.path);
  const n = f.added || f.removed
    ? `<span class="n"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>`
    : "";
  return `<li><span class="dstat ${WT_FCLASS[f.code] ?? "s-mod"}">${esc(f.code)}</span>`
    + `<span class="p">${name}</span>${n}</li>`;
}
/** `pending` shows until the fetch lands. A worktree row already knows whether it is
 *  dirty from `list_worktrees`, so it says so at once and never flashes the opposite answer. */
function wtWorkHtml(dir: string, pending: string): string {
  if (!wtDirty.has(dir)) return pending;
  const g = wtDirty.get(dir);
  if (!g || !g.dirty) return `<span class="good">clean</span>`; // null: not a repo, or no commits yet
  const shown = g.entries.slice(0, WT_FILES_SHOWN);
  const rest = g.dirty - shown.length;
  return `<span class="warn">${g.dirty} file${g.dirty === 1 ? "" : "s"} uncommitted</span>`
    + (g.added || g.removed ? ` <span class="dim">·</span> <span class="add">+${g.added}</span> <span class="del">−${g.removed}</span>` : "")
    + (g.untracked ? ` <span class="dim">· ${g.untracked} new</span>` : "")
    + (shown.length ? `<ul class="wt-files">${shown.map(wtFileHtml).join("")}</ul>` : "")
    + (rest > 0 ? `<div class="wt-fmore">…and ${rest} more</div>` : "");
}

function wtFacts(pairs: [string, string][]) {
  return `<dl class="wt-facts">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}
function wtCommitHtml(d: Dest): string {
  const ck = wtCommitKey(d);
  if (!ck) return `<span class="dim">—</span>`;
  if (!wtCommits.has(ck)) return `<span class="dim">reading…</span>`;
  const c = wtCommits.get(ck);
  if (!c) return `<span class="dim">no commits yet</span>`;
  return `<span class="em">${esc(c.short)}</span> · ${esc(c.author)} · ${esc(c.rel)}<span class="subj">${esc(c.subject)}</span>`;
}
function wtPathHtml(p: string) {
  const b = basename(p);
  const i = p.lastIndexOf(b);
  return i <= 0 ? `<span class="em">${esc(p)}</span>` : `<span class="dim">${esc(p.slice(0, i))}</span><span class="em">${esc(b)}</span>`;
}
function wtSessHtml(list: Sess[]) {
  const col: Record<Phase, string> = { idle: "--st-idle", thinking: "--st-working", working: "--st-working", done: "--st-done", error: "--st-error", ended: "--st-idle" };
  return `<div class="wt-sess">${list.map((s) =>
    `<button class="wt-sessb" type="button" data-wtjump="${esc(s.id)}"><i style="background:var(${col[s.phase]})"></i>${esc(s.title || s.branch || "session")}</button>`).join("")}</div>`;
}

function wtDetailHtml(d: Dest | undefined): string {
  if (wtLoading && !d) return `<div class="wt-empty">Reading the repo…</div>`;
  if (!d || !wtCtx) return `<div class="wt-empty">Nothing selected.</div>`;

  if (d.kind === "repo") {
    const sess = wtSessionsIn(d.dir);
    if (wtArmed === d.dir) return wtSwitchHtml();
    return `<div class="wt-dhead"><span class="wt-dkind">The repo itself</span><span class="wt-dname">${wtPathHtml(d.dir)}</span></div>`
      + wtFacts([
        ["Branch", `<span class="em">${esc(wtRepoBranch || "—")}</span>`],
        ["HEAD", wtCommitHtml(d)],
        ["Working tree", wtWorkHtml(d.dir, `<span class="dim">reading…</span>`)],
      ])
      + (sess.length ? `<dl class="wt-facts"><dt>Sessions</dt><dd>${wtSessHtml(sess)}</dd></dl>` : "")
      + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go">Start session here</button>`
      + `<button class="wt-rm" type="button" data-wtact="arm">Switch branch…</button></div>`;
  }

  if (d.kind === "wt") {
    const w = d.wt!, st = wtStateOf(w, wtCtx.repoDir), sess = wtSessionsIn(w.path);
    if (wtArmed === w.path) return wtConfirmHtml(d);
    let warn = "";
    if (!w.exists) {
      warn = `<div class="wt-warn err"><span class="t">Folder is gone</span>`
        + `Nothing is left at this path except git's record of it. Removing prunes that record; there's nothing to launch into.</div>`;
    } else if (st === "diverged") {
      // Names the folder, not the branch it was created for: wtSlug is lossy, so the folder
      // can't be turned back into a branch name.
      warn = `<div class="wt-warn"><span class="t">Folder and branch disagree</span>`
        + `This checkout lives in <b>${esc(basename(w.path))}/</b>, a folder named after the branch it was created for. `
        + `Its HEAD is now <b>${esc(w.branch)}</b>. Something switched inside it. `
        + `Removing it deletes the folder; the branch is a separate decision.</div>`;
    } else if (st === "detached") {
      warn = `<div class="wt-warn"><span class="t">No branch checked out</span>`
        + `HEAD is detached here, so commits made in this checkout belong to no branch, so Episko can't tell you whether they're merged, and won't offer to delete anything.</div>`;
    } else if (st === "foreign") {
      warn = `<div class="wt-warn"><span class="t">Outside .cc-worktrees</span>`
        + `Episko didn't create this checkout, so it doesn't own the path. Removal still works; the folder just isn't where new worktrees go.</div>`;
    }
    if (w.locked) {
      warn += `<div class="wt-warn"><span class="t">Locked</span>`
        + `<b>git worktree lock</b> was used here. Git refuses to remove a locked worktree even with <b>--force</b>, so unlock it first.</div>`;
    }
    const facts: [string, string][] = [
      ["Folder", wtPathHtml(w.path)],
      ["Branch", w.branch && w.branch !== "(detached)" ? `<span class="em">${esc(w.branch)}</span>` : `<span class="warn">(detached)</span>`],
      ["HEAD", wtCommitHtml(d)],
      ["Working tree", !w.exists ? `<span class="dim">—</span>`
        : wtWorkHtml(w.path, w.dirty ? `<span class="warn">uncommitted changes</span>` : `<span class="good">clean</span>`)],
    ];
    if (w.branch && w.branch !== "(detached)") {
      facts.push(["Branch state", w.merged ? `<span class="good">merged into ${esc(wtRepoBranch || "the main branch")}</span>`
        : `<span class="em">has commits</span> ${esc(wtRepoBranch || "the main branch")} doesn't`]);
    }
    return `<div class="wt-dhead"><span class="wt-dkind">Existing worktree</span><span class="wt-dname">${esc(wtLabelOf(w))}</span></div>`
      + warn + wtFacts(facts)
      + (sess.length ? `<dl class="wt-facts"><dt>Sessions</dt><dd>${wtSessHtml(sess)}</dd></dl>` : "")
      + `<div class="wt-acts">`
      + `<button class="wt-go" type="button" data-wtact="go"${w.exists ? "" : " disabled"}>${sess.length ? "Start another session here" : "Start session here"}</button>`
      + `<button class="wt-rm" type="button" data-wtact="arm"${sess.length ? " disabled title=\"Close its sessions first\"" : ""}>Remove worktree…</button>`
      + `</div>`;
  }

  // branch / create: neither has a checkout yet, so both show the folder that WOULD be
  // made, which catches a collision before git does.
  const clash = d.clash;
  const clashWarn = clash
    ? `<div class="wt-warn err"><span class="t">Folder already taken</span>`
      + `<b>${esc(basename(clash.path))}/</b> exists and has <b>${esc(wtLabelOf(clash))}</b> checked out`
      + `${clash.dirty ? ", with uncommitted changes" : ""}. The folder is derived from the branch name, so this branch has nowhere to go.</div>`
    : "";
  if (d.kind === "branch") {
    const b = d.br!;
    if (wtArmed === d.dir) return wtBranchConfirmHtml(d);
    // A gone or missing remote is a fact about the branch, not a reason to avoid it: say
    // what will happen rather than let the red `gone` chip imply doom.
    const noRemote = (b.gone || !b.upstream) && !clash
      ? `<div class="wt-warn note"><span class="t">No remote branch right now</span>`
        + `${b.gone ? `<b>${esc(b.upstream)}</b> was deleted` : "This branch has never been pushed"}, so starting a worktree here is fine. `
        + `The first <b>git push -u</b> from it creates <b>origin/${esc(b.name)}</b> again.</div>`
      : "";
    return `<div class="wt-dhead"><span class="wt-dkind">Branch · no checkout yet</span><span class="wt-dname">${esc(b.name)}</span></div>`
      + clashWarn + noRemote
      + wtFacts([
        ["Last commit", wtCommitHtml(d)],
        ["Upstream", wtUpstreamHtml(b)],
        [clash ? "Would be" : "Will create", wtPathHtml(d.dir)],
      ])
      + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go"${clash ? " disabled" : ""}>Create worktree &amp; start</button>`
      + (clash ? `<button class="wt-alt" type="button" data-wtact="openclash">Open that checkout instead</button>` : "")
      + `<button class="wt-rm" type="button" data-wtact="arm">Delete branch…</button>`
      + `</div>`;
  }

  // Remote-only: no local ref to delete or switch to, so the pane is about what picking it creates.
  if (d.kind === "remote") {
    const b = d.br!;
    return `<div class="wt-dhead"><span class="wt-dkind">Remote branch · no local copy</span><span class="wt-dname">${esc(b.upstream)}</span></div>`
      + clashWarn
      + (clash ? "" : `<div class="wt-warn note"><span class="t">Not checked out anywhere yet</span>`
        + `This exists on <b>${esc(wtRemoteOf(b))}</b> and nowhere in this repo. Starting here cuts <b>${esc(b.name)}</b> `
        + `from it and sets it to track <b>${esc(b.upstream)}</b>, so <b>git push</b> and <b>git pull</b> in the new worktree take no arguments.</div>`)
      + wtFacts([
        ["Last commit", wtCommitHtml(d)],
        ...(b.author ? [["Author", `<span class="em">${esc(b.author)}</span>`] as [string, string]] : []),
        ...(b.base ? [["Standing", !b.ahead && !b.behind
          ? `<span class="good">even with ${esc(b.base)}</span>`
          : `${b.ahead ? `<span class="em">↑${b.ahead}</span> ahead` : ""}${b.ahead && b.behind ? " · " : ""}`
            + `${b.behind ? `<span class="em">↓${b.behind}</span> behind` : ""} <span class="dim">${esc(b.base)}</span>`] as [string, string]] : []),
        ["Will track", `<span class="em">${esc(b.upstream)}</span>`],
        ["Local branch", `<span class="em">${esc(b.name)}</span> <span class="dim">created now</span>`],
        [clash ? "Would be" : "Will create", wtPathHtml(d.dir)],
      ])
      + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go"${clash ? " disabled" : ""}>Create worktree &amp; start</button>`
      + (clash ? `<button class="wt-alt" type="button" data-wtact="openclash">Open that checkout instead</button>` : "")
      + `</div>`;
  }

  return `<div class="wt-dhead"><span class="wt-dkind">New worktree</span><span class="wt-dname">${esc(d.label)}</span></div>`
    + clashWarn
    + wtFacts([
      ["Branch from", wtBaseSelect()],
      [clash ? "Would be" : "Will create", wtPathHtml(d.dir)],
    ])
    + `<div class="wt-acts"><button class="wt-go" type="button" data-wtact="go"${clash ? " disabled" : ""}>Create worktree &amp; start</button>`
    + (clash ? `<button class="wt-alt" type="button" data-wtact="openclash">Open that checkout instead</button>` : "")
    + `</div>`;
}

// Confirmed in the pane, not a modal on a modal. `worktree remove` never touches the
// branch, so the checkout and the branch get separate sentences and separate buttons.
function wtConfirmHtml(d: Dest): string {
  const w = d.wt!;
  const folder = `<b>${esc(basename(w.path))}/</b>`;
  if (!w.exists) {
    return `<div class="wt-danger"><span class="q">Prune ${folder}?</span>`
      + `<span class="w">The folder is already gone; this only clears git's record of it. Nothing is lost.</span>`
      + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="rm0">Prune it</button>`
      + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  if (w.dirty) {
    return `<div class="wt-danger"><span class="q">Remove ${folder}?</span>`
      + `<span class="w"><span class="em">Uncommitted changes</span> live only in this checkout. Nothing else has them. `
      + `Episko won't force it; it'll open a terminal in the repo root with the command ready.</span>`
      + `<span class="row"><button class="wt-cbtn" type="button" data-wtact="rm0">Open a terminal there</button>`
      + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const hasBranch = !!w.branch && w.branch !== "(detached)";
  const branchLine = !hasBranch
    ? " It has no branch checked out, so only the folder goes."
    : w.merged
      ? ` Its branch <b>${esc(w.branch)}</b> is merged into ${esc(wtRepoBranch || "the main branch")}, so deleting it loses nothing.`
      : ` Its branch <b>${esc(w.branch)}</b> has commits ${esc(wtRepoBranch || "the main branch")} doesn't, so it's kept.`;
  return `<div class="wt-danger"><span class="q">Remove ${folder}?</span>`
    + `<span class="w">The checkout is clean.${branchLine}</span>`
    + `<span class="row">`
    + (hasBranch && w.merged ? `<button class="wt-cbtn danger" type="button" data-wtact="rm1">Remove + delete branch</button>` : "")
    + `<button class="wt-cbtn" type="button" data-wtact="rm0">Remove${hasBranch ? ", keep branch" : ""}</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

// A `gone` upstream usually means the PR merged, but a squash merge leaves no ancestors of
// HEAD, so `git branch -d` refuses anyway. Say that before the click, not after it fails.
function wtBranchConfirmHtml(d: Dest): string {
  const b = d.br!;
  const name = `<b>${esc(b.name)}</b>`;
  let why: string;
  if (b.gone) {
    why = `<b>${esc(b.upstream)}</b> was deleted on the remote, so this branch is local-only now, often after its pull request merged, `
      + `but not always. If you still want the work, cancel and start a worktree on it instead; a push from there recreates the remote branch.`;
  } else if (!b.upstream) {
    why = `<span class="em">It has never been pushed.</span> Its commits exist here and nowhere else. Once it's gone, they're only reachable by sha.`;
  } else if (b.ahead) {
    why = `<span class="em">${b.ahead} commit${b.ahead === 1 ? "" : "s"} are not on <b>${esc(b.upstream)}</b></span>. Deleting the branch leaves them only reachable by sha. The remote branch itself stays.`;
  } else {
    why = `It's in sync with <b>${esc(b.upstream)}</b>, which is not touched, so the remote branch stays and this can be re-fetched.`;
  }
  return `<div class="wt-danger"><span class="q">Delete ${name}?</span>`
    + `<span class="w">${why}</span>`
    + `<span class="w">Episko only runs the safe <b>git branch -d</b>, so git refuses anything it can't see as merged`
    + `${b.gone ? ", which includes a squash-merged branch" : ""}. If it does, you get a terminal with <b>-D</b> ready.</span>`
    + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="delbranch">Delete branch</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

// Safe-delete only; on refusal the `-D` command goes to a terminal, never to a click.
async function wtDeleteBranch() {
  const d = wtRows[wtSel];
  if (!d || d.kind !== "branch" || !wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx, branch = d.br!.name;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("delete_branch", { repoDir, branch });
    dlog(r.ok ? "info" : "warn", `branch delete · ${branch} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = "";
    await wtLoad(true);
  } catch (e) {
    dlog("error", `branch delete failed: ${e}`);
    toast("branch: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// Defaults to the repo's HEAD, as git does silently: a root parked on a feature branch makes
// every new worktree a child of it, so the parent is named and changeable.
function wtBaseSelect(): string {
  const head = wtRepoBranch || "HEAD";
  return wtPickBtn("base", wtBase || head) + (wtBase ? "" : ` <span class="dim">the repo's current branch</span>`);
}
function wtBaseOptions(): BranchPick[] {
  const head = wtRepoBranch || "HEAD";
  return [{ name: head, note: "the repo's current branch" }]
    .concat(wtBranches.filter((b) => !b.current).map((b) => ({ name: b.name, note: b.rel || "" })));
}

// Moving the root itself stays secondary to a worktree, but the root's branch is the default
// parent of every new worktree, so a stale root needs an escape. Only work in flight
// (`midFlight`) blocks it; "any session at all" made it unreachable exactly when wanted.
function wtSwitchHtml(): string {
  if (!wtCtx) return "";
  const { repoDir } = wtCtx;
  const here = wtSessionsIn(repoDir);
  const busy = here.filter(midFlight);
  // An external session counts the same way, with the one signal its registry file has:
  // `extWorking` blocks, a quiet one only warns.
  const extHere = externals.filter((e) => e.cwd === repoDir);
  const extBusy = extHere.filter(extWorking);
  const pick = wtSwitchable();
  if (busy.length || extBusy.length) {
    const agents = busy.filter(isAgent).length;
    const runs = busy.filter((s) => s.kind === "task").length;
    const what: string[] = [];
    if (agents) what.push(`${agents} agent${agents === 1 ? " is" : "s are"} mid-turn`);
    if (runs) what.push(`${runs} task${runs === 1 ? " is" : "s are"} still running`);
    if (extBusy.length) what.push(`${extBusy.length} session${extBusy.length === 1 ? " is" : "s are"} working outside Episko`);
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w"><span class="em">${what.join(", ")}.</span> `
      + `Switching would move the ground under that work mid-edit, so Episko won't, though only while it lasts. `
      + `Simply having a session open here doesn't block it: wait for this to land, or stop it.</span>`
      + (busy.length ? wtSessHtml(busy) : "")
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  if (!pick.length) {
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w">Every other branch is already checked out in a worktree, so there is nothing to switch to.</span>`
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const sel = wtSwitchTo || pick[0].name;
  // A remote-only target also brings a name into the repo, a change to the branch list, so
  // it is said before the click rather than discovered in the toast.
  const from = pick.find((o) => o.name === sel)?.base;
  const cut = from
    ? `<span class="w"><b>${esc(sel)}</b> exists only on <b>${esc(from)}</b>. Switching cuts a local branch from it, `
      + `set to track it, so <b>git push</b> and <b>git pull</b> here take no arguments afterwards.</span>`
    : "";
  // Nothing open here is mid-turn (the wall above caught that), so say what the switch means
  // for it: the next prompt or command lands on the new branch, whatever the conversation
  // reads. An exited pane is a transcript on screen and left out of the count.
  const stay = here.filter((s) => !isExited(s)).length + extHere.length;
  const note = stay
    ? `<div class="wt-warn note"><span class="t">${stay} session${stay === 1 ? "" : "s"} stay${stay === 1 ? "s" : ""} open</span>`
      + `Nothing here is mid-turn, so no work is cut off. But this folder is where `
      + `${stay === 1 ? "it lives" : "they live"}, so the next thing that happens in `
      + `${stay === 1 ? "it" : "them"} (your next prompt, the next command you type) happens on `
      + `<b>${esc(sel)}</b>, however the conversation reads.</div>`
    : "";
  return `<div class="wt-danger"><span class="q">Switch <b>${esc(basename(repoDir))}</b> to another branch?</span>`
    + `<span class="w">The repo's own folder moves. Every worktree keeps its own branch, untouched. `
    + `This also changes what new worktrees branch from by default.</span>`
    + `<span class="row">${wtPickBtn("switch", sel)}</span>`
    + cut
    + note
    + `<span class="w">Episko only switches a <b>clean</b> tree: git would carry uncommitted changes across to the new branch, `
    + `which is a change it never announced. If yours is dirty you get a terminal instead.</span>`
    + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="doswitch">Switch branch</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

/** Branches the root can move to, plus the remote-only ones the switch cuts a local ref from. */
function wtSwitchOptions(): BranchPick[] {
  // One checkout per branch, so anything held is listed disabled with the reason: omitting
  // it silently made `dev` look like it had gone missing.
  const held = new Map<string, string>();
  for (const w of wtWts) if (!w.is_main && w.branch) held.set(w.branch, basename(w.path));
  const local = wtBranches.map((b) => b.current
    ? { name: b.name, note: "already checked out here", disabled: true }
    : held.has(b.name)
      ? { name: b.name, note: `checked out in ${held.get(b.name)}/`, disabled: true }
      : { name: b.name, note: b.rel || "" });
  // Remote-only rows have no local ref (git_branch_list says so), so none is held; `base`
  // makes the cut ref track its origin. Last and marked: the only options that add a name.
  const remote = wtRemotes.map((b) => ({
    name: b.name, ic: "⇣", base: b.upstream,
    note: `only on ${wtRemoteOf(b)}; creates a local branch tracking it`,
  }));
  return [...local, ...remote];
}
const wtSwitchable = () => wtSwitchOptions().filter((o) => !o.disabled);
async function wtDoSwitch() {
  if (!wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  const pick = wtSwitchable();
  const target = pick.find((o) => o.name === wtSwitchTo) ?? pick[0];
  const branch = target?.name;
  if (!branch) return;
  wtBusy = true;
  try {
    // `base` is null unless the target is remote-only; the backend ignores it for a branch
    // that exists locally by now, so a seconds-old list is safe to send.
    const r = await invoke<GitActionResult>("switch_branch", { repoDir, branch, base: target.base ?? null });
    dlog(r.ok ? "info" : "warn", `switch · ${basename(repoDir)} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = ""; wtSwitchTo = ""; wtRepoBranch = branch;
    onBranchSwitched(repoDir);
    await wtLoad(true);
    // Sessions here still show the branch they were launched on; the app moved HEAD itself,
    // so it must not wait for the 4s poll to correct them.
    void refreshGitViews();
  } catch (e) {
    dlog("error", `switch failed: ${e}`);
    toast("switch: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// ---------- branch chooser ----------
// One picker for the new-worktree base and the root-switch target, in the .menupop idiom.
// At body level (#bPop) because .wtdlg is overflow:hidden; typing filters, since a repo
// can hold BRANCH_LIST_CAP refs.
interface BranchPick {
  name: string;
  note: string;
  disabled?: boolean; // shown but not choosable, with `note` saying why: a row that vanishes reads as a bug
  ic?: string;        // row glyph override; only the remote-only rows set it (⇣)
  base?: string;      // remote-tracking ref to cut from when there is no local ref (see switch_branch)
}
let bPopItems: BranchPick[] = [];
let bPopSel = 0;
let bPopOn: ((name: string) => void) | null = null;
let bPopAnchor: HTMLElement | null = null;

function bPopOpen() { return $("bPop").classList.contains("show"); }
// Exported for the Branches view's trunk chip (via `DashHost.pickTrunk`), so the popover
// and its keyboard handling exist once.
export function openBranchPop(anchor: HTMLElement, items: BranchPick[], current: string, onPick: (name: string) => void) {
  bPopItems = items; bPopOn = onPick; bPopAnchor = anchor;
  const at = items.findIndex((i) => i.name === current);
  bPopSel = at >= 0 && !items[at].disabled ? at : bPopFirst(items);
  const pop = $("bPop");
  pop.innerHTML = `<div class="bp-q"><span>❯</span><input id="bPopQ" spellcheck="false" autocomplete="off" placeholder="Filter branches…" aria-label="Filter branches" /></div><div class="bp-list" id="bPopList" role="listbox"></div>`;
  pop.classList.add("show");
  anchor.classList.add("open");
  renderBranchPop();
  // Anchor below the trigger, flipping above when that would run off the bottom.
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
  setTimeout(() => ($("bPopQ") as HTMLInputElement)?.focus(), 20);
}
function renderBranchPop() {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  const shown = bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
  if (bPopSel >= shown.length) bPopSel = Math.max(0, shown.length - 1);
  $("bPopList").innerHTML = shown.length
    ? shown.map((i, n) => `<button class="mp-item${n === bPopSel ? " on" : ""}${i.disabled ? " dis" : ""}" type="button" role="option"`
        + ` aria-selected="${n === bPopSel}" aria-disabled="${!!i.disabled}"${i.disabled ? " disabled" : ""} data-bpick="${esc(i.name)}">`
        + `<span class="mp-ic">${i.disabled ? "⊘" : i.ic || "⌥"}</span><span class="mp-main"><span class="mp-l">${esc(i.name)}</span>`
        + (i.note ? `<span class="mp-s">${esc(i.note)}</span>` : "")
        + `</span><span class="mp-check">✓</span></button>`).join("")
    : `<div class="bp-none">No branch matches that.</div>`;
  $("bPopList").querySelector(".mp-item.on")?.scrollIntoView({ block: "nearest" });
}
function bPopShown(): BranchPick[] {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  return bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
}
/** Next choosable row in `dir`, or stay put: arrows step over the disabled entries. */
function bPopStep(shown: BranchPick[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (!shown[i].disabled) return i;
  return from;
}
const bPopFirst = (shown: BranchPick[]) => { const i = shown.findIndex((x) => !x.disabled); return i < 0 ? 0 : i; };
export function closeBranchPop(refocus = true) {
  if (!bPopOpen()) return;
  $("bPop").classList.remove("show");
  bPopAnchor?.classList.remove("open");
  bPopAnchor = null; bPopOn = null;
  if (refocus && $("wtDlg").classList.contains("show")) ($("wtQ") as HTMLInputElement).focus();
}
function bPopPick(name: string) { const cb = bPopOn; closeBranchPop(); cb?.(name); }

$("bPop").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bpick]");
  if (b) bPopPick(b.dataset.bpick!);
});
$("bPop").addEventListener("input", () => { bPopSel = bPopFirst(bPopShown()); renderBranchPop(); });
$("bPop").addEventListener("keydown", (e) => {
  const shown = bPopShown();
  if (e.key === "ArrowDown") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, 1); renderBranchPop(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); bPopSel = bPopStep(shown, bPopSel, -1); renderBranchPop(); }
  else if (e.key === "Enter") { e.preventDefault(); const p = shown[bPopSel]; if (p && !p.disabled) bPopPick(p.name); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeBranchPop(); }
});

function wtPickBtn(kind: "base" | "switch", label: string): string {
  return `<button class="wt-pick" type="button" data-wtpick="${kind}" aria-haspopup="listbox">`
    + `<span class="v">${esc(label)}</span><span class="c">▾</span></button>`;
}

export function closeWt() {
  closeBranchPop(false);
  $("wtDlg").classList.remove("show"); dropScrim();
  clearInterval(wtAgeT); wtAgeT = undefined;
  wtCtx = null; wtArmed = ""; wtGen++;
}

/** What ⏎ (and the pane's primary button) does for the highlighted row. */
function wtRun(d: Dest | undefined) {
  if (!d || !wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  if (d.kind === "repo") { closeWt(); launch(project, repoDir, { colorKey: repoDir, branch: wtRepoBranch }); return; }
  if (d.kind === "wt") {
    const w = d.wt!;
    if (!w.exists) { toast(`${basename(w.path)} is gone, remove it instead`); return; }
    closeWt();
    // Always a NEW session: a second agent on one branch is normal. The session chips jump to a running one.
    launch(project, w.path, { colorKey: repoDir, worktree: wtLabelOf(w), branch: d.branch });
    return;
  }
  if (d.clash) { toast(`${basename(d.clash.path)}/ already exists`); return; }
  // A remote-only row starts from its remote ref, which is what makes the new branch track it.
  void wtCreate(d.branch, d.kind === "create" ? wtBase : d.kind === "remote" ? d.br!.upstream : "");
}

async function wtCreate(branch: string, base = "") {
  if (!wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  wtBusy = true;
  try {
    const path = await invoke<string>("create_worktree", { repoDir, branch, base: base || null });
    closeWt();
    launch(project, path, { colorKey: repoDir, worktree: branch, branch });
    toast(`Worktree ${branch} created`);
  } catch (e) {
    dlog("error", `worktree create failed (${branch}): ${e}`);
    toast("worktree: " + e);
  } finally { wtBusy = false; }
}

// Same number and reason as actions.ts's KILL_WAIT_MS: only `pty-exit` proves the process
// was reaped, and Windows won't delete a directory a live process sits in. Bounded so a
// wedged process can't strand the removal forever.
const KILL_WAIT_MS = 5000;

// Close every session in a checkout and wait for the processes to be gone. Order matters:
// each waiter is registered BEFORE its kill (a fast exit would resolve into nothing), and
// `closeSession` comes last because it settles pending waiters itself. Ended panes are
// skipped: no `pty-exit` is coming for them.
async function closeSessionsIn(list: Sess[]) {
  const running = list.filter((s) => s.phase !== "ended");
  const dead = running.map((s) => {
    const w = waitForExit(s.id);
    void invoke("kill_session", { sessionId: s.id }).catch(() => {});
    return w;
  });
  if (dead.length) {
    await Promise.race([Promise.all(dead), new Promise((r) => setTimeout(r, KILL_WAIT_MS))]);
  }
  for (const s of list) closeSession(s.id);
}

// A worktree gone from git whose folder is still on disk. Processes Episko started are
// killed without asking (the click already decided that); anything else is somebody's
// editor or build, and a question. No holder means the OS refused for another reason: say so.
async function strandedFlow(s: Stranded, label: string) {
  const purge = (kill: number[]) =>
    invoke<PurgeResult>("purge_worktree_folder", { path: s.path, kill })
      .catch((e) => { dlog("warn", `purge ${s.path}: ${e}`); return null; });

  let cur = s;
  const ours = cur.holders.filter((h) => h.ours).map((h) => h.pid);
  if (ours.length) {
    const r = await purge(ours);
    if (r?.gone) { toast(`Removed ${label}`); return; }
    if (r?.stranded) cur = r.stranded;
  }
  const foreign = cur.holders.filter((h) => !h.ours);
  if (!foreign.length) {
    toast(`${label} removed, but its folder wouldn't delete: ${cur.reason}`);
    return;
  }
  const one = foreign.length === 1;
  const who = foreign
    .map((h) => `  • ${h.name} (${h.pid}): ${h.why === "cwd" ? "sitting in this folder" : "has a file open"}`)
    .join("\n");
  const ok = await ask(
    `${label} is removed, but its folder is still on disk:\n${cur.path}\n\nHeld by:\n${who}\n\n`
    + `Terminating ${one ? "it" : "them"} ends whatever ${one ? "it is" : "they are"} doing`
    + `. An editor loses unsaved work, a build stops.`,
    { title: "Folder still in use", kind: "warning", okLabel: "Terminate & retry", cancelLabel: "Leave it" },
  );
  if (!ok) { toast(`Folder left at ${basename(cur.path)}/; nothing else of the worktree remains`); return; }
  const r = await purge(foreign.map((h) => h.pid));
  toast(r?.gone ? `Removed ${label}` : `${basename(cur.path)}/ still wouldn't delete: ${r?.stranded?.reason ?? "unknown"}`);
}

// The backend never forces: a dirty tree is refused and its --force command handed to a terminal.
async function wtDoRemove(deleteBranch: boolean) {
  const d = wtRows[wtSel];
  if (!d || d.kind !== "wt" || !wtCtx || wtBusy) return;
  const w = d.wt!, { project, repoDir } = wtCtx;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path: w.path, branch: w.branch, deleteBranch });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${w.branch || w.path} · ${r.summary}`);
    if (!r.ok && r.suggest) {
      // git refused and changed nothing. The handoff runs from the repo root, never the
      // worktree being deleted: git refuses to remove the tree you're standing in.
      toast(`${r.summary} → opening a terminal`);
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    toast(r.summary);
    wtArmed = "";
    // Unconditional: a stranded removal is `ok: true` and has already changed the roster,
    // and a harmless refusal costs one listing.
    await wtLoad(true);       // this dialog's own list…
    await refreshGitViews();  // …and the ⑃ roster the sidebar draws behind it
    if (r.stranded) await strandedFlow(r.stranded, wtLabelOf(w));
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  } finally { wtBusy = false; renderAll(); }
}

export function removeWorktreeSession(s: Sess) {
  return removeWorktreeAt(s.project, s.colorKey, s.workdir, s.branch);
}
// Remove the checkout at `path`: guard uncommitted work, close the sessions in it, remove
// the worktree, safe-delete its branch. Keyed by path because the ⑃ cluster menu may hold
// no session at all. The backend can't see an external session, so that case is refused:
// `git worktree remove` would pull the folder from under an agent in someone else's terminal.
export async function removeWorktreeAt(project: string, repoDir: string, path: string, branch: string) {
  const label = branch || basename(path);
  const at = wtNorm(path);
  if (externals.some((e) => wtNorm(e.cwd) === at)) {
    toast(`${label}: a session outside Episko is running there. Close it first`);
    return;
  }
  const live = wtSessionsIn(path);
  // Is the folder even there? A checkout removed outside Episko keeps its `.git/worktrees`
  // record while a session names it, and the generic question below reads as a warning
  // about work to lose. The in-memory roster (`worktree_heads`) is the authority; unknown
  // means "assume it is there", since the backend removes a vanished checkout cleanly anyway.
  const known = (worktreesByRepo.get(repoDir) ?? []).find((w) => wtNorm(w.path) === at);
  const gone = known ? !known.exists : false;
  if (gone) {
    if (!await ask(`Prune ${basename(path)}/?\n\nThe folder is already gone, so this only clears git's record of it. Nothing is lost.`,
      { title: "Prune worktree", kind: "info", okLabel: "Prune", cancelLabel: "Cancel" })) return;
  } else {
    // Never close a session with a dirty tree; hand over a shell instead. A null diffstat
    // (non-repo) is "clean enough to try": the backend still refuses, without forcing, if wrong.
    const ds = await invoke<DiffStat | null>("git_diffstat", { workdir: path }).catch(() => null);
    if (ds && ds.dirty > 0) {
      toast(`${label}: uncommitted changes; commit or discard first`);
      await handToTerminal(project, path, "git status", { colorKey: repoDir, worktree: branch, branch });
      return;
    }
    const closes = live.length === 0 ? "Nothing is running in it"
      : live.length === 1 ? "Its session closes"
      : `Its ${live.length} sessions close`;
    if (!await ask(`Remove the worktree at ${basename(path)}/?\n\n${closes}, the folder goes, and its branch is deleted only if it's fully merged.`,
      { title: "Remove worktree", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" })) return;
  }
  // Wait for the processes to be reaped: git deletes the directory before it unregisters the
  // worktree, and Windows won't delete a directory a live process sits in.
  await closeSessionsIn(live);
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path, branch, deleteBranch: true });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${label} · ${r.summary}`);
    // The handoff runs from the repo root: git refuses to remove the tree you're standing in.
    if (!r.ok && r.suggest) { toast(`${r.summary} → opening a terminal`); await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir }); }
    else toast(r.summary);
    // The cluster header is drawn from the ⑃ roster, which only a re-read drops. Unconditional:
    // a stranded removal is `ok: true` and has already changed the roster.
    await refreshGitViews();
    if (r.stranded) await strandedFlow(r.stranded, label);
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  }
  renderAll();
}

// ---------- the dialog's own event wiring ----------
// Rows are indexed into wtRows; the data-wt* attributes are handled here, never in main.ts's dispatcher.
$("wtRefresh").addEventListener("click", () => { void wtReadLocal(true).then(() => wtMaybeFetch(true)); });
// Coming back to the window is when the list is most likely stale. Skipped while the chooser
// is open: a re-render would swap the element its popover is anchored to.
window.addEventListener("focus", () => {
  if (!$("wtDlg").classList.contains("show") || bPopOpen()) return;
  void wtReadLocal(true).then(() => wtMaybeFetch());
});
$("wtQ").addEventListener("input", () => { wtSel = 0; wtArmed = ""; wtRender(); });
$("wtQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); wtSel = Math.min(wtSel + 1, wtRows.length - 1); wtRender(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); wtSel = Math.max(wtSel - 1, 0); wtRender(); }
  else if (e.key === "Enter") { e.preventDefault(); wtRun(wtRows[wtSel]); }
  else if (e.key === "Escape") {
    e.preventDefault();
    // Esc peels one layer at a time: an armed removal, then the filter, then the dialog.
    if (wtArmed) { wtArmed = ""; wtRender(); }
    else if (($("wtQ") as HTMLInputElement).value) { ($("wtQ") as HTMLInputElement).value = ""; wtSel = 0; wtRender(); }
    else closeWt();
  }
});
$("wtDlg").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>("[data-wtpick]");
  if (pick) {
    if (bPopOpen()) { closeBranchPop(); return; }
    const head = wtRepoBranch || "HEAD";
    if (pick.dataset.wtpick === "cmp") {
      // A new trunk changes numbers only git can recompute, so re-read; the empty option clears the override.
      openBranchPop(pick, wtTrunkOptions(), cmpBase[wtCtx?.repoDir ?? ""] ?? "", (n) => {
        if (!wtCtx) return;
        saveCmpBase(wtCtx.repoDir, n);
        void wtReadLocal(true);
      });
    } else if (pick.dataset.wtpick === "base") {
      openBranchPop(pick, wtBaseOptions(), wtBase || head, (n) => { wtBase = n === head ? "" : n; wtRender(); });
    } else {
      openBranchPop(pick, wtSwitchOptions(), wtSwitchTo || wtSwitchable()[0]?.name || "", (n) => { wtSwitchTo = n; wtRender(); });
    }
    return;
  }
  const jump = t.closest<HTMLElement>("[data-wtjump]");
  if (jump) { const id = jump.dataset.wtjump!; closeWt(); setActive(id); return; }
  const act = t.closest<HTMLElement>("[data-wtact]");
  if (act) {
    switch (act.dataset.wtact) {
      case "go": wtRun(wtRows[wtSel]); break;
      case "arm": wtArmed = wtRows[wtSel]?.dir || ""; wtRender(); break;
      case "cancel": wtArmed = ""; wtRender(); break;
      case "rm0": void wtDoRemove(false); break;
      case "rm1": void wtDoRemove(true); break;
      case "delbranch": void wtDeleteBranch(); break;
      case "doswitch": void wtDoSwitch(); break;
      case "openclash": {
        const c = wtRows[wtSel]?.clash;
        if (c && wtCtx) { const { project, repoDir } = wtCtx; closeWt(); launch(project, c.path, { colorKey: repoDir, worktree: wtLabelOf(c), branch: c.branch }); }
        break;
      }
    }
    ($("wtQ") as HTMLInputElement).focus();
    return;
  }
  const row = t.closest<HTMLElement>("[data-wti]");
  // Picking a row cancels an armed removal: one question on screen at a time.
  if (row) { wtSel = +row.dataset.wti!; wtArmed = ""; wtRender(); ($("wtQ") as HTMLInputElement).focus(); }
});
// Double-click runs the row; the first click of the pair already selected it.
$("wtList").addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-wti]");
  if (row) { e.preventDefault(); wtRun(wtRows[+row.dataset.wti!]); }
});
