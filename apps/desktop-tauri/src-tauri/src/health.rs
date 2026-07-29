use std::time::Duration;

/// Poll a health endpoint until it responds with HTTP 200 OK or the timeout expires.
///
/// Mirrors Electron's `waitForHealth()`:
/// - Interval: 300ms between attempts
/// - Timeout: 15s by default
/// - Uses reqwest::blocking for synchronous polling
pub fn wait_for_health(url: &str, timeout_ms: u64) -> Result<(), String> {
    let started_at = std::time::Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let interval = Duration::from_millis(300);

    loop {
        if started_at.elapsed() >= timeout {
            return Err(format!(
                "API health check timed out after {}ms: {}",
                timeout_ms, url
            ));
        }

        match reqwest::blocking::get(url) {
            Ok(resp) if resp.status().is_success() => {
                return Ok(());
            }
            _ => {
                // Ignore errors — the API might still be starting up
                std::thread::sleep(interval);
            }
        }
    }
}