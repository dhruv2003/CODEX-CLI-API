const $ = (id) => document.getElementById(id);
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
let state = { running: false, dashboardUrl: null, settings: { workspaceRoot: "", port: 3081 } };
let busy = false;
let refreshPending = false;
let initialSetup = true;
let dashboardReady = false;
let pendingNavigation = null;
let frameUrl = null;
let models = [];
const defaultsKey = "codex-desktop-ui-defaults";
const views = new Set(["overview", "api-keys", "connect", "requests", "diagnostics", "settings", "onboarding"]);
const recordWithKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const boundedString = (value, max, allowEmpty = false) => typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
let defaults = { model: "", reasoning: "" };
let theme = "light";
try { if (localStorage.getItem("codex-ui-theme") === "dark") theme = "dark"; } catch { /* Use light when storage is unavailable. */ }
function applyTheme(next, persist = true) {
  theme = next;
  document.documentElement.dataset.theme = theme;
  $("native-theme-light").setAttribute("aria-pressed", String(theme === "light"));
  $("native-theme-dark").setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) { try { localStorage.setItem("codex-ui-theme", theme); } catch { /* Keep the selected theme for this session. */ } }
}
applyTheme(theme, false);
for (const choice of ["light", "dark"]) $("native-theme-" + choice).addEventListener("click", () => {
  applyTheme(choice);
  sendDashboard({ type: "codex-desktop-theme", theme });
});
try {
  const saved = JSON.parse(localStorage.getItem(defaultsKey));
  if (recordWithKeys(saved, ["model", "reasoning"]) && boundedString(saved.model, 128, true) && boundedString(saved.reasoning, 64, true)) defaults = saved;
} catch { /* Storage may be unavailable; defaults remain session-only until Save. */ }
function sendDashboard(message) {
  if (state.running && state.dashboardUrl) $("dashboard").contentWindow?.postMessage(message, new URL(state.dashboardUrl).origin);
}
function sendDefaults() {
  if (dashboardReady) sendDashboard({ type: "codex-desktop-defaults", model: defaults.model, reasoning: defaults.reasoning });
}
function syncControls() {
  document.querySelectorAll("button").forEach((button) => { button.disabled = busy || button.hasAttribute("data-setup-nav"); });
  $("open-diagnostics").disabled = busy || !state.running;
  $("save-defaults").disabled = busy || !models.length;
}
function renderReasoning(preferred = defaults.reasoning) {
  const efforts = models.find((model) => model.id === $("default-model").value)?.efforts || [];
  $("default-reasoning").replaceChildren(new Option("Model default", ""), ...efforts.map((effort) => new Option(effort, effort)));
  $("default-reasoning").value = efforts.includes(preferred) ? preferred : "";
  $("default-reasoning").disabled = !efforts.length;
}
function renderModels() {
  const preferred = $("default-model").value || defaults.model;
  $("default-model").replaceChildren(new Option(models.length ? "Gateway default" : "Waiting for model catalog", ""), ...models.map((model) => new Option(model.id, model.id)));
  $("default-model").value = models.some((model) => model.id === preferred) ? preferred : "";
  $("default-model").disabled = !models.length;
  renderReasoning();
  syncControls();
}
function placeWorkspaceForm() {
  const settingsOpen = !$("settings-panel").hidden;
  $(settingsOpen ? "settings-content" : "workspace-host").append($("settings-form"));
  $("workspace-title").textContent = settingsOpen ? "Workspace & port" : "1. Choose your workspace";
  $("workspace-advanced").open = settingsOpen;
  $("first-run-host").hidden = settingsOpen || state.running;
  $("close-settings").textContent = state.running ? "Back to overview" : "Back to setup";
}
function showError(error) { $("error").textContent = error?.message || String(error); $("error").hidden = false; }
function render(next) {
  // Validate the destination before changing state or exposing a frame.
  if (next.running && next.dashboardUrl) {
    const url = new URL(next.dashboardUrl);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== String(next.settings.port) || url.username || url.password) throw new Error("Gateway returned an unexpected dashboard address.");
  }
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
  $("sidebar-status").textContent = next.settings.workspaceRoot ? "Gateway stopped" : "Setup required";
  placeWorkspaceForm();
  $("restart-hint").hidden = !next.running;
  $("start").textContent = next.running ? "Save & restart gateway" : "Save & start gateway";
  document.body.classList.toggle("connected", next.running);
  // The dashboard is untrusted web content and receives no Tauri bridge.
  let frame = $("dashboard");
  if (next.running && next.dashboardUrl) {
    if (frameUrl !== next.dashboardUrl) {
      dashboardReady = false;
      models = []; renderModels();
      frameUrl = next.dashboardUrl;
      const url = new URL(next.dashboardUrl);
      if (initialSetup) {
        const hash = new URLSearchParams(url.hash.slice(1));
        hash.set("view", "onboarding"); hash.set("step", "2");
        url.hash = hash.toString();
      }
      // Stopping navigates the old frame to about:blank. A fast restart with
      // only a new token/hash can race that navigation. Insert a fresh browsing
      // context with its final URL so the old blank navigation cannot win.
      const replacement = frame.cloneNode(false);
      replacement.src = url.href;
      frame.replaceWith(replacement);
      frame = replacement;
    }
    frame.hidden = false;
  } else { frame.hidden = true; frame.removeAttribute("src"); frameUrl = null; dashboardReady = false; pendingNavigation = null; models = []; renderModels(); }
  syncControls();
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
    busy = false; syncControls();
    if (refreshPending) { refreshPending = false; void action(async () => render(await invoke("desktop_status"))); }
  }
}
$("choose").addEventListener("click", () => action(async () => { const path = await invoke("choose_workspace"); if (path) $("workspace").value = path; }));
function openSettings() {
  $("settings-panel").hidden = false;
  document.body.classList.add("settings-open");
  placeWorkspaceForm();
  $("settings-title").focus({ preventScroll: true });
}
function closeSettings(view) {
  $("settings-panel").hidden = true;
  document.body.classList.remove("settings-open");
  placeWorkspaceForm();
  if (view && state.running) {
    const navigation = { type: "codex-desktop-navigate", view, ...(view === "onboarding" ? { step: 2 } : {}) };
    if (dashboardReady) sendDashboard(navigation);
    else pendingNavigation = navigation;
  }
  if (state.running) $("dashboard").focus(); else $("settings-toggle").focus();
}
$("settings-toggle").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", () => closeSettings("overview"));
$("open-diagnostics").addEventListener("click", () => closeSettings("diagnostics"));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("settings-panel").hidden) closeSettings("overview"); });
$('update-notice').addEventListener('click', openSettings);
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const settings = { workspaceRoot: $("workspace").value.trim(), port: Number($("port").value), launchAtLogin: $("launch-at-login").checked, keepRunningOnClose: $("keep-running").checked };
  if (!settings.workspaceRoot || !Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) { showError("Choose a workspace and a port between 1024 and 65535."); return; }
  void action(async () => {
    if (state.running) render(await invoke("stop_gateway"));
    await invoke("save_settings", { settings });
    render(await invoke("start_gateway"));
    // First run already carries onboarding step 2 in the URL and ready reply.
    closeSettings(initialSetup ? undefined : "overview");
  });
});
$("stop").addEventListener("click", () => action(async () => render(await invoke("stop_gateway"))));
$("restart").addEventListener("click", () => action(async () => { render(await invoke("stop_gateway")); render(await invoke("start_gateway")); }));
$("creator-site").addEventListener("click", () => action(async () => { await invoke("open_creator_website"); }));
$("save-preferences").addEventListener("click", () => action(async () => {
  render(await invoke("save_preferences", { launchAtLogin: $("launch-at-login").checked, keepRunningOnClose: $("keep-running").checked }));
}));
$("default-model").addEventListener("change", () => renderReasoning());
$("defaults-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || !models.length) return;
  const model = $("default-model").value;
  const reasoning = $("default-reasoning").value;
  if (model && !models.some((entry) => entry.id === model && (!reasoning || entry.efforts.includes(reasoning)))) return;
  try {
    const next = { model, reasoning };
    localStorage.setItem(defaultsKey, JSON.stringify(next));
    defaults = next;
    sendDefaults();
    $("defaults-status").textContent = "Defaults saved.";
  } catch { showError("Could not save defaults in this app. Check that local storage is available."); }
});
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
  const data = event.data;
  if (recordWithKeys(data, ["type", "theme"]) && data.type === "codex-desktop-theme" && (data.theme === "light" || data.theme === "dark")) {
    // Incoming changes are never echoed: native storage is authoritative on ready.
    applyTheme(data.theme);
    return;
  }
  if (recordWithKeys(data, ["type", "view"]) && data.type === "codex-desktop-view" && views.has(data.view)) {
    // A reloaded dashboard reports its restored view before ready. Preserve the
    // explicit native return route until that handshake can deliver it.
    if (pendingNavigation && !dashboardReady) return;
    if (data.view === "settings") openSettings(); else { if (!$("settings-panel").hidden) closeSettings(); }
    if (data.view !== "settings" && data.view !== "onboarding") initialSetup = false;
    return;
  }
  if (recordWithKeys(data, ["type", "models"]) && data.type === "codex-desktop-models") {
    if (!Array.isArray(data.models) || data.models.length > 200) return;
    if (!data.models.every((model) => recordWithKeys(model, ["id", "efforts"]) && boundedString(model.id, 128) && Array.isArray(model.efforts) && model.efforts.length <= 32 && model.efforts.every((effort) => boundedString(effort, 64)) && new Set(model.efforts).size === model.efforts.length)) return;
    if (new Set(data.models.map((model) => model.id)).size !== data.models.length) return;
    models = data.models;
    renderModels();
    return;
  }
  if (!recordWithKeys(data, ["type"])) return;
  if (event.data.type === "codex-desktop-open-login") {
    // No URL or command is accepted from web content: Rust opens one fixed auth URL.
    void action(async () => { await invoke("open_codex_login"); });
  } else if (event.data.type === "codex-desktop-open-settings") {
    openSettings();
  } else if (data.type === "codex-desktop-ready") {
    dashboardReady = true;
    sendDefaults();
    sendDashboard({ type: "codex-desktop-theme", theme });
    if (pendingNavigation) {
      sendDashboard(pendingNavigation);
      pendingNavigation = null;
    } else if (initialSetup) sendDashboard({ type: "codex-desktop-navigate", view: "onboarding", step: 2 });
  }
});
void action(async () => {
  if (!window.__TAURI__?.core?.invoke) throw new Error("Open this screen from the Codex CLI API desktop app.");
  const next = await invoke("desktop_status");
  initialSetup = !next.settings.workspaceRoot;
  render(next);
  if (!state.running && state.settings.workspaceRoot && !state.error) render(await invoke("start_gateway"));
  void checkUpdate();
});
