#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::{fs, io::{BufRead, BufReader, Write}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{mpsc, Mutex}, thread, time::{Duration, Instant}};
use tauri::Manager;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings { workspace_root: String, port: u16 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status { running: bool, dashboard_url: Option<String>, settings: Settings, data_dir: String, error: Option<String> }

struct Gateway { child: Child, url: String }
struct Desktop { settings: Settings, data_dir: PathBuf, runtime: PathBuf, gateway: Option<Gateway>, error: Option<String> }

fn validate_settings(settings: &Settings, data_dir: &Path) -> Result<Settings, String> {
    if settings.port < 1024 { return Err("Choose a port between 1024 and 65535.".into()); }
    let workspace = Path::new(&settings.workspace_root);
    if !workspace.is_absolute() || !workspace.is_dir() { return Err("Choose an existing absolute workspace folder.".into()); }
    // Keep Windows drive paths usable by Node, the folder picker and onboarding.
    let workspace = dunce::canonicalize(workspace).map_err(|e| e.to_string())?;
    let data = dunce::canonicalize(data_dir).map_err(|e| e.to_string())?;
    if workspace.starts_with(&data) || data.starts_with(&workspace) { return Err("Workspace must not contain the app's private data folder or be inside it.".into()); }
    Ok(Settings { workspace_root: workspace.to_string_lossy().into_owned(), port: settings.port })
}

fn protect_existing_key_scopes(current: &Settings, next: &Settings, data_dir: &Path) -> Result<(), String> {
    // API-key workspace scopes are relative to this root. Reinterpreting them
    // beneath another root would silently grant access to different files.
    let current_root = Path::new(&current.workspace_root).canonicalize().ok();
    let next_root = Path::new(&next.workspace_root).canonicalize().ok();
    if current_root.is_some() && current_root == next_root { return Ok(()); }
    let message = "Existing API keys are bound to the current workspace. Keep that workspace (port can change); use a separate setup for another root.";
    let bytes = match fs::read(data_dir.join("api-keys.json")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(format!("Cannot safely read the API-key store. {message}")),
    };
    let keys: Vec<serde_json::Value> = serde_json::from_slice(&bytes)
        .map_err(|_| format!("Cannot safely read the API-key store. {message}"))?;
    if keys.is_empty() { Ok(()) } else { Err(message.into()) }
}

impl Desktop {
    fn status(&mut self) -> Status {
        if let Some(gateway) = self.gateway.as_mut() {
            match gateway.child.try_wait() {
                Ok(Some(exit)) => { self.error = Some(format!("Gateway stopped ({exit}). Start it again.")); self.gateway = None; }
                Err(e) => self.error = Some(format!("Cannot check gateway: {e}")),
                _ => {}
            }
        }
        Status { running: self.gateway.is_some(), dashboard_url: self.gateway.as_ref().map(|g| g.url.clone()), settings: self.settings.clone(), data_dir: self.data_dir.to_string_lossy().into_owned(), error: self.error.clone() }
    }

    fn stop(&mut self) {
        if let Some(mut gateway) = self.gateway.take() {
            if let Some(mut input) = gateway.child.stdin.take() { let _ = input.write_all(b"shutdown\n"); }
            let deadline = Instant::now() + Duration::from_secs(15);
            while Instant::now() < deadline {
                if matches!(gateway.child.try_wait(), Ok(Some(_))) { return; }
                thread::sleep(Duration::from_millis(50));
            }
            terminate_tree(&mut gateway.child);
        }
    }

    fn start(&mut self) -> Result<Status, String> {
        if self.status().running { return Ok(self.status()); }
        self.settings = validate_settings(&self.settings, &self.data_dir)?;
        let node = self.runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
        let codex = self.runtime.join("codex/bin").join(if cfg!(windows) { "codex.exe" } else { "codex" });
        let entry = self.runtime.join("gateway.mjs");
        if !node.is_file() || !codex.is_file() || !entry.is_file() { return Err("The packaged runtime is missing. Reinstall the app (developers: run desktop:prepare).".into()); }
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut command = Command::new(node);
        let mut paths = vec![self.runtime.join("codex/codex-path")];
        if let Some(existing) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&existing)); }
        command.env("PATH", std::env::join_paths(paths).map_err(|e| e.to_string())?);
        command.arg(entry).arg("--desktop").current_dir(&self.data_dir)
            .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
            .env("CODEX_DESKTOP_DATA_DIR", &self.data_dir)
            .env("CODEX_DESKTOP_WORKSPACE_ROOT", &self.settings.workspace_root)
            .env("CODEX_DESKTOP_PORT", self.settings.port.to_string())
            .env("CODEX_DESKTOP_TOKEN", &token)
            .env("CODEX_DESKTOP_CODEX_COMMAND", codex)
            .env("CODEX_DESKTOP_PUBLIC_DIR", self.runtime.join("public"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e| format!("Could not launch the bundled runtime: {e}"))?;
        let output = child.stdout.take().ok_or("Gateway output is unavailable")?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            // Continue draining after ready so ordinary request logs cannot block the server.
            for line in BufReader::new(output).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if value["event"] == "desktop_ready" { let _ = tx.send(value["port"].as_u64()); }
                }
            }
        });
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Some(port)) if port == u64::from(self.settings.port) => {
                self.gateway = Some(Gateway { child, url: format!("http://127.0.0.1:{port}/#desktopToken={token}") });
                self.error = None;
                Ok(self.status())
            }
            _ => {
                terminate_tree(&mut child);
                Err(format!("Gateway could not start on port {}. The port may be in use; choose another port in Settings.", self.settings.port))
            }
        }
    }
}

fn terminate_tree(child: &mut Child) {
    #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill.exe").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x08000000).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
async fn desktop_status(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Desktop>>();
        let mut desktop = state.lock().map_err(|_| "App state unavailable")?;
        Ok(desktop.status())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_settings(settings: Settings, app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
    let state = app.state::<Mutex<Desktop>>();
    let mut desktop = state.lock().map_err(|_| "App state unavailable")?;
    if desktop.status().running { return Err("Stop the gateway before changing settings.".into()); }
    let settings = validate_settings(&settings, &desktop.data_dir)?;
    protect_existing_key_scopes(&desktop.settings, &settings, &desktop.data_dir)?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(desktop.data_dir.join("settings.json"), bytes).map_err(|e| format!("Could not save settings: {e}"))?;
    desktop.settings = settings;
    desktop.error = None;
    Ok(desktop.status())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_gateway(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Desktop>>();
        let mut desktop = state.lock().map_err(|_| "App state unavailable")?;
        desktop.start()
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stop_gateway(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Mutex<Desktop>>();
        let mut desktop = state.lock().map_err(|_| "App state unavailable")?;
        desktop.stop(); desktop.error = None; Ok(desktop.status())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn choose_workspace() -> Result<Option<String>, String> {
    Ok(rfd::AsyncFileDialog::new().set_title("Choose your workspace folder").pick_folder().await.map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn open_codex_login() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| open::that("https://auth.openai.com/codex/device").map_err(|e| format!("Could not open the sign-in page: {e}")))
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_creator_website() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| open::that("https://thisisdhruv.in").map_err(|e| format!("Could not open the creator website: {e}")))
        .await.map_err(|e| e.to_string())?
}

fn main() {
    let app = tauri::Builder::default()
      .plugin(tauri_plugin_single_instance::init(|app, _, _| {
          if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
      }))
      .setup(|app| {
        let data_dir = app.path().app_data_dir()?;
        fs::create_dir_all(&data_dir)?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700))?; }
        let mut error = None;
        let settings = match fs::read(data_dir.join("settings.json")) {
            Ok(bytes) => match serde_json::from_slice::<Settings>(&bytes) {
                Ok(value) => value,
                Err(_) => { error = Some("Saved settings could not be read. Choose a workspace and save settings again.".into()); Settings { workspace_root: String::new(), port: 3081 } }
            },
            Err(_) => Settings { workspace_root: String::new(), port: 3081 },
        };
        let runtime = if cfg!(debug_assertions) { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../desktop-runtime") } else { app.path().resource_dir()?.join("runtime") };
        app.manage(Mutex::new(Desktop { settings, data_dir, runtime, gateway: None, error }));
        Ok(())
    }).invoke_handler(tauri::generate_handler![desktop_status, save_settings, start_gateway, stop_gateway, choose_workspace, open_codex_login, open_creator_website])
      .build(tauri::generate_context!()).expect("Unable to initialize Codex CLI API desktop");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            if let Ok(mut desktop) = app.state::<Mutex<Desktop>>().lock() { desktop.stop(); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_keys_lock_workspace_but_allow_port_changes() {
        let root = std::env::temp_dir().join(format!("codex-scope-test-{}", rand::random::<u64>()));
        let data = root.join("private"); let first = root.join("first"); let second = root.join("second");
        for path in [&data, &first, &second] { fs::create_dir_all(path).unwrap(); }
        let setting = |path: &Path, port| Settings { workspace_root: path.to_string_lossy().into_owned(), port };
        let current = setting(&first, 3081); let changed = setting(&second, 3081);
        assert!(protect_existing_key_scopes(&current, &changed, &data).is_ok());
        let store = data.join("api-keys.json");
        fs::write(&store, "[{\"id\":\"existing-key\"}]").unwrap();
        assert!(protect_existing_key_scopes(&current, &changed, &data).is_err());
        assert!(protect_existing_key_scopes(&current, &setting(&first, 3082), &data).is_ok());
        fs::write(&store, "invalid json").unwrap();
        assert!(protect_existing_key_scopes(&current, &changed, &data).is_err());
        fs::write(&store, "{}").unwrap();
        assert!(protect_existing_key_scopes(&current, &changed, &data).is_err());
        fs::write(&store, "[]").unwrap();
        assert!(protect_existing_key_scopes(&current, &changed, &data).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_relative_missing_and_credential_overlap() {
        let root = std::env::temp_dir().join(format!("codex-desktop-test-{}", rand::random::<u64>()));
        let data = root.join("private"); let workspace = root.join("workspace");
        fs::create_dir_all(&data).unwrap(); fs::create_dir_all(&workspace).unwrap();
        let setting = |path: &Path, port| Settings { workspace_root: path.to_string_lossy().into_owned(), port };
        assert!(validate_settings(&setting(&workspace, 3081), &data).is_ok());
        assert!(validate_settings(&setting(Path::new("relative"), 3081), &data).is_err());
        assert!(validate_settings(&setting(&data, 3081), &data).is_err());
        assert!(validate_settings(&setting(&root, 3081), &data).is_err());
        assert!(validate_settings(&setting(&workspace, 80), &data).is_err());
        assert!(validate_settings(&setting(&root.join("missing"), 3081), &data).is_err());
        #[cfg(unix)] {
            let alias = root.join("private-alias");
            std::os::unix::fs::symlink(&data, &alias).unwrap();
            assert!(validate_settings(&setting(&alias, 3081), &data).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }
}
