use std::env;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

const RESOLVE_TIMEOUT: Duration = Duration::from_millis(25_000);

const STREAMLINK_OFFLINE_MARKERS: &[&str] =
    &["No playable streams found", "error: No playable streams"];

/// Quality tokens accepted by the resolve/player commands. HISTORICALLY an
/// enumerated allowlist (`best`/`audio_only`/`160p`…`1080p60`), but Twitch's
/// transcode ladder is DYNAMIC — rungs are named after whatever the channel's
/// master playlist happens to offer (`936p60`, `480p60`, …), so an
/// enumeration silently made real rungs unresolvable (a `936p60` variant
/// failed validation before streamlink ever saw it). Validation is now
/// STRUCTURAL: after lowercasing, a quality token is exactly the character
/// class streamlink itself uses for variant names (lowercase ASCII
/// alphanumerics + underscore), bounded in length. The token reaches
/// streamlink as a direct argv element (never through a shell), so this is
/// defense-in-depth against malformed input, not an injection guard.
pub(crate) fn is_quality_valid(q: &str) -> bool {
    let len = q.chars().count();
    if len == 0 || len > 16 {
        return false;
    }
    q.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

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
/// "QuietBraveLlamaMeadowRun-pT4vXR2bWHn7fKqz". Validated before the slug
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
    // Resolved ONCE and cached for the process lifetime (every live/VOD/clip
    // play calls this). The env is read at most once; if a user installs or
    // relocates streamlink after the first resolution they must restart, which
    // the not-installed message already tells them. The pure selection logic
    // (env override → first existing candidate → bare fallback) lives in
    // `select_binary_path` and is unit-tested directly.
    static STREAMLINK_BIN_CACHE: OnceLock<PathBuf> = OnceLock::new();
    STREAMLINK_BIN_CACHE
        .get_or_init(|| {
            let env_value = env::var("STREAMLINK_BIN").ok();
            // macOS GUI apps launched from Finder/Dock inherit launchd's
            // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which excludes
            // Homebrew (/opt/homebrew/bin) and MacPorts (/opt/local/bin), so a
            // bare "streamlink" lookup fails for every Finder-launched user.
            // Probe absolute candidates first (mirroring opener.rs). On Linux/
            // Windows the candidate list is empty and this degrades to the bare
            // binary via PATH, preserving the original behaviour.
            let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
                let home = env::var("HOME").ok().map(PathBuf::from);
                macos_streamlink_candidates(home.as_deref())
            } else if cfg!(target_os = "windows") {
                let exe_dir = env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(Path::to_path_buf));
                windows_streamlink_candidates(exe_dir.as_deref())
            } else {
                Vec::new()
            };
            select_binary_path(env_value.as_deref(), &candidates, "streamlink")
        })
        .clone()
}

/// Pure binary-path resolver (no global state, no env access) so the
/// resolution order and rejection cases are unit-testable on any host.
///
/// Order: a non-empty env override (verbatim) wins; otherwise the first
/// existing candidate (checked with `is_file()`); otherwise the bare fallback
/// (resolved via the child's PATH at spawn time). Like opener.rs, candidates
/// are absolute paths so a PATH-hijacked binary of the same name can't win,
/// and the env override remains the explicit escape hatch. Shared by
/// `streamlink_bin` (resolve.rs) and the mpv resolver (player.rs).
pub(crate) fn select_binary_path(
    env_value: Option<&str>,
    candidates: &[PathBuf],
    fallback: &str,
) -> PathBuf {
    if let Some(v) = env_value.filter(|v| !v.is_empty()) {
        return PathBuf::from(v);
    }
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.clone();
        }
    }
    PathBuf::from(fallback)
}

/// macOS streamlink candidate absolute paths, in probe order:
/// Apple Silicon Homebrew → Intel Homebrew / some pip → MacPorts → pip --user.
/// `home` is passed in (rather than read from env) so the ORDER is unit-testable
/// on any host; the caller expands `$HOME`. Non-gated: only the list data is
/// platform-agnostic; invocation is gated at the call site by `cfg!(macos)`.
fn macos_streamlink_candidates(home: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/streamlink"),
        PathBuf::from("/usr/local/bin/streamlink"),
        PathBuf::from("/opt/local/bin/streamlink"),
    ];
    if let Some(home) = home {
        candidates.push(home.join(".local/bin/streamlink"));
    }
    candidates
}

/// Windows streamlink candidate absolute paths: the copy BUNDLED with the
/// app comes first. The NSIS installer ships streamlink's portable build
/// (embedded Python + deps, ffmpeg stripped — this app only resolves URLs)
/// at `<install>\streamlink\` via tauri.windows.conf.json's bundle
/// resources, so a fresh install resolves streams with zero external
/// setup. A system install (installer/pip) puts streamlink on PATH, which
/// the bare fallback covers — no absolute candidates needed for it.
/// `exe_dir` is passed in (rather than read via current_exe) so the list is
/// unit-testable on any host; the caller passes the app binary's directory.
fn windows_streamlink_candidates(exe_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("streamlink").join("bin").join("streamlink.exe"));
    }
    candidates
}

/// A clear, actionable message for the case where the streamlink binary is
/// not found. Windows installs BUNDLE streamlink next to the app (see
/// windows_streamlink_candidates), so this arm is a fallback there (dev
/// builds, or a broken install); on macOS/Linux it is the first-class
/// first-run state. It tells the user exactly what's missing, how to
/// install it, and how to override the path via `STREAMLINK_BIN`. The debug
/// build additionally names the path we looked for so a misconfigured
/// override is easy to diagnose; release builds stay clean of local paths.
/// Shared by `resolve_stream`/`resolve_vod`/`resolve_clip` (resolve.rs)
/// and `launch_player` (player.rs).
pub(crate) fn streamlink_missing_message(bin: &std::path::Path) -> String {
    let detail = if include_detail() {
        format!(" (looked for '{}')", bin.display())
    } else {
        String::new()
    };
    if cfg!(target_os = "windows") {
        format!(
            "streamlink is not installed or not on PATH{detail}. Install it from https://streamlink.github.io/install.html (or run 'pip install streamlink'), then restart kappastream. To point at a specific location, set the STREAMLINK_BIN environment variable to streamlink.exe's full path."
        )
    } else if cfg!(target_os = "macos") {
        format!(
            "streamlink is not installed or not on PATH{detail}. Install it with Homebrew ('brew install streamlink'), or run 'pip install streamlink', then restart kappastream. To point at a specific location, set the STREAMLINK_BIN environment variable to streamlink's full path."
        )
    } else {
        format!(
            "streamlink is not installed or not on PATH{detail}. Install it via your package manager (e.g. 'sudo apt install streamlink'), then restart kappastream. Set the STREAMLINK_BIN environment variable to override the path."
        )
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
    let mut args: Vec<String> = vec!["--loglevel".into(), "error".into()];
    // Twitch low-latency mode: requests the short-segment LL-HLS playlist so
    // the player can chase the live edge (~5-8s vs the usual 15-30s). Paired
    // with hls.js lowLatencyMode + liveSyncDurationCount in the frontend.
    if low_latency {
        args.push("--twitch-low-latency".into());
    }
    args.push("--stream-url".into());
    args.push(twitch_url.into());
    args.push(quality.into());
    spawn_streamlink(bin, args).await
}

/// Spawn streamlink with the given args, wait (bounded by RESOLVE_TIMEOUT),
/// and return its stdout. The shared plumbing behind the resolve paths
/// (which pass a quality + `--stream-url`) and the quality-list probe
/// (which passes `--json`).
async fn spawn_streamlink<S: AsRef<std::ffi::OsStr>>(
    bin: &std::path::Path,
    args: impl IntoIterator<Item = S>,
) -> Result<String, StreamlinkError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::env_spawn::configure(cmd.as_std_mut(), None);
    // A Windows GUI app would otherwise pop a console window for the
    // short-lived streamlink resolve call (which happens on every live/VOD/
    // clip play). No-op on Unix.
    crate::env_spawn::hide_console(cmd.as_std_mut());

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StreamlinkError::Spawn(streamlink_missing_message(bin)));
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

/// Result of probing the host for a usable streamlink install. Used only by the
/// first-run welcome screen so it can surface the platform-appropriate install
/// hint ONLY when streamlink is actually missing — users who already have it
/// are never nagged.
///
/// `platform` is the compile-time target OS (`std::env::consts::OS`, the same
/// authoritative value the `target_os` command returns) so the FRONTEND can
/// pick the right install command per platform (pacman/apt/dnf on Linux, brew
/// on macOS, pip on Windows). The hint text itself is translated frontend
/// chrome — it does not belong here, so this command reports presence +
/// platform only and stays out of the localization business.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamlinkStatus {
    pub present: bool,
    pub platform: String,
}

/// Whether streamlink is installed and discoverable, plus the compile-time
/// platform so the welcome screen can show the right install command.
///
/// Reuses `streamlink_bin` — the SAME binary discovery every resolve uses (env
/// override → macOS absolute candidates → bare PATH fallback) — so a "present"
/// result here guarantees the subsequent `resolve_stream` will spawn it too.
/// Probed with `streamlink --version` under the SAME env whitelist a real
/// resolve uses (`env_spawn::configure` + `hide_console`), so AppImage PATH
/// handling and Windows console-suppression match exactly. On any non-NotFound
/// spawn error we assume present (don't nag on a weird-but-working install).
/// NOT gated behind the `updater` Cargo feature — AUR builds compile the
/// updater out but AUR users still update via pacman and still get the welcome
/// screen on first install.
#[tauri::command]
pub async fn streamlink_status() -> StreamlinkStatus {
    let bin = streamlink_bin();
    let platform = std::env::consts::OS.to_string();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    crate::env_spawn::configure(cmd.as_std_mut(), None);
    // No-op on Unix; suppresses the flash of a console window for the probe on
    // Windows (same as every other streamlink spawn).
    crate::env_spawn::hide_console(cmd.as_std_mut());
    match cmd.spawn() {
        Ok(mut child) => {
            // --version exits immediately; reap it so we never orphan a handle.
            let _ = child.wait().await;
            StreamlinkStatus {
                present: true,
                platform,
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => StreamlinkStatus {
            present: false,
            platform,
        },
        Err(_) => StreamlinkStatus {
            present: true,
            platform,
        },
    }
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
    if !is_quality_valid(&q) {
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

/// Parse `streamlink --json <url>` LISTING output (no quality argument →
/// streamlink prints its streams object and exits without playing) into the
/// REAL variant rungs it advertises. Twitch's transcode ladder is dynamic —
/// rungs carry whatever name the channel's master playlist uses (`936p60`,
/// `480p60`, …) — so this does NOT intersect with any fixed vocabulary; it
/// keeps every structurally-valid key (`is_quality_valid`) EXCEPT streamlink's
/// own aliases (`best`/`worst` and their `*_unfiltered` twins), which just
/// duplicate rungs — the frontend prepends its own `best`. Tolerant by
/// design: anything unexpected — offline/error payloads (`{"error": …}`),
/// malformed JSON, a missing `streams` object — yields an EMPTY vec, never
/// an error; the frontend maps empty to "unknown" and falls back to the full
/// static vocabulary.
pub(crate) fn parse_available_qualities(stdout: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Vec::new();
    };
    let Some(streams) = value.get("streams").and_then(|s| s.as_object()) else {
        return Vec::new();
    };
    const ALIASES: &[&str] = &["best", "worst", "best_unfiltered", "worst_unfiltered"];
    streams
        .keys()
        .filter(|k| !ALIASES.contains(&k.as_str()) && is_quality_valid(k))
        .cloned()
        .collect()
}

/// The stream qualities a live channel actually offers RIGHT NOW — the source
/// of truth for the players' quality menus. The static menu vocabulary
/// over-promises: a channel transcoding 720p60 but not 720p makes the plain
/// "720p" menu entry a guaranteed resolve failure (and a silent fallback to
/// best). This probe runs `streamlink --json` in listing mode so the menu
/// lists only real variants, INCLUDING rungs the old hardcoded vocabulary
/// never knew (936p60 etc.). Presentation ORDER is the frontend's business
/// (it sorts by encoded resolution height); this returns an unordered set of
/// rung ids. ANY failure (streamlink missing, timeout, offline, malformed
/// output) returns an empty list — the probe can never take the menu away,
/// only sharpen it.
#[tauri::command]
pub async fn stream_qualities(
    channel: String,
    low_latency: Option<bool>,
) -> Result<Vec<String>, String> {
    let mut channel = channel.trim().to_lowercase();
    if let Some(stripped) = channel.strip_prefix('#') {
        channel = stripped.to_string();
    }
    if !is_channel_name_valid(&channel) {
        return Ok(Vec::new());
    }

    let bin = streamlink_bin();
    let url = format!("https://twitch.tv/{}", channel);
    let mut args: Vec<String> = vec!["--loglevel".into(), "error".into()];
    if low_latency.unwrap_or(false) {
        args.push("--twitch-low-latency".into());
    }
    args.push("--json".into());
    args.push(url);

    match spawn_streamlink(&bin, args).await {
        Ok(stdout) => Ok(parse_available_qualities(&stdout)),
        Err(_) => Ok(Vec::new()),
    }
}

// VOD/clip media (resolved HLS playlists and clip MP4s) are served from
// Twitch's CloudFront distribution (e.g. d2nvs31859zcd8.cloudfront.net), which
// the live `resolve_stream` allowlist below intentionally does NOT include.
// The VOD path gets its own broader host set so the live path stays untouched.
// Shared (pub(crate)) with vod_proxy.rs so the proxy validates fetches against
// the SAME single list — two copies would silently drift (a security-relevant
// failure mode). The proxy comment used to say "mirrors"; it now uses this.
pub(crate) fn is_allowed_vod_host(host: &str) -> bool {
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
    if !is_quality_valid(&q) {
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
    if !is_quality_valid(&q) {
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
    fn available_qualities_from_typical_listing() {
        // Shape of `streamlink --json <url>` listing output (trimmed to the
        // keys we read): aliases dropped, every real rung kept — INCLUDING
        // ladder names the old hardcoded vocabulary never knew (936p60 is a
        // standard modern Twitch rung between 1080p60 and 720p60).
        let out = r#"{"plugin":"twitch","streams":{
            "audio_only":{"type":"hls"},
            "160p":{"type":"hls"},
            "360p":{"type":"hls"},
            "480p":{"type":"hls"},
            "720p60":{"type":"hls"},
            "936p60":{"type":"hls"},
            "1080p60":{"type":"hls"},
            "worst":{"type":"hls"},
            "best":{"type":"hls"},
            "worst_unfiltered":{"type":"hls"},
            "best_unfiltered":{"type":"hls"}
        }}"#;
        let mut q = parse_available_qualities(out);
        q.sort();
        assert_eq!(
            q,
            vec![
                "1080p60",
                "160p",
                "360p",
                "480p",
                "720p60",
                "936p60",
                "audio_only"
            ]
        );
    }

    #[test]
    fn available_qualities_transcode_subset() {
        // A sparse ladder (what smaller channels get): the highest rung IS
        // the source, plus one transcode and audio_only — and no low rungs.
        // The probe reports exactly that; nothing is invented or dropped.
        let out = r#"{"streams":{"best":{},"1080p60":{},"720p60":{},"audio_only":{},"worst":{}}}"#;
        let mut q = parse_available_qualities(out);
        q.sort();
        assert_eq!(q, vec!["1080p60", "720p60", "audio_only"]);
    }

    #[test]
    fn available_qualities_drop_structurally_invalid_keys() {
        // Keys that could never be streamlink variant names (spaces, caps,
        // punctuation, oversize) are dropped rather than surfaced to menus.
        let out = r#"{"streams":{"720p60":{},"not a quality":{},"720P":{},"x-y":{},"way_too_long_quality_name":{}}}"#;
        let q = parse_available_qualities(out);
        assert_eq!(q, vec!["720p60"]);
    }

    #[test]
    fn available_qualities_offline_and_malformed_yield_empty() {
        // Offline channels: streamlink --json exits non-zero with an error
        // payload (no streams object). Malformed output likewise. Both must
        // map to "unknown" (empty), never panic or error.
        assert!(
            parse_available_qualities(r#"{"error":"No playable streams found on this URL"}"#)
                .is_empty()
        );
        assert!(parse_available_qualities("not json at all").is_empty());
        assert!(parse_available_qualities(r#"{"streams":[]}"#).is_empty());
        assert!(parse_available_qualities("").is_empty());
    }

    #[test]
    fn channel_name_valid_basic() {
        assert!(is_channel_name_valid("x"));
        assert!(is_channel_name_valid("twitch"));
        assert!(is_channel_name_valid("chan1"));
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
    fn quality_valid_accepts_realistic_rungs() {
        // Everything a Twitch ladder realistically names, including rungs
        // the old hardcoded vocabulary never knew.
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
            "936p60",
            "480p60",
        ] {
            assert!(is_quality_valid(q), "expected `{q}` to be valid");
        }
    }

    #[test]
    fn quality_valid_rejects_malformed_tokens() {
        // The check is structural (post-lowercase): no casing, separators,
        // whitespace, emptiness, or oversize tokens may reach a streamlink
        // argv.
        assert!(!is_quality_valid(""));
        assert!(!is_quality_valid("720P")); // uppercase never reaches streamlink
        assert!(!is_quality_valid("1080p "));
        assert!(!is_quality_valid("audio only"));
        assert!(!is_quality_valid("best;rm -rf"));
        assert!(!is_quality_valid("--stream-url"));
        assert!(!is_quality_valid(&"q".repeat(17)));
        assert!(is_quality_valid(&"q".repeat(16))); // boundary: exactly 16 ok
    }

    #[test]
    fn windows_streamlink_candidates_prefer_the_bundled_copy() {
        // The bundled tree ships at <install>/streamlink/bin/streamlink.exe
        // (backslashes on the real platform — forward slashes keep the
        // assertion join-semantics-identical on this test host).
        assert_eq!(
            windows_streamlink_candidates(Some(Path::new("C:/apps/kappastream"))),
            vec![PathBuf::from(
                "C:/apps/kappastream/streamlink/bin/streamlink.exe"
            )]
        );
        // Without a resolvable exe dir there is nothing absolute to probe —
        // selection degrades to the bare PATH fallback.
        assert!(windows_streamlink_candidates(None).is_empty());
    }

    #[test]
    fn select_binary_path_prefers_env_override() {
        // A non-empty env override wins verbatim, even when a candidate exists.
        let existing = std::env::current_exe().unwrap();
        assert_eq!(
            select_binary_path(Some("/override/streamlink"), &[existing], "streamlink"),
            PathBuf::from("/override/streamlink")
        );
        // An empty env string does NOT win — it falls through to candidates.
        assert_eq!(
            select_binary_path(
                Some(""),
                &[PathBuf::from("/does/not/exist/streamlink")],
                "streamlink"
            ),
            PathBuf::from("streamlink")
        );
    }

    #[test]
    fn select_binary_path_returns_first_existing_candidate() {
        let existing = std::env::current_exe().unwrap();
        // A non-existent candidate placed BEFORE an existing one: the existing
        // one must win (order is a probe order, not first-wins-blindly).
        let candidates = vec![PathBuf::from("/nope/bin/streamlink"), existing.clone()];
        assert_eq!(
            select_binary_path(None, &candidates, "streamlink"),
            existing
        );
    }

    #[test]
    fn select_binary_path_falls_back_to_bare_when_no_candidate_exists() {
        // None of these exist on the test host → bare fallback (PATH lookup).
        let candidates = vec![
            PathBuf::from("/opt/homebrew/bin/streamlink"),
            PathBuf::from("/usr/local/bin/streamlink"),
        ];
        assert_eq!(
            select_binary_path(None, &candidates, "streamlink"),
            PathBuf::from("streamlink")
        );
    }

    #[test]
    fn macos_streamlink_candidate_order() {
        let home = PathBuf::from("/Users/test");
        let candidates = macos_streamlink_candidates(Some(&home));
        // Load-bearing order: Apple Silicon Homebrew is checked BEFORE Intel
        // Homebrew, then MacPorts, then pip --user under $HOME.
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/opt/homebrew/bin/streamlink"),
                PathBuf::from("/usr/local/bin/streamlink"),
                PathBuf::from("/opt/local/bin/streamlink"),
                PathBuf::from("/Users/test/.local/bin/streamlink"),
            ]
        );
        // Without HOME, the pip --user entry is omitted (the other three remain).
        let no_home = macos_streamlink_candidates(None);
        assert_eq!(no_home.len(), 3);
        assert!(!no_home.iter().any(|p| p.ends_with(".local/bin/streamlink")));
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
            "QuietBraveLlamaMeadowRun-pT4vXR2bWHn7fKqz"
        ));
        assert!(is_clip_slug_valid(
            "HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf"
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
