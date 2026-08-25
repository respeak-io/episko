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
// What the change did to the shape of the code, once `project_health` answers — and the
// chips ./health derived from it, one list per file, positionally matching `files`.
//
// **The diff never waits for this.** The measurement reads every file in the project, so
// it arrives a moment after the patch does; the overlay paints the diff first and the
// chips land on the second pass. That ordering is the whole reason the cost is
// affordable, and it is why `chips` starts empty rather than undefined: a file with no
// chips and a file not yet measured render identically, which is correct — neither is
// making a claim.
let chips: Chip[][] = [];
// The report those chips came from, kept so the copy handler can rebuild the SAME
// set-level chips the gate below and `renderSetChips` computed. It improvised with
// `null` before, which dropped "partial sweep" / "findings incomplete" from the copied
// text — precisely the caveat ./health added them to carry — and, when those were the
// only findings, showed a button that copied "No code-health findings".
let healthRep: HealthReport | null = null;
// Bumped by every open, and captured by the measurement in flight. An answer whose
// generation is stale belongs to a diff that is no longer on screen: opening one folder,
// closing it and opening another must not paint the first one's chips on the second.
let gen = 0;

// Keyed by folder (workdir/cwd), not session id, so the same viewer serves Episko's
// own sessions and read-only external ones alike — both are just a git working tree.
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

/// Ask the backend what this change did to the shape of the code, and repaint when it
/// answers.
///
/// Fired *after* the diff is on screen, never awaited before it. The measurement reads
/// every file in the project to build its duplicate index, so it costs tens of
/// milliseconds where the patch costs one process — and a review surface that waited for
/// it would feel slow for a signal that is advisory. A failure is silent by design: no
/// chips is exactly what a project it could not measure should look like, and an error
/// banner over a diff you asked for would be the tail wagging the dog.
async function measureHealth(workdir: string, mine: number) {
  // A binary file has no lines to measure and a deleted one has nothing on disk; both
  // would come back `measured: false`, so they are not worth the round trip.
  const changed = files
    .filter((f) => !f.binary && f.status !== "deleted")
    .map((f) => ({
      path: f.path,
      // New-file line numbers of the added lines — the text stays here, since ./diff is
      // the only patch parser and sending it back would make the backend a second one.
      added: f.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newNo ?? 0)).filter(Boolean),
    }));
  if (!changed.length) return;
  let rep: HealthReport | null = null;
  try {
    rep = await invoke<HealthReport>("project_health", { workdir, changed });
  } catch {
    return;
  }
  // The overlay may have been closed, or reopened on another folder, while we measured.
  if (!diffOpen || mine !== gen) return;
  healthRep = rep;
  const byPath = new Map(rep.files.map((h) => [h.path, h]));
  // The project's own thresholds when it set any, the defaults where it did not.
  const prefs = clampHealth(rep.prefs);
  chips = files.map((f) => fileChips(f, byPath.get(f.path), rep, prefs));
  renderSetChips(rep);
  applyChips();
  // Only offered when there is something to hand over. A button that copies "no findings"
  // is a button that has to be tried to find out.
  $("diffCopy").hidden = !chips.some((c) => c.length) && !setChips(files, rep).length;
}

/// Put the chips into the diff that is already on screen, rather than repainting it.
///
/// This arrives a beat *after* you started reading, so a repaint here is not a free
/// redraw: it would reset every fold, throw away where you had scrolled to, and destroy
/// whatever node the pointer was over — which is how a click gets silently dropped
/// (`docs/architecture.md`). So the chips are inserted into each file's existing body and
/// the rail is rebuilt in place with its scroll kept.
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
  // The rail carries no fold state and nothing of yours lives in it, so rebuilding is
  // safe — but it can be scrolled, and losing that would move the index under you.
  const rail = $("diffRail");
  const keep = rail.scrollTop;
  rail.innerHTML = railHtml(files, activeFile, chips);
  rail.scrollTop = keep;
}

/// The findings that are about the change rather than any one file in it, beside the
/// totals. One line, not one per file: the same finding repeated five times reads as
/// five findings.
function renderSetChips(rep: HealthReport | null) {
  const set = setChips(files, rep, !!$("diffBody").querySelector(".diff-trunc"));
  const el = $("diffSetHealth");
  el.innerHTML = set
    .map((c) => `<span class="hchip ${c.sev} flat" title="${escAttr(c.title)}">${esc(c.text)}</span>`)
    .join("");
  el.hidden = !set.length;
}

/// Paint the body and the rail from `files`. Called on load and on every mode switch;
/// `truncated` is only known on load, so the note is read back off the DOM rather than
/// stored twice.
function paint(truncated: boolean) {
  const note = truncated ? `<div class="diff-trunc">Diff truncated: too large to show in full. Open a terminal for the complete diff.</div>` : "";
  $("diffBody").innerHTML = files.map((f, i) => fileHtml(f, i, diffMode, allOpen, rowBtns(f), chips[i] ?? [])).join("") + note;
  $("diffRail").innerHTML = railHtml(files, -1, chips);
  activeFile = -1;
  activeFinding = "";
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

/// Which finding is currently selected, as `<file index>:<chip id>`, or "" for none.
///
/// A *selection*, not a flash. The first cut animated the target line for 1.6s and faded
/// it out, which answered "did the click register" and nothing else: by the time your eye
/// reached the line the mark was already going, and a `dup ×3` marked one of its three
/// places. A finding now stays lit until you pick another or click it again — you can
/// scroll away, read around it and come back, which is what reviewing actually is.
let activeFinding = "";

/// Which of the selected finding's places we last went to. A `dup ×2` is two blocks fifty
/// lines apart and only one of them fits on screen, so the chip is also the control that
/// walks between them.
let markStep = 0;

/// Light every line a finding covers, light its chip, and answer where to go.
///
/// Returns the line to scroll to, or 0 to stay put. Clicking a *different* chip selects it
/// and goes to its first place; clicking the lit one again advances to its next. A finding
/// with only one place puts itself out instead — cycling a single mark would look like a
/// control that does nothing.
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
    // Unified draws a row per line; side-by-side splits it, so the number cell carries
    // the anchor and the code beside it has to be lit with it.
    for (const el of sec.querySelectorAll<HTMLElement>(`[data-ln="${n}"]`)) {
      el.classList.add("hmark");
      if (el.classList.contains("sn")) el.nextElementSibling?.classList.add("hmark");
    }
  }
  return stops.length ? stops[markStep % stops.length] : 0;
}

/// The rendered line closest to `line` inside one file's section, or null when the file
/// has no numbered rows at all (a binary or mode-only change).
function nearestLine(sec: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (const el of sec.querySelectorAll<HTMLElement>("[data-ln]")) {
    const d = Math.abs(+el.dataset.ln! - line);
    if (d < gap) { gap = d; best = el; }
  }
  return best;
}

/// Go to the line a chip is about, and mark it briefly so the eye lands on it.
///
/// `line` is a *new-file* line number, which is why only added and context rows carry a
/// `data-ln` — a finding never points at a deletion, since there is nothing there to look
/// at. A line the patch does not show (a complex function whose signature sits outside
/// any hunk) falls back to the file, which is still the right neighbourhood.
function gotoFinding(fi: number, id: string, fallback: number) {
  const sec = $("diffBody").querySelector<HTMLElement>(`.dfile[data-fi="${fi}"]`);
  if (!sec) return;
  sec.classList.remove("collapsed");
  const line = selectFinding(fi, id) || fallback;
  if (!activeFinding) return; // it was a second click on the lit chip: put it out, stay put
  // ./health aims every finding at a line the change added, so the exact row is normally
  // there. The fallback is for the case it cannot: a patch shows only its hunks, so a
  // line outside one is simply not in the DOM — and scrolling to the file while marking
  // nothing is indistinguishable from a control that does not work. The nearest rendered
  // line of the same file is at least in the right neighbourhood.
  const row = line
    ? sec.querySelector<HTMLElement>(`[data-ln="${line}"]`) ?? nearestLine(sec, line)
    : null;
  (row ?? sec).scrollIntoView({ block: row ? "center" : "start" });
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
  // A health chip: go to the line that earned it. Chips sit inside the file body rather
  // than its header, so this cannot be confused with the fold — but it is tested first
  // anyway, on the same inner-wins rule the rest of this listener follows.
  const chip = t.closest<HTMLElement>("[data-hline]");
  if (chip) {
    gotoFinding(+(chip.dataset.hfi ?? -1), chip.dataset.hid ?? "", +(chip.dataset.hline ?? 0));
    return;
  }
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
// The findings, as text you can paste into a session.
//
// The whole premise is that you are reviewing work you did not type, so the fix will not
// be typed by you either — and a chip you can only look at makes you the courier between
// the two. `tauri-plugin-clipboard-manager` rather than `navigator.clipboard`, which
// raises an OS permission prompt (CLAUDE.md).
$("diffCopy").addEventListener("click", () => {
  const title = `${$("diffTitle").textContent} · ${$("diffSub").textContent}`.trim();
  const text = findingsText(title, files, chips, setChips(files, healthRep, !!$("diffBody").querySelector(".diff-trunc")));
  void writeText(text)
    .then(() => toast("Findings copied — paste them into a session"))
    .catch(() => toast("Couldn't reach the clipboard"));
});
// The index: click a file to unfold it and go there.
$("diffRail").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drow]");
  if (row) revealFile(+row.dataset.drow!);
});
$("diffBody").addEventListener("scroll", spy, { passive: true });
