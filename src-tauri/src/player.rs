use std::process::Stdio;

use serde::Serialize;

use crate::resolve::{is_channel_name_valid, streamlink_bin, ALLOWED_QUALITIES};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlayerResponse {
    pub ok: bool,
    pub error: Option<String>,
}

/// Hand the stream off to an external player (mpv) by letting streamlink
/// own the lifecycle: `streamlink --player=mpv twitch.tv/<channel> <quality>`
/// resolves the stream and pipes it to mpv, reconnection/token-refresh
/// included. The process is spawned detached (no `kill_on_drop`): dropping
/// the handle reparents streamlink to init, so it + mpv keep running
/// independently of this app until mpv exits.
#[tauri::command]
pub async fn launch_player(
    channel: String,
    quality: Option<String>,
    low_latency: Option<bool>,
) -> Result<LaunchPlayerResponse, String> {
    let mut channel = channel.trim().to_lowercase();
    if let Some(stripped) = channel.strip_prefix('#') {
        channel = stripped.to_string();
    }

    if !is_channel_name_valid(&channel) {
        return Ok(LaunchPlayerResponse {
            ok: false,
            error: Some("invalid channel name".to_string()),
        });
    }

    let q_raw = quality.unwrap_or_else(|| "best".to_string());
    let q = q_raw.trim().to_lowercase();
    if !ALLOWED_QUALITIES.contains(&q.as_str()) {
        return Ok(LaunchPlayerResponse {
            ok: false,
            error: Some("invalid stream quality".to_string()),
        });
    }

    let bin = streamlink_bin();
    let low = low_latency.unwrap_or(false);

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--player=mpv");
    if low {
        cmd.arg("--twitch-low-latency");
    }
    cmd.arg("--loglevel")
        .arg("error")
        .arg(format!("https://twitch.tv/{}", channel))
        .arg(&q)
        // We don't care about streamlink's own output here — it pipes the
        // stream to mpv internally. Null stdio keeps it out of our pipes.
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::env_spawn::configure(cmd.as_std_mut(), None);

    match cmd.spawn() {
        Ok(_child) => {
            // Fire-and-forget: intentionally drop the handle WITHOUT
            // kill_on_drop so streamlink (and the mpv it spawned) survive.
            Ok(LaunchPlayerResponse {
                ok: true,
                error: None,
            })
        }
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
