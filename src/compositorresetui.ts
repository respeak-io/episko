// Hides the webview for a moment so Chromium resets its frame bookkeeping (./compositorreset has the
// why and the when). Windows only: WKWebView and WebKitGTK have no such compositor.

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { setWindowFocused } from "./actions";
import { dlog } from "./debug";
import { IS_TAURI, IS_WIN } from "./dom";
import { resetDue } from "./compositorreset";
import { winFocused } from "./state";

export const compositorResetSupported = IS_TAURI && IS_WIN;

const TICK_MS = 30_000;
const HIDDEN_TIMEOUT_MS = 1000; // only a guard: the page normally reports hidden within 100 ms

let running = false;
let lastResetAt: number | null = null;

// A blank window is far worse than a slow one, so a failed show gets a second try.
async function showAgain() {
  const wv = getCurrentWebview();
  try {
    await wv.show();
  } catch (e) {
    dlog("warn", `compositor reset: show failed, retrying (${e})`);
    await new Promise((r) => setTimeout(r, 250));
    await wv.show().catch((e2) => dlog("error", `compositor reset: show failed twice (${e2})`));
  }
}

export async function resetCompositor(): Promise<void> {
  if (!compositorResetSupported || running) return;
  running = true;
  const t0 = performance.now();
  let hiddenAfter = -1;
  try {
    // Waiting for the page's own event replaces a guessed delay: show no sooner than the hide landed.
    const hidden = new Promise<void>((res) => {
      const done = () => { document.removeEventListener("visibilitychange", done); res(); };
      document.addEventListener("visibilitychange", done);
      setTimeout(done, HIDDEN_TIMEOUT_MS);
    });
    await getCurrentWebview().hide();
    await hidden;
    hiddenAfter = Math.round(performance.now() - t0);
  } catch (e) {
    dlog("warn", `compositor reset: hide failed (${e})`);
  } finally {
    await showAgain();
    lastResetAt = Date.now();
    running = false;
  }
  // main.ts took "hidden" as focus lost and nothing says it back, and hiding the webview takes the
  // keyboard from it, which matters when this came from the Settings button.
  try {
    const focused = await getCurrentWindow().isFocused();
    setWindowFocused(focused);
    if (focused) await getCurrentWebview().setFocus();
  } catch (e) {
    dlog("warn", `compositor reset: could not restore focus (${e})`);
  }
  dlog("info", `compositor reset · hidden after ${hiddenAfter} ms, back after ${Math.round(performance.now() - t0)} ms`);
}

export function initCompositorReset() {
  if (!compositorResetSupported) return;
  let unfocusedSince: number | null = null;
  setInterval(() => {
    const now = Date.now();
    unfocusedSince = winFocused ? null : (unfocusedSince ?? now);
    if (resetDue({ now, unfocusedSince, lastResetAt })) void resetCompositor();
  }, TICK_MS);
}
