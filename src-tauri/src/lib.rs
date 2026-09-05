//! Bootstrap: `run()`, `AppState`/`Session`, the window, the tray mirror, the panic hook
//! and the `invoke_handler!` list. Each session is a PTY keyed by the uuid passed to
//! `claude --session-id`, instrumented per launch via `--settings` (CLAUDE.md).

mod agent;
mod external;
mod files;
mod git;
mod health;
mod github;
mod icons;
mod notes;
mod platform;
mod pty;
mod summarize;
mod tasks;
mod telemetry;
#[cfg(test)]
mod testutil;
mod usage;

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::sync::Mutex;

use portable_pty::{ChildKiller, MasterPty};
#[cfg(target_os = "macos")]
use tauri::menu::SubmenuBuilder;
use tauri::menu::{IconMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use crate::platform::KeepAwake;

pub(crate) struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>, // embedded PTY only; excludes our own sessions from list_external_sessions
    workdir: String, // lets remove_worktree refuse a worktree with a live session in it
    /// "agent" | "shell" | "task", kept backend-side so an orphaned PTY stays
    /// self-describing across a webview reload; agent identity is `provider`.
    kind: &'static str,
    provider: Option<String>, // "claude", "codex", ...; None for a shell/task
    /// Recent raw output, shared with the reader thread; refills a pane after a webview reload.
    scrollback: std::sync::Arc<Mutex<pty::ScrollBuf>>,
    /// Latched by the reader when ConPTY asks for win32 input records (`ESC[?9001h`);
    /// `write_pty` reads it. Never set off Windows. See `pty::win32_input_encode`.
    win32_input: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) struct AppState {
    /// Baked into every instrument file. Atomic because `serve_telemetry` re-binds this
    /// port after a listener dies and only falls back to a fresh one if it stays taken.
    port: std::sync::atomic::AtomicU16,
    sessions: Mutex<HashMap<String, Session>>,
    /// Provider sidecars keyed by pane id (Codex's loopback app-server). Not in `Session`
    /// because each also owns an observer thread and a JSON-RPC control plane.
    agent_runtimes: Mutex<HashMap<String, agent::AgentRuntime>>,
    /// PIDs of the `claude` processes Episko spawned, so our own sessions never list as
    /// external; by pid because /resume and /clear rewrite the registry's session id.
    owned_pids: Mutex<HashSet<u32>>,
    /// Last disk-I/O reading per owned pid: (read, written, when). `all_sessions_resources`
    /// differences per pid against this (docs/architecture.md).
    io_samples: Mutex<HashMap<u32, (u64, u64, std::time::Instant)>>,
    /// (read, written) of sessions that have exited, so closing a pane does not walk the
    /// app-wide total backwards.
    io_retired: Mutex<(u64, u64)>,
    /// Where the last background-shell log resolved, so each poll does not re-walk the
    /// ladder; `pty::BgRootState` says why the root is remembered and the file never is.
    bg_root: Mutex<pty::BgRootState>,
    /// Held-open PermissionRequest HTTP requests, answered by `resolve_permission`.
    pending: Mutex<HashMap<String, tiny_http::Request>>,
    next_perm: std::sync::atomic::AtomicU64,
    /// The `caffeinate` child; started with `-w <our pid>` so it dies with Episko.
    #[cfg(not(windows))]
    caffeinate: Mutex<Option<std::process::Child>>,
    /// Windows' `SetThreadExecutionState` assertion, the `caffeinate` equivalent.
    #[cfg(windows)]
    caffeinate: Mutex<Option<KeepAwake>>,
}

/// Write the frontend's debug snapshot to a fixed path so external tools can read live state.
#[tauri::command]
fn write_debug_file(contents: String) -> Result<String, String> {
    let mut dir = std::env::temp_dir();
    dir.push("cc-launcher");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("episko-debug.json");
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Only reached from Settings > Diagnostics. The `devtools` Cargo feature is what makes
/// `open_devtools` exist in a release build; opening an already-open inspector focuses it.
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// Tee a frontend `dlog()` line into the rolling episko.log, tagged `[ui]`, so the UI and
/// backend timelines share one file that survives a crash (the debug snapshot does not).
#[tauri::command]
fn log_frontend(level: String, msg: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {msg}"),
        "warn" => log::warn!("[ui] {msg}"),
        _ => log::info!("[ui] {msg}"),
    }
}

// ---------- app quit ----------

/// The only immediate-exit paths are this and the tray's Quit: Cmd+Q is bound to our own
/// menu item (see `run`), which asks the frontend to confirm first.
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    app.exit(0);
}

// ---------- macOS menu-bar (tray) ----------

/// One row of the tray menu as the frontend lays it out: order, grouping, `shape` and
/// `rgb` are the sidebar's, so the backend keeps no second copy of the palette.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TrayRow {
    /// `id` is what the menu handler's `sid` catch-all turns back into a `tray-select`.
    Session {
        id: String,
        label: String,
        shape: String,
        rgb: [u8; 3],
    },
    /// A project heading, as a *disabled* item (the macOS idiom): it fires no `MenuEvent`,
    /// and the handler treats every unknown id as a session to select.
    Header {
        label: String,
    },
    Sep,
}

/// `title` is the text beside the menu-bar icon (macOS only); `tooltip` the hover text.
#[tauri::command]
fn update_tray(
    app: AppHandle,
    title: String,
    tooltip: String,
    items: Vec<TrayRow>,
) -> Result<(), String> {
    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };
    let mut mb = MenuBuilder::new(&app);
    if items.is_empty() {
        mb = mb.text("none", "No active sessions");
    } else {
        for row in &items {
            mb = match row {
                TrayRow::Sep => mb.separator(),
                TrayRow::Header { label } => {
                    let it = MenuItemBuilder::new(label)
                        .enabled(false)
                        .build(&app)
                        .map_err(|e| e.to_string())?;
                    mb.item(&it)
                }
                TrayRow::Session {
                    id,
                    label,
                    shape,
                    rgb,
                } => {
                    // Not a template image: AppKit would re-tint it to the menu's text
                    // colour. (The tray icon itself in `run()` is a template on purpose.)
                    let icon = tauri::image::Image::new_owned(
                        crate::icons::glyph_rgba(shape, *rgb),
                        32,
                        32,
                    );
                    let it = IconMenuItemBuilder::with_id(id.clone(), label)
                        .icon(icon)
                        .build(&app)
                        .map_err(|e| e.to_string())?;
                    mb.item(&it)
                }
            };
        }
    }
    let menu = mb
        .separator()
        .text("show", "Show Episko")
        // Keep this trio in sync with the initial menu in `run()`: this replaces the whole menu.
        .text("check-updates", "Check for Updates…")
        .separator()
        .text("quit", "Quit Episko")
        .build()
        .map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let _ = tray.set_tooltip(Some(&tooltip));
    let _ = tray.set_title(Some(&title));
    Ok(())
}

/// A panic unwinding out of `main` ends a GUI app with no crash dump, so this is the only
/// on-disk trace: through `log` (episko.log) and raw to `panic.log` in case the logger broke.
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
        // Terminal copy/paste goes through this plugin, not `navigator.clipboard`: wry
        // leaves `clipboard-read` ungranted, so the webview would raise its own prompt.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Windows has no app menu, so closing the window is the quit; intercept it and run
        // the same frontend confirm flow. Only `confirm_quit` actually exits.
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
            // One interactive shell startup, off the main thread, before anyone needs PATH.
            platform::warm_shell_path();

            let server =
                tiny_http::Server::http("127.0.0.1:0").expect("bind telemetry server on 127.0.0.1");
            let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            log::info!("telemetry server on 127.0.0.1:{port}");

            app.manage(AppState {
                port: std::sync::atomic::AtomicU16::new(port),
                sessions: Mutex::new(HashMap::new()),
                agent_runtimes: Mutex::new(HashMap::new()),
                owned_pids: Mutex::new(HashSet::new()),
                io_samples: Mutex::new(HashMap::new()),
                io_retired: Mutex::new((0, 0)),
                bg_root: Mutex::new(pty::BgRootState::default()),
                pending: Mutex::new(HashMap::new()),
                next_perm: std::sync::atomic::AtomicU64::new(1),
                caffeinate: Mutex::new(None),
            });

            let handle = app.handle().clone();
            // `serve_telemetry`, not `run_telemetry_server`: the inner loop ends on the first
            // accept error, silently, and only the supervisor brings it back (telemetry.rs).
            std::thread::spawn(move || telemetry::serve_telemetry(server, handle));

            // ---- The window (one title bar, not two) ----
            // Built here rather than by config (docs/native-ui.md): `decorations` is not a
            // per-platform key, and flipping it after creation leaves edges that cannot be
            // dragged. Built after `app.manage`, so no invoke can run before its state exists.
            #[allow(unused_mut)] // `mut` is only used by the windows arm below
            let mut win_cfg = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("main window config in tauri.conf.json");
            #[cfg(windows)]
            {
                win_cfg.decorations = false;
            }
            tauri::WebviewWindowBuilder::from_config(app, &win_cfg)?.build()?;

            // The tray; its menu is rebuilt from the frontend via `update_tray`.
            let tray_menu = MenuBuilder::new(app)
                .text("show", "Show Episko")
                .text("check-updates", "Check for Updates…")
                .separator()
                .text("quit", "Quit Episko")
                .build()?;
            // A template image, so the `>_` glyph adapts to the light/dark menu bar.
            let tray_icon =
                tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate.png"))
                    .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Episko")
                .menu(&tray_menu)
                // macOS never emits DoubleClick (Windows/Linux only); there, use the menu item.
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
                        // Before the `sid` catch-all. Shown first: the check reports itself
                        // as a toast in the UI, and a hidden window would look like a no-op.
                        "check-updates" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("tray-check-updates", ());
                        }
                        // Every menu handler shares one listener list, so the app menu's
                        // Cmd+Q item lands here too; swallow it before the catch-all.
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
            // Tauri does not surface Cmd+Q reliably (tauri-apps/tauri#9198), so we own the
            // Quit item: its handler asks the frontend and only `confirm_quit` exits. The
            // replaced default menu must get its Edit submenu back, or Cmd+C/V/Z stop working.
            #[cfg(target_os = "macos")] // on Windows muda's Hide item hides the window for good
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
                        // Show the window so the confirm has context; the frontend decides.
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
            pty::live_sessions,
            pty::read_scrollback,
            pty::read_bg_log,
            external::session_ports,
            git::git_branch,
            git::git_head,
            git::git_diffstat,
            git::git_working_set,
            git::git_changed,
            files::project_files,
            health::project_health,
            git::git_diff,
            git::git_graph,
            git::git_commit_message,
            git::git_action,
            pty::all_sessions_resources,
            git::create_worktree,
            platform::set_caffeinate,
            telemetry::resolve_permission,
            agent::resolve_agent_request,
            agent::refresh_agent_state,
            agent::agent_history,
            git::list_worktrees,
            git::worktree_heads,
            git::remove_worktree,
            git::purge_worktree_folder,
            git::git_branch_list,
            git::delete_branch,
            git::sweep_branches,
            git::delete_remote_branches,
            git::switch_branch,
            git::git_commit_info,
            git::git_log_days,
            git::project_facts,
            github::gh_threads,
            github::gh_accounts,
            github::gh_invalidate,
            github::gh_claim,
            github::gh_release,
            github::gh_close_issue,
            github::gh_day_activity,
            github::gh_merged_prs,
            github::claim_policy,
            github::list_kept,
            github::set_kept,
            notes::list_shared_notes,
            notes::set_shared_note,
            pty::spawn_ghostty,
            pty::spawn_shell,
            pty::spawn_task,
            pty::spawn_agent,
            tasks::discover_runnables,
            tasks::rescan_runnables,
            tasks::save_episko_task,
            tasks::delete_episko_task,
            tasks::save_task_override,
            tasks::remove_task_override,
            tasks::list_task_overrides,
            tasks::episko_tasks_file,
            pty::available_terminals,
            pty::list_agents,
            pty::spawn_external_terminal,
            pty::open_terminal_here,
            external::list_external_sessions,
            external::focus_external_session,
            usage::read_transcript,
            usage::read_transcript_asked,
            usage::move_session_transcript,
            usage::list_past_sessions,
            usage::list_session_history,
            usage::token_usage_by_day,
            summarize::summarize_day,
            summarize::read_digest,
            summarize::has_digest,
            summarize::write_digest,
            icons::find_project_icon,
            icons::read_custom_icon,
            platform::read_legacy_localstorage,
            platform::open_folder,
            platform::reveal_path,
            platform::open_file,
            platform::reveal_file,
            platform::resolve_link_path,
            pty::session_cwd,
            write_debug_file,
            log_frontend,
            open_devtools,
            update_tray,
            confirm_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // A log that ends without one of these lines is an abnormal termination.
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
