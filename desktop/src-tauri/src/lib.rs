// Marginote 桌面版应用主体。
// 注册 Tauri 插件、命令、托盘、关闭最小化拦截、单实例。

use tauri::{Manager, WindowEvent};

mod commands;
mod scheduler;
mod storage;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例：第二次启动时唤起已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::cmd_fetch,
            commands::cmd_stream_fetch,
            commands::cmd_alarm_set,
            commands::cmd_alarm_clear,
            commands::cmd_alarm_list,
            commands::cmd_window_focus,
            commands::cmd_window_hide,
            commands::cmd_kv_get,
            commands::cmd_kv_set,
            commands::cmd_kv_remove,
            commands::cmd_kv_keys,
            commands::cmd_register_hotkey,
            commands::cmd_unregister_hotkey,
            commands::cmd_get_app_paths,
            commands::cmd_set_window_theme,
        ])
        .setup(|app| {
            // 安装托盘
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("tray install failed: {e}");
            }
            // 拦截主窗口关闭按钮 → 隐藏到托盘
            if let Some(w) = app.get_webview_window("main") {
                let w_clone = w.clone();
                w.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w_clone.hide();
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Marginote failed to start");
}
