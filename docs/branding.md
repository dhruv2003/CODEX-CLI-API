# Sidecar Branding

Product: **Sidecar** — https://sidecar.co.in

Creator: **Dhruv** — https://thisisdhruv.in

The source brand kit is checked in at `brand-assets/Sidecar_Brand_Assets_Pack/`.

- `desktop/logo.png` uses the dark app-icon master for the desktop shell.
- `src/public/logo.png` uses the light app-icon master for the dashboard.
- Tauri platform icons use the blue app-icon master so the installed application has one strong, recognizable icon across platforms.

Tauri platform icons can be regenerated with:

```sh
node node_modules/@tauri-apps/cli/tauri.js icon desktop/logo.png --output src-tauri/icons
```

The brand kit defines cobalt `#3155FF`, charcoal `#0F172A`, off-white `#F8F9FB`, and white. The symbol is intentionally text-free so it remains legible in a tray, dock, favicon, and compact dashboard header.

When replacing the brand, update the two shipped UI logos, regenerate native icons from the selected 1024px master, and rebuild the desktop bundle.
