// The Threads board. ./thread owns the model and the ranking, this owns the markup
// and the events — the same split as ./trail + ./trailui and ./history + ./historyui.
//
// Why a ranked list and not a grid of cards: a grid asks you to *search* it, and the
// whole promise of this surface is that the top row is always the answer. The bands
// are the only structure, and they are the phases the app already ships.
//
// The two altitudes are one component. `mirror.project` is the entire difference:
// null shows every project and renders a project column, a colorKey filters the same
// list and drops that column. There is no second screen to keep in sync.

import { invoke } from "@tauri-apps/api/core";
import { $, toast } from "./dom";
import { dlog } from "./debug";
import { esc, relTime, uUsd2 } from "./format";
import { noteList, removeNote } from "./notes";
import { launch, setActive } from "./panes";
import {
  accentFor, dirtyByFolder, FAVORITES, sessions, setActiveId, setMirror,
  threadsOpen, threadsProject,
} from "./state";
import {
  BAND_META, bandsOf, buildThreads, dispatchable, inProject, threadStatusKey, type Thread,
} from "./thread";

const GLYPH: Record<string, string> = {
  attention: "◆", error: "✕", done: "✓", working: "◐", thinking: "◐",
  idle: "·", ended: "·", unclaimed: "·",
};
const GCLS: Record<string, string> = {
  attention: "g-attn", error: "g-err", done: "g-done", working: "g-work",
  thinking: "g-work", idle: "g-idle", ended: "g-idle", unclaimed: "g-idle",
};

/** colorKey → the name the sidebar shows. Falls back to the folder's own basename. */
function projectName(colorKey: string): string {
  const fav = FAVORITES.find((f) => f.path === colorKey);
  if (fav) return fav.name;
  for (const s of sessions.values()) if (s.colorKey === colorKey) return s.project;
  return colorKey.split(/[/\\]/).pop() || colorKey;
}

function current(): Thread[] {
  const all = buildThreads({
    sessions: sessions.values(),
    notes: noteList(),
    dirty: dirtyByFolder,
    projectName,
  });
  return all.filter((t) => inProject(t, threadsProject()));
}

// ---------- markup ----------
function altHtml(): string {
  const active = threadsProject();
  // Only projects that actually have a thread — an altitude with nothing in it is a
  // dead segment, and the picker should describe the fleet, not the favourites list.
  const keys = new Set<string>();
  for (const t of buildThreads({ sessions: sessions.values(), notes: noteList(), dirty: dirtyByFolder, projectName })) {
    if (t.colorKey) keys.add(t.colorKey);
  }
  const segs = [
    `<button class="th-seg${active === null ? " on" : ""}" data-alt="">⌂ All projects</button>`,
    ...[...keys].sort().map((k) =>
      `<button class="th-seg${active === k ? " on" : ""}" data-alt="${esc(k)}">` +
      `<i style="background:${esc(accentFor(k))}"></i>${esc(projectName(k))}</button>`),
  ];
  return segs.join("");
}

function actionFor(t: Thread): string {
  if (t.sess?.attention) return `<button class="mini-act ans" data-answer="${esc(t.id)}">Answer</button>`;
  if (t.sess) return `<button class="mini-act" data-open="${esc(t.id)}">Open</button>`;
  if (dispatchable(t)) return `<button class="mini-act go" data-dispatch="${esc(t.id)}">⏎ dispatch</button>`;
  return `<button class="mini-act" data-open="${esc(t.id)}" disabled>—</button>`;
}

function rowHtml(t: Thread, showProject: boolean): string {
  const key = threadStatusKey(t);
  const hot = key === "attention" || key === "error";
  const src = t.source === "note" ? `<span class="th-src note">note</span>`
    : t.source === "task" ? `<span class="th-src">task</span>`
    : t.source === "branch" ? `<span class="th-src">git</span>` : "";
  return `<tr class="th-row${hot ? " hot" : ""}" data-open="${esc(t.id)}">
    <td class="th-g ${GCLS[key] ?? "g-idle"}">${GLYPH[key] ?? "·"}</td>
    ${showProject ? `<td class="th-p"><span class="th-pc"><i style="background:${esc(accentFor(t.colorKey))}"></i>${esc(t.project)}</span></td>` : ""}
    <td><div class="th-t">${src}<span class="th-txt">${esc(t.title)}</span></div></td>
    <td class="th-w">${esc(t.where)}</td>
    <td class="th-s">${esc(t.state)}</td>
    <td class="th-n">${esc(t.since ? relTime(t.since) : "—")}</td>
    <td class="th-n th-c">${t.cost != null ? esc(uUsd2(t.cost)) : "—"}</td>
    <td class="th-a">${actionFor(t)}</td>
  </tr>`;
}

export function renderThreads(): void {
  if (!threadsOpen()) return;
  $("threadsAlt").innerHTML = altHtml();

  const threads = current();
  const showProject = threadsProject() === null;
  const cols = showProject ? 8 : 7;
  // The widths live here, not on the body cells: under `table-layout: fixed` a column's
  // width is taken from the FIRST row, so widths declared on `<td>`s are ignored and
  // every column ends up equal. A colgroup states them once, authoritatively; the
  // Thread column is deliberately unsized so it absorbs whatever is left.
  const colgroup = `<colgroup>` +
    `<col style="width:18px">` +
    (showProject ? `<col style="width:98px">` : "") +
    `<col>` +
    `<col style="width:140px"><col style="width:176px">` +
    `<col style="width:52px"><col style="width:60px"><col style="width:92px">` +
    `</colgroup>`;
  const head = `<thead><tr><th></th>${showProject ? "<th>Project</th>" : ""}` +
    `<th>Thread</th><th>Where</th><th>State</th><th class="r">Age</th><th class="r">Spend</th><th></th></tr></thead>`;

  const groups = bandsOf(threads);
  const body = groups.map((g) => {
    const m = BAND_META[g.band];
    return `<tr class="th-band"><th colspan="${cols}"><span class="th-blbl b-${g.band}">` +
      `${esc(m.label)}<span class="th-bn">${g.threads.length}</span>` +
      `<span class="th-bx">${esc(m.hint)}</span></span></th></tr>` +
      g.threads.map((t) => rowHtml(t, showProject)).join("");
  }).join("");

  $("threadsTbl").innerHTML = colgroup + head + `<tbody>${body || emptyRow(cols)}</tbody>`;
}

function emptyRow(cols: number): string {
  return `<tr><td colspan="${cols}" class="th-empty">Nothing wants you right now.
    Sessions, failed runs, notes and branches behind their remote all appear here.</td></tr>`;
}

// ---------- actions ----------
function find(id: string): Thread | undefined {
  return current().find((t) => t.id === id);
}

async function dispatchThread(id: string): Promise<void> {
  const t = find(id);
  if (!t || !dispatchable(t)) return;
  const sid = await launch(t.project || projectName(t.colorKey), t.colorKey, { colorKey: t.colorKey });
  // A note becomes the session's brief and stops being a note — it is the same work
  // item, one stage later, not a copy.
  if (t.note) {
    removeNote(t.note.id);
    if (typeof sid === "string") {
      const brief = t.note.text.replace(/\n/g, " ");
      setTimeout(() => { void invoke("write_pty", { sessionId: sid, data: brief }).catch(() => {}); }, 1400);
      toast("Dispatched — prefilled, press Enter to send");
    }
  } else {
    toast(`Started a session in ${t.project}`);
  }
  renderThreads();
}

function openThread(id: string): void {
  const t = find(id);
  if (!t) return;
  if (t.sess) {
    // Leaving the board for a pane is a normal activation — `setActive` drops the
    // mirror through closeExternalView, so the board hides itself.
    setActive(t.sess.id);
    return;
  }
  if (t.source === "note") { toast("A note — dispatch it to start an agent on it"); return; }
  if (t.source === "branch") { toast(`${t.title} — open a session there to pull`); return; }
}

// ---------- open / close ----------
export function openThreads(project: string | null = null): void {
  setMirror({ kind: "threads", project });
  setActiveId(null);
  for (const x of sessions.values()) x.pane.classList.remove("active");
  ($("empty") as HTMLElement).style.display = "none";
  ($("extPane") as HTMLElement).hidden = true;
  ($("trailPane") as HTMLElement).hidden = true;
  ($("threadsPane") as HTMLElement).hidden = false;
  // At the meta altitude no single project owns the tint; inside one, wear its colour.
  if (project) document.documentElement.style.setProperty("--accent", accentFor(project));
  else document.documentElement.style.removeProperty("--accent");
  // All three, not just the table: this is also the altitude switch, and the header
  // chip and the inspector's counts are both scoped to the altitude. Repainting only
  // the rows left them describing the view you just left.
  renderThreadsHeader(); renderThreadsInspector(); renderThreads();
}

export function closeThreads(): void {
  if (!threadsOpen()) return;
  setMirror(null);
  ($("threadsPane") as HTMLElement).hidden = true;
}

export function renderThreadsHeader(): void {
  ($("btnClose") as HTMLButtonElement).hidden = true;
  const p = threadsProject();
  $("hProj").textContent = p ? projectName(p) : "Threads";
  const hb = $("hBranch");
  hb.textContent = p ? "this project" : "all projects";
  hb.hidden = false; hb.classList.add("ext-chip");
  $("hTitle").textContent = "everything with a phase, ranked";
  $("hPath").textContent = "";
}

export function renderThreadsInspector(): void {
  const threads = current();
  const groups = bandsOf(threads);
  const n = (b: string) => groups.find((g) => g.band === b)?.threads.length ?? 0;
  const pill = $("iPill");
  const needs = n("needs");
  pill.className = `pill ${needs ? "attention" : "idle"}`;
  $("iPillTxt").textContent = needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "all clear";
  $("inspector").innerHTML = `
    <div class="td-stats">
      <div class="td-stat"><span class="label">Needs you</span><b>${needs}</b></div>
      <div class="td-stat"><span class="label">Running</span><b>${n("running")}</b></div>
      <div class="td-stat"><span class="label">Your move</span><b>${n("move")}</b></div>
      <div class="td-stat"><span class="label">Unclaimed</span><b>${n("open")}</b></div>
    </div>
    <p class="ihint">One row per thread — a live agent, a failed run, a note you jotted,
    a branch behind its remote. Ranked by how much it wants you, using the same order
    the sidebar's attention sort uses.</p>`;
}

// ---------- events ----------
export function wireThreads(): void {
  $("threadsPane").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const alt = t.closest<HTMLElement>("[data-alt]");
    if (alt) {
      // Re-open rather than mutate: the altitude lives in `mirror`, and going through
      // the one entry point keeps the accent and the panes in step with it.
      openThreads(alt.dataset.alt || null);
      return;
    }
    const ans = t.closest<HTMLElement>("[data-answer]");
    if (ans) {
      const th = find(ans.dataset.answer!);
      // Answering is the inspector's job — it owns the allow/deny/terminal choice and
      // the risk copy. Jumping there is the honest handoff.
      if (th?.sess) { setActive(th.sess.id); }
      return;
    }
    const disp = t.closest<HTMLElement>("[data-dispatch]");
    if (disp) { void dispatchThread(disp.dataset.dispatch!); return; }
    const open = t.closest<HTMLElement>("[data-open]");
    if (open && !(open as HTMLButtonElement).disabled) { openThread(open.dataset.open!); }
  });
  dlog("info", "threads board wired");
}

/// Repaint on any fleet change, but only when on screen — the board is derived
/// entirely from live state, so it must not go stale while a session works.
export function refreshThreadsIfOpen(): void {
  if (threadsOpen()) { renderThreads(); renderThreadsInspector(); }
}
