// The memory stream's rules (docs/sync.md): Claude's per-project memory files between one
// person's machines, keyed `<project id>|<name>.md`. Pure; ./synclink drives it, and the disk
// half (scan, write, the index) is usage.rs's.
import { safeParse } from "./store";

const NAME = /^[A-Za-z0-9._-]+\.md$/;
/** usage.rs's MEMORY_NAME_MAX: a longer name never travels either way. */
export const MEM_NAME_MAX = 120;
/** What this machine holds for projects it has not applied yet; past it an arrival is dropped. */
export const HELD_MAX = 2 * 1024 * 1024;

/** A memory file that may travel: never the index in any case (macOS and Windows fold it), never a path. */
export const validName = (n: unknown): n is string =>
  typeof n === "string" && n.toLowerCase() !== "memory.md" && n.length <= MEM_NAME_MAX && NAME.test(n) && !/^\.+\.md$/.test(n);

export const memKey = (pid: string, name: string) => `${pid}|${name}`;

/** The last `|` splits: a name cannot hold one, so whatever a project id is, it stays whole. */
export function parseMemKey(key: string): { pid: string; name: string } | null {
  const bar = key.lastIndexOf("|");
  const pid = key.slice(0, bar), name = key.slice(bar + 1);
  return bar > 0 && validName(name) ? { pid, name } : null;
}

/** `null` is a tombstone. */
export interface MemPayload { text: string; sha: string }
const SHA = /^[0-9a-f]{64}$/;

/** A payload, `null` for a tombstone, `undefined` for anything unusable. */
export function narrowMem(v: unknown): MemPayload | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.sha === "string" && SHA.test(o.sha) ? { text: o.text, sha: o.sha } : undefined;
}

export interface MemFile { name: string; text: string; sha: string }
/** `skipped` is present but too big to travel; nothing is read as removed while `found` is false. */
export interface MemScan { files: MemFile[]; skipped: string[]; found: boolean }

export function narrowScan(v: unknown): MemScan | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.files)) return null;
  const files: MemFile[] = [];
  for (const f of o.files) {
    const p = narrowMem(f);
    const name = (f as { name?: unknown } | null)?.name;
    if (p && validName(name)) files.push({ name, ...p });
  }
  const skipped = Array.isArray(o.skipped) ? o.skipped.filter(validName) : [];
  return { files, skipped, found: o.found === true };
}

/** An arrival accepted but not on disk yet: no checkout here, the opt-in off, or a failed write. */
export interface Held { payload: MemPayload | null; at: number; device: string }
/** `seen`: memKey → the sha this machine and the server last agreed on; `dirs`: the checkout each project is scanned in. */
export interface MemBook { seen: Record<string, string>; held: Record<string, Held>; dirs: Record<string, string> }

export function readMemBook(raw: string | null): MemBook {
  const v = safeParse<Record<string, unknown>>(raw);
  const book: MemBook = { seen: {}, held: {}, dirs: {} };
  if (!v || typeof v !== "object" || Array.isArray(v)) return book;
  const seen = v.seen, held = v.held, dirs = v.dirs;
  if (dirs && typeof dirs === "object" && !Array.isArray(dirs)) {
    for (const [pid, d] of Object.entries(dirs)) if (pid && typeof d === "string" && d) book.dirs[pid] = d;
  }
  if (seen && typeof seen === "object" && !Array.isArray(seen)) {
    for (const [k, sha] of Object.entries(seen)) if (parseMemKey(k) && typeof sha === "string" && SHA.test(sha)) book.seen[k] = sha;
  }
  if (held && typeof held === "object" && !Array.isArray(held)) {
    for (const [k, h] of Object.entries(held as Record<string, unknown>)) {
      const o = h as Partial<Held> | null;
      const payload = narrowMem(o?.payload);
      if (!parseMemKey(k) || payload === undefined || typeof o?.at !== "number" || typeof o.device !== "string") continue;
      book.held[k] = { payload, at: o.at, device: o.device };
    }
  }
  return book;
}

/** One change this machine owes. `reveal`: never heard of anywhere, so it goes at the oldest stamp. */
export interface MemOut { key: string; payload: MemPayload | null; reveal: boolean }

/**
 * What one project's scan owes against what was last agreed. A tombstone goes only for a file
 * this machine saw and no longer has; a key waiting in `held` is left until it has been applied.
 */
export function diffLocal(pid: string, scan: MemScan, book: MemBook, stamped: (key: string) => boolean): MemOut[] {
  const out: MemOut[] = [];
  const here = new Set([...scan.files.map((f) => f.name), ...scan.skipped]);
  for (const f of scan.files) {
    const key = memKey(pid, f.name);
    if (book.seen[key] === f.sha || key in book.held) continue;
    out.push({ key, payload: { text: f.text, sha: f.sha }, reveal: !(key in book.seen) && !stamped(key) });
  }
  for (const key of scan.found ? Object.keys(book.seen) : []) {
    const k = parseMemKey(key);
    if (k && k.pid === pid && !here.has(k.name) && !(key in book.held)) out.push({ key, payload: null, reveal: false });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The one checkout a project's memories are read and written in: the one it was last, while it
 * is still here. `moved`: a new pick, whose first scan must not read the old folder's files as removed.
 */
export function pickDir(had: string | undefined, paths: readonly string[]): { dir: string; moved: boolean } | null {
  if (had && paths.includes(had)) return { dir: had, moved: false };
  return paths.length ? { dir: paths[0], moved: true } : null;
}

/** Where an arrival goes when a file of its name here was never agreed: beside it, both kept. */
export function conflictName(name: string, device: string): string {
  const tag = `.from-${device.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "other"}.md`;
  return name.slice(0, -3).slice(0, MEM_NAME_MAX - tag.length) + tag;
}

/** An arrival worth holding: another machine's, valid, and newer than what this one holds. */
export function acceptMem(
  ev: { stream: string; key: string; at: number; device: string; payload: unknown },
  held: { at: number; device: string } | undefined, self: string,
): Held | null {
  if (ev.stream !== "memory" || ev.device === self || !parseMemKey(ev.key)) return null;
  const payload = narrowMem(ev.payload);
  if (payload === undefined) return null;
  if (held && (ev.at !== held.at ? ev.at < held.at : ev.device <= held.device)) return null;
  return { payload, at: ev.at, device: ev.device };
}

const heldBytes = (held: Record<string, Held>) => Object.values(held).reduce((n, h) => n + (h.payload?.text.length ?? 0), 0);

/** Holds an arrival, replacing any older one for its key; false when the cap would be passed. */
export function holdMem(book: MemBook, key: string, h: Held): boolean {
  const rest = { ...book.held };
  delete rest[key];
  if (heldBytes(rest) + (h.payload?.text.length ?? 0) > HELD_MAX) return false;
  book.held[key] = h;
  return true;
}

/**
 * The held arrivals split by whether this machine has the project: `apply` can be written now,
 * `carry` waits, untouched, for a checkout to appear, so nothing is lost for not being cloned.
 */
export function mergeMemWire(held: Record<string, Held>, known: (pid: string) => boolean): { apply: [string, Held][]; carry: string[] } {
  const apply: [string, Held][] = [], carry: string[] = [];
  for (const [key, h] of Object.entries(held).sort(([a], [b]) => a.localeCompare(b))) {
    const k = parseMemKey(key);
    if (k && known(k.pid)) apply.push([key, h]); else carry.push(key);
  }
  return { apply, carry };
}

/** Pushes of at most ~`max` payload bytes each; one bigger memory still goes, alone. */
export function memChunks<T extends { payload: unknown }>(events: T[], max = 512 * 1024): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const e of events) {
    const n = JSON.stringify(e.payload ?? null).length + 128;
    if (cur.length && size + n > max) { out.push(cur); cur = []; size = 0; }
    cur.push(e);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
