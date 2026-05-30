#!/usr/bin/env bash
# 一次性下载 Excalidraw 自托管资源（约 3MB，需联网一次，之后离线可用）。
# 这些文件刻意 .gitignore，不入库（体积大、可重新下载）。
#
# 用法（在项目任意位置均可）：  bash shared/excalidraw/vendor/fetch.sh
# 会自动写入两处：shared/excalidraw/vendor/（桌面 exe）与
#                extension/excalidraw/vendor/（Chrome 扩展），无需手动复制。
set -euo pipefail

# 本脚本所在目录 = shared/excalidraw/vendor
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# 项目根 = 上三级
ROOT="$(cd "$SELF_DIR/../../.." && pwd)"
SHARED_DIR="$ROOT/shared/excalidraw/vendor"
EXT_DIR="$ROOT/extension/excalidraw/vendor"

REACT_VER="18.2.0"
EXCALI_VER="0.17.6"

dl() {  # dl <url> <outfile>
  local url="$1" out="$2"
  echo "↓ $(basename "$out")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "需要 curl 或 wget" >&2; exit 1
  fi
}

mkdir -p "$SHARED_DIR"
cd "$SHARED_DIR"

dl "https://unpkg.com/react@${REACT_VER}/umd/react.production.min.js"            react.production.min.js
dl "https://unpkg.com/react-dom@${REACT_VER}/umd/react-dom.production.min.js"    react-dom.production.min.js
dl "https://unpkg.com/@excalidraw/excalidraw@${EXCALI_VER}/dist/excalidraw.production.min.js" excalidraw.production.min.js
# 样式（0.17.x 单文件 CSS）
dl "https://unpkg.com/@excalidraw/excalidraw@${EXCALI_VER}/dist/excalidraw.min.css" excalidraw.css || \
  echo "/* excalidraw.css 可选，缺失不影响功能 */" > excalidraw.css

# 简单校验：excalidraw 主包应明显 > 100KB，否则多半是 404 错误页
SZ=$(wc -c < excalidraw.production.min.js | tr -d ' ')
if [ "${SZ:-0}" -lt 100000 ]; then
  echo "⚠️  excalidraw.production.min.js 仅 ${SZ} 字节，疑似下载失败（404/网络）。请检查版本号或网络。" >&2
  exit 1
fi

# 同步到扩展端（Chrome 实际加载的是 extension/）
if [ -d "$ROOT/extension/excalidraw" ]; then
  mkdir -p "$EXT_DIR"
  cp -f "$SHARED_DIR"/react.production.min.js "$SHARED_DIR"/react-dom.production.min.js \
        "$SHARED_DIR"/excalidraw.production.min.js "$SHARED_DIR"/excalidraw.css "$EXT_DIR"/ 2>/dev/null || true
  echo "✓ 已同步到扩展：$EXT_DIR"
fi

echo
echo "✓ 完成。桌面：$SHARED_DIR"
echo "  现在在 Marginote 侧栏点「新建画板」即可画图。"
