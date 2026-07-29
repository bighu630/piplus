use std::net::TcpListener;

const DEFAULT_API_PORT: u16 = 18321;
const PORT_ENV_VAR: &str = "PIPLUS_DESKTOP_PORT";

/// Check if a specific port is available on the given host.
pub fn is_port_available(host: &str, port: u16) -> bool {
    TcpListener::bind(format!("{}:{}", host, port)).is_ok()
}

/// Get a random free port from the OS.
pub fn get_free_port(host: &str) -> std::io::Result<u16> {
    let listener = TcpListener::bind(format!("{}:0", host))?;
    Ok(listener.local_addr()?.port())
}

/// Get a port with the following priority:
/// 1. Environment variable PIPLUS_DESKTOP_PORT (if set and available)
/// 2. Built-in default (18321) if available
/// 3. Random free port as fallback
///
/// Returns (port, is_preferred) — mirrors Electron's `getPreferredPort()`.
pub fn get_preferred_port(host: &str) -> (u16, bool) {
    // 1. Try env var
    if let Ok(env_val) = std::env::var(PORT_ENV_VAR) {
        let trimmed = env_val.trim().to_string();
        if let Ok(port) = trimmed.parse::<u16>() {
            if port > 0 && is_port_available(host, port) {
                eprintln!(
                    "[desktop] using preferred port from {}={}",
                    PORT_ENV_VAR, port
                );
                return (port, true);
            }
            if port > 0 {
                eprintln!(
                    "[desktop] {}={} unavailable; falling back",
                    PORT_ENV_VAR, port
                );
            }
        } else {
            eprintln!(
                "[desktop] {}={:?} is not a valid port; ignoring",
                PORT_ENV_VAR, trimmed
            );
        }
    }

    // 2. Try built-in default
    if is_port_available(host, DEFAULT_API_PORT) {
        eprintln!("[desktop] using preferred API port {}", DEFAULT_API_PORT);
        return (DEFAULT_API_PORT, true);
    }

    // 3. Fallback to random port
    match get_free_port(host) {
        Ok(port) => {
            eprintln!(
                "[desktop] preferred API port {} unavailable; \
                 falling back to random port {}; \
                 localStorage origin will differ across restarts",
                DEFAULT_API_PORT, port
            );
            (port, false)
        }
        Err(e) => {
            eprintln!(
                "[desktop] failed to get free port: {}; using default {}",
                e, DEFAULT_API_PORT
            );
            (DEFAULT_API_PORT, true)
        }
    }
}