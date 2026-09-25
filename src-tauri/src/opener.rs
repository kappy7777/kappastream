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
    /// - Windows: `rundll32.exe` normally exits within milliseconds of
    ///   handing the URL to the shell handler; reaching the grace period
    ///   means a hang, but detaching is still safer than killing a
    ///   possibly-launching browser.
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
    // Character-level backstop for the spawn path: whatever process we
    // hand this URL to must never receive a backslash, a double quote,
    // whitespace or a control character. Url::parse percent-encodes most
    // of these, but anything that survives parsing is rejected here
    // rather than trusted to the next parser down the chain. `&`, `=`,
    // `?` and `%XX` are legitimate in Twitch URLs and stay accepted.
    let serialized = parsed.to_string();
    if serialized
        .chars()
        .any(|c| c == '\\' || c == '"' || c.is_whitespace() || c.is_control())
    {
        return None;
    }
    Some(serialized)
}

// --- Windows candidate helpers ------------------------------------------------
// The Linux opener list below uses hardcoded absolute paths because every
// Linux distro ships the openers under well-known locations. Windows has no
// such fixed layout guarantee (SystemRoot is technically not bound to the
// C: drive), so we resolve rundll32.exe through %SystemRoot%
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
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn system32_binary(system_root: &str, binary: &str) -> String {
    format!("{}\\System32\\{}", system_root, binary)
}

/// `rundll32.exe url.dll,FileProtocolHandler <url>` — hands the URL to
/// ShellExecute as one argument; nothing re-parses the command line with
/// shell metacharacters.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn rundll_url_args(url: &str) -> Vec<String> {
    vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]
}

/// Windows opener candidates for a resolved SystemRoot, in try order: only
/// `rundll32.exe url.dll,FileProtocolHandler`, which hands the URL to
/// ShellExecute without any shell re-parsing of the argument vector.
///
/// (An earlier first candidate, `cmd.exe /C start "" <url>`, was removed:
/// cmd.exe re-parses the whole command line with its own metacharacters,
/// and Rust's argument quoting escapes only whitespace, so an `&` inside a
/// query string made cmd execute everything after it — one-click command
/// execution from a chat link. `validated_url` keeps a character-level
/// backstop for the remaining spawn paths.)
///
/// Kept pure (root and url passed explicitly, no env access) so it compiles
/// and is unit-tested on every host; the SystemRoot/windir lookup lives in
/// `system_root()` above.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_candidates(system_root: &str, url: &str) -> Vec<(&'static str, String, Vec<String>)> {
    vec![(
        "rundll32",
        system32_binary(system_root, "rundll32.exe"),
        rundll_url_args(url),
    )]
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
    // spawning rundll32.exe on Windows. No-op on Unix (no
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
            // - Windows: `rundll32.exe` normally exits within milliseconds
            //   of handing the URL to the shell handler; reaching here
            //   means it hung. This is NOT the expected path on Windows
            //   (unlike the KDE case), but detaching is still the right
            //   call rather than killing something that may be mid-launch.
            // Either way: hand the handle to a detached reaper thread and
            // report success. Barely dropping it would leave a ZOMBIE for
            // every long-lived child (the browser xdg-open exec'd stays
            // mapped in the process table until something waits on it); the
            // reaper thread waits it out while the child keeps running
            // independently either way.
            Ok(None) => {
                thread::spawn(move || {
                    let _ = child.wait();
                });
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
        // AppImage (whose runtime strips PATH). configure() is a no-op when
        // APPIMAGE is unset — i.e. always on macOS and Windows — so this value
        // is only ever consulted on Linux (AppImage). It just satisfies the
        // parameter elsewhere.
        #[cfg(target_os = "linux")]
        let child_path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        #[cfg(not(target_os = "linux"))]
        let child_path = "";

        // Each candidate is (name, absolute_path, args). The absolute path
        // is checked via is_file() in run_candidate — we deliberately do
        // NOT do a bare PATH lookup, so a PATH-hijacked binary of the same
        // name can't win (same philosophy on every platform).
        //
        // Linux: xdg-open → gio → distro browser launchers. macOS: the single
        // `open` system binary (/usr/bin/open, always present) hands the URL
        // to the registered https handler. The previous `#[cfg(not(windows))]`
        // arm mapped macOS onto the Linux list (xdg-open etc. don't exist on
        // macOS), so browser-opening silently failed there.
        #[cfg(target_os = "linux")]
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

        // macOS: `/usr/bin/open <url>` opens in the default browser. It is a
        // core system binary (always present, not PATH-installed), so a single
        // absolute candidate is sufficient and has no PATH-hijack surface.
        #[cfg(target_os = "macos")]
        let candidates: Vec<(&'static str, String, Vec<String>)> = vec![(
            "open",
            "/usr/bin/open".to_string(),
            vec![opener_url.clone()],
        )];

        // Windows: rundll32.exe url.dll,FileProtocolHandler — the single
        // candidate (see windows_candidates for why nothing shells out).
        // Resolved under %SystemRoot%\System32 to stay off PATH.
        #[cfg(target_os = "windows")]
        let candidates: Vec<(&'static str, String, Vec<String>)> = match system_root() {
            Some(root) => windows_candidates(&root, &opener_url),
            None => Vec::new(),
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
    use super::{rundll_url_args, system32_binary, validated_url, windows_candidates};

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

    #[test]
    fn accepts_query_strings_and_clip_slugs() {
        assert_eq!(
            validated_url("https://www.twitch.tv/videos/123?t=1h2m3s&foo=bar"),
            Some("https://www.twitch.tv/videos/123?t=1h2m3s&foo=bar".to_string())
        );
        assert_eq!(
            validated_url("https://clips.twitch.tv/Some-Slug_1"),
            Some("https://clips.twitch.tv/Some-Slug_1".to_string())
        );
    }

    #[test]
    fn rejects_backslash_in_query() {
        assert_eq!(validated_url("https://www.twitch.tv/x?a=\\calc"), None);
    }

    #[test]
    fn windows_candidates_never_spawn_cmd_exe() {
        let candidates = windows_candidates("C:\\Windows", "https://twitch.tv/somechannel");
        assert!(!candidates.is_empty());
        for (_, path, _) in &candidates {
            assert!(
                !path.to_ascii_lowercase().ends_with("cmd.exe"),
                "cmd.exe candidate survived: {path}"
            );
        }
    }

    #[test]
    fn ampersand_url_is_a_single_byte_identical_argv_element() {
        // The injection payload: cmd metacharacters must stay inert data.
        let url = "https://www.twitch.tv/x?a=1&calc.exe";
        let validated = validated_url(url).expect("query ampersand is legitimate");
        assert_eq!(validated, url);
        for (_, _, args) in windows_candidates("C:\\Windows", &validated) {
            assert_eq!(
                args.len(),
                2,
                "rundll32 takes the handler spec and the url, nothing else"
            );
            assert_eq!(args[1], url, "url must be one byte-identical argv element");
        }
    }

    #[test]
    fn system32_binary_joins_root_and_name() {
        assert_eq!(
            system32_binary("C:\\Windows", "rundll32.exe"),
            "C:\\Windows\\System32\\rundll32.exe"
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
    fn rundll_args_use_file_protocol_handler() {
        let url = "https://twitch.tv/some_channel";
        assert_eq!(
            rundll_url_args(url),
            vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]
        );
    }
}
