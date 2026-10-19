// Back and forward between what has owned the stage: a session or a copy of state.ts's
// `mirror`. Pure; main.ts records in renderAllNow and reopens through the existing openers.

// A tiled run group is one place: clicking its tiles moves `activeId` but not the location.
export type Loc =
  | { kind: "session"; id: string; group?: string }
  | { kind: "ext"; id: string; pid: number }
  | { kind: "past"; id: string }
  | { kind: "dash"; root: string; name: string }
  | { kind: "fleet" }
  | { kind: "review"; root: string; name: string; number: number };

export type NavDir = "back" | "forward";

export interface Nav { back: Loc[]; cur: Loc | null; fwd: Loc[] }

export const NAV_CAP = 50;

export const emptyNav = (): Nav => ({ back: [], cur: null, fwd: [] });

// Identity, never the label: an external session's id rotates on /clear, its pid does not.
export function sameLoc(a: Loc | null, b: Loc | null): boolean {
  if (!a || !b) return a === b;
  switch (a.kind) {
    case "session": return b.kind === "session" && (a.group || b.group ? a.group === b.group : a.id === b.id);
    case "ext": return b.kind === "ext" && a.pid === b.pid;
    case "past": return b.kind === "past" && a.id === b.id;
    case "dash": return b.kind === "dash" && a.root === b.root;
    case "fleet": return b.kind === "fleet";
    case "review": return b.kind === "review" && a.root === b.root && a.number === b.number;
  }
}

/** Where the stage is now. `null` (a handover mid-flight) is not a place and records nothing. */
export function visit(n: Nav, loc: Loc | null): Nav {
  if (!loc) return n;
  if (sameLoc(n.cur, loc)) return sameLocFields(n.cur, loc) ? n : { ...n, cur: loc };
  const back = n.cur ? [...n.back, n.cur].slice(-NAV_CAP) : n.back;
  return { back, cur: loc, fwd: [] };
}

// A renamed dashboard or a rotated external id is the same place with fresher fields.
function sameLocFields(a: Loc | null, b: Loc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The live entry a step would land on, without moving: what the buttons show. */
export function peek(n: Nav, dir: NavDir, alive: (l: Loc) => boolean): Loc | null {
  const list = dir === "back" ? n.back : n.fwd;
  for (let i = list.length - 1; i >= 0; i--) if (alive(list[i]) && !sameLoc(list[i], n.cur)) return list[i];
  return null;
}

// Moves the cursor rather than recording: what it passes over is dropped (dead, or the place
// you are already on), and the place you left goes onto the other stack.
export function step(n: Nav, dir: NavDir, alive: (l: Loc) => boolean): { nav: Nav; to: Loc } | null {
  const from = (dir === "back" ? n.back : n.fwd).slice();
  const other = (dir === "back" ? n.fwd : n.back).slice();
  while (from.length) {
    const to = from.pop()!;
    if (!alive(to) || sameLoc(to, n.cur)) continue;
    if (n.cur) other.push(n.cur);
    const nav = dir === "back"
      ? { back: from, cur: to, fwd: other }
      : { back: other.slice(-NAV_CAP), cur: to, fwd: from };
    return { nav, to };
  }
  return null;
}

export function locKind(l: Loc): string {
  switch (l.kind) {
    case "session": return l.group ? "task group" : "session";
    case "ext": return "external session";
    case "past": return "shelved session";
    case "dash": return "dashboard";
    case "fleet": return "all projects";
    case "review": return `pull request #${l.number}`;
  }
}

/** A button's tooltip. `name` is the caller's (it needs the session map); `chord` may be "". */
export function navTip(dir: NavDir, to: Loc | null, name: string, chord: string): string {
  const keys = chord ? ` (${chord})` : "";
  if (!to) return `${dir === "back" ? "Nothing to go back to" : "Nothing to go forward to"}${keys}`;
  const verb = dir === "back" ? "Back to" : "Forward to";
  const what = to.kind === "fleet" ? "All projects" : name ? `${name} · ${locKind(to)}` : locKind(to);
  return `${verb} ${what}${keys}`;
}
