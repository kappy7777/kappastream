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
    /// The opener was still running when the grace period elapsed. We
    /// detach instead of killing it; treat as success.
    /// - Linux/KDE: `xdg-open` execs the browser directly (no
    ///   xdg-desktop-portal), so the child we tracked IS the browser
    ///   launching.
    /// - Windows: `cmd.exe`/`rundll32.exe` normally exit within
    ///   milliseconds of handing the URL to the shell handler; reaching
    ///   the grace period means a hang, but detaching is still safer than
    ///   killing a possibly-launching browser.
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

// --- Windows candidate helpers ------------------------------------------------
// The Linux opener list below uses hardcoded absolute paths because every
// Linux distro ships the openers under well-known locations. Windows has no
// such fixed layout guarantee (SystemRoot is technically not bound to the
// C: drive), so we resolve cmd.exe / rundll32.exe through %SystemRoot%
// (falling back to %windir%) and keep the same absolute-path `is_file()`
// existence check the Linux path uses — we deliberately do NOT fall back to a
// bare PATH lookup, to keep a PATH-hijacked binary of the same name from
// winning (same philosophy as the Linux candidates).

#[cfg(target_os = "windows")]
fn system_root() -> Option<String> {
    std::env::var("SystemRoot")
        .or_else(|_| std::env::var("windir"))
        .ok()
        .filter(|root| !root.is_empty())
}

/// Build `<system_root>\System32\<binary>`. Kept pure (root passed
/// explicitly, no env access) so it can be unit-tested on any host; the
/// SystemRoot/windir lookup lives in `system_root()` above.
#[cfg(target_os = "windows")]
fn system32_binary(system_root: &str, binary: &str) -> String {
    format!("{}\\System32\\{}", system_root, binary)
}

/// `cmd.exe /C start "" <url>` argument vector. The empty string at index 2
/// is `start`'s window-TITLE parameter and is MANDATORY: `start` parses the
/// first quoted positional argument as the title (per Microsoft's `start`
/// reference: `start <"title"> ... <command>`), so without the explicit `""`
/// the URL itself would be consumed as the title and nothing would open.
/// `cmd /C` runs the command then exits.
#[cfg(target_os = "windows")]
fn cmd_start_args(url: &str) -> Vec<String> {
    vec![
        "/C".to_string(),
        "start".to_string(),
        String::new(),
        url.to_string(),
    ]
}

/// `rundll32.exe url.dll,FileProtocolHandler <url>` — the long-standing
/// ShellExecute-based fallback when `cmd /C start` does not succeed.
#[cfg(target_os = "windows")]
fn rundll_url_args(url: &str) -> Vec<String> {
    vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]
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
    // Suppress the console window a GUI app would otherwise flash when
    // spawning cmd.exe/rundll32.exe on Windows. No-op on Unix (no
    // per-process console window). NOT detach(): the opener child is
    // short-lived by design (it hands the URL to the shell handler and
    // exits), so the survive-the-parent detachment semantics that the
    // streamlink/mpv handoff in player.rs needs do not apply here — and
    // DETACHED_PROCESS would semantically conflict with CREATE_NO_WINDOW.
    crate::env_spawn::hide_console(&mut cmd);

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
            // Still running past the grace period.
            // - Linux/KDE: `xdg-open` execs the browser directly (it does
            //   NOT go through xdg-desktop-portal), so this child IS the
            //   browser that just started launching. Killing it would abort
            //   a freshly-starting browser — the exact symptom where the
            //   link "only opens if the browser is already running".
            // - Windows: `cmd.exe`/`rundll32.exe` normally exit within
            //   milliseconds of handing the URL to the shell handler;
            //   reaching here means they hung. This is NOT the expected
            //   path on Windows (unlike the KDE case), but detaching is
            //   still the right call rather than killing something that may
            //   be mid-launch.
            // Either way: drop the handle so the child is reparented to
            // init (Unix) / orphaned but left running (Windows), and report
            // success.
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
        // PATH forwarded to env_spawn::configure() when running from an
        // AppImage (whose runtime strips PATH). configure() is a no-op on
        // Windows (APPIMAGE is never set there), so this Unix PATH string
        // is never consulted on Windows — it just satisfies the parameter.
        #[cfg(not(target_os = "windows"))]
        let child_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        #[cfg(target_os = "windows")]
        let child_path = "";

        // Each candidate is (name, absolute_path, args). The absolute path
        // is checked via is_file() in run_candidate — we deliberately do
        // NOT do a bare PATH lookup, so a PATH-hijacked binary of the same
        // name can't win (same philosophy on both platforms).
        #[cfg(not(target_os = "windows"))]
        let candidates: Vec<(&'static str, String, Vec<String>)> = vec![
            (
                "xdg-open",
                "/usr/bin/xdg-open".to_string(),
                vec![opener_url.clone()],
            ),
            (
                "xdg-open",
                "/bin/xdg-open".to_string(),
                vec![opener_url.clone()],
            ),
            (
                "xdg-open",
                "/usr/local/bin/xdg-open".to_string(),
                vec![opener_url.clone()],
            ),
            (
                "gio",
                "/usr/bin/gio".to_string(),
                vec!["open".to_string(), opener_url.clone()],
            ),
            (
                "gio",
                "/bin/gio".to_string(),
                vec!["open".to_string(), opener_url.clone()],
            ),
            (
                "sensible-browser",
                "/usr/bin/sensible-browser".to_string(),
                vec![opener_url.clone()],
            ),
            (
                "x-www-browser",
                "/usr/bin/x-www-browser".to_string(),
                vec![opener_url.clone()],
            ),
        ];

        // Windows: cmd.exe /C start "" <url> first (most universal —
        // resolves the URL through the registered https handler), then
        // rundll32 url.dll,FileProtocolHandler as the fallback. Both
        // resolved under %SystemRoot%\System32 to stay off PATH.
        #[cfg(target_os = "windows")]
        let candidates: Vec<(&'static str, String, Vec<String>)> = {
            let mut list: Vec<(&'static str, String, Vec<String>)> = Vec::new();
            if let Some(root) = system_root() {
                list.push((
                    "cmd.exe",
                    system32_binary(&root, "cmd.exe"),
                    cmd_start_args(&opener_url),
                ));
                list.push((
                    "rundll32",
                    system32_binary(&root, "rundll32.exe"),
                    rundll_url_args(&opener_url),
                ));
            }
            list
        };

        let mut results = Vec::new();
        for (name, path, args) in candidates {
            let result = run_candidate(name, &path, &args, child_path);
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

// NOTE: this module is #[cfg(target_os = "windows")], so it only compiles
// (and only runs) on a Windows runner. The functions under test
// (system32_binary, cmd_start_args, rundll_url_args) are themselves
// Windows-gated, so the tests cannot run on this Linux dev host — they are
// exercised by the windows-latest CI job in release.yml / ci.yml.
#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::{cmd_start_args, rundll_url_args, system32_binary};

    #[test]
    fn system32_binary_joins_root_and_name() {
        assert_eq!(
            system32_binary("C:\\Windows", "cmd.exe"),
            "C:\\Windows\\System32\\cmd.exe"
        );
        // A relocated Windows install (SystemRoot != C:\Windows) is still
        // resolved correctly because we build from the env var, not a
        // hardcoded drive letter.
        assert_eq!(
            system32_binary("D:\\Win", "rundll32.exe"),
            "D:\\Win\\System32\\rundll32.exe"
        );
    }

    #[test]
    fn cmd_start_args_include_mandatory_empty_title() {
        let url = "https://twitch.tv/some_channel";
        let args = cmd_start_args(url);
        // `start` parses its first quoted positional argument as the window
        // TITLE, not the target. The empty string at index 2 is mandatory;
        // without it the URL would be misparsed as the title.
        assert_eq!(args, vec!["/C", "start", "", url]);
        assert_eq!(args[2], "", "the empty title argument must be present");
        // And the URL must still be the final target, not swallowed as title.
        assert_eq!(args[3], url);
    }

    #[test]
    fn rundll_args_use_file_protocol_handler() {
        let url = "https://twitch.tv/some_channel";
        let args = rundll_url_args(url);
        assert_eq!(args, vec!["url.dll,FileProtocolHandler", url]);
    }
}
