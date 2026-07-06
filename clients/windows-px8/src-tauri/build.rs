fn main() {
    // Standard Tauri build step. When the `player` feature is on, libmpv2 links against the system
    // libmpv; ship libmpv-2.dll next to the exe (see README) and, if the import lib isn't on the
    // default search path, add: println!("cargo:rustc-link-search=native=<path-to-libmpv>");
    tauri_build::build();
}
