// The macOS menu-bar (tray) mirror of the sidebar: the fleet's most-urgent state as a
// title, its session count as a tooltip, and one menu item per pane so a session can
// be brought to the stage from outside the window.
//
// Unlike every other render surface this one is *native*, so a repaint is an IPC call
// and a menu rebuild rather than an innerHTML assignment. renderAll() calls it on
// every telemetry event, so it diffs a signature of what it would draw and returns
// early when nothing changed — the same guarded-invoke pattern reconcileCaf uses.

import { invoke } from "@tauri-apps/api/core";
import { PILL_TEXT, statusKey } from "./types";
import { needsYouSessions, orderedSessions, reactorLabel, reactorState } from "./grouping";
import { GLYPH } from "./sidebarview";

let lastTraySig = "";
export function updateTray() {
  const list = orderedSessions();
  const items = list.map((s) => {
    const k = statusKey(s);
    const branch = s.worktree ? `⑃ ${s.branch}` : (s.branch || "session");
    const status = s.attention ? s.attention : PILL_TEXT[s.phase];
    return { id: s.id, label: `${GLYPH[k]}  ${s.project} · ${branch}  —  ${status}` };
  });
  const needy = needsYouSessions();
  const n = list.length;
  let title = "", tooltip = "Episko — no active sessions";
  if (n > 0) {
    if (needy.length) {
      const dom = reactorState(needy[0]);
      const c = needy.filter((s) => reactorState(s) === dom).length;
      title = `${GLYPH[dom]} ${c}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}, ${reactorLabel(dom, c)}`;
    } else {
      title = `● ${n}`;
      tooltip = `Episko — ${n} session${n === 1 ? "" : "s"}`;
    }
  }
  const sig = title + "|" + tooltip + "|" + items.map((i) => i.label).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  invoke("update_tray", { title, tooltip, items }).catch(() => {});
}
