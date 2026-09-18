// One ranked queue over what were four cards: open work, triage, dependencies and notes.
// The rules only — no DOM, no fetch, no state; ./dashview draws it. See docs/dashboard.md.

import { prBlockers, prFor, prReady, sevRank, type Advisory, type DepPr, type OutRow } from "./deps";
import type { GhThread, Holder } from "./ghwork";
import type { Note, SharedNote } from "./notes";

export type QueueKind = "work" | "deps" | "note";
// The chips split `work` into issues and pull requests, because that is the distinction you
// filter on, and add `quiet` — a FACET, not a source: a quiet row is also an issue and is
// counted in both, which is why this is not `QueueKind` with an extra member.
export type QueueFilter = "all" | "iss" | "pr" | "deps" | "note" | "quiet";

/// One row, whatever it came from. The source object rides along so the view draws the verbs
/// that row already had; `title`/`sub` are what every row says however it is drawn.
export interface QueueItem {
  key: string;
  kind: QueueKind;
  rank: number;
  moved: number;
  title: string;
  sub: string;
  thread?: GhThread;
  held?: Holder | null;
  triage?: string;
  advisory?: Advisory;
  pr?: DepPr;
  out?: OutRow;
  note?: Note;
  shared?: SharedNote;
}

export interface QueueInput {
  threads: GhThread[];
  stale: { t: GhThread; why: string }[];
  adv: Advisory[];
  prs: DepPr[];
  out: OutRow[];
  notes: Note[];
  shared: SharedNote[];
  holder: (t: GhThread) => Holder | null;
  now: number;
}

// The `rank` ladder, 0 first: a critical or high advisory · a claim of yours in flight · a
// bot PR ready to merge · any other open PR · your note · an open issue · a triage
// suggestion · something out of date · a medium or low advisory.

// A row with no readable timestamp sorts last within its rank, never first: a row falsely
// from today is the one you would act on first (./ghwork says the same about buckets).
const at = (iso: string): number => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : 0;
};

const heldText = (h: Holder | null): string =>
  !h ? "nobody on it" : h.mine ? (h.stale ? "yours, probably stale" : "yours") : `${h.who} is on it`;

// "opened 3d", not "3d": the row carries no age column of its own, so the word has to say
// which clock it is. Past a week the span alone is unambiguous and the word is dropped.
export function agedAt(iso: string, now: number): string {
  const t = at(iso);
  if (!t) return "";
  const d = Math.max(0, Math.round((now - t) / 86_400_000));
  if (d <= 0) return "opened today";
  if (d === 1) return "opened yesterday";
  if (d < 7) return `opened ${d}d`;
  if (d < 31) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)} month${Math.round(d / 30) === 1 ? "" : "s"}`;
}

function workItem(t: GhThread, held: Holder | null, why: string | undefined, now: number): QueueItem {
  return {
    key: `work:${t.number}`,
    kind: "work",
    rank: held?.mine && !held.stale ? 1 : t.kind === "pr" ? 3 : 5,
    moved: at(t.updated_at),
    title: t.title,
    sub: [agedAt(t.updated_at, now), why ?? "", heldText(held)].filter(Boolean).join(" · "),
    thread: t,
    held,
    triage: why,
  };
}

// An advisory and the bot PR that fixes it stay two rows — one says how bad, the other
// merges it — but the advisory says the fix is already in flight rather than reading as work
// nobody has started.
function advItem(a: Advisory, pr: DepPr | null): QueueItem {
  const names = a.alerts.map((x) => x.pkg);
  const patched = a.alerts[0]?.patched;
  return {
    key: `deps:adv:${a.ghsa}`,
    kind: "deps",
    rank: sevRank(a.severity) <= sevRank("high") ? 0 : 8,
    moved: Math.max(0, ...a.alerts.map((x) => at(x.updatedAt))),
    title: names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : ""),
    sub: [
      a.severity || "unrated",
      patched ? `→ ${patched}` : "no fix yet",
      pr ? `#${pr.number} open` : "",
    ].filter(Boolean).join(" · "),
    advisory: a,
  };
}

function prItem(p: DepPr): QueueItem {
  const blockers = prBlockers(p);
  const ready = prReady(p);
  return {
    key: `deps:pr:${p.number}`,
    kind: "deps",
    rank: ready ? 2 : 3,
    moved: at(p.updatedAt),
    title: p.title,
    sub: `${p.bot || "bot"} · ${blockers[0] ?? (ready ? "ready to merge" : "no check has run")}`,
    pr: p,
  };
}

// A package manager's answer carries no timestamp at all, so every out-of-date row shares
// one `moved` and the localeCompare tie-break is what orders them.
function outItem(r: OutRow): QueueItem {
  return {
    key: `deps:out:${r.pkg}`,
    kind: "deps",
    rank: 7,
    moved: 0,
    title: r.pkg,
    sub: `${r.current || "—"} → ${r.latest} · ${r.bump}`,
    out: r,
  };
}

const noteItem = (n: Note): QueueItem => ({
  key: `note:${n.id}`, kind: "note", rank: 4, moved: n.created, title: n.text, sub: "", note: n,
});

// A colleague's note ranks with your own: whose it is decides the row's verbs, not its urgency.
const sharedItem = (s: SharedNote): QueueItem => ({
  key: `note:shared:${s.id}`, kind: "note", rank: 4, moved: at(s.at), title: s.text,
  sub: [s.who || "someone", s.at].filter(Boolean).join(" · "), shared: s,
});

export function rankQueue(q: QueueInput): QueueItem[] {
  const why = new Map(q.stale.map((s) => [s.t.number, s.why]));
  const drawn = new Set(q.threads.map((t) => t.number));
  // `gh_threads` filters by no author, so a bot's PR arrives as open work AND in the deps
  // half; the deps row owns it, carrying the checks, the blockers and the ▶ that reads it.
  const bot = new Set(q.prs.map((p) => p.number));
  const items = q.threads.filter((t) => !(t.kind === "pr" && bot.has(t.number)))
    .map((t) => workItem(t, q.holder(t), why.get(t.number), q.now));
  // A thread that is both open work and a triage suggestion is ONE row, at its better rank,
  // carrying the suggestion; only a suggestion with no open-work row of its own ranks here.
  for (const { t, why: reason } of q.stale) {
    if (drawn.has(t.number)) continue;
    drawn.add(t.number);
    items.push({ ...workItem(t, q.holder(t), reason, q.now), rank: 6 });
  }
  items.push(...q.adv.map((a) => advItem(a, prFor(a, q.prs))),
    ...q.prs.map(prItem), ...q.out.map(outItem));
  items.push(...q.notes.map(noteItem), ...q.shared.map(sharedItem));
  // A suggestion LEADS its rank: ./ghwork caps them at TRIAGE_ROWS and the card answers one
  // outright (✓/✕), so the few there are belong at the top of the rank they share rather than
  // wherever recency — which favours the newest issues — would scatter them.
  // Ties then break on `moved` and `key`, so a repaint never reorders a row under the pointer.
  return items.sort((a, b) =>
    a.rank - b.rank
    || Number(!!b.triage) - Number(!!a.triage)
    || b.moved - a.moved
    || a.key.localeCompare(b.key));
}

const isPr = (i: QueueItem): boolean => i.thread?.kind === "pr" || !!i.pr;
const inFilter = (i: QueueItem, f: QueueFilter): boolean =>
  f === "all" ? true
  : f === "quiet" ? !!i.triage
  : f === "iss" ? i.kind === "work" && !isPr(i)
  : f === "pr" ? isPr(i)
  : f === "note" ? i.kind === "note"
  : i.kind === "deps" && !isPr(i);

export const filterQueue = (items: QueueItem[], f: QueueFilter): QueueItem[] =>
  f === "all" ? items : items.filter((i) => inFilter(i, f));

// Counted over the UNFILTERED list, so a chip says what it would reveal rather than what is on
// screen. `quiet` overlaps `iss`, so the parts deliberately do not sum to `all`.
export function queueTally(items: QueueItem[]): Record<QueueFilter, number> {
  const t: Record<QueueFilter, number> = { all: items.length, iss: 0, pr: 0, deps: 0, note: 0, quiet: 0 };
  for (const i of items) for (const f of ["iss", "pr", "deps", "note", "quiet"] as const) if (inFilter(i, f)) t[f]++;
  return t;
}

// A row is matched on everything it SAYS, plus the words its chip stands for: `iss 37` is
// drawn from the kind and the number, and `quiet` is a facet no field spells out, so a
// search for either would otherwise miss the rows the chips find.
const hay = (i: QueueItem): string => [
  i.title, i.sub, i.triage ? "quiet" : "",
  i.thread ? `${i.thread.kind} #${i.thread.number} ${i.thread.labels.join(" ")}` : "",
  i.advisory ? `adv ${i.advisory.ghsa} ${i.advisory.cve ?? ""} ${i.advisory.summary} ${i.advisory.alerts.map((a) => a.pkg).join(" ")}` : "",
  i.pr ? `pr #${i.pr.number} ${i.pr.bot}` : "",
  i.out ? `pkg ${i.out.pkg}` : "",
  i.kind === "note" ? `note ${i.shared?.who ?? ""}` : "",
].join(" ").toLowerCase();

/// Every term must match, in any field and in any order, so "axios high" narrows rather than
/// widening. Runs BEFORE the chips and before `queueTally`: the search is the pool, so a chip
/// says what it would reveal within it rather than what the project has (docs/dashboard.md).
export function searchQueue(items: QueueItem[], q: string): QueueItem[] {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items;
  return items.filter((i) => {
    const h = hay(i);
    return terms.every((t) => h.includes(t));
  });
}
