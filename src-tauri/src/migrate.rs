//! One-time webview data-directory migration for the application
//! identifier rename (`dev.kappy.kappastream` →
//! `io.github.kappy7777.kappastream`).
//!
//! The webview's persistent storage — localStorage, the app's ONLY
//! persistence — lives in a single identifier-named directory per platform:
//!
//! - Linux: `$XDG_DATA_HOME/<id>` (default `~/.local/share/<id>`); Tauri
//!   forces the webview `data_directory` to `app_local_data_dir()`, which
//!   is derived from the identifier.
//! - Windows: `%LOCALAPPDATA%\<id>` (the WebView2 user data folder,
//!   including its `EBWebView` subtree).
//! - macOS: `~/Library/WebKit/<id>` (the WKWebView default data store,
//!   keyed by the bundle identifier).
//!
//! Renaming the identifier relocates that directory, which would otherwise
//! hand every existing user an empty profile: favorites, settings, and VOD
//! positions would all be gone. This module moves the old directory to the
//! new name BEFORE the builder creates any webview (first statement of
//! `run()`), so the first launch of the renamed build finds all previous
//! state exactly where it expects it.
//!
//! Semantics: a no-op unless the old directory exists. The common path is
//! an atomic same-filesystem rename; the fallback is an idempotent
//! merge-copy (cross-device move, or completing a partial copy left by an
//! earlier attempt — files already present at the destination are left
//! untouched, so storage the app wrote between attempts survives a retry)
//! followed by removal of the old directory so subsequent launches no-op.
//! Every failure path prints to stderr and returns; the untouched old
//! directory lets the next launch retry.

use std::fs;
use std::path::{Path, PathBuf};

const OLD_IDENTIFIER: &str = "dev.kappy.kappastream";
const NEW_IDENTIFIER: &str = "io.github.kappy7777.kappastream";

/// Runs the migration (see the module docs). Cheap when there is nothing
/// to do: one `is_dir()` stat when the old directory is absent.
pub fn migrate() {
    let Some(base) = data_root() else {
        return;
    };
    migrate_dir(&base.join(OLD_IDENTIFIER), &base.join(NEW_IDENTIFIER));
}

/// The identifier-named storage base for the current platform (see the
/// module docs). `None` when the platform is unsupported or the
/// environment does not pin down a home/data location — nothing to do.
fn data_root() -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        // Mirrors the XDG base-directory rule tauri/dirs apply: an EMPTY
        // XDG_DATA_HOME is treated as unset, and a RELATIVE one is invalid
        // (the app itself falls back to ~/.local/share, so the migration
        // must resolve the same directory or it would silently no-op).
        match std::env::var_os("XDG_DATA_HOME") {
            Some(v) if !v.is_empty() && Path::new(&v).is_absolute() => Some(PathBuf::from(v)),
            _ => home_dir().map(|h| h.join(".local").join("share")),
        }
    } else if cfg!(target_os = "windows") {
        // %LOCALAPPDATA% equals the known folder for standard profiles.
        // Under corporate folder redirection tauri/dirs resolve through
        // the known-folder API instead and this lookup misses — the
        // migration then no-ops (old data stays put, nothing is lost) and
        // the affected user starts on fresh storage.
        std::env::var_os("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home_dir().map(|h| h.join("Library").join("WebKit"))
    } else {
        None
    }
}

/// `$HOME` only, without the getpwuid(3) fallback the dirs crate applies:
/// a desktop session launch always has HOME set, and without it the
/// migration simply no-ops (old data stays put, nothing is lost).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Migrates `old` → `new` (see the module docs). Pure filesystem logic so
/// the decision tree is unit-testable against throwaway directories.
fn migrate_dir(old: &Path, new: &Path) {
    if !old.is_dir() {
        return; // Fresh install, already migrated, or never ran the old ID.
    }
    if !new.exists() && fs::rename(old, new).is_ok() {
        return; // Common case: atomic move on the same filesystem.
    }
    // `new` already exists (the partial result of an earlier attempt) or
    // the rename failed for another reason: merge the old tree over it
    // (idempotent, fills in only missing files), then drop the old
    // directory so later launches no-op.
    match copy_dir_recursive(old, new) {
        Ok(()) => {
            if let Err(err) = fs::remove_dir_all(old) {
                eprintln!(
                    "kappastream: migrated webview data but could not remove the old directory {}: {err}",
                    old.display()
                );
            }
        }
        Err(err) => eprintln!(
            "kappastream: could not migrate webview data from {} to {}: {err}",
            old.display(),
            new.display()
        ),
    }
}

/// Recursively merges `src` into `dst`, copying a file only when the
/// destination is absent, and staging each copy under a private suffix
/// that is renamed into place. Skip-rather-than-overwrite protects
/// storage the app itself wrote after an earlier partial migration
/// (newer than anything the old tree holds; clobbering it would
/// silently revert live favorites/settings), while the staging rename
/// keeps a crash mid-copy from leaving a truncated file that a later
/// retry would mistake for complete — a leftover staged file is simply
/// replaced on the next attempt. Symlinks are followed and copied as
/// their targets' contents — the webview storage trees hold plain
/// files.
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if !to.exists() {
            let staged = dst.join(format!(
                "{}.kappastream-migrate-part",
                entry.file_name().to_string_lossy()
            ));
            fs::copy(entry.path(), &staged)?;
            fs::rename(&staged, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// A throwaway directory unique per test AND per run (a previous run's
    /// leftover with the same name must not poison the assertions).
    fn scratch(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before the epoch")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ks-migrate-{tag}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, contents).expect("write file");
    }

    #[test]
    fn renames_old_into_missing_new() {
        let base = scratch("rename");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("localstorage").join("db.sqlite"), "favorites");

        migrate_dir(&old, &new);

        assert!(new.join("localstorage").join("db.sqlite").is_file());
        assert!(!old.exists(), "rename must consume the old directory");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn no_op_without_old() {
        let base = scratch("noop");
        let old = base.join("old");
        let new = base.join("new");

        migrate_dir(&old, &new);

        assert!(!old.exists() && !new.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn merge_fills_missing_files_and_keeps_existing() {
        // A partial earlier copy left one of two files behind at `new`;
        // the retry must complete the merge and then drop `old`. The file
        // already present is NOT overwritten: after a partial migration
        // the app itself may have written live storage into `new`, whose
        // bytes are newer than anything the old tree holds.
        let base = scratch("merge");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("a").join("one"), "1");
        write(&old.join("a").join("two"), "2");
        write(&new.join("a").join("one"), "LIVE");

        migrate_dir(&old, &new);

        assert_eq!(
            fs::read_to_string(new.join("a").join("one")).unwrap(),
            "LIVE"
        );
        assert_eq!(fs::read_to_string(new.join("a").join("two")).unwrap(), "2");
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_never_overwrites_existing_files() {
        let base = scratch("copy");
        let src = base.join("src");
        let dst = base.join("dst");
        write(&src.join("sub").join("f"), "v1");
        copy_dir_recursive(&src, &dst).unwrap();
        write(&src.join("sub").join("f"), "v2");
        copy_dir_recursive(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("sub").join("f")).unwrap(), "v1");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn retry_replaces_a_stale_staged_file() {
        // A crash mid-copy leaves the staged sibling behind; the retry
        // must not treat it (or anything else) as a reason to skip, and
        // the rename consumes the staged file.
        let base = scratch("staged");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("a").join("one"), "1");
        write(
            &new.join("a").join("one.kappastream-migrate-part"),
            "GARBAGE",
        );

        migrate_dir(&old, &new);

        assert_eq!(fs::read_to_string(new.join("a").join("one")).unwrap(), "1");
        assert!(
            !new.join("a").join("one.kappastream-migrate-part").exists(),
            "the staged file must be renamed away, not left behind"
        );
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }
}
