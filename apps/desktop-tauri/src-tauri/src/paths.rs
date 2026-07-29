use std::path::PathBuf;

/// Application paths, mirroring Electron's `ensureAppPaths()` behavior.
#[allow(dead_code)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub database_path: PathBuf,
}

/// Ensure all application directories exist and return resolved paths.
///
/// On Linux:  ~/.config/piplus/
/// On macOS:  ~/Library/Application Support/com.piplus.desktop/
/// On Windows:  C:\Users\<user>\AppData\Roaming\com.piplus.desktop/
///
/// NOTE: Uses dirs::config_dir() to match Electron's app.getPath('userData')
/// which on Linux resolves to ~/.config/ (not ~/.local/share/).
///
/// Sub-directories: logs, runtime, cache, projects
pub fn ensure_app_paths() -> std::io::Result<AppPaths> {
    let data_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("piplus");

    let logs_dir = data_dir.join("logs");
    let runtime_dir = data_dir.join("runtime");
    let cache_dir = data_dir.join("cache");
    let projects_dir = data_dir.join("projects");
    let database_path = data_dir.join("app.db");

    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(&logs_dir)?;
    std::fs::create_dir_all(&runtime_dir)?;
    std::fs::create_dir_all(&cache_dir)?;
    std::fs::create_dir_all(&projects_dir)?;

    Ok(AppPaths {
        data_dir,
        logs_dir,
        runtime_dir,
        cache_dir,
        projects_dir,
        database_path,
    })
}