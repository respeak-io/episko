// The project dashboard's markup. Data in, string out — no `$()`, no `innerHTML`, no
// renderer call, the same contract as ./sidebarview, ./inspectorview and ./usageview.
// ./dash owns the rules and ./dashboard owns the pane, the IPC and the events.
//
// Untested by design, like every other *view module: snapshotting template literals
// mostly re-asserts itself.

import { basename, esc, relTime, sparkline, tilde, uUsd2 } from "./format";
import type { Pulse, ProjectFacts, ProjectTier } from "./dash";
import type { Note } from "./notes";
import type { TrailCommit, TrailDay, TrailSession } from "./trail";
import type { WtHead } from "./types";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- the pulse strip ----------
// Five numbers before any detail, so the window answers itself at a glance. Which five
// depends on the tier: a folder with no git has no commits to count, and showing a
// permanent zero there would read as "nothing happened" rather than "not applicable".

function tile(k: string, v: string, d = ""): string {
  return `<div class="db-tile"><span class="k">${esc(k)}</span><span class="v">${v}</span>`
    + (d ? `<span class="d">${d}</span>` : "") + `</div>`;
}

export function pulseHtml(p: Pulse, tier: ProjectTier, range: number, dense: number[]): string {
  const tiles: string[] = [];
  if (tier !== "none") {
    tiles.push(`<div class="db-tile"><span class="k">Commits</span><span class="v">${p.commits}</span>`
      + `<span class="db-spark mono" aria-hidden="true">${esc(sparkline(dense))}</span></div>`);
  }
  tiles.push(tile("Sessions", String(p.sessions), `${range} days`));
  // Spend is per-project and only exists from the day the detail rollup started. A
  // dash rather than $0.00 — "we didn't keep this" and "it was free" are different
  // facts and the strip must not conflate them.
  tiles.push(tile("Agent spend", p.spend > 0 ? esc(uUsd2(p.spend)) : `<span class="dim">—</span>`));
  if (tier !== "none") {
    const who = p.authors.length
      ? esc(p.authors.slice(0, 2).map((a) => a.split(/\s+/)[0]).join(", ")) + (p.authors.length > 2 ? ` +${p.authors.length - 2}` : "")
      : `<span class="dim">—</span>`;
    tiles.push(tile("Contributors", String(p.authors.length), who));
  }
  return `<div class="db-pulse" data-tiles="${tiles.length + 1}">${tiles.join("")}
    <div class="db-tile win"><span class="db-seg">
      ${[7, 14, 30].map((r) => `<button${r === range ? ` class="on"` : ""} data-dashrange="${r}">${r}d</button>`).join("")}
    </span></div></div>`;
}

// ---------- the timeline ----------

/// A generated sentence is marked, always. The reader has to be able to tell what the
/// app observed from what a model wrote about it, and the mark is the only difference
/// between a log and a claim.
export function dayHtml(d: TrailDay, summary: string | null, headline: string, open: boolean): string {
  const dt = new Date(d.when);
  const rows = dayRows(d);
  const hidden = rows.length;
  return `<div class="db-day${open ? " open" : ""}" data-dashday="${esc(d.key)}">
    <div class="db-gut">
      <span class="dd">${WEEKDAY[dt.getDay()]} ${dt.getDate()}</span>
      ${d.cost > 0 ? `<span class="cc">${esc(uUsd2(d.cost))}</span>` : ""}
    </div>
    <div class="db-dbody">
      <p class="db-sum">${esc(summary || headline)}${summary ? `<span class="ai">· ai</span>` : ""}</p>
      <div class="db-facts">
        ${d.commits.length ? `<span>${d.commits.length} commit${d.commits.length === 1 ? "" : "s"}</span>` : ""}
        ${d.commits.length && d.sessions.length ? `<span class="dot">·</span>` : ""}
        ${d.sessions.length ? `<span>${d.sessions.length} session${d.sessions.length === 1 ? "" : "s"}</span>` : ""}
        ${authorsOf(d)}
        ${hidden ? `<button class="db-more" data-dashopen="${esc(d.key)}">${hidden} more <span class="cv">⌄</span></button>` : ""}
      </div>
      ${hidden ? `<div class="db-detail"><div><div class="db-rows">${rows.join("")}</div></div></div>` : ""}
    </div>
  </div>`;
}

function authorsOf(d: TrailDay): string {
  const who = [...new Set(d.commits.map((c) => c.author.split(/\s+/)[0]))];
  if (!who.length) return "";
  return `<span class="dot">·</span><span class="who">${esc(who.slice(0, 3).join(", "))}</span>`;
}

/// One time-ordered list, sessions and commits mixed. Not sessions-then-commits: a
/// session at 09:00 and the commit it produced at 09:05 are a cause and its effect,
/// and listing all the causes then all the effects breaks the only ordering that
/// explains the day. (Same rule as ./trail's `dayItems`, restated per project.)
function dayRows(d: TrailDay): string[] {
  const items: { when: number; html: string }[] = [
    ...d.sessions.map((s) => ({ when: s.when, html: sessionRow(s) })),
    ...d.commits.map((c) => ({ when: c.when * 1000, html: commitRow(c) })),
  ];
  return items.sort((a, b) => b.when - a.when).map((i) => i.html);
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function sessionRow(s: TrailSession): string {
  return `<div class="db-item"><span class="db-kind sess">session</span>`
    + `<span class="db-t" title="${esc(s.title)}">${esc(s.title)}</span>`
    + `<span class="db-r">${clock(s.when)}</span></div>`;
}
function commitRow(c: TrailCommit): string {
  return `<div class="db-item" data-dashsha="${esc(c.sha)}" title="${esc(`${c.subject} — ${c.author}`)}">`
    + `<span class="db-kind">commit</span>`
    + `<span class="db-t">${esc(c.subject)}</span>`
    + `<span class="db-r">${clock(c.when * 1000)}</span></div>`;
}

// ---------- the aside ----------
// Four compact cards at most, each one line per row and each with a ⤢ that opens the
// same detail overlay. A card appears when it has something to say and is absent
// otherwise: an empty panel reads as breakage, not as an honest blank.

function card(id: string, title: string, count: string, body: string, enlarge = true): string {
  return `<div class="ac"><div class="ac-h"><span class="t">${esc(title)}</span>`
    + `<span class="n">${esc(count)}</span>`
    + (enlarge ? `<button class="xb" data-dashopen-view="${id}" title="See all">⤢</button>` : "")
    + `</div><div class="ac-b">${body}</div></div>`;
}

/// A checkout row. Branch and one piece of state — anything more (ahead/behind,
/// merged) costs a `git` process per checkout, which is what the ⑃ dialog is for.
function checkoutRow(w: WtHead, live: number, dirty: boolean, main: boolean): string {
  const tag = live ? `<span class="tag acc">${live} live</span>`
    : dirty ? `<span class="tag warn">dirty</span>`
    : `<span class="tag ok">clean</span>`;
  return `<div class="cr" data-dashwt="${esc(w.path)}" title="${esc(tilde(w.path))}">`
    + `<span class="k">${main ? "⌂" : "⑃"}</span>`
    + `<span class="ti mono">${esc(w.branch || basename(w.path))}</span>`
    + `<span class="rt">${tag}</span></div>`;
}

export function checkoutsCard(
  heads: WtHead[],
  liveFor: (path: string) => number,
  dirtyFor: (path: string) => boolean,
): string {
  if (heads.length < 2) return ""; // one checkout is not a list worth a card
  const rows = heads.map((w) => checkoutRow(w, liveFor(w.path), dirtyFor(w.path), w.is_main)).join("");
  return card("checkouts", "Checkouts", String(heads.length), rows);
}

function noteRow(n: Note): string {
  return `<div class="nt" data-dashnote="${esc(n.id)}">
    <span class="ntx"><span class="tx">${esc(n.text)}</span>
      <span class="mt"><span>${esc(relTime(n.created))}</span></span></span>
    <span class="nt-b">
      <button class="nb" data-dashdispatch="${esc(n.id)}" title="Start an agent on this">▶</button>
      <button class="nb" data-dashdrop="${esc(n.id)}" title="Delete">✕</button>
    </span></div>`;
}

export function notesCard(notes: Note[]): string {
  const body = notes.length
    ? notes.slice(0, 3).map(noteRow).join("")
    : `<div class="ac-empty">Nothing queued. Jot the next thing above.</div>`;
  return `<div class="ac"><div class="ac-h"><span class="t">Notes</span>
      <span class="n">${notes.length}</span>
      <button class="xb" data-dashopen-view="notes" title="Open the notes board">⤢</button></div>
    <form class="nt-form" id="dashJot">
      <input id="dashNote" placeholder="What's next here?" autocomplete="off" />
      <button type="submit" title="Add">＋</button>
    </form>
    <div class="ac-b">${body}</div></div>`;
}

/// What this folder can't do, said once and plainly. Rendered *instead of* the cards
/// it replaces, never alongside empty ones.
export function missingCard(tier: ProjectTier, f: ProjectFacts | null): string {
  if (tier === "github") return "";
  if (tier === "git") {
    const where = f?.host ? `<code>${esc(f.host)}</code>` : "no remote at all";
    return `<div class="miss"><span class="t">Not on GitHub</span>
      <p>Issues, pull requests and claims need a GitHub remote — this project's origin is ${where}.
         Those cards are absent rather than empty.</p>
      <p><b>Sharing still works.</b> <code>.episko/</code> is committed like any other file, so the
         work log reaches whoever pulls. GitHub was never what made it shared.</p></div>`;
  }
  return `<div class="miss"><span class="t">Not a repository</span>
    <p>The timeline is still real — sessions and spend come from Claude's own transcripts, which never
       needed git. What's missing is the commit half: no checkouts, no contributors, no work log.</p>
    <p>Notes stay on this machine: there is nothing to commit <code>.episko/</code> into.</p></div>`;
}

// ---------- the inspector: the project's context menu, standing open ----------

export function dashInspector(
  root: string, tier: ProjectTier, f: ProjectFacts | null,
  live: { id: string; label: string; glyph: string; cls: string; ctx: string }[],
  shared: boolean,
): string {
  const act = (a: string, ic: string, lb: string, sb = "", cls = "") =>
    `<button class="ia ${cls}" data-dashact="${a}"><span class="ic">${ic}</span>`
    + `<span><span class="lb">${esc(lb)}</span>${sb ? `<span class="sb">${esc(sb)}</span>` : ""}</span></button>`;
  const chips = [
    f?.slug ? `<span class="chip">${esc(f.slug)}</span>` : "",
    f?.host && !f.slug ? `<span class="chip">${esc(f.host)}</span>` : "",
    tier === "none" ? `<span class="chip warn">not a repo</span>` : "",
    shared ? `<span class="chip acc" title="This project has a committed .episko/digest.md">.episko/ shared</span>` : "",
  ].filter(Boolean).join("");
  return `
    ${live.length ? `<div><span class="label">Running here</span><div class="ip-live">${live.map((s) =>
      `<div class="srow" data-sel="${esc(s.id)}"><span class="sglyph ${s.cls}">${s.glyph}</span>`
      + `<span class="sbranch">${esc(s.label)}</span><span class="sctx">${esc(s.ctx)}</span></div>`).join("")}</div></div>` : ""}
    <div><span class="label">Do something here</span><div class="ip-acts">
      ${act("launch", "＋", "New session", live.length ? `${live.length} already running here` : "start Claude Code in this folder")}
      ${tier !== "none" ? act("worktree", "⑃", "New worktree session…", "on a branch of its own") : ""}
      ${act("terminal", "❯", "Open terminal here")}
      ${act("run", "▶", "Run a task…")}
      <div class="ip-sep"></div>
      ${tier !== "none" ? act("graph", "⑂", "Commit graph…", "history, branches, merges") : ""}
      ${act("history", "◷", "History…", "reopen a session you closed")}
      ${act("folder", "⌂", "Open project folder")}
      ${act("copypath", "⧉", "Copy path")}
    </div></div>
    ${chips ? `<div><span class="label">Repository</span><div class="db-chips">${chips}</div></div>` : ""}
    <p class="ihint">${esc(tilde(root))}</p>`;
}

/// The 44px rail ⌘I collapses to on this view. It exists because the inspector holds
/// the ONLY copy of History / Terminal / Run here — the dashboard header gave them up
/// — so collapsing to nothing would hide real verbs. The live-session glyphs stay at
/// the top, so the one thing the lighter header gave up (noticing something needs you)
/// survives the collapse.
export function dashStrip(
  accent: string, initial: string, tier: ProjectTier,
  live: { id: string; glyph: string; cls: string; label: string }[],
): string {
  const b = (a: string, ic: string, t: string, cls = "") =>
    `<button class="isb ${cls}" data-dashact="${a}" title="${esc(t)}">${ic}</button>`;
  return `<span class="sglyphs">
      <span class="pglyph" style="background:${esc(accent)}">${esc(initial)}</span>
      ${live.map((s) => `<button class="isb live ${s.cls}" data-sel="${esc(s.id)}" title="${esc(s.label)}">${s.glyph}</button>`).join("")}
    </span>
    ${b("launch", "＋", "New session")}
    ${tier !== "none" ? b("worktree", "⑃", "New worktree session…") : ""}
    ${b("terminal", "❯", "Open terminal here")}
    ${b("run", "▶", "Run a task…")}
    <span class="isep"></span>
    ${tier !== "none" ? b("graph", "⑂", "Commit graph…") : ""}
    ${b("history", "◷", "History…")}
    ${b("folder", "⌂", "Open project folder")}
    ${b("copypath", "⧉", "Copy path")}`;
}

// ---------- the enlarge overlay ----------
// One component, N contents — title, subtitle, ✕ Close, and a footer stating the one
// non-obvious rule. It covers the dashboard rather than replacing it, and Esc steps
// out one layer, the same as the commit graph's message overlay.

export function overlayHtml(title: string, sub: string, body: string, foot: string): string {
  return `<div class="ovl-h"><span class="t">${esc(title)}</span><span class="s">${esc(sub)}</span>
      <span class="rt"><button class="act" data-dashclose-view>✕<span class="txt"> Close</span></button></span></div>
    <div class="ovl-b">${body}</div>
    ${foot ? `<div class="ovl-f">${foot}</div>` : ""}`;
}

/// Checkouts, enlarged: the ⑃ dialog's facts without the dialog. One fixed column
/// geometry for every row — `auto` would let each row size to its own tag and the
/// columns would stagger, which is the trap the commit graph's row grid documents.
export function checkoutsOverlay(
  heads: WtHead[], liveFor: (p: string) => number, dirtyFor: (p: string) => boolean,
): string {
  const rows = heads.map((w) => {
    const live = liveFor(w.path), dirty = dirtyFor(w.path);
    return `<div class="dbwt" data-dashwt="${esc(w.path)}">
      <span class="gl">${w.is_main ? "⌂" : "⑃"}</span>
      <span class="bn mono">${esc(w.branch || basename(w.path))}</span>
      <span class="pt mono">${esc(tilde(w.path))}</span>
      <span class="tags">${live ? `<span class="tag acc">${live} live</span>` : ""}${dirty ? `<span class="tag warn">uncommitted</span>` : `<span class="tag ok">clean</span>`}</span>
      <span class="acts"><button class="act" data-dashwtadd="${esc(w.path)}" title="New session here">＋</button>
        <button class="act" data-dashwtterm="${esc(w.path)}" title="Open a terminal here">❯</button></span>
    </div>`;
  }).join("");
  return overlayHtml("Checkouts", `${heads.length} · ${heads.filter((w) => liveFor(w.path)).length} with sessions`,
    `<div class="dbwt-hd"><span></span><span>Branch</span><span>Folder</span><span>State</span><span class="r">Actions</span></div>${rows}`,
    `Creating a worktree, pruning a stale one and every warning about a locked or detached checkout stay in the <b>⑃ dialog</b>, which already does all of that. This is a status board.`);
}

export function notesOverlay(notes: Note[], shared: boolean): string {
  const body = notes.length
    ? `<div class="ncol">${notes.map((n) => `<div class="ncard" data-dashnote="${esc(n.id)}">
        <span class="tx">${esc(n.text)}</span>
        <span class="mt"><span>${esc(relTime(n.created))}</span></span>
        <span class="bar"><button class="act" data-dashdispatch="${esc(n.id)}">▶ Start an agent</button>
          <button class="act" data-dashdrop="${esc(n.id)}">✕</button></span></div>`).join("")}</div>`
    : `<div class="ac-empty">Nothing queued yet.</div>`;
  return overlayHtml("Notes", `${notes.length} on this project`, body,
    shared
      ? `Notes are yours alone. The committed half of <code>.episko/</code> is the work log; sharing a note is a separate switch and is not in this build yet.`
      : `Notes stay on this machine — there is no repository to commit them into.`);
}
