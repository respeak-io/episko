// When to reset the webview's compositor. Chromium's cc keeps a FrameSequenceTracker per finished
// animation until its frame is accounted for and walks that list every frame; in a webview open for a
// day or more the walk alone can outrun the frame budget, so hover lags while JS and the DOM look fine.
// Hiding resets cc::FrameSorter (LayerTreeHostImpl::SetVisible). Chrome tabs get that for free; a
// WebView2 page only when its host asks, and wry doesn't. No DOM here; ./compositorresetui does it.

// Unfocused this long first, so a quick Alt-Tab never flashes the window.
export const RESET_QUIET_MS = 60_000;
// And no more often than this: the window may well still be on screen, on another monitor.
export const RESET_EVERY_MS = 15 * 60_000;

export interface ResetClock {
  now: number;
  unfocusedSince: number | null; // null while the window has focus
  lastResetAt: number | null;
}

export function resetDue({ now, unfocusedSince, lastResetAt }: ResetClock): boolean {
  if (unfocusedSince === null || now - unfocusedSince < RESET_QUIET_MS) return false;
  return lastResetAt === null || now - lastResetAt >= RESET_EVERY_MS;
}
