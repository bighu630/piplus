use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;

/// Thread-safe file logger that writes to both desktop.log and api.log.
///
/// Mirrors Electron behavior:
/// - desktop.log: all desktop lifecycle events
/// - api.log: stdout/stderr from the bun API sidecar process
/// - All messages also go to stdout/stderr for immediate feedback
#[allow(dead_code)]
pub struct FileLogger {
    desktop_file: Mutex<std::fs::File>,
    api_file: Mutex<std::fs::File>,
}

fn format_timestamp() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

impl FileLogger {
    /// Open both log files in append mode. Creates the files if they don't exist.
    pub fn new(logs_dir: &Path) -> std::io::Result<Self> {
        let desktop_path = logs_dir.join("desktop.log");
        let api_path = logs_dir.join("api.log");

        let desktop_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&desktop_path)?;

        let api_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&api_path)?;

        Ok(Self {
            desktop_file: Mutex::new(desktop_file),
            api_file: Mutex::new(api_file),
        })
    }

    /// Log a desktop event to both stdout and desktop.log.
    pub fn log_desktop(&self, msg: &str) {
        let ts = format_timestamp();
        let line = format!("[{}] [desktop] {}\n", ts, msg);

        let _ = std::io::stdout().write_all(line.as_bytes());
        if let Ok(mut f) = self.desktop_file.lock() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }

    /// Log an API process message to both stderr and api.log.
    #[allow(dead_code)]
    pub fn log_api(&self, msg: &str) {
        let ts = format_timestamp();
        let line = format!("[{}] [api] {}\n", ts, msg);

        let _ = std::io::stderr().write_all(line.as_bytes());
        if let Ok(mut f) = self.api_file.lock() {
            let _ = f.write_all(line.as_bytes());
            let _ = f.flush();
        }
    }
}