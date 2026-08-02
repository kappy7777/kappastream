use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

use serde::Serialize;

use crate::resolve::{
    is_channel_name_valid, is_clip_slug_valid, is_vod_id_valid, select_binary_path, streamlink_bin,
    streamlink_missing_message, ALLOWED_QUALITIES,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlayerResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Resolved mpv binary path, cached for the process lifetime. On macOS, a
/// Finder/Dock-launched app inherits launchd's minimal PATH, so — like
/// streamlink — mpv is probed at well-known absolute locations before falling
/// back to a bare PATH lookup. mpv is frequently installed as a `.app` bundle
/// rather than via Homebrew, so `/Applications/mpv.app/Contents/MacOS/mpv` is
/// in the candidate list. On Linux/Windows the list is empty → bare "mpv".
pub(crate) fn mpv_bin() -> PathBuf {
    static MPV_BIN_CACHE: OnceLock<PathBuf> = OnceLock::new();
    MPV_BIN_CACHE
        .get_or_init(|| {
            let candidates: Vec<PathBuf> = if cfg!(target_os = "macos") {
                macos_mpv_candidates()
            } else {
                Vec::new()
            };
            select_binary_path(None, &candidates, "mpv")
        })
        .clone()
}

/// macOS mpv candidate absolute paths, in probe order: Homebrew (Apple Silicon
/// → Intel) → MacPorts → the mpv.app bundle. Non-gated so the ORDER (incl. the
/// `.app` path) is unit-testable on any host; invocation is cfg!(macos)-gated
/// at the call site.
fn macos_mpv_candidates() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin/mpv"),
        PathBuf::from("/usr/local/bin/mpv"),
        PathBuf::from("/opt/local/bin/mpv"),
        PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv"),
    ]
}

/// Whether the external player binary (mpv) can be launched. Probed with the
/// SAME env whitelist the real handoff uses (`env_spawn::configure`), so AppImage
/// PATH handling and Windows PATHEXT resolution match exactly what the actual
/// `--player=<mpv>` spawn would see. `mpv --version` exits immediately; on
/// NotFound we treat mpv as missing, on any other error we assume it exists
/// (don't block a working install on a weird --version failure).
fn external_player_available() -> bool {
    let mut cmd = std::process::Command::new(mpv_bin());
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::env_spawn::configure(&mut cmd, None);
    crate::env_spawn::hide_console(&mut cmd);
    match cmd.spawn() {
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            true
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

/// A clear, actionable message for when mpv is not installed. The
/// external-player feature (`--player=<mpv>`) needs mpv; without this pre-check
/// streamlink would spawn, fail to launch mpv, and exit asynchronously — so the
/// app would report success while nothing opens.
fn external_player_missing_message() -> String {
    if cfg!(target_os = "windows") {
        "mpv is not installed or not on PATH. The 'open in external player' feature needs mpv — install it from https://mpv.io/installation/ and restart kappastream."
            .to_string()
    } else if cfg!(target_os = "macos") {
        "mpv is not installed or not on PATH. The 'open in external player' feature needs mpv — install it with Homebrew ('brew install mpv') or from https://mpv.io/installation/ and restart kappastream."
            .to_string()
    } else {
        "mpv is not installed or not on PATH. The 'open in external player' feature needs mpv — install it via your package manager (e.g. 'sudo apt install mpv') and restart kappastream."
            .to_string()
    }
}

/// Hand the stream off to an external player (mpv) by letting streamlink
/// own the lifecycle. For live channels:
///   `streamlink --player=mpv twitch.tv/<channel> <quality>`
/// For VODs:
///   `streamlink --player=mpv twitch.tv/videos/<id> <quality>`
/// For clips:
///   `streamlink --player=mpv clips.twitch.tv/<slug> best`
///
/// The process is spawned detached (no `kill_on_drop`): dropping the handle
/// reparents streamlink to init, so it + mpv keep running independently of
/// this app until mpv exits.
#[tauri::command]
pub async fn launch_player(
    channel: Option<String>,
    quality: Option<String>,
    low_latency: Option<bool>,
    vod_id: Option<String>,
    clip_slug: Option<String>,
) -> Result<LaunchPlayerResponse, String> {
    let q_raw = quality.unwrap_or_else(|| "best".to_string());
    let q = q_raw.trim().to_lowercase();
    if !ALLOWED_QUALITIES.contains(&q.as_str()) {
        return Ok(LaunchPlayerResponse {
            ok: false,
            error: Some("invalid stream quality".to_string()),
        });
    }

    // Determine the streamlink target URL and whether low-latency is valid.
    let (url, low_ok) = if let Some(slug) = clip_slug.as_deref() {
        let s = slug.trim();
        if !is_clip_slug_valid(s) {
            return Ok(LaunchPlayerResponse {
                ok: false,
                error: Some("invalid clip slug".to_string()),
            });
        }
        // Clips only support "best" quality.
        if q != "best" {
            return Ok(LaunchPlayerResponse {
                ok: false,
                error: Some("clips only support 'best' quality".to_string()),
            });
        }
        (format!("https://clips.twitch.tv/{}", s), false)
    } else if let Some(id) = vod_id.as_deref() {
        let id = id.trim();
        if !is_vod_id_valid(id) {
            return Ok(LaunchPlayerResponse {
                ok: false,
                error: Some("invalid VOD id".to_string()),
            });
        }
        (format!("https://www.twitch.tv/videos/{}", id), false)
    } else {
        // Live channel.
        let mut ch = channel.as_deref().unwrap_or("").trim().to_lowercase();
        if let Some(stripped) = ch.strip_prefix('#') {
            ch = stripped.to_string();
        }
        if !is_channel_name_valid(&ch) {
            return Ok(LaunchPlayerResponse {
                ok: false,
                error: Some("invalid channel name".to_string()),
            });
        }
        (format!("https://twitch.tv/{}", ch), true)
    };

    let bin = streamlink_bin();
    // Resolve mpv once (cached) and pass its path to streamlink's --player so
    // the handoff does NOT depend on mpv being on the child's PATH — on macOS a
    // Finder-launched streamlink inherits launchd's minimal PATH and could not
    // find /opt/homebrew/bin/mpv or /Applications/mpv.app/... on its own. The
    // external_player_available() probe above resolves the SAME path.
    let player = mpv_bin();
    let low = low_latency.unwrap_or(false) && low_ok;

    // The handoff shells out to `streamlink --player=<player> ...`, so both
    // binaries must be reachable. streamlink is checked by the spawn's NotFound
    // arm below; mpv is checked up front because streamlink launches mpv
    // asynchronously and its failure would otherwise surface nowhere (the app
    // would report ok while nothing opens).
    if !external_player_available() {
        return Ok(LaunchPlayerResponse {
            ok: false,
            error: Some(external_player_missing_message()),
        });
    }

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg(format!("--player={}", player.display()));
    if low {
        cmd.arg("--twitch-low-latency");
    }
    cmd.arg("--loglevel")
        .arg("error")
        .arg(&url)
        .arg(&q)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::env_spawn::configure(cmd.as_std_mut(), None);
    // Detach so streamlink+mpv survive this app (no kill_on_drop). On Windows
    // this also suppresses the console window and isolates the child from the
    // parent's control signals; on Unix dropping the handle already reparents
    // it to init.
    crate::env_spawn::detach(cmd.as_std_mut());

    match cmd.spawn() {
        Ok(_child) => Ok(LaunchPlayerResponse {
            ok: true,
            error: None,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LaunchPlayerResponse {
            ok: false,
            error: Some(streamlink_missing_message(&bin)),
        }),
        Err(e) => Ok(LaunchPlayerResponse {
            ok: false,
            error: Some(e.to_string()),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_mpv_candidate_order_includes_app_bundle() {
        let candidates = macos_mpv_candidates();
        // Load-bearing order: Homebrew Apple Silicon → Intel → MacPorts → the
        // mpv.app bundle (mpv is often installed as a .app, not via Homebrew).
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("/opt/homebrew/bin/mpv"),
                PathBuf::from("/usr/local/bin/mpv"),
                PathBuf::from("/opt/local/bin/mpv"),
                PathBuf::from("/Applications/mpv.app/Contents/MacOS/mpv"),
            ]
        );
    }

    // On a non-macOS host (Linux/Windows) the candidate list is empty, so the
    // resolver returns the bare binary name (PATH lookup at spawn time) —
    // preserving the original behaviour. Skipped on macOS, where the candidate
    // list is non-empty and the result depends on what's installed.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn mpv_bin_falls_back_to_bare_on_non_macos_host() {
        assert_eq!(mpv_bin(), PathBuf::from("mpv"));
    }
}
