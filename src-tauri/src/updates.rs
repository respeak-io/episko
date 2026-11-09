//! The update check, per channel (docs/releases.md § Preview builds). The plugin's own `check`
//! reads the one endpoint the config names; a channel switch needs the other one, and the way
//! back from a preview is a downgrade. What it finds goes into the webview's resource table
//! exactly as the plugin's would, so the plugin still downloads and installs it.

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{Manager, ResourceId, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

const STABLE: &str = "https://github.com/respeak-io/episko/releases/latest/download/latest.json";
const PREVIEW: &str =
    "https://github.com/respeak-io/episko/releases/download/preview-build/latest.json";

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Channel {
    Stable,
    Preview,
}

/// Anything newer, and on the way out of a preview any stable release at all.
fn offers(build: Channel, want: Channel, current: &Version, remote: &Version) -> bool {
    remote > current || (build == Channel::Preview && want == Channel::Stable && remote != current)
}

/// A preview reads both and takes the newer, so a release that overtakes it still arrives.
fn sources(want: Channel) -> &'static [&'static str] {
    match want {
        Channel::Stable => &[STABLE],
        Channel::Preview => &[PREVIEW, STABLE],
    }
}

fn newer(a: &str, b: &str) -> bool {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a), Ok(b)) => a > b,
        (Ok(_), Err(_)) => true,
        _ => false,
    }
}

/// The plugin's `UpdateMetadata`, which the JS `Update` class is constructed from.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Found {
    rid: ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub(crate) async fn check_update(
    webview: Webview,
    build: Channel,
    want: Channel,
) -> Result<Option<Found>, String> {
    let mut best: Option<Update> = None;
    let mut failed = None;
    let mut answered = false;
    for src in sources(want) {
        let url = src.parse().map_err(|e| format!("{e}"))?;
        let updater = webview
            .updater_builder()
            .endpoints(vec![url])
            .and_then(|b| {
                b.version_comparator(move |cur, rel| offers(build, want, &cur, &rel.version))
                    .build()
            })
            .map_err(|e| e.to_string())?;
        match updater.check().await {
            Ok(found) => {
                answered = true;
                if let Some(u) = found {
                    if best.as_ref().is_none_or(|b| newer(&u.version, &b.version)) {
                        best = Some(u);
                    }
                }
            }
            Err(e) => {
                failed.get_or_insert(e.to_string());
            }
        }
    }
    if !answered {
        return Err(failed.unwrap_or_default());
    }
    Ok(best.map(|u| Found {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        body: u.body.clone(),
        raw_json: u.raw_json.clone(),
        rid: webview.resources_table().add(u),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use Channel::{Preview, Stable};

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn offers_only_newer_on_the_channel_a_build_is_on() {
        assert!(offers(Stable, Stable, &v("0.40.0"), &v("0.40.1")));
        assert!(!offers(Stable, Stable, &v("0.40.0"), &v("0.40.0")));
        assert!(!offers(Stable, Stable, &v("0.40.0"), &v("0.39.0")));
        assert!(offers(Preview, Preview, &v("0.40.1-preview.3"), &v("0.40.1-preview.4")));
        assert!(offers(Preview, Preview, &v("0.40.1-preview.3"), &v("0.40.1")));
    }

    #[test]
    fn enters_a_preview_only_when_it_is_newer_and_leaves_one_for_any_release() {
        assert!(offers(Stable, Preview, &v("0.40.0"), &v("0.40.1-preview.1")));
        assert!(!offers(Stable, Preview, &v("0.40.0"), &v("0.39.1-preview.1")));
        assert!(offers(Preview, Stable, &v("0.40.1-preview.3"), &v("0.40.0")));
        assert!(!offers(Preview, Stable, &v("0.40.0"), &v("0.40.0")));
    }

    #[test]
    fn a_preview_reads_both_manifests_and_stable_reads_one() {
        assert_eq!(sources(Stable), &[STABLE]);
        assert_eq!(sources(Preview), &[PREVIEW, STABLE]);
        assert!(newer("0.40.1", "0.40.1-preview.9"));
        assert!(newer("0.40.1-preview.2", "0.40.0"));
        assert!(!newer("garbage", "0.40.0"));
    }

    // The configs name the same manifests a build reads; preview.yml publishes to that tag.
    #[test]
    fn the_endpoints_are_the_configs() {
        let endpoint = |json: &str| -> String {
            let c: serde_json::Value = serde_json::from_str(json).unwrap();
            c["plugins"]["updater"]["endpoints"][0].as_str().unwrap().to_string()
        };
        assert_eq!(endpoint(include_str!("../tauri.conf.json")), STABLE);
        assert_eq!(endpoint(include_str!("../tauri.preview.conf.json")), PREVIEW);
        let workflow = include_str!("../../.github/workflows/preview.yml");
        assert!(workflow.contains("TAG: preview-build"));
    }
}
