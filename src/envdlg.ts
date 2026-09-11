// The Environments dialog: where the rules are written. Opened from the picker's ↗ for a
// project (and saved into its `.episko/episko.toml`, so the whole team gets them), or from
// Settings for Episko's own fallback. One editor, two places to put the answer.

// A draft, not a live commit: the project half writes a committed file, and that is a
// deliberate act rather than something a keystroke does (docs/environments.md).

import { invoke } from "@tauri-apps/api/core";
import { ask } from "./confirm";
import { $, dropScrim, toast } from "./dom";
import {
  clampEnvPrefs, ENV_DEFAULTS, ENV_RX_MAX, envMark, envRegex, hasProjectRules,
  isDefaultEnvRules, rulesFrom, type EnvPolicy, type EnvRules, type EnvTag, type EnvTone,
} from "./envs";
import { basename, esc, escAttr } from "./format";
import { envPolicyFor, envPreview, envSectionsFor, pinEnvDir, pollEnvs, unpinEnvDir } from "./envui";
import { envPrefs } from "./state";

let save: (r: EnvRules) => void = () => {};
export function setEnvDlgSave(f: (r: EnvRules) => void) { save = f; }
let turnOn: () => void = () => {};
export function setEnvDlgEnable(f: () => void) { turnOn = f; }

// Turning it on from here re-reads this checkout, so the preview fills in rather than
// staying empty behind a switch that now says yes.
function enable(): void {
  turnOn();
  if (scope.kind === "project") void pinEnvDir(scope.dir).then(() => { if (envDlgOpen()) render(); });
  else render();
}
let repaint: () => void = () => {};
export function setEnvDlgRepaint(f: () => void) { repaint = f; }

/** `app` edits Episko's fallback; `project` edits one checkout's committed table. */
type Scope = { kind: "app" } | { kind: "project"; dir: string; policy: EnvPolicy | null };

let scope: Scope = { kind: "app" };
let draft: EnvRules = ENV_DEFAULTS;

export const envDlgOpen = (): boolean => $("envDlg").classList.contains("show");

export function closeEnvDlg(): void {
  $("envDlg").classList.remove("show");
  unpinEnvDir();
  dropScrim();
}

/** A checkout's own rules, seeded from whatever is in force there now. */
export function openEnvRules(dir?: string): void {
  const at = dir ?? envPreview()?.dir ?? "";
  if (!at) { openEnvDefaults(); return; }
  scope = { kind: "project", dir: at, policy: envPolicyFor(at) };
  draft = rulesFrom(scope.policy, envPrefs);
  show();
  // The project menu can open this on a checkout nothing is running in, and then there is
  // nothing cached to preview. Scan it now and repaint when it lands.
  void pinEnvDir(at).then(() => {
    if (scope.kind === "project" && scope.dir === at && envDlgOpen()) {
      scope = { kind: "project", dir: at, policy: envPolicyFor(at) };
      render();
    }
  });
}

/** Episko's fallback, for projects that never write a table of their own. */
export function openEnvDefaults(): void {
  scope = { kind: "app" };
  draft = clampEnvPrefs(envPrefs);
  show();
}

function show(): void {
  $("scrim").classList.add("show");
  $("envDlg").classList.add("show");
  render();
  setTimeout(() => $("envDlg").querySelector<HTMLInputElement>("input")?.focus(), 20);
}

// ---------- markup ----------

const TONE_OPTS: { value: EnvTone; label: string; glyph: string }[] = [
  { value: "danger", label: "Danger", glyph: "⬤" },
  { value: "warn", label: "Care", glyph: "◐" },
  { value: "safe", label: "Safe", glyph: "○" },
  { value: "none", label: "Plain", glyph: "·" },
];

// What the app's fallback is previewed against: names, not files. Rules shown against a
// project you are not editing was the muddle this dialog exists to end.
const SAMPLE = ["production", "preprod", "staging", "dev", "local", "sandbox-2"];

const join = (v: string[]) => v.join(", ");
const split = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

function field(id: keyof EnvRules, label: string, value: string, hint: string, ph: string): string {
  return `<label class="evf"><span class="evf-l">${esc(label)}</span>
    <input class="tfield mono" data-edfield="${id}" type="text" spellcheck="false" autocomplete="off"
      value="${escAttr(value)}" placeholder="${escAttr(ph)}" aria-label="${escAttr(label)}" />
    <span class="evf-h">${esc(hint)}</span></label>`;
}

function ruleHtml(t: EnvTag, i: number): string {
  return `<div class="evr${envRegex(t.match) ? "" : " evr-bad"}">
    <input class="tfield mono evr-p" data-edrule="match" data-edi="${i}" value="${escAttr(t.match)}"
      spellcheck="false" autocomplete="off" maxlength="${ENV_RX_MAX}" placeholder="prod|live" aria-label="Pattern" />
    <div class="evr-tones">${TONE_OPTS.map((o) =>
      `<button class="chip-opt ev-${o.value}${t.tone === o.value ? " on" : ""}" type="button" data-edtone="${o.value}"
        data-edi="${i}" title="${escAttr(o.label)}" aria-label="${escAttr(o.label)}">${o.glyph}</button>`).join("")}</div>
    <input class="tfield evr-lb" data-edrule="label" data-edi="${i}" value="${escAttr(t.label ?? "")}"
      spellcheck="false" autocomplete="off" placeholder="name it" aria-label="Label" />
    <button class="set-freset evr-x" type="button" data-eddel="${i}" aria-label="Remove this rule">✕</button>
    <div class="evr-err">Not a valid pattern, so this rule matches nothing.</div>
  </div>`;
}

function previewRow(name: string, path: string): string {
  const m = envMark(name, draft.tags);
  return `<div class="evp-r ev-${m.tone}"><span class="ev-d"></span>
    <span class="evp-n">${esc(m.label)}</span><span class="evp-p mono">${esc(path)}</span>
    <span class="evp-w">${m.rule ? esc(`/${m.rule}/i`) : "no rule"}</span></div>`;
}

// Split out because a keystroke repaints only this block: rebuilding the dialog would take
// the <input> being typed into with it (the title field's rule, one dialog over).
function previewHtml(): string {
  if (scope.kind === "app") {
    return `<div class="evprev" id="edPrev"><div class="evp-h">What these rules call a name</div>
      ${SAMPLE.map((n) => previewRow(n, "an environment called this")).join("")}
      <div class="evp-src">Names, not files: these are Episko's fallback, so they are not about any
        one project. Open the switcher in a project and click ↗ to write rules that are.</div></div>`;
  }
  const dir = scope.dir;
  if (!envPrefs.enabled) {
    return `<div class="evprev" id="edPrev"><div class="evp-h">In ${esc(basename(dir))}</div>
      <div class="set-empty">The switcher is off, so nothing has been read. These rules are saved
      either way — <button class="ev-link" type="button" data-edon="1">turn it on</button>.</div></div>`;
  }
  const secs = envSectionsFor(dir);
  const body = secs.length
    ? secs.map((s) => `<div class="evp-g mono">${esc(s.group.target)}</div>`
        + (s.rows.length
          ? s.rows.map((r) => previewRow(r.preset.name, r.preset.path)).join("")
          : `<div class="set-empty">No presets beside it yet.</div>`)).join("")
    : `<div class="set-empty">No environments found.</div>`;
  // Named in full, because the commonest confusion is not knowing it only looked at the root:
  // these are the patterns the CURRENT scan used, never the draft above, which has not run yet.
  const live = rulesFrom(scope.policy, envPrefs).targets;
  const stale = JSON.stringify(live) !== JSON.stringify(draft.targets)
    ? ` The list above has not been searched yet — Save to use it.` : "";
  return `<div class="evprev" id="edPrev"><div class="evp-h">In ${esc(basename(dir))}, right now</div>${body}
    <div class="evp-src">Looked for <code>${esc(live.join("</code>, <code>"))}</code> — found
      ${secs.length}.${stale} Tones update as you type; the file list is re-read on Save, since
      finding them is a disk read.</div></div>`;
}

function render(): void {
  const project = scope.kind === "project" ? scope : null;
  const had = !!project && hasProjectRules(project.policy);
  const where = project
    ? `<code>${esc(basename(project.dir))}/.episko/episko.toml</code> — committed, so everyone who pulls the repo gets these`
    : `Episko's fallback, on this machine. A project with its own <code>[env]</code> table overrides it.`;
  const from = project && !had
    ? `<div class="ed-seed">Seeded from your defaults; this project has no <code>[env]</code> table yet.</div>`
    : "";
  const dirty = project || JSON.stringify(clampEnvPrefs({ ...envPrefs, ...draft })) !== JSON.stringify(clampEnvPrefs(envPrefs));
  $("envDlgBody").innerHTML = `
    <div class="ed-h"><b>${project ? "This project's environments" : "Default environment rules"}</b>
      <span class="ed-where">${where}</span>${from}</div>
    ${field("targets", "The files that get switched", join(draft.targets),
      "One per environment. A directory segment may hold a * — apps/*/.env finds one per package.", ".env, apps/*/.env")}
    ${field("presets", "Where its presets are", join(draft.presets),
      "Looked for beside each target, so these are relative to it. * matches within a filename.", ".env.*, envs/*")}
    ${field("ignore", "Never a preset", join(draft.ignore),
      "Samples, templates and the local overlay, matched against the name or the whole path.", "*.example")}
    <div class="evrules">${draft.tags.map(ruleHtml).join("")
      || `<div class="set-empty">No rules, so nothing is ever marked. That is how the colours are turned off.</div>`}</div>
    <div class="ed-add"><button class="set-freset" type="button" data-edadd="1">+ Add a rule</button>
      <button class="set-freset" type="button" data-edreset="1"${isDefaultEnvRules(draft) ? " disabled" : ""}>Reset to Episko's defaults</button></div>
    ${previewHtml()}
    <div class="ed-foot">
      ${project && had ? `<button class="set-abtn danger" type="button" data-eddrop="1">Remove from the project</button>` : ""}
      <span class="ed-sp"></span>
      <button class="set-freset" type="button" data-edcancel="1">Cancel</button>
      <button class="set-abtn" type="button" data-edsave="1"${dirty ? "" : " disabled"}>${
        project ? (had ? "Save to the project" : "Write to the project") : "Save"}</button>
    </div>`;
}

// ---------- editing ----------

function patchPreview(): void {
  const el = $("envDlg").querySelector("#edPrev");
  if (el) el.outerHTML = previewHtml();
}

function setDraft(next: Partial<EnvRules>, full = true): void {
  draft = clampEnvPrefs({ ...ENV_DEFAULTS, ...draft, ...next });
  if (full) render(); else patchPreview();
}

function editRule(el: HTMLInputElement): void {
  const i = Number(el.dataset.edi);
  const which = el.dataset.edrule;
  // An empty pattern is held back rather than committed: `clampEnvPrefs` drops a rule with no
  // pattern, which would take the row out from under the caret.
  if (!(which === "match" && !el.value.trim())) {
    setDraft({
      tags: draft.tags.map((t, n): EnvTag =>
        n !== i ? t : which === "label" ? { ...t, label: el.value } : { ...t, match: el.value }),
    }, false);
  }
  // Only the pattern decides the mark: a keystroke in the label beside it must not clear the
  // row's "this matches nothing", which is the one thing it has to keep saying.
  if (which === "match") el.closest(".evr")?.classList.toggle("evr-bad", !envRegex(el.value));
}

async function commit(): Promise<void> {
  if (scope.kind === "app") {
    save(draft);
    closeEnvDlg();
    toast("Default rules saved");
    return;
  }
  const { dir, policy } = scope;
  const had = hasProjectRules(policy);
  const ok = await ask(
    `Write these rules into .episko/episko.toml in ${basename(dir)}?\n\n`
    + (had
      ? `The [env] table already in it is replaced.`
      : `That file is committed, so everyone who pulls the repo gets them.`),
    { title: had ? "Replace this project's rules?" : "Share these rules?", kind: had ? "warning" : "info",
      okLabel: had ? "Replace it" : "Write it", cancelLabel: "Cancel" },
  );
  if (!ok) return;
  try {
    await invoke("env_write_policy", {
      workdir: dir, targets: draft.targets, presets: draft.presets, ignore: draft.ignore,
      tags: draft.tags.map((t) => ({ match: t.match, tone: t.tone ?? null, label: t.label ?? null })),
      create: true,
    });
    closeEnvDlg();
    await pollEnvs(dir);
    repaint();
    toast("Written to .episko/episko.toml");
  } catch (e) {
    toast(String(e));
  }
}

async function drop(): Promise<void> {
  if (scope.kind !== "project") return;
  const { dir } = scope;
  const ok = await ask(
    `Remove the [env] table from .episko/episko.toml in ${basename(dir)}?\n\n`
    + `This project falls back to Episko's defaults, and everyone who pulls the repo loses these rules.`,
    { title: "Remove this project's rules?", kind: "warning", okLabel: "Remove it", cancelLabel: "Keep them" },
  );
  if (!ok) return;
  try {
    await invoke("env_drop_policy", { workdir: dir });
    closeEnvDlg();
    await pollEnvs(dir);
    repaint();
    toast("Removed from .episko/episko.toml");
  } catch (e) {
    toast(String(e));
  }
}

// ---------- wiring ----------

$("envDlg").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const tone = t.closest<HTMLElement>("[data-edtone]");
  if (tone) {
    const i = Number(tone.dataset.edi);
    setDraft({ tags: draft.tags.map((x, n) => n === i ? { ...x, tone: tone.dataset.edtone } : x) });
    return;
  }
  const del = t.closest<HTMLElement>("[data-eddel]");
  if (del) { const i = Number(del.dataset.eddel); setDraft({ tags: draft.tags.filter((_, n) => n !== i) }); return; }
  if (t.closest("[data-edadd]")) { setDraft({ tags: [...draft.tags, { match: "", tone: "warn", label: null }] }); return; }
  if (t.closest("[data-edreset]")) { draft = clampEnvPrefs(ENV_DEFAULTS); render(); return; }
  if (t.closest("[data-edon]")) { enable(); return; }
  if (t.closest("[data-edcancel]")) { closeEnvDlg(); return; }
  if (t.closest("[data-edsave]")) { void commit(); return; }
  if (t.closest("[data-eddrop]")) void drop();
});

$("envDlg").addEventListener("input", (e) => {
  const t = e.target as HTMLElement;
  const r = t.closest<HTMLInputElement>("[data-edrule]");
  if (r) { editRule(r); return; }
  const f = t.closest<HTMLInputElement>("[data-edfield]");
  if (!f) return;
  const id = f.dataset.edfield as keyof EnvRules;
  // The path fields change which files are found, which is a disk read: committed to the
  // draft live, re-scanned on Save, so a preview never costs a read per letter.
  setDraft({ [id]: split(f.value) } as Partial<EnvRules>, false);
});

$("envDlgClose").addEventListener("click", () => closeEnvDlg());
