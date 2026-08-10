// Display formatting: durations, paths, escaping, small inline charts, money and
// token counts. Every function here turns data into a string and nothing else —
// no DOM, no Tauri, no app state beyond the home dir `tilde` abbreviates against
// — so it can be unit-tested in isolation, like ./diff. See test/format.test.ts.

// ---------- paths & escaping ----------
// The user's home directory, for `~` path abbreviation. It resolves at runtime
// (an async backend call), so main.ts's bootstrap hands it over via setHome once
// it lands; until then `tilde` is a no-op and paths simply show in full.
let HOME = "";
export function setHome(h: string) { HOME = h; }

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export const tilde = (p: string) => (HOME ? p.replace(HOME, "~") : p);
// Split on both separators so Windows paths (E:\proj\sub) collapse to the leaf,
// not the whole string — otherwise the sidebar shows the full path as the name.
export function basename(p: string) { const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/); return parts[parts.length - 1] || p; }

/// Shorten a path from the *middle*, keeping the head and the last two segments.
///
/// CSS `text-overflow` can only elide the tail, which for a path drops the only part
/// that identifies it: `~/prog/work/.cc-worktrees/pii-reduction/feat-platform-…`
/// tells you nothing that `~/prog/work/…/pii-reduction/feat-platform-groundwork`
/// doesn't, and loses which checkout you are about to run in. With worktrees that
/// tail *is* the answer, so it is what survives.
export function elidePath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  const parts = p.split(sep);
  // Fewer than four segments has no middle to drop; a long single segment (a deep
  // slugified branch dir) can't be helped by re-splitting it, so leave it whole and
  // let the CSS ellipsis be the backstop.
  if (parts.length < 4) return p;
  const tail = parts.slice(-2).join(sep);
  // An absolute path splits with an empty first segment, so the head is the root
  // plus the segment after it — using `parts[0] || sep` instead yields `//…/x`.
  const head = parts[0] === "" ? sep + (parts[1] ?? "") : parts[0];
  const short = `${head}${sep}…${sep}${tail}`;
  // Only worth it if it actually saved something.
  return short.length < p.length ? short : p;
}

// ---------- colour ----------
export function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  const to = (x: number) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

// ---------- durations ----------
export function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (!(ms > 0) || d < 0) return "—";
  const m = Math.round(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
export function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${String(ss).padStart(2, "0")}s`;
}
// Absolute wall-clock time of a reset (epoch seconds) — "15:45" / "3:45 PM".
export function fmtClock(ts: number): string { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
// Time remaining until a reset (epoch seconds) — "2h 10m" / "3d 4h". The weekly
// window can be days out, where fmtClock's time-of-day alone would be misleading.
export function fmtUntil(ts: number): string {
  const s = Math.max(0, Math.floor(ts - Date.now() / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// A raw duration (seconds) — "2h 10m" / "3d 4h" / "45m". Like fmtUntil but for a
// span we already hold, not a wall-clock target (used for forecast etas/headroom).
export function fmtSpan(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// Compact seconds → "M:SS" (under an hour) / "Hh Mm" — the dwell + wait clocks.
export function fmtDwell(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}:${String(ss).padStart(2, "0")}`;
}
export function fmtLatency(ms: number): string { return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms"; }
/// A disk-I/O rate, in the unit a human reads it in. Whole bytes and whole KiB — a
/// fractional B/s is noise — but MiB/s keeps one decimal, because that is the range
/// where the difference between 1.2 and 4.8 is the thing you are looking at.
///
/// **Binary units, and labelled as such.** These divide by 1024, so they were always
/// KiB and MiB; calling them KB/MB understated every figure by 2.4% and 4.9%. The
/// source is a byte counter, so the binary unit is the honest one — the label moved to
/// meet the arithmetic rather than the other way round.
export function fmtRate(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KiB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MiB/s`;
}
/// A size already in MiB, promoted to GiB once it stops being readable as MiB. Same
/// binary-unit reasoning as `fmtRate` above — at GiB the mislabel was worth 7.4%.
export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb.toFixed(0)} MiB`;
}
export function fmtShort(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ---------- inline charts ----------
// A mini area+line sparkline as an inline SVG. Fixed intrinsic size so the endpoint
// dot stays round; scales down within its card. `lo`/`hi` pin the domain (context
// uses 0–100; cost uses 0–max) so the curve reflects absolute fill, not just shape.
export function sparkline(vals: number[], opts: { lo?: number; hi?: number } = {}): string {
  const w = 108, h = 24, pad = 3;
  if (vals.length < 2) return "";
  const lo = opts.lo ?? Math.min(...vals);
  let hi = opts.hi ?? Math.max(...vals);
  if (hi <= lo) hi = lo + 1;
  const n = vals.length;
  const px = (i: number) => (i / (n - 1)) * (w - pad);
  const py = (v: number) => h - pad - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (h - pad * 2);
  const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const area = `${line} L${px(n - 1).toFixed(1)},${h} L0,${h} Z`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}"><path class="spk-a" d="${area}"></path><path class="spk-l" d="${line}"></path><circle class="spk-d" cx="${px(n - 1).toFixed(1)}" cy="${py(vals[n - 1]).toFixed(1)}" r="2.1"></circle></svg>`;
}

// ---------- money & tokens (the usage panel) ----------
export const uUsd = (n: number) => n >= 10000 ? "$" + (n / 1000).toFixed(1) + "k" : "$" + Math.round(n).toLocaleString();
export const uUsd2 = (n: number) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const uTok = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n));
export function uDelta(cur: number, prev: number): string {
  if (prev <= 0) return `<span class="u-delta u-muted">new</span>`;
  const pct = Math.round((cur - prev) / prev * 100);
  return `<span class="u-delta"><span class="u-arw">${pct >= 0 ? "▲" : "▼"}</span><b>${Math.abs(pct)}%</b>&nbsp;vs&nbsp;prev</span>`;
}
