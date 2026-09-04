// The sidebar's rows and the glyph vocabulary shared with the mini-rail and the tray. Data in,
// string out: ./sidebar owns the elements and handlers, ./grouping the split and the order.

import { basename, esc, relTime, tilde } from "./format";
import {
  apiErrText, fanoutTally, hasSessionState, isAgent, liveCount, orphanAgents, statusKey,
  taskStateText, type ExtSession, type Restorable, type Sess,
} from "./types";
import {
  accentFor, activeId, collapsedRuns, extMirrorId, folderDirty, pastMirrorId,
  peekPrefs, stageGroup, wtGroup,
} from "./state";
import {
  checkoutOf, clusterByWorktree, clusterIsLive, dormantBusy, foldRunGroups,
  type GroupSummary, type ProjGroup, type RunItem, type WtCluster,
} from "./grouping";
import { peekStaysOpen } from "./peek";
import type { GroupDef } from "./projgroups";

// ---------- the header of a user-defined project group ----------
// `.pf*`, never `.pg*`: `.pgroup` is a project and `.pgpeek` its idle checkouts, both inside
// this fold, and three handlers find `.pgroup` by class. `data-gtoggle`/`data-gid` sit on the
// header, not the wrapper, or a project head inside would `closest()` the group's gid.
export function foldHead(g: GroupDef, sum: GroupSummary, n: number): string {
  const plural = (c: number, word: string) => `${c} ${word}${c === 1 ? "" : "s"}`;
  // Only while collapsed: open, the rows say this; collapsed, a hidden permission is a trap.
  const hidden = g.collapsed
    ? (sum.dirty ? `<span class="pfdirty" title="Uncommitted changes in this group"></span>` : "")
      + (sum.urgent ? `<span class="pfattn ${GCLASS[statusKey(sum.urgent)]}" title="${esc(`${sum.urgent.title || sum.urgent.project} needs you`)}">${GLYPH[statusKey(sum.urgent)]}</span>` : "")
    : "";
  const count = sum.count
    ? `<span class="pfcount live" title="${esc(plural(sum.count, "session"))}">${sum.count}</span>`
    : `<span class="pfcount">${n}</span>`;
  const tip = `${g.name} · ${plural(n, "project")}${sum.count ? `, ${plural(sum.count, "session")}` : ""}`
    + ` · click to ${g.collapsed ? "expand" : "collapse"}`;
  return `<div class="pfhead" data-gtoggle="${esc(g.id)}" data-gid="${esc(g.id)}" title="${esc(tip)}">`
    + `<span class="pfchev"></span><span class="pfname">${esc(g.name)}</span>${hidden}${count}</div>`;
}
export const foldEmpty = () => `<div class="pfempty">Drag a project here</div>`;

// Shared with the mini-rail, the tray and the inspector pill; a new status must also go in tray.ts's SHAPE.
export const GLYPH: Record<string, string> = { attention: "◆", working: "●", thinking: "●", done: "✓", idle: "○", error: "✕", ended: "·", background: "◐" };
export const GCLASS: Record<string, string> = { attention: "g-attn", working: "g-work", thinking: "g-work", done: "g-done", idle: "g-idle", error: "g-error", ended: "g-ended", background: "g-bg" };
// Row wash while a finish highlight fades (./attn, `applyFlash`); an unlisted state falls back
// to done's green rather than unlit. A variable, not a class, so it cannot fight `g-*`'s pulse.
export const LIT_COLOR: Record<string, string> = {
  attention: "var(--st-attention)", error: "var(--st-error)", done: "var(--st-done)",
};
export const extWorking = (e: ExtSession) => !!e.status && !["idle", "sleeping", "done", ""].includes(e.status);

// Main is seeded by its path, the project's own key, so it wears the project header's accent.
const branchHue = (c: WtCluster) => accentFor(c.isMain ? c.key : (c.branch || c.key));
// ⌂ for the repo's own checkout (what the ⑃ dialog and "Open project folder" use), ⑃ for a worktree.
const clusterGlyph = (c: WtCluster) => (c.isMain ? "⌂" : "⑃");
const clusterTip = (c: WtCluster) => (c.isMain ? `${c.branch} · the project folder itself` : c.branch);
const clusterChip = (c: WtCluster) =>
  `<span class="chip" style="--wtc:${branchHue(c)}" title="${esc(clusterTip(c))}">`
  + `<span class="fork">${clusterGlyph(c)}</span><span class="lbl">${esc(c.branch)}</span></span>`;

function sessionRow(s: Sess, chip?: WtCluster, nested = false): string {
  const k = statusKey(s);
  // Title, else the branch until Claude sets one; `nested` drops the ▶ a run group's header carries.
  const label = s.kind === "task"
    ? `${nested ? "" : "▶ "}${s.run?.label ?? "task"}`
    : s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session"));
  // A shell (❯) or terminal-only agent (») has no phase; a dot once exited. Tasks keep the
  // status glyphs, since an exit code is a done/error phase.
  const bare = s.kind === "shell" ? "❯" : isAgent(s) && !hasSessionState(s) ? "»" : "";
  const glyph = bare ? (s.phase === "ended" ? GLYPH.ended : bare) : GLYPH[k];
  const gcls = bare ? (s.phase === "ended" ? GCLASS.ended : "g-idle") : GCLASS[k];
  const chipHtml = chip ? clusterChip(chip) : "";
  const fan = fanoutTally(s);
  const carried = fan ? orphanAgents(s).length : 0;
  const tip = s.phase === "error" && s.apiErr
    ? `${label} · ${apiErrText(s.apiErr)}`
    : fan ? `${label} · ${s.fanout?.name || "background agents"}: ${fan.done} of ${fan.total} done, ${liveCount(s)} running${carried ? ` (${carried} from an earlier run)` : ""}`
      : s.drift ? `${label} · writing to ${s.drift.branch} instead of ${s.branch || "this checkout"}` : label;
  // The row stays under the checkout it was launched in: its identity, and where --resume goes.
  const drift = s.drift
    ? `<span class="sdrift" title="${esc(`Writing to ${s.drift.dir}`)}">⤳ ${esc(s.drift.branch)}</span>`
    : "";
  const fanHtml = fan ? `<span class="sfan" title="${esc(`${fan.done} of ${fan.total} background agents done`)}">${fan.done}/${fan.total}</span>` : "";
  // One cell for every tag: `.srow`'s columns are fixed by CSS (`.o3` adds the fourth).
  const tags = drift + fanHtml + chipHtml;
  return `<div class="srow${tags ? " o3" : ""}${s.drift ? " drifted" : ""} ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${gcls}">${glyph}</span>
    <span class="sbranch" title="${esc(tip)}">${esc(label)}</span>${tags ? `<span class="stags">${tags}</span>` : ""}
    <span class="sctx">${s.kind === "task" ? esc(taskStateText(s)) : s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
    <span class="sclose" data-close="${s.id}" title="Close session">✕</span></div>`;
}
// One `dependsOn` launch as a block: the header carries the aggregate phase and tiles the
// members; the ▸ is its own hit target, since "show all" and "show the steps" differ.
function runGroupRow(it: Extract<RunItem, { kind: "group" }>, chip?: WtCluster): string {
  const open = !collapsedRuns.has(it.id);
  const gcls = GCLASS[it.phase] || "g-idle";
  const tiled = stageGroup === it.id;
  const failed = it.members.filter((m) => m.phase === "error").length;
  const done = it.members.filter((m) => m.run?.exitCode != null || m.phase === "ended").length;
  const tally = failed ? `${failed} failed` : done < it.members.length ? `${done}/${it.members.length}` : `${it.members.length} steps`;
  const chipHtml = chip
    ? `<span class="chip" style="--wtc:${branchHue(chip)}"><span class="fork">⑃</span><span class="lbl">${esc(chip.branch)}</span></span>`
    : "";
  const head = `<div class="rgrow${tiled ? " on" : ""}" data-rungroup="${esc(it.id)}"
      title="${esc(it.label)} · ${it.members.length} steps · open them side by side">
    <span class="rgtwist${open ? " open" : ""}" data-rgtoggle="${esc(it.id)}" title="${open ? "Collapse" : "Expand"} the steps">▸</span>
    <span class="sglyph ${gcls}">${GLYPH[it.phase] || GLYPH.idle}</span>
    <span class="rgname" title="${esc(it.label)}">${esc(it.label)}</span>${chipHtml}
    <span class="rgtally${failed ? " bad" : ""}">${esc(tally)}</span>
    <span class="sclose" data-closerun="${esc(it.id)}" title="Close every pane in this run">✕</span></div>`;
  const body = open ? `<div class="rgsteps">${it.members.map((m) => sessionRow(m, undefined, true)).join("")}</div>` : "";
  return `<div class="rgroup${tiled ? " on" : ""}${open ? " open" : ""}">${head}${body}</div>`;
}

// Every wtGroup mode goes through here, so a run group looks the same in all four.
function rows(list: Sess[], chipFor?: (s: Sess) => WtCluster | undefined): string {
  return foldRunGroups(list)
    .map((it) => it.kind === "group"
      ? runGroupRow(it, chipFor?.(it.members[0]))
      : sessionRow(it.s, chipFor?.(it.s)))
    .join("");
}

// subheader → ⑃ cluster headers, chip → flat rows with a branch chip, off/toplevel → flat; a
// single-checkout project is always flat. Only live checkouts appear; idle ones are peekBody's.
export function groupBody(p: ProjGroup): string {
  const flat = () => rows(p.sessions) + p.externals.map((e) => extRow(e)).join("");
  if (wtGroup === "subheader") {
    // `withEmpty`: idle checkouts count toward whether clustering is worth it, then leave the rows.
    const cl = clusterByWorktree(p, true);
    if (cl.length >= 2) return cl.filter(clusterIsLive).map((c) => {
      const col = branchHue(c), n = c.sessions.length + c.externals.length;
      const body = rows(c.sessions) + c.externals.map((e) => extRow(e)).join("");
      // `data-root` is the repo root, the colorKey every session in the project groups by.
      const add = `<span class="wtadd" data-wtadd="${esc(c.key)}" data-proj="${esc(p.name)}" data-root="${esc(p.path)}"`
        + ` data-branch="${esc(c.branch)}" title="New session in ${esc(c.branch)}">＋</span>`;
      return `<div class="wthead" ${wtMenuAttrs(p, c)}>`
        + `<span class="wtglyph" style="color:${col}">${clusterGlyph(c)}</span>`
        + `<span class="wtname" style="color:${col}" title="${esc(clusterTip(c))}">${esc(c.branch)}</span>`
        + `<span class="wtcount">${n}</span>${add}</div>`
        + `<div class="wtsessions" style="--wtc:${col}">${body}</div>`;
    }).join("");
  } else if (wtGroup === "chip") {
    const cl = clusterByWorktree(p, true);
    if (cl.length >= 2) {
      const byKey = new Map(cl.map((c) => [c.key, c]));
      // Same key clusterByWorktree used, or a task pane in a subfolder gets no chip.
      return rows(p.sessions, (s) => byKey.get(checkoutOf(s, p.path)))
        + p.externals.map((e) => extRow(e, byKey.get(e.cwd || p.path))).join("");
    }
  }
  return flat();
}
// Idle checkouts, revealed while the pointer rests on the group (./peek times it, ./sidebar
// drives it). Rendered whether or not open: hover must never be a render input, or it busts
// renderSidebar's byte-identical cache on every move. `peekStaysOpen` owns the already-open cases.
export function peekBody(p: ProjGroup): string {
  // `toplevel` has nothing nested to reveal and `off` is the flat legacy mode.
  if (wtGroup !== "subheader" && wtGroup !== "chip") return "";
  const cl = clusterByWorktree(p, true);
  if (cl.length < 2) return "";
  const vacant = cl.filter((c) => !clusterIsLive(c));
  if (!vacant.length) return "";
  const open = peekStaysOpen(peekPrefs, vacant.length < cl.length);
  return `<div class="pgpeek${open ? " open" : ""}"><div class="pgpeek-in">`
    + vacant.map((c) => peekRow(p, c)).join("")
    + `</div></div>`;
}
// The whole row launches; same `data-wtadd`/`data-root` contract as the cluster header's ＋.
function peekRow(p: ProjGroup, c: WtCluster): string {
  const col = branchHue(c);
  // Dirty is the one state worth a git process per checkout; the rest is the ⑃ dialog's.
  const dirty = folderDirty(c.key)
    ? `<span class="pkdirty" title="Uncommitted changes in this checkout"></span>` : "";
  return `<div class="pkrow" data-wtadd="${esc(c.key)}" ${wtMenuAttrs(p, c)}`
    + ` title="${esc(`Start a session in ${c.branch} · ${tilde(c.key)}`)}">`
    + `<span class="pkglyph" style="color:${col}">${clusterGlyph(c)}</span>`
    + `<span class="pkname">${esc(c.branch)}</span>${dirty}`
    + `<span class="pkgo">＋</span></div>`;
}
// `data-wt` must be matched ahead of the `data-key` project menu (./projmenu): a checkout, not its repo.
export function wtMenuAttrs(p: ProjGroup, c: WtCluster): string {
  return `data-wt="${esc(c.key)}" data-root="${esc(p.path)}" data-proj="${esc(p.name)}"`
    + ` data-branch="${esc(c.branch)}"${c.isMain ? ` data-main="1"` : ""}`;
}
// Below the live rows, outside any cluster; one shape for shelved-now and last-run rows.
export function dormantRows(p: ProjGroup): string {
  return p.dormants.map((d) => dormantRow(d)).join("");
}
function dormantRow(d: Restorable): string {
  const busy = dormantBusy(d);
  const label = d.title || (d.worktree ? `⑃ ${d.branch}` : d.branch) || "session";
  const when = relTime(d.lastActivity);
  const tip = busy
    ? "This provider session is already running, so it cannot be resumed twice"
    : `Shelved · last active ${when} · click to look, ⟲ to resume`;
  return `<div class="srow pastrow${busy ? " busy" : ""} ${d.id === pastMirrorId() ? "active" : ""}" data-past="${d.id}" data-key="${esc(d.colorKey)}" title="${esc(tip)}">
    <span class="sglyph g-ended">·</span>
    <span class="sbranch">${esc(label)}</span>
    <span class="past-tag">${busy ? "busy" : when}</span>
    <span class="sclose" data-forget="${d.id}" title="Take off the shelf; the conversation stays on disk">✕</span></div>`;
}
function extRow(e: ExtSession, chip?: WtCluster): string {
  const working = extWorking(e);
  const chipHtml = chip ? clusterChip(chip) : "";
  return `<div class="srow extrow${chip ? " o3e" : ""} ${e.session_id === extMirrorId() ? "active" : ""}" data-ext="${e.session_id}" data-key="${esc(e.cwd)}">
    <span class="sglyph ${working ? "g-work" : "g-idle"}">${working ? "●" : "○"}</span>
    <span class="sbranch">${esc(e.name || basename(e.cwd))}</span>${chipHtml}
    <span class="ext-tag" title="Running outside Episko · Claude v${esc(e.version)} · pid ${e.pid}">ext</span>
    <span class="sjump" data-jump="${e.pid}" title="Jump to its terminal ↗">↗</span></div>`;
}
