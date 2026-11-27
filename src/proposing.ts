// A headless proposal while it runs (actions' proposeDeploy/Maint/Stack): what the agent has looked
// at, read off deploy.rs's `propose-step` events. The backend reports tool calls; the words are here.

import { esc, escAttr } from "./format";

export type ProposeKind = "deploy" | "maint" | "stack";
export interface Step { verb: "read" | "find" | "search"; what: string; where: string }
export interface Proposing { kind: ProposeKind; since: number; reads: number; looks: number; trail: Step[] }

const TRAIL = 3; // the steps a card shows under its head; the count carries the rest

/** What each read is working out, as the head of its live line says it. */
export const KIND_TEXT: Record<ProposeKind, string> = {
  deploy: "Finding where it runs",
  maint: "Reading branches, releases and scanners",
  stack: "Describing its tasks and dev stack",
};

export const startProposing = (kind: ProposeKind, now: number): Proposing => ({ kind, since: now, reads: 0, looks: 0, trail: [] });

/** `p` relative to `root` when it is inside it, either separator; anything else as given. */
export function relTo(p: string, root: string): string {
  const fwd = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = fwd(p), r = fwd(root);
  if (a === r) return "";
  return r && a.startsWith(r + "/") ? a.slice(r.length + 1) : a;
}

/** One tool call as the agent asked for it; null for a tool this read is not given. */
export function stepOf(tool: string, input: unknown, root: string): Step | null {
  const o = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const s = (k: string) => typeof o[k] === "string" ? (o[k] as string).trim() : "";
  if (tool === "Read") return s("file_path") ? { verb: "read", what: relTo(s("file_path"), root), where: "" } : null;
  if (tool === "Glob") return s("pattern") ? { verb: "find", what: s("pattern"), where: relTo(s("path"), root) } : null;
  if (tool === "Grep") return s("pattern") ? { verb: "search", what: s("pattern"), where: relTo(s("path"), root) || s("glob") } : null;
  return null;
}

export function addStep(p: Proposing, st: Step): Proposing {
  return {
    ...p, reads: p.reads + (st.verb === "read" ? 1 : 0), looks: p.looks + (st.verb === "read" ? 0 : 1),
    trail: [...p.trail, st].slice(-TRAIL),
  };
}

const VERB: Record<Step["verb"], string> = { read: "Read", find: "Find", search: "Search" };
export const stepText = (st: Step): string =>
  `${VERB[st.verb]} ${st.verb === "search" ? `“${st.what}”` : st.what}${st.where ? ` in ${st.where}` : ""}`;

/** The counts beside the head; empty before the first step. */
export function tallyText(p: Proposing): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return [p.reads ? n(p.reads, "file read", "files read") : "", p.looks ? n(p.looks, "search", "searches") : ""].filter(Boolean).join(" · ");
}

/** The live line that stands where the button was. `stop` is the host's own attributes for its Stop
 *  button, so the click lands in that surface's dispatcher. No clock: a ticking figure defeats the
 *  innerHTML guard every surface keeps (docs/architecture.md); the spinner is the sign of life. */
export function liveHtml(p: Proposing, stop: string, compact = false): string {
  const at = new Date(p.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tip = `Claude reads this project read-only, in the background, since ${at}. Nothing is written until you apply what it proposes.`;
  const last = p.trail[p.trail.length - 1];
  const now = !last ? "starting Claude…" : compact ? stepText(last) : "";
  const head = `<div class="pp-h"><span class="u-spin"></span><span class="t">${esc(KIND_TEXT[p.kind])}</span>`
    + (now ? `<span class="now mono">${esc(now)}</span>` : `<span class="gap"></span>`)
    + `<span class="pc">${esc(tallyText(p))}</span>`
    + `<button class="aslink pp-stop" ${stop} data-tip="Stop this read. Nothing has been written">Stop</button></div>`;
  const trail = compact || !p.trail.length ? ""
    : `<ol class="pp-trail">${p.trail.map((st, i) => `<li class="mono${i === p.trail.length - 1 ? " cur" : ""}">${esc(stepText(st))}</li>`).join("")}</ol>`;
  return `<div class="pp${compact ? " compact" : ""}" role="status" data-tip="${escAttr(tip)}">${head}${trail}</div>`;
}
