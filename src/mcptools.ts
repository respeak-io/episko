// What the Episko MCP tools say back to an agent: which runnables it may start, the inputs
// it must supply, and a run's output folded to what a terminal would have left on screen.
// ./mcp drives it; docs/mcp.md.

import { applyInputs, execCmd } from "./tasks";
import type { InputSpec, Runnable } from "./types";
import type { Stack } from "./stack";

/** Output kept per run, from the end: a test failure's summary is at the bottom. */
export const OUTPUT_CAP = 16_000;
export const WAIT_DEFAULT_S = 600;
export const WAIT_UP_S = 60; // a server or app answers once it is up, so its wait is for coming up, not exiting
export const WAIT_MAX_S = 1800;

export function waitSeconds(v: unknown, long = false): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : long ? WAIT_UP_S : WAIT_DEFAULT_S;
  return Math.min(WAIT_MAX_S, Math.max(0, n));
}

// Answered once it is up rather than once it exits: what never exits, and a compound (its servers).
export const runsOn = (r: Runnable): boolean => r.background || r.compound;

/** Why an agent may not start this one, or "" if it may. Only what cannot run at all. */
export function refuseRun(r: Runnable): string {
  return r.blocked ? `${r.id} can't run: ${r.blocked}` : "";
}

/** Fill a task's inputs: the agent's value, else what the user typed last, else the default. */
export function fillInputs(
  r: Runnable, given: unknown, remembered: (inputId: string) => string | undefined,
): { ready: Runnable } | { missing: InputSpec[] } {
  const from = given && typeof given === "object" ? given as Record<string, unknown> : {};
  const vals: Record<string, string> = {};
  const missing: InputSpec[] = [];
  for (const i of r.inputs) {
    const own = typeof from[i.id] === "string" ? from[i.id] as string : undefined;
    const v = own ?? (i.password ? undefined : remembered(i.id)) ?? i.default ?? (i.optional ? "" : undefined);
    if (v === undefined) missing.push(i);
    else vals[i.id] = v;
  }
  return missing.length ? { missing } : { ready: r.inputs.length ? applyInputs(r, vals) : r };
}

export function missingText(r: Runnable, missing: InputSpec[]): string {
  const rows = missing.map((i) => `- ${i.id}: ${i.description || "(no description)"}${i.options.length ? ` (one of: ${i.options.join(", ")})` : ""}`);
  return `${r.id} needs inputs nobody has answered yet. Pass them as \`inputs\`:\n${rows.join("\n")}`;
}

export function runnablesText(rs: Runnable[]): string {
  if (!rs.length) return "This project defines no runnable tasks Episko can see.";
  const rows = rs.map((r) => {
    const tags = [
      r.kind ?? (r.background ? "long-running" : r.group), r.compound && "runs other tasks",
      r.described === "stale" && "description out of date", r.note,
      r.inputs.length && `inputs: ${r.inputs.map((i) => i.id).join(", ")}`,
      r.blocked && `blocked: ${r.blocked}`,
    ].filter(Boolean);
    const what = r.compound ? r.dependsOn.join(" + ") : execCmd(r);
    return `- ${r.id} · ${what}${tags.length ? ` [${tags.join("; ")}]` : ""}`;
  });
  return `Runnable tasks (pass the id to run_task):\n${rows.join("\n")}`;
}

// CSI, OSC (BEL- or ST-terminated) and the two-byte escapes a TUI emits for charset and keypad.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g;

/**
 * Append a chunk the way a terminal would leave it: escapes gone, a `\r` progress line
 * reduced to its last state, the head dropped past `cap` at a line boundary.
 */
export function appendOutput(prev: string, chunk: string, cap = OUTPUT_CAP): { text: string; cut: boolean } {
  const lines = (prev + chunk.replace(ANSI, "").replace(/\r\n/g, "\n")).split("\n");
  // The last line may still be mid-write, so its `\r` is folded only once more text arrives.
  const folded = lines.map((l, i) => {
    const at = l.lastIndexOf("\r");
    return at < 0 || (i === lines.length - 1 && at === l.length - 1) ? l : l.slice(at + 1);
  });
  let text = folded.join("\n");
  if (text.length <= cap) return { text, cut: false };
  text = text.slice(-cap);
  const nl = text.indexOf("\n");
  return { text: nl >= 0 ? text.slice(nl + 1) : text, cut: true };
}

export interface RunReport {
  id: string; cmd: string; handle: string; exit: number | null;
  elapsedMs: number; output: string; cut: boolean;
}

/** A server or app's answer: up (with where), still coming up, or down before it ever was. */
export function upText(id: string, cmd: string, handle: string, elapsedMs: number, st: Stack | undefined, output: string): string {
  const secs = Math.round(elapsedMs / 1000);
  const pages = st?.pages.map((p) => `- ${p.name}: ${p.url}`) ?? [];
  const head = st?.state === "ready"
    ? `${id} is up after ${secs}s (\`${cmd}\`). It keeps running in its own Episko pane; the user stops it.`
    : st?.state === "failed"
      ? `${id} failed to come up after ${secs}s (\`${cmd}\`): ${st.why}.`
      : `${id} is still coming up after ${secs}s (\`${cmd}\`)${st?.why ? `: ${st.why}` : ""}. Call task_status with handle "${handle}" to keep waiting.`;
  const tail = output.trim().split("\n").slice(-30).join("\n");
  return [head, pages.length ? `Pages:\n${pages.join("\n")}` : "", tail ? `Output so far (the end):\n${tail}` : ""].filter(Boolean).join("\n\n");
}

/** stack_status: every stack of this repo, across its checkouts, as an agent would want it. */
export function stacksText(stacks: readonly Stack[], here: string): string {
  if (!stacks.length) return "Nothing of this repository's dev environment is running: no dev task panes, no Compose containers.";
  return stacks.map((s) => {
    const where = s.checkout === here ? "this checkout" : `checkout ${s.checkout}`;
    const lines = [`${s.project}${s.label ? ` · ${s.label}` : ""} (${where}): ${s.state}${s.why ? `, ${s.why}` : ""}`];
    for (const m of s.members) lines.push(`  pane ${m.label}: ${m.state}${m.url ? ` at ${m.url}` : m.ports.length ? ` on :${m.ports.join(", :")}` : ""}${m.exit != null ? ` (exit ${m.exit})` : ""}`);
    for (const b of s.boxes) lines.push(`  container ${b.c.service} (${b.c.name}): ${b.state}${b.health !== "none" ? `, ${b.health}` : ""}${b.hostPorts.length ? `, ports :${b.hostPorts.join(", :")}` : ""}${b.from ? `, started from ${b.from}` : ""}`);
    for (const p of s.pages) lines.push(`  page ${p.name}: ${p.url}`);
    return lines.join("\n");
  }).join("\n\n");
}

export function reportText(r: RunReport): string {
  const secs = Math.round(r.elapsedMs / 1000);
  const head = r.exit == null
    ? `${r.id} is still running after ${secs}s (\`${r.cmd}\`). Call task_status with handle "${r.handle}" to keep waiting.`
    : `${r.id} exited ${r.exit} after ${secs}s (\`${r.cmd}\`).`;
  const out = r.output.trim();
  if (!out) return `${head}\n\n(no output)`;
  return `${head}\n\n${r.cut ? "Output (the end of it):" : "Output:"}\n${out}`;
}
