// 系统托盘 + 关闭最小化到托盘行为。
// 主窗口的 × 关闭被拦截 → 隐藏窗口；托盘单击或菜单「显示主界面」恢复。

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 托盘菜单
    let show_item = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let separator = MenuItem::with_id(app, "sep", "—", false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 Marginote", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("Marginote · 笔记本")
        .icon(app.default_window_icon().cloned().ok_or("missing icon")?)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击 = 显示窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
