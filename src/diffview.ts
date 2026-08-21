// The working-set diff viewer: clicking the +N −M card opens a read-only peek at
// what is uncommitted. The backend (git_diff) hands over one combined unified-diff
// patch and parsePatch turns it into files and hunks — that parser is in ./diff and
// is the one piece of this app with thorough tests, which is why nothing here
// re-parses anything. This module only paints the result and owns the overlay.
//
// **This is where "which files moved" gets answered, not the inspector card.** The card
// is four lines of summary in a 300px column and stays that way; anything wider than a
// file count belongs behind its ⤢. So the overlay opens as a *list of files* — every
// section folded, one row each — and unfolds a diff only where asked. It used to open
// with every hunk of every file already expanded: the same information, in the one
// arrangement you cannot skim, which is how a folder with a file viewer in it still
// read as having no way to see which files had moved.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, FILE_MANAGER } from "./dom";
import { basename, esc, escAttr } from "./format";
import { parsePatch, type DiffFile } from "./diff";
import { hunkHtml } from "./inspectorview";

// The footer/overlay menus are exclusive; opening this closes the rest.
let closeFootMenus: (keep?: string) => void = () => {};
export function setDiffCloseFootMenus(fn: typeof closeFootMenus) { closeFootMenus = fn; }

// Clicking the +N −M card opens a read-only peek at the uncommitted diff. The
// backend (git_diff) hands us one combined unified-diff patch; parsePatch turns it
// into files/hunks (in ./diff, unit-tested there). Rendering stays here, in the DOM.
const DSTAT: Record<DiffFile["status"], [string, string]> = {
  modified: ["M", "s-mod"], added: ["A", "s-add"], deleted: ["D", "s-del"], renamed: ["R", "s-ren"],
};
export let diffOpen = false;
// The folder this diff was read from. Patch paths are repo-relative, and the two
// per-row buttons take an absolute one, so it has to survive the await.
let diffDir = "";
// Whether every section is currently unfolded — the state the head button toggles and
// names. Not per-file: the per-file twisties own themselves, this is only the bulk verb.
let allOpen = false;
// One file to open on and scroll to, when the peek was opened *about* it — the explorer
// hands over a path this way. It survives the await like `diffDir` does, and is cleared
// by the next open, so a plain click on the card never inherits the last one.
let focusPath = "";
// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
// own sessions and read-only external ones alike — both are just a git working tree.
export async function openDiff(workdir: string, title: string, focus?: string) {
  if (!workdir) return;
  diffOpen = true;
  diffDir = workdir;
  focusPath = focus || "";
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
  $("diffFold").hidden = true;
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

function renderDiffBody(files: DiffFile[], truncated: boolean) {
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  if (!files.length) { $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`; return; }
  // One file is not a list worth skimming, so it opens on its diff; two or more open as
  // the index. The bulk toggle only earns its place once there is something to skim.
  allOpen = files.length === 1;
  $("diffFold").hidden = files.length < 2;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  const sections = files.map((f, i) => {
    const [glyph, cls] = DSTAT[f.status];
    const name = f.status === "renamed" && f.oldPath
      ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span>${esc(f.path)}`
      : esc(f.path);
    const counts = f.binary ? `<span class="d-bin">binary</span>`
      : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const body = f.binary
      ? `<div class="d-binbody">Binary file, no textual diff.</div>`
      : f.hunks.map(hunkHtml).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
    return `<div class="dfile${allOpen ? "" : " collapsed"}" data-fi="${i}">
      <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${name}</span><span class="dcount">${counts}</span>${rowBtns(f)}</div>
      <div class="dfbody">${body}</div></div>`;
  }).join("");
  const note = truncated ? `<div class="diff-trunc">Diff truncated: too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = sections + note;
  // Opened *about* one file (the explorer's ↵): unfold that one and put it at the top,
  // leaving the rest of the working set folded underneath as context. A path that is no
  // longer in the patch just leaves the index as it was — the file stopped being changed
  // between the two reads, which is a race, not an error.
  if (!focusPath) return;
  const i = files.findIndex((f) => f.path === focusPath);
  if (i < 0) return;
  const el = $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${i}"]`);
  if (!el) return;
  el.classList.remove("collapsed");
  el.scrollIntoView({ block: "start" });
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
});
// Collapse / expand a file section by clicking its header. The open/reveal buttons live
// inside that header and are the document dispatcher's, so a click on one must not also
// fold the row it sits in — same inner-wins rule the dispatcher's own selector encodes.
$("diffBody").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-fopen],[data-freveal]")) return;
  const h = t.closest<HTMLElement>("[data-dtoggle]");
  if (h) h.parentElement!.classList.toggle("collapsed");
});
