// The project explorer: ⌘P, one field, two modes.
//
// The third of the app's file lists, and the only one that shows a file nothing has
// happened to. Empty, the field browses the folder you are in; typing turns it into a
// find across the whole project. Both read one index and render one row shape, so the
// scope chips (All / Changed / Touched) are filters rather than three separate screens
// — see ./explore for the rules, which are where the tests are.
//
// What keeps this from being an IDE, in the order the temptations arrive:
//
//   - It is an overlay. It opens, you do one thing, it dies on Escape, exactly like the
//     palette and the peek. There is no pane, no persistent tree, no expansion state.
//   - It is read-only. No create, rename, delete, stage or discard: agents change files
//     and git records it.
//   - It never reads a file's contents. ↵ on a changed file opens the diff in the peek
//     that already exists; anything else is handed to the OS. The app shows you changes;
//     the OS shows you contents.
//   - It does not watch anything. The index is read when the overlay opens and cached
//     for CACHE_MS so reopening is instant; the app has no filesystem watcher by design
//     and this is not the feature that adds one.
//
// DOM-owning and IPC-bound, so untested by design — every rule worth asserting lives in
// ./explore instead.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, FILE_MANAGER } from "./dom";
import { basename, esc, escAttr } from "./format";
import { sessions } from "./state";
import { copyPath, openTouchedFile, revealTouchedFile } from "./actions";
import { openDiff } from "./diffview";
import {
  browseRows, crumbs, findRows, parentDir, rowAction, scopeKeep, touchIndex,
  type ExpRow, type ExpScope,
} from "./explore";
import type { TouchKind } from "./types";

interface FileIndex { files: string[]; truncated: boolean; repo: boolean }
interface ChangedPath { path: string; status: string }

/// How long a project's index is reused. Long enough that closing and reopening the
/// overlay is instant, short enough that a file an agent created a minute ago is there.
/// The dirty marks are never cached — they are one cheap git call and they change constantly.
const CACHE_MS = 30_000;
const indexCache = new Map<string, { at: number; idx: FileIndex }>();

export let explorerOpen = false;
let root = "";
let rootLabel = "";
let paths: string[] = [];
let truncated = false;
let isRepo = true;
let changed = new Map<string, string>();
let touched = new Map<string, TouchKind>();
let cwd = "";
let scope: ExpScope = "all";
// The index arrives one await later, and an empty list means four different things
// (see `emptyText`) — three of which are wrong while it is still being read.
let loading = false;
let rows: ExpRow[] = [];
let sel = 0;

// The overlays are exclusive; opening this closes the footer menus.
let closeFootMenus: (keep?: string) => void = () => {};
export function setExplorerCloseFootMenus(fn: typeof closeFootMenus) { closeFootMenus = fn; }

const TOUCH_GLYPH: Record<TouchKind, string> = { created: "✦", edited: "◆", read: "○" };

export async function openExplorer(dir: string, label?: string) {
  if (!dir) return;
  closeFootMenus();
  // Reopening on a different project resets where you were; reopening on the same one
  // keeps it, because "⌘P, glance, Escape, ⌘P again" is one thought, not two.
  if (dir !== root) { cwd = ""; scope = "all"; }
  root = dir;
  rootLabel = label || basename(dir);
  explorerOpen = true;
  sel = 0;
  loading = true;
  // Reset what belongs to the *previous* project, or its truncation note and its
  // "not a repo" empty state carry over to this one for a frame.
  truncated = false;
  isRepo = true;
  changed = new Map();
  touched = new Map();
  ($("expIn") as HTMLInputElement).value = "";
  $("scrim").classList.add("show");
  $("expDlg").classList.add("show");
  $("expIn").focus();
  $("expCrumb").innerHTML = "";
  paths = [];
  render();

  const cached = indexCache.get(dir);
  const fresh = cached && Date.now() - cached.at < CACHE_MS ? cached.idx : null;
  const [idx, chg] = await Promise.all([
    fresh ? Promise.resolve(fresh) : invoke<FileIndex>("project_files", { root: dir }).catch(() => null),
    invoke<ChangedPath[]>("git_changed", { workdir: dir }).catch(() => [] as ChangedPath[]),
  ]);
  if (!explorerOpen || root !== dir) return; // closed, or moved on, while reading
  loading = false;
  if (idx) {
    // Only a real read restarts the clock. Re-stamping on a cache *hit* would let every
    // reopen inside the window extend it, so a project you glance at every half-minute
    // would never be re-read at all and a file an agent made ten minutes ago would stay
    // missing — the opposite of what CACHE_MS is for.
    if (idx !== fresh) indexCache.set(dir, { at: Date.now(), idx });
    paths = idx.files;
    truncated = idx.truncated;
    isRepo = idx.repo;
  } else {
    paths = [];
    truncated = false;
    isRepo = false;
  }
  changed = new Map((chg || []).map((c) => [c.path, c.status]));
  touched = touchIndex(sessions.values(), dir);
  render();
}

export function closeExplorer() {
  explorerOpen = false;
  $("expDlg").classList.remove("show");
  dropScrim();
}

/// Everything the row shows on its right: what git says, and what an agent did. Both are
/// the marks their own cards already use, so a path reads the same wherever you meet it.
function marks(r: ExpRow): string {
  if (r.dir) return `<span class="exp-n">${r.n}</span>`;
  const out: string[] = [];
  const st = changed.get(r.path);
  if (st) out.push(`<span class="exp-git s-${st === "?" ? "new" : st.toLowerCase()}" title="${st === "?" ? "new, not yet committed" : "changed"}">${st}</span>`);
  const t = touched.get(r.path);
  if (t) out.push(`<span class="exp-t k-${t}" title="${t} by an agent this session">${TOUCH_GLYPH[t]}</span>`);
  return out.join("");
}

function render() {
  const q = ($("expIn") as HTMLInputElement).value.trim();
  const finding = q.length > 0;
  const keep = scopeKeep(scope, changed, touched);
  rows = finding ? findRows(paths, q, keep) : browseRows(paths, cwd, keep);
  if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
  $("expMode").textContent = finding ? "find" : "browse";

  // The breadcrumb is browse's business; in find mode the path is on every row already.
  $("expCrumb").innerHTML = finding
    ? ""
    : crumbs(cwd, rootLabel).map((c, i, a) =>
        (i ? `<span class="sep">/</span>` : "")
        + `<button data-expdir="${escAttr(c.path)}"${i === a.length - 1 ? ' class="here"' : ""}>${esc(c.label)}</button>`).join("");

  for (const s of ["all", "changed", "touched"] as ExpScope[]) {
    $("expScope-" + s).classList.toggle("on", scope === s);
  }
  $("expCount-changed").textContent = String(changed.size);
  $("expCount-touched").textContent = String(touched.size);

  if (!rows.length) {
    $("expList").innerHTML = `<div class="exp-empty">${esc(emptyText(q, finding))}</div>`;
    $("expAct").innerHTML = "";
    return;
  }
  $("expList").innerHTML = rows.map((r, i) => {
    const label = finding ? (r.html ?? esc(r.name)) : esc(r.name);
    return `<div class="exp-row" role="option" id="expRow${i}" aria-selected="${i === sel}" data-expi="${i}">`
      + `<span class="exp-ico${r.dir ? " dir" : ""}">${r.dir ? "▸" : "·"}</span>`
      + `<span class="exp-nm">${label}</span>`
      + `<span class="exp-marks">${marks(r)}</span></div>`;
  }).join("")
    + (truncated ? `<div class="exp-trunc">Index truncated — this folder holds more files than the explorer will list.</div>` : "");
  ($("expIn") as HTMLElement).setAttribute("aria-activedescendant", "expRow" + sel);
  syncAction();
}

/// An empty list has four different causes and only one of them is "no match".
function emptyText(q: string, finding: boolean): string {
  if (loading) return "Reading the project…";
  if (finding) return `Nothing matches “${q}”` + (scope === "all" ? "." : ` in ${scope} files.`);
  if (!paths.length) return isRepo ? "This project has no files git knows about yet." : "Nothing to list in this folder.";
  return scope === "all" ? "This folder is empty." : `Nothing ${scope} in this folder.`;
}

/// What ↵ will do, said before it is pressed. The rule is in ./explore, not here, so the
/// footer and the keypress cannot disagree about it.
function syncAction() {
  const a = rowAction(rows[sel], changed);
  const leaf = (p: string) => esc(p.split("/").pop() || p);
  $("expAct").innerHTML = !a ? ""
    : a.kind === "enter" ? `<b>↵</b> open ${leaf(a.path)}/`
    : a.kind === "diff" ? `<b>↵</b> show what changed in ${leaf(a.path)}`
    : `<b>↵</b> open ${leaf(a.path)} outside`;
}

function select(i: number) {
  if (!rows.length) return;
  sel = Math.max(0, Math.min(rows.length - 1, i));
  for (const el of $("expList").querySelectorAll<HTMLElement>("[data-expi]")) {
    el.setAttribute("aria-selected", String(+el.dataset.expi! === sel));
  }
  $("expList").querySelector<HTMLElement>(`[data-expi="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  ($("expIn") as HTMLElement).setAttribute("aria-activedescendant", "expRow" + sel);
  syncAction();
}

const abs = (rel: string) => root.replace(/[\\/]+$/, "") + "/" + rel;

function activate(i: number) {
  const a = rowAction(rows[i], changed);
  if (!a) return;
  if (a.kind === "enter") {
    cwd = a.path;
    ($("expIn") as HTMLInputElement).value = "";
    sel = 0;
    render();
    $("expIn").focus();
    return;
  }
  if (a.kind === "diff") {
    // The peek is the viewer; it opens on the whole working set with this file unfolded,
    // because "what changed here" is rarely a question about one file in isolation.
    closeExplorer();
    void openDiff(root, rootLabel, a.path);
    return;
  }
  closeExplorer();
  void openTouchedFile(abs(a.path));
}

// ---------- wiring ----------
// The one hint that names an OS app rather than a key, so it is filled in rather than
// written into the markup.
$("expReveal").title = `Show it in ${FILE_MANAGER}`;
$("expClose").addEventListener("click", closeExplorer);
$("expIn").addEventListener("input", () => { sel = 0; render(); });
$("expIn").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); select(sel + 1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); select(sel - 1); }
  else if (e.key === "Home" && !($("expIn") as HTMLInputElement).value) { e.preventDefault(); select(0); }
  else if (e.key === "Enter") {
    e.preventDefault();
    const r = rows[sel];
    if (!r) return;
    // ⌘↵ and ⌥↵ are the row's other two verbs, and both apply to a folder as well as a
    // file — revealing a directory is exactly what you want when you are looking at one.
    if (e.metaKey || e.ctrlKey) { closeExplorer(); void revealTouchedFile(abs(r.path)); }
    else if (e.altKey) { void copyPath(abs(r.path)); }
    else activate(sel);
  } else if (e.key === "Backspace" && !($("expIn") as HTMLInputElement).value && cwd) {
    // Only when the field is empty: inside a query, ⌫ is editing text.
    e.preventDefault();
    cwd = parentDir(cwd);
    sel = 0;
    render();
  }
});
$("expList").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-expi]");
  if (!row) return;
  select(+row.dataset.expi!);
  activate(sel);
});
$("expCrumb").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-expdir]");
  if (!b) return;
  cwd = b.dataset.expdir!;
  sel = 0;
  render();
  $("expIn").focus();
});
$("expBar").addEventListener("click", (e) => {
  const c = (e.target as HTMLElement).closest<HTMLElement>("[data-expscope]");
  if (!c) return;
  scope = c.dataset.expscope as ExpScope;
  sel = 0;
  render();
  $("expIn").focus();
});
