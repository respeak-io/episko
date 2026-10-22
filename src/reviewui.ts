// The pull-request review stage: its reads, its writes to GitHub, its own `#reviewPane` listener
// and the pending review kept until Submit. ./review decides, ./reviewview and ./patchview draw.
// A stage like the dashboard (`takeStage("review")`), opened from a PR in the project's queue.
// See docs/review.md.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "./confirm";
import { dlog } from "./debug";
import { $, clearStageBadges, setHeadPath, takeStage, toast } from "./dom";
import { parsePatch, type DiffFile } from "./diff";
import { openMenu } from "./menu";
import { icon, type IconName } from "./svgicons";
import { fileHtml, railHeadHtml, railHtml, treeRailHtml, type LineHooks } from "./patchview";
import {
  agentBrief, anchorKey, anchorOf, canComment, clampDrafts, clampViewed, commentableIn, commitsSince, draftBrief,
  expandGap, gapAt, isViewed, lastReviewed, liveSides, mergeBlock, mergeWarn, METHOD_WORD, place, prFromUrl, prKey, rangeArgs,
  reviewComments, setViewed, submitBlock, suggestion, threadBrief, threadPin, treeOrder, treeRows, withDraft,
  type Anchor, type Commentable, type DraftComment, type DraftStore, type PrDiff, type PrReview, type PrThread,
  type RailLayout, type Range, type ReviewEvent, type Side, type ViewedStore,
} from "./review";
import {
  addBtn, rangePos, checksHtml, composeHtml, conversationHtml, draftHtml, elsewhereHtml, expandBtn, failHtml, fileBtnsHtml,
  railMark, reviewBarHtml, reviewHeadHtml, tailBtn, threadHtml, type RvTab,
} from "./reviewview";
import {
  accentFor, diffMode, FAVORITES, ghAccountFor, railLayout, reviewMirror, sessions, setActiveId, setDiffMode, setMirror,
  setRailLayout, worktreesByRepo,
} from "./state";
import { readObj } from "./store";
import { isAgent, type GitActionResult } from "./types";

// What the stage does but does not own, as one host object (the FleetHost precedent).
export interface ReviewHost {
  launch: (project: string, workdir: string, opts?: { colorKey?: string; worktree?: string | null; branch?: string }) => Promise<string | null>;
  setActive: (id: string) => void;
  openDashboard: (project: string, path: string) => void;
  refreshGit: () => Promise<void>;
  renderAll: () => void;
}
let host: ReviewHost = {
  launch: async () => null, setActive: () => {}, openDashboard: () => {}, refreshGit: async () => {}, renderAll: () => {},
};
export function setReviewHost(h: ReviewHost) { host = h; }

const METHOD_ICON: Record<string, IconName> = { merge: "merge", squash: "squash", rebase: "rebase" };
const PREFILL_MS = 1400; // a fresh session's REPL is not reading yet; the dashboard's dispatch waits as long
const EXPAND_STEP = 20;
const OPEN_ALL_UNDER = 60; // past this many files a review opens folded, as a list to work down

interface Compose {
  fi: number; path: string; side: Side | null; line: number | null; start: number | null; anchor: number | null;
  text: string; preview: boolean; edit: string | null;
}

let pr: PrReview | null = null;
let failed = "";
let loading = false;
let full: DiffFile[] = []; // GitHub's diff, merge base → head: what comments and Viewed are measured on
let shown: DiffFile[] = []; // the view's diff, with any context revealed
let truncated = false;
let fullTruncated = false; // the "all" view reuses `full`, and its note with it
let commentable: Commentable = new Map();
let range: Range = { kind: "all" };
let ws = false;
let tab: RvTab = "conversation"; // GitHub opens a PR there too: what it is before what it changed
let compose: Compose | null = null;
let convText = "";
const replies = new Map<string, string>();
const threadOpen = new Map<string, boolean>(); // a thread you folded or unfolded by hand
const collapsed = new Set<string>(); // files folded, by path
const railFolded = new Set<string>();
const tailDone = new Set<string>();
let activeFile = -1;
let busy: string | null = null;
let event: ReviewEvent = "COMMENT";
let mergeMethod = "";
let deleteBranch = true;
let gen = 0;
let seeded = false; // the first diff of a review folds what you have viewed; after that, folds are yours

let drafts: DraftStore = clampDrafts(readObj("cc-review-drafts"));
let viewed: ViewedStore = clampViewed(readObj("cc-review-viewed"));

const root = () => reviewMirror()?.root ?? "";
const name = () => reviewMirror()?.name ?? "";
const key = () => (pr ? prKey(pr.slug, pr.number) : "");
const account = () => ghAccountFor(root());
const myDraft = () => drafts[key()] ?? { body: "", comments: [], at: 0 };
const draftList = (): DraftComment[] => myDraft().comments;

function saveDrafts(comments: DraftComment[], body = ($("rvSummary") as HTMLTextAreaElement).value) {
  drafts = withDraft(drafts, key(), { body, comments, at: Date.now() });
  localStorage.setItem("cc-review-drafts", JSON.stringify(drafts));
}

// ---------- open / close ----------

export function openPrReview(project: string, path: string, number: number): void {
  const same = reviewMirror()?.root === path && reviewMirror()?.number === number;
  setMirror({ kind: "review", root: path, name: project, number });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  takeStage("review");
  document.documentElement.style.setProperty("--accent", accentFor(path));
  if (!same) {
    pr = null; failed = ""; full = []; shown = []; truncated = false; fullTruncated = false; commentable = new Map();
    range = { kind: "all" }; ws = false; tab = "conversation"; compose = null; convText = "";
    replies.clear(); threadOpen.clear(); collapsed.clear(); railFolded.clear(); tailDone.clear();
    activeFile = -1; event = "COMMENT"; mergeMethod = ""; seeded = false;
    $("rvBody").scrollTop = 0;
  }
  host.renderAll();
  paintAll();
  void load(!same);
}

// A repo's slug never changes under a project, so one `project_facts` per root per run.
const slugOf = new Map<string, Promise<string | null>>();
const rootSlug = (root: string) => {
  let p = slugOf.get(root);
  if (!p) {
    p = invoke<{ slug: string | null }>("project_facts", { dir: root }).then((f) => f.slug?.toLowerCase() ?? null, () => null);
    slugOf.set(root, p);
  }
  return p;
};

/** A PR link clicked in a pane: open it here when a known project is that repo (the clicking
 *  pane's own first). False hands it back to the browser. */
export async function openPrLink(url: string, near?: { project: string; root: string }): Promise<boolean> {
  const hit = prFromUrl(url);
  if (!hit) return false;
  const want = hit.slug.toLowerCase();
  const cands = new Map<string, string>(); // root → project name, in the order asked
  if (near?.root) cands.set(near.root, near.project);
  for (const s of sessions.values()) if (s.colorKey && !cands.has(s.colorKey)) cands.set(s.colorKey, s.project);
  for (const f of FAVORITES) if (!cands.has(f.path)) cands.set(f.path, f.name);
  for (const [root, project] of cands) {
    if ((await rootSlug(root)) !== want) continue;
    dlog("info", `link: ${hit.slug}#${hit.number} → review in ${root}`);
    openPrReview(project, root, hit.number);
    return true;
  }
  dlog("info", `link: ${hit.slug}#${hit.number} · no project here is that repo, opening the browser`);
  return false;
}

export function closePrReview(): void {
  const m = reviewMirror();
  if (!m) return;
  setMirror(null);
  host.openDashboard(m.name, m.root);
}

/** Esc backs out of the comment being written before it leaves the stage. */
export function prReviewEscape(): boolean {
  if (!reviewMirror()) return false;
  if (compose) { cancelCompose(); return true; }
  closePrReview();
  return true;
}

// The top bar is renderAll's, so it is written there; everything below the bar is this module's.
export function renderReviewHeader(): void {
  clearStageBadges();
  const xb = $("btnClose") as HTMLButtonElement;
  xb.hidden = false;
  xb.title = "Back to the project (Esc)";
  ($("btnShelve") as HTMLButtonElement).hidden = true;
  $("hProj").textContent = name();
  const hb = $("hBranch");
  hb.classList.remove("ext-chip", "drifted");
  hb.hidden = !pr;
  hb.textContent = pr ? `${pr.base_ref} ← ${pr.head_ref}` : "";
  hb.title = "";
  $("hTitle").textContent = `Review · #${reviewMirror()?.number ?? ""}`;
  setHeadPath(root());
}

// ---------- reads ----------

async function load(fresh: boolean): Promise<void> {
  const mine = ++gen;
  const m = reviewMirror();
  if (!m) return;
  loading = true;
  if (fresh) paintAll();
  const was = pr?.head_oid;
  const got = await invoke<PrReview>("pr_review", { root: m.root, number: m.number, account: account() })
    .catch((e): PrReview | null => { failed = String(e); return null; });
  if (mine !== gen || !reviewMirror()) return;
  loading = false;
  if (!got || !got.available) {
    failed = got?.reason || failed || "GitHub could not be reached";
    pr = got;
    paintAll();
    return;
  }
  failed = "";
  pr = got;
  ($("rvSummary") as HTMLTextAreaElement).value = myDraft().body;
  host.renderAll();
  if (!full.length || was !== pr.head_oid) {
    // A push moved the head: every view's numbers changed, so start again from GitHub's diff.
    if (was !== pr.head_oid) { full = []; range = { kind: "all" }; }
    await loadDiffs(mine);
  } else paintAll();
}

async function readDiff(r: Range, ignore: boolean): Promise<{ files: DiffFile[]; truncated: boolean }> {
  const a = rangeArgs(pr!, r);
  const d = await invoke<PrDiff>("pr_diff", {
    root: root(), number: pr!.number, baseOid: pr!.base_oid, headOid: a.headOid, fromOid: a.fromOid, ignoreWs: ignore,
  });
  return { files: treeOrder(parsePatch(d.patch)), truncated: d.truncated };
}

async function loadDiffs(mine = ++gen): Promise<void> {
  if (!pr) return;
  loading = true;
  paintBar();
  try {
    if (!full.length) {
      const f = await readDiff({ kind: "all" }, false);
      if (mine !== gen) return;
      full = f.files;
      fullTruncated = f.truncated;
      commentable = commentableIn(full);
    }
    const v = range.kind === "all" && !ws ? { files: full, truncated: fullTruncated } : await readDiff(range, ws);
    if (mine !== gen) return;
    shown = v.files;
    truncated = v.truncated;
    tailDone.clear();
    if (!seeded) {
      seeded = true;
      const k = key();
      for (const f of shown) if (shown.length > OPEN_ALL_UNDER || isViewed(viewed, k, sigFile(f))) collapsed.add(f.path);
    }
    failed = "";
  } catch (e) {
    if (mine !== gen) return;
    failed = `Couldn't read the diff: ${e}`;
    dlog("warn", `review #${pr.number}: ${e}`);
  }
  loading = false;
  paintAll();
}

// Viewed is measured on GitHub's diff, so a tick made in one commit's view means the same file.
const sigFile = (f: DiffFile) => full.find((x) => x.path === f.path) ?? f;

// ---------- painting ----------

function paintAll() {
  paintHead();
  paintBar();
  paintBody();
  paintRail();
  paintFoot();
}

function paintHead() {
  $("rvHead").innerHTML = pr?.available ? reviewHeadHtml(pr, Date.now(), busy) : "";
}

function rangeLabel(): string {
  if (!pr || range.kind === "all") return "All changes";
  if (range.kind === "since") return "Since your review";
  const r = range;
  const i = pr.commits.findIndex((c) => c.oid === r.oid);
  return `Commit ${i + 1} of ${pr.commits.length}`;
}

function paintBar() {
  const bar = $("rvBar");
  if (!pr?.available) { bar.innerHTML = ""; return; }
  const since = lastReviewed(pr);
  const k = key();
  bar.innerHTML = reviewBarHtml({
    tab, pr, rangeLabel: rangeLabel(),
    since: since ? { oid: since, n: commitsSince(pr, since) } : null, showingSince: range.kind === "since",
    ws, mode: diffMode, allOpen: shown.every((f) => !collapsed.has(f.path)),
    files: shown.length, add: shown.reduce((a, f) => a + f.added, 0), del: shown.reduce((a, f) => a + f.removed, 0),
    viewed: shown.filter((f) => isViewed(viewed, k, sigFile(f))).length, truncated,
  });
}

function placements() {
  const sides = pr ? liveSides(pr, range) : new Set<Side>();
  return {
    sides,
    threads: place((pr?.threads ?? []).map(threadPin), shown, sides),
    drafts: place(draftList(), shown, sides),
  };
}
type Placements = ReturnType<typeof placements>;

function threadBlock(t: PrThread, loose: boolean, showPath = false): string {
  const open = threadOpen.get(t.id) ?? !t.resolved;
  return threadHtml(t, { now: Date.now(), loose, open, reply: replies.get(t.id) ?? "", busy: !!busy, showPath });
}

function composeBlock(): string {
  if (!compose) return "";
  return composeHtml({ ...compose, editing: !!compose.edit, canSuggest: compose.side === "RIGHT" && !!compose.line });
}

const inCompose = (path: string, a: Anchor) => (compose && compose.path === path && compose.side === a.side && compose.line
  ? rangePos(a.line, compose.start ?? compose.line, compose.line) : "");

function sectionHtml(i: number, pl: Placements): string {
  const f = shown[i];
  const k = key();
  const isV = isViewed(viewed, k, sigFile(f));
  const live = pr?.state === "OPEN";
  const hooks: LineHooks = {
    gutter: (l) => {
      const a = anchorOf(l);
      if (!live || !a || !pl.sides.has(a.side) || !canComment(commentable, f.path, a.side, a.line)) return "";
      return addBtn(i, a.side, a.line, inCompose(f.path, a));
    },
    after: (l) => {
      const a = anchorOf(l);
      if (!a) return "";
      const ak = anchorKey(f.path, a);
      const here = compose && compose.path === f.path && compose.line && compose.side
        && anchorKey(f.path, { side: compose.side, line: compose.line }) === ak;
      return (pl.threads.at.get(ak) ?? []).map((t) => threadBlock(t, false)).join("")
        + (pl.drafts.at.get(ak) ?? []).map((d) => (compose?.edit === d.id ? composeBlock() : draftHtml(d, false))).join("")
        + (here && !compose!.edit ? composeBlock() : "");
    },
  };
  const loose = pl.threads.loose.get(f.path) ?? [];
  const fileDrafts = pl.drafts.loose.get(f.path) ?? [];
  const top = loose.map((t) => threadBlock(t, true)).join("")
    + fileDrafts.map((d) => (compose?.edit === d.id ? composeBlock() : draftHtml(d, true))).join("")
    + (compose && compose.fi === i && !compose.line && !compose.edit ? composeBlock() : "");
  const opens = (pr?.threads ?? []).filter((t) => t.path === f.path && !t.resolved).length;
  const tail = f.status === "modified" || f.status === "renamed";
  return fileHtml(f, i, diffMode, !collapsed.has(f.path), {
    btns: fileBtnsHtml(i, isV, opens, !!live),
    tick: null,
    hunk: (hi) => { const g = gapAt(f, hi, 0); return g ? expandBtn(i, hi, g) : ""; },
    lines: hooks,
    top: top ? `<div class="rv-top">${top}</div>` : "",
    tail: tail && f.hunks.length && !tailDone.has(f.path) ? tailBtn(i, f.hunks.length) : "",
    cls: isV ? " rv-isviewed" : "",
  });
}

function paintBody() {
  const body = $("rvBody");
  if (!pr || !pr.available) {
    body.innerHTML = loading ? `<div class="diff-empty"><span class="u-spin"></span> Reading the pull request…</div>`
      : failHtml(failed || "Nothing to show", pr?.url ?? "");
    return;
  }
  if (tab === "conversation") { body.innerHTML = conversationHtml(pr, Date.now(), convText, !!busy); return; }
  if (tab === "checks") { body.innerHTML = checksHtml(pr.checks); return; }
  if (failed) { body.innerHTML = failHtml(failed, pr.url); return; }
  if (loading && !shown.length) { body.innerHTML = `<div class="diff-empty"><span class="u-spin"></span> Reading the diff…</div>`; return; }
  if (!shown.length) { body.innerHTML = `<div class="diff-empty">No changes in this view.</div>`; return; }
  const pl = placements();
  const away = pl.threads.elsewhere.map((t) => threadBlock(t, true, true));
  const note = truncated ? `<div class="diff-trunc">Diff truncated: too large to show in full here. GitHub has the rest.</div>` : "";
  keepPlace(() => { body.innerHTML = shown.map((_, i) => sectionHtml(i, pl)).join("") + note + elsewhereHtml(away); });
  refocus();
}

// One file repainted in place: the rest of the stream, its folds and its scroll are untouched.
function paintFile(i: number) {
  const sec = section(i);
  if (!sec || tab !== "files") return;
  keepPlace(() => { sec.outerHTML = sectionHtml(i, placements()); });
  refocus();
}

// A repaint above the reading position must not move it: hold the active file's header still.
function keepPlace(paint: () => void) {
  const body = $("rvBody");
  const at = activeFile >= 0 ? section(activeFile) : null;
  const before = at ? at.getBoundingClientRect().top : 0;
  const top = body.scrollTop;
  paint();
  const now = activeFile >= 0 ? section(activeFile) : null;
  body.scrollTop = now && at ? top + now.getBoundingClientRect().top - before : top;
}

function refocus() {
  const ta = document.getElementById("rvCompText") as HTMLTextAreaElement | null;
  if (ta) grow(ta);
  if (ta && document.activeElement !== ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

// A comment box is as tall as what is in it, up to a point: a suggestion block is several lines.
function grow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight + 2, 360)}px`;
}

const section = (i: number) => $("rvBody").querySelector<HTMLElement>(`.dfile[data-fi="${i}"]`);

function paintRail() {
  const rail = $("rvRail");
  rail.hidden = !pr?.available || tab !== "files" || shown.length < 2;
  if (rail.hidden) return;
  const k = key();
  const opens = (i: number) => (pr?.threads ?? []).filter((t) => t.path === shown[i].path && !t.resolved).length;
  const mark = (i: number) => railMark(isViewed(viewed, k, sigFile(shown[i])), opens(i));
  const keep = rail.scrollTop;
  rail.innerHTML = railHeadHtml(railLayout, shown.length) + (railLayout === "tree"
    ? treeRailHtml(shown, treeRows(shown.map((f) => f.path), railFolded), railFolded, activeFile, [], () => null, mark)
    : railHtml(shown, activeFile, [], () => null, mark));
  rail.scrollTop = keep;
}

function paintFoot() {
  const foot = $("rvFoot");
  foot.hidden = !pr?.available || pr.state !== "OPEN";
  if (foot.hidden || !pr) return;
  const n = draftList().length;
  $("rvPending").textContent = n ? `${n} pending comment${n === 1 ? "" : "s"}` : "No comments yet";
  for (const b of $("rvEvent").querySelectorAll<HTMLElement>("[data-ev]")) b.classList.toggle("on", b.dataset.ev === event);
  const block = submitBlock({ ...myDraft(), body: ($("rvSummary") as HTMLTextAreaElement).value }, event, pr);
  const go = $("rvSubmit") as HTMLButtonElement;
  go.disabled = !!busy || !!block;
  go.title = block ?? "Send the review and every pending comment to GitHub in one go";
  $("rvSubmitTxt").textContent = busy === "submitting" ? "submitting…" : "Submit review";
  ($("rvAgentDraft") as HTMLButtonElement).disabled = !n;
}

// ---------- the scroll spy, as the working-set viewer has it ----------
let spyDue = false;
function spy() {
  if (spyDue) return;
  spyDue = true;
  requestAnimationFrame(() => {
    spyDue = false;
    if (!reviewMirror() || tab !== "files") return;
    const top = $("rvBody").getBoundingClientRect().top + 1;
    let hit = 0;
    const heads = $("rvBody").querySelectorAll<HTMLElement>(".dfhead");
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= top + heads[i].offsetHeight) hit = i;
      else break;
    }
    if (hit === activeFile) return;
    activeFile = hit;
    const rail = $("rvRail");
    for (const el of rail.querySelectorAll(".dr-row.on")) el.classList.remove("on");
    const row = rail.querySelector<HTMLElement>(`.dr-row[data-drow="${hit}"]`);
    row?.classList.add("on");
    if (row) {
      const rb = rail.getBoundingClientRect(), b = row.getBoundingClientRect();
      if (b.top < rb.top || b.bottom > rb.bottom) row.scrollIntoView({ block: "nearest" });
    }
  });
}

function revealFile(i: number) {
  const f = shown[i];
  if (!f) return;
  if (collapsed.delete(f.path)) paintFile(i);
  section(i)?.scrollIntoView({ block: "start" });
  spy();
}

// ---------- composing ----------

function onAdd(fi: number, side: Side, line: number, shift: boolean) {
  const f = shown[fi];
  if (!f) return;
  const old = compose?.fi;
  if (shift && compose && compose.path === f.path && compose.side === side && compose.anchor && !compose.edit) {
    const lo = Math.min(compose.anchor, line), hi = Math.max(compose.anchor, line);
    if (!canComment(commentable, f.path, side, lo, hi)) { toast("A comment can only span lines of one hunk"); return; }
    compose = { ...compose, start: lo === hi ? null : lo, line: hi };
  } else {
    compose = { fi, path: f.path, side, line, start: null, anchor: line, text: compose?.edit ? "" : compose?.text ?? "", preview: false, edit: null };
  }
  if (old !== undefined && old !== fi) paintFile(old);
  paintFile(fi);
}

// ---------- dragging the "+" down (or up) a run of lines, as GitHub does ----------
// The range is lit in place by toggling the buttons' `on` class; nothing repaints until the drop.

interface Drag { fi: number; side: Side; from: number; to: number; moved: boolean }
let drag: Drag | null = null;
let swallowClick = false; // the click that ends a drag is the drop, not a click on whatever it landed on

// The line under the pointer, from any part of its row: the `+` itself, a unified row, or a split cell.
function lineAt(t: HTMLElement): { fi: number; side: Side; line: number } | null {
  const row = t.closest<HTMLElement>(".dline, .sn, .sc");
  const cell = row?.classList.contains("sc") ? row.previousElementSibling as HTMLElement | null : row;
  const btn = t.closest<HTMLElement>("[data-rvadd]") ?? cell?.querySelector<HTMLElement>("[data-rvadd]");
  if (!btn) return null;
  const [fi, side, line] = btn.dataset.rvadd!.split(":");
  return { fi: +fi, side: side as Side, line: +line };
}

function markDrag(d: Drag) {
  const lo = Math.min(d.from, d.to), hi = Math.max(d.from, d.to);
  for (const b of section(d.fi)?.querySelectorAll<HTMLElement>(`[data-rvadd^="${d.fi}:${d.side}:"]`) ?? []) {
    const pos = rangePos(+b.dataset.rvadd!.split(":")[2], lo, hi);
    b.classList.remove("on", "one", "first", "mid", "last");
    if (pos) b.classList.add("on", pos);
  }
}

function dropDrag(d: Drag) {
  const f = shown[d.fi];
  if (!f) return;
  const lo = Math.min(d.from, d.to), hi = Math.max(d.from, d.to);
  const old = compose?.fi;
  compose = { fi: d.fi, path: f.path, side: d.side, line: hi, start: lo === hi ? null : lo, anchor: d.from,
    text: compose && !compose.edit ? compose.text : "", preview: false, edit: null };
  if (old !== undefined && old !== d.fi) paintFile(old);
  paintFile(d.fi);
}

function onFileComment(fi: number) {
  const f = shown[fi];
  if (!f) return;
  const old = compose?.fi;
  compose = { fi, path: f.path, side: null, line: null, start: null, anchor: null, text: compose?.edit ? "" : compose?.text ?? "", preview: false, edit: null };
  collapsed.delete(f.path);
  if (old !== undefined && old !== fi) paintFile(old);
  paintFile(fi);
}

function cancelCompose() {
  const fi = compose?.fi;
  compose = null;
  if (fi !== undefined) paintFile(fi);
}

function saveCompose() {
  if (!compose || !pr) return;
  const text = compose.text.trim();
  if (!text) { toast("Write the comment first"); return; }
  const list = draftList().slice();
  if (compose.edit) {
    const i = list.findIndex((d) => d.id === compose!.edit);
    if (i >= 0) list[i] = { ...list[i], body: compose.text };
  } else {
    list.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, path: compose.path,
      side: compose.side, line: compose.line, start: compose.start, body: compose.text, at: Date.now(),
    });
  }
  saveDrafts(list);
  const fi = compose.fi;
  compose = null;
  paintFile(fi);
  paintRail();
  paintFoot();
}

function editDraft(id: string) {
  const d = draftList().find((x) => x.id === id);
  if (!d) return;
  const fi = shown.findIndex((f) => f.path === d.path);
  if (fi < 0) { toast("That file is not in this view; switch to All changes to edit it"); return; }
  const old = compose?.fi;
  compose = { fi, path: d.path, side: d.side, line: d.line, start: d.start, anchor: d.start ?? d.line, text: d.body, preview: false, edit: id };
  if (old !== undefined && old !== fi) paintFile(old);
  paintFile(fi);
}

function deleteDraft(id: string) {
  const d = draftList().find((x) => x.id === id);
  saveDrafts(draftList().filter((x) => x.id !== id));
  const fi = d ? shown.findIndex((f) => f.path === d.path) : -1;
  if (fi >= 0) paintFile(fi); else paintBody();
  paintFoot();
}

// The selected new-side lines as GitHub's suggestion block, the starting point for an edit.
function insertSuggestion() {
  if (!compose?.line || compose.side !== "RIGHT") return;
  const f = shown[compose.fi];
  const lo = compose.start ?? compose.line;
  const lines: string[] = [];
  for (const h of f.hunks) for (const l of h.lines) if (l.newNo && l.newNo >= lo && l.newNo <= compose.line) lines.push(l.text);
  const ta = document.getElementById("rvCompText") as HTMLTextAreaElement | null;
  const block = suggestion(lines);
  compose.text = compose.text.trim() ? `${compose.text.replace(/\s+$/, "")}\n\n${block}` : block;
  if (ta) { ta.value = compose.text; grow(ta); ta.focus(); }
}

// ---------- writes to GitHub ----------

async function write<T>(what: string, call: () => Promise<T>, reload = true): Promise<T | null> {
  if (busy) return null;
  busy = what;
  paintHead();
  paintFoot();
  try {
    return await call();
  } catch (e) {
    toast(`${what}: ${e}`);
    dlog("warn", `review ${what}: ${e}`);
    return null;
  } finally {
    busy = null;
    paintHead();
    paintFoot();
    if (reload) void load(false);
  }
}

async function submit() {
  if (!pr) return;
  const body = ($("rvSummary") as HTMLTextAreaElement).value;
  const d = { ...myDraft(), body };
  if (submitBlock(d, event, pr)) return;
  const n = pr.number;
  const url = await write("submitting", () => invoke<string>("pr_submit_review", {
    root: root(), number: n, commitId: pr!.head_oid, event, body, comments: reviewComments(d), account: account(),
  }));
  if (url === null) return;
  drafts = withDraft(drafts, key(), null);
  localStorage.setItem("cc-review-drafts", JSON.stringify(drafts));
  ($("rvSummary") as HTMLTextAreaElement).value = "";
  event = "COMMENT";
  toast(`Review sent on #${n}`);
}

async function reply(id: string) {
  const t = pr?.threads.find((x) => x.id === id);
  const text = (replies.get(id) ?? "").trim();
  if (!t || !pr || !text || !t.comments[0]) return;
  // GitHub takes a reply to the thread's first comment only; a reply to a reply is refused.
  const ok = await write("replying", () => invoke("pr_reply", {
    root: root(), number: pr!.number, commentId: t.comments[0].db_id, body: text, account: account(),
  }).then(() => true));
  if (ok) replies.delete(id);
}

async function resolve(id: string) {
  const t = pr?.threads.find((x) => x.id === id);
  if (!t) return;
  const ok = await write(t.resolved ? "reopening" : "resolving", () => invoke("pr_resolve", {
    root: root(), threadId: id, resolve: !t.resolved, account: account(),
  }).then(() => true));
  if (ok) threadOpen.delete(id);
}

async function converse() {
  const text = convText.trim();
  if (!text || !pr) return;
  const ok = await write("commenting", () => invoke("pr_comment", { root: root(), number: pr!.number, body: text, account: account() }).then(() => true));
  if (ok) convText = "";
}

async function setReady(ready: boolean) {
  if (!pr) return;
  await write(ready ? "marking ready" : "converting to draft", () =>
    invoke("pr_ready", { root: root(), number: pr!.number, ready, account: account() }));
}

function openMerge(at: HTMLElement) {
  if (!pr) return;
  const p = pr;
  const block = mergeBlock(p);
  if (block) { toast(block); return; }
  const methods = p.merge_methods;
  if (!methods.includes(mergeMethod)) mergeMethod = methods.includes("squash") ? "squash" : methods[0];
  openMenu(at, {
    title: `Merge #${p.number}`, sub: `${p.head_ref} → ${p.base_ref}`,
    groups: [
      { items: methods.map((m) => ({ id: m, label: METHOD_WORD[m] ?? m, logo: icon(METHOD_ICON[m] ?? "merge"),
        sub: m === mergeMethod ? "last used" : undefined })) },
      { items: [{ id: "del", label: "Delete the branch afterwards", logo: icon(deleteBranch && p.same_repo ? "trash" : "box"),
        sub: !p.same_repo ? "it lives in a fork" : deleteBranch ? "on · click to keep it" : "off · click to delete it",
        disabled: !p.same_repo }] },
    ],
    onPick: (id) => {
      if (id === "del") { deleteBranch = !deleteBranch; openMerge(at); return; }
      mergeMethod = id;
      void doMerge();
    },
  });
}

async function doMerge() {
  if (!pr) return;
  const p = pr;
  const warn = mergeWarn(p);
  const del = deleteBranch && p.same_repo;
  const ok = await ask(`${METHOD_WORD[mergeMethod] ?? mergeMethod}: \`${p.head_ref}\` into \`${p.base_ref}\` on GitHub.`
    + (warn ? `\n\n${warn}.` : "")
    + (del ? `\n\nThe branch \`${p.head_ref}\` is deleted on GitHub afterwards.` : "")
    + `\n\nIf anybody pushed since this page read it, GitHub refuses rather than merging what you have not seen.`,
  { title: `Merge #${p.number}?`, kind: warn ? "warning" : "info", okLabel: "Merge" });
  if (!ok) return;
  const said = await write("merging", () => invoke<string>("pr_merge", {
    root: root(), number: p.number, method: mergeMethod, headOid: p.head_oid, deleteBranch: del, account: account(),
  }));
  if (said) { toast(said); void host.refreshGit(); }
}

// ---------- handing work to an agent ----------

async function checkoutDir(p: PrReview): Promise<string | null> {
  const r = root();
  const here = (worktreesByRepo.get(r) ?? []).find((w) => w.branch === p.head_ref && w.exists);
  if (here) return here.path;
  if (!p.same_repo) {
    toast(`#${p.number}'s branch lives in a fork: check it out with \`gh pr checkout ${p.number}\` first`);
    return null;
  }
  const make = () => invoke<string>("create_worktree", { repoDir: r, branch: p.head_ref, base: `origin/${p.head_ref}` });
  try {
    let path: string;
    try { path = await make(); } catch (e) {
      // Nobody has fetched the branch here yet: fetch once, then the remote ref exists.
      if (!/no such commit/.test(String(e))) throw e;
      await invoke<GitActionResult>("git_action", { workdir: r, op: "fetch" });
      path = await make();
    }
    toast(`Worktree ${p.head_ref} created`);
    await host.refreshGit();
    return path;
  } catch (e) {
    toast(`worktree: ${e}`);
    return null;
  }
}

// Prefilled, never sent: a human reads what goes in before pressing Enter (CLAUDE.md).
function prefill(sid: string, text: string) {
  invoke("write_pty", { sessionId: sid, data: text.replace(/\n/g, "\r") })
    .then(() => toast("Prefilled in the session. Press Enter to send"))
    .catch((e) => toast("send failed: " + e));
}

async function toAgent(text: string | null) {
  const p = pr;
  if (!p) return;
  const live = [...sessions.values()].find((s) => isAgent(s) && !s.external && s.colorKey === root() && s.branch === p.head_ref);
  if (live) {
    host.setActive(live.id);
    if (text) prefill(live.id, text);
    return;
  }
  const dir = await checkoutDir(p);
  if (!dir) return;
  const sid = await host.launch(name(), dir, { colorKey: root(), worktree: p.head_ref, branch: p.head_ref });
  if (typeof sid !== "string" || !text) return;
  setTimeout(() => prefill(sid, text), PREFILL_MS);
}

// ---------- the view's own switches ----------

function setRange(r: Range) {
  range = r;
  compose = null;
  void loadDiffs();
}

function openRange(at: HTMLElement) {
  if (!pr) return;
  const p = pr;
  const since = lastReviewed(p);
  const short = (o: string) => o.slice(0, 7);
  const on = (id: string) => (id === (range.kind === "commit" ? `c:${range.oid}` : range.kind) ? " · showing" : "");
  openMenu(at, {
    title: "Show changes", sub: `#${p.number}`,
    groups: [
      { items: [
        { id: "all", label: "All changes", sub: `${p.base_ref} → ${p.head_ref}${on("all")}`, logo: icon("files") },
        ...(since ? [{ id: "since", label: "Since your last review", sub: short(since) + on("since"), logo: icon("since") }] : []),
      ] },
      { label: "One commit", items: p.commits.map((c) => ({ id: `c:${c.oid}`, label: c.headline || short(c.oid), sub: `${short(c.oid)} · ${c.author}${on(`c:${c.oid}`)}`, logo: icon("commit") })).reverse() },
    ],
    onPick: (id) => {
      if (id === "all") setRange({ kind: "all" });
      else if (id === "since" && since) setRange({ kind: "since", from: since });
      else if (id.startsWith("c:")) setRange({ kind: "commit", oid: id.slice(2) });
    },
  });
}

async function expand(fi: number, hi: number) {
  const f = shown[fi];
  if (!pr || !f) return;
  try {
    const text = await invoke<string>("pr_blob", { root: root(), oid: rangeArgs(pr, range).headOid, path: f.path });
    const total = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    shown[fi] = expandGap(f, hi, text, EXPAND_STEP);
    if (hi >= f.hunks.length && !gapAt(shown[fi], hi, total)) tailDone.add(f.path);
    paintFile(fi);
  } catch (e) {
    toast(`Couldn't read ${f.path}: ${e}`);
  }
}

function toggleViewed(fi: number) {
  const f = shown[fi];
  if (!f) return;
  const on = !isViewed(viewed, key(), sigFile(f));
  viewed = setViewed(viewed, key(), sigFile(f), on, Date.now());
  localStorage.setItem("cc-review-viewed", JSON.stringify(viewed));
  if (on) collapsed.add(f.path); else collapsed.delete(f.path);
  paintFile(fi);
  paintRail();
  paintBar();
  if (on) section(fi)?.scrollIntoView({ block: "nearest" });
}

function setTab(t: RvTab) {
  tab = t;
  paintBar();
  paintBody();
  paintRail();
  $("rvBody").scrollTop = 0;
}

// ---------- events: one delegated listener on the pane, bound once ----------
export function wireReview(): void {
  $("reviewPane").addEventListener("pointerdown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-rvadd]");
    if (!b || e.button !== 0 || e.shiftKey) return;
    const at = lineAt(b)!;
    drag = { fi: at.fi, side: at.side, from: at.line, to: at.line, moved: false };
    e.preventDefault(); // or the drag selects the code it passes over
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const at = lineAt(e.target as HTMLElement);
    if (!at || at.fi !== drag.fi || at.side !== drag.side || at.line === drag.to) return;
    // Past the edge of the hunk GitHub would refuse it, so the range stops where the hunk does.
    if (!canComment(commentable, shown[drag.fi]?.path ?? "", drag.side, drag.from, at.line)) return;
    drag.to = at.line;
    drag.moved = true;
    markDrag(drag);
  });
  document.addEventListener("pointerup", () => {
    const d = drag;
    drag = null;
    if (!d?.moved) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    dropDrag(d);
  });
  $("reviewPane").addEventListener("click", (e) => {
    if (swallowClick) { swallowClick = false; return; }
    const t = e.target as HTMLElement;
    const url = t.closest<HTMLElement>("[data-rvurl]");
    if (url) { void openUrl(url.dataset.rvurl!).catch(() => {}); return; }
    const tb = t.closest<HTMLElement>("[data-rvtab]");
    if (tb) { setTab(tb.dataset.rvtab as RvTab); return; }
    const act = t.closest<HTMLElement>("[data-rvact]");
    if (act) { runAct(act.dataset.rvact!, act); return; }
    const rg = t.closest<HTMLElement>("[data-rvrange]");
    if (rg) { openRange(rg); return; }
    const since = t.closest<HTMLElement>("[data-rvsince]");
    if (since) { const o = pr && lastReviewed(pr); if (o) setRange({ kind: "since", from: o }); return; }
    if (t.closest<HTMLElement>("[data-rvws]")) { ws = !ws; void loadDiffs(); return; }
    if (t.closest<HTMLElement>("[data-rvmode]")) {
      setDiffMode(diffMode === "split" ? "unified" : "split");
      localStorage.setItem("cc-diff-mode", diffMode);
      paintBar();
      paintBody();
      return;
    }
    if (t.closest<HTMLElement>("[data-rvfold]")) {
      const open = shown.some((f) => collapsed.has(f.path));
      collapsed.clear();
      if (!open) for (const f of shown) collapsed.add(f.path);
      paintBar();
      paintBody();
      return;
    }

    // A file's and a line's own controls, all nested inside the header or a row: before the fold.
    const add = t.closest<HTMLElement>("[data-rvadd]");
    if (add) { const [fi, side, line] = add.dataset.rvadd!.split(":"); onAdd(+fi, side as Side, +line, e.shiftKey); return; }
    const fc = t.closest<HTMLElement>("[data-rvfilec]");
    if (fc) { onFileComment(+fc.dataset.rvfilec!); return; }
    const vw = t.closest<HTMLElement>("[data-rvviewed]");
    if (vw) { toggleViewed(+vw.dataset.rvviewed!); return; }
    const ex = t.closest<HTMLElement>("[data-rvexp]");
    if (ex) { const [fi, hi] = ex.dataset.rvexp!.split(":").map(Number); void expand(fi, hi); return; }

    if (t.closest<HTMLElement>("[data-rvsave]")) { saveCompose(); return; }
    if (t.closest<HTMLElement>("[data-rvcancel]")) { cancelCompose(); return; }
    if (t.closest<HTMLElement>("[data-rvsuggest]")) { insertSuggestion(); return; }
    const pv = t.closest<HTMLElement>("[data-rvpreview]");
    if (pv && compose) { compose.preview = pv.dataset.rvpreview === "1"; paintFile(compose.fi); return; }
    const de = t.closest<HTMLElement>("[data-rvdedit]");
    if (de) { editDraft(de.dataset.rvdedit!); return; }
    const dd = t.closest<HTMLElement>("[data-rvddel]");
    if (dd) { deleteDraft(dd.dataset.rvddel!); return; }

    const rp = t.closest<HTMLElement>("[data-rvreply]");
    if (rp) { void reply(rp.dataset.rvreply!); return; }
    const rs = t.closest<HTMLElement>("[data-rvresolve]");
    if (rs) { void resolve(rs.dataset.rvresolve!); return; }
    const ta = t.closest<HTMLElement>("[data-rvthagent]");
    if (ta) {
      const th = pr?.threads.find((x) => x.id === ta.dataset.rvthagent);
      if (th && pr) void toAgent(agentBrief(pr, [threadBrief(th)]));
      return;
    }
    if (t.closest<HTMLElement>("[data-rvconv]")) { void converse(); return; }
    // The thread's head is its whole background, so it is probed after every button in it.
    const tf = t.closest<HTMLElement>("[data-rvthfold]");
    if (tf) {
      const id = tf.dataset.rvthfold!;
      const th = pr?.threads.find((x) => x.id === id);
      if (th) threadOpen.set(id, !(threadOpen.get(id) ?? !th.resolved));
      paintBody();
      return;
    }

    // The rail.
    const lay = t.closest<HTMLElement>("[data-drlayout]");
    if (lay) {
      setRailLayout(lay.dataset.drlayout as RailLayout);
      localStorage.setItem("cc-diff-tree", railLayout);
      paintRail();
      return;
    }
    const dir = t.closest<HTMLElement>("[data-drdir]");
    if (dir) { const p = dir.dataset.drdir!; if (!railFolded.delete(p)) railFolded.add(p); paintRail(); return; }
    const row = t.closest<HTMLElement>("[data-drow]");
    if (row) { revealFile(+row.dataset.drow!); return; }

    const fold = t.closest<HTMLElement>("[data-dtoggle]");
    if (fold) {
      const i = +fold.dataset.dtoggle!;
      const f = shown[i];
      if (!f) return;
      if (!collapsed.delete(f.path)) collapsed.add(f.path);
      section(i)?.classList.toggle("collapsed", collapsed.has(f.path));
      if (collapsed.has(f.path)) section(i)?.scrollIntoView({ block: "nearest" });
      paintBar();
      spy();
    }
  });

  // Typed text lives in state, so a repaint (a thread arriving, a range moving) never eats a word.
  $("reviewPane").addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement) grow(t);
    if (t.id === "rvCompText" && compose) compose.text = (t as HTMLTextAreaElement).value;
    else if (t.id === "rvConvText") convText = (t as HTMLTextAreaElement).value;
    else if (t.dataset.rvreplytext) replies.set(t.dataset.rvreplytext, (t as HTMLTextAreaElement).value);
    else if (t.id === "rvSummary") { saveDrafts(draftList(), (t as HTMLTextAreaElement).value); paintFoot(); }
  });
  $("reviewPane").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
    const t = e.target as HTMLElement;
    if (t.id === "rvCompText") { e.preventDefault(); saveCompose(); }
    else if (t.dataset.rvreplytext) { e.preventDefault(); void reply(t.dataset.rvreplytext); }
    else if (t.id === "rvConvText") { e.preventDefault(); void converse(); }
    else if (t.id === "rvSummary") { e.preventDefault(); void submit(); }
  });
  $("rvBody").addEventListener("scroll", spy, { passive: true });
  $("rvEvent").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ev]");
    if (b) { event = b.dataset.ev as ReviewEvent; paintFoot(); }
  });
  $("rvSubmit").addEventListener("click", () => { void submit(); });
  $("rvAgentDraft").addEventListener("click", () => {
    if (pr && draftList().length) void toAgent(agentBrief(pr, draftList().map(draftBrief)));
  });
}

function runAct(act: string, at: HTMLElement) {
  if (act === "refresh") { full = []; void load(false); return; }
  if (act === "merge") { openMerge(at); return; }
  if (act === "ready") { void setReady(true); return; }
  if (act === "draft") { void setReady(false); return; }
  if (act === "session") {
    // With what is still open on it, so the agent starts where the review stands.
    const open = (pr?.threads ?? []).filter((t) => !t.resolved).map(threadBrief);
    void toAgent(pr && open.length ? agentBrief(pr, open) : null);
  }
}
