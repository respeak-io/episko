// The Diagnostics tab's model: what the frontend records about its own weight, what
// those numbers mean, and the two knobs that change behaviour rather than observe it.
//
// This exists because of a bug shape the rest of the app has no answer for. Episko is
// meant to be left up for days, and after roughly fifteen hours with a fleet of panes
// the webview's renderer saturates a core: every hover and click lags until the page is
// reloaded, which frees ~130MB and costs no sessions (the backend holds the PTYs and
// `adoptOrphans` re-adopts the panes). Every *snapshot* of that state looks fine. The
// debug console's `dbgSnapshot` is state-of-now by construction, so nothing in it can
// ever show a counter that has been climbing since breakfast — and by the time the app
// is slow enough to investigate, the only honest move is the reload that destroys the
// evidence.
//
// So the thing worth building is not another readout. It is a **time series that is
// already running before anybody notices**: one sample every few minutes, teed into the
// rolling `episko.log` where it survives a crash and a reload, so the question "which
// number grew overnight?" is answered by `grep vitals` rather than by catching the app
// in the act. Recording is what makes a slow leak findable at all; that is why it is one
// switch and not a mode you have to remember to enter.
//
// Pure logic, no DOM and no Tauri — ./debug reads the live values (it is the module that
// already owns both the snapshot and the log tee) and hands them here. The split matters
// for one reason beyond the usual: sampling touches `document` and `performance.memory`,
// which vitest's node environment does not have, and the interesting half is what the
// numbers *mean*, which is testable exactly because it never looks at them itself.

/// What kind of question a counter answers — and therefore what it is allowed to accuse.
///
/// The distinction is the whole reason this table exists rather than a flat list of
/// numbers. A **growth** counter has no ceiling, so a steady climb is a leak. A **level**
/// is bounded by design (a cap, a pool, the size of the fleet), so its value is worth
/// seeing and its slope means nothing — reporting one as a leak would be the health.ts
/// mistake of a rule that fires on ordinary behaviour, and here it would fire on the
/// structures already ruled out by measurement. A **rate** is a monotonic total whose
/// only meaningful form is per-hour; it always climbs, and saying so is noise.
export type VitalKind = "growth" | "level" | "rate";

/// One sample's counters. Ordered as the table below lists them, which is the order the
/// log line writes and the readout draws — there is no second list to fall out of step.
export interface VitalCounts {
  dom: number;
  heapMB: number;
  canvases: number;
  files: number;
  servers: number;
  termLines: number;
  panes: number;
  gl: number;
  acts: number;
  hist: number;
  paints: number;
  events: number;
}
export type VitalId = keyof VitalCounts;

/// A sample: the counters, when they were taken, and how long the *page* had been up.
///
/// `upMs` is page uptime rather than process uptime, and the difference is the point: a
/// reload is the workaround for this bug, so a series that spanned one would otherwise
/// show every growth counter dropping to zero and read as a fix. A drop in `upMs`
/// between two samples is how a consumer knows the series restarted.
export interface Vitals extends VitalCounts { t: number; upMs: number }

export interface VitalDef {
  id: VitalId;
  /// The key written into the log line. Short on purpose: this is grepped, not read.
  key: string;
  label: string;
  kind: VitalKind;
  /// Per hour, what a genuine leak looks like in this counter. `growth` only — the two
  /// other kinds must never carry one, which `leakSuspects` relies on.
  climb?: number;
  hint: string;
}

/// Every counter, why it is here, and (for the five that can accuse) what rate of climb
/// is worth naming. The thresholds are set from the one measured incident rather than
/// from taste: a reload freed ~130MB after ~15h, so a heap climbing 4MB/h reproduces it,
/// and the DOM and canvas numbers are scaled to "visible cost within a day".
export const VITALS: readonly VitalDef[] = [
  {
    id: "dom", key: "dom", label: "DOM nodes", kind: "growth", climb: 200,
    hint: "Every element in the document. renderAll rebuilds markup in place, so a steady climb means something is being appended and never removed — the shape a detached-node leak takes.",
  },
  {
    id: "heapMB", key: "heap", label: "JS heap", kind: "growth", climb: 4,
    hint: "Megabytes of live JavaScript. The measured incident freed about 130MB on reload after fifteen hours, which is this counter at roughly 9MB an hour.",
  },
  {
    id: "canvases", key: "canvas", label: "Canvases", kind: "growth", climb: 1,
    hint: "xterm's WebGL renderer draws into a handful of canvases per pane and the pool caps live contexts at eight. This is bounded in a healthy app, so anything that climbs is an addon that was never disposed.",
  },
  {
    id: "files", key: "files", label: "Context files", kind: "growth", climb: 500,
    hint: "One entry per path every session has read, edited or created. Bounded by the size of the projects in practice, not by a cap.",
  },
  {
    id: "servers", key: "srv", label: "Background shells", kind: "growth", climb: 5,
    hint: "Every shell the agents have backgrounded in this pane, running or not: an ended record is kept on purpose — a crashed server must not vanish off the count — and only a dismissed row leaves. So this rises with the number of shells started, never with how many are still up, and it is a leak only if it climbs while nothing is being backgrounded.",
  },
  {
    id: "termLines", key: "term", label: "Scrollback lines", kind: "level",
    hint: "Lines held across every pane's terminal buffer. Bounded by the scrollback setting times the number of panes, so it saturates rather than leaks — but the ceiling itself is worth seeing, because it is the largest single thing a long-lived fleet holds.",
  },
  { id: "panes", key: "panes", label: "Panes", kind: "level", hint: "Open sessions. The denominator for everything above." },
  { id: "gl", key: "gl", label: "WebGL contexts", kind: "level", hint: "Panes currently holding a pooled renderer. Capped at eight by design." },
  {
    id: "acts", key: "acts", label: "Timeline rows", kind: "level",
    hint: "Tool calls held across every session's activity timeline. Capped per session, and already ruled out by measurement — recorded so a regression in that cap would be visible rather than suspected.",
  },
  {
    id: "hist", key: "hist", label: "Sparkline points", kind: "level",
    hint: "Context and cost history points across the fleet. Capped per session, like the timeline above, and here for the same reason.",
  },
  { id: "paints", key: "paints", label: "Paints", kind: "rate", hint: "renderAll passes that actually painted. Coalesced to one per animation frame, so this should stay well under the event rate." },
  { id: "events", key: "ev", label: "Telemetry events", kind: "rate", hint: "Hook and statusLine payloads received. The load the app is actually under, and what the paint rate has to be read against." },
];

const BY_ID = new Map<VitalId, VitalDef>(VITALS.map((v) => [v.id, v]));

// ---------- the two preferences ----------

/// How often to sample, in milliseconds. Three choices rather than a stepper, because
/// the honest range is narrow: below a minute the series is mostly noise from a single
/// busy turn, and above a quarter of an hour a fifteen-hour incident lands in sixty
/// points, which is too coarse to see where a climb began.
export const VITALS_EVERY = [60_000, 300_000, 900_000] as const;
export const VITALS_DEFAULTS = { enabled: false, everyMs: 300_000 } as const;

export interface VitalsPrefs { enabled: boolean; everyMs: number }

/// Ships **off**, and that is a real cost worth stating: the first time anybody hits this
/// bug they will have no series, and the honest answer is "switch it on and come back
/// tomorrow". It stays off anyway, on the same rule as the sound alerts — a feature that
/// writes to a log file on a timer, forever, on every install, to serve a fault most
/// users will never see, is not something to turn on by default. What the tab owes in
/// exchange is saying plainly that it has to be armed *before* the day it is needed.
export function clampVitalsPrefs(p: Partial<VitalsPrefs> | null | undefined): VitalsPrefs {
  const every = Number(p?.everyMs);
  return {
    enabled: p?.enabled === true,
    everyMs: (VITALS_EVERY as readonly number[]).includes(every) ? every : VITALS_DEFAULTS.everyMs,
  };
}
export function vitalsPrefsJson(p: VitalsPrefs): string { return JSON.stringify(p); }

/// How many samples to keep in memory. A day at the coarsest cadence, or four hours at
/// the finest — the ring is only what the readout draws, since the durable series is the
/// log file and is not bounded by anything here.
export const VITALS_CAP = 300;

/// Terminal scrollback, in lines per pane.
///
/// A knob rather than a constant because it is the one number here that changes the
/// app's weight instead of measuring it: eight thousand lines across a fleet is the
/// largest structure a long-lived session holds, and `trimScrollback` only ever reclaims
/// it from panes that have *ended*. Dialling it down is both a way to test whether that
/// is what goes wrong overnight and, if it is, the fix.
export const SCROLLBACK_OPTS = [1000, 4000, 8000] as const;
export const SCROLLBACK_DEFAULT = 8000;

/// Snap to a known option. An unknown value falls back to the shipped default rather
/// than to the nearest neighbour: this is read at module scope from a hand-editable
/// store, and silently honouring `50` would give somebody a terminal with no history and
/// no clue why.
export function clampScrollback(raw: unknown): number {
  const n = Number(raw);
  return (SCROLLBACK_OPTS as readonly number[]).includes(n) ? n : SCROLLBACK_DEFAULT;
}

// ---------- the series ----------

/// Append a sample, dropping the oldest past the cap. Mutates, like ./debug's own event
/// ring it sits beside, because the caller owns one long-lived array for the session.
export function pushVitals(ring: Vitals[], v: Vitals, cap = VITALS_CAP): void {
  ring.push(v);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

/// The one line written to `episko.log`, and the only durable form of any of this.
///
/// Compact `key=value` pairs behind a fixed `vitals` prefix, so a day of them is one
/// `grep vitals episko.log` away from a table — and stable in field order and spelling,
/// because the consumer is a person with a terminal or an agent reading the log, and
/// either will be diffing lines written hours apart by two different runs.
export function vitalsLine(v: Vitals): string {
  const fields = VITALS.map((d) => `${d.key}=${v[d.id]}`).join(" ");
  return `vitals up=${Math.round(v.upMs / 60_000)}m ${fields}`;
}

export interface DriftRow {
  id: VitalId; label: string; kind: VitalKind;
  first: number; last: number; delta: number;
  /// Change per hour. For a `rate` counter this is the rate itself, which is the only
  /// form it has ever meant anything in.
  perHour: number;
  /// Growth as a share of where it started, or null when it started at zero — where a
  /// percentage is either infinite or a lie.
  pct: number | null;
}
export interface VitalsDrift { spanMs: number; samples: number; reloaded: boolean; rows: DriftRow[] }

/// Below half an hour, no verdict. Two samples ten minutes apart across one busy turn
/// can show any counter climbing at an alarming rate, and a diagnostic that cries leak
/// on its first reading teaches you to close the tab.
export const MIN_SPAN_MS = 30 * 60_000;

/// First sample against last. Deliberately not a regression or a windowed slope: the
/// question this feature exists to answer is "is the app heavier than it was this
/// morning", and endpoints answer exactly that without inventing a confidence nobody
/// asked for.
export function vitalsDrift(ring: readonly Vitals[]): VitalsDrift | null {
  if (ring.length < 2) return null;
  const a = ring[0], b = ring[ring.length - 1];
  const spanMs = b.t - a.t;
  if (spanMs <= 0) return null;
  const hours = spanMs / 3_600_000;
  return {
    spanMs, samples: ring.length,
    // A page uptime that went backwards means the webview reloaded inside this window,
    // so the growth counters restarted from nothing and every delta below spans two
    // different lives of the page. Reported rather than repaired: the caller can say so.
    reloaded: b.upMs < a.upMs,
    rows: VITALS.map((d) => {
      const first = a[d.id], last = b[d.id];
      const delta = last - first;
      return {
        id: d.id, label: d.label, kind: d.kind, first, last, delta,
        perHour: delta / hours,
        pct: d.kind !== "rate" && first > 0 ? (delta / first) * 100 : null,
      };
    }),
  };
}

/// Which counters are climbing hard enough to name, worst first.
///
/// Only `growth` rows can qualify, only past `MIN_SPAN_MS`, and only across a series
/// that did not reload underneath itself — three refusals rather than a hedged answer,
/// because the whole value of this readout is that when it does name something, that is
/// worth acting on. Ranked by how far past its own threshold each one is, so counters
/// measured in wildly different units still compare.
export function leakSuspects(d: VitalsDrift | null): DriftRow[] {
  if (!d || d.spanMs < MIN_SPAN_MS || d.reloaded) return [];
  return d.rows
    .filter((r) => {
      const climb = BY_ID.get(r.id)?.climb;
      return r.kind === "growth" && climb != null && r.delta > 0 && r.perHour >= climb;
    })
    .sort((x, y) => y.perHour / BY_ID.get(y.id)!.climb! - x.perHour / BY_ID.get(x.id)!.climb!);
}

/// The sentence the Diagnostics tab leads with. One line, and it says which of the four
/// states you are in — not recording, recording but too early to say, recording and
/// clean, or recording and here is what grew.
export function driftVerdict(prefs: VitalsPrefs, d: VitalsDrift | null): string {
  if (!prefs.enabled) return "Not recording. Switch this on and leave it on — a leak that takes fifteen hours cannot be caught after it happens.";
  if (!d) return "Recording. The first reading needs two samples.";
  if (d.reloaded) return "The interface reloaded during this window, so the counters restarted. A fresh reading builds from here.";
  if (d.spanMs < MIN_SPAN_MS) return `Recording — ${fmtSpanShort(d.spanMs)} so far. Half an hour is the shortest window worth a verdict.`;
  const bad = leakSuspects(d);
  if (!bad.length) return `Nothing growing over ${fmtSpanShort(d.spanMs)}. Every unbounded counter is flat or falling.`;
  // The labels go in as written. Lowercasing them to fit the sentence turned "JS heap"
  // and "DOM nodes" into "js heap" and "dom nodes", which reads as a typo in the one
  // sentence anybody will quote back.
  return `Over ${fmtSpanShort(d.spanMs)}: ${bad.map((r) => `${r.label} +${fmtPerHour(r.perHour)}/h`).join(", ")}.`;
}

/// Hours and minutes, no seconds — every span this module reports is measured in hours,
/// and a whole number of them drops the minutes rather than saying "16h 0m".
export function fmtSpanShort(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/// A rate a person can read at a glance. Sub-unit rates keep one decimal, because the
/// heap threshold is 4MB/h and rounding 3.6 to 4 would make a clean reading look flagged.
export function fmtPerHour(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString();
  if (a >= 10) return String(Math.round(n));
  return n.toFixed(1);
}
