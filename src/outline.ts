// The conversation outline: the prompts you sent, listed as anchors back into the pane's
// scrollback. Rules only — ./terminal owns the anchors and ./inspectorview draws the rows.
// In memory only, like a tool payload: a prompt is conversation and never reaches storage.

import type { Prompt } from "./types";

export interface OutlinePrefs {
  enabled: boolean;
  // Rendered lines a folded row shows. The fold is CSS line-clamp, so a wrapped one-liner
  // and a five-line prompt cost the same height, which is what the rail's width needs.
  lines: number;
  hover: boolean; // resting on a row unfolds it
}

export const OUTLINE_DEFAULTS: OutlinePrefs = { enabled: true, lines: 3, hover: true };
export const OUTLINE_LINES = [1, 2, 3, 5];
export const OUTLINE_SHOW = 6; // rows before the list folds; the rest are one click away

export function clampOutlinePrefs(p: Partial<OutlinePrefs> | null | undefined): OutlinePrefs {
  const lines = Number(p?.lines);
  return {
    enabled: p?.enabled !== false,
    lines: OUTLINE_LINES.includes(lines) ? lines : OUTLINE_DEFAULTS.lines,
    hover: p?.hover !== false,
  };
}

// A memory bound, not a display one: a pane's scrollback runs out long before this, and a
// row whose anchor has gone is still worth reading.
export const PROMPT_CAP = 200;
const TEXT_CAP = 4000; // as ./toolio caps a payload, and for the same reason

export function cleanPrompt(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const t = raw.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + "…" : t;
}

/** The single line a tooltip or a folded row falls back to. */
export function promptLabel(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first.length > 120 ? first.slice(0, 120) + "…" : first;
}

let seq = 0;
// Guards a resend of one submit (Codex reports a message twice, started and completed),
// never asking the same thing twice on purpose: a repeat a turn later is its own entry.
const REPEAT_MS = 1500;

/** Returns the entry so the caller can anchor it; null when there is nothing to list. */
export function notePrompt(list: Prompt[], raw: unknown, now: number): Prompt | null {
  const text = cleanPrompt(raw);
  if (!text) return null;
  const last = list[list.length - 1];
  if (last && last.text === text && now - last.at < REPEAT_MS) return null;
  const p: Prompt = { id: `p${++seq}`, text, at: now };
  list.push(p);
  if (list.length > PROMPT_CAP) list.splice(0, list.length - PROMPT_CAP);
  return p;
}

// SessionStart fires for all four; only `clear` starts an empty conversation on a cleared
// screen. /compact and /resume carry on, and their prompts are still up in the scrollback.
export const clearsOutline = (source: unknown): boolean => String(source ?? "") === "clear";
