// Marginote 桌面版入口。
// Windows 发布版隐藏控制台窗口；其他平台保留 stdout/stderr 便于调试。
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    marginote_lib::run();
}
