use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::thread;
use std::time::Duration;

use crate::paths::AppPaths;

/// Configuration for starting the Bun API sidecar process.
///
/// Mirrors Electron's `ApiProcessOptions`:
/// - port: the API server port
/// - paths: resolved application paths
/// - app_password: optional password for app auth
/// - web_dist_dir: path to the built web frontend (prod only)
/// - dev_mode: whether we're running in development mode
/// - repo_root: monorepo root path (dev only)
pub struct SidecarConfig {
    pub port: u16,
    pub paths: AppPaths,
    pub app_password: Option<String>,
    pub web_dist_dir: Option<String>,
    pub dev_mode: bool,
    pub repo_root: Option<PathBuf>,
    pub resource_dir: Option<PathBuf>,
}

/// A handle to the running Bun sidecar process.
///
/// When explicitly stopped (or dropped), the process is terminated
/// gracefully (SIGTERM + 3s grace + SIGKILL).
pub struct SidecarHandle {
    pub child: Option<Child>,
    pub stopped: Arc<AtomicBool>,
}

// ── Bun executable resolution ──────────────────────────────────────────────

/// Resolve the Bun executable path.
///
/// Resolution order (mirrors Electron's `resolveBunExecutable()`):
/// 1. `PIPLUS_BUN_PATH` environment variable (explicit override)
/// 2. Resource path `external/bun-bin/bun` (production)
/// 3. `bun` from system PATH (development fallback)
fn resolve_bun_path(resource_dir: Option<&PathBuf>) -> String {
    if let Ok(path) = std::env::var("PIPLUS_BUN_PATH") {
        if !path.is_empty() && PathBuf::from(&path).exists() {
            return path;
        }
    }

    if let Some(res_dir) = resource_dir {
        let bin_name = if cfg!(target_os = "windows") {
            "bun.exe"
        } else {
            "bun"
        };
        let bundled = res_dir.join("external").join("bun-bin").join(bin_name);
        if bundled.exists() {
            return bundled.to_string_lossy().to_string();
        }
        eprintln!(
            "[desktop] Bundled bun not found at {:?}; falling back to system 'bun'.",
            bundled
        );
    }

    "bun".to_string()
}

/// Resolve the API entry script path.
///
/// - Production: `<resource_dir>/external/api-dist/index.js`
/// - Development: `<repo_root>/apps/api/src/index.ts`
fn resolve_api_entry(config: &SidecarConfig) -> String {
    if config.dev_mode {
        if let Some(root) = &config.repo_root {
            root.join("apps")
                .join("api")
                .join("src")
                .join("index.ts")
                .to_string_lossy()
                .to_string()
        } else {
            // Fallback: relative path guessing
            let cwd = std::env::current_dir().unwrap_or_default();
            // Walk up from src-tauri -> apps/desktop-tauri -> apps -> repo root
            let guess = cwd
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(|r| r.join("apps").join("api").join("src").join("index.ts"));
            if let Some(ref path) = guess {
                if path.exists() {
                    return path.to_string_lossy().to_string();
                }
            }
            "apps/api/src/index.ts".to_string()
        }
    } else if let Some(res_dir) = &config.resource_dir {
        res_dir
            .join("external")
            .join("api-dist")
            .join("index.js")
            .to_string_lossy()
            .to_string()
    } else {
        "external/api-dist/index.js".to_string()
    }
}

/// Resolve the API CWD (current working directory for the bun process).
///
/// - Production: `<resource_dir>/external/api-dist`
/// - Development: `<repo_root>`
fn resolve_api_cwd(config: &SidecarConfig) -> String {
    if config.dev_mode {
        config
            .repo_root
            .as_ref()
            .map(|r| r.to_string_lossy().to_string())
            .unwrap_or_else(|| ".".to_string())
    } else if let Some(res_dir) = &config.resource_dir {
        res_dir
            .join("external")
            .join("api-dist")
            .to_string_lossy()
            .to_string()
    } else {
        ".".to_string()
    }
}

// ── Platform-specific signal helpers ───────────────────────────────────────

#[cfg(unix)]
fn send_sigterm(child: &Child) {
    let pid = child.id() as i32;
    if pid > 0 {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        eprintln!("[desktop/sidecar] Sent SIGTERM to pid {}", pid);
    }
}

#[cfg(windows)]
fn send_sigterm(child: &Child) {
    // On Windows, `child.kill()` is the only option — it terminates the process.
    // There's no SIGTERM equivalent in Win32, so we use TerminateProcess directly
    // which is what child.kill() does. We'll just rely on the kill + wait approach.
    eprintln!("[desktop/sidecar] Terminating process on Windows");
    let _ = child.kill();
}

// ── Public API ─────────────────────────────────────────────────────────────

/// Start the Bun API sidecar process.
///
/// Mirrors Electron's `startApiProcess()`:
/// - Spawns `bun <api_entry>` with the correct environment variables
/// - Pipes stdout/stderr to both console and api.log via threads
/// - Returns a `SidecarHandle` for lifecycle management
pub fn start_sidecar(config: SidecarConfig) -> std::io::Result<SidecarHandle> {
    let bun_path = resolve_bun_path(config.resource_dir.as_ref());
    let api_entry = resolve_api_entry(&config);
    let api_cwd = resolve_api_cwd(&config);

    eprintln!(
        "[desktop/sidecar] Using bun: {} entry: {} cwd: {}",
        bun_path, api_entry, api_cwd
    );

    let web_dist = config.web_dist_dir.clone().unwrap_or_else(|| {
        if config.dev_mode {
            config
                .repo_root
                .as_ref()
                .map(|r| r.join("apps").join("web").join("dist").to_string_lossy().to_string())
                .unwrap_or_else(|| "apps/web/dist".to_string())
        } else {
            // In production (AppImage), use absolute path from resource_dir
            config
                .resource_dir
                .as_ref()
                .map(|r| r.join("external").join("web-dist").to_string_lossy().to_string())
                .unwrap_or_else(|| "external/web-dist".to_string())
        }
    });

    let mut cmd = Command::new(&bun_path);
    cmd.arg(&api_entry);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.current_dir(&api_cwd);

    // Environment variables — exactly matching Electron's ApiProcessOptions
    cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
    cmd.env("HOME", std::env::var("HOME").unwrap_or_default());
    cmd.env("API_HOST", "127.0.0.1");
    cmd.env("API_PORT", config.port.to_string());
    cmd.env("PIPLUS_DATA_DIR", &config.paths.data_dir);
    cmd.env(
        "DATABASE_URL",
        format!("file:{}", config.paths.database_path.display()),
    );
    cmd.env("PROJECTS_ROOT", &config.paths.projects_dir);
    cmd.env("PIPLUS_WEB_DIST", &web_dist);
    cmd.env("PIPLUS_SERVE_WEB", "1");
    cmd.env("PIPLUS_FORCE_ROLE_PROMPTS", "true");

    // Pass through relevant environment variables
    for (key, val) in std::env::vars() {
        if key.starts_with("NODE_") || key.starts_with("BUN_") || key == "RUST_LOG" {
            cmd.env(&key, &val);
        }
    }

    if let Some(ref pw) = config.app_password {
        cmd.env("APP_PASSWORD", pw);
    }

    let mut child = cmd.spawn()?;
    let stopped = Arc::new(AtomicBool::new(false));
    let api_log_path = config.paths.logs_dir.join("api.log");

    // Pipe stdout to console and api.log
    if let Some(stdout) = child.stdout.take() {
        let log_path = api_log_path.clone();
        let s = stopped.clone();
        thread::spawn(move || pipe_output(stdout, &log_path, "[desktop/api]", s));
    }

    // Clone the stopped flag before moving it into the first closure
    let stopped_for_handle = stopped.clone();
    let stopped_for_err = stopped;
    // Pipe stderr to console and api.log
    if let Some(stderr) = child.stderr.take() {
        let log_path = api_log_path;
        thread::spawn(move || pipe_output(stderr, &log_path, "[desktop/api:err]", stopped_for_err));
    }

    let handle = SidecarHandle {
        child: Some(child),
        stopped: stopped_for_handle,
    };
    Ok(handle)
}

/// Read lines from a pipe and write them to both stderr and the API log file.
/// Exits early if the `stopped` flag is set (indicating intentional shutdown).
fn pipe_output<R: std::io::Read + Send + 'static>(
    reader: R,
    log_path: &std::path::Path,
    prefix: &str,
    stopped: Arc<AtomicBool>,
) {
    let log_path = log_path.to_path_buf();
    let prefix = prefix.to_string();

    let mut log_file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("[desktop/sidecar] Failed to open api.log: {}", e);
            None
        }
    };

    let buf_reader = BufReader::new(reader);
    for line_result in buf_reader.lines() {
        // Check if we should stop (intentional shutdown triggered)
        if stopped.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        match line_result {
            Ok(line) => {
                let formatted = format!("{} {}\n", prefix, line);
                let _ = std::io::stderr().write_all(formatted.as_bytes());
                if let Some(ref mut f) = log_file {
                    let _ = writeln!(f, "{}", line);
                }
            }
            Err(_) => break,
        }
    }

    // Flush and close
    if let Some(ref mut f) = log_file {
        let _ = f.flush();
    }
}

/// Stop the API sidecar process gracefully.
///
/// Mirrors Electron's `stopApiProcess()`:
/// 1. Mark the stopped flag so monitoring threads know this is intentional
/// 2. Send SIGTERM (or terminate on Windows)
/// 3. Wait up to 3 seconds for graceful exit
/// 4. If still alive, send SIGKILL (unix) or TerminateProcess (windows)
pub fn stop_sidecar(handle: &mut SidecarHandle) {
    // Signal that we're intentionally shutting down
    handle.stopped.store(true, std::sync::atomic::Ordering::SeqCst);

    let child = match handle.child.as_mut() {
        Some(c) => c,
        None => {
            eprintln!("[desktop/sidecar] No child process handle (already taken for monitoring)");
            return;
        }
    };

    // Already exited?
    match child.try_wait() {
        Ok(Some(_)) => {
            eprintln!("[desktop/sidecar] API process already exited");
            return;
        }
        Ok(None) => {} // Still running
        Err(e) => {
            // May have been reaped by monitoring thread
            eprintln!("[desktop/sidecar] try_wait error (already reaped): {}", e);
            return;
        }
    }

    // 1. Try graceful termination
    eprintln!("[desktop/sidecar] Stopping API process...");
    send_sigterm(child);

    // 2. Wait up to 3 seconds
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                eprintln!("[desktop/sidecar] API process exited gracefully");
                return;
            }
            Ok(None) => {} // Still running, continue waiting
            Err(e) => {
                // May have been reaped by monitoring thread
                eprintln!("[desktop/sidecar] try_wait error (already reaped): {}", e);
                return;
            }
        }
        if start.elapsed() >= Duration::from_secs(3) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // 3. Force kill
    eprintln!("[desktop/sidecar] Force killing API process...");
    let _ = child.kill();
    // wait() may fail if the monitoring thread already reaped the child; that's fine
    match child.wait() {
        Ok(_) => eprintln!("[desktop/sidecar] API process terminated"),
        Err(e) => eprintln!("[desktop/sidecar] wait() error (may have been reaped): {}", e),
    }
}

impl Drop for SidecarHandle {
    fn drop(&mut self) {
        stop_sidecar(self);
    }
}