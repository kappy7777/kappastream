use std::env;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;

const RESOLVE_TIMEOUT: Duration = Duration::from_millis(25_000);

const STREAMLINK_OFFLINE_MARKERS: &[&str] =
    &["No playable streams found", "error: No playable streams"];

pub(crate) const ALLOWED_QUALITIES: &[&str] = &[
    "best",
    "worst",
    "audio_only",
    "160p",
    "360p",
    "480p",
    "720p",
    "720p60",
    "1080p60",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponse {
    pub ok: bool,
    pub url: Option<String>,
    pub quality: Option<String>,
    pub offline: bool,
    pub unavailable: bool,
    pub error: Option<String>,
}

pub(crate) fn is_channel_name_valid(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > 25 {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A Twitch VOD id is an all-digit string (the trailing path segment of
/// `https://twitch.tv/videos/<id>`). Bound to 20 digits (current ids are ~13).
/// Used by `resolve_vod` to refuse anything that is not a bare numeric id, so
/// unvalidated input can never reach a streamlink argument.
pub(crate) fn is_vod_id_valid(id: &str) -> bool {
    let s = id.trim();
    let len = s.len();
    if len == 0 || len > 20 {
        return false;
    }
    s.chars().all(|c| c.is_ascii_digit())
}

/// A Twitch clip slug is alphanumeric + dashes/underscores, e.g.
/// "ClumsyDarkPassionfruitBCouch-IAtE_BZ87kE7PQSG". Validated before the slug
/// reaches a streamlink argument so unvalidated input can never be injected.
pub(crate) fn is_clip_slug_valid(slug: &str) -> bool {
    let s = slug.trim();
    let len = s.len();
    if len == 0 || len > 100 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub(crate) fn streamlink_bin() -> PathBuf {
    match env::var("STREAMLINK_BIN") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => PathBuf::from("streamlink"),
    }
}

fn is_offline(detail: &str) -> bool {
    STREAMLINK_OFFLINE_MARKERS
        .iter()
        .any(|m| detail.contains(m))
}

fn is_unavailable(detail: &str) -> bool {
    detail.contains("could not be found")
        || detail.contains("invalid stream")
        || detail.contains("Available streams")
}

/// Whether to surface detailed resolver output (stdout/stderr, local
/// paths, signed URLs) in the returned error text. Development builds
/// keep it for debugging; release builds get stable, sanitized messages
/// so signed HLS URLs and local paths never leak into screenshots or
/// shared logs. Exit codes and derived states (offline/unavailable)
/// are not sensitive and are always returned.
fn include_detail() -> bool {
    cfg!(debug_assertions)
}

async fn run_streamlink(
    bin: &std::path::Path,
    twitch_url: &str,
    quality: &str,
    low_latency: bool,
) -> Result<String, StreamlinkError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--loglevel").arg("error");
    // Twitch low-latency mode: requests the short-segment LL-HLS playlist so
    // the player can chase the live edge (~5-8s vs the usual 15-30s). Paired
    // with hls.js lowLatencyMode + liveSyncDurationCount in the frontend.
    if low_latency {
        cmd.arg("--twitch-low-latency");
    }
    cmd.arg("--stream-url")
        .arg(twitch_url)
        .arg(quality)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::env_spawn::configure(cmd.as_std_mut(), None);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let msg = if include_detail() {
                format!(
                    "streamlink binary not found at '{}': set STREAMLINK_BIN to override the path",
                    bin.display()
                )
            } else {
                "streamlink binary not found: set STREAMLINK_BIN to override the path".to_string()
            };
            return Err(StreamlinkError::Spawn(msg));
        }
        Err(e) => return Err(StreamlinkError::Spawn(e.to_string())),
    };

    let output = match tokio::time::timeout(RESOLVE_TIMEOUT, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| StreamlinkError::Spawn(e.to_string()))?,
        Err(_) => {
            return Err(StreamlinkError::Timeout);
        }
    };

    if !output.status.success() {
        return Err(StreamlinkError::Failed {
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

enum StreamlinkError {
    Spawn(String),
    Timeout,
    Failed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
}

#[tauri::command]
pub async fn resolve_stream(
    channel: String,
    quality: Option<String>,
    low_latency: Option<bool>,
) -> Result<ResolveResponse, String> {
    let mut channel = channel.trim().to_lowercase();
    if let Some(stripped) = channel.strip_prefix('#') {
        channel = stripped.to_string();
    }

    if !is_channel_name_valid(&channel) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid channel name".to_string()),
        });
    }

    let q_raw = quality.unwrap_or_else(|| "best".to_string());
    let q = q_raw.trim().to_lowercase();
    if !ALLOWED_QUALITIES.contains(&q.as_str()) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid stream quality".to_string()),
        });
    }

    let bin = streamlink_bin();
    let channel_for_spawn = channel.clone();
    let q_for_spawn = q.clone();
    let low_for_spawn = low_latency.unwrap_or(false);

    let result = run_streamlink(
        &bin,
        &format!("https://twitch.tv/{}", channel_for_spawn),
        &q_for_spawn,
        low_for_spawn,
    )
    .await;

    match result {
        Ok(url) => {
            let parsed = url::Url::parse(&url).ok().filter(|parsed| {
                parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                    && parsed.port_or_known_default() == Some(443)
                    && parsed.host_str().is_some_and(|host| {
                        host == "twitch.tv"
                            || host.ends_with(".twitch.tv")
                            || host == "ttvnw.net"
                            || host.ends_with(".ttvnw.net")
                            || host == "ttv-clips.net"
                            || host.ends_with(".ttv-clips.net")
                    })
            });
            if parsed.is_none() || url.lines().count() != 1 {
                let err = if include_detail() {
                    format!(
                        "streamlink returned non-url: {}",
                        url.chars().take(200).collect::<String>()
                    )
                } else {
                    "streamlink returned an unexpected response".to_string()
                };
                return Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: false,
                    unavailable: false,
                    error: Some(err),
                });
            }
            Ok(ResolveResponse {
                ok: true,
                url: parsed.map(|parsed| parsed.to_string()),
                quality: Some(q),
                offline: false,
                unavailable: false,
                error: None,
            })
        }
        Err(StreamlinkError::Spawn(msg)) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(msg),
        }),
        Err(StreamlinkError::Timeout) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(format!(
                "streamlink timed out after {} ms",
                RESOLVE_TIMEOUT.as_millis()
            )),
        }),
        Err(StreamlinkError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let combined_detail = format!("{}\n{}\nexit {:?}", stdout, stderr, code);
            if is_offline(&combined_detail) {
                Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: true,
                    unavailable: false,
                    error: None,
                })
            } else {
                let combined_err = format!("{} {}", stderr, stdout).trim().to_string();
                let unavailable = is_unavailable(&combined_err);
                let detail_text = if include_detail() {
                    if combined_err.is_empty() {
                        format!("streamlink exited {:?}", code)
                    } else {
                        combined_err.chars().take(500).collect()
                    }
                } else if code.is_some() {
                    format!("streamlink exited with code {:?}", code)
                } else {
                    "streamlink exited unexpectedly".to_string()
                };
                Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: false,
                    unavailable,
                    error: Some(detail_text),
                })
            }
        }
    }
}

// VOD/clip media (resolved HLS playlists and clip MP4s) are served from
// Twitch's CloudFront distribution (e.g. d2nvs31859zcd8.cloudfront.net), which
// the live `resolve_stream` allowlist below intentionally does NOT include.
// The VOD path gets its own broader host set so the live path stays untouched.
fn is_allowed_vod_host(host: &str) -> bool {
    host == "twitch.tv"
        || host.ends_with(".twitch.tv")
        || host == "ttvnw.net"
        || host.ends_with(".ttvnw.net")
        || host == "ttv-clips.net"
        || host.ends_with(".ttv-clips.net")
        || host == "cloudfront.net"
        || host.ends_with(".cloudfront.net")
}

// Sub-only / paywalled VODs are not playable anonymously: streamlink gets a
// 403 or an explicit subscribers-only error. Match conservatively so a plain
// transient error is never misreported as paywalled.
fn looks_sub_only(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    [
        "subscribers-only",
        "subscriber-only",
        "sub-only",
        "requires a subscription",
        "403 forbidden",
        "sub-only content",
    ]
    .iter()
    .any(|m| lower.contains(m))
}

/// Resolve a Twitch VOD (`https://twitch.tv/videos/<id>`) to a playable HLS
/// playlist URL via streamlink. Validates the id is all-digits and the quality
/// is on the allowlist, so unvalidated input never reaches a streamlink
/// argument. Accepts CloudFront hosts (VOD media lives there). A sub-only VOD
/// is reported as a clean, user-facing paywall message rather than a raw error.
#[tauri::command]
pub async fn resolve_vod(
    video_id: String,
    quality: Option<String>,
) -> Result<ResolveResponse, String> {
    let id = video_id.trim().to_string();
    if !is_vod_id_valid(&id) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid video id".to_string()),
        });
    }

    let q_raw = quality.unwrap_or_else(|| "best".to_string());
    let q = q_raw.trim().to_lowercase();
    if !ALLOWED_QUALITIES.contains(&q.as_str()) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid stream quality".to_string()),
        });
    }

    let bin = streamlink_bin();
    let url = format!("https://twitch.tv/videos/{}", id);
    let q_for_spawn = q.clone();

    let result = run_streamlink(&bin, &url, &q_for_spawn, false).await;

    match result {
        Ok(url) => {
            let parsed = url::Url::parse(&url).ok().filter(|parsed| {
                parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                    && parsed.port_or_known_default() == Some(443)
                    && parsed.host_str().is_some_and(is_allowed_vod_host)
            });
            if parsed.is_none() || url.lines().count() != 1 {
                let err = if include_detail() {
                    format!(
                        "streamlink returned non-url: {}",
                        url.chars().take(200).collect::<String>()
                    )
                } else {
                    "streamlink returned an unexpected response".to_string()
                };
                return Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: false,
                    unavailable: false,
                    error: Some(err),
                });
            }
            Ok(ResolveResponse {
                ok: true,
                url: parsed.map(|parsed| parsed.to_string()),
                quality: Some(q),
                offline: false,
                unavailable: false,
                error: None,
            })
        }
        Err(StreamlinkError::Spawn(msg)) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(msg),
        }),
        Err(StreamlinkError::Timeout) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(format!(
                "streamlink timed out after {} ms",
                RESOLVE_TIMEOUT.as_millis()
            )),
        }),
        Err(StreamlinkError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let combined = format!("{}\n{}", stderr, stdout);
            if looks_sub_only(&combined) {
                return Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: false,
                    unavailable: false,
                    error: Some(
                        "This video is subscriber-only and is not available without a subscription."
                            .to_string(),
                    ),
                });
            }
            let detail_text = if include_detail() {
                let combined_err = format!("{} {}", stderr, stdout).trim().to_string();
                if combined_err.is_empty() {
                    format!("streamlink exited {:?}", code)
                } else {
                    combined_err.chars().take(500).collect()
                }
            } else if code.is_some() {
                format!("streamlink exited with code {:?}", code)
            } else {
                "streamlink exited unexpectedly".to_string()
            };
            Ok(ResolveResponse {
                ok: false,
                url: None,
                quality: Some(q),
                offline: false,
                unavailable: false,
                error: Some(detail_text),
            })
        }
    }
}

/// Resolve a Twitch clip (`https://clips.twitch.tv/<slug>`) to a playable MP4
/// URL via streamlink. Streamlink generates the signed CloudFront URL (with
/// `sig` and `token` query params) — the raw `sourceURL` from GQL
/// `videoQualities` lacks these and returns HTTP 401. Validates the slug and
/// quality before reaching a streamlink argument. Accepts the same media-CDN
/// host allowlist as `resolve_vod`.
#[tauri::command]
pub async fn resolve_clip(
    slug: String,
    quality: Option<String>,
) -> Result<ResolveResponse, String> {
    let s = slug.trim().to_string();
    if !is_clip_slug_valid(&s) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid clip slug".to_string()),
        });
    }

    let q_raw = quality.unwrap_or_else(|| "best".to_string());
    let q = q_raw.trim().to_lowercase();
    if !ALLOWED_QUALITIES.contains(&q.as_str()) {
        return Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: None,
            offline: false,
            unavailable: false,
            error: Some("invalid stream quality".to_string()),
        });
    }

    let bin = streamlink_bin();
    let url = format!("https://clips.twitch.tv/{}", s);
    let q_for_spawn = q.clone();

    let result = run_streamlink(&bin, &url, &q_for_spawn, false).await;

    match result {
        Ok(url) => {
            let parsed = url::Url::parse(&url).ok().filter(|parsed| {
                parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                    && parsed.port_or_known_default() == Some(443)
                    && parsed.host_str().is_some_and(is_allowed_vod_host)
            });
            if parsed.is_none() || url.lines().count() != 1 {
                let err = if include_detail() {
                    format!(
                        "streamlink returned non-url: {}",
                        url.chars().take(200).collect::<String>()
                    )
                } else {
                    "streamlink returned an unexpected response".to_string()
                };
                return Ok(ResolveResponse {
                    ok: false,
                    url: None,
                    quality: Some(q),
                    offline: false,
                    unavailable: false,
                    error: Some(err),
                });
            }
            Ok(ResolveResponse {
                ok: true,
                url: parsed.map(|parsed| parsed.to_string()),
                quality: Some(q),
                offline: false,
                unavailable: false,
                error: None,
            })
        }
        Err(StreamlinkError::Spawn(msg)) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(msg),
        }),
        Err(StreamlinkError::Timeout) => Ok(ResolveResponse {
            ok: false,
            url: None,
            quality: Some(q),
            offline: false,
            unavailable: false,
            error: Some(format!(
                "streamlink timed out after {} ms",
                RESOLVE_TIMEOUT.as_millis()
            )),
        }),
        Err(StreamlinkError::Failed {
            stdout,
            stderr,
            code,
        }) => {
            let detail_text = if include_detail() {
                let combined_err = format!("{} {}", stderr, stdout).trim().to_string();
                if combined_err.is_empty() {
                    format!("streamlink exited {:?}", code)
                } else {
                    combined_err.chars().take(500).collect()
                }
            } else if code.is_some() {
                format!("streamlink exited with code {:?}", code)
            } else {
                "streamlink exited unexpectedly".to_string()
            };
            Ok(ResolveResponse {
                ok: false,
                url: None,
                quality: Some(q),
                offline: false,
                unavailable: false,
                error: Some(detail_text),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_name_valid_basic() {
        assert!(is_channel_name_valid("x"));
        assert!(is_channel_name_valid("twitch"));
        assert!(is_channel_name_valid("shroud"));
        assert!(is_channel_name_valid("name_with_underscore"));
        assert!(is_channel_name_valid("123abc"));
        assert!(is_channel_name_valid("a1b2c3"));
    }

    #[test]
    fn channel_name_valid_boundaries() {
        // exactly 25 chars is the max Twitch login length -> valid
        assert!(is_channel_name_valid(&"a".repeat(25)));
        // 26 chars -> invalid
        assert!(!is_channel_name_valid(&"a".repeat(26)));
        // empty -> invalid
        assert!(!is_channel_name_valid(""));
    }

    #[test]
    fn channel_name_rejects_invalid_chars() {
        // uppercase
        assert!(!is_channel_name_valid("Twitch"));
        // hyphen (not allowed in Twitch logins)
        assert!(!is_channel_name_valid("two-words"));
        // dot
        assert!(!is_channel_name_valid("dot.name"));
        // space
        assert!(!is_channel_name_valid("with space"));
        // unicode
        assert!(!is_channel_name_valid("café"));
        // leading hash — note: stripping '#' happens in resolve_stream,
        // NOT in is_channel_name_valid, so '#' must be rejected here.
        assert!(!is_channel_name_valid("#channel"));
        // special chars
        assert!(!is_channel_name_valid("name!"));
    }

    #[test]
    fn offline_detection_markers() {
        assert!(is_offline("error: No playable streams found on this URL"));
        assert!(is_offline("error: No playable streams"));
        // substring match works even with surrounding noise
        assert!(is_offline(
            "streamlink: ...\nNo playable streams found\nexit 1"
        ));
        assert!(!is_offline("some unrelated streamlink error"));
        assert!(!is_offline(""));
    }

    #[test]
    fn unavailable_detection_markers() {
        assert!(is_unavailable("The channel could not be found."));
        assert!(is_unavailable("invalid stream"));
        assert!(is_unavailable("Available streams: audio_only, 720p60"));
        assert!(!is_unavailable("a normal streamlink message"));
        assert!(!is_unavailable(""));
    }

    #[test]
    fn allowed_qualities_complete() {
        // The full allowlist mirrored by vite.config.ts ALLOWED_QUALITIES.
        // Keep these in sync with the const at the top of this file.
        for q in [
            "best",
            "worst",
            "audio_only",
            "160p",
            "360p",
            "480p",
            "720p",
            "720p60",
            "1080p60",
        ] {
            assert!(
                ALLOWED_QUALITIES.contains(&q),
                "expected `{q}` in ALLOWED_QUALITIES"
            );
        }
        // common-but-not-allowed values must be rejected
        assert!(!ALLOWED_QUALITIES.contains(&"4k"));
        assert!(!ALLOWED_QUALITIES.contains(&"source"));
        assert!(!ALLOWED_QUALITIES.contains(&"1080p"));
    }

    #[test]
    fn streamlink_bin_respects_env() {
        // With the override unset, falls back to the bare binary name.
        temp_env::with_var_unset("STREAMLINK_BIN", || {
            assert_eq!(streamlink_bin(), PathBuf::from("streamlink"));
        });

        // An explicit override is honored verbatim.
        temp_env::with_var("STREAMLINK_BIN", Some("/custom/path/streamlink"), || {
            assert_eq!(streamlink_bin(), PathBuf::from("/custom/path/streamlink"));
        });
    }

    #[test]
    fn vod_id_valid_basic() {
        assert!(is_vod_id_valid("12345"));
        assert!(is_vod_id_valid("2826461407"));
        assert!(is_vod_id_valid("1"));
    }

    #[test]
    fn vod_id_rejects_non_digits_and_injection() {
        // Non-digit characters must be refused so they can never reach a
        // streamlink argument (path/query/shell injection attempts).
        assert!(!is_vod_id_valid("123abc"));
        assert!(!is_vod_id_valid("12 34"));
        assert!(!is_vod_id_valid("1-2"));
        assert!(!is_vod_id_valid("12;rm -rf"));
        assert!(!is_vod_id_valid("../../../etc"));
        assert!(!is_vod_id_valid("videos/123"));
        assert!(!is_vod_id_valid(""));
        // Over the 20-digit cap.
        assert!(!is_vod_id_valid(&"1".repeat(21)));
    }

    #[test]
    fn vod_id_trims_whitespace() {
        // resolve_vod trims; the validator also tolerates surrounding spaces.
        assert!(is_vod_id_valid("  12345  "));
    }

    #[test]
    fn vod_host_allowlist_accepts_cloudfront() {
        // VOD/clip media is served from CloudFront — the live allowlist omits
        // it, but resolve_vod's allowlist must accept it.
        assert!(is_allowed_vod_host("d2nvs31859zcd8.cloudfront.net"));
        assert!(is_allowed_vod_host("d1ndex63qxojbr.cloudfront.net"));
        assert!(is_allowed_vod_host("eun12.playlist.ttvnw.net"));
        assert!(is_allowed_vod_host("twitch.tv"));
        // Not accepted: unrelated hosts.
        assert!(!is_allowed_vod_host("evil.example.net"));
        assert!(!is_allowed_vod_host("notcloudfront.net")); // suffix must be .cloudfront.net
        assert!(!is_allowed_vod_host("cloudfront.net.evil.com"));
    }

    #[test]
    fn sub_only_detection() {
        assert!(looks_sub_only("error: This content is subscribers-only"));
        assert!(looks_sub_only("HTTP 403 Forbidden"));
        assert!(looks_sub_only("requires a subscription to view"));
        // Plain transient errors are NOT flagged sub-only.
        assert!(!looks_sub_only("error: No playable streams found"));
        assert!(!looks_sub_only("transient network hiccup"));
        assert!(!looks_sub_only(""));
    }

    #[test]
    fn clip_slug_valid_basic() {
        assert!(is_clip_slug_valid(
            "ClumsyDarkPassionfruitBCouch-IAtE_BZ87kE7PQSG"
        ));
        assert!(is_clip_slug_valid(
            "CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4"
        ));
        assert!(is_clip_slug_valid("abc"));
        assert!(is_clip_slug_valid("a-b_c"));
    }

    #[test]
    fn clip_slug_rejects_invalid() {
        // Empty / whitespace-only
        assert!(!is_clip_slug_valid(""));
        assert!(!is_clip_slug_valid("   "));
        // Path separators, spaces, special chars
        assert!(!is_clip_slug_valid("bad/slug"));
        assert!(!is_clip_slug_valid("bad slug"));
        assert!(!is_clip_slug_valid("bad?slug"));
        assert!(!is_clip_slug_valid("bad#slug"));
        assert!(!is_clip_slug_valid("bad;rm -rf"));
        assert!(!is_clip_slug_valid("../../../etc"));
        // Over 100 chars
        assert!(!is_clip_slug_valid(&"a".repeat(101)));
    }
}
