use tauri::WebviewWindow;

/// Inject `window.piplusConfig` into the webview via JavaScript eval.
///
/// Mirrors Electron's preload script (`apps/desktop/src/preload/index.ts`):
/// ```js
/// contextBridge.exposeInMainWorld('piplusConfig', {
///   isDesktop: true,
///   platform: process.platform,
/// });
/// ```
///
/// The config object tells the web frontend it's running inside the
/// desktop shell and which OS platform it's on.
pub fn inject_config(window: &WebviewWindow, platform: &str) -> Result<(), Box<dyn std::error::Error>> {
    let js = format!(
        "window.piplusConfig = {{ isDesktop: true, platform: '{}' }};",
        platform
    );

    window.eval(&js)?;
    eprintln!("[desktop/config] Injected piplusConfig (platform={})", platform);
    Ok(())
}

/// Detect the current platform string (matches Electron's `process.platform`).
pub fn detect_platform() -> &'static str {
    if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}