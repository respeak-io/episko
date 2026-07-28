// A project's favicon / logo, probed off disk so the sidebar can show something
// recognisable without the user picking one.
//
// The rule that shapes it: **content wins over extension.** Repos routinely ship a
// PNG named `favicon.ico`; trusting the name would emit `data:image/x-icon`
// wrapping PNG bytes, which the webview may refuse — the icon then reads as "found"
// and renders broken. `sniff_mime` reads magic bytes first and falls back to the
// extension only when it recognises nothing.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

// ---------- project favicon / logo discovery ----------

#[derive(serde::Serialize)]
pub(crate) struct ProjectIcon {
    path: String,
    data_uri: String,
}

/// Pick an image MIME from magic bytes, falling back to the file extension.
/// Repos routinely ship a PNG named `favicon.ico`; trusting the extension would
/// emit a `data:image/x-icon` URI wrapping PNG bytes, which the WebKit webview can
/// refuse to render — so the icon would be "found" yet show as broken.
fn sniff_mime(bytes: &[u8], ext: &str) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // SVG is text — look for a `<svg` tag near the start (past any XML prolog).
    let head = &bytes[..bytes.len().min(256)];
    if head.windows(4).any(|w| w.eq_ignore_ascii_case(b"<svg")) {
        return Some("image/svg+xml");
    }
    // Couldn't sniff (e.g. an SVG with a long prolog) — trust the extension.
    match ext {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

/// Read a candidate icon file into a base64 data-URI (small files only). The MIME
/// is sniffed from content (see `sniff_mime`), not assumed from the extension.
fn read_icon(p: &std::path::Path) -> Option<ProjectIcon> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 512 * 1024 {
        return None;
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let bytes = std::fs::read(p).ok()?;
    let mime = sniff_mime(&bytes, &ext)?;
    let b64 = STANDARD.encode(&bytes);
    Some(ProjectIcon {
        path: p.to_string_lossy().to_string(),
        data_uri: format!("data:{mime};base64,{b64}"),
    })
}

/// Conventional favicon / logo spots relative to a web / Tauri / Electron project
/// root. Returns the first that exists (no recursive walk — this stays cheap).
fn probe_icon_dir(base: &std::path::Path) -> Option<ProjectIcon> {
    const CANDIDATES: &[&str] = &[
        "favicon.ico", "favicon.svg", "favicon.png",
        "public/favicon.ico", "public/favicon.svg", "public/favicon.png",
        "public/apple-touch-icon.png", "public/logo.svg", "public/logo.png",
        "public/icon.svg", "public/icon.png",
        "static/favicon.ico", "static/favicon.svg", "static/favicon.png",
        "static/logo.svg", "static/logo.png",
        "app/favicon.ico", "app/icon.png", "app/icon.svg",
        "src/favicon.ico", "src/favicon.svg",
        "src/assets/favicon.ico", "src/assets/favicon.svg", "src/assets/favicon.png",
        "src/assets/logo.svg", "src/assets/logo.png",
        "src/assets/icon.svg", "src/assets/icon.png",
        "assets/favicon.png", "assets/logo.png", "assets/logo.svg", "assets/icon.png",
        "resources/icon.png", "build/icon.png",
        "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
    ];
    CANDIDATES.iter().find_map(|rel| read_icon(&base.join(rel)))
}

/// Scour a project directory for a favicon / logo we can show as its sidebar
/// glyph. Checks the conventional spots at the repo root, then — for monorepos
/// that keep the web app in a subdirectory (e.g. `01_frontend/`, `frontend/`,
/// `apps/web`) — one shallow level of subdirs, frontend-ish names first. This
/// finds a nested `01_frontend/public/favicon.ico` without a deep filesystem walk.
#[tauri::command]
pub(crate) fn find_project_icon(dir: String) -> Option<ProjectIcon> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }
    // Fast path: conventional spots at the repo root.
    if let Some(hit) = probe_icon_dir(base) {
        return Some(hit);
    }
    // Fallback: probe immediate subdirectories, skipping heavy / build output dirs.
    let mut subs: Vec<std::path::PathBuf> = std::fs::read_dir(base)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            !name.starts_with('.')
                && !matches!(
                    name,
                    "node_modules" | "target" | "dist" | "build" | "out"
                        | "vendor" | "coverage" | "tmp" | "__pycache__"
                )
        })
        .collect();
    // Prefer frontend-ish directories, then fall back to alphabetical order so the
    // choice is deterministic (e.g. `01_frontend` before `02_backend`).
    subs.sort_by_key(|p| {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let frontendish = ["front", "web", "client", "app", "ui", "site", "www"]
            .iter()
            .any(|k| name.contains(k));
        (!frontendish, name)
    });
    subs.iter().find_map(|p| probe_icon_dir(p))
}

/// Load a user-picked image as a project's logo. Deliberately runs the same
/// sniff/size gate as discovery (`read_icon`), so a file that isn't really an
/// image — or one too big to sit in localStorage as a data-URI — is rejected here
/// instead of becoming a broken `<img>` in the sidebar.
#[tauri::command]
pub(crate) fn read_custom_icon(path: String) -> Result<ProjectIcon, String> {
    read_icon(std::path::Path::new(&path))
        .ok_or_else(|| "Not a usable image (PNG, SVG, ICO, JPEG, WEBP or GIF, max 512 KB)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;


    /// Repos routinely ship a PNG named `favicon.ico`. Trusting the extension would
    /// emit `data:image/x-icon` wrapping PNG bytes, which the webview may refuse —
    /// the icon reads as "found" but renders broken. So content wins over extension,
    /// and the extension is only the fallback.
    #[test]
    fn sniff_mime_trusts_content_over_extension() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\nIHDR", "ico"), Some("image/png"));
        assert_eq!(sniff_mime(&[0x00, 0x00, 0x01, 0x00, 0x01, 0x00], "png"), Some("image/x-icon"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0], "png"), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"GIF89a\x10\x00", "png"), Some("image/gif"));
        assert_eq!(sniff_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 ", "png"), Some("image/webp"));
        assert_eq!(sniff_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">", "png"), Some("image/svg+xml"));
        // SVG is text, so it's found by tag — past an XML prolog, and case-insensitively.
        assert_eq!(sniff_mime(b"<?xml version=\"1.0\"?>\n<SVG width=\"16\">", "bin"), Some("image/svg+xml"));
        // Unsniffable (e.g. an SVG behind a long prolog) falls back to the extension.
        assert_eq!(sniff_mime(b"", "svg"), Some("image/svg+xml"));
        assert_eq!(sniff_mime(b"nothing recognisable", "webp"), Some("image/webp"));
        // Neither content nor extension says image → no icon, rather than a guess.
        assert_eq!(sniff_mime(b"nothing recognisable", "txt"), None);
    }

}
