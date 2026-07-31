// Notes — the one part of the Trail you type.
//
// A note is **a thread with no agent yet**: something you want done, written down
// before anyone starts it. That framing is the whole point — a note is not a separate
// kind of object to be reconciled later, it is the same work item at an earlier
// stage, which is why dispatching one turns it into a session rather than copying it
// somewhere.
//
// WHY CAPTURE MUST BE FREE. One field, one key, no form. An idea you have to
// categorise is an idea you don't write down, so `project` is optional and everything
// else is derived. The cost of a wrong or unfiled note is that you delete it later;
// the cost of friction is that the thought is gone.
//
// PERSONAL, NOT SHARED. This is `localStorage`, following the split the app already
// draws everywhere else — personal preference in `cc-*`, project fact in `.episko/`.
// Half-formed thoughts are not a teammate's business, and a note only becomes shared
// when you promote it (which, once the board exists, means writing a card). Keeping
// that boundary here means the board can never accidentally publish your scratchpad.
//
// No DOM and no Tauri, so it tests in isolation; ./trailui owns the markup.

/// One captured intention. `project` is a colorKey (the sidebar's own grouping id),
/// null when the note isn't about anything in particular yet.
export interface Note {
  id: string;
  text: string;
  project: string | null;
  created: number;
}

/// One note as the project's committed `.episko/notes.toml` carries it. Mirrors the
/// Rust struct. Read-only from here: a colleague's note is theirs.
export interface SharedNote { id: string; text: string; who: string; at: string }

const KEY = "cc-notes";

/// Ids only have to be unique within one machine's `localStorage`, so this is a
/// timestamp plus a short random tail rather than a uuid — no import, no ceremony,
/// and still collision-free for two notes jotted in the same millisecond.
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Read once at module load, like every other cc-* store in ./state. A corrupt or
// hand-edited value must not take the app down with it, so a bad parse degrades to an
// empty list rather than throwing during import.
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

/** Newest first — the order the Trail shows them in, and the order they were meant. */
export function noteList(project?: string | null): Note[] {
  const all = [...notes].sort((a, b) => b.created - a.created);
  return project ? all.filter((n) => n.project === project) : all;
}

/** Capture. Returns null for an empty jot so the caller needn't test first. */
export function addNote(text: string, project: string | null = null): Note | null {
  const t = text.trim();
  if (!t) return null;
  const n: Note = { id: newId(), text: t, project, created: Date.now() };
  notes.unshift(n);
  save();
  return n;
}

/** Remove one — used both by an explicit delete and by dispatching it into a session,
 *  because a note that has become an agent is no longer waiting to be started. */
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

/** Re-file a note onto a project (or off one). */
export function setNoteProject(id: string, project: string | null): void {
  const n = noteById(id);
  if (!n) return;
  n.project = project;
  save();
}

/// Test seam: reset module state from storage. Nothing in the app calls this — the
/// store is read once at load like its neighbours — but a test that writes
/// `localStorage` needs a way to re-read it.
export function reloadNotes(): void { notes = load(); }
