// The Diagnostics tab's model: what the frontend records about its own weight and what
// those numbers mean. Pure logic; ./debug samples the live values and hands them here, since
// sampling touches `document` and `performance.memory`, which vitest's node env does not have.

// What a counter may accuse: only a `growth` counter (no ceiling) can be called a leak.
// A `level` is bounded by design, so its slope means nothing; a `rate` is a total read per hour.
export type VitalKind = "growth" | "level" | "rate";

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

/** A sample. `upMs` is page uptime, not process uptime: a drop between two samples means a reload. */
export interface Vitals extends VitalCounts { t: number; upMs: number }

export interface VitalDef {
  id: VitalId;
  key: string; // the log line's field name; short because it is grepped, not read
  label: string;
  kind: VitalKind;
  climb?: number; // per-hour rate that counts as a leak; `growth` only, which leakSuspects relies on
  hint: string;
}

// Thresholds come from the one measured incident: a reload freed ~130MB after ~15h, so a heap
// climbing 4MB/h reproduces it; DOM and canvas are scaled to "visible cost within a day".
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

// Three choices, not a stepper: below a minute the series is noise from one busy turn; above
// a quarter-hour a fifteen-hour incident lands in sixty points, too coarse to see a climb begin.
export const VITALS_EVERY = [60_000, 300_000, 900_000] as const;
export const VITALS_DEFAULTS = { enabled: false, everyMs: 300_000 } as const;

export interface VitalsPrefs { enabled: boolean; everyMs: number }

// Ships off (CLAUDE.md): a timer writing to a log file forever, on every install, is not a default.
export function clampVitalsPrefs(p: Partial<VitalsPrefs> | null | undefined): VitalsPrefs {
  const every = Number(p?.everyMs);
  return {
    enabled: p?.enabled === true,
    everyMs: (VITALS_EVERY as readonly number[]).includes(every) ? every : VITALS_DEFAULTS.everyMs,
  };
}
export function vitalsPrefsJson(p: VitalsPrefs): string { return JSON.stringify(p); }

export const VITALS_CAP = 300; // a day at the coarsest cadence; the durable series is the log file

// Scrollback per pane: the one knob here that changes the app's weight rather than measuring
// it. It is the largest thing a fleet holds, and trimScrollback only reclaims it from ended panes.
export const SCROLLBACK_OPTS = [1000, 4000, 8000] as const;
export const SCROLLBACK_DEFAULT = 8000;

// Unknown values fall back to the default, never the nearest option: honouring a hand-edited
// `50` would give somebody a terminal with no history and no clue why.
export function clampScrollback(raw: unknown): number {
  const n = Number(raw);
  return (SCROLLBACK_OPTS as readonly number[]).includes(n) ? n : SCROLLBACK_DEFAULT;
}

// ---------- the series ----------

export function pushVitals(ring: Vitals[], v: Vitals, cap = VITALS_CAP): void {
  ring.push(v);
  if (ring.length > cap) ring.splice(0, ring.length - cap);
}

// The one durable form of any of this: `grep vitals episko.log`. Field order and spelling
// must stay stable, since lines written hours apart by two runs get diffed against each other.
export function vitalsLine(v: Vitals): string {
  const fields = VITALS.map((d) => `${d.key}=${v[d.id]}`).join(" ");
  return `vitals up=${Math.round(v.upMs / 60_000)}m ${fields}`;
}

export interface DriftRow {
  id: VitalId; label: string; kind: VitalKind;
  first: number; last: number; delta: number;
  perHour: number;
  pct: number | null;
}
export interface VitalsDrift { spanMs: number; samples: number; reloaded: boolean; rows: DriftRow[] }

// No verdict below half an hour: two samples across one busy turn make any counter look alarming.
export const MIN_SPAN_MS = 30 * 60_000;

// First sample against last, not a regression: the question is "heavier than this morning?".
export function vitalsDrift(ring: readonly Vitals[]): VitalsDrift | null {
  if (ring.length < 2) return null;
  const a = ring[0], b = ring[ring.length - 1];
  const spanMs = b.t - a.t;
  if (spanMs <= 0) return null;
  const hours = spanMs / 3_600_000;
  return {
    spanMs, samples: ring.length,
    // upMs going backwards means the page reloaded inside the window; reported, not repaired.
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

// Only growth rows, only past MIN_SPAN_MS, only across a series that did not reload: three
// refusals rather than a hedged answer. Ranked by how far past its own threshold each one is.
export function leakSuspects(d: VitalsDrift | null): DriftRow[] {
  if (!d || d.spanMs < MIN_SPAN_MS || d.reloaded) return [];
  return d.rows
    .filter((r) => {
      const climb = BY_ID.get(r.id)?.climb;
      return r.kind === "growth" && climb != null && r.delta > 0 && r.perHour >= climb;
    })
    .sort((x, y) => y.perHour / BY_ID.get(y.id)!.climb! - x.perHour / BY_ID.get(x.id)!.climb!);
}

export function driftVerdict(prefs: VitalsPrefs, d: VitalsDrift | null): string {
  if (!prefs.enabled) return "Not recording. Switch this on and leave it on — a leak that takes fifteen hours cannot be caught after it happens.";
  if (!d) return "Recording. The first reading needs two samples.";
  if (d.reloaded) return "The interface reloaded during this window, so the counters restarted. A fresh reading builds from here.";
  if (d.spanMs < MIN_SPAN_MS) return `Recording — ${fmtSpanShort(d.spanMs)} so far. Half an hour is the shortest window worth a verdict.`;
  const bad = leakSuspects(d);
  if (!bad.length) return `Nothing growing over ${fmtSpanShort(d.spanMs)}. Every unbounded counter is flat or falling.`;
  // Labels go in as written: lowercased, "JS heap" reads as a typo.
  return `Over ${fmtSpanShort(d.spanMs)}: ${bad.map((r) => `${r.label} +${fmtPerHour(r.perHour)}/h`).join(", ")}.`;
}

export function fmtSpanShort(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

// Sub-unit rates keep one decimal: the heap threshold is 4MB/h, and 3.6 rounded to 4 looks flagged.
export function fmtPerHour(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return Math.round(n).toLocaleString();
  if (a >= 10) return String(Math.round(n));
  return n.toFixed(1);
}
