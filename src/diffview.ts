// The working-set diff viewer: clicking the +N −M card opens a read-only peek at
// what is uncommitted. The backend (git_diff) hands over one combined unified-diff
// patch and parsePatch turns it into files and hunks — that parser is in ./diff and
// is the one piece of this app with thorough tests, which is why nothing here
// re-parses anything. ./patchview turns those files into markup. This module owns the
// DOM: the dialog, its listeners, the scroll spy, and which mode is current.
//
// **This is where "which files moved" gets answered, not the inspector card.** The card
// is four lines of summary in a 300px column and stays that way; anything wider than a
// file count belongs behind its ⤢. So the overlay opens as a *list of files* — every
// section folded, one row each — and unfolds a diff only where asked. It used to open
// with every hunk of every file already expanded: the same information, in the one
// arrangement you cannot skim, which is how a folder with a file viewer in it still
// read as having no way to see which files had moved.
//
// Expanding, though, put the same wall back one level down. Seven expanded files are
// seven runs of code with nothing between them but a header that has already scrolled
// off, and the only way to answer "which file am I looking at" was to scroll back until
// one appeared. Two things fix that and they are the two a pull request has: an **index**
// that is always on screen (the rail, ./patchview's `railHtml`), and **file headers that
// stick** to the top of the scroller while their file is under the pointer. The rail
// also tracks — the spy below marks whichever file the top of the viewport is inside, so
// the index answers "where am I" as well as "what is there".

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, FILE_MANAGER } from "./dom";
import { basename, esc, escAttr } from "./format";
import { parsePatch, type DiffFile, type DiffMode } from "./diff";
import { fileHtml, railHtml } from "./patchview";
import { diffMode, setDiffMode } from "./state";

// The footer/overlay menus are exclusive; opening this closes the rest.
let closeFootMenus: (keep?: string) => void = () => {};
export function setDiffCloseFootMenus(fn: typeof closeFootMenus) { closeFootMenus = fn; }

export let diffOpen = false;
// The folder this diff was read from. Patch paths are repo-relative, and the two
// per-row buttons take an absolute one, so it has to survive the await.
let diffDir = "";
// The parsed patch, kept so switching layout repaints from memory rather than asking
// git again: the mode toggle is a rendering choice, and re-reading the working tree for
// it would also let the answer change under a click that was not about the answer.
let files: DiffFile[] = [];
// Whether every section is currently unfolded — the state the head button toggles and
// names. Not per-file: the per-file twisties own themselves, this is only the bulk verb.
let allOpen = false;
// One file to open on and scroll to, when the peek was opened *about* it — the explorer
// hands over a path this way. It survives the await like `diffDir` does, and is cleared
// by the next open, so a plain click on the card never inherits the last one.
let focusPath = "";
// Which file the rail is currently marking. Held so the spy can leave the DOM alone on
// the great majority of scroll frames, where the answer has not changed.
let activeFile = -1;

// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
// own sessions and read-only external ones alike — both are just a git working tree.
export async function openDiff(workdir: string, title: string, focus?: string) {
  if (!workdir) return;
  diffOpen = true;
  diffDir = workdir;
  focusPath = focus || "";
  files = [];
  activeFile = -1;
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
  $("diffFold").hidden = true;
  $("diffMode").hidden = true;
  $("diffRail").hidden = true;
  $("diffRail").innerHTML = "";
  $("diffBody").innerHTML = `<div class="diff-empty">Reading the working tree…</div>`;
  try {
    const res = await invoke<{ patch: string; truncated: boolean } | null>("git_diff", { workdir });
    if (!diffOpen) return; // closed while the diff was loading
    renderDiffBody(res ? parsePatch(res.patch) : [], !!res?.truncated);
  } catch (e) {
    if (!diffOpen) return;
    $("diffSub").textContent = "";
    $("diffBody").innerHTML = `<div class="diff-empty">Couldn't read the diff.<br><span class="mono">${esc(String(e))}</span></div>`;
  }
}
// Several dialogs share the one #scrim, so closing any of them must only drop it
// once none of the others are still up.
export function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  dropScrim();
}

/// The two buttons on a file's row: open it, and show it in the file manager. They
/// reuse `data-fopen`/`data-freveal` — the Context card's attributes, already in
/// main.ts's dispatcher and its if-chain — rather than minting a pair of their own,
/// which is why this feature needed no dispatcher change at all. `#diffBody`'s own
/// listener has to skip them, since they sit *inside* the row that folds.
///
/// A deleted file gets neither: both backend commands check `exists()` first and would
/// answer "no longer there", so the honest rendering of the row is no buttons on it.
function rowBtns(f: DiffFile): string {
  if (f.status === "deleted" || !diffDir) return "";
  const abs = escAttr(diffDir.replace(/[\\/]+$/, "") + "/" + f.path);
  return `<span class="dfx">`
    + `<button data-fopen="${abs}" title="Open this file">↗</button>`
    + `<button data-freveal="${abs}" title="Reveal in ${FILE_MANAGER}">⌂</button></span>`;
}

/// A path as [folder, name]. The sort key below, and the same split ./patchview draws.
function dirName(p: string): [string, string] {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
}

function renderDiffBody(parsed: DiffFile[], truncated: boolean) {
  // Sorted by folder, then by name inside it — which is what lets the rail print each
  // folder once. Plain path order does not: `src/dom.ts` sorts before `src/legacy/x.ts`
  // sorts before `src/state.ts`, so `src` would get a heading, lose it, and get a second
  // one. git's own order is no help either (tracked files first, untracked appended), so
  // the index would otherwise end on a second, unexplained alphabet.
  files = parsed.slice().sort((a, b) => {
    const [da, na] = dirName(a.path), [db, nb] = dirName(b.path);
    return da === db ? na.localeCompare(nb) : da.localeCompare(db);
  });
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  if (!files.length) {
    $("diffFold").hidden = true;
    $("diffMode").hidden = true;
    $("diffRail").hidden = true;
    $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`;
    return;
  }
  // One file is not a list worth skimming, so it opens on its diff and needs no index;
  // two or more open as the index. The bulk toggle earns its place on the same count.
  allOpen = files.length === 1;
  $("diffFold").hidden = files.length < 2;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  $("diffMode").hidden = false;
  $("diffRail").hidden = files.length < 2;
  paint(truncated);
  // Opened *about* one file (the explorer's ↵): unfold that one and put it at the top,
  // leaving the rest of the working set folded underneath as context. A path that is no
  // longer in the patch just leaves the index as it was — the file stopped being changed
  // between the two reads, which is a race, not an error.
  if (!focusPath) return;
  const i = files.findIndex((f) => f.path === focusPath);
  if (i >= 0) revealFile(i);
}

/// Paint the body and the rail from `files`. Called on load and on every mode switch;
/// `truncated` is only known on load, so the note is read back off the DOM rather than
/// stored twice.
function paint(truncated: boolean) {
  const note = truncated ? `<div class="diff-trunc">Diff truncated: too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = files.map((f, i) => fileHtml(f, i, diffMode, allOpen, rowBtns(f))).join("") + note;
  $("diffRail").innerHTML = railHtml(files, -1);
  activeFile = -1;
  spy();
}

/// Unfold one file, mark it in the rail and put it at the top of the scroller.
function revealFile(i: number) {
  const el = $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${i}"]`);
  if (!el) return;
  el.classList.remove("collapsed");
  el.scrollIntoView({ block: "start" });
  markRail(i);
}

/// Mark one rail row as current, and keep it in view when the spy moved it there.
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

/// Which file the rail should mark: the one whose header is pinned to the top edge.
///
/// "The last header at or above the edge" is the obvious rule and it is wrong by one
/// file for the whole handoff — an arriving header pushes the outgoing one up, so for
/// the ~30px that takes, the file you are reading is the one *below* the edge while the
/// file the rule names has already ended. Allowing one header's height of slack names
/// whichever header is doing the pinning, which is the name on screen.
///
/// Reading `getBoundingClientRect` per file per frame is a forced layout, so the spy is
/// rAF-coalesced like `renderAll` is, and it writes nothing when the answer is unchanged
/// (`markRail` returns early) — which is every frame but the handful that cross a border.
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

// ---------- the viewer's own event wiring ----------
$("diffClose").addEventListener("click", closeDiff);
// Expand / collapse every section at once. The label says what the click will do, so it
// flips with the state rather than naming the state.
$("diffFold").addEventListener("click", () => {
  allOpen = !allOpen;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  for (const el of $("diffBody").querySelectorAll(".dfile")) el.classList.toggle("collapsed", !allOpen);
  $("diffBody").scrollTop = 0;
  spy();
});
// Unified ↔ side by side. Same button rule as the fold above: it names the layout the
// click will switch *to*, not the one you are in.
$("diffMode").addEventListener("click", () => {
  const m: DiffMode = diffMode === "split" ? "unified" : "split";
  setDiffMode(m);
  localStorage.setItem("cc-diff-mode", m);
  syncModeLabel();
  // Switching layout is a change of *rendering*, so nothing about where you were in the
  // review may move with it. Two things carry over by hand, since `paint` rebuilds from
  // `allOpen` and the scroller: which files you had folded, and which file you were
  // reading. Restoring a raw `scrollTop` would not do — the same hunk is a different
  // height in the two layouts, so the number means something else on the other side.
  const shut = new Set([...$("diffBody").querySelectorAll<HTMLElement>(".dfile.collapsed")].map((el) => el.dataset.fi));
  const here = activeFile;
  paint(!!$("diffBody").querySelector(".diff-trunc"));
  for (const el of $("diffBody").querySelectorAll<HTMLElement>(".dfile")) {
    el.classList.toggle("collapsed", shut.has(el.dataset.fi));
  }
  if (here >= 0) {
    $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${here}"]`)?.scrollIntoView({ block: "start" });
    markRail(here);
  }
});
function syncModeLabel() {
  const split = diffMode === "split";
  $("diffMode").textContent = split ? "unified" : "side by side";
  $("diffMode").title = split ? "Show one column, git's own order" : "Show the old and new versions side by side";
}
syncModeLabel();
// Collapse / expand a file section by clicking its header. The open/reveal buttons live
// inside that header and are the document dispatcher's, so a click on one must not also
// fold the row it sits in — same inner-wins rule the dispatcher's own selector encodes.
$("diffBody").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-fopen],[data-freveal]")) return;
  const h = t.closest<HTMLElement>("[data-dtoggle]");
  if (!h) return;
  const sec = h.parentElement!;
  sec.classList.toggle("collapsed");
  // Folding a file from *inside* it leaves the pointer over whatever moved up into its
  // place, several files further down the list. Scrolling its header back to the top is
  // what keeps the click's subject on screen — and it is where the header already was,
  // since it was stuck there.
  if (sec.classList.contains("collapsed")) sec.scrollIntoView({ block: "nearest" });
  spy();
});
// The index: click a file to unfold it and go there.
$("diffRail").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drow]");
  if (row) revealFile(+row.dataset.drow!);
});
$("diffBody").addEventListener("scroll", spy, { passive: true });
