// The xterm side of a pane: creating, sizing and keying a terminal, shared by every spawner.
// Nothing here reaches upward.

import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IS_WIN, toast } from "./dom";
import { dlog } from "./debug";
import type { Prompt, Sess } from "./types";
import { lineHasPrompt, normLine, promptKeys, screenShift, type PromptKey } from "./outline";
import { findLinks, linkBases, type PathCand } from "./termlinks";
import { activeId, sessions, setTermFontSize, stageGroup, termFontSize } from "./state";

// The bundled Nerd Font first (@font-face in styles.css) so icon glyphs draw on every OS.
export const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

// WebGL contexts come from a small LRU pool: a context per pane for life hits the webview's
// 16-context cap, and dispose-per-switch leaks under WKWebView's GC. Full story: docs/architecture.md.
const glPool: Sess[] = []; // panes holding a live addon, most recently staged last
const GL_POOL_MAX = 8;     // headroom under the 16-slot budget for contexts not yet collected
export function attachWebgl(s: Sess) {
  if (!s.term) return;
  const i = glPool.indexOf(s);
  if (i >= 0) glPool.splice(i, 1);
  if (s.gl) { glPool.push(s); return; }
  let w: WebglAddon | undefined;
  try {
    w = new WebglAddon();
    w.onContextLoss(() => {
      // dispose() is the documented recovery; clearing `s.gl` lets the next setActive re-attach.
      dlog("warn", `webgl context lost · ${s.id.slice(0, 8)} · DOM renderer until reactivated`);
      detachWebgl(s);
    });
    s.term.loadAddon(w);
    s.gl = w;
    glPool.push(s);
    // Evict the coldest hidden pane past the cap; visible tiles are exempt (they heal on loss).
    while (glPool.length > GL_POOL_MAX) {
      const victim = glPool.find((x) => !x.pane.classList.contains("active"));
      if (!victim) break;
      detachWebgl(victim);
    }
  } catch (e) {
    // No WebGL (GPU blocklist, RDP): warn once per run but keep retrying, a GPU process can come back.
    try { w?.dispose(); } catch { /* half-activated addon */ }
    if (!webglWarned) { webglWarned = true; dlog("warn", `webgl unavailable, so terminals use the DOM renderer (${e})`); }
  }
}
let webglWarned = false;
export function detachWebgl(s: Sess) {
  const w = s.gl;
  if (!w) return;
  s.gl = undefined; // clear first: dispose() must not re-enter through onContextLoss
  const i = glPool.indexOf(s);
  if (i >= 0) glPool.splice(i, 1);
  // Zero the canvases dispose() removes so their backing stores can be freed now.
  const canvases = [...s.pane.querySelectorAll("canvas")];
  try { w.dispose(); } catch { /* already disposed with its terminal */ }
  for (const c of canvases) { c.width = 0; c.height = 0; }
}

// For ended provider-backed panes only: history can reopen those, a shell has no history, and a
// failed task's scrollback is the log you open it to read.
export function trimScrollback(s: Sess) {
  if (!s.term || s.term.options.scrollback === 0) return;
  try { s.term.options.scrollback = 0; } catch { /* pane already disposed */ }
}

// A pane already at 0 is `trimScrollback`'s reclaim; handing it lines back would refill the buffer.
export function applyScrollback(list: Iterable<Sess>, lines: number) {
  for (const s of list) {
    if (!s.term || s.term.options.scrollback === 0) continue;
    try { s.term.options.scrollback = lines; } catch { /* pane disposed mid-pass */ }
  }
}

// xterm keeps only the last custom key handler; task panes take `clipboardKeys` alone (no prompt).
export function shellKeys(id: string, term: Terminal): (e: KeyboardEvent) => boolean {
  const clip = clipboardKeys(term), nav = macShellKeys(id);
  return (e) => clip(e) && nav(e);
}

// Ctrl+Shift+C/V (Ctrl+C is an interrupt, xterm turns Ctrl+V into ^V; ⌘C/⌘V work natively on macOS).
// Tauri's clipboard plugin, never `navigator.clipboard`: its read prompts.
export function clipboardKeys(term: Terminal): (e: KeyboardEvent) => boolean {
  return (e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
    const k = e.key.toLowerCase();
    if (k !== "c" && k !== "v") return true;
    // Returning false only stops xterm; the WebView's own Ctrl+Shift+C (devtools) needs this too.
    e.preventDefault();
    if (k === "c") void copySelection(term);
    else void pasteClipboard(term);
    return false;
  };
}

async function copySelection(term: Terminal) {
  const sel = term.getSelection();
  if (!sel) return;
  try { await writeText(sel); toast("Copied"); }
  catch (e) { dlog("error", `clipboard write failed: ${e}`); toast("Couldn't copy: clipboard unavailable"); }
}

// `term.paste`, never `write_pty`: xterm's own path applies \r\n→\r and bracketed paste.
// A read that throws is nearly always an empty or non-text clipboard (arboard reports both as errors).
async function pasteClipboard(term: Terminal) {
  let text = "";
  try { text = await readText(); }
  catch (e) { dlog("error", `clipboard read failed: ${e}`); toast("Nothing to paste: no text on the clipboard"); return; }
  if (text) term.paste(text);
}

// xterm emits modified-arrow sequences (Option+Left = \e[1;3D) a plain login zsh does not bind,
// so word-nav keys self-insert ";3D". Send the Meta/emacs sequences Terminal.app sends instead.
function macShellKeys(id: string): (e: KeyboardEvent) => boolean {
  const send = (data: string, e: KeyboardEvent): boolean => { e.preventDefault(); invoke("write_pty", { sessionId: id, data }); return false; };
  return (e: KeyboardEvent) => {
    if (e.type !== "keydown") return true;
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x1bb", e);      // backward-word
      if (e.key === "ArrowRight") return send("\x1bf", e);     // forward-word
      if (e.key === "Backspace") return send("\x1b\x7f", e);   // backward-kill-word
    }
    if (e.metaKey && !e.altKey && !e.ctrlKey) {
      if (e.key === "ArrowLeft") return send("\x01", e);       // beginning-of-line (^A)
      if (e.key === "ArrowRight") return send("\x05", e);      // end-of-line (^E)
    }
    return true;
  };
}

// Claude's REPL quits on a second ^C inside its ~2s double-press window, which in an embedded pane
// reads as Episko losing the session, so repeats within INTR_GUARD_MS are swallowed.
const INTR_GUARD_MS = 3000; // must stay longer than Claude's own window, or the exit gets through
export function claudeInput(id: string): (d: string) => void {
  let lastIntr = 0, warned = false;
  return (d) => {
    // Exactly ^C: a paste arrives in bracketed-paste sequences, so a pasted \x03 never lands here alone.
    if (d === "\x03") {
      const now = Date.now();
      if (now - lastIntr < INTR_GUARD_MS) {
        if (!warned) { // one toast per burst, or key repeat fires it continuously
          warned = true;
          toast("Ctrl+C interrupts. Use ✕ or /exit to end the session");
          dlog("info", `guarded repeat ^C · ${id.slice(0, 8)}`);
        }
        return;
      }
      lastIntr = now;
      warned = false;
    }
    invoke("write_pty", { sessionId: id, data: d });
  };
}

// Windows image paste for Claude panes. Claude binds chat:imagePaste to alt+v on native Windows and
// xterm makes Ctrl+V a dead key, so Ctrl+V is left to the browser and the paste event sends ESC v
// when an image is aboard; text falls through to xterm's own paste. xterm keeps ONE custom key
// handler per pane: a new claude key rule goes here or in `claudeInput`, never in a second handler.
export function winClaudePaste(id: string, term: Terminal, pane: HTMLElement) {
  if (!IS_WIN) return;
  term.attachCustomKeyEventHandler((e) =>
    !(e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v"));
  // Capture phase: beats xterm's textarea paste handler, so an image paste never double-fires as text.
  pane.addEventListener("paste", (e) => {
    if (!Array.from(e.clipboardData?.items ?? []).some((i) => i.type.startsWith("image/"))) return;
    e.preventDefault();
    e.stopPropagation();
    invoke("write_pty", { sessionId: id, data: "\x1bv" });
  }, true);
}

// ---------- outline anchors ----------
// The submit hook fires as you press Enter, so its marker sits in the input box while the
// REPL commits the message above it a frame later: the address is the TEXT, and that marker
// only says where to look (docs/sessions.md). The line, once found, gets a marker of its
// own, which xterm disposes as it scrolls out — how a jump is known to have expired.

const JUMP_LEAD = 2; // rows of context above the question, where the viewport can scroll at all
const SLACK = 2;     // the commit is above the cursor row, give or take a reflow since

export function markPrompt(s: Sess, id: string) {
  if (!s.term || isAlt(s.term)) return; // a screen row the next frame overwrites is not an anchor
  const marks = s.promptMarks ?? (s.promptMarks = new Map());
  const live = new Set(s.prompts.map((p) => p.id));
  for (const [k, m] of marks) if (m.isDisposed || !live.has(k)) marks.delete(k);
  const m = s.term.registerMarker(0);
  if (m) marks.set(id, m);
}

const liveMark = (s: Sess, id: string) => {
  const m = s.promptMarks?.get(id);
  return m && !m.isDisposed && m.line >= 0 ? m : null;
};

function anchorAt(s: Sess, id: string, line: number) {
  const buf = s.term!.buffer.active;
  const m = s.term!.registerMarker(line - (buf.baseY + buf.cursorY)); // the offset is from the cursor
  if (!m) return null;
  const marks = s.promptMarks ?? (s.promptMarks = new Map());
  marks.get(id)?.dispose(); // the submit hint has done its job
  marks.set(id, m);
  return m;
}

// The rows xterm wrapped into one logical line, as prose. Capped: a match needs a key's worth
// of text, not the paragraph a wall of pasted output wraps into.
const RUN_MAX = 240;
function runText(buf: Buf, y: number): string {
  let t = buf.getLine(y)?.translateToString(false) ?? "";
  for (let i = y + 1; i < buf.length && t.length < RUN_MAX; i++) {
    const l = buf.getLine(i);
    if (!l?.isWrapped) break;
    t += l.translateToString(false);
  }
  return normLine(t);
}

/**
 * The question's own line, by its text. `below` is the submit marker's: the message was
 * committed above it, so the nearest match at or above that is the one you asked, while a
 * reply quoting you back comes later. Without one (a restored prompt) the first match wins.
 */
function findPrompt(term: Terminal, k: PromptKey, below: number | null): number | null {
  const buf = term.buffer.active;
  const last = Math.min(below == null ? buf.length : below + SLACK, buf.length - 1);
  let hit: number | null = null;
  for (let y = 0; y <= last; y++) {
    if (buf.getLine(y)?.isWrapped) continue; // a continuation row belongs to the run above it
    if (!lineHasPrompt(runText(buf, y), k)) continue;
    if (below == null) return y;
    hit = y;
  }
  return hit;
}

// One search per question: a scan is the whole scrollback, and a miss stays a miss — either
// the text was never rendered as typed (a pasted block collapses to a placeholder) or it has
// gone. The submit marker is what a miss falls back to, so the row stays clickable.
function resolve(s: Sess, p: Prompt) {
  const hint = liveMark(s, p.id);
  if (p.found || p.lost || !s.term) return hint;
  for (const k of promptKeys(p.text)) { // the whole key first: the short retry is likelier to lie
    const y = findPrompt(s.term, k, hint && hint.line);
    if (y == null) continue;
    const m = anchorAt(s, p.id, y);
    if (m) { p.found = true; return m; }
  }
  p.lost = true;
  return hint;
}

/** The prompts still reachable in this pane; the rest render as out of reach. */
export function anchoredPrompts(s: Sess): Set<string> {
  const out = new Set<string>();
  if (!s.term) return out;
  // A REPL on the alternate screen keeps the conversation itself, so every question is worth
  // a click and the marker map answers for nothing.
  for (const p of s.prompts) if (isAlt(s.term) || liveMark(s, p.id)) out.add(p.id);
  return out;
}

// ---------- a REPL that owns the screen ----------
// Claude Code runs on the ALTERNATE screen (`?1049h` at startup, measured) and grabs the
// mouse with it, so there is no scrollback for xterm to scroll, `scrollToLine` moves nothing,
// and every marker is a screen row the next frame overwrites. The conversation is the TUI's,
// so the jump is asked of it in the language it is listening in (docs/sessions.md).
const isAlt = (t: Terminal) => t.buffer.active.type === "alternate";

// SGR 1006, exactly what the user's own wheel sends. Mouse bytes are not text: no REPL can
// read one as a prompt, which is what keeps this on the right side of the rule that Episko
// types at a session in only two places (CLAUDE.md).
const WHEEL_UP = 64, WHEEL_DOWN = 65;
function wheel(s: Sess, btn: number, notches: number) {
  if (!s.term) return;
  const col = Math.max(1, s.term.cols >> 1), row = Math.max(1, s.term.rows >> 1);
  invoke("write_pty", { sessionId: s.id, data: `\x1b[<${btn};${col};${row}M`.repeat(notches) });
}

const STEP0 = 4;        // the opener, until a wheel has been measured
const STEP_MAX = 40;
const TARGET = 0.66;    // of a screen per step: quick, and still too short to step over a hit
const HUNT_STEPS = 120;
const BUDGET_MS = 6000; // a jump is a click, not an errand
const SAY_MS = 700;     // before a hunt is worth saying out loud
const FRAME_MS = 200;   // no change for this long is the top, not a redraw still on its way
const SNAP = 40, SNAP_ROUNDS = 8; // notches, and rounds of them, to reach the live end

const onScreen = (t: Terminal, keys: PromptKey[]) => {
  for (const k of keys) { const y = findPrompt(t, k, null); if (y != null) return y; }
  return null;
};

function screenRows(t: Terminal): string[] {
  const b = t.buffer.active, out: string[] = [];
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? "");
  return out;
}

// The redraw itself, rather than a delay long enough to cover the worst one: resolves on the
// first write that CHANGED the screen, or after FRAME_MS of none. A write is not a redraw —
// the footer's clock lands first and read as "the top of the conversation" the first time.
const SETTLE_MS = 16; // a frame written in two chunks
function frame(t: Terminal, before: string[]): Promise<string[]> {
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (done) return; done = true; d.dispose(); clearTimeout(tid); res(screenRows(t)); };
    const tid = setTimeout(finish, FRAME_MS);
    const d = t.onWriteParsed(() => { if (screenShift(before, screenRows(t)) !== 0) setTimeout(finish, SETTLE_MS); });
  });
}

// A wheel notch is worth what this REPL says it is worth, so the first step measures it and
// the rest are paced to two thirds of a screen. Nothing is assumed: an unreadable shift keeps
// the conservative step, which is only slow, never wrong.
const pace = (step: number, moved: number, rows: number) =>
  Math.max(STEP0, Math.min(STEP_MAX, Math.round((step * rows * TARGET) / moved)));

async function snapToEnd(s: Sess) {
  for (let i = 0; i < SNAP_ROUNDS; i++) {
    const before = screenRows(s.term!);
    wheel(s, WHEEL_DOWN, SNAP);
    if (screenShift(before, await frame(s.term!, before)) === 0) return; // nothing moved: already there
  }
}

/**
 * On screen already? Then nothing moves: yanking the view to the bottom first would undo the
 * reading you are in. Otherwise from the live end — the view may be parked where the last
 * jump left it, and a hunt that only walks up would never reach a question below that.
 */
async function hunt(s: Sess, keys: PromptKey[]): Promise<number | null> {
  const t = s.term!;
  const here = onScreen(t, keys);
  if (here != null) return here;
  await snapToEnd(s);
  const t0 = Date.now();
  let step = STEP0, up = 0, said = false, rows = screenRows(t);
  for (let i = 0; i < HUNT_STEPS && Date.now() - t0 < BUDGET_MS; i++) {
    const y = onScreen(t, keys);
    if (y != null) return y;
    if (!said && Date.now() - t0 > SAY_MS) { said = true; toast("Looking back through the conversation…"); }
    wheel(s, WHEEL_UP, step);
    up += step;
    const next = await frame(t, rows);
    const moved = screenShift(rows, next);
    if (moved === 0) break; // a wheel that changes nothing is the top of the conversation
    if (moved) step = pace(step, moved, t.rows);
    rows = next;
  }
  wheel(s, WHEEL_DOWN, up + step); // a hunt that failed must not also lose your place
  return null;
}

let hunting = false;
async function huntFor(s: Sess, p: Prompt): Promise<JumpResult> {
  const keys = promptKeys(p.text);
  if (hunting || !keys.length) return "unfound"; // one at a time: two hunts scroll each other
  hunting = true;
  try {
    const y = await hunt(s, keys);
    if (y != null) { try { flashLine(s.term!, y); } catch { /* renderer between frames */ } }
    dlog("info", `outline hunt · ${p.id} · ${y == null ? "not found" : `row ${y}`}`);
    return y == null ? "unfound" : "ok";
  } finally { hunting = false; }
}

// The line is marked whether or not the viewport moved: `scrollToLine` clamps at `ybase`, so a
// question already on screen scrolls nowhere and the click reads as dead (docs/sessions.md).
// A selection, not `registerDecoration`: that is proposed API and throws without
// `allowProposedApi`. This one is stable and every renderer draws it.
const FLASH_MS = 1600;
let flash: number | undefined;
function flashLine(term: Terminal, line: number) {
  clearTimeout(flash);
  const buf = term.buffer.active;
  let end = line; // a question wrapped over three rows is three rows of answer
  while (end + 1 < buf.length && buf.getLine(end + 1)?.isWrapped) end++;
  term.selectLines(line, end);
  const ours = JSON.stringify(term.getSelectionPosition() ?? null);
  // Only clear what we made: by now the pointer may have selected something to copy.
  flash = window.setTimeout(() => {
    if (JSON.stringify(term.getSelectionPosition() ?? null) === ours) term.clearSelection();
  }, FLASH_MS);
}

/** `gone` is the pane's answer, `unfound` the TUI's: one has lost the line, the other looked. */
export type JumpResult = "ok" | "gone" | "unfound";

export async function scrollToPrompt(s: Sess, id: string): Promise<JumpResult> {
  const p = s.prompts.find((x) => x.id === id);
  if (!s.term || !p) return "gone";
  if (isAlt(s.term)) return huntFor(s, p);
  const m = resolve(s, p);
  if (!m) return "gone";
  const before = s.term.buffer.active.viewportY;
  s.term.scrollToLine(Math.max(0, m.line - JUMP_LEAD));
  // Never let the marking take the navigation down with it, whatever the renderer is doing.
  try { flashLine(s.term, m.line); } catch (e) { dlog("warn", `outline: could not mark the line (${e})`); }
  // One line per click, and the one that would have answered "why did nothing happen".
  dlog("info", `outline jump · line ${m.line} · ${p.found ? "matched" : "marker only"}`
    + ` · view ${before} → ${s.term.buffer.active.viewportY}`);
  return "ok";
}

// ---------- clickable links ----------
// The one surface where a path or URL is only text (the Context card cannot see what Bash did), so
// wired on every pane. OSC 8 goes to `options.linkHandler` and stays http(s)-only, since a program
// chooses that URI; plain text goes to a link provider: ./termlinks proposes, disk decides.

// The joined rows as one string; `cells[i]` is the buffer cell of `text[i]`.
interface JoinedRow { text: string; cells: { x: number; y: number }[] }
// Structural: xterm does not re-export `ILink` from the package root.
interface TermLink {
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  text: string;
  activate: () => void;
}
type Buf = Terminal["buffer"]["active"];

const MAX_JOIN = 4000; // past this the joined text is a paragraph, and every hover walks it
// Two, not one: an agent breaks a long path at its own spaces, so a path with two spaces spans three
// rows, and from the middle one a single run reaches only one end.
const EXTRA_RUNS = 2;
// Hover answers; the same row is re-asked on every re-entry. Cleared wholesale: a miss is one stat sweep.
const RESOLVED_MAX = 300;
const resolved = new Map<string, [number, string] | null>();

const runStart = (buf: Buf, y: number): number => { while (y > 0 && buf.getLine(y)?.isWrapped) y--; return y; };
const runEnd = (buf: Buf, y: number): number => { while (y + 1 < buf.length && buf.getLine(y + 1)?.isWrapped) y++; return y; };

// The hovered row's wrap-run plus `EXTRA_RUNS` either side, as one string. Rows xterm wrapped join
// with nothing between them; a hard break (the agent broke the path at a space) joins with ONE space,
// since the row's padding is an artifact of the window and the path on disk has a single space there.
// Over-joining is safe: a candidate spanning unrelated lines never resolves, so it is never underlined.
function joinRows(term: Terminal, y: number): JoinedRow {
  const buf = term.buffer.active;
  let first = runStart(buf, y);
  for (let n = 0; n < EXTRA_RUNS && first > 0; n++) first = runStart(buf, first - 1);
  let last = runEnd(buf, y);
  for (let n = 0; n < EXTRA_RUNS && last + 1 < buf.length; n++) last = runEnd(buf, last + 1);
  const text: string[] = [];
  const cells: { x: number; y: number }[] = [];
  const cell = buf.getNullCell();
  for (let ly = first; ly <= last && cells.length < MAX_JOIN; ly++) {
    // Hard break: one space. Never a candidate endpoint (`\S+` runs), so its cell is only passed over.
    if (ly > first && !buf.getLine(ly)?.isWrapped) {
      text.push(" ");
      cells.push(cells[cells.length - 1] ?? { x: 0, y: ly });
    }
    const line = buf.getLine(ly);
    if (!line) continue;
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue; // right half of a wide glyph, already counted
      const ch = cell.getChars() || " ";
      // One `cells` entry per UTF-16 unit keeps `text` and `cells` index-aligned across surrogate pairs.
      for (let i = 0; i < ch.length; i++) cells.push({ x, y: ly });
      text.push(ch);
    }
    // Drop the row's trailing blanks, so the hard-break space above is the whole gap.
    while (text.length && text[text.length - 1] === " " && cells[cells.length - 1].y === ly) {
      text.pop();
      cells.pop();
    }
  }
  return { text: text.join(""), cells };
}

// `[start, end)` in the joined string → the 1-based buffer range xterm underlines.
function mkRange(row: JoinedRow, start: number, end: number): TermLink["range"] | null {
  const a = row.cells[start];
  const b = row.cells[Math.min(end, row.cells.length) - 1];
  if (!a || !b) return null;
  return { start: { x: a.x + 1, y: a.y + 1 }, end: { x: b.x + 1, y: b.y + 1 } };
}

// Where each pane's process is now. A shell's `Sess.workdir` says nothing after a `cd`, so the live cwd
// is asked and goes first among the bases; a short TTL rather than events, since nothing reports a `cd`.
const CWD_TTL_MS = 3000;
const cwds = new Map<string, { at: number; dir: string }>();
async function liveCwd(id: string): Promise<string> {
  const hit = cwds.get(id);
  if (hit && Date.now() - hit.at < CWD_TTL_MS) return hit.dir;
  let dir = "";
  try { dir = (await invoke<string | null>("session_cwd", { sessionId: id })) ?? ""; }
  catch { /* the pane exited between the hover and the ask */ }
  cwds.set(id, { at: Date.now(), dir });
  return dir;
}

// Ask disk which proposal is real; cached against the bases, since the file set grows as the session works.
async function resolvePath(s: Sess | undefined, cands: PathCand[]): Promise<{ abs: string; end: number } | null> {
  // Most authoritative first: live cwd, drift dir, launch dir. `linkBases` drops empties and duplicates.
  const dirs = s ? [await liveCwd(s.id), s.drift?.dir ?? "", s.workdir] : [];
  const bases = linkBases(dirs, (s?.files ?? []).map((f) => f.path));
  if (!bases.length) return null;
  const texts = cands.map((c) => c.text);
  const key = `${bases.join("\u0002")}\u0000${texts.join("\u0001")}`;
  let hit = resolved.get(key);
  if (hit === undefined) {
    try { hit = await invoke<[number, string] | null>("resolve_link_path", { bases, cands: texts }); }
    catch (e) { dlog("warn", `resolve_link_path failed: ${e}`); hit = null; }
    if (resolved.size > RESOLVED_MAX) resolved.clear();
    resolved.set(key, hit);
    // Once per line (the miss is cached); the bases are what answer "that is a file, why is it not blue?".
    if (!hit) dlog("info", `link: nothing on disk for "${texts[texts.length - 1] ?? ""}" · ${bases.length} base(s), first ${bases[0] ?? "none"}`);
  }
  if (!hit) return null;
  const cand = cands[hit[0]];
  return cand ? { abs: hit[1], end: cand.end } : null;
}

async function openHref(url: string) {
  // OSC 8 payloads are program-chosen; http(s)-only here as well as via `allowNonHttpProtocols`.
  if (!/^https?:\/\//i.test(url)) { dlog("warn", `link ignored · not http(s) · ${url.slice(0, 80)}`); return; }
  try { await openUrl(url); }
  catch (e) { toast("Couldn't open the link: " + e); }
}

// A copy of ./actions' `openTouchedFile`, since ./actions imports this module; the error is surfaced.
async function openFilePath(path: string) {
  try { await invoke("open_file", { path }); }
  catch (e) { toast(String(e)); }
}

async function provide(id: string, term: Terminal, y: number, cb: (links: TermLink[] | undefined) => void) {
  const row = joinRows(term, y - 1); // provideLinks counts rows 1-based; the buffer does not
  const hits = row.text.trim() ? findLinks(row.text) : [];
  if (!hits.length) { cb(undefined); return; }
  const s = sessions.get(id);
  const out: TermLink[] = [];
  // ./termlinks proposes overlapping candidates and only disk says how far a path reaches; two links
  // over the same cells would let xterm pick either, so a clash is settled after resolution: first wins.
  const taken: [number, number][] = [];
  const claim = (a: number, b: number) => {
    if (taken.some(([x, y]) => a < y && x < b)) return false;
    taken.push([a, b]);
    return true;
  };
  for (const h of hits) {
    if (h.kind === "url") {
      const range = claim(h.start, h.end) ? mkRange(row, h.start, h.end) : null;
      if (range) out.push({ range, text: h.text, activate: () => { void openHref(h.text); } });
      continue;
    }
    const won = await resolvePath(s, h.cands);
    if (!won || !claim(h.start, won.end)) continue;
    const range = mkRange(row, h.start, won.end);
    if (range) out.push({ range, text: won.abs, activate: () => { void openFilePath(won.abs); } });
  }
  cb(out.length ? out : undefined);
}

// Called by every spawner after `term.open`; xterm keeps every link provider, so this composes.
export function wireLinks(id: string, term: Terminal) {
  term.options.linkHandler = { activate: (_e, text) => { void openHref(text); } };
  term.registerLinkProvider({ provideLinks: (y, cb) => { void provide(id, term, y, cb); } });
}

// Fit, push the size to the PTY, and force a full repaint: on resize the WebGL renderer redraws only
// damage-flagged cells, so a cell gone glyph→blank keeps a ghost until refresh() re-rasterizes the rows.
// Active pane only: an inactive one is display:none, so fit() would resize the PTY to garbage.
export function fitSession(s: Sess) {
  if (!s.term || !s.fit) return;
  try {
    s.fit.fit();
    invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols });
    s.term.refresh(0, s.term.rows - 1);
  } catch { /* pane not measurable yet */ }
}
// Everything the stage shows: a tiled run group is several panes, and a window resize reflows them all.
export function refit() {
  if (stageGroup) {
    for (const s of sessions.values()) if (s.run?.groupId === stageGroup) fitSession(s);
    return;
  }
  if (!activeId) return;
  const s = sessions.get(activeId);
  if (s) fitSession(s);
}
export function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
export function bumpFont(d: number) { setTermFontSize(Math.max(8, Math.min(28, termFontSize + d))); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }

// The WebGL renderer bakes a glyph atlas on first paint; if the bundled Nerd Font is not ready it caches
// tofu for the icon glyphs and never repaints. Force the load, then drop every open terminal's atlas.
void (async () => {
  try {
    await Promise.all([
      document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font"`),
      document.fonts.load(`bold ${termFontSize}px "JetBrainsMono Nerd Font"`),
    ]);
    await document.fonts.ready;
  } catch { /* no Font Loading API; the @font-face still applies */ }
  for (const s of sessions.values()) s.term?.clearTextureAtlas();
  // A pane opened before the font arrived measured its cells against fallback metrics, so its PTY width
  // is slightly off; re-fit now that the real ones are in.
  refit();
})();
