// Branch cleanup: which branches are worth deleting, what stops each one, and what the
// backend should be asked to do about it.
//
// Pure and testable, and deliberately so — this is the module that decides to delete
// things. It was born inside the ⑃ dialog's detail pane, where it could only ever be
// verified by opening the dialog and looking; the rules are the same, the surface is now
// the dashboard's full-screen Branches view, and nothing in here knows about either.
//
// Three sources of evidence, and they overlap freely (a branch is usually `gone` *because*
// its pull request merged):
//
//   gone   — its upstream was deleted on the remote.
//   merged — every commit is already in the trunk.
//   pr     — GitHub says its pull request merged.
//
// The third earns its network call on its own: a **squash**-merged branch is contained in
// nothing, so `git branch -d` refuses it forever and no local read can tell it apart from
// work that never shipped. That is the only case where a force is ever offered, and only
// per branch.

/// One local branch or remote-tracking ref, as `git_branch_list` answers. See the Rust
/// `BranchInfo` for the full contract — in particular that a remote row reads one level
/// over (`name` is the local branch a checkout would create) and that its `ahead`/`behind`
/// are versus the trunk, where a local row's are versus its own `upstream`.
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
  /// What `merged` (and, for a remote row, ahead/behind) was measured against. Empty
  /// means it could not be measured — which is a reason to offer nothing, never a
  /// reason to read the zeros as "in sync".
  base: string;
  author: string;
  sha: string;
  rel: string;
  unix: number;
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
/// `available: false` is not the same answer as an empty list, and the difference is the
/// whole point: "no PR ever merged from these branches" invites deleting nothing, while
/// "gh isn't logged in" must not be allowed to look like that.
export interface MergedPrs {
  available: boolean;
  reason: string | null;
  prs: MergedPr[];
}

// ---------- what the backend is asked ----------

/// Two claims travel with a local branch, and only one of them is checkable there.
/// `gone` is about the world, so `sweep_branches` re-derives it. `force` is about
/// *evidence*, which nothing local can check — see the module header.
export type SweepPick = { branch: string; gone: boolean; force: boolean };
/// A remote branch with the sha its row was showing: `git push --delete` is public, and
/// the list it was chosen from is only as fresh as the last fetch, so the backend refuses
/// a ref that has moved since.
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

/// One branch on offer, with the reason it is on offer. `block` is the counter-fact:
/// non-empty means the row is shown but not choosable, because a bulk button must never
/// be the thing that kills a running agent or drops uncommitted work.
export interface CleanCand {
  br: BranchInfo;
  /// The checkout holding it, which a cleanup would have to remove first.
  wt?: WtInfo;
  why: string;
  pr?: MergedPr;
  /// A `-D` is justified if the safe delete refuses. Only ever true with PR evidence.
  force: boolean;
  block: string;
}

/// What the caller knows about the world that this module can't read for itself.
export interface CleanCtx {
  branches: BranchInfo[];
  worktrees: WtInfo[];
  prs: MergedPr[];
  /// How many Episko sessions are running in a checkout.
  liveIn: (path: string) => number;
  /// Whether a session Episko can't see (someone else's terminal) is in a checkout.
  externalIn: (path: string) => boolean;
}

const prIndex = (prs: MergedPr[]) => {
  const m = new Map<string, MergedPr>();
  for (const p of prs) if (!m.has(p.branch)) m.set(p.branch, p);
  return m;
};

/// Local branches worth deleting. The repo's own HEAD is never a candidate — git refuses
/// to delete the branch you are on, and offering it would only produce an error.
export function localCands(ctx: CleanCtx): CleanCand[] {
  const prBy = prIndex(ctx.prs);
  const out: CleanCand[] = [];
  for (const b of ctx.branches) {
    if (b.remote || b.current) continue;
    const pr = prBy.get(b.name);
    if (!b.gone && !b.merged && !pr) continue;
    // Most specific evidence first: a merged PR says what happened, `gone` says only that
    // something happened, and `merged` is the weakest — "contained in the trunk" can also
    // mean the branch never had a commit of its own.
    const why = pr ? `#${pr.number} merged`
      : b.gone ? "remote branch deleted"
      : `merged into ${b.base || "the trunk"}`;
    const wt = ctx.worktrees.find((w) => !w.is_main && w.branch === b.name);
    // A checkout is a reason to be careful, not a reason to hide the row: seeing "3
    // sessions open here" is how you learn why the branch you expected isn't offered.
    const live = wt ? ctx.liveIn(wt.path) : 0;
    const block = !wt ? ""
      : live ? `${live} session${live === 1 ? "" : "s"} open in its worktree`
      : ctx.externalIn(wt.path) ? "a session outside Episko is running there"
      : wt.dirty ? "its worktree has uncommitted changes"
      : wt.locked ? "its worktree is locked"
      : "";
    // Only a merged pull request justifies a force, and only where the safe delete will
    // actually refuse: a merged branch needs none, and claiming one on its row would
    // inflate the warning into something nobody reads. `gone` alone never justifies it —
    // an unmerged branch whose remote someone deleted is unpushed work, and `-d` refusing
    // it is the system working.
    out.push({ br: b, wt, why, pr, force: !!pr && !b.merged, block });
  }
  return out;
}

/// Remote branches worth deleting — a narrower rule than the local one, because
/// `git push --delete` changes what everyone else sees. **Only a branch already contained
/// in the trunk, or whose pull request merged, is ever offered.** After a remote delete no
/// machine in the world necessarily still has an unmerged branch's commits.
export function remoteCands(branches: BranchInfo[], prs: MergedPr[]): CleanCand[] {
  const prBy = prIndex(prs);
  return branches.filter((b) => b.remote).map((b) => {
    const pr = prBy.get(b.name);
    const why = pr ? `#${pr.number} merged` : b.merged ? `contained in ${b.base}` : "";
    // No base means the comparison could not be made at all (a second remote, no default
    // ref, a git too old for `%(ahead-behind:)`). Not knowing is a reason to refuse.
    const block = !b.base ? `no comparison against ${remoteOf(b)}'s default branch`
      : b.merged || pr ? ""
      : `${b.ahead} commit${b.ahead === 1 ? "" : "s"} not in ${b.base}`;
    return { br: b, why, pr, force: false, block };
  });
}

/// The remote a remote-only row came from. `upstream` is exactly `<remote>/<name>`, so
/// this is a slice rather than a split — the branch name may itself contain slashes.
export function remoteOf(b: BranchInfo): string {
  return b.upstream.slice(0, Math.max(0, b.upstream.length - b.name.length - 1));
}

/// The remote a cleanup would push deletions to. Rows are only ever offered when they
/// carry a `base`, which is by construction the primary remote's — so a mixed-remote list
/// can never send a branch to the wrong place.
export function remoteFor(cands: CleanCand[]): string {
  const c = cands.find((x) => !x.block) ?? cands[0];
  return c ? remoteOf(c.br) : "origin";
}

/// What every branch was measured against — read off the rows rather than from what was
/// asked for, so a stored override that no longer resolves shows git's real answer.
export function trunkOf(branches: BranchInfo[]): string {
  return branches.find((b) => b.base)?.base ?? "";
}

/// What the trunk can be set to. Remote refs first — a trunk is nearly always
/// `origin/<something>`, and a local one drifts the moment you stop pulling it.
export function trunkOptions(branches: BranchInfo[]): { name: string; note: string }[] {
  const seen = new Set<string>();
  const out = [{ name: "", note: "automatic — whatever the remote's default is" }];
  // The trunk in force, first and always: it is usually `origin/main`, which nothing in
  // the repo need *track*, so a list built from upstreams alone was missing the one ref
  // every number on screen is measured against.
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

/// The chosen candidates, in the shape each command takes. `picked` is the set of branch
/// names still ticked; a blocked row can never be in it, and is filtered here regardless
/// so no caller can pass one through by forgetting.
export function sweepPicks(cands: CleanCand[], picked: ReadonlySet<string>): SweepPick[] {
  return chosen(cands, picked).map((c) => ({ branch: c.br.name, gone: c.br.gone, force: c.force }));
}
export function remotePicks(cands: CleanCand[], picked: ReadonlySet<string>): RemotePick[] {
  return chosen(cands, picked).map((c) => ({ branch: c.br.name, sha: c.br.sha }));
}
/// The checkouts a local cleanup has to remove first: git refuses to delete a branch any
/// worktree holds, so a branch whose checkout is still there is a branch that cannot go.
export function chosenWorktrees(cands: CleanCand[], picked: ReadonlySet<string>): WtInfo[] {
  return chosen(cands, picked).flatMap((c) => (c.wt ? [c.wt] : []));
}
export function chosen(cands: CleanCand[], picked: ReadonlySet<string>): CleanCand[] {
  return cands.filter((c) => !c.block && picked.has(c.br.name));
}

/// Deletable first, blocked last, each half keeping git's own most-recent-first order.
///
/// The list you act on should not make you skip past the rows you can't act on to reach
/// the ones you can — and the blocked rows are not noise to be hidden either: "why isn't
/// this branch offered?" is a real question, and the row with its reason on it is the
/// answer. So they stay, at the bottom, out of the way of the ticks.
///
/// Stable within each group: `git_branch_list` sorts by committer date descending, and
/// re-sorting by anything else here would throw away the one ordering the rows arrive
/// with — recency is what makes "everything above this is old" readable.
export function orderCands(cands: CleanCand[]): CleanCand[] {
  return [...cands].sort((a, b) => Number(!!a.block) - Number(!!b.block));
}

/// Everything selectable — what "All" selects, and what a freshly opened view starts with.
export function selectable(cands: CleanCand[]): Set<string> {
  return new Set(cands.filter((c) => !c.block).map((c) => c.br.name));
}

/// A REMOTE row's standing against the trunk, as words rather than glyphs — the table has
/// room for it where the dialog's row never did. The trunk is not named: the view names it
/// once, in its footer, and repeating it down every row is what squeezed the branch column.
export function standing(b: BranchInfo): string {
  if (!b.base) return "not compared";
  if (!b.ahead && !b.behind) return "even";
  return [b.ahead ? `${b.ahead} ahead` : "", b.behind ? `${b.behind} behind` : ""]
    .filter(Boolean).join(" · ");
}

/// A LOCAL row's standing, which is a different question with a different answer: its
/// ahead/behind are versus its OWN upstream, not versus the trunk, so showing them under
/// the same heading as a remote row's would put two incompatible numbers in one column.
/// What a local branch has to say here is where its work sits relative to its remote.
export function localStanding(b: BranchInfo): string {
  if (b.gone) return "remote deleted";
  if (!b.upstream) return "never pushed";
  if (b.ahead) return `${b.ahead} unpushed`;
  return "pushed";
}
