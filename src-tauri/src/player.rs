use std::process::Stdio;

use serde::Serialize;

use crate::resolve::{
    is_channel_name_valid, is_clip_slug_valid, is_vod_id_valid, streamlink_bin, ALLOWED_QUALITIES,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlayerResponse {
    pub ok: bool,
    pub error: Option<String>,
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
    let low = low_latency.unwrap_or(false) && low_ok;

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--player=mpv");
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

    match cmd.spawn() {
        Ok(_child) => Ok(LaunchPlayerResponse {
            ok: true,
            error: None,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(LaunchPlayerResponse {
            ok: false,
            error: Some(if cfg!(debug_assertions) {
                format!(
                    "streamlink binary not found at '{}': set STREAMLINK_BIN to override the path",
                    bin.display()
                )
            } else {
                "streamlink binary not found: set STREAMLINK_BIN to override the path".to_string()
            }),
        }),
        Err(e) => Ok(LaunchPlayerResponse {
            ok: false,
            error: Some(e.to_string()),
        }),
    }
}
