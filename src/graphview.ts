// The project commit-graph panel: the dialog, the IPC and the scroll; ./graph does the
// layout. Never read a whole history: one page of PAGE commits at a time, and nothing
// runs until the project menu row is clicked (docs/commit-graph.md).

import { invoke } from "@tauri-apps/api/core";
import { $, dropScrim, toast } from "./dom";
import { basename, esc, tilde } from "./format";
import {
  laneColor, layoutGraph, lineTip, refChips, refChipsHtml, rowSvg, shortRel,
  type GraphCommit, type GraphLayout,
} from "./graph";

const PAGE = 60; // commits per page; enough to fill a window at 26px a row, one git call
const PREFETCH_PX = 240; // distance from the bottom at which the next page is fetched
// Cap on the graph+chips block, so a deep graph can't squeeze every subject to nothing;
// LEFT_COL_SHARE bounds it by the panel's width too (the one collapse step measured in JS).
const LEFT_COL_MAX = 380;
const LEFT_COL_SHARE = 0.42;

type Scope = "all" | "head";
type Page = { commits: GraphCommit[]; more: boolean };
const EMPTY_LAYOUT: GraphLayout = { rows: [], lanes: 0 };

let root = "";              // the project folder the panel is scoped to
let label = "";
let scope: Scope = "all";   // reset on every open; "this branch" is a narrowing, not a setting
let commits: GraphCommit[] = [];
let layout: GraphLayout = EMPTY_LAYOUT;
let more = false;
let loading = false;
let settled = false; // any page back yet; without it the first paint would say "No commits yet"
let err: string | null = null;
let sel: string | null = null; // selected sha, for the detail strip
let open1: string | null = null; // full-message overlay, by sha; closing it leaves `sel` alone
// Messages by sha, fetched when the overlay opens (a page field had to be length-capped)
// and cached so ↑/↓ doesn't re-ask git.
const msgs = new Map<string, string>();
let seq = 0; // bumped on open, rescope, refresh and close; a page from an older seq is dropped

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
  $("graphBody").focus(); // so ↑/↓ reach the panel, not the terminal underneath
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
      // A tall window can hold more than one page with no scroll to trigger the next; top up.
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
    // Eight lane colours only, so the node's title is the one place a line (and a merge) is named.
    const tip = esc(lineTip(r));
    // Graph and chips share one cell, so the chips sit against the graph's actual silhouette.
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

// Pin every row's graph+chips block to the widest one's width, capped. Each row is its own
// grid, so an `auto` track would stagger per row; measuring graph and chips as one block
// keeps a wide graph and wide chips from costing width where they don't co-occur.
function sizeLeftColumn() {
  const list = $("graphBody").querySelector<HTMLElement>(".grows");
  if (!list) return;
  // Reset, measure and pin in one synchronous pass, so no frame paints at `auto`.
  list.style.setProperty("--gleft-w", "auto");
  let max = 0;
  for (const el of list.querySelectorAll<HTMLElement>(".gleft")) max = Math.max(max, el.offsetWidth);
  const cap = Math.min(LEFT_COL_MAX, Math.round($("graphDlg").clientWidth * LEFT_COL_SHARE));
  list.style.setProperty("--gleft-w", Math.min(max, cap) + "px");
}

function footHtml(): string {
  if (loading) return `<div class="gmore"><span class="g-dim">Reading history…</span></div>`;
  if (err) return `<div class="gmore"><span class="g-err">${esc(err)}</span></div>`;
  if (!more) return `<div class="gmore"><span class="g-dim">· the beginning of history ·</span></div>`;
  // Both on purpose: scroll prefetch is the everyday path; the button shows it's a page, not the repo.
  return `<div class="gmore"><button class="gmore-b" data-gmore="1">Load ${PAGE} more</button></div>`;
}

function detailHtml(): string {
  const c = commits.find((x) => x.sha === sel);
  if (!c) return `<span class="g-dim">Pick a commit to see its branch, author and parents. ⏎ opens the whole message.</span>`;
  const when = c.unix > 0 ? new Date(c.unix * 1000).toLocaleString() : "";
  const parents = c.parents.length
    ? c.parents.map((p) => {
      const known = commits.some((x) => x.sha === p);
      // A parent past the loaded frontier isn't a row yet: say so rather than offer a dead click.
      return known
        ? `<button class="gp" data-gsha="${p}" title="Jump to this parent">${esc(p.slice(0, 7))}</button>`
        : `<span class="gp gp-off" title="Not loaded yet; load more to reach it">${esc(p.slice(0, 7))}</span>`;
    }).join("")
    : `<span class="g-dim">root</span>`;
  const row = layout.rows.find((r) => r.c.sha === c.sha);
  const lane = row
    ? `<span class="gd-lane" title="${esc(lineTip(row))}" style="--lc:${laneColor(row.line)}">`
      + `${row.label ? `on ${esc(row.label.name)}` : "no branch on this line"}`
      + `${row.merged.length ? ` · merges ${esc(row.merged.join(", "))}` : ""}</span>`
    : "";
  // A summary only: the full sha and the body live in the overlay. The short sha IS the copy button.
  return `<div class="gd-l1">${refChipsHtml(refChips(c.refs, 99))}`
    + `<span class="gd-subj" title="${esc(c.subject)}">${esc(c.subject)}</span></div>`
    + `<div class="gd-l2">${lane}<span class="gd-sep">·</span><span>${esc(c.author)}</span>`
    + `<span class="g-dim">${esc(when)}</span><span class="gd-sep">·</span>`
    + `<button class="gd-sha-b" data-gcopy="${esc(c.sha)}" title="Copy the full sha\n${esc(c.sha)}">⧉ ${esc(c.short)}</button>`
    + `<span class="gd-par">parents ${parents}</span>`
    // Shares the `gswap` footprint with the overlay's close button, so closing lands under the pointer.
    + `<button class="gd-b gswap" data-gopen="${esc(c.sha)}" title="Show the whole commit (⏎)">`
    + `⤢ Full message</button></div>`;
}

// One commit in full, over the list rather than replacing the dialog, so Esc steps back
// to the graph (why graphEscape exists instead of main.ts calling closeGraph).
function renderCommit() {
  const el = $("graphCommit");
  const c = commits.find((x) => x.sha === open1);
  if (!c) { el.hidden = true; el.innerHTML = ""; return; }
  const row = layout.rows.find((r) => r.c.sha === c.sha);
  // Until the whole message lands, the subject alone shows, so the overlay never opens empty.
  const msg = msgs.get(c.sha);
  const body = msg === undefined ? undefined : msg.slice(c.subject.length).trim();
  const when = c.unix > 0 ? new Date(c.unix * 1000).toLocaleString() : "";
  const parents = c.parents.length
    ? c.parents.map((p) => {
      const known = commits.some((x) => x.sha === p);
      return known
        ? `<button class="gp" data-gsha="${p}" data-gjump="1" title="Jump to this parent">${esc(p.slice(0, 12))}</button>`
        : `<span class="gp gp-off" title="Not loaded yet; load more to reach it">${esc(p.slice(0, 12))}</span>`;
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
        : `<div class="gco-nobody">No message body; the subject is the whole commit message.</div>`)
    + `</div>`
    + `<div class="gco-meta">`
    + `<span><b>${esc(c.author)}</b></span><span class="g-dim">${esc(when)}</span>`
    + (row ? `<span class="gd-lane" style="--lc:${laneColor(row.line)}" title="${esc(lineTip(row))}">`
      + `${row.label ? `on ${esc(row.label.name)}` : "no branch on this line"}`
      + `${row.merged.length ? ` · merges ${esc(row.merged.join(", "))}` : ""}</span>` : "")
    + `<span class="gco-sp"></span><span class="gd-par">parents ${parents}</span>`
    // A second close at the bottom right, where the pointer is when you finish reading.
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

async function loadMessage(sha: string) {
  try {
    msgs.set(sha, await invoke<string>("git_commit_message", { workdir: root, sha }));
  } catch (e) {
    // Cache the failure too: a broken object store must not be re-asked on every ↑/↓.
    msgs.set(sha, `${commits.find((c) => c.sha === sha)?.subject ?? ""}\n\ncouldn't read this message: ${String(e)}`);
  }
  if (open1 === sha) renderCommit();
}
function closeCommit() {
  open1 = null;
  renderCommit();
  $("graphBody").focus();
}
export function graphEscape() {
  if (open1) { closeCommit(); return; }
  closeGraph();
}

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
// One delegated handler for list, strip and overlay: a parent chip carries the same data-gsha a row does.
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
// The left block's cap is a share of the panel's width, so a resize has to re-measure it.
window.addEventListener("resize", () => { if (graphOpen) sizeLeftColumn(); });
// ↑/↓ keep working while a commit is open, so messages can be read one commit at a time.
$("graphCommit").addEventListener("keydown", (e) => {
  if (!open1) return;
  if (e.key === "ArrowDown") { e.preventDefault(); step(1); openCommit(sel); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); openCommit(sel); }
});
$("graphBody").addEventListener("dblclick", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>("[data-gsha]");
  if (row) openCommit(row.dataset.gsha!);
});
// Prefetch near the bottom; loadMore's own guards keep a fast scroll from stacking requests.
$("graphBody").addEventListener("scroll", () => {
  if (!graphOpen || loading || !more) return;
  const b = $("graphBody");
  if (b.scrollHeight - b.scrollTop - b.clientHeight < PREFETCH_PX) void loadMore();
});
// Stopped here, so arrow keys never reach the terminal or the sidebar underneath.
$("graphBody").addEventListener("keydown", (e) => {
  if (!graphOpen) return;
  if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  else if (e.key === "Home") { e.preventDefault(); if (layout.rows.length) select(layout.rows[0].c.sha, true); }
  else if (e.key === "Enter" && sel) { e.preventDefault(); openCommit(sel); }
});
