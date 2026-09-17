use crate::{Settings, validate_settings};
use serde::Serialize;
use std::{net::TcpListener, path::Path};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health { workspace: String, runtime: String, port: String }

pub fn inspect(settings: &Settings, data: &Path, runtime: &Path, running: bool) -> Health {
    let workspace = validate_settings(settings, data).map(|_| "Ready".into()).unwrap_or_else(|e| e);
    let complete = [if cfg!(windows) { "node.exe" } else { "node" }, if cfg!(windows) { "codex/bin/codex.exe" } else { "codex/bin/codex" }, "gateway.mjs"].iter().all(|name| runtime.join(name).is_file());
    let port = if running { "Gateway running" } else if TcpListener::bind(("127.0.0.1", settings.port)).is_ok() { "Available" } else { "Unavailable: choose another port" };
    Health { workspace, runtime: if complete { "Ready" } else { "Missing: reinstall app or prepare runtime" }.into(), port: port.into() }
}
