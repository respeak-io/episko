// The working-set diff viewer: clicking the +N −M card opens a read-only peek at
// what is uncommitted. The backend (git_diff) hands over one combined unified-diff
// patch and parsePatch turns it into files and hunks — that parser is in ./diff and
// is the one piece of this app with thorough tests, which is why nothing here
// re-parses anything. This module only paints the result and owns the overlay.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim } from "./dom";
import { basename, esc } from "./format";
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
// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
// own sessions and read-only external ones alike — both are just a git working tree.
export async function openDiff(workdir: string, title: string) {
  if (!workdir) return;
  diffOpen = true;
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
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
function renderDiffBody(files: DiffFile[], truncated: boolean) {
  const tot = files.reduce((a, f) => ({ add: a.add + f.added, rem: a.rem + f.removed }), { add: 0, rem: 0 });
  $("diffSub").innerHTML = files.length
    ? `<span class="add">+${tot.add}</span> <span class="del">−${tot.rem}</span> · ${files.length} file${files.length === 1 ? "" : "s"}`
    : "";
  if (!files.length) { $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`; return; }
  const sections = files.map((f, i) => {
    const [glyph, cls] = DSTAT[f.status];
    const name = f.status === "renamed" && f.oldPath
      ? `<span class="d-old">${esc(f.oldPath)}</span><span class="d-arr">→</span>${esc(f.path)}`
      : esc(f.path);
    const counts = f.binary ? `<span class="d-bin">binary</span>`
      : `<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span>`;
    const body = f.binary
      ? `<div class="d-binbody">Binary file — no textual diff.</div>`
      : f.hunks.map(hunkHtml).join("") || `<div class="d-binbody">No line changes (mode or metadata only).</div>`;
    return `<div class="dfile" data-fi="${i}">
      <div class="dfhead" data-dtoggle="${i}"><span class="dchev">▾</span><span class="dstat ${cls}">${glyph}</span><span class="dpath">${name}</span><span class="dcount">${counts}</span></div>
      <div class="dfbody">${body}</div></div>`;
  }).join("");
  const note = truncated ? `<div class="diff-trunc">Diff truncated — too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = sections + note;
}

// ---------- the viewer's own event wiring ----------
$("diffClose").addEventListener("click", closeDiff);
// Collapse / expand a file section by clicking its header.
$("diffBody").addEventListener("click", (e) => {
  const h = (e.target as HTMLElement).closest<HTMLElement>("[data-dtoggle]");
  if (h) h.parentElement!.classList.toggle("collapsed");
});
