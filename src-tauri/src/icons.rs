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

// ---------- tray status glyphs ----------

// The sidebar's status vocabulary, rasterised so the tray menu can carry it in
// colour. A menu item's *text* is always drawn in the menu's own colour, so the
// glyph a text row spells (`◆`, `✕`) arrives the same grey as "Quit"; an item's
// icon is an image and is not tinted, so this is the only way a status reaches
// the menu as anything but a character.
//
// Two things this deliberately does NOT decide. **Which shape and which colour** —
// the frontend sends both, because it already owns them (`GCLASS` maps a status to
// a class, `styles.css` gives that class its hue). Deriving them again here would
// be a second copy of the palette, and the copies would part company the first time
// a hue is re-stepped for the light theme. And **the size on screen**: muda scales
// the image to an 18pt row height on macOS and blits it into a hard-coded 16×16
// bitmap on Windows, so 32px is a source that halves exactly for Windows and still
// out-resolves the macOS row on a retina display.

/// Distance from `p` to the segment `a`–`b`. The shapes below are strokes and
/// outlines, so all of them are expressed as a distance to a line or a circle.
fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (vx, vy) = (bx - ax, by - ay);
    let (wx, wy) = (px - ax, py - ay);
    let len2 = vx * vx + vy * vy;
    let t = if len2 <= f32::EPSILON { 0.0 } else { ((wx * vx + wy * vy) / len2).clamp(0.0, 1.0) };
    let (dx, dy) = (wx - t * vx, wy - t * vy);
    (dx * dx + dy * dy).sqrt()
}

/// Signed distance to the named shape, in pixels on the 32px canvas, with the
/// origin at its centre and **y running down** (image order, not maths order — the
/// check mark's elbow is the lowest point on screen, so it has the largest `y`).
/// An unknown name draws the plain disc: a new status should look like *a* status,
/// not like a hole in the menu.
fn shape_sdf(shape: &str, x: f32, y: f32) -> f32 {
    let len = (x * x + y * y).sqrt();
    match shape {
        // `○` idle — an outline, so it reads as "nothing is happening here" against
        // the filled shapes without needing a second colour.
        "ring" => (len - 8.5).abs() - 1.3,
        // `◆` attention. `/ √2` converts the octagonal-norm distance to a true one,
        // which is what keeps the anti-aliased edge the same weight as the disc's.
        "diamond" => (x.abs() + y.abs() - 11.0) * std::f32::consts::FRAC_1_SQRT_2,
        // `✓` done — two strokes, elbow low and left.
        "check" => seg_dist(x, y, -7.5, -0.5, -2.5, 5.0).min(seg_dist(x, y, -2.5, 5.0, 8.0, -6.0)) - 1.6,
        // `✕` error.
        "cross" => seg_dist(x, y, -6.5, -6.5, 6.5, 6.5).min(seg_dist(x, y, -6.5, 6.5, 6.5, -6.5)) - 1.5,
        // `❯` a live shell pane — not a phase, which is why it isn't a dot at all.
        "chevron" => seg_dist(x, y, -5.5, -7.5, 4.0, 0.0).min(seg_dist(x, y, 4.0, 0.0, -5.5, 7.5)) - 1.6,
        // `·` ended. Small rather than grey-and-full-size, so it stays quiet even
        // when the theme puts a light ground under it.
        "small" => len - 4.5,
        // `●` working / thinking, and the fallback.
        _ => len - 9.0,
    }
}

/// Rasterise one status glyph as 32×32 straight (non-premultiplied) RGBA, which is
/// what `tauri::image::Image::new_owned` takes — so the seven states cost no asset
/// files and re-colour from the app's own tokens.
pub(crate) fn glyph_rgba(shape: &str, rgb: [u8; 3]) -> Vec<u8> {
    const N: usize = 32;
    const C: f32 = N as f32 / 2.0;
    let mut out = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            // Coverage from the signed distance, over one pixel of falloff. Cheap
            // anti-aliasing, and enough for shapes this simple.
            let d = shape_sdf(shape, x as f32 + 0.5 - C, y as f32 + 0.5 - C);
            let cov = (0.5 - d).clamp(0.0, 1.0);
            if cov <= 0.0 {
                continue;
            }
            let i = (y * N + x) * 4;
            out[i] = rgb[0];
            out[i + 1] = rgb[1];
            out[i + 2] = rgb[2];
            out[i + 3] = (cov * 255.0).round() as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The buffer's shape is a contract with `Image::new_owned(rgba, 32, 32)`, which
    /// takes the dimensions on trust — a short buffer is a panic or a garbled icon
    /// somewhere inside AppKit, not a compile error here.
    #[test]
    fn glyph_rgba_is_a_full_32x32_rgba_buffer() {
        assert_eq!(glyph_rgba("disc", [1, 2, 3]).len(), 32 * 32 * 4);
        assert_eq!(glyph_rgba("check", [1, 2, 3]).len(), 32 * 32 * 4);
    }

    /// Every opaque pixel carries the colour it was asked for. This is the whole
    /// point of the exercise: a text row's glyph arrives in the menu's grey, and an
    /// icon's does not.
    #[test]
    fn glyph_rgba_paints_the_colour_it_was_given() {
        let px = glyph_rgba("disc", [224, 164, 74]);
        let centre = (16 * 32 + 16) * 4;
        assert_eq!(&px[centre..centre + 4], &[224, 164, 74, 255]);
        // ...and leaves the corner fully transparent, so the row's background shows
        // through rather than a 32px square of colour.
        assert_eq!(px[3], 0);
    }

    /// The shapes must actually differ, or the whole set collapses to "coloured dot"
    /// and a red ✕ becomes indistinguishable from a red ● for anyone reading shape
    /// before hue — which is most people, and all of the colourblind ones.
    #[test]
    fn each_shape_draws_something_different() {
        let alpha = |s: &str| glyph_rgba(s, [255, 255, 255]).chunks(4).map(|p| p[3] as u32).sum::<u32>();
        let names = ["disc", "ring", "diamond", "check", "cross", "chevron", "small"];
        let mut seen: Vec<u32> = names.iter().map(|s| alpha(s)).collect();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), before, "two shapes rasterised identically");
        // The ring is hollow and the disc is not — the pair most likely to collapse
        // if the ring's stroke width is ever widened past its radius.
        let centre = (16 * 32 + 16) * 4 + 3;
        assert_eq!(glyph_rgba("ring", [255, 255, 255])[centre], 0);
        assert_eq!(glyph_rgba("disc", [255, 255, 255])[centre], 255);
    }

    /// A status the frontend gains before this list does must still draw *a* glyph.
    /// The tray is a mirror; a blank icon column reads as a broken menu.
    #[test]
    fn an_unknown_shape_falls_back_to_the_disc() {
        assert_eq!(glyph_rgba("compacting", [9, 9, 9]), glyph_rgba("disc", [9, 9, 9]));
    }

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

