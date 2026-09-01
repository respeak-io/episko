// The project context menu, the worktree one, and the appearance panel the sidebar's
// colour dots share. Every mode shares the one #ctxMenu and its .mp-* skin, so each opener
// clears every other mode's target. Nothing here is on renderAll()'s path.

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
import { agentCapabilitySummary, isAgent, isExited, midFlight } from "./types";
import { agentLogo } from "./providers/logos";
import {
  accentFor, activeId, agentByProject, allAgents, colorOverrides, defaultAgentDef, effectiveAgent,
  engineDef, externals, FAVORITES, ghAccountFor, ghLogins, missingAgents, projGroups, sessions,
  termEngine,
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
  openProjectFolder: (key: string) => void;
  addProjectPath: (dir: string) => void;
  removeFavorite: (path: string) => void;
} = {
  renderAll: () => {}, requestLaunch: () => {}, launchWorktree: () => {}, launchShell: () => {},
  setProjectAgent: () => {}, openProjectFolder: () => {}, addProjectPath: () => {}, removeFavorite: () => {},
  setGhAccount: () => {},
};
export function setProjMenuHost(h: typeof host) { host = h; }

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
// Opens standalone at the cursor or as the context menu's submenu; `flipFrom` is the
// parent menu's rect, so a panel that won't fit to its right lands on its left instead.
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
  // Every button here commits, so the whole stack (submenu + menu) closes with it.
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
const ctxRowsHtml = (rows: (CtxRow | null)[]) =>
  rows.map((r) => (r ? ctxRowHtml(r) : `<div class="mp-sep"></div>`)).join("");

// Where the menu was opened, so a drill-down and its ‹ Back land on the same pixels.
let menuX = 0, menuY = 0;

function openCtxMenu(key: string, x: number, y: number) {
  closeColorPop();
  wtTarget = gTarget = pickPath = agentKey = ghKey = null; // one #ctxMenu, one target
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
export function closeCtxMenu() { $("ctxMenu").classList.remove("show", "agent-all"); ctxKey = wtTarget = gTarget = pickPath = agentKey = ghKey = null; }
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
  ctxKey = null; // one #ctxMenu, one target
  wtTarget = t;
  menuX = x; menuY = y;
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

// ---------- which agent this project runs: the picker ----------
// A drill-down of the one #ctxMenu (a list of rows, so it replaces the menu in place with
// ‹ Back). It sets a per-project preference and does not launch: nobody switches agent
// per session, so `＋ New session` reads the stored answer.
let agentKey: string | null = null;   // the project whose agent is being chosen

// Names where the answer came from: a repo pinned to Codex must not read the same as one
// inheriting Codex from the default, or clearing a forgotten override is guesswork.
function agentSub(key: string): string {
  if (agentByProject[key]) return "set for this project";
  const n = allAgents().length - 1;
  return n ? `the default · ${n} other${n === 1 ? "" : "s"} installed` : "the default · nothing else installed";
}

// Sticky for the app's life, not per open: re-collapsing under somebody who expanded it
// would read as the menu forgetting.
let agentShowAll = false;

// ---------- which GitHub account this project reads as ----------
// A copy of the agent picker on purpose: the same shape of question. It exists because
// `gh` holds one active account per host, and the failure when it is the wrong one is a
// "could not be resolved" that names no account and suggests no fix.
let ghKey: string | null = null;   // the project whose account is being chosen

// The same three states `ghWho` returns: "set for this project" and "gh's default" look
// alike on the row above and are the whole answer when the reads are failing.
function ghSub(key: string): string {
  const w = ghWho(ghAccountFor(key), ghLogins);
  if (w.source !== "pinned") return "gh's active account";
  return w.known ? "set for this project" : "set for this project · gh is not logged in as it";
}

function openGhPicker(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = pickPath = agentKey = null; // one #ctxMenu, one target
  ghKey = key;
  const cur = ghAccountFor(key);
  const w = ghWho(cur, ghLogins);
  const rows: (CtxRow | null)[] = [
    { act: "hback", ic: "‹", label: "Back", sub: projName(key) },
    null,
    ...ghLogins.map((a) => ({
      act: `hpick:${a.login}`, ic: a.login === w.login ? "✓" : "▪", label: a.login,
      // The tick marks the effective account; this line tells a pin from the default.
      sub: a.login === cur ? "set for this project" : a.active ? "gh's active account" : "logged in, not active",
    })),
    // A pin gh has forgotten is still in force (the backend refuses the read rather than
    // answering as somebody else), so it gets a row of its own to be seen and cleared.
    cur && !w.known ? { act: `hpick:${cur}`, ic: "✓", label: cur, sub: "set for this project · gh is not logged in as it", cls: "dis" } : null,
    cur ? { act: "hclear", ic: "⊘", label: "Follow gh's active account", sub: "what every project with no setting uses" } : null,
  ];
  const menu = $("ctxMenu");
  menu.classList.remove("agent-all");
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(key)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">GitHub account</span>`
    + `<span class="mp-hpath">${esc(projName(key))} · reads as ${esc(w.login ?? "—")}</span></span></div>`
    + ctxRowsHtml(rows);
  placePop(menu, x, y);
}

function openAgentPicker(key: string, x: number, y: number) {
  closeColorPop();
  ctxKey = wtTarget = gTarget = pickPath = ghKey = null; // one #ctxMenu, one target
  agentKey = key;
  const cur = agentByProject[key];
  const eff = effectiveAgent(key);
  const missing = missingAgents();
  const rows: (CtxRow | null)[] = [
    { act: "aback", ic: "‹", label: "Back", sub: projName(key) },
    null,
    // Claude plus what the probe found: a row here promises the binary exists.
    ...allAgents().map((a) => ({
      act: `apick:${a.id}`, logo: agentLogo(a.id), label: a.label,
      // The tick marks the override, not the effective agent: ticking an inherited row
      // would make "Follow the default" below it look like a no-op.
      sub: a.id === cur ? "✓ set for this project"
        : a.capabilities.length ? `integrated — ${agentCapabilitySummary(a)}`
        : tilde(a.path ?? ""),
    })),
    cur ? { act: "aclear", ic: "⊘", label: "Follow the default", sub: `Settings › Sessions · ${defaultAgentDef().label}` } : null,
    // Below the fold, what Episko supports but this machine lacks: folded so they don't
    // bury the pickable rows, present so a missing row isn't read as "not supported".
    ...(missing.length ? [null, {
      act: "amore", ic: agentShowAll ? "−" : "+",
      label: `${missing.length} more supported`,
      sub: agentShowAll ? "installed ones are above" : "not found on this machine",
    }] as (CtxRow | null)[] : []),
    // `cls: "dis"` makes them inert: every click listener on this menu bails on a `.dis` row.
    ...(agentShowAll
      ? missing.map((a) => ({
        act: "", logo: agentLogo(a.id), label: a.label, cls: "dis",
        // The binary name says exactly what Episko searched PATH for, and cannot rot like a URL.
        sub: `not on PATH · ${a.bin}`,
      }))
      : []),
  ];
  const menu = $("ctxMenu");
  menu.classList.toggle("agent-all", agentShowAll);
  menu.innerHTML =
    `<div class="mp-head"><span class="mp-hsw" style="background:${accentFor(key)}"></span>`
    + `<span class="mp-hmain"><span class="mp-hname">Agent</span><span class="mp-hpath">${esc(projName(key))} · runs ${esc(eff.label)}</span></span></div>`
    + `<div class="agent-pick-list">${ctxRowsHtml(rows)}</div>`;
  placePop(menu, x, y);
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
  ctxKey = wtTarget = gTarget = agentKey = ghKey = null;
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
  ctxKey = wtTarget = pickPath = agentKey = ghKey = null;
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

// A row that re-renders this menu instead of committing must stop the click dead, and
// stopPropagation is not enough: main.ts's outside-click closer sees the original target
// detached by the innerHTML swap and closes the menu, and the sibling click listeners on
// #ctxMenu still run, find their target set again by the reopen, and fall through to closeCtxMenu().
const keepMenuOpen = (e: Event) => e.stopImmediatePropagation();

// One listener for all the drill-downs, each guarded on its own target.
$("ctxMenu").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-ctx]");
  if (!b || b.classList.contains("dis")) return;
  const act = b.dataset.ctx || "";
  if (agentKey) {
    const key = agentKey;
    if (act === "aback") { keepMenuOpen(e); closeCtxMenu(); openCtxMenu(key, menuX, menuY); return; }
    // The fold is a re-render in place, not a commit, like ‹ Back.
    if (act === "amore") { keepMenuOpen(e); agentShowAll = !agentShowAll; openAgentPicker(key, menuX, menuY); return; }
    // A row this picker did not draw leaves the menu alone.
    if (act !== "aclear" && !act.startsWith("apick:")) return;
    closeCtxMenu();
    host.setProjectAgent(key, act === "aclear" ? null : act.slice(6));
    return;
  }
  if (ghKey) {
    const key = ghKey;
    if (act === "hback") { keepMenuOpen(e); closeCtxMenu(); openCtxMenu(key, menuX, menuY); return; }
    if (act !== "hclear" && !act.startsWith("hpick:")) return;
    closeCtxMenu();
    host.setGhAccount(key, act === "hclear" ? null : act.slice(6));
    return;
  }
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
  if (b.dataset.ctx === "agents") { keepMenuOpen(e); openAgentPicker(key, menuX, menuY); return; }
  if (b.dataset.ctx === "ghacct") { keepMenuOpen(e); openGhPicker(key, menuX, menuY); return; }
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
