# CODEX CLI API Stitch Desktop UI

## Outcome

Implement the approved Stitch redesign in the packaged desktop app while keeping the existing local gateway, API-key lifecycle, Codex sign-in, connection test, diagnostics, request history, desktop settings, update flow, and DMG packaging behavior intact.

## Source of truth

The visual reference is the private Stitch project `projects/3608752727796523352`, design system `assets/3390566479657626752`. It contains these approved desktop screens:

- Overview
- API Keys
- Connect
- Requests
- Diagnostics
- Settings
- First Run Onboarding
- Onboarding Step 2: Create Key
- Onboarding Step 3: Sign in to Codex
- Onboarding Step 4: Test connection

## Visual language

- Keep the warm cream background, cobalt-blue primary actions, deep navy text, thin warm-gray borders, rounded cards, and the existing angular gateway logo.
- Use a persistent left navigation rail with Overview, API Keys, Connect, Requests, Diagnostics, and Settings.
- Use a compact top bar for gateway state, workspace context, refresh, and desktop settings access.
- Preserve clear active, success, warning, and error states; never communicate a completed setup step only through color.
- Keep the UI responsive for the existing desktop minimum window and narrow browser widths.

## Functional requirements

1. Overview shows gateway health, active/total key counts, request and token metrics, capacity, setup progress, and prominent next actions.
2. API Keys supports creation, one-time secret reveal/copy, search, status filtering, activation/deactivation, policy editing, delete confirmation, and a selected-key detail panel with workspace scope, rate limit, expiry, authentication state, and last successful test.
3. Connect presents the workflow in order: select key, choose model, choose reasoning level, sign in, test connection, copy endpoint, and copy VS Code configuration. It must preserve the current key secret only in page memory.
4. Requests displays recent request history with filters for key, model, and result and retains duration and token usage columns.
5. Diagnostics provides local health checks, sanitized diagnostic report generation/copy, failure explanations, and recovery actions.
6. Settings exposes the existing desktop settings and update controls through the wrapper without weakening the Tauri boundary.
7. First-run onboarding keeps workspace selection and port configuration, saves progress through the existing Tauri settings, and communicates the four setup steps consistently with the dashboard.
8. Existing server routes and security headers remain unchanged unless a narrowly scoped UI compatibility change is required.

## Non-goals

- No remote hosting, public tunnel support in the packaged app, or new persistence for API secrets.
- No replacement of the Tauri gateway lifecycle or updater implementation.
- No change to the existing logo asset.
