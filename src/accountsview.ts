// Settings › Accounts as markup: the setup-token accounts in priority order with their last
// figures, the keychain items not yet listed, and the two ways to add one. Data in, string out;
// ./settings owns the element and ./actions every verb (docs/accounts.md).
import { esc, escAttr } from "./format";
import type { AcctReading, ClaudeAcct } from "./accounts";
import type { AcctCheck } from "./state";

/** `blocked`: why a launch skips it (no token in the keychain, or its last Check failed). */
export interface AcctRow { acct: ClaudeAcct; reading: AcctReading | null; full: boolean; check?: AcctCheck; next: boolean; blocked?: string }
export interface AcctPanel { rows: AcctRow[]; found: string[]; login: string | null; draft: { name: string; token: string }; external: boolean; now: number }

const left = (resetS: number | null, now: number) => {
  if (resetS == null) return "";
  const m = Math.max(0, Math.round((resetS * 1000 - now) / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function figures(r: AcctReading | null, now: number): string {
  if (!r || (r.h5 == null && r.d7 == null)) return `<span class="sync-dim">no reading yet</span>`;
  const win = (name: string, pct: number | null, reset: number | null) => {
    if (pct == null) return "";
    const past = reset != null && reset * 1000 <= now;
    return `${name} <b>${past ? 0 : Math.round(pct)}%</b>${!past && reset != null ? ` <span class="sync-dim">↻ ${left(reset, now)}</span>` : ""}`;
  };
  return [win("5h", r.h5, r.h5Reset), win("7d", r.d7, r.d7Reset)].filter(Boolean).join(`<span class="sync-dim"> · </span>`);
}

function row(r: AcctRow, i: number, n: number, now: number): string {
  const l = escAttr(r.acct.label);
  const c = r.check;
  const state = c?.busy ? `<span class="sync-dim">checking…</span>`
    : c && !c.ok ? `<span class="acct-bad" title="${escAttr(c.error ?? "")}">✕ ${esc(c.error ?? "failed")}</span>`
      : c ? `<span class="sync-dim">✓ worked ${ago(now - c.at)}</span>` : "";
  const tag = !r.acct.on ? `<span class="acct-tag">off</span>`
    : r.blocked ? `<span class="acct-tag full" title="New sessions skip it until this is fixed">${esc(r.blocked)}</span>`
    : r.full ? `<span class="acct-tag full">full</span>`
      : r.next ? `<span class="acct-tag next">next session</span>` : "";
  return `<div class="acct-row${r.acct.on ? "" : " off"}">
    <span class="acct-n">${i + 1}</span>
    <div class="acct-main"><div class="acct-l"><span class="mono">${esc(r.acct.label)}</span>${tag}</div>
      <div class="acct-f">${figures(r.reading, now)}${state ? ` <span class="sync-dim">·</span> ${state}` : ""}</div></div>
    <div class="acct-btns">
      <button class="set-fbtn" data-setacct="up|${l}" title="Earlier in the order"${i === 0 ? " disabled" : ""}>↑</button>
      <button class="set-fbtn" data-setacct="down|${l}" title="Later in the order"${i === n - 1 ? " disabled" : ""}>↓</button>
      <button class="set-freset" data-setacct="check|${l}"${c?.busy ? " disabled" : ""} title="One short Haiku turn: proves the token and reads its limits">Check</button>
      <button class="sw${r.acct.on ? " on" : ""}" data-setacct="toggle|${l}" role="switch" aria-checked="${r.acct.on}" title="${r.acct.on ? "Skip this account" : "Use this account"}"></button>
      <button class="set-fbtn" data-setacct="remove|${l}" title="Remove, and delete its token from this machine">✕</button>
    </div>
  </div>`;
}

const sect = (title: string, body: string, hint = "") =>
  `<div class="sync-sec"><div class="sync-st">${title}</div>${hint ? `<div class="thint">${hint}</div>` : ""}${body}</div>`;

export function accountsPanelHtml(p: AcctPanel): string {
  const login = p.login ? `the account you're logged in to (${esc(p.login)})` : "the account you're logged in to";
  const list = p.rows.length
    ? p.rows.map((r, i) => row(r, i, p.rows.length, p.now)).join("")
    : `<div class="thint">None yet, so every session starts on ${login}.</div>`;
  const ext = p.external ? `<div class="thint">New sessions open in an external terminal, which always uses ${login}: a token there would end up in its scrollback.</div>` : "";
  const found = p.found.length ? sect("In your keychain",
    `<div class="sync-pchips">${p.found.map((f) => `<button class="sync-pchip" data-setacct="add|${escAttr(f)}" title="Add ${escAttr(f)} at the end of the order">+ ${esc(f)}</button>`).join("")}</div>`,
    `Tokens stored under <span class="mono">episko-claude-token</span> that aren't in the order yet.`) : "";
  const d = p.draft;
  const add = sect("Add an account", `
    <label class="tlabel" for="acct-name">Name</label>
    <input id="acct-name" class="tfield mono" type="text" spellcheck="false" autocomplete="off" data-acctfield="name" placeholder="max20" value="${escAttr(d.name)}">
    <div class="trow-end"><button class="set-abtn" data-setacct="setup">Sign in with claude setup-token</button></div>
    <details class="sync-sent"${d.token ? " open" : ""}><summary>Paste a token instead</summary>
      <input id="acct-token" class="tfield mono" type="password" spellcheck="false" autocomplete="off" data-acctfield="token" placeholder="sk-ant-oat01-…" value="${escAttr(d.token)}">
      <div class="thint">The whole token, both lines of it if your terminal wrapped it.</div>
      <div class="trow-end"><button class="set-abtn" data-setacct="paste">Save and check</button></div>
    </details>`,
    `Signing in opens a shell with <span class="mono">claude setup-token</span> typed in. Press Enter and sign in as that account in the browser; Episko reads the token off the screen, keeps it in your keychain and closes the shell.`);
  return `<div class="titlebox syncbox">
    ${sect("In this order", list + ext, `A new session starts on the first account that is on and not full. When every one is full, it starts on ${login}. A session never changes account while it runs.`)}
    ${found}
    ${add}
  </div>`;
}
