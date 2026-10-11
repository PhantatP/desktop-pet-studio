//! Desktop Pet: one transparent overlay window that the pets live in (drawn by overlay.ts),
//! a Studio window for managing pets, a tray icon, and a pet library in %APPDATA%.

use std::fs;
use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod screen;

#[derive(serde::Serialize)]
struct Scan {
    cursor: (f64, f64),
    /// Top-level windows as [left, top, right, bottom], topmost first; only when requested.
    windows: Option<Vec<[f64; 4]>>,
}

/// Cursor position and (optionally) other windows, in the calling window's logical pixels.
#[tauri::command]
fn scan(window: WebviewWindow, windows: bool) -> Result<Scan, String> {
    let origin = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let own = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let to_logical = |x: i32, y: i32| ((x - origin.x) as f64 / scale, (y - origin.y) as f64 / scale);

    let (cx, cy) = screen::cursor();
    let rects = windows.then(|| {
        screen::window_rects(own)
            .into_iter()
            .map(|[l, t, r, b]| {
                let (l, t) = to_logical(l, t);
                let (r, b) = to_logical(r, b);
                [l, t, r, b]
            })
            .collect()
    });
    Ok(Scan { cursor: to_logical(cx, cy), windows: rects })
}

fn pets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("pets"))
}

/// Pet ids and sheet file names become paths, so allow only plain names.
fn safe_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if ok { Ok(name) } else { Err(format!("invalid name: {name}")) }
}

/// Every saved pet.json, as raw JSON text.
#[tauri::command]
fn list_pets(app: AppHandle) -> Result<Vec<String>, String> {
    let Ok(entries) = fs::read_dir(pets_dir(&app)?) else { return Ok(vec![]) };
    Ok(entries
        .flatten()
        .filter_map(|e| fs::read_to_string(e.path().join("pet.json")).ok())
        .collect())
}

/// Write pet.json and delete sheet files the pet no longer uses.
#[tauri::command]
fn save_pet(app: AppHandle, id: String, json: String) -> Result<(), String> {
    let dir = pets_dir(&app)?.join(safe_name(&id)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let pet: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let used: Vec<&str> = pet["sheets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s["file"].as_str())
        .collect();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != "pet.json" && !used.contains(&name.as_str()) {
            let _ = fs::remove_file(entry.path());
        }
    }
    fs::write(dir.join("pet.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_pet(app: AppHandle, id: String) -> Result<(), String> {
    fs::remove_dir_all(pets_dir(&app)?.join(safe_name(&id)?)).map_err(|e| e.to_string())
}

/// Copy a sprite sheet the user picked into the pet's folder; returns the new file name.
#[tauri::command]
fn import_sheet(app: AppHandle, id: String, path: String) -> Result<String, String> {
    let dir = pets_dir(&app)?.join(safe_name(&id)?);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ext = PathBuf::from(&path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let name = format!("sheet-{stamp}.{}", safe_name(&ext)?);
    fs::copy(&path, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

/// Raw bytes of an image the user picked in the file dialog.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

/// Raw bytes of a sheet stored in a pet's folder.
#[tauri::command]
fn read_pet_file(app: AppHandle, id: String, file: String) -> Result<Response, String> {
    let path = pets_dir(&app)?.join(safe_name(&id)?).join(safe_name(&file)?);
    fs::read(path).map(Response::new).map_err(|e| e.to_string())
}

// async: creating a window from a synchronous command can deadlock on Windows
#[tauri::command]
async fn open_studio(app: AppHandle) -> Result<(), String> {
    show_studio(&app).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn show_studio(app: &AppHandle) -> tauri::Result<()> {
    if let Some(studio) = app.get_webview_window("studio") {
        studio.unminimize()?;
        studio.show()?;
        return studio.set_focus();
    }
    WebviewWindowBuilder::new(app, "studio", WebviewUrl::App("index.html".into()))
        .title("Desktop Pet Studio")
        .inner_size(1060.0, 760.0)
        .min_inner_size(820.0, 600.0)
        .center()
        .build()?;
    Ok(())
}

/// A transparent, click-through, always-on-top window covering the main screen above the taskbar.
fn create_overlay(app: &AppHandle) -> tauri::Result<()> {
    let monitor = app.primary_monitor()?.expect("no monitor");
    let area = monitor.work_area();
    let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Desktop Pet")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    overlay.set_position(area.position)?;
    overlay.set_size(area.size)?;
    overlay.set_ignore_cursor_events(true)?; // overlay.ts turns clicks on while the cursor is over a pet
    overlay.show()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // launching a second copy just opens the Studio of the running one
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_studio(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            scan,
            list_pets,
            save_pet,
            delete_pet,
            import_sheet,
            read_file,
            read_pet_file,
            open_studio,
            quit
        ])
        .setup(|app| {
            create_overlay(app.handle())?;
            let open = MenuItem::with_id(app, "open", "Open Studio", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("Desktop Pet")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        let _ = show_studio(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let _ = show_studio(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
