const $ = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let state = { running: false, dashboardUrl: null, settings: { workspaceRoot: "", port: 3081 } };
let busy = false;
let refreshPending = false;
function showError(error) { $("error").textContent = error?.message || String(error); $("error").hidden = false; }
function render(next) {
  state = next;
  $("workspace").value = next.settings.workspaceRoot;
  $("port").value = String(next.settings.port);
  $("launch-at-login").checked = Boolean(next.settings.launchAtLogin);
  $("keep-running").checked = Boolean(next.settings.keepRunningOnClose);
  $("health-workspace").textContent = `Workspace: ${next.health?.workspace || "Choose a workspace"}`;
  $("health-runtime").textContent = `Bundled runtime: ${next.health?.runtime || "Checking"}`;
  $("health-port").textContent = `Port ${next.settings.port}: ${next.health?.port || "Checking"}`;
  $("data-dir").textContent = next.dataDir || "Managed by this app";
  $("status").textContent = next.running ? `Running · localhost:${next.settings.port}` : "Gateway stopped";
  $("stop").hidden = $("restart").hidden = !next.running;
  $("settings-toggle").hidden = false;
  $(next.running ? 'settings-content' : 'first-run-host').append($('onboarding'));
  $("onboarding").hidden = false;
  $('first-run-host').hidden = next.running;
  $("restart-hint").hidden = !next.running;
  $("start").textContent = next.running ? "Save & restart gateway" : "Save & start gateway";
  document.body.classList.toggle("connected", next.running);
  // The dashboard is untrusted web content and receives no Tauri bridge.
  const frame = $("dashboard");
  if (next.running && next.dashboardUrl) {
    const url = new URL(next.dashboardUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(next.settings.port)) throw new Error("Gateway returned an unexpected dashboard address.");
    if (frame.getAttribute("src") !== next.dashboardUrl) frame.src = next.dashboardUrl;
    frame.hidden = false;
  } else { frame.hidden = true; frame.removeAttribute("src"); }
  if (next.error) showError(next.error);
}
async function action(fn) {
  if (busy) return;
  busy = true; $("error").hidden = true;
  document.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try { await fn(); } catch (error) {
    showError(error);
    try { render(await invoke("desktop_status")); } catch { /* Keep the original actionable error. */ }
    $("onboarding").hidden = false;
  } finally {
    busy = false; document.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    if (refreshPending) { refreshPending = false; void action(async () => render(await invoke("desktop_status"))); }
  }
}
$("choose").addEventListener("click", () => action(async () => { const path = await invoke("choose_workspace"); if (path) $("workspace").value = path; }));
function openSettings() { if (!$('settings-drawer').open) $('settings-drawer').showModal(); }
$("settings-toggle").addEventListener("click", openSettings);
$('close-settings').addEventListener('click', () => $('settings-drawer').close());
$('settings-drawer').addEventListener('close', () => $('settings-toggle').focus());
$('update-notice').addEventListener('click', openSettings);
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = { workspaceRoot: $("workspace").value.trim(), port: Number($("port").value), launchAtLogin: $("launch-at-login").checked, keepRunningOnClose: $("keep-running").checked };
  if (!settings.workspaceRoot || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) { showError("Choose a workspace and a port between 1024 and 65535."); return; }
  void action(async () => {
    if (state.running) render(await invoke("stop_gateway"));
    await invoke("save_settings", { settings });
    render(await invoke("start_gateway"));
    $('settings-drawer').close();
  });
});
$("stop").addEventListener("click", () => action(async () => render(await invoke("stop_gateway"))));
$("restart").addEventListener("click", () => action(async () => { render(await invoke("stop_gateway")); render(await invoke("start_gateway")); }));
$("creator-site").addEventListener("click", () => action(async () => { await invoke("open_creator_website"); }));
$("save-preferences").addEventListener("click", () => action(async () => {
  render(await invoke("save_preferences", { launchAtLogin: $("launch-at-login").checked, keepRunningOnClose: $("keep-running").checked }));
}));
async function checkUpdate() {
  $("download-update").hidden = $("install-update").hidden = $("update-confirmation").hidden = true;
  $('update-details').hidden = true;
  try {
  const result = await invoke("check_for_update");
  $("update-status").textContent = result.version ? `${result.message}: ${result.version}` : result.message;
  $("update-notes").textContent = result.notes || "";
  $("update-notes").hidden = !result.notes;
  $("download-update").hidden = !result.version;
  $('update-notice').hidden = !result.version;
  } catch (error) {
    $('update-notice').hidden = true;
    $('update-status').textContent = "Update information isn’t available yet. You can keep using the app and check again later.";
    $('update-error-detail').textContent = error?.message || String(error);
    $('update-details').hidden = false;
  }
}
$("check-update").addEventListener("click", () => action(checkUpdate));
$("download-update").addEventListener("click", () => action(async () => {
  $("update-status").textContent = "Downloading and verifying update…";
  await invoke("download_update");
  $("update-status").textContent = "Verified update ready to install.";
  $("download-update").hidden = true; $("install-update").hidden = false;
}));
$("install-update").addEventListener("click", () => { $("update-confirmation").hidden = false; });
$("cancel-install").addEventListener("click", () => { $("update-confirmation").hidden = true; });
$("confirm-install").addEventListener("click", () => action(async () => {
  $("update-confirmation").hidden = true;
  await invoke("install_update", { confirmed: true });
}));
if (window.__TAURI__?.event?.listen) {
  void window.__TAURI__.event.listen("desktop-changed", () => { if (busy) refreshPending = true; else void action(async () => render(await invoke("desktop_status"))); });
  void window.__TAURI__.event.listen("update-progress", ({ payload }) => {
    $("update-status").textContent = payload.total ? `Downloading: ${Math.round(payload.downloaded / payload.total * 100)}%` : `Downloading: ${Math.round(payload.downloaded / 1024)} KB`;
  });
}
window.addEventListener("message", (event) => {
  if (!state.running || !state.dashboardUrl || event.source !== $("dashboard").contentWindow) return;
  if (event.origin !== new URL(state.dashboardUrl).origin) return;
  if (!event.data || event.data.type !== "codex-desktop-open-login" || Object.keys(event.data).length !== 1) return;
  // No URL or command is accepted from web content: Rust opens one fixed auth URL.
  void action(async () => { await invoke("open_codex_login"); });
});
void action(async () => {
  if (!window.__TAURI__?.core?.invoke) throw new Error("Open this screen from the Codex CLI API desktop app.");
  render(await invoke("desktop_status"));
  if (!state.running && state.settings.workspaceRoot && !state.error) render(await invoke("start_gateway"));
  void checkUpdate();
});
