// The sidebar's rows: one line per session, external session or dormant one, the
// worktree cluster bodies that wrap them, and the glyph vocabulary they share with
// the mini-rail and the tray.
//
// A *view.ts module in the sense the other two established: data in, string out,
// no DOM and no renderer. renderSidebar / renderMini / initProjectDnD stay in
// main.ts — they own the element, the drag state and the delegated click handlers
// these rows' data- attributes are read by.
//
// Which grouping mode produced a row is not decided here either: ./grouping hands
// over ProjGroups and WtClusters already split and sorted, and this only paints
// them.

import { basename, esc, fmtShort, relTime } from "./format";
import { statusKey, type ExtSession, type Restorable, type Sess } from "./types";
import {
  accentFor, activeId, externals, extMirrorId, pastMirrorId, sessions, wtGroup,
} from "./state";
import { clusterByWorktree, type ProjGroup, type WtCluster } from "./grouping";

// The status glyph vocabulary. Shared with the mini-rail, the tray and the
// inspector pill, which is why it sits beside the rows rather than inside them.
export const GLYPH: Record<string, string> = { attention: "◆", working: "●", thinking: "●", done: "✓", idle: "○", error: "✕", ended: "·" };
export const GCLASS: Record<string, string> = { attention: "g-attn", working: "g-work", thinking: "g-work", done: "g-done", idle: "g-idle", error: "g-error", ended: "g-ended" };
export const extWorking = (e: ExtSession) => !!e.status && !["idle", "sleeping", "done", ""].includes(e.status);

// A stable colour per branch, from the same hash as project accents so the sidebar's
// colour language stays consistent (a branch and a project just seed different hues).
const branchHue = (c: WtCluster) => accentFor(c.branch || c.key);

// `chip` (chip mode only) tags the row with its worktree's colour-coded branch,
// which expands from a bare ⑃ to the branch name on row hover.
function sessionRow(s: Sess, chip?: WtCluster): string {
  const k = statusKey(s);
  // Prefer the abbreviated title; fall back to the branch/worktree only until
  // Claude sets a title, so idle rows stay identifiable. (Branch is kept in the
  // stage header — dropped here to save sidebar space.)
  const label = s.kind === "task" ? `▶ ${s.run?.label ?? "task"}` : s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session"));
  // shells have no telemetry phase — show a terminal prompt glyph (a dot once exited).
  // tasks keep the status glyphs: an exit code *is* a done/error phase, so a red
  // build reads exactly like a broken session in the rail.
  const glyph = s.kind === "shell" ? (s.phase === "ended" ? GLYPH.ended : "❯") : GLYPH[k];
  const gcls = s.kind === "shell" ? (s.phase === "ended" ? GCLASS.ended : "g-idle") : GCLASS[k];
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow${chip ? " o3" : ""} ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${gcls}">${glyph}</span>
    <span class="sbranch" title="${esc(label)}">${esc(label)}</span>${chipHtml}
    <span class="sctx">${s.kind === "task" ? esc(taskStateText(s)) : s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
    <span class="sclose" data-close="${s.id}" title="Close session">✕</span></div>`;
}
// The full body of a project group (owned sessions + external rows), shaped by the
// worktree-grouping mode. subheader → ⑃ cluster headers with nested rows; chip →
// flat rows each tagged with a colour-coded branch chip; off/toplevel → plain flat
// rows. A single-checkout project (one cluster) always renders flat — nothing to
// disambiguate. Externals cluster right alongside owned sessions (same checkout dir).
export function groupBody(p: ProjGroup): string {
  const flat = () => p.sessions.map((s) => sessionRow(s)).join("") + p.externals.map((e) => extRow(e)).join("");
  if (wtGroup === "subheader") {
    const cl = clusterByWorktree(p);
    if (cl.length >= 2) return cl.map((c) => {
      const col = branchHue(c), n = c.sessions.length + c.externals.length;
      const body = c.sessions.map((s) => sessionRow(s)).join("") + c.externals.map((e) => extRow(e)).join("");
      return `<div class="wthead"><span class="wtglyph" style="color:${col}">⑃</span>`
        + `<span class="wtname" style="color:${col}" title="${esc(c.branch)}">${esc(c.branch)}</span>`
        + `<span class="wtcount">${n}</span></div>`
        + `<div class="wtsessions" style="--wtc:${col}">${body}</div>`;
    }).join("");
  } else if (wtGroup === "chip") {
    const cl = clusterByWorktree(p);
    if (cl.length >= 2) {
      const byKey = new Map(cl.map((c) => [c.key, c]));
      return p.sessions.map((s) => sessionRow(s, byKey.get(s.workdir || p.path))).join("")
        + p.externals.map((e) => extRow(e, byKey.get(e.cwd || p.path))).join("");
    }
  }
  return flat();
}
// Dormant rows always sit below the live ones, outside any worktree cluster.
export function dormantRows(p: ProjGroup): string {
  return p.dormants.map((d) => dormantRow(d)).join("");
}
function dormantRow(d: Restorable): string {
  const busy = dormantBusy(d);
  const label = d.title || (d.worktree ? `⑃ ${d.branch}` : d.branch) || "session";
  const when = relTime(d.lastActivity);
  const tip = busy
    ? "This session is running somewhere else right now — resuming it would interleave both transcripts"
    : `Restore this session · last active ${when}`;
  return `<div class="srow pastrow${busy ? " busy" : ""} ${d.id === pastMirrorId() ? "active" : ""}" data-past="${d.id}" data-key="${esc(d.colorKey)}" title="${esc(tip)}">
    <span class="sglyph g-ended">·</span>
    <span class="sbranch">${esc(label)}</span>
    <span class="past-tag">${busy ? "busy" : when}</span>
    <span class="sclose" data-forget="${d.id}" title="Remove from list — the conversation stays on disk">✕</span></div>`;
}
// A session that's live right now must not be offered for restore: Claude doesn't
// lock the transcript, so a second --resume of the same id silently interleaves
// both conversations into one file.
export function dormantBusy(d: Restorable): boolean {
  for (const s of sessions.values()) if (s.resumeId === d.resumeId || s.id === d.id) return true;
  return externals.some((e) => e.session_id === d.resumeId);
}
function extRow(e: ExtSession, chip?: WtCluster): string {
  const working = extWorking(e);
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  return `<div class="srow extrow${chip ? " o3e" : ""} ${e.session_id === extMirrorId() ? "active" : ""}" data-ext="${e.session_id}" data-key="${esc(e.cwd)}">
    <span class="sglyph ${working ? "g-work" : "g-idle"}">${working ? "●" : "○"}</span>
    <span class="sbranch">${esc(e.name || basename(e.cwd))}</span>${chipHtml}
    <span class="ext-tag" title="Running outside Episko · Claude v${esc(e.version)} · pid ${e.pid}">ext</span>
    <span class="sjump" data-jump="${e.pid}" title="Jump to its terminal ↗">↗</span></div>`;
}

// The trailing column in the sidebar, and the palette subtitle. A background run
// never claims to be finished, so it reads "bg" for as long as it lives.
export function taskStateText(s: Sess): string {
  const r = s.run;
  if (!r) return "";
  if (s.phase === "working") return r.background ? "bg" : fmtShort(Date.now() - r.startedAt);
  if (r.exitCode == null) return "";
  return r.exitCode === 0 ? fmtShort(Date.now() - r.startedAt) : `exit ${r.exitCode}`;
}
