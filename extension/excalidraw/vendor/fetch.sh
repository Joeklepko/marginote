#!/usr/bin/env bash
# 一次性下载 Excalidraw 自托管资源到本目录（约 3MB，需联网一次，之后离线可用）。
# 这些文件刻意 .gitignore，不入库（体积大、可重新下载）。
#
# 用法：  cd shared/excalidraw/vendor && bash fetch.sh
# 下载后记得同步到扩展：  cp -r shared/excalidraw extension/   （或重跑你的同步流程）
set -euo pipefail
cd "$(dirname "$0")"

# 版本可按需升级；UMD 版自带打包，无需 npm/构建。
REACT_VER="18.2.0"
EXCALI_VER="0.17.6"

dl() {  # dl <url> <outfile>
  local url="$1" out="$2"
  echo "↓ $out"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "需要 curl 或 wget" >&2; exit 1
  fi
}

dl "https://unpkg.com/react@${REACT_VER}/umd/react.production.min.js"            react.production.min.js
dl "https://unpkg.com/react-dom@${REACT_VER}/umd/react-dom.production.min.js"    react-dom.production.min.js
dl "https://unpkg.com/@excalidraw/excalidraw@${EXCALI_VER}/dist/excalidraw.production.min.js" excalidraw.production.min.js
# 样式（0.17.x 单文件 CSS）
dl "https://unpkg.com/@excalidraw/excalidraw@${EXCALI_VER}/dist/excalidraw.min.css" excalidraw.css || \
  echo "/* excalidraw.css 可选，缺失不影响功能 */" > excalidraw.css

echo
echo "✓ 完成。资源已下载到 $(pwd)"
echo "  现在可在 Marginote 里点工具栏的「画图」创建画板。"
echo "  别忘了同步到扩展：把 shared/excalidraw/ 复制到 extension/excalidraw/"
