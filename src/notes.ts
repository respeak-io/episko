// Notes: the one part of the Trail you type. A note is a thread with no agent yet, so
// dispatching one turns it into a session. Capture must be free (`project` is optional),
// and the store is personal `localStorage`, never `.episko/`; ./trailui owns the markup.

export interface Note {
  id: string;
  text: string;
  project: string | null; // a colorKey; null until filed
  created: number;
}

// As the committed `.episko/notes.toml` carries it; mirrors the Rust struct. Read-only here.
export interface SharedNote { id: string; text: string; who: string; at: string }

const KEY = "cc-notes";

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function load(): Note[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((n): n is Note => !!n && typeof n.id === "string" && typeof n.text === "string");
  } catch {
    return [];
  }
}

export let notes: Note[] = load();

function save() { localStorage.setItem(KEY, JSON.stringify(notes)); }

/** Newest first. */
export function noteList(project?: string | null): Note[] {
  const all = [...notes].sort((a, b) => b.created - a.created);
  return project ? all.filter((n) => n.project === project) : all;
}

export function addNote(text: string, project: string | null = null): Note | null {
  const t = text.trim();
  if (!t) return null;
  const n: Note = { id: newId(), text: t, project, created: Date.now() };
  notes.unshift(n);
  save();
  return n;
}

/** Used by delete and by dispatch alike: a note that became an agent is no longer waiting. */
export function removeNote(id: string): Note | null {
  const i = notes.findIndex((n) => n.id === id);
  if (i < 0) return null;
  const [n] = notes.splice(i, 1);
  save();
  return n;
}

export function noteById(id: string): Note | null {
  return notes.find((n) => n.id === id) || null;
}

export function setNoteProject(id: string, project: string | null): void {
  const n = noteById(id);
  if (!n) return;
  n.project = project;
  save();
}

export function reloadNotes(): void { notes = load(); } // test seam; nothing in the app calls it
