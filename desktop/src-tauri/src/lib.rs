// Marginote 桌面版应用主体。
// 注册 Tauri 插件、命令、设置阶段（托盘、闹钟恢复在 P3/P4 加进来）。

use tauri::Manager;

mod commands;

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
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new().build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            commands::cmd_fetch,
            commands::cmd_alarm_set,
            commands::cmd_alarm_clear,
            commands::cmd_alarm_list,
            commands::cmd_window_focus,
            commands::cmd_window_hide,
        ])
        .setup(|_app| {
            // P3 在此挂载 alarm scheduler 恢复；P4 挂载托盘
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Marginote failed to start");
}
