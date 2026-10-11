//! Desktop Pet: one transparent overlay window that the pets live in (drawn by overlay.ts),
//! a Studio window for managing pets, a tray icon, and a pet library in %APPDATA%.

use std::fs;
use std::path::PathBuf;

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use tauri::ipc::Response;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod packaged;
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
    let name = format!("sheet-{}.{}", stamp()?, safe_name(&ext)?);
    fs::copy(&path, dir.join(&name)).map_err(|e| e.to_string())?;
    Ok(name)
}

fn stamp() -> Result<u128, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis())
}

/// Marks a .deskpet file: JSON holding the pet definition and its sheets, base64-encoded.
const PET_FILE_FORMAT: &str = "desktop-pet";
const NOT_A_PET_FILE: &str = "This isn't a Desktop Pet file, or it's damaged.";

/// Save a pet and its sprite sheets as one file that can be sent to someone else.
#[tauri::command]
fn export_pet(app: AppHandle, id: String, path: String) -> Result<(), String> {
    let dir = pets_dir(&app)?.join(safe_name(&id)?);
    let json = fs::read_to_string(dir.join("pet.json")).map_err(|e| e.to_string())?;
    let mut pet: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let mut files = serde_json::Map::new();
    for (i, sheet) in pet["sheets"].as_array_mut().into_iter().flatten().enumerate() {
        let file = sheet["file"].as_str().ok_or("a sheet has no file")?.to_string();
        let bytes = if sheet["builtin"].as_bool() == Some(true) {
            // built-in sheets are bundled inside the app, not in the pet's folder
            app.asset_resolver()
                .get(format!("builtin/{file}"))
                .ok_or(format!("missing built-in sheet {file}"))?
                .bytes
        } else {
            fs::read(dir.join(safe_name(&file)?)).map_err(|e| e.to_string())?
        };
        let ext = file.rsplit('.').next().unwrap_or("png");
        let name = format!("sheet-{}.{}", i + 1, safe_name(ext)?);
        files.insert(name.clone(), BASE64.encode(bytes).into());
        sheet["file"] = name.into();
        if let Some(sheet) = sheet.as_object_mut() {
            sheet.remove("builtin");
        }
    }
    if let Some(pet) = pet.as_object_mut() {
        pet.remove("id");
        pet.remove("enabled");
    }
    let bundle = json!({ "format": PET_FILE_FORMAT, "version": 1, "pet": pet, "files": files });
    fs::write(path, bundle.to_string()).map_err(|e| e.to_string())
}

/// Add the pet in a .deskpet file to the library, switched on; returns its new id.
#[tauri::command]
fn import_pet(app: AppHandle, path: String) -> Result<String, String> {
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let bundle: Value = serde_json::from_str(&text).map_err(|_| NOT_A_PET_FILE)?;
    let mut pet = bundle["pet"].clone();
    if bundle["format"] != PET_FILE_FORMAT || !pet["name"].is_string() || !pet["sheets"].is_array() {
        return Err(NOT_A_PET_FILE.into());
    }
    let id = format!("pet-{}", stamp()?);
    let dir = pets_dir(&app)?.join(&id);
    let write_all = || -> Result<(), String> {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for sheet in pet["sheets"].as_array().into_iter().flatten() {
            let file = safe_name(sheet["file"].as_str().ok_or(NOT_A_PET_FILE)?)?;
            let data = bundle["files"][file].as_str().ok_or(NOT_A_PET_FILE)?;
            let bytes = BASE64.decode(data).map_err(|_| NOT_A_PET_FILE)?;
            fs::write(dir.join(file), bytes).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    if let Err(e) = write_all() {
        let _ = fs::remove_dir_all(&dir); // don't leave half a pet behind
        return Err(e);
    }
    pet["id"] = id.clone().into();
    pet["enabled"] = true.into();
    fs::write(dir.join("pet.json"), pet.to_string()).map_err(|e| e.to_string())?;
    Ok(id)
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

/// Import the .deskpet files the app was opened with (double-clicked, or dropped onto the .exe),
/// then show the Studio with the new pets.
fn open_pet_files(app: &AppHandle, args: &[String]) {
    let files: Vec<&String> = args.iter().filter(|a| a.to_lowercase().ends_with(".deskpet")).collect();
    if files.is_empty() {
        return;
    }
    for path in files {
        if let Err(e) = import_pet(app.clone(), path.clone()) {
            app.dialog().message(e).title("Import pet").kind(MessageDialogKind::Error).show(|_| {});
        }
    }
    let _ = app.emit("library-changed", ());
    let _ = show_studio(app);
}

/// Is "Start with Windows" on? The Store version uses its startup task, the plain .exe the registry.
#[tauri::command]
async fn get_autostart(app: AppHandle) -> Result<bool, String> {
    match packaged::startup_task() {
        Some(task) => packaged::is_enabled(&task),
        None => app.autolaunch().is_enabled().map_err(|e| e.to_string()),
    }
}

/// Turn "Start with Windows" on or off; returns the resulting state.
#[tauri::command]
async fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if let Some(task) = packaged::startup_task() {
        return packaged::set_enabled(&task, enabled);
    }
    let autolaunch = app.autolaunch();
    let result = if enabled { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|e| e.to_string())?;
    autolaunch.is_enabled().map_err(|e| e.to_string())
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
        // launching a second copy opens the running one's Studio, importing any .deskpet it was given
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            open_pet_files(app, &args);
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
            export_pet,
            import_pet,
            get_autostart,
            set_autostart,
            read_file,
            read_pet_file,
            open_studio,
            quit
        ])
        .setup(|app| {
            create_overlay(app.handle())?;
            open_pet_files(app.handle(), &std::env::args().collect::<Vec<_>>());
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
