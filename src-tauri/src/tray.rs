use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager, Emitter};
use crate::{Desktop, Mutex};

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start gateway", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop gateway", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &start, &stop, &quit])?;
    let mut builder = TrayIconBuilder::new().menu(&menu).tooltip("Codex CLI API");
    if let Some(icon) = app.default_window_icon() { builder = builder.icon(icon.clone()); }
    builder.on_menu_event(|app, event| {
        if crate::updates::installing(app) && event.id.as_ref() != "show" { return; }
        match event.id.as_ref() {
            "show" => { if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); } }
            "quit" => app.exit(0),
            "start" | "stop" => {
                let app = app.clone(); let start = event.id.as_ref() == "start";
                tauri::async_runtime::spawn_blocking(move || {
                    if let Ok(mut desktop) = app.state::<Mutex<Desktop>>().lock() {
                        if crate::updates::installing(&app) { return; }
                        if start { if let Err(e) = desktop.start() { desktop.error = Some(e); } } else { desktop.stop(); }
                        let _ = app.emit("desktop-changed", ());
                    }
                });
            }
            _ => {}
        }
    }).build(app)?;
    Ok(())
}
