// cc-launcher — Tauri backend (multi-session)
//
// - Manages N concurrent `claude` sessions, each in its own PTY (portable-pty),
//   keyed by a caller-supplied session UUID (also passed to `claude --session-id`
//   so every hook/statusline event correlates back to its pane).
// - Instruments each session per-launch via `claude --settings <file>` so Claude
//   Code's hooks + statusLine POST live status/cost/context to a local HTTP
//   server — no global config mutation, no transcript parsing.

mod external;
mod git;
mod icons;
mod platform;
mod pty;
mod tasks;
mod telemetry;
mod usage;
#[cfg(test)]
mod testutil;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::Mutex;

use portable_pty::{ChildKiller, MasterPty};
use tauri::menu::MenuBuilder;
#[cfg(target_os = "macos")]
use tauri::menu::{MenuItemBuilder, SubmenuBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use crate::platform::KeepAwake;
use crate::telemetry::run_telemetry_server;

pub(crate) struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// OS pid of the spawned `claude` (embedded PTY only). Used to exclude our
    /// own sessions from `list_external_sessions` by pid rather than session id.
    pid: Option<u32>,
    /// Working directory this session runs in. Lets `remove_worktree` refuse to
    /// delete a worktree that still has a live embedded session inside it.
    workdir: String,
}

pub(crate) struct AppState {
    port: u16,
    sessions: Mutex<HashMap<String, Session>>,
    /// PIDs of the `claude` processes Episko spawned in an embedded PTY. Matched
    /// against the on-disk session registry so our own sessions never masquerade
    /// as "external" — robust to the session id changing under /resume or /clear
    /// (which rewrites `~/.claude/sessions/<pid>.json` with the new id).
    owned_pids: Mutex<HashSet<u32>>,
    /// Held-open PermissionRequest HTTP requests, keyed by an id we assign.
    /// Answered later by the `resolve_permission` command.
    pending: Mutex<HashMap<String, tiny_http::Request>>,
    next_perm: std::sync::atomic::AtomicU64,
    /// The single running `caffeinate` child, if the user has toggled it on.
    /// Started with `-w <our pid>` so it self-terminates if Episko ever dies
    /// without a clean stop — no orphaned process keeps the Mac awake forever.
    #[cfg(not(windows))]
    caffeinate: Mutex<Option<std::process::Child>>,
    /// The single live `SetThreadExecutionState` assertion, if the user has
    /// toggled keep-awake on. Windows' equivalent of the `caffeinate` child.
    #[cfg(windows)]
    caffeinate: Mutex<Option<KeepAwake>>,
}


/// Persist a debug snapshot (JSON built by the frontend) to a fixed, discoverable
/// path so an external tool — or an LLM agent debugging the running app — can read
/// live state and the recent event log. Returns the path written.
#[tauri::command]
fn write_debug_file(contents: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("episko-debug.json");
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Tee a frontend `dlog()` line into the backend rolling log (episko.log), tagged
/// `[ui]`. The UI's event stream is otherwise only an in-memory ring mirrored to
/// the *overwritten* episko-debug.json snapshot — so it doesn't survive a crash.
/// Forwarding it here puts the whole timeline (UI + backend) in one durable,
/// time-ordered file: after #12 the backend was crash-visible but the UI half
/// wasn't. Fire-and-forget from the frontend; a dropped line is not worth an error.
#[tauri::command]
fn log_frontend(level: String, msg: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {msg}"),
        "warn" => log::warn!("[ui] {msg}"),
        _ => log::info!("[ui] {msg}"),
    }
}



// ---------- app quit ----------

/// Actually terminate the app. The Cmd+Q accelerator is bound to our own menu
/// item (see the app menu in `run`), which asks the frontend to confirm instead
/// of quitting; the frontend calls this once the user (or an empty session list)
/// has approved the quit. Kept as a command so the *only* immediate-exit paths
/// are this and the tray's "Quit Episko".
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    app.exit(0);
}

// ---------- macOS menu-bar (tray) ----------

#[derive(serde::Deserialize)]
struct TrayItem {
    id: String,
    label: String,
}

/// Rebuild the tray menu to mirror the sidebar: one clickable row per session
/// (with its status), plus Show / Quit. `title` is the short text shown next to
/// the menu-bar icon (macOS); `tooltip` is the hover text.
#[tauri::command]
fn update_tray(
    app: AppHandle,
    title: String,
    tooltip: String,
    items: Vec<TrayItem>,
) -> Result<(), String> {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut mb = MenuBuilder::new(&app);
    if items.is_empty() {
        mb = mb.text("none", "No active sessions");
    } else {
        for it in &items {
            mb = mb.text(it.id.clone(), it.label.clone());
        }
    }
    let menu = mb
        .separator()
        .text("show", "Show Episko")
        // Keep this trio in sync with the initial menu built in `run()` — this
        // command *replaces* the whole menu, so anything missing here vanishes the
        // moment the frontend first renders.
        .text("check-updates", "Check for Updates…")
        .separator()
        .text("quit", "Quit Episko")
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(&tooltip));
    // macOS-only: text label rendered next to the menu-bar icon.
    let _ = tray.set_title(Some(&title));
    Ok(())
}

/// Log every panic — message, location, thread, backtrace — before the process
/// dies. A panic that unwinds out of `main` terminates a GUI app *cleanly* as far
/// as the OS is concerned: no crash dump, no WER/CrashReporter entry, the window
/// just vanishes. This hook is the only on-disk trace of that failure class. It
/// writes through the `log` facade (→ the rolling episko.log) AND appends raw to
/// `panic.log` in the same directory, in case the logger itself is what broke.
fn install_panic_hook(log_dir: std::path::PathBuf) {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let msg = format!(
            "panic on thread '{}': {info}\n{backtrace}",
            thread.name().unwrap_or("<unnamed>")
        );
        log::error!("{msg}");
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("panic.log"))
        {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[unix {secs}] {msg}\n");
        }
        prev(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("episko".into()),
                    }),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(1_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Windows analog of the macOS Cmd+Q catcher in `setup` below: Windows gets
        // no app menu (see there), so quitting means closing the window. Intercept
        // the close and run the same frontend confirm flow — only `confirm_quit`
        // actually exits, and the frontend calls it straight away when idle.
        .on_window_event(|window, event| {
            #[cfg(windows)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("quit-requested", ());
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .setup(|app| {
            // Before anything that can panic: from here on, panics leave a trace.
            install_panic_hook(app.path().app_log_dir()?);
            log::info!("episko v{} starting", app.package_info().version);

            let server = tiny_http::Server::http("127.0.0.1:0")
                .expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            log::info!("telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port,
                sessions: Mutex::new(HashMap::new()),
                owned_pids: Mutex::new(HashSet::new()),
                pending: Mutex::new(HashMap::new()),
                next_perm: std::sync::atomic::AtomicU64::new(1),
                caffeinate: Mutex::new(None),
            });

            let handle = app.handle().clone();
            std::thread::spawn(move || run_telemetry_server(server, handle));

            // macOS menu-bar (tray) icon — its menu mirrors the sidebar and is
            // rebuilt from the frontend via `update_tray`.
            let tray_menu = MenuBuilder::new(app)
                .text("show", "Show Episko")
                .text("check-updates", "Check for Updates…")
                .separator()
                .text("quit", "Quit Episko")
                .build()?;
            // Monochrome `>_` glyph, rendered as a macOS template image so it
            // adapts to the light/dark menu bar. Falls back to the app icon.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))
                .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Episko")
                .menu(&tray_menu)
                // Double-click the icon → show the window. NOTE: on macOS the tray
                // crate never emits DoubleClick (it's Windows/Linux-only), so there
                // the "Show Episko" menu item is the reliable path; this handler
                // covers the other platforms.
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(w) = tray.app_handle().get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().0.as_str();
                    match id {
                        "quit" => app.exit(0),
                        "show" | "none" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        // Must be matched before the `sid` arm below, which treats
                        // any unknown id as a session to select. The window is shown
                        // first because the check reports itself as a toast/chip in
                        // the UI — checking from a hidden window would look like a
                        // menu item that does nothing.
                        "check-updates" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-check-updates", ());
                        }
                        // Cmd+Q is handled by the app menu's own quit item, but that
                        // MenuEvent also reaches this handler — every menu handler shares
                        // one global listener list — so swallow it here instead of letting
                        // it fall through to the session catch-all below.
                        "quit-confirm" => {}
                        sid => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-select", sid.to_string());
                        }
                    }
                })
                .build(app)?;

            // ---- App menu with a Cmd+Q catcher (macOS only) ----
            // Cmd+Q is a "special Apple event" that Tauri does not reliably surface
            // as an app/window event on macOS (tauri-apps/tauri#9198), so
            // RunEvent::ExitRequested/prevent_exit can't be trusted to intercept it.
            // Instead we *own* the Quit item: binding our own menu item to Cmd+Q means
            // the keystroke fires `on_menu_event` (deterministic) rather than the OS
            // `terminate:`. The handler asks the frontend to confirm; only `confirm_quit`
            // actually exits. Replacing the default menu means we must re-add the Edit
            // submenu ourselves, or Cmd+C/X/V/Z/A stop working in the app's inputs.
            //
            // Never install this on Windows: `set_menu` would render it as an
            // in-window menu bar full of mac-only items — and muda's predefined
            // Hide item there does a raw Win32 ShowWindow(SW_HIDE) behind tao's
            // visibility flags, after which tao's show() no-ops and the window is
            // unrecoverable, tray "Show Episko" included (muda 0.19.3
            // windows/mod.rs:1217 vs tao 0.35.3 window_state.rs apply_diff).
            // Windows needs no menu at all: WebView2 handles the edit shortcuts
            // natively, and quitting goes through the CloseRequested hook on the
            // builder above.
            #[cfg(target_os = "macos")]
            {
                let quit_item = MenuItemBuilder::with_id("quit-confirm", "Quit Episko")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let app_menu = SubmenuBuilder::new(app, "Episko")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .item(&quit_item)
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .fullscreen()
                    .separator()
                    .close_window()
                    .build()?;
                let menu = MenuBuilder::new(app)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().0.as_str() == "quit-confirm" {
                        // Surface the window so the confirm dialog has context, then let the
                        // frontend decide (it quits straight away when nothing is running).
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                        let _ = app.emit("quit-requested", ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::spawn_claude,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_session,
            git::git_branch,
            git::git_head,
            git::git_diffstat,
            git::git_diff,
            git::git_graph,
            git::git_commit_message,
            git::git_action,
            pty::session_resources,
            git::create_worktree,
            platform::set_caffeinate,
            telemetry::resolve_permission,
            git::list_worktrees,
            git::remove_worktree,
            git::git_branch_list,
            git::delete_branch,
            git::switch_branch,
            git::git_commit_info,
            pty::spawn_ghostty,
            pty::spawn_shell,
            pty::spawn_task,
            tasks::discover_runnables,
            tasks::rescan_runnables,
            tasks::save_episko_task,
            tasks::delete_episko_task,
            tasks::save_task_override,
            tasks::remove_task_override,
            tasks::list_task_overrides,
            tasks::episko_tasks_file,
            pty::available_terminals,
            pty::spawn_external_terminal,
            pty::open_terminal_here,
            external::list_external_sessions,
            external::focus_external_session,
            usage::read_transcript,
            usage::list_past_sessions,
            usage::token_usage_by_day,
            icons::find_project_icon,
            icons::read_custom_icon,
            platform::read_legacy_localstorage,
            platform::open_folder,
            platform::reveal_path,
            write_debug_file,
            log_frontend,
            update_tray,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // Record clean shutdowns: a log that ends WITHOUT one of these lines is an
        // abnormal termination — that alone answers "did it crash or was it quit?".
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                log::info!(
                    "exit requested{}",
                    code.map(|c| format!(" (code {c})")).unwrap_or_default()
                );
            }
            tauri::RunEvent::Exit => log::info!("exit · clean shutdown"),
            _ => {}
        });
}
