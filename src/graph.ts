// The commit-graph panel's pure half: a page of commits in, lanes/edges/ref chips
// out. No DOM, no Tauri, no render imports — so it is unit-tested in isolation
// (test/graph.test.ts), and ./graphview owns the dialog that paints what this
// returns. Same split as diff.ts / diffview.ts, for the same reason: the parsing and
// the layout are where the bugs live, and neither needs a browser to check.

import { esc } from "./format";

/** One commit as `git_graph` hands it over (src-tauri/src/git.rs). */
export interface GraphCommit {
  /** Full sha — parent links are matched on it, so never the abbreviation. */
  sha: string;
  short: string;
  /** Parent shas, first parent first. Empty for a root, 2+ for a merge. */
  parents: string[];
  subject: string;
  author: string;
  /** Author date, epoch seconds. */
  unix: number;
  /** Committer date, relative, in git's own wording ("3 days ago"). */
  rel: string;
  /** Raw `%D` with `--decorate=full`: "HEAD -> refs/heads/main, refs/tags/v1". */
  refs: string;
}

/**
 * A branch line touching a row: which lane (column) it sits in, and *which line it is*.
 * `line` is an identity, minted once when the line opens and carried to the end of it —
 * the colour is only `line % GRAPH_COLORS.length`, and the lane label is keyed off it.
 */
export interface Line { lane: number; line: number; }

/**
 * One drawn row. The three lists are what the SVG is made of, and they are split by
 * *where the line meets the row's edges* rather than by what it means in git terms —
 * that is the only distinction the drawing needs:
 *
 * - `above` — lanes at the row's TOP edge that end at this node (this commit's
 *   children, which each opened a lane waiting for it).
 * - `below` — lanes at the BOTTOM edge that start at this node (its parents).
 * - `through` — lanes crossing the whole row without touching the node at all.
 */
export interface GraphRow {
  c: GraphCommit;
  lane: number;
  line: number;
  above: Line[];
  below: Line[];
  through: Line[];
  /** What line this commit sits on — the nearest ref *above* it on that line, or the
   *  branch the merge that opened the line named. Null when nothing names it. */
  label: LineLabel | null;
  /** Branch names this commit merged in, for a merge row; empty otherwise. The one
   *  thing the drawing genuinely cannot say. */
  merged: string[];
  /** Lanes THIS row touches. The SVG is drawn to this width, not to the page's widest
   *  row: a 12-lane repo would otherwise indent every 2-lane row by ten empty lanes,
   *  and what follows the graph (the ref chips) should hug its actual silhouette. */
  span: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest row's lane count. Rows are drawn to their OWN `span`; this is the ceiling,
   *  useful for sizing decisions about the column as a whole. */
  lanes: number;
}

/**
 * What a lane is, so a reader can tell one anonymous coloured line from another.
 *
 * `from` is how we know, and it matters: `"ref"` means a branch/tag actually sits on a
 * commit of this line, which is a fact; `"merge"` means the line was opened by a merge
 * whose subject names the branch it took in ("Merge pull request #30 from foo/bar"),
 * which is a *claim git no longer stores* — the branch itself is usually deleted by
 * then. Keep the two distinguishable in any wording built from this.
 */
export interface LineLabel { name: string; from: "ref" | "merge"; }

/** First free lane, appending a new one when every active lane is taken. */
function freeLane(lanes: (string | null)[]): number {
  const i = lanes.indexOf(null);
  if (i >= 0) return i;
  lanes.push(null);
  return lanes.length - 1;
}

/**
 * Assign every commit a lane and work out the segments that connect them.
 *
 * The walk is the classic one: a lane is "waiting" for the sha it must draw next, a
 * commit takes the lane already waiting for it (its leftmost, if several children
 * opened one each), then hands that lane to its first parent so a branch keeps one
 * column and one colour for its whole length. A merge's other parents take further
 * lanes — joining one that is already waiting for that parent, so two children of a
 * commit share its line rather than drawing it twice.
 *
 * **Called on the whole accumulated list after each page arrives, not incrementally.**
 * It is O(commits × lanes) over a few hundred rows, and recomputing is how the lanes
 * either side of a page boundary stay consistent — carrying mutable lane state across
 * fetches would be the same answer with a state bug waiting in it.
 *
 * A parent that isn't in `commits` (the frontier of the last loaded page, or a shallow
 * clone's boundary) leaves its lane open, so the line runs off the bottom of the last
 * row — which is exactly what "there is more history below" should look like.
 */
export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = []; // lanes[i] = the sha lane i draws next
  const ids: number[] = [];            // id of the line currently occupying lane i
  const rows: GraphRow[] = [];
  // Lines opened by a merge's second-and-later parent, and the subject of the merge
  // that opened them — the only name a merged-and-deleted branch has left.
  const byMerge = new Map<number, string>();
  let nextLine = 0;
  let widest = 0;

  for (const c of commits) {
    // Every lane waiting for this commit converges here. Two children on different
    // lanes can each be waiting for the same parent, so this is a list, not a find.
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
        // The line continues: same lane, same identity, all the way down the branch.
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

    // Every lane the row touches, including ones merely passing through: an SVG narrower
    // than its widest line would clip that line.
    let span = lane + 1;
    for (const l of [...above, ...below, ...through]) if (l.lane + 1 > span) span = l.lane + 1;
    if (span > widest) widest = span;
    rows.push({ c, lane, line, above, below, through, label: null, merged: [], span });
  }
  nameLines(rows, byMerge);
  return { rows, lanes: widest };
}

/**
 * Say what each row's line is, so the graph is readable rather than eight anonymous
 * colours. Fills `row.label` and `row.merged` in place.
 *
 * **The label is the nearest ref ABOVE the commit on its own line, not the topmost
 * one.** That distinction is the whole correctness of this: in a repo where a feature
 * branch's tip is simply the newest commit, the top of `dev`'s line carries that
 * feature's ref — so "topmost" labels half of dev's history with a branch that was cut
 * from it. The nearest ref above is the tightest ref the commit is genuinely an
 * ancestor of, which is what someone reading a lane wants to know. (Not a claim of
 * exclusivity: a commit is typically reachable from many refs.)
 *
 * Fallback for a line with no ref above it at all — a branch merged and then deleted
 * leaves no ref anywhere — is the subject of the merge that opened the line, which is
 * the last place its name survives. Marked `from: "merge"`, because a message is not a
 * ref and the wording must not pretend otherwise.
 */
function nameLines(rows: GraphRow[], byMerge: Map<number, string>) {
  // Backward pass — what a merge took in. `refBelow` holds, per line, the nearest ref at
  // or BELOW the row being visited, which is the only place a merged-in branch's own ref
  // can be: its commits are older than the merge. Reading the line's first ref instead
  // would happily report a branch cut from the line *above* the merge as its source.
  const refBelow = new Map<number, string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const own = lineRef(parseRefs(r.c.refs));
    if (own) refBelow.set(r.line, own);
    r.merged = r.below.slice(1)
      .map((b) => refBelow.get(b.line) ?? mergeBranchName(r.c.subject))
      .filter((n): n is string => !!n);
  }
  // Forward pass — what line each row is on: carry the last ref seen down each line, so
  // a row gets the nearest ref ABOVE it. A line with none at all falls back to the
  // subject of the merge that opened it (see the note above).
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

/**
 * The ref that best names the *line* a commit sits on: where HEAD is, then a local
 * branch, then a remote one.
 *
 * **A tag is deliberately not one of them.** A tag marks a moment — `v0.11.1` is a
 * commit, not a branch — and a line label propagates down every commit below it, so
 * accepting tags would label a stretch of history "on v0.11.1", which reads as a
 * lineage it never had. Tags still show as chips on their own commit.
 */
export function lineRef(chips: RefChip[]): string | null {
  for (const kind of ["head", "branch", "remote"] as RefKind[]) {
    const hit = chips.find((c) => c.kind === kind);
    if (hit) return hit.label;
  }
  return null;
}

/**
 * The branch name inside a merge subject, or null when it doesn't name one.
 *
 * Only git's own wordings and GitHub's are matched, quoted form first: `Merge branch
 * 'x' into y`, `Merge remote-tracking branch 'origin/x'`, `Merge pull request #30 from
 * owner/branch`. A hand-written "Merge everything" names nothing and must stay null —
 * inventing a lane name from arbitrary prose would be worse than leaving it blank.
 */
export function mergeBranchName(subject: string): string | null {
  const quoted = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  if (quoted) return quoted[1];
  const from = subject.match(/^Merge pull request #\d+ from (\S+)/);
  if (from) return from[1];
  return null;
}

/**
 * The one-line answer to "what is this line?", for the node's tooltip and the detail
 * strip. Wording tracks `label.from`: a ref is stated, a merge subject is attributed,
 * and an unnamed line says why it has no name instead of going silent.
 */
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
  /** Remotes this chip absorbed: `main` + `origin/main` is ONE chip that says it is
   *  pushed, not two chips saying the same name twice. Empty for a plain local ref. */
  also?: string[];
  /** For the `+N` chip: the refs it stands in for, so the title can list them. */
  rest?: string[];
}

/**
 * Turn a `%D` decoration into typed chips — the raw parse, one chip per ref, in git's
 * own order. `refChips` is what the panel draws; this is what the layout reasons over.
 *
 * Read the FULL ref paths (`--decorate=full`), never the short ones: a local branch
 * called `feat/graph` and a remote branch `origin/main` are indistinguishable once
 * abbreviated, and mislabelling half of a branchy repo's chips as remotes is worse
 * than showing no kind at all. `refs/heads/…`, `refs/remotes/…` and `refs/tags/…`
 * answer it outright. (The one thing full mode does *not* spell out is a tag, which
 * keeps its `tag: ` prefix — so that is stripped first.)
 *
 * Anything else under `refs/` (notes, stash, a foreign namespace) keeps its path minus
 * `refs/` and reads as a plain branch chip — an unfamiliar chip is honest; dropping it
 * silently isn't.
 */
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

/**
 * git's relative date, shortened for a narrow panel: "2 days ago" → "2d", "3 weeks ago"
 * → "3w", "1 year, 3 months ago" → "1y". Anything unrecognised is returned untouched —
 * `%cr`'s wording is git's, not ours, and a date we can't parse must still be shown.
 *
 * Both forms are rendered and CSS picks one, so nothing is lost at a narrow width; this
 * is the short one.
 */
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

/** Row height in px. The SVG and the row's CSS height must agree exactly, or the
 *  lane lines break at every row boundary — so both read this. */
export const ROW_H = 26;
/** Horizontal distance between lanes, and the left inset of lane 0. */
export const LANE_W = 14;
export const LANE_X0 = 11;
export const laneX = (lane: number) => LANE_X0 + lane * LANE_W;
export const graphWidth = (lanes: number) => LANE_X0 * 2 + Math.max(0, lanes - 1) * LANE_W;

/**
 * Lane colours, as CSS variables rather than literals: eight hues have to stay
 * distinguishable from each other on *both* grounds, and a set that separates nicely
 * on the dark panel goes pale on the light one — so `--gl-0…7` are re-stepped per
 * theme in styles.css, next to every other palette that had the same problem.
 *
 * A colour follows a branch *line*, not a lane index, so a line keeps its colour for
 * its whole length even when a neighbouring lane closes and is reused under it.
 */
export const GRAPH_COLORS = [
  "var(--gl-0)", "var(--gl-1)", "var(--gl-2)", "var(--gl-3)",
  "var(--gl-4)", "var(--gl-5)", "var(--gl-6)", "var(--gl-7)",
];
export const laneColor = (line: number) => GRAPH_COLORS[((line % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];

/**
 * One row's lanes as an inline SVG — `sparkline`'s shape (data in, string out), so
 * it is tested here rather than in the DOM module that paints it.
 *
 * Edges are S-curves between the row's edge and the node's centre line, which is what
 * makes a merge read as a merge at 26px per row; a straight diagonal at this size
 * looks like a line that missed its column.
 */
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

/**
 * The chips a row actually shows: `parseRefs`, then everything needed to keep a busy
 * repo's rows readable. Four reductions, each earned on a real repo where the raw list
 * was unreadable:
 *
 * - **A local branch absorbs its remote twins.** `main` beside `origin/main` is the same
 *   name twice and cost more width than everything else on the row; it becomes one
 *   `main` chip that *says* it is pushed (`also: ["origin"]`). A remote with no local
 *   counterpart keeps its `origin/` prefix, because "not checked out here" is the whole
 *   difference between the two.
 * - **`origin/HEAD` is dropped.** It is a symref to the remote's default branch — always
 *   a duplicate of another chip on the same commit, and never the answer to anything.
 * - **HEAD first, then local, remote, tags.** Git's own order is not stable across
 *   repos (HEAD can come last), and the leftmost chip is the one that survives a narrow
 *   column, so it must be the most important one rather than whichever git listed first.
 * - **A hard cap, with a `+N` chip.** Ten refs on one commit is normal after a release;
 *   the alternative to folding them is a column wide enough to swallow the subject, or
 *   chips clipped mid-word.
 */
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
      // `refs/remotes/<remote>/<branch>` — the remote name is the first segment (git
      // does not allow one to contain a slash).
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

/** Attribute-safe escaping. `esc` covers `&` and `<`, which is enough for text but not
 *  for a quoted attribute, and a ref name may legally contain a double quote. */
const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

/**
 * Ref chips for a row. A chip that absorbed a remote carries a small `⇡` — "this branch
 * is also on the remote" — which is a glyph's worth of width instead of a second chip's.
 *
 * The name sits in its own inner span so that **only the name is ever ellipsised**: with
 * the marker inside the truncating text, a long branch loses the one bit of information
 * the collapse added, which is worse than losing a few characters of a name you can
 * still hover for.
 */
export function refChipsHtml(chips: RefChip[]): string {
  return chips.map((r) => {
    // Always titled: a chip can be ellipsised by a narrow column, and then its title is
    // the only way to read the branch it names.
    const title = ` title="${attr(chipText(r))}"`;
    const mark = r.also?.length
      ? `<span class="gr">⇡${r.also.includes("origin") && r.also.length === 1 ? "" : esc(r.also.join(" "))}</span>`
      : "";
    const name = `<span class="gn">${r.kind === "tag" ? "⚑ " : ""}${esc(r.label)}</span>`;
    return `<span class="gchip gc-${r.kind}"${title}>${name}${mark}</span>`;
  }).join("");
}
