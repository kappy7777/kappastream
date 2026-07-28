// Authoritative compile-time target-OS metadata for the frontend.
//
// `target_os()` returns the OS this binary was compiled for — the value of
// `std::env::consts::OS`, evaluated at compile time. That is the authoritative
// signal for which WebView engine the app runs under (Windows → WebView2 /
// Chromium; Linux → WebKitGTK), which in turn decides whether the live CDN must
// be fetched through the ksvod proxy: Chromium enforces CORS on the real
// `http://tauri.localhost` origin, so Twitch's live manifest would fail with a
// `manifestLoadError` if fetched directly (see App.svelte `isWindows`).
//
// The frontend previously inferred the platform from `navigator.userAgent`, but
// WebView2's UA is Chromium's and is not contractually stable — and this
// codebase already overrides the UA for GQL — so a substring match was the
// wrong tool for a load-bearing switch whose failure is silent and total.
// Exposing the compile target as a command makes the signal authoritative and
// removes the inference entirely. (Custom command, not a plugin, matching the
// repo's opener/gql/player/resolve pattern; no capability entry needed.)

/// The compile-time target OS (`std::env::consts::OS`): e.g. `"linux"`,
/// `"windows"`, `"macos"`. No allocation — returns a `&'static str`.
#[tauri::command]
pub fn target_os() -> &'static str {
    std::env::consts::OS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_os_matches_compile_target() {
        // The command MUST report the compile-time target — that's what makes
        // it authoritative for the frontend's WebView-engine detection. If this
        // ever drifts from std::env::consts::OS the whole point of the command
        // (no UA inference) is lost.
        assert_eq!(target_os(), std::env::consts::OS);
        // kappastream ships desktop builds only; the value must be one of these.
        assert!(matches!(
            std::env::consts::OS,
            "linux" | "windows" | "macos"
        ));
    }
}
