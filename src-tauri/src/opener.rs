use serde::Serialize;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use url::{Position, Url};

const OPENER_TIMEOUT: Duration = Duration::from_secs(5);

fn has_explicit_userinfo(raw_url: &str) -> bool {
    raw_url
        .find("://")
        .and_then(|scheme_end| raw_url.get(scheme_end + 3..))
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'))
}

#[derive(Serialize)]
pub struct CandidateResult {
    pub name: String,
    pub path: String,
    pub present: bool,
    pub exit_code: Option<i32>,
    /// The opener was still running when the grace period elapsed. This
    /// happens on KDE where `xdg-open` execs the browser directly (no
    /// xdg-desktop-portal), so the child we tracked IS the browser
    /// launching. We detach instead of killing it; treat as success.
    pub still_running: bool,
    pub stderr: String,
}

#[derive(Serialize)]
pub struct OpenResult {
    pub ok: bool,
    pub method: String,
    pub path: Option<String>,
    pub exit_code: Option<i32>,
    pub stderr: String,
    pub url: String,
    pub inherited_path: Option<String>,
    pub display: Option<String>,
    pub dbus_session: Option<String>,
    pub candidates: Vec<CandidateResult>,
}

fn validated_url(raw_url: &str) -> Option<String> {
    if raw_url.len() > 2_048 {
        return None;
    }
    let parsed = Url::parse(raw_url).ok()?;
    let host = parsed.host_str()?;
    if parsed.scheme() != "https"
        || !(host == "twitch.tv" || host.ends_with(".twitch.tv"))
        || has_explicit_userinfo(raw_url)
        || !parsed[Position::BeforeUsername..Position::BeforeHost].is_empty()
        || parsed.port_or_known_default() != Some(443)
    {
        return None;
    }
    Some(parsed.to_string())
}

fn run_candidate(name: &str, path: &str, args: &[String], child_path: &str) -> CandidateResult {
    if !std::path::Path::new(path).is_file() {
        return CandidateResult {
            name: name.to_string(),
            path: path.to_string(),
            present: false,
            exit_code: None,
            still_running: false,
            stderr: String::new(),
        };
    }

    let mut cmd = Command::new(path);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::env_spawn::configure(&mut cmd, Some(child_path));

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CandidateResult {
                name: name.to_string(),
                path: path.to_string(),
                present: true,
                exit_code: None,
                still_running: false,
                stderr: format!("spawn error: {error}"),
            };
        }
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break CandidateResult {
                    name: name.to_string(),
                    path: path.to_string(),
                    present: true,
                    exit_code: status.code(),
                    still_running: false,
                    stderr: String::new(),
                }
            }
            Ok(None) if started.elapsed() < OPENER_TIMEOUT => {
                thread::sleep(Duration::from_millis(25));
            }
            // Still running past the grace period. On KDE, xdg-open execs
            // the browser directly (it does not go through
            // xdg-desktop-portal), so this child IS the browser that just
            // started launching. Killing it would abort a freshly-starting
            // browser — the exact symptom where the link "only opens if the
            // browser is already running". Detach instead: drop the handle
            // so the child is reparented to init, and report success.
            Ok(None) => {
                drop(child);
                break CandidateResult {
                    name: name.to_string(),
                    path: path.to_string(),
                    present: true,
                    exit_code: None,
                    still_running: true,
                    stderr: format!(
                        "still running after {} ms (browser likely launched directly); detached",
                        OPENER_TIMEOUT.as_millis()
                    ),
                };
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break CandidateResult {
                    name: name.to_string(),
                    path: path.to_string(),
                    present: true,
                    exit_code: None,
                    still_running: false,
                    stderr: format!("wait error: {error}"),
                };
            }
        }
    }
}

#[tauri::command]
pub async fn open_url_robust(url: String) -> Result<OpenResult, String> {
    let (inherited_path, display, dbus_session) = if cfg!(debug_assertions) {
        (
            std::env::var("PATH").ok(),
            std::env::var("DISPLAY").ok(),
            std::env::var("DBUS_SESSION_BUS_ADDRESS").ok(),
        )
    } else {
        (None, None, None)
    };

    let Some(url) = validated_url(&url) else {
        return Ok(OpenResult {
            ok: false,
            method: "validation".to_string(),
            path: None,
            exit_code: None,
            stderr: "URL must be an HTTPS twitch.tv page without credentials or a custom port"
                .to_string(),
            url,
            inherited_path,
            display,
            dbus_session,
            candidates: vec![],
        });
    };

    let opener_url = url.clone();
    let per_candidate = tauri::async_runtime::spawn_blocking(move || {
        let child_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        let candidates = [
            ("xdg-open", "/usr/bin/xdg-open", false),
            ("xdg-open", "/bin/xdg-open", false),
            ("xdg-open", "/usr/local/bin/xdg-open", false),
            ("gio", "/usr/bin/gio", true),
            ("gio", "/bin/gio", true),
            ("sensible-browser", "/usr/bin/sensible-browser", false),
            ("x-www-browser", "/usr/bin/x-www-browser", false),
        ];
        let mut results = Vec::new();
        for (name, path, is_gio) in candidates {
            let args = if is_gio {
                vec!["open".to_string(), opener_url.clone()]
            } else {
                vec![opener_url.clone()]
            };
            let result = run_candidate(name, path, &args, child_path);
            let succeeded = result.exit_code == Some(0) || result.still_running;
            results.push(result);
            if succeeded {
                break;
            }
        }
        results
    })
    .await
    .map_err(|error| format!("opener task failed: {error}"))?;

    if let Some(success) = per_candidate
        .iter()
        .find(|candidate| candidate.exit_code == Some(0) || candidate.still_running)
    {
        return Ok(OpenResult {
            ok: true,
            method: success.name.clone(),
            path: Some(success.path.clone()),
            exit_code: success.exit_code,
            stderr: if success.still_running {
                success.stderr.clone()
            } else {
                format!("{} ({}) succeeded", success.name, success.path)
            },
            url,
            inherited_path,
            display,
            dbus_session,
            candidates: per_candidate,
        });
    }

    let combined = per_candidate
        .iter()
        .map(|candidate| {
            if !candidate.present {
                format!("{}({}): not present", candidate.name, candidate.path)
            } else if let Some(code) = candidate.exit_code {
                let stderr = if candidate.stderr.is_empty() {
                    "<empty>"
                } else {
                    &candidate.stderr
                };
                format!(
                    "{}({}) exit={} stderr={}",
                    candidate.name, candidate.path, code, stderr
                )
            } else {
                format!(
                    "{}({}): {}",
                    candidate.name, candidate.path, candidate.stderr
                )
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");

    Ok(OpenResult {
        ok: false,
        method: "all-failed".to_string(),
        path: None,
        exit_code: None,
        stderr: combined,
        url,
        inherited_path,
        display,
        dbus_session,
        candidates: per_candidate,
    })
}

#[cfg(test)]
mod tests {
    use super::validated_url;

    #[test]
    fn accepts_and_normalizes_twitch_https_urls() {
        assert_eq!(
            validated_url("https://WWW.TWITCH.TV:443/some_channel"),
            Some("https://www.twitch.tv/some_channel".to_string())
        );
    }

    #[test]
    fn rejects_untrusted_url_variants() {
        for url in [
            "http://twitch.tv/channel",
            "https://notwitch.tv/channel",
            "https://twitch.tv.example/channel",
            "https://user@twitch.tv/channel",
            "https://@twitch.tv/channel",
            "https://twitch.tv:444/channel",
            "https://evil.example\\.twitch.tv/channel",
        ] {
            assert_eq!(validated_url(url), None, "accepted {url}");
        }
    }
}
