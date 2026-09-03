// The commit-graph panel's pure half: a page of commits in, lanes, edges and ref chips out.
// No DOM, no Tauri, no render imports; ./graphview paints what this returns.

import { esc } from "./format";

/** One commit as `git_graph` hands it over (src-tauri/src/git.rs). */
export interface GraphCommit {
  sha: string; // full; parent links match on it, never the abbreviation
  short: string;
  parents: string[]; // first parent first; empty for a root, 2+ for a merge
  subject: string;
  author: string;
  unix: number; // author date, epoch seconds
  rel: string; // committer date in git's own relative wording ("3 days ago")
  refs: string; // raw `%D` with `--decorate=full`
}

/** A branch line touching a row: its lane (column) and its identity; colour and label key off `line`. */
export interface Line { lane: number; line: number; }

/** One drawn row; the lists are split by where a line meets the row's edges. */
export interface GraphRow {
  c: GraphCommit;
  lane: number;
  line: number;
  above: Line[]; // lanes at the top edge ending at this node (its children)
  below: Line[]; // lanes at the bottom edge starting here (its parents)
  through: Line[]; // lanes crossing the row without touching the node
  label: LineLabel | null; // nearest ref above on this line, else the opening merge's branch
  merged: string[]; // branch names a merge row merged in
  span: number; // lanes this row touches; the SVG is drawn to this, not the page's widest row
}

export interface GraphLayout {
  rows: GraphRow[];
  lanes: number; // widest row's span
}

/** `from: "ref"` is a fact (a ref sits on this line); `"merge"` is a claim from a merge
 *  subject whose branch is usually deleted by now. Keep the two distinguishable in wording. */
export interface LineLabel { name: string; from: "ref" | "merge"; }

function freeLane(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  if (i >= 0) return i;
  lanes.push(null);
  return lanes.length - 1;
}

// A lane waits for the sha it draws next; a commit takes the leftmost lane waiting for it and
// hands it to its first parent; a merge's other parents join a waiting lane or open one.
// Recomputed over the whole list after each page, never incrementally, so lanes either side
// of a page boundary agree. A parent not in `commits` leaves its lane open (more history below).
export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = []; // lanes[i] = the sha lane i draws next
  const ids: number[] = [];            // id of the line currently occupying lane i
  const rows: GraphRow[] = [];
  // Lines a merge's later parents opened, with the merge subject: a deleted branch's only name.
  const byMerge = new Map<number, string>();
  let nextLine = 0;
  let widest = 0;

  for (const c of commits) {
    // Two children on different lanes can wait for the same parent, so a list, not a find.
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.sha) waiting.push(i);

    let lane: number, line: number;
    if (waiting.length) {
      lane = waiting[0]; // leftmost keeps the node; the others fold into it
      line = ids[lane];
    } else {
      lane = freeLane(lanes); // a tip — or the top of a page — starts a new line
      line = nextLine++;
    }
    const above: Line[] = waiting.map((i) => ({ lane: i, line: ids[i] }));
    const through: Line[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null || i === lane || waiting.includes(i)) continue;
      through.push({ lane: i, line: ids[i] });
    }

    // Close every lane that ended here (including this node's own) before opening
    // any, or a merge's extra parent could be handed the lane we are about to reuse.
    for (const i of waiting) lanes[i] = null;
    lanes[lane] = null;

    const below: Line[] = [];
    c.parents.forEach((p, k) => {
      if (k === 0) {
        lanes[lane] = p;
        ids[lane] = line;
        below.push({ lane, line });
        return;
      }
      const joining = lanes.indexOf(p);
      if (joining >= 0) { below.push({ lane: joining, line: ids[joining] }); return; }
      const l = freeLane(lanes);
      lanes[l] = p;
      ids[l] = nextLine++;
      byMerge.set(ids[l], c.subject);
      below.push({ lane: l, line: ids[l] });
    });

    let span = lane + 1;
    for (const l of [...above, ...below, ...through]) if (l.lane + 1 > span) span = l.lane + 1;
    if (span > widest) widest = span;
    rows.push({ c, lane, line, above, below, through, label: null, merged: [], span });
  }
  nameLines(rows, byMerge);
  return { rows, lanes: widest };
}

// Fills `row.label` and `row.merged`. The label is the nearest ref ABOVE the commit on its
// own line, not the topmost: the top of dev's line often carries a feature ref cut from it.
// A line with no ref falls back to the subject of the merge that opened it (`from: "merge"`).
function nameLines(rows: GraphRow[], byMerge: Map<number, string>) {
  // Backward pass, what a merge took in: the nearest ref at or BELOW the row, since a
  // merged-in branch's own commits are older than the merge.
  const refBelow = new Map<number, string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const own = lineRef(parseRefs(r.c.refs));
    if (own) refBelow.set(r.line, own);
    r.merged = r.below.slice(1)
      .map((b) => refBelow.get(b.line) ?? mergeBranchName(r.c.subject))
      .filter((n): n is string => !!n);
  }
  // Forward pass, what line each row is on: carry the last ref seen down each line.
  const cur = new Map<number, LineLabel>();
  for (const r of rows) {
    const own = lineRef(parseRefs(r.c.refs));
    if (own) cur.set(r.line, { name: own, from: "ref" });
    else if (!cur.has(r.line)) {
      const merge = byMerge.get(r.line);
      const named = merge ? mergeBranchName(merge) : null;
      if (named) cur.set(r.line, { name: named, from: "merge" });
    }
    r.label = cur.get(r.line) ?? null;
  }
}

/** The ref naming a commit's line: HEAD, then local, then remote. Never a tag: a label
 *  propagates down every commit below it, and a tag marks a moment, not a lineage. */
export function lineRef(chips: RefChip[]): string | null {
  for (const kind of ["head", "branch", "remote"] as RefKind[]) {
    const hit = chips.find((c) => c.kind === kind);
    if (hit) return hit.label;
  }
  return null;
}

/** The branch inside a merge subject (git's and GitHub's wordings only), or null. Prose
 *  like "Merge everything" must stay null; an invented lane name is worse than a blank. */
export function mergeBranchName(subject: string): string | null {
  const quoted = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (quoted) return quoted[1];
  const from = subject.match(/^Merge pull request #\d+ from (\S+)/);
  if (from) return from[1];
  return null;
}

/** The line's one-line answer for the tooltip; wording tracks `label.from`, and unnamed says why. */
export function lineTip(row: GraphRow): string {
  const parts = [
    row.label
      ? row.label.from === "ref"
        ? `On the line leading up to ${row.label.name}`
        : `On the branch merged in as ${row.label.name} (from the merge's subject)`
      : "No branch or tag above this commit on its line, usually a branch deleted after merging",
  ];
  if (row.merged.length) parts.push(`merges ${row.merged.join(", ")}`);
  return parts.join(" · ");
}

// ---------- ref decorations ----------

export type RefKind = "head" | "branch" | "remote" | "tag" | "more";
export interface RefChip {
  kind: RefKind;
  label: string;
  also?: string[]; // remotes this chip absorbed: `main` + `origin/main` is one chip that says pushed
  rest?: string[]; // for the `+N` chip: the refs it stands in for
}

// One chip per ref in git's order; `refChips` is what the panel draws. Needs the FULL ref
// paths (`--decorate=full`): short `feat/graph` and `origin/main` are indistinguishable. Tags
// keep a `tag: ` prefix even in full mode. Anything else under `refs/` reads as a branch chip.
export function parseRefs(decoration: string): RefChip[] {
  const chips: RefChip[] = [];
  for (const raw of decoration.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("tag: ")) { chips.push({ kind: "tag", label: shortRef(t.slice(5)) }); continue; }
    // "HEAD -> refs/heads/main" names both the checkout and the branch it is on.
    const head = t.match(/^HEAD -> (.+)$/);
    const path = head ? head[1] : t;
    if (path === "HEAD") { chips.push({ kind: "head", label: "HEAD" }); continue; } // detached
    const kind: RefKind = head ? "head"
      : path.startsWith("refs/remotes/") ? "remote"
      : path.startsWith("refs/tags/") ? "tag" // git prefixes tags, but don't rely on it
      : "branch";
    chips.push({ kind, label: shortRef(path) });
  }
  return chips;
}

/** git's `%cr` shortened for a narrow panel ("2 days ago" → "2d"); anything unrecognised is
 *  returned untouched, since the wording is git's. CSS picks this or the long form. */
export function shortRel(rel: string): string {
  const m = rel.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?/);
  if (!m) return rel;
  const unit: Record<string, string> = {
    second: "s", minute: "m", hour: "h", day: "d", week: "w", month: "mo", year: "y",
  };
  return m[1] + unit[m[2]];
}

/** `refs/remotes/origin/main` → `origin/main`; a name we don't know keeps its shape. */
export function shortRef(path: string): string {
  for (const p of ["refs/heads/", "refs/remotes/", "refs/tags/"]) {
    if (path.startsWith(p)) return path.slice(p.length);
  }
  return path.startsWith("refs/") ? path.slice(5) : path;
}

// ---------- geometry & colour ----------

/** Row height in px; the SVG and the row's CSS height must agree exactly or lane lines break. */
export const ROW_H = 26;
/** Horizontal distance between lanes, and the left inset of lane 0. */
export const LANE_W = 14;
export const LANE_X0 = 11;
export const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
export const graphWidth = (lanes: number) => LANE_X0 * 2 + Math.max(0, lanes - 1) * LANE_W;

// CSS variables, re-stepped per theme in styles.css: eight hues must stay apart on both grounds.
// A colour follows a line, not a lane index, so it survives a neighbouring lane's reuse.
export const GRAPH_COLORS = [
  "var(--gl-0)", "var(--gl-1)", "var(--gl-2)", "var(--gl-3)",
  "var(--gl-4)", "var(--gl-5)", "var(--gl-6)", "var(--gl-7)",
];
export const laneColor = (line: number) => GRAPH_COLORS[((line % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];

// Edges are S-curves: at 26px a straight diagonal looks like a line that missed its column.
export function rowSvg(row: GraphRow, opts: { head?: boolean } = {}): string {
  const w = graphWidth(row.span), h = ROW_H, mid = h / 2;
  const x = laneX(row.lane);
  const seg = (d: string, line: number) => `<path class="gline" d="${d}" stroke="${laneColor(line)}"></path>`;
  const parts: string[] = [];
  for (const t of row.through) parts.push(seg(`M${laneX(t.lane)},0V${h}`, t.line));
  for (const a of row.above) {
    const xa = laneX(a.lane);
    parts.push(seg(xa === x ? `M${xa},0V${mid}` : `M${xa},0C${xa},${mid * 0.5} ${x},${mid * 0.5} ${x},${mid}`, a.line));
  }
  for (const b of row.below) {
    const xb = laneX(b.lane);
    parts.push(seg(xb === x ? `M${x},${mid}V${h}` : `M${x},${mid}C${x},${mid * 1.5} ${xb},${mid * 1.5} ${xb},${h}`, b.line));
  }
  const c = laneColor(row.line);
  const node = opts.head
    ? `<circle class="gnode ghead" cx="${x}" cy="${mid}" r="4.2" fill="${c}" stroke="${c}"></circle>`
    : `<circle class="gnode" cx="${x}" cy="${mid}" r="3.4" fill="${c}"></circle>`;
  return `<svg class="gsvg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}${node}</svg>`;
}

// What a row shows: a local branch absorbs its remote twins (`also`), a remote with no local
// keeps its `origin/` prefix, `origin/HEAD` is dropped as a duplicate symref, order is HEAD,
// local, remote, tags (git's own order is not stable, and the leftmost chip is what survives
// a narrow column), and everything past `max` folds into one `+N` chip.
export function refChips(decoration: string, max = 3): RefChip[] {
  const raw = parseRefs(decoration);
  const locals = new Map<string, RefChip>();
  const out: RefChip[] = [];
  for (const r of raw) {
    if (r.kind === "head" || r.kind === "branch") {
      const chip: RefChip = { ...r, also: [] };
      locals.set(r.label, chip);
      out.push(chip);
    }
  }
  for (const r of raw) {
    if (r.kind === "head" || r.kind === "branch") continue;
    if (r.kind === "remote") {
      // The remote name is the first segment; git forbids a slash in one.
      const cut = r.label.indexOf("/");
      const remote = cut < 0 ? r.label : r.label.slice(0, cut);
      const branch = cut < 0 ? "" : r.label.slice(cut + 1);
      if (branch === "HEAD") continue; // the remote's default-branch pointer: noise
      const local = locals.get(branch);
      if (local) { local.also!.push(remote); continue; }
    }
    out.push(r);
  }
  const rank: Record<string, number> = { head: 0, branch: 1, remote: 2, tag: 3, more: 4 };
  out.sort((a, b) => rank[a.kind] - rank[b.kind]);
  if (out.length <= max) return out;
  const rest = out.slice(max);
  return [...out.slice(0, max), {
    kind: "more",
    label: `+${rest.length}`,
    rest: rest.map((r) => chipText(r)),
  }];
}

/** A chip's full name for a tooltip — `main (also on origin)`, `v1.0`, `origin/next`. */
export function chipText(chip: RefChip): string {
  if (chip.kind === "more") return (chip.rest ?? []).join(", ");
  return chip.also?.length ? `${chip.label} (also on ${chip.also.join(", ")})` : chip.label;
}

// `esc` covers `&` and `<` only, and a ref name may legally contain a double quote.
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

// A chip that absorbed a remote carries `⇡` instead of a second chip. Only the name span
// ellipsises, so a long branch never loses the marker; the title is how you read the rest.
export function refChipsHtml(chips: RefChip[]): string {
  return chips.map((r) => {
    const title = ` title="${attr(chipText(r))}"`;
    const mark = r.also?.length
      ? `<span class="gr">⇡${r.also.includes("origin") && r.also.length === 1 ? "" : esc(r.also.join(" "))}</span>`
      : "";
    const name = `<span class="gn">${r.kind === "tag" ? "⚑ " : ""}${esc(r.label)}</span>`;
    return `<span class="gchip gc-${r.kind}"${title}>${name}${mark}</span>`;
  }).join("");
}
