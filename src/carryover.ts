// What an update's restart brings back: the agent sessions that were running when it was
// installed. Shelved ones stay shelved. ./update writes the mark; the boot after spends it
// (docs/sessions.md § Restorable sessions).

import { safeParse } from "./store";

export const CARRY_KEY = "cc-update-resume";
/** Past this the restart it was written for has come and gone; the rows wait on the shelf. */
export const CARRY_TTL = 6 * 3600_000;
/** Between two resumes, so a fleet does not start a dozen agents in the same instant. */
export const CARRY_GAP_MS = 400;

/** `ids` are roster ids (`Restorable.id`), which is what the boot's dormant rows are keyed by. */
export interface CarryMark { from: string; ids: string[]; active: string | null; at: number }
export interface CarryPane { id: string; resumable: boolean }

/** Null when nothing would come back, so no mark is left for a boot to puzzle over. */
export function carryMark(panes: readonly CarryPane[], active: string | null, from: string, now: number): CarryMark | null {
  const ids = [...new Set(panes.filter((p) => p.resumable).map((p) => p.id))];
  if (!ids.length) return null;
  return { from, ids, active: active && ids.includes(active) ? active : null, at: now };
}

/** The ids to resume, in launch order. Each launch takes the stage, so the active one goes last. */
export function carryDue(raw: string | null, version: string, now: number): string[] {
  const m = safeParse<CarryMark>(raw);
  if (!m || typeof m.from !== "string" || typeof m.at !== "number" || !Array.isArray(m.ids)) return [];
  if (m.from === version) return []; // the install never happened
  if (now - m.at > CARRY_TTL || m.at - now > 60_000) return [];
  const ids = [...new Set(m.ids.filter((i): i is string => typeof i === "string" && !!i))];
  const active = typeof m.active === "string" && ids.includes(m.active) ? m.active : null;
  return active ? [...ids.filter((i) => i !== active), active] : ids;
}

/** The confirmation's middle: what comes back, what stops mid-turn, what closes for good. */
export function carryText(back: number, busy: number, closing: number): string {
  const parts: string[] = [];
  if (back === 1) parts.push("The running session comes back by itself afterwards, with its conversation.");
  else if (back) parts.push(`The ${back} running sessions come back by themselves afterwards, with their conversations.`);
  if (busy === 1) parts.push(back === 1 ? "It is mid-turn: that turn stops, and it waits for you rather than carrying on."
    : "One is mid-turn: that turn stops, and the session waits for you rather than carrying on.");
  else if (busy) parts.push(`${busy} are mid-turn: those turns stop, and the sessions wait for you rather than carrying on.`);
  const body = parts.join(" ");
  if (!closing) return body;
  const rest = closing === 1 ? "1 other pane (a terminal, a task or an agent that cannot resume) closes for good."
    : `${closing} other panes (terminals, tasks, agents that cannot resume) close for good.`;
  return body ? `${body}\n\n${rest}` : rest;
}
