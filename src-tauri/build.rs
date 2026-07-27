fn main() {
    // Windows: give every linked artifact the Common Controls v6 dependency that
    // tauri-build already embeds into the app binary itself.
    //
    // Why a test needs it: building a `tauri::App` — which the telemetry tests do via
    // `mock_app()` — pulls in muda/tray-icon, which statically import v6-only comctl32
    // exports (`TaskDialogIndirect`, `SetWindowSubclass`). Cargo's test harness gets no
    // manifest, so the loader binds System32's comctl32 v5.82, those entry points are
    // missing, and the exe dies at load with STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)
    // before a single test runs.
    //
    // `/MANIFESTDEPENDENCY` alone (no `/MANIFEST:EMBED`) is deliberate: it makes the
    // linker write an *external* `<exe>.manifest` beside each artifact, which Windows
    // honours only for binaries that have no embedded one — i.e. exactly the test
    // harnesses. The app binary keeps tauri's embedded manifest and ignores the stray
    // file, which never leaves `target/*/deps` anyway. Embedding instead would collide
    // with tauri's own manifest resource (CVT1100: duplicate resource, type MANIFEST).
    //
    // Cargo has no knob for "the lib's unit-test binary" — `rustc-link-arg-tests`
    // covers only a `tests/` directory, which this crate deliberately doesn't have
    // (see PLAN.md, "On integration tests") — hence the unscoped form.
    #[cfg(windows)]
    println!(
        "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );

    tauri_build::build()
}
