//! A project's favicon/logo probed off disk for the sidebar, and the tray menu's status
//! glyphs. Content wins over extension: repos ship PNGs named `favicon.ico`, and a wrong
//! MIME in the data URI renders as a broken icon the webview still counts as found.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

// ---------- project favicon / logo discovery ----------

#[derive(serde::Serialize)]
pub(crate) struct ProjectIcon {
    path: String,
    data_uri: String,
}

/// Image MIME from magic bytes, falling back to the extension only when nothing matches.
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

/// A candidate icon file as a base64 data URI; small files only, MIME sniffed from content.
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

/// The first conventional favicon/logo spot that exists under `base`; no recursive walk.
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

/// A project's favicon/logo: the conventional spots at the root, then one shallow level
/// of subdirs (frontend-ish names first) for monorepos that keep the web app nested.
#[tauri::command]
pub(crate) fn find_project_icon(dir: String) -> Option<ProjectIcon> {
    let base = std::path::Path::new(&dir);
    if !base.is_dir() {
        return None;
    }
    if let Some(hit) = probe_icon_dir(base) {
        return Some(hit);
    }
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
    // Frontend-ish first, then alphabetical so the choice is deterministic.
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

/// A user-picked logo, through the same sniff/size gate as discovery so a non-image or
/// an oversized file is refused here rather than becoming a broken `<img>`.
#[tauri::command]
pub(crate) fn read_custom_icon(path: String) -> Result<ProjectIcon, String> {
    read_icon(std::path::Path::new(&path))
        .ok_or_else(|| "Not a usable image (PNG, SVG, ICO, JPEG, WEBP or GIF, max 512 KB)".to_string())
}

// ---------- tray status glyphs ----------

// The rail's status glyphs rasterised for the tray: menu text is always menu-coloured,
// an icon image is not. Shape and colour are the frontend's (GCLASS + styles.css), never
// derived here. 32px halves exactly to Windows's 16×16 and out-resolves macOS's 18pt row.

/// Distance from `p` to the segment `a`–`b`; every shape below is a stroke or an outline.
fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (vx, vy) = (bx - ax, by - ay);
    let (wx, wy) = (px - ax, py - ay);
    let len2 = vx * vx + vy * vy;
    let t = if len2 <= f32::EPSILON { 0.0 } else { ((wx * vx + wy * vy) / len2).clamp(0.0, 1.0) };
    let (dx, dy) = (wx - t * vx, wy - t * vy);
    (dx * dx + dy * dy).sqrt()
}

/// Signed distance to the named shape on the 32px canvas, origin at centre, y running
/// down (image order). An unknown name draws the disc, not a hole in the menu.
fn shape_sdf(shape: &str, x: f32, y: f32) -> f32 {
    let len = (x * x + y * y).sqrt();
    match shape {
        "ring" => (len - 8.5).abs() - 1.3,  // ○ idle: an outline needs no second colour
        // ◆ attention; `/ √2` keeps the anti-aliased edge the disc's weight.
        "diamond" => (x.abs() + y.abs() - 11.0) * std::f32::consts::FRAC_1_SQRT_2,
        // `✓` done — two strokes, elbow low and left.
        "check" => seg_dist(x, y, -7.5, -0.5, -2.5, 5.0).min(seg_dist(x, y, -2.5, 5.0, 8.0, -6.0)) - 1.6,
        // `✕` error.
        "cross" => seg_dist(x, y, -6.5, -6.5, 6.5, 6.5).min(seg_dist(x, y, -6.5, 6.5, 6.5, -6.5)) - 1.5,
        // `❯` a live shell pane — not a phase, which is why it isn't a dot at all.
        "chevron" => seg_dist(x, y, -5.5, -7.5, 4.0, 0.0).min(seg_dist(x, y, 4.0, 0.0, -5.5, 7.5)) - 1.6,
        // » a pane running somebody else's agent: the shell's chevron doubled, so it reads as
        // the terminal family. Never a diamond variant: ◆ alone means drop what you are doing.
        "dchevron" => {
            let v = |ax: f32| {
                seg_dist(x, y, ax - 4.0, -6.0, ax, 0.0).min(seg_dist(x, y, ax, 0.0, ax - 4.0, 6.0))
            };
            v(-1.0).min(v(5.0)) - 1.3
        }
        // · ended. Small rather than grey, so it stays quiet on a light ground.
        "small" => len - 4.5,
        // ◐ background fan-out: a ring with its left half filled, the union (`min`) of the
        // outline and a half-plane clipped to the inner disc.
        "half" => ((len - 8.5).abs() - 1.3).min((len - 7.6).max(x)),
        // `●` working / thinking, and the fallback.
        _ => len - 9.0,
    }
}

/// One status glyph as 32×32 straight (non-premultiplied) RGBA, what `Image::new_owned` takes.
pub(crate) fn glyph_rgba(shape: &str, rgb: [u8; 3]) -> Vec<u8> {
    const N: usize = 32;
    const C: f32 = N as f32 / 2.0;
    let mut out = vec![0u8; N * N * 4];
    for y in 0..N {
        for x in 0..N {
            // Coverage over one pixel of falloff: cheap anti-aliasing, enough for these shapes.
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

    /// `Image::new_owned(rgba, 32, 32)` trusts the size; a short buffer fails inside AppKit.
    #[test]
    fn glyph_rgba_is_a_full_32x32_rgba_buffer() {
        assert_eq!(glyph_rgba("disc", [1, 2, 3]).len(), 32 * 32 * 4);
        assert_eq!(glyph_rgba("check", [1, 2, 3]).len(), 32 * 32 * 4);
    }

    #[test]
    fn glyph_rgba_paints_the_colour_it_was_given() {
        let px = glyph_rgba("disc", [224, 164, 74]);
        let centre = (16 * 32 + 16) * 4;
        assert_eq!(&px[centre..centre + 4], &[224, 164, 74, 255]);
        // ...and the corner stays transparent, so the row's background shows through.
        assert_eq!(px[3], 0);
    }

    /// Identical rasters collapse the set to "coloured dot" for anyone reading shape before hue.
    #[test]
    fn each_shape_draws_something_different() {
        let alpha = |s: &str| glyph_rgba(s, [255, 255, 255]).chunks(4).map(|p| p[3] as u32).sum::<u32>();
        let names = ["disc", "ring", "diamond", "check", "cross", "chevron", "small", "half", "dchevron"];
        let mut seen: Vec<u32> = names.iter().map(|s| alpha(s)).collect();
        let before = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), before, "two shapes rasterised identically");
        // Ring vs disc: the pair most likely to collapse if the ring's stroke widens past its radius.
        let centre = (16 * 32 + 16) * 4 + 3;
        assert_eq!(glyph_rgba("ring", [255, 255, 255])[centre], 0);
        assert_eq!(glyph_rgba("disc", [255, 255, 255])[centre], 255);
        // Two SDFs compose ◐; a sign slip turns it into a whole disc or a bare ring.
        let half = glyph_rgba("half", [255, 255, 255]);
        assert_eq!(half[(16 * 32 + 11) * 4 + 3], 255, "the left half of ◐ is filled");
        assert_eq!(half[(16 * 32 + 21) * 4 + 3], 0, "the right half of ◐ is not");
        // The gap is the whole difference from ❯; an offset typo in the closure collapses »
        // into one fat chevron, which the alpha-sum check above would accept.
        let dch = glyph_rgba("dchevron", [255, 255, 255]);
        let row = |col: usize| dch[(16 * 32 + col) * 4 + 3];
        assert!(row(14) > 0 && row(20) > 0, "» draws both chevrons");
        assert_eq!(row(17), 0, "» keeps a gap between them");
    }

    /// The tray is a mirror; a status the frontend gains first must still draw a glyph.
    #[test]
    fn an_unknown_shape_falls_back_to_the_disc() {
        assert_eq!(glyph_rgba("compacting", [9, 9, 9]), glyph_rgba("disc", [9, 9, 9]));
    }

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
