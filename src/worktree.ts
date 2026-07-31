// The new-session dialog: pick where a session starts — the repo root, an existing
// worktree, a branch to check out, or a brand-new worktree — plus the branch chooser
// popover it opens and the worktree removal/switch flows.
//
// The biggest single cluster to come out of main.ts, and it moves whole: its markup
// reads its own dialog state (which row is armed, what is prefetched, whether a
// create is in flight), so there is no clean view/controller seam to split it on the
// way the *view.ts modules have. It owns its state, its markup, its git calls and
// its own click/key handlers — rows are addressed by index into wtRows, so nothing
// leaks into the global [data-*] dispatcher.
//
// Four things it cannot own reach it as hooks (PLAN seam rule 2), and they are all
// the same kind of thing: this dialog *acts on panes*, which main.ts owns. Starting
// a session, closing one, putting one on stage, repainting everything.

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { $, dropScrim, toast } from "./dom";
import { dlog } from "./debug";
import { basename, esc } from "./format";
import type { DiffStat, GitActionResult, Phase, Sess } from "./types";
import { engineDef, sessions, termEngine } from "./state";

type LaunchOpts = { colorKey?: string; worktree?: string | null; branch?: string; resume?: string };
let launch: (project: string, workdir: string, opts?: LaunchOpts) => Promise<void> = async () => {};
export function setWtLaunch(fn: typeof launch) { launch = fn; }
let closeSession: (id: string) => void = () => {};
export function setWtCloseSession(fn: typeof closeSession) { closeSession = fn; }
let setActive: (id: string) => void = () => {};
export function setWtSetActive(fn: typeof setActive) { setActive = fn; }
let renderAll: () => void = () => {};
export function setWtRenderAll(fn: typeof renderAll) { renderAll = fn; }
// Handing a refused git action to a real terminal needs a pane (or an external
// window) and the launch engine — main.ts territory, same as the four above.
let handToTerminal: (project: string, workdir: string, cmd: string, opts?: { colorKey?: string; worktree?: string | null; branch?: string }) => Promise<void> = async () => {};
export function setWtHandToTerminal(fn: typeof handToTerminal) { handToTerminal = fn; }

// Every answer to "where should this session run?" is a directory, so every answer
// is a row: the repo itself, its worktrees, its branches, and whatever you type.
// One list on the left; the consequences of the highlighted row on the right.
//
// The repo row is unconditional — the old dialog only offered the main checkout when
// `requestLaunch` opened it, so the toolbar button, the context menu and the action
// panel each led to a dialog that couldn't start a session in the project itself.
// ahead/behind are versus this branch's OWN remote upstream (empty when it has none),
// not versus whatever HEAD is on — see the BranchInfo doc comment in lib.rs.
// `remote: true` inverts how the row is read: it has no local branch at all, so `name`
// is the local branch a checkout WOULD create and `upstream` the ref it would track.
// See the BranchInfo doc comment in git.rs.
type BranchInfo = { name: string; current: boolean; checked_out: boolean; upstream: string; ahead: number; behind: number; gone: boolean; remote: boolean; rel: string; unix: number };
type WtInfo = { path: string; branch: string; is_main: boolean; dirty: boolean; merged: boolean; locked: boolean; exists: boolean };
type CommitInfo = { short: string; subject: string; author: string; rel: string };

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
// Kept apart rather than filtered at each use: `wtBranches` means "branches this repo
// has", and every existing reader (the base chooser, the switch chooser, delete) is only
// ever correct for those. A remote-only row is not a branch you can base, switch to or
// delete — it doesn't exist yet.
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
const wtDirty = new Map<string, DiffStat | null>();

/** Mirror of the backend's path scheme (`create_worktree`): every character git
 *  can't take becomes "-", then "/" does too. Lossy on purpose — and irreversibly
 *  so, which is why nothing here ever tries to derive a branch back out of a folder. */
function wtSlug(branch: string): string {
  return branch.trim().replace(/[^\p{L}\p{N}\-_/.]/gu, "-").replace(/\//g, "-");
}
function parentOf(p: string) { const q = p.replace(/[/\\]+$/, ""); const i = Math.max(q.lastIndexOf("/"), q.lastIndexOf("\\")); return i > 0 ? q.slice(0, i) : q; }
const wtNorm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
/** Where `create_worktree` would put a checkout for `branch` in this repo. */
function wtTargetDir(repoDir: string, branch: string) {
  return `${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}/${wtSlug(branch)}`;
}

// The four ways a checkout's folder and its branch can relate. The folder is the
// identity (it's what exists, and what removal deletes); the branch is only a label,
// and `git switch` inside a session rewrites it at will.
type WtState = "aligned" | "diverged" | "detached" | "foreign";
function wtStateOf(w: WtInfo, repoDir: string): WtState {
  const base = wtNorm(`${parentOf(repoDir)}/.cc-worktrees/${basename(repoDir)}`);
  if (!wtNorm(w.path).startsWith(base + "/")) return "foreign";
  if (!w.branch || w.branch === "(detached)") return "detached";
  return wtSlug(w.branch) === basename(w.path) ? "aligned" : "diverged";
}
/** What to call a checkout. Its branch when it has one; otherwise its folder,
 *  because a row still has to be nameable. */
function wtLabelOf(w: WtInfo) {
  return w.branch && w.branch !== "(detached)" ? w.branch : basename(w.path) + "/";
}
const wtSessionsIn = (path: string) => [...sessions.values()].filter((s) => s.workdir === path);

/** Head flexes and ellipsises, tail is pinned: sibling branches often differ only in
 *  their suffix, so a plain tail-ellipsis would render two rows identically. */
function wtName(name: string) {
  const TAIL = 9;
  if (name.length <= TAIL + 4) return `<span class="hd">${esc(name)}</span>`;
  return `<span class="hd">${esc(name.slice(0, name.length - TAIL))}</span><span class="tl">${esc(name.slice(-TAIL))}</span>`;
}

/** A branch's standing against its own remote — the only comparison that answers a
 *  question you'd actually ask here. A branch in sync with its upstream shows nothing;
 *  silence is the clean state. */
function wtSyncMeta(b: BranchInfo): string {
  if (b.gone) return `<span class="wt-tag gone" title="${esc(b.upstream)} no longer exists on the remote — this branch is local-only now">gone</span>`;
  if (!b.upstream) return `<span class="wt-tag det" title="No remote branch tracks this — it has never been pushed">local</span>`;
  return (b.ahead ? `<span class="wt-ab wt-ahead" title="${b.ahead} commit(s) not yet pushed to ${esc(b.upstream)}">↑${b.ahead}</span>` : "")
    + (b.behind ? `<span class="wt-ab wt-behind" title="${b.behind} commit(s) on ${esc(b.upstream)} not pulled yet">↓${b.behind}</span>` : "");
}

/** The same fact as wtSyncMeta, spelled out for the detail pane. */
function wtUpstreamHtml(b: BranchInfo): string {
  if (b.gone) return `<span class="em">${esc(b.upstream)}</span> — deleted on the remote; local-only now`;
  if (!b.upstream) return `<span class="dim">none — never pushed</span>`;
  if (!b.ahead && !b.behind) return `<span class="em">${esc(b.upstream)}</span> <span class="good">· in sync</span>`;
  return `<span class="em">${esc(b.upstream)}</span>`
    + (b.ahead ? ` · <span class="warn">↑${b.ahead} unpushed</span>` : "")
    + (b.behind ? ` · ↓${b.behind} unpulled` : "");
}

export async function openWt(project: string, repoDir: string, knownBranch?: string | null) {
  wtCtx = { project, repoDir };
  wtSel = 0; wtArmed = ""; wtBusy = false; wtBase = ""; wtSwitchTo = ""; wtFetchedAt = 0;
  wtRepoBranch = knownBranch || "";   // seeded by requestLaunch, which already asked
  ($("wtQ") as HTMLInputElement).value = "";
  $("wtProj").textContent = project;
  $("wtPath").textContent = repoDir;
  const eng = engineDef(termEngine);
  $("wtEng").textContent = `${termEngine === "embedded" ? "▤" : "⧉"} ${eng.label}`;
  ($("wtEng") as HTMLElement).title = `New sessions open in ${eng.label}`;
  $("scrim").classList.add("show"); $("wtDlg").classList.add("show");
  setTimeout(() => ($("wtQ") as HTMLInputElement).focus(), 30);
  clearInterval(wtAgeT); wtAgeT = window.setInterval(wtTickAge, 1000);
  await wtLoad();
}

// Both lists cost several git calls (a status probe per checkout, a rev-list per ref),
// so the dialog draws its shape first and fills in. The repo row is real from the
// first frame — it's the path we were opened with — so ⏎ works at t=0.
//
// Two layers of freshness, because they cost different things:
//   wtReadLocal — pure local git, instant, safe to run whenever.
//   wtMaybeFetch — network. ahead/behind and `gone` come from %(upstream:track), which
//     compares against refs/remotes/*, a cache only `git fetch` moves. Without this the
//     panel's most useful signal would silently reflect whenever you last fetched — and
//     the Remote branches group is read straight out of refs/remotes, so a colleague's
//     branch pushed five minutes ago would not be a destination at all.
async function wtLoad(quiet = false) {
  await wtReadLocal(quiet);
  void wtMaybeFetch();
}

// Re-list because the repo changed underneath the open dialog — a worktree created or
// removed by an agent while you were looking at the picker. A no-op when the dialog is
// closed, so the caller (the git-invalidation path in panes.ts) doesn't have to know
// whether it is. Local read only: this is not a reason to hit the network.
export async function refreshWtDialog() {
  if (!wtCtx) return;
  await wtReadLocal(true);
}

// Fetch is throttled and best-effort: it runs in the background, never blocks the list,
// and stays silent on failure (offline, no remote, auth) — a stale number is a better
// outcome than a toast every time you alt-tab with no network.
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

// `quiet` = there is already a list on screen, so don't tear it down: no skeletons, no
// "not a git repository" toast a second time, and one render at the end instead of two.
// Skeletons are for the first paint only.
async function wtReadLocal(quiet = false) {
  if (!wtCtx) return;
  const { repoDir } = wtCtx;
  const gen = ++wtGen;
  // The lazily-fetched facts (HEAD lines, the repo's dirty count) are re-derived: a
  // quiet refresh usually follows something that moved them.
  wtCommits.clear(); wtDirty.clear();
  if (!quiet) { wtLoading = true; wtRender(); }
  const [wts, branches, head] = await Promise.all([
    invoke<WtInfo[]>("list_worktrees", { repoDir }).catch(() => [] as WtInfo[]),
    invoke<BranchInfo[]>("git_branch_list", { repoDir }).catch(() => [] as BranchInfo[]),
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

// One array, four row kinds. Both the list and the detail pane read only from this.
function wtBuild(): Dest[] {
  if (!wtCtx) return [];
  const { repoDir } = wtCtx;
  const raw = ($("wtQ") as HTMLInputElement).value;
  const q = raw.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const out: Dest[] = [];

  // Remote-only names count as known: typing one must land on its row, not fall through
  // to "create", which would cut an unrelated branch off HEAD under the very same name.
  const known = [...wtWts.map((w) => w.branch), ...wtBranches.map((b) => b.name),
    ...wtRemotes.map((b) => b.name), wtRepoBranch];
  const exact = known.some((n) => n && n.toLowerCase() === q);

  // The typed query, promoted to an action. This is what lets the branch field, its
  // datalist and the fixed "Create worktree" button all disappear.
  if (q && !exact) {
    const want = wtSlug(raw);
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === want);
    out.push({
      kind: "create", group: "", ic: "＋", label: raw.trim(),
      sub: clash ? `folder ${basename(clash.path)}/ is already taken` : `new worktree off ${wtBase || wtRepoBranch || "HEAD"}`,
      dir: wtTargetDir(repoDir, raw), branch: raw.trim(), tags: [], meta: "", stale: false, clash,
      verb: clash ? "blocked — that folder exists" : "create worktree & start session",
    });
  }

  const repoSess = wtSessionsIn(repoDir).length;
  if (hit(wtRepoBranch) || hit(basename(repoDir)) || hit("repo")) {
    out.push({
      kind: "repo", group: "Repo", ic: "⌂",
      label: wtRepoBranch || basename(repoDir), sub: repoDir,
      dir: repoDir, branch: wtRepoBranch,
      tags: repoSess ? [["open", `${repoSess} open`]] : [], meta: "", stale: false,
      verb: "start session in the repo — no worktree",
    });
  }

  for (const w of wtWts) {
    if (w.is_main) continue;
    // Searchable by the branch you want OR the folder you remember — after a
    // `git switch` inside the checkout those are different strings.
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
    // `merged` is computed against the main branch and skipped for (detached) — never
    // imply a detached checkout is a safe cleanup.
    if (w.merged && st !== "detached") tags.push(["merged", "merged"]);
    out.push({
      kind: "wt", group: "Worktrees", ic: "⑃", wt: w,
      label: wtLabelOf(w),
      sub: st === "diverged" ? `in ${basename(w.path)}/` : st === "foreign" ? w.path : "",
      dir: w.path, branch: w.branch === "(detached)" ? "" : w.branch,
      tags, meta: "", stale: false,
      verb: !w.exists ? "folder is gone — remove it instead"
        : open ? "start another session in this worktree"
        : "start session in this worktree",
    });
  }

  // Branches you could start a NEW worktree on. The current branch (the repo row) and
  // any already checked out (the worktrees above) are excluded — git refuses either a
  // second time, so offering them would only produce an error.
  const STALE = 45 * 86400, now = Date.now() / 1000;
  for (const b of wtBranches) {
    if (b.current || b.checked_out || !hit(b.name)) continue;
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === wtSlug(b.name));
    out.push({
      kind: "branch", group: "Branches", ic: "⌥", br: b, clash,
      label: b.name, sub: "", dir: wtTargetDir(repoDir, b.name), branch: b.name,
      tags: [], stale: b.unix > 0 && now - b.unix > STALE,
      meta: wtSyncMeta(b) + `<span class="wt-when">${esc(b.rel || "")}</span>`,
      verb: clash ? "blocked — that folder exists" : "create a worktree on this branch & start",
    });
  }

  // Branches that exist on a remote and nowhere here — a colleague's work, or your own
  // from another machine. Last, because they're the least likely destination and the
  // only ones that touch a name the repo doesn't have yet.
  for (const b of wtRemotes) {
    if (!hit(`${b.name} ${b.upstream}`)) continue;
    const clash = wtWts.find((w) => !w.is_main && basename(w.path) === wtSlug(b.name));
    out.push({
      kind: "remote", group: "Remote branches", ic: "⇣", br: b, clash,
      label: b.name, sub: "", dir: wtTargetDir(repoDir, b.name), branch: b.name,
      tags: [], stale: b.unix > 0 && now - b.unix > STALE,
      meta: `<span class="wt-tag rem" title="Only on ${esc(b.upstream)} — no local branch yet">${esc(wtRemoteOf(b))}</span>`
        + `<span class="wt-when">${esc(b.rel || "")}</span>`,
      verb: clash ? "blocked — that folder exists" : `check ${b.upstream} out into a worktree & start`,
    });
  }
  return out;
}

/** The remote a remote-only row came from. `upstream` is exactly `<remote>/<name>`, so
 *  this is a slice rather than a split — the branch name may itself contain slashes. */
function wtRemoteOf(b: BranchInfo) {
  return b.upstream.slice(0, Math.max(0, b.upstream.length - b.name.length - 1));
}

function wtRender() {
  wtRows = wtBuild();
  if (wtSel >= wtRows.length) wtSel = Math.max(0, wtRows.length - 1);
  const cur = wtRows[wtSel];
  if (!cur || cur.kind === "create" || cur.dir !== wtArmed) wtArmed = "";

  let html = "", lastGroup: string | null = null;
  wtRows.forEach((d, i) => {
    if (d.group && d.group !== lastGroup) {
      lastGroup = d.group;
      const n = wtRows.filter((x) => x.group === d.group).length;
      html += `<div class="wt-gh">${d.group}<span class="gc">${n}</span><span class="rule"></span></div>`;
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
  if (wtLoading) {
    html += `<div class="wt-gh">Worktrees<span class="rule"></span></div>`
      + [44, 62, 37].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("")
      + `<div class="wt-gh">Branches<span class="rule"></span></div>`
      + [55, 41].map((w) => `<div class="wt-sk"><i class="a"></i><i style="width:${w}%"></i></div>`).join("");
  } else if (!wtRows.length) {
    html += `<div class="wt-empty"><b>Nothing matches that</b>Clear the filter, or type a branch name to create one</div>`;
  }
  $("wtList").innerHTML = html;
  $("wtCount").textContent = wtLoading ? "" : wtRows.length ? `${wtRows.length} destinations` : "";
  $("wtVerb").textContent = cur ? cur.verb : "—";
  $("wtDetail").innerHTML = wtDetailHtml(cur);
  $("wtList").querySelector(".wt-item.on")?.scrollIntoView({ block: "nearest" });
  void wtPrefetch(cur);
}

// The pane's git facts, fetched for the HIGHLIGHTED row only — a repo can hold
// BRANCH_LIST_CAP branches plus every worktree, and one `git log` per row would cost
// far more than the pane is worth.
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
  // list_worktrees skips `dirty` for the main worktree, so the repo row needs its own.
  if (d.kind === "repo" && !wtDirty.has(repoDir)) {
    jobs.push(invoke<DiffStat | null>("git_diffstat", { workdir: repoDir }).catch(() => null)
      .then((g) => { wtDirty.set(repoDir, g); }));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (gen !== wtGen) return;                    // refreshed under us
  if (wtRows[wtSel] !== d) return;              // selection moved on
  $("wtDetail").innerHTML = wtDetailHtml(d);
}
/** `<dir>\n<rev>` — the argument pair for git_commit_info, newline-joined because
 *  git forbids newlines in ref names and a path may contain spaces. "" when there is
 *  nothing to ask about (an unborn create row has no commit yet). */
function wtCommitKey(d: Dest): string {
  if (!wtCtx) return "";
  if (d.kind === "repo") return `${d.dir}\n`;
  if (d.kind === "wt") return d.wt!.exists ? `${d.dir}\n` : "";
  if (d.kind === "branch") return `${wtCtx.repoDir}\n${d.branch}`;
  // A remote-only row has no local ref to name, so ask about the remote-tracking one.
  if (d.kind === "remote") return `${wtCtx.repoDir}\n${d.br!.upstream}`;
  return "";
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
/** Dim the containing directory, emphasise the leaf — the leaf is the identity. */
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
    const g = wtDirty.get(d.dir);
    const sess = wtSessionsIn(d.dir);
    if (wtArmed === d.dir) return wtSwitchHtml();
    return `<div class="wt-dhead"><span class="wt-dkind">The repo itself</span><span class="wt-dname">${wtPathHtml(d.dir)}</span></div>`
      + wtFacts([
        ["Branch", `<span class="em">${esc(wtRepoBranch || "—")}</span>`],
        ["HEAD", wtCommitHtml(d)],
        ["Working tree", !wtDirty.has(d.dir) ? `<span class="dim">reading…</span>`
          : g && g.dirty > 0 ? `<span class="warn">${g.dirty} file${g.dirty === 1 ? "" : "s"} uncommitted</span>`
          : `<span class="good">clean</span>`],
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
        + `Nothing is left at this path — only git's record of it. Removing prunes that record; there's nothing to launch into.</div>`;
    } else if (st === "diverged") {
      // Deliberately does NOT name the branch this folder was created for: wtSlug is
      // lossy (both "/" and every odd character become "-"), so the folder can't be
      // turned back into a branch name. Name the folder, which is what exists.
      warn = `<div class="wt-warn"><span class="t">Folder and branch disagree</span>`
        + `This checkout lives in <b>${esc(basename(w.path))}/</b>, a folder named after the branch it was created for. `
        + `Its HEAD is now <b>${esc(w.branch)}</b> — something switched inside it. `
        + `Removing it deletes the folder; the branch is a separate decision.</div>`;
    } else if (st === "detached") {
      warn = `<div class="wt-warn"><span class="t">No branch checked out</span>`
        + `HEAD is detached here, so commits made in this checkout belong to no branch — Episko can't tell you whether they're merged, and won't offer to delete anything.</div>`;
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
      ["Working tree", !w.exists ? `<span class="dim">—</span>` : w.dirty ? `<span class="warn">uncommitted changes</span>` : `<span class="good">clean</span>`],
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

  // branch / create — neither has a checkout yet, so both are about the folder that
  // WOULD be made. Showing that path is what catches a collision before git does.
  const clash = d.clash;
  const clashWarn = clash
    ? `<div class="wt-warn err"><span class="t">Folder already taken</span>`
      + `<b>${esc(basename(clash.path))}/</b> exists and has <b>${esc(wtLabelOf(clash))}</b> checked out`
      + `${clash.dirty ? ", with uncommitted changes" : ""}. The folder is derived from the branch name, so this branch has nowhere to go.</div>`
    : "";
  if (d.kind === "branch") {
    const b = d.br!;
    if (wtArmed === d.dir) return wtBranchConfirmHtml(d);
    // No live remote is a fact about the branch, not a reason to avoid it — resuming a
    // branch whose remote was deleted (and pushing a fresh one) is an ordinary thing to
    // want. Say what will happen instead of leaving the red `gone` chip to imply doom.
    const noRemote = (b.gone || !b.upstream) && !clash
      ? `<div class="wt-warn note"><span class="t">No remote branch right now</span>`
        + `${b.gone ? `<b>${esc(b.upstream)}</b> was deleted` : "This branch has never been pushed"} — starting a worktree here is fine. `
        + `The first <b>git push -u</b> from it creates <b>origin/${esc(b.name)}</b> again.</div>`
      : "";
    return `<div class="wt-dhead"><span class="wt-dkind">Branch — no checkout yet</span><span class="wt-dname">${esc(b.name)}</span></div>`
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

  // A remote-only branch. Nothing here can be deleted or switched to — there is no local
  // ref yet — so the pane is entirely about what picking it would bring into existence.
  if (d.kind === "remote") {
    const b = d.br!;
    return `<div class="wt-dhead"><span class="wt-dkind">Remote branch — no local copy</span><span class="wt-dname">${esc(b.upstream)}</span></div>`
      + clashWarn
      + (clash ? "" : `<div class="wt-warn note"><span class="t">Not checked out anywhere yet</span>`
        + `This exists on <b>${esc(wtRemoteOf(b))}</b> and nowhere in this repo. Starting here cuts <b>${esc(b.name)}</b> `
        + `from it and sets it to track <b>${esc(b.upstream)}</b>, so <b>git push</b> and <b>git pull</b> in the new worktree take no arguments.</div>`)
      + wtFacts([
        ["Last commit", wtCommitHtml(d)],
        ["Will track", `<span class="em">${esc(b.upstream)}</span>`],
        ["Local branch", `<span class="em">${esc(b.name)}</span> <span class="dim">— created now</span>`],
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

// Removal, confirmed in the pane rather than a modal on a modal. The checkout and the
// branch are separate losses — `worktree remove` never touches the branch — so they
// get separate sentences and separate buttons.
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
      + `<span class="w"><span class="em">Uncommitted changes</span> live only in this checkout — nothing else has them. `
      + `Episko won't force it; it'll open a terminal in the repo root with the command ready.</span>`
      + `<span class="row"><button class="wt-cbtn" type="button" data-wtact="rm0">Open a terminal there</button>`
      + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const hasBranch = !!w.branch && w.branch !== "(detached)";
  const branchLine = !hasBranch
    ? " It has no branch checked out, so only the folder goes."
    : w.merged
      ? ` Its branch <b>${esc(w.branch)}</b> is merged into ${esc(wtRepoBranch || "the main branch")} — deleting it loses nothing.`
      : ` Its branch <b>${esc(w.branch)}</b> has commits ${esc(wtRepoBranch || "the main branch")} doesn't, so it's kept.`;
  return `<div class="wt-danger"><span class="q">Remove ${folder}?</span>`
    + `<span class="w">The checkout is clean.${branchLine}</span>`
    + `<span class="row">`
    + (hasBranch && w.merged ? `<button class="wt-cbtn danger" type="button" data-wtact="rm1">Remove + delete branch</button>` : "")
    + `<button class="wt-cbtn" type="button" data-wtact="rm0">Remove${hasBranch ? ", keep branch" : ""}</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

// Deleting a local branch, the counterpart to removing a worktree. The copy has to
// carry one non-obvious fact: a `gone` upstream usually means the PR merged, but if it
// was SQUASH-merged the commits never became ancestors of HEAD, so git's safe delete
// refuses anyway. Say that before the click, not after it fails.
function wtBranchConfirmHtml(d: Dest): string {
  const b = d.br!;
  const name = `<b>${esc(b.name)}</b>`;
  let why: string;
  if (b.gone) {
    why = `<b>${esc(b.upstream)}</b> was deleted on the remote, so this branch is local-only now — often after its pull request merged, `
      + `but not always. If you still want the work, cancel and start a worktree on it instead; a push from there recreates the remote branch.`;
  } else if (!b.upstream) {
    why = `<span class="em">It has never been pushed.</span> Its commits exist here and nowhere else — once it's gone, they're only reachable by sha.`;
  } else if (b.ahead) {
    why = `<span class="em">${b.ahead} commit${b.ahead === 1 ? "" : "s"} are not on <b>${esc(b.upstream)}</b></span> — deleting the branch leaves them only reachable by sha. The remote branch itself stays.`;
  } else {
    why = `It's in sync with <b>${esc(b.upstream)}</b>, which is not touched — the remote branch stays and this can be re-fetched.`;
  }
  return `<div class="wt-danger"><span class="q">Delete ${name}?</span>`
    + `<span class="w">${why}</span>`
    + `<span class="w">Episko only runs the safe <b>git branch -d</b>, so git refuses anything it can't see as merged`
    + `${b.gone ? " — which includes a squash-merged branch" : ""}. If it does, you get a terminal with <b>-D</b> ready.</span>`
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

// The start-point for a NEW branch. Defaults to the repo's HEAD, which is what git
// does — but silently, and that silence is the problem: a root parked on a feature
// branch makes every new worktree a child of it. Naming the parent (and letting it be
// changed) is cheaper and far safer than switching the root just to branch elsewhere.
function wtBaseSelect(): string {
  const head = wtRepoBranch || "HEAD";
  return wtPickBtn("base", wtBase || head) + (wtBase ? "" : ` <span class="dim">the repo's current branch</span>`);
}
/** Options for the base chooser: the repo's HEAD first, then every other local branch. */
function wtBaseOptions(): BranchPick[] {
  const head = wtRepoBranch || "HEAD";
  return [{ name: head, note: "the repo's current branch" }]
    .concat(wtBranches.filter((b) => !b.current).map((b) => ({ name: b.name, note: b.rel || "" })));
}

// Move the root folder itself to another branch. Episko's answer to "work on another
// branch" is normally a worktree, and this stays deliberately secondary — but the root's
// branch is the default parent of every new worktree, so a root parked somewhere stale
// needed an escape that wasn't "drop to a shell".
function wtSwitchHtml(): string {
  if (!wtCtx) return "";
  const running = wtSessionsIn(wtCtx.repoDir).length;
  const pick = wtSwitchable();
  if (running) {
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w"><span class="em">${running} session${running === 1 ? " is" : "s are"} running here.</span> `
      + `Switching would move the ground under ${running === 1 ? "it" : "them"} mid-edit, so Episko won't. Close ${running === 1 ? "it" : "them"} first.</span>`
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  if (!pick.length) {
    return `<div class="wt-danger"><span class="q">Switch this folder's branch?</span>`
      + `<span class="w">Every other branch is already checked out in a worktree, so there is nothing to switch to.</span>`
      + `<span class="row"><button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
  }
  const sel = wtSwitchTo || pick[0].name;
  return `<div class="wt-danger"><span class="q">Switch <b>${esc(basename(wtCtx.repoDir))}</b> to another branch?</span>`
    + `<span class="w">The repo's own folder moves — every worktree keeps its own branch, untouched. `
    + `This also changes what new worktrees branch from by default.</span>`
    + `<span class="row">${wtPickBtn("switch", sel)}</span>`
    + `<span class="w">Episko only switches a <b>clean</b> tree: git would carry uncommitted changes across to the new branch, `
    + `which is a change it never announced. If yours is dirty you get a terminal instead.</span>`
    + `<span class="row"><button class="wt-cbtn danger" type="button" data-wtact="doswitch">Switch branch</button>`
    + `<button class="wt-cbtn ghost" type="button" data-wtact="cancel">Cancel</button></span></div>`;
}

/** Branches the root can actually move to: not current, not held by a worktree. */
function wtSwitchOptions(): BranchPick[] {
  // git allows exactly one checkout per branch, so anything a worktree holds — or the
  // root already has — can't be switched to. List them anyway, disabled and explained:
  // silently omitting them is what made `dev` look like it had gone missing.
  const held = new Map<string, string>();
  for (const w of wtWts) if (!w.is_main && w.branch) held.set(w.branch, basename(w.path));
  return wtBranches.map((b) => b.current
    ? { name: b.name, note: "already checked out here", disabled: true }
    : held.has(b.name)
      ? { name: b.name, note: `checked out in ${held.get(b.name)}/`, disabled: true }
      : { name: b.name, note: b.rel || "" });
}
const wtSwitchable = () => wtSwitchOptions().filter((o) => !o.disabled);
async function wtDoSwitch() {
  if (!wtCtx || wtBusy) return;
  const { project, repoDir } = wtCtx;
  const branch = wtSwitchTo || wtSwitchable()[0]?.name;
  if (!branch) return;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("switch_branch", { repoDir, branch });
    dlog(r.ok ? "info" : "warn", `switch · ${basename(repoDir)} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = ""; wtSwitchTo = ""; wtRepoBranch = branch;
    await wtLoad(true);
  } catch (e) {
    dlog("error", `switch failed: ${e}`);
    toast("switch: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// ---------- branch chooser ----------
// A picker for the two places the dialog needs one: the new-worktree base, and the
// root-switch target. Built from the .menupop/.mp-item idiom the engine, caffeinate,
// shortcuts, usage and colour menus already share, so it reads as part of the app
// rather than as the one piece of system chrome on a fully custom surface.
//
// It lives at body level (#bPop) because .wtdlg is overflow:hidden — anchored inside,
// it would be clipped. Typing filters, because a repo can hold BRANCH_LIST_CAP refs
// and "scroll until you see it" is not a choice.
interface BranchPick {
  name: string;
  note: string;
  /** Shown, but not choosable — with `note` carrying the reason. A branch that simply
   *  vanishes from the list reads as a bug: you go looking for `dev`, it isn't there,
   *  and nothing tells you it's held by a worktree. */
  disabled?: boolean;
}
let bPopItems: BranchPick[] = [];
let bPopSel = 0;
let bPopOn: ((name: string) => void) | null = null;
let bPopAnchor: HTMLElement | null = null;

function bPopOpen() { return $("bPop").classList.contains("show"); }
function openBranchPop(anchor: HTMLElement, items: BranchPick[], current: string, onPick: (name: string) => void) {
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
        + `<span class="mp-ic">${i.disabled ? "⊘" : "⌥"}</span><span class="mp-main"><span class="mp-l">${esc(i.name)}</span>`
        + (i.note ? `<span class="mp-s">${esc(i.note)}</span>` : "")
        + `</span><span class="mp-check">✓</span></button>`).join("")
    : `<div class="bp-none">No branch matches that.</div>`;
  $("bPopList").querySelector(".mp-item.on")?.scrollIntoView({ block: "nearest" });
}
function bPopShown(): BranchPick[] {
  const q = (($("bPopQ") as HTMLInputElement)?.value || "").trim().toLowerCase();
  return bPopItems.filter((i) => !q || i.name.toLowerCase().includes(q));
}
/** Next choosable row in `dir`, or stay put if there is none — so arrow keys step over
 *  the disabled entries instead of parking on something Enter can't take. */
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

/** The trigger: reads as a field holding a value, not as a button. */
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
    if (!w.exists) { toast(`${basename(w.path)} is gone — remove it instead`); return; }
    closeWt();
    // Always a NEW session: a second agent on one branch is a normal thing to want.
    // The session chips in the pane are what jump to a running one.
    launch(project, w.path, { colorKey: repoDir, worktree: wtLabelOf(w), branch: d.branch });
    return;
  }
  if (d.clash) { toast(`${basename(d.clash.path)}/ already exists`); return; }
  // A remote-only row starts from its remote ref, which is also what makes the new
  // branch track it — `create_worktree` reads that off the start-point.
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

// The backend never forces: a dirty tree is refused and its --force command handed to
// a terminal, so nothing uncommitted is ever clobbered by a click here.
async function wtDoRemove(deleteBranch: boolean) {
  const d = wtRows[wtSel];
  if (!d || d.kind !== "wt" || !wtCtx || wtBusy) return;
  const w = d.wt!, { project, repoDir } = wtCtx;
  wtBusy = true;
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path: w.path, branch: w.branch, deleteBranch });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${w.branch || w.path} · ${r.summary}`);
    toast(r.ok ? r.summary : `${r.summary} → opening a terminal`);
    if (!r.ok && r.suggest) {
      // The handoff must run from the repo root, never the worktree being deleted —
      // git refuses to remove the tree you're standing in.
      closeWt();
      await handToTerminal(project, repoDir, r.suggest, { colorKey: repoDir });
      return;
    }
    wtArmed = "";
    await wtLoad(true);
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  } finally { wtBusy = false; renderAll(); }
}

// The action-panel "Remove this worktree" flow: guard uncommitted work, then close
// the session and remove its worktree (safe-deleting the branch if it's merged).
export async function removeWorktreeSession(s: Sess) {
  const repoDir = s.colorKey, path = s.workdir, branch = s.branch;
  // Never close a session that still has a dirty tree — hand the decision (and a
  // shell) over instead. git_diffstat is null for a non-repo; treat that as "clean
  // enough to try", since the backend still refuses (without forcing) if it's wrong.
  const ds = await invoke<DiffStat | null>("git_diffstat", { workdir: path }).catch(() => null);
  if (ds && ds.dirty > 0) {
    toast(`${branch || "worktree"}: uncommitted changes — commit or discard first`);
    await handToTerminal(s.project, path, "git status", { colorKey: repoDir, worktree: s.worktree, branch });
    return;
  }
  if (!await ask(`Remove the worktree at ${basename(path)}/?\n\nIts session closes, the folder goes, and its branch is deleted only if it's fully merged.`,
    { title: "Remove worktree", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" })) return;
  closeSession(s.id);
  await invoke("kill_session", { sessionId: s.id }).catch(() => {}); // ensure the backend guard sees it gone
  try {
    const r = await invoke<GitActionResult>("remove_worktree", { repoDir, path, branch, deleteBranch: true });
    dlog(r.ok ? "info" : "warn", `worktree remove · ${branch || path} · ${r.summary}`);
    if (r.ok) toast(r.summary);
    else if (r.suggest) { toast(`${r.summary} → opening a terminal`); await handToTerminal(s.project, repoDir, r.suggest, { colorKey: repoDir }); }
    else toast(r.summary);
  } catch (e) {
    dlog("error", `worktree remove failed: ${e}`);
    toast("worktree: " + e);
  }
  renderAll();
}

// ---------- the dialog's own event wiring ----------
// The dialog handles its own clicks and keys: rows are addressed by index into
// wtRows, so nothing leaks into the global [data-*] dispatcher.
$("wtRefresh").addEventListener("click", () => { void wtReadLocal(true).then(() => wtMaybeFetch(true)); });
// Coming back to the window is the moment the list is most likely to be wrong: you were
// just in a terminal, or someone else pushed. Re-read locally and fetch (throttled).
// Skipped while the branch chooser is open — re-rendering would swap the element its
// popover is anchored to out from under a choice in progress.
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
    if (pick.dataset.wtpick === "base") {
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
  if (row) { wtSel = +row.dataset.wti!; wtArmed = ""; wtRender(); ($("wtQ") as HTMLInputElement).focus(); }
});
// Double-click a row to go, so the mouse path doesn't require crossing to the pane's
// button. The first click of the pair already selected it, so this just runs it.
$("wtList").addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-wti]");
  if (row) { e.preventDefault(); wtRun(wtRows[+row.dataset.wti!]); }
});
