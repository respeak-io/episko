// The usage surfaces: the forecast presentation the footer popup and the Usage
// settings tab share, and the analytics panel itself — tiles, spend heatmap,
// token bars, model/token mixes, top projects and the forecast card.
//
// The data layer — the rollup, the day/token join, the bucketing and the forecast
// maths — lives in ./usage and ./rl; everything here turns those numbers into
// markup and nothing else. No DOM is touched: every function returns a string for
// a caller to paint, which is why the module needs no seam back into main.ts.
//
// `refreshTokens` deliberately stayed behind: it is an async backend scan that
// repaints the settings dialog, so it belongs to the wiring layer. It owns the
// `tokenScanning` flag below through setTokenScanning, and the panels read it to
// decide between a skeleton and a "no data" line.

import { esc, fmtClock, fmtSpan, fmtUntil, uDelta, uTok, uUsd, uUsd2 } from "./format";
import { burnRate, D7_LEN, forecast5h, forecast7d, H5_LEN, type Forecast } from "./rl";
import { accentFor } from "./state";
import {
  tokenDays, U_MONTHS, uBuckets, uDkey, uModels, usage, usageRange, usageWindow,
  uSum, type DaySpend, type UDay,
} from "./usage";

// Plain-language forecast line for a window ("→ ~86% by reset" / "runs out …").
export function foreText(f: Forecast): string {
  if (f.used == null) return "no reading yet";
  if (!f.hasRate) return f.secLeft == null ? "no active window" : "gathering pace…";
  if (f.runsOut && f.etaSec != null && f.secLeft != null)
    return `on pace to hit 100% in ${fmtSpan(f.etaSec)} — ${fmtSpan(f.secLeft - f.etaSec)} before reset`;
  return `at this pace → ~${Math.round(f.proj!)}% by reset`;
}
// The colour-coded verdict chip (empty until we have a trustworthy rate).
export function verdictChip(f: Forecast): string {
  if (f.used == null || !f.hasRate) return "";
  if (f.status === "bad" && f.etaSec != null && f.secLeft != null)
    return `<span class="vchip s-bad">runs out ${fmtSpan(f.secLeft - f.etaSec)} early</span>`;
  if (f.status === "warn") return `<span class="vchip s-warn">tight</span>`;
  return `<span class="vchip s-ok">clear</span>`;
}
// One usage window (session/5h or weekly/7d): label, a dual-track meter (solid =
// used now, hatched = projected by reset), the forecast line, and the reset time.
export function usageRow(label: string, sub: string, f: Forecast): string {
  const cls = f.used == null ? "" : "s-" + f.status;
  const pctTxt = f.used == null ? "–" : Math.round(f.used) + "%";
  const usedW = f.used == null ? 0 : Math.min(100, Math.max(0, f.used));
  const projW = f.proj == null ? usedW : Math.min(100, Math.max(0, f.proj));
  const ghostW = Math.max(0, projW - usedW);
  const resetTxt = f.resetTs != null
    ? `resets ${fmtClock(f.resetTs)} · in ${fmtUntil(f.resetTs)}`
    : (f.used == null ? "no reading yet" : "no active window");
  return `<div class="up-row">
    <div class="up-top"><span class="up-l">${label}</span><span class="up-sub">${sub}</span><span class="up-pct ${cls}">${pctTxt}</span></div>
    <div class="up-bar ${cls}"><i class="up-fill" style="width:${usedW}%"></i><i class="up-ghost" style="left:${usedW}%;width:${ghostW}%"></i></div>
    <div class="up-fore"><span>${foreText(f)}</span>${verdictChip(f)}</div>
    <div class="up-reset">${resetTxt}</div>
  </div>`;
}
/**
 * Today's spend, split by project and by session — the popover behind the footer's
 * `today $x.xx`.
 *
 * Two rules it inherits from the dashboard's cost strip, for the same reasons:
 *
 *   • **A day with no split says so, rather than showing zeros.** `cc-usage-detail`
 *     records from the day it shipped, so an older day legitimately has a total and no
 *     breakdown — "we didn't keep this" and "it was free" are different facts.
 *   • **`unattributed` is a row, not a rounding-away.** `daySpend` puts the difference
 *     between the authoritative total and what the split accounts for on screen, so the
 *     popover can never read lower than the footer segment that opened it.
 *
 * A session still running is a button (jumping to it is the obvious next move); one that
 * has ended is a plain row, because there is nothing to jump to and a dead button that
 * looks live is worse than a line of text.
 */
export function costPopHtml(d: DaySpend, live: Set<string>): string {
  const maxP = d.projects[0]?.usd || 1;
  const rows = d.projects.map((r) => `<div class="cp-row">
      <div class="cp-top"><span class="cp-l${r.key ? "" : " cp-un"}">${esc(r.label)}</span><span class="cp-v">${uUsd2(r.usd)}</span></div>
      <div class="cp-bar"><i style="width:${Math.max(2, r.usd / maxP * 100).toFixed(1)}%;${r.key ? `background:${esc(accentFor(r.key))}` : ""}"></i></div>
    </div>`).join("");
  const sess = d.sessions.map((r) => {
    const on = live.has(r.key);
    const inner = `<span class="cp-sl">${esc(r.label)}</span><span class="cp-ss">${esc(r.sub)}</span><span class="cp-v">${uUsd2(r.usd)}</span>`;
    return on
      ? `<button class="cp-s on" data-sel="${esc(r.key)}" title="Jump to this session">${inner}</button>`
      : `<div class="cp-s">${inner}</div>`;
  }).join("");
  const nothing = !d.projects.length && !d.sessions.length;
  return `<div class="up-h">Today's spend</div>
    <div class="cp-tot">${uUsd2(d.total)}</div>
    ${rows ? `<div class="cp-lbl">By project</div>${rows}` : ""}
    ${sess ? `<div class="cp-lbl">By session</div><div class="cp-sess">${sess}</div>` : ""}
    ${nothing ? `<div class="up-note">Nothing recorded today yet. A session's spend appears here as soon as it reports one.</div>` : ""}
    ${!nothing && !d.sessions.length ? `<div class="up-note">No per-session split for this day — it predates the record.</div>` : ""}`;
}

export let tokenScanning = false;
export function setTokenScanning(v: boolean) { tokenScanning = v; }
const USAGE_RANGES: [number, string][] = [[7, "7D"], [30, "30D"], [90, "90D"], [365, "12M"]];
const MODEL_ORDER = ["Opus", "Sonnet", "Haiku", "Other"];
const MODEL_VAR: Record<string, string> = { Opus: "--m-opus", Sonnet: "--m-sonnet", Haiku: "--m-haiku", Other: "--m-other" };

const U_WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A smooth (Catmull-Rom) sparkline; long series are averaged down to ~22 points so
// a 90D/12M spark reads as a trend, not a jagged comb.
function uSpark(raw: number[], w = 64, h = 26): string {
  let series = raw;
  if (series.length > 22) {
    const size = Math.ceil(series.length / 22); const o: number[] = [];
    for (let i = 0; i < series.length; i += size) { const c = series.slice(i, i + size); o.push(c.reduce((s, v) => s + v, 0) / c.length); }
    series = o;
  }
  if (!series.length) return "";
  const max = Math.max(...series, 1), n = series.length, pad = 2.5;
  const pts = series.map((v, i) => [pad + (n <= 1 ? 0 : i / (n - 1)) * (w - pad * 2), h - pad - (v / max) * (h - pad * 2)]);
  let line = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    line += ` C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(2)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(2)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  const lastX = pts[pts.length - 1][0].toFixed(2), firstX = pts[0][0].toFixed(2);
  return `<svg class="u-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${line} L${lastX},${h} L${firstX},${h} Z" fill="var(--accent)" opacity=".1"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/><circle cx="${lastX}" cy="${pts[pts.length - 1][1].toFixed(2)}" r="2" fill="var(--accent)"/></svg>`;
}

function uTiles(): string {
  const all = usageWindow(usageRange * 2);
  const cur = all.slice(usageRange), prev = all.slice(0, usageRange);
  const mean = (a: UDay[], f: (d: UDay) => number) => a.length ? uSum(a, f) / a.length : 0;
  const sess = (a: UDay[]) => uSum(a, (d) => d.u ? d.u.sessions : 0);
  const spend = uSum(cur, (d) => d.cost), tok = uSum(cur, (d) => d.tok);
  const nSess = sess(cur), nPrev = sess(prev);
  const perSess = nSess ? tok / nSess : 0, perPrev = nPrev ? uSum(prev, (d) => d.tok) / nPrev : 0;
  const haveTok = tokenDays.length > 0; // the transcript scan populates tokens/sessions
  const tile = (label: string, val: string, foot: string, series: number[]) =>
    `<div class="u-tile"><div class="label">${label}</div><div class="u-fig mono">${val}</div><div class="u-tfoot">${foot}${uSpark(series)}</div></div>`;
  // Token/session tiles come from the (async) transcript scan: skeleton while it runs.
  const skel = `<span class="u-skel"></span>`;
  const scanFoot = `<span class="u-delta u-muted"><span class="u-spin"></span>scanning…</span>`;
  const noData = `<span class="u-delta u-muted">no data</span>`;
  const wait = (v: string, foot: string) => haveTok ? [v, foot] : [tokenScanning ? skel : "—", tokenScanning ? scanFoot : noData];
  const [tokV, tokF] = wait(uTok(tok), uDelta(mean(cur, (d) => d.tok), mean(prev, (d) => d.tok)));
  const [sesV, sesF] = wait(nSess.toLocaleString("en-US"), uDelta(nSess, nPrev));
  const [avgV, avgF] = wait(nSess ? uTok(perSess) : "—", nSess ? uDelta(perSess, perPrev) : noData);
  return `<div class="u-tiles">
    ${tile("Total spend", uUsd(spend), uDelta(mean(cur, (d) => d.cost), mean(prev, (d) => d.cost)), cur.map((d) => d.cost))}
    ${tile("Tokens processed", tokV, tokF, cur.map((d) => d.tok))}
    ${tile("Sessions", sesV, sesF, cur.map((d) => d.u ? d.u.sessions : 0))}
    ${tile("Avg / session", avgV, avgF, cur.map((d) => d.tok))}
  </div>`;
}

// The GitHub-style spend heatmap — full recorded history, range-independent.
function uHeatmap(): string {
  const DAY = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const nz = Object.values(usage).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => nz.length ? nz[Math.floor(p * (nz.length - 1))] : 0;
  const th = [q(0.20), q(0.40), q(0.62), q(0.84)];
  const level = (v: number) => v <= 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4;
  const end = today.getTime() + (6 - today.getDay()) * DAY;
  const WEEKS = 53, start = end - (WEEKS * 7 - 1) * DAY;
  let months = "", cells = "", colMonth = -1, maxKey = "", maxCost = 0;
  for (let w = 0; w < WEEKS; w++) { const m = new Date(start + w * 7 * DAY).getMonth(); months += `<span>${m !== colMonth ? U_MONTHS[m] : ""}</span>`; if (m !== colMonth) colMonth = m; }
  for (let w = 0; w < WEEKS; w++) for (let r = 0; r < 7; r++) {
    const t = start + (w * 7 + r) * DAY;
    if (t > today.getTime()) { cells += `<i class="u-cell" style="visibility:hidden"></i>`; continue; }
    const d = new Date(t), key = uDkey(d), v = usage[key] || 0;
    if (v > maxCost) { maxCost = v; maxKey = key; }
    const head = `${U_WD[d.getDay()]}, ${U_MONTHS[d.getMonth()]} ${d.getDate()}`;
    cells += `<i class="u-cell l${level(v)}" data-tip="${esc(head + "||" + (v > 0 ? uUsd2(v) : "no sessions"))}"></i>`;
  }
  const active = nz.length;
  let busiest = "—";
  if (maxKey) { const d = new Date(maxKey + "T00:00:00"); busiest = `${U_MONTHS[d.getMonth()]} ${d.getDate()} · ${uUsd2(maxCost)}`; }
  return `<section class="u-card">
    <div class="u-cardh"><div><div class="label">Daily spend</div><h3 class="u-h">Last 12 months</h3>
      <p class="u-hint">Each square is a day — darker means a heavier bill.</p></div>
      <div class="u-scale">less<i style="background:var(--u-g0)"></i><i style="background:var(--u-g1)"></i><i style="background:var(--u-g2)"></i><i style="background:var(--u-g3)"></i><i style="background:var(--u-g4)"></i>more</div></div>
    <div class="u-calwrap"><div class="u-wd"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
      <div><div class="u-months">${months}</div><div class="u-grid">${cells}</div></div></div>
    <div class="u-calfoot"><span>Busiest day <b>${busiest}</b></span><span><b>${active}</b> active days recorded</span></div>
  </section>`;
}

function uBars(): string {
  const data = uBuckets();
  const max = Math.max(...data.map((d) => d.total), 1), H = 168;
  const parts: [string, string][] = [["Haiku", "--m-haiku"], ["Sonnet", "--m-sonnet"], ["Opus", "--m-opus"], ["Other", "--m-other"]];
  const gap = data.length > 40 ? "2px" : data.length > 16 ? "4px" : "7px";
  const cols = data.map((d) => {
    let segs = "";
    for (const [m, cssvar] of parts) { const v = d.models[m] || 0; if (v > 0) segs += `<i class="u-seg" style="height:${(v / max * H).toFixed(1)}px;background:var(${cssvar})"></i>`; }
    const lines = parts.filter(([m]) => (d.models[m] || 0) > 0).map(([m]) => `${m} ${uTok(d.models[m])}`);
    const tip = [d.tip, ...lines, `Total ${uTok(d.total)}`].join("||");
    return `<div class="u-col" data-tip="${esc(tip)}"><div class="u-stack">${segs}</div></div>`;
  }).join("");
  const step = Math.ceil(data.length / 12);
  const labels = data.map((d, i) => `<span>${(i % step === 0 || i === data.length - 1) ? esc(d.label) : ""}</span>`).join("");
  const title = usageRange <= 31 ? `Last ${usageRange} days` : usageRange === 90 ? "Last 90 days · weekly" : "Last 12 months · monthly";
  const anyOther = data.some((d) => (d.models.Other || 0) > 0);
  const legModels: [string, string][] = anyOther
    ? [["Opus", "--m-opus"], ["Sonnet", "--m-sonnet"], ["Haiku", "--m-haiku"], ["Other", "--m-other"]]
    : [["Opus", "--m-opus"], ["Sonnet", "--m-sonnet"], ["Haiku", "--m-haiku"]];
  const legend = legModels.map(([m, c]) => `<span class="u-lg"><i style="background:var(${c})"></i>${m}</span>`).join("");
  const empty = !data.some((d) => d.total > 0);
  const plot = empty && tokenScanning
    ? `<div class="u-skelbar" style="height:${H}px"></div>`
    : `<div class="u-plot"><div class="u-glabel mono">${uTok(max)}</div><div class="u-bars" style="--barsgap:${gap}">${cols}</div></div>
       <div class="u-xlabels" style="--barsgap:${gap}">${labels}</div>`;
  return `<section class="u-card">
    <div class="u-cardh"><div><div class="label">Daily tokens by model</div><h3 class="u-h">${title}</h3></div><div class="u-legend">${legend}</div></div>
    ${plot}
  </section>`;
}

function uModelMix(): string {
  const models = uModels(usageWindow(usageRange));
  const total = models.Opus + models.Sonnet + models.Haiku + models.Other;
  const rows = MODEL_ORDER.filter((m) => models[m] > 0).map((m) => {
    const v = models[m], pct = total ? v / total * 100 : 0;
    return `<div class="u-srow"><div class="u-stop"><span class="u-sw" style="background:var(${MODEL_VAR[m]})"></span><span class="u-snm">${m}</span><span class="u-susd mono">${uTok(v)}</span></div><div class="u-strack"><i style="width:${pct.toFixed(1)}%;background:var(${MODEL_VAR[m]})"></i></div></div>`;
  }).join("");
  const body = total > 0
    ? `<div class="u-share">${rows}</div>`
    : `<p class="u-hint">${tokenScanning ? "Scanning transcripts…" : "No token data in range yet."}</p>`;
  return `<div class="label">Model mix <span class="u-byline">· by tokens</span></div>${body}`;
}

function uTokenMix(): string {
  const cur = usageWindow(usageRange);
  let inp = 0, out = 0, cr = 0, cw = 0;
  const tk = new Map(tokenDays.map((t) => [t.day, t]));
  for (const d of cur) { const t = tk.get(d.key); if (t) { inp += t.input; out += t.output; cr += t.cache_read; cw += t.cache_write; } }
  const total = inp + out + cr + cw;
  if (!total) {
    const body = tokenScanning
      ? `<div class="u-skelbar"></div><p class="u-hint"><span class="u-spin"></span> Scanning transcripts for token history…</p>`
      : `<p class="u-hint">No token data in range yet.</p>`;
    return `<div class="label" style="margin-top:15px">Token composition</div>${body}`;
  }
  const bar = ([["Cache read", cr, "--u-t4"], ["Cache write", cw, "--u-t3"], ["Input", inp, "--u-t2"], ["Output", out, "--u-t1"]] as [string, number, string][])
    .map(([, v, c]) => v > 0 ? `<i style="width:${(v / total * 100).toFixed(2)}%;background:var(${c})"></i>` : "").join("");
  const leg = ([["Cache read", cr, "--u-t4"], ["Input", inp, "--u-t2"], ["Output", out, "--u-t1"], ["Cache write", cw, "--u-t3"]] as [string, number, string][])
    .map(([nm, v, c]) => `<div><i style="background:var(${c})"></i>${nm}<b>${Math.round(v / total * 100)}%</b></div>`).join("");
  return `<div class="label" style="margin-top:15px">Token composition</div><div class="u-mix">${bar}</div><div class="u-mixleg">${leg}</div>
    <div class="u-insight"><b>~${Math.round(cr / total * 100)}% of tokens are cache reads</b> — most context is reused, not re-billed. Big token counts, cheap dollars.</div>`;
}

function uProjects(): string {
  const cur = usageWindow(usageRange);
  const proj: Record<string, number> = {};
  // `projects` can be absent on DayUsage entries written by an older cc-usage-tokens
  // cache (the field was added after the scan shipped) — guard, or Object.entries throws.
  for (const d of cur) if (d.u) for (const [p, v] of Object.entries(d.u.projects || {})) proj[p] = (proj[p] || 0) + v;
  const entries = Object.entries(proj).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) return `<section class="u-card"><div class="label">Top projects</div><p class="u-hint">${tokenScanning ? "Scanning transcripts…" : "No token data in range yet."}</p></section>`;
  const maxw = entries[0][1] || 1;
  const rows = entries.map(([p, v]) => `<tr><td><span class="u-pj"><span class="u-dot" style="background:${accentFor(p)}"></span>${esc(p)}</span></td><td class="u-num"><span class="u-pjbar"><i style="width:${(v / maxw * 100).toFixed(0)}%"></i></span></td><td class="u-num"><span class="u-usd mono">${uTok(v)}</span></td></tr>`).join("");
  return `<section class="u-card"><div class="u-cardh"><div><div class="label">Attribution</div><h3 class="u-h">Top projects</h3></div><p class="u-hint" style="margin-top:5px">by tokens · working directory</p></div>
    <table class="u-tbl"><thead><tr><th>Project</th><th class="u-num">Share</th><th class="u-num">Tokens</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

// One window of the Usage-tab forecast card: current %, verdict, dual-track meter,
// a timeline with the projected run-out marker, the raw numbers, and a plain-English
// recommendation. Reads the same forecast()/burnRate() the footer & popup use.
function fcWinHtml(name: string, sub: string, f: Forecast, burnPerHr: number | null, len: number, burnUnit: string): string {
  const cls = f.used == null ? "" : "s-" + f.status;
  const pctTxt = f.used == null ? "–" : Math.round(f.used) + "%";
  const usedW = f.used == null ? 0 : Math.min(100, Math.max(0, f.used));
  const projW = f.proj == null ? usedW : Math.min(100, Math.max(0, f.proj));
  const ghostW = Math.max(0, projW - usedW);
  const elapsed = f.secLeft != null ? len - f.secLeft : 0;
  const elapsedPct = Math.min(100, Math.max(0, elapsed / len * 100));
  const outPct = (f.runsOut && f.etaSec != null && f.secLeft != null)
    ? Math.min(100, Math.max(0, (elapsed + f.etaSec) / len * 100)) : null;
  const vc = verdictChip(f);
  const verdict = (f.used != null && f.used >= 100) ? `<span class="vchip s-bad">at cap</span>`
    : vc || `<span class="vchip s-mut">level only</span>`;
  const burnTxt = burnPerHr == null ? "—" : `${burnPerHr.toFixed(burnPerHr < 10 ? 1 : 0)} <small>${burnUnit}</small>`;
  const etaTxt = (f.runsOut && f.etaSec != null && f.etaSec > 0) ? `${fmtSpan(f.etaSec)} <small>to cap</small>` : "—";
  const projTxt = f.proj == null ? "—" : `~${Math.round(f.proj)}%`;
  const resetInTxt = f.resetTs != null ? fmtUntil(f.resetTs) : "—";
  let rec: string;
  if (f.used == null) rec = `<span class="fc-recic">·</span><div>No reading yet — appears once a running session reports a statusLine.</div>`;
  else if (f.used >= 100) rec = `<span class="fc-recic">✕</span><div><b>At the cap</b> — new work on this window is blocked until it resets${f.resetTs != null ? " in " + fmtUntil(f.resetTs) : ""}.</div>`;
  else if (!f.hasRate) rec = `<span class="fc-recic">·</span><div>Gathering pace — the forecast sharpens after a few statusLine ticks. Showing level only for now.</div>`;
  else if (f.status === "bad") rec = `<span class="fc-recic">✕</span><div>On this pace you'll be <b>locked out ~${fmtSpan(f.secLeft! - f.etaSec!)} before reset</b>. Ease off, or move work to the other window.</div>`;
  else if (f.status === "warn") rec = `<span class="fc-recic">!</span><div>On track for <b>~${Math.round(f.proj!)}%</b> by reset — you can keep going, but there isn't much slack.</div>`;
  else rec = `<span class="fc-recic">✓</span><div>Comfortable — projected <b>~${Math.round(f.proj!)}%</b> at reset. Nothing to manage here.</div>`;
  return `<div class="fc-win">
    <div class="fc-head"><span class="fc-name">${name}</span><span class="fc-wsub">${sub}</span></div>
    <div class="fc-big"><span class="fc-num ${cls}">${pctTxt}</span><span class="fc-of">used</span>${verdict}</div>
    <div class="fc-bar ${cls}"><i class="up-fill" style="width:${usedW}%"></i><i class="up-ghost" style="left:${usedW}%;width:${ghostW}%"></i></div>
    <div class="fc-scale"><span>0%</span><span>▨ projected by reset</span><span>100%</span></div>
    <div class="fc-tl">
      <div class="fc-tlab"><span>window opened</span><span>resets ${f.resetTs != null ? fmtClock(f.resetTs) : "—"}</span></div>
      <div class="fc-tltrack"><i class="fc-tlel" style="width:${elapsedPct}%"></i><i class="fc-tlnow" style="left:${elapsedPct}%"></i>${outPct != null ? `<i class="fc-tlout" style="left:${outPct}%"></i>` : ""}<span class="fc-tlreset">${resetInTxt} left</span></div>
    </div>
    <div class="fc-stats">
      <div class="fc-stat"><div class="fc-k">Burn rate</div><div class="fc-v">${burnTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Projected @ reset</div><div class="fc-v ${cls}">${projTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Time to cap</div><div class="fc-v">${etaTxt}</div></div>
      <div class="fc-stat"><div class="fc-k">Resets in</div><div class="fc-v">${resetInTxt}</div></div>
    </div>
    <div class="fc-rec">${rec}</div>
  </div>`;
}
function forecastBlockHtml(): string {
  const b7 = burnRate("d7");
  return `<div class="fc-block">
    <div class="label">Forecast <span class="fc-hint">· will you hit a limit before it resets?</span></div>
    <div class="fc-grid">
      ${fcWinHtml("Session", "5-hour window", forecast5h(), burnRate("h5"), H5_LEN, "%/hr")}
      ${fcWinHtml("Weekly", "7-day window", forecast7d(), b7 == null ? null : b7 * 24, D7_LEN, "%/day")}
    </div>
  </div>`;
}
export function usagePanelHtml(): string {
  const ranges = USAGE_RANGES.map(([n, l]) => `<button class="u-rbtn${n === usageRange ? " on" : ""}" data-urange="${n}">${l}</button>`).join("");
  return `<div class="u-pane">
    <header class="u-paneh"><div><div class="label">Analytics</div><h2 class="u-title">Usage &amp; spend</h2>
      <p class="u-hint">Every session Episko launches, account-wide. History stays on this machine.</p></div>
      <div class="u-range">${ranges}</div></header>
    ${uTiles()}
    ${forecastBlockHtml()}
    ${uHeatmap()}
    <div class="u-cols">${uBars()}<section class="u-card">${uModelMix()}${uTokenMix()}</section></div>
    ${uProjects()}
  </div>`;
}
