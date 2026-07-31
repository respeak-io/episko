// The project commit-graph panel: the lanes, the refs and the commits behind a
// project folder. Reached from a project's right-click menu and nowhere else — history
// is a "go and look" surface, not a figure the cockpit should carry, and the header has
// no room left for a button that answers a question nobody asked yet.
//
// **The rule this module exists to keep: never read a whole history.** Nothing here
// runs until that menu row is clicked (so app start and renderAll() are untouched),
// and the panel then reads ONE page — the newest `PAGE` commits — asking for the next
// only when the reader reaches the end of what it has. A monorepo with 300k commits
// costs the same first paint as a week-old repo. The layout side is ./graph, which is
// pure and tested; this module owns the dialog, the IPC and the scroll.

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, toast } from "./dom";
import { basename, esc, tilde } from "./format";
import {
  laneColor, layoutGraph, lineTip, refChips, refChipsHtml, rowSvg, shortRel,
  type GraphCommit, type GraphLayout,
} from "./graph";

/** Commits per page. Enough to fill any window at 26px a row and to make the shape of
 *  recent history legible; small enough that the panel is up in one git call. */
const PAGE = 60;
/** How close to the bottom (px) a scroll gets before the next page is fetched. */
const PREFETCH_PX = 240;
/** Ceiling on the graph+chips block, so a deep graph or a commit carrying nine refs can't
 *  squeeze every subject in the panel into nothing. Past it the chips fade at the edge,
 *  each keeping its full name in its own title. Also bounded by a share of the panel's
 *  own width (`LEFT_COL_SHARE`) — the rest of the collapse ladder is CSS container
 *  queries, but this one number is measured in JS, so it has to shrink here. */
const LEFT_COL_MAX = 380;
const LEFT_COL_SHARE = 0.42;

type Scope = "all" | "head";
type Page = { commits: GraphCommit[]; more: boolean };
const EMPTY_LAYOUT: GraphLayout = { rows: [], lanes: 0 };

let root = "";              // the project folder the panel is scoped to
let label = "";
// Resets to "all" on every open rather than persisting: one lane isn't a graph, so
// all-refs is the answer the panel exists to give, and "this branch" is a narrowing
// you make while reading — not a setting you want to inherit from last week.
let scope: Scope = "all";
let commits: GraphCommit[] = [];
let layout: GraphLayout = EMPTY_LAYOUT;
let more = false;
let loading = false;
// Whether any page has come back yet for the current question. Distinct from
// `loading`: without it the first paint (which happens before the first request, so
// the panel is up instantly) would say "No commits yet" for a frame — an answer, and
// the wrong one.
let settled = false;
let err: string | null = null;
let sel: string | null = null; // selected sha, for the detail strip
// The full-message overlay, by sha. Separate from `sel` because closing it must leave the
// selection alone — you open it to read one commit, not to move.
let open1: string | null = null;
// Messages, by sha. Fetched one at a time when the overlay opens rather than shipped with
// every commit in the page: as a page field a body had to be length-capped, and the cap
// then truncated the one message somebody had opened to read. Cached so walking ↑/↓
// through commits and back doesn't re-ask git.
const msgs = new Map<string, string>();
// Bumped on every open, rescope, refresh and close: a page that lands after one of
// those belongs to a question nobody is asking any more and must be dropped.
let seq = 0;

export let graphOpen = false;

// ---------- opening & loading ----------

export async function openGraph(dir: string, name: string) {
  root = dir;
  label = name || basename(dir);
  scope = "all";
  graphOpen = true;
  reset();
  $("scrim").classList.add("show");
  $("graphDlg").classList.add("show");
  $("graphTitle").textContent = label;
  $("graphPath").textContent = tilde(dir);
  // Focus the scroll region so ↑/↓ reach the panel rather than the terminal underneath.
  $("graphBody").focus();
  render();
  await loadMore();
}

export function closeGraph() {
  graphOpen = false;
  open1 = null;
  renderCommit();
  seq++;
  loading = false;
  commits = [];
  layout = EMPTY_LAYOUT;
  $("graphDlg").classList.remove("show");
  dropScrim();
}

function reset() {
  seq++;
  msgs.clear();
  commits = [];
  layout = EMPTY_LAYOUT;
  more = false;
  loading = false;
  settled = false;
  err = null;
  sel = null;
  $("graphBody").scrollTop = 0;
}

/** Fetch the next page and re-lay-out. The only path that talks to git. */
async function loadMore() {
  if (!graphOpen || loading) return;
  loading = true;
  const my = seq;
  render(); // paint the "loading" foot before the call, not after it
  try {
    const page = await invoke<Page>("git_graph", { workdir: root, skip: commits.length, limit: PAGE, scope });
    if (my !== seq) return; // closed, rescoped or refreshed while git was working
    commits = commits.concat(page.commits);
    more = page.more;
    err = null;
  } catch (e) {
    if (my !== seq) return;
    err = String(e);
    more = false;
  } finally {
    if (my === seq) {
      loading = false;
      settled = true;
      render();
      // A tall window can hold more than one page, and then there is no scroll to
      // trigger the next one — so top up until the reader has something to scroll.
      const body = $("graphBody");
      if (more && !loading && body.scrollHeight <= body.clientHeight) void loadMore();
    }
  }
}

async function rescope(s: Scope) {
  if (s === scope) return;
  scope = s;
  reset();
  render();
  await loadMore();
}

async function refresh() {
  reset();
  render();
  await loadMore();
}

// ---------- painting ----------

function render() {
  if (!graphOpen) return;
  layout = layoutGraph(commits);
  $("graphSub").innerHTML = err
    ? `<span class="g-err">${esc(err)}</span>`
    : `${commits.length}${more ? "+" : ""} commit${commits.length === 1 ? "" : "s"}`
      + ` · <span class="g-dim">${scope === "all" ? "all refs" : "this branch"}</span>`;
  $("graphScope").innerHTML = (["all", "head"] as Scope[])
    .map((s) => `<button class="gseg-b ${s === scope ? "on" : ""}" data-gscope="${s}">${s === "all" ? "All branches" : "This branch"}</button>`)
    .join("");

  const rows = layout.rows.map((r) => {
    const chips = refChips(r.c.refs);
    const head = chips.some((x) => x.kind === "head");
    // The lanes are eight colours and nothing else, so the node carries what line it is
    // on — and, for a merge, what came in. It is the only place that can be read.
    const tip = esc(lineTip(r));
    // Graph and chips share ONE cell: the SVG is only as wide as this row's own lanes,
    // so the chips land against the graph's actual silhouette, and the cell's fixed width
    // still starts every subject at the same x.
    return `<div class="grow${r.c.sha === sel ? " on" : ""}" data-gsha="${r.c.sha}" role="option" aria-selected="${r.c.sha === sel}">`
      + `<span class="gleft">`
      + `<span class="gcol" title="${tip}">${rowSvg(r, { head })}</span>`
      + `<span class="grefs">${refChipsHtml(chips)}</span></span>`
      + `<span class="gsubj" title="${esc(r.c.subject)}">${esc(r.c.subject) || "<em>no subject</em>"}</span>`
      + `<span class="gsha">${esc(r.c.short)}</span>`
      + `<span class="gwho">${esc(r.c.author)}</span>`
      + `<span class="gwhen" title="${esc(r.c.rel)}"><span class="w-l">${esc(r.c.rel)}</span><span class="w-s">${esc(shortRel(r.c.rel))}</span></span>`
      + `</div>`;
  }).join("");

  $("graphBody").innerHTML = rows
    ? `<div class="grows" role="listbox" aria-label="Commits">${rows}</div>${footHtml()}`
    : `<div class="diff-empty">${!settled || loading ? "Reading history…" : err ? esc(err) : "No commits yet."}</div>`;
  $("graphDetail").innerHTML = detailHtml();
  sizeLeftColumn();
  if (open1) renderCommit(); // a page landing under the overlay may fill in its parents
}

/**
 * Give every row the same graph+chips width: the widest one's, capped.
 *
 * The chips belong beside the lanes — a label is a property of the *line*, and inside the
 * message column it reads as clutter attached to the wrong thing. Measuring one block
 * (graph *and* chips together) rather than two is what stops a 12-lane repo from
 * indenting every 2-lane row by ten empty lanes plus the widest ref column in the page;
 * the slack is shared, so a wide graph and wide chips only cost width where they actually
 * co-occur.
 *
 * Each row is its own grid (see the CSS note), so an `auto` track would be per-row and
 * stagger. Rather than guess a width from character counts, let the browser lay each row
 * out naturally, take the widest, and pin every row to it. Both style writes and the read
 * happen inside this task, so nothing is painted mid-measurement.
 */
function sizeLeftColumn() {
  const list = $("graphBody").querySelector<HTMLElement>(".grows");
  if (!list) return;
  list.style.setProperty("--gleft-w", "auto");
  let max = 0;
  for (const el of list.querySelectorAll<HTMLElement>(".gleft")) max = Math.max(max, el.offsetWidth);
  const cap = Math.min(LEFT_COL_MAX, Math.round($("graphDlg").clientWidth * LEFT_COL_SHARE));
  list.style.setProperty("--gleft-w", Math.min(max, cap) + "px");
}

/** The end of the list: what is left, and how to ask for it. */
function footHtml(): string {
  if (loading) return `<div class="gmore"><span class="g-dim">Reading history…</span></div>`;
  if (err) return `<div class="gmore"><span class="g-err">${esc(err)}</span></div>`;
  if (!more) return `<div class="gmore"><span class="g-dim">— the beginning of history —</span></div>`;
  // Deliberately both: the scroll prefetch is the everyday path, the button is what
  // makes it obvious that the panel is holding a page and not the whole repo.
  return `<div class="gmore"><button class="gmore-b" data-gmore="1">Load ${PAGE} more</button></div>`;
}

function detailHtml(): string {
  const c = commits.find((x) => x.sha === sel);
  if (!c) return `<span class="g-dim">Pick a commit to see its branch, author and parents — ⏎ opens the whole message.</span>`;
  const when = c.unix > 0 ? new Date(c.unix * 1000).toLocaleString() : "";
  const parents = c.parents.length
    ? c.parents.map((p) => {
      const known = commits.some((x) => x.sha === p);
      // A parent past the loaded frontier isn't a row yet, so it can't be jumped to —
      // say so on the chip rather than offering a click that does nothing.
      return known
        ? `<button class="gp" data-gsha="${p}" title="Jump to this parent">${esc(p.slice(0, 7))}</button>`
        : `<span class="gp gp-off" title="Not loaded yet — load more to reach it">${esc(p.slice(0, 7))}</span>`;
    }).join("")
    : `<span class="g-dim">root</span>`;
  const row = layout.rows.find((r) => r.c.sha === c.sha);
  const lane = row
    ? `<span class="gd-lane" title="${esc(lineTip(row))}" style="--lc:${laneColor(row.line)}">`
      + `${row.label ? `on ${esc(row.label.name)}` : "no branch on this line"}`
      + `${row.merged.length ? ` · merges ${esc(row.merged.join(", "))}` : ""}</span>`
    : "";
  // Two lines: the commit, then its metadata. Everything here is a *summary* — the full
  // sha and the message body are one keystroke away in the overlay, and putting them here
  // as well made a 40-character sha the loudest thing in the panel while the lane label
  // sat orphaned beside it. The short sha IS the copy button, so that is one control
  // instead of two.
  return `<div class="gd-l1">${refChipsHtml(refChips(c.refs, 99))}`
    + `<span class="gd-subj" title="${esc(c.subject)}">${esc(c.subject)}</span></div>`
    + `<div class="gd-l2">${lane}<span class="gd-sep">·</span><span>${esc(c.author)}</span>`
    + `<span class="g-dim">${esc(when)}</span><span class="gd-sep">·</span>`
    + `<button class="gd-sha-b" data-gcopy="${esc(c.sha)}" title="Copy the full sha\n${esc(c.sha)}">⧉ ${esc(c.short)}</button>`
    + `<span class="gd-par">parents ${parents}</span>`
    // Bottom right of the strip, which is where the overlay's own close button lands:
    // open a message and the thing that closes it is already under the pointer. The
    // shared `gswap` footprint is what makes that true rather than nearly true.
    + `<button class="gd-b gswap" data-gopen="${esc(c.sha)}" title="Show the whole commit (⏎)">`
    + `⤢ Full message</button></div>`;
}

/**
 * One commit in full, over the list. The strip can show a subject; a message is prose,
 * and a scrolling 40px box inside a footer is not where anyone reads prose.
 *
 * It covers the list rather than replacing the dialog, so the graph is still behind it and
 * Esc steps back to it — the reason `graphEscape` exists rather than main.ts calling
 * `closeGraph` directly.
 */
function renderCommit() {
  const el = $("graphCommit");
  const c = commits.find((x) => x.sha === open1);
  if (!c) { el.hidden = true; el.innerHTML = ""; return; }
  const row = layout.rows.find((r) => r.c.sha === c.sha);
  // The whole message (subject included) once it lands. Until then the subject alone is
  // shown — it is already known, so the overlay never opens empty.
  const msg = msgs.get(c.sha);
  const body = msg === undefined ? undefined : msg.slice(c.subject.length).trim();
  const when = c.unix > 0 ? new Date(c.unix * 1000).toLocaleString() : "";
  const parents = c.parents.length
    ? c.parents.map((p) => {
      const known = commits.some((x) => x.sha === p);
      return known
        ? `<button class="gp" data-gsha="${p}" data-gjump="1" title="Jump to this parent">${esc(p.slice(0, 12))}</button>`
        : `<span class="gp gp-off" title="Not loaded yet — load more to reach it">${esc(p.slice(0, 12))}</span>`;
    }).join("")
    : `<span class="g-dim">none (root commit)</span>`;
  el.hidden = false;
  el.innerHTML = `<div class="gco-head">`
    + `<code class="gco-sha">${esc(c.sha)}</code>`
    + `<button class="gd-b" data-gcopy="${esc(c.sha)}">⧉ Sha</button>`
    + `<button class="gd-b" data-gcopymsg="1">⧉ Message</button>`
    + `<span class="gco-sp"></span>`
    + `<button class="diff-x" data-gclose1="1" title="Back to the graph (Esc)">✕</button></div>`
    + `<div class="gco-body">`
    + `<div class="gco-refs">${refChipsHtml(refChips(c.refs, 99))}</div>`
    + `<h3 class="gco-subj">${esc(c.subject)}</h3>`
    + (body === undefined
      ? `<div class="gco-nobody">Reading the message…</div>`
      : body
        ? `<pre class="gco-msg">${esc(body)}</pre>`
        : `<div class="gco-nobody">No message body — the subject is the whole commit message.</div>`)
    + `</div>`
    + `<div class="gco-meta">`
    + `<span><b>${esc(c.author)}</b></span><span class="g-dim">${esc(when)}</span>`
    + (row ? `<span class="gd-lane" style="--lc:${laneColor(row.line)}" title="${esc(lineTip(row))}">`
      + `${row.label ? `on ${esc(row.label.name)}` : "no branch on this line"}`
      + `${row.merged.length ? ` · merges ${esc(row.merged.join(", "))}` : ""}</span>` : "")
    + `<span class="gco-sp"></span><span class="gd-par">parents ${parents}</span>`
    // A second close, bottom right. You finish reading at the *bottom* of a message, and
    // the pointer is already down here — travelling back to the top-right ✕ is the whole
    // reason this exists. Both buttons and Esc do the same thing.
    + `<button class="gd-b gswap gco-x2" data-gclose1="1" title="Back to the graph (Esc)">✕ Close</button>`
    + `</div>`;
}

function openCommit(sha: string | null) {
  if (!sha) return;
  open1 = sha;
  renderCommit();
  $("graphCommit").focus();
  if (!msgs.has(sha)) void loadMessage(sha);
}

/** One commit's whole message. Uncapped in practice — see git_commit_message. */
async function loadMessage(sha: string) {
  try {
    msgs.set(sha, await invoke<string>("git_commit_message", { workdir: root, sha }));
  } catch (e) {
    // Store the failure where the body would have been, and cache it: a broken object
    // store must not be re-asked on every ↑/↓.
    msgs.set(sha, `${commits.find((c) => c.sha === sha)?.subject ?? ""}\n\ncouldn't read this message — ${String(e)}`);
  }
  if (open1 === sha) renderCommit();
}
function closeCommit() {
  open1 = null;
  renderCommit();
  $("graphBody").focus();
}
/** Esc steps out one layer: the commit overlay first, then the panel. */
export function graphEscape() {
  if (open1) { closeCommit(); return; }
  closeGraph();
}

/** Select a commit, scrolling it into view when the move came from the keyboard. */
function select(sha: string | null, reveal = false) {
  sel = sha;
  render();
  if (reveal && sha) $("graphBody").querySelector<HTMLElement>(`.grow[data-gsha="${sha}"]`)?.scrollIntoView({ block: "nearest" });
}

function step(delta: number) {
  const rows = layout.rows;
  if (!rows.length) return;
  const at = rows.findIndex((r) => r.c.sha === sel);
  const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
  select(rows[next].c.sha, true);
}

// ---------- the panel's own wiring ----------

$("graphClose").addEventListener("click", closeGraph);
$("graphRefresh").addEventListener("click", () => { void refresh(); });
$("graphScope").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-gscope]");
  if (b) void rescope(b.dataset.gscope as Scope);
});
// One delegated handler for the list and the detail strip: a parent chip in the strip
// carries the same data-gsha a row does, so jumping to it needs no second path.
for (const id of ["graphBody", "graphDetail", "graphCommit"]) {
  $(id).addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const copy = t.closest<HTMLElement>("[data-gcopy]");
    if (copy) {
      const sha = copy.dataset.gcopy!;
      navigator.clipboard.writeText(sha).then(() => toast("Sha copied")).catch(() => toast(sha));
      return;
    }
    if (t.closest("[data-gcopymsg]")) {
      const c = commits.find((x) => x.sha === open1);
      const text = (open1 && msgs.get(open1)) || c?.subject || "";
      navigator.clipboard.writeText(text).then(() => toast("Message copied")).catch(() => toast("copy failed"));
      return;
    }
    if (t.closest("[data-gclose1]")) { closeCommit(); return; }
    if (t.closest("[data-gmore]")) { void loadMore(); return; }
    const opener = t.closest<HTMLElement>("[data-gopen]");
    if (opener) { openCommit(opener.dataset.gopen!); return; }
    const row = t.closest<HTMLElement>("[data-gsha]");
    if (!row) return;
    // A parent chip in the strip or the overlay jumps; a row toggles its selection.
    if (row.dataset.gjump) { select(row.dataset.gsha!, true); closeCommit(); return; }
    select(row.dataset.gsha === sel ? null : row.dataset.gsha!, id !== "graphBody");
  });
}
// The left block's cap is a share of the panel's width, so a window resize has to
// re-measure it — nothing else re-renders on resize.
window.addEventListener("resize", () => { if (graphOpen) sizeLeftColumn(); });
// ↑/↓ keep working while a commit is open, so a message can be read one commit at a time
// rather than open-Esc-move-open. (Esc is global — see graphEscape.)
$("graphCommit").addEventListener("keydown", (e) => {
  if (!open1) return;
  if (e.key === "ArrowDown") { e.preventDefault(); step(1); openCommit(sel); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); openCommit(sel); }
});
// Double-click a row to read it in full — the same thing ⏎ and the strip's ⤢ do.
$("graphBody").addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-gsha]");
  if (row) openCommit(row.dataset.gsha!);
});
// Load the next page as the reader approaches the end of this one. The `more` and
// `loading` guards are in loadMore, so a fast scroll can't stack requests.
$("graphBody").addEventListener("scroll", () => {
  if (!graphOpen || loading || !more) return;
  const b = $("graphBody");
  if (b.scrollHeight - b.scrollTop - b.clientHeight < PREFETCH_PX) void loadMore();
});
// Arrow keys walk the list. Scoped to the open panel and stopped here, so they never
// reach the terminal (or the sidebar) underneath.
$("graphBody").addEventListener("keydown", (e) => {
  if (!graphOpen) return;
  if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "Home") { e.preventDefault(); if (layout.rows.length) select(layout.rows[0].c.sha, true); }
  else if (e.key === "Enter" && sel) { e.preventDefault(); openCommit(sel); }
});
