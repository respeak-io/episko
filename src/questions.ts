// The Questions sheet: every question in a conversation and the agent's closing answer to it,
// opened from the outline's head. Owns #qDlg on the ./callsheet pattern; ./questionsview draws.
// It exists because the REPL compacts its scrollback away and the outline's rail fits one line.

import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, dropScrim, IS_MAC, toast } from "./dom";
import { jumpToPrompt } from "./inspector";
import { openFileOrRead } from "./mdreader";
import { hitPattern, promptHits, searchTerms } from "./outline";
import { answerMd, copiedWhat, qClipText, qEntries, qIndexHtml, qSearchText, qSubText, qThreadHtml, type QEntry } from "./questionsview";
import { sessions } from "./state";
import type { Sess } from "./types";

let sid: string | null = null;
let sel: string | null = null;
let lastSid: string | null = null;
let query = "";
let terms: string[] = [];

export function questionsOpen(): boolean { return sid !== null; }

const qInput = () => $("qQ") as HTMLInputElement;

// `sessionId` travels with the click, not `activeId`, as with the call sheet. A search survives
// *Find in terminal* and back on the same session; anything else opens fresh.
export function openQuestions(sessionId: string) {
  const again = sessionId === lastSid && terms.length > 0;
  sid = lastSid = sessionId;
  if (!again) { sel = null; setQuery(""); }
  $("scrim").classList.add("show");
  $("qDlg").classList.add("show");
  renderQuestions(true);
  if (!(again && sel && reveal(sel))) {
    const t = $("qThread");
    t.scrollTop = again ? 0 : t.scrollHeight; // the newest question is the one you came back for
  }
  qInput().focus();
  qInput().select();
}

export function closeQuestions() {
  if (sid === null) return;
  sid = null;
  $("qDlg").classList.remove("show");
  CSS.highlights?.delete("q-hit");
  dropScrim();
}

function setQuery(q: string) {
  query = q;
  terms = searchTerms(q);
  if (qInput().value !== q) qInput().value = q;
  $("qSearch").classList.toggle("has", q !== "");
}

function shownEntries(s: Sess): { all: QEntry[]; shown: QEntry[] } {
  const all = qEntries(s.prompts);
  return { all, shown: terms.length ? all.filter((e) => promptHits(e.p, terms)) : all };
}

// Rendering markdown is the costly half of a paint that rides renderAll, so each answer is
// rendered once per text. Keyed by prompt id (plus `#s` for a summary), unique app-wide.
const mdCache = new Map<string, { src: string; html: string }>();
function mdHtml(s: Sess, key: string, text: string): string {
  const hit = mdCache.get(key);
  if (hit && hit.src === text) return hit.html;
  const html = answerMd(s.workdir, text);
  mdCache.set(key, { src: text, html });
  return html;
}

// A fold you opened or closed is yours: the next answer landing must not reset it. That is a
// pasted block's (`data-qblk`) and a compaction's summary (`data-qcmp`).
const FOLDS = "details[data-qblk], details[data-qcmp]";
const foldKey = (d: HTMLElement) => (d.dataset.qblk ? `b:${d.dataset.qblk}` : `c:${d.dataset.qcmp}`);
function paintKeepingFolds(el: HTMLElement, html: string) {
  const was = new Map([...el.querySelectorAll<HTMLDetailsElement>(FOLDS)].map((d) => [foldKey(d), d.open]));
  el.innerHTML = html;
  for (const d of el.querySelectorAll<HTMLDetailsElement>(FOLDS)) {
    const open = was.get(foldKey(d));
    if (open !== undefined) d.open = open;
  }
}

let lastSub = "";
let lastIndex = "";
let lastThread = "";

// Guarded like the call sheet: a text selection dragged across an answer must survive the
// telemetry paints that land while you read it.
export function renderQuestions(force = false) {
  if (sid === null) return;
  const s = sessions.get(sid);
  if (!s) { closeQuestions(); return; }
  if (force) { lastSub = ""; lastIndex = ""; lastThread = ""; }
  const { all, shown } = shownEntries(s);
  const title = s.title || s.branch || s.project || "Session";
  if ($("qTitle").textContent !== title) $("qTitle").textContent = title;
  const sub = qSubText(all);
  if (sub !== lastSub) { lastSub = sub; $("qSub").textContent = sub; }
  const stat = terms.length ? qSearchText(shown.length) : "";
  if ($("qSStat").textContent !== stat) $("qSStat").textContent = stat;
  const copyAll = terms.length ? "Copy matches" : "Copy all";
  if ($("qCopyAll").textContent !== copyAll) {
    $("qCopyAll").textContent = copyAll;
    $("qCopyAll").title = `Copy ${terms.length ? "the matching questions and their answers" : "every question and answer"} as markdown`;
  }
  const none = terms.length && !shown.length && all.length ? `<div class="call-empty">No question or answer mentions that.</div>` : "";
  const index = none || qIndexHtml(shown, sel, terms);
  if (index !== lastIndex) { lastIndex = index; $("qIndex").innerHTML = index; }
  const running = s.phase === "thinking" || s.phase === "working";
  const thread = none || qThreadHtml(shown, (key, text) => mdHtml(s, key, text), { running, live: true, last: all[all.length - 1]?.p.id });
  if (thread !== lastThread) { lastThread = thread; paintKeepingFolds($("qThread"), thread); markThread(false); }
  if (mdCache.size > 400) { // prompts are capped at 200 a pane; drop what no open sheet can show
    const live = new Set([...sessions.values()].flatMap((x) => x.prompts.map((p) => p.id)));
    for (const k of mdCache.keys()) if (!live.has(k.replace(/#s$/, ""))) mdCache.delete(k);
  }
}

// The hits in the thread are a CSS highlight, not <mark>s: the DOM stays exactly what the guard
// wrote, and the ranges die with the nodes, so every repaint re-marks. `open` unfolds a paste or
// a summary a hit is inside, on a new query only: a fold you close after that stays closed.
function markThread(open: boolean) {
  const reg = CSS.highlights;
  if (!reg) return;
  const re = hitPattern(terms);
  if (!re) { reg.delete("q-hit"); return; }
  const root = $("qThread");
  const ranges: Range[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    for (const m of n.data.matchAll(re)) {
      if (!m[0]) continue;
      const r = new Range();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      ranges.push(r);
      if (open) for (let d = n.parentElement?.closest("details"); d && root.contains(d); d = d.parentElement?.closest("details")) d.open = true;
    }
  }
  reg.set("q-hit", new Highlight(...ranges));
}

function reveal(id: string): boolean {
  const ent = $("qThread").querySelector<HTMLElement>(`[data-qent="${CSS.escape(id)}"]`);
  ent?.scrollIntoView({ block: "start" });
  $("qIndex").querySelector<HTMLElement>(".q-row.on")?.scrollIntoView({ block: "nearest" });
  return !!ent;
}

function select(id: string) {
  sel = id;
  renderQuestions();
  reveal(id);
}

// ↓/↑ (and ↵/⇧↵) walk what is listed, wrapping, so a search reads one match after the next.
function step(dir: 1 | -1) {
  const s = sid ? sessions.get(sid) : null;
  if (!s) return;
  const ids = shownEntries(s).shown.map((e) => e.p.id);
  if (!ids.length) return;
  const i = sel ? ids.indexOf(sel) : -1;
  select(ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length]);
}

function search(q: string) {
  setQuery(q);
  renderQuestions(true);
  markThread(true);
  if (!(sel && reveal(sel))) $("qThread").scrollTop = terms.length ? 0 : $("qThread").scrollHeight;
  $("qIndex").scrollTop = 0;
}

function copy(id: string | null) {
  const s = sid ? sessions.get(sid) : null;
  if (!s) return;
  const { shown } = shownEntries(s);
  const entries = id ? shown.filter((e) => e.p.id === id) : shown;
  writeText(qClipText(entries))
    .then(() => toast(id ? copiedWhat(entries) : `${entries.length} questions copied`))
    .catch(() => toast("copy failed"));
}

// The sheet's own listener, like the reader's: its attributes never reach main.ts's dispatcher.
$("qDlg").addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-qsel],[data-qjump],[data-qcopy],[data-qcopyall],[data-mdurl],[data-mdfile]");
  if (!el) return;
  ev.preventDefault();
  const d = el.dataset;
  if (d.qsel) select(d.qsel);
  else if (d.qcopy) copy(d.qcopy);
  else if (d.qcopyall) copy(null);
  else if (d.qjump) { const id = sid; closeQuestions(); if (id) void jumpToPrompt(id, d.qjump); }
  else if (d.mdurl) openUrl(d.mdurl).catch((e) => toast("Couldn't open the link: " + e));
  else if (d.mdfile) { closeQuestions(); void openFileOrRead(d.mdfile); }
});
$("qClose").addEventListener("click", closeQuestions);
$("qQ").addEventListener("input", () => search(qInput().value));
$("qQ").addEventListener("keydown", (e) => {
  // Esc clears first and closes on the second press; prevented here, or main.ts closes at once.
  if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); search(""); }
  else if (e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); step(1); }
  else if (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey)) { e.preventDefault(); step(-1); }
});
$("qQClear").addEventListener("click", () => { search(""); qInput().focus(); });
// ⌘F / Ctrl+F finds in the sheet, wherever the focus went (a click on prose leaves it on <body>).
window.addEventListener("keydown", (e) => {
  if (sid === null || e.key.toLowerCase() !== "f" || e.shiftKey || e.altKey || !(IS_MAC ? e.metaKey : e.ctrlKey)) return;
  e.preventDefault();
  e.stopPropagation();
  qInput().focus();
  qInput().select();
}, true);
