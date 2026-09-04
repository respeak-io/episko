// The menu-bar (tray) mirror of the sidebar: the most-urgent state as title, the count as tooltip,
// one item per pane. Native, so a repaint is an IPC call; it diffs a signature and returns early.

import { invoke } from "@tauri-apps/api/core";
import { hasSessionState, isAgent, phaseText, statusKey, type Sess } from "./types";
import { needsYouSessions, projectList, reactorLabel, reactorState } from "./grouping";
import { GCLASS, GLYPH } from "./sidebarview";
import { dlog } from "./debug";

type TrayRow =
  | { kind: "session"; id: string; label: string; shape: string; rgb: [number, number, number] }
  | { kind: "header"; label: string }
  | { kind: "sep" };

// GLYPH's vocabulary as shapes icons.rs can rasterise, keyed by `statusKey`. Every status in
// GLYPH must be here too; a missing one falls back to the disc.
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

// styles.css owns the status hues (`g-ended` differs per theme), so read the colour off the
// class rather than restate it. Cached per theme.
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

// A shell or agent pane is not a phase: `chevron`/`dchevron` mirror sidebarview's `❯`/`»`,
// and the two tables must change together or the tray disagrees with the rail beside it.
function rowIcon(s: Sess): { shape: string; cls: string } {
  const k = statusKey(s);
  const bare = s.kind === "shell" ? "chevron" : isAgent(s) && !hasSessionState(s) ? "dchevron" : "";
  if (bare) {
    return s.phase === "ended" ? { shape: SHAPE.ended, cls: GCLASS.ended } : { shape: bare, cls: "g-idle" };
  }
  return { shape: SHAPE[k] ?? "disc", cls: GCLASS[k] ?? "g-idle" };
}

const DESC_MAX = 44; // a menu sizes itself to its widest row, so this is the menu's width policy
function clip(t: string): string {
  const x = t.replace(/\s+/g, " ").trim(); // a stray newline would wrap the native item
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
      const desc = clip(s.title) || branch; // the OSC title names the work; four panes on `main` read alike
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
  // Shape and colour are in the signature: a phase change with the same wording must still repaint.
  const sig = title + "|" + tooltip + "|" + rows.map((r) =>
    r.kind === "session" ? `s${r.id}${r.label}${r.shape}${r.rgb.join()}` : r.kind === "header" ? `h${r.label}` : "-",
  ).join("§");
  if (sig === lastTraySig) return; // avoid rebuilding the native menu on every telemetry tick
  lastTraySig = sig;
  // Not swallowed: `items` is a serde tagged union, so a row shape drifting from lib.rs's
  // `TrayRow` is rejected whole, and the banked signature would otherwise hide that forever.
  invoke("update_tray", { title, tooltip, items: rows }).catch((e) => {
    lastTraySig = ""; // let the next event retry rather than sit on a menu that never landed
    dlog("warn", `update_tray rejected: ${e}`);
  });
}
