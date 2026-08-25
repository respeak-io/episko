// The History dialog. ./history owns the rules; this owns the markup, the state that
// only a dialog has (selection, filter text, the cached scan) and the events — the
// same split as ./palette and ./palui.
//
// It is its own module rather than more of ./mirror because it shares nothing with
// it: no `mirror` stage pointer, no roster, no polling. The one thing it borrows is
// provider history readers and the `.tvmsg` markup that renders their prose.
//
// Resuming from here is the same operation a dormant row performs, under the same two
// constraints: resume must run in the session's ORIGINAL cwd (hence `entry.cwd` and
// the `exists` guard), and a live session must not be resumed twice (`histBusy`).

import { $, dropScrim, toast } from "./dom";
import { dlog } from "./debug";
import { basename, esc, relTime, tilde } from "./format";
import { abbr } from "./phase";
import { activeProjectCtx, launch } from "./panes";
import { accentFor, availAgents } from "./state";
import { historyProviders, readProviderHistory } from "./providers";
import { providerSessionKey } from "./types";
import {
  histBucket, histBusy, histInProject, histLabel, histMatches, histProject,
  type HistEntry,
} from "./history";

let histAll: HistEntry[] = [];
let histRows: HistEntry[] = [];   // what's on screen, after scope + search
let histSel = 0;
let histLoadedAt = 0;
let histScoped = false;           // ◧ narrow to the project on stage
let histLoading = false;
// The preview is keyed by session id and re-checked on arrival: arrow keys move the
// selection faster than a transcript read returns, and a late reply must not paint
// over the row the user has already moved to.
let histPreview: { key: string; msgs: { role: string; text: string }[] } | null = null;
const HIST_LIMIT = 300;
const HIST_TTL = 60000;           // re-scan on reopen if the last one is older

export const histOpen = () => $("histDlg").classList.contains("show");
const histSelected = (): HistEntry | undefined => histRows[histSel];

// Two doors into one dialog, and the difference is only which scope it opens in.
// `◷ History` in the stage header is scoped, because everything beside it
// (❯ Terminal, ▶ Run, ＋ Session) acts on the project on screen and a global
// button among them would read as one more of those. The whole-machine view lives in
// the top bar with the other app-wide controls. Either way the ◧ chip switches
// between them, and a scoped open with nothing on stage falls back to all projects.
export async function openHistory(scoped: boolean) {
  histScoped = scoped && !!activeProjectCtx();
  $("scrim").classList.add("show");
  $("histDlg").classList.add("show");
  const q = $("histQ") as HTMLInputElement;
  q.value = ""; histSel = 0; histPreview = null;
  histRender();
  setTimeout(() => q.focus(), 30);
  await loadHistory(Date.now() - histLoadedAt > HIST_TTL);
}
export function closeHistory() {
  $("histDlg").classList.remove("show");
  dropScrim();
}
// The scan reads real files, so it's cached between openings and refreshed on a TTL
// (or the ⟳ chip). `force` bypasses the cache; an empty cache always loads.
export async function loadHistory(force: boolean) {
  if (histLoading || (!force && histAll.length)) return;
  histLoading = true;
  histRender();
  try {
    const batches = await Promise.all(historyProviders(availAgents).map(async (provider) => {
      try { return await provider.history!.list(HIST_LIMIT); }
      catch (e) { dlog("warn", `${provider.id} history scan failed: ${e}`); return []; }
    }));
    histAll = batches.flat().sort((a, b) => b.last_active - a.last_active).slice(0, HIST_LIMIT);
    histLoadedAt = Date.now();
  } catch (e) {
    dlog("warn", `history scan failed: ${e}`);
  } finally {
    histLoading = false;
  }
  if (histOpen()) { histSel = 0; histPreview = null; histRender(); }
}
// The project the ◧ chip narrows to — null when nothing owns the stage, in which
// case the chip is a no-op rather than a filter that silently empties the list.
const histScopeCtx = () => (histScoped ? activeProjectCtx() : null);
function histFiltered(): HistEntry[] {
  const term = ($("histQ") as HTMLInputElement).value.trim();
  const ctx = histScopeCtx();
  let list = histAll;
  if (ctx) list = list.filter((h) => histInProject(h, ctx.path));
  if (term) list = list.filter((h) => histMatches(h, term));
  return list;
}

export function histRender() {
  histRows = histFiltered();
  if (histSel >= histRows.length) histSel = Math.max(0, histRows.length - 1);
  const ctx = activeProjectCtx();
  const scope = histScopeCtx();
  // Nothing on stage → nothing to narrow to, so the chip goes dead rather than
  // toggling a state with no visible effect.
  ($("histScope") as HTMLButtonElement).disabled = !ctx;
  $("histScope").title = !ctx ? "Nothing on stage to scope to" : scope ? "Show every project" : `Show only ${ctx.project}`;
  $("histScopeTxt").textContent = scope ? scope.project : "all projects";
  $("histScope").classList.toggle("on", !!scope);
  $("histCount").textContent = histAll.length ? `${histAll.length} session${histAll.length === 1 ? "" : "s"}` : "";
  $("histN").textContent = histRows.length === histAll.length ? "" : `${histRows.length}`;
  $("histAge").textContent = histLoadedAt ? relTime(histLoadedAt).replace(" ago", "") : "…";

  if (histLoading && !histAll.length) {
    $("histList").innerHTML = Array.from({ length: 7 }, (_, i) =>
      `<div class="wt-sk"><i class="a"></i><i style="width:${45 + ((i * 37) % 45)}%"></i></div>`).join("");
  } else if (!histRows.length) {
    // An empty scoped list is a different answer from an empty search, and saying so
    // is what stops "this project has none" reading as "History is broken".
    const [head, body] = !histAll.length
      ? ["No past sessions", "No supported coding agent has saved a conversation on this machine yet."]
      : ($("histQ") as HTMLInputElement).value.trim()
      ? ["No match", "Nothing here matches that filter."]
      : scope
      ? [`Nothing yet in ${scope.project}`, "Switch the ◧ chip to all projects to see the rest."]
      : ["No match", "Nothing here matches that filter."];
    $("histList").innerHTML = `<div class="wt-empty"><b>${esc(head)}</b>${esc(body)}</div>`;
  } else {
    let html = "", bucket = "";
    histRows.forEach((h, i) => {
      const b = histBucket(h.last_active * 1000);
      if (b !== bucket) { bucket = b; html += `<div class="wt-gh">${esc(b)}<span class="rule"></span></div>`; }
      const busy = histBusy(h);
      const tag = busy ? `<span class="wt-tag ext">live</span>` : !h.exists ? `<span class="wt-tag gone">no folder</span>` : "";
      html += `<button class="wt-item${i === histSel ? " on" : ""}${!h.exists && !busy ? " stale" : ""}" data-hi="${i}" role="option" aria-selected="${i === histSel}">
        <span class="wt-ic" style="color:${accentFor(histProject(h).colorKey)}">◷</span>
        <span class="wt-main">
          <span class="wt-br"><span class="hd">${esc(histLabel(h))}</span></span>
          <span class="wt-sub2">${esc(h.project)}${h.branch ? ` · ${esc(h.branch)}` : ""}</span>
        </span>
        <span class="wt-meta">${tag}<span class="wt-when">${esc(relTime(h.last_active * 1000))}</span></span>
      </button>`;
    });
    $("histList").innerHTML = html;
    $("histList").querySelector(".wt-item.on")?.scrollIntoView({ block: "nearest" });
  }
  histPaintDetail();
  void histLoadPreview(histSelected());
}
function histPaintDetail() { $("histDetail").innerHTML = histDetailHtml(histSelected()); }
// The new-session dialog's `wtFacts` in the same shape. Copied rather than exported
// from ./worktree: it is four lines of markup, and the alternative is a module that
// owns one dialog exporting a fragment helper to a module that owns another.
function histFacts(pairs: [string, string][]) {
  return `<dl class="wt-facts">${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}
function histDetailHtml(h: HistEntry | undefined): string {
  if (!h) {
    return `<div class="wt-empty"><b>Nothing selected</b>Supported providers keep their own conversation history, so anything you closed can still appear here.</div>`;
  }
  const busy = histBusy(h);
  const p = histProject(h);
  const when = new Date(h.last_active * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  // Binary units, spelled binary — this divides by 1024, same as `fmtMb`/`fmtRate`.
  const size = h.bytes >= 1048576 ? `${(h.bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(h.bytes / 1024))} KiB`;
  const facts = histFacts([
    ["project", `<span class="em">${esc(p.project)}</span>`],
    ["path", `${esc(tilde(h.cwd))}${h.exists ? "" : ` <span class="warn">· gone</span>`}`],
    ...(h.branch ? [["branch", esc(h.branch)] as [string, string]] : []),
    ["last active", `${esc(when)} <span class="dim">· ${esc(relTime(h.last_active * 1000))}</span>`],
    ["session", `${esc(h.session_id.slice(0, 8))} <span class="dim">· ${esc(h.provider)}${h.bytes ? ` · ${esc(size)}` : ""}</span>`],
  ]);
  const action = busy
    ? `<div class="ext-note warn">This session is running right now. Resuming the same provider thread twice can corrupt or interleave its state, so Episko waits for the other process to exit.</div>`
    : !h.exists
    ? `<div class="ext-note warn">Its folder is gone (a deleted worktree, most likely). Provider sessions must resume in their original directory, so this one can only be read.</div>`
    : `<button class="ext-jump-btn" data-histact="resume">⟲ Resume this session</button>
       <div class="ext-note">Reopens the ${esc(h.provider)} conversation in a new pane, in <span class="mono">${esc(tilde(h.cwd))}</span>. A long conversation may compact its context first.</div>`;
  const preview = histPreview?.key === providerSessionKey(h.provider, h.session_id)
    ? (histPreview.msgs.length
        ? `<div class="hist-tv">${histPreview.msgs.map((m) => {
            const user = m.role === "user";
            return `<div class="tvmsg ${esc(m.role)}"><span class="tvgutter">${user ? "❯" : "⏺"}</span><div class="tvtext">${esc(abbr(m.text, 420))}</div></div>`;
          }).join("")}</div>`
        : `<div class="hist-tv tv-empty">No prose in this conversation; it's tool traffic only.</div>`)
    : `<div class="hist-tv tv-empty">Reading the conversation…</div>`;
  return `
    <div class="wt-dhead">
      <div class="wt-dkind">past ${esc(h.provider)} session</div>
      <div class="wt-dname">${esc(histLabel(h))}</div>
    </div>
    ${facts}
    ${action}
    <div class="wt-dkind">how it ended</div>
    ${preview}`;
}
// Lazily mirror the selected provider conversation, just a few messages inline in
// the detail column.
async function histLoadPreview(h: HistEntry | undefined) {
  if (!h) return;
  const id = h.session_id;
  const key = providerSessionKey(h.provider, id);
  if (histPreview?.key === key) return;
  try {
    const msgs = await readProviderHistory(h.provider, id, h.cwd, 8);
    const selected = histSelected();
    if (!histOpen() || !selected || providerSessionKey(selected.provider, selected.session_id) !== key) return;
    histPreview = { key, msgs };
  } catch {
    const selected = histSelected();
    if (!histOpen() || !selected || providerSessionKey(selected.provider, selected.session_id) !== key) return;
    histPreview = { key, msgs: [] };
  }
  histPaintDetail();
}
export function histResume(h: HistEntry | undefined) {
  if (!h) return;
  if (histBusy(h)) { toast("That session is running right now"); return; }
  if (!h.exists) { toast(`${basename(h.cwd)} no longer exists`); return; }
  const p = histProject(h);
  closeHistory();
  void launch(p.project, h.cwd, { colorKey: p.colorKey, worktree: p.worktree, branch: h.branch, resume: h.session_id, resumeProvider: h.provider });
}

// ---------- the dialog's own events ----------
// Rows are addressed by index into histRows, so nothing leaks into the delegated
// document dispatcher in main.ts — in particular the resume button carries
// `data-histact`, not the `data-resume` that dispatcher already owns for the
// sidebar's dormant rows.
export function initHistoryEvents() {
  $("histRefresh").addEventListener("click", () => { void loadHistory(true); ($("histQ") as HTMLInputElement).focus(); });
  $("histScope").addEventListener("click", () => { histScoped = !histScoped; histSel = 0; histRender(); ($("histQ") as HTMLInputElement).focus(); });
  $("histQ").addEventListener("input", () => { histSel = 0; histRender(); });
  $("histQ").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); histSel = Math.min(histSel + 1, histRows.length - 1); histRender(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); histSel = Math.max(histSel - 1, 0); histRender(); }
    else if (e.key === "Enter") { e.preventDefault(); histResume(histSelected()); }
    else if (e.key === "Escape") {
      // stopPropagation matters: main.ts's global handler also closes History (so Esc
      // works when focus has left the box), and without this both would fire — peeling
      // the filter and closing the dialog on one keypress.
      e.preventDefault(); e.stopPropagation();
      // Esc peels the filter first, then the dialog — same as the new-session dialog.
      if (($("histQ") as HTMLInputElement).value) { ($("histQ") as HTMLInputElement).value = ""; histSel = 0; histRender(); }
      else closeHistory();
    }
  });
  $("histDlg").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-histact]")) { histResume(histSelected()); return; }
    const row = t.closest<HTMLElement>("[data-hi]");
    if (row) { histSel = +row.dataset.hi!; histRender(); ($("histQ") as HTMLInputElement).focus(); }
  });
  // Double-click a row to resume, so the mouse path doesn't require crossing to the
  // detail pane's button. The first click of the pair already selected it.
  $("histList").addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-hi]");
    if (row) { e.preventDefault(); histResume(histRows[+row.dataset.hi!]); }
  });
}
