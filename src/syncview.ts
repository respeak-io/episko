// Settings › Sync as markup: the pairing form, the connection's state, who is on the server, what
// travels where, what arrived, and each project's channel. Data in, string out; ./settings owns
// the element and ./synclink the connection.
import { esc, escAttr } from "./format";
import type { Activity, SyncStatus } from "./synclink";
import {
  PREF_LABEL, STREAM_INFO, prefLabel, type DeviceInfo, type PendingPref, type Stream, type SyncHealth, type UserDevices,
} from "./sync";
import type { ShareMode } from "./state";

export interface SyncDraft { url: string; code: string; user: string; label: string; headers: string }

/** One project as Settings › Sync lists it. `id` absent: not in git, so nothing of it syncs. */
export interface ProjectSyncRow { key: string; name: string; mode: ShareMode }
export interface SyncPanel {
  st: SyncStatus; h: SyncHealth; draft: SyncDraft; busy: boolean; err: string | null; prefsArrived: number;
  users: UserDevices[]; online: Set<string>; activity: Partial<Record<Stream, Activity>>;
  pending: PendingPref[]; excluded: ReadonlySet<string>; invite: { code: string; expires: number } | null;
  nameOf: (device: string) => string; projects: ProjectSyncRow[]; now: number;
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export const HEALTH_TEXT: Record<SyncHealth, string> = {
  off: "Not set up", ok: "In step", lagging: "Reconnecting…", down: "Unreachable",
};

/** The one line the status bar and the folded row share. */
export function syncSummary(st: SyncStatus, h: SyncHealth): string {
  if (!st.configured) return "Off";
  if (st.halted) return "Needs pairing again";
  return HEALTH_TEXT[h];
}

// Write-only: a saved value is never shown again, so the field always starts empty.
const headerField = (value: string) => `<label class="tlabel" for="sync-headers">Extra headers <span class="sync-dim">optional</span></label>
    <textarea id="sync-headers" class="tfield mono sync-hdrs" rows="3" spellcheck="false" autocomplete="off"
      data-syncfield="headers" placeholder="CF-Access-Client-Id: …&#10;CF-Access-Client-Secret: …">${esc(value)}</textarea>
    <div class="thint">For a proxy in front of the server: one <span class="mono">Name: value</span> per line. A Cloudflare
      Access service token is its two <span class="mono">CF-Access-Client-*</span> lines; Traefik basic auth is
      <span class="mono">Authorization: Basic …</span>. Sealed with the sync token, never shown again.</div>`;

function pairForm(d: SyncDraft, busy: boolean, err: string | null): string {
  const field = (id: keyof SyncDraft, label: string, ph: string, mono = true) =>
    `<label class="tlabel" for="sync-${id}">${label}</label>
    <input id="sync-${id}" class="tfield${mono ? " mono" : ""}" type="text" spellcheck="false" autocomplete="off"
      data-syncfield="${id}" placeholder="${escAttr(ph)}" value="${escAttr(d[id])}">`;
  return `<div class="titlebox syncbox">
    ${field("url", "Server address", "https://sync.example.com  or  100.64.0.2:7878")}
    ${field("code", "Code", "the team's registration code, or EPSK-XXXX-XXXX")}
    ${field("user", "Your name", "Ana", false)}
    ${field("label", "Name this machine", "Laptop", false)}
    <div class="thint"><b>New here:</b> enter the team's registration code and your name. <b>Another machine of yours:</b>
      choose <i>Add a machine</i> in Settings › Sync on one that is already paired, and enter its code here; the name
      can stay empty, since the code already knows who you are.</div>
    ${headerField(d.headers)}
    ${err ? `<div class="sync-err">${esc(err)}</div>` : ""}
    <div class="trow-end"><button class="set-abtn" data-setsync="pair"${busy ? " disabled" : ""}>${busy ? "Pairing…" : "Pair"}</button></div>
  </div>`;
}

const sect = (title: string, body: string, hint = "") =>
  `<div class="sync-sec"><div class="sync-st">${title}</div>${hint ? `<div class="thint">${hint}</div>` : ""}${body}</div>`;

function machines(p: SyncPanel): string {
  if (!p.users.length) {
    return sect("Machines", `<div class="thint">This server does not list its machines yet. Update
      <span class="mono">episko-server</span> and reconnect to see who is who.</div>`);
  }
  const dev = (d: DeviceInfo) => {
    const self = d.device === p.st.device;
    const on = self ? p.st.connected : p.online.has(d.device);
    return `<span class="sync-dev${self ? " self" : ""}" title="${escAttr(d.device)}"><i class="sync-dot${on ? " on" : ""}"></i>${esc(d.label || "unnamed")}${self ? ` <span class="sync-dim">this one</span>` : ""}</span>`;
  };
  const rows = p.users.map((u) => `<div class="sync-user">
      <div class="sync-un">${u.mine ? "You" : esc(u.user || "unnamed")}<span class="sync-dim mono">${esc(u.user)}</span></div>
      <div class="sync-devs">${u.devices.map(dev).join("")}</div>
      <div class="sync-dim">${u.mine ? "share your preferences, spend, limits and projects" : "sees shared notes, the work log, claims and what is open"}</div>
    </div>`).join("");
  const left = p.invite ? Math.max(0, Math.round((p.invite.expires - p.now) / 60_000)) : 0;
  const code = p.invite && p.invite.expires > p.now
    ? `<div class="sync-invite"><span class="mono">${esc(p.invite.code)}</span><span class="sync-dim">works once, for ${left} more minute${left === 1 ? "" : "s"}: enter it on the new machine</span></div>` : "";
  return sect("Machines", `${rows}
    <div class="trow-end"><button class="set-freset" data-setsync="invite"${p.st.connected ? "" : " disabled"}>Add a machine</button></div>${code}`,
    `Everyone is one name. Your machines share your preferences, spend and projects; teammates join with the team's
    registration code and their own name.`);
}

function prefs(p: SyncPanel): string {
  const rows = Object.keys(PREF_LABEL).map((k) => {
    const kept = p.excluded.has(k);
    return `<div class="sync-pref"><span>${esc(prefLabel(k))}</span>
      <button class="sync-seg${kept ? "" : " on"}" data-setsync="excl|${escAttr(k)}|0">Syncs</button><button class="sync-seg${kept ? " on" : ""}" data-setsync="excl|${escAttr(k)}|1">This machine only</button></div>`;
  }).join("");
  return sect("Settings that follow you", `<div class="sync-prefs">${rows}</div>`,
    `A change another machine makes is shown to you before it applies here. A setting kept to this machine is neither
    sent nor taken.`);
}

function streams(p: SyncPanel): string {
  const rows = (Object.keys(STREAM_INFO) as Stream[]).map((s) => {
    const i = STREAM_INFO[s], a = p.activity[s];
    const io = !a ? `<span class="sync-dim">nothing yet</span>`
      : [a.sent ? `↑${a.sent}` : "", a.got ? `↓${a.got}` : ""].filter(Boolean).join(" ")
        + ` <span class="sync-dim">${ago(p.now - Math.max(a.sentAt, a.gotAt))}</span>`;
    return `<tr><td>${esc(i.label)}<div class="sync-dim">${esc(i.what)}</div></td>
      <td><span class="sync-reach ${i.scope}">${i.scope === "you" ? "your machines" : "everyone"}</span></td><td class="mono">${io}</td></tr>`;
  }).join("");
  return sect("What travels, and to whom",
    `<table class="sv-tbl sync-tbl"><thead><tr><th>What</th><th>Reaches</th><th>This run</th></tr></thead><tbody>${rows}</tbody></table>`,
    `Permission modes, trusted folders, tasks and auto-fetch never leave this machine, and nothing conversational
    (prompts, transcripts, diffs, session titles) ever does.`);
}

function waiting(p: SyncPanel): string {
  const n = p.pending.length;
  const review = n ? `<div class="sync-arrived">${n} setting${n === 1 ? "" : "s"} from your other machines wait${n === 1 ? "s" : ""} for you.
      <button class="set-abtn" data-setsync="review">Review</button></div>` : "";
  const reload = p.prefsArrived ? `<div class="sync-arrived">What you accepted applies when the interface reloads.
      <button class="set-abtn" data-setsync="reload">Reload now</button></div>` : "";
  return review + reload;
}

/** The review dialog's list: what each setting becomes here, ticked to apply unless you untick it. */
export function reviewHtml(items: PendingPref[], off: ReadonlySet<string>, nameOf: (device: string) => string, now: number): string {
  return items.map((a) => `<div class="srv-item${off.has(a.key) ? " off" : ""}">
      <label class="srv-h"><input type="checkbox" data-srv="tick|${escAttr(a.key)}"${off.has(a.key) ? "" : " checked"}>
        <b>${esc(prefLabel(a.key))}</b><span class="sync-dim">from ${esc(nameOf(a.device))} · ${ago(now - a.at)}</span>
        <button class="srv-keep" data-srv="keep|${escAttr(a.key)}" title="Never take or send this setting">Keep mine, always</button></label>
      ${a.lines.map((l) => `<div class="sync-diff mono">${l.path ? `<span class="sync-dp">${esc(l.path)}</span>` : ""}<span class="sync-del">${esc(l.from)}</span>→<span class="sync-add">${esc(l.to)}</span></div>`).join("")}
      ${a.more ? `<div class="sync-dim">and ${a.more} more</div>` : ""}
    </div>`).join("");
}

const MODE_TEXT: Record<ShareMode, string> = { git: "Git", server: "Sync server", off: "Nowhere" };

// A summary, not the place it is chosen: that is each project's own settings, where the
// team's last choice and what the server holds sit beside the switch (./projsettings).
function projects(p: SyncPanel): string {
  if (!p.projects.length) return "";
  const group = (m: ShareMode) => {
    const rows = p.projects.filter((r) => r.mode === m);
    return rows.length ? `<div class="sync-pgrp"><span class="sync-pk">${MODE_TEXT[m]} <b>${rows.length}</b></span>${rows.map((r) =>
      `<button class="sync-pchip" data-setproj="${escAttr(r.key)}" title="Open ${escAttr(r.name)}'s settings">${esc(r.name)}</button>`).join("")}</div>` : "";
  };
  return sect("Projects", group("server") + group("off") + group("git"),
    `Where each project's notes and work log go. Each project chooses in its own settings: ⚙ on its dashboard, or
    Project settings in its menu. Click a name to open it.`);
}

export function syncPanelHtml(p: SyncPanel): string {
  const { st, h, draft: d, busy, err } = p;
  if (!st.configured) return pairForm(d, busy, err);
  const row = (k: string, v: string, cls = "") => `<div class="tprev-r"><span class="tprev-k">${k}</span><span class="tprev-v${cls}">${v}</span></div>`;
  const state = st.halted ? "The server no longer accepts this machine. Forget it and pair again."
    : st.connected ? "Connected." : st.error ? esc(st.error) : "Connecting…";
  const me = st.user === "me" ? `<div class="thint">Your name on this server is still <span class="mono">me</span>. Its admin can
    run <span class="mono">episko-server rename me YourName</span>; your settings and spend follow the new name.</div>` : "";
  return `<div class="titlebox syncbox">
    <div class="tprev">
      ${row("State", `<span class="sync-h sync-${h}">${esc(syncSummary(st, h))}</span> ${state}`)}
      ${row("Server", esc(st.url), " mono")}
      ${row("You", `${esc(st.label || "unnamed")} <span class="sync-dim">as user</span> <span class="mono">${esc(st.user || "?")}</span>`)}
      ${row("Last", st.lastOkAt ? `exchange ${ago(p.now - st.lastOkAt)}` : "never")}
    </div>
    ${me}
    ${waiting(p)}
    ${machines(p)}
    ${prefs(p)}
    ${streams(p)}
    ${projects(p)}
    <div class="trow-end">
      <button class="set-freset" data-setsync="reconnect">Reconnect</button>
      <button class="set-abtn danger" data-setsync="forget">Forget this machine</button>
    </div>
    <details class="sync-sent"${d.headers || err ? " open" : ""}><summary>${st.headerNames.length ? `Extra headers: ${esc(st.headerNames.join(", "))}` : "Add extra headers"}</summary>
      ${headerField(d.headers)}
      ${err ? `<div class="sync-err">${esc(err)}</div>` : ""}
      <div class="trow-end">
        ${st.headerNames.length ? `<button class="set-freset" data-setsync="noheaders">Remove them</button>` : ""}
        <button class="set-abtn" data-setsync="headers"${busy ? " disabled" : ""}>Save and reconnect</button>
      </div>
    </details>
  </div>`;
}
