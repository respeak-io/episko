// The xterm side of a pane: creating a terminal, sizing it, and the two small
// translations between what Claude Code sends and what the UI wants.
//
// Everything here is shared by all three spawners (`spawn_claude`, `spawn_shell`,
// `spawn_task`), which is why it sits below them rather than inside any one — a font
// stack copied per spawner, or a second `fitSession`, is a drift bug waiting to
// happen. Nothing here reaches upward, so it needs no hook.
//
// Two rules worth not rediscovering: `fitSession` must only ever run on the *active*
// pane (an inactive one is display:none, so fit() would measure a zero-size box and
// resize the PTY to garbage), and the font atlas has to be dropped once the bundled
// Nerd Font arrives — the WebGL renderer bakes tofu boxes into it otherwise.

import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { toast } from "./dom";
import { basename, tilde } from "./format";
import type { Sess } from "./types";
import { activeId, sessions, setTermFontSize, termFontSize } from "./state";

// Leads with the bundled Nerd Font (see @font-face in styles.css) so the terminal
// draws powerline / devicon glyphs on every OS; the rest stay as graceful fallbacks.
export const MONO = '"JetBrainsMono Nerd Font", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace';

export function loadWebgl(term: Terminal) {
  try {
    const w = new WebglAddon();
    w.onContextLoss(() => w.dispose()); // fall back to the DOM renderer
    term.loadAddon(w);
  } catch { /* WebGL unavailable — DOM renderer is fine */ }
}

// macOS terminal key conventions for the embedded shell. xterm.js emits xterm's
// modified-arrow sequences (Option+Left = \e[1;3D etc.), which a plain login zsh
// doesn't bind by default — so word-nav keys self-insert garbage like ";3D".
// Terminal.app instead maps them to the Meta/emacs sequences zsh binds out of the
// box; we do the same here so the embedded shell navigates like a normal terminal.
// Only plain-shell PTYs get this (Claude's REPL handles its own key input).
export function macShellKeys(id: string): (e: KeyboardEvent) => boolean {
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

// Fit one terminal to its pane, push the new size to its PTY, and force a full
// repaint. The repaint is not cosmetic: on a resize the WebGL renderer only redraws
// cells its damage tracker flagged, so a cell that went glyph→blank can keep a stale
// glyph in the GL framebuffer (the "floating chars" past a shrunk table). refresh()
// re-rasterizes every visible row straight from the buffer, clearing those ghosts.
// Only ever call this on the *active* pane — an inactive one is display:none, so
// fit() would measure a zero-size box and resize the PTY to garbage.
export function fitSession(s: Sess) {
  if (!s.term || !s.fit) return;
  try {
    s.fit.fit();
    invoke("resize_pty", { sessionId: s.id, rows: s.term.rows, cols: s.term.cols });
    s.term.refresh(0, s.term.rows - 1);
  } catch { /* pane not measurable yet */ }
}
export function refit() { if (!activeId) return; const s = sessions.get(activeId); if (s) fitSession(s); }
export function applyFontSize() { for (const s of sessions.values()) if (s.term) s.term.options.fontSize = termFontSize; refit(); localStorage.setItem("cc-term-font", String(termFontSize)); }
export function bumpFont(d: number) { setTermFontSize(Math.max(8, Math.min(28, termFontSize + d))); applyFontSize(); toast(`Terminal font ${termFontSize}px`); }

// Claude prepends an animated spinner to its OSC title: it cycles through braille
// dots (U+2800-U+28FF) and an eight-spoked asterisk (U+2733), e.g. a braille dot or
// a star before "Fixing the bug". Strip any leading run of those so the sidebar
// shows a steady summary; our own status stays in the row's colored .sglyph column.
// Missing the braille range is what left the title glyph flickering. (CC 2.x OSC.)
const TITLE_DECOR = /^(?:[\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿\uFE0F\u200D]|\u{1F31F})+/u;
// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
// just the folder path/name (which we already show).
export function cleanTitle(t: string, s: Sess): string {
  const x = (t || "").replace(TITLE_DECOR, "").trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

// The WebGL/canvas renderer bakes a glyph texture atlas on first paint. If the
// bundled Nerd Font (font-display:block) isn't ready yet, that atlas caches tofu
// boxes for the icon glyphs and never repaints them on its own. So force the font
// to load, then drop every open terminal's atlas once it's ready — the next frame
// re-rasterizes with real glyphs. Terminals opened after this point are already fine.
void (async () => {
  try {
    await Promise.all([
      document.fonts.load(`${termFontSize}px "JetBrainsMono Nerd Font"`),
      document.fonts.load(`bold ${termFontSize}px "JetBrainsMono Nerd Font"`),
    ]);
    await document.fonts.ready;
  } catch { /* Font Loading API unavailable — the browser still applies the @font-face */ }
  for (const s of sessions.values()) s.term?.clearTextureAtlas();
  // A session opened before the font arrived had its cell width measured against
  // the *fallback* metrics, so its column count (and the size we spawned Claude at)
  // is slightly off and stays off until the next resize. Re-fit now that the real
  // font's metrics are in, so the PTY width matches what we actually render.
  refit();
})();
