// The Questions sheet: every question in a conversation and the agent's closing answer to it,
// opened from the outline's head. Owns #qDlg on the ./callsheet pattern; ./questionsview draws.
// It exists because the REPL compacts its scrollback away and the outline's rail fits one line.

import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, dropScrim, toast } from "./dom";
import { jumpToPrompt } from "./inspector";
import { joinPath, renderMarkdown } from "./markdown";
import { openFileOrRead } from "./mdreader";
import { qClipText, qEntries, qIndexHtml, qSubText, qThreadHtml } from "./questionsview";
import { sessions } from "./state";
import type { Prompt, Sess } from "./types";

let sid: string | null = null;
let sel: string | null = null;

export function questionsOpen(): boolean { return sid !== null; }

// `sessionId` travels with the click, not `activeId`, as with the call sheet.
export function openQuestions(sessionId: string) {
  sid = sessionId;
  sel = null;
  $("scrim").classList.add("show");
  $("qDlg").classList.add("show");
  renderQuestions(true);
  const t = $("qThread");
  t.scrollTop = t.scrollHeight; // the newest question is the one you came back for
}

export function closeQuestions() {
  if (sid === null) return;
  sid = null;
  sel = null;
  $("qDlg").classList.remove("show");
  dropScrim();
}

// Rendering markdown is the costly half of a paint that rides renderAll, so each answer is
// rendered once per text. Keyed by prompt id, which is unique app-wide.
const mdCache = new Map<string, { src: string; html: string }>();
function answerHtml(s: Sess, p: Prompt): string {
  const hit = mdCache.get(p.id);
  if (hit && hit.src === p.answer) return hit.html;
  const html = renderMarkdown(p.answer ?? "", { docPath: joinPath(s.workdir, "answer.md"), root: s.workdir, images: false, remote: false }).html;
  mdCache.set(p.id, { src: p.answer ?? "", html });
  return html;
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
  const entries = qEntries(s);
  const title = s.title || s.branch || s.project || "Session";
  if ($("qTitle").textContent !== title) $("qTitle").textContent = title;
  const sub = qSubText(entries);
  if (sub !== lastSub) { lastSub = sub; $("qSub").textContent = sub; }
  const index = qIndexHtml(entries, sel);
  if (index !== lastIndex) { lastIndex = index; $("qIndex").innerHTML = index; }
  const thread = qThreadHtml(s, entries, (p) => answerHtml(s, p));
  if (thread !== lastThread) { lastThread = thread; $("qThread").innerHTML = thread; }
  if (mdCache.size > 400) { // prompts are capped at 200 a pane; drop what no open sheet can show
    const live = new Set([...sessions.values()].flatMap((x) => x.prompts.map((p) => p.id)));
    for (const k of mdCache.keys()) if (!live.has(k)) mdCache.delete(k);
  }
}

function select(id: string) {
  sel = id;
  renderQuestions();
  $("qThread").querySelector<HTMLElement>(`[data-qent="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
}

function copy(id: string | null) {
  const s = sid ? sessions.get(sid) : null;
  if (!s) return;
  const all = qEntries(s);
  const entries = id ? all.filter((e) => e.p.id === id) : all;
  writeText(qClipText(entries))
    .then(() => toast(id ? "Question and answer copied" : `${entries.length} questions copied`))
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
