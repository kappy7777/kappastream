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
//! Semantics — the invariant is that the old directory is only ever
//! deleted once a complete, marked copy exists at the new name, so no
//! failure can destroy the only copy of the profile:
//!
//! - A completed profile carries a [`MARKER`] file. The marker is written
//!   into the source BEFORE the move whenever possible, so the atomic
//!   rename carries it along.
//! - Common path: an atomic same-filesystem rename. A transient failure
//!   (on Windows, a lingering msedgewebview2.exe holding the directory
//!   after an updater restart) is retried a few times; a cross-device
//!   failure is permanent and skips straight to the copy path.
//! - Copy path: the old tree is copied into a fresh per-process staging
//!   sibling, the marker is written INTO the staging copy (aborting the
//!   whole attempt if that fails), and only after the staging directory
//!   is flipped into place by a same-volume rename is the old directory
//!   removed.
//! - An existing UNmarked directory at the new name — left by a migration
//!   attempt that did not complete, or a fresh profile a failed attempt
//!   booted on — is set aside under `<name>.pre-migration-<timestamp>`
//!   (never deleted) and the old profile takes its place.
//! - An existing MARKED directory at the new name alongside a re-created
//!   old one (a downgrade to the old identifier ran in between) means
//!   both are left untouched: the marked profile stays authoritative and
//!   the old directory is kept as-is. Data written by such a downgrade
//!   stays in the old directory and is ignored — preserved, not migrated.
//!
//! Every failure path prints to stderr, naming the paths involved, and
//! returns; the untouched old directory lets the next launch retry.
//!
//! Known hazard (accepted): on Linux, a second launch while a first
//! instance runs on an unmarked new-name directory (reachable only after
//! an earlier migration already failed) sets the live profile aside
//! mid-session; the first instance keeps running on the renamed-aside
//! copy, so its later writes land there instead of the migrated profile —
//! preserved, not lost. Practically unreachable: sibling-directory
//! renames do not fail on Linux, so the unmarked state itself requires
//! the copy path to have failed first.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const OLD_IDENTIFIER: &str = "dev.kappy.kappastream";
const NEW_IDENTIFIER: &str = "io.github.kappy7777.kappastream";

/// Marks a data directory whose identifier migration COMPLETED. Written
/// into the source of a move before the move whenever possible, and into
/// a staging copy before it is flipped into place — never after the fact,
/// so a marked directory is always a complete one.
const MARKER: &str = ".kappastream-migrated";

/// Backoff between rename attempts, after the immediate first try.
const RENAME_RETRY_DELAYS_MS: [u64; 5] = [100, 250, 500, 1000, 2000];

/// Staging directory infix: `<new-name>.migrating-<pid>`. Per-process so
/// two concurrent launches can never interleave into the same copy.
const STAGING_INFIX: &str = ".migrating-";

/// Rescue-directory infix for an unmarked live profile set aside:
/// `<new-name>.pre-migration-<unix-secs>[-n]`.
const RESCUE_INFIX: &str = ".pre-migration-";

/// A leftover staging directory from another process is only removed once
/// it is this old — a younger one may belong to an instance that is still
/// copying.
const STALE_STAGING_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// How many `-n` suffixes to probe before giving up on a rescue name.
const RESCUE_PROBE_LIMIT: u32 = 9;

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

/// Injectable filesystem operations, so every branch of the decision tree
/// is unit-testable against throwaway directories.
struct Ops<'a> {
    rename: &'a mut dyn FnMut(&Path, &Path) -> io::Result<()>,
    copy_tree: &'a mut dyn FnMut(&Path, &Path) -> io::Result<()>,
    remove_tree: &'a mut dyn FnMut(&Path) -> io::Result<()>,
    write_file: &'a mut dyn FnMut(&Path, &[u8]) -> io::Result<()>,
    sleep: &'a mut dyn FnMut(Duration),
}

/// Migrates `old` → `new` (see the module docs) with real filesystem ops.
fn migrate_dir(old: &Path, new: &Path) {
    let mut rename = |from: &Path, to: &Path| fs::rename(from, to);
    let mut copy_tree = |from: &Path, to: &Path| copy_dir_recursive(from, to);
    let mut remove_tree = |dir: &Path| fs::remove_dir_all(dir);
    let mut write_file = |path: &Path, bytes: &[u8]| fs::write(path, bytes);
    let mut sleep = |delay: Duration| std::thread::sleep(delay);
    migrate_dir_with(
        old,
        new,
        &mut Ops {
            rename: &mut rename,
            copy_tree: &mut copy_tree,
            remove_tree: &mut remove_tree,
            write_file: &mut write_file,
            sleep: &mut sleep,
        },
    );
}

/// The migration decision tree (see the module docs). Every branch either
/// completes the move or leaves both directories on disk.
fn migrate_dir_with(old: &Path, new: &Path, ops: &mut Ops) {
    if !old.is_dir() {
        return; // Fresh install, already migrated, or never ran the old ID.
    }

    if new.exists() {
        if new.join(MARKER).exists() {
            // Completed migration + a re-created old directory (a
            // downgrade ran in between). Both stay untouched.
            eprintln!(
                "kappastream: webview data at {} was already migrated; leaving the old directory {} in place",
                new.display(),
                old.display()
            );
            return;
        }
        // Unmarked: a migration attempt that did not complete, or a fresh
        // profile a failed attempt booted on. Preserve it aside — never
        // delete — and let the old profile take its place.
        if !move_aside(new, ops) {
            return; // In use (e.g. a running instance): retry next launch.
        }
    }

    // `new` is absent now. Write the marker into the source so the rename
    // carries it atomically; a failed write only downgrades to a marker-
    // less move, it must not divert to the copy path (a machine where
    // marker writes fail would otherwise repeat the full copy on every
    // launch forever).
    if let Err(err) = write_marker(&old.join(MARKER), ops) {
        eprintln!(
            "kappastream: could not pre-write the migration marker into {}: {err}",
            old.display()
        );
    }

    // Common case first: atomic move on the same filesystem, retried on
    // transient failures. A cross-device rename is permanent (std maps it
    // to CrossesDevices), so it skips the retries and goes straight to
    // the same-volume staging flip below.
    match (ops.rename)(old, new) {
        Ok(()) => return,
        Err(err) if err.kind() == io::ErrorKind::CrossesDevices => {}
        Err(err) => {
            eprintln!(
                "kappastream: renaming webview data {} -> {} failed ({err}); retrying",
                old.display(),
                new.display()
            );
            for delay_ms in RENAME_RETRY_DELAYS_MS {
                (ops.sleep)(Duration::from_millis(delay_ms));
                if !old.is_dir() {
                    return; // A concurrent instance completed the move.
                }
                if (ops.rename)(old, new).is_ok() {
                    return;
                }
            }
        }
    }

    // Copy fallback: fresh per-process staging sibling, then a same-volume
    // rename into place. The staging directory is a SIBLING of `new`, so
    // the flip can never hit the cross-device wall that brought us here.
    sweep_stale_staging(new, STALE_STAGING_AGE, ops);
    let Some(name) = new.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    let staging = new.with_file_name(format!("{name}{STAGING_INFIX}{}", std::process::id()));
    if let Err(err) = (ops.copy_tree)(old, &staging) {
        let _ = (ops.remove_tree)(&staging);
        eprintln!(
            "kappastream: could not copy webview data {} -> {}: {err}; the old directory is untouched, this launch starts on a fresh profile",
            old.display(),
            staging.display()
        );
        return;
    }
    // The marker must exist before anything may remove `old`; a write
    // failure aborts the whole attempt like a copy failure.
    if let Err(err) = write_marker(&staging.join(MARKER), ops) {
        let _ = (ops.remove_tree)(&staging);
        eprintln!(
            "kappastream: could not mark the staged copy at {}: {err}; the old directory is untouched, this launch starts on a fresh profile",
            staging.display()
        );
        return;
    }
    if let Err(err) = (ops.rename)(&staging, new) {
        let _ = (ops.remove_tree)(&staging);
        eprintln!(
            "kappastream: could not move the staged copy {} -> {}: {err}; the old directory is untouched",
            staging.display(),
            new.display()
        );
        return;
    }
    if !old.is_dir() {
        return; // A concurrent instance already consumed the old tree.
    }
    if let Err(err) = (ops.remove_tree)(old) {
        eprintln!(
            "kappastream: migrated webview data to {} but could not remove the old directory {}: {err}; the marker keeps future launches from touching the leftover",
            new.display(),
            old.display()
        );
    }
}

/// Writes the completion marker (best effort for a pre-move write; the
/// copy path treats a failure as fatal, see `migrate_dir_with`).
fn write_marker(path: &Path, ops: &mut Ops) -> io::Result<()> {
    (ops.write_file)(path, b"identifier rename complete\n")
}

/// Moves an unmarked live `new` aside to a unique
/// `<name>.pre-migration-<unix-secs>[-n]` sibling. Returns `false` when
/// the move failed or no free name was found — the caller skips the
/// migration entirely, keeping BOTH directories intact.
fn move_aside(new: &Path, ops: &mut Ops) -> bool {
    let Some(name) = new.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for n in 1..=RESCUE_PROBE_LIMIT {
        let suffix = if n == 1 {
            format!("{RESCUE_INFIX}{secs}")
        } else {
            format!("{RESCUE_INFIX}{secs}-{n}")
        };
        let aside = new.with_file_name(format!("{name}{suffix}"));
        if aside.exists() {
            continue;
        }
        return match (ops.rename)(new, &aside) {
            Ok(()) => {
                eprintln!(
                    "kappastream: incomplete webview data at {} was set aside at {} (nothing was deleted)",
                    new.display(),
                    aside.display()
                );
                true
            }
            Err(err) => {
                eprintln!(
                    "kappastream: {} is in use and could not be set aside ({err}); skipping the migration this launch",
                    new.display()
                );
                false
            }
        };
    }
    eprintln!(
        "kappastream: no free set-aside name next to {}; leaving both directories in place and skipping the migration",
        new.display()
    );
    false
}

/// Removes leftover staging directories of the migration's own naming
/// (`<new-name>.migrating-<pid>`) from crashed earlier processes, but only
/// ones older than `max_age` — a younger one may belong to an instance
/// that is still copying. Never touches anything else.
fn sweep_stale_staging(new: &Path, max_age: Duration, ops: &mut Ops) {
    let (Some(parent), Some(prefix)) = (
        new.parent(),
        new.file_name()
            .and_then(|n| n.to_str())
            .map(|n| format!("{n}{STAGING_INFIX}")),
    ) else {
        return;
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(pid) = name.strip_prefix(&prefix) else {
            continue;
        };
        if pid.parse::<u32>().is_err() {
            continue; // Same infix but not our naming scheme.
        }
        let Ok(meta) = fs::metadata(entry.path()) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        if meta.modified().ok().and_then(|m| m.elapsed().ok()) < Some(max_age) {
            continue; // Younger than the threshold: leave it alone.
        }
        let _ = (ops.remove_tree)(&entry.path());
    }
}

/// Recursively copies `src` into `dst` (which must not exist yet — every
/// caller stages into a fresh directory, so no merge semantics are
/// needed). Symlinks are followed and copied as their targets' contents —
/// the webview storage trees hold plain files.
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if fs::metadata(entry.path())?.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
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

    /// Every sibling of `base/{old,new}` the migration may create.
    fn side_dirs(base: &Path) -> Vec<String> {
        let mut found: Vec<String> = fs::read_dir(base)
            .expect("read base")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(STAGING_INFIX) || n.contains(RESCUE_INFIX))
            .collect();
        found.sort();
        found
    }

    fn staging_name(new: &Path) -> PathBuf {
        new.with_file_name(format!(
            "{}{STAGING_INFIX}{}",
            new.file_name().unwrap().to_string_lossy(),
            std::process::id()
        ))
    }

    /// Runs the migration with the real filesystem ops.
    fn run_real(old: &Path, new: &Path) {
        migrate_dir(old, new);
    }

    #[test]
    fn renames_old_into_missing_new_with_the_marker() {
        let base = scratch("rename");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("localstorage").join("db.sqlite"), "favorites");

        run_real(&old, &new);

        assert!(new.join("localstorage").join("db.sqlite").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists(), "rename must consume the old directory");
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn no_op_without_old() {
        let base = scratch("noop");
        let old = base.join("old");
        let new = base.join("new");
        fs::create_dir_all(&base).expect("create base");

        run_real(&old, &new);

        assert!(!old.exists() && !new.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn transient_rename_failure_is_retried() {
        let base = scratch("retry");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("ls").join("db"), "favorites");

        let mut failures_left = 2usize;
        let mut sleeps: Vec<u64> = Vec::new();
        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() && failures_left > 0 {
                failures_left -= 1;
                Err(io::Error::other("test: transient"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |d: Duration| sleeps.push(d.as_millis() as u64);
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        assert_eq!(sleeps, vec![100, 250], "one sleep per failed retry");
        assert!(new.join("ls").join("db").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn persistent_rename_failure_falls_back_to_a_marked_staging_copy() {
        let base = scratch("staging");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("ls").join("db"), "favorites");
        // A young foreign staging dir must survive the sweep untouched.
        let foreign = new.with_file_name(format!("new{STAGING_INFIX}999999"));
        write(&foreign.join("partial"), "half-copied");

        let mut attempts = 0usize;
        let mut sleeps: Vec<u64> = Vec::new();
        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() {
                attempts += 1;
                Err(io::Error::other("test: persistent"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |d: Duration| sleeps.push(d.as_millis() as u64);
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        // The immediate attempt plus one per retry delay, then staging.
        assert_eq!(attempts, 6);
        assert_eq!(sleeps, vec![100, 250, 500, 1000, 2000]);
        assert!(new.join("ls").join("db").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        assert!(!staging_name(&new).exists(), "staging must be flipped away");
        assert_eq!(
            side_dirs(&base),
            vec![foreign.file_name().unwrap().to_string_lossy().into_owned()],
            "the young foreign staging dir stays"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn crosses_devices_skips_the_retries() {
        let base = scratch("exdev");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut attempts = 0usize;
        let mut sleeps: Vec<u64> = Vec::new();
        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() {
                attempts += 1;
                Err(io::Error::new(io::ErrorKind::CrossesDevices, "test: exdev"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |d: Duration| sleeps.push(d.as_millis() as u64);
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        // A cross-device rename is permanent: one attempt, no sleeps, and
        // the sibling staging flip still completes the migration.
        assert_eq!(attempts, 1);
        assert!(sleeps.is_empty());
        assert!(new.join("db").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_concurrent_winner_consuming_old_ends_the_retry_quietly() {
        let base = scratch("winner");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut first = true;
        let mut sleeps: Vec<u64> = Vec::new();
        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() && first {
                first = false;
                // Simulate another instance completing the move between
                // our attempts: the old directory disappears.
                fs::remove_dir_all(from).expect("consume old");
                Err(io::Error::other("test: lost the race"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |d: Duration| sleeps.push(d.as_millis() as u64);
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        assert!(!old.exists());
        assert!(!new.exists(), "this instance must not fabricate a profile");
        assert_eq!(sleeps, vec![100]);
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_failure_leaves_old_untouched_and_no_new() {
        let base = scratch("copyfail");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() {
                Err(io::Error::other("test: persistent"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree =
            |_a: &Path, _b: &Path| -> io::Result<()> { Err(io::Error::other("test: copy")) };
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |_d: Duration| {};
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        assert_eq!(fs::read_to_string(old.join("db")).unwrap(), "favorites");
        assert!(!new.exists());
        assert!(side_dirs(&base).is_empty(), "the staging dir is cleaned up");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn marker_write_failure_in_staging_aborts_with_old_untouched() {
        let base = scratch("marker-staging");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() {
                Err(io::Error::other("test: persistent"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file =
            |_p: &Path, _b: &[u8]| -> io::Result<()> { Err(io::Error::other("test: ro")) };
        let mut sleep = |_d: Duration| {};
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        // The marker must exist before anything may remove `old`.
        assert_eq!(fs::read_to_string(old.join("db")).unwrap(), "favorites");
        assert!(!new.exists());
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn marker_write_failure_before_the_rename_does_not_divert() {
        let base = scratch("marker-src");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut rename = |from: &Path, to: &Path| fs::rename(from, to);
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file =
            |_p: &Path, _b: &[u8]| -> io::Result<()> { Err(io::Error::other("test: ro")) };
        let mut sleep = |_d: Duration| {};
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        // A failed pre-move marker write downgrades to a marker-less move;
        // it must not push a healthy rename onto the copy path.
        assert!(new.join("db").is_file());
        assert!(!new.join(MARKER).exists());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn unmarked_existing_new_is_set_aside_and_old_migrates() {
        let base = scratch("aside");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("profile"), "OLD");
        write(&new.join("live"), "LIVE");

        run_real(&old, &new);

        let sides = side_dirs(&base);
        assert_eq!(sides.len(), 1, "exactly one set-aside copy: {sides:?}");
        let aside = base.join(&sides[0]);
        assert_eq!(
            fs::read_to_string(aside.join("live")).unwrap(),
            "LIVE",
            "the set-aside copy is intact"
        );
        assert_eq!(fs::read_to_string(new.join("profile")).unwrap(), "OLD");
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rescue_name_collisions_probe_the_suffix_range() {
        let base = scratch("rescue-names");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("profile"), "OLD");
        write(&new.join("live"), "LIVE");
        // Occupy the rescue names for now() and now()+1 so whichever
        // second the migration observes, its first probe collides.
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        for s in [secs, secs + 1] {
            write(
                &base.join(format!("new{RESCUE_INFIX}{s}")).join("x"),
                "occupied",
            );
        }

        run_real(&old, &new);

        let sides = side_dirs(&base);
        let used: Vec<&String> = sides
            .iter()
            .filter(|n| n.ends_with("-2"))
            .collect::<Vec<_>>();
        assert_eq!(
            used.len(),
            1,
            "the colliding rescue name takes the -2 suffix: {sides:?}"
        );
        assert!(new.join("profile").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn move_aside_failure_skips_everything() {
        let base = scratch("aside-fail");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("profile"), "OLD");
        write(&new.join("live"), "LIVE");

        let mut rename = |from: &Path, to: &Path| {
            if from == new.as_path() {
                Err(io::Error::other("test: in use"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |a: &Path| fs::remove_dir_all(a);
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |_d: Duration| {};
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        // Both directories untouched, no rescue, no staging.
        assert_eq!(fs::read_to_string(old.join("profile")).unwrap(), "OLD");
        assert_eq!(fs::read_to_string(new.join("live")).unwrap(), "LIVE");
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_at_new_is_set_aside_like_a_directory() {
        let base = scratch("file-new");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("profile"), "OLD");
        write(&new, "LIVE");

        run_real(&old, &new);

        let sides = side_dirs(&base);
        assert_eq!(sides.len(), 1);
        assert_eq!(
            fs::read_to_string(base.join(&sides[0])).unwrap(),
            "LIVE",
            "the stray file is preserved"
        );
        assert!(new.join("profile").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn marked_new_and_recreated_old_are_both_left_alone() {
        let base = scratch("marked-new");
        let old = base.join("old");
        let new = base.join("new");
        write(&new.join(MARKER), "done");
        write(&new.join("keep"), "MIGRATED");
        write(&old.join("stale"), "DOWNGRADE");

        run_real(&old, &new);

        assert_eq!(fs::read_to_string(new.join("keep")).unwrap(), "MIGRATED");
        assert!(!new.join("stale").exists(), "old must not bleed into new");
        assert_eq!(
            fs::read_to_string(old.join("stale")).unwrap(),
            "DOWNGRADE",
            "the old directory is kept"
        );
        assert!(side_dirs(&base).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_marker_inside_old_migrates_with_it_and_never_counts_as_new() {
        // A marker left inside `old` by a failed attempt rides along when
        // the move finally happens...
        let base = scratch("marker-old");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join(MARKER), "from a failed attempt");
        write(&old.join("db"), "favorites");

        run_real(&old, &new);

        assert!(new.join(MARKER).is_file());
        assert!(new.join("db").is_file());
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);

        // ...but it never satisfies the completed-migration check, which
        // reads only `new`: an unmarked `new` is still set aside.
        let base = scratch("marker-old-2");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join(MARKER), "from a failed attempt");
        write(&old.join("db"), "favorites");
        write(&new.join("live"), "LIVE");

        run_real(&old, &new);

        assert!(new.join(MARKER).is_file());
        assert!(new.join("db").is_file());
        assert_eq!(side_dirs(&base).len(), 1, "the unmarked new was set aside");
        assert!(!old.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_failure_after_the_flip_keeps_the_completed_new() {
        let base = scratch("rm-fail");
        let old = base.join("old");
        let new = base.join("new");
        write(&old.join("db"), "favorites");

        let mut rename = |from: &Path, to: &Path| {
            if from == old.as_path() && to == new.as_path() {
                Err(io::Error::other("test: persistent"))
            } else {
                fs::rename(from, to)
            }
        };
        let mut copy_tree = |a: &Path, b: &Path| copy_dir_recursive(a, b);
        let mut remove_tree = |_a: &Path| -> io::Result<()> { Err(io::Error::other("test: busy")) };
        let mut write_file = |p: &Path, bytes: &[u8]| fs::write(p, bytes);
        let mut sleep = |_d: Duration| {};
        migrate_dir_with(
            &old,
            &new,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );

        assert!(new.join("db").is_file());
        assert!(new.join(MARKER).is_file());
        assert!(
            old.exists(),
            "the leftover stays; the marker keeps future launches away from it"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn stale_staging_siblings_are_swept_and_young_ones_kept() {
        let base = scratch("sweep");
        let new = base.join("new");
        fs::create_dir_all(&base).expect("create base");
        let stale = new.with_file_name(format!("new{STAGING_INFIX}111"));
        let young = new.with_file_name(format!("new{STAGING_INFIX}222"));
        let foreign = base.join("not-our-staging");
        write(&stale.join("partial"), "x");
        write(&young.join("partial"), "x");
        write(&foreign.join("partial"), "x");

        let mut rename = |_a: &Path, _b: &Path| -> io::Result<()> { Ok(()) };
        let mut copy_tree = |_a: &Path, _b: &Path| -> io::Result<()> { Ok(()) };
        let removed = std::rc::Rc::new(std::cell::RefCell::new(Vec::<PathBuf>::new()));
        let removed_log = removed.clone();
        let mut remove_tree = move |a: &Path| {
            removed_log.borrow_mut().push(a.to_path_buf());
            fs::remove_dir_all(a)
        };
        let mut write_file = |_p: &Path, _b: &[u8]| -> io::Result<()> { Ok(()) };
        let mut sleep = |_d: Duration| {};

        // Zero threshold: anything with our naming goes.
        sweep_stale_staging(
            &new,
            Duration::ZERO,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );
        assert_eq!(
            removed.borrow().len(),
            2,
            "both staging dirs, young included"
        );
        assert!(foreign.exists(), "foreign dirs are never touched");
        assert!(!stale.exists() && !young.exists());

        // The production threshold keeps fresh dirs (nothing is old
        // enough to sweep here).
        write(&stale.join("partial"), "x");
        write(&young.join("partial"), "x");
        removed.borrow_mut().clear();
        sweep_stale_staging(
            &new,
            STALE_STAGING_AGE,
            &mut Ops {
                rename: &mut rename,
                copy_tree: &mut copy_tree,
                remove_tree: &mut remove_tree,
                write_file: &mut write_file,
                sleep: &mut sleep,
            },
        );
        assert!(
            removed.borrow().is_empty(),
            "young staging dirs are left alone"
        );
        assert!(stale.exists() && young.exists());
        let _ = fs::remove_dir_all(&base);
    }
}
