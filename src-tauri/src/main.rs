// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Linux graphics compatibility MUST run before Tauri/GTK/WebKitGTK/EGL
    // initialize so NVIDIA EGL-Wayland explicit sync can be disabled (on
    // Wayland + NVIDIA, unless the user already set the variable) before any
    // surface is created. See src/compat.rs.
    #[cfg(target_os = "linux")]
    app_lib::compat::configure();
    app_lib::run();
}
