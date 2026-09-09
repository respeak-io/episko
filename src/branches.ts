// Branches: where each one lives, what is worth deleting, what blocks it, and where a
// checkout can move to (docs/worktrees.md). Evidence is `gone`, `merged` or a merged PR;
// only the last ever justifies a force, since a squash-merged branch is contained in
// nothing and `-d` refuses it.

import { basename } from "./format";

// As `git_branch_list` answers (the Rust `BranchInfo` is the contract). `ahead`/`behind` are
// versus what the branch FOLLOWS; `t_ahead`/`t_behind` are versus the trunk on every row kind.
export interface BranchInfo {
  name: string;
  current: boolean;
  checked_out: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  gone: boolean;
  merged: boolean;
  remote: boolean;
  base: string; // what merged/t_ahead/t_behind were measured against; empty = unmeasured
  author: string;
  sha: string;
  rel: string;
  unix: number;
  remote_ref: string; // the remote-tracking ref it HAS, tracked or not; empty when there is none
  remote_sha: string; // that ref's own tip, which is not the branch's on a local row
  t_ahead: number;
  t_behind: number;
  is_default: boolean; // the remote's own default branch, whatever the trunk is set to
}

export interface WtInfo {
  path: string;
  branch: string;
  is_main: boolean;
  dirty: boolean;
  merged: boolean;
  locked: boolean;
  exists: boolean;
}

export interface MergedPr {
  number: number;
  branch: string;
  title: string;
  url: string;
  merged_at: string;
}
// `available: false` ("gh isn't logged in") must never look like an empty list ("nothing merged").
export interface MergedPrs {
  available: boolean;
  reason: string | null;
  prs: MergedPr[];
}

// ---------- what the backend is asked ----------

// `gone` is re-derived by `sweep_branches`; `force` is evidence nothing local can check.
export type SweepPick = { branch: string; gone: boolean; force: boolean };
// With the sha the ref was showing: the backend refuses a ref that has moved since the last fetch.
export type RemotePick = { branch: string; sha: string };
export type DeletedBranch = { branch: string; sha: string; forced: boolean };
export type KeptBranch = { branch: string; reason: string; forceable: boolean };
export type SweepResult = {
  deleted: DeletedBranch[];
  kept: KeptBranch[];
  suggest: string | null;
  summary: string;
};

// ---------- the rules ----------

// A branch is one row wherever it lives: the two places it can be are a property of it, not
// a reason for a second table. Each half carries its own permission and its own refusal, and
// `block` is empty when the half does not exist at all — the Where cell has already said so.
export interface Scope {
  ok: boolean;
  block: string;
}
export interface BranchRow {
  br: BranchInfo;
  name: string;
  hasLocal: boolean;
  hasRemote: boolean;
  remoteRef: string;
  wt?: WtInfo;
  pr?: MergedPr;
  why: string; // the evidence in words; "" when there is none
  local: Scope & { force: boolean };
  remote: Scope;
}

export interface CleanCtx {
  branches: BranchInfo[];
  worktrees: WtInfo[];
  prs: MergedPr[];
  liveIn: (path: string) => number;
  externalIn: (path: string) => boolean; // a session Episko can't see is in the checkout
}

const prIndex = (prs: MergedPr[]) => {
  const m = new Map<string, MergedPr>();
  for (const p of prs) if (!m.has(p.branch)) m.set(p.branch, p);
  return m;
};

export function branchRows(ctx: CleanCtx): BranchRow[] {
  const prBy = prIndex(ctx.prs);
  const trunk = trunkOf(ctx.branches);
  return ctx.branches.map((br) => {
    const pr = prBy.get(br.name);
    const wt = ctx.worktrees.find((w) => !w.is_main && w.branch === br.name);
    // Most specific first; `merged` is weakest: it can also mean the branch never had a commit of its own.
    const why = pr ? `#${pr.number} merged`
      : br.gone ? "remote branch deleted"
      : br.merged ? `merged into ${br.base || "the trunk"}`
      : "";
    // `gone` names a ref the remote no longer has, so it is not somewhere the branch lives.
    const remoteRef = br.gone ? "" : br.remote_ref;
    return {
      br,
      name: br.name,
      hasLocal: !br.remote,
      hasRemote: !!remoteRef,
      remoteRef,
      wt,
      pr,
      why,
      local: localScope(br, wt, pr, why, br.is_default || remoteRef === trunk, ctx),
      remote: remoteScope(br, remoteRef, pr, trunk),
    };
  });
}

// The current branch is never a candidate: git refuses to delete it. A checkout blocks the
// row rather than hiding it: the reason is how you learn why it isn't offered.
function localScope(
  br: BranchInfo, wt: WtInfo | undefined, pr: MergedPr | undefined, why: string,
  isTrunk: boolean, ctx: CleanCtx,
): Scope & { force: boolean } {
  const no = (block: string) => ({ ok: false, block, force: false });
  if (br.remote) return no("");
  if (br.current) return no("the branch you are on");
  // Two branches are never on offer whatever the evidence says: the trunk in force, and the
  // remote's own default. The second is the one that bites — the trunk is overridable, so a
  // repo comparing against `origin/dev` finds `main` "merged into origin/dev" and would
  // otherwise offer it, which is exactly the branch nobody ever means to delete.
  if (isTrunk) return no("the repository's default branch");
  if (!why) return no("nothing says it has landed");
  const live = wt ? ctx.liveIn(wt.path) : 0;
  const block = !wt ? ""
    : live ? `${live} session${live === 1 ? "" : "s"} open in its worktree`
    : ctx.externalIn(wt.path) ? "a session outside Episko is running there"
    : wt.dirty ? "its worktree has uncommitted changes"
    : wt.locked ? "its worktree is locked"
    : "";
  // Only a merged PR justifies a force, and only where `-d` will refuse (a merged branch needs
  // none). `gone` alone never does: an unmerged branch whose remote was deleted is unpushed work.
  return { ok: !block, block, force: !!pr && !br.merged };
}

// Narrower than the local rule, since `git push --delete` changes what everyone sees: only a
// branch contained in the trunk, or whose PR merged, is ever offered.
function remoteScope(
  br: BranchInfo, remoteRef: string, pr: MergedPr | undefined, trunk: string,
): Scope {
  if (!remoteRef) return { ok: false, block: "" };
  if (br.is_default || remoteRef === trunk) return { ok: false, block: "the repository's default branch" };
  // No base means the comparison could not be made at all; not knowing is a reason to refuse.
  if (!br.base) return { ok: false, block: `no comparison against ${remoteOf(br) || "the remote"}'s default branch` };
  // A local row's evidence is about ITS tip. It carries to the remote ref only while the two
  // are the same commit; anything else is one fetch away from being knowable, and until then
  // this half is a claim about a commit nobody here has looked at.
  if (!br.remote && br.sha !== br.remote_sha) {
    return { ok: false, block: `${remoteRef} is on another commit — fetch first` };
  }
  if (br.merged || pr) return { ok: true, block: "" };
  return { ok: false, block: `${br.t_ahead} commit${br.t_ahead === 1 ? "" : "s"} not in ${br.base}` };
}

// `remote_ref` is exactly `<remote>/<name>`, so slice rather than split: the name may contain slashes.
export function remoteOf(b: BranchInfo): string {
  const ref = b.remote_ref || b.upstream;
  return ref.slice(0, Math.max(0, ref.length - b.name.length - 1));
}

// The remote a cleanup pushes to. Read off a row that is actually offered, whose `base` is the
// primary remote's, so a mixed-remote list cannot misroute.
export function remoteFor(rows: BranchRow[]): string {
  const r = rows.find((x) => x.remote.ok) ?? rows.find((x) => x.hasRemote);
  return (r && remoteOf(r.br)) || "origin";
}

// Read off the rows, not the setting, so an override that no longer resolves shows git's real answer.
export function trunkOf(branches: BranchInfo[]): string {
  return branches.find((b) => b.base)?.base ?? "";
}

export function trunkOptions(branches: BranchInfo[]): { name: string; note: string }[] {
  const seen = new Set<string>();
  const out = [{ name: "", note: "automatic: whatever the remote's default is" }];
  // The trunk in force first: usually `origin/main`, which no upstream need name. Then remote
  // refs, then locals, which drift the moment you stop pulling them.
  const now = trunkOf(branches);
  if (now) { seen.add(now); out.push({ name: now, note: "in use now" }); }
  for (const b of branches) {
    if (b.upstream && !seen.has(b.upstream)) { seen.add(b.upstream); out.push({ name: b.upstream, note: b.rel || "" }); }
  }
  for (const b of branches) {
    if (!b.remote && !seen.has(b.name)) {
      seen.add(b.name);
      out.push({ name: b.name, note: `local${b.current ? " · checked out here" : ""}` });
    }
  }
  return out;
}

// ---------- selection ----------

// A row is tickable if EITHER half can go. The scope toggles then decide where a delete
// lands; they never decide what may be ticked, or opening the view on a repo whose branches
// all live on the remote would make every row inert until you found the right switch.
export const anyDeletable = (r: BranchRow) => r.local.ok || r.remote.ok;

export function selectable(rows: BranchRow[]): Set<string> {
  return new Set(rows.filter(anyDeletable).map((r) => r.name));
}

const picked = (rows: BranchRow[], on: ReadonlySet<string>) => rows.filter((r) => on.has(r.name));

// Rows the scopes cannot act on are filtered here regardless, so no caller can pass one
// through by forgetting.
export function localPicks(rows: BranchRow[], on: ReadonlySet<string>): SweepPick[] {
  return picked(rows, on).filter((r) => r.local.ok)
    .map((r) => ({ branch: r.name, gone: r.br.gone, force: r.local.force }));
}
export function remotePicks(rows: BranchRow[], on: ReadonlySet<string>): RemotePick[] {
  return picked(rows, on).filter((r) => r.remote.ok)
    .map((r) => ({ branch: r.name, sha: r.br.remote_sha || r.br.sha }));
}
// git refuses to delete a branch any worktree holds, so these go first.
export function chosenWorktrees(rows: BranchRow[], on: ReadonlySet<string>): WtInfo[] {
  return picked(rows, on).filter((r) => r.local.ok).flatMap((r) => (r.wt ? [r.wt] : []));
}

// Shift-click: everything between the last tick and this one, in the order on screen.
export function rangePick(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from), b = order.indexOf(to);
  if (b < 0) return [];
  if (a < 0) return [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

// Offered first, then evidenced-but-blocked (their reason answers "why isn't this offered?"),
// then everything else, each band keeping git's most-recent-first order. The bands are facts
// about the branch rather than about the toggles, so arming a scope never makes the table jump.
export function orderRows(rows: BranchRow[]): BranchRow[] {
  const band = (r: BranchRow) => (anyDeletable(r) ? 0 : r.why ? 1 : 2);
  return [...rows].sort((a, b) => band(a) - band(b));
}

// ---------- the filter chips, which are also the quick-selects ----------
// They narrow the table, and `All` ticks what is left, so "select everything merged" is two
// clicks and needs no second mechanism.

export type BranchFilter = "all" | "merged" | "gone" | "stale" | "localonly" | "checkout";
export const BRANCH_FILTERS: { id: BranchFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "merged", label: "Merged" },
  { id: "gone", label: "Gone" },
  { id: "stale", label: "Stale" },
  { id: "localonly", label: "Local only" },
  { id: "checkout", label: "Checked out" },
];
export const STALE_DAYS = 30;

const MATCH: Record<BranchFilter, (r: BranchRow, now: number) => boolean> = {
  all: () => true,
  merged: (r) => !!r.pr || r.br.merged,
  gone: (r) => r.br.gone,
  stale: (r, now) => !!r.br.unix && now - r.br.unix * 1000 > STALE_DAYS * 864e5,
  localonly: (r) => r.hasLocal && !r.hasRemote,
  checkout: (r) => !!r.wt || r.br.current,
};

export function filterRows(rows: BranchRow[], f: BranchFilter, q: string, now: number): BranchRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => MATCH[f](r, now) && (!needle || r.name.toLowerCase().includes(needle)));
}

// Counted over every row, never over the filtered set: a chip that reads 0 because another
// chip is on says nothing about the repo.
export function filterCounts(rows: BranchRow[], now: number): Record<BranchFilter, number> {
  const out = {} as Record<BranchFilter, number>;
  for (const { id } of BRANCH_FILTERS) out[id] = rows.filter((r) => MATCH[id](r, now)).length;
  return out;
}

// ---------- what a row says ----------

// Where the branch lives, which is the whole reason there is one row and not two.
export function whereText(r: BranchRow): string {
  const rem = remoteOf(r.br) || "the remote";
  if (r.hasLocal && r.hasRemote) return `local · ${rem}`;
  if (r.hasRemote) return rem;
  return r.br.gone ? "local · remote deleted" : "local";
}

// Versus the trunk, on every row kind, so the column means one thing. The trunk is not named:
// the view names it once, in the chip that changes it.
export function trunkText(b: BranchInfo): string {
  if (!b.base) return "not compared";
  if (!b.t_ahead && !b.t_behind) return "even";
  // ↑ahead ↓behind, the vocabulary the repo card and the inspector already use, because two
  // spelled-out numbers do not fit a column beside everything else the row has to carry.
  return [b.t_ahead ? `↑${b.t_ahead}` : "", b.t_behind ? `↓${b.t_behind}` : ""]
    .filter(Boolean).join(" ");
}

// The other question a row can answer, and a different one: where the local ref stands
// against the ref it follows. The tooltip's, not a column's.
export function syncText(b: BranchInfo): string {
  if (b.remote) return "no local branch here";
  if (b.gone) return "its remote branch was deleted";
  if (!b.upstream) return b.remote_ref ? `not tracking ${b.remote_ref}` : "never pushed";
  if (b.ahead || b.behind) {
    return [b.ahead ? `${b.ahead} unpushed` : "", b.behind ? `${b.behind} unpulled` : ""]
      .filter(Boolean).join(" · ");
  }
  return `in sync with ${b.upstream}`;
}

// ---------- the checkouts half ----------
// The same table shape keyed by folder rather than by branch, for the rows a branch cannot
// carry: a detached HEAD, and a checkout whose folder disk has lost but git still records.

export interface CheckoutRow {
  wt: WtInfo;
  label: string;  // the folder name, which is what the rail and the ⑃ dialog call it
  live: number;
  gone: boolean;  // not on disk: removal only clears git's record, and nothing is lost
  ok: boolean;
  block: string;
  note: string;   // what removal would do here, or what state the folder is in
}

export interface CheckoutCtx {
  worktrees: WtInfo[];
  liveIn: (path: string) => number;
  externalIn: (path: string) => boolean;
}

export function checkoutRows(ctx: CheckoutCtx): CheckoutRow[] {
  return ctx.worktrees.map((wt) => {
    const live = ctx.liveIn(wt.path);
    const gone = !wt.exists;
    // `remove_worktree` refuses a session outright, so the row must refuse it first; the
    // dirty and locked walls are the ⑃ dialog's, kept word for word.
    const block = wt.is_main ? "the project's own folder"
      : live ? `${live} session${live === 1 ? "" : "s"} open here`
      : ctx.externalIn(wt.path) ? "a session outside Episko is running there"
      : gone ? ""
      : wt.dirty ? "uncommitted changes"
      : wt.locked ? "locked"
      : "";
    const note = wt.is_main ? "every other checkout branches from it"
      : gone ? "folder is gone — removing only clears git's record"
      : wt.merged ? "merged; its branch goes with it"
      : "not merged, so its branch is kept";
    return { wt, label: basename(wt.path), live, gone, ok: !block, block, note };
  });
}

export const removableCheckouts = (rows: CheckoutRow[]) =>
  new Set(rows.filter((r) => r.ok).map((r) => r.wt.path));

export function chosenCheckouts(rows: CheckoutRow[], on: ReadonlySet<string>): CheckoutRow[] {
  return rows.filter((r) => r.ok && on.has(r.wt.path));
}

// ---------- switching a checkout ----------

export interface BranchPick {
  name: string;
  note: string;
  disabled?: boolean; // shown but not choosable, with `note` saying why: a row that vanishes reads as a bug
  ic?: string;        // row glyph override; only the remote-only rows set it (⇣)
  base?: string;      // remote-tracking ref to cut from when there is no local ref (see switch_branch)
}

const samePath = (a: string, b: string) =>
  a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Where the checkout at `here` can move to, plus the remote-only branches a switch cuts a
 *  local ref from. One checkout per branch, so anything another worktree holds is listed
 *  disabled with the reason: omitting it silently made `dev` look like it had gone missing. */
export function switchOptions(branches: BranchInfo[], worktrees: WtInfo[], here: string): BranchPick[] {
  const held = new Map<string, string>();
  for (const w of worktrees) if (!samePath(w.path, here) && w.branch) held.set(w.branch, basename(w.path));
  const local = branches.filter((b) => !b.remote).map((b) => b.current
    ? { name: b.name, note: "already checked out here", disabled: true }
    : held.has(b.name)
      ? { name: b.name, note: `checked out in ${held.get(b.name)}/`, disabled: true }
      : { name: b.name, note: b.rel || "" });
  // Remote-only rows have no local ref, so none is held; `base` makes the cut ref track its
  // origin. Last and marked: the only options that add a name to the repo.
  const remote = branches.filter((b) => b.remote).map((b) => ({
    name: b.name, ic: "⇣", base: b.upstream,
    note: `only on ${remoteOf(b)}; creates a local branch tracking it`,
  }));
  return [...local, ...remote];
}

export const switchable = (opts: BranchPick[]) => opts.filter((o) => !o.disabled);

/** What a switch would interrupt here, in words, or "" when nothing would be. Having a session
 *  open is not enough: only work in flight blocks, and it says which kind. */
export function midFlightText(agents: number, tasks: number, external: number): string {
  const what: string[] = [];
  if (agents) what.push(`${agents} agent${agents === 1 ? " is" : "s are"} mid-turn`);
  if (tasks) what.push(`${tasks} task${tasks === 1 ? " is" : "s are"} still running`);
  if (external) what.push(`${external} session${external === 1 ? " is" : "s are"} working outside Episko`);
  return what.join(", ");
}
