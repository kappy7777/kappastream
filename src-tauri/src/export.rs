use std::path::PathBuf;

const MAX_EXPORT_BYTES: usize = 1024 * 1024;

fn safe_filename(suggested: &str) -> String {
    let basename = std::path::Path::new(suggested.trim())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let stem = basename
        .strip_suffix(".json")
        .or_else(|| basename.strip_suffix(".JSON"))
        .unwrap_or(basename);
    let mut sanitized: String = stem
        .chars()
        .take(96)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    sanitized = sanitized.trim_matches('_').to_string();
    if sanitized.is_empty() {
        sanitized = "kappastream-favorites".to_string();
    }
    format!("{sanitized}.json")
}

/// Native "Save As..." for the favorites JSON export.
///
/// The browser-side `<a download>` blob trick doesn't trigger a save
/// dialog in the Tauri WebView (WebKitGTK on Linux), so we route export
/// through Rust + `rfd` to get a real native file picker.
///
#[tauri::command]
pub async fn save_favorites_export(
    content: String,
    suggested_filename: String,
) -> Result<Option<String>, String> {
    if content.len() > MAX_EXPORT_BYTES {
        return Err("favorites export is too large".to_string());
    }
    let name = safe_filename(&suggested_filename);

    let chosen = rfd::AsyncFileDialog::new()
        .set_title("Export favorites")
        .set_file_name(&name)
        .add_filter("JSON", &["json"])
        .save_file()
        .await;

    let Some(handle) = chosen else {
        // User canceled the dialog.
        return Ok(None);
    };

    let path: PathBuf = handle.path().to_path_buf();
    let write_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || std::fs::write(write_path, content.as_bytes()))
        .await
        .map_err(|error| format!("export task failed: {error}"))?
        .map_err(|error| format!("failed to write export: {error}"))?;

    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::safe_filename;

    #[test]
    fn sanitizes_export_filename_and_forces_json_extension() {
        assert_eq!(
            safe_filename("../../my favorites.txt"),
            "my_favorites_txt.json"
        );
        assert_eq!(safe_filename(" favorites.JSON "), "favorites.json");
        assert_eq!(safe_filename("../.json"), "kappastream-favorites.json");
    }
}
