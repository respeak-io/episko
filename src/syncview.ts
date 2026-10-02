// Settings › Sync as markup: the pairing form, the connection's state, who is on the server, what
// travels where, what arrived, and each project's channel. Data in, string out; ./settings owns
// the element and ./synclink the connection.
import { esc, escAttr } from "./format";
import type { Activity, SyncStatus } from "./synclink";
import {
  STREAM_INFO, prefLabel, type Arrival, type DeviceInfo, type Stream, type SyncHealth, type UserDevices,
} from "./sync";
import type { ShareMode } from "./state";

export interface SyncDraft { url: string; code: string; label: string; headers: string }

/** One project as Settings › Sync lists it. `id` absent: not in git, so nothing of it syncs. */
export interface ProjectSyncRow {
  key: string; name: string; id: string | undefined; mode: ShareMode;
  team: { mode: "git" | "server"; by: string } | null;
  lines: number; notes: number; digestFile: boolean;
}
export interface SyncPanel {
  st: SyncStatus; h: SyncHealth; draft: SyncDraft; busy: boolean; err: string | null; prefsArrived: number;
  users: UserDevices[]; online: Set<string>; activity: Partial<Record<Stream, Activity>>;
  arrivals: Arrival[]; nameOf: (device: string) => string; projects: ProjectSyncRow[]; now: number;
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
    ${field("code", "Invite code", "EPSK-XXXX-XXXX")}
    ${field("label", "Name this machine", "Laptop", false)}
    <div class="thint">On the server, <span class="mono">episko-server invite</span> prints a code for another machine of
      yours; <span class="mono">episko-server invite --user NAME</span> prints one for a teammate. It works once, for ten minutes.</div>
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
  return sect("Machines", rows, `A machine's user is the name it was invited under: one name is one person. Pair another
    machine of yours with <span class="mono">episko-server invite</span>; a teammate needs
    <span class="mono">--user NAME</span>, or they share your settings and spend.`);
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

function arrived(p: SyncPanel): string {
  if (!p.arrivals.length && !p.prefsArrived) return "";
  const rows = p.arrivals.map((a) => `<div class="sync-arr">
      <div class="sync-arr-h"><b>${esc(prefLabel(a.key))}</b><span class="sync-dim">from ${esc(p.nameOf(a.device))} · ${ago(p.now - a.at)}</span></div>
      ${a.lines.map((l) => `<div class="sync-diff mono">${l.path ? `<span class="sync-dp">${esc(l.path)}</span>` : ""}<span class="sync-del">${esc(l.from)}</span>→<span class="sync-add">${esc(l.to)}</span></div>`).join("")}
      ${a.more ? `<div class="sync-dim">and ${a.more} more</div>` : ""}
    </div>`).join("");
  const banner = p.prefsArrived ? `<div class="sync-arrived">These apply when the interface reloads.
      <button class="set-abtn" data-setsync="reload">Reload now</button></div>` : "";
  return sect("Arrived from your other machines", `${banner}${rows}
    ${p.arrivals.length ? `<div class="trow-end"><button class="set-freset" data-setsync="clearArrivals">Clear this list</button></div>` : ""}`);
}

const MODE_TEXT: Record<ShareMode, string> = { git: "Git", server: "Sync server", off: "Nowhere" };

function projects(p: SyncPanel): string {
  if (!p.projects.length) return "";
  const rows = p.projects.map((r) => {
    const modes = (["git", "server", "off"] as ShareMode[]).map((m) =>
      `<button class="sync-seg${m === r.mode ? " on" : ""}" data-setsync="share|${m}|${escAttr(r.key)}"${!r.id && m === "server" ? " disabled" : ""}>${MODE_TEXT[m]}</button>`).join("");
    const team = r.team && r.team.mode !== r.mode && r.mode !== "off"
      ? `<div class="sync-dim">the team last chose ${MODE_TEXT[r.team.mode]}${r.team.by ? ` (${esc(r.team.by)})` : ""}</div>` : "";
    const facts = [r.lines ? `${r.lines} work-log day${r.lines === 1 ? "" : "s"}` : "", r.notes ? `${r.notes} note${r.notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    const move = r.digestFile && r.mode !== "git" && r.id
      ? `<button class="set-freset" data-setsync="movelog|${escAttr(r.key)}" title="Send .episko/digest.md's days to the server, then delete the file">Move digest.md to the server</button>` : "";
    return `<tr><td>${esc(r.name)}<div class="sync-dim mono">${r.id ? esc(r.id.slice(0, 16)) : "not in git: stays on this machine"}</div></td>
      <td><div class="sync-segs">${modes}</div>${team}</td>
      <td>${facts ? `<span class="sync-dim">on the server: ${facts}</span>` : ""}${r.digestFile ? `<div class="sync-dim">.episko/digest.md in the repo</div>` : ""}${move}</td></tr>`;
  }).join("");
  return sect("Projects",
    `<table class="sv-tbl sync-tbl sync-proj"><thead><tr><th>Project</th><th>Notes and work log</th><th></th></tr></thead><tbody>${rows}</tbody></table>`,
    `A project syncs by its first commit, so every clone of it is the same project. <b>Git</b> commits notes and the work
    log in <span class="mono">.episko/</span>; <b>Sync server</b> keeps them off the repo; <b>Nowhere</b> shares nothing.
    Choosing Git or Sync server switches your teammates too; Nowhere is yours alone.`);
}

export function syncPanelHtml(p: SyncPanel): string {
  const { st, h, draft: d, busy, err } = p;
  if (!st.configured) return pairForm(d, busy, err);
  const row = (k: string, v: string, cls = "") => `<div class="tprev-r"><span class="tprev-k">${k}</span><span class="tprev-v${cls}">${v}</span></div>`;
  const state = st.halted ? "The server no longer accepts this machine. Forget it and pair again."
    : st.connected ? "Connected." : st.error ? esc(st.error) : "Connecting…";
  return `<div class="titlebox syncbox">
    <div class="tprev">
      ${row("State", `<span class="sync-h sync-${h}">${esc(syncSummary(st, h))}</span> ${state}`)}
      ${row("Server", esc(st.url), " mono")}
      ${row("You", `${esc(st.label || "unnamed")} <span class="sync-dim">as user</span> <span class="mono">${esc(st.user || "?")}</span>`)}
      ${row("Last", st.lastOkAt ? `exchange ${ago(p.now - st.lastOkAt)}` : "never")}
    </div>
    ${arrived(p)}
    ${machines(p)}
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
