// The call sheet: one tool call in full, at a width its payloads were written for (the rail
// is ~38 mono columns; see CLAUDE.md). Owns #callDlg on the ./diffview pattern. The detail
// pane is the only scroller, and `overflow-wrap` stays default so a line is never cut mid-token.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { $, dropScrim, toast } from "./dom";
import { ageBucket, esc, escAttr, fmtLatency } from "./format";
import { toolClass } from "./inspectorview";
import { ACT_CAP } from "./phase";
import { actClipText } from "./toolio";
import { actKey, type Act } from "./types";
import { sessions } from "./state";

// Two ids rather than a held `Act`: the activity ring shifts under a live session.
let sid: string | null = null;
let sel: string | null = null;

export function callSheetOpen(): boolean { return sid !== null; }

// `sessionId` travels with the click, not `activeId`: the stage may have moved between paint and click.
export function openCallSheet(sessionId: string, key: string) {
  sid = sessionId;
  sel = key;
  $("scrim").classList.add("show");
  $("callDlg").classList.add("show");
  renderCallSheet(true);
}

export function closeCallSheet() {
  // `sid === null`, matching callSheetOpen: `!sid` would let an empty id read open there and closed here.
  if (sid === null) return;
  sid = null;
  sel = null;
  $("callDlg").classList.remove("show");
  dropScrim();
}

export function selectCall(key: string) {
  if (sid === null || key === sel) return;
  sel = key;
  renderCallSheet();
}

// Through the clipboard plugin like every other copy in the app: `navigator.clipboard`
// asks the OS for permission, and a copy that raises a prompt is a copy that failed.
export function copySelectedCall(side: string) {
  const a = selected();
  if (!a) return;
  // An empty block copies its placeholder: silently keeping the old clipboard is worse than pasting it.
  const text = side === "inp" ? (a.inp || "(no arguments)")
    : side === "out" ? (a.out || (a.durMs == null ? "still running" : "(nothing returned)"))
    : actClipText(a);
  const what = side === "inp" ? "Input copied" : side === "out" ? "Output copied" : "Call copied";
  writeText(text)
    .then(() => toast(what))
    .catch(() => toast("copy failed"));
}

function selected(): Act | undefined {
  const s = sid ? sessions.get(sid) : null;
  return s?.activity.find((x) => actKey(x) === sel);
}

// ---------- render ----------

let lastHead = "";
let lastList = "";
let lastDetail = "";

// innerHTML guards, with the list and the detail guarded independently: the sheet rides
// renderAll, but a finished call's detail is a constant string, so a selection dragged across it
// is never replaced under the pointer by a call arriving in the list. `force` clears the caches.
export function renderCallSheet(force = false) {
  if (sid === null) return;
  const s = sessions.get(sid);
  // The pane went away under the sheet; nothing honest left to show.
  if (!s) { closeCallSheet(); return; }
  if (force) { lastHead = ""; lastList = ""; lastDetail = ""; }

  const acts = s.activity;
  const failed = acts.filter((a) => a.failed).length;
  const head = `${acts.length} call${acts.length === 1 ? "" : "s"} kept`
    + (failed ? ` · <span class="bad">${failed} failed</span>` : "");
  if (head !== lastHead) { lastHead = head; $("callSub").innerHTML = head; }
  const title = s.title || s.branch || s.project || "Session";
  if ($("callTitle").textContent !== title) $("callTitle").textContent = title;

  const list = listHtml(acts) || `<div class="call-empty">No tool calls yet.</div>`;
  if (list !== lastList) { lastList = list; $("callList").innerHTML = list; }

  const detail = detailHtml(selected());
  if (detail !== lastDetail) { lastDetail = detail; $("callDetail").innerHTML = detail; }
}

// The whole ring under recency headers. `now` is read once, so two adjacent calls cannot straddle a band.
function listHtml(acts: readonly Act[]): string {
  const now = Date.now();
  let band = "";
  return acts.map((a) => {
    const b = ageBucket(now - a.startMs);
    const head = b === band ? "" : `<div class="call-gh">${esc(b)}</div>`;
    band = b;
    return head + rowHtml(a);
  }).join("");
}

// The clock is `a.time`, never an age recomputed here: that would change every repaint and defeat the guard.
function rowHtml(a: Act): string {
  const cls = toolClass(a.tool);
  const k = actKey(a);
  const running = a.durMs == null;
  const lat = running ? "···" : fmtLatency(a.durMs!);
  return `<button class="call-row${a.failed ? " bad" : ""}${k === sel ? " on" : ""}" type="button" data-callsel="${escAttr(k)}">`
    + `<span class="dot ${cls}"></span>`
    + `<span class="nm ${cls}">${esc(a.tool)}</span>`
    + `<span class="arg">${esc(a.arg)}</span>`
    + `<span class="lat${running ? " run" : ""}">${lat}</span>`
    + `<span class="tm">${esc(a.time)}</span>`
    + `</button>`;
}

// Both sides arrive capped (./toolio cuts at capture). The block's own copy button copies it
// as is, no header: that is for pasting a command back into a shell, unlike the header's Copy.
function block(side: "inp" | "out", label: string, body: string, bad: boolean, dim: boolean): string {
  return `<div class="call-blk">`
    + `<div class="call-blh${bad ? " bad" : ""}">${esc(label)}`
    + `<button class="call-bcopy" type="button" data-callcopy="${side}" title="Copy this on its own">⧉</button>`
    + `</div>`
    + `<pre class="call-pre${bad ? " bad" : ""}${dim ? " dim" : ""}">${esc(body)}</pre>`
    + `</div>`;
}

function detailHtml(a: Act | undefined): string {
  if (!a) {
    // The selected call aged out of the ring; say so rather than jumping the selection.
    return `<div class="call-empty">`
      + `This call has aged out. Only the last ${ACT_CAP} are kept, and the session has run enough tools since to drop it.`
      + `</div>`;
  }
  const running = a.durMs == null;
  // Two "nothing here" facts, both spelled out: still in flight, or genuinely returned nothing.
  const out = a.out || (running ? "still running…" : "(nothing returned)");
  const cls = toolClass(a.tool);
  const meta = `${a.time} · ${running ? "running" : fmtLatency(a.durMs!)}`;
  return `<div class="call-dh">`
    + `<span class="dot ${cls}"></span><b class="${cls}">${esc(a.tool)}</b>`
    + `<span class="call-arg">${esc(a.arg)}</span>`
    + `<span class="call-meta">${esc(meta)}</span>`
    + `<button class="call-copy" type="button" data-callcopy="both" title="Copy this call and its result">Copy</button>`
    + `</div>`
    // Above the Executed block, in the UI font, so nothing about it looks like part of the payload.
    + (a.desc ? `<p class="call-why">${esc(a.desc)}</p>` : "")
    + block("inp", "Executed", a.inp || "(no arguments)", false, !a.inp)
    + block("out", a.failed ? "Failed" : "Returned", out, a.failed, !a.out);
}

$("callClose").addEventListener("click", closeCallSheet);
