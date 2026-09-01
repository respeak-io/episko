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
/// `esc` for a value going into a double-quoted **attribute**. `esc` is tuned for text
/// nodes and leaves `"` alone, which is right everywhere it is used on visible content
/// and wrong the moment the string is user data in an attribute: the inspector's file
/// rows carry a path straight off a hook payload into `data-fopen="…"`, and a quote in
/// a filename is legal on both mainstream filesystems. One would close the attribute
/// early and swallow the rest of the row's markup.
export const escAttr = (s: string) => esc(s).replace(/"/g, "&quot;");
export const tilde = (p: string) => (HOME ? p.replace(HOME, "~") : p);

/**
 * A confirmation's prose → the markup the in-app dialog paints (./confirm).
 *
 * The messages this renders were written for the OS dialog `ask()` used to put them
 * in, so they are plain text: a blank line between paragraphs, a bullet in front of a
 * list item. They stay that way. Owning the box does not make the wording ours to
 * re-punctuate, and a formatter that reads what is already written is one fewer place
 * for the two halves to drift apart.
 *
 * Three things only, because three is what those messages use:
 *   - a blank line starts a paragraph
 *   - a run of bullet-led lines is a list (the bullet itself is dropped, since `<li>`
 *     draws its own and two bullets on one row is the tell that a list was faked)
 *   - backticked text is code, which is how a command or a path gets named mid-sentence
 *
 * Escaped FIRST, so nothing in a branch name, a path or an agent's task label can reach
 * the DOM as markup. These strings are assembled from repo data, and a branch name is
 * whatever somebody typed.
 */
export function dialogBody(text: string): string {
  const code = (s: string) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const BULLET = /^[ \t]*[•\-*][ \t]+/;
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((para) => {
      const lines = para.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) return "";
      // A paragraph is a list only when EVERY line is a bullet; a lead-in above them
      // ("Held by:") is its own paragraph and keeps its own line.
      if (lines.every((l) => BULLET.test(l))) {
        return `<ul>${lines.map((l) => `<li>${code(l.replace(BULLET, ""))}</li>`).join("")}</ul>`;
      }
      // A single newline inside one paragraph is the author's own line break (a path
      // on a line of its own), not the start of a new thought.
      return `<p>${lines.map((l) => code(l.trim())).join("<br>")}</p>`;
    })
    .join("");
}
// Split on both separators so Windows paths (E:\proj\sub) collapse to the leaf,
// not the whole string — otherwise the sidebar shows the full path as the name.
export function basename(p: string) { const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/); return parts[parts.length - 1] || p; }

// ---------- a pane's title, off the terminal's OSC ----------

/// The leading decoration Claude Code puts in front of its OSC title.
///
/// It animates a spinner there — braille dots (U+2800–U+28FF), an eight-spoked
/// asterisk (U+2733), and since **2.1.250** the quadrant circles ◐◑◒◓ (U+25D0–U+25D3)
/// — so the raw title arrives as a frame of animation followed by the summary. We
/// strip any leading run of it and keep the summary; our own status is the row's
/// coloured `.sglyph`, which is a steadier thing to read.
///
/// **This is a table that tracks somebody else's release, so it lives here rather than
/// in the DOM layer and it is tested.** Each time it has fallen behind, the symptom has
/// been the same and has read as an Episko bug: a spinner frame parked in the sidebar.
/// Missing the braille range left the glyph flickering; missing U+25D0 put a `◐` in
/// front of every title the day 2.1.250 shipped — and `◐` is also Episko's own
/// `background` glyph, so the leak read as "this session has background agents up".
/// The quadrant ranges below are covered whole (U+25D0–U+25D7, U+25F4–U+25F7) rather
/// than frame by frame, so the next rotation through that family costs nothing.
/// A class *source* rather than a regex literal, because `titleDecor` concatenates the
/// user's additions onto it. One spelling — a literal kept alongside it for the empty
/// case would be a second copy of this list to update.
const TITLE_DECOR_CLASS = "\\s•·∙⋅●○◦◆◇✦✧★☆✨✩-✷✺-✽∗＊*⏺⬤⭐⠀-⣿◐-◗◴-◷\\uFE0F\\u200D";

/// What the user added to the table above, and whether it is applied at all.
///
/// The built-in list is the baseline and is **not** editable: `extra` only ever adds,
/// so the worst a bad value does is strip one character too many. A field that could
/// remove from it would give "my titles went strange" two possible causes.
export interface TitlePrefs {
  /// Off shows the OSC title as the terminal sent it. The folder-echo rule below is
  /// unaffected — that is a different question and not about somebody's animation.
  scrub: boolean;
  /// `◐-◗ ◴-◷ ✦✧` — characters and `a-b` ranges, whitespace ignored. Parsed by
  /// `titleExtra`; malformed input is dropped rather than throwing, since this is a
  /// field somebody is mid-typing in.
  extra: string;
}

export const TITLE_DEFAULTS: TitlePrefs = { scrub: true, extra: "" };
/// Room for ~30 ranges. It exists because the value is compiled into a RegExp and this
/// is a field somebody can paste a whole file into.
export const TITLE_EXTRA_MAX = 120;

export function clampTitlePrefs(p: Partial<TitlePrefs> | null | undefined): TitlePrefs {
  return {
    // `!== false`, like every shipped-on preference: an absent key lands on the default.
    scrub: p?.scrub !== false,
    extra: typeof p?.extra === "string" ? p.extra.slice(0, TITLE_EXTRA_MAX) : "",
  };
}

/// Parse `extra` into codepoint pairs — `[from, to]`, a single character being `[c, c]`.
/// Exported because the settings preview shows **what it understood**, not what was
/// typed: `◐-◗` is three characters and eight codepoints of meaning.
export function titleExtra(extra: string): [number, number][] {
  const cps = [...(extra || "")].map((c) => c.codePointAt(0)!);
  const out: [number, number][] = [];
  for (let i = 0; i < cps.length;) {
    // A separator, never a member: the built-in class already covers `\s`.
    if (/\s/u.test(String.fromCodePoint(cps[i]))) { i++; continue; }
    const dash = cps[i + 1] === 0x2d || cps[i + 1] === 0x2013 || cps[i + 1] === 0x2014;
    const end = cps[i + 2];
    if (dash && end !== undefined && !/\s/u.test(String.fromCodePoint(end))) {
      // Swap an inverted range rather than dropping it: `◗-◐` can only have meant the
      // same eight codepoints, and an empty result for a value that looks right is the
      // least diagnosable outcome available.
      out.push(cps[i] <= end ? [cps[i], end] : [end, cps[i]]);
      i += 3;
      continue;
    }
    out.push([cps[i], cps[i]]);
    i++;
  }
  return out;
}

/// The compiled prefix matcher: the built-in class plus whatever `extra` parsed to.
///
/// Every added codepoint is emitted as a `\u{…}` escape rather than as itself, which is
/// what makes a raw text field safe to concatenate into a character class — `]`, `^`,
/// `\` and `-` would otherwise change the *shape* of the class rather than joining it,
/// and one of them is the range syntax this field invites people to type.
const decorRe = (added: string) => new RegExp(`^(?:[${TITLE_DECOR_CLASS}${added}]|\\u{1F31F})+`, "u");
/// The built-in table alone, and the fallback when an addition will not compile.
const TITLE_DECOR = decorRe("");
const decorCache = new Map<string, RegExp>();
export function titleDecor(extra: string): RegExp {
  const hit = decorCache.get(extra);
  if (hit) return hit;
  const u = (c: number) => `\\u{${c.toString(16)}}`;
  const added = titleExtra(extra).map(([a, b]) => (a === b ? u(a) : `${u(a)}-${u(b)}`)).join("");
  let re = TITLE_DECOR;
  if (added) {
    // The escaping makes a failure unlikely, but this runs on a title change and the
    // alternative to a fallback is a pane that stops updating.
    try { re = decorRe(added); } catch { re = TITLE_DECOR; }
  }
  // Bounded: the key is a text field, so Settings recompiles on every keystroke.
  if (decorCache.size > 32) decorCache.clear();
  decorCache.set(extra, re);
  return re;
}

/// Claude Code sets the terminal title (OSC) to an auto-summary; keep it unless it's
/// just the folder path/name (which we already show).
///
/// Takes the three fields it reads rather than a whole `Sess`, which keeps ./format
/// free of a types.ts import — a `Sess` satisfies it structurally, so the call sites
/// still pass one.
export function cleanTitle(
  t: string,
  s: { title: string; workdir: string; project: string },
  prefs: TitlePrefs = TITLE_DEFAULTS,
): string {
  const raw = t || "";
  const x = (prefs.scrub ? raw.replace(titleDecor(prefs.extra), "") : raw).trim();
  if (!x) return s.title;
  if (x === s.workdir || x === tilde(s.workdir) || x === s.project || x === basename(s.workdir)) return "";
  return x;
}

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

/// A recency band, for grouping a list under time headers — the tool-call sheet's left
/// column, where a dozen calls can span ten seconds or two hours and the gaps between
/// them are the shape of the turn.
///
/// The bands are minutes wide rather than days, unlike the day buckets in ./history:
/// this groups one session's calls, and "Today" over all twelve of them would be a
/// divider that never divides anything. `ms` is an **age**, not a timestamp.
///
/// A row does drift from one band to the next while you watch it, which is correct and
/// is why the sheet's list is repainted rather than frozen.
export function ageBucket(ms: number): string {
  const m = ms / 60000;
  if (m < 1) return "Just now";
  if (m < 5) return "Last 5 minutes";
  if (m < 30) return "Last 30 minutes";
  if (m < 60) return "Last hour";
  return "Earlier";
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
