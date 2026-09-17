use std::{sync::{Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}, io::Write, thread};
use serde::Serialize;
use tauri::{Manager, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use crate::Desktop;

#[derive(Default)]
pub struct Pending(Mutex<UpdateState>, AtomicBool);
struct InstallGuard<'a>(&'a AtomicBool);
impl Drop for InstallGuard<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
pub fn installing(app: &tauri::AppHandle) -> bool { app.state::<Pending>().1.load(Ordering::SeqCst) }
#[derive(Default)]
struct UpdateState { update: Option<Update>, bytes: Option<Vec<u8>>, busy: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata { configured: bool, version: Option<String>, message: String, notes: Option<String> }

fn config() -> Result<Option<(String, reqwest::Url)>, String> {
    let key = option_env!("CODEX_UPDATER_PUBLIC_KEY").unwrap_or(include_str!("../updater-public-key.txt")).trim();
    let endpoint = option_env!("CODEX_UPDATER_ENDPOINT").unwrap_or("https://github.com/dhruv2003/CODEX-CLI-API/releases/latest/download/latest.json").trim();
    if key.is_empty() || endpoint.is_empty() { return Ok(None); }
    let url = reqwest::Url::parse(endpoint).map_err(|_| "Invalid update endpoint")?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() { return Err("Updates require an HTTPS endpoint without credentials.".into()); }
    Ok(Some((key.into(), url)))
}

#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<Metadata, String> {
    let Some((key, endpoint)) = config()? else { return Ok(Metadata { configured: false, version: None, notes: None, message: "Automatic updates are not configured for this build. Install a published release manually.".into() }); };
    {
        let state = app.state::<Pending>(); let mut state = state.0.lock().map_err(|_| "Update state unavailable")?;
        if state.busy { return Err("An update operation is already running.".into()); }
        state.busy = true; state.update = None; state.bytes = None;
    }
    let result = async {
        app.updater_builder().pubkey(key).timeout(Duration::from_secs(30)).endpoints(vec![endpoint]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())
    }.await;
    let state = app.state::<Pending>(); let mut state = state.0.lock().map_err(|_| "Update state unavailable")?;
    state.busy = false;
    let update = result?;
    let version = update.as_ref().map(|u| u.version.clone());
    let notes = update.as_ref().and_then(|u| u.body.clone());
    state.update = update; state.bytes = None;
    Ok(Metadata { configured: true, message: if version.is_some() { "Update available" } else { "You are up to date" }.into(), version, notes })
}

#[tauri::command]
pub async fn download_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = {
        let state = app.state::<Pending>(); let mut state = state.0.lock().map_err(|_| "Update state unavailable")?;
        if state.busy { return Err("An update operation is already running.".into()); }
        let update = state.update.clone().ok_or("Check for an update first.")?;
        state.busy = true; state.bytes = None; update
    };
    let mut downloaded = 0u64;
    let result = update.download(|chunk, total| {
        downloaded += chunk as u64;
        let _ = app.emit("update-progress", serde_json::json!({"downloaded":downloaded,"total":total}));
    }, || {}).await.map_err(|e| e.to_string());
    let state = app.state::<Pending>(); let mut state = state.0.lock().map_err(|_| "Update state unavailable")?;
    state.busy = false; state.bytes = Some(result?); Ok(())
}

// Admission is closed by the owned gateway before shutdown. A timeout fails
// installation; it never force-kills active work or deletes application data.
fn prepare_gateway(desktop: &mut Desktop) -> Result<(), String> {
    if !desktop.status().running { return Ok(()); }
    let gateway = desktop.gateway.as_mut().ok_or("Gateway unavailable")?;
    let token = gateway.url.split("#desktopToken=").nth(1).ok_or("Gateway token unavailable")?;
    let base = format!("http://127.0.0.1:{}", desktop.settings.port);
    let client = reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let result: Result<(), String> = (|| {
        let response = client.post(format!("{base}/admin/prepare-update")).header("X-Codex-Desktop-Token", token).header("X-Codex-Admin", "local").json(&serde_json::json!({})).send().map_err(|e| format!("Could not confirm idle gateway: {e}"))?;
        if !response.status().is_success() { return Err("Finish all active requests and account sign-ins before installing an update.".into()); }
        let ready: serde_json::Value = response.json().map_err(|_| "Invalid gateway update response")?;
        if ready["ready"] != true { return Err("Gateway did not confirm update readiness.".into()); }
        gateway.child.stdin.as_mut().ok_or("Gateway shutdown channel unavailable")?.write_all(b"shutdown\n").map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if gateway.child.try_wait().map_err(|e| e.to_string())?.is_some() { return Ok(()); }
            thread::sleep(Duration::from_millis(50));
        }
        Err("Gateway has not stopped safely. Update was not installed; try again after it stops.".into())
    })();
    if result.is_err() { let _ = client.post(format!("{base}/admin/cancel-update")).header("X-Codex-Desktop-Token", token).header("X-Codex-Admin", "local").json(&serde_json::json!({})).send(); }
    result?; desktop.gateway = None; Ok(())
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, confirmed: bool) -> Result<(), String> {
    if !confirmed { return Err("Confirm installation before continuing.".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let pending = app.state::<Pending>(); let mut pending = pending.0.lock().map_err(|_| "Update state unavailable")?;
        if pending.busy { return Err("An update operation is already running.".into()); }
        let update = pending.update.as_ref().ok_or("Check for an update first.")?;
        let bytes = pending.bytes.as_ref().ok_or("Download the update first.")?;
        let install_state = app.state::<Pending>();
        install_state.1.store(true, Ordering::SeqCst);
        let guard = InstallGuard(&install_state.1);
        let desktop = app.state::<Mutex<Desktop>>(); let mut desktop = desktop.lock().map_err(|_| "App state unavailable")?;
        let was_running = desktop.status().running;
        prepare_gateway(&mut desktop)?;
        drop(desktop);
        let result = update.install(bytes);
        let desktop_state = app.state::<Mutex<Desktop>>();
        let mut desktop = desktop_state.lock().map_err(|_| "App state unavailable")?;
        if let Err(e) = result {
            let recovery = if was_running { desktop.start().err().map(|e| format!(" Gateway restart also failed: {e}")).unwrap_or_default() } else { String::new() };
            return Err(format!("Update could not be installed: {e}.{recovery}"));
        }
        pending.bytes = None;
        drop(desktop); drop(pending); drop(guard);
        app.restart();
    }).await.map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{io::Read, net::TcpListener, process::{Command, Stdio}, path::PathBuf};
    use crate::{Settings, Gateway};

    fn fixture(response: &'static str, cancel: bool) -> (Desktop, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            for path in if cancel { vec!["prepare-update", "cancel-update"] } else { vec!["prepare-update"] } {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = vec![]; let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); request.push(byte[0]); }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with(&format!("post /admin/{path} ")));
                assert!(request.contains("x-codex-desktop-token: fixture-token"));
                assert!(request.contains("x-codex-admin: local"));
                let mut body_bytes = [0; 2]; stream.read_exact(&mut body_bytes).unwrap();
                assert_eq!(&body_bytes, b"{}");
                let body = if path == "cancel-update" { "{}" } else { response };
                let status = if response == "busy" && path == "prepare-update" { "409 Conflict" } else { "200 OK" };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let child = Command::new("/bin/sh").args(["-c", "read line; test \"$line\" = shutdown"]).stdin(Stdio::piped()).spawn().unwrap();
        let settings = Settings { workspace_root: String::new(), port, launch_at_login: false, keep_running_on_close: false };
        (Desktop { settings, data_dir: PathBuf::new(), runtime: PathBuf::new(), gateway: Some(Gateway { child, url: format!("http://127.0.0.1:{port}/#desktopToken=fixture-token") }), error: None }, server)
    }

    #[test]
    fn busy_or_malformed_gateway_stays_running_and_is_unpaused() {
        for response in ["busy", "not json", r#"{"ready":false}"#] {
            let (mut desktop, server) = fixture(response, true);
            assert!(prepare_gateway(&mut desktop).is_err());
            assert!(desktop.gateway.as_mut().unwrap().child.try_wait().unwrap().is_none());
            desktop.gateway.as_mut().unwrap().child.kill().unwrap();
            desktop.gateway.as_mut().unwrap().child.wait().unwrap();
            server.join().unwrap();
        }
    }

    #[test]
    fn ready_gateway_exits_before_install_can_proceed() {
        let (mut desktop, server) = fixture(r#"{"ready":true}"#, false);
        prepare_gateway(&mut desktop).unwrap();
        assert!(desktop.gateway.is_none());
        server.join().unwrap();
    }
}
