// The ⌘K palette's UI, to ./palette's decisions — the same split tasks.ts / taskui.ts
// already has, and the reason moving this buys no coverage: fuzzy matching, scoring,
// prefix parsing and frecency are extracted and tested next door (39 tests). What is
// here is the box, the group assembly, the row markup and the key handling.
//
// It renders on demand and never from renderAll(), so unlike the sidebar/footer/tray
// slices this one is size-and-readability only.
//
// It is also the widest-reaching surface in the app — a palette row can do almost
// anything the app can do — which is why it takes a host object rather than ten
// setters, exactly as settings.ts does (PLAN: "a control panel may take one host
// object instead of N setters").

import { $, chord, FILE_MANAGER, MOD } from "./dom";
import { esc, tilde } from "./format";
import { iconFor } from "./icons";
import { setEngine } from "./footer";
// runGit went to ./panes with the rest of a session's lifecycle, so it is a plain
// import rather than a host member (seam rule 1).
import { runGit } from "./panes";
import { verbFor } from "./inspectorview";
import { bumpFrec, frecScore, parsePal, scoreItem, type PalItem } from "./palette";
import { taskStateText } from "./sidebarview";
import { isAgent, type Runnable, type Sess } from "./types";
import { allProjects, needsYou, orderedSessions, urgencyRank } from "./grouping";
import { openWt, removeWorktreeSession } from "./worktree";
import {
  askTrust, openInputPrompt, openRunPicker, openTaskManager, runTargetCtx,
} from "./taskui";
import { discoverTasks, execCmd, launchWithDeps } from "./tasks";
import {
  accentFor, availEngines, engineDef, sessions, termEngine,
} from "./state";

// Everything a palette row can do that this module does not own. Twelve callees is
// past the point where per-callee setters read as anything but noise, so this follows
// settings.ts and takes one host; all default to no-ops so the module stands alone.
let host: {
  setActive: (id: string) => void;
  resolvePermission: (id: string, behavior: string) => void;
  openPlainTerminal: () => void;
  closeSession: (id: string) => void;
  addProject: () => void;
  cycleSort: () => void;
  toggleInsp: () => void;
  toggleRail: () => void;
  toggleTheme: () => void;
  requestLaunch: (project: string, path: string) => void;
  revealActiveFolder: () => void;
  openProjectFolder: (key: string) => void;
} = {
  setActive: () => {}, resolvePermission: () => {},
  openPlainTerminal: () => {}, closeSession: () => {}, addProject: () => {},
  cycleSort: () => {}, toggleInsp: () => {}, toggleRail: () => {},
  toggleTheme: () => {}, requestLaunch: () => {},
  revealActiveFolder: () => {}, openProjectFolder: () => {},
};
export function setPaletteHost(h: typeof host) { host = h; }

// ---------- palette (⌘K) ----------
// A fused switcher + command runner. Prefixes scope the search (⟩ commands,
// @ sessions/projects, / by state); results are grouped with the "Needs you" set
// pinned on top, fuzzy-matched with highlight, and frecency-ranked. ⌘K on a session
// opens an action panel (jump, terminal, worktree, kill, answer permission) without
// leaving the box — a page stack you back out of with Backspace/Esc.
interface PalGroup { name: string; count?: number; items: PalItem[] }
let palGroups: PalGroup[] = [];
let palFlat: PalItem[] = [];   // the selectable rows, in display order
let palSel = 0;
let palPage: "root" | "actions" = "root";
let palActionSess: Sess | null = null;

// The ⌘K-within action list for one session.
function sessionActions(s: Sess): PalItem[] {
  const mk = (label: string, glyph: string, run: () => void): PalItem => ({ kind: "action", key: "", label, labelHtml: esc(label), glyph, run });
  const a: PalItem[] = [mk("Jump to session", "→", () => host.setActive(s.id))];
  if (s.pendingPermId) {
    a.push(mk("Allow the pending permission", "✓", () => host.resolvePermission(s.pendingPermId!, "allow")));
    a.push(mk("Deny the pending permission", "✕", () => host.resolvePermission(s.pendingPermId!, "deny")));
    a.push(mk("Answer it in the terminal", "❯", () => host.resolvePermission(s.pendingPermId!, "terminal")));
  }
  if (isAgent(s)) {
    // Only offered for repo sessions — s.git is null when the workdir isn't one.
    if (s.git) {
      const b = s.git.behind, ah = s.git.ahead;
      a.push(mk("Fetch from the remote", "↻", () => runGit(s.id, "fetch")));
      a.push(mk(b ? `Pull ${b} commit${b === 1 ? "" : "s"}` : "Pull (fast-forward only)", "↓", () => runGit(s.id, "pull")));
      a.push(mk(ah ? `Push ${ah} commit${ah === 1 ? "" : "s"}` : "Push", "↑", () => runGit(s.id, "push")));
    }
    a.push(mk("Open a terminal here", "❯", () => { host.setActive(s.id); host.openPlainTerminal(); }));
  // Not gated on isAgent — every pane kind has a real directory behind it (a task's
  // run cwd, a shell's launch dir), and unlike ⌘⏎ this names *this* session's
  // folder rather than whichever one holds the stage.
  a.push(mk(`Reveal folder in ${FILE_MANAGER}`, "⌂", () => host.openProjectFolder(s.workdir)));
    a.push(mk("New session here…", "⑃", () => openWt(s.project, s.colorKey)));
    // Only when this session lives in a worktree (not the repo's main checkout):
    // clean up its worktree (and merged branch) without dropping to a shell.
    if (s.worktree) a.push(mk("Remove this worktree…", "⌫", () => removeWorktreeSession(s)));
  }
  a.push(mk("Close session", "✕", () => host.closeSession(s.id)));
  return a;
}
const PAL_CMDS: { key: string; label: string; glyph: string; run: () => void; sc?: string[] }[] = [
  { key: "cmd:add", label: "Add a project folder…", glyph: "＋", run: host.addProject },
  { key: "cmd:term", label: "Open a terminal in the current project", glyph: "❯", run: host.openPlainTerminal, sc: [MOD, "T"] },
  { key: "cmd:folder", label: `Reveal the current folder in ${FILE_MANAGER}`, glyph: "⌂", run: host.revealActiveFolder, sc: [MOD, "⏎"] },
  { key: "cmd:run", label: "Run a task in the current project…", glyph: "▶", run: () => { void openRunPicker(); }, sc: [MOD, "⇧", "R"] },
  { key: "cmd:tasks", label: "Manage this project's tasks…", glyph: "✎", run: () => { void openTaskManager(); } },
  { key: "cmd:sort", label: "Change the sidebar sort order", glyph: "≡", run: host.cycleSort },
  { key: "cmd:insp", label: "Toggle the inspector", glyph: "◨", run: host.toggleInsp, sc: [MOD, "I"] },
  { key: "cmd:rail", label: "Toggle the sidebar", glyph: "◧", run: host.toggleRail, sc: [MOD, "B"] },
  { key: "cmd:theme", label: "Toggle the theme", glyph: "◐", run: host.toggleTheme },
];
function buildPalGroups(raw: string): PalGroup[] {
  // action panel page — one group of the target session's actions, fuzzy-filtered
  if (palPage === "actions" && palActionSess) {
    const t = raw.trim();
    const items = sessionActions(palActionSess).map((it) => scoreItem(it, t)).filter(Boolean) as PalItem[];
    items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const label = palActionSess.title || palActionSess.branch || "session";
    return [{ name: `↩ ${palActionSess.project} · ${label}`, items }];
  }
  const { mode, term } = parsePal(raw);
  const searchTerm = mode === "filter" ? "" : term;   // in /filter mode the term is a state, not a name
  const emptyTerm = !searchTerm;
  const order = new Map(orderedSessions().map((s, i) => [s.id, i]));
  const stateOf = (s: Sess) => (s.attention ? "waiting" : s.phase);
  const matchesState = mode === "filter" && term ? (s: Sess) => stateOf(s).startsWith(term.toLowerCase()) : () => true;

  const sessCands: PalItem[] = [...sessions.values()].filter(matchesState).map((s) => {
    const i = order.get(s.id);
    const label = `${s.project} · ${s.kind === "task" ? "▶ " + (s.run?.label ?? "task") : s.title || s.branch || (s.kind === "shell" ? "shell" : "session")}`;
    const sub = s.kind === "shell" ? "shell"
      : s.kind === "task" ? `task · ${taskStateText(s)}`
      : `${verbFor(s).toLowerCase()}${s.ctxPct != null ? ` · ${Math.round(s.ctxPct)}% ctx` : ""}${s.cost != null ? ` · $${s.cost.toFixed(2)}` : ""}`;
    return { kind: "session", key: "session:" + s.id, label, labelHtml: esc(label), sub, sw: accentFor(s.colorKey), icon: iconFor(s.colorKey) || undefined, shortcut: i != null && i < 9 ? [MOD, String(i + 1)] : undefined, session: s, run: () => host.setActive(s.id) };
  });
  // Tasks for the active project. Discovery is async, so this reads a cache the
  // palette warms on open — an empty first frame is corrected in place.
  const taskCands: PalItem[] = palTasks.map((r) => ({
    kind: "task", key: "task:" + r.id, label: `Run ${r.label}`, labelHtml: esc(`Run ${r.label}`),
    sub: `${r.source} · ${execCmd(r)}`, glyph: r.blocked ? "⃠" : "▶",
    run: () => {
      const c = runTargetCtx(); if (!c) return;
      const o = { colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, discoveredIn: c.workdir };
      if (r.id === "just:__untrusted") { void askTrust(c.colorKey, c.project); return; }
      if (r.inputs.length) { openInputPrompt(r, c.project, o); return; }
      void launchWithDeps(r, c.project, o);
    },
  }));
  // Same source as the sidebar (see allProjects) — a project detected from an external
  // session is just as launchable as a favourite, and hiding it here made "+ Session"
  // with nothing selected look like it was picking projects at random.
  const launchCands: PalItem[] = allProjects().map((p) => ({ kind: "launch", key: "launch:" + p.path, label: `Launch ${p.name}`, labelHtml: esc(`Launch ${p.name}`), sub: tilde(p.path), sw: accentFor(p.path), icon: iconFor(p.path) || undefined, run: () => host.requestLaunch(p.name, p.path) }));
  const cmdCands: PalItem[] = PAL_CMDS.map((c) => ({ kind: "command", key: c.key, label: c.label, labelHtml: esc(c.label), sub: "command", glyph: c.glyph, shortcut: c.sc, run: c.run }));
  for (const id of availEngines) { const d = engineDef(id); cmdCands.push({ kind: "command", key: "engine:" + id, label: `New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`, labelHtml: esc(`New sessions in ${d.label}${id === termEngine ? " ✓" : ""}`), sub: d.sub, glyph: id === "embedded" ? "▤" : "⧉", run: () => setEngine(id) }); }

  const score = (arr: PalItem[]) => arr.map((it) => scoreItem(it, searchTerm)).filter(Boolean) as PalItem[];
  const byScore = (a: PalItem, b: PalItem) => (b.score ?? 0) - (a.score ?? 0);
  const byFrec = (a: PalItem, b: PalItem) => frecScore(b.key) - frecScore(a.key);
  const sessNatural = (a: PalItem, b: PalItem) => urgencyRank(a.session!) - urgencyRank(b.session!) || b.session!.lastActivity - a.session!.lastActivity;

  const sess = score(sessCands), launch = score(launchCands), cmds = score(cmdCands), tsk = score(taskCands);
  const needy = sess.filter((i) => needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);
  const rest = sess.filter((i) => !needsYou(i.session!)).sort(emptyTerm ? sessNatural : byScore);

  const groups: PalGroup[] = [];
  const recentKeys = new Set<string>();
  if (mode !== "cmd" && needy.length) groups.push({ name: "Needs you", count: needy.length, items: needy });
  if (emptyTerm && mode === "all") {
    const recent = [...cmds, ...launch, ...tsk].filter((i) => frecScore(i.key) > 0).sort(byFrec).slice(0, 3);
    recent.forEach((i) => recentKeys.add(i.key));
    if (recent.length) groups.push({ name: "Recent", items: recent });
  }
  if (mode !== "cmd" && rest.length) groups.push({ name: "Sessions", count: rest.length, items: rest });
  if (mode === "all" || mode === "sess") { const l = launch.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (l.length) groups.push({ name: "Launch", items: l }); }
  if (mode === "all" || mode === "sess") { const t = tsk.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (t.length) groups.push({ name: "Tasks", count: t.length, items: t }); }
  if (mode === "all" || mode === "cmd") { const c = cmds.filter((i) => !recentKeys.has(i.key)).sort(emptyTerm ? byFrec : byScore); if (c.length) groups.push({ name: "Commands", items: c }); }
  if (!groups.length) groups.push({ name: "No matches", items: [{ kind: "fallback", key: "", label: "Add a project folder…", labelHtml: esc("Add a project folder…"), glyph: "＋", run: host.addProject }] });
  return groups;
}
function runPalItem(it: PalItem | undefined) { if (!it) return; bumpFrec(it.key); closePalette(); it.run(); }
function openPalActions(s: Sess) { palPage = "actions"; palActionSess = s; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function popPalPage() { palPage = "root"; palActionSess = null; const inp = $("palInput") as HTMLInputElement; inp.value = ""; palSel = 0; refreshPal(); inp.focus(); }
function renderPal() {
  let idx = 0;
  const html = palGroups.map((g) => {
    const rows = g.items.map((it) => {
      const i = idx++;
      const ic = it.icon ? `<img class="pal-icimg" src="${it.icon}" alt="" />` : it.sw ? `<span class="sw" style="background:${it.sw}"></span>` : (it.glyph || "›");
      const sh = it.shortcut ? `<span class="pal-sh">${it.shortcut.map((k) => `<span class="k">${esc(k)}</span>`).join("")}</span>`
        : it.session ? `<span class="pal-sh actions"><span class="k">${chord("K")}</span></span>` : "";
      return `<div class="pal-item ${i === palSel ? "on" : ""}" data-i="${i}"><span class="pal-ic">${ic}</span><span class="pal-main"><span class="pm">${it.labelHtml}</span>${it.sub ? `<span class="ps">${esc(it.sub)}</span>` : ""}</span>${sh}</div>`;
    }).join("");
    return `<div class="pal-gh">${esc(g.name)}${g.count ? `<span class="gc">${g.count}</span>` : ""}</div>${rows}`;
  }).join("");
  $("palList").innerHTML = html || `<div class="pal-item"><span class="pal-main"><span class="pm" style="color:var(--muted)">No matches</span></span></div>`;
  $("palList").querySelectorAll<HTMLElement>(".pal-item[data-i]").forEach((el) => el.addEventListener("click", () => runPalItem(palFlat[+el.dataset.i!])));
  const foot = $("palFoot");
  foot.innerHTML = palPage === "actions"
    ? `<span>↵ run</span><span>⌫ back</span><span class="sp"></span><span>esc close</span>`
    : `<span class="pf-mode">⟩ command</span><span>@ project</span><span>/ state</span><span class="sp"></span><span>${chord("K")} actions · esc</span>`;
  $("palList").querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}
function refreshPal() { palGroups = buildPalGroups(($("palInput") as HTMLInputElement).value); palFlat = palGroups.flatMap((g) => g.items); palSel = 0; renderPal(); }
let palTasks: Runnable[] = [];
export function openPalette() {
  palPage = "root"; palActionSess = null; palSel = 0;
  const c = runTargetCtx();
  palTasks = [];
  if (c) void discoverTasks(c.workdir, c.colorKey).then((l) => { palTasks = l; if ($("palette").classList.contains("show")) refreshPal(); });
  $("scrim").classList.add("show");
  $("palette").classList.add("show");
  ($("palInput") as HTMLInputElement).value = "";
  refreshPal();
  setTimeout(() => ($("palInput") as HTMLInputElement).focus(), 30);
}
export function closePalette() { $("scrim").classList.remove("show"); $("palette").classList.remove("show"); palPage = "root"; palActionSess = null; }

$("palInput").addEventListener("input", refreshPal);
$("palInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const val = ($("palInput") as HTMLInputElement).value;
  if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, palFlat.length - 1); renderPal(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); renderPal(); }
  else if (e.key === "Enter") { e.preventDefault(); runPalItem(palFlat[palSel]); }
  else if (meta && e.key.toLowerCase() === "k") {
    // ⌘K on a session opens its action panel; otherwise swallow it so the global
    // handler doesn't close the palette out from under an open action list.
    e.preventDefault(); e.stopPropagation();
    const it = palFlat[palSel];
    if (palPage === "root" && it?.session) openPalActions(it.session);
  }
  else if (e.key === "Backspace" && !val && palPage === "actions") { e.preventDefault(); popPalPage(); }
  else if (e.key === "Escape") { if (palPage === "actions") { e.preventDefault(); popPalPage(); } else closePalette(); }
});
