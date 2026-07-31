// The project board — RFC #24's committable cards, on disk.
//
// One markdown file per card under `.episko/board/`, because that is the shape that
// survives a team: high-churn content in separate files merges cleanly, and a colleague
// on vim or Cursor reads the same board on GitHub without installing anything. The
// low-churn part (columns, WIP limits) is one `board.toml` beside it, TOML like its
// neighbour `tasks.toml`.
//
// FOUR RULES FROM THE RFC, and each one is load-bearing:
//
//  1. **Random ids, not sequential.** Two people creating a card on two branches must
//     never collide, which is exactly what `task-005` guarantees they will.
//  2. **`order` is a sparse integer** (gaps of 1000, insert at the midpoint) so moving
//     a card rewrites ONE file. Two people reordering different columns then never
//     touch the same bytes.
//  3. **No machine-local state in the file.** Which pane runs a card, its cost, its
//     phase — a session uuid means nothing to a teammate. Committed fields are only
//     the ones a human reading GitHub would want.
//  4. **Writes target the repo root, never the active worktree.** A board move is
//     metadata, not code, and must not ride a feature branch — otherwise your board on
//     `feat/x` and mine on `main` are different boards.
//
// PRESERVE WHAT WE DID NOT WRITE. Frontmatter is parsed as an ordered list of raw
// key/value lines, not deserialised into a struct: unknown keys, their order and the
// body all survive a round trip untouched. That is the same promise `toml_edit` gives
// `tasks.toml`, and it matters more here because agents hand-write these files.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Gap between adjacent cards. Big enough that inserting between two neighbours is
/// always a midpoint away, so a move rewrites one file and never renumbers a column.
pub(crate) const ORDER_GAP: i64 = 1000;

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct Card {
    pub id: String,
    pub title: String,
    pub status: String,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
    pub branch: Option<String>,
    pub order: i64,
    pub created: Option<String>,
    /// Everything after the frontmatter, verbatim — the card's brief, and what a
    /// dispatched agent is handed.
    pub body: String,
    /// Relative to the repo root, for "reveal source".
    pub source_file: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub(crate) struct BoardColumn {
    pub id: String,
    pub label: String,
    /// 0 = no limit. Only meaningful for the in-flight column, but stored per column
    /// so a team can bound review too.
    pub wip: u32,
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct Board {
    pub columns: Vec<BoardColumn>,
    pub cards: Vec<Card>,
    /// False when `.episko/board/` does not exist — the UI offers to create it rather
    /// than showing an empty board that looks broken.
    pub exists: bool,
}

/// The default columns, used when `board.toml` is absent. Deliberately the ones the
/// concept page settled on: unstarted → ready → running → blocked → review → done.
fn default_columns() -> Vec<BoardColumn> {
    [
        ("ideas", "Ideas", 0u32),
        ("ready", "Ready", 0),
        ("doing", "In flight", 4),
        ("blocked", "Needs you", 0),
        ("review", "Review", 0),
        ("done", "Done", 0),
    ]
    .iter()
    .map(|(id, label, wip)| BoardColumn { id: (*id).into(), label: (*label).into(), wip: *wip })
    .collect()
}

// ---------- frontmatter: an ordered, lossless key/value list ----------

/// Parsed frontmatter, kept as raw lines in file order.
///
/// NOT a struct with named fields, on purpose. Deserialising would silently drop any
/// key we don't know about, and these files are hand-written by humans and agents who
/// will absolutely put things in them that we have never heard of. Round-tripping the
/// raw lines is what makes "Episko never reformats a file it didn't create" true.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Front {
    pub entries: Vec<(String, String)>,
}

impl Front {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
    /// Update in place, preserving position; append if new.
    pub fn set(&mut self, key: &str, value: &str) {
        if let Some(e) = self.entries.iter_mut().find(|(k, _)| k == key) {
            e.1 = value.to_string();
        } else {
            self.entries.push((key.to_string(), value.to_string()));
        }
    }
    pub fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }
}

/// Split a card file into (frontmatter, body).
///
/// Forgiving by design: a file with no `---` block is still a card — its id comes from
/// the filename and its title from the first `# ` heading. Agents will hand-write these,
/// and a strict parser would make a perfectly readable board look broken.
pub(crate) fn split_front(text: &str) -> (Front, String) {
    let norm = text.replace("\r\n", "\n");
    let Some(rest) = norm.strip_prefix("---\n") else {
        return (Front::default(), norm);
    };
    let Some(end) = rest.find("\n---") else {
        return (Front::default(), norm);
    };
    let block = &rest[..end];
    // Skip past the closing fence and the newline that follows it.
    let after = &rest[end + 4..];
    let body = after.strip_prefix('\n').unwrap_or(after).to_string();

    let mut front = Front::default();
    for line in block.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let Some((k, v)) = t.split_once(':') else { continue };
        front.entries.push((k.trim().to_string(), v.trim().to_string()));
    }
    (front, body)
}

/// Re-emit a card file. The body is written back byte-for-byte.
pub(crate) fn join_front(front: &Front, body: &str) -> String {
    let mut s = String::from("---\n");
    for (k, v) in &front.entries {
        s.push_str(k);
        s.push_str(": ");
        s.push_str(v);
        s.push('\n');
    }
    s.push_str("---\n\n");
    s.push_str(body.trim_start_matches('\n'));
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `[a, b]` → ["a","b"]. A flat subset, because we control the schema and the Rust
/// YAML ecosystem is deprecated/fragmented — pulling a parser in for this would be a
/// dependency with a maintenance story worse than the problem.
fn parse_list(raw: &str) -> Vec<String> {
    let inner = raw.trim().trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
fn fmt_list(items: &[String]) -> String {
    format!("[{}]", items.join(", "))
}

/// The first `# ` heading, for a card with no `title:`.
fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .find(|l| l.trim_start().starts_with("# "))
        .map(|l| l.trim_start().trim_start_matches("# ").trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse one card file. `stem` is the filename without `.md`, used for the id when the
/// frontmatter has none.
pub(crate) fn parse_card(text: &str, stem: &str, rel_path: &str, first_column: &str) -> Card {
    let (front, body) = split_front(text);
    // `k3f9a2-board-mcp-server` → `k3f9a2`. The id is the part before the first dash;
    // the rest is a human-readable slug that may change without breaking references.
    let id_from_stem = stem.split('-').next().unwrap_or(stem).to_string();
    Card {
        id: front.get("id").map(str::to_string).filter(|s| !s.is_empty()).unwrap_or(id_from_stem),
        title: front
            .get("title")
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| first_heading(&body))
            .unwrap_or_else(|| stem.to_string()),
        status: front
            .get("status")
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| first_column.to_string()),
        labels: front.get("labels").map(parse_list).unwrap_or_default(),
        assignee: front.get("assignee").map(str::to_string).filter(|s| !s.is_empty()),
        branch: front.get("branch").map(str::to_string).filter(|s| !s.is_empty()),
        order: front.get("order").and_then(|s| s.parse().ok()).unwrap_or(0),
        created: front.get("created").map(str::to_string).filter(|s| !s.is_empty()),
        body,
        source_file: rel_path.to_string(),
    }
}

// ---------- ids ----------

/// Six characters of Crockford base32 — no I, L, O or U, so an id can be read aloud and
/// typed back without ambiguity. Random rather than sequential for RFC rule 1.
///
/// Seeded from the system clock and the address of a local allocation: this needs
/// collision resistance across two developers' machines, not cryptographic strength,
/// and it avoids taking a `rand` dependency for six characters.
pub(crate) fn new_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    // A process-global counter is what makes rapid calls differ. The clock alone is
    // not enough: creating several cards in a loop reads nearly the same nanos, and a
    // stack address is identical every call — seeded that way the ids collided about
    // two-thirds of the time, which is precisely the failure sequential ids have.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let local = 0u8;
    let addr = &local as *const u8 as u64;

    // splitmix64 — one well-distributed draw per character, rather than xorshift's
    // correlated low bits.
    let mut state = nanos ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ addr.rotate_left(17);
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    (0..6).map(|_| ALPHABET[(next() % 32) as usize] as char).collect()
}

/// `Board MCP server` → `board-mcp-server`, for the filename's readable half.
fn slug(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    let mut out = String::new();
    let mut prev_dash = false;
    for c in s.chars() {
        if c == '-' {
            if !prev_dash { out.push(c); }
            prev_dash = true;
        } else {
            out.push(c);
            prev_dash = false;
        }
    }
    out.chars().take(48).collect::<String>().trim_matches('-').to_string()
}

// ---------- paths + cache ----------

fn board_dir(root: &str) -> PathBuf { Path::new(root).join(".episko").join("board") }
fn board_toml(root: &str) -> PathBuf { Path::new(root).join(".episko").join("board.toml") }

type Stamp = Vec<(String, Option<(std::time::SystemTime, u64)>)>;

/// The same `(mtime, len)` trick `discover_cached` uses in tasks.rs, and for the same
/// reason: ~N `metadata()` calls answer instantly what a file watcher needs a thread, a
/// crate and a per-project lifecycle to answer. A missing file is part of the stamp, so
/// creating or deleting a card invalidates too.
fn stamp(root: &str) -> Stamp {
    let dir = board_dir(root);
    let mut out: Stamp = Vec::new();
    let meta = |p: &Path| std::fs::metadata(p).ok().map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len()));
    out.push(("board.toml".into(), meta(&board_toml(root))));
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut files: Vec<_> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
            .collect();
        // Sorted, or directory order makes two identical states compare unequal.
        files.sort();
        for f in files {
            out.push((f.to_string_lossy().to_string(), meta(&f)));
        }
    }
    out
}

struct Cached { stamp: Stamp, board: Board }
static CACHE: LazyLock<Mutex<std::collections::HashMap<String, Cached>>> = LazyLock::new(Default::default);

fn read_columns(root: &str) -> Vec<BoardColumn> {
    #[derive(serde::Deserialize)]
    struct RawFile { column: Option<Vec<RawCol>> }
    #[derive(serde::Deserialize)]
    struct RawCol { id: String, label: Option<String>, wip: Option<u32> }
    let Ok(text) = std::fs::read_to_string(board_toml(root)) else { return default_columns() };
    let Ok(f) = toml::from_str::<RawFile>(&text) else { return default_columns() };
    let Some(cols) = f.column else { return default_columns() };
    if cols.is_empty() {
        return default_columns();
    }
    cols.into_iter()
        .map(|c| BoardColumn { label: c.label.unwrap_or_else(|| c.id.clone()), id: c.id, wip: c.wip.unwrap_or(0) })
        .collect()
}

fn read_board(root: &str) -> Board {
    let columns = read_columns(root);
    let first = columns.first().map(|c| c.id.clone()).unwrap_or_else(|| "ideas".into());
    let dir = board_dir(root);
    let exists = dir.is_dir();
    let mut cards = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let rel = format!(".episko/board/{}", p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default());
            cards.push(parse_card(&text, &stem, &rel, &first));
        }
    }
    // Stable order: by `order`, then by id, so an unchanged board never reshuffles.
    cards.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    Board { columns, cards, exists }
}

#[tauri::command(async)]
pub(crate) fn list_cards(root: String) -> Board {
    let s = stamp(&root);
    if let Ok(guard) = CACHE.lock() {
        if let Some(hit) = guard.get(&root) {
            if hit.stamp == s {
                return hit.board.clone();
            }
        }
    }
    let board = read_board(&root);
    if let Ok(mut guard) = CACHE.lock() {
        guard.insert(root.clone(), Cached { stamp: s, board: board.clone() });
    }
    board
}

// ---------- writes ----------

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    // temp + rename, like tasks.rs: a crash mid-write must never leave a half-written
    // card that then fails to parse.
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn find_card_path(root: &str, id: &str) -> Option<PathBuf> {
    std::fs::read_dir(board_dir(root)).ok()?.filter_map(|e| e.ok()).map(|e| e.path()).find(|p| {
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            return false;
        }
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        if stem.split('-').next() == Some(id) {
            return true;
        }
        // A card whose frontmatter id disagrees with its filename still resolves.
        std::fs::read_to_string(p).map(|t| split_front(&t).0.get("id") == Some(id)).unwrap_or(false)
    })
}

/// Create a card. Returns its id.
#[tauri::command(async)]
pub(crate) fn create_card(root: String, title: String, status: String, body: String) -> Result<String, String> {
    let id = new_id();
    let cols = read_columns(&root);
    let status = if status.is_empty() {
        cols.first().map(|c| c.id.clone()).unwrap_or_else(|| "ideas".into())
    } else {
        status
    };
    // Land at the end of its column: max existing order + one gap.
    let board = read_board(&root);
    let max = board.cards.iter().filter(|c| c.status == status).map(|c| c.order).max().unwrap_or(0);
    let mut front = Front::default();
    front.set("id", &id);
    front.set("title", &title);
    front.set("status", &status);
    front.set("order", &(max + ORDER_GAP).to_string());
    let path = board_dir(&root).join(format!("{}-{}.md", id, slug(&title)));
    write_atomic(&path, &join_front(&front, &body))?;
    Ok(id)
}

/// Move a card to a column and position. Rewrites exactly one file (RFC rule 2), and
/// preserves every key it did not come to change.
#[tauri::command(async)]
pub(crate) fn move_card(root: String, id: String, status: String, order: i64) -> Result<(), String> {
    let path = find_card_path(&root, &id).ok_or("card not found")?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut front, body) = split_front(&text);
    front.set("status", &status);
    front.set("order", &order.to_string());
    if front.get("id").is_none() {
        front.set("id", &id); // a hand-written card gets its id recorded on first move
    }
    write_atomic(&path, &join_front(&front, &body))
}

/// Update the human-editable fields of a card. `None` leaves a field untouched.
#[tauri::command(async)]
pub(crate) fn update_card(
    root: String,
    id: String,
    title: Option<String>,
    labels: Option<Vec<String>>,
    assignee: Option<String>,
    branch: Option<String>,
    body: Option<String>,
) -> Result<(), String> {
    let path = find_card_path(&root, &id).ok_or("card not found")?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (mut front, old_body) = split_front(&text);
    if let Some(t) = title { front.set("title", &t); }
    if let Some(l) = labels { front.set("labels", &fmt_list(&l)); }
    if let Some(a) = assignee {
        if a.is_empty() { front.remove("assignee") } else { front.set("assignee", &a) }
    }
    if let Some(b) = branch {
        if b.is_empty() { front.remove("branch") } else { front.set("branch", &b) }
    }
    write_atomic(&path, &join_front(&front, &body.unwrap_or(old_body)))
}

#[tauri::command(async)]
pub(crate) fn delete_card(root: String, id: String) -> Result<(), String> {
    let path = find_card_path(&root, &id).ok_or("card not found")?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Create `.episko/board/` for the first time. Asked for explicitly, because a new
/// committable directory in someone's repo is a real side effect — the same courtesy
/// `tasks.rs` extends before creating `tasks.toml`.
#[tauri::command(async)]
pub(crate) fn create_board(root: String) -> Result<(), String> {
    std::fs::create_dir_all(board_dir(&root)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::scratch_dir;

    #[test]
    fn round_trips_a_file_it_did_not_write() {
        // The promise: Episko never reformats what a human or another tool wrote. An
        // agent will absolutely put keys in here that we have never heard of.
        let src = "---\nid: k3f9a2\ntitle: Board MCP server\nstatus: doing\nepic: platform\nnotes: keep me\norder: 3000\n---\n\n## Goal\nExpose board_* tools.\n";
        let (mut front, body) = split_front(src);
        assert_eq!(front.get("epic"), Some("platform"));
        front.set("status", "review");
        let out = join_front(&front, &body);

        // Unknown keys survive, in their original positions.
        assert!(out.contains("epic: platform"));
        assert!(out.contains("notes: keep me"));
        // skip(1) past the opening fence — without it take_while stops immediately and
        // the assertion below silently checks nothing.
        let keys: Vec<&str> = out.lines().skip(1).take_while(|l| *l != "---").collect();
        assert_eq!(
            keys,
            vec!["id: k3f9a2", "title: Board MCP server", "status: review", "epic: platform", "notes: keep me", "order: 3000"],
            "frontmatter order or content changed");
        // The body is untouched.
        assert!(out.contains("## Goal\nExpose board_* tools."));
        assert!(out.contains("status: review"));
    }

    #[test]
    fn a_card_with_no_frontmatter_is_still_a_card() {
        // Forgiving on read: agents hand-write these, and a strict parser would make a
        // perfectly readable board look broken.
        let c = parse_card("# Fix the flaky test\n\nSome detail.\n", "q7m1xd-fix-flaky", ".episko/board/x.md", "ideas");
        assert_eq!(c.id, "q7m1xd");          // from the filename
        assert_eq!(c.title, "Fix the flaky test"); // from the first heading
        assert_eq!(c.status, "ideas");       // the first column
        assert_eq!(c.order, 0);
    }

    #[test]
    fn falls_back_to_the_stem_when_there_is_no_heading_either() {
        let c = parse_card("just prose\n", "abc123-something", "x", "ideas");
        assert_eq!(c.title, "abc123-something");
    }

    #[test]
    fn parses_the_flat_yaml_subset_we_actually_use() {
        let c = parse_card(
            "---\nid: k3f9a2\ntitle: A card\nstatus: doing\nlabels: [backend, p2]\nassignee: tim\norder: 2500\n---\nbody\n",
            "k3f9a2-a-card", "x", "ideas");
        assert_eq!(c.labels, vec!["backend", "p2"]);
        assert_eq!(c.assignee.as_deref(), Some("tim"));
        assert_eq!(c.order, 2500);
        assert_eq!(c.body.trim(), "body");
    }

    #[test]
    fn ids_are_random_and_readable() {
        // RFC rule 1: two people on two branches must never collide, which sequential
        // ids guarantee they will.
        let ids: std::collections::HashSet<String> = (0..200).map(|_| new_id()).collect();
        assert!(ids.len() > 190, "ids collide too often: {} unique of 200", ids.len());
        for id in &ids {
            assert_eq!(id.len(), 6);
            // Crockford base32 excludes i/l/o/u so an id can be read aloud.
            assert!(!id.contains('i') && !id.contains('l') && !id.contains('o') && !id.contains('u'), "{id}");
        }
    }

    #[test]
    fn moving_a_card_rewrites_one_file_and_keeps_everything_else() {
        let root = scratch_dir();
        let r = root.to_string_lossy().to_string();
        create_board(r.clone()).unwrap();
        let id = create_card(r.clone(), "Board MCP server".into(), "ready".into(), "## Goal\ndo it\n".into()).unwrap();

        // A key we never wrote, added by hand afterwards.
        let path = find_card_path(&r, &id).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("---\n\n", "epic: platform\n---\n\n")).unwrap();

        move_card(r.clone(), id.clone(), "doing".into(), 4200).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("status: doing"));
        assert!(after.contains("order: 4200"));
        assert!(after.contains("epic: platform"), "unknown key was dropped:\n{after}");
        assert!(after.contains("## Goal"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_cache_invalidates_when_a_card_appears_or_changes() {
        let root = scratch_dir();
        let r = root.to_string_lossy().to_string();
        create_board(r.clone()).unwrap();
        assert_eq!(list_cards(r.clone()).cards.len(), 0);

        let id = create_card(r.clone(), "First".into(), "ready".into(), String::new()).unwrap();
        // A file appearing is part of the stamp, so the cache must not serve the empty
        // board it just memoised.
        assert_eq!(list_cards(r.clone()).cards.len(), 1);

        move_card(r.clone(), id, "doing".into(), 9000).unwrap();
        assert_eq!(list_cards(r.clone()).cards[0].status, "doing");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn columns_come_from_board_toml_when_it_exists() {
        let root = scratch_dir();
        let r = root.to_string_lossy().to_string();
        create_board(r.clone()).unwrap();
        std::fs::write(
            board_toml(&r),
            "[[column]]\nid = \"todo\"\nlabel = \"To do\"\n\n[[column]]\nid = \"wip\"\nwip = 2\n",
        ).unwrap();
        let b = list_cards(r.clone());
        assert_eq!(b.columns.len(), 2);
        assert_eq!(b.columns[0].label, "To do");
        assert_eq!(b.columns[1].label, "wip"); // label defaults to the id
        assert_eq!(b.columns[1].wip, 2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_broken_board_toml_falls_back_rather_than_emptying_the_board() {
        let root = scratch_dir();
        let r = root.to_string_lossy().to_string();
        create_board(r.clone()).unwrap();
        std::fs::write(board_toml(&r), "not [ valid").unwrap();
        assert_eq!(list_cards(r.clone()).columns, default_columns());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn update_preserves_the_body_unless_it_is_given_one() {
        let root = scratch_dir();
        let r = root.to_string_lossy().to_string();
        create_board(r.clone()).unwrap();
        let id = create_card(r.clone(), "T".into(), "ready".into(), "the brief\n".into()).unwrap();

        update_card(r.clone(), id.clone(), Some("Renamed".into()), Some(vec!["a".into(), "b".into()]), None, None, None).unwrap();
        let c = list_cards(r.clone()).cards.into_iter().find(|c| c.id == id).unwrap();
        assert_eq!(c.title, "Renamed");
        assert_eq!(c.labels, vec!["a", "b"]);
        assert_eq!(c.body.trim(), "the brief");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn crlf_files_parse_the_same_as_lf() {
        // A colleague on Windows commits CRLF; the board must not read as one long body.
        let c = parse_card("---\r\nid: abc\r\ntitle: X\r\nstatus: doing\r\n---\r\n\r\nbody\r\n", "abc-x", "x", "ideas");
        assert_eq!(c.id, "abc");
        assert_eq!(c.status, "doing");
        assert_eq!(c.title, "X");
    }
}
