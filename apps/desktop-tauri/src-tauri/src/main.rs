use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

mod config;
mod health;
mod logging;
mod paths;
mod port;
mod sidecar;
mod tray;

// ── Managed state types ────────────────────────────────────────────────────

/// Wrapper for the sidecar handle stored in Tauri managed state.
/// Dropped on app exit, which triggers `SidecarHandle::drop` → graceful shutdown.
#[allow(dead_code)]
struct SidecarState(Mutex<sidecar::SidecarHandle>);

/// Wrapper for the file logger stored in Tauri managed state.
#[allow(dead_code)]
struct AppLogger(logging::FileLogger);

// ── API process crash monitor ──────────────────────────────────────────────

/// Spawn a background thread that monitors the API sidecar process.
///
/// Mirrors Electron's apiProcess.once('exit', ...) handler:
/// - If the process exits unexpectedly (not an intentional stop via `stop_sidecar`),
///   the app is exited with code 1.
/// - On Unix, uses `waitpid` to block until the child exits.
/// - On Windows, uses a polling loop since there's no direct waitpid equivalent.
fn spawn_api_monitor(app_handle: tauri::AppHandle, pid: u32, stopped: Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            // Block until the child process exits (this reaps the zombie too).
            unsafe {
                let mut status: i32 = 0;
                libc::waitpid(pid as libc::pid_t, &mut status, 0);
            }

            if !stopped.load(Ordering::SeqCst) {
                eprintln!(
                    "[desktop] API process (pid={}) exited unexpectedly; shutting down app",
                    pid
                );
                app_handle.exit(1);
            }
        }

        #[cfg(not(unix))]
        {
            // On Windows, we can't waitpid on a PID directly without the Child handle.
            // Poll the stopped flag periodically as a fallback.
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
            }
        }
    });
}

// ── Repo root resolution (dev mode) ────────────────────────────────────────

/// Walk up from the current working directory to find the monorepo root.
///
/// The monorepo root is identified by the presence of `pnpm-workspace.yaml`
/// and an `apps/` directory. In Tauri dev mode, CWD is typically
/// `<monorepo>/apps/desktop-tauri/src-tauri/`.
fn resolve_repo_root_dev() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut dir = Some(cwd.as_path());
    while let Some(d) = dir {
        if d.join("pnpm-workspace.yaml").exists() || d.join("apps").exists() {
            // If it has Cargo.toml at root level (monorepo root) return it
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Resolve the tray icon path, trying several locations in order.
fn resolve_tray_icon_path(app: &tauri::App, dev_mode: bool) -> PathBuf {
    // 1. Dev mode: look in src-tauri/icons/ first
    if dev_mode {
        let cwd = std::env::current_dir().unwrap_or_default();
        let local_icons = cwd.join("icons").join("tray-icon.png");
        if local_icons.exists() {
            return local_icons;
        }
        // 2. Dev mode: try the Electron assets directory
        if let Some(root) = resolve_repo_root_dev() {
            let electron_asset = root
                .join("apps")
                .join("desktop")
                .join("assets")
                .join("tray-icon.png");
            if electron_asset.exists() {
                return electron_asset;
            }
        }
        // Fallback: still return the local icons path (will be handled gracefully)
        local_icons
    } else {
        // Production: look in resource directory
        app.path()
            .resource_dir()
            .ok()
            .map(|r| r.join("icons").join("tray-icon.png"))
            .unwrap_or_else(|| PathBuf::from("icons/tray-icon.png"))
    }
}

// ── Application entry point ────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(tray::Quitting(Mutex::new(false)))
        .setup(|app| {
            // ── 1. Ensure application paths ──────────────────────
            let app_paths = paths::ensure_app_paths()
                .unwrap_or_else(|e| panic!("[desktop] Failed to create app paths: {}", e));
            eprintln!("[desktop] Data directory: {:?}", app_paths.data_dir);

            // ── 2. Start file logging ────────────────────────────
            let logger = logging::FileLogger::new(&app_paths.logs_dir)
                .unwrap_or_else(|e| panic!("[desktop] Failed to create logger: {}", e));
            logger.log_desktop("=== PiPlus Desktop (Tauri v2) starting ===");
            app.manage(AppLogger(logger));

            // ── 3. Resolve port ──────────────────────────────────
            // Dev mode: random port (avoiding conflicts between instances).
            // Production: preferred stable port for localStorage consistency.
            let (port, preferred) = if cfg!(debug_assertions)
                || std::env::var("TAURI_DEV").is_ok()
                || std::env::var("PIPLUS_DEV").is_ok()
            {
                let p = port::get_free_port("127.0.0.1")
                    .expect("[desktop] Failed to get free port");
                (p, false)
            } else {
                port::get_preferred_port("127.0.0.1")
            };
            let api_base_url = format!("http://127.0.0.1:{}", port);
            let api_url = url::Url::parse(&api_base_url)
                .expect("[desktop] Invalid API base URL");
            eprintln!(
                "[desktop] Port: {} (preferred: {})",
                port, preferred
            );

            // ── 4. Determine mode and paths ──────────────────────
            let dev_mode = cfg!(debug_assertions)
                || std::env::var("TAURI_DEV").is_ok()
                || std::env::var("PIPLUS_DEV").is_ok();
            let resource_dir = app.path().resource_dir().ok();
            let repo_root = if dev_mode {
                resolve_repo_root_dev()
            } else {
                None
            };

            eprintln!(
                "[desktop] Mode: {}",
                if dev_mode { "development" } else { "production" }
            );

            // ── 5. Start the Bun sidecar API process ─────────────
            let sidecar_cfg = sidecar::SidecarConfig {
                port,
                paths: app_paths,
                app_password: std::env::var("APP_PASSWORD").ok(),
                web_dist_dir: None,
                dev_mode,
                repo_root,
                resource_dir,
            };

            let mut sidecar_handle = sidecar::start_sidecar(sidecar_cfg)
                .unwrap_or_else(|e| panic!("[desktop] Failed to start API sidecar: {}", e));
            eprintln!("[desktop] API sidecar started");

            // ── 6. Spawn API process crash monitor ───────────────
            // Mirrors Electron's apiProcess.once('exit') handler.
            // If the API process exits unexpectedly (not via stop_sidecar),
            // the app will exit with code 1.
            {
                let app_handle = app.handle().clone();
                let child_pid = sidecar_handle.child.as_ref().map(|c| c.id());
                let stopped = sidecar_handle.stopped.clone();

                if let Some(pid) = child_pid {
                    spawn_api_monitor(app_handle, pid, stopped);
                }
            }

            // ── 7. Wait for API to be healthy ────────────────────
            let health_url = format!("{}/health", api_base_url);
            eprintln!("[desktop] Waiting for API health at {} ...", health_url);
            if let Err(e) = health::wait_for_health(&health_url, 15000) {
                // Log the error, stop the sidecar, and panic
                eprintln!("[desktop] Health check failed: {}", e);
                sidecar::stop_sidecar(&mut sidecar_handle);
                panic!("{}", e);
            }
            eprintln!("[desktop] API is healthy");

            // ── 8. Create the main window ────────────────────────
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(api_url),
            )
            .title("piplus")
            .inner_size(1440.0, 960.0)
            .min_inner_size(800.0, 600.0)
            .resizable(true)
            .center()
            .build()
            .unwrap_or_else(|e| panic!("[desktop] Failed to create main window: {}", e));
            eprintln!("[desktop] Main window created");

            // ── 9. Inject piplusConfig into the webview ──────────
            let platform = config::detect_platform();
            config::inject_config(&window, platform)
                .unwrap_or_else(|e| eprintln!("[desktop] Failed to inject config: {}", e));

            // ── 10. Setup system tray ─────────────────────────────
            let tray_icon_path = resolve_tray_icon_path(app, dev_mode);
            eprintln!("[desktop] Tray icon path: {:?}", tray_icon_path);
            if let Err(e) = tray::setup_tray(app.handle(), &tray_icon_path, "main".to_string()) {
                eprintln!("[desktop] Tray setup skipped: {}", e);
            }

            // ── 11. Store sidecar handle in managed state ────────
            // It will be dropped on app exit, shutting down the sidecar.
            app.manage(SidecarState(Mutex::new(sidecar_handle)));

            eprintln!("[desktop] Bootstrap complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // If the "Quitting" flag is set (from tray's "退出"), allow close.
                let should_quit = window
                    .try_state::<tray::Quitting>()
                    .map(|q| q.0.lock().map(|guard| *guard).unwrap_or(false))
                    .unwrap_or(false);

                if should_quit {
                    eprintln!("[desktop] Quitting flag set; allowing window close");
                    return;
                }

                // Otherwise, prevent close and hide to tray instead.
                eprintln!("[desktop] Window close requested; hiding to tray");
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}