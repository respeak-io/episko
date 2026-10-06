// The working-set diff viewer: the dialog, its listeners, the scroll spy and the current
// layout. ./diff parses, ./patchview draws. Shaped like a pull request (an always-on index
// rail, sticky file headers) and opens as a folded list of files; see CLAUDE.md. It also
// writes: commit, stash and discard over the ticked files, and the repo's stash (./gitops).

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask } from "./confirm";
import { $, dropScrim, FILE_MANAGER, MOD, toast } from "./dom";
import { basename, esc, escAttr } from "./format";
import { hunkBody, parsePatch, type DiffFile, type DiffMode } from "./diff";
import { canDiscardHunk, commitBlock, discardQuestion, filePaths } from "./gitops";
import { chipsHtml, fileHtml, railHtml, stashBarHtml, stashListHtml, type FileActs } from "./patchview";
import { clampHealth, fileChips, findingsText, setChips, type Chip } from "./health";
import { applyPick, emptyPick, pickState, togglePickAll, type Pick, type PickCtx } from "./pick";
import { diffMode, setDiffMode } from "./state";
import type { GitActionResult, HealthReport, StashEntry } from "./types";

// The footer/overlay menus are exclusive; opening this closes the rest.
let closeFootMenus: (keep?: string) => void = () => {};
export function setDiffCloseFootMenus(fn: typeof closeFootMenus) { closeFootMenus = fn; }

// What a write needs from further up: re-polling the folder, a terminal for a refusal's
// command, and whether an agent is mid-turn in the folder a discard is about to change.
export interface DiffHost {
  changed: (dir: string) => void;
  handToTerminal: (dir: string, cmd: string) => void;
  liveAgents: (dir: string) => number;
}
let host: DiffHost = { changed: () => {}, handToTerminal: () => {}, liveAgents: () => 0 };
export function setDiffHost(h: DiffHost) { host = h; }

// "work" is the working set; "stashes" the repo's stash list; "stash" one stash, read-only.
type View = "work" | "stashes" | "stash";
let view: View = "work";
let stashes: StashEntry[] = [];
let shownStash: StashEntry | null = null;
let branchHere = ""; // which stashes are this branch's; the stack is shared by every worktree
let pick: Pick = emptyPick(); // keyed by path, so a reload keeps what you ticked
let workRead = false; // read once this open: a re-read keeps the ticks rather than resetting them
let busy = false; // one write at a time; the foot greys while git works
const drafts = new Map<string, string>(); // a commit message per folder, in memory only

export let diffOpen = false;
let diffDir = ""; // the folder the diff was read from; row buttons need an absolute path
let files: DiffFile[] = []; // kept so a layout switch repaints from memory, not from git
let allOpen = false; // the bulk toggle's state; per-file twisties own themselves
let focusPath = ""; // the file to open on (the explorer's ↵); cleared by the next open
let activeFile = -1; // which file the rail marks; lets the spy skip unchanged frames
// Per file, positionally matching `files`. The diff never waits for this: chips land on a
// second pass, and empty means "no claim", which is what unmeasured must look like too.
let chips: Chip[][] = [];
let healthRep: HealthReport | null = null; // kept so Copy rebuilds the same set-level chips
let gen = 0; // bumped per open; a stale measurement must not paint on a later diff

// Keyed by folder, not session, so external sessions get the same viewer.
// `tab` "stashes" opens on the stash list: the way in when the tree is clean.
export async function openDiff(workdir: string, title: string, focus?: string, tab?: string) {
  if (!workdir) return;
  diffOpen = true;
  diffDir = workdir;
  focusPath = focus || "";
  pick = emptyPick();
  workRead = false;
  stashes = [];
  branchHere = "";
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  ($("diffMsg") as HTMLInputElement).value = drafts.get(workdir) ?? "";
  void invoke<{ branch: string | null } | null>("git_head", { workdir })
    .then((h) => { if (diffDir === workdir) branchHere = h?.branch ?? ""; }).catch(() => {});
  if (tab === "stashes") return showStashes();
  void readStashes(workdir); // the tab's count, beside the diff rather than ahead of it
  await loadWork();
}

function clearBody(sub: string, empty: string) {
  files = [];
  chips = [];
  healthRep = null;
  activeFile = -1;
  $("diffSub").textContent = sub;
  for (const id of ["diffFold", "diffMode", "diffCopy", "diffRail", "diffSetHealth", "diffFoot"]) $(id).hidden = true;
  $("diffRail").innerHTML = "";
  $("diffBody").innerHTML = `<div class="diff-empty">${empty}</div>`;
}

// A re-read after a write keeps folds and scroll by path; ticks are kept in renderDiffBody.
async function loadWork() {
  view = "work";
  syncTabs();
  const mine = ++gen;
  const again = workRead;
  const shut = new Set([...$("diffBody").querySelectorAll<HTMLElement>(".dfile.collapsed")].map((el) => files[+el.dataset.fi!]?.path));
  const top = $("diffBody").scrollTop;
  if (!again) clearBody("reading working tree…", "Reading the working tree…");
  try {
    const res = await invoke<{ patch: string; truncated: boolean } | null>("git_diff", { workdir: diffDir });
    if (!diffOpen || mine !== gen) return; // closed, or moved to another view, while git worked
    renderDiffBody(res ? parsePatch(res.patch) : [], !!res?.truncated);
    if (again) {
      for (const el of $("diffBody").querySelectorAll<HTMLElement>(".dfile")) {
        el.classList.toggle("collapsed", shut.has(files[+el.dataset.fi!]?.path));
      }
      $("diffBody").scrollTop = top;
    }
    void measureHealth(diffDir, mine);
  } catch (e) {
    if (!diffOpen || mine !== gen) return;
    clearBody("", `Couldn't read the diff.<br><span class="mono">${esc(String(e))}</span>`);
  }
}

async function readStashes(dir: string): Promise<void> {
  try {
    const list = await invoke<StashEntry[]>("git_stash_list", { workdir: dir });
    if (diffDir === dir) { stashes = list; syncTabs(); }
  } catch { /* not a repo: no count, and the list says why when opened */ }
}

async function showStashes() {
  view = "stashes";
  shownStash = null;
  const mine = ++gen;
  syncTabs();
  clearBody("", "Reading the stash…");
  try {
    stashes = await invoke<StashEntry[]>("git_stash_list", { workdir: diffDir });
  } catch (e) {
    if (mine === gen) clearBody("", `Couldn't read the stash.<br><span class="mono">${esc(String(e))}</span>`);
    return;
  }
  if (!diffOpen || mine !== gen) return;
  syncTabs();
  $("diffSub").textContent = stashes.length ? "shared by every worktree of this repo" : "";
  $("diffBody").innerHTML = stashListHtml(stashes, branchHere);
}

async function showStash(sha: string) {
  const e = stashes.find((x) => x.sha === sha);
  if (!e) return;
  view = "stash";
  shownStash = e;
  const mine = ++gen;
  clearBody("", "Reading the stash…");
  try {
    const res = await invoke<{ patch: string; truncated: boolean }>("git_stash_diff", { workdir: diffDir, sha });
    if (!diffOpen || mine !== gen) return;
    renderDiffBody(parsePatch(res.patch), res.truncated);
  } catch (err) {
    if (mine === gen) clearBody("", `Couldn't read the stash.<br><span class="mono">${esc(String(err))}</span>`);
  }
}

function syncTabs() {
  for (const b of $("diffTabs").querySelectorAll<HTMLElement>("[data-dtab]")) {
    b.classList.toggle("on", (b.dataset.dtab === "work") === (view === "work"));
  }
  $("diffTabStashes").textContent = stashes.length ? `Stashes · ${stashes.length}` : "Stashes";
}
export function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  dropScrim();
}

// Reuses the Context card's `data-fopen`/`data-freveal`, already in main.ts's dispatcher;
// `#diffBody`'s own listener must skip them. A deleted file gets neither (both check exists()).
function rowBtns(f: DiffFile, i: number): string {
  if (!diffDir) return "";
  const abs = escAttr(diffDir.replace(/[\\/]+$/, "") + "/" + f.path);
  return `<span class="dfx"><button data-ddiscard="${i}" title="Discard changes to this file">↶</button>`
    + (f.status === "deleted" ? "" : `<button data-fopen="${abs}" title="Open this file">↗</button>`
      + `<button data-freveal="${abs}" title="Reveal in ${FILE_MANAGER}">⌂</button>`)
    + `</span>`;
}

// A stash is read-only here: no ticks, no buttons, nothing that would write.
function acts(f: DiffFile, i: number): FileActs {
  if (view !== "work") return { btns: "", tick: null, hunk: () => "" };
  const hunk = (hi: number) => canDiscardHunk(f)
    ? `<button class="dhx" data-dhunk="${i}:${hi}" title="Put this hunk back as the last commit has it">discard hunk</button>`
    : "";
  return { btns: rowBtns(f, i), tick: pick.picked.has(f.path), hunk };
}

const tickFor = (i: number) => (view === "work" && files[i] ? pick.picked.has(files[i].path) : null);

// The sort key below, and the same split ./patchview draws.
function dirName(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
}

function renderDiffBody(parsed: DiffFile[], truncated: boolean) {
  // Folder, then name, so the rail prints each folder once: plain path order interleaves
  // `src/x` with `src/legacy/y`, and git's order appends untracked files as a second alphabet.
  files = parsed.slice().sort((a, b) => {
    const [da, na] = dirName(a.path), [db, nb] = dirName(b.path);
    return da === db ? na.localeCompare(nb) : da.localeCompare(db);
  });
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  // A file that appeared since the last read arrives unticked: an agent may have just written it.
  if (view === "work") {
    const paths = files.map((f) => f.path);
    pick = workRead
      ? { picked: new Set(paths.filter((p) => pick.picked.has(p))), anchor: pick.anchor }
      : { picked: new Set(paths), anchor: "" };
    workRead = true;
  }
  if (!files.length) {
    for (const id of ["diffFold", "diffMode", "diffRail", "diffFoot"]) $(id).hidden = true;
    $("diffBody").innerHTML = (view === "stash" && shownStash ? stashBarHtml(shownStash) : "") + `<div class="diff-empty">${view === "work"
      ? "No uncommitted changes to show." : "This stash holds no changes."}</div>`;
    return;
  }
  // One file opens on its diff and needs no index; two or more open as the index.
  allOpen = files.length === 1;
  $("diffFold").hidden = files.length < 2;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  $("diffMode").hidden = false;
  $("diffRail").hidden = files.length < 2;
  paint(truncated);
  syncFoot();
  // Opened about one file (the explorer's ↵). A path no longer in the patch is a race, not an error.
  if (!focusPath) return;
  const i = files.findIndex((f) => f.path === focusPath);
  if (i >= 0) revealFile(i);
}

// Fired after the diff is on screen, never awaited before it: it reads every file in the
// project. A failure is silent by design; no chips is what an unmeasurable project looks like.
async function measureHealth(workdir: string, mine: number) {
  if (view !== "work") return; // a stash is read, not reviewed
  // Binary and deleted files would come back `measured: false`; skip the round trip.
  const changed = files
    .filter((f) => !f.binary && f.status !== "deleted")
    .map((f) => ({
      path: f.path,
      // New-file line numbers only; ./diff stays the only patch parser.
      added: f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newNo ?? 0)).filter(Boolean),
    }));
  if (!changed.length) return;
  let rep: HealthReport | null = null;
  try {
    rep = await invoke<HealthReport>("project_health", { workdir, changed });
  } catch {
    return;
  }
  if (!diffOpen || mine !== gen) return; // closed, or reopened on another folder, meanwhile
  healthRep = rep;
  const byPath = new Map(rep.files.map((h) => [h.path, h]));
  const prefs = clampHealth(rep.prefs);
  chips = files.map((f) => fileChips(f, byPath.get(f.path), rep, prefs));
  renderSetChips(rep);
  applyChips();
  // A button that copies "no findings" has to be tried to find out.
  $("diffCopy").hidden = !chips.some((c) => c.length) && !setChips(files, rep).length;
}

// Inserts into the DOM already on screen rather than repainting: a repaint would reset every
// fold, lose the scroll position and destroy the node under the pointer (docs/architecture.md).
function applyChips() {
  const body = $("diffBody");
  for (let i = 0; i < files.length; i++) {
    const host = body.querySelector<HTMLElement>(`.dfile[data-fi="${i}"] > .dftop`);
    if (!host) continue;
    const html = chipsHtml(chips[i] ?? [], i);
    const had = host.querySelector<HTMLElement>(":scope > .dhealth");
    if (!html) had?.remove();
    else if (!had) host.insertAdjacentHTML("beforeend", html);
    else if (had.outerHTML !== html) had.outerHTML = html;
  }
  // The rail holds no fold state, but it scrolls; keep that.
  const rail = $("diffRail");
  const keep = rail.scrollTop;
  rail.innerHTML = railHtml(files, activeFile, chips, tickFor);
  rail.scrollTop = keep;
}

// Findings about the change as a whole, said once rather than once per file.
function renderSetChips(rep: HealthReport | null) {
  const set = setChips(files, rep, !!$("diffBody").querySelector(".diff-trunc"));
  const el = $("diffSetHealth");
  el.innerHTML = set
    .map((c) => `<span class="hchip ${c.sev} flat" title="${escAttr(c.title)}">${esc(c.text)}</span>`)
    .join("");
  el.hidden = !set.length;
}

// `truncated` is only known on load; a mode switch reads the note back off the DOM.
function paint(truncated: boolean) {
  const note = truncated ? `<div class="diff-trunc">Diff truncated: too large to show in full. Open a terminal for the complete diff.</div>` : "";
  const bar = view === "stash" && shownStash ? stashBarHtml(shownStash) : "";
  $("diffBody").innerHTML = bar + files.map((f, i) => fileHtml(f, i, diffMode, allOpen, acts(f, i), chips[i] ?? [])).join("") + note;
  $("diffRail").innerHTML = railHtml(files, -1, chips, tickFor);
  activeFile = -1;
  activeFinding = "";
  spy();
}

// The one way from a file's index to its section. Never walk up from the header: `.dfhead`
// shares the sticky `.dftop` box with its chips, so `parentElement` is that box rather than
// the file, and the fold toggle spent a release putting `collapsed` on the wrong element.
const fileSection = (i: number) => $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${i}"]`);

function revealFile(i: number) {
  const el = fileSection(i);
  if (!el) return;
  el.classList.remove("collapsed");
  el.scrollIntoView({ block: "start" });
  markRail(i);
}

// `<file index>:<chip id>`, or "". A selection, not a flash: it stays lit until you pick another.
let activeFinding = "";

let markStep = 0; // which of the selected finding's places we last went to; the chip walks them

// Returns the line to scroll to, or 0. A different chip selects it and goes to its first
// place; the lit one again advances, or puts itself out when it has only one place.
function selectFinding(fi: number, id: string): number {
  const body = $("diffBody");
  for (const el of body.querySelectorAll(".hmark")) el.classList.remove("hmark");
  for (const el of body.querySelectorAll(".hchip.on")) el.classList.remove("on");

  const chip = chips[fi]?.find((c) => c.id === id);
  const sec = fileSection(fi);
  const key = `${fi}:${id}`;
  const again = activeFinding === key;
  const stops = chip?.places ?? [];
  if (again && stops.length < 2) { activeFinding = ""; return 0; }
  markStep = again ? markStep + 1 : 0;
  activeFinding = key;
  if (!chip || !sec) return 0;

  sec.querySelector(`.hchip[data-hid="${id}"]`)?.classList.add("on");
  for (const n of chip.lines) {
    // Side by side splits a row: the number cell carries the anchor, the code beside it is lit too.
    for (const el of sec.querySelectorAll<HTMLElement>(`[data-ln="${n}"]`)) {
      el.classList.add("hmark");
      if (el.classList.contains("sn")) el.nextElementSibling?.classList.add("hmark");
    }
  }
  return stops.length ? stops[markStep % stops.length] : 0;
}

// Null when the file has no numbered rows at all (a binary or mode-only change).
function nearestLine(sec: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (const el of sec.querySelectorAll<HTMLElement>("[data-ln]")) {
    const d = Math.abs(+el.dataset.ln! - line);
    if (d < gap) { gap = d; best = el; }
  }
  return best;
}

// `line` is a new-file number, so only added and context rows carry `data-ln`. A line
// outside every hunk is not in the DOM and falls back to the nearest rendered row of the file.
function gotoFinding(fi: number, id: string, fallback: number) {
  const sec = fileSection(fi);
  if (!sec) return;
  sec.classList.remove("collapsed");
  const line = selectFinding(fi, id) || fallback;
  if (!activeFinding) return; // a second click on the lit chip: put it out, stay put
  const row = line
    ? sec.querySelector<HTMLElement>(`[data-ln="${line}"]`) ?? nearestLine(sec, line)
    : null;
  (row ?? sec).scrollIntoView({ block: row ? "center" : "start" });
}

function markRail(i: number) {
  if (i === activeFile) return;
  activeFile = i;
  const rail = $("diffRail");
  for (const el of rail.querySelectorAll(".dr-row.on")) el.classList.remove("on");
  const row = rail.querySelector<HTMLElement>(`.dr-row[data-drow="${i}"]`);
  if (!row) return;
  row.classList.add("on");
  const rb = rail.getBoundingClientRect(), b = row.getBoundingClientRect();
  if (b.top < rb.top || b.bottom > rb.bottom) row.scrollIntoView({ block: "nearest" });
}

// Marks the file whose header is pinned to the top edge, with one header's height of slack:
// during a handoff the arriving header pushes the outgoing one up, and "last header above the
// edge" is wrong by one file. rAF-coalesced, since getBoundingClientRect per file forces layout.
let spyDue = false;
function spy() {
  if (spyDue) return;
  spyDue = true;
  requestAnimationFrame(() => {
    spyDue = false;
    if (!diffOpen || $("diffRail").hidden) return;
    const top = $("diffBody").getBoundingClientRect().top + 1;
    let hit = 0;
    const heads = $("diffBody").querySelectorAll<HTMLElement>(".dfhead");
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= top + heads[i].offsetHeight) hit = i;
      else break;
    }
    markRail(hit);
  });
}

// ---------- the write verbs: commit, stash, discard (./gitops says what each may touch) ----------

const pickCtx = (range = false): PickCtx => {
  const order = files.map((f) => f.path);
  return { order, pickable: new Set(order), range };
};
const pickedFiles = () => files.filter((f) => pick.picked.has(f.path));
const msgEl = () => $("diffMsg") as HTMLInputElement;

// Ticks change in place, never by repainting: a repaint resets every fold and the scroll.
function syncTicks() {
  for (const el of document.querySelectorAll<HTMLElement>("#diffDlg [data-dpick]")) {
    const on = pick.picked.has(files[+el.dataset.dpick!]?.path ?? "");
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", String(on));
  }
  syncFoot();
}

function syncFoot() {
  const foot = $("diffFoot");
  foot.hidden = view !== "work" || !files.length;
  if (foot.hidden) return;
  const n = pickedFiles().length;
  const st = pickState(pickCtx(), pick.picked);
  const all = $("diffPickAll");
  all.classList.toggle("on", st === "all");
  all.classList.toggle("some", st === "some");
  all.setAttribute("aria-checked", st === "all" ? "true" : st === "some" ? "mixed" : "false");
  $("diffPicked").textContent = `${n} of ${files.length}`;
  const block = commitBlock(msgEl().value, n);
  const commit = $("diffCommit") as HTMLButtonElement;
  commit.disabled = busy || !!block;
  commit.title = block || `Commit the ticked files (${MOD}+Enter)`;
  commit.textContent = busy ? "working…" : n === files.length ? "Commit all" : `Commit ${n}`;
  for (const id of ["diffStash", "diffDiscard"]) ($(id) as HTMLButtonElement).disabled = busy || !n;
}

// One write at a time. A refusal that names a command hands it to a terminal, as git_action's do.
async function write(what: string, call: () => Promise<GitActionResult>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  syncFoot();
  const dir = diffDir;
  try {
    const r = await call();
    if (r.ok) toast(`${what}: ${r.summary}`);
    else if (r.suggest) {
      toast(`${what}: ${r.summary} → opening a terminal`);
      host.handToTerminal(dir, r.suggest);
    } else toast(`${what}: ${r.summary}`);
    return r.ok;
  } catch (e) {
    toast(`${what}: ${e}`);
    return false;
  } finally {
    busy = false;
    host.changed(dir);
    if (diffOpen && diffDir === dir) syncFoot();
  }
}

async function commitPicked() {
  const sel = pickedFiles();
  const message = msgEl().value;
  if (busy || commitBlock(message, sel.length)) return;
  const ok = await write("commit", () => invoke<GitActionResult>("git_commit", { workdir: diffDir, message, paths: filePaths(sel) }));
  if (ok) { msgEl().value = ""; drafts.delete(diffDir); }
  if (diffOpen) await loadWork();
}

// The message box names the stash when it holds anything; git's `WIP on …` otherwise.
async function stashPicked() {
  const sel = pickedFiles();
  if (busy || !sel.length) return;
  const message = msgEl().value.trim() || null;
  const ok = await write("stash", () => invoke<GitActionResult>("git_stash", { workdir: diffDir, op: "push", sha: null, message, paths: filePaths(sel) }));
  if (ok) void readStashes(diffDir);
  if (diffOpen) await loadWork();
}

async function discardFiles(sel: DiffFile[]) {
  if (busy || !sel.length) return;
  const q = discardQuestion(sel, host.liveAgents(diffDir));
  if (!await ask(q.message, { title: q.title, kind: "warning", okLabel: q.okLabel })) return;
  await write("discard", () => invoke<GitActionResult>("git_discard", { workdir: diffDir, paths: filePaths(sel) }));
  if (diffOpen) await loadWork();
}

async function discardHunk(fi: number, hi: number) {
  const f = files[fi], h = f?.hunks[hi];
  if (busy || !f || !h) return;
  const ok = await ask(`This hunk of \`${f.path}\` goes back to how the last commit has it.\n\nThis cannot be undone.`,
    { title: "Discard this hunk?", kind: "warning", okLabel: "Discard" });
  if (!ok) return;
  await write("discard", () => invoke<GitActionResult>("git_discard_hunk", { workdir: diffDir, path: f.path, at: h.at, body: hunkBody(h) }));
  if (diffOpen) await loadWork();
}

async function stashOp(op: string, sha: string) {
  if (busy) return;
  const e = stashes.find((x) => x.sha === sha);
  if (op === "drop" && !await ask(`"${e?.message || sha.slice(0, 7)}" is deleted from the repo's stash.\n\nThis cannot be undone.`,
    { title: "Drop this stash?", kind: "warning", okLabel: "Drop" })) return;
  const ok = await write(`stash ${op}`, () => invoke<GitActionResult>("git_stash", { workdir: diffDir, op, sha, message: null, paths: [] }));
  if (!diffOpen) return;
  // Applied: the changes are what you came to see. Gone from the list: back to the list.
  if (ok && op !== "drop") await loadWork();
  else if (view === "stash" && !(ok && op === "drop")) await showStash(sha);
  else await showStashes();
}

// ---------- the viewer's own event wiring ----------
$("diffClose").addEventListener("click", closeDiff);
// The label says what the click will do, not the state.
$("diffFold").addEventListener("click", () => {
  allOpen = !allOpen;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  for (const el of $("diffBody").querySelectorAll(".dfile")) el.classList.toggle("collapsed", !allOpen);
  $("diffBody").scrollTop = 0;
  spy();
});
// Names the layout the click switches to, like the fold button.
$("diffMode").addEventListener("click", () => {
  const m: DiffMode = diffMode === "split" ? "unified" : "split";
  setDiffMode(m);
  localStorage.setItem("cc-diff-mode", m);
  syncModeLabel();
  // A layout change must not move the review: folds and the current file carry over by hand.
  // A raw scrollTop would not do, since the same hunk is a different height in the two layouts.
  const shut = new Set([...$("diffBody").querySelectorAll<HTMLElement>(".dfile.collapsed")].map((el) => el.dataset.fi));
  const here = activeFile;
  paint(!!$("diffBody").querySelector(".diff-trunc"));
  for (const el of $("diffBody").querySelectorAll<HTMLElement>(".dfile")) {
    el.classList.toggle("collapsed", shut.has(el.dataset.fi));
  }
  if (here >= 0) {
    fileSection(here)?.scrollIntoView({ block: "start" });
    markRail(here);
  }
});
function syncModeLabel() {
  const split = diffMode === "split";
  $("diffMode").textContent = split ? "unified" : "side by side";
  $("diffMode").title = split ? "Show one column, git's own order" : "Show the old and new versions side by side";
}
syncModeLabel();
// The open/reveal buttons inside the header are the document dispatcher's; inner wins.
$("diffBody").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-fopen],[data-freveal]")) return;
  if (onWriteClick(e, t)) return;
  const chip = t.closest<HTMLElement>("[data-hline]");
  if (chip) {
    gotoFinding(+(chip.dataset.hfi ?? -1), chip.dataset.hid ?? "", +(chip.dataset.hline ?? 0));
    return;
  }
  const h = t.closest<HTMLElement>("[data-dtoggle]");
  if (!h) return;
  const sec = fileSection(+h.dataset.dtoggle!);
  if (!sec) return;
  sec.classList.toggle("collapsed");
  // Folding from inside a file leaves the pointer over whatever moved up; keep its header on screen.
  if (sec.classList.contains("collapsed")) sec.scrollIntoView({ block: "nearest" });
  spy();
});
// Findings as text for a session to act on; the plugin, never `navigator.clipboard` (CLAUDE.md).
$("diffCopy").addEventListener("click", () => {
  const title = `${$("diffTitle").textContent} · ${$("diffSub").textContent}`.trim();
  const text = findingsText(title, files, chips, setChips(files, healthRep, !!$("diffBody").querySelector(".diff-trunc")));
  void writeText(text)
    .then(() => toast("Findings copied — paste them into a session"))
    .catch(() => toast("Couldn't reach the clipboard"));
});
$("diffRail").addEventListener("click", (e) => {
  if (onWriteClick(e, e.target as HTMLElement)) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drow]");
  if (row) revealFile(+row.dataset.drow!);
});
$("diffBody").addEventListener("scroll", spy, { passive: true });

// Ticks, the per-file and per-hunk discards and the stash buttons, in body and rail alike.
// True when the click was one of them, so the fold toggle under a tick never fires too.
function onWriteClick(e: MouseEvent, t: HTMLElement): boolean {
  const tick = t.closest<HTMLElement>("[data-dpick]");
  if (tick) {
    const f = files[+tick.dataset.dpick!];
    if (f) pick = applyPick(pick, f.path, pickCtx(e.shiftKey));
    syncTicks();
    return true;
  }
  const one = t.closest<HTMLElement>("[data-ddiscard]");
  if (one) {
    const f = files[+one.dataset.ddiscard!];
    if (f) void discardFiles([f]);
    return true;
  }
  const hunk = t.closest<HTMLElement>("[data-dhunk]");
  if (hunk) {
    const [fi, hi] = hunk.dataset.dhunk!.split(":").map(Number);
    void discardHunk(fi, hi);
    return true;
  }
  const st = t.closest<HTMLElement>("[data-dstash]");
  if (st) {
    const op = st.dataset.dstash!, sha = st.dataset.dsha ?? "";
    if (op === "list") void showStashes();
    else if (op === "view") void showStash(sha);
    else void stashOp(op, sha);
    return true;
  }
  return false;
}

$("diffTabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-dtab]");
  if (!b || busy) return;
  if (b.dataset.dtab === "work" && view !== "work") void loadWork();
  else if (b.dataset.dtab === "stashes" && view !== "stashes") void showStashes();
});
$("diffPickAll").addEventListener("click", () => { pick = togglePickAll(pick, pickCtx()); syncTicks(); });
$("diffMsg").addEventListener("input", () => { drafts.set(diffDir, msgEl().value); syncFoot(); });
$("diffMsg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commitPicked(); }
});
$("diffCommit").addEventListener("click", () => { void commitPicked(); });
$("diffStash").addEventListener("click", () => { void stashPicked(); });
$("diffDiscard").addEventListener("click", () => { void discardFiles(pickedFiles()); });
