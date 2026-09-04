// The working-set diff viewer: the dialog, its listeners, the scroll spy and the current
// layout. ./diff parses, ./patchview draws. Shaped like a pull request (an always-on index
// rail, sticky file headers) and opens as a folded list of files; see CLAUDE.md.

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, dropScrim, FILE_MANAGER, toast } from "./dom";
import { basename, esc, escAttr } from "./format";
import { parsePatch, type DiffFile, type DiffMode } from "./diff";
import { chipsHtml, fileHtml, railHtml } from "./patchview";
import { clampHealth, fileChips, findingsText, setChips, type Chip } from "./health";
import { diffMode, setDiffMode } from "./state";
import type { HealthReport } from "./types";

// The footer/overlay menus are exclusive; opening this closes the rest.
let closeFootMenus: (keep?: string) => void = () => {};
export function setDiffCloseFootMenus(fn: typeof closeFootMenus) { closeFootMenus = fn; }

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
export async function openDiff(workdir: string, title: string, focus?: string) {
  if (!workdir) return;
  diffOpen = true;
  diffDir = workdir;
  focusPath = focus || "";
  files = [];
  chips = [];
  healthRep = null;
  activeFile = -1;
  gen++;
  $("scrim").classList.add("show");
  $("diffDlg").classList.add("show");
  $("diffTitle").textContent = title || basename(workdir);
  $("diffSub").textContent = "reading working tree…";
  $("diffFold").hidden = true;
  $("diffMode").hidden = true;
  $("diffCopy").hidden = true;
  $("diffRail").hidden = true;
  $("diffRail").innerHTML = "";
  $("diffBody").innerHTML = `<div class="diff-empty">Reading the working tree…</div>`;
  try {
    const res = await invoke<{ patch: string; truncated: boolean } | null>("git_diff", { workdir });
    if (!diffOpen) return; // closed while the diff was loading
    renderDiffBody(res ? parsePatch(res.patch) : [], !!res?.truncated);
    void measureHealth(workdir, gen);
  } catch (e) {
    if (!diffOpen) return;
    $("diffSub").textContent = "";
    $("diffBody").innerHTML = `<div class="diff-empty">Couldn't read the diff.<br><span class="mono">${esc(String(e))}</span></div>`;
  }
}
export function closeDiff() {
  diffOpen = false;
  $("diffDlg").classList.remove("show");
  dropScrim();
}

// Reuses the Context card's `data-fopen`/`data-freveal`, already in main.ts's dispatcher;
// `#diffBody`'s own listener must skip them. A deleted file gets neither (both check exists()).
function rowBtns(f: DiffFile): string {
  if (f.status === "deleted" || !diffDir) return "";
  const abs = escAttr(diffDir.replace(/[\\/]+$/, "") + "/" + f.path);
  return `<span class="dfx">`
    + `<button data-fopen="${abs}" title="Open this file">↗</button>`
    + `<button data-freveal="${abs}" title="Reveal in ${FILE_MANAGER}">⌂</button></span>`;
}

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
  if (!files.length) {
    $("diffFold").hidden = true;
    $("diffMode").hidden = true;
    $("diffRail").hidden = true;
    $("diffBody").innerHTML = `<div class="diff-empty">No uncommitted changes to show.</div>`;
    return;
  }
  // One file opens on its diff and needs no index; two or more open as the index.
  allOpen = files.length === 1;
  $("diffFold").hidden = files.length < 2;
  $("diffFold").textContent = allOpen ? "collapse all" : "expand all";
  $("diffMode").hidden = false;
  $("diffRail").hidden = files.length < 2;
  paint(truncated);
  // Opened about one file (the explorer's ↵). A path no longer in the patch is a race, not an error.
  if (!focusPath) return;
  const i = files.findIndex((f) => f.path === focusPath);
  if (i >= 0) revealFile(i);
}

// Fired after the diff is on screen, never awaited before it: it reads every file in the
// project. A failure is silent by design; no chips is what an unmeasurable project looks like.
async function measureHealth(workdir: string, mine: number) {
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
  rail.innerHTML = railHtml(files, activeFile, chips);
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
  $("diffBody").innerHTML = files.map((f, i) => fileHtml(f, i, diffMode, allOpen, rowBtns(f), chips[i] ?? [])).join("") + note;
  $("diffRail").innerHTML = railHtml(files, -1, chips);
  activeFile = -1;
  activeFinding = "";
  spy();
}

function revealFile(i: number) {
  const el = $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${i}"]`);
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
  const sec = body.querySelector<HTMLElement>(`.dfile[data-fi="${fi}"]`);
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
  const sec = $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${fi}"]`);
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
// The open/reveal buttons inside the header are the document dispatcher's; inner wins.
$("diffBody").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest("[data-fopen],[data-freveal]")) return;
  const chip = t.closest<HTMLElement>("[data-hline]");
  if (chip) {
    gotoFinding(+(chip.dataset.hfi ?? -1), chip.dataset.hid ?? "", +(chip.dataset.hline ?? 0));
    return;
  }
  const h = t.closest<HTMLElement>("[data-dtoggle]");
  if (!h) return;
  const sec = h.parentElement!;
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
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drow]");
  if (row) revealFile(+row.dataset.drow!);
});
$("diffBody").addEventListener("scroll", spy, { passive: true });
