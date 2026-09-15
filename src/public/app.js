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
let setupData = { models: [], keys: [] };
const secrets = new Map();
let loginTimer;
let loginGeneration = 0;
let pendingLoginKey;
const pendingTests = new Set();
const $ = (id) => document.getElementById(id);
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const elements = {
  form: document.querySelector("#create-form"), name: document.querySelector("#key-name"),
  workspaceRoot: document.querySelector("#key-workspace-root"),
  requestsPerMinute: document.querySelector("#key-rpm"), expiresAt: document.querySelector("#key-expiry"),
  keys: document.querySelector("#keys"), status: document.querySelector("#status"), overview: document.querySelector(".overview"),
  secretPanel: document.querySelector("#secret-panel"), secret: document.querySelector("#new-secret"), refresh: document.querySelector("#refresh"),
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("error", isError);
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

async function loadConfig() {
  setupConfigError = "";
  renderSetup();
  try {
    adminConfig = await requestJson("/admin/config");
    const migration = adminConfig.desktopMigration;
    $("migration-notice").hidden = !migration || ["existing", "not_found"].includes(migration.status);
    $("migration-notice").textContent = migration?.message || "";
    document.querySelector("#setup-platform").value = /^[A-Za-z]:[\\/]/.test(adminConfig.codexStateRoot) ? "windows" : "macos";
    renderChoices();
  } catch (error) {
    setupConfigError = error.message;
    renderSetup();
    setStatus(`Could not load setup configuration: ${error.message}`, true);
  }
}

function renderSetup() {
  if (!adminConfig) {
    ["setup-workspace-root", "key-create-example", "base-url", "login-example", "vscode-example", "curl-example", "tunnel-example"].forEach((id) => { $(id).textContent = setupConfigError ? "Unavailable: " + setupConfigError : "Loading server configuration…"; });
    return;
  }
  const windows = $("setup-platform").value === "windows";
  const quote = windows ? psQuote : shellQuote;
  const model = $("setup-model").value || adminConfig.defaultModel;
  const effort = $("setup-reasoning").value;
  const modelId = model;
  const baseUrl = window.location.origin + "/v1";
  const secret = $("setup-secret").value || "YOUR_KEY";
  const home = adminConfig.codexStateRoot.replace(/[\\/]$/, "") + (/^[A-Za-z]:/.test(adminConfig.codexStateRoot) ? "\\" : "/") + setupKeyId;
  $("workspace-help").textContent = "Choose an existing folder inside " + adminConfig.workspaceRoot + ". This is the folder this key can access.";
  elements.workspaceRoot.placeholder = adminConfig.workspaceRoot.replace(/[\\/]$/, "") + (/^[A-Za-z]:/.test(adminConfig.workspaceRoot) ? "\\my-project" : "/my-project");
  $("base-url").textContent = baseUrl + "/chat/completions";
  $("setup-workspace-root").textContent = "Allowed workspace: " + adminConfig.workspaceRoot;
  $("key-create-example").textContent = "Create a key for an existing project folder above, save its secret, then select it here.";
  $("login-example").textContent = desktopToken ? "Click Login to Codex above. The desktop app includes Codex and manages your sign-in; no terminal setup is needed." : windows
    ? "$env:CODEX_HOME=" + quote(home) + "\nNew-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null\ncodex login"
    : "export CODEX_HOME=" + quote(home) + '\nmkdir -p "$CODEX_HOME"\ncodex login';
  $("vscode-example").textContent = JSON.stringify([{name:"Local Codex CLI API", vendor:"customendpoint", apiKey:secret, apiType:"chat-completions", models:[{id:modelId,name:modelId,url:baseUrl+"/chat/completions",toolCalling:false,vision:false,thinking:true,supportsReasoningEffort:setupData.models.find((entry) => entry.id === model)?.efforts || [],reasoningEffortFormat:"chat-completions"}]}], null, 2);
  const payload = JSON.stringify({model:modelId,messages:[{role:"user",content:"Say hello"}],stream:false,...(effort ? {reasoning_effort:effort} : {})});
  $("curl-example").textContent = windows
    ? "Invoke-RestMethod -Method Post -Uri " + quote(baseUrl+"/chat/completions") + " -Headers @{ Authorization = " + quote("Bearer "+secret) + " } -ContentType 'application/json' -Body " + quote(payload)
    : "curl " + quote(baseUrl+"/chat/completions") + " -H " + quote("Authorization: Bearer "+secret) + " -H 'Content-Type: application/json' -d " + quote(payload);
  $("tunnel-example").textContent = ["tunnel: YOUR_TUNNEL_ID","credentials-file: "+(windows ? "'C:/Users/YOU/.cloudflared/YOUR_TUNNEL_ID.json'" : "'/Users/YOU/.cloudflared/YOUR_TUNNEL_ID.json'"),"ingress:","  - hostname: api.example.com","    path: ^/v1(/|$)","    service: "+window.location.origin,"  - service: http_status:404"].join("\n");
  const key = dashboardKeys.find((entry) => entry.id === setupKeyId);
  $("setup-progress").textContent = key ? progressText(key) : "Create a key to begin.";
  $("test-connection").disabled = !key || !key.active || isExpired(key.expiresAt) || pendingTests.has(key.id);
  $("login-codex").disabled = !key || !key.active || isExpired(key.expiresAt) || pendingLoginKey === key.id;
}

function clearLogin() {
  clearTimeout(loginTimer); loginGeneration++;
  pendingLoginKey = undefined;
  $("login-status").textContent = desktopToken ? "Use Login to Codex to sign in with your own account." : "Sign in here, or use the terminal command below.";
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
  if (state.ready && state.authStatus === "credentials_found" && state.lastTest?.ok) {
    const changedModel = key.id === setupKeyId && $("setup-model").value && $("setup-model").value !== state.lastTest.model;
    return "Key created → Test passed for " + state.lastTest.model + " → " + (changedModel ? "Test the selected model before using it." : "Ready for VS Code") + " · Last tested " + formatDate(state.lastTest.testedAt);
  }
  if (state.lastTest && !state.lastTest.ok) return "Key created · Test failed: " + state.lastTest.message;
  return state.authStatus === "credentials_found"
    ? "Key created → Codex credentials found → Test connection next. Credentials alone do not confirm a valid login."
    : desktopToken ? "Key created → Click Sign in to Codex → Test connection." : "Key created → Sign in to Codex using the command below → Test connection.";
}

function renderChoices() {
  const selectedModel = $("setup-model").value;
  $("setup-key").replaceChildren(...(dashboardKeys.length ? dashboardKeys.map((key) => new Option(key.name || key.id, key.id)) : [new Option("Create a key first", "")]));
  if (!dashboardKeys.some((key) => key.id === setupKeyId)) setupKeyId = dashboardKeys[0]?.id || "key_REPLACE_WITH_ID";
  $("setup-key").value = setupKeyId;
  $("setup-secret").value = secrets.get(setupKeyId) || "";
  $("setup-model").replaceChildren(...setupData.models.map((model) => new Option(model.id, model.id)));
  if (setupData.models.some((model) => model.id === selectedModel)) $("setup-model").value = selectedModel;
  else if (adminConfig) $("setup-model").value = adminConfig.defaultModel;
  renderEfforts();
}

function renderEfforts() {
  const selected = $("setup-reasoning").value;
  const model = setupData.models.find((entry) => entry.id === $("setup-model").value);
  $("setup-reasoning").replaceChildren(new Option("Model default", ""), ...(model?.efforts || []).map((effort) => new Option(effort, effort)));
  if ((model?.efforts || []).includes(selected)) $("setup-reasoning").value = selected;
  renderSetup();
}

async function testConnection(id = setupKeyId, button = $("test-connection")) {
  if (pendingTests.has(id)) return;
  pendingTests.add(id);
  button.disabled = true;
  $("test-result").textContent = "Testing… This may take a minute.";
  try {
    const result = await api("/" + encodeURIComponent(id) + "/test", {method:"POST",body:JSON.stringify({model:$("setup-model").value || adminConfig?.defaultModel, reasoningEffort:$("setup-reasoning").value || undefined})});
    $("test-result").textContent = (result.ok ? "Test passed: " : "Test failed: ") + result.message;
    await refreshDashboard();
  } catch (error) { $("test-result").textContent = "Test failed: " + error.message; await refreshDashboard(); }
  finally { pendingTests.delete(id); button.disabled = false; renderKeys(dashboardKeys); renderSetup(); }
}

async function loadHistory() {
  try {
    const body = await requestJson("/admin/requests");
    $("request-history").replaceChildren(...body.data.map((item) => {
      const row = document.createElement("tr");
      [formatDate(item.timestamp), dashboardKeys.find((key) => key.id === item.keyId)?.name || item.keyId || "—",item.model || "—",item.status + " (" + item.httpStatus + ")",item.durationMs+" ms",String(item.inputTokens ?? "—")+" / "+String(item.outputTokens ?? "—")].forEach((value) => { const cell = document.createElement("td"); cell.textContent=value; row.append(cell); });
      return row;
    }));
    $("history-status").textContent = body.data.length ? "Refresh to see the latest requests." : "No requests yet. Test a connection to begin.";
  } catch (error) { $("history-status").textContent = "Request history unavailable: " + error.message; }
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Never" : date.toLocaleString();
}

function localDateTimeValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function canonicalExpiry(value) { return value ? new Date(value).toISOString() : null; }
function isExpired(value) { return value !== null && value !== undefined && !Number.isNaN(Date.parse(value)) && Date.parse(value) <= Date.now(); }

function renderMessage(text, className) {
  elements.keys.replaceChildren(Object.assign(document.createElement("p"), { className, textContent: text }));
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
  if (!keys.length) return renderMessage("No API keys yet. Create one above to get started.", "empty");
  const fragment = document.createDocumentFragment();
  keys.forEach((key) => {
    const card = document.createElement("article"); card.className = "key-card";
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
    appendMeta(details, progressText(key));

    const stateButton = document.createElement("button"); stateButton.className = "secondary"; stateButton.type = "button";
    stateButton.textContent = key.active ? "Deactivate" : "Activate";
    stateButton.setAttribute("aria-label", `${key.active ? "Deactivate" : "Activate"} API key ${key.name || key.id}`);
    stateButton.addEventListener("click", () => setKeyState(key.id, !key.active, stateButton));
    const actions = document.createElement("div"); actions.className = "key-actions"; actions.append(stateButton);
    const test = document.createElement("button"); test.type = "button"; test.className = "secondary"; test.textContent = pendingTests.has(key.id) ? "Testing…" : "Test connection"; test.disabled = !key.active || expired || pendingTests.has(key.id);
    test.setAttribute("aria-label", "Test connection for " + (key.name || key.id));
    test.addEventListener("click", () => { if (setupKeyId !== key.id) { clearLogin(); setupKeyId = key.id; renderChoices(); deviceLogin("GET"); } testConnection(key.id, test); });
    actions.append(test);
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
    const save = document.createElement("button"); save.type = "submit"; save.textContent = "Save policy"; save.setAttribute("aria-label", `Save policy for API key ${key.name || key.id}`);
    const clear = document.createElement("button"); clear.className = "secondary"; clear.type = "button"; clear.textContent = "Clear expiry"; clear.setAttribute("aria-label", `Clear expiry for API key ${key.name || key.id}`); clear.disabled = !key.expiresAt;
    clear.addEventListener("click", () => updateKeyPolicy(key.id, { expiresAt: null }, clear));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (form.reportValidity()) updateKeyPolicy(key.id, { requestsPerMinute: Number(rpm.value), expiresAt: canonicalExpiry(expiry.value) }, save);
    });
    form.append(rpmField, expiryField, save, clear); policy.append(summary, form);
    card.append(details, actions, policy); fragment.append(card);
  });
  elements.keys.replaceChildren(fragment);
}

async function refreshDashboard() {
  elements.keys.setAttribute("aria-busy", "true"); elements.overview.setAttribute("aria-busy", "true");
  renderMessage("Loading keys…", "loading"); setStatus("Loading dashboard…");
  const previousKeyId = setupKeyId;
  try {
    const [keyBody, metrics] = await Promise.all([api(), requestJson("/admin/metrics")]);
    dashboardKeys = Array.isArray(keyBody.data) ? keyBody.data : [];
    try { setupData = await requestJson("/admin/setup"); } catch (error) { setupData = {models:[],keys:[]}; $("test-result").textContent = "Setup status unavailable: " + error.message; }
    renderChoices(); renderKeys(dashboardKeys); renderMetrics(metrics); await loadHistory();
    if (previousKeyId !== setupKeyId) { clearLogin(); deviceLogin("GET"); }
    setStatus(setupConfigError ? `Could not load setup configuration: ${setupConfigError}` : "Dashboard up to date", Boolean(setupConfigError));
  } catch (error) {
    renderMessage(error.message, "error-state"); unavailableMetrics();
    setStatus(setupConfigError ? `Could not load setup configuration: ${setupConfigError}` : "Could not load dashboard", true);
  } finally {
    elements.keys.setAttribute("aria-busy", "false"); elements.overview.setAttribute("aria-busy", "false");
  }
}

async function setKeyState(id, active, button) {
  if (!id) return;
  button.disabled = true;
  try { await api(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active }) }); await refreshDashboard(); }
  catch (error) { setStatus(error.message, true); button.disabled = false; }
}

async function updateKeyPolicy(id, policy, button) {
  if (!id) return;
  button.disabled = true;
  try { await api(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(policy) }); await refreshDashboard(); }
  catch (error) { setStatus(error.message, true); button.disabled = false; }
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
  const button = elements.form.querySelector("button[type=submit]"); button.disabled = true;
  try {
    const key = await api("", { method: "POST", body: JSON.stringify({ name, workspaceRoot: elements.workspaceRoot.value.trim(), requestsPerMinute: Number(elements.requestsPerMinute.value), expiresAt: canonicalExpiry(elements.expiresAt.value) }) });
    elements.secret.textContent = key.key || ""; elements.secretPanel.hidden = !key.key;
    clearLogin(); setupKey = key.key; setupKeyId = key.id; secrets.set(key.id, key.key); $("setup-secret").value = key.key; renderSetup(); elements.name.value = ""; elements.requestsPerMinute.value = "60"; elements.expiresAt.value = "";
    setStatus("Key created. Copy the secret now."); await refreshDashboard();
  } catch (error) { setStatus(error.message, true); $("workspace-error").textContent = error.message + (adminConfig ? " Choose an existing project directory inside " + adminConfig.workspaceRoot + "." : ""); $("workspace-error").hidden = false; } finally { button.disabled = false; }
});

document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", () => copyText(button.dataset.copy, button)));
elements.refresh.addEventListener("click", refreshDashboard);
document.querySelector("#setup-platform").addEventListener("change", renderSetup);
$("setup-key").addEventListener("change", () => { clearLogin(); setupKeyId = $("setup-key").value; $("setup-secret").value = secrets.get(setupKeyId) || ""; renderSetup(); deviceLogin("GET"); });
$("setup-secret").addEventListener("input", () => { secrets.set(setupKeyId, $("setup-secret").value); renderSetup(); });
$("setup-model").addEventListener("change", renderEfforts);
$("setup-reasoning").addEventListener("change", renderSetup);
$("test-connection").addEventListener("click", () => testConnection());
$("login-codex").addEventListener("click", () => deviceLogin());
$("login-link").addEventListener("click", (event) => {
  if (!desktopToken || window.parent === window) return;
  event.preventDefault();
  // No secret or URL crosses this bridge; the parent verifies sender and origin.
  window.parent.postMessage({ type: "codex-desktop-open-login" }, "*");
});
$("login-cancel").addEventListener("click", () => deviceLogin("DELETE"));
renderSetup();
loadConfig();
refreshDashboard();
