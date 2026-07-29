use std::path::PathBuf;
use std::sync::Mutex;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{AppHandle, image::Image, Manager};

/// State holding a flag that signals the app should quit for real.
pub struct Quitting(pub Mutex<bool>);

/// Create the system tray icon with right-click context menu.
///
/// Mirrors Electron's `createAppTray()`:
/// - **显示** → restores and focuses the main window
/// - **退出** → sets quitting flag and closes the app
/// - Left-click → shows the window
/// - If the icon file doesn't exist, skips tray creation (logs a warning)
pub fn setup_tray(
    app: &AppHandle,
    icon_path: &PathBuf,
    main_window_label: String,
) -> Result<(), Box<dyn std::error::Error>> {
    // ── Try to load the tray icon ────────────────────────────
    let icon_bytes = match std::fs::read(icon_path) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!(
                "[desktop/tray] Tray icon not found at {:?} ({}); skipping tray",
                icon_path, e
            );
            return Ok(());
        }
    };

    let icon = match Image::from_bytes(&icon_bytes) {
        Ok(img) => img,
        Err(e) => {
            eprintln!(
                "[desktop/tray] Failed to decode tray icon: {}; skipping tray",
                e
            );
            return Ok(());
        }
    };

    // ── Build menu items ──────────────────────────────────────
    let show_item = MenuItemBuilder::with_id("show", "显示").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    // ── Ensure quitting state exists ──────────────────────────
    if !app.try_state::<Quitting>().is_some() {
        app.manage(Quitting(Mutex::new(false)));
    }

    let label_show = main_window_label.clone();
    let label_click = main_window_label;

    // ── Build tray ────────────────────────────────────────────
    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("PiPlus")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let id = event.id().0.as_str();
            match id {
                "show" => {
                    if let Some(window) = app.get_webview_window(&label_show) {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    if let Some(state) = app.try_state::<Quitting>() {
                        if let Ok(mut q) = state.0.lock() {
                            *q = true;
                        }
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window(&label_click) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    eprintln!("[desktop/tray] Tray created");
    Ok(())
}