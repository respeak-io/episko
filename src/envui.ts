// The env chip, its picker and the poll behind them. What a preset means — which one is
// active, what a rule calls it, where a saved one lands — is ./envs'; this half is DOM and
// IPC, untested. Four surfaces draw the chip and all of them open this one picker.

import { invoke } from "@tauri-apps/api/core";
import { playSound } from "./chime";
import { ask } from "./confirm";
import { $, toast } from "./dom";
import {
  activePreset, envChip, envSections, isDanger, needsBackup, presetDest,
  type EnvChip, type EnvGroup, type EnvScan, type EnvSection,
} from "./envs";
import { absoluteTouchPath, touchPath, touchTool } from "./files";
import { basename } from "./format";
import { envPopHtml } from "./footerview";
import { footShown } from "./footprefs";
import { envPrefs, footPrefs, sessions } from "./state";

export interface EnvView { dir: string; scan: EnvScan; chip: EnvChip | null }

const byDir = new Map<string, EnvView>();
const dueAt = new Map<string, number>();
// The autofetch tick's cadence, and for the same reason: a read nobody is looking at is not
// worth doing sooner, and the three prods below cover every change worth seeing now.
const ENV_EVERY = 20_000;

let stageDir: () => string | null = () => null;
export function setEnvStageDir(f: () => string | null) { stageDir = f; }
let repaint: () => void = () => {};
export function setEnvRepaint(f: () => void) { repaint = f; }
let closeOtherMenus: () => void = () => {};
export function setEnvCloseMenus(f: () => void) { closeOtherMenus = f; }
let openRules: (dir: string) => void = () => {};
export function setEnvOpenRules(f: (dir: string) => void) { openRules = f; }

export const envViewFor = (dir: string | null | undefined): EnvView | null =>
  (dir && envPrefs.enabled ? byDir.get(dir) ?? null : null);

/** Every flagged checkout, which is what the badge counts and the sidebar marks. */
export const envDanger = (): EnvView[] => [...byDir.values()].filter((v) => isDanger(v.chip));

// ---------- the scan ----------

// The stage's checkout plus every live pane's: the sidebar marks are what the rest are for,
// so the set is bounded by the panes that are open, never by the projects you have.
// The checkout the rules dialog is open on. Kept while it is up even with no pane in it, or
// the next prune would blank the preview under the person editing it.
let pinned = "";

/** Scan a checkout on demand and hold it, for a dialog opened on a project nothing is running in. */
export async function pinEnvDir(dir: string): Promise<void> {
  pinned = dir;
  dueAt.delete(dir);
  await pollEnvs(dir);
}
export function unpinEnvDir(): void { pinned = ""; }

function watched(): string[] {
  const out = new Set<string>();
  const stage = stageDir();
  if (stage) out.add(stage);
  if (pinned) out.add(pinned);
  for (const s of sessions.values()) {
    const dir = s.drift?.dir ?? s.workdir;
    if (dir) out.add(dir);
  }
  return [...out];
}

// Everything a surface draws, so a repaint is owed exactly when one of them moved.
const sig = (v: EnvView | undefined): string =>
  v ? JSON.stringify([v.chip, v.scan.groups.map((g) => [g.target, g.state, g.presets.map((p) => [p.path, p.active, p.vars])])]) : "";

async function scanOne(dir: string): Promise<boolean> {
  const p = envPrefs;
  let scan: EnvScan;
  try {
    scan = await invoke<EnvScan>("env_scan", { workdir: dir, targets: p.targets, presets: p.presets, ignore: p.ignore });
  } catch {
    return false; // the row survives a failed read; the next tick asks again
  }
  const before = byDir.get(dir);
  const next: EnvView = { dir, scan, chip: envChip(scan, p) };
  byDir.set(dir, next);
  // A sound on first sight would fire once per pane at startup and say nothing. What is worth
  // hearing is a checkout *becoming* dangerous, which is the case nobody watched happen.
  if (before && isDanger(next.chip) && !isDanger(before.chip)) playSound("envDanger");
  return sig(before) !== sig(next);
}

/** The tick. `force` is one checkout (an arrival, a write) or `true` for all of them, which
 *  is what a change to the patterns needs: they decide which files are found at all. */
export async function pollEnvs(force?: string | true): Promise<void> {
  if (!envPrefs.enabled) {
    if (byDir.size) { byDir.clear(); dueAt.clear(); repaint(); }
    return;
  }
  const at = Date.now();
  const dirs = watched();
  for (const dir of [...byDir.keys()]) {
    if (!dirs.includes(dir)) { byDir.delete(dir); dueAt.delete(dir); }
  }
  let changed = false;
  for (const dir of dirs) {
    if (force !== true && dir !== force && (dueAt.get(dir) ?? 0) > at) continue;
    dueAt.set(dir, at + ENV_EVERY);
    if (await scanOne(dir)) changed = true;
  }
  if (changed) repaint();
}

/** An agent wrote a target. `Sess.files` records every PostToolUse write, so the one change
 *  no tick would see for twenty seconds is free to notice. */
export function noteEnvWrite(dir: string): void {
  dueAt.delete(dir);
  void pollEnvs(dir);
}

// Separators normalised and case folded. A false match on a case-sensitive filesystem costs
// one extra scan, where a miss costs twenty seconds of a wrong chip.
const samePath = (a: string, b: string) =>
  a.replace(/[/\\]+/g, "/").toLowerCase() === b.replace(/[/\\]+/g, "/").toLowerCase();

/** A tool call that wrote a target or a preset. `touchPath`/`touchTool` are the Context card's
 *  own readers, so there is no second parser of a tool payload here. */
export function noteEnvTouch(dir: string, tool: string, input: unknown): void {
  const v = byDir.get(dir);
  const act = touchTool(tool);
  const path = touchPath(input);
  if (!v || !path || !act || act === "read") return;
  const abs = absoluteTouchPath(path, dir);
  const watching = v.scan.groups.flatMap((g) => [g.target, ...g.presets.map((p) => p.path)]);
  if (watching.some((f) => samePath(abs, absoluteTouchPath(f, dir)))) noteEnvWrite(dir);
}

// ---------- the chips ----------

const TONES = ["none", "safe", "warn", "danger"] as const;

function paintChip(el: HTMLElement, txt: HTMLElement, c: EnvChip | null, dir: string, show: boolean): void {
  el.hidden = !show || !c;
  if (!c || !show) return;
  for (const t of TONES) el.classList.toggle(`ev-${t}`, c.tone === t);
  el.title = `${c.title}\nClick to switch`;
  el.dataset.envdir = dir;
  txt.textContent = c.text; // textContent, so this needs no innerHTML guard
}

/** The header chip, the status-bar segment and the badge, from the one map. */
export function renderEnvs(): void {
  const dir = stageDir() ?? "";
  // Arriving at a checkout nothing has read yet. The tick would take twenty seconds to notice,
  // and being right when you look at it is the chip's whole job. The due map doubles as the
  // "asked" mark, so a scan that fails is not re-kicked by every paint until it succeeds.
  if (dir && envPrefs.enabled && !dueAt.has(dir)) { dueAt.set(dir, 0); void pollEnvs(dir); }
  const c = envViewFor(dir)?.chip ?? null;
  paintChip($("hEnv"), $("hEnvTxt"), c, dir, envPrefs.header);
  // Its own switch, and this pass runs after the footer's: without it, painting the segment
  // would un-hide what Settings › Status bar had just hidden.
  paintChip($("fEnvSeg"), $("fEnvTxt"), c, dir, footShown(footPrefs, "env"));
  const hot = envDanger();
  const badge = $("envBadge");
  badge.className = hot.length ? "env-badge show" : "env-badge";
  if (hot.length) {
    $("envBadgeTxt").textContent = hot.length === 1 ? hot[0].chip!.text : `${hot.length} checkouts`;
    badge.title = hot.map((v) => `${basename(v.dir)} · ${v.chip!.text}`).join("\n");
  }
  if (envPopOpen()) renderEnvPop();
}

/** What the footer's own layout needs: the segment is hidden when this checkout has no
 *  environments at all, and its divider has to go with it (footer.ts's `applyFootPrefs`). */
export const envFooterShown = (): boolean => !!envViewFor(stageDir())?.chip;

// ---------- the picker ----------

let popDir = "";
let popAnchor: HTMLElement | null = null;

export const envPopOpen = (): boolean => $("envPop").classList.contains("show");

export function closeEnvPop(): void {
  if (!envPopOpen()) return;
  $("envPop").classList.remove("show");
  popAnchor?.classList.remove("open");
  popAnchor = null;
  popDir = "";
}

export function openEnvPop(anchor: HTMLElement, dir: string): void {
  if (!envViewFor(dir)) { toast("No environments found in this checkout"); return; }
  closeOtherMenus();
  popDir = dir;
  popAnchor = anchor;
  renderEnvPop();
  const pop = $("envPop");
  pop.classList.add("show");
  anchor.classList.add("open");
  // Anchored under the trigger, flipping above when that would run off the bottom (./bpop's rule).
  const r = anchor.getBoundingClientRect(), h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
  pop.style.top = (r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + "px";
}

let lastPop = "";

/** The view the picker draws. Also what Settings previews, so the two cannot drift. */
export function envPopView(v: EnvView) {
  return {
    where: basename(v.dir),
    sections: envSections(v.scan, envPrefs),
    broken: !v.scan.policyReadable,
    targets: v.scan.policy.targets ?? envPrefs.targets,
  };
}

function renderEnvPop(): void {
  const v = envViewFor(popDir);
  if (!v) { closeEnvPop(); return; }
  const html = envPopHtml(envPopView(v));
  if (html === lastPop) return; // an assignment between mousedown and mouseup drops the click
  lastPop = html;
  $("envPop").innerHTML = html;
}

// ---------- switching ----------

const groupFor = (dir: string, target: string): EnvGroup | null =>
  byDir.get(dir)?.scan.groups.find((g) => g.target === target) ?? null;

/** The one verb. A recognised target is swapped in silence — that is the whole point of the
 *  feature — and only content no preset holds is worth stopping for. */
export async function switchEnv(dir: string, target: string, preset: string): Promise<void> {
  const g = groupFor(dir, target);
  if (!g) return;
  if (activePreset(g)?.path === preset) { closeEnvPop(); return; }
  let backup = false;
  if (needsBackup(g)) {
    const ok = await ask(
      `${target} does not match any preset, so it holds changes nothing else has a copy of.\n\n`
      + `Switching to ${basename(preset)} overwrites it. Episko can keep the current one as ${target}.bak first.`,
      { title: "Overwrite this .env?", kind: "warning", okLabel: "Back up and switch", cancelLabel: "Keep it" },
    );
    if (!ok) return;
    backup = true;
  }
  closeEnvPop();
  try {
    const kept = await invoke<string>("env_switch", { workdir: dir, target, preset, backup });
    await pollEnvs(dir);
    repaint();
    toast(kept ? `${target} → ${basename(preset)} · kept ${kept}` : `${target} → ${basename(preset)}`);
  } catch (e) {
    toast("switch failed: " + String(e));
  }
}

async function savePreset(dir: string, target: string, name: string): Promise<void> {
  const g = groupFor(dir, target);
  if (!g) return;
  const dest = presetDest(g, name);
  if (!dest) { toast("Give it a name first"); return; }
  try {
    await invoke("env_save_preset", { workdir: dir, target, dest });
    lastPop = "";
    await pollEnvs(dir);
    repaint();
    toast(`Saved ${dest}`);
  } catch (e) {
    toast(String(e));
  }
}

// ---------- wiring ----------
// Each host owns its own opener, the way the footer's other segments do; only the dashboard
// card's rows are dispatched elsewhere, since ./dashboard owns that element.

const openFrom = (el: HTMLElement) => { if (el.dataset.envdir != null) openEnvPop(el, el.dataset.envdir); };

for (const id of ["hEnv", "fEnvSeg"]) {
  $(id).addEventListener("click", (e) => {
    e.stopPropagation();
    envPopOpen() ? closeEnvPop() : openFrom($(id));
  });
}

$("envBadge").addEventListener("click", (e) => {
  e.stopPropagation();
  if (envPopOpen()) { closeEnvPop(); return; }
  // The stage's checkout when that is the flagged one, else the first that is: the badge is
  // about production being live somewhere, and the picker has to be about exactly one place.
  const hot = envDanger();
  const here = hot.find((v) => v.dir === stageDir()) ?? hot[0];
  if (here) openEnvPop($("envBadge"), here.dir);
});

$("envPop").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>("[data-envpick]");
  if (pick) {
    e.stopPropagation();
    void switchEnv(popDir, pick.dataset.envtarget!, pick.dataset.envpick!);
    return;
  }
  const save = t.closest<HTMLElement>("[data-envsave]");
  if (save) {
    e.stopPropagation();
    const field = save.closest(".ev-mod")?.querySelector<HTMLInputElement>("[data-envname]");
    void savePreset(popDir, save.dataset.envsave!, field?.value ?? "");
    return;
  }
  // The rules live with the project, so the picker's quick open is the dialog that writes
  // them there — never a Settings section, which is this machine's answer (docs/environments.md).
  if (t.closest("[data-envrules]")) {
    e.stopPropagation();
    const dir = popDir;
    closeEnvPop();
    openRules(dir);
  }
});

$("envPop").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  closeEnvPop();
});

/** A checkout's own `[env]` table, for the dialog that edits it. */
export const envPolicyFor = (dir: string) => byDir.get(dir)?.scan.policy ?? null;

/** The checkout the rules dialog opens on when nothing named one. */
export const envPreview = (): EnvView | null => envViewFor(stageDir()) ?? [...byDir.values()][0] ?? null;


/** Everything the dashboard card and the rules dialog need for a checkout. */
export function envSectionsFor(dir: string): EnvSection[] {
  const v = byDir.get(dir);
  return v ? envSections(v.scan, envPrefs) : [];
}
