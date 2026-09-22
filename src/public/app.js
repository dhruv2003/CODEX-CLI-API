const endpoint = "/admin/api-keys";
const desktopTokenCandidate = new URLSearchParams(window.location.hash.slice(1)).get("desktopToken");
const desktopToken = /^[a-f0-9]{64}$/i.test(desktopTokenCandidate || "") ? desktopTokenCandidate : null;
if (desktopToken) {
  document.body.classList.add("desktop-embedded");
  document.getElementById("login-status").textContent = "Use Sign in to Codex to connect your own account. No terminal setup is needed.";
}
let adminConfig;
let setupKey = "YOUR_KEY";
let setupKeyId = "key_REPLACE_WITH_ID";
let setupConfigError = "";
let dashboardKeys = [];
let healthData;
let setupData = { models: [], keys: [] };
const secrets = new Map();
let loginTimer;
let loginGeneration = 0;
let pendingLoginKey;
const pendingTests = new Set();
const testErrors = new Map();
let requestHistory = [];
let currentView = "overview";
const views = new Set(["overview", "api-keys", "connect", "requests", "diagnostics", "settings", "onboarding"]);
const preferenceKey = "codex-dashboard-ui";
let preferences = {};
try { preferences = readPreferences(JSON.parse(localStorage.getItem(preferenceKey) || "{}")); } catch { /* Storage is optional. */ }
let wizardStep = preferences.step || 1;
setupKeyId = preferences.keyId || setupKeyId;
let setupLoaded = false;
let keysLoaded = false;
let pendingDefaults;
let selectedRequestId;
let historyError = "";
let historyGeneration = 0;
let refreshGeneration = 0;
let healthGeneration = 0;
const diagnosticRuns = [];
const relocated = new Map();
const parentOrigins = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
let parentOrigin;
try {
  const referrer = new URL(document.referrer);
  if (["http:", "https:"].includes(referrer.protocol)) { parentOrigin = referrer.origin; parentOrigins.add(parentOrigin); }
  else if (referrer.protocol === "tauri:" && referrer.hostname === "localhost") parentOrigin = "tauri://localhost";
} catch { /* Native webviews may omit the referrer. */ }
const $ = (id) => document.getElementById(id);
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const elements = {
  form: document.querySelector("#create-form"), name: document.querySelector("#key-name"),
  workspaceRoot: document.querySelector("#key-workspace-root"),
  allowedOrigins: document.querySelector("#key-origins"),
  requestsPerMinute: document.querySelector("#key-rpm"), expiresAt: document.querySelector("#key-expiry"),
  keys: document.querySelector("#keys"), status: document.querySelector("#status"), overview: document.querySelector(".overview"),
  secretPanel: document.querySelector("#secret-panel"), secret: document.querySelector("#new-secret"), refresh: document.querySelector("#refresh"),
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
}

function readPreferences(value) {
  if (!value || typeof value !== "object") return {};
  return {
    view: views.has(value.view) ? value.view : "overview",
    keyId: typeof value.keyId === "string" && /^key_[a-zA-Z0-9_-]{1,80}$/.test(value.keyId) ? value.keyId : "",
    model: catalogId(value.model) ? value.model : "",
    reasoning: ["", "none", "minimal", "low", "medium", "high", "xhigh"].includes(value.reasoning) ? value.reasoning : "",
    step: Number.isInteger(value.step) && value.step >= 1 && value.step <= 4 ? value.step : 1,
  };
}

function catalogId(value) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value); }

function persistPreferences() {
  preferences = readPreferences({view:currentView, keyId:setupKeyId, model:$("setup-model").value || preferences.model,
    reasoning:setupLoaded ? $("setup-reasoning").value : preferences.reasoning, step:wizardStep});
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* Storage is optional. */ }
  history.replaceState({dashboard:preferences}, "", window.location.href);
}

function postDesktop(message) {
  if (window.parent !== window) window.parent.postMessage(message, parentOrigin || "*");
}

function applyTheme(theme, {persist = true, notify = true} = {}) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.dataset.theme = theme;
  $("theme-light")?.setAttribute("aria-pressed", String(theme === "light"));
  $("theme-dark")?.setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) { try { localStorage.setItem("codex-ui-theme", theme); } catch { /* Storage is optional. */ } }
  if (notify) postDesktop({type:"codex-desktop-theme", theme});
}

function initializeTheme() {
  let saved;
  try { saved = localStorage.getItem("codex-ui-theme"); } catch { /* Storage is optional. */ }
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  applyTheme(saved === "light" || saved === "dark" ? saved : system.matches ? "dark" : "light", {persist:false, notify:false});
  $("theme-light")?.addEventListener("click", () => applyTheme("light"));
  $("theme-dark")?.addEventListener("click", () => applyTheme("dark"));
  system.addEventListener?.("change", event => {
    let preference;
    try { preference = localStorage.getItem("codex-ui-theme"); } catch { /* Storage is optional. */ }
    if (preference !== "light" && preference !== "dark") applyTheme(event.matches ? "dark" : "light", {persist:false});
  });
}

function sendCatalog() {
  if (!setupLoaded) return;
  const seen = new Set();
  postDesktop({type:"codex-desktop-models", models:setupData.models.filter(model => {
    if (!catalogId(model.id) || seen.has(model.id)) return false;
    seen.add(model.id); return true;
  }).slice(0,200).map(model => ({
    id:model.id, efforts:[...new Set((Array.isArray(model.efforts) ? model.efforts : []).filter(effort => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)))],
  }))});
}

function applyDefaults(value) {
  const gatewayDefault = value.model === "";
  if (!setupLoaded || (gatewayDefault && !adminConfig)) { pendingDefaults = value; return; }
  pendingDefaults = undefined;
  const model = setupData.models.find(entry => entry.id === (gatewayDefault ? adminConfig.defaultModel : value.model));
  if (!model) return;
  $("setup-model").value = model.id;
  preferences.model = model.id;
  preferences.reasoning = !gatewayDefault && (model.efforts || []).includes(value.reasoning) ? value.reasoning : "";
  $("setup-reasoning").value = preferences.reasoning;
  renderEfforts(); persistPreferences();
}

function shortPath(value) {
  if (!value) return "Not configured";
  const normalized = String(value).replaceAll("\\", "/").replace(/\/$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function showView(view = "overview", {replace = false, restore = false, notify = true} = {}) {
  const previous = currentView;
  currentView = views.has(view) ? view : "overview";
  if (currentView !== "onboarding") restoreWizardContent();
  if (previous !== currentView) $("create-dialog")?.close();
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== currentView;
  });
  document.querySelectorAll("[data-view]").forEach((control) => {
    if (control.dataset.view === currentView) control.setAttribute("aria-current", "page");
    else control.removeAttribute("aria-current");
  });
  document.body.dataset.view = currentView;
  const labels = {
    overview:["Overview", "Gateway health, setup progress, and recent activity."],
    "api-keys":["API keys", "Create and manage access to your workspaces."],
    connect:["Connect", "Sign in, test your selected key, and configure your client."],
    requests:["Requests", "Recent request metadata, kept in gateway memory."],
    diagnostics:["Diagnostics", "Check local gateway health without using model quota."],
    settings:["Settings", "Review workspace and gateway configuration."],
    onboarding:["Set up your gateway", "Workspace → Create key → Sign in → Test connection."],
  };
  if ($("page-title")) $("page-title").textContent = labels[currentView][0];
  if ($("page-description")) $("page-description").textContent = labels[currentView][1];
  if (!restore) {
    const url = new URL(window.location.href);
    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set("view", currentView);
    url.hash = hash.toString();
    if (replace || previous === currentView) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  persistPreferences();
  if (notify) postDesktop({type:"codex-desktop-view", view:currentView});
  if (currentView === "api-keys") renderKeys(dashboardKeys);
  if (currentView === "connect") renderSetup();
  if (currentView === "requests") { renderHistoryRows(); void loadHistory(); }
  if (currentView === "onboarding") renderWizard();
  if (currentView === "diagnostics") renderHealth();
  const main = document.querySelector(".app-main");
  if (main) main.scrollTop = 0;
  const title = $("page-title") || document.querySelector(`[data-view-panel="${currentView}"] h2`);
  title?.setAttribute("tabindex", "-1"); title?.focus({preventScroll:true});
}

function bindNavigation() {
  document.addEventListener("click", event => {
    const control = event.target.closest("[data-create-key], [data-view], [data-route]");
    if (!control || control === document.body) return;
    event.preventDefault();
    if (control.hasAttribute("data-create-key")) openCreate();
    else showView(control.dataset.view || control.dataset.route);
  });
  $("open-native-settings")?.addEventListener("click", () => showView("settings"));
  ["history-key-filter", "history-model-filter", "history-result-filter"].forEach((id) => $(id)?.addEventListener("change", renderHistoryRows));
  $("history-search")?.addEventListener("input", renderHistoryRows);
  $("history-refresh")?.addEventListener("click", loadHistory);
  $("history-export")?.addEventListener("click", exportHistory);
  $("request-detail-close")?.addEventListener("click", closeRequestDetail);
  $("request-detail-copy")?.addEventListener("click", copyRequestDetail);
  $("close-create")?.addEventListener("click", () => $("create-dialog")?.close());
  $("secret-continue")?.addEventListener("click", () => {
    if (!selectedKey()) return;
    $("create-dialog")?.close();
    if (currentView === "onboarding") setWizardStep(3); else showView("connect");
  });
  $("setup-continue")?.addEventListener("click", () => showView("onboarding"));
  $("wizard-back")?.addEventListener("click", () => setWizardStep(wizardStep - 1));
  $("wizard-next")?.addEventListener("click", () => {
    if (!wizardCanContinue()) return;
    if (wizardStep === 4) showView("overview"); else setWizardStep(wizardStep + 1);
  });
  $("page-refresh")?.addEventListener("click", () => { void loadConfig(); void refreshDashboard(); });
  $("key-expiry-mode")?.addEventListener("change", renderExpiryMode);
  renderExpiryMode();
  const restoreNavigation = () => {
    const saved = history.state?.dashboard;
    if (saved) {
      preferences = readPreferences(saved); wizardStep = preferences.step;
      selectKey(preferences.keyId, false); renderChoices();
    }
    const view = new URLSearchParams(location.hash.slice(1)).get("view");
    showView(view || preferences.view, {restore:true});
  };
  window.addEventListener("popstate", restoreNavigation);
  window.addEventListener("hashchange", restoreNavigation);
  window.addEventListener("message", event => {
    if (window.parent === window || event.source !== window.parent || !parentOrigins.has(event.origin)) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    parentOrigin = event.origin;
    if (message.type === "codex-desktop-navigate" && views.has(message.view)) {
      if (message.view === "onboarding" && message.step === 2) wizardStep = 2;
      // Acknowledge the applied route so a native startup override also replaces
      // any Settings view published during the ready handshake.
      showView(message.view);
    } else if (message.type === "codex-desktop-defaults" && (message.model === "" || catalogId(message.model))) {
      applyDefaults({model:message.model, reasoning:typeof message.reasoning === "string" ? message.reasoning : ""});
    } else if (message.type === "codex-desktop-theme" && ["light", "dark"].includes(message.theme)) {
      applyTheme(message.theme, {notify:false});
    }
  });
  initializeTheme();
  const initialHash = new URLSearchParams(location.hash.slice(1));
  if (initialHash.get("view") === "onboarding" && initialHash.get("step") === "2") wizardStep = 2;
  showView(new URLSearchParams(location.hash.slice(1)).get("view") || preferences.view, {replace:true, notify:false});
  // Native ignores this restored view while a return route is queued, then
  // delivers that authoritative navigation when ready arrives. Keep this order.
  postDesktop({type:"codex-desktop-view", view:currentView});
  postDesktop({type:"codex-desktop-ready"});
}

function selectedKey() { return dashboardKeys.find(key => key.id === setupKeyId); }
function selectedSetup() { return setupData.keys.find(key => key.id === setupKeyId); }
function usableKey() { const key = selectedKey(); return Boolean(key?.active && !isExpired(key.expiresAt)); }
function currentHealthReady(id) {
  return healthData?.gateway?.ready === true && healthData.gateway.workspaceAccessible === true && healthData.keys?.find(key => key.id === id)?.workspaceAccessible === true;
}
function testMatchesSelection() { return Boolean(usableKey() && currentHealthReady(setupKeyId) && pendingLoginKey !== setupKeyId && !testErrors.has(setupKeyId) && selectedSetup()?.authStatus === "credentials_found" && selectedSetup()?.lastTest?.ok && selectedSetup().lastTest.model === $("setup-model").value); }

function selectKey(id, persist = true) {
  if (id !== setupKeyId) clearLogin();
  setupKeyId = id || "key_REPLACE_WITH_ID";
  $("setup-secret").value = secrets.get(setupKeyId) || "";
  if (persist) { renderChoices(); renderKeys(dashboardKeys); persistPreferences(); }
}

function moveToWizard(id) {
  const node = $(id), stage = $("wizard-stage");
  if (!node || !stage) return;
  if (!relocated.has(id)) { const anchor = document.createComment(id); node.before(anchor); relocated.set(id, anchor); }
  stage.append(node);
}

function restoreWizardContent() {
  for (const [id, anchor] of relocated) { const node = $(id); if (node && anchor.parentNode) anchor.replaceWith(node); }
  relocated.clear();
  if ($("wizard-stage")) delete $("wizard-stage").dataset.step;
}

function wizardCanContinue() {
  if (wizardStep === 1) return Boolean(adminConfig?.workspaceRoot && healthData?.gateway?.workspaceAccessible === true);
  if (wizardStep === 2) return usableKey();
  if (wizardStep === 3) return usableKey() && pendingLoginKey !== setupKeyId && selectedSetup()?.authStatus === "credentials_found";
  return testMatchesSelection() && !pendingTests.has(setupKeyId);
}

function setWizardStep(step) {
  wizardStep = Math.max(1, Math.min(4, step)); persistPreferences(); renderWizard();
  $("wizard-title")?.setAttribute("tabindex", "-1"); $("wizard-title")?.focus({preventScroll:true});
  const main = document.querySelector(".app-main"); if (main) main.scrollTop = 0;
}

function renderWizard() {
  if (currentView !== "onboarding" || !$("wizard-stage")) return;
  // Moving the same nodes preserves the form, one-time secret and live sign-in state.
  const mounted = $("wizard-stage").dataset.step === String(wizardStep);
  const titles = ["Choose your workspace", "Create an API key", "Sign in to Codex", "Test your connection"];
  const descriptions = ["Choose the folder your keys can access, then continue.", "Create a scoped key and save its one-time secret, or continue with the selected saved key.", "Sign in for the selected key. Continue when Codex credentials are found.", "Run a model request with the selected key. Continue after a successful test for this model."];
  if ($("wizard-title")) $("wizard-title").textContent = titles[wizardStep - 1];
  if ($("wizard-description")) $("wizard-description").textContent = descriptions[wizardStep - 1] + (wizardStep > 1 && selectedKey() ? ` Selected key: ${selectedKey().name || selectedKey().id}.` : "");
  if ($("wizard-progress")) $("wizard-progress").replaceChildren(...titles.map((title, index) => {
    const item = document.createElement("li"); item.textContent = `${index + 1}. ${title}`;
    item.dataset.complete = String([healthData?.gateway?.workspaceAccessible === true, usableKey(), usableKey() && selectedSetup()?.authStatus === "credentials_found" && pendingLoginKey !== setupKeyId, testMatchesSelection()][index]);
    if (index + 1 === wizardStep) item.setAttribute("aria-current", "step");
    item.dataset.active = String(index + 1 === wizardStep); return item;
  }));
  if (!mounted) {
    restoreWizardContent(); $("create-dialog")?.close(); $("wizard-stage").replaceChildren();
    $("wizard-stage").dataset.step = String(wizardStep);
    if (wizardStep === 1) {
      const text = document.createElement("p"); text.id = "wizard-workspace-summary";
      const action = document.createElement("button"); action.type = "button";
      action.textContent = desktopToken ? "Open workspace settings" : "Review workspace settings";
      action.addEventListener("click", () => showView("settings"));
      $("wizard-stage").append(text, action);
      if (!desktopToken) { const help = document.createElement("p"); help.textContent = "The workspace is configured when the gateway starts. Choose an existing project folder inside that workspace when creating a key. Refresh after changing gateway configuration."; $("wizard-stage").append(help); }
    } else if (wizardStep === 2) moveToWizard("create-content");
    else if (wizardStep === 3) moveToWizard("connect-auth-card");
    else { moveToWizard("connection-selection"); moveToWizard("connect-test-card"); }
  }
  if ($("wizard-workspace-summary")) $("wizard-workspace-summary").textContent = adminConfig?.workspaceRoot || "Workspace configuration unavailable. Refresh to try again.";
  if ($("wizard-back")) $("wizard-back").disabled = wizardStep === 1;
  if ($("wizard-next")) { $("wizard-next").disabled = !wizardCanContinue(); $("wizard-next").textContent = wizardStep === 4 ? "Finish setup" : "Continue"; }
}

function openCreate() {
  if (currentView === "onboarding") { setWizardStep(2); return; }
  restoreWizardContent();
  if ($("create-dialog")) { if (!$("create-dialog").open) $("create-dialog").showModal(); }
  else showView("api-keys");
  elements.name.focus();
}

function renderExpiryMode() {
  if (!$("key-expiry-mode")) return;
  const custom = $("key-expiry-mode").value === "custom";
  if ($("key-expiry-field")) $("key-expiry-field").hidden = !custom;
  elements.expiresAt.disabled = !custom; elements.expiresAt.required = custom;
  if (!custom) elements.expiresAt.value = "";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "X-Codex-Admin": "local", ...(desktopToken ? { "X-Codex-Desktop-Token": desktopToken } : {}), ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || body.message || `Request failed (${response.status})`);
  return body;
}

function api(path = "", options = {}) { return requestJson(`${endpoint}${path}`, options); }

function parseOrigins(value) { return value.split(/[\n,]/).map(origin => origin.trim()).filter(Boolean); }

async function loadConfig() {
  setupConfigError = "";
  renderSetup();
  try {
    adminConfig = await requestJson("/admin/config");
    const migration = adminConfig.desktopMigration;
    $("migration-notice").hidden = !migration || ["existing", "not_found"].includes(migration.status);
    $("migration-notice").textContent = migration?.message || "";
    $("workspace-context").textContent = shortPath(adminConfig.workspaceRoot);
    $("settings-workspace").textContent = adminConfig.workspaceRoot || "Not configured";
    $("settings-endpoint").textContent = window.location.origin + "/v1";
    document.querySelector("#setup-platform").value = /^[A-Za-z]:[\\/]/.test(adminConfig.codexStateRoot) ? "windows" : "macos";
    renderChoices();
    if (pendingDefaults) applyDefaults(pendingDefaults);
  } catch (error) {
    setupConfigError = error.message;
    $("workspace-context").textContent = "Unavailable";
    $("settings-workspace").textContent = "Unavailable";
    renderSetup();
    setStatus(`Could not load setup configuration: ${error.message}`, true);
  }
}

function renderSetup() {
  renderChecklist();
  const key = selectedKey();
  if ($("connect-empty")) $("connect-empty").hidden = dashboardKeys.length > 0;
  if ($("connect-content")) $("connect-content").hidden = dashboardKeys.length === 0;
  $("test-connection").disabled = !key || !key.active || isExpired(key.expiresAt) || pendingTests.has(key.id) || pendingLoginKey === key.id || !$("setup-model").value;
  const signingIn = Boolean(key && pendingLoginKey === key.id);
  const signedIn = selectedSetup()?.authStatus === "credentials_found" && !signingIn;
  const loginUnavailable = !key || !key.active || isExpired(key.expiresAt) || signingIn;
  $("login-codex").disabled = loginUnavailable || signedIn;
  $("login-codex").textContent = signingIn ? "Signing in…" : signedIn ? "Signed in" : "Sign in to Codex ↗";
  $("login-codex").classList.toggle("login-complete", signedIn);
  $("login-again").hidden = !signedIn;
  $("login-again").disabled = loginUnavailable;
  $("setup-progress").textContent = key ? progressText(key) : "Create a key to begin.";
  if (!pendingTests.has(setupKeyId)) $("test-result").textContent = testErrors.get(setupKeyId) || (selectedSetup()?.lastTest ? testSummary(selectedSetup().lastTest) : "No connection test recorded for this key. Run a small model request to verify it; this uses your account's quota.");
  else $("test-result").textContent = "Testing… This may take a minute.";
  renderKeyDetail(key);
  renderWizard();
  if (!adminConfig) {
    ["setup-workspace-root", "key-create-example", "base-url", "login-example", "vscode-example", "curl-example", "browser-example", "tunnel-example"].forEach((id) => { $(id).textContent = setupConfigError ? "Unavailable: " + setupConfigError : "Loading server configuration…"; });
    return;
  }
  const windows = $("setup-platform").value === "windows";
  const quote = windows ? psQuote : shellQuote;
  const model = $("setup-model").value || adminConfig.defaultModel;
  const effort = $("setup-reasoning").value;
  const modelId = model;
  const baseUrl = window.location.origin + "/v1";
  const secret = $("setup-secret").value || "YOUR_KEY";
  const home = (adminConfig.codexStateRoot || "").replace(/[\\/]$/, "") + (/^[A-Za-z]:/.test(adminConfig.codexStateRoot) ? "\\" : "/") + setupKeyId;
  $("workspace-help").textContent = "Choose an existing folder inside " + adminConfig.workspaceRoot + ". This is the folder this key can access.";
  elements.workspaceRoot.placeholder = adminConfig.workspaceRoot.replace(/[\\/]$/, "") + (/^[A-Za-z]:/.test(adminConfig.workspaceRoot) ? "\\my-project" : "/my-project");
  $("base-url").textContent = baseUrl + "/chat/completions";
  $("setup-workspace-root").textContent = "Allowed workspace: " + adminConfig.workspaceRoot;
  $("key-create-example").textContent = "Create a key for an existing project folder above, save its secret, then select it here.";
  $("login-example").textContent = desktopToken ? "Choose Sign in to Codex. The desktop app includes Codex and manages your sign-in; no terminal setup is needed." : windows
    ? "$env:CODEX_HOME=" + quote(home) + "\nNew-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null\ncodex login"
    : "export CODEX_HOME=" + quote(home) + '\nmkdir -p "$CODEX_HOME"\ncodex login';
  $("vscode-example").textContent = JSON.stringify([{name:"Local Codex CLI API", vendor:"customendpoint", apiKey:secret, apiType:"chat-completions", models:[{id:modelId,name:modelId,url:baseUrl+"/chat/completions",toolCalling:false,vision:false,thinking:true,supportsReasoningEffort:setupData.models.find((entry) => entry.id === model)?.efforts || [],reasoningEffortFormat:"chat-completions"}]}], null, 2);
  const payload = JSON.stringify({model:modelId,messages:[{role:"user",content:"Say hello"}],stream:false,...(effort ? {reasoning_effort:effort} : {})});
  $("browser-origins-status").textContent = key?.allowedOrigins?.length
    ? "Allowed browser origins: " + key.allowedOrigins.join(", ")
    : "Cross-origin browser access disabled. Add your app’s origin under API keys → Edit policy.";
  $("browser-example").textContent = [
    "const response = await fetch(" + JSON.stringify(baseUrl + "/chat/completions") + ", {",
    '  method: "POST",',
    '  headers: { "Content-Type": "application/json", Authorization: ' + JSON.stringify("Bearer " + secret) + " },",
    "  body: JSON.stringify(" + payload + ")",
    "});",
    "const data = await response.json();",
    'if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`);',
    "console.log(data.choices[0].message.content);",
  ].join("\n");
  $("curl-example").textContent = windows
    ? "Invoke-RestMethod -Method Post -Uri " + quote(baseUrl+"/chat/completions") + " -Headers @{ Authorization = " + quote("Bearer "+secret) + " } -ContentType 'application/json' -Body " + quote(payload)
    : "curl " + quote(baseUrl+"/chat/completions") + " -H " + quote("Authorization: Bearer "+secret) + " -H 'Content-Type: application/json' -d " + quote(payload);
  $("tunnel-example").textContent = ["tunnel: YOUR_TUNNEL_ID","credentials-file: "+(windows ? "'C:/Users/YOU/.cloudflared/YOUR_TUNNEL_ID.json'" : "'/Users/YOU/.cloudflared/YOUR_TUNNEL_ID.json'"),"ingress:","  - hostname: api.example.com","    path: ^/v1(/|$)","    service: "+window.location.origin,"  - service: http_status:404"].join("\n");
}

function renderChecklist() {
  const key = dashboardKeys.find(entry => entry.id === setupKeyId);
  const setup = setupData.keys.find(entry => entry.id === setupKeyId);
  const validKey = key && key.active && !isExpired(key.expiresAt);
  const steps = [
    ['Choose workspace', healthData?.gateway?.workspaceAccessible === true, 'settings'],
    ['Create an active key', Boolean(validKey), 'api-keys'],
    ['Sign in to Codex', setup?.authStatus === 'credentials_found', 'connect'],
    ['Test connection', testMatchesSelection(), 'connect'],
  ];
  $('setup-checklist').replaceChildren(...steps.map(([label, done, target]) => {
    const item = document.createElement('li');
    const link = document.createElement('a'); link.href = '#'; link.dataset.route = target;
    link.textContent = `${done ? '✓' : '○'} ${label}`;
    item.dataset.complete = String(done); item.append(link); return item;
  }));
}

function clearLogin() {
  clearTimeout(loginTimer); loginGeneration++;
  pendingLoginKey = undefined;
  $("login-status").textContent = desktopToken ? "Use Sign in to Codex to connect your own account." : "Sign in here, or use the terminal command in Connect.";
  $("login-link").hidden = true; $("login-code").textContent = ""; $("login-copy").hidden = true; $("login-cancel").hidden = true;
}

async function deviceLogin(method = "POST") {
  const id = setupKeyId;
  if (!dashboardKeys.some((key) => key.id === id)) return;
  const generation = ++loginGeneration;
  clearTimeout(loginTimer);
  $("login-status").textContent = "Starting Codex sign-in…";
  $("login-codex").disabled = true;
  pendingLoginKey = id;
  if (method === "POST") {
    const state = selectedSetup(); if (state) { state.lastTest = null; state.ready = false; }
    testErrors.delete(id);
  }
  renderSetup();
  async function update(verb) {
    try {
      const state = await api("/" + encodeURIComponent(id) + "/login", {method:verb});
      if (generation !== loginGeneration || id !== setupKeyId) return;
      $("login-status").textContent = state.message || state.status;
      $("login-code").textContent = state.code || "";
      $("login-copy").hidden = !state.code;
      let link;
      try { link = new URL(state.url); } catch { link = null; }
      const allowed = link?.protocol === "https:" && link.hostname === "auth.openai.com";
      $("login-link").hidden = !allowed;
      if (allowed) $("login-link").href = link.href;
      const pending = state.status === "starting" || state.status === "waiting";
      $("login-cancel").hidden = !pending;
      if (pending) loginTimer = setTimeout(() => update("GET"), 2000);
      else { pendingLoginKey = undefined; renderSetup(); if (state.status === "success") await refreshDashboard(); }
    } catch (error) { if (generation === loginGeneration) { pendingLoginKey = undefined; $("login-status").textContent = "Sign-in failed: " + error.message + (desktopToken ? ". Retry Sign in to Codex when ready." : ". You can use the terminal command below."); renderSetup(); $("login-cancel").hidden = true; } }
  }
  await update(method);
}

function progressText(key) {
  const state = setupData.keys.find((entry) => entry.id === key.id);
  if (!key.active || isExpired(key.expiresAt)) return "Key " + (key.active ? "expired" : "inactive") + " · Activate it or update its expiry before testing.";
  if (!state) return "Key created · Setup status unavailable. Refresh to try again.";
  if (testErrors.has(key.id)) return testErrors.get(key.id);
  if (!currentHealthReady(key.id)) return "Gateway or workspace health is not confirmed. Review Diagnostics before using this key.";
  if (state.ready && state.authStatus === "credentials_found" && state.lastTest?.ok) {
    const changedModel = key.id === setupKeyId && $("setup-model").value && $("setup-model").value !== state.lastTest.model;
    return "Key created → Test passed for " + state.lastTest.model + " → " + (changedModel ? "Test the selected model before using it." : "Ready to configure your client") + " · Last tested " + formatDate(state.lastTest.testedAt);
  }
  if (state.lastTest && !state.lastTest.ok) return "Key created · Test failed: " + state.lastTest.message;
  return state.authStatus === "credentials_found"
    ? "Key created → Codex credentials found → Test connection next. Credentials alone do not confirm a valid login."
    : "Key created → Sign in to Codex → Test connection.";
}

function testSummary(test) { return `${test.ok ? "Test passed" : "Test failed"} · ${test.model || "Unknown model"} · ${formatDate(test.testedAt)}${test.message ? " · " + test.message : ""}`; }

function renderChoices() {
  const selectedModel = preferences.model || $("setup-model").value;
  $("setup-key").replaceChildren(...(dashboardKeys.length ? dashboardKeys.map((key) => new Option(key.name || key.id, key.id)) : [new Option("Create a key first", "")]));
  if (keysLoaded && !dashboardKeys.some((key) => key.id === setupKeyId)) setupKeyId = dashboardKeys[0]?.id || "key_REPLACE_WITH_ID";
  $("setup-key").value = dashboardKeys.length ? setupKeyId : "";
  $("setup-secret").value = secrets.get(setupKeyId) || "";
  $("setup-model").replaceChildren(...setupData.models.map((model) => new Option(model.id, model.id)));
  if (setupData.models.some((model) => model.id === selectedModel)) $("setup-model").value = selectedModel;
  else if (setupData.models.some(model => model.id === adminConfig?.defaultModel)) $("setup-model").value = adminConfig.defaultModel;
  if (!setupData.models.length) $("setup-model").replaceChildren(new Option("Models unavailable", ""));
  renderEfforts();
}

function renderEfforts() {
  const selected = preferences.reasoning ?? $("setup-reasoning").value;
  const model = setupData.models.find((entry) => entry.id === $("setup-model").value);
  $("setup-reasoning").replaceChildren(new Option("Model default", ""), ...(model?.efforts || []).map((effort) => new Option(effort, effort)));
  if ((model?.efforts || []).includes(selected)) $("setup-reasoning").value = selected;
  renderSetup();
}

async function testConnection(id = setupKeyId, button = $("test-connection")) {
  if (pendingTests.has(id)) return;
  const key = dashboardKeys.find(key => key.id === id);
  if (!key?.active || isExpired(key.expiresAt) || pendingLoginKey === id) return;
  if (setupKeyId !== id) selectKey(id);
  if (currentView !== "onboarding") showView("connect");
  const model = $("setup-model").value || adminConfig?.defaultModel;
  if (!model) { setStatus("Load an available model before testing.", true); return; }
  pendingTests.add(id);
  const startedAt = Date.now();
  testErrors.delete(id);
  renderWizard();
  button.disabled = true;
  $("test-result").textContent = "Testing… This may take a minute.";
  try {
    const result = await api("/" + encodeURIComponent(id) + "/test", {method:"POST",body:JSON.stringify({model, reasoningEffort:$("setup-reasoning").value || undefined})});
    if (id === setupKeyId) $("test-result").textContent = testSummary(result);
    await refreshDashboard();
  } catch (error) {
    testErrors.set(id, `Test request failed · ${model} · ${formatDate(new Date().toISOString())} · ${error.message}`);
    await refreshDashboard();
    const recorded = setupData.keys.find(key => key.id === id)?.lastTest;
    if (recorded?.ok === false && recorded.model === model && Date.parse(recorded.testedAt) >= startedAt) testErrors.delete(id);
  }
  finally { pendingTests.delete(id); button.disabled = false; renderKeys(dashboardKeys); renderSetup(); }
}

function setFilterOptions(id, values, labels = values) {
  const select = $(id);
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(new Option(id === "history-key-filter" ? "All keys" : id === "history-model-filter" ? "All models" : "All results", "all"));
  values.forEach((value, index) => select.append(new Option(labels[index] || value, value)));
  select.value = values.includes(previous) ? previous : "all";
}

function renderHistoryFilters() {
  const keyIds = [...new Set(requestHistory.map((item) => item.keyId).filter(Boolean))];
  setFilterOptions("history-key-filter", keyIds, keyIds.map((id) => dashboardKeys.find((key) => key.id === id)?.name || id));
  const models = [...new Set(requestHistory.map((item) => item.model).filter(Boolean))];
  setFilterOptions("history-model-filter", models);
  const results = [...new Set(requestHistory.map((item) => item.status).filter(Boolean))];
  setFilterOptions("history-result-filter", results);
}

function filteredHistory() {
  const keyFilter = $("history-key-filter")?.value || "all";
  const modelFilter = $("history-model-filter")?.value || "all";
  const resultFilter = $("history-result-filter")?.value || "all";
  const search = $("history-search")?.value.trim().toLocaleLowerCase() || "";
  return requestHistory.filter(item => (keyFilter === "all" || item.keyId === keyFilter) && (modelFilter === "all" || item.model === modelFilter) && (resultFilter === "all" || item.status === resultFilter) &&
    [item.requestId, item.keyId, dashboardKeys.find(key => key.id === item.keyId)?.name, item.model, item.status, item.httpStatus].some(value => String(value ?? "").toLocaleLowerCase().includes(search)));
}

function renderHistoryRows() {
  const rows = filteredHistory();
  $("request-history").replaceChildren(...rows.map(item => {
    const row = document.createElement("tr");
    row.tabIndex = 0; row.dataset.requestId = item.requestId || "";
    row.setAttribute("aria-label", `View request ${item.requestId || "details"}: ${item.model || "unknown model"}, ${item.status || "unknown result"}`);
    row.setAttribute("aria-selected", String(item.requestId === selectedRequestId));
    row.addEventListener("click", () => openRequestDetail(item));
    row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openRequestDetail(item); } });
    [formatDate(item.timestamp), dashboardKeys.find((key) => key.id === item.keyId)?.name || item.keyId || "—", item.model || "—", `${item.status || "Unknown"}${item.httpStatus == null ? "" : " (" + item.httpStatus + ")"}`, item.durationMs == null ? "—" : item.durationMs + " ms", String(item.inputTokens ?? "—") + " / " + String(item.outputTokens ?? "—")].forEach((value, index) => {
      const cell = document.createElement("td");
      if (index === 3) cell.append(resultBadge(value, item.status)); else cell.textContent = value;
      row.append(cell);
    });
    return row;
  }));
  $("history-status").textContent = historyError || (requestHistory.length && !rows.length ? "No requests match this search and filters." : requestHistory.length ? `${rows.length} of ${requestHistory.length} recent requests. Kept in gateway memory until restart.` : "No requests yet. Test a connection or send an API request to begin.");
  if ($("history-export")) $("history-export").disabled = rows.length === 0;
}

async function loadHistory() {
  const generation = ++historyGeneration;
  if ($("history-refresh")) $("history-refresh").disabled = true;
  try {
    const body = await requestJson("/admin/requests");
    if (generation !== historyGeneration) return;
    requestHistory = Array.isArray(body.data) ? body.data.map(requestMetadata) : [];
    historyError = "";
    if (selectedRequestId && !requestHistory.some(item => item.requestId === selectedRequestId)) closeRequestDetail(false);
    renderHistoryFilters();
    renderHistoryRows();
  } catch (error) {
    if (generation !== historyGeneration) return;
    requestHistory = []; historyError = "Request history unavailable: " + error.message;
    closeRequestDetail(false); renderHistoryFilters(); renderHistoryRows();
  } finally { if (generation === historyGeneration) { if ($("history-refresh")) $("history-refresh").disabled = false; renderOverview(); } }
}

// Explicit metadata allowlist: never export prompts, bodies, account hints or secrets.
function requestMetadata(item) {
  const result = {};
  if (!item || typeof item !== "object") return result;
  for (const field of ["requestId", "keyId", "model", "status", "timestamp", "path"]) {
    if (typeof item[field] === "string") result[field] = redact(item[field]).slice(0, 256);
  }
  for (const field of ["httpStatus", "durationMs", "inputTokens", "outputTokens"]) {
    if (typeof item[field] === "number" && Number.isFinite(item[field])) result[field] = item[field];
  }
  return result;
}

function redact(value) {
  let text = String(value);
  for (const secret of [...secrets.values(), desktopToken].filter(Boolean)) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/\b(?:sk-[a-zA-Z0-9_-]+|Bearer\s+[^\s"',;]+)\b/gi, "[redacted]");
}

function openRequestDetail(item) {
  selectedRequestId = item.requestId;
  const panel = $("request-detail-panel"), body = $("request-detail-body");
  if (!panel || !body) return;
  panel.hidden = false;
  if ($("request-detail-title")) $("request-detail-title").textContent = item.requestId ? `Request ${item.requestId}` : "Request details";
  const labels = {requestId:"Request ID",keyId:"Key ID",model:"Model",status:"Result",httpStatus:"HTTP status",durationMs:"Duration (ms)",inputTokens:"Input tokens",outputTokens:"Output tokens",timestamp:"Time",path:"Route"};
  const list = document.createElement("dl"); list.className = "detail-list";
  for (const [field, value] of Object.entries(requestMetadata(item))) {
    const group = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd");
    term.textContent = labels[field]; detail.textContent = field === "timestamp" ? formatDate(value) : String(value);
    group.append(term, detail); list.append(group);
  }
  body.replaceChildren(list); renderHistoryRows();
  $("request-detail-title")?.setAttribute("tabindex", "-1"); $("request-detail-title")?.focus({preventScroll:true});
}

function closeRequestDetail(focus = true) {
  const id = selectedRequestId; selectedRequestId = undefined;
  if ($("request-detail-panel")) $("request-detail-panel").hidden = true;
  if ($("request-detail-body")) $("request-detail-body").replaceChildren();
  renderHistoryRows();
  if (focus) [...$("request-history").children].find(row => row.dataset.requestId === id)?.focus({preventScroll:true});
}

async function copyRequestDetail() {
  const item = requestHistory.find(entry => entry.requestId === selectedRequestId);
  if (!item) return;
  try { await navigator.clipboard.writeText(JSON.stringify({request:requestMetadata(item), gatewayReady:healthData?.gateway?.ready ?? null}, null, 2)); setStatus("Request diagnostic context copied."); }
  catch { setStatus("Clipboard access was blocked. Select and copy the metadata manually.", true); }
}

function csvCell(value) {
  let text = redact(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function exportHistory() {
  const rows = filteredHistory(); if (!rows.length) return;
  const fields = ["requestId", "timestamp", "keyId", "model", "status", "httpStatus", "durationMs", "inputTokens", "outputTokens", "path"];
  const csv = [fields, ...rows.map(item => fields.map(field => requestMetadata(item)[field] ?? ""))].map(row => row.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  const link = document.createElement("a"); link.href = url; link.download = "codex-request-metadata.csv";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderOverview() {
  const gateway = healthData?.gateway;
  if ($("sidebar-status")) $("sidebar-status").textContent = gateway ? gateway.ready ? "Ready" : "Attention needed" : "Unavailable";
  if ($("sidebar-status-dot")) { $("sidebar-status-dot").classList.toggle("error", gateway?.ready !== true); $("sidebar-status-dot").dataset.state = gateway ? gateway.ready ? "ready" : "failed" : "unknown"; }
  if ($("sidebar-endpoint")) $("sidebar-endpoint").textContent = location.origin + "/v1";
  if ($("overview-health")) {
    const auth = setupData.keys.filter(key => key.authStatus === "credentials_found").length;
    const passed = setupData.keys.filter(key => key.lastTest?.ok).length;
    $("overview-health").replaceChildren(...[
      `Gateway: ${gateway ? gateway.ready ? "Ready" : "Needs attention" : "Health unavailable"}`,
      setupLoaded ? `${auth} keys with credentials found` : "Authentication status unavailable",
      setupLoaded ? `${passed} keys with a passing last connection test` : "Connection test status unavailable",
      healthData?.checkedAt ? "Health checked " + formatDate(healthData.checkedAt) : "Refresh to check local health",
    ].map(text => { const row = document.createElement("p"); row.textContent = text; return row; }));
  }
  const recent = $("overview-history"); if (!recent) return;
  recent.replaceChildren();
  const items = [...requestHistory].sort((a,b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)).slice(0,5);
  if (!items.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = historyError || "No recent requests. Test a connection to begin."; recent.append(empty); return; }
  const table = document.createElement("table"); table.setAttribute("aria-label", "Latest five requests");
  const head = document.createElement("thead"), header = document.createElement("tr"), body = document.createElement("tbody");
  for (const text of ["Model", "Result", "Time"]) { const cell = document.createElement("th"); cell.scope = "col"; cell.textContent = text; header.append(cell); }
  head.append(header);
  for (const item of items) {
    const row = document.createElement("tr"), model = document.createElement("td"), result = document.createElement("td"), time = document.createElement("td");
    const action = document.createElement("button"); action.type = "button"; action.className = "text-button";
    action.textContent = item.model || "Unknown model"; action.setAttribute("aria-label", `View request ${item.requestId || "details"}`);
    action.addEventListener("click", () => { showView("requests"); openRequestDetail(item); });
    model.append(action); result.append(resultBadge(item.status || "Unknown", item.status)); time.textContent = formatDate(item.timestamp);
    row.append(model, result, time); body.append(row);
  }
  table.append(head, body); recent.append(table);
}

function resultBadge(label, status) {
  const badge = document.createElement("span");
  badge.className = "result-badge " + (status === "success" ? "success" : status === "failed" ? "error" : "warning"); badge.textContent = label; return badge;
}

function renderHealth() {
  renderOverview();
  const target = $("health-results"); if (!target) return;
  const gateway = healthData?.gateway;
  const recovery = $("recovery-panel"); recovery?.replaceChildren();
  const checks = [["Gateway", "ready"], ["Workspace", "workspaceAccessible"], ["Private state", "stateAccessible"], ["Key store", "keyStoreAccessible"]];
  target.replaceChildren(...checks.map(([label, field]) => {
    const value = gateway?.[field];
    const card = document.createElement("article"); card.className = "check-row"; card.dataset.state = value === true ? "pass" : value === false ? "fail" : "unknown";
    const title = document.createElement("h3"), status = document.createElement("p"); title.textContent = label;
    status.textContent = value === true ? field === "ready" ? "Ready" : "Accessible" : value === false ? field === "ready" ? "Not ready" : "Inaccessible" : "Status unavailable";
    const badge = resultBadge(value === true ? "Passed" : value === false ? "Needs attention" : "Unavailable", value === true ? "success" : value === false ? "failed" : "unknown");
    card.append(title, badge, status);
    if (value !== true) addRecovery(`${label}: ${status.textContent}`, "Review settings", () => showView("settings"), recovery || card);
    return card;
  }));
  for (const key of healthData?.keys || []) {
    const card = document.createElement("article"); card.className = "check-row";
    const title = document.createElement("h3"), status = document.createElement("p");
    title.textContent = dashboardKeys.find(entry => entry.id === key.id)?.name || key.id;
    const test = setupData.keys.find(entry => entry.id === key.id)?.lastTest;
    status.textContent = `${key.authStatus === "credentials_found" ? "Credentials found; use a connection test to verify them." : "Sign in to Codex required."} ${test ? testSummary(test) : "No connection test recorded."}`;
    card.dataset.state = key.ready === true ? "pass" : "attention"; card.append(title, resultBadge(key.ready === true ? "Ready" : "Review connection", key.ready === true ? "success" : "unknown"), status); target.append(card);
    if (key.workspaceAccessible === false) addRecovery(`${title.textContent}: workspace inaccessible`, "Review settings", () => showView("settings"), recovery || card);
    if (key.authStatus !== "credentials_found" || !test?.ok) addRecovery(`${title.textContent}: ${key.authStatus !== "credentials_found" ? "sign in required" : "connection test needed"}`, "Open Connect", () => { selectKey(key.id); showView("connect"); }, recovery || card);
  }
  if (recovery && !recovery.childNodes.length) { const text = document.createElement("p"); text.className = "empty"; text.textContent = "No local health issues reported."; recovery.append(text); }
  if ($("diagnostic-runs")) {
    $("diagnostic-runs").replaceChildren(...diagnosticRuns.map(run => {
      const row = document.createElement("p"); row.textContent = `${formatDate(run.checkedAt)} · ${run.available ? run.ready ? "Gateway ready" : "Gateway needs attention" : "Health check unavailable"}`; return row;
    }));
    if (!diagnosticRuns.length) $("diagnostic-runs").textContent = "No manual health checks in this page session.";
  }
  if ($("diagnostic-technical")) {
    const list = document.createElement("dl"); list.className = "detail-list";
    for (const [label, value] of [["Last health check", healthData?.checkedAt ? formatDate(healthData.checkedAt) : "Unavailable"], ["Active requests", gateway?.capacity?.active ?? "Unavailable"], ["Queued requests", gateway?.capacity?.queued ?? "Unavailable"]]) {
      const group = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = label; detail.textContent = String(value); group.append(term, detail); list.append(group);
    }
    $("diagnostic-technical").replaceChildren(list);
  }
}

function addRecovery(message, label, handler, target) {
  const row = document.createElement("div"); row.className = "check-row";
  const text = document.createElement("p"); text.textContent = message;
  const action = document.createElement("button"); action.type = "button"; action.className = "secondary"; action.textContent = label;
  action.addEventListener("click", handler); row.append(text, action); target.append(row);
}

async function checkHealth() {
  const generation = ++healthGeneration, button = $("health-check"); button.disabled = true;
  try {
    const result = await requestJson("/admin/health");
    if (generation !== healthGeneration) return;
    healthData = result;
    // Memory only, bounded, with no paths, key identifiers, account hints or errors.
    diagnosticRuns.unshift({checkedAt:result.checkedAt, available:true, ready:result.gateway?.ready === true});
    setStatus("Local health check completed. Connection tests are separate.");
  } catch {
    if (generation !== healthGeneration) return;
    healthData = undefined;
    diagnosticRuns.unshift({checkedAt:new Date().toISOString(), available:false, ready:false});
    setStatus("Local health check unavailable. Review settings and retry.", true);
  } finally {
    diagnosticRuns.length = Math.min(diagnosticRuns.length, 8);
    button.disabled = false; renderHealth(); renderKeys(dashboardKeys); renderSetup();
  }
}

function sanitizedReport(value) {
  const report = {version:Number.isInteger(value.version) ? value.version : null, generatedAt:typeof value.generatedAt === "string" && Number.isFinite(Date.parse(value.generatedAt)) ? new Date(value.generatedAt).toISOString() : null, retention:"memory", sessionCredentialsIncluded:false, gateway:{}, keys:{}, recentRequests:[]};
  for (const field of ["ready", "workspaceAccessible", "stateAccessible", "keyStoreAccessible"]) if (typeof value.gateway?.[field] === "boolean") report.gateway[field] = value.gateway[field];
  for (const field of ["total", "ready", "credentialsFound", "inaccessibleWorkspaces"]) if (Number.isFinite(value.keys?.[field])) report.keys[field] = value.keys[field];
  report.gateway.capacity = {};
  for (const field of ["active", "queued"]) if (Number.isFinite(value.gateway?.capacity?.[field])) report.gateway.capacity[field] = value.gateway.capacity[field];
  report.recentRequests = (Array.isArray(value.recentRequests) ? value.recentRequests : []).slice(0,100).map(item => {
    const metadata = requestMetadata(item);
    return Object.fromEntries(Object.entries(metadata).filter(([field]) => ["status", "httpStatus", "durationMs", "inputTokens", "outputTokens", "timestamp"].includes(field)));
  });
  return report;
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Never" : date.toLocaleString();
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function canonicalExpiry(value) { return value ? new Date(value).toISOString() : null; }
function isExpired(value) { return value !== null && value !== undefined && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= Date.now(); }

function renderMessage(text, className) {
  elements.keys.replaceChildren(Object.assign(document.createElement("p"), { className, textContent: text }));
}

function renderKeyDetail(key) {
  if ($("key-detail-panel")) $("key-detail-panel").hidden = !key;
  const name = $("detail-key-name");
  const state = $("detail-key-state");
  if (!key) {
    if (name) name.textContent = "No key selected";
    if (state) { state.textContent = "Not selected"; state.className = "pill"; }
    $("detail-key-scope").textContent = "Select a key to inspect it.";
    $("detail-key-rate-limit").textContent = "—";
    $("detail-key-expiry").textContent = "—";
    $("detail-key-auth").textContent = "—";
    $("detail-key-last-test").textContent = "—";
    return;
  }
  const setup = setupData.keys.find((entry) => entry.id === key.id);
  const health = healthData?.keys?.find((entry) => entry.id === key.id);
  const expired = isExpired(key.expiresAt);
  const status = expired ? "Expired" : key.active ? "Active" : "Inactive";
  name.textContent = key.name || key.id;
  state.textContent = status;
  state.className = `pill${key.active && !expired ? "" : " inactive"}`;
  $("detail-key-scope").textContent = key.workspaceRoot || adminConfig?.workspaceRoot || "—";
  $("detail-key-rate-limit").textContent = `${key.requestsPerMinute || 60} requests / minute`;
  $("detail-key-expiry").textContent = key.expiresAt ? formatDate(key.expiresAt) : "Never";
  const authStatus = setup?.authStatus ?? health?.authStatus;
  $("detail-key-auth").textContent = authStatus === "credentials_found" ? "Codex credentials found (not a connection test)" : authStatus ? "Sign-in required" : "Authentication status unavailable";
  $("detail-key-last-test").textContent = testErrors.get(key.id) || (setup?.lastTest ? testSummary(setup.lastTest) : "Not tested yet");
}

function metric(id, value) { document.querySelector(id).textContent = Number(value || 0).toLocaleString(); }

function renderMetrics(metrics) {
  const keys = metrics.keys || {};
  const capacity = metrics.capacity || {};
  metric("#metric-total-keys", keys.total);
  metric("#metric-active-keys", keys.active);
  metric("#metric-requests", keys.requestCount);
  metric("#metric-tokens", Number(keys.inputTokens || 0) + Number(keys.outputTokens || 0));
  metric("#metric-capacity-active", capacity.active);
  metric("#metric-capacity-queued", capacity.queued);
  elements.overview.removeAttribute("data-state");
  elements.overview.setAttribute("aria-label", "Service overview");
}

function unavailableMetrics() {
  ["#metric-total-keys", "#metric-active-keys", "#metric-requests", "#metric-tokens", "#metric-capacity-active", "#metric-capacity-queued"].forEach((id) => {
    document.querySelector(id).textContent = "Unavailable";
  });
  elements.overview.dataset.state = "unavailable";
  elements.overview.setAttribute("aria-label", "Service overview unavailable");
}

function appendMeta(details, text) {
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = text;
  details.append(meta);
}

function policyField(labelText, id, input) {
  const field = document.createElement("div");
  field.className = "form-field";
  const label = document.createElement("label");
  label.htmlFor = id; label.textContent = labelText; input.id = id;
  field.append(label, input);
  return field;
}

function renderKeys(keys) {
  if (!keys.length) {
    renderMessage("No API keys yet. Create a key to get started.", "empty");
    const create = document.createElement("button"); create.type = "button"; create.textContent = "Create API key"; create.dataset.createKey = "";
    elements.keys.append(create); renderKeyDetail(null); return;
  }
  const query = $('key-search').value.trim().toLocaleLowerCase();
  const filter = $('key-filter').value;
  keys = keys.filter(key => {
    const status = isExpired(key.expiresAt) ? 'expired' : key.active ? 'active' : 'inactive';
    return (filter === 'all' || status === filter) && [key.name, key.id, key.workspaceRoot].some(value => String(value || '').toLocaleLowerCase().includes(query));
  });
  if (!keys.length) { renderMessage('No keys match your search and status filter.', 'empty'); renderKeyDetail(selectedKey()); return; }
  const fragment = document.createDocumentFragment();
  keys.forEach((key) => {
    const card = document.createElement("article"); card.className = "key-card"; card.dataset.keyId = key.id;
    card.dataset.selected = String(key.id === setupKeyId);
    card.classList.toggle("selected", key.id === setupKeyId);
    const details = document.createElement("div");
    const name = document.createElement("span"); name.className = "key-name"; name.textContent = key.name || "Unnamed key";
    const expired = isExpired(key.expiresAt);
    const state = document.createElement("span"); state.className = `pill${key.active && !expired ? "" : " inactive"}`;
    state.textContent = expired ? "Expired" : key.active ? "Active" : "Inactive";
    name.append(" ", state); details.append(name);
    appendMeta(details, `ID: ${key.id || "—"} · Created ${formatDate(key.createdAt)}`);
    appendMeta(details, `Workspace: ${key.workspaceRoot || adminConfig?.workspaceRoot || "—"}`);
    appendMeta(details, `RPM ${key.requestsPerMinute || 60} · ${key.requestCount || 0} requests · ${key.failureCount || 0} failures · ${Number(key.inputTokens || 0) + Number(key.outputTokens || 0)} tokens`);
    appendMeta(details, `Last used ${formatDate(key.lastUsedAt)} · Expires ${key.expiresAt ? formatDate(key.expiresAt) : "Never"}`);
    appendMeta(details, key.allowedOrigins?.length ? `Browser origins: ${key.allowedOrigins.join(", ")}` : "Cross-origin browser access disabled");
    appendMeta(details, progressText(key));
    const account = healthData?.keys?.find(entry => entry.id === key.id)?.account;
    appendMeta(details, account?.email ? `Account hint (unverified): ${account.email}` : 'Codex account: identity unavailable; use sign-in to select your account.');

    const stateButton = document.createElement("button"); stateButton.className = "secondary"; stateButton.type = "button";
    stateButton.textContent = key.active ? "Deactivate" : "Activate";
    stateButton.setAttribute("aria-label", `${key.active ? "Deactivate" : "Activate"} API key ${key.name || key.id}`);
    stateButton.addEventListener("click", () => setKeyState(key.id, !key.active, stateButton));
    const actions = document.createElement("div"); actions.className = "key-actions"; actions.append(stateButton);
    const select = document.createElement("button"); select.type = "button"; select.className = "secondary";
    select.textContent = key.id === setupKeyId ? "Selected" : "Select key";
    select.setAttribute("aria-label", `Select API key ${key.name || key.id}`); select.setAttribute("aria-pressed", String(key.id === setupKeyId));
    select.addEventListener("click", () => selectKey(key.id)); actions.prepend(select);
    const test = document.createElement("button"); test.type = "button"; test.className = "secondary"; test.textContent = pendingTests.has(key.id) ? "Testing…" : "Test connection"; test.disabled = !key.active || expired || pendingTests.has(key.id);
    test.setAttribute("aria-label", "Test connection for " + (key.name || key.id));
    test.addEventListener("click", () => { selectKey(key.id); showView("connect"); void testConnection(key.id); });
    actions.append(test);
    const login = document.createElement('button'); login.type = 'button'; login.className = 'secondary';
    login.textContent = setupData.keys.find(entry => entry.id === key.id)?.authStatus === 'credentials_found' ? 'Sign in again' : 'Sign in to Codex';
    login.setAttribute('aria-label', `Sign in to Codex for ${key.name || key.id}`);
    login.disabled = !key.active || expired;
    login.addEventListener('click', () => { selectKey(key.id); showView('connect'); void deviceLogin(); });
    actions.append(login);
    if (!key.active) {
      const deleteButton = document.createElement("button"); deleteButton.className = "danger"; deleteButton.type = "button"; deleteButton.textContent = "Delete permanently";
      deleteButton.setAttribute("aria-label", `Permanently delete API key ${key.name || key.id}`);
      deleteButton.addEventListener("click", () => deleteKey(key, deleteButton));
      actions.append(deleteButton);
    }

    const policy = document.createElement("details"); policy.className = "key-policy";
    const summary = document.createElement("summary"); summary.textContent = `Edit policy for ${key.name || "this key"}`;
    const form = document.createElement("form"); form.className = "policy-form";
    const rpm = document.createElement("input"); rpm.type = "number"; rpm.min = "1"; rpm.step = "1"; rpm.required = true; rpm.value = String(key.requestsPerMinute || 60);
    const rpmField = policyField("Requests / minute", `rpm-${key.id}`, rpm); rpmField.classList.add("compact-field");
    const expiry = document.createElement("input"); expiry.type = "datetime-local"; expiry.value = localDateTimeValue(key.expiresAt);
    const expiryField = policyField("Expiry (optional)", `expiry-${key.id}`, expiry);
    const origins = document.createElement("textarea"); origins.rows = 3; origins.value = (key.allowedOrigins || []).join("\n");
    origins.placeholder = "http://127.0.0.1:5500\nhttp://localhost:3000";
    const originsField = policyField("Browser origins (optional)", `origins-${key.id}`, origins); originsField.classList.add("origins-field");
    const originsHelp = document.createElement("p"); originsHelp.className = "muted"; originsHelp.id = `origins-help-${key.id}`;
    originsHelp.textContent = "One exact http:// or https:// origin per line or comma, with no path. Blank keeps cross-origin browser access disabled. Server and CLI clients are unaffected.";
    origins.setAttribute("aria-describedby", originsHelp.id + " policy-error-" + key.id); originsField.append(originsHelp);
    const policyError = document.createElement("p"); policyError.className = "error-state policy-error"; policyError.id = `policy-error-${key.id}`; policyError.setAttribute("role", "alert"); policyError.hidden = true;
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save policy"; save.setAttribute("aria-label", `Save policy for API key ${key.name || key.id}`);
    const clear = document.createElement("button"); clear.className = "secondary"; clear.type = "button"; clear.textContent = "Clear expiry"; clear.setAttribute("aria-label", `Clear expiry for API key ${key.name || key.id}`); clear.disabled = !key.expiresAt;
    clear.addEventListener("click", () => updateKeyPolicy(key.id, { expiresAt: null }, clear, policyError));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.reportValidity()) updateKeyPolicy(key.id, { requestsPerMinute: Number(rpm.value), expiresAt: canonicalExpiry(expiry.value), allowedOrigins: parseOrigins(origins.value) }, save, policyError);
    });
    form.append(rpmField, expiryField, originsField, policyError, save, clear); policy.append(summary, form);
    card.append(details, actions, policy); fragment.append(card);
  });
  elements.keys.replaceChildren(fragment);
  renderKeyDetail(selectedKey());
}

async function refreshDashboard() {
  const generation = ++refreshGeneration;
  elements.keys.setAttribute("aria-busy", "true"); elements.overview.setAttribute("aria-busy", "true");
  renderMessage("Loading keys…", "loading"); setStatus("Loading dashboard…");
  try {
    const healthVersion = ++healthGeneration;
    const [keys, metrics, setup, health] = await Promise.allSettled([api(), requestJson("/admin/metrics"), requestJson("/admin/setup"), requestJson("/admin/health")]);
    if (generation !== refreshGeneration) return;
    const failures = [];
    keysLoaded = keys.status === "fulfilled";
    if (keysLoaded) dashboardKeys = Array.isArray(keys.value.data) ? keys.value.data : [];
    else { dashboardKeys = []; failures.push("API keys unavailable"); }
    if (setup.status === "fulfilled") {
      setupData = {models:Array.isArray(setup.value.models) ? setup.value.models : [], keys:Array.isArray(setup.value.keys) ? setup.value.keys : []};
      setupLoaded = true;
    } else { setupData = {models:[],keys:[]}; setupLoaded = false; failures.push("Setup status unavailable"); }
    if (healthVersion === healthGeneration) { healthData = health.status === "fulfilled" ? health.value : undefined; if (health.status === "rejected") failures.push("Gateway health unavailable"); }
    const previousKeyId = setupKeyId;
    renderChoices();
    if (previousKeyId !== setupKeyId) clearLogin();
    if (pendingDefaults && setupLoaded) { const value = pendingDefaults; pendingDefaults = undefined; applyDefaults(value); }
    renderKeys(dashboardKeys); renderHealth(); renderSetup(); persistPreferences(); sendCatalog();
    if (keys.status === "rejected") renderMessage("API keys unavailable. Refresh to try again.", "error-state");
    if (metrics.status === "fulfilled") renderMetrics(metrics.value); else { unavailableMetrics(); failures.push("Metrics unavailable"); }
    await loadHistory();
    if (generation !== refreshGeneration) return;
    if (setupConfigError) failures.push("Setup configuration unavailable");
    setStatus(failures.length ? failures.join(" · ") : "Dashboard up to date", failures.length > 0);
  } catch (error) {
    renderMessage(error.message, "error-state"); unavailableMetrics();
    setStatus(setupConfigError ? `Could not load setup configuration: ${setupConfigError}` : "Could not load dashboard", true);
  } finally {
    if (generation === refreshGeneration) { elements.keys.setAttribute("aria-busy", "false"); elements.overview.setAttribute("aria-busy", "false"); }
  }
}

async function setKeyState(id, active, button) {
  if (!id) return;
  button.disabled = true;
  try { await api(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active }) }); await refreshDashboard(); }
  catch (error) { setStatus(error.message, true); button.disabled = false; }
}

async function updateKeyPolicy(id, policy, button, errorElement) {
  if (!id) return;
  if (errorElement) errorElement.hidden = true;
  button.disabled = true;
  try { await api(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(policy) }); await refreshDashboard(); }
  catch (error) {
    setStatus(error.message, true); button.disabled = false;
    if (errorElement) { errorElement.textContent = error.message; errorElement.hidden = false; }
  }
}

function confirmKeyDeletion(label) {
  const dialog = $("delete-dialog");
  if (dialog.open) return Promise.resolve(false);
  $("delete-description").textContent = `Delete ${label}? This removes its API key record, Codex login, history, and state.`;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), { once: true });
    dialog.showModal();
  });
}

async function deleteKey(key, button) {
  const label = key.name || key.id;
  if (!await confirmKeyDeletion(label)) return;
  button.disabled = true;
  try {
    await api(`/${encodeURIComponent(key.id)}`, { method: "DELETE" });
    secrets.delete(key.id);
    testErrors.delete(key.id);
    if (setupKeyId === key.id) {
      clearLogin();
      setupKey = "YOUR_KEY"; setupKeyId = "key_REPLACE_WITH_ID"; elements.secret.textContent = ""; elements.secretPanel.hidden = true; renderSetup();
    }
    setStatus(`Deleted ${label} permanently.`); await refreshDashboard();
  } catch (error) { setStatus(error.message, true); button.disabled = false; }
}

async function copyText(id, button) {
  const value = document.getElementById(id).textContent;
  try { await navigator.clipboard.writeText(value); button.textContent = "Copied"; }
  catch { setStatus("Clipboard access was blocked. Select and copy the text manually.", true); return; }
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;
  const name = elements.name.value.trim(); if (!name) return;
  $("workspace-error").hidden = true;
  $("origins-error").hidden = true;
  $("create-error").hidden = true;
  const button = elements.form.querySelector("button[type=submit]"); button.disabled = true;
  try {
    const key = await api("", { method: "POST", body: JSON.stringify({ name, workspaceRoot: elements.workspaceRoot.value.trim(), requestsPerMinute: Number(elements.requestsPerMinute.value), expiresAt: canonicalExpiry(elements.expiresAt.value), allowedOrigins: parseOrigins(elements.allowedOrigins.value) }) });
    elements.secret.textContent = key.key || ""; elements.secretPanel.hidden = !key.key;
    clearLogin(); setupKey = key.key; setupKeyId = key.id; secrets.set(key.id, key.key); $("setup-secret").value = key.key; renderSetup(); elements.name.value = ""; elements.requestsPerMinute.value = "60"; elements.expiresAt.value = "";
    if ($("key-expiry-mode")) $("key-expiry-mode").value = "never";
    elements.allowedOrigins.value = "";
    renderExpiryMode(); persistPreferences();
    setStatus("Key created. Copy the secret now."); await refreshDashboard();
  } catch (error) {
    setStatus(error.message, true);
    const errorElement = /origin/i.test(error.message) ? $("origins-error") : /workspace|directory|folder/i.test(error.message) ? $("workspace-error") : $("create-error");
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally { button.disabled = false; }
});

document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copy, button)));
elements.refresh.addEventListener("click", refreshDashboard);
$('key-search').addEventListener('input', () => renderKeys(dashboardKeys));
$('key-filter').addEventListener('change', () => renderKeys(dashboardKeys));
$('health-check').addEventListener('click', checkHealth);
$('diagnostic-check').addEventListener('click', async () => {
  const button = $('diagnostic-check'); button.disabled = true;
  $('diagnostic-report').hidden = false; $('diagnostic-report').textContent = 'Preparing sanitized report…'; $('diagnostic-copy').hidden = true;
  if ($('diagnostic-technical')) { $('diagnostic-technical').hidden = false; if ($('diagnostic-technical').tagName === 'DETAILS') $('diagnostic-technical').open = true; }
  try { $('diagnostic-report').textContent = JSON.stringify(sanitizedReport(await requestJson('/admin/diagnostics')), null, 2); $('diagnostic-copy').hidden = false; }
  catch (error) { $('diagnostic-report').textContent = `Report unavailable: ${error.message}`; }
  finally { button.disabled = false; }
});
$('diagnostic-copy').addEventListener('click', () => copyText('diagnostic-report', $('diagnostic-copy')));
document.querySelector("#setup-platform").addEventListener("change", renderSetup);
$("setup-key").addEventListener("change", () => selectKey($("setup-key").value));
$("setup-secret").addEventListener("input", () => { secrets.set(setupKeyId, $("setup-secret").value); renderSetup(); });
$("setup-model").addEventListener("change", () => { preferences.model = $("setup-model").value; renderEfforts(); persistPreferences(); });
$("setup-reasoning").addEventListener("change", () => { preferences.reasoning = $("setup-reasoning").value; renderSetup(); persistPreferences(); });
$("test-connection").addEventListener("click", () => testConnection());
$("login-codex").addEventListener("click", () => { if (currentView !== "onboarding") showView("connect"); void deviceLogin(); });
$("login-again").addEventListener("click", () => { if (currentView !== "onboarding") showView("connect"); void deviceLogin(); });
$("login-link").addEventListener("click", (event) => {
  if (!desktopToken || window.parent === window) return;
  event.preventDefault();
  // No secret or URL crosses this bridge; the parent verifies sender and origin.
  postDesktop({ type: "codex-desktop-open-login" });
});
$("login-cancel").addEventListener("click", () => deviceLogin("DELETE"));
bindNavigation();
renderSetup();
loadConfig();
refreshDashboard();
