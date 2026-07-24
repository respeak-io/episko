// Every persisted thing in the frontend is localStorage, and the leaf modules read
// their slice of it at *import* time (`const usage = JSON.parse(localStorage…)`).
// vitest runs in the node environment, which has no such global, so the stub has to
// exist before the subject module is evaluated: import this file on the line above
// the subject's import, and let ESM's ordering do the rest.
//
// `store` is the backing map, so a test can seed it before importing a subject, and
// assert on what a subject wrote afterwards.
export const store = new Map<string, string>();

(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;
