# Codex CLI API

Local OpenAI-compatible HTTP access to an authenticated Codex CLI. Each API key
is bound to one workspace and generation results stream over SSE.

Created by **Dhruv** — [thisisdhruv.in](https://thisisdhruv.in).

## Desktop app

The Tauri app bundles Node and Codex, saves settings in the OS app-data folder, and runs the dashboard in a native window. Users do not need a `.env` or terminal setup.

Build a macOS installer: `npm ci` then `npm run desktop:dmg` (Node, Rust, and Xcode Command Line Tools required for builders). The app and DMG are saved under `release/`; the DMG includes `README.txt` with creator information and setup steps. See [desktop build and installation instructions](docs/desktop.md).

For hosted builds, the manual GitHub Actions workflow builds macOS Apple Silicon and Windows x64 installers from one version tag, then stages a GitHub draft release with signed updater artifacts. Publication stays manual. See [the release guide](docs/releasing.md) for setup, testing and publishing.

## Scope and security

The gateway accepts OpenAI-compatible Chat Completions and Responses requests.
It is **not** an OpenAI hosted-model proxy: it does not accept
`OPENAI_API_KEY` and it cannot provide every OpenAI model. Requests run through
the local Codex CLI. Use authenticated `GET /v1/models` to discover enabled
model IDs.

Each key can use only one existing workspace below `CODEX_WORKSPACE_ROOT`.
Keep `CODEX_STATE_ROOT` and `CODEX_API_KEY_FILE` outside that directory tree.
The dashboard and `/admin/*` are local-only; save a `dsh_live_...` secret when
it is created because it is only shown once.

## Dashboard onboarding

Open the local dashboard after starting the server. Create a key using the
workspace guidance beside the folder field, then select it in the connection
wizard. Click **Sign in to Codex**, open the displayed official sign-in page,
and enter the one-time code. The page reports completion and offers cancellation;
the terminal login command remains available as a fallback. Each key signs in
to its own Codex home. The wizard also provides model and reasoning selectors
and VS Code configuration. Existing key secrets must be supplied
again; the server cannot recover them and the browser does not persist them.

Use **Test connection** to run a small read-only generation. This consumes
provider usage and the key's normal request allowance. Credentials found on
disk alone do not prove the login works: only a successful generation confirms
the connection for the tested model. Status and the latest 100 request records
are kept in memory and reset when the gateway restarts. History contains
request metadata, never prompts, generated text, or credentials.

## macOS setup

```zsh
npm install
cp .env.example .env
```

Set a repository parent as the workspace root and keep server state elsewhere:

```dotenv
CODEX_STATE_ROOT=/Users/YOU/.codex-cli-api/users
CODEX_API_KEY_FILE=/Users/YOU/.codex-cli-api/api-keys.json
CODEX_WORKSPACE_ROOT=/Users/YOU/Documents/Dev
```

Create a workspace-bound key and authenticate its isolated Codex home. The
`codex login` account is the gateway operator credential, not the client API key.

```zsh
npm run key:create -- --name vscode-local --workspace "/Users/YOU/Documents/Dev/my-project"
export CODEX_HOME="/Users/YOU/.codex-cli-api/users/key_REPLACE_WITH_PRINTED_ID"
mkdir -p "$CODEX_HOME"
codex login
npm run dev
curl -fsS http://127.0.0.1:3081/readyz
```

Use `npm start` where source watching is not wanted. Stop and start the process
after editing `.env` because source watching does not reload environment values.

## Windows setup

```powershell
npm install
Copy-Item .env.example .env
```

Forward slashes are accepted on Windows:

```dotenv
CODEX_STATE_ROOT=C:/Users/YOU/.codex-cli-api/users
CODEX_API_KEY_FILE=C:/Users/YOU/.codex-cli-api/api-keys.json
CODEX_WORKSPACE_ROOT=D:/GIT CLONED PROJECTS
```

```powershell
npm run key:create -- --name vscode-local --workspace "D:/GIT CLONED PROJECTS/my-project"
$env:CODEX_HOME = 'C:/Users/YOU/.codex-cli-api/users/key_REPLACE_WITH_PRINTED_ID'
New-Item -ItemType Directory -Force $env:CODEX_HOME | Out-Null
codex login
npm run dev
curl.exe -fsS http://127.0.0.1:3081/readyz
```

## Test a key

macOS / Linux:

```zsh
export CODEX_API_KEY='dsh_live_REPLACE_ME'
curl -sS http://127.0.0.1:3081/v1/models -H "Authorization: Bearer $CODEX_API_KEY"
curl -N http://127.0.0.1:3081/v1/chat/completions -H "Authorization: Bearer $CODEX_API_KEY" -H 'Content-Type: application/json' -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Explain this project."}],"stream":true,"reasoning_effort":"high"}'
```

Windows PowerShell:

```powershell
$env:CODEX_API_KEY = 'dsh_live_REPLACE_ME'
curl.exe -sS http://127.0.0.1:3081/v1/models -H "Authorization: Bearer $env:CODEX_API_KEY"
curl.exe -N http://127.0.0.1:3081/v1/chat/completions -H "Authorization: Bearer $env:CODEX_API_KEY" -H "Content-Type: application/json" -d '{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"Explain this project."}],"stream":true,"reasoning_effort":"high"}'
```

`/readyz` checks the workspace, state root, and key-file parent. Repair it
before troubleshooting any client.

## Personal browser apps: allowed origins

Create a key for your project, sign in to Codex, and test its connection. In
**Create API key** (including guided setup) or **API Keys → Edit policy**, add
your frontend's address under **Browser origins**, for example
`http://127.0.0.1:5500`. Save the policy, then use the key with the API endpoint
`http://127.0.0.1:3081/v1` and a model returned by `/v1/models`. **Connect**
includes a JavaScript example for your own app.

Enter one origin per line or separate them with commas. Origins include the
scheme, hostname, and port, but no page path: enter `http://127.0.0.1:5500`,
not `http://127.0.0.1:5500/index.html`. `localhost` and `127.0.0.1` are different
origins; add each one you use. Wildcards are not supported. The list belongs to
each key and is saved with its policy, so desktop users do not need a `.env`
setting. Existing keys default to an empty list, which disables cross-origin
browser access while retaining same-origin and server/CLI access.

Browser preflight requests do not contain the API key. The gateway handles
preflight for supported API methods and headers, then authenticates the actual
request and checks its origin against that specific key before running it.
Browser permissions never grant access to the desktop administration routes.
CORS is a browser control, not a substitute for the secret API key.

For a personal local demo, accept the key through a password field and keep it
in page memory. Do not serve `.env`, embed a shared secret in frontend code, or
commit it. For an app shared with other people, keep your secret in your backend.
The loopback endpoint connects to the gateway on the same computer as the client.

## VS Code: direct localhost integration

If VS Code is on the same computer as the gateway, use:

```text
http://127.0.0.1:3081/v1/chat/completions
```

No tunnel, public hostname, or public HTTPS endpoint is needed. VS Code's
**Custom Endpoint** provider replaces its deprecated OpenAI-Compatible provider:

1. Open the Chat model picker, select the gear icon, then **Manage Language
   Models** (or run **Chat: Manage Language Models**).
2. Choose **Add Models** → **Custom Endpoint**.
3. Add the `dsh_live_...` secret, choose **Chat Completions**, then configure:

```json
[
  {
    "name": "Local Codex CLI API",
    "vendor": "customendpoint",
    "apiKey": "${input:codexCliApiKey}",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "gpt-5.6-sol",
        "name": "Codex Sol (local gateway)",
        "url": "http://127.0.0.1:3081/v1/chat/completions",
        "toolCalling": false,
        "vision": false,
        "thinking": true,
        "supportsReasoningEffort": ["low", "medium", "high", "xhigh", "max", "ultra"],
        "reasoningEffortFormat": "chat-completions"
      }
    ]
  }
]
```

Store the key through VS Code's input prompt, not workspace settings. Check
`/v1/models` before adding another ID, and reload VS Code if the model is not
visible.

| Model IDs | Default reasoning levels |
| --- | --- |
| `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `low` through `max` |
| `gpt-5.5`, `gpt-5.4-mini` | `low` through `xhigh` |

`CODEX_MODELS`, `CODEX_IMAGE_MODELS`, and `CODEX_MODEL_EFFORTS` override
these defaults. `/v1/models` returns enabled IDs, reasoning levels, and image
modality. Chat Completions sends `reasoning_effort`; Responses sends
`reasoning.effort`.

### Capability limits

- This endpoint provides BYOK chat, not GitHub Copilot semantic search,
  embeddings, or inline suggestions.
- The server does not publish canonical context-window or output-token limits.
  Do not invent `maxInputTokens` or `maxOutputTokens` in VS Code settings.
- Image support uses the gateway's custom `images` field with existing paths
  inside the API key's workspace. Standard VS Code image attachments are not
  supported, so its model configuration must use `vision: false`.
- `cwd` cannot escape the workspace; only `read-only` and
  `workspace-write` sandboxes are accepted.
- Tool calls, persistent `previous_response_id` state, and non-text Responses
  input are not supported.

See [VS Code's language-model guide](https://code.visualstudio.com/docs/agent-customization/language-models)
for the current Custom Endpoint workflow.

## Remote clients: restricted HTTPS tunnel

Use a tunnel only when a client cannot reach localhost, such as hosted
automation or another computer. A named Cloudflare Tunnel is the documented
option: it retains its hostname on restart and can allow only the API route.
Do not use a quick tunnel for this gateway.

The configuration below forwards only `/v1/*`. It returns 404 for the
dashboard, `/admin/*`, `/healthz`, `/readyz`, and all other paths. A forwarded
API request still requires `Authorization: Bearer dsh_live_...`.

You need a Cloudflare-managed domain and permission to create a tunnel/DNS
record.

```zsh
# macOS install
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create codex-cli-api
cloudflared tunnel route dns codex-cli-api api.example.com
```

On Windows, install the current `cloudflared.exe` or MSI from Cloudflare, add
it to `PATH`, and run the same tunnel commands in PowerShell.

Create `~/.cloudflared/config.yml` on macOS or
`%USERPROFILE%\\.cloudflared\\config.yml` on Windows. Replace the UUID and
credentials path with the values printed by `tunnel create`:

```yaml
tunnel: REPLACE_WITH_TUNNEL_UUID
credentials-file: /Users/YOU/.cloudflared/REPLACE_WITH_TUNNEL_UUID.json

ingress:
  - hostname: api.example.com
    path: ^/v1(/|$)
    service: http://127.0.0.1:3081
  - hostname: api.example.com
    service: http_status:404
  - service: http_status:404
```

On Windows, use a credentials-file such as
`C:/Users/YOU/.cloudflared/REPLACE_WITH_TUNNEL_UUID.json`. Ingress rules are
checked in order, so the second and final rules deliberately deny non-API
traffic.

```zsh
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://api.example.com/v1/models
cloudflared tunnel ingress rule https://api.example.com/admin/api-keys
cloudflared tunnel run codex-cli-api
```

Verify the public boundary:

```zsh
# Expected: 401; /v1 reaches the API but has no key.
curl -i https://api.example.com/v1/models
# Expected: 404; dashboard/admin is never public.
curl -i https://api.example.com/
curl -i https://api.example.com/admin/api-keys
```

Remote clients use:

```text
https://api.example.com/v1/chat/completions
```

### Tunnel lifecycle

- **Start:** after `/readyz` passes, run `cloudflared tunnel run codex-cli-api`.
- **Stop:** press <kbd>Ctrl</kbd>+<kbd>C</kbd> in the tunnel terminal; the
  local API stays running.
- **Restart after ingress edits:** stop it, run
  `cloudflared tunnel ingress validate`, and start it again.
- **After an API restart:** keep the named tunnel running; it reconnects once
  `127.0.0.1:3081` is back.
- **Changed URL:** ordinary named-tunnel restarts retain the hostname. If you
  replace the hostname or tunnel, update every remote client's full endpoint
  URL and repeat the 401/404 checks.

Cloudflare's [configuration reference](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/)
and [local tunnel guide](https://developers.cloudflare.com/tunnel/advanced/local-management/create-local-tunnel/)
cover current commands and ingress rules.

## API and operations

```text
GET   /healthz
GET   /readyz
GET   /v1/models
POST  /v1/sessions
POST  /v1/sessions/:id/messages
POST  /v1/chat/completions
POST  /v1/responses
```

Every response includes `x-request-id`. Process-local limits:

```dotenv
CODEX_MAX_CONCURRENT=2
CODEX_MAX_CONCURRENT_PER_KEY=1
CODEX_MAX_QUEUE=20
CODEX_REQUEST_TIMEOUT_MS=600000
CODEX_SHUTDOWN_GRACE_MS=30000
```

After code changes:

```zsh
npm test
npm run check
```
