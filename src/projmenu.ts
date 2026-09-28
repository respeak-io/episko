// The right-click menus the sidebar and the dashboard share — a project, a worktree cluster, a
// session row, a branch row — plus the appearance panel behind the colour dots. Every mode shares
// the one #ctxMenu and its .mp-* skin, so each opener clears every other mode's target. Nothing
// here is on renderAll()'s path.

import { invoke } from "@tauri-apps/api/core";
import { $, EMOJI_PICKER_KEY, FILE_MANAGER, IS_WIN, toast } from "./dom";
import { EM_HEAD_H, EM_ROW_H, emojiRows, rowWindow } from "./emoji";
import type { EmRow } from "./emoji";
import { basename, esc, relTime, tilde } from "./format";
import { openMenu, type MenuItem } from "./menu";
import { closeFootMenus } from "./footer";
import { openGraph } from "./graphview";
import { clearIcon, customIcons, emojiFor, iconFor, pickCustomIcon, resetCustomIcon, setEmojiIcon } from "./icons";
import { openSessionBranchPop, openWt, removeWorktreeAt } from "./worktree";
import {
  collapseAllProjGroups, copyPath, deleteProjectGroup, followSessionDrift, newProjectGroup,
  openTerminalIn, renameProjectGroup, setProjectGroup, shelveSessionAsked, toggleProjGroup,
} from "./actions";
import { groupById, groupOf, groupPaths } from "./projgroups";
import { dormantBusy } from "./grouping";
import { lastRunnableById, pinnedIds, togglePin } from "./tasks";
import { rerunTask, revealSource } from "./taskrun";
import { forgetDormant, jumpExternal, resumeDormant } from "./mirror";
import { openDiff } from "./diffview";
import { dirtyCount } from "./inspectorview";
import { extWorking, GCLASS, GLYPH, pastLabel, rowGlyph, rowLabel } from "./sidebarview";
import {
  agentCapabilitySummary, canShelve, isAgent, isExited, midFlight, midWork, paneDir,
  type ExtSession, type Restorable, type Sess,
} from "./types";
import { agentLogo } from "./providers/logos";
import {
  accentFor, activeId, agentByProject, allAgents, colorOverrides, defaultAgentDef, dirtyByFolder,
  dormants, effectiveAgent, engineDef, externals, FAVORITES, ghAccountFor, ghLogins, isDirty,
  missingAgents, projGroups, sessions, termEngine,
  shareModeOf, type ShareMode,
} from "./state";
import { ghPickable, ghWho } from "./ghwork";

// What a menu row does that this module does not own; one host object rather than nine
// setters, as settings.ts does.
let host: {
  renderAll: () => void;
  requestLaunch: (project: string, path: string) => void;
  launchWorktree: (project: string, root: string, dir: string, branch: string) => void;
  launchShell: (project: string, workdir: string, opts: { colorKey?: string }) => void;
  setProjectAgent: (colorKey: string, id: string | null) => void;
  setGhAccount: (colorKey: string, login: string | null) => void;
  setShareMode: (colorKey: string, mode: ShareMode) => void;
  openProjectFolder: (key: string) => void;
  addProjectPath: (dir: string) => void;
  removeFavorite: (path: string) => void;
  openShellFor: (id: string) => void;
  closeSession: (id: string) => void;
} = {
  renderAll: () => {}, requestLaunch: () => {}, launchWorktree: () => {}, launchShell: () => {},
  setProjectAgent: () => {}, openProjectFolder: () => {}, addProjectPath: () => {}, removeFavorite: () => {},
  setGhAccount: () => {}, openShellFor: () => {}, closeSession: () => {}, setShareMode: () => {},
};
export function setProjMenuHost(h: typeof host) { host = h; }

// A control that re-renders its own menu instead of committing must stop the click dead, and
// stopPropagation is not enough: main.ts's outside-click closer sees the original target
// detached by the innerHTML swap and closes the menu, and the sibling click listeners on
// #ctxMenu still run, find their target set again by the reopen, and fall through to closeCtxMenu().
const keepMenuOpen = (e: Event) => e.stopImmediatePropagation();

// ---------- the appearance panel ----------
// 12 perceptually distinct hues around the wheel
const SWATCHES = ["#f2555a", "#fb923c", "#facc15", "#a3e635", "#34d399", "#2dd4bf", "#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#d084f5", "#f472b6"];
let popKey: string | null = null;
function normalizeHex(v: string): string | null {
  let x = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(x)) x = x.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(x) ? "#" + x.toLowerCase() : null;
}
// Clamps against the measured size: these panels change height with their optional rows.
function placePop(el: HTMLElement, x: number, y: number) {
  el.classList.add("show");
  el.style.left = Math.max(8, Math.min(x, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = Math.max(8, Math.min(y, window.innerHeight - el.offsetHeight - 8)) + "px";
}
const colorPopHtml = (key: string) => {
  const cur = accentFor(key).toLowerCase();
  return SWATCHES.map((c) => `<button class="sw-btn ${c === cur ? "on" : ""}" style="background:${c}" data-c="${c}"></button>`).join("") +
    `<div class="sw-row"><input class="sw-hex" type="text" spellcheck="false" placeholder="#hex" value="${cur}" maxlength="7" /><button class="sw-apply">Set</button></div>` +
    `<button class="sw-auto" data-c="auto">Auto color</button>` +
    `<button class="sw-auto" data-c="emoji">Pick an emoji…${emojiFor(key) ? ` ${emojiFor(key)}` : ""}</button>` +
    `<button class="sw-auto" data-c="seticon">Set custom logo…</button>` +
    (customIcons[key] ? `<button class="sw-auto" data-c="reseticon">Restore repo logo</button>` : "") +
    (iconFor(key) ? `<button class="sw-auto" data-c="delicon">Use color dot (hide icon)</button>` : "");
};
// The full Unicode set is ~1,900 glyphs, so the list is windowed: `emRows` is the whole
// thing and only `rowWindow`'s slice is ever in the DOM. Flags are left out where the font
// has no regional-indicator glyphs, or the group is 270 rows of letter pairs.
const EM_VIEW_H = 252;
let emQ = "";
let emRows: EmRow[] = [];
let emWinKey = "";
const emFlags = !IS_WIN;

const emojiPopHtml = (key: string) => {
  const cur = emojiFor(key);
  return `<button class="sw-auto sw-back" data-c="back">‹ Color &amp; logo</button>` +
    `<div class="sw-row"><input class="sw-hex sw-emin" type="text" spellcheck="false" placeholder="Search or paste an emoji" value="" /></div>` +
    `<div class="em-scroll"><div class="em-win"></div></div>` +
    `<div class="sw-note">↵ takes the first${EMOJI_PICKER_KEY ? ` · ${EMOJI_PICKER_KEY} opens the system picker` : ""}</div>` +
    (cur ? `<button class="sw-auto" data-c="reseticon">Remove emoji</button>` : "");
};
const emRowsHtml = (rows: EmRow[], cur: string | null) => rows.map((r) => r.kind === "head"
  ? `<div class="em-head" style="height:${EM_HEAD_H}px">${esc(r.label)}</div>`
  : `<div class="em-row" style="height:${EM_ROW_H}px">` + r.cells.map((c) =>
    `<button class="em-btn${c.ch === cur ? " on" : ""}" data-c="em:${c.ch}" title="${esc(c.name)}">${c.ch}</button>`).join("") + `</div>`).join("");

// Paints the rows in view. Guarded like every other innerHTML surface: a scroll that moves
// inside the same window must not rebuild the button under the pointer.
function renderEmojiList(force = false) {
  const pop = $("colorPop");
  const sc = pop.querySelector<HTMLElement>(".em-scroll"), win = pop.querySelector<HTMLElement>(".em-win");
  if (!sc || !win || !popKey) return;
  // Measured against the full height, never the current one: a short result list shrinks the
  // scroller, and reading that back would then decide the window from what it had just set.
  const w = rowWindow(emRows, sc.scrollTop, EM_VIEW_H);
  const key = `${emQ}|${w.start}|${w.end}`;
  if (!force && key === emWinKey) return;
  emWinKey = key;
  sc.style.maxHeight = `${EM_VIEW_H}px`;
  win.style.padding = `${w.padTop}px 0 ${w.padBottom}px`;
  win.innerHTML = emRows.length
    ? emRowsHtml(emRows.slice(w.start, w.end), emojiFor(popKey))
    : `<div class="em-none">No emoji named “${esc(emQ)}”</div>`;
}
function setEmojiQuery(q: string) {
  emQ = q;
  emRows = emojiRows(q, { flags: emFlags });
  const sc = $("colorPop").querySelector<HTMLElement>(".em-scroll");
  if (sc) sc.scrollTop = 0;
  renderEmojiList(true);
}
// Where the panel was opened, so the emoji mode lands on the same pixels the colours did.
let popAt = { x: 0, y: 0, flip: undefined as DOMRect | undefined };
function renderPop(mode: "color" | "emoji") {
  if (!popKey) return;
  const pop = $("colorPop");
  pop.classList.toggle("emo", mode === "emoji");
  pop.innerHTML = mode === "emoji" ? emojiPopHtml(popKey) : colorPopHtml(popKey);
  pop.classList.add("show"); // shown before measuring, or offsetWidth reads 0
  if (mode === "emoji") {
    emWinKey = "";
    setEmojiQuery("");
    pop.querySelector<HTMLElement>(".em-scroll")?.addEventListener("scroll", () => renderEmojiList());
    setTimeout(() => pop.querySelector<HTMLInputElement>(".sw-emin")?.focus(), 0);
  }
  let x = popAt.x;
  if (popAt.flip && x + pop.offsetWidth > window.innerWidth - 8) x = popAt.flip.left - pop.offsetWidth - 6;
  placePop(pop, x, popAt.y);
}
// Opens standalone at the cursor or as the context menu's submenu; `flipFrom` is the
// parent menu's rect, so a panel that won't fit to its right lands on its left instead.
export function openColorPopover(key: string, x: number, y: number, flipFrom?: DOMRect) {
  popKey = key;
  popAt = { x, y, flip: flipFrom };
  closeFootMenus("colorPop");
  renderPop("color");
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
// ↵ takes the first result, which for a pasted emoji is that emoji. A refused value leaves
// the panel up to retype in, so this asks whether it took rather than reading the store back.
function commitEmoji() {
  const first = emRows.find((r) => r.kind === "grid");
  if (!first || first.kind !== "grid") return;
  if (popKey && setEmojiIcon(popKey, first.cells[0].ch)) { closeCtxMenu(); closeColorPop(); }
}
$("colorPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-apply")) { const inp = $("colorPop").querySelector<HTMLInputElement>(".sw-hex"); if (inp) commitHex(inp.value); return; }
  const b = t.closest<HTMLElement>("[data-c]");
  if (!b || !popKey) return;
  // The two mode switches redraw in place, so they take keepMenuOpen; everything else
  // commits, and the whole stack (submenu + menu) closes with it.
  if (b.dataset.c === "emoji") { keepMenuOpen(e); renderPop("emoji"); return; }
  if (b.dataset.c === "back") { keepMenuOpen(e); renderPop("color"); return; }
  const key = popKey;
  const em = b.dataset.c?.startsWith("em:") ? b.dataset.c.slice(3) : null;
  closeCtxMenu();
  if (em) { setEmojiIcon(key, em); closeColorPop(); return; }
  if (b.dataset.c === "delicon") { clearIcon(key); closeColorPop(); return; }
  if (b.dataset.c === "seticon") { closeColorPop(); pickCustomIcon(key); return; }
  if (b.dataset.c === "reseticon") { resetCustomIcon(key); closeColorPop(); return; }
  setColor(key, b.dataset.c === "auto" ? null : b.dataset.c!);
});
$("colorPop").addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  if (t.classList.contains("sw-emin")) setEmojiQuery((t as HTMLInputElement).value);
});
$("colorPop").addEventListener("keydown", (e: KeyboardEvent) => {
  const t = e.target as HTMLElement;
  if (e.key !== "Enter") return;
  // The emoji field carries `sw-hex` for its skin, so it must be asked about first.
  if (t.classList.contains("sw-emin")) { e.preventDefault(); commitEmoji(); return; }
  if (t.classList.contains("sw-hex")) { e.preventDefault(); commitHex((t as HTMLInputElement).value); }
});
// ---------- project context menu ----------
// Right-click on anything carrying a project folder (`data-key`): one verb per row, with
// colour and logo in an Appearance submenu so the everyday verbs stay one click deep.
let ctxKey: string | null = null;
const projName = (key: string) => FAVORITES.find((f) => f.path === key)?.name || basename(key);

type CtxRow = { act: string; ic?: string; logo?: string; label: string; sub?: string; cls?: string; chev?: boolean };
const ctxRowHtml = (r: CtxRow) =>
  `<button class="mp-item ${r.cls || ""}" data-ctx="${r.act}">`
  + (r.logo
    ? `<span class="mp-ic agent-logo" aria-hidden="true">${r.logo}</span>`
    : `<span class="mp-ic${[...(r.ic || "")].length === 2 ? " mp-mono" : ""}">${r.ic || ""}</span>`)
  + `<span class="mp-main"><span class="mp-l">${esc(r.label)}</span>${r.sub ? `<span class="mp-s">${esc(r.sub)}</span>` : ""}</span>`
  + (r.chev ? `<span class="mp-chev">›</span>` : "") + `</button>`;
// A separator divides two things; a `null` that ends up leading, trailing or beside another
// divides nothing and draws a line across empty menu. Every list here is built with conditional
// rows, so normalising is the renderer's job rather than each caller's.
const ctxRowsHtml = (rows: (CtxRow | null)[]) => {
  const kept: (CtxRow | null)[] = [];
  for (const r of rows) {
    if (!r && (!kept.length || !kept[kept.length - 1])) continue;
    kept.push(r);
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");
};

// Where the menu was opened, so a drill-down and its ‹ Back land on the same pixels.
let menuX = 0, menuY = 0;

export function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  wtTarget = gTarget = pickPath = brTarget = sessTarget = null; // one #ctxMenu, one target
  ctxKey = key;
  menuX = x; menuY = y;
  const grouped = groupById(projGroups, groupOf(projGroups, key) ?? "");
  const fav = FAVORITES.some((f) => f.path === key);
  const live = [...sessions.values()].filter((s) => s.colorKey === key && isAgent(s)).length;
  const agent = effectiveAgent(key);
  const ic = iconFor(key);
  const rows: (CtxRow | null)[] = [
    // Names the agent: this button is the last honest moment to say what it is about to start.
    { act: "launch", ic: "＋", label: "New session", sub: live ? `${live} already running here` : `start ${agent.label} in this folder` },
    { act: "worktree", ic: "⑃", label: "New worktree session…", sub: "on a branch of its own" },
    { act: "terminal", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    // Always present, even with only Claude installed: the picker behind it is the one
    // place that says which agents Episko supports and looked for.
    { act: "agents", logo: agentLogo(agent.id), label: `Agent · ${agent.label}`, sub: agentSub(key), chev: true },
    // Only with more than one GitHub account logged in, the only case where it can change
    // an answer; "GitHub · you" on every menu would be noise.
    ghPickable(ghLogins)
      ? { act: "ghacct", ic: "◈", label: `GitHub · ${ghWho(ghAccountFor(key), ghLogins).login ?? "—"}`, sub: ghSub(key), chev: true }
      : null,
    { act: "sharing", ic: "⇄", label: `Sharing · ${SHARE_LABEL[shareModeOf(key)]}`, sub: SHARE_SUB[shareModeOf(key)], chev: true },
    null,
    // Dropped below unless the probe says this folder is a repo.
    { act: "graph", ic: "⑂", label: "Commit graph…", sub: "recent history, branches and merges" },
    { act: "folder", ic: "⌂", label: "Open project folder", sub: FILE_MANAGER },
    { act: "copypath", ic: "⧉", label: "Copy path" },
    null,
    grouped
      ? { act: "movegroup", ic: "▤", label: `Group · ${grouped.name}`, sub: "move to another, or take it out", chev: true }
      : { act: "movegroup", ic: "▤", label: "Add to group…", sub: "collect projects under one collapsible heading", chev: true },
    { act: "appearance", ic: "◐", label: "Appearance", sub: "color, logo", chev: true },
    null,
    // A project can be listed without being pinned (it has a live session), so the row is
    // about permanence, not presence; "add" would read as a lie about a listed project.
    fav
      ? { act: "removeproj", ic: "✕", label: "Remove project", sub: "unpins it; sessions keep running", cls: "mp-danger" }
      : { act: "addproj", ic: "☆", label: "Pin to sidebar", sub: "keeps it listed with no session running" },
  ];
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head">`
    + (ic ? `<img class="mp-hico" src="${ic}" alt="" />` : `<span class="mp-hsw" style="background:${accentFor(key)}"></span>`)
    + `<span class="mp-hmain"><span class="mp-hname">${esc(projName(key))}</span><span class="mp-hpath">${esc(tilde(key))}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
  // Asked after opening so the menu feels instant, then the shorter menu is re-placed. One
  // probe answers both rows: `git_head` is None for anything but a repo with a commit, and
  // a null `branch` is a detached HEAD, with a history to graph but no branch to fork from.
  invoke<{ branch: string | null; short: string } | null>("git_head", { workdir: key }).then((h) => {
    if (ctxKey !== key) return; // menu closed or moved to another project meanwhile
    const drop = (act: string) => menu.querySelector<HTMLElement>(`[data-ctx="${act}"]`)?.remove();
    if (!h) { drop("worktree"); drop("graph"); placePop(menu, x, y); return; }
    if (!h.branch) { drop("worktree"); placePop(menu, x, y); return; }
    const sub = menu.querySelector('[data-ctx="worktree"] .mp-s');
    if (sub) sub.textContent = `branch off ${h.branch}`;
  }).catch(() => {});
}
export function closeCtxMenu() { $("ctxMenu").classList.remove("show", "agent-all"); ctxKey = wtTarget = gTarget = pickPath = brTarget = sessTarget = null; }
export const ctxMenuOpen = () => $("ctxMenu").classList.contains("show");

// ---------- worktree cluster context menu ----------
// Right-click on a ⑃ cluster header. Not the project menu with different rows: a cluster
// is one checkout, whose verbs act on `dir` while belonging to `root` (the project's
// colorKey); conflating them would put a worktree session in a project group of its own.
type WtTarget = { dir: string; root: string; project: string; branch: string; isMain: boolean };
let wtTarget: WtTarget | null = null;

// What removing this checkout would cost, said before it is clicked. An external session
// blocks it outright: the backend can't see one, and git would delete the folder under it.
function removeRow(t: WtTarget): CtxRow {
  const ext = externals.filter((e) => e.cwd === t.dir).length;
  if (ext) return { act: "wtremove", ic: "⌫", label: "Remove worktree…", sub: `blocked: ${ext} session${ext > 1 ? "s" : ""} running outside Episko`, cls: "dis" };
  const live = [...sessions.values()].filter((s) => s.workdir === t.dir).length;
  const sub = live
    ? `closes ${live} session${live > 1 ? "s" : ""}, then deletes the folder`
    : "deletes the folder; the branch only if merged";
  return { act: "wtremove", ic: "⌫", label: "Remove worktree…", sub, cls: "mp-danger" };
}

// Main checkout only: a worktree exists so its branch doesn't move, so there the row is
// absent rather than greyed (unlike removal, whose absence would look like a bug). When
// busy it names what to wait for; *All worktrees…* one row up lists those sessions.
function switchRow(t: WtTarget): CtxRow {
  const busy = busyIn(t.dir);
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
  ctxKey = brTarget = sessTarget = null; // one #ctxMenu, one target
  wtTarget = t;
  // No `menuX`/`menuY` stamp: those exist for the drill-downs that re-open a menu at its
  // own coordinates (agents, groups, gh), and this menu has none.
  const live = [...sessions.values()].filter((s) => s.workdir === t.dir && isAgent(s)).length;
  const rows: (CtxRow | null)[] = [
    // No agent row: the override is keyed by repo (`colorKey`), which every checkout of it
    // launches under, so a per-worktree picker would set something other than it appeared to.
    { act: "wtlaunch", ic: "＋", label: "New session here", sub: live ? `${live} already running in this checkout` : `start ${effectiveAgent(t.root).label} on this branch` },
    { act: "wtterm", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label },
    null,
    { act: "wtfolder", ic: "⌂", label: "Open checkout folder", sub: FILE_MANAGER },
    { act: "wtcopy", ic: "⧉", label: "Copy path" },
    null,
    { act: "wtdialog", ic: "⑃", label: "All worktrees…", sub: "create, switch, prune" },
    // A spread, not a null: in this list a null is a separator.
    ...(t.isMain ? [switchRow(t)] : []),
    null,
    // git refuses to remove the main checkout; saying so beats dropping the row.
    t.isMain
      ? { act: "", ic: "⌫", label: "Remove worktree…", sub: "this is the repo's main checkout", cls: "dis" }
      : removeRow(t),
  ];
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
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
    // The dialog is the repo's, so it opens on the root (the only cwd `git worktree add`
    // runs from), in manage mode and focused at this checkout.
    case "wtdialog": openWt(t.project, t.root, null, { manage: true, focusDir: t.dir }); break;
    // Same dialog, opened on the answer: `armSwitch` paints the repo row's switch card. The
    // row is main-only, so `t.branch` is the branch being left; seed it or the card reads "—".
    case "wtswitch": openWt(t.project, t.root, t.branch, { manage: true, armSwitch: true }); break;
    case "wtremove": void removeWorktreeAt(t.project, t.root, t.dir, t.branch); break;
  }
});

// ---------- the sidebar's session rows ----------
// Right-click a row under a project. One mode for all three kinds, because they answer the same
// question and differ only in how much of the session is ours: a live pane, a shelved one (a row
// and a transcript) or an external one (neither). The row's own glyph and label head it.
type SessTarget = { kind: "live" | "past" | "ext"; id: string; row: HTMLElement };
let sessTarget: SessTarget | null = null;

// Sessions mid-turn in a checkout, ours and other people's: what a branch switch must wait for.
const busyIn = (dir: string) =>
  [...sessions.values()].filter((s) => s.workdir === dir && midFlight(s)).length
  + externals.filter((e) => e.cwd === dir && extWorking(e)).length;

// Where the branch pop hangs: the row you right-clicked, or its twin in the sidebar if a repaint
// has replaced it meanwhile — this menu is long closed by the time git answers.
function rowAnchor(t: SessTarget): HTMLElement {
  if (t.row.isConnected) return t.row;
  const attr = t.kind === "live" ? "sel" : t.kind === "past" ? "past" : "ext";
  return $("projects").querySelector<HTMLElement>(`.srow[data-${attr}="${t.id}"]`) ?? t.row;
}
const termRow = (): CtxRow => ({
  act: "sterm", ic: "❯", label: "Open terminal here",
  sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label,
});
const folderRow: CtxRow = { act: "sfolder", ic: "⌂", label: "Open folder", sub: FILE_MANAGER };
const copyRow: CtxRow = { act: "scopy", ic: "⧉", label: "Copy path" };

// The app-wide map rather than `Sess.git`, which is only fresh while the pane is on stage.
// Greyed rather than dropped, because the row is on every other agent's menu — and a folder
// nobody has read is not a clean one.
function wsetRow(dir: string): CtxRow {
  const row = { ic: "◧", label: "Review working set…" };
  if (!dirtyByFolder.has(dir)) return { ...row, act: "", sub: "not read yet", cls: "dis" };
  const g = dirtyByFolder.get(dir);
  if (!g) return { ...row, act: "", sub: "not a git repository", cls: "dis" };
  if (!isDirty(g)) return { ...row, act: "", sub: "nothing uncommitted", cls: "dis" };
  return { ...row, act: "swset", sub: dirtyCount(g) };
}
// What ✕ costs here: a finished pane is a row to clear, a working one is work to stop. A running
// task spells out the difference from ■ Stop two rows up, which keeps the pane and its output.
const closeSub = (s: Sess) => isExited(s)
  ? "takes the finished pane off the list"
  : s.kind === "task" ? "stops it, and the pane goes with it"
    : midWork(s) ? "it is still working — this stops it now" : "ends the process and closes the pane";

// A task pane's own verbs, the ones the inspector's card has had all along: a row you can only
// close is not what this menu is for. ⟳ replaces the pane rather than adding one (./taskrun), so
// it says *again* rather than *run*, and a definition that has gone says so instead of toasting.
function taskRows(s: Sess): (CtxRow | null)[] {
  const r = s.run!;
  const spec = lastRunnableById.get(r.id);
  const running = !isExited(s);
  const again = running ? "stops it and starts it over"
    : r.groupId ? "this step only — the chain's other steps are not repeated"
      : "in this pane, with the same parameters";
  return [
    spec
      ? { act: "srerun", ic: "⟳", label: "Run again", sub: again }
      : { act: "", ic: "⟳", label: "Run again", sub: "its definition is gone — rescan with ▶ Run", cls: "dis" },
    ...(spec?.inputs.length ? [{ act: "sreparams", ic: "⋯", label: "Run again with…", sub: "change what it runs with" }] : []),
    ...(running ? [{ act: "sstop", ic: "■", label: "Stop", sub: "kills the process; the pane and its output stay" }] : []),
    null,
  ];
}
// Beside *Open folder*, because both answer "where does this come from"; the pin is the ▶ Run
// picker's, and belongs to the task rather than to this pane.
const taskWhereRows = (s: Sess): CtxRow[] => [
  { act: "sreveal", ic: "↗", label: "Reveal source", sub: s.run!.sourceFile || basename(s.run!.root) },
  pinnedIds(s.colorKey).includes(s.run!.id)
    ? { act: "spin", ic: "★", label: "Unpin from ▶ Run", sub: "back into the list with the rest" }
    : { act: "spin", ic: "☆", label: "Pin to ▶ Run", sub: "keeps it at the top of the picker" },
];

// A spread, not a null: in these lists a null is a separator. ⇩ follows `canShelve`, which the
// header's own button reads, so the two never disagree about what can be put down.
function liveRows(s: Sess): (CtxRow | null)[] {
  const busy = busyIn(s.workdir);
  const d = s.drift;
  const task = s.kind === "task" && !!s.run;
  return [
    ...(task ? taskRows(s) : []),
    termRow(),
    ...(s.branch ? [busy
      ? { act: "", ic: "⇄", label: "Switch branch…", sub: `waiting: ${busy} session${busy > 1 ? "s" : ""} still working here`, cls: "dis" }
      : { act: "sswitch", ic: "⇄", label: "Switch branch…", sub: `${basename(s.workdir)}/ is on ${s.branch}` }] : []),
    // The two drifts cost different things to repair, so they are not one row (docs/worktrees.md).
    ...(d ? [d.via === "cwd"
      ? { act: "sdrift", ic: "⤳", label: `Follow it to ${d.branch}`, sub: "it moved itself; Episko catches up" }
      : { act: "sdrift", ic: "⤳", label: `Move it to ${d.branch}`, sub: "ends it, takes the conversation, resumes there" }] : []),
    null,
    // Only an agent's folder is measured (./mirror's dirty sweep), so a shell or task has no
    // working set to review and says nothing about one.
    ...(isAgent(s) ? [wsetRow(s.workdir)] : []),
    ...(task ? taskWhereRows(s) : []),
    folderRow,
    copyRow,
    null,
    ...(canShelve(s) ? [{ act: "sshelve", ic: "⇩", label: "Shelve session", sub: "stops it now; the row stays, and resumes" }] : []),
    { act: "sclose", ic: "✕", label: "Close session", sub: closeSub(s), cls: "mp-danger" },
  ];
}
function pastRows(d: Restorable): (CtxRow | null)[] {
  return [
    dormantBusy(d)
      ? { act: "", ic: "⟲", label: "Resume session", sub: "already running — it cannot be resumed twice", cls: "dis" }
      : { act: "sresume", ic: "⟲", label: "Resume session", sub: `picks the conversation up · last active ${relTime(d.lastActivity)}` },
    termRow(),
    null,
    folderRow,
    copyRow,
    null,
    // Not destructive, and the sub must say so: the conversation is the provider's, not this row.
    { act: "sforget", ic: "✕", label: "Take off the shelf", sub: "clears the row; the conversation stays on disk" },
  ];
}
// Nothing here stops it: Episko did not start it, and `kill_session` cannot reach it.
function extRows(e: ExtSession): (CtxRow | null)[] {
  return [
    { act: "sjump", ic: "↗", label: "Jump to its terminal", sub: `Claude v${e.version} · pid ${e.pid}` },
    termRow(),
    null,
    wsetRow(e.cwd),
    folderRow,
    copyRow,
  ];
}

// The folder the ⌂/⧉/❯ rows mean. A drifted pane is working somewhere else, and the header
// already says so; a task's own root is where it runs.
const sessDir = (s?: Sess | null, d?: Restorable | null, e?: ExtSession | null) =>
  s ? (s.drift?.dir ?? paneDir(s)) : d ? d.workdir : e ? e.cwd : "";

function openSessionMenu(kind: SessTarget["kind"], id: string, row: HTMLElement, x: number, y: number) {
  const s = kind === "live" ? sessions.get(id) : null;
  const d = kind === "past" ? dormants.find((r) => r.id === id) : null;
  const e = kind === "ext" ? externals.find((r) => r.session_id === id) : null;
  if (!s && !d && !e) return;
  closeColorPop();
  ctxKey = wtTarget = gTarget = pickPath = brTarget = null; // one #ctxMenu, one target
  sessTarget = { kind, id, row };
  const working = !!e && extWorking(e);
  const g = s ? rowGlyph(s)
    : e ? { glyph: working ? GLYPH.working : GLYPH.idle, cls: working ? GCLASS.working : GCLASS.idle }
      : { glyph: GLYPH.ended, cls: GCLASS.ended };
  const name = s ? rowLabel(s) : d ? pastLabel(d) : (e!.name || basename(e!.cwd));
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hgl ${g.cls}">${g.glyph}</span>`
    + `<span class="mp-hmain"><span class="mp-hname">${esc(name)}</span>`
    + `<span class="mp-hpath">${esc(tilde(sessDir(s, d, e)))}</span></span></div>`
    + ctxRowsHtml(s ? liveRows(s) : d ? pastRows(d) : extRows(e!));
  placePop(menu, x, y);
}
$("ctxMenu").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !sessTarget || b.classList.contains("dis")) return;
  const t = sessTarget;
  // Read the session again rather than trusting the menu: markup outlives the state that drew
  // it, and a pane can exit or be shelved from somewhere else while this is up.
  const s = t.kind === "live" ? sessions.get(t.id) : null;
  const d = t.kind === "past" ? dormants.find((r) => r.id === t.id) : null;
  const e = t.kind === "ext" ? externals.find((r) => r.session_id === t.id) : null;
  const dir = sessDir(s, d, e);
  const anchor = rowAnchor(t);
  closeCtxMenu(); closeColorPop();
  switch (b.dataset.ctx) {
    // A live pane's shell is ⌘T's: it keeps the pane's colorKey and splits beside it when
    // Settings says so. The other two have no pane to sit beside.
    case "sterm": if (s) host.openShellFor(s.id); else if (dir) openTerminalIn(d ? d.project : basename(e?.repo_root || dir), dir); break;
    case "sfolder": if (dir) host.openProjectFolder(dir); break;
    case "scopy": if (dir) void copyPath(dir); break;
    case "sswitch": if (s) void openSessionBranchPop(anchor, s.id); break;
    case "sdrift": if (s) void followSessionDrift(s.id); break;
    // ./taskrun owns every one of these; the rerun closes this pane and opens the next itself.
    case "srerun": if (s) void rerunTask(s); break;
    case "sreparams": if (s) void rerunTask(s, true); break;
    case "sstop": if (s) void invoke("kill_session", { sessionId: s.id }).catch(() => {}); break;
    case "sreveal": if (s?.run) revealSource(s.run.root, s.run.sourceFile); break;
    case "spin": if (s?.run) togglePin(s.colorKey, s.run.id); break;
    // The inspector's own card: the launch checkout, titled the way that card titles it.
    case "swset":
      if (s) void openDiff(s.workdir, s.project + (s.branch ? " · " + s.branch : ""));
      else if (e) void openDiff(e.cwd, e.name || basename(e.cwd));
      break;
    case "sshelve": if (s) void shelveSessionAsked(s.id); break;
    case "sclose": if (s) host.closeSession(s.id); break;
    case "sresume": if (d) resumeDormant(d.id); break;
    case "sforget": if (d) forgetDormant(d.id); break;
    case "sjump": if (e) jumpExternal(e.pid); break;
  }
});

// ---------- the Branches view's row menu ----------
// Right-click a branch row, or its ⋯. The verbs arrive as a callback rather than as host
// entries: the two menus above are the app's, where this one belongs to one view and every
// row of it means something only the dashboard knows.
export interface BranchTarget {
  branch: string;
  root: string;   // the project's own folder: what a session here is keyed and coloured by
  dir: string;    // where a session would start; "" when the branch has no checkout yet
  live: number;   // sessions already running there
  lock: { by: "episko" | "github"; exact: boolean; text: string } | null;
  // The switch moves `root` and nothing else, so the row NAMES it: in a repo with five
  // worktrees "this folder" points at nothing, and the one it would move is the one the
  // dashboard is open on. `hereBranch` is what that folder is on now.
  hereBranch: string;
  switchNote: string;  // "" when that folder can move to the branch, else why it cannot
}
let brTarget: BranchTarget | null = null;
let brRun: (act: string) => void = () => {};

// Four states, because two of them cannot be lifted from here: GitHub's rule is not ours to
// edit, and a glob covers siblings nobody named on this row.
function lockRow(t: BranchTarget): CtxRow {
  if (!t.lock) {
    return { act: "brprotect", ic: "🔒", label: "Protect branch", sub: "no delete here, for everyone who pulls the repo" };
  }
  if (t.lock.by === "github") {
    return { act: "", ic: "🔒", label: "Protected on GitHub", sub: "a branch protection rule or ruleset guards it", cls: "dis" };
  }
  if (!t.lock.exact) {
    return { act: "", ic: "🔒", label: "Protected by a pattern", sub: `${t.lock.text} — edit the file to change it`, cls: "dis" };
  }
  // ⊘ is this menu's "clear the setting", which is what unprotecting is.
  return { act: "brunprotect", ic: "⊘", label: "Unprotect branch", sub: "removes it from .episko/episko.toml" };
}

// The folder by name, because it is one of several: `episko/`, not "this folder". What it
// is on now is the other half of the answer — a switch is a move from somewhere.
function switchRowFor(t: BranchTarget): CtxRow {
  const label = `Switch ${basename(t.root)}/ to it`;
  const here = t.hereBranch ? `the project's own folder, on ${t.hereBranch} now` : "the project's own folder";
  return t.switchNote
    ? { act: "", ic: "⇄", label, sub: t.switchNote, cls: "dis" }
    : { act: "brswitch", ic: "⇄", label, sub: here };
}

export function openBranchMenu(t: BranchTarget, x: number, y: number, run: (act: string) => void) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = pickPath = sessTarget = null; // one #ctxMenu, one target
  brTarget = t;
  brRun = run;
  const rows: (CtxRow | null)[] = [
    {
      act: "brlaunch", ic: "＋", label: "New session here",
      sub: t.dir
        ? (t.live ? `${t.live} already running in this checkout` : `start ${effectiveAgent(t.root).label} on this branch`)
        : "makes a worktree for this branch, then starts",
    },
    // A terminal needs a folder to open in, and a branch with no checkout has none.
    ...(t.dir ? [{ act: "brterm", ic: "❯", label: "Open terminal here", sub: termEngine === "embedded" ? "shell pane inside Episko" : engineDef(termEngine).label }] : []),
    switchRowFor(t),
    null,
    lockRow(t),
    { act: "brcopy", ic: "⧉", label: "Copy branch name" },
  ];
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(t.branch)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">${esc(t.branch)}</span>`
    + `<span class="mp-hpath">${esc(t.dir ? tilde(t.dir) : "no checkout yet")}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
}

$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || !brTarget || b.classList.contains("dis")) return;
  const act = b.dataset.ctx || "";
  const run = brRun;
  closeCtxMenu(); closeColorPop();
  run(act);
});

// ---------- which agent this project runs: the picker ----------
// A drill-down of the one #ctxMenu (a list of rows, so it replaces the menu in place with
// ‹ Back). It sets a per-project preference and does not launch: nobody switches agent
// per session, so `＋ New session` reads the stored answer.

// Names where the answer came from: a repo pinned to Codex must not read the same as one
// inheriting Codex from the default, or clearing a forgotten override is guesswork.
function agentSub(key: string): string {
  if (agentByProject[key]) return "set for this project";
  const n = allAgents().length - 1;
  return n ? `the default · ${n} other${n === 1 ? "" : "s"} installed` : "the default · nothing else installed";
}

// Sticky for the app's life, not per open: re-collapsing under somebody who expanded it
// would read as the menu forgetting.

// ---------- which GitHub account this project reads as ----------
// A copy of the agent picker on purpose: the same shape of question. It exists because
// `gh` holds one active account per host, and the failure when it is the wrong one is a
// "could not be resolved" that names no account and suggests no fix.

// The same three states `ghWho` returns: "set for this project" and "gh's default" look
// alike on the row above and are the whole answer when the reads are failing.
function ghSub(key: string): string {
  const w = ghWho(ghAccountFor(key), ghLogins);
  if (w.source !== "pinned") return "gh's active account";
  return w.known ? "set for this project" : "set for this project · gh is not logged in as it";
}

export function openGhPicker(at: HTMLElement | DOMRect, key: string) {
  const cur = ghAccountFor(key);
  const w = ghWho(cur, ghLogins);
  const accounts: MenuItem[] = ghLogins.map((a) => ({
    id: `pick:${a.login}`, label: a.login, mark: a.login === w.login ? "✓" : "",
    // The tick marks the effective account; this line tells a pin from the default.
    sub: a.login === cur ? "set for this project" : a.active ? "gh's active account" : "logged in, not active",
  }));
  // A pin gh has forgotten is still in force (the backend refuses the read rather than
  // answering as somebody else), so it gets a row of its own to be seen and cleared.
  if (cur && !w.known) {
    accounts.push({ id: "", label: cur, mark: "✓", disabled: true,
      sub: "set for this project · gh is not logged in as it" });
  }
  openMenu(at, {
    title: "GitHub account", accent: accentFor(key),
    sub: `${projName(key)} · reads as ${w.login ?? "—"}`,
    groups: [
      { items: accounts },
      { items: cur ? [{ id: "clear", mark: "⊘", label: "Follow gh's active account",
        sub: "what every project with no setting uses" }] : [] },
    ],
    onPick: (id) => {
      host.setGhAccount(key, id === "clear" ? null : id.slice(5));
      host.renderAll();
    },
  });
}

// ---------- where a project's shared notes and work log go (docs/sync.md) ----------
const SHARE_LABEL: Record<ShareMode, string> = { git: "Git", server: "Sync server", off: "Nowhere" };
const SHARE_SUB: Record<ShareMode, string> = {
  git: "notes and the work log are committed in .episko/",
  server: "the team sees them through sync; nothing in the repo",
  off: "nothing is shared, and nothing is offered",
};
export function openSharePicker(at: HTMLElement | DOMRect, key: string) {
  const cur = shareModeOf(key);
  openMenu(at, {
    title: "Sharing", accent: accentFor(key),
    sub: `${projName(key)} · where shared notes and the work log go`,
    groups: [{ items: (["git", "server", "off"] as ShareMode[]).map((m) => ({
      id: m, label: SHARE_LABEL[m], mark: m === cur ? "✓" : "", sub: SHARE_SUB[m],
    })) }],
    onPick: (id) => { host.setShareMode(key, id as ShareMode); host.renderAll(); },
  });
}

export function openAgentPicker(at: HTMLElement | DOMRect, key: string) {
  const cur = agentByProject[key];
  const missing = missingAgents();
  // Claude plus what the probe found: a row here promises the binary exists.
  const installed: MenuItem[] = allAgents().map((a) => ({
    id: `pick:${a.id}`, logo: agentLogo(a.id), label: a.label, mark: a.id === cur ? "✓" : "",
    // The tick marks the override, not the effective agent: ticking an inherited row
    // would make "Follow the default" below it look like a no-op.
    sub: a.id === cur ? "set for this project"
      : a.capabilities.length ? `integrated — ${agentCapabilitySummary(a)}`
      : tilde(a.path ?? ""),
  }));
  openMenu(at, {
    title: "Agent", accent: accentFor(key),
    sub: `${projName(key)} · runs ${effectiveAgent(key).label}`,
    groups: [
      { items: installed },
      { items: cur ? [{ id: "clear", mark: "⊘", label: "Follow the default",
        sub: `Settings › Launching · ${defaultAgentDef().label}` }] : [] },
      // What Episko supports but this machine lacks: shown and inert, so a missing row is
      // not read as "not supported". The binary name says what was searched for on PATH.
      { label: missing.length ? "Not on this machine" : "",
        items: missing.map((a) => ({
          id: "", logo: agentLogo(a.id), label: a.label, disabled: true, sub: `not on PATH · ${a.bin}`,
        })) },
    ],
    onPick: (id) => {
      host.setProjectAgent(key, id === "clear" ? null : id.slice(5));
      host.renderAll();
    },
  });
}


// ---------- project groups: the picker, and a group's own menu ----------
// Drill-downs, not submenus: "which group?" is a list of rows, so it replaces the menu in
// place with ‹ Back. Naming a group is an inline <input> in the menu (as .sw-hex is in the
// colour panel): one short string, and a modal would be heavier than what it creates.
let pickPath: string | null = null;   // the project being filed
let gTarget: string | null = null;    // the group whose menu is open

const groupCount = (gid: string) => groupPaths(projGroups, gid).length;
const nameField = (placeholder: string, value = "") =>
  `<div class="mp-new"><input class="mp-in" type="text" spellcheck="false" autocomplete="off" maxlength="40"`
  + ` placeholder="${esc(placeholder)}" value="${esc(value)}" /></div>`;
const focusField = () => setTimeout(() => $("ctxMenu").querySelector<HTMLInputElement>(".mp-in")?.focus(), 30);

function openGroupPicker(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = sessTarget = null;
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
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(key)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Group</span><span class="mp-hpath">${esc(projName(key))}</span></span></div>`
    + ctxRowsHtml(rows) + nameField("New group…");
  placePop(menu, x, y);
  focusField();
}

function openGroupMenu(gid: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = pickPath = sessTarget = null;
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
    // Only worth offering with more than one group; otherwise it repeats the row above.
    ...(many ? [null, { act: "gcollapseall", ic: "⇱", label: "Collapse all groups" }, { act: "gexpandall", ic: "⇲", label: "Expand all groups" }] as (CtxRow | null)[] : []),
    null,
    // Destroys only the heading, and the sub must say so.
    { act: "gdelete", ic: "✕", label: "Delete group", sub: "the projects stay, at the top level", cls: "mp-danger" },
  ];
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
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
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw mp-hfold"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Rename</span><span class="mp-hpath">${esc(g.name)}</span></span></div>`
    + nameField("Group name", g.name);
  placePop(menu, menuX, menuY);
  focusField();
  setTimeout(() => menu.querySelector<HTMLInputElement>(".mp-in")?.select(), 40);
}

// One listener for all the drill-downs, each guarded on its own target.
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || b.classList.contains("dis")) return;
  const act = b.dataset.ctx || "";
  if (pickPath) {
    const path = pickPath;
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
// The name field carries no `data-ctx`, so the click listeners above ignore it while typing.
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

// Appearance opens rather than commits: the panel hangs off the menu's edge. Re-entrant,
// since `mouseover` fires per child span crossed and a re-render would wipe a half-typed hex.
function openAppearanceSub(row: HTMLElement) {
  if (!ctxKey || row.classList.contains("sub-open")) return;
  row.classList.add("sub-open");
  const m = $("ctxMenu").getBoundingClientRect(), r = row.getBoundingClientRect();
  openColorPopover(ctxKey, m.right + 6, r.top - 6, m);
}
// Hover opens the submenu and any other row folds it away; moving right into the panel
// leaves the menu entirely, so nothing here fires.
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
  // Drill-downs replace the menu in place, so they take keepMenuOpen and must not reach the close below.
  if (b.dataset.ctx === "movegroup") { keepMenuOpen(e); openGroupPicker(key, menuX, menuY); return; }
  // Not a drill-down any more: the picker is its own popover, so the menu behind it goes.
  if (b.dataset.ctx === "agents") { const r = b.getBoundingClientRect(); closeCtxMenu(); openAgentPicker(r, key); return; }
  if (b.dataset.ctx === "ghacct") { const r = b.getBoundingClientRect(); closeCtxMenu(); openGhPicker(r, key); return; }
  if (b.dataset.ctx === "sharing") { const r = b.getBoundingClientRect(); closeCtxMenu(); openSharePicker(r, key); return; }
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
// `data-wt` is matched first and on its own: a ⑃ cluster header sits inside a project
// group, so one `[data-key],[data-wt]` closest() would be decided by tree distance.
// `data-gid` is the same rule one level up, and why it sits on the fold's header, not the fold.
document.addEventListener("contextmenu", (e) => {
  const fold = (e.target as HTMLElement).closest<HTMLElement>("[data-gid]");
  if (fold?.dataset.gid) {
    e.preventDefault();
    openGroupMenu(fold.dataset.gid, e.clientX, e.clientY);
    return;
  }
  // Before [data-key]: a shelved or external row carries the project key itself, and the menu
  // for the row you clicked is not the menu for its project.
  const row = (e.target as HTMLElement).closest<HTMLElement>(".srow");
  if (row) {
    const sel = row.dataset.sel || "", past = row.dataset.past || "", ext = row.dataset.ext || "";
    if (sel || past || ext) {
      e.preventDefault();
      const kind = sel ? "live" : past ? "past" : "ext";
      openSessionMenu(kind, sel || past || ext, row, e.clientX, e.clientY);
      return;
    }
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
