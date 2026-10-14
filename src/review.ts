// The pull-request review's rules: which diff a view shows, which lines GitHub will take a
// comment on, where a thread is drawn, the pending review kept on this machine, the viewed
// ticks and the file tree. Data in, data out — ./reviewview draws, ./reviewui owns the stage.
// See docs/review.md.

import type { DiffFile, DiffHunk, DiffLine } from "./diff";
import type { GhComment } from "./issue";

// ---------- the backend's shapes (review.rs) ----------

export interface PrCheck { name: string; state: string; url: string; workflow: string }
export interface PrCommit { oid: string; headline: string; author: string; at: string }
export interface PrComment { id: string; db_id: number; author: string; body: string; at: string; url: string; diff_hunk: string }
export interface PrThread {
  id: string; resolved: boolean; outdated: boolean; path: string;
  line: number | null; start_line: number | null; original_line: number | null; original_start_line: number | null;
  side: string; subject: string; comments: PrComment[];
}
export interface PrReviewEntry { author: string; state: string; body: string; at: string; commit: string }
export interface PrReview {
  available: boolean; reason: string | null;
  number: number; slug: string; title: string; url: string; state: string; draft: boolean;
  author: string | null; body: string; created_at: string; updated_at: string;
  base_ref: string; head_ref: string; base_oid: string; head_oid: string; same_repo: boolean;
  mergeable: string; merge_state: string; review_decision: string | null; merge_methods: string[];
  viewer: string | null;
  checks: PrCheck[]; commits: PrCommit[]; threads: PrThread[]; reviews: PrReviewEntry[]; comments: GhComment[];
}
export interface PrDiff { patch: string; truncated: boolean }

export type Side = "LEFT" | "RIGHT";
export interface Anchor { side: Side; line: number }
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export const prKey = (slug: string, n: number) => `${slug}#${n}`;

// ---------- which diff a view shows ----------

// `all` is GitHub's own diff (merge base → head), the only one every comment is anchored to.
export type Range = { kind: "all" } | { kind: "since"; from: string } | { kind: "commit"; oid: string };

/** What `pr_diff` is asked for. A null `from` is a three-dot diff against the base. */
export function rangeArgs(pr: PrReview, r: Range): { headOid: string; fromOid: string | null } {
  if (r.kind === "since") return { headOid: pr.head_oid, fromOid: r.from };
  if (r.kind === "commit") {
    const i = pr.commits.findIndex((c) => c.oid === r.oid);
    return { headOid: r.oid, fromOid: i > 0 ? pr.commits[i - 1].oid : null };
  }
  return { headOid: pr.head_oid, fromOid: null };
}

/** The sides whose line numbers mean what GitHub means by them in this view. */
export function liveSides(pr: PrReview, r: Range): Set<Side> {
  if (r.kind === "all") return new Set(["LEFT", "RIGHT"]);
  // Both of these end at head, so a new-file number is head's; the old side is not the base's.
  if (r.kind === "since" || r.oid === pr.head_oid) return new Set(["RIGHT"]);
  return new Set();
}

/** The head your last submitted review saw, when the PR has moved since: "since your review". */
export function lastReviewed(pr: PrReview): string | null {
  if (!pr.viewer) return null;
  const mine = pr.reviews
    .filter((r) => r.author === pr.viewer && r.commit && r.state !== "PENDING" && r.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return mine && mine.commit !== pr.head_oid ? mine.commit : null;
}

/** How many of the PR's commits came after `oid`; null when a rewrite took `oid` out of it. */
export function commitsSince(pr: PrReview, oid: string): number | null {
  const i = pr.commits.findIndex((c) => c.oid === oid);
  return i < 0 ? null : pr.commits.length - 1 - i;
}

// ---------- where a comment may go ----------

/** A deletion is anchored on the old side, everything else on the new, as GitHub does. */
export function anchorOf(l: DiffLine): Anchor | null {
  if (l.kind === "del") return l.oldNo ? { side: "LEFT", line: l.oldNo } : null;
  return l.newNo ? { side: "RIGHT", line: l.newNo } : null;
}

export const anchorKey = (path: string, a: Anchor) => `${path}\u0000${a.side}\u0000${a.line}`;

export interface Span { side: Side; lo: number; hi: number }
export type Commentable = Map<string, Span[]>;

function sideSpan(h: DiffHunk, side: Side): Span | null {
  const ns = h.lines.map((l) => (side === "LEFT" ? l.oldNo : l.newNo)).filter((n): n is number => !!n);
  return ns.length ? { side, lo: Math.min(...ns), hi: Math.max(...ns) } : null;
}

/** Per path, the hunk spans of GitHub's diff: a comment off them is refused with a 422. */
export function commentableIn(files: DiffFile[]): Commentable {
  const out: Commentable = new Map();
  for (const f of files) {
    const spans: Span[] = [];
    for (const h of f.hunks) for (const s of ["LEFT", "RIGHT"] as const) { const sp = sideSpan(h, s); if (sp) spans.push(sp); }
    out.set(f.path, spans);
  }
  return out;
}

/** Whether `start..end` (one line when equal) sits inside one hunk of the PR's diff. */
export function canComment(c: Commentable, path: string, side: Side, start: number, end = start): boolean {
  const lo = Math.min(start, end), hi = Math.max(start, end);
  return (c.get(path) ?? []).some((s) => s.side === side && s.lo <= lo && hi <= s.hi);
}

// ---------- where a thread, or a draft, is drawn ----------

/** Anything pinned to a line of a file, or to the file itself (`line` null). */
export interface Pinned { path: string; side: Side | null; line: number | null }

export interface Placed<T> {
  at: Map<string, T[]>; // by the anchorKey of the row it follows
  loose: Map<string, T[]>; // on a file in the view, but on no line drawn: shown at the file's head
  elsewhere: T[]; // on a file this view does not show
}

// A context row is one row on both sides, drawn once under its new-side key; an old-side
// pin on it must find that row.
function rowKeys(files: DiffFile[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    const a = anchorOf(l);
    if (!a) continue;
    const k = anchorKey(f.path, a);
    m.set(k, k);
    if (l.kind === "ctx" && l.oldNo) m.set(anchorKey(f.path, { side: "LEFT", line: l.oldNo }), k);
  }
  return m;
}

export function place<T extends Pinned>(items: T[], shown: DiffFile[], sides: Set<Side>): Placed<T> {
  const rows = rowKeys(shown);
  const paths = new Set(shown.map((f) => f.path));
  const out: Placed<T> = { at: new Map(), loose: new Map(), elsewhere: [] };
  const push = (m: Map<string, T[]>, k: string, t: T) => { const l = m.get(k); if (l) l.push(t); else m.set(k, [t]); };
  for (const t of items) {
    const row = t.line && t.side && sides.has(t.side) ? rows.get(anchorKey(t.path, { side: t.side, line: t.line })) : undefined;
    if (row) push(out.at, row, t);
    else if (paths.has(t.path)) push(out.loose, t.path, t);
    else out.elsewhere.push(t);
  }
  return out;
}

/** A thread as a pin: an outdated one has no line in today's diff, whatever it once had. */
export function threadPin(t: PrThread): PrThread & Pinned {
  const onLine = t.subject !== "FILE" && !t.outdated && t.line;
  return { ...t, side: t.side === "LEFT" ? "LEFT" : "RIGHT", line: onLine ? t.line : null };
}

export const openThreads = (pr: PrReview) => pr.threads.filter((t) => !t.resolved).length;

// ---------- the pending review: on this machine until it is submitted, in one call ----------

export interface DraftComment { id: string; path: string; side: Side | null; line: number | null; start: number | null; body: string; at: number }
export interface ReviewDraft { body: string; comments: DraftComment[]; at: number }
export type DraftStore = Record<string, ReviewDraft>;

const MAX_PRS = 40; // drafts and viewed ticks each; the oldest PR you touched goes first

function capByAt<T extends { at: number }>(m: Record<string, T>): Record<string, T> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_PRS) return m;
  const keep = keys.sort((a, b) => m[b].at - m[a].at).slice(0, MAX_PRS);
  return Object.fromEntries(keep.map((k) => [k, m[k]]));
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `cc-review-drafts`, narrowed: a comment missing its path or body is dropped, never sent. */
export function clampDrafts(raw: unknown): DraftStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DraftStore = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const d = v as Partial<ReviewDraft>;
    const comments = (Array.isArray(d.comments) ? d.comments : []).flatMap((c: Partial<DraftComment>): DraftComment[] => {
      if (!c || !str(c.path) || !str(c.body).trim() || !str(c.id)) return [];
      const line = num(c.line);
      const side = c.side === "LEFT" || c.side === "RIGHT" ? c.side : null;
      return [{ id: str(c.id), path: str(c.path), body: str(c.body), at: num(c.at) ?? 0,
        line: side ? line : null, side: line ? side : null, start: line && side ? num(c.start) : null }];
    });
    if (!comments.length && !str(d.body).trim()) continue;
    out[k] = { body: str(d.body), comments, at: num(d.at) ?? 0 };
  }
  return out;
}

/** The store with `key`'s draft replaced; an empty draft is removed rather than kept. */
export function withDraft(store: DraftStore, key: string, d: ReviewDraft | null): DraftStore {
  const next = { ...store };
  if (!d || (!d.comments.length && !d.body.trim())) delete next[key];
  else next[key] = d;
  return capByAt(next);
}

/** `pr_submit_review`'s `comments`: a range only when it is one, and no line on a file comment. */
export function reviewComments(d: ReviewDraft) {
  return d.comments.map((c) => ({
    path: c.path, body: c.body,
    line: c.line, side: c.line ? c.side : null,
    start_line: c.line && c.start && c.start !== c.line ? Math.min(c.start, c.line) : null,
    start_side: c.line && c.start && c.start !== c.line ? c.side : null,
  }));
}

/** Why Submit is refused, or null. Approving with nothing said is a review; commenting with nothing is not. */
export function submitBlock(d: ReviewDraft | undefined, ev: ReviewEvent, pr: PrReview): string | null {
  if (pr.state !== "OPEN") return `This pull request is ${pr.state.toLowerCase()}`;
  if (ev !== "COMMENT" && pr.viewer && pr.author === pr.viewer) return "GitHub does not let you approve or request changes on your own pull request";
  if (ev === "REQUEST_CHANGES" && !d?.body.trim() && !d?.comments.length) return "Say what needs to change";
  if (ev === "COMMENT" && !d?.body.trim() && !d?.comments.length) return "Write a comment first";
  return null;
}

export const suggestion = (lines: string[]) => "```suggestion\n" + lines.join("\n") + "\n```";

// ---------- viewed: a tick that undoes itself when the file changes again ----------

export interface ViewedEntry { at: number; files: Record<string, string> }
export type ViewedStore = Record<string, ViewedEntry>;

/** FNV-1a over what the file's diff says, so a push that touches it clears the tick. */
export function fileSig(f: DiffFile): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  feed(`${f.status}\u0000${f.oldPath ?? ""}\u0000${f.path}`);
  for (const hk of f.hunks) { feed(hk.at); for (const l of hk.lines) feed(l.kind[0] + l.text + "\n"); }
  return h.toString(16);
}

export function clampViewed(raw: unknown): ViewedStore {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ViewedStore = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<ViewedEntry> | null;
    if (!e || typeof e.files !== "object" || !e.files || Array.isArray(e.files)) continue;
    const files = Object.fromEntries(Object.entries(e.files).filter(([, s]) => typeof s === "string")) as Record<string, string>;
    if (Object.keys(files).length) out[k] = { at: num(e.at) ?? 0, files };
  }
  return out;
}

export const isViewed = (s: ViewedStore, key: string, f: DiffFile) => s[key]?.files[f.path] === fileSig(f);

export function setViewed(s: ViewedStore, key: string, f: DiffFile, on: boolean, now: number): ViewedStore {
  const files = { ...(s[key]?.files ?? {}) };
  if (on) files[f.path] = fileSig(f); else delete files[f.path];
  const next = { ...s };
  if (Object.keys(files).length) next[key] = { at: now, files }; else delete next[key];
  return capByAt(next);
}

// ---------- the file tree ----------

interface Dir { dirs: Map<string, Dir>; files: number[] }

function trie(paths: string[]): Dir {
  const root: Dir = { dirs: new Map(), files: [] };
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let d = root;
    for (const seg of parts.slice(0, -1)) {
      let n = d.dirs.get(seg);
      if (!n) d.dirs.set(seg, n = { dirs: new Map(), files: [] });
      d = n;
    }
    d.files.push(i);
  });
  return root;
}

const byName = (paths: string[]) => (a: number, b: number) => {
  const na = paths[a].slice(paths[a].lastIndexOf("/") + 1), nb = paths[b].slice(paths[b].lastIndexOf("/") + 1);
  return na.localeCompare(nb);
};

export type RailLayout = "tree" | "flat"; // ./state persists it and must not import a view

export type TreeRow = { kind: "dir"; name: string; path: string; depth: number } | { kind: "file"; index: number; depth: number };

/** Preorder, a folder's own files before its subfolders, and a chain of single-folder folders
 *  folded into one row (`src/app/lib`), as VS Code draws it. `folded` hides a folder's rows. */
export function treeRows(paths: string[], folded: ReadonlySet<string> = new Set()): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (d: Dir, prefix: string, depth: number) => {
    for (const i of d.files.slice().sort(byName(paths))) out.push({ kind: "file", index: i, depth });
    for (const name of [...d.dirs.keys()].sort((a, b) => a.localeCompare(b))) {
      let node = d.dirs.get(name)!, label = name;
      while (!node.files.length && node.dirs.size === 1) {
        const [k, v] = [...node.dirs][0];
        label += "/" + k;
        node = v;
      }
      const path = prefix + label;
      out.push({ kind: "dir", name: label, path, depth });
      if (!folded.has(path)) walk(node, path + "/", depth + 1);
    }
  };
  walk(trie(paths), "", 0);
  return out;
}

/** The files in the tree's own order, so the stream, the flat list and the tree never disagree. */
export function treeOrder<T extends { path: string }>(files: T[]): T[] {
  const rows = treeRows(files.map((f) => f.path));
  return rows.flatMap((r) => (r.kind === "file" ? [files[r.index]] : []));
}

// ---------- more context around a hunk, read from the file at the view's head ----------

const hunkStart = (h: DiffHunk) => {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(h.at);
  return m ? { old: +m[1], neu: +m[2] } : null;
};
const lastNew = (h: DiffHunk) => h.lines.reduce((n, l) => (l.newNo && l.newNo > n ? l.newNo : n), 0);

/** Hidden new-side lines above hunk `hi` (below the last when `hi` is hunks.length). */
export function gapAt(f: DiffFile, hi: number, total: number): number {
  if (f.status === "added" || f.status === "deleted" || f.binary) return 0;
  const prev = hi > 0 ? lastNew(f.hunks[hi - 1]) : 0;
  if (hi >= f.hunks.length) return Math.max(0, total - prev);
  const s = hunkStart(f.hunks[hi]);
  return s ? Math.max(0, s.neu - 1 - prev) : 0;
}

/** `f` with up to `n` context lines revealed at gap `hi` (see gapAt), taken from `text`. */
export function expandGap(f: DiffFile, hi: number, text: string, n: number): DiffFile {
  const src = text.replace(/\r\n?/g, "\n").split("\n");
  if (src.length && src[src.length - 1] === "") src.pop();
  const gap = gapAt(f, hi, src.length);
  if (!gap) return f;
  const hunks = f.hunks.map((h) => ({ ...h, lines: h.lines.slice() }));
  const ctx = (neu: number, old: number): DiffLine => ({ kind: "ctx", text: src[neu - 1] ?? "", oldNo: old, newNo: neu });
  if (hi < hunks.length) {
    const s = hunkStart(hunks[hi])!;
    const from = Math.max(s.neu - Math.min(n, gap), 1);
    const add: DiffLine[] = [];
    for (let k = from; k < s.neu; k++) add.push(ctx(k, k + s.old - s.neu));
    const lo = add.length;
    hunks[hi].lines.unshift(...add);
    hunks[hi].at = hunks[hi].at.replace(/^@@ -\d+(,\d+)? \+\d+(,\d+)?/, `@@ -${s.old - lo} +${s.neu - lo}`);
    // Once nothing is hidden between two hunks they are one: the separator row has nothing left to stand for.
    if (hi > 0 && s.neu - lo - 1 === lastNew(hunks[hi - 1])) {
      hunks[hi - 1].lines.push(...hunks[hi].lines);
      hunks.splice(hi, 1);
    }
  } else {
    const h = hunks[hunks.length - 1];
    const s = hunkStart(h);
    const newEnd = lastNew(h);
    if (!s || !newEnd) return f;
    // A hunk with no old lines (`-5,0`) sits after old line 5, which is what its header says.
    const oldEnd = h.lines.reduce((m, l) => (l.oldNo && l.oldNo > m ? l.oldNo : m), 0) || s.old;
    for (let k = newEnd + 1; k <= Math.min(newEnd + n, src.length); k++) h.lines.push(ctx(k, k + oldEnd - newEnd));
  }
  return { ...f, hunks };
}

// ---------- the header's facts ----------

export interface CheckTally { pass: number; fail: number; pending: number; skip: number; total: number }

export function checkTally(checks: PrCheck[]): CheckTally {
  const t: CheckTally = { pass: 0, fail: 0, pending: 0, skip: 0, total: checks.length };
  for (const c of checks) {
    if (c.state === "pass") t.pass++;
    else if (c.state === "fail") t.fail++;
    else if (c.state === "pending") t.pending++;
    else t.skip++;
  }
  return t;
}

/** Worst first: a failure is what you came to the list for. */
export function sortChecks(checks: PrCheck[]): PrCheck[] {
  const rank: Record<string, number> = { fail: 0, pending: 1, pass: 2 };
  return checks.slice().sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || a.name.localeCompare(b.name));
}

export function decisionWord(pr: PrReview): { text: string; tone: "ok" | "bad" | "wait" | "" } {
  if (pr.review_decision === "APPROVED") return { text: "approved", tone: "ok" };
  if (pr.review_decision === "CHANGES_REQUESTED") return { text: "changes requested", tone: "bad" };
  if (pr.review_decision === "REVIEW_REQUIRED") return { text: "review required", tone: "wait" };
  return { text: "", tone: "" };
}

/** Why a merge is refused outright; GitHub has the last word on everything else. */
export function mergeBlock(pr: PrReview): string | null {
  if (pr.state !== "OPEN") return `It is already ${pr.state.toLowerCase()}`;
  if (pr.draft) return "It is a draft. Mark it ready for review first";
  if (pr.mergeable === "CONFLICTING" || pr.merge_state === "DIRTY") return "It conflicts with the base branch";
  if (!pr.merge_methods.length) return "This repository allows no merge method you can use";
  return null;
}

/** What a merge would be going against, said before the confirm rather than after GitHub refuses. */
export function mergeWarn(pr: PrReview): string | null {
  const t = checkTally(pr.checks);
  if (pr.merge_state === "BLOCKED") return "GitHub says the branch's rules are not met yet (reviews or required checks)";
  if (t.fail) return `${t.fail} check${t.fail === 1 ? "" : "s"} failed`;
  if (t.pending) return `${t.pending} check${t.pending === 1 ? " is" : "s are"} still running`;
  if (pr.merge_state === "BEHIND") return `It is behind ${pr.base_ref}`;
  return null;
}

export const METHOD_WORD: Record<string, string> = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };

// ---------- the conversation ----------

export type TimelineItem =
  | { kind: "comment"; who: string; at: string; body: string }
  | { kind: "review"; who: string; at: string; state: string; body: string }
  | { kind: "commit"; who: string; at: string; oid: string; headline: string };

export function timeline(pr: PrReview): TimelineItem[] {
  const items: TimelineItem[] = [
    ...pr.comments.map((c): TimelineItem => ({ kind: "comment", who: c.who, at: c.at, body: c.body })),
    ...pr.reviews.filter((r) => r.at).map((r): TimelineItem => ({ kind: "review", who: r.author, at: r.at, state: r.state, body: r.body })),
    ...pr.commits.map((c): TimelineItem => ({ kind: "commit", who: c.author, at: c.at, oid: c.oid, headline: c.headline })),
  ];
  const t = (s: string) => Date.parse(s) || 0;
  return items.sort((a, b) => t(a.at) - t(b.at));
}

// ---------- handing feedback to an agent ----------

export interface BriefItem { path: string; line: number | null; start: number | null; side: Side | null; text: string }

export function threadBrief(t: PrThread): BriefItem {
  const p = threadPin(t);
  const text = t.comments.map((c) => `${c.author}: ${c.body.trim()}`).join("\n");
  return { path: t.path, line: p.line ?? t.original_line, start: t.start_line ?? t.original_start_line, side: p.side, text };
}

export const draftBrief = (c: DraftComment): BriefItem =>
  ({ path: c.path, line: c.line, start: c.start, side: c.side, text: c.body.trim() });

function where(b: BriefItem): string {
  if (!b.line) return `${b.path} (the whole file)`;
  const lines = b.start && b.start !== b.line ? `${Math.min(b.start, b.line)}-${Math.max(b.start, b.line)}` : `${b.line}`;
  return `${b.path}:${lines}${b.side === "LEFT" ? " (a removed line, old numbering)" : ""}`;
}

/** The prompt a session is prefilled with: where each point is, what was said, and the ask. */
export function agentBrief(pr: PrReview, items: BriefItem[]): string {
  const head = `Address this review feedback on PR #${pr.number} "${pr.title}" (branch ${pr.head_ref}):\n${pr.url}\n`;
  const body = items.map((b, i) => `${i + 1}. ${where(b)}\n${b.text.split("\n").map((l) => "   " + l).join("\n")}`).join("\n\n");
  return `${head}\n${body}\n\nMake the changes on this branch and run the checks. Don't push until I've looked.`;
}
