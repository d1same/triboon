fn main() {
    // libmpv2-sys asks MSVC for `mpv.lib`. CI and local production builds point MPV_SOURCE at the
    // checksum-verified bundle root containing that import library and libmpv-2.dll.
    println!("cargo:rerun-if-env-changed=MPV_SOURCE");
    if let Ok(source) = std::env::var("MPV_SOURCE") {
        println!("cargo:rustc-link-search=native={source}");
    }
    // Register every application command with Tauri's ACL generator. Remote catalog pages receive
    // only the explicit permissions listed in capabilities/catalog.json; they never inherit
    // core:default (filesystem/window/menu/event APIs).
    let commands = &[
        "connect",
        "windows_connect",
        "last_server",
        "windows_change_server",
        "windows_native_chrome_version",
        "windows_native_playback_caps",
        "windows_app_version",
        "windows_player_show_loading",
        "windows_player_play_vod",
        "windows_player_play_live",
        "windows_player_control",
        "windows_player_update",
        "windows_player_open_guide",
        "windows_player_close_guide",
        "windows_player_set_guide_pip_rect",
    ];
    let manifest = tauri_build::AppManifest::new().commands(commands);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to build Triboon Windows metadata");
}
