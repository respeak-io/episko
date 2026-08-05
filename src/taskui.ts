// The two task surfaces: the project tasks panel (pin / hide / create / edit /
// delete / override, reached from ⌘K) and the ▶ Run picker (pinned first, then a
// frecency-ranked recent group, then grouped by source).
//
// They sit together because they are two views of one thing — the Runnables a
// project ships — and share the rule that matters: **what can't run says so**. A
// blocked row renders greyed rather than being dropped, because a missing row reads
// as "Episko didn't find my task" while a greyed one reads as "this needs
// something". The other rule is that .episko/tasks.toml is the only file Episko
// writes: editing a discovered VS Code task or justfile recipe writes an
// [override."<id>"] keyed by its discovered id, never a mutation of the other tool's
// file.
//
// Discovery, the preference state and the dependency chain all live in ./tasks;
// this is only the UI over them. What it cannot own — panes, the stage, the ⌘K
// palette — arrives as one host object, the same shape settings.ts uses and for the
// same reason: six separate setters would be noise.
//
// The ${input:…} prompt is at the bottom of this file rather than behind a hook: it
// is the last step of the same launch, and both surfaces here reach it — but only
// when something has to be asked. `runRunnable` is the single door every surface
// launches through: Run prefills and goes, ⋯ Run with parameters… always asks.

import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import { basename, elidePath, esc, tilde } from "./format";
import type { Runnable } from "./types";
import { activeId, dashMirror, externals, extMirrorId, sessions } from "./state";
import { bumpFrec, frecScore } from "./palette";
import {
  applyInputs, discoverTasks, execCmd, hiddenIds, launchWithDeps, pinnedIds,
  prefillInputs, PROVIDER_LABEL, rememberedInput, rememberInput, rescanTasks, RUNNERS,
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

// Manage what the picker shows. Two kinds of change live here and they persist to
// different places on purpose: hiding a task is *yours* (localStorage), while a
// task's command is the *project's* (.episko/tasks.toml, committable). Only

let mgrCtx: { project: string; colorKey: string; workdir: string } | null = null;
let mgrList: Runnable[] = [];
// The discovered ids the project overrides — a discovered task edited into a
// committable `[override.*]` rather than a mutation of the file it came from.
let mgrOverrides: string[] = [];
// `kind` decides where a save lands: "own" writes a `[[task]]`, "override" writes an
// `[override."<id>"]` keyed by the discovered task's id.
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
  // Show hidden tasks too — this is the panel where you un-hide them.
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
  // A committable command edit lands in .episko/tasks.toml either way: our own
  // task in place, a discovered one as an [override.*] that never touches its file.
  const rowsHtml = mgrList.map((r) => {
        const own = r.source === "episko";
        const overridden = mgrOverrides.includes(r.id);
        const dangling = r.id.startsWith("override:");   // an override whose target vanished
        const editable = !r.blocked;
        // At most one task per project runs after a turn, so the glyph is a radio
        // in disguise: clicking another moves the rule, clicking this one clears it.
        const onStop = rule?.id === r.id;
        const noStop = stopRuleBlocked(r);
        const tags = `${r.background ? " · bg" : ""}${overridden ? " · overridden" : ""}${r.blocked ? " · " + esc(r.blocked) : ""}${onStop ? " · runs after each turn" : ""}`;
        const editBtn = own
          ? `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit in .episko/tasks.toml">✎</button>
             <button class="mgr-b danger" data-del="${esc(r.id)}" title="Delete from .episko/tasks.toml">✕</button>`
          : `<button class="mgr-b" data-edit="${esc(r.id)}" title="Edit — writes an override into .episko/tasks.toml, never ${esc(r.sourceFile)}">✎</button>`;
        const revertBtn = (overridden || dangling)
          ? `<button class="mgr-b" data-revert="${esc(dangling ? r.id.slice("override:".length) : r.id)}" title="Revert to what ${esc(r.sourceFile)} declares">↺</button>`
          : "";
        return `<div class="mgr-row${hid.includes(r.id) ? " off" : ""}">
          <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.sourceFile)}${tags}</small></span>
          <span class="mgr-acts">
            <button class="mgr-b${pins.includes(r.id) ? " on" : ""}" data-pin="${esc(r.id)}" title="${pins.includes(r.id) ? "Unpin" : "Pin to the top of the picker"}">${pins.includes(r.id) ? "★" : "☆"}</button>
            <button class="mgr-b" data-hide="${esc(r.id)}" title="${hid.includes(r.id) ? "Show in the picker" : "Hide from the picker"}">${hid.includes(r.id) ? "◌" : "◎"}</button>
            <button class="mgr-b${onStop ? " on" : ""}${noStop ? " quiet" : ""}" ${noStop ? "disabled" : ""} data-onstop="${esc(r.id)}"
              title="${noStop ? esc(`Can't run after a turn — ${noStop}`) : onStop ? "Stop running this after a turn" : "Run this whenever a session in this project finishes a turn"}">⟲</button>
            ${revertBtn}${editable ? editBtn : ""}
          </span>
        </div>`;
      }).join("");
  // A per-project runner override — only meaningful when the project actually has
  // npm scripts. Absent everywhere else, so it doesn't imply a knob that does nothing.
  const runnerStrip = mgrList.some((r) => r.source === "npm")
    ? `<div class="mgr-row mgr-runner">
         <span class="txt"><b>Package runner</b><small>the lockfile picks this — override a repo that ships the wrong one</small></span>
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
  // Editing a discovered task doesn't rewrite its file — it captures the effective
  // command as an override. Our own tasks edit in place.
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
  // Editing a task another tool owns is an override, not a rewrite — say so, because
  // it's the surprising-but-deliberate half of "Episko never touches a file it didn't create".
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

  // Creating .episko/tasks.toml puts a new committable file in someone's repo —
  // that's a side effect worth asking about once, not something to do silently.
  const [path, exists] = await invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir });
  if (!exists) {
    const ok = await ask(
      `Episko will create ${tilde(path)}.\n\nIt's a normal file in your repo — commit it and your team gets these tasks too, in any editor.`,
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
// A popover over the stage, grouped by source so it's obvious where each task came
// from. Blocked runnables stay visible but greyed: hiding them reads as "Episko
// didn't find my task", which is the more expensive confusion.
let runCtx: { project: string; colorKey: string; worktree: string | null; branch: string; workdir: string } | null = null;
let runList: Runnable[] = [];
let runSel = 0;
let runSource: string | null = null;   // jump-bar filter; null = every source

export function runTargetCtx() {
  const wd = host.activeCwd();
  if (!wd) return null;
  const s = activeId ? sessions.get(activeId) : null;
  const e = extMirrorId() ? externals.find((x) => x.session_id === extMirrorId()) : undefined;
  // The dashboard names its own project; basename(root) would usually agree, but the
  // sidebar's label is the one the run's pane should carry.
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
  // The middle of the path is what goes, not the end: with worktrees the last
  // segment is the only thing that says which checkout this will run in. The full
  // string stays reachable as the tooltip.
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

// Pinned first (they're the ones you run fifty times a day), then by source.
// Short chip labels for the jump bar. Group headers use the Runnable's own
// sourceFile instead, which is authoritative — it's the file discovery actually
// found, so ".vscode/tasks.json" and ".vscode/launch.json" name themselves, and a
// repo with `Justfile` doesn't get told it has a `justfile`.
const sourceShort = (r: Runnable) => PROVIDER_LABEL[r.source as Provider] || r.source;

function runMatches(term: string): Runnable[] {
  const t = term.trim().toLowerCase();
  const match = (r: Runnable) => !t || r.label.toLowerCase().includes(t) || execCmd(r).toLowerCase().includes(t) || (r.group || "").includes(t);
  return runList.filter(match);
}

/// The jump bar: every source present under the current search, with its count.
/// Built from the search results rather than the whole list, so a chip never
/// promises rows the current term has filtered away.
function runSources(term: string): { src: string; short: string; count: number }[] {
  const out: { src: string; short: string; count: number }[] = [];
  for (const r of runMatches(term)) {
    const hit = out.find((o) => o.src === r.source);
    if (hit) hit.count++;
    else out.push({ src: r.source, short: sourceShort(r), count: 1 });
  }
  return out;
}

// How many tasks the "recent" group floats to the top. Small on purpose — it's a
// shortcut to the two or three you keep re-running, not a second copy of the list.
const RUN_RECENT_MAX = 5;

function runGroups(term: string): { name: string; sub?: string; items: Runnable[] }[] {
  const list = runMatches(term).filter((r) => !runSource || r.source === runSource);
  const pins = runCtx ? pinnedIds(runCtx.colorKey) : [];
  const groups: { name: string; sub?: string; items: Runnable[] }[] = [];
  // A row shown in a float-to-top group (pinned, recent) is pulled out of its source
  // group below, so nothing appears twice.
  const lifted = new Set<string>();
  // Pinned float to the top, but only in the unfiltered view — inside a single
  // source, splitting two of its own rows into a separate block just hides them.
  const pinned = runSource ? [] : list.filter((r) => pins.includes(r.id));
  if (pinned.length) { groups.push({ name: "pinned", items: pinned }); pinned.forEach((r) => lifted.add(r.id)); }
  // Recent: the tasks you actually reach for, ranked by the same frecency the palette
  // uses (every launch bumps `task:<id>`). Only in the unfiltered "all" view — typing
  // or picking a source is already a narrower intent, and a Recent block there would
  // just be another thing to scan. Pinned are already up top, so they don't repeat.
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

/// Tab / ⇧Tab step through the jump bar — the keyboard equivalent of clicking a
/// chip, so the whole picker stays reachable without the mouse.
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
      // A task with ${input:…} gets a second verb rather than a forced dialog: the
      // row runs it with what it already knows, ⋯ asks. The tooltip shows the
      // command *as prefilled*, so what the row will run is never a surprise.
      const asks = !!r.inputs.length && !r.blocked;
      const ready = asks && runCtx ? prefillInputs(r, runCtx.project) : null;
      return `<div class="run-row${on}${r.blocked ? " blocked" : ""}" data-i="${idx}" title="${esc(r.blocked || execCmd(ready ?? r))}">
        <span class="ic">${r.blocked ? "⃠" : "▸"}</span>
        <span class="txt"><b>${esc(r.label)}</b><small>${esc(r.detail || execCmd(r))}</small></span>
        <span class="end">${r.blocked ? esc(r.blocked) : r.background ? "bg" : pinned ? "★" : ""}</span>
        ${asks ? `<button class="run-params" type="button" data-p="${idx}" title="Run with parameters…">⋯</button>` : ""}
      </div>`;
    }).join("");
    return `<div class="run-grp">${esc(g.name)}${g.sub ? `<span class="n">${esc(g.sub)}</span>` : ""}</div>${rows}`;
  }).join("");
  body.querySelectorAll<HTMLElement>(".run-row").forEach((el) => {
    el.addEventListener("click", () => { runSel = +el.dataset.i!; pickRun("run"); });
  });
  body.querySelectorAll<HTMLElement>(".run-params").forEach((el) => {
    // The button sits inside the row, whose click runs immediately — so it has to
    // stop there, or asking for parameters would also start a run without them.
    el.addEventListener("click", (e) => { e.stopPropagation(); runSel = +el.dataset.p!; pickRun("params"); });
  });
  body.querySelector(".run-row.on")?.scrollIntoView({ block: "nearest" });
}

function pickRun(how: "run" | "pin" | "params") {
  const flat = runGroups(($("runInput") as HTMLInputElement).value).flatMap((g) => g.items);
  const r = flat[runSel];
  if (!r || !runCtx) return;
  if (how === "pin") { togglePin(runCtx.colorKey, r.id); renderRunPicker(($("runInput") as HTMLInputElement).value); return; }
  // The trust gate is the one blocked row you can act on: choosing it asks for
  // permission rather than shrugging.
  if (r.id === "just:__untrusted") { void askTrust(runCtx.colorKey, runCtx.project); return; }
  if (r.blocked) { toast(`${r.label}: ${r.blocked}`); return; }
  const ctx = runCtx;
  closeRunPicker();
  bumpFrec("task:" + r.id);
  runRunnable(r, ctx.project, { colorKey: ctx.colorKey, worktree: ctx.worktree, branch: ctx.branch, discoveredIn: ctx.workdir }, how === "params");
}

/// Start a runnable, asking only for what it cannot answer itself. `withParams` is
/// the explicit *Run with parameters…* verb and always asks — that is the whole
/// difference between the two buttons, and every surface that runs a task goes
/// through here so they cannot drift apart.
export function runRunnable(r: Runnable, project: string, opts: TaskLaunchOpts, withParams = false) {
  const ready = withParams && r.inputs.length ? null : prefillInputs(r, project);
  if (!ready) { openInputPrompt(r, project, opts); return; }
  void launchWithDeps(ready, project, opts);
}

/// VS Code's ⌘⇧B / ⌘⇧T — run the project's *default* build (or test) task.
///
/// This is the "start the whole stack with one chord" affordance, and it works because
/// the default build task is usually a **compound**: no command of its own, just a
/// `dependsOn` list of the servers to bring up. So the chord finds one task and
/// `launchWithDeps` fans out from there — no separate orchestration.
///
/// Resolution follows VS Code: the task marked `"group": {"kind":"build","isDefault":true}`
/// wins outright. Failing that, an unambiguous single member of the build group is
/// obviously what was meant. Anything else is genuinely ambiguous, so it opens the
/// picker rather than guessing — silently running the first build-ish task in the file
/// is how you end up deploying when you meant to compile.
export async function runDefaultTask(kind: "build" | "test") {
  const c = runTargetCtx();
  if (!c) { toast("No active project"); return; }
  const all = (await discoverTasks(c.workdir, c.colorKey)).filter((r) => !r.blocked);
  const marked = all.filter((r) => r.defaultFor === kind);
  const inGroup = all.filter((r) => r.group === kind);
  const pick = marked[0] ?? (inGroup.length === 1 ? inGroup[0] : null);
  if (!pick) {
    toast(inGroup.length
      ? `No default ${kind} task — ${inGroup.length} are in the ${kind} group`
      : `No ${kind} task in ${c.project}`);
    await openRunPicker();
    return;
  }
  dlog("info", `${kind} task · ${pick.id} · ${c.project}`);
  bumpFrec("task:" + pick.id);
  const o = { colorKey: c.colorKey, worktree: c.worktree, branch: c.branch, discoveredIn: c.workdir };
  // Even the one-chord path stops for an ${input:…}: the alternative is a dialog-less
  // hang or a command with a literal ${input:x} in it.
  if (pick.inputs.length) { openInputPrompt(pick, c.project, o); return; }
  toast(`▶ ${pick.label}`);
  void launchWithDeps(pick, c.project, o);
}

// Trusting a folder means Episko may execute code from it to enumerate tasks, so
// it is asked for plainly and once, never inferred from mere use.
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

// Hand a command over to a terminal at `workdir` instead of running it ourselves.
// The embedded engine can genuinely prefill: it opens a shell pane and types the
// command *without* a newline, so the user reads it and presses Enter. External
// terminal apps take a directory but no pending input, so there we open the

// ---------- the panels' own event wiring ----------
$("mgrClose").addEventListener("click", closeTaskManager);
$("mgrNew").addEventListener("click", () => startMgrEdit(null));
$("mgrSave").addEventListener("click", () => { void saveMgrTask(); });
$("mgrBack").addEventListener("click", () => { mgrEdit = null; renderMgr(); });
$("mgrOpen").addEventListener("click", () => {
  if (mgrCtx) void invoke<[string, boolean]>("episko_tasks_file", { workdir: mgrCtx.workdir })
    .then(([path]) => openUrl("file://" + path))
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
  // ⌘⇧R inside the picker is a *real* rescan: drop the cache, then re-discover.
  else if (meta && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); if (runCtx) void rescanTasks(runCtx.workdir).then(() => openRunPicker()); }
  else if (e.key === "Tab") { e.preventDefault(); cycleRunSource(e.shiftKey ? -1 : 1); }
  else if (e.key === "Escape") { e.preventDefault(); closeRunPicker(); }
});

// Esc in the task panel backs out of the edit form first; the global keydown that
// decides that lives in main.ts, so it reads the binding above and writes it here.
export function setMgrEdit(v: typeof mgrEdit) { mgrEdit = v; }

// ---------- the inputs prompt ----------
// A task declaring ${input:…} collects its values before anything runs. Discovery
// deliberately leaves the placeholders intact, because only this side knows the
// answers — so this is where they get filled in.
let inputCtx: { r: Runnable; project: string; opts: TaskLaunchOpts } | null = null;

export function openInputPrompt(r: Runnable, project: string, opts: TaskLaunchOpts) {
  inputCtx = { r, project, opts };
  $("inSub").textContent = `${r.label} · ${r.inputs.length} input${r.inputs.length === 1 ? "" : "s"}`;
  $("inBody").innerHTML = r.inputs.map((i, n) => {
    // What you typed last for this exact input wins over the file's default — but a
    // password is never remembered, so it always starts empty.
    const remembered = i.password ? undefined : rememberedInput(project, r.id, i.id);
    const val = remembered ?? i.default ?? "";
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
    // Remember for next time — but never a password.
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

