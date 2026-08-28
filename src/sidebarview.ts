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
// `.pf*`, not `.pg*`. The prefix is load-bearing: `.pgroup` is a *project* and
// `.pgpeek` is its idle checkouts, both of which live INSIDE one of these, and
// `applyPeek`, the peek hover and the reorder all reach for `.pgroup` by class. A fold
// called `.pgroup-something` would be found by half of them. (Same trap the commit
// graph hit with `gc-*` vs `gco-*`, and the same fix: a different prefix, not a longer
// name.)
//
// `data-gtoggle` is the click (collapse), `data-gid` is the right-click (the group
// menu), and both sit on the HEADER rather than on the wrapper — a project head inside
// the fold would otherwise find the wrapper's `data-gid` with `closest()` and open the
// group's menu instead of its own.
export function foldHead(g: GroupDef, sum: GroupSummary, n: number): string {
  const plural = (c: number, word: string) => `${c} ${word}${c === 1 ? "" : "s"}`;
  // Only while collapsed. Open, the rows beneath say all of this themselves, and a
  // header repeating them is noise; collapsed, this is the whole point — a group that
  // could hide a session waiting on a permission would be a trap, not a tidy-up.
  const hidden = g.collapsed
    ? (sum.dirty ? `<span class="pfdirty" title="Uncommitted changes in this group"></span>` : "")
      + (sum.urgent ? `<span class="pfattn ${GCLASS[statusKey(sum.urgent)]}" title="${esc(`${sum.urgent.title || sum.urgent.project} needs you`)}">${GLYPH[statusKey(sum.urgent)]}</span>` : "")
    : "";
  // Panes when it has any, projects otherwise — and the pill is what says which, so
  // the number never has to be read twice. A count that silently meant one thing on one
  // group and the other on its neighbour is the wart this shape avoids.
  const count = sum.count
    ? `<span class="pfcount live" title="${esc(plural(sum.count, "session"))}">${sum.count}</span>`
    : `<span class="pfcount">${n}</span>`;
  const tip = `${g.name} · ${plural(n, "project")}${sum.count ? `, ${plural(sum.count, "session")}` : ""}`
    + ` · click to ${g.collapsed ? "expand" : "collapse"}`;
  return `<div class="pfhead" data-gtoggle="${esc(g.id)}" data-gid="${esc(g.id)}" title="${esc(tip)}">`
    + `<span class="pfchev"></span><span class="pfname">${esc(g.name)}</span>${hidden}${count}</div>`;
}
// A group you took the last project out of. It keeps its place (at the end — it has no
// member to be ranked by) and says what it is for, because the alternative reads as
// Episko having quietly deleted a heading you named.
export const foldEmpty = () => `<div class="pfempty">Drag a project here</div>`;

// The status glyph vocabulary. Shared with the mini-rail, the tray and the
// inspector pill, which is why it sits beside the rows rather than inside them.
//
// `background` is the fan-out state — the session's own turn is over but the agents it
// launched are still running. Half-filled, because that is what it is: half of this row
// is finished and half of it is still going.
export const GLYPH: Record<string, string> = { attention: "◆", working: "●", thinking: "●", done: "✓", idle: "○", error: "✕", ended: "·", background: "◐" };
export const GCLASS: Record<string, string> = { attention: "g-attn", working: "g-work", thinking: "g-work", done: "g-done", idle: "g-idle", error: "g-error", ended: "g-ended", background: "g-bg" };
// The wash a row is lit with while its finish highlight fades (./attn, driven by
// `applyFlash` in ./sidebar). Only the three states that can enter the needs-you set
// ever appear here; anything else falls back to the "your turn" green rather than
// going unlit, so a state added to that set later is visible rather than silent.
//
// A colour per state and not one neutral flash, because the two questions the highlight
// answers are "where" and "what": a pink row across the rail means something is blocked
// on you, and that is worth telling apart from a green one at a glance you are taking
// from another window. It is a *variable*, not a class, precisely so it cannot collide
// with the `g-*` classes above — those already carry a `pulse` animation, and the row's
// own fade would have fought it for the same property.
export const LIT_COLOR: Record<string, string> = {
  attention: "var(--st-attention)", error: "var(--st-error)", done: "var(--st-done)",
};
export const extWorking = (e: ExtSession) => !!e.status && !["idle", "sleeping", "done", ""].includes(e.status);

// A stable colour per branch, from the same hash as project accents so the sidebar's
// colour language stays consistent (a branch and a project just seed different hues).
//
// The main checkout is the exception, and deliberately: it is seeded by its *path*,
// which is the project's own key — so it comes out wearing the exact accent the
// project header does, including a colour the user picked by hand. Seeded by its
// branch it would draw a fourth unrelated hue for the one cluster that isn't a
// separate thing at all.
const branchHue = (c: WtCluster) => accentFor(c.isMain ? c.key : (c.branch || c.key));
// ⑃ forks off something; the repo's own checkout is the something. Wearing the same
// glyph as its worktrees left the project folder identifiable only by knowing which
// branch name meant "the original", which is not knowledge the sidebar should assume —
// a repo whose default is `develop` sitting under three `feat/*` worktrees reads as
// four worktrees. ⌂ is the glyph the ⑃ dialog's Repo row and the project menu's "Open
// project folder" already use for exactly this folder.
const clusterGlyph = (c: WtCluster) => (c.isMain ? "⌂" : "⑃");
const clusterTip = (c: WtCluster) => (c.isMain ? `${c.branch} · the project folder itself` : c.branch);
// The branch chip a row wears in chip mode, colour-coded and hover-expanded.
const clusterChip = (c: WtCluster) =>
  `<span class="chip" style="--wtc:${branchHue(c)}" title="${esc(clusterTip(c))}">`
  + `<span class="fork">${clusterGlyph(c)}</span><span class="lbl">${esc(c.branch)}</span></span>`;

// `chip` (chip mode only) tags the row with its worktree's colour-coded branch,
// which expands from a bare ⑃ to the branch name on row hover.
function sessionRow(s: Sess, chip?: WtCluster, nested = false): string {
  const k = statusKey(s);
  // Prefer the abbreviated title; fall back to the branch/worktree only until
  // Claude sets a title, so idle rows stay identifiable. (Branch is kept in the
  // stage header — dropped here to save sidebar space.)
  // `nested` drops the ▶: inside a run group every row is a step of one, so the
  // group's own header carries the mark and repeating it is just noise.
  const label = s.kind === "task"
    ? `${nested ? "" : "▶ "}${s.run?.label ?? "task"}`
    : s.title || (s.worktree ? `⑃ ${s.branch}` : (s.branch || "session"));
  // shells have no telemetry phase — show a terminal prompt glyph (a dot once exited).
  // A terminal-only agent has none either, so it takes a doubled chevron:
  // same family (a terminal with no phase behind it), visibly not the same thing.
  // tasks keep the status glyphs: an exit code *is* a done/error phase, so a red
  // build reads exactly like a broken session in the rail.
  const bare = s.kind === "shell" ? "❯" : isAgent(s) && !hasSessionState(s) ? "»" : "";
  const glyph = bare ? (s.phase === "ended" ? GLYPH.ended : bare) : GLYPH[k];
  const gcls = bare ? (s.phase === "ended" ? GCLASS.ended : "g-idle") : GCLASS[k];
  const chipHtml = chip ? clusterChip(chip) : "";
  // A red ✕ says the turn broke; the row's tooltip says why, because "API overloaded"
  // and "auth failed" are the same glyph and completely different problems.
  const fan = fanoutTally(s);
  // Named on the row too, not just in the card: the tooltip is where you check a tally
  // that looks wrong, so it has to be able to say which agents aren't this run's.
  const carried = fan ? orphanAgents(s).length : 0;
  const tip = s.phase === "error" && s.apiErr
    ? `${label} · ${apiErrText(s.apiErr)}`
    : fan ? `${label} · ${s.fanout?.name || "background agents"}: ${fan.done} of ${fan.total} done, ${liveCount(s)} running${carried ? ` (${carried} from an earlier run)` : ""}`
      : s.drift ? `${label} · writing to ${s.drift.branch} instead of ${s.branch || "this checkout"}` : label;
  // The row stays under the checkout the session was *launched* in — that is its
  // identity, and where `--resume` goes. This is what says the agent's writes have
  // moved elsewhere, without moving the row out from under you.
  const drift = s.drift
    ? `<span class="sdrift" title="${esc(`Writing to ${s.drift.dir}`)}">⤳ ${esc(s.drift.branch)}</span>`
    : "";
  // The one number worth the width: how much of the fleet has landed. It replaces
  // nothing — the ctx% column keeps its meaning — and it is the whole reason a row can
  // now say "still going" instead of a ✓ that meant "finished twenty minutes ago".
  const fanHtml = fan ? `<span class="sfan" title="${esc(`${fan.done} of ${fan.total} background agents done`)}">${fan.done}/${fan.total}</span>` : "";
  // Both tags share one grid cell. `.srow`'s column count is fixed by CSS (`.o3` adds
  // the fourth for a chip), so a second in-flow child would wrap the row instead of
  // sitting beside it — wrapping them keeps the existing grid math untouched.
  const tags = drift + fanHtml + chipHtml;
  return `<div class="srow${tags ? " o3" : ""}${s.drift ? " drifted" : ""} ${s.id === activeId ? "active" : ""}" data-sel="${s.id}">
    <span class="sglyph ${gcls}">${glyph}</span>
    <span class="sbranch" title="${esc(tip)}">${esc(label)}</span>${tags ? `<span class="stags">${tags}</span>` : ""}
    <span class="sctx">${s.kind === "task" ? esc(taskStateText(s)) : s.ctxPct != null ? Math.round(s.ctxPct) + "%" : ""}</span>
    <span class="sclose" data-close="${s.id}" title="Close session">✕</span></div>`;
}
/// One launch of a `dependsOn` chain, as a single collapsible **block**.
///
/// Deliberately not a row that looks like its own steps. A group header is a different
/// kind of thing — a summary of N runs, and the thing you click to tile them — so it
/// gets a surface of its own with the steps inset inside it, and the whole set reads as
/// one object in the sidebar rather than as N+1 siblings competing for the same rank.
///
/// The header carries the group's *aggregate* phase, so a red chain reads red without
/// expanding it. Clicking it tiles the members across the stage (the one place they are
/// legible side by side); the ▸ affordance is a separate hit target, because "show me
/// all of it" and "show me the step list" are different questions.
function runGroupRow(it: Extract<RunItem, { kind: "group" }>, chip?: WtCluster): string {
  const open = !collapsedRuns.has(it.id);
  const gcls = GCLASS[it.phase] || "g-idle";
  const tiled = stageGroup === it.id;
  const failed = it.members.filter((m) => m.phase === "error").length;
  // Count what's left rather than what there was: "2 of 4 done" is what you want
  // mid-chain, and once it's over the tally is the whole story.
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

/// Paint a session list with each `dependsOn` chain folded into one row. Every
/// wtGroup mode goes through here, so a run group looks the same in all four.
function rows(list: Sess[], chipFor?: (s: Sess) => WtCluster | undefined): string {
  return foldRunGroups(list)
    .map((it) => it.kind === "group"
      ? runGroupRow(it, chipFor?.(it.members[0]))
      : sessionRow(it.s, chipFor?.(it.s)))
    .join("");
}

// The full body of a project group (owned sessions + external rows), shaped by the
// worktree-grouping mode. subheader → ⑃ cluster headers with nested rows; chip →
// flat rows each tagged with a colour-coded branch chip; off/toplevel → plain flat
// rows. A single-checkout project (one cluster) always renders flat — nothing to
// disambiguate. Externals cluster right alongside owned sessions (same checkout dir).
//
// **Only checkouts with something running in them appear here.** The idle ones moved
// to `peekBody` — see the block comment there for why.
export function groupBody(p: ProjGroup): string {
  const flat = () => rows(p.sessions) + p.externals.map((e) => extRow(e)).join("");
  if (wtGroup === "subheader") {
    // `cl` still folds the idle checkouts in (`withEmpty`), because their *count* is
    // what decides whether this project is worth clustering at all: one live checkout
    // beside three idle ones is exactly the case a ⑃ header disambiguates. They are
    // filtered out of the rows, not out of the question.
    const cl = clusterByWorktree(p, true);
    if (cl.length >= 2) return cl.filter(clusterIsLive).map((c) => {
      const col = branchHue(c), n = c.sessions.length + c.externals.length;
      // `rows`, not a bare sessionRow map: a cluster is exactly where the run-group
      // fold has to happen, since a chain's panes all share one checkout.
      const body = rows(c.sessions) + c.externals.map((e) => extRow(e)).join("");
      // The cluster header already answers the only question the worktree dialog
      // would ask — which checkout — so its ＋ launches straight into `c.key`.
      // `data-root` carries the repo root separately: it is the colorKey every
      // session in this project groups by, and a worktree's own path is not it.
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
      // Same key clusterByWorktree used, or a task pane whose cwd is a subfolder
      // gets no chip at all.
      return rows(p.sessions, (s) => byKey.get(checkoutOf(s, p.path)))
        + p.externals.map((e) => extRow(e, byKey.get(e.cwd || p.path))).join("");
    }
  }
  return flat();
}
// The checkouts nothing is running in — collapsed until the pointer rests on the
// project group, then revealed (./peek owns the timing, ./sidebar drives it).
//
// WHY THEY LEFT THE MAIN LIST. A row that permanently says "no session" costs the
// same vertical space as one that is doing something, and a repo with four worktrees
// spent four rows saying it. These rows are worth *reaching*, not *showing*: you want
// them at the moment you are about to start something, which is exactly the moment
// the pointer is already on the project.
//
// Rendered whether or not the group is expanded — hover must never change the markup.
// `renderSidebar` skips its DOM write when the string is byte-identical (84.5% of
// repaints), so making hover a render input would bust that cache on every mouse
// move *and* let a telemetry tick rebuild the DOM out from under an open group.
// The expansion is one class, applied outside the render path.
//
// Peek switched off keeps the old behaviour rather than hiding these for good: the
// wrapper renders already-open, so nothing that used to be reachable stops being so.
// `pinLive` is the same class for a narrower reason — this project has a session in it,
// so its other checkouts are worth showing rather than merely reaching (./peek's
// `peekStaysOpen` owns both halves of that question, and the Settings preview asks it
// too). Whether the project counts as live is asked of the CLUSTERS, not of
// `p.sessions`: a session's pane and the checkout it runs in are the same fact here,
// and `cl` has already resolved every session and external onto one.
export function peekBody(p: ProjGroup): string {
  // Only the two modes that showed idle checkouts before. `toplevel` gives each
  // worktree its own group (there is nothing nested to reveal) and `off` is the
  // deliberately flat legacy mode.
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
// One idle checkout. The whole row launches — there is no ＋ to aim at, because the
// row has exactly one thing it can do and a target the width of the sidebar is easier
// to hit than a glyph. Same `data-wtadd` contract as the cluster header's ＋, so the
// new session keeps the repo's identity (`data-root`) instead of splintering into a
// project group of its own, and the same `wtMenuAttrs` so right-click still reaches
// the checkout menu.
function peekRow(p: ProjGroup, c: WtCluster): string {
  const col = branchHue(c);
  // The one piece of state worth carrying at this size. Anything more (ahead/behind,
  // merged) costs a `git` process per checkout — that is what the ⑃ dialog is for.
  const dirty = folderDirty(c.key)
    ? `<span class="pkdirty" title="Uncommitted changes in this checkout"></span>` : "";
  return `<div class="pkrow" data-wtadd="${esc(c.key)}" ${wtMenuAttrs(p, c)}`
    + ` title="${esc(`Start a session in ${c.branch} · ${tilde(c.key)}`)}">`
    + `<span class="pkglyph" style="color:${col}">${clusterGlyph(c)}</span>`
    + `<span class="pkname">${esc(c.branch)}</span>${dirty}`
    + `<span class="pkgo">＋</span></div>`;
}
// What identifies one checkout to the worktree context menu (./projmenu). `data-wt`
// is the marker its contextmenu handler matches on, and it must be matched *ahead* of
// the `data-key` project menu — a cluster is a checkout, not the repo it belongs to.
// The rest is everything the menu's verbs need without a second lookup.
export function wtMenuAttrs(p: ProjGroup, c: WtCluster): string {
  return `data-wt="${esc(c.key)}" data-root="${esc(p.path)}" data-proj="${esc(p.name)}"`
    + ` data-branch="${esc(c.branch)}"${c.isMain ? ` data-main="1"` : ""}`;
}
// Shelved rows always sit below the live ones, outside any worktree cluster. One row
// shape for two ways in — a session you shelved just now (./panes `shelveSession`) and
// one still on the roster from your last run — because both mean the same thing to the
// reader: not running, and one click from carrying on.
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
