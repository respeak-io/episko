// The two task surfaces: the project tasks panel (from ⌘K) and the ▶ Run picker. What
// can't run says so: a blocked row is greyed, never dropped. .episko/tasks.toml is the
// only file written; editing a discovered task writes an [override."<id>"] there.

import { invoke } from "@tauri-apps/api/core";
import { $, toast } from "./dom";
import { ask } from "./confirm";
import { dlog } from "./debug";
import { basename, elidePath, esc, tilde } from "./format";
import type { Runnable } from "./types";
import { activeId, dashMirror, externals, extMirrorId, keyPrefs, sessions } from "./state";
import { activeBind, comboMatches } from "./keys";
import { bumpFrec, forgetFrec, frecScore } from "./palette";
import {
  applyInputs, discoverTasks, execCmd, hiddenIds, launchWithDeps, pinnedIds,
  prefillInputs, PROVIDER_LABEL, rememberedInput, rememberInput, rescanTasks, resolveRunInputs, RUNNERS,
  runnerFor, setRunner, stopRuleBlocked, stopRules, toggleHidden, togglePin,
  toggleStopRule, trustProject,
  type Provider, type Runner, type TaskLaunchOpts,
} from "./tasks";

// What these panels change but do not own.
export interface TaskUiHost {
  launchTask: (r: Runnable, project: string, opts?: TaskLaunchOpts) => Promise<string | null>;
  handToTerminal: (project: string, workdir: string, cmd: string, opts?: { colorKey?: string; worktree?: string | null; branch?: string }) => Promise<void>;
  activeProjectCtx: () => { project: string; path: string } | null;
  activeCwd: () => string | null;
  setActive: (id: string) => void;
  renderAll: () => void;
  closePalette: () => void;
}
let host: TaskUiHost = {
  launchTask: async () => null, handToTerminal: async () => {},
  activeProjectCtx: () => null, activeCwd: () => null, setActive: () => {},
  renderAll: () => {}, closePalette: () => {},
};
export function setTaskUiHost(h: TaskUiHost) { host = h; }

// The task manager. Hiding a task is yours (localStorage); a task's command is the
// project's (.episko/tasks.toml, committable).

let mgrCtx: { project: string; colorKey: string; workdir: string } | null = null;
let mgrList: Runnable[] = [];
let mgrOverrides: string[] = [];  // discovered ids the project overrides
// kind decides where a save lands: "own" writes a [[task]], "override" an [override."<id>"].
export let mgrEdit: { id: string | null; kind: "own" | "override"; label: string; run: string; group: string; background: boolean; cwd: string } | null = null;

export async function openTaskManager() {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  mgrCtx = { project: c.project, colorKey: c.colorKey, workdir: c.workdir };
  mgrEdit = null;
  await refreshMgr();
  $("mgrDlg").classList.add("show");
  $("scrim").classList.add("show");
}
async function refreshMgr() {
  if (!mgrCtx) return;
  // Hidden tasks too: this is the panel where you un-hide them.
  mgrList = await discoverTasks(mgrCtx.workdir, mgrCtx.colorKey, true);
  mgrOverrides = await invoke<string[]>("list_task_overrides", { workdir: mgrCtx.workdir }).catch(() => []);
  renderMgr();
}
export function closeTaskManager() {
  $("mgrDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
  mgrCtx = null; mgrEdit = null;
}

export function renderMgr() {
  if (!mgrCtx) return;
  const { colorKey, project } = mgrCtx;
  $("mgrSub").textContent = project;

  const editing = !!mgrEdit;
  ($("mgrBack") as HTMLButtonElement).hidden = !editing;
  ($("mgrSave") as HTMLButtonElement).hidden = !editing;
  ($("mgrNew") as HTMLButtonElement).hidden = editing;
  ($("mgrOpen") as HTMLButtonElement).hidden = editing;
  ($("mgrRescan") as HTMLButtonElement).hidden = editing;
  if (mgrEdit) { renderMgrForm(); return; }

  const pins = pinnedIds(colorKey), hid = hiddenIds(colorKey);
  const rule = stopRules[colorKey];
  const rowsHtml = mgrList.map((r) => {
        const own = r.source === "episko";
        const overridden = mgrOverrides.includes(r.id);
        const dangling = r.id.startsWith("override:");   // an override whose target vanished
        const editable = !r.blocked;
        // One stop rule per project, so the glyph is a radio: clicking another moves it.
        const onStop = rule?.id === r.id;
        const noStop = stopRuleBlocked(r);
        const tags = `${r.background ? " · bg" : ""}${overridden ? " · overridden" : ""}${r.blocked ? " · " + esc(r.blocked) : ""}${onStop ? " · runs after each turn" : ""}`;
        const editBtn = own
          ? `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit in .episko/tasks.toml">✎</button>
             <button class="mgr-b danger" data-del="${esc(r.id)}" title="Delete from .episko/tasks.toml">✕</button>`
          : `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit. Writes an override into .episko/tasks.toml, never ${esc(r.sourceFile)}">✎</button>`;
        const revertBtn = (overridden || dangling)
          ? `<button class="mgr-b" data-revert="${esc(dangling ? r.id.slice("override:".length) : r.id)}" title="Revert to what ${esc(r.sourceFile)} declares">↺</button>`
          : "";
        return `<div class="mgr-row${hid.includes(r.id) ? " off" : ""}">
          <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.sourceFile)}${tags}</small></span>
          <span class="mgr-acts">
            <button class="mgr-b${pins.includes(r.id) ? " on" : ""}" data-pin="${esc(r.id)}" title="${pins.includes(r.id) ? "Unpin" : "Pin to the top of the picker"}">${pins.includes(r.id) ? "★" : "☆"}</button>
            <button class="mgr-b" data-hide="${esc(r.id)}" title="${hid.includes(r.id) ? "Show in the picker" : "Hide from the picker"}">${hid.includes(r.id) ? "◌" : "◎"}</button>
            <button class="mgr-b${onStop ? " on" : ""}${noStop ? " quiet" : ""}" ${noStop ? "disabled" : ""} data-onstop="${esc(r.id)}"
              title="${noStop ? esc(`Can't run after a turn: ${noStop}`) : onStop ? "Stop running this after a turn" : "Run this whenever a session in this project finishes a turn"}">⟲</button>
            ${revertBtn}${editable ? editBtn : ""}
          </span>
        </div>`;
      }).join("");
  // Only when the project has npm scripts, so it never implies a knob that does nothing.
  const runnerStrip = mgrList.some((r) => r.source === "npm")
    ? `<div class="mgr-row mgr-runner">
         <span class="txt"><b>Package runner</b><small>the lockfile picks this; override a repo that ships the wrong one</small></span>
         <span class="s-ctl">${RUNNERS.map((rn) =>
           `<button class="opt${runnerFor(colorKey) === rn ? " on" : ""}" data-runner="${rn}">${rn}</button>`).join("")}</span>
       </div>`
    : "";
  $("mgrBody").innerHTML = mgrList.length ? runnerStrip + rowsHtml : `<div class="run-empty">No tasks found in this project.</div>`;

  $("mgrBody").querySelectorAll<HTMLElement>("[data-pin]").forEach((el) =>
    el.addEventListener("click", () => { togglePin(colorKey, el.dataset.pin!); renderMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-hide]").forEach((el) =>
    el.addEventListener("click", () => { toggleHidden(colorKey, el.dataset.hide!); renderMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-onstop]").forEach((el) =>
    el.addEventListener("click", () => {
      const r = mgrList.find((x) => x.id === el.dataset.onstop!);
      if (!r) return;
      toggleStopRule(colorKey, r);
      toast(stopRules[colorKey]?.id === r.id
        ? `${r.label} will run when a session here finishes a turn`
        : `${r.label} no longer runs after a turn`);
      renderMgr();
    }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-runner]").forEach((el) =>
    el.addEventListener("click", () => { setRunner(colorKey, el.dataset.runner as Runner); void refreshMgr(); }));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-edit]").forEach((el) =>
    el.addEventListener("click", () => startMgrEdit(el.dataset.edit!)));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-revert]").forEach((el) =>
    el.addEventListener("click", () => void revertMgrOverride(el.dataset.revert!)));
  $("mgrBody").querySelectorAll<HTMLElement>("[data-del]").forEach((el) =>
    el.addEventListener("click", () => void deleteMgrTask(el.dataset.del!)));
}

function startMgrEdit(id: string | null) {
  const r = id ? mgrList.find((x) => x.id === id) : null;
  const kind: "own" | "override" = r && r.source !== "episko" ? "override" : "own";
  mgrEdit = r
    ? { id: r.id, kind, label: r.label, run: r.exec.mode === "shell" ? r.exec.line : execCmd(r), group: r.group ?? "", background: r.background, cwd: "" }
    : { id: null, kind: "own", label: "", run: "", group: "", background: false, cwd: "" };
  renderMgr();
}

async function revertMgrOverride(id: string) {
  if (!mgrCtx) return;
  try {
    await invoke("remove_task_override", { workdir: mgrCtx.workdir, id });
    toast(`Reverted “${id}” to its own definition`);
    await refreshMgr();
  } catch (err) { toast("revert failed: " + err); }
}

function renderMgrForm() {
  const e = mgrEdit!;
  const note = e.kind === "override"
    ? `<div class="mgr-note">Saving writes an <b>override</b> into <code>.episko/tasks.toml</code>. The original stays as its tool declared it; ↺ Revert removes the override.</div>`
    : "";
  $("mgrBody").innerHTML = note + `
    <div class="in-field"><label class="in-lbl">Label</label>
      <input class="in-ctl" id="mgrLabel" value="${esc(e.label)}" placeholder="Dev server" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Command<span class="in-id">runs in a login shell</span></label>
      <input class="in-ctl" id="mgrRun" value="${esc(e.run)}" placeholder="pnpm tauri dev" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Working directory<span class="in-id">optional · relative</span></label>
      <input class="in-ctl" id="mgrCwd" value="${esc(e.cwd)}" placeholder="src-tauri" spellcheck="false" /></div>
    <div class="in-field"><label class="in-lbl">Group</label>
      <span class="s-ctl">${["", "build", "test", "run", "check", "clean"].map((g) =>
        `<button class="opt${g === e.group ? " on" : ""}" data-group="${g}">${g || "none"}</button>`).join("")}</span></div>
    <div class="in-field"><label class="in-lbl">Long-running<span class="in-id">a server or watcher, never “done”</span></label>
      <span class="s-ctl"><button class="opt${e.background ? " on" : ""}" data-bg="1">background</button></span></div>`;

  $("mgrBody").querySelectorAll<HTMLElement>("[data-group]").forEach((el) =>
    el.addEventListener("click", () => { mgrEdit!.group = el.dataset.group!; syncMgrForm(); renderMgr(); }));
  $("mgrBody").querySelector("[data-bg]")?.addEventListener("click", () => {
    mgrEdit!.background = !mgrEdit!.background; syncMgrForm(); renderMgr();
  });
  ($("mgrLabel") as HTMLInputElement).focus();
}
// Keep typed text when a click re-renders the form.
function syncMgrForm() {
  if (!mgrEdit) return;
  mgrEdit.label = ($("mgrLabel") as HTMLInputElement).value;
  mgrEdit.run = ($("mgrRun") as HTMLInputElement).value;
  mgrEdit.cwd = ($("mgrCwd") as HTMLInputElement).value;
}

async function saveMgrTask() {
  if (!mgrCtx || !mgrEdit) return;
  syncMgrForm();
  const e = mgrEdit;
  if (!e.label.trim() || !e.run.trim()) { toast("A task needs a label and a command"); return; }

  // A new committable file in someone's repo is asked about once, never created silently.
  const [path, exists] = await invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir });
  if (!exists) {
    const ok = await ask(
      `Episko will create ${tilde(path)}.\n\nIt's a normal file in your repo. Commit it and your team gets these tasks too, in any editor.`,
      { title: "Create .episko/tasks.toml?", kind: "info", okLabel: "Create", cancelLabel: "Cancel" });
    if (!ok) return;
  }
  const task = { label: e.label.trim(), run: e.run.trim(), group: e.group || null, background: e.background, cwd: e.cwd.trim() || null };
  try {
    if (e.kind === "override") {
      // The override is keyed by the discovered id verbatim ("vscode:test").
      await invoke("save_task_override", { workdir: mgrCtx.workdir, id: e.id, task });
      toast(`Overrode ${e.label}`);
    } else {
      // Discovery ids are namespaced ("episko:dev"); the file addresses the bare slug.
      await invoke("save_episko_task", { workdir: mgrCtx.workdir, id: e.id ? e.id.replace(/^episko:/, "") : null, task });
      toast(e.id ? `Updated ${e.label}` : `Added ${e.label}`);
    }
    mgrEdit = null;
    await refreshMgr();
  } catch (err) {
    toast("save failed: " + err);
    dlog("error", `save task: ${err}`);
  }
}

async function deleteMgrTask(id: string) {
  if (!mgrCtx) return;
  const r = mgrList.find((x) => x.id === id);
  const ok = await ask(`Delete “${r?.label ?? id}” from .episko/tasks.toml?`, {
    title: "Delete task?", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
  });
  if (!ok) return;
  try {
    await invoke("delete_episko_task", { workdir: mgrCtx.workdir, id: id.replace(/^episko:/, "") });
    await refreshMgr();
  } catch (err) { toast("delete failed: " + err); }
}

// ---------- the ▶ Run picker ----------
let runCtx: { project: string; colorKey: string; worktree: string | null; branch: string; workdir: string } | null = null;
let runList: Runnable[] = [];
let runSel = 0;
let runSource: string | null = null;   // jump-bar filter; null = every source

export function runTargetCtx() {
  const wd = host.activeCwd();
  if (!wd) return null;
  const s = activeId ? sessions.get(activeId) : null;
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  // The dashboard names its own project; the sidebar's label is what the pane should carry.
  const dm = dashMirror();
  return {
    workdir: wd,
    project: s ? s.project : e ? basename(e.repo_root || e.cwd) : dm ? dm.name : basename(wd),
    colorKey: s ? s.colorKey : e ? (e.repo_root || e.cwd) : wd,
    worktree: s ? s.worktree : null,
    branch: s ? s.branch : (e?.branch || ""),
  };
}

export async function openRunPicker() {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  runCtx = { project: c.project, colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, workdir: c.workdir };
  runList = await discoverTasks(c.workdir, c.colorKey);
  runSel = 0;
  runSource = null;
  // Elide the middle: with worktrees the last segment says which checkout this runs in.
  const where = `${c.project}${c.worktree ? " · ⑃ " + c.branch : ""} · `;
  const sub = $("runSub");
  sub.textContent = where + elidePath(tilde(c.workdir));
  sub.title = where + tilde(c.workdir);
  const pop = $("runPop");
  pop.classList.add("show");
  $("scrim").classList.add("show");
  renderRunPicker("");
  const inp = $("runInput") as HTMLInputElement;
  inp.value = "";
  setTimeout(() => inp.focus(), 20);
}
export function closeRunPicker() {
  $("runPop").classList.remove("show");
  if (!$("palette").classList.contains("show")) $("scrim").classList.remove("show");
  runCtx = null;
}

// Short chip labels for the jump bar; group headers use the Runnable's own sourceFile,
// which is what discovery found (a repo with `Justfile` is not told it has a `justfile`).
const sourceShort = (r: Runnable) => PROVIDER_LABEL[r.source as Provider] || r.source;

function runMatches(term: string): Runnable[] {
  const t = term.trim().toLowerCase();
  const match = (r: Runnable) => !t || r.label.toLowerCase().includes(t) || execCmd(r).toLowerCase().includes(t) || (r.group || "").includes(t);
  return runList.filter(match);
}

// Built from the search results, so a chip never promises rows the term filtered away.
function runSources(term: string): { src: string; short: string; count: number }[] {
  const out: { src: string; short: string; count: number }[] = [];
  for (const r of runMatches(term)) {
    const hit = out.find((o) => o.src === r.source);
    if (hit) hit.count++;
    else out.push({ src: r.source, short: sourceShort(r), count: 1 });
  }
  return out;
}

const RUN_RECENT_MAX = 5;  // a shortcut to the few you keep re-running, not a second list

function runGroups(term: string): { name: string; sub?: string; items: Runnable[] }[] {
  const list = runMatches(term).filter((r) => !runSource || r.source === runSource);
  const pins = runCtx ? pinnedIds(runCtx.colorKey) : [];
  const groups: { name: string; sub?: string; items: Runnable[] }[] = [];
  // Rows lifted into pinned/recent leave their source group, so nothing appears twice.
  const lifted = new Set<string>();
  // Pinned float only in the unfiltered view; inside one source it would just hide them.
  const pinned = runSource ? [] : list.filter((r) => pins.includes(r.id));
  if (pinned.length) { groups.push({ name: "pinned", items: pinned }); pinned.forEach((r) => lifted.add(r.id)); }
  // Recent: ranked by the palette's frecency (every launch bumps `task:<id>`), and only in
  // the unfiltered view, where typing or a source chip is not already a narrower intent.
  if (!runSource && !term.trim()) {
    const recent = list
      .filter((r) => !lifted.has(r.id) && !r.blocked && frecScore("task:" + r.id) > 0)
      .sort((a, b) => frecScore("task:" + b.id) - frecScore("task:" + a.id))
      .slice(0, RUN_RECENT_MAX);
    if (recent.length) { groups.push({ name: "recent", items: recent }); recent.forEach((r) => lifted.add(r.id)); }
  }
  const bySource = new Map<string, Runnable[]>();
  for (const r of list) {
    if (lifted.has(r.id)) continue;
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }
  for (const [, items] of bySource) {
    groups.push({ name: items[0].sourceFile || sourceShort(items[0]), sub: String(items.length), items });
  }
  return groups;
}

function renderRunTabs(term: string) {
  const srcs = runSources(term);
  const bar = $("runTabs");
  // One source is not a choice — the bar would just be a label taking up a row.
  bar.hidden = srcs.length < 2;
  if (bar.hidden) return;
  const total = srcs.reduce((n, s2) => n + s2.count, 0);
  bar.innerHTML =
    `<button class="run-tab${runSource === null ? " on" : ""}" data-src="">All<span class="n">${total}</span></button>` +
    srcs.map((s2) =>
      `<button class="run-tab${runSource === s2.src ? " on" : ""}" data-src="${esc(s2.src)}">${esc(s2.short)}<span class="n">${s2.count}</span></button>`).join("");
  bar.querySelectorAll<HTMLElement>("[data-src]").forEach((el) =>
    el.addEventListener("click", () => setRunSource(el.dataset.src || null)));
}

function setRunSource(src: string | null) {
  runSource = src;
  runSel = 0;
  renderRunPicker(($("runInput") as HTMLInputElement).value);
  ($("runInput") as HTMLInputElement).focus();
}

// Tab / ⇧Tab step through the jump bar, so the picker stays reachable without the mouse.
function cycleRunSource(dir: 1 | -1) {
  const srcs = runSources(($("runInput") as HTMLInputElement).value);
  if (srcs.length < 2) return;
  const order: (string | null)[] = [null, ...srcs.map((s2) => s2.src)];
  const i = order.indexOf(runSource);
  setRunSource(order[(i + dir + order.length) % order.length]);
}

function renderRunPicker(term: string) {
  renderRunTabs(term);
  const groups = runGroups(term);
  const flat = groups.flatMap((g) => g.items);
  if (runSel >= flat.length) runSel = Math.max(0, flat.length - 1);
  const body = $("runList");
  if (!flat.length) {
    body.innerHTML = runList.length
      ? `<div class="run-empty">Nothing matches${term ? ` “${esc(term)}”` : ""}${runSource ? ` in ${esc(PROVIDER_LABEL[runSource as Provider] || runSource)}` : ""}.</div>`
      : `<div class="run-empty">No tasks found in this project.<br><span class="dim">Episko reads <code>package.json</code> scripts and <code>.episko/tasks.toml</code>.</span></div>`;
    return;
  }
  let i = 0;
  body.innerHTML = groups.map((g) => {
    const rows = g.items.map((r) => {
      const on = i === runSel ? " on" : "";
      const idx = i++;
      const pinned = runCtx && pinnedIds(runCtx.colorKey).includes(r.id);
      // A task with ${input:…} gets a second verb rather than a forced dialog: the row runs
      // with what it already knows, ⋯ asks. The tooltip shows the command as prefilled.
      const asks = !!r.inputs.length && !r.blocked;
      const ready = asks && runCtx ? prefillInputs(r, runCtx.project) : null;
      return `<div class="run-row${on}${r.blocked ? " blocked" : ""}" data-i="${idx}" title="${esc(r.blocked || execCmd(ready ?? r))}">
        <span class="ic">${r.blocked ? "⃠" : "▸"}</span>
        <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.detail || execCmd(r))}</small></span>
        <span class="end">${r.blocked ? esc(r.blocked) : r.background ? "bg" : pinned ? "★" : ""}</span>
        ${asks ? `<button class="run-params" type="button" data-p="${idx}" title="Run with parameters…">⋯</button>` : ""}
        ${g.name === "recent" ? `<button class="run-forget" type="button" data-forget="${esc(r.id)}" title="Forget — take “${esc(r.label)}” out of recent. It stays under ${esc(r.sourceFile || sourceShort(r))}.">✕</button>` : ""}
      </div>`;
    }).join("");
    return `<div class="run-grp">${esc(g.name)}${g.sub ? `<span class="n">${esc(g.sub)}</span>` : ""}</div>${rows}`;
  }).join("");
  body.querySelectorAll<HTMLElement>(".run-row").forEach((el) => {
    el.addEventListener("click", () => { runSel = +el.dataset.i!; pickRun("run"); });
  });
  body.querySelectorAll<HTMLElement>(".run-params").forEach((el) => {
    // The row's own click runs immediately, so this must stop there.
    el.addEventListener("click", (e) => { e.stopPropagation(); runSel = +el.dataset.p!; pickRun("params"); });
  });
  body.querySelectorAll<HTMLElement>("[data-forget]").forEach((el) => {
    // Without stopPropagation, forgetting a task would also launch it.
    el.addEventListener("click", (e) => { e.stopPropagation(); forgetRecent(el.dataset.forget!); });
  });
  body.querySelector(".run-row.on")?.scrollIntoView({ block: "nearest" });
}

// Take a row out of recent. It drops back to its source group, so say so: a row that
// moves rather than disappears otherwise reads as a misfire. The score is ⌘K's too.
function forgetRecent(id: string) {
  const r = runList.find((x) => x.id === id);
  forgetFrec("task:" + id);
  if (r) toast(`Forgot ${r.label} — still under ${r.sourceFile || sourceShort(r)}`);
  renderRunPicker(($("runInput") as HTMLInputElement).value);
  ($("runInput") as HTMLInputElement).focus();
}

// The selection only while it sits in recent: ⇧⌫ edits that group alone. Recent exists
// only on an empty term, so wherever backspace has text to delete this answers null.
function selectedRecent(): Runnable | null {
  let i = 0;
  for (const g of runGroups(($("runInput") as HTMLInputElement).value)) {
    for (const r of g.items) if (i++ === runSel) return g.name === "recent" ? r : null;
  }
  return null;
}

function pickRun(how: "run" | "pin" | "params") {
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  const r = flat[runSel];
  if (!r || !runCtx) return;
  if (how === "pin") { togglePin(runCtx.colorKey, r.id); renderRunPicker(($("runInput") as HTMLInputElement).value); return; }
  // The trust gate is the one blocked row you can act on.
  if (r.id === "just:__untrusted") { void askTrust(runCtx.colorKey, runCtx.project); return; }
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return; }
  const ctx = runCtx;
  closeRunPicker();
  bumpFrec("task:" + r.id);
  runRunnable(r, ctx.project, { colorKey: ctx.colorKey, worktree: ctx.worktree, branch: ctx.branch, discoveredIn: ctx.workdir }, how === "params");
}

// The single door every attended surface launches through (picker, ⌘K, ⌘⇧B); re-run
// shares `resolveRunInputs`. `withParams` is the explicit Run with parameters… verb and
// always asks. Returns whether it launched, so a chord can toast only when something did.
export function runRunnable(r: Runnable, project: string, opts: TaskLaunchOpts, withParams = false): boolean {
  const ready = resolveRunInputs(r, project, withParams);
  if (!ready) { openInputPrompt(r, project, opts); return false; }
  void launchWithDeps(ready, project, opts);
  return true;
}

// VS Code's ⌘⇧B / ⌘⇧T: the default build (or test) task, usually a compound whose
// `dependsOn` fans out through `launchWithDeps`. An `isDefault` task wins, else a lone
// member of the group; anything else opens the picker rather than guessing.
export async function runDefaultTask(kind: "build" | "test") {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  const all = (await discoverTasks(c.workdir, c.colorKey)).filter((r) => !r.blocked);
  const marked = all.filter((r) => r.defaultFor === kind);
  const inGroup = all.filter((r) => r.group === kind);
  const pick = marked[0] ?? (inGroup.length === 1 ? inGroup[0] : null);
  if (!pick) {
    toast(inGroup.length
      ? `No default ${kind} task; ${inGroup.length} are in the ${kind} group`
      : `No ${kind} task in ${c.project}`);
    await openRunPicker();
    return;
  }
  dlog("info", `${kind} task · ${pick.id} · ${c.project}`);
  bumpFrec("task:" + pick.id);
  const o = { colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, discoveredIn: c.workdir };
  // Prefills like every other run surface; the dialog opens only for an input with no answer.
  if (runRunnable(pick, c.project, o)) toast(`▶ ${pick.label}`);
}

// Trust lets Episko run code from the folder to enumerate tasks: asked plainly, and once.
export async function askTrust(path: string, project: string) {
  const ok = await ask(
    `Episko will run \`just --dump\` inside ${project} to list its recipes.\n\n`
    + `That evaluates the justfile, which can execute code from this folder. Only do this for projects you trust.`,
    { title: `Trust ${project}?`, kind: "warning", okLabel: "Trust and rescan", cancelLabel: "Cancel" });
  if (!ok) return;
  trustProject(path);
  dlog("info", `trusted ${path}`);
  await openRunPicker();
}

// ---------- the panels' own event wiring ----------
$("mgrClose").addEventListener("click", closeTaskManager);
$("mgrNew").addEventListener("click", () => startMgrEdit(null));
$("mgrSave").addEventListener("click", () => { void saveMgrTask(); });
$("mgrBack").addEventListener("click", () => { mgrEdit = null; renderMgr(); });
// `open_file`, not the opener plugin: `openUrl` is scope-checked against `opener:default`,
// which refuses `file://`. `open_file` takes a plain path, as the Context card's rows do.
$("mgrOpen").addEventListener("click", () => {
  if (mgrCtx) void invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir })
    .then(([path]) => invoke("open_file", { path }))
    .catch((e) => toast("open failed: " + e));
});
$("mgrRescan").addEventListener("click", () => { if (mgrCtx) void rescanTasks(mgrCtx.workdir).then(() => refreshMgr()).then(() => toast("Rescanned")); });
$("runInput").addEventListener("input", () => { runSel = 0; renderRunPicker(($("runInput") as HTMLInputElement).value); });
$("runInput").addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  if (e.key === "ArrowDown") { e.preventDefault(); runSel = Math.min(runSel + 1, flat.length - 1); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "ArrowUp") { e.preventDefault(); runSel = Math.max(runSel - 1, 0); renderRunPicker(($("runInput") as HTMLInputElement).value); }
  else if (e.key === "Enter") { e.preventDefault(); pickRun(meta ? "pin" : e.altKey ? "params" : "run"); }
  // The chord that opened the picker is a real rescan inside it. Read from the binding,
  // so it follows a rebind in Settings › Keys.
  else if (comboMatches(activeBind(keyPrefs, "runTask"), e)) { e.preventDefault(); if (runCtx) void rescanTasks(runCtx.workdir).then(() => openRunPicker()); }
  // ⇧⌫ / ⇧⌦ is the ✕ without the mouse. Not a binding: it exists only in this picker,
  // on a group that only exists with an empty search box.
  else if ((e.key === "Backspace" || e.key === "Delete") && e.shiftKey) {
    const r = selectedRecent();
    if (r) { e.preventDefault(); forgetRecent(r.id); }
  }
  else if (e.key === "Tab") { e.preventDefault(); cycleRunSource(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { e.preventDefault(); closeRunPicker(); }
});

// main.ts's global keydown backs Esc out of the edit form first, and writes it here.
export function setMgrEdit(v: typeof mgrEdit) { mgrEdit = v; }

// ---------- the inputs prompt ----------
// Discovery leaves ${input:…} placeholders intact; only this side knows the answers.
let inputCtx: { r: Runnable; project: string; opts: TaskLaunchOpts } | null = null;

export function openInputPrompt(r: Runnable, project: string, opts: TaskLaunchOpts) {
  inputCtx = { r, project, opts };
  $("inSub").textContent = `${r.label} · ${r.inputs.length} input${r.inputs.length === 1 ? "" : "s"}`;
  $("inBody").innerHTML = r.inputs.map((i, n) => {
    // Last typed wins over the file's default; a password is never remembered.
    const remembered = i.password ? undefined : rememberedInput(project, r.id, i.id);
    // A pick the file no longer offers selects nothing, so the browser shows — and submits —
    // the first option instead: fall back to something the prompt actually displays.
    const want = remembered ?? i.default ?? "";
    const val = i.kind === "pickString" && !i.options.includes(want) ? i.options[0] ?? "" : want;
    const field = i.kind === "pickString"
      ? `<select class="in-ctl" data-n="${n}">${i.options.map((o) => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input class="in-ctl" data-n="${n}" type="${i.password ? "password" : "text"}" value="${esc(val)}" placeholder="${esc(i.default ?? (i.optional ? "optional" : ""))}" spellcheck="false" autocomplete="off" />`;
    return `<div class="in-field">
      <label class="in-lbl">${esc(i.description)}<span class="in-id">${esc(i.id)}</span></label>
      ${field}
    </div>`;
  }).join("");
  $("inDlg").classList.add("show");
  $("scrim").classList.add("show");
  setTimeout(() => ($("inBody").querySelector(".in-ctl") as HTMLElement | null)?.focus(), 30);
}
export function closeInputPrompt() {
  $("inDlg").classList.remove("show");
  if (!$("palette").classList.contains("show") && !$("runPop").classList.contains("show")) $("scrim").classList.remove("show");
  inputCtx = null;
}
function submitInputPrompt() {
  if (!inputCtx) return;
  const { r, project, opts } = inputCtx;
  const vals: Record<string, string> = {};
  $("inBody").querySelectorAll<HTMLInputElement | HTMLSelectElement>(".in-ctl").forEach((el) => {
    const input = r.inputs[+el.dataset.n!];
    vals[input.id] = el.value;
    if (!input.password) rememberInput(project, r.id, input.id, el.value);
  });
  closeInputPrompt();
  void launchWithDeps(applyInputs(r, vals), project, opts);
}

$("inCancel").addEventListener("click", closeInputPrompt);
$("inGo").addEventListener("click", submitInputPrompt);
$("inBody").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); submitInputPrompt(); }
  else if (e.key === "Escape") { e.preventDefault(); closeInputPrompt(); }
});

