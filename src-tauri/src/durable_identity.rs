//! Durable copy of the user identity, stored outside the identifier-scoped
//! application data directory.
//!
//! `app_local_data_dir()` — the root of `paths::profile_data_dir` and therefore
//! of `projects.json` — is derived from the bundle identifier. Every identifier
//! change (upstream -> fork, dev config vs release config) hands the app a
//! brand new empty directory, so the persisted preferences (display name,
//! avatar, language) are gone and onboarding runs again. The webview data
//! directory (`EBWebView`, i.e. localStorage) sits under the same root and is
//! lost the same way.
//!
//! This file lives in a fixed, identifier-independent folder so the frontend can
//! restore the identity after such a change. It stores identity fields only —
//! never projects, terminals or tokens.

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DURABLE_DIR_NAME: &str = "UtopiaAgent";
const DURABLE_FILE_NAME: &str = "identity.json";

/// `<os local data dir>/UtopiaAgent/identity.json` — no bundle identifier in the
/// path, unlike `app_local_data_dir()`.
fn durable_identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .local_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(root.join(DURABLE_DIR_NAME).join(DURABLE_FILE_NAME))
}

#[tauri::command]
pub fn load_durable_identity(app: AppHandle) -> Result<Option<String>, String> {
    let path = durable_identity_path(&app)?;
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_durable_identity(app: AppHandle, content: String) -> Result<(), String> {
    let path = durable_identity_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // Atomic write (tmp -> rename), matching `projects::save_projects`.
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, &content).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())
}
