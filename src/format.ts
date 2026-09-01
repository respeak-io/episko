// Display formatting: data in, string out. No DOM, no Tauri; see test/format.test.ts.

// ---------- paths & escaping ----------
let HOME = ""; // set by main.ts once the backend answers; until then `tilde` is a no-op
export function setHome(h: string) { HOME = h; }

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
// `esc` leaves `"` alone (right for text nodes); a value in a double-quoted attribute needs this.
export const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
export const tilde = (p: string) => (HOME ? p.replace(HOME, "~") : p);

// A confirmation's plain-text prose → the markup ./confirm paints: a blank line starts a
// paragraph, a run of bullet-led lines is a list, backticks are code. Escaped first.
export function dialogBody(text: string): string {
  const code = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const BULLET = /^[ \t]*[•\-*][ \t]+/;
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((para) => {
      const lines = para.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return "";
      // A list only when EVERY line is a bullet; a lead-in ("Held by:") stays a paragraph.
      if (lines.every((l) => BULLET.test(l))) {
        return `<ul>${lines.map((l) => `<li>${code(l.replace(BULLET, ""))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map((l) => code(l.trim())).join("<br>")}</p>`;
    })
    .join("");
}
// Both separators, so a Windows path collapses to its leaf too.
export function basename(p: string) { const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/); return parts[parts.length - 1] || p; }

// ---------- a pane's title, off the terminal's OSC ----------

// Claude Code's OSC title leads with a spinner frame (braille, U+2733, the quadrant circles).
// A missed frame parks in the sidebar as a glyph, so whole ranges are covered.
const TITLE_DECOR = /^(?:[\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿◐-◗◴-◷\uFE0F\u200D]|\u{1F31F})+/u;

// The OSC auto-summary, unless it is just the folder we already show. Takes three fields
// rather than a `Sess` to keep ./format free of a types.ts import.
export function cleanTitle(t: string, s: { title: string; workdir: string; project: string }): string {
  const x = (t || "").replace(TITLE_DECOR, "").trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

// Elide from the middle: CSS can only cut the tail, and with worktrees the tail is the answer.
export function elidePath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const sep = p.includes("\\") && !p.includes("/") ? "\\" : "/";
  const parts = p.split(sep);
  if (parts.length < 4) return p; // no middle to drop; the CSS ellipsis is the backstop
  const tail = parts.slice(-2).join(sep);
  // An absolute path splits with an empty first segment; `parts[0] || sep` would yield `//…/x`.
  const head = parts[0] === "" ? sep + (parts[1] ?? "") : parts[0];
  const short = `${head}${sep}…${sep}${tail}`;
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
export function fmtClock(ts: number): string { return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
// Until an epoch-seconds target — "2h 10m" / "3d 4h"; the weekly window can be days out.
export function fmtUntil(ts: number): string {
  const s = Math.max(0, Math.floor(ts - Date.now() / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
// A span in seconds — "2h 10m" / "3d 4h" / "45m"; fmtUntil for a duration rather than a target.
export function fmtSpan(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
export function fmtDwell(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}:${String(ss).padStart(2, "0")}`;
}
export function fmtLatency(ms: number): string { return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms"; }
// Binary units, labelled as such; one decimal on MiB/s because 1.2 vs 4.8 is the range being read.
export function fmtRate(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KiB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MiB/s`;
}
export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb.toFixed(0)} MiB`;
}
export function fmtShort(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Headers for the tool-call sheet; minutes wide, unlike ./history's day buckets. `ms` is an age.
export function ageBucket(ms: number): string {
  const m = ms / 60000;
  if (m < 1) return "Just now";
  if (m < 5) return "Last 5 minutes";
  if (m < 30) return "Last 30 minutes";
  if (m < 60) return "Last hour";
  return "Earlier";
}

// ---------- inline charts ----------
// Fixed intrinsic size keeps the endpoint dot round; `lo`/`hi` pin the domain so the curve
// shows absolute fill, not just shape.
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
