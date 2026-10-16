// The send sheet's markup and the rows a handed session leaves behind (docs/handoff.md). Data
// in, string out: ./handoffui owns #handoffDlg, its listener and its guard.
import { esc, escAttr } from "./format";
import { peerName, type Brief, type GitOption, type HandoffRec, type MemoryFile, type MemoryRow, type Target } from "./handoff";

export const PRIVACY = (hours: number) =>
  "A transcript contains everything the agent read: file contents, command output, and any secret that passed through it. "
  + `It is stored on your sync server until picked up or for ${hours} hours.`;

const mib = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(n >= 10 << 20 ? 0 : 1)} MiB` : `${Math.max(1, Math.round(n / 1024))} KiB`);
const foot = (hint: string, buttons: string) => `<div class="cfm-foot"><span class="cfm-hint">${esc(hint)}</span>${buttons}</div>`;
const btn = (verb: string, label: string, cls: string, disabled?: string) =>
  `<button class="cfm-btn ${cls}" type="button" data-hand="${escAttr(verb)}"${disabled ? ` disabled title="${escAttr(disabled)}"` : ""}>${esc(label)}</button>`;

export interface SendView { title: string; project: string; targets: Target[]; pick: number | null; warnings: string[]; live: boolean }
/** Step 1: who takes it, and what stopping the session costs. */
export function sendSheetHtml(v: SendView): string {
  const rows = v.targets.map((t, i) => {
    const why = t.ready ? "" : t.mine ? "Its Episko predates handoff" : "None of their machines speaks handoff yet";
    const sub = t.mine ? (t.online ? "your machine · online" : "your machine · offline, picks it up later") : (t.online ? "teammate · online" : "teammate · any of their machines");
    return `<button class="hand-t${v.pick === i ? " on" : ""}" type="button" data-hand="pick|${i}"${why ? ` disabled title="${escAttr(why)}"` : ""}>
      <span class="hand-dot${t.online ? " live" : ""}"></span><b>${esc(t.label)}</b><span class="sync-dim">${esc(why || sub)}</span></button>`;
  }).join("");
  const warn = v.warnings.map((w) => `<div class="hand-warn">${esc(w)}</div>`).join("");
  const notice = v.live ? "This stops the session now. Cancel later and it stays on your shelf." : "The session stays on your shelf until somebody picks it up.";
  return `<div class="hand-what"><b>${esc(v.title)}</b><span class="sync-dim">${esc(v.project)}</span></div>
    <div class="hand-ts">${rows || `<div class="sync-dim">Nobody else on this server.</div>`}</div>
    ${warn}<p class="hand-note">${esc(notice)}</p>
    ${foot("esc cancel", btn("close", "Cancel", "ghost") + btn("go", v.live ? "Stop and continue" : "Continue", "go", v.pick === null ? "Choose who takes it" : ""))}`;
}

/** While the session stops there is nothing to skip yet; the brief is only asked for after. */
export function briefingHtml(who: string, stopping: boolean): string {
  const what = stopping ? "Stopping the session…" : `Writing a brief for ${esc(who)} from the conversation…`;
  return `<p class="hand-note"><span class="hand-spin" aria-hidden="true"></span>${what}</p>
    ${foot("nothing is typed into the session", btn("cancel", "Cancel", "ghost") + (stopping ? "" : btn("skip", "Skip the brief", "ghost")))}`;
}

export interface ReviewView {
  who: string; options: GitOption[] | null; pick: string | null; gitNote: string;
  ttlHours: number; maxBytes: number; err: string; busy: boolean; offering: boolean;
  memories: MemoryRow[]; teammate: boolean;
}
const memRow = (m: MemoryFile, verb: string, ticked: boolean, off: boolean, extra = "") =>
  `<label class="hand-g hand-m"><input type="checkbox" data-hand="${escAttr(verb)}"${ticked ? " checked" : ""}${off ? " disabled" : ""}>
    <span><span class="mono">${esc(m.name)}</span> <span class="sync-dim">· ${esc(m.type || "untyped")}${extra}</span>
    ${m.description ? `<span class="hand-md sync-dim">${esc(m.description)}</span>` : ""}</span></label>`;
/** The project's saved memories, ticked to travel; empty when there are none worth offering. */
function memoriesHtml(rows: MemoryRow[], teammate: boolean, who: string, busy: boolean): string {
  if (!rows.length) return "";
  const note = teammate ? `Only project and reference memories can go to ${who}; yours about you never do.` : "Ticked ones go with it.";
  return `<div class="hand-sec"><span class="label">Memories</span><span class="sync-dim">${esc(note)}</span></div>
    <div class="hand-gs">${rows.map((m, i) => memRow(m, `mem|${i}`, m.ticked, busy, m.suggested ? " · the session used it" : "")).join("")}</div>`;
}
const lines = (xs: string[]) => esc(xs.join("\n"));
/** Step 2's brief, painted once per sheet: a repaint would replace the field being typed into. */
export function reviewBriefHtml(who: string, brief: Brief, note: string): string {
  const field = (k: keyof Brief, label: string, value: string, rows: number) =>
    `<label class="hand-f"><span>${esc(label)}</span><textarea data-hbrief="${k}" rows="${rows}" spellcheck="false">${value}</textarea></label>`;
  return `<div class="hand-sec"><span class="label">Brief for ${esc(who)}</span>${note ? `<span class="sync-dim">${esc(note)}</span>` : ""}</div>
    ${field("summary", "What it was doing", esc(brief.summary), 3)}
    ${field("state", "Where it stands", esc(brief.state), 2)}
    ${field("next_steps", "Next steps, one per line", lines(brief.next_steps), 3)}
    ${field("open_questions", "Open questions, one per line", lines(brief.open_questions), 2)}`;
}
/** The rest of step 2: how the code travels, and the warning nobody can dismiss. */
export function reviewRestHtml(v: ReviewView): string {
  const git = v.options === null
    ? `<div class="sync-dim"><span class="hand-spin" aria-hidden="true"></span>Reading the checkout…</div>`
    : v.options.map((o) => `<label class="hand-g${o.disabled ? " dis" : ""}"${o.disabled ? ` title="${escAttr(o.disabled)}"` : ""}>
        <input type="radio" name="handgit" data-hand="git|${o.id}"${v.pick === o.id ? " checked" : ""}${o.disabled || v.busy ? " disabled" : ""}>
        <span>${esc(o.label)}${o.disabled ? ` <span class="sync-dim">· ${esc(o.disabled)}</span>` : ""}</span></label>`).join("");
  const blocked = v.busy ? "Sending…" : v.options === null ? "Still reading the checkout" : v.pick === null ? "Choose how the code travels" : "";
  return `<div class="hand-sec"><span class="label">Code</span>${v.gitNote ? `<span class="sync-dim">${esc(v.gitNote)}</span>` : ""}</div>
    <div class="hand-gs">${git}</div>
    ${memoriesHtml(v.memories, v.teammate, v.who, v.busy)}
    <div class="hand-priv">${esc(PRIVACY(v.ttlHours))}</div>
    <div class="sync-dim">This server takes up to ${esc(mib(v.maxBytes))}. Files like <span class="mono">.env</span> and keys are left out of a snapshot.</div>
    ${v.err ? `<div class="sync-err">${esc(v.err)}</div>` : ""}
    ${foot(`to ${v.who}`, btn("cancel", "Cancel", "ghost", v.offering ? "It is already on its way; take it back from its row" : "") + btn("send", v.busy ? "Sending…" : "Send", "go", blocked))}`;
}

/** A sent session whose handover finished: the shelved row's shape, cleared with ✕. */
export function handoffRowHtml(r: HandoffRec, tag: string, title: string): string {
  return `<div class="srow pastrow handed" title="${escAttr(`Handed to ${peerName(r.peer)}; the conversation is theirs now`)}">
    <span class="sglyph g-ended">⇢</span>
    <span class="sbranch">${esc(title)}</span>
    <span class="past-tag">${esc(tag)}</span>
    <span class="sclose" data-handout="${escAttr(r.id)}" title="Clear this row">✕</span></div>`;
}

/** An offer to this machine, or one it is receiving: clicking opens its sheet. */
export function incomingRowHtml(r: HandoffRec, tag: string, title: string): string {
  const taken = !!r.takenBy;
  return `<div class="srow pastrow handin${taken ? " taken" : ""}" data-handin="${escAttr(r.id)}" title="${escAttr(taken ? tag : `Sent by ${peerName(r.peer)} · click to look`)}">
    <span class="sglyph g-ended">⇠</span>
    <span class="sbranch">${esc(title)}</span>
    <span class="past-tag">${esc(tag)}</span></div>`;
}

/** The rail's strip for offers whose project is not cloned here; empty when there are none. */
export function incomingStripHtml(rows: string, n: number): string {
  if (!rows) return "";
  return `<div class="handin-strip"><div class="phead ext-only"><span class="pname">⇠ Incoming</span>
    <span class="pcount ext">${n} not cloned here</span></div><div class="psessions">${rows}</div></div>`;
}

export interface IncomingView {
  from: string; title: string; project: string; brief: Brief | null; code: string; newer: boolean;
  paths: string[]; pick: number | null; folder: string | null; gate: string | null;
  stage: "offer" | "claiming" | "receiving" | "ready" | "installing" | "taken";
  progress: string; err: string; ttlHours: number;
  memories: MemoryFile[]; ticked: ReadonlySet<string>;
}
const briefRead = (b: Brief) => {
  const list = (label: string, xs: string[]) => (xs.length ? `<div class="hand-sec"><span class="label">${esc(label)}</span></div><ul class="hand-ul">${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  return `${b.summary ? `<p class="hand-note">${esc(b.summary)}</p>` : ""}${b.state ? `<p class="hand-note sync-dim">${esc(b.state)}</p>` : ""}
    ${list("Next steps", b.next_steps)}${list("Open questions", b.open_questions)}`;
};
/** An offer from `from`, and what Resume here would do; also the receiving and retry states. */
export function incomingSheetHtml(v: IncomingView): string {
  const head = `<div class="hand-what"><b>${esc(v.title)}</b><span class="sync-dim">${esc(v.project)} · from ${esc(v.from)}</span></div>`;
  if (v.newer) {
    return `${head}<p class="hand-note">This was sent from a newer Episko, and this version can't read it. Update, then open it again.</p>
      ${foot("esc later", btn("in-later", "Later", "ghost") + btn("in-decline", "Decline", "danger"))}`;
  }
  if (v.stage === "taken") return `${head}<p class="hand-note">${esc(v.progress)}</p>${foot("", btn("in-later", "Close", "ghost"))}`;
  const brief = v.brief && (v.brief.summary || v.brief.state || v.brief.next_steps.length || v.brief.open_questions.length)
    ? briefRead(v.brief) : `<p class="hand-note sync-dim">No brief came with it.</p>`;
  const choose = v.stage === "offer" || v.stage === "ready";
  const places = v.paths.map((p, i) => `<label class="hand-g"><input type="radio" name="handin" data-hand="in-pick|${i}"${v.pick === i ? " checked" : ""}${choose ? "" : " disabled"}>
      <span class="mono">${esc(p)}</span></label>`).join("");
  const folder = v.folder ? `<label class="hand-g"><input type="radio" name="handin" data-hand="in-pick|-1"${v.pick === -1 ? " checked" : ""}${choose ? "" : " disabled"}><span class="mono">${esc(v.folder)}</span></label>` : "";
  const where = `<div class="hand-sec"><span class="label">Resume it in</span></div><div class="hand-gs">${places}${folder}
      ${choose ? `<button class="cfm-btn ghost hand-pickdir" type="button" data-hand="in-folder">Choose a folder…</button>` : ""}</div>`;
  const mems = v.memories.length ? `<div class="hand-sec"><span class="label">Memories</span><span class="sync-dim">One you already have is never replaced.</span></div>
    <div class="hand-gs">${v.memories.map((m, i) => memRow(m, `in-mem|${i}`, v.ticked.has(m.name), !choose)).join("")}</div>` : "";
  const status = v.stage === "offer" ? "" : `<p class="hand-note">${v.stage === "ready" ? "" : `<span class="hand-spin" aria-hidden="true"></span>`}${esc(v.progress)}</p>`;
  const err = v.err ? `<div class="sync-err">${esc(v.err)}</div>` : "";
  const gate = v.gate ? `<div class="hand-warn">${esc(v.gate)}</div>` : "";
  let buttons: string;
  if (v.stage === "offer") buttons = btn("in-later", "Later", "ghost") + btn("in-decline", "Decline", "ghost") + btn("in-claim", "Resume here", "go", v.gate ?? "");
  else if (v.stage === "ready") buttons = btn("in-later", "Later", "ghost") + btn("in-open", "Open folder", "ghost", v.pick === null ? "Choose a folder first" : "") + btn("in-retry", "Retry", "go", v.gate ?? "");
  else if (v.stage === "installing") buttons = btn("in-later", "Hide", "ghost");
  else buttons = btn("in-later", "Hide", "ghost") + btn("in-giveback", "Give back", "ghost");
  const hint = v.stage === "offer" ? `held for ${v.ttlHours}h at most` : v.stage === "ready" ? "this is now your copy" : "nothing is written until it is yours";
  return `${head}<div class="hand-sec"><span class="label">Brief</span></div>${brief}
    <div class="hand-sec"><span class="label">Code</span></div><p class="hand-note">${esc(v.code)}</p>
    ${where}${mems}${gate}${status}${err}${foot(hint, buttons)}`;
}
