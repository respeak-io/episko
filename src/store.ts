// The one home for reading a `cc-` key. Every read narrows rather than trusts (CLAUDE.md):
// these run at module scope, where a throw is a blank window before any UI exists to say why,
// and a stored `"null"` or `"[]"` parses fine and only fails at the first property access,
// somewhere else entirely. A leaf — it imports nothing, so any module may read through it.

/** `JSON.parse` that answers null instead of throwing. Shape is the caller's business. */
export function safeParse<T>(raw: string | null): Partial<T> | null {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** A stored object, or `{}`: never an array, a scalar or `null`. */
export function readObj<T>(key: string): Record<string, T> {
  const v = safeParse<Record<string, T>>(localStorage.getItem(key));
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, T> : {};
}

/** A stored array, or `[]`. Elements are the caller's business. */
export function readList<T>(key: string): T[] {
  const v = safeParse<T[]>(localStorage.getItem(key));
  return Array.isArray(v) ? v as T[] : [];
}
