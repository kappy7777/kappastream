//! Notify-only new-release check for builds whose updates are installed,
//! not self-applied.
//!
//! The flatpak build compiles without the `updater` feature, so
//! tauri-plugin-updater is never registered and the frontend's plugin
//! `check()` rejects. It still deserves to learn that a newer release
//! exists: one GET of the updater's own `latest.json` manifest, and the
//! banner points at the release page instead of downloading anything.
//! Every other build answers `None` without touching the network (the
//! updater builds have the real plugin; AUR updates belong to pacman).

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

/// The updater's manifest endpoint. Must stay identical to
/// `plugins.updater.endpoints[0]` in `tauri.conf.json` — pinned by test.
const LATEST_JSON_URL: &str =
    "https://github.com/kappy7777/kappastream/releases/latest/download/latest.json";

/// Upper bound on the manifest body. The real file is ~3 KB; the updater
/// notes it carries are one line.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Cap on the `notes` field. The banner collapses it to one line anyway;
/// the updater itself caps at 300 characters client-side.
const MAX_NOTES_CHARS: usize = 1000;

/// Cap on the `pub_date` field (an RFC 3339 timestamp is ~25 chars).
const MAX_PUBDATE_CHARS: usize = 64;

/// Redirect hops to follow. The real chain is
/// github.com → github.com → *.githubusercontent.com (two to three hops).
const MAX_REDIRECTS: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNotice {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .user_agent(crate::gql::USER_AGENT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                // A custom policy enforces no hop limit of its own.
                // `previous()` includes the initial URL, so > MAX_REDIRECTS
                // means the chain already consumed every allowed hop.
                if attempt.previous().len() > MAX_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                if is_allowed_redirect(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("failed to build release-notice HTTP client")
    })
}

/// Redirects are followed only to the hosts the release manifest actually
/// lives on — the GitHub release page and GitHub's asset CDN domains —
/// over plain https, without credentials or a custom port. Anything else
/// stops the chain, which surfaces as the 3xx response and fails the
/// success check.
fn is_allowed_redirect(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && (host == "github.com" || host.ends_with(".githubusercontent.com"))
        && url.username().is_empty()
        && url.password().is_none()
}

/// Strict field extraction from `latest.json`. `version` must be
/// `MAJOR.MINOR.PATCH[-PRERELEASE]` (each numeric part 1-4 digits, the
/// prerelease 1-32 chars of `[0-9A-Za-z.]`); `notes` is trimmed and
/// capped; `pub_date` is length-bounded. Anything else returns `None`,
/// which makes the command fail — a malformed or hostile manifest must
/// never reach the banner. No version comparison happens here: the
/// frontend applies the same `isVersionNewer` gate it uses for the
/// plugin's own result.
fn parse_latest_json(body: &str) -> Option<(String, Option<String>, Option<String>)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let object = value.as_object()?;
    let version = parse_version(object.get("version")?.as_str()?)?;
    let notes = match object.get("notes") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.chars().take(MAX_NOTES_CHARS).collect::<String>())
            }
        }
        Some(_) => return None,
    };
    let pub_date = match object.get("pub_date") {
        None | Some(Value::Null) => None,
        Some(Value::String(raw)) => {
            if raw.chars().count() > MAX_PUBDATE_CHARS {
                return None;
            }
            Some(raw.clone())
        }
        Some(_) => return None,
    };
    Some((version, notes, pub_date))
}

/// Validates the strict `MAJOR.MINOR.PATCH[-PRERELEASE]` shape by hand
/// (no regex dependency) and returns the string unchanged.
fn parse_version(raw: &str) -> Option<String> {
    let (core, prerelease) = match raw.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (raw, None),
    };
    let mut parts = core.split('.');
    for _ in 0..3 {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 4 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
    }
    if parts.next().is_some() {
        return None; // A fourth dot-separated component.
    }
    if let Some(pre) = prerelease {
        // The charset is ASCII, so byte length equals char count.
        if pre.is_empty()
            || pre.len() > 32
            || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        {
            return None;
        }
    }
    Some(raw.to_string())
}

/// One GET of the manifest. `Ok(None)` — without touching the network —
/// on every build that is not the flatpak; a fetch or parse failure is an
/// `Err` the frontend swallows silently like a failed plugin check.
#[tauri::command]
pub async fn release_notice() -> Result<Option<ReleaseNotice>, String> {
    if !crate::env_spawn::in_flatpak() {
        return Ok(None);
    }
    let response = client()
        .get(LATEST_JSON_URL)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_BODY_BYTES as u64)
    {
        return Err("response too large".to_string());
    }
    // Streamed cap (the gql_fetch pattern): neither a lying
    // Content-Length nor a chunked body can grow memory past the cap.
    let mut buf = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("body: {e}"))?;
        if buf.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err("response too large".to_string());
        }
        buf.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(buf).map_err(|_| "response was not UTF-8".to_string())?;
    let (version, notes, pub_date) =
        parse_latest_json(&body).ok_or_else(|| "malformed latest.json".to_string())?;
    Ok(Some(ReleaseNotice {
        version,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        notes,
        pub_date,
    }))
}

#[cfg(test)]
mod tests {
    use super::{is_allowed_redirect, parse_latest_json, parse_version, LATEST_JSON_URL};
    use url::Url;

    #[test]
    fn latest_json_url_matches_the_updater_endpoint() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoint = conf["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
        assert_eq!(LATEST_JSON_URL, endpoint);
    }

    #[test]
    fn parse_accepts_the_published_manifest_shape() {
        // Field set of the real latest.json (measured against the
        // published v1.0.9 manifest; the platforms map is elided).
        let body = concat!(
            r#"{"version":"1.0.9","notes":"Fixes for the player controls.","#,
            r#""pub_date":"2026-11-04T08:17:00Z","platforms":{}}"#
        );
        let (version, notes, pub_date) = parse_latest_json(body).unwrap();
        assert_eq!(version, "1.0.9");
        assert_eq!(notes.as_deref(), Some("Fixes for the player controls."));
        assert_eq!(pub_date.as_deref(), Some("2026-11-04T08:17:00Z"));
    }

    #[test]
    fn parse_rejects_malformed_manifests() {
        // Non-object JSON.
        assert!(parse_latest_json("[]").is_none());
        assert!(parse_latest_json("\"1.0.9\"").is_none());
        // Missing version.
        assert!(parse_latest_json(r#"{"pub_date":"2026-11-04T08:17:00Z"}"#).is_none());
        // Malformed versions.
        for body in [
            r#"{"version":"1.0"}"#,
            r#"{"version":"v1.0.9"}"#,
            r#"{"version":"1.0.9 ; x"}"#,
            r#"{"version":"01.0.9.2"}"#,
            r#"{"version":""}"#,
        ] {
            assert!(parse_latest_json(body).is_none(), "accepted {body}");
        }
        // A 10 000-character version.
        let huge = format!(r#"{{"version":"{}"}}"#, "1".repeat(10_000));
        assert!(parse_latest_json(&huge).is_none());
        // A non-string version.
        assert!(parse_latest_json(r#"{"version":109}"#).is_none());
    }

    #[test]
    fn version_shape_details() {
        assert_eq!(parse_version("1.0.9").as_deref(), Some("1.0.9"));
        assert_eq!(parse_version("10.20.300").as_deref(), Some("10.20.300"));
        // Prerelease tail: allowed charset and bounded length.
        assert_eq!(parse_version("1.1.0-rc1").as_deref(), Some("1.1.0-rc1"));
        assert_eq!(
            parse_version("1.1.0-2026.11.07").as_deref(),
            Some("1.1.0-2026.11.07")
        );
        // Four numeric parts, an empty part, oversized parts, an empty or
        // hostile prerelease.
        for raw in [
            "1.0.9.2",
            "1..9",
            "1.0.",
            ".1.0.9",
            "12345.0.9",
            "1.0.9-",
            "1.0.9-rc 1",
            "1.0.9-rc/1",
        ] {
            assert_eq!(parse_version(raw), None, "accepted {raw}");
        }
    }

    #[test]
    fn notes_are_trimmed_capped_and_char_safe() {
        let long = "ä".repeat(1500);
        let body = format!(r#"{{"version":"1.0.9","notes":"  {long}  "}}"#);
        let (_, notes, _) = parse_latest_json(&body).unwrap();
        let notes = notes.unwrap();
        assert_eq!(notes.chars().count(), 1000, "cap holds on char boundary");
        assert!(notes.chars().all(|c| c == 'ä'));

        // Blank notes collapse to None.
        let (_, notes, _) = parse_latest_json(r#"{"version":"1.0.9","notes":"   "}"#).unwrap();
        assert!(notes.is_none());
        // A non-string or oversized pub_date fails the parse outright —
        // never truncated into a misleading timestamp.
        let long_date = "x".repeat(65);
        let body = format!(r#"{{"version":"1.0.9","pub_date":"{long_date}"}}"#);
        assert!(parse_latest_json(&body).is_none());
        assert!(parse_latest_json(r#"{"version":"1.0.9","pub_date":123}"#).is_none());
        assert!(parse_latest_json(r#"{"version":"1.0.9","notes":42}"#).is_none());
    }

    #[test]
    fn redirects_follow_only_github_hosts() {
        for ok in [
            "https://github.com/kappy7777/kappastream/releases/download/v1.0.9/latest.json",
            "https://release-assets.githubusercontent.com/a/b/c",
            "https://objects.githubusercontent.com/gh_ABC/X",
        ] {
            assert!(
                is_allowed_redirect(&Url::parse(ok).unwrap()),
                "rejected {ok}"
            );
        }
        for bad in [
            "http://github.com/x",
            "https://github.com.evil.example/x",
            "https://githubusercontent.com.evil.example/x",
            "https://githubusercontent.com/x",
            "https://user@github.com/x",
            "https://user:pw@github.com/x",
            "https://github.com:8443/x",
            "ftp://github.com/x",
        ] {
            assert!(
                !is_allowed_redirect(&Url::parse(bad).unwrap()),
                "accepted {bad}"
            );
        }
    }
}
