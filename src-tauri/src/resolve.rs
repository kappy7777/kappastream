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
    channel: &str,
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
        .arg(format!("https://twitch.tv/{}", channel))
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

    let result = run_streamlink(&bin, &channel_for_spawn, &q_for_spawn, low_for_spawn).await;

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
        env::remove_var("STREAMLINK_BIN");
        assert_eq!(streamlink_bin(), PathBuf::from("streamlink"));

        // An explicit override is honored verbatim.
        env::set_var("STREAMLINK_BIN", "/custom/path/streamlink");
        assert_eq!(streamlink_bin(), PathBuf::from("/custom/path/streamlink"));
        env::remove_var("STREAMLINK_BIN");
    }
}
