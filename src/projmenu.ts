// The project context menu, the worktree one, and the appearance panel they share
// with the sidebar's colour dots. One module because they are one interaction: the
// panel opens either standalone at the cursor or as the menu's Appearance submenu,
// and each closes the other — the panel clears the menu's `.sub-open` row, and every
// button in it commits and so closes the whole stack. The two menus share the one
// `#ctxMenu` element and its `.mp-*` skin for the same reason; only one can be open,
// so each opener clears the other's target.
//
// Cosmetic, in Phase-1 terms: nothing here is on renderAll()'s path. It paints on
// right-click and on a dot click, and nowhere else.

import { invoke } from "@tauri-apps/api/core";
import { $, FILE_MANAGER, toast } from "./dom";
import { basename, esc, tilde } from "./format";
import { closeFootMenus } from "./footer";
import { openGraph } from "./graphview";
import { clearIcon, customIcons, iconFor, pickCustomIcon, resetCustomIcon } from "./icons";
import { openWt, removeWorktreeAt } from "./worktree";
import {
  collapseAllProjGroups, copyPath, deleteProjectGroup, newProjectGroup, openTerminalIn,
  renameProjectGroup, setProjectGroup, toggleProjGroup,
} from "./actions";
import { groupById, groupOf, groupPaths } from "./projgroups";
import { extWorking } from "./sidebarview";
import { CLAUDE_CLI, isClaude, isExited, midFlight } from "./types";
import {
  accentFor, activeId, agentByProject, allAgents, colorOverrides, defaultAgentDef, effectiveAgent,
  engineDef, externals, FAVORITES, missingAgents, projGroups, sessions, termEngine,
} from "./state";

// The eight things a menu row does that this module does not own — panes, the project
// list and the repaint all belong to main.ts. Past the ~4 where per-callee setters
// stop reading as anything but noise, so it takes one host (settings.ts's deviation).
let host: {
  renderAll: () => void;
  requestLaunch: (project: string, path: string) => void;
  launchWorktree: (project: string, root: string, dir: string, branch: string) => void;
  launchShell: (project: string, workdir: string, opts: { colorKey?: string }) => void;
  setProjectAgent: (colorKey: string, id: string | null) => void;
  openProjectFolder: (key: string) => void;
  addProjectPath: (dir: string) => void;
  removeFavorite: (path: string) => void;
} = {
  renderAll: () => {}, requestLaunch: () => {}, launchWorktree: () => {}, launchShell: () => {},
  setProjectAgent: () => {}, openProjectFolder: () => {}, addProjectPath: () => {}, removeFavorite: () => {},
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

type CtxRow = { act: string; ic: string; label: string; sub?: string; cls?: string; chev?: boolean };
// A two-character icon is an agent monogram (`Cx`, `Gm`) and needs smaller, tighter
// type than the single glyphs every other row uses — derived from the content rather
// than flagged on the row, because "two characters" IS the condition, and a flag would
// be a second thing to remember to set. Counted in code points: no icon here is astral
// today, and `.length` would quietly mis-size the first one that is.
const ctxRowHtml = (r: CtxRow) =>
  `<button class="mp-item ${r.cls || ""}" data-ctx="${r.act}"><span class="mp-ic${[...r.ic].length === 2 ? " mp-mono" : ""}">${r.ic}</span>`
  + `<span class="mp-main"><span class="mp-l">${esc(r.label)}</span>${r.sub ? `<span class="mp-s">${esc(r.sub)}</span>` : ""}</span>`
  + (r.chev ? `<span class="mp-chev">›</span>` : "") + `</button>`;
const ctxRowsHtml = (rows: (CtxRow | null)[]) =>
  rows.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");

// Where the menu was opened, so a drill-down (Move to group…) and its ‹ Back land on
// the same pixels rather than jumping to wherever the pointer has since wandered.
let menuX = 0, menuY = 0;

function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  wtTarget = gTarget = pickPath = agentKey = null; // one #ctxMenu, one target — see the module header
  ctxKey = key;
  menuX = x; menuY = y;
  const grouped = groupById(projGroups, groupOf(projGroups, key) ?? "");
  const fav = FAVORITES.some((f) => f.path === key);
  const live = [...sessions.values()].filter((s) => s.colorKey === key && isClaude(s)).length;
  const agent = effectiveAgent(key);
  const ic = iconFor(key);
  const rows: (CtxRow | null)[] = [
    // The sub names the agent instead of saying "Claude Code" unconditionally, which
    // is the whole point of the row below it: the button that starts a session is the
    // last honest moment to say what it is about to start.
    { act: "launch", ic: "＋", label: "New session", sub: live ? `${live} already running here` : `start ${agent.label} in this folder` },
    { act: "worktree", ic: "⑃", label: "New worktree session…", sub: "on a branch of its own" },
    { act: "terminal", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    // Always present, even on a machine with nothing but Claude installed — which is
    // the case where it earns the most: the picker behind it is where "Episko supports
    // twenty-one of these, here is what it looked for" is written down. Dropping it
    // then would hide the feature from exactly the person who has not found it yet.
    { act: "agents", ic: agent.mark, label: `Agent · ${agent.label}`, sub: agentSub(key), chev: true },
    null,
    // Dropped below unless the probe says this folder is a repo — a graph row on a
    // plain directory would open a panel with nothing but an error in it.
    { act: "graph", ic: "⑂", label: "Commit graph…", sub: "recent history, branches and merges" },
    { act: "folder", ic: "⌂", label: "Open project folder", sub: FILE_MANAGER },
    { act: "copypath", ic: "⧉", label: "Copy path" },
    null,
    // Named after where the project already is, when it is somewhere: "Group: Work"
    // answers the question the row would otherwise raise, and the picker behind it is
    // the same one either way.
    grouped
      ? { act: "movegroup", ic: "▤", label: `Group · ${grouped.name}`, sub: "move to another, or take it out", chev: true }
      : { act: "movegroup", ic: "▤", label: "Add to group…", sub: "collect projects under one collapsible heading", chev: true },
    { act: "appearance", ic: "◐", label: "Appearance", sub: "color, logo", chev: true },
    null,
    // Not every group in the sidebar is pinned: a folder also shows up while it has
    // a live or external session, then vanishes with it. So the row is about
    // *permanence*, not presence — say so, or "add" reads as a lie about a project
    // that's plainly already listed.
    fav
      ? { act: "removeproj", ic: "✕", label: "Remove project", sub: "unpins it; sessions keep running", cls: "mp-danger" }
      : { act: "addproj", ic: "☆", label: "Pin to sidebar", sub: "keeps it listed with no session running" },
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head">`
    + (ic ? `<img class="mp-hico" src="${ic}" alt="" />` : `<span class="mp-hsw" style="background:${accentFor(key)}"></span>`)
    + `<span class="mp-hmain"><span class="mp-hname">${esc(projName(key))}</span><span class="mp-hpath">${esc(tilde(key))}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
  // Two rows only mean something in a git repo. Ask *after* opening — the menu must
  // feel instant — then drop what doesn't apply and re-place the (now shorter) menu.
  // One probe answers both: `git_head` returns None for anything that isn't a repo
  // with a commit, and a null `branch` inside it means a detached HEAD, which still
  // has a history to graph but no branch to fork a worktree from.
  invoke<{ branch: string | null; short: string } | null>("git_head", { workdir: key }).then((h) => {
    if (ctxKey !== key) return; // menu closed or moved to another project meanwhile
    const drop = (act: string) => menu.querySelector<HTMLElement>(`[data-ctx="${act}"]`)?.remove();
    if (!h) { drop("worktree"); drop("graph"); placePop(menu, x, y); return; }
    if (!h.branch) { drop("worktree"); placePop(menu, x, y); return; }
    const sub = menu.querySelector('[data-ctx="worktree"] .mp-s');
    if (sub) sub.textContent = `branch off ${h.branch}`;
  }).catch(() => {});
}
export function closeCtxMenu() { $("ctxMenu").classList.remove("show"); ctxKey = wtTarget = gTarget = pickPath = agentKey = null; }
export const ctxMenuOpen = () => $("ctxMenu").classList.contains("show");

// ---------- worktree cluster context menu ----------
// Right-clicking a ⑃ cluster header in the sidebar. The header's ＋ already covers
// the one verb worth a single click; everything else a checkout can be — opened,
// walked to in a terminal, pruned — lives here rather than as four more glyphs
// crowding an 11px row.
//
// Deliberately NOT the project menu with different rows: a cluster is one checkout,
// and its verbs act on `dir` while still belonging to `root` (the colorKey the whole
// project groups under). Conflating them is what would put a worktree session in a
// project group of its own — the same trap `launchWorktree` exists to avoid.
type WtTarget = { dir: string; root: string; project: string; branch: string; isMain: boolean };
let wtTarget: WtTarget | null = null;

// What removing this checkout would actually cost, said before it is clicked. An
// external session blocks it outright (the backend can't see one, and git would
// delete the folder out from under it), so that row is disabled rather than offered.
function removeRow(t: WtTarget): CtxRow {
  const ext = externals.filter((e) => e.cwd === t.dir).length;
  if (ext) return { act: "wtremove", ic: "⌫", label: "Remove worktree…", sub: `blocked: ${ext} session${ext > 1 ? "s" : ""} running outside Episko`, cls: "dis" };
  const live = [...sessions.values()].filter((s) => s.workdir === t.dir).length;
  const sub = live
    ? `closes ${live} session${live > 1 ? "s" : ""}, then deletes the folder`
    : "deletes the folder; the branch only if merged";
  return { act: "wtremove", ic: "⌫", label: "Remove worktree…", sub, cls: "mp-danger" };
}

// Moving the root folder to another branch, from the header that names it.
//
// **The main checkout's row only** — a worktree exists precisely so its branch doesn't
// move, so the verb has nothing to offer there and a greyed row would be answering a
// question nobody asked. That is the opposite call from *Remove worktree…* below, which
// IS greyed on the main checkout, and the difference is whether the row reads as a gap:
// removal is what you go to a checkout's menu for, so its absence would look like a bug;
// switching a worktree's branch is a thing the model deliberately doesn't do.
//
// What it does say, when it is shown, is what the click will cost — `midFlight` for our
// own panes and `extWorking` for a terminal we can only see from the outside. Same
// bargain `removeRow` makes: a greyed row with a reason beats a click into a wall. This
// block is *transient* where removal's is permanent, so it names what to wait for rather
// than implying the verb is unavailable, and *All worktrees…* one row up still reaches
// the card that lists the offending sessions and jumps to them.
function switchRow(t: WtTarget): CtxRow {
  const busy = [...sessions.values()].filter((s) => s.workdir === t.dir && midFlight(s)).length
    + externals.filter((e) => e.cwd === t.dir && extWorking(e)).length;
  if (busy) {
    return { act: "", ic: "⇄", label: "Switch branch…", sub: `waiting: ${busy} session${busy > 1 ? "s" : ""} still working here`, cls: "dis" };
  }
  const idle = [...sessions.values()].filter((s) => s.workdir === t.dir && !isExited(s)).length;
  return {
    act: "wtswitch", ic: "⇄", label: "Switch branch…",
    sub: idle
      ? `${idle} idle session${idle > 1 ? "s" : ""} here stay${idle > 1 ? "" : "s"} open`
      : "moves this folder; every worktree keeps its own",
  };
}

function openWtMenu(t: WtTarget, x: number, y: number) {
  closeColorPop();
  ctxKey = null; // one #ctxMenu, one target — see the module header
  wtTarget = t;
  // Stamped for the same reason `openCtxMenu` stamps it: the agent picker replaces
  // this menu in place, and its ‹ Back has to reopen on the same pixels.
  menuX = x; menuY = y;
  const live = [...sessions.values()].filter((s) => s.workdir === t.dir && isClaude(s)).length;
  const rows: (CtxRow | null)[] = [
    // No agent row of its own: the override is keyed by repo (`colorKey`), which is
    // what every checkout of it launches under, so a per-worktree picker would be
    // setting something other than what it appeared to. Naming it is the honest half.
    { act: "wtlaunch", ic: "＋", label: "New session here", sub: live ? `${live} already running in this checkout` : `start ${effectiveAgent(t.root).label} on this branch` },
    { act: "wtterm", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    null,
    { act: "wtfolder", ic: "⌂", label: "Open checkout folder", sub: FILE_MANAGER },
    { act: "wtcopy", ic: "⧉", label: "Copy path" },
    null,
    { act: "wtdialog", ic: "⑃", label: "All worktrees…", sub: "create, switch, prune" },
    // Spread, not a `null` — in this list a null IS a separator, so a row that should be
    // absent has to be an empty array rather than a falsy entry.
    ...(t.isMain ? [switchRow(t)] : []),
    null,
    // The main checkout is not removable and never will be — git refuses it. Saying so
    // beats dropping the row, which would read as "Episko forgot how to prune this one".
    t.isMain
      ? { act: "", ic: "⌫", label: "Remove worktree…", sub: "this is the repo's main checkout", cls: "dis" }
      : removeRow(t),
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(t.branch || t.dir)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">⑃ ${esc(t.branch)}</span><span class="mp-hpath">${esc(tilde(t.dir))}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
}

$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !wtTarget || b.classList.contains("dis")) return;
  const t = wtTarget;
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    case "wtlaunch": host.launchWorktree(t.project, t.root, t.dir, t.branch); break;
    case "wtterm": openTerminalIn(t.project, t.dir); break;
    case "wtfolder": host.openProjectFolder(t.dir); break;
    case "wtcopy": copyPath(t.dir); break;
    // The dialog is the repo's, not the checkout's — it opens on the root, which is
    // also the only cwd `git worktree add` can be driven from. But in *manage* mode
    // and focused at this checkout: reached from a cluster header it is the worktree
    // list, not the launcher, and every difference between the two is in `openWt`.
    case "wtdialog": openWt(t.project, t.root, null, { manage: true, focusDir: t.dir }); break;
    // Same dialog, opened on the answer rather than on the list: `armSwitch` selects the
    // repo row and paints its switch card, so the branch picker is the next click. The
    // header we were opened from IS the root here (the row is main-only), so `t.branch`
    // is the branch being left — seed it, or the card reads "—" until the git call lands.
    case "wtswitch": openWt(t.project, t.root, t.branch, { manage: true, armSwitch: true }); break;
    case "wtremove": void removeWorktreeAt(t.project, t.root, t.dir, t.branch); break;
  }
});

// ---------- which agent this project runs: the picker ----------
// A fourth mode of the one #ctxMenu, and a drill-down rather than a submenu for the
// same reason "which group?" is one: it is a list of rows, so it replaces the menu in
// place and offers ‹ Back.
//
// It sets a preference; it does not launch. That is the whole difference from the
// version this replaced, which asked "which agent, this time?" on every single start —
// nobody switches agent per session, they switch per project, so the answer is stored
// and `＋ New session` reads it. One picker, one meaning.
let agentKey: string | null = null;   // the project whose agent is being chosen

/// What the "Agent · X" row says underneath. Names where the answer came from, because
/// the same label means two different things: a repo pinned to Codex must not read
/// identically to one that merely inherits Codex from the global default — otherwise
/// clearing an override you forgot you set is guesswork.
function agentSub(key: string): string {
  if (agentByProject[key]) return "set for this project";
  const n = allAgents().length - 1;
  return n ? `the default · ${n} other${n === 1 ? "" : "s"} installed` : "the default · nothing else installed";
}

/// Whether the picker is showing the agents this machine hasn't got. Sticky for the
/// app's life rather than per-open: somebody who expanded it once is shopping, and
/// re-collapsing under them on the next open would read as the menu forgetting.
let agentShowAll = false;

function openAgentPicker(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = pickPath = null; // one #ctxMenu, one target
  agentKey = key;
  const cur = agentByProject[key];
  const eff = effectiveAgent(key);
  const missing = missingAgents();
  const rows: (CtxRow | null)[] = [
    { act: "aback", ic: "‹", label: "Back", sub: projName(key) },
    null,
    // Above the fold: Claude plus what the probe FOUND. A row here is a promise the
    // binary exists, and the probe is the only thing that can make that promise.
    ...allAgents().map((a) => ({
      act: `apick:${a.id}`, ic: a.mark, label: a.label,
      // The tick marks the *override*, not the effective agent: ticking an inherited
      // row would make "follow the default" below it look like a no-op.
      sub: a.id === cur ? "✓ set for this project"
        : a.id === CLAUDE_CLI.id ? "instrumented — phase, cost, context"
        : tilde(a.path ?? ""),
    })),
    cur ? { act: "aclear", ic: "⊘", label: "Follow the default", sub: `Settings › Sessions · ${defaultAgentDef().label}` } : null,
    // …and below it, everything Episko supports that this machine hasn't got. Folded,
    // because twelve rows you cannot pick would bury the ones you can — but present,
    // because a *missing* row is indistinguishable from "Episko doesn't support Codex"
    // and the only place to take that question is the issue tracker. Same rule as a
    // Runnable that cannot run and a worktree that cannot be removed: say why.
    ...(missing.length ? [null, {
      act: "amore", ic: agentShowAll ? "−" : "+",
      label: `${missing.length} more supported`,
      sub: agentShowAll ? "installed ones are above" : "not found on this machine",
    }] as (CtxRow | null)[] : []),
    // `cls: "dis"` is what makes them inert: every click listener on this menu bails on
    // a `.dis` row before reading its act, so there is no dead branch to write.
    ...(agentShowAll
      ? missing.map((a) => ({
        act: "", ic: a.mark, label: a.label, cls: "dis",
        // The binary name IS the answer to "why isn't it here?" — it says exactly what
        // Episko searched the PATH for, which no install link could tell you as
        // precisely, and which cannot rot the way twenty-one vendor URLs would.
        sub: `not on PATH · ${a.bin}`,
      }))
      : []),
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(key)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Agent</span><span class="mp-hpath">${esc(projName(key))} · runs ${esc(eff.label)}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
}


// ---------- project groups: the picker, and a group's own menu ----------
// Two more modes of the one #ctxMenu, and they are drill-downs rather than submenus:
// Appearance hangs a *panel* off the menu's edge because a colour grid is not a list of
// rows, but "which group?" is exactly a list of rows, so it replaces the menu in place
// and offers ‹ Back. One element, one skin, no second popover to position.
//
// Naming a group is an inline `<input>` in the menu (the `.sw-hex` field in the colour
// panel is the precedent) rather than a dialog: it is one short string, and a modal for
// it would be heavier than the thing it creates.
let pickPath: string | null = null;   // the project being filed
let gTarget: string | null = null;    // the group whose menu is open

const groupCount = (gid: string) => groupPaths(projGroups, gid).length;
const nameField = (placeholder: string, value = "") =>
  `<div class="mp-new"><input class="mp-in" type="text" spellcheck="false" autocomplete="off" maxlength="40"`
  + ` placeholder="${esc(placeholder)}" value="${esc(value)}" /></div>`;
const focusField = () => setTimeout(() => $("ctxMenu").querySelector<HTMLInputElement>(".mp-in")?.focus(), 30);

function openGroupPicker(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = agentKey = null;
  pickPath = key;
  const cur = groupOf(projGroups, key);
  const rows: (CtxRow | null)[] = [
    { act: "gback", ic: "‹", label: "Back", sub: projName(key) },
    null,
    ...projGroups.groups.map((g) => ({
      act: `gpick:${g.id}`, ic: g.id === cur ? "✓" : "▪", label: g.name,
      sub: `${groupCount(g.id)} project${groupCount(g.id) === 1 ? "" : "s"}`,
    })),
    cur ? { act: "gclear", ic: "⊘", label: "Remove from group", sub: "back to the top level" } : null,
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(key)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Group</span><span class="mp-hpath">${esc(projName(key))}</span></span></div>`
    + ctxRowsHtml(rows) + nameField("New group…");
  placePop(menu, x, y);
  focusField();
}

function openGroupMenu(gid: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = pickPath = agentKey = null;
  gTarget = gid;
  menuX = x; menuY = y;
  const g = groupById(projGroups, gid);
  if (!g) return;
  const n = groupCount(gid);
  const many = projGroups.groups.length > 1;
  const rows: (CtxRow | null)[] = [
    g.collapsed
      ? { act: "gopen", ic: "▾", label: "Expand group", sub: `show its ${n} project${n === 1 ? "" : "s"}` }
      : { act: "gopen", ic: "▸", label: "Collapse group", sub: n ? `fold ${n} project${n === 1 ? "" : "s"} away` : "it is empty" },
    { act: "grename", ic: "✎", label: "Rename group…" },
    // Only worth offering once there is more than one group to act on — otherwise
    // "collapse all" is a longer way of saying the row directly above it.
    ...(many ? [null, { act: "gcollapseall", ic: "⇱", label: "Collapse all groups" }, { act: "gexpandall", ic: "⇲", label: "Expand all groups" }] as (CtxRow | null)[] : []),
    null,
    // Not destructive to anything but the heading, and the sub says so — "Delete" over
    // a list of someone's repos has to be unmistakable about what it takes with it.
    { act: "gdelete", ic: "✕", label: "Delete group", sub: "the projects stay, at the top level", cls: "mp-danger" },
  ];
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw mp-hfold"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">${esc(g.name)}</span>`
    + `<span class="mp-hpath">${n} project${n === 1 ? "" : "s"}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
}

function openRenameGroup(gid: string) {
  const g = groupById(projGroups, gid);
  if (!g) return;
  gTarget = gid;
  const menu = $("ctxMenu");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw mp-hfold"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Rename</span><span class="mp-hpath">${esc(g.name)}</span></span></div>`
    + nameField("Group name", g.name);
  placePop(menu, menuX, menuY);
  focusField();
  setTimeout(() => menu.querySelector<HTMLInputElement>(".mp-in")?.select(), 40);
}

/// A row that REPLACES this menu's markup instead of committing has to stop the click
/// dead, and the reason is not obvious enough to leave unwritten — there are *two*
/// things that would otherwise close the menu it just opened.
///
/// 1. main.ts's outside-click closer asks `t.closest("#ctxMenu")` of the original
///    target, and by the time it runs the innerHTML has been swapped — so the node it
///    is asking about is detached, answers null, and the menu we just opened is closed
///    as an outside click. Appearance never hit this because it only adds a class;
///    every drill-down here re-renders.
/// 2. **The sibling listeners on this very element.** `#ctxMenu` carries three click
///    listeners (worktree menu, drill-downs, project menu) and they fire in
///    registration order; `stopPropagation` only stops the trip *onward*, so every one
///    of them still sees a click any one of them has already handled. A drill-down
///    reopens its parent menu synchronously, which means a later listener finds its
///    own target set again and an act it has no case for — and falls through to the
///    unconditional `closeCtxMenu()` before its switch. That is why ‹ Back on *Move to
///    group* used to blink the menu shut instead of going back, and it is why this is
///    `stopImmediatePropagation` rather than the `stopPropagation` it was.
const keepMenuOpen = (e: Event) => e.stopImmediatePropagation();

// One listener for all three drill-downs, guarded on their own targets exactly as the
// project and worktree menus guard on theirs — four modes, one element, no shared
// branch.
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || b.classList.contains("dis")) return;
  const act = b.dataset.ctx || "";
  if (agentKey) {
    const key = agentKey;
    if (act === "aback") { keepMenuOpen(e); closeCtxMenu(); openCtxMenu(key, menuX, menuY); return; }
    // Anything else is not this picker's vocabulary — leave the menu exactly as it is
    // rather than closing it on a row we did not draw. Belt and braces behind
    // `keepMenuOpen` above, which is what actually keeps a sibling listener's click
    // from arriving here at all.
    // The fold is a re-render in place, not a commit — same shape as ‹ Back above it.
    if (act === "amore") { keepMenuOpen(e); agentShowAll = !agentShowAll; openAgentPicker(key, menuX, menuY); return; }
    if (act !== "aclear" && !act.startsWith("apick:")) return;
    closeCtxMenu();
    host.setProjectAgent(key, act === "aclear" ? null : act.slice(6));
    return;
  }
  if (pickPath) {
    const path = pickPath;
    // Back is the one row that reopens rather than commits — same coordinates, so the
    // menu appears not to have moved at all.
    if (act === "gback") { keepMenuOpen(e); closeCtxMenu(); openCtxMenu(path, menuX, menuY); return; }
    closeCtxMenu();
    if (act === "gclear") setProjectGroup(path, null);
    else if (act.startsWith("gpick:")) setProjectGroup(path, act.slice(6));
    return;
  }
  if (!gTarget) return;
  const gid = gTarget;
  if (act === "grename") { keepMenuOpen(e); openRenameGroup(gid); return; }
  closeCtxMenu();
  if (act === "gopen") toggleProjGroup(gid);
  else if (act === "gcollapseall") collapseAllProjGroups(true);
  else if (act === "gexpandall") collapseAllProjGroups(false);
  else if (act === "gdelete") deleteProjectGroup(gid);
});
// The inline name field: Enter commits, Esc backs out. It carries no `data-ctx`, so
// every click listener above already ignores it and the menu stays open while typing.
$("ctxMenu").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (!t.classList.contains("mp-in")) return;
  if (e.key === "Escape") { e.preventDefault(); closeCtxMenu(); return; }
  if (e.key !== "Enter") return;
  e.preventDefault();
  const value = (t as HTMLInputElement).value;
  const path = pickPath, gid = gTarget;
  closeCtxMenu();
  if (path) newProjectGroup(value, path);
  else if (gid) renameProjectGroup(gid, value);
});

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
  // The other row that opens rather than commits — it replaces this menu in place
  // (see openGroupPicker), so it must not fall through to the close below, and the
  // click must not reach main.ts's outside-click closer (see keepMenuOpen).
  if (b.dataset.ctx === "movegroup") { keepMenuOpen(e); openGroupPicker(key, menuX, menuY); return; }
  // Third row that opens rather than commits, same rule as the two above it.
  if (b.dataset.ctx === "agents") { keepMenuOpen(e); openAgentPicker(key, menuX, menuY); return; }
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    case "launch": host.requestLaunch(name, key); break;
    case "worktree": openWt(name, key); break;
    case "terminal": openTerminalIn(name, key); break;
    case "graph": void openGraph(key, name); break;
    case "folder": host.openProjectFolder(key); break;
    case "copypath": copyPath(key); break;
    case "addproj": host.addProjectPath(key); break;
    case "removeproj": host.removeFavorite(key); toast(`Removed ${name}`); break;
  }
});
// `data-wt` is matched first and on its own element: a ⑃ cluster header sits inside a
// project group, so a single `[data-key],[data-wt]` closest() would be decided by
// which happens to be nearer in the tree rather than by what was actually clicked.
//
// `data-gid` is the same rule one level up, and is why it sits on the fold's HEADER
// and not on the fold: a project inside the group would find a wrapper's `data-gid` as
// an ancestor and open the group's menu instead of its own.
document.addEventListener("contextmenu", (e) => {
  const fold = (e.target as HTMLElement).closest<HTMLElement>("[data-gid]");
  if (fold?.dataset.gid) {
    e.preventDefault();
    openGroupMenu(fold.dataset.gid, e.clientX, e.clientY);
    return;
  }
  const wt = (e.target as HTMLElement).closest<HTMLElement>("[data-wt]");
  if (wt?.dataset.wt) {
    e.preventDefault();
    openWtMenu({
      dir: wt.dataset.wt,
      root: wt.dataset.root || wt.dataset.wt,
      project: wt.dataset.proj || basename(wt.dataset.wt),
      branch: wt.dataset.branch || basename(wt.dataset.wt),
      isMain: wt.dataset.main === "1",
    }, e.clientX, e.clientY);
    return;
  }
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
  if (!el || !el.dataset.key) return;
  e.preventDefault();
  openCtxMenu(el.dataset.key, e.clientX, e.clientY);
});
