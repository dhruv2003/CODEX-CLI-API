const $ = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let state = { running: false, dashboardUrl: null, settings: { workspaceRoot: "", port: 3081 } };
let busy = false;
function showError(error) { $("error").textContent = error?.message || String(error); $("error").hidden = false; }
function render(next) {
  state = next;
  $("workspace").value = next.settings.workspaceRoot;
  $("port").value = String(next.settings.port);
  $("data-dir").textContent = next.dataDir || "Managed by this app";
  $("status").textContent = next.running ? `Running · localhost:${next.settings.port}` : "Gateway stopped";
  $("stop").hidden = $("restart").hidden = $("settings-toggle").hidden = !next.running;
  $("onboarding").hidden = next.running;
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
  } finally { busy = false; document.querySelectorAll("button").forEach((button) => { button.disabled = false; }); }
}
$("choose").addEventListener("click", () => action(async () => { const path = await invoke("choose_workspace"); if (path) $("workspace").value = path; }));
$("settings-toggle").addEventListener("click", () => { $("onboarding").hidden = !$("onboarding").hidden; });
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = { workspaceRoot: $("workspace").value.trim(), port: Number($("port").value) };
  if (!settings.workspaceRoot || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) { showError("Choose a workspace and a port between 1024 and 65535."); return; }
  void action(async () => {
    if (state.running) render(await invoke("stop_gateway"));
    await invoke("save_settings", { settings });
    render(await invoke("start_gateway"));
  });
});
$("stop").addEventListener("click", () => action(async () => render(await invoke("stop_gateway"))));
$("restart").addEventListener("click", () => action(async () => { render(await invoke("stop_gateway")); render(await invoke("start_gateway")); }));
$("creator-site").addEventListener("click", () => action(async () => { await invoke("open_creator_website"); }));
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
});
