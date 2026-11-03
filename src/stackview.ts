// A dev stack's block in the servers popover: data in, markup out. The rules are ./stack's;
// ./serversui owns the element, its listener and the poll. Every `data-sv*` here is probed
// there (test/dispatch.test.ts reads both files).

import { esc, escAttr } from "./format";
import type { Box, Member, Stack, StackPage } from "./stack";
import { icon } from "./svgicons";

const FROM: Record<StackPage["from"], string> = {
  declared: "from [stack] pages", described: "from the task's description", pane: "announced by its pane", proxy: "a reverse-proxy route",
};

// Every address the stack offers, as chips under its head: the ones to open, by name.
function pagesHtml(pages: readonly StackPage[]): string {
  return pages.length
    ? `<div class="sv-pages">${pages.map((p) => `<button class="sv-page" data-svopen="${escAttr(p.url)}" title="${escAttr(`Open ${p.url} · ${FROM[p.from]}`)}">${esc(p.name)}</button>`).join("")}</div>`
    : "";
}

// A leftover's `why` already says what it is; its state word would only repeat it.
const STATE_TEXT: Record<Stack["state"], string> = {
  starting: "starting", ready: "ready", failed: "failed", leftover: "",
};

const M_DOT: Record<Member["state"], string> = { running: "", serving: " up", done: " done", failed: " down" };
const B_DOT: Record<Box["state"], string> = { up: " up", starting: "", failing: " down", done: " done", stopped: " done" };

function memberHtml(m: Member): string {
  // A port with no announced URL is still worth a click: it is the kernel's word that something listens.
  const url = m.url || (m.ports.length ? `http://localhost:${m.ports[0]}` : "");
  const meta = m.state === "failed" ? `<span class="sv-meta sv-bad">${m.exit != null && m.exit !== 0 ? `exited ${m.exit}` : "stopped"}</span>`
    : m.state === "done" ? `<span class="sv-meta">done</span>`
    : url ? `<button class="sv-url" data-svopen="${escAttr(url)}" title="Open ${escAttr(url)}">${esc(url.replace(/^https?:\/\//, ""))}</button>`
    : `<span class="sv-meta">${m.background ? "not listening yet" : "running"}</span>`;
  return `<div class="sv-line"><span class="sv-dot${M_DOT[m.state]}"></span><span class="sv-ln" title="${escAttr(m.label)}">${esc(m.label)}</span>${meta}`
    + `<button class="sv-go" data-svgo="${m.sid}" title="Go to this pane">${icon("panelRight", "solo")}</button></div>`;
}

function boxHtml(b: Box): string {
  const bits = [
    b.c.state === "running" ? (b.health === "none" ? "up" : b.health) : b.c.status.replace(/\s+ago$/, " ago"),
    ...b.hostPorts.map((p) => `:${p}`),
    b.from && `from ${b.from}`,
  ].filter(Boolean);
  return `<div class="sv-line sv-box"><span class="sv-dot${B_DOT[b.state]}"></span>`
    + `<span class="sv-ln" title="${escAttr(`${b.c.name} · ${b.c.project} · ${b.c.workingDir}`)}"><span class="sv-src sv-obs">${icon("container", "solo")}</span>${esc(b.c.service)}</span>`
    + `<span class="sv-meta${b.state === "failing" ? " sv-bad" : ""}">${esc(bits.join(" · "))}</span><span class="sv-none"></span></div>`;
}

// The dot and the edge: a leftover has no dev task to sum, so it wears its containers' worst state.
function tone(s: Stack): Exclude<Stack["state"], "leftover"> {
  if (s.state !== "leftover") return s.state;
  if (s.boxes.some((b) => b.state === "failing")) return "failed";
  return s.boxes.some((b) => b.state === "starting") ? "starting" : "ready";
}
const TONE_TITLE: Record<ReturnType<typeof tone>, string> = {
  ready: "Everything here is up", starting: "Still coming up", failed: "Something here has failed",
};

/** One stack. `downLabel` names where ⏹ sends its containers: `[stack] down`, or a compose stop. */
export function stackHtml(s: Stack, downLabel: string): string {
  const running = s.boxes.some((b) => b.state === "up" || b.state === "starting" || b.state === "failing");
  const sub = [STATE_TEXT[s.state], s.why].filter(Boolean).join(" · ");
  const head = `<span class="sv-main"><span class="sv-proj">${esc(s.project)}${s.label ? ` · ${esc(s.label)}` : ""}</span>`
    + `<span class="sv-cmd">${esc(sub)}</span></span>`;
  const down = running
    ? `<button class="sv-stop" data-svdown="${escAttr(s.key)}" title="${escAttr(downLabel)}">${icon("circleStop", "solo")}</button>`
    : `<span class="sv-none"></span>`;
  const stop = s.members.length
    ? `<button class="sv-stop" data-svstack="${escAttr(s.key)}" title="Close this stack's ${s.members.length} pane${s.members.length === 1 ? "" : "s"} (containers keep running)">${icon("x", "solo")}</button>`
    : `<span class="sv-none"></span>`;
  return `<div class="sv-stack st-${tone(s)}"><div class="sv-sh"><span class="sv-sdot" title="${escAttr(TONE_TITLE[tone(s)])}"></span>${head}${down}${stop}</div>${pagesHtml(s.pages)}`
    + s.members.map(memberHtml).join("") + s.boxes.map(boxHtml).join("") + `</div>`;
}
