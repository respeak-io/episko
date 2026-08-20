// The macOS menu-bar (tray) mirror of the sidebar: the fleet's most-urgent state as a
// title, its session count as a tooltip, and one menu item per pane so a session can
// be brought to the stage from outside the window.
//
// Unlike every other render surface this one is *native*, so a repaint is an IPC call
// and a menu rebuild rather than an innerHTML assignment. renderAll() calls it on
// every telemetry event, so it diffs a signature of what it would draw and returns
// early when nothing changed — the same guarded-invoke pattern reconcileCaf uses.
//
// The rows are grouped under disabled project headers, and each session's status
// rides as a coloured *icon* rather than a character. That is not decoration: a menu
// item's text is always drawn in the menu's own colour, so `◆` (waiting on you) and
// `✕` (the turn died) used to arrive the same grey as "Quit" — the two states you
// open this menu for were the two it could not show. Since the header now carries the
// project, the row label reads as the session's own summary — the OSC title Claude
// keeps updated with what the conversation is about — with the branch stepping in
// only until a title arrives: four panes on `main` all read "main — your turn", which
// names nothing.

import { invoke } from "@tauri-apps/api/core";
import { phaseText, statusKey, type Sess } from "./types";
import { needsYouSessions, projectList, reactorLabel, reactorState } from "./grouping";
import { GCLASS, GLYPH } from "./sidebarview";
import { dlog } from "./debug";

type TrayRow =
  | { kind: "session"; id: string; label: string; shape: string; rgb: [number, number, number] }
  | { kind: "header"; label: string }
  | { kind: "sep" };

// The sidebar's glyph vocabulary as shapes the backend can rasterise. Keyed by the
// same `statusKey` GLYPH is, so the two cannot drift apart silently — a status added
// to one without the other falls back to the disc rather than vanishing.
const SHAPE: Record<string, string> = {
  attention: "diamond", // ◆
  working: "disc",      // ●
  thinking: "disc",     // ●
  done: "check",        // ✓
  idle: "ring",         // ○
  error: "cross",       // ✕
  ended: "small",       // ·
  background: "half",   // ◐ — the turn is over, its agents are not
};

// Resolve a status colour by asking the *stylesheet*, not by restating it here.
// `GCLASS` names the class and `styles.css` owns the hue, so a hardcoded copy would
// be a second palette to keep in step — and `g-ended` alone already differs between
// the themes (it rides `--muted-2`), which is exactly the drift a copy would hide.
// Cached per theme; the cache is only ever filled on a rebuild, which the signature
// below makes rare.
let palTheme: string | null = null;
const palCache = new Map<string, [number, number, number]>();
function classRgb(cls: string): [number, number, number] {
  const theme = document.documentElement.dataset.theme ?? "";
  if (theme !== palTheme) { palTheme = theme; palCache.clear(); }
  const hit = palCache.get(cls);
  if (hit) return hit;
  const el = document.createElement("span");
  el.className = `sglyph ${cls}`;
  el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  document.body.appendChild(el);
  const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(getComputedStyle(el).color);
  el.remove();
  const rgb: [number, number, number] = m ? [+m[1], +m[2], +m[3]] : [140, 140, 150];
  palCache.set(cls, rgb);
  return rgb;
}

// A shell pane is not a phase, so it gets its own glyph here exactly as it does in
// the sidebar (`sidebarview.ts` line 62) — the tray used to spell every kind of pane
// with the phase vocabulary, which drew a live shell as an idle agent. An agent pane
// is the same argument again: `»` mirrors the sidebar's, and the two tables have to
// be changed together or the tray silently disagrees with the rail beside it.
function rowIcon(s: Sess): { shape: string; cls: string } {
  const k = statusKey(s);
  const bare = s.kind === "shell" ? "chevron" : s.kind === "agent" ? "dchevron" : "";
  if (bare) {
    return s.phase === "ended" ? { shape: SHAPE.ended, cls: GCLASS.ended } : { shape: bare, cls: "g-idle" };
  }
  return { shape: SHAPE[k] ?? "disc", cls: GCLASS[k] ?? "g-idle" };
}

// One line, bounded width: whitespace collapsed (a stray newline would wrap the
// native item) and cut with an ellipsis. A menu sizes itself to its widest row, so
// DESC_MAX *is* the menu's width policy — 44 keeps a full row (icon, summary,
// "— your turn") readable without one long-winded summary stretching every row.
const DESC_MAX = 44;
function clip(t: string): string {
  const x = t.replace(/\s+/g, " ").trim();
  return x.length <= DESC_MAX ? x : x.slice(0, DESC_MAX - 1).trimEnd() + "…";
}

let lastTraySig = "";
export function updateTray() {
  const groups = projectList().filter((p) => p.sessions.length);
  const rows: TrayRow[] = [];
  for (const p of groups) {
    if (rows.length) rows.push({ kind: "sep" });
    rows.push({ kind: "header", label: p.name });
    for (const s of p.sessions) {
      const branch = s.worktree ? `⑃ ${s.branch}` : (s.branch || "session");
      const desc = clip(s.title) || branch;
      const status = s.attention ? s.attention : phaseText(s);
      const { shape, cls } = rowIcon(s);
      rows.push({ kind: "session", id: s.id, label: `${desc} · ${status}`, shape, rgb: classRgb(cls) });
    }
  }
  const list = groups.flatMap((p) => p.sessions);
  const needy = needsYouSessions();
  const n = list.length;
  let title = "", tooltip = "Episko · no active sessions";
  if (n > 0) {
    if (needy.length) {
      const dom = reactorState(needy[0]);
      const c = needy.filter((s) => reactorState(s) === dom).length;
      title = `${GLYPH[dom]} ${c}`;
      tooltip = `Episko · ${n} session${n === 1 ? "" : "s"}, ${reactorLabel(dom, c)}`;
    } else {
      title = `● ${n}`;
      tooltip = `Episko · ${n} session${n === 1 ? "" : "s"}`;
    }
  }
  // The icons are part of what is drawn, so shape and colour belong in the signature
  // — without them a session changing phase without changing its wording (idle → an
  // ended shell, say) would leave a stale glyph in the menu.
  const sig = title + "|" + tooltip + "|" + rows.map((r) =>
    r.kind === "session" ? `s${r.id}${r.label}${r.shape}${r.rgb.join()}` : r.kind === "header" ? `h${r.label}` : "-",
  ).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  // Not swallowed: `items` is a tagged union deserialized by serde, so a row shape
  // that drifts from `TrayRow` in lib.rs is rejected whole — and the only symptom
  // would be a menu that silently stopped updating, since the signature above has
  // already been banked. Failing that quietly is how `gh_claim` shipped broken for
  // three releases.
  invoke("update_tray", { title, tooltip, items: rows }).catch((e) => {
    lastTraySig = ""; // let the next event retry rather than sit on a menu that never landed
    dlog("warn", `update_tray rejected: ${e}`);
  });
}
