SIDECAR
Desktop app - macOS

Created by Dhruv Bhagatkar
Creator and developer of Sidecar
Website: https://sidecar.co.in
Created by Dhruv Bhagatkar: https://thisisdhruv.in

INSTALL
1. Drag Sidecar.app to the Applications shortcut beside this file.
2. Open Sidecar from Applications, then eject this disk image.
3. Select an existing workspace folder and save your settings in the app.
4. Start the gateway, create an API key, and follow the in-app Codex sign-in
   instructions. Each user signs in with their own account.

No Node.js installation, terminal commands, or .env editing is needed to use
the packaged app. Runtime components are included. Settings and credentials
are stored in the app's private data folder, separately from your workspace.
The app shows that folder in Settings. Never share that folder or your keys.

CONNECT YOUR APP
Create a key, sign in, and add your browser app's origin under Browser origins
or API Keys > Edit policy (for example http://127.0.0.1:5500 for TESTGPT).
Use the endpoint shown in Connect and the key you created to make API calls.
Server-side clients and VS Code on the same computer need no browser origins.
Localhost is sufficient; no tunnel is needed.
Keep the gateway running while using it. Follow the in-app setup guide for
the current endpoint, model choices, reasoning options, and limitations.
The gateway is a local compatibility bridge, not a complete replacement for
every OpenAI API feature. Codex access depends on your own account eligibility.

STOP AND RESTART
Use Stop gateway before changing the workspace or port. Save your changes,
then Start gateway again. Closing/quitting the desktop app stops its gateway.
If you change the port, update your client endpoint to match the app.

DEVELOPMENT BUILD NOTICE
This development build is not Apple-notarized and may be unsigned or ad-hoc
signed. macOS may block the first launch. Only if you trust the source, review
the app in System Settings > Privacy & Security and use Open Anyway if offered.
Do not disable Gatekeeper globally. Public distribution should use a signed,
notarized release. This build targets the architecture named in its DMG filename
(arm64 for Apple silicon; x64 for Intel), not every Mac in one installer.

PRIVACY AND SAFETY
Use only workspaces you intend to grant access to. Do not use your entire home
directory or the app's private data directory as the workspace. Save new API
keys when shown; they are not displayed again. Never send your Codex account
credentials or API keys to the developer. This app is an independent project,
not an official OpenAI application.
