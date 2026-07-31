// Shared notes — `.episko/notes.toml`, the committable half of the dashboard's jot box.
//
// WHY BOTH HALVES EXIST. A note starts as a half-formed thought, and half-formed
// thoughts are not a teammate's business — so capture is personal (`localStorage`, see
// ./notes.ts) and stays that way until you decide otherwise. Promoting one writes it
// here, where it is committed, diffable, and readable by a colleague who never opens
// Episko. That is the same split the app draws everywhere else: **personal preference
// in `cc-*`, project fact in `.episko/`.**
//
// Sharing needs *git*, not GitHub — this is a file, and a file only means anything to
// a team if it can be committed. A repo with a GitLab remote, or no remote at all,
// shares exactly as well as one on GitHub.
//
// `toml_edit` rather than a serialize-the-whole-file round trip, like `tasks.rs`: the
// file is meant to be hand-editable, and a colleague's comment or ordering must
// survive Episko touching it.

use std::path::{Path, PathBuf};

/// One shared note. `id` is the frontend's own id, so promoting and demoting the same
/// note is idempotent rather than producing a duplicate on the second try.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct SharedNote {
    pub id: String,
    pub text: String,
    /// Who wrote it. The list is a team artifact, so an unattributed row would raise
    /// "whose is this?" on every read.
    pub who: String,
    /// ISO-8601, day resolution — an hour adds nothing and churns the diff.
    pub at: String,
}

fn notes_path(root: &str) -> PathBuf {
    Path::new(root).join(".episko").join("notes.toml")
}

/// Everything in the project's shared list. A missing or malformed file is an empty
/// list, never an error: the same forgiving-on-read stance `tasks.rs` takes with a
/// broken `tasks.toml`, and for the same reason — one bad edit must not take a
/// feature away from the whole team.
#[tauri::command]
pub(crate) fn list_shared_notes(root: String) -> Vec<SharedNote> {
    let Ok(text) = std::fs::read_to_string(notes_path(&root)) else { return vec![] };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else { return vec![] };
    let Some(arr) = doc.get("note").and_then(|n| n.as_array_of_tables()) else { return vec![] };
    arr.iter()
        .filter_map(|t| {
            let text = t.get("text")?.as_str()?.trim();
            if text.is_empty() {
                return None;
            }
            Some(SharedNote {
                id: t.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                text: text.to_string(),
                who: t.get("who").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                at: t.get("at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Promote a note into the project (`share = true`) or take it back out.
///
/// `create` gates the very first write, because a new committable file in someone's
/// repo is a real side effect — the same stance `tasks.rs` takes with `tasks.toml` and
/// `summarize.rs` with `digest.md`.
#[tauri::command]
pub(crate) fn set_shared_note(
    root: String, id: String, text: String, who: String, at: String, share: bool, create: bool,
) -> Result<(), String> {
    let path = notes_path(&root);
    if !path.is_file() && !create {
        return Err("no .episko/notes.toml yet".into());
    }
    if share && text.trim().is_empty() {
        return Err("an empty note is not worth sharing".into());
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut doc = existing.parse::<toml_edit::DocumentMut>().map_err(|e| e.to_string())?;
    if doc.get("note").is_none() {
        doc["note"] = toml_edit::Item::ArrayOfTables(toml_edit::ArrayOfTables::new());
    }
    let arr = doc["note"].as_array_of_tables_mut().ok_or("note is not an array of tables")?;
    // Drop any existing entry for this id first: sharing twice must update rather than
    // duplicate, and un-sharing is simply the removal.
    arr.retain(|t| t.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
    if share {
        let mut t = toml_edit::Table::new();
        t["id"] = toml_edit::value(id);
        t["text"] = toml_edit::value(text.trim());
        t["who"] = toml_edit::value(who);
        t["at"] = toml_edit::value(at);
        arr.push(t);
    }
    if arr.is_empty() {
        doc.remove("note");
    }
    let dir = path.parent().ok_or("bad root")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // Temp-then-rename: a crash mid-write must not truncate a file under version
    // control.
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

    fn root_of(d: &Path) -> String { d.to_string_lossy().to_string() }

    #[test]
    fn refuses_to_create_the_file_until_it_is_allowed_to() {
        let d = scratch_dir();
        let r = root_of(&d);
        assert!(set_shared_note(r.clone(), "n1".into(), "hi".into(), "Tim".into(), "2026-07-31".into(), true, false).is_err());
        assert!(!d.join(".episko").join("notes.toml").exists());
        set_shared_note(r.clone(), "n1".into(), "hi".into(), "Tim".into(), "2026-07-31".into(), true, true).unwrap();
        assert_eq!(list_shared_notes(r).len(), 1);
    }

    #[test]
    fn sharing_the_same_note_twice_updates_rather_than_duplicating() {
        let d = scratch_dir();
        let r = root_of(&d);
        set_shared_note(r.clone(), "n1".into(), "first".into(), "Tim".into(), "2026-07-31".into(), true, true).unwrap();
        set_shared_note(r.clone(), "n1".into(), "second".into(), "Tim".into(), "2026-07-31".into(), true, false).unwrap();
        let l = list_shared_notes(r);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].text, "second");
    }

    #[test]
    fn unsharing_removes_it_and_empties_the_table() {
        let d = scratch_dir();
        let r = root_of(&d);
        set_shared_note(r.clone(), "n1".into(), "hi".into(), "Tim".into(), "2026-07-31".into(), true, true).unwrap();
        set_shared_note(r.clone(), "n1".into(), String::new(), String::new(), String::new(), false, false).unwrap();
        assert!(list_shared_notes(r).is_empty());
        let text = std::fs::read_to_string(d.join(".episko").join("notes.toml")).unwrap();
        assert!(!text.contains("[[note]]"), "an empty table is noise: {text}");
    }

    #[test]
    fn a_hand_written_comment_survives_a_write() {
        // The file is meant to be hand-editable. toml_edit is what keeps that true —
        // a serialize-the-whole-struct round trip would eat this.
        let d = scratch_dir();
        let r = root_of(&d);
        std::fs::create_dir_all(d.join(".episko")).unwrap();
        std::fs::write(d.join(".episko").join("notes.toml"),
            "# team notes — keep these short\n\n[[note]]\nid = \"a\"\ntext = \"existing\"\nwho = \"Frederic\"\nat = \"2026-07-20\"\n").unwrap();
        set_shared_note(r.clone(), "b".into(), "added".into(), "Tim".into(), "2026-07-31".into(), true, false).unwrap();
        let text = std::fs::read_to_string(d.join(".episko").join("notes.toml")).unwrap();
        assert!(text.contains("# team notes — keep these short"), "comment was eaten: {text}");
        assert_eq!(list_shared_notes(r).len(), 2);
    }

    #[test]
    fn a_malformed_file_reads_as_empty_rather_than_taking_the_feature_away() {
        let d = scratch_dir();
        std::fs::create_dir_all(d.join(".episko")).unwrap();
        std::fs::write(d.join(".episko").join("notes.toml"), "this is not [ valid toml").unwrap();
        assert!(list_shared_notes(root_of(&d)).is_empty());
    }

    #[test]
    fn an_empty_note_is_refused_rather_than_written() {
        let d = scratch_dir();
        let r = root_of(&d);
        assert!(set_shared_note(r, "n1".into(), "   ".into(), "Tim".into(), "2026-07-31".into(), true, true).is_err());
    }
}
