pub mod auth;
pub mod claudelog;
pub mod codexlog;
pub mod commands;
pub mod geminilog;
pub mod git;
pub mod hooklog;
pub mod opencodelog;
pub mod http_api;
pub mod ipc;
pub mod keyboard_hook;
pub mod layout;
pub mod persistence;
pub mod process_util;
pub mod remote;
pub mod session;
pub mod updater;

use std::sync::{Arc, OnceLock};

/// Global AppHandle for emitting events from non-Tauri contexts (e.g., remote API handlers).
static GLOBAL_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn emit_global(event: &str, payload: impl serde::Serialize + Clone) {
    if let Some(handle) = GLOBAL_APP_HANDLE.get() {
        let _ = handle.emit(event, payload);
    }
}

#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{Manager, Emitter};
use tauri_plugin_store::StoreExt;
use tokio::sync::Mutex as TokioMutex;

use crate::commands::IpcState;
use crate::remote::RemoteState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::get_session,
            commands::list_sessions,
            commands::switch_session,
            commands::close_session,
            commands::rename_session,
            commands::split_pane,
            commands::close_pane,
            commands::resize_pane,
            commands::write_to_pty,
            commands::resize_pty,
            commands::respawn_pty,
            commands::set_pane_last_command,
            commands::attach_session,
            commands::list_directory,
            commands::get_home_dir,
            commands::get_recent_dirs,
            commands::add_recent_dir,
            commands::delete_recent_dir,
            commands::get_prompts_dir,
            commands::read_prompt_file,
            commands::write_prompt_file,
            commands::read_shell_history,
            commands::write_racemo_history,
            commands::list_directory_filtered,
            commands::list_directory_gitfiltered,
            commands::dir_has_docs,
            commands::webview_navigate,
            commands::webview_reload,
            commands::webview_go_back,
            commands::webview_go_forward,
            commands::webview_get_url,
            commands::webview_hide,
            commands::webview_show,
            commands::webview_toggle_devtools,
            commands::is_ipc_ready,
            commands::fe_log,
            commands::get_history_path,
            commands::clear_history,
            commands::delete_history_entry,
            commands::get_favorites,
            commands::add_favorite,
            commands::remove_favorite,
            commands::save_clipboard_image,
            commands::git_init,
            commands::git_repo_info,
            commands::git_file_statuses,
            commands::git_commit_log,
            commands::git_ref_list,
            commands::git_commit_detail,
            commands::git_stage_file,
            commands::git_unstage_file,
            commands::git_stage_all,
            commands::git_unstage_all,
            commands::git_commit,
            commands::git_discard_file,
            commands::git_add_to_gitignore,
            commands::git_diff_file,
            commands::git_discard_hunk,
            commands::git_apply_patch,
            commands::load_diff_cache,
            commands::save_diff_cache,
            commands::load_discard_cache,
            commands::save_discard_cache,
            commands::git_diff_summary,
            commands::git_unpushed_commits,
            commands::git_pr_status,
            commands::git_create_pr,
            commands::git_default_branch,
            commands::git_push,
            commands::git_pull,
            commands::git_stash_pull,
            commands::git_stash_rebase_pull,
            commands::git_worktree_list,
            commands::git_worktree_add,
            commands::git_worktree_remove,
            commands::git_worktree_prune,
            commands::git_worktree_sync,
            commands::git_worktree_apply,
            commands::git_worktree_cherry_pick,
            commands::git_worktree_reset,
            commands::git_worktree_lock,
            commands::git_worktree_unlock,
            commands::git_delete_branch,
            commands::git_checkout_commit,
            commands::git_create_branch,
            commands::git_create_tag,
            commands::git_cherry_pick,
            commands::git_revert_commit,
            commands::git_get_remote_url,
            commands::git_show_commit_patch,
            commands::git_diff_commits,
            commands::git_merge_base,
            commands::git_resolve_ours,
            commands::git_resolve_theirs,
            commands::git_merge_abort,
            commands::git_mergetool,
            commands::git_mergetool_name,
            commands::git_open_vscode_merge,
            commands::git_command_log,
            commands::git_clear_command_log,
            commands::git_detect_hosting_cli,
            commands::git_list_remote_repos,
            commands::git_exec_streaming,
            commands::run_ai_command,
            commands::run_ai_streaming,
            commands::exec_streaming,
            commands::kill_streaming,
            commands::stop_server,
            commands::reconnect_ipc,
            commands::get_active_session_id,
            commands::get_shell_log_path_string,
            commands::append_shell_log,
            commands::append_shell_log_hex,
            commands::clear_shell_log,
            commands::start_remote_hosting,
            commands::stop_remote_hosting,
            commands::get_remote_status,
            commands::connect_to_remote_host,
            commands::disconnect_remote,
            commands::approve_remote_client,
            commands::write_to_remote_pty,
            commands::resize_remote_pty,
            commands::resize_remote_pane,
            commands::split_remote_pane,
            commands::close_remote_pane,
            commands::request_remote_session_list,
            commands::remote_api_call,
            commands::start_account_hosting,
            commands::connect_to_device_account,
            commands::approve_account_connection,
            auth::auth_start_device_flow,
            auth::auth_poll_token,
            auth::auth_get_current_user,
            auth::auth_logout,
            auth::fetch_my_devices,
            auth::get_current_device_name,
            auth::connect_to_device,
            auth::auth_get_access_token,
            commands::read_hook_log,
            commands::clear_hook_log,
            commands::read_claude_log_history,
            commands::read_claude_log_session,
            commands::read_codex_log_history,
            commands::read_codex_log_session,
            commands::check_codex_dir_exists,
            commands::check_gemini_dir_exists,
            commands::read_gemini_log_history,
            commands::read_gemini_log_session,
            commands::check_opencode_dir_exists,
            commands::read_opencode_log_history,
            commands::read_opencode_log_session,
            commands::open_in_default_app,
            commands::reveal_in_file_manager,
            commands::create_file,
            commands::create_directory,
            commands::rename_path,
            commands::trash_path,
            commands::update_watched_paths,
            commands::read_text_file,
            commands::write_text_file,
            commands::search_files,
            commands::search_content,
            commands::list_docs_recursive,
            commands::prepare_update,

            commands::set_block_hangul_key,
            commands::get_claude_usage,
            commands::get_editor_state,
            commands::save_editor_state,
            updater::check_app_update,
            updater::install_app_update,
            updater::relaunch_app,
        ]);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|handle| {
            let app_menu = SubmenuBuilder::new(handle, "Racemo")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .item(&MenuItem::with_id(
                    handle,
                    "quit",
                    "Quit Racemo",
                    true,
                    Some("CmdOrCtrl+Shift+Q"),
                )?)
                .build()?;
            let edit_menu = SubmenuBuilder::new(handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .build()?;
            MenuBuilder::new(handle)
                .item(&app_menu)
                .item(&edit_menu)
                .build()
        })
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                // 서버에 Shutdown 전송 후 앱 종료
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<IpcState>();
                    let guard = state.lock().await;
                    if let Some(client) = guard.as_ref() {
                        let _ = client.request(crate::ipc::protocol::ClientMessage::Shutdown).await;
                    }
                    app_handle.exit(0);
                });
            }
        });
    }

    builder
        .on_page_load(|webview, payload| {
            if !webview.label().starts_with("bw") { return; }

            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    // Stub out Notification API to prevent unhandled promise rejections
                    let _ = webview.eval(
                        "window.Notification = class Notification { \
                           static get permission() { return 'denied'; } \
                           static requestPermission() { return Promise.resolve('denied'); } \
                           constructor() {} \
                         };",
                    );
                }
                tauri::webview::PageLoadEvent::Finished => {
                    let label = webview.label().to_string();
                    if let Ok(url) = webview.url() {
                        let url_str = url.to_string();
                        let app = webview.app_handle().clone();
                        let _ = app.emit_to(
                            tauri::EventTarget::webview("main"),
                            "browser-url-changed",
                            serde_json::json!({ "label": label, "url": url_str }),
                        );
                    }
                }
            }
        })
        .setup(|app| {
            let _ = GLOBAL_APP_HANDLE.set(app.handle().clone());
            // Windows and Linux: disable native decorations (use custom window controls in frontend)
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    let _ = window.remove_menu();
                    let _ = window.set_resizable(true);

                    // Linux: explicitly set window size to match Windows/macOS default
                    #[cfg(target_os = "linux")]
                    {
                        use tauri::LogicalSize;
                        let _ = window.set_size(LogicalSize::new(1200.0_f64, 800.0_f64));
                    }

                    // Show window after a short delay to ensure UI is ready
                    let w = window.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        let _ = w.show();
                    });
                }
            }

            // Restore saved window size
            const DEFAULT_W: f64 = 1200.0;
            const DEFAULT_H: f64 = 800.0;
            const MIN_W: f64 = 400.0;
            const MIN_H: f64 = 300.0;
            const MAX_W: f64 = 7680.0; // 8K
            const MAX_H: f64 = 4320.0;

            if let Some(window) = app.get_webview_window("main") {
                if let Ok(store) = app.store("window-state.json") {
                    let w = store.get("width").and_then(|v| v.as_f64());
                    let h = store.get("height").and_then(|v| v.as_f64());
                    log::info!("Restoring window size: saved={:?}x{:?}", w, h);
                    if let (Some(w), Some(h)) = (w, h) {
                        let valid = (MIN_W..=MAX_W).contains(&w) && (MIN_H..=MAX_H).contains(&h);
                        let (w, h) = if valid { (w, h) } else {
                            log::warn!("Invalid saved window size {}x{}, resetting to default", w, h);
                            store.set("width", serde_json::json!(DEFAULT_W));
                            store.set("height", serde_json::json!(DEFAULT_H));
                            let _ = store.save();
                            (DEFAULT_W, DEFAULT_H)
                        };
                        log::info!("Setting window size to {}x{}", w, h);
                        let _ = window.set_size(tauri::LogicalSize::new(w, h));
                    }
                }

                // Save size on resize (debounced 500ms)
                let app_handle = app.handle().clone();
                let save_timer: Arc<TokioMutex<Option<tauri::async_runtime::JoinHandle<()>>>> =
                    Arc::new(TokioMutex::new(None));
                let win_for_event = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(size) = event {
                        let (w, h) = (size.width, size.height);
                        if w == 0 || h == 0 { return; } // ignore minimized
                        // Get current scale factor dynamically (handles monitor changes on macOS)
                        let scale_factor = win_for_event.scale_factor().unwrap_or(1.0);
                        let lw = (w as f64 / scale_factor).round();
                        let lh = (h as f64 / scale_factor).round();
                        // Only persist sane values
                        if lw < MIN_W || lh < MIN_H || lw > MAX_W || lh > MAX_H { return; }
                        let handle = app_handle.clone();
                        let timer = save_timer.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut guard = timer.lock().await;
                            if let Some(prev) = guard.take() { prev.abort(); }
                            *guard = Some(tauri::async_runtime::spawn(async move {
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                if let Ok(store) = handle.store("window-state.json") {
                                    store.set("width", serde_json::json!(lw));
                                    store.set("height", serde_json::json!(lh));
                                    match store.save() {
                                        Ok(_) => log::info!("Saved window size: {}x{}", lw, lh),
                                        Err(e) => log::warn!("Failed to save window size: {}", e),
                                    }
                                }
                            }));
                        });
                    }
                });
            }

        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )?;

            log::info!("=== Racemo setup started ===");

            // Windows: 저수준 키보드 훅 설치 (한/영 키 차단 토글 지원)
            crate::keyboard_hook::install();

            // Manage IPC state immediately (None = not yet connected).
            let ipc_state: IpcState = Arc::new(TokioMutex::new(None));
            app.manage(ipc_state.clone());

            // Manage remote hosting state.
            let remote_state: RemoteState =
                Arc::new(TokioMutex::new(crate::remote::RemoteHostingState::default()));
            app.manage(remote_state);

            // Connect to server asynchronously.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ipc::client::setup_ipc(app_handle, ipc_state).await;
            });

            log::info!("=== Racemo setup complete ===");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
