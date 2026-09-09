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

const MAX_ICON: usize = 512 * 1024;

/// A candidate icon file as a base64 data URI; small files only, MIME sniffed from content.
fn read_icon(p: &std::path::Path) -> Option<ProjectIcon> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_ICON as u64 {
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

// ---------- the icon a page declares ----------
// `<link rel="icon">` is what a browser actually shows, and it is often the only answer:
// the emoji-favicon trick inlines an SVG in the href, so there is no file to go and find.

/// Raw `<link …>` tags in document order. Quote-aware, since a `data:` URI can hold a `>`.
fn link_tags(html: &str) -> Vec<&str> {
    let low = html.to_ascii_lowercase();
    let b = html.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0usize);
    while let Some(hit) = low.get(i..).and_then(|s| s.find("<link")) {
        let start = i + hit;
        let mut j = start + 5;
        let mut quote = 0u8;
        while j < b.len() {
            match b[j] {
                c if c == quote => quote = 0,
                c @ (b'"' | b'\'') if quote == 0 => quote = c,
                b'>' if quote == 0 => break,
                _ => {}
            }
            j += 1;
        }
        out.push(&html[start..j]);
        i = j + 1;
    }
    out
}

/// `name="value"` out of one raw tag: the search is case-insensitive, the value verbatim,
/// since a data URI's %-escapes are not. A name only answers as a whole attribute, or
/// `data-href` would be read as the `href`.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let low = tag.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(hit) = low.get(from..).and_then(|s| s.find(name)) {
        let at = from + hit;
        from = at + name.len();
        if at == 0 || !low.as_bytes()[at - 1].is_ascii_whitespace() {
            continue;
        }
        let v = tag.get(from..)?.trim_start().strip_prefix('=')?.trim_start();
        return Some(match v.as_bytes().first() {
            Some(q @ (b'"' | b'\'')) => v[1..].split(*q as char).next()?.to_string(),
            // Unquoted, so the tag's own `/>` is still stuck to the last value.
            _ => v.split_whitespace().next()?.trim_end_matches(['>', '/']).to_string(),
        });
    }
    None
}

/// Whether `rel` names a favicon. Token equality, so `shortcut icon` counts while
/// `mask-icon` (a monochrome silhouette, not the page's icon) does not.
fn rel_is_icon(rel: &str) -> bool {
    rel.split_whitespace()
        .any(|t| t.eq_ignore_ascii_case("icon") || t.eq_ignore_ascii_case("apple-touch-icon"))
}

/// The entities an HTML attribute may spell a URL's bytes with.
fn html_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
}

/// An inline `data:` icon, kept verbatim: those bytes are already encoded, and re-encoding a
/// percent-escaped SVG is how a working icon becomes a broken one.
fn data_uri_icon(href: &str) -> Option<String> {
    // A `"` would close the `src="…"` this ends up in, and every render site quotes it that
    // way; a data URI that needs one is broken anyway. Single quotes and spaces are legal here
    // and common in a hand-written inline SVG, so they stay.
    if href.len() > MAX_ICON || href.contains('"') || !href.get(..5)?.eq_ignore_ascii_case("data:") {
        return None;
    }
    let mime = href[5..].split([';', ',']).next()?;
    mime.get(..6)?.eq_ignore_ascii_case("image/").then(|| href.to_string())
}

/// A page-relative `href` tried where the file actually lives: beside the page, then the
/// roots a dev server maps `/` onto.
fn href_icon(href: &str, page_dir: &std::path::Path, root: &std::path::Path) -> Option<ProjectIcon> {
    let path = href.split(['?', '#']).next()?.trim();
    if path.is_empty() || path.contains("://") || path.starts_with("//") {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split(['/', '\\']) {
        if seg == ".." {
            return None;
        }
        // `%PUBLIC_URL%` and friends: a build-time stand-in for the site root, not a directory.
        let tmpl = seg.len() > 2 && seg.starts_with('%') && seg.ends_with('%');
        if !seg.is_empty() && seg != "." && !tmpl {
            parts.push(seg);
        }
    }
    let rel: std::path::PathBuf = parts.into_iter().collect();
    if rel.as_os_str().is_empty() {
        return None;
    }
    [page_dir.to_path_buf(), root.to_path_buf(), root.join("public"), root.join("static")]
        .iter()
        .find_map(|d| read_icon(&d.join(&rel)))
}

/// How well a declared icon will wear at 15px: an SVG scales to anything, and of the rasters
/// the biggest downscales best, so a page's 16x16 favicon loses to its apple-touch-icon.
/// `sizes` is a hint the page volunteers; absent, assume the worst rather than the best.
fn icon_rank(tag: &str) -> u32 {
    let href = tag_attr(tag, "href").unwrap_or_default().to_ascii_lowercase();
    let ty = tag_attr(tag, "type").unwrap_or_default().to_ascii_lowercase();
    if ty.contains("svg")
        || href.starts_with("data:image/svg")
        || href.split(['?', '#']).next().unwrap_or("").ends_with(".svg")
    {
        return u32::MAX;
    }
    tag_attr(tag, "sizes").map_or(1, |s| {
        if s.eq_ignore_ascii_case("any") {
            return u32::MAX;
        }
        s.split_whitespace()
            .filter_map(|d| d.split(['x', 'X']).next()?.parse::<u32>().ok())
            .max()
            .unwrap_or(1)
    })
}

/// The best icon an HTML page declares that we can actually produce.
fn icon_from_page(page: &std::path::Path, root: &std::path::Path) -> Option<ProjectIcon> {
    use std::io::Read as _;
    // A `<link>` lives in <head>, so a bounded read also bounds a page with a bundle inlined.
    let mut buf = Vec::new();
    std::fs::File::open(page).ok()?.take(64 * 1024).read_to_end(&mut buf).ok()?;
    let html = String::from_utf8_lossy(&buf);
    let dir = page.parent().unwrap_or(root);
    let mut tags = link_tags(&html);
    tags.retain(|t| tag_attr(t, "rel").is_some_and(|r| rel_is_icon(&r)));
    tags.sort_by_key(|t| std::cmp::Reverse(icon_rank(t))); // stable, so document order breaks a tie
    tags.into_iter().find_map(|tag| {
        let href = html_unescape(&tag_attr(tag, "href")?);
        match data_uri_icon(&href) {
            Some(uri) => Some(ProjectIcon { path: page.to_string_lossy().to_string(), data_uri: uri }),
            None => href_icon(&href, dir, root),
        }
    })
}

/// What a page declares, then the first conventional favicon/logo spot that exists under
/// `base`; no recursive walk. Declared beats conventional, since a repo can ship both and
/// only one of them is what the browser puts in the tab.
fn probe_icon_dir(base: &std::path::Path) -> Option<ProjectIcon> {
    const PAGES: &[&str] = &[
        "index.html", "public/index.html", "src/index.html", "app/index.html", "static/index.html",
    ];
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
    PAGES
        .iter()
        .find_map(|rel| icon_from_page(&base.join(rel), base))
        .or_else(|| CANDIDATES.iter().find_map(|rel| read_icon(&base.join(rel))))
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


    // ---------- the icon a page declares ----------

    const SVG: &str = "<svg xmlns='http://www.w3.org/2000/svg'/>";

    fn write(dir: &std::path::Path, rel: &str, body: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    /// The emoji-favicon trick: the icon IS the href, and there is no file to go and find.
    #[test]
    fn a_data_uri_link_is_the_icon() {
        let dir = crate::testutil::scratch_dir();
        write(&dir, "index.html", "<!doctype html><head>\n<link rel=\"stylesheet\" href=\"/src/styles.css\" />\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%99%EF%B8%8F%3C/text%3E%3C/svg%3E\" />\n</head>");
        let icon = find_project_icon(dir.to_string_lossy().to_string()).expect("a declared icon");
        // Verbatim: re-encoding the %-escapes is how this becomes a broken <img>.
        assert!(icon.data_uri.starts_with("data:image/svg+xml,%3Csvg"), "{}", icon.data_uri);
        assert!(icon.data_uri.ends_with("%3C/svg%3E"), "{}", icon.data_uri);
    }

    /// A declared href is a path we would never have guessed, under a root `/` maps onto.
    #[test]
    fn a_declared_href_resolves_against_the_static_roots() {
        let dir = crate::testutil::scratch_dir();
        write(&dir, "public/brand-mark.svg", SVG);
        write(&dir, "index.html", "<link rel=icon type=image/svg+xml href=/brand-mark.svg />");
        let icon = find_project_icon(dir.to_string_lossy().to_string()).expect("a declared icon");
        assert!(icon.path.ends_with("brand-mark.svg"), "{}", icon.path);
        assert!(icon.data_uri.starts_with("data:image/svg+xml;base64,"));
    }

    /// Both exist and they disagree; the tab shows the declared one, so we do too.
    #[test]
    fn a_declared_icon_beats_a_conventional_file() {
        let dir = crate::testutil::scratch_dir();
        write(&dir, "favicon.ico", SVG); // candidate #1
        write(&dir, "img/logo.png", SVG);
        write(&dir, "index.html", "<html><head><link rel='shortcut icon' href='./img/logo.png?v=3'></head>");
        let icon = find_project_icon(dir.to_string_lossy().to_string()).expect("a declared icon");
        assert!(icon.path.ends_with("logo.png"), "{}", icon.path);
    }

    /// A page that declares nothing usable must fall through rather than answer for the dir.
    #[test]
    fn an_unusable_declaration_falls_back_to_the_conventional_spots() {
        let dir = crate::testutil::scratch_dir();
        write(&dir, "favicon.svg", SVG);
        // A network icon we won't fetch, a traversal we won't follow, and a missing file.
        write(&dir, "index.html", "<link rel=icon href=\"https://cdn.example/f.png\">\n<link rel=icon href=\"../../etc/passwd\">\n<link rel=icon href=\"/nope.png\">");
        let icon = find_project_icon(dir.to_string_lossy().to_string()).expect("the conventional icon");
        assert!(icon.path.ends_with("favicon.svg"), "{}", icon.path);
    }

    #[test]
    fn tag_attr_reads_the_whole_name_and_the_verbatim_value() {
        assert_eq!(tag_attr("<link REL='shortcut icon' HREF=\"/a.ico\"", "href").as_deref(), Some("/a.ico"));
        // `data-href` answering for `href` would read the wrong URL off half the pages out there.
        assert_eq!(tag_attr("<link data-href=\"x\" href=y>", "href").as_deref(), Some("y"));
        assert_eq!(tag_attr("<link rel=icon href='data:image/svg+xml,%3Csvg%3E'", "href").as_deref(),
                   Some("data:image/svg+xml,%3Csvg%3E"));
        assert_eq!(tag_attr("<link rel=icon>", "href"), None);
    }

    #[test]
    fn link_tags_end_at_the_tag_not_inside_a_quoted_uri() {
        // An unencoded `>` in an href is legal, and ends the tag early if you scan naively.
        let tags = link_tags("<LINK rel=icon href=\"data:image/svg+xml,<svg/>\"><link rel=x>");
        assert_eq!(tags.len(), 2);
        assert!(tags[0].contains("<svg/>"), "{}", tags[0]);
    }

    /// A real page declares three, and the 15px row wants the one that downscales.
    #[test]
    fn the_best_declared_icon_wins_not_the_first() {
        let dir = crate::testutil::scratch_dir();
        write(&dir, "favicon-16x16.png", SVG);
        write(&dir, "apple-touch-icon.png", SVG);
        write(&dir, "index.html", "<link rel='icon' type='image/png' sizes='16x16' href='/favicon-16x16.png' /> <link rel='apple-touch-icon' sizes='180x180' href='/apple-touch-icon.png' />");
        let icon = find_project_icon(dir.to_string_lossy().to_string()).expect("a declared icon");
        assert!(icon.path.ends_with("apple-touch-icon.png"), "{}", icon.path);
    }

    #[test]
    fn icon_rank_prefers_scalable_then_biggest() {
        assert_eq!(icon_rank("<link rel=icon href=/f.svg>"), u32::MAX);
        assert_eq!(icon_rank("<link rel=icon type='image/svg+xml' href='/f'>"), u32::MAX);
        assert_eq!(icon_rank("<link rel=icon sizes='any' href='/f.ico'>"), u32::MAX);
        assert_eq!(icon_rank("<link rel=icon sizes='16x16 48x48' href='/f.ico'>"), 48);
        // No `sizes` at all is unknown, and must not outrank a size the page did declare.
        assert_eq!(icon_rank("<link rel=icon href=/favicon.ico>"), 1);
    }

    #[test]
    fn rel_is_icon_takes_whole_tokens() {
        assert!(rel_is_icon("shortcut icon") && rel_is_icon("ICON") && rel_is_icon("apple-touch-icon"));
        assert!(!rel_is_icon("mask-icon"), "a pinned-tab silhouette is not the page's icon");
        assert!(!rel_is_icon("stylesheet") && !rel_is_icon("preload"));
    }

    #[test]
    fn data_uri_icon_takes_images_only() {
        assert!(data_uri_icon("data:image/png;base64,AAAA").is_some());
        assert!(data_uri_icon("DATA:IMAGE/SVG+XML,%3Csvg%3E").is_some());
        assert!(data_uri_icon("data:text/html,<b>x</b>").is_none());
        // A repo's own index.html must not be able to inject markup into the sidebar.
        assert!(data_uri_icon("data:image/svg+xml,%3Csvg%3E\" onerror=x").is_none());
        assert!(data_uri_icon("data:,").is_none());
        assert!(data_uri_icon("/favicon.ico").is_none());
        // The same cap read_icon puts on a file: localStorage carries whatever this returns.
        assert!(data_uri_icon(&format!("data:image/png;base64,{}", "A".repeat(MAX_ICON))).is_none());
    }
}
