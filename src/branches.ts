// Branch cleanup: what is worth deleting, what blocks it, and what each command is asked
// for (docs/worktrees.md). Evidence is `gone`, `merged` or a merged PR; only the last ever
// justifies a force, since a squash-merged branch is contained in nothing and `-d` refuses it.

// As `git_branch_list` answers (the Rust `BranchInfo` is the contract). A remote row's
// `ahead`/`behind` are versus the trunk; a local row's are versus its own `upstream`.
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
  base: string; // what merged/ahead/behind were measured against; empty = unmeasured, offer nothing
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
// `available: false` ("gh isn't logged in") must never look like an empty list ("nothing merged").
export interface MergedPrs {
  available: boolean;
  reason: string | null;
  prs: MergedPr[];
}

// ---------- what the backend is asked ----------

// `gone` is re-derived by `sweep_branches`; `force` is evidence nothing local can check.
export type SweepPick = { branch: string; gone: boolean; force: boolean };
// With the sha its row showed: the backend refuses a ref that has moved since the last fetch.
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

// One branch on offer. A non-empty `block` means shown but not choosable: a bulk button
// must never be what kills a running agent or drops uncommitted work.
export interface CleanCand {
  br: BranchInfo;
  wt?: WtInfo;
  why: string;
  pr?: MergedPr;
  force: boolean; // `-D` if the safe delete refuses; only ever true with PR evidence
  block: string;
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

// The current branch is never a candidate: git refuses to delete it.
export function localCands(ctx: CleanCtx): CleanCand[] {
  const prBy = prIndex(ctx.prs);
  const out: CleanCand[] = [];
  for (const b of ctx.branches) {
    if (b.remote || b.current) continue;
    const pr = prBy.get(b.name);
    if (!b.gone && !b.merged && !pr) continue;
    // Most specific first; `merged` is weakest: it can also mean the branch never had a commit of its own.
    const why = pr ? `#${pr.number} merged`
      : b.gone ? "remote branch deleted"
      : `merged into ${b.base || "the trunk"}`;
    const wt = ctx.worktrees.find((w) => !w.is_main && w.branch === b.name);
    // A checkout blocks the row rather than hiding it: the reason is how you learn why it isn't offered.
    const live = wt ? ctx.liveIn(wt.path) : 0;
    const block = !wt ? ""
      : live ? `${live} session${live === 1 ? "" : "s"} open in its worktree`
      : ctx.externalIn(wt.path) ? "a session outside Episko is running there"
      : wt.dirty ? "its worktree has uncommitted changes"
      : wt.locked ? "its worktree is locked"
      : "";
    // Only a merged PR justifies a force, and only where `-d` will refuse (a merged branch needs
    // none). `gone` alone never does: an unmerged branch whose remote was deleted is unpushed work.
    out.push({ br: b, wt, why, pr, force: !!pr && !b.merged, block });
  }
  return out;
}

// Narrower than the local rule, since `git push --delete` changes what everyone sees: only a
// branch contained in the trunk, or whose PR merged, is ever offered.
export function remoteCands(branches: BranchInfo[], prs: MergedPr[]): CleanCand[] {
  const prBy = prIndex(prs);
  return branches.filter((b) => b.remote).map((b) => {
    const pr = prBy.get(b.name);
    const why = pr ? `#${pr.number} merged` : b.merged ? `contained in ${b.base}` : "";
    // No base means the comparison could not be made at all; not knowing is a reason to refuse.
    const block = !b.base ? `no comparison against ${remoteOf(b)}'s default branch`
      : b.merged || pr ? ""
      : `${b.ahead} commit${b.ahead === 1 ? "" : "s"} not in ${b.base}`;
    return { br: b, why, pr, force: false, block };
  });
}

// `upstream` is exactly `<remote>/<name>`, so slice rather than split: the name may contain slashes.
export function remoteOf(b: BranchInfo): string {
  return b.upstream.slice(0, Math.max(0, b.upstream.length - b.name.length - 1));
}

// Offered rows always carry a `base`, which is the primary remote's, so a mixed-remote list cannot misroute.
export function remoteFor(cands: CleanCand[]): string {
  const c = cands.find((x) => !x.block) ?? cands[0];
  return c ? remoteOf(c.br) : "origin";
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

// Blocked rows are filtered here regardless, so no caller can pass one through by forgetting.
export function sweepPicks(cands: CleanCand[], picked: ReadonlySet<string>): SweepPick[] {
  return chosen(cands, picked).map((c) => ({ branch: c.br.name, gone: c.br.gone, force: c.force }));
}
export function remotePicks(cands: CleanCand[], picked: ReadonlySet<string>): RemotePick[] {
  return chosen(cands, picked).map((c) => ({ branch: c.br.name, sha: c.br.sha }));
}
// git refuses to delete a branch any worktree holds, so these go first.
export function chosenWorktrees(cands: CleanCand[], picked: ReadonlySet<string>): WtInfo[] {
  return chosen(cands, picked).flatMap((c) => (c.wt ? [c.wt] : []));
}
export function chosen(cands: CleanCand[], picked: ReadonlySet<string>): CleanCand[] {
  return cands.filter((c) => !c.block && picked.has(c.br.name));
}

// Deletable first, blocked last (their reason answers "why isn't this offered?"), each half
// keeping git_branch_list's most-recent-first order: recency is what makes the list readable.
export function orderCands(cands: CleanCand[]): CleanCand[] {
  return [...cands].sort((a, b) => Number(!!a.block) - Number(!!b.block));
}

export function selectable(cands: CleanCand[]): Set<string> {
  return new Set(cands.filter((c) => !c.block).map((c) => c.br.name));
}

// A REMOTE row's standing versus the trunk. The trunk is not named: the view names it once, in its footer.
export function standing(b: BranchInfo): string {
  if (!b.base) return "not compared";
  if (!b.ahead && !b.behind) return "even";
  return [b.ahead ? `${b.ahead} ahead` : "", b.behind ? `${b.behind} behind` : ""]
    .filter(Boolean).join(" · ");
}

// A LOCAL row's numbers are versus its own upstream, not the trunk: a different question, different words.
export function localStanding(b: BranchInfo): string {
  if (b.gone) return "remote deleted";
  if (!b.upstream) return "never pushed";
  if (b.ahead) return `${b.ahead} unpushed`;
  return "pushed";
}
