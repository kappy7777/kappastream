//! Linux graphics-compatibility setup.
//!
//! Invoked from the very top of `main()` (see `main.rs`), before `tauri::Builder`
//! and therefore before GTK, WebKitGTK, EGL or any Tauri webview initializes.
//!
//! There are two independent NVIDIA-specific workarounds, each applied only on
//! the matching session type and only when the user has not already supplied a
//! value; one AppImage-only backend selection (`GDK_BACKEND`, see the
//! dedicated section below) that is deliberately GPU-independent; and one
//! AppImage-only pipewire-client swap performed by a one-shot re-exec (also
//! with its own section below). AMD, Intel
//! and unknown sessions are never touched by the NVIDIA rules, and the two
//! workarounds are never both selected during a single session.
//!
//! ## Wayland — `__NV_DISABLE_EXPLICIT_SYNC=1`
//!
//! NVIDIA EGL-Wayland explicit sync can terminate GTK/WebKitGTK applications
//! when a surface is committed without an acquire point — the compositor raises
//! `wp_linux_drm_syncobj_surface_v1` error 4 ("explicit sync is used, but no
//! acquire point is set"), which surfaces as `Gdk-Message: Error 71 (Protocol
//! error) dispatching to Wayland display` and aborts the process. Setting
//! `__NV_DISABLE_EXPLICIT_SYNC=1` makes EGL-Wayland fall back to implicit sync,
//! avoiding the crash while keeping WebKitGTK's accelerated compositing path
//! enabled (the previous broad workaround, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
//! globally disabled compositing and crippled maximized-window performance).
//!
//! ## X11 — `WEBKIT_DISABLE_DMABUF_RENDERER=1`
//!
//! On X11 with the NVIDIA kernel driver loaded, WebKitGTK's DMA-BUF renderer can
//! fail to allocate a GBM buffer and print `Failed to create GBM buffer of size
//! 800x600: Invalid argument`, leaving the webview blank/invisible while the
//! process keeps running. Setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` makes
//! WebKitGTK skip the GBM/DMA-BUF renderer path while leaving its compositing
//! mode enabled — the UI becomes visible and acceleration is otherwise retained.
//! It does not disable compositing globally and does not imply every NVIDIA or
//! every WebKitGTK version is affected.
//!
//! ## AppImage — `GDK_BACKEND=wayland,x11`
//!
//! Tauri's AppImage bundler fetches `linuxdeploy-plugin-gtk.sh` from an
//! unpinned `master` branch at build time, and the AppRun hook that script
//! generates unconditionally runs `export GDK_BACKEND=x11` before `main()` —
//! stomping any value the user had set. That export is a 2024 workaround for
//! a WebKitGTK 2.38 GSettings-schema crash (tauri-apps/tauri#8541) and no
//! longer applies to this bundle: it ships WebKitGTK 2.52.5, verified on
//! hardware (KDE Plasma Wayland + NVIDIA) to render, play streams and
//! register as a native Wayland client with none of the #8541 symptoms.
//! Forcing XWayland also silently defeated the Wayland workaround above —
//! `__NV_DISABLE_EXPLICIT_SYNC` only acts on a Wayland EGL surface, so an
//! AppImage rendered through XWayland never received it.
//!
//! Undoing the hook here is the ONE deliberate exception to the
//! never-overwrite rule below: inside an AppImage the hook ALWAYS sets
//! `GDK_BACKEND`, so a hook-supplied `x11` is indistinguishable from a
//! user-supplied one and "only set when absent" is impossible. The exception
//! gets its own escape hatch the hook cannot stomp, the user-override
//! variable `KAPPASTREAM_GDK_BACKEND`:
//!  - non-empty ⇒ written to `GDK_BACKEND` verbatim, regardless of session
//!    (the user is in charge; `x11` restores the old XWayland behaviour);
//!  - present but empty ⇒ "don't touch" — the hook's `x11` stands;
//!  - absent ⇒ an AppImage on a Wayland session sets
//!    `GDK_BACKEND=wayland,x11` (GDK tries backends in order; the `x11` tail
//!    keeps an XWayland path available if the compositor refuses a Wayland
//!    connection), while X11/Other/Unknown sessions keep the hook's `x11`,
//!    which is already the correct backend there.
//!
//! Native builds (AUR/deb/rpm — anything without the AppRun hook) never have
//! a hook-supplied `GDK_BACKEND` in the environment and are untouched by
//! construction.
//!
//! ## AppImage — system `libpipewire` via one-shot re-exec
//!
//! The bundled `libmpv.so.2` (a Debian build) declares `libpipewire-0.3.so.0`
//! as a direct dependency, so linuxdeploy copies the build host's pipewire
//! client into the AppImage — dropping it would fail the loader on systems
//! without PipeWire, and bundling it is what keeps the image self-contained.
//! But PipeWire expects the client library and the `spa-0.2` support modules
//! it loads to match the local server: a client from the build host, running
//! against the host system's server and modules, periodically stalls the
//! audio clock. mpv paces video to that clock (`video-sync=audio`), so in the
//! mpv engine this dropped 4-6 frames per second of 60 (measured with the
//! render-cadence harness: 55-56 renders/s and 16-23 missed frame-clock ticks
//! per 5 s window under the bundled client, a flat 60.0 renders/s with zero
//! missed ticks under the system one, with every other library identical).
//!
//! The swap must happen before `DT_NEEDED` resolution, which is before
//! `main()` — no in-process fix exists. So on an AppImage launch, when a
//! pipewire client is mapped into the process, the system provides one under
//! the same basename, and the mapped copy is not that system one,
//! `configure()` re-execs the binary once with `LD_PRELOAD=<system path>`: a
//! preloaded object's SONAME satisfies `libmpv`'s dependency before the
//! AppImage's `LD_LIBRARY_PATH` is searched, so the bundled copy never loads.
//! If the system has no pipewire, nothing happens and the bundled client
//! serves — the app keeps working everywhere, just with the old pacing on
//! PipeWire-less systems. Children spawned through `env_spawn` never inherit
//! the preload: its AppImage whitelist clears `LD_PRELOAD` from every
//! subprocess (streamlink resolve, the mpv handoff, URL openers). The
//! processes that DO inherit it are WebKitGTK's own helper processes and an
//! updater relaunch — forking/exec'ing from this image, they keep the system
//! client (intended) and inherit the exec guard too, so neither re-execs.
//!
//! The user override is `KAPPASTREAM_PIPEWIRE_PRELOAD`:
//!  - absent ⇒ automatic swap (the default above);
//!  - `0`/`off`/`no`/`false` (any case) or empty ⇒ keep the bundled client;
//!  - any other value ⇒ an explicit library path, preloaded verbatim.
//!
//! `KAPPASTREAM_PIPEWIRE_EXEC_GUARD` is internal, not a user channel: set on
//! the re-exec and checked before the action is applied again, so a preload
//! that somehow fails to take effect can never loop the process through
//! repeated execs. The guard is the actual backstop for the auto path too:
//! after a successful swap the mapped client IS the system one, but the
//! maps/ldconfig path SPELLINGS can still differ (resolved versioned name
//! vs SONAME, symlinked lib dir), so the same-file (dev+ino) check and this
//! guard — not string equality — are what keep it from re-exec'ing.
//!
//! ## Common rules
//!
//! The variables are applied only when ALL hold for their respective path:
//!  - the NVIDIA kernel driver appears loaded, AND
//!  - the session matches (Wayland for explicit sync, X11 for DMA-BUF renderer), AND
//!  - the user has not already set the variable.
//!
//! A user-provided value (including `"0"`, `"1"`, an arbitrary string, or even
//! an empty string) is always preserved — we only ever set a variable when it is
//! entirely absent. The exception is the AppImage `GDK_BACKEND` selection
//! above, which overwrites the hook's value by necessity and uses
//! `KAPPASTREAM_GDK_BACKEND` as its user-override channel instead.

use std::path::Path;

const NV_EXPLICIT_SYNC_VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const WEBKIT_DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const GDK_BACKEND_VAR: &str = "GDK_BACKEND";
const KAPPASTREAM_GDK_BACKEND_VAR: &str = "KAPPASTREAM_GDK_BACKEND";
const KAPPASTREAM_PIPEWIRE_PRELOAD_VAR: &str = "KAPPASTREAM_PIPEWIRE_PRELOAD";
/// Internal once-guard for the pipewire re-exec, NOT a user channel. Set on
/// the exec'd image; `configure()` refuses to apply the pipewire action again
/// while it is present. See the module doc's "system libpipewire" section.
const KAPPASTREAM_PIPEWIRE_EXEC_GUARD_VAR: &str = "KAPPASTREAM_PIPEWIRE_EXEC_GUARD";
/// Backend list set for AppImage runs on Wayland sessions. GDK tries the
/// backends in order; the `x11` tail keeps an XWayland path available if the
/// compositor refuses a Wayland connection. See the module doc's
/// "AppImage — GDK_BACKEND" section.
const APPIMAGE_WAYLAND_GDK_BACKENDS: &str = "wayland,x11";

/// Whether an NVIDIA kernel driver appears to be loaded, via two
/// dependency-free kernel signals. `/sys/module/nvidia` is a directory created
/// by the kernel when the `nvidia` module is loaded; `/proc/driver/nvidia/version`
/// is the procfs file the NVIDIA driver registers. Either present counts as
/// "NVIDIA loaded"; both are absent on AMD/Intel-only and NVIDIA-free systems.
///
/// Takes its paths as arguments so the probes can be exercised by unit tests
/// against stable filesystem objects (e.g. `/proc/self/status`, `/sys/module`)
/// without NVIDIA hardware or root.
fn nvidia_driver_present(proc_version: &Path, sys_module: &Path) -> bool {
    sys_module.is_dir() || proc_version.is_file()
}

/// Coerce an `Option<String>` env capture to `Some(non-empty)` / `None`, treating
/// a present-but-empty value as absent. Used for the *session-signal* variables
/// (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `DISPLAY`) where an empty string
/// carries no signal. The user-override variables are intentionally NOT routed
/// through this — an empty value there still counts as "user supplied".
fn non_empty(opt: &Option<String>) -> Option<&str> {
    opt.as_deref().filter(|s| !s.is_empty())
}

/// The display session class, derived only from environment signals (never from
/// compositor process names, desktop variables, or resolution).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Session {
    Wayland,
    X11,
    /// A session type we explicitly do not target (e.g. `XDG_SESSION_TYPE=tty`).
    Other,
    /// No usable session signal at all.
    Unknown,
}

/// Classify the session. `XDG_SESSION_TYPE` is the primary signal; when it is
/// absent or empty we fall back to `WAYLAND_DISPLAY` (Wayland) then `DISPLAY`
/// (X11). A Wayland session is never classified as X11 merely because `DISPLAY`
/// is also present (XWayland sets it).
fn classify_session(inputs: &CompatInputs) -> Session {
    match non_empty(&inputs.xdg_session_type) {
        Some("wayland") => Session::Wayland,
        Some("x11") => Session::X11,
        Some(_) => Session::Other,
        None => {
            if non_empty(&inputs.wayland_display).is_some() {
                Session::Wayland
            } else if non_empty(&inputs.display).is_some() {
                Session::X11
            } else {
                Session::Unknown
            }
        }
    }
}

/// Inputs to the workaround decision, abstracted away from the live process
/// environment + filesystem so the decision is unit-testable without NVIDIA
/// hardware, an X server, or a Wayland compositor.
#[derive(Clone, Debug)]
struct CompatInputs {
    /// `XDG_SESSION_TYPE` env value (primary session signal).
    xdg_session_type: Option<String>,
    /// `WAYLAND_DISPLAY` env value. Non-empty ⇒ Wayland session signal.
    wayland_display: Option<String>,
    /// `DISPLAY` env value. Non-empty with no Wayland signal ⇒ X11 fallback.
    display: Option<String>,
    /// `__NV_DISABLE_EXPLICIT_SYNC` env value, if the user supplied one.
    nv_disable_explicit_sync: Option<String>,
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` env value, if the user supplied one.
    webkit_disable_dmabuf_renderer: Option<String>,
    /// NVIDIA kernel module / procfs signal.
    nvidia_loaded: bool,
    /// Whether the process runs from a packed AppImage (the Type-2 runtime
    /// sets `APPIMAGE`). Canonical test: `env_spawn::in_appimage()`, called
    /// from `read_inputs()` so the two consumers can never disagree.
    appimage: bool,
    /// `KAPPASTREAM_GDK_BACKEND` env value, if the user supplied one — the
    /// override channel for the AppImage `GDK_BACKEND` selection. Captured
    /// raw like the other user overrides: an empty value still counts as
    /// "user supplied" (and means "don't touch").
    kappastream_gdk_backend: Option<String>,
    /// Path of the pipewire client currently mapped into the process
    /// (parsed from `/proc/self/maps`). Probed only on AppImage runs —
    /// native builds never load a bundled client to swap.
    pipewire_loaded: Option<String>,
    /// The system's pipewire client for the same basename (`ldconfig` /
    /// standard library dirs), if the system has one at all.
    pipewire_system: Option<String>,
    /// `KAPPASTREAM_PIPEWIRE_PRELOAD` env value, if the user supplied one —
    /// the override channel for the pipewire swap. Captured raw: empty
    /// counts as "user supplied" (and means "keep the bundled client").
    kappastream_pipewire_preload: Option<String>,
    /// Whether `pipewire_loaded` and `pipewire_system` resolve to the SAME
    /// file (same dev+ino through symlinks — `/proc/self/maps` reports the
    /// resolved versioned path while ldconfig/the directory fallback report
    /// SONAME and symlinked spellings, so string equality lies on Arch-style
    /// layouts). `None` = no system copy / metadata unavailable; anything
    /// but `Some(true)` falls back to the string comparison.
    pipewire_same_file: Option<bool>,
}

/// The concrete compatibility actions to apply for a given `CompatInputs`.
/// At most one NVIDIA workaround is selected for any normal session (Wayland
/// selects the explicit-sync path, X11 selects the DMA-BUF-renderer path).
/// `gdk_backend` is independent of both — AppImage-only and GPU-independent —
/// and is the one action allowed to overwrite an existing env value.
#[derive(Debug, Default, PartialEq, Eq)]
struct CompatActions {
    disable_nvidia_explicit_sync: bool,
    disable_webkit_dmabuf_renderer: bool,
    /// `GDK_BACKEND` value to set, or `None` to leave the environment alone.
    gdk_backend: Option<String>,
    /// System pipewire client to `LD_PRELOAD` via a one-shot re-exec, or
    /// `None` to keep the bundled one. See the module doc's
    /// "AppImage — system libpipewire" section.
    pipewire_preload: Option<String>,
}

/// Select the compatibility actions for the given inputs.
///
/// - No NVIDIA driver ⇒ nothing (AMD/Intel/unknown GPUs are untouched).
/// - Wayland + NVIDIA + `__NV_DISABLE_EXPLICIT_SYNC` unset ⇒ explicit-sync path.
/// - X11 + NVIDIA + `WEBKIT_DISABLE_DMABUF_RENDERER` unset ⇒ DMA-BUF-renderer path.
/// - `Other`/`Unknown` sessions ⇒ nothing.
/// - Any user-supplied value (incl. `"0"`, `"1"`, arbitrary, or empty) ⇒ preserved
///   (the matching action is suppressed).
/// - `gdk_backend` is selected independently of all of the above (no NVIDIA
///   requirement) — see `select_gdk_backend` and the module doc.
fn select_actions(inputs: &CompatInputs) -> CompatActions {
    let mut actions = CompatActions {
        gdk_backend: select_gdk_backend(inputs),
        pipewire_preload: select_pipewire_preload(inputs),
        ..CompatActions::default()
    };
    if !inputs.nvidia_loaded {
        return actions;
    }
    match classify_session(inputs) {
        Session::Wayland => {
            if inputs.nv_disable_explicit_sync.is_none() {
                actions.disable_nvidia_explicit_sync = true;
            }
        }
        Session::X11 => {
            if inputs.webkit_disable_dmabuf_renderer.is_none() {
                actions.disable_webkit_dmabuf_renderer = true;
            }
        }
        Session::Other | Session::Unknown => {}
    }
    actions
}

/// Select the `GDK_BACKEND` value for an AppImage run, or `None` to leave the
/// environment alone. Independent of the NVIDIA rules — a Wayland session is
/// the right backend on every GPU. See the module doc's
/// "AppImage — GDK_BACKEND" section for the rationale and the escape hatch.
fn select_gdk_backend(inputs: &CompatInputs) -> Option<String> {
    if !inputs.appimage {
        return None;
    }
    if let Some(override_value) = &inputs.kappastream_gdk_backend {
        if override_value.is_empty() {
            // Present but empty = explicit "don't touch": the hook's x11 stands.
            return None;
        }
        return Some(override_value.clone());
    }
    match classify_session(inputs) {
        Session::Wayland => Some(APPIMAGE_WAYLAND_GDK_BACKENDS.to_string()),
        Session::X11 | Session::Other | Session::Unknown => None,
    }
}

/// Select the system pipewire client to preload over the bundled one, or
/// `None` to leave the process as-is. AppImage-only, like the backend
/// selection. See the module doc's "AppImage — system libpipewire" section
/// for the rationale and the override channel.
fn select_pipewire_preload(inputs: &CompatInputs) -> Option<String> {
    if !inputs.appimage {
        return None;
    }
    match inputs.kappastream_pipewire_preload.as_deref() {
        // Auto: swap only when a pipewire client is actually mapped in AND
        // the system's copy is a DIFFERENT FILE. Equality is decided by
        // dev+ino when both paths stat (same_file injected by read_inputs)
        // with the string comparison as the fallback: after a re-exec the
        // maps path is the resolved versioned file while the system probe
        // reports SONAME/symlink spellings, and string-only comparison
        // re-selected a swap that only the exec guard stopped.
        None => {
            let loaded = inputs.pipewire_loaded.as_deref()?;
            let system = inputs.pipewire_system.as_deref()?;
            if loaded == system || inputs.pipewire_same_file == Some(true) {
                return None;
            }
            Some(system.to_string())
        }
        // Present but empty = explicit "leave it alone" (bundled client).
        Some("") => None,
        // Explicit opt-out words, any case.
        Some(v)
            if matches!(
                v.to_ascii_lowercase().as_str(),
                "0" | "off" | "no" | "false"
            ) =>
        {
            None
        }
        // Anything else is a user-supplied library path, preloaded verbatim.
        Some(path) => Some(path.to_string()),
    }
}

/// First `libpipewire-*.so.*` mapping in a `/proc/self/maps` dump, as a pure
/// parser over the file text so the extraction is unit-testable. Maps lines
/// are `addr perms offset dev inode path`; anonymous mappings have no sixth
/// field, which `nth(5)` turns into the `None` that skips the line.
fn pipewire_path_in_maps(maps: &str) -> Option<&str> {
    maps.lines().find_map(|line| {
        let path = line.split_whitespace().nth(5)?;
        let name = Path::new(path).file_name()?.to_str()?;
        (name.starts_with("libpipewire-") && name.contains(".so")).then_some(path)
    })
}

/// Extract the library path for `basename` from `ldconfig -p` output (lines
/// look like `libpipewire-0.3.so.0 (libc6,x86-64) => /usr/lib/…`). Pure for
/// the same reason as the maps parser; matching on the FIRST field keeps a
/// longer library name that merely contains the basename from matching.
fn ldconfig_path_for(cache: &str, basename: &str) -> Option<String> {
    cache.lines().find_map(|line| {
        if line.split_whitespace().next() != Some(basename) {
            return None;
        }
        line.rsplit(" => ")
            .next()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
    })
}

/// The system's pipewire client for the same basename the process already
/// loaded, if the system has one at all. `ldconfig -p` is authoritative (it
/// also knows nonstandard prefixes such as NixOS store paths) but the binary
/// lives in `/sbin` or `/usr/sbin` on merged-/usr systems, which the AppRun
/// PATH may not include — so probe absolute locations, then a plain PATH
/// lookup. The FIRST ldconfig that RUNS SUCCESSFULLY is the answer, found or
/// not: it printed the whole cache, so a miss means the system genuinely has
/// no such SONAME, and re-asking sibling binaries after a success only
/// burns execs before the directory fallback below guesses anyway.
fn system_pipewire_path(basename: &str) -> Option<String> {
    for bin in ["/sbin/ldconfig", "/usr/sbin/ldconfig", "ldconfig"] {
        if let Ok(out) = std::process::Command::new(bin).arg("-p").output() {
            if out.status.success() {
                let cache = String::from_utf8_lossy(&out.stdout);
                return ldconfig_path_for(&cache, basename);
            }
        }
    }
    for dir in [
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/usr/lib",
        "/lib/x86_64-linux-gnu",
        "/lib64",
        "/lib",
    ] {
        let candidate = format!("{dir}/{basename}");
        if Path::new(&candidate).is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Whether two library paths resolve to the same file: `metadata` follows
/// symlinks, and (dev, ino) equality survives every spelling difference
/// (versioned vs SONAME name, /usr/lib64 → /usr/lib symlink). False when
/// either path cannot be stat'ed — the caller treats that as "not proven
/// same" and falls back to its other evidence.
fn paths_refer_to_same_file(a: &str, b: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) => ma.dev() == mb.dev() && ma.ino() == mb.ino(),
        _ => false,
    }
}

/// The pipewire probes for `read_inputs`: the client currently mapped into
/// this process, and the system's copy of the same basename. Only AppImage
/// runs bother probing — native builds never load a bundled client to swap.
/// The exec'd image skips the probe entirely: the guard variable is the
/// authority on "the swap already happened", and probing again can only
/// re-derive a stale swap decision (and costs the ldconfig execs) — never a
/// useful one.
fn probe_pipewire() -> (Option<String>, Option<String>) {
    if !crate::env_spawn::in_appimage()
        || std::env::var(KAPPASTREAM_PIPEWIRE_EXEC_GUARD_VAR).is_ok()
    {
        return (None, None);
    }
    let Some(loaded) = std::fs::read_to_string("/proc/self/maps")
        .ok()
        .as_deref()
        .and_then(pipewire_path_in_maps)
        .map(str::to_string)
    else {
        return (None, None);
    };
    let basename = Path::new(&loaded)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    (Some(loaded), system_pipewire_path(&basename))
}

/// Replace the process with itself, preloading `system_pipewire` so its
/// SONAME satisfies `libmpv`'s dependency ahead of the AppImage's
/// `LD_LIBRARY_PATH`. Called from the top of `configure()`, before any env
/// var is applied — a successful exec never reaches those, and the fresh
/// image's own `configure()` pass performs them with the exec guard set. If
/// `exec` returns (failure), the process continues unchanged with the
/// bundled client.
fn reexec_with_pipewire_preload(system_pipewire: &str) {
    use std::os::unix::process::CommandExt;
    let Ok(exe) = std::env::current_exe() else {
        eprintln!("[compat] pipewire swap: cannot resolve current exe; keeping the bundled client");
        return;
    };
    // Prepend ours so it wins the SONAME even if the user preloaded something.
    let mut preload = system_pipewire.to_string();
    if let Ok(existing) = std::env::var("LD_PRELOAD") {
        if !existing.is_empty() {
            preload = format!("{system_pipewire}:{existing}");
        }
    }
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env("LD_PRELOAD", &preload)
        .env(KAPPASTREAM_PIPEWIRE_EXEC_GUARD_VAR, "1")
        .exec();
    eprintln!("[compat] pipewire swap re-exec failed ({err}); continuing with the bundled client");
}

/// Gather the real process environment + kernel state into `CompatInputs`.
fn read_inputs() -> CompatInputs {
    let (pipewire_loaded, pipewire_system) = probe_pipewire();
    let pipewire_same_file = match (&pipewire_loaded, &pipewire_system) {
        (Some(loaded), Some(system)) => Some(paths_refer_to_same_file(loaded, system)),
        _ => None,
    };
    CompatInputs {
        xdg_session_type: std::env::var("XDG_SESSION_TYPE").ok(),
        wayland_display: std::env::var("WAYLAND_DISPLAY").ok(),
        display: std::env::var("DISPLAY").ok(),
        nv_disable_explicit_sync: std::env::var(NV_EXPLICIT_SYNC_VAR).ok(),
        webkit_disable_dmabuf_renderer: std::env::var(WEBKIT_DMABUF_VAR).ok(),
        nvidia_loaded: nvidia_driver_present(
            Path::new("/proc/driver/nvidia/version"),
            Path::new("/sys/module/nvidia"),
        ),
        appimage: crate::env_spawn::in_appimage(),
        kappastream_gdk_backend: std::env::var(KAPPASTREAM_GDK_BACKEND_VAR).ok(),
        pipewire_loaded,
        pipewire_system,
        pipewire_same_file,
        kappastream_pipewire_preload: std::env::var(KAPPASTREAM_PIPEWIRE_PRELOAD_VAR).ok(),
    }
}

/// Apply the Linux graphics-compatibility workarounds.
///
/// MUST be called at the very start of `main()`, before Tauri/GTK/WebKitGTK/EGL
/// initialize, so `__NV_DISABLE_EXPLICIT_SYNC` is visible to EGL-Wayland when it
/// first creates a surface, `WEBKIT_DISABLE_DMABUF_RENDERER` is visible to
/// WebKitGTK before it picks its renderer, and the AppImage `GDK_BACKEND`
/// selection is in place before GTK reads that variable at display-open time.
/// Calling it from `main()` is early enough because all EGL/Wayland surface
/// creation, WebKitGTK renderer selection and GDK display-open happen later,
/// during Tauri window/webview setup (inside `tauri::Builder::run`, reached
/// from `app_lib::run()` in `lib.rs`) — nothing touches EGL, the renderer or
/// the display before `main()` runs. The pipewire re-exec is the FIRST action:
/// it must land before `DT_NEEDED` resolution (i.e. before `main()`, hence the
/// exec) and before any env var below is applied — a successful exec replaces
/// the image and the fresh `configure()` pass applies those itself.
///
/// `std::env::set_var` is safe here because this runs on the single main thread
/// at process startup, before any other thread or library reads the
/// environment. User-provided values are never overwritten — with one
/// documented exception: the AppImage `GDK_BACKEND` selection may replace the
/// linuxdeploy hook's pre-set `x11` (see the module doc).
pub fn configure() {
    let inputs = read_inputs();
    let actions = select_actions(&inputs);
    if std::env::var(KAPPASTREAM_PIPEWIRE_EXEC_GUARD_VAR).is_err() {
        // Once-guard: the exec'd image re-runs configure() with the guard
        // set, and a preload that failed to take effect must not retry
        // forever. Everything else proceeds normally either way.
        if let Some(system_pipewire) = &actions.pipewire_preload {
            reexec_with_pipewire_preload(system_pipewire);
        }
    }
    if actions.disable_nvidia_explicit_sync {
        std::env::set_var(NV_EXPLICIT_SYNC_VAR, "1");
    }
    if actions.disable_webkit_dmabuf_renderer {
        std::env::set_var(WEBKIT_DMABUF_VAR, "1");
    }
    if let Some(backend) = actions.gdk_backend {
        // The one call in this function that may OVERWRITE an existing value:
        // inside an AppImage the linuxdeploy gtk hook already exported
        // GDK_BACKEND=x11 before main() (see the module doc), so "only set
        // when absent" is impossible there. It is safe to break because the
        // user's escape hatch (KAPPASTREAM_GDK_BACKEND) was consulted first
        // and native builds never see the hook's value; and for the same
        // reason as the calls above, nothing has read the environment yet
        // (GDK reads GDK_BACKEND later, at display-open inside
        // `tauri::Builder::run`).
        std::env::set_var(GDK_BACKEND_VAR, backend);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test input builder: every signal is explicit so each case documents exactly
    // which environment it represents. Fields: (xdg, wayland, display, nv_sync,
    // webkit_dmabuf, nvidia_loaded). Defaults to a NON-AppImage run with no
    // KAPPASTREAM_GDK_BACKEND override; use compat_appimage() for those axes.
    fn compat(
        xdg: Option<&str>,
        wayland: Option<&str>,
        display: Option<&str>,
        nv_sync: Option<&str>,
        webkit: Option<&str>,
        nvidia: bool,
    ) -> CompatInputs {
        CompatInputs {
            xdg_session_type: xdg.map(String::from),
            wayland_display: wayland.map(String::from),
            display: display.map(String::from),
            nv_disable_explicit_sync: nv_sync.map(String::from),
            webkit_disable_dmabuf_renderer: webkit.map(String::from),
            nvidia_loaded: nvidia,
            appimage: false,
            kappastream_gdk_backend: None,
            pipewire_loaded: None,
            pipewire_system: None,
            pipewire_same_file: None,
            kappastream_pipewire_preload: None,
        }
    }

    // AppImage variant of the builder above: same six signals, plus the
    // KAPPASTREAM_GDK_BACKEND override, with appimage=true fixed — so the
    // non-AppImage cases in the table above stay byte-identical.
    fn compat_appimage(
        xdg: Option<&str>,
        wayland: Option<&str>,
        display: Option<&str>,
        nv_sync: Option<&str>,
        webkit: Option<&str>,
        nvidia: bool,
        gdk_override: Option<&str>,
    ) -> CompatInputs {
        CompatInputs {
            appimage: true,
            kappastream_gdk_backend: gdk_override.map(String::from),
            ..compat(xdg, wayland, display, nv_sync, webkit, nvidia)
        }
    }

    fn actions_wayland_only() -> CompatActions {
        CompatActions {
            disable_nvidia_explicit_sync: true,
            disable_webkit_dmabuf_renderer: false,
            gdk_backend: None,
            pipewire_preload: None,
        }
    }

    fn actions_x11_only() -> CompatActions {
        CompatActions {
            disable_nvidia_explicit_sync: false,
            disable_webkit_dmabuf_renderer: true,
            gdk_backend: None,
            pipewire_preload: None,
        }
    }

    fn actions_none() -> CompatActions {
        CompatActions::default()
    }

    fn actions_wayland_appimage() -> CompatActions {
        CompatActions {
            disable_nvidia_explicit_sync: true,
            disable_webkit_dmabuf_renderer: false,
            gdk_backend: Some(APPIMAGE_WAYLAND_GDK_BACKENDS.to_string()),
            pipewire_preload: None,
        }
    }

    // #1 NVIDIA Wayland with unset variables selects only the explicit-sync path.
    #[test]
    fn nvidia_wayland_unset_selects_explicit_sync_only() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true
            )),
            actions_wayland_only()
        );
    }

    // #2 NVIDIA X11 with unset variables selects only the DMA-BUF-renderer path.
    #[test]
    fn nvidia_x11_unset_selects_dmabuf_only() {
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, None, true)),
            actions_x11_only()
        );
    }

    // #3 Wayland with both WAYLAND_DISPLAY and DISPLAY stays Wayland.
    #[test]
    fn wayland_with_display_stays_wayland() {
        assert_eq!(
            classify_session(&compat(
                Some("wayland"),
                Some("wayland-0"),
                Some(":0"),
                None,
                None,
                true
            )),
            Session::Wayland
        );
        // And the action set is the Wayland-only one (X11 DMA-BUF not selected).
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                Some(":0"),
                None,
                None,
                true
            )),
            actions_wayland_only()
        );
    }

    // #4 XDG_SESSION_TYPE=x11 is classified as X11.
    #[test]
    fn xdg_session_type_x11_is_x11() {
        assert_eq!(
            classify_session(&compat(Some("x11"), None, Some(":0"), None, None, false)),
            Session::X11
        );
    }

    // #5 X11 fallback: XDG_SESSION_TYPE missing, DISPLAY set, no WAYLAND_DISPLAY.
    #[test]
    fn x11_fallback_when_xdg_missing() {
        assert_eq!(
            classify_session(&compat(None, None, Some(":0"), None, None, false)),
            Session::X11
        );
        // Fallback path also drives the action under NVIDIA.
        assert_eq!(
            select_actions(&compat(None, None, Some(":0"), None, None, true)),
            actions_x11_only()
        );
    }

    // #6 Missing session variables ⇒ Unknown, and no workaround even with NVIDIA.
    #[test]
    fn missing_session_vars_unknown_and_no_action() {
        assert_eq!(
            classify_session(&compat(None, None, None, None, None, false)),
            Session::Unknown
        );
        assert_eq!(
            select_actions(&compat(None, None, None, None, None, true)),
            actions_none()
        );
    }

    // #7 AMD/Intel-equivalent input (no NVIDIA driver) ⇒ no workaround on either
    //    session type.
    #[test]
    fn non_nvidia_no_workaround() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                false
            )),
            actions_none()
        );
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, None, false)),
            actions_none()
        );
    }

    // #8 User value WEBKIT_DISABLE_DMABUF_RENDERER=0 is preserved.
    #[test]
    fn dmabuf_user_zero_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("0"),
                true
            )),
            actions_none()
        );
    }

    // #9 User value WEBKIT_DISABLE_DMABUF_RENDERER=1 is preserved.
    #[test]
    fn dmabuf_user_one_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("1"),
                true
            )),
            actions_none()
        );
    }

    // #10 Arbitrary user value for the DMA-BUF variable is preserved.
    #[test]
    fn dmabuf_arbitrary_user_value_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("custom"),
                true
            )),
            actions_none()
        );
    }

    // #11 Existing __NV_DISABLE_EXPLICIT_SYNC override behavior still works
    //     (Wayland + NVIDIA + user value ⇒ explicit-sync action suppressed).
    #[test]
    fn explicit_sync_user_override_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some("0"),
                None,
                true
            )),
            actions_none()
        );
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some("1"),
                None,
                true
            )),
            actions_none()
        );
    }

    // #12 X11 does not select the Wayland explicit-sync workaround.
    #[test]
    fn x11_never_selects_explicit_sync() {
        let actions = select_actions(&compat(Some("x11"), None, Some(":0"), None, None, true));
        assert!(!actions.disable_nvidia_explicit_sync);
        assert!(actions.disable_webkit_dmabuf_renderer);
    }

    // #13 Wayland does not select the X11 DMA-BUF workaround.
    #[test]
    fn wayland_never_selects_dmabuf() {
        let actions = select_actions(&compat(
            Some("wayland"),
            Some("wayland-0"),
            None,
            None,
            None,
            true,
        ));
        assert!(actions.disable_nvidia_explicit_sync);
        assert!(!actions.disable_webkit_dmabuf_renderer);
    }

    // #14 Empty environment strings are handled deliberately:
    //     - empty XDG_SESSION_TYPE ⇒ treated as absent (fallback path);
    //     - empty WAYLAND_DISPLAY ⇒ not Wayland;
    //     - empty user-override values ⇒ preserved (not overwritten).
    #[test]
    fn empty_strings_handled_deliberately() {
        // Empty XDG + no other signal ⇒ Unknown.
        assert_eq!(
            classify_session(&compat(Some(""), None, None, None, None, false)),
            Session::Unknown
        );
        // Empty WAYLAND_DISPLAY with DISPLAY set ⇒ X11 fallback (not Wayland).
        assert_eq!(
            classify_session(&compat(None, Some(""), Some(":0"), None, None, false)),
            Session::X11
        );
        // Empty user DMA-BUF value on NVIDIA X11 ⇒ preserved (no action).
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, Some(""), true)),
            actions_none()
        );
        // Empty user explicit-sync value on NVIDIA Wayland ⇒ preserved (no action).
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some(""),
                None,
                true
            )),
            actions_none()
        );
    }

    // tty session type ⇒ Other, no workaround even with NVIDIA.
    #[test]
    fn tty_session_is_other_and_untargeted() {
        assert_eq!(
            classify_session(&compat(Some("tty"), None, None, None, None, false)),
            Session::Other
        );
        assert_eq!(
            select_actions(&compat(Some("tty"), None, None, None, None, true)),
            actions_none()
        );
    }

    // #15 NVIDIA filesystem detection probes remain valid. The pure decision
    //     against `nvidia_loaded` is covered by #1/#7 above; these exercise the
    //     path probes themselves against stable filesystem objects (no NVIDIA
    //     hardware / no root required).
    #[test]
    fn nvidia_driver_present_false_for_missing_paths() {
        assert!(!nvidia_driver_present(
            Path::new("/proc/driver/nvidia/does-not-exist-version"),
            Path::new("/sys/module/definitely-not-nvidia"),
        ));
    }

    #[test]
    fn nvidia_driver_present_via_proc_file_signal() {
        // /proc/self/status always exists as a regular file → procfs branch.
        assert!(nvidia_driver_present(
            Path::new("/proc/self/status"),
            Path::new("/sys/module/definitely-not-nvidia"),
        ));
    }

    #[test]
    fn nvidia_driver_present_via_sys_dir_signal() {
        // /sys/module always exists as a directory on Linux → sysfs branch.
        assert!(nvidia_driver_present(
            Path::new("/proc/driver/nvidia/does-not-exist-version"),
            Path::new("/sys/module"),
        ));
    }

    // #16 Non-AppImage runs never touch GDK_BACKEND on any session type —
    //     native builds (AUR/deb/rpm) have no hook value to undo.
    #[test]
    fn non_appimage_never_sets_gdk_backend() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true
            ))
            .gdk_backend,
            None
        );
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, None, true)).gdk_backend,
            None
        );
        assert_eq!(
            select_actions(&compat(Some("tty"), None, None, None, None, true)).gdk_backend,
            None
        );
        assert_eq!(
            select_actions(&compat(None, None, None, None, None, true)).gdk_backend,
            None
        );
    }

    // #17 AppImage + Wayland + NVIDIA selects BOTH the explicit-sync action
    //     and the backend override — the whole point: the sync fix only acts
    //     on a Wayland EGL surface, so the app must BE a Wayland client.
    #[test]
    fn appimage_wayland_nvidia_selects_explicit_sync_and_gdk_backend() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true,
                None
            )),
            actions_wayland_appimage()
        );
    }

    // #18 AppImage + Wayland WITHOUT NVIDIA still overrides the backend — the
    //     backend choice is GPU-independent — but selects no explicit-sync
    //     action (AMD/Intel are untouched by the NVIDIA rules).
    #[test]
    fn appimage_wayland_without_nvidia_still_overrides_backend() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                false,
                None
            )),
            CompatActions {
                disable_nvidia_explicit_sync: false,
                disable_webkit_dmabuf_renderer: false,
                gdk_backend: Some(APPIMAGE_WAYLAND_GDK_BACKENDS.to_string()),
                pipewire_preload: None,
            }
        );
    }

    // #19 AppImage + X11 keeps the hook's x11 (already the correct backend
    //     there) while the NVIDIA X11 workaround is unaffected.
    #[test]
    fn appimage_x11_keeps_hook_backend_and_dmabuf_untouched() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("x11"),
                None,
                Some(":0"),
                None,
                None,
                true,
                None
            )),
            actions_x11_only()
        );
    }

    // #20 AppImage + Other/Unknown sessions leave GDK_BACKEND alone (the
    //     hook's x11 stands; we cannot tell what the right backend is).
    #[test]
    fn appimage_other_and_unknown_leave_gdk_backend_alone() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("tty"),
                None,
                None,
                None,
                None,
                true,
                None
            ))
            .gdk_backend,
            None
        );
        assert_eq!(
            select_actions(&compat_appimage(None, None, None, None, None, true, None)).gdk_backend,
            None
        );
    }

    // #21 KAPPASTREAM_GDK_BACKEND=x11 on a Wayland AppImage wins verbatim —
    //     the user can still force the old XWayland behaviour.
    #[test]
    fn appimage_wayland_user_override_x11_wins() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true,
                Some("x11")
            ))
            .gdk_backend,
            Some("x11".to_string())
        );
    }

    // #22 The override is honoured regardless of session: an X11 AppImage
    //     with KAPPASTREAM_GDK_BACKEND=wayland still forwards `wayland`.
    #[test]
    fn appimage_x11_user_override_wayland_wins() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("x11"),
                None,
                Some(":0"),
                None,
                None,
                true,
                Some("wayland")
            ))
            .gdk_backend,
            Some("wayland".to_string())
        );
    }

    // #23 Present-but-empty override = explicit "don't touch": the hook's
    //     x11 stands even on a Wayland session.
    #[test]
    fn appimage_wayland_empty_override_means_dont_touch() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true,
                Some("")
            ))
            .gdk_backend,
            None
        );
    }

    // #24 The exact environment the AppImage currently runs in: a Wayland
    //     session where XWayland ALSO exports DISPLAY. Still classified
    //     Wayland (#3), still selects both Wayland actions.
    #[test]
    fn appimage_wayland_with_display_still_overrides_backend() {
        assert_eq!(
            select_actions(&compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                Some(":0"),
                None,
                None,
                true,
                None
            )),
            actions_wayland_appimage()
        );
    }

    // Pipewire-swap test builder: an AppImage run on a Wayland session with
    // the three pipewire axes explicit. The graphics axes are irrelevant to
    // the swap and stay at the compat_appimage defaults. same_file defaults
    // to "unknown" (None) — the pure selection table never stats files.
    fn compat_pipewire(
        loaded: Option<&str>,
        system: Option<&str>,
        preload_override: Option<&str>,
    ) -> CompatInputs {
        CompatInputs {
            pipewire_loaded: loaded.map(String::from),
            pipewire_system: system.map(String::from),
            kappastream_pipewire_preload: preload_override.map(String::from),
            ..compat_appimage(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                false,
                None,
            )
        }
    }

    // #25 Non-AppImage runs never preload, even with a bundled-looking
    //     client mapped and a system copy present — native builds never
    //     load a bundled client to swap.
    #[test]
    fn non_appimage_never_preloads_pipewire() {
        let inputs = CompatInputs {
            pipewire_loaded: Some("/appdir/usr/lib/libpipewire-0.3.so.0".into()),
            pipewire_system: Some("/usr/lib/libpipewire-0.3.so.0".into()),
            kappastream_pipewire_preload: None,
            ..compat(Some("wayland"), Some("wayland-0"), None, None, None, true)
        };
        assert_eq!(select_actions(&inputs).pipewire_preload, None);
    }

    // #26 Auto: AppImage run, bundled client mapped, system copy present
    //     ⇒ preload the system path.
    #[test]
    fn appimage_bundled_pipewire_swapped_for_system() {
        assert_eq!(
            select_actions(&compat_pipewire(
                Some("/tmp/.mount_K/usr/lib/libpipewire-0.3.so.0"),
                Some("/usr/lib/libpipewire-0.3.so.0"),
                None
            ))
            .pipewire_preload,
            Some("/usr/lib/libpipewire-0.3.so.0".to_string())
        );
    }

    // #27 The system copy is already the one mapped (user preload or an
    //     identical resolution) ⇒ nothing to do. Equal strings are the
    //     trivial spelling of "same file"; the same-file flag below covers
    //     the ones only (dev, ino) can prove.
    #[test]
    fn appimage_system_pipewire_already_loaded_does_nothing() {
        assert_eq!(
            select_actions(&compat_pipewire(
                Some("/usr/lib/libpipewire-0.3.so.0"),
                Some("/usr/lib/libpipewire-0.3.so.0"),
                None
            ))
            .pipewire_preload,
            None
        );
    }

    // #27b Same file, DIFFERENT spellings (the post-re-exec reality: maps
    //      reports the resolved versioned file, the system probe a SONAME
    //      or symlinked directory path) ⇒ nothing to do. String-only
    //      comparison re-selected a swap here; only the exec guard stopped
    //      the loop.
    #[test]
    fn appimage_same_file_different_spelling_does_nothing() {
        let mut inputs = compat_pipewire(
            Some("/usr/lib/libpipewire-0.3.so.0.1404.0"),
            Some("/usr/lib64/libpipewire-0.3.so.0"),
            None,
        );
        inputs.pipewire_same_file = Some(true);
        assert_eq!(select_actions(&inputs).pipewire_preload, None);
    }

    // #27c Different files by (dev, ino) — the swap genuinely applies even
    //      when the stat says so, and unknown metadata falls back to the
    //      string comparison (also a swap: the spellings differ).
    #[test]
    fn appimage_proven_different_file_swaps() {
        let mut inputs = compat_pipewire(
            Some("/tmp/.mount_K/usr/lib/libpipewire-0.3.so.0"),
            Some("/usr/lib64/libpipewire-0.3.so.0"),
            None,
        );
        inputs.pipewire_same_file = Some(false);
        assert_eq!(
            select_actions(&inputs).pipewire_preload,
            Some("/usr/lib64/libpipewire-0.3.so.0".to_string())
        );
        // Unknown (None) keeps the historical string-difference behavior.
        inputs.pipewire_same_file = None;
        assert_eq!(
            select_actions(&inputs).pipewire_preload,
            Some("/usr/lib64/libpipewire-0.3.so.0".to_string())
        );
    }

    // #27d The (dev, ino) comparison itself, against real files: a symlink
    //      with a SONAME-style name pointing at a versioned file is the SAME
    //      file; distinct files are not; an unstat'able path is never
    //      proven same.
    #[test]
    fn same_file_detection_follows_symlinks_and_versioned_names() {
        let dir = std::env::temp_dir().join(format!("ks-pw-same-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let real = dir.join("libpipewire-0.3.so.0.1404.0");
        std::fs::write(&real, b"so").unwrap();
        let soname = dir.join("libpipewire-0.3.so.0");
        let _ = std::fs::remove_file(&soname);
        std::os::unix::fs::symlink(&real, &soname).unwrap();
        assert!(paths_refer_to_same_file(
            real.to_str().unwrap(),
            soname.to_str().unwrap()
        ));
        assert!(paths_refer_to_same_file(
            soname.to_str().unwrap(),
            real.to_str().unwrap()
        ));
        let other = dir.join("libpipewire-elsewhere.so");
        std::fs::write(&other, b"so").unwrap();
        assert!(!paths_refer_to_same_file(
            real.to_str().unwrap(),
            other.to_str().unwrap()
        ));
        assert!(!paths_refer_to_same_file(
            real.to_str().unwrap(),
            "/definitely/not/there/libpipewire-0.3.so.0"
        ));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // #28 System without PipeWire keeps the bundled client — removing the
    //     swap keeps the AppImage self-contained there.
    #[test]
    fn appimage_no_system_pipewire_keeps_bundled() {
        assert_eq!(
            select_actions(&compat_pipewire(
                Some("/tmp/.mount_K/usr/lib/libpipewire-0.3.so.0"),
                None,
                None
            ))
            .pipewire_preload,
            None
        );
    }

    // #29 Nothing pipewire-ish mapped (no libmpv consumer) ⇒ no swap.
    #[test]
    fn appimage_no_pipewire_loaded_does_nothing() {
        assert_eq!(
            select_actions(&compat_pipewire(
                None,
                Some("/usr/lib/libpipewire-0.3.so.0"),
                None
            ))
            .pipewire_preload,
            None
        );
    }

    // #30 Override opt-outs: empty and the 0/off/no/false words (any case)
    //     keep the bundled client.
    #[test]
    fn pipewire_override_opt_outs_keep_bundled() {
        for value in ["", "0", "off", "OFF", "No", "false"] {
            assert_eq!(
                select_actions(&compat_pipewire(
                    Some("/tmp/.mount_K/usr/lib/libpipewire-0.3.so.0"),
                    Some("/usr/lib/libpipewire-0.3.so.0"),
                    Some(value)
                ))
                .pipewire_preload,
                None,
                "override {value:?} should keep the bundled client"
            );
        }
    }

    // #31 Any other override value is an explicit library path and wins
    //     verbatim, even when nothing pipewire-ish is mapped.
    #[test]
    fn pipewire_override_explicit_path_wins() {
        assert_eq!(
            select_actions(&compat_pipewire(
                None,
                None,
                Some("/opt/other/libpipewire-0.3.so.0")
            ))
            .pipewire_preload,
            Some("/opt/other/libpipewire-0.3.so.0".to_string())
        );
    }

    // #32 /proc/self/maps parsing: skips anonymous and [stack] mappings,
    //     ignores non-pipewire libraries, returns the FIRST pipewire
    //     mapping's full path.
    #[test]
    fn maps_parser_finds_first_pipewire_mapping() {
        let maps = "\
7f0000000000-7f0000021000 r--p 00000000 103:02 1234567  /usr/lib/libc.so.6
7f0000040000-7f0000066000 r-xp 00000000 103:02 8912345  /tmp/.mount_K/usr/lib/libpipewire-0.3.so.0
7f0000066000-7f0000068000 r--p 00051000 103:02 8912345  /tmp/.mount_K/usr/lib/libpipewire-0.3.so.0
7ffc0000000-7ffc0020000 rw-p 00000000 00:00 0           [stack]
7f0000080000-7f0000081000 rw-p 00000000 00:00 0
";
        assert_eq!(
            pipewire_path_in_maps(maps),
            Some("/tmp/.mount_K/usr/lib/libpipewire-0.3.so.0")
        );
        assert_eq!(pipewire_path_in_maps(""), None);
        let no_pipewire = "7f0000000000-7f0000021000 r--p 00000000 103:02 1  /usr/lib/libc.so.6\n";
        assert_eq!(pipewire_path_in_maps(no_pipewire), None);
    }

    // #33 ldconfig cache parsing: first-field basename match, path after
    //     the " => " separator; a present-but-different basename misses.
    #[test]
    fn ldconfig_parser_extracts_path_for_basename() {
        let cache = "        289 libs found in cache `/etc/ld.so.cache'\n\
                     \tlibpulse.so.0 (libc6,x86-64) => /usr/lib/libpulse.so.0\n\
                     \tlibpipewire-0.3.so.0 (libc6,x86-64) => /usr/lib/libpipewire-0.3.so.0\n";
        assert_eq!(
            ldconfig_path_for(cache, "libpipewire-0.3.so.0"),
            Some("/usr/lib/libpipewire-0.3.so.0".to_string())
        );
        assert_eq!(ldconfig_path_for(cache, "libpipewire-9.so.9"), None);
        assert_eq!(ldconfig_path_for(cache, ""), None);
    }
}
