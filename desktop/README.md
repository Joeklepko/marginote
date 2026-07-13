# Marginote 桌面版（Tauri）

把 Marginote 打成 Windows `.exe` 安装包的 Tauri 工程。前端复用 `../shared/`。

## 构建

正常构建走 GitHub Actions（推送 `dev` 分支自动出包，见 `.github/workflows/build-windows.yml`）。工作流使用 `package-lock.json` 锁定的项目内 Tauri CLI，避免全局最新版带来的构建漂移。

本地构建（仅 Windows）：

```bash
cd desktop
npm install                          # 装 @tauri-apps/cli
npx tauri icon ../shared/icons/icon128.png -o src-tauri/icons   # 首次需生成多尺寸图标
npx tauri build                      # 输出在 src-tauri/target/release/bundle/nsis/
```

要求：
- Rust stable（`rustup toolchain install stable`）
- Visual Studio Build Tools（含 MSVC + Windows SDK）
- Node 20+

在 Ubuntu 上可做 Rust 编译和 Linux 桌面冒烟验证，但 NSIS `.exe` 仍应在 Windows 或上述 GitHub Actions 中构建。Ubuntu 24.04 的 Tauri 2 依赖为：

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## 目录

- `src-tauri/`：Rust 应用代码 + Tauri 配置
  - `tauri.conf.json`：窗口/打包/CSP 配置；`frontendDist` 指向 `../../shared`
  - `Cargo.toml`：Rust 依赖
  - `capabilities/default.json`：Tauri 2 权限模型
  - `src/lib.rs`：插件注册 + 命令路由
  - `src/commands.rs`：fetch / alarms / window 命令实现
  - `icons/`：多尺寸图标（CI 自动生成，本地需手动生成）
- `package.json`：仅供 `@tauri-apps/cli` 使用

## 设计文档

详见 [`../docs/superpowers/specs/2026-05-10-windows-desktop-design.md`](../docs/superpowers/specs/2026-05-10-windows-desktop-design.md)。
