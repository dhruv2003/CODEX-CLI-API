# Sidecar Branding

Product: **Sidecar** — https://sidecar.co.in

Creator: **Dhruv** — https://thisisdhruv.in

The project-bound logo is `desktop/logo.png`, also copied to `src/public/logo.png` for the standalone dashboard. Tauri platform icons are generated from it:

```sh
node node_modules/@tauri-apps/cli/tauri.js icon desktop/logo.png --output src-tauri/icons
```

The logo was generated with the built-in image-generation tool, not the CLI/API fallback.

Prompt: Original minimal cobalt/off-white angular gateway mark with connection dot, charcoal rounded-square tile, transparent outer corners, no text or existing brand marks. Strong silhouette legible at small app-icon sizes; suited to an independent local API gateway.

Replace `desktop/logo.png`, copy it to `src/public/logo.png`, regenerate native icons, and rebuild to use a new supplied logo.
