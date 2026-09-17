fn main() {
    println!("cargo:rerun-if-env-changed=CODEX_UPDATER_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=CODEX_UPDATER_ENDPOINT");
    tauri_build::build()
}
