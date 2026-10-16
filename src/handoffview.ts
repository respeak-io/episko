// The send sheet's markup and the rows a handed session leaves behind (docs/handoff.md). Data
// in, string out: ./handoffui owns #handoffDlg, its listener and its guard.
import { esc, escAttr } from "./format";
import { peerName, type Brief, type GitOption, type HandoffRec, type Target } from "./handoff";

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

export function briefingHtml(who: string): string {
  return `<p class="hand-note"><span class="hand-spin" aria-hidden="true"></span>Writing a brief for ${esc(who)} from the conversation…</p>
    ${foot("nothing is typed into the session", btn("cancel", "Cancel", "ghost") + btn("skip", "Skip the brief", "ghost"))}`;
}

export interface ReviewView {
  who: string; brief: Brief; briefNote: string; options: GitOption[] | null; pick: string | null; gitNote: string;
  ttlHours: number; maxBytes: number; err: string; busy: boolean;
}
const lines = (xs: string[]) => esc(xs.join("\n"));
/** Step 2: the brief to edit, how the code travels, and the warning nobody can dismiss. */
export function reviewSheetHtml(v: ReviewView): string {
  const field = (k: keyof Brief, label: string, value: string, rows: number) =>
    `<label class="hand-f"><span>${esc(label)}</span><textarea data-hbrief="${k}" rows="${rows}" spellcheck="false">${value}</textarea></label>`;
  const git = v.options === null
    ? `<div class="sync-dim"><span class="hand-spin" aria-hidden="true"></span>Reading the checkout…</div>`
    : v.options.map((o) => `<label class="hand-g${o.disabled ? " dis" : ""}"${o.disabled ? ` title="${escAttr(o.disabled)}"` : ""}>
        <input type="radio" name="handgit" data-hand="git|${o.id}"${v.pick === o.id ? " checked" : ""}${o.disabled ? " disabled" : ""}>
        <span>${esc(o.label)}${o.disabled ? ` <span class="sync-dim">· ${esc(o.disabled)}</span>` : ""}</span></label>`).join("");
  const blocked = v.busy ? "Sending…" : v.options === null ? "Still reading the checkout" : v.pick === null ? "Choose how the code travels" : "";
  return `<div class="hand-sec"><span class="label">Brief for ${esc(v.who)}</span>${v.briefNote ? `<span class="sync-dim">${esc(v.briefNote)}</span>` : ""}</div>
    ${field("summary", "What it was doing", esc(v.brief.summary), 3)}
    ${field("state", "Where it stands", esc(v.brief.state), 2)}
    ${field("next_steps", "Next steps, one per line", lines(v.brief.next_steps), 3)}
    ${field("open_questions", "Open questions, one per line", lines(v.brief.open_questions), 2)}
    <div class="hand-sec"><span class="label">Code</span>${v.gitNote ? `<span class="sync-dim">${esc(v.gitNote)}</span>` : ""}</div>
    <div class="hand-gs">${git}</div>
    <div class="hand-priv">${esc(PRIVACY(v.ttlHours))}</div>
    <div class="sync-dim">This server takes up to ${esc(mib(v.maxBytes))}. Files like <span class="mono">.env</span> and keys are left out of a snapshot.</div>
    ${v.err ? `<div class="sync-err">${esc(v.err)}</div>` : ""}
    ${foot(`to ${v.who}`, btn("cancel", "Cancel", "ghost") + btn("send", v.busy ? "Sending…" : "Send", "go", blocked))}`;
}

/** A sent session whose handover finished: the shelved row's shape, cleared with ✕. */
export function handoffRowHtml(r: HandoffRec, tag: string, title: string): string {
  return `<div class="srow pastrow handed" title="${escAttr(`Handed to ${peerName(r.peer)}; the conversation is theirs now`)}">
    <span class="sglyph g-ended">⇢</span>
    <span class="sbranch">${esc(title)}</span>
    <span class="past-tag">${esc(tag)}</span>
    <span class="sclose" data-handout="${escAttr(r.id)}" title="Clear this row">✕</span></div>`;
}
