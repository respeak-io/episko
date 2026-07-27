// The project context menu and the appearance panel it shares with the sidebar's
// colour dots. One module because they are one interaction: the panel opens either
// standalone at the cursor or as the menu's Appearance submenu, and each closes the
// other — the panel clears the menu's `.sub-open` row, and every button in it commits
// and so closes the whole stack.
//
// Cosmetic, in Phase-1 terms: nothing here is on renderAll()'s path. It paints on
// right-click and on a dot click, and nowhere else.

import { invoke } from "@tauri-apps/api/core";
import { $, IS_MAC, IS_WIN, toast } from "./dom";
import { basename, esc, tilde } from "./format";
import { closeFootMenus } from "./footer";
import { clearIcon, customIcons, iconFor, pickCustomIcon, resetCustomIcon } from "./icons";
import { openWt } from "./worktree";
import { isAgent } from "./types";
import {
  accentFor, activeId, colorOverrides, engineDef, FAVORITES, sessions, termEngine,
} from "./state";

// The six things a menu row does that this module does not own — panes, the project
// list and the repaint all belong to main.ts. Past the ~4 where per-callee setters
// stop reading as anything but noise, so it takes one host (settings.ts's deviation).
let host: {
  renderAll: () => void;
  requestLaunch: (project: string, path: string) => void;
  launchShell: (project: string, workdir: string, opts: { colorKey?: string }) => void;
  openProjectFolder: (key: string) => void;
  addProjectPath: (dir: string) => void;
  removeFavorite: (path: string) => void;
} = {
  renderAll: () => {}, requestLaunch: () => {}, launchShell: () => {},
  openProjectFolder: () => {}, addProjectPath: () => {}, removeFavorite: () => {},
};
export function setProjMenuHost(h: typeof host) { host = h; }

// recolor a project — click its color dot, or right-click the project
// 12 perceptually distinct hues around the wheel
const SWATCHES = ["#f2555a", "#fb923c", "#facc15", "#a3e635", "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#d084f5", "#f472b6"];
let popKey: string | null = null;
function normalizeHex(v: string): string | null {
  let x = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(x)) x = x.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(x) ? "#" + x.toLowerCase() : null;
}
// Show a floating panel, then clamp it inside the viewport against its *measured*
// size — these panels change height with their optional rows, so a hard-coded
// estimate would hang them off-screen.
function placePop(el: HTMLElement, x: number, y: number) {
  el.classList.add("show");
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + "px";
}
// The appearance panel: colour swatches + logo. Opens standalone at the cursor
// (clicking a colour dot) or as the context menu's submenu — `flipFrom` is the
// parent menu's rect, so a panel that won't fit to its right lands on its left
// instead of being shoved back over the menu it belongs to.
export function openColorPopover(key: string, x: number, y: number, flipFrom?: DOMRect) {
  popKey = key;
  closeFootMenus("colorPop");
  const cur = accentFor(key).toLowerCase();
  const pop = $("colorPop");
  pop.innerHTML =
    SWATCHES.map((c) => `<button class="sw-btn ${c === cur ? "on" : ""}" style="background:${c}" data-c="${c}"></button>`).join("") +
    `<div class="sw-row"><input class="sw-hex" type="text" spellcheck="false" placeholder="#hex" value="${cur}" maxlength="7" /><button class="sw-apply">Set</button></div>` +
    `<button class="sw-auto" data-c="auto">Auto color</button>` +
    `<button class="sw-auto" data-c="seticon">Set custom logo…</button>` +
    (customIcons[key] ? `<button class="sw-auto" data-c="reseticon">Restore repo logo</button>` : "") +
    (iconFor(key) ? `<button class="sw-auto" data-c="delicon">Use color dot (hide icon)</button>` : "");
  pop.classList.add("show"); // shown before measuring, or offsetWidth reads 0
  if (flipFrom && x + pop.offsetWidth > window.innerWidth - 8) x = flipFrom.left - pop.offsetWidth - 6;
  placePop(pop, x, y);
}
export function closeColorPop() {
  $("colorPop").classList.remove("show");
  popKey = null;
  $("ctxMenu").querySelector(".sub-open")?.classList.remove("sub-open");
}
function applyColor(key: string) {
  host.renderAll();
  const s = activeId ? sessions.get(activeId) : null;
  if (s && s.colorKey === key) document.documentElement.style.setProperty("--accent", accentFor(s.colorKey));
}
function setColor(key: string, hex: string | null) {
  if (hex === null) delete colorOverrides[key]; else colorOverrides[key] = hex;
  localStorage.setItem("cc-colors", JSON.stringify(colorOverrides));
  closeColorPop();
  applyColor(key);
}
function commitHex(v: string) {
  if (!popKey) return;
  const h = normalizeHex(v);
  if (!h) { toast("Enter a valid hex, e.g. #7c5cff"); return; }
  setColor(popKey, h);
}
$("colorPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-apply")) { const inp = $("colorPop").querySelector<HTMLInputElement>(".sw-hex"); if (inp) commitHex(inp.value); return; }
  const b = t.closest<HTMLElement>("[data-c]");
  if (!b || !popKey) return;
  // Every button here commits something, so the whole stack (submenu + the menu
  // that opened it) closes with it.
  const key = popKey;
  closeCtxMenu();
  if (b.dataset.c === "delicon") { clearIcon(key); closeColorPop(); return; }
  if (b.dataset.c === "seticon") { closeColorPop(); pickCustomIcon(key); return; }
  if (b.dataset.c === "reseticon") { resetCustomIcon(key); closeColorPop(); return; }
  setColor(key, b.dataset.c === "auto" ? null : b.dataset.c!);
});
$("colorPop").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-hex") && e.key === "Enter") { e.preventDefault(); commitHex((t as HTMLInputElement).value); }
});
// ---------- project context menu ----------
// Right-clicking anything that carries a project folder (`data-key` — a project
// head, an external row, a rail button) opens a real menu: one verb per row, with
// colour and logo tucked into an Appearance submenu (the swatch panel above,
// reused verbatim) so the everyday actions stay one click deep.
let ctxKey: string | null = null;
const projName = (key: string) => FAVORITES.find((f) => f.path === key)?.name || basename(key);
// Where "Open project folder" actually lands, so the row can name it.
const FILE_MANAGER = IS_WIN ? "Explorer" : IS_MAC ? "Finder" : "file manager";

type CtxRow = { act: string; ic: string; label: string; sub?: string; cls?: string; chev?: boolean };
const ctxRowHtml = (r: CtxRow) =>
  `<button class="mp-item ${r.cls || ""}" data-ctx="${r.act}"><span class="mp-ic">${r.ic}</span>`
  + `<span class="mp-main"><span class="mp-l">${esc(r.label)}</span>${r.sub ? `<span class="mp-s">${esc(r.sub)}</span>` : ""}</span>`
  + (r.chev ? `<span class="mp-chev">›</span>` : "") + `</button>`;

function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = key;
  const fav = FAVORITES.some((f) => f.path === key);
  const live = [...sessions.values()].filter((s) => s.colorKey === key && isAgent(s)).length;
  const ic = iconFor(key);
  const rows: (CtxRow | null)[] = [
    { act: "launch", ic: "＋", label: "New session", sub: live ? `${live} already running here` : "start Claude Code in this folder" },
    { act: "worktree", ic: "⑃", label: "New worktree session…", sub: "on a branch of its own" },
    { act: "terminal", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    null,
    { act: "folder", ic: "⌂", label: "Open project folder", sub: FILE_MANAGER },
    { act: "copypath", ic: "⧉", label: "Copy path" },
    null,
    { act: "appearance", ic: "◐", label: "Appearance", sub: "color, logo", chev: true },
    null,
    // Not every group in the sidebar is pinned: a folder also shows up while it has
    // a live or external session, then vanishes with it. So the row is about
    // *permanence*, not presence — say so, or "add" reads as a lie about a project
    // that's plainly already listed.
    fav
      ? { act: "removeproj", ic: "✕", label: "Remove project", sub: "unpins it — sessions keep running", cls: "mp-danger" }
      : { act: "addproj", ic: "☆", label: "Pin to sidebar", sub: "keeps it listed with no session running" },
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head">`
    + (ic ? `<img class="mp-hico" src="${ic}" alt="" />` : `<span class="mp-hsw" style="background:${accentFor(key)}"></span>`)
    + `<span class="mp-hmain"><span class="mp-hname">${esc(projName(key))}</span><span class="mp-hpath">${esc(tilde(key))}</span></span></div>`
    + rows.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");
  placePop(menu, x, y);
  // A worktree only means something in a git repo. Ask *after* opening — the menu
  // must feel instant — then either name the branch it would fork from or drop the
  // row entirely. (A detached HEAD also answers None and loses the row; forking a
  // worktree from one is a corner case not worth a second probe.)
  invoke<string | null>("git_branch", { workdir: key }).then((b) => {
    if (ctxKey !== key) return; // menu closed or moved to another project meanwhile
    const row = menu.querySelector<HTMLElement>('[data-ctx="worktree"]');
    if (!row) return;
    if (!b) { row.remove(); placePop(menu, x, y); return; }
    const sub = row.querySelector(".mp-s");
    if (sub) sub.textContent = `branch off ${b}`;
  }).catch(() => {});
}
export function closeCtxMenu() { $("ctxMenu").classList.remove("show"); ctxKey = null; }
export const ctxMenuOpen = () => $("ctxMenu").classList.contains("show");

// A plain shell in this project's folder — embedded gets an in-app pane, the
// external engines their own window (the same split as openPlainTerminal).
function openTerminalIn(project: string, dir: string) {
  if (termEngine !== "embedded") { invoke("open_terminal_here", { workdir: dir, engine: termEngine }).catch((e) => toast("terminal: " + e)); return; }
  void host.launchShell(project, dir, { colorKey: dir });
}
async function copyPath(dir: string) {
  try { await navigator.clipboard.writeText(dir); toast("Path copied"); }
  catch { toast(dir); } // clipboard denied — at least show what it was
}

// Appearance is the one row that opens rather than commits: the menu stays put and
// the swatch panel hangs off its edge. Re-entrant — `mouseover` fires again for
// every child span the pointer crosses, and re-rendering the panel under the
// cursor would wipe a half-typed hex.
function openAppearanceSub(row: HTMLElement) {
  if (!ctxKey || row.classList.contains("sub-open")) return;
  row.classList.add("sub-open");
  const m = $("ctxMenu").getBoundingClientRect(), r = row.getBoundingClientRect();
  openColorPopover(ctxKey, m.right + 6, r.top - 6, m);
}
// Hover opens the submenu, the way a menu should. Moving onto any *other* row
// folds it away again; moving right, into the panel itself, leaves the menu
// entirely, so nothing here fires and it stays put.
$("ctxMenu").addEventListener("mouseover", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!row) return;
  if (row.dataset.ctx === "appearance") openAppearanceSub(row);
  else closeColorPop();
});
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !ctxKey) return;
  const key = ctxKey, name = projName(key);
  // Clicking it is the keyboard/touch path to the same thing hover already did.
  if (b.dataset.ctx === "appearance") { openAppearanceSub(b); return; }
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    case "launch": host.requestLaunch(name, key); break;
    case "worktree": openWt(name, key); break;
    case "terminal": openTerminalIn(name, key); break;
    case "folder": host.openProjectFolder(key); break;
    case "copypath": copyPath(key); break;
    case "addproj": host.addProjectPath(key); break;
    case "removeproj": host.removeFavorite(key); toast(`Removed ${name}`); break;
  }
});
document.addEventListener("contextmenu", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!el || !el.dataset.key) return;
  e.preventDefault();
  openCtxMenu(el.dataset.key, e.clientX, e.clientY);
});
