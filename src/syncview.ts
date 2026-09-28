// Settings › Sync as markup: the pairing form, the connection's state, and what this device sent.
// Data in, string out; ./settings owns the element and ./synclink the connection.
import { esc, escAttr } from "./format";
import type { SyncStatus } from "./synclink";
import type { SyncHealth } from "./sync";

export interface SyncDraft { url: string; code: string; label: string; headers: string }

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
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
    <div class="thint">On the server, <span class="mono">episko-server invite</span> prints a code that works once, for ten minutes.</div>
    ${headerField(d.headers)}
    ${err ? `<div class="sync-err">${esc(err)}</div>` : ""}
    <div class="trow-end"><button class="set-abtn" data-setsync="pair"${busy ? " disabled" : ""}>${busy ? "Pairing…" : "Pair"}</button></div>
  </div>`;
}

export function syncPanelHtml(st: SyncStatus, h: SyncHealth, d: SyncDraft, busy: boolean, err: string | null,
  prefsArrived: number, sent: { at: number; stream: string; key: string }[], now: number): string {
  if (!st.configured) return pairForm(d, busy, err);
  const row = (k: string, v: string, cls = "") => `<div class="tprev-r"><span class="tprev-k">${k}</span><span class="tprev-v${cls}">${v}</span></div>`;
  const state = st.halted ? "The server no longer accepts this machine. Forget it and pair again."
    : st.connected ? "Connected." : st.error ? esc(st.error) : "Connecting…";
  const log = sent.slice(0, 40).map((e) => `<tr><td class="mono">${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.stream)}</td><td class="mono">${esc(e.key)}</td></tr>`).join("");
  return `<div class="titlebox syncbox">
    <div class="tprev">
      ${row("State", `<span class="sync-h sync-${h}">${esc(syncSummary(st, h))}</span> ${state}`)}
      ${row("Server", esc(st.url), " mono")}
      ${row("This machine", `${esc(st.label || "unnamed")} <span class="mono sync-dim">${esc(st.device)}</span>`)}
      ${row("Last exchange", st.lastOkAt ? ago(now - st.lastOkAt) : "never")}
      ${row("Extra headers", st.headerNames.length ? esc(st.headerNames.join(", ")) : "none", st.headerNames.length ? " mono" : "")}
    </div>
    ${prefsArrived ? `<div class="sync-arrived">Preferences arrived from another machine; they apply when the interface reloads.
      <button class="set-abtn" data-setsync="reload">Reload now</button></div>` : ""}
    <div class="trow-end">
      <button class="set-freset" data-setsync="reconnect">Reconnect</button>
      <button class="set-abtn danger" data-setsync="forget">Forget this machine</button>
    </div>
    <details class="sync-sent"${d.headers || err ? " open" : ""}><summary>${st.headerNames.length ? "Replace the extra headers" : "Add extra headers"}</summary>
      ${headerField(d.headers)}
      ${err ? `<div class="sync-err">${esc(err)}</div>` : ""}
      <div class="trow-end">
        ${st.headerNames.length ? `<button class="set-freset" data-setsync="noheaders">Remove them</button>` : ""}
        <button class="set-abtn" data-setsync="headers"${busy ? " disabled" : ""}>Save and reconnect</button>
      </div>
    </details>
    <details class="sync-sent"><summary>What this machine sent (${sent.length})</summary>
      ${log ? `<table class="sv-tbl"><thead><tr><th>When</th><th>Stream</th><th>Key</th></tr></thead><tbody>${log}</tbody></table>`
        : `<div class="thint">Nothing yet this run.</div>`}
    </details>
  </div>`;
}
