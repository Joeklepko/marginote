#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 维护脚本（普通使用无需运行）：重新拉取 / 升级自托管的 Excalidraw 资源。
#
# 这些资源 **已随仓库提交、并打进安装包与扩展**，所以：
#   · 克隆代码后无需运行本脚本，画板直接可用；
#   · 你打包 exe / 扩展给别人，对方也无需运行任何脚本。
#
# 只有在你想 **升级 Excalidraw/React 版本** 时才需要：改下面的版本号再跑一次，
# 它会把 shared/ 与 extension/ 两端的 ./vendor/ 全量刷新（含字体、分包、zh-CN 语言包），
# 然后你 git add 提交即可。
#
# 用法：bash shared/excalidraw/vendor/fetch.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REACT_VER="18.2.0"
EXCALI_VER="0.17.6"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"          # shared/excalidraw/vendor
ROOT="$(cd "$SELF_DIR/../../.." && pwd)"           # 仓库根
SHARED_DIR="$ROOT/shared/excalidraw/vendor"
EXT_DIR="$ROOT/extension/excalidraw/vendor"
PKG_BASE="https://unpkg.com/@excalidraw/excalidraw@${EXCALI_VER}/dist"

dl() {  # dl <url> <outfile>
  local url="$1" out="$2"
  mkdir -p "$(dirname "$out")"
  echo "↓ ${out#$SHARED_DIR/}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    echo "需要 curl 或 wget" >&2; exit 1
  fi
}

# 干净重建 excalidraw-assets（避免升级后残留旧 hash 的分包/语言包）
rm -rf "$SHARED_DIR/excalidraw-assets"
mkdir -p "$SHARED_DIR/excalidraw-assets"

echo "== 核心运行时 =="
dl "https://unpkg.com/react@${REACT_VER}/umd/react.production.min.js"          "$SHARED_DIR/react.production.min.js"
dl "https://unpkg.com/react-dom@${REACT_VER}/umd/react-dom.production.min.js"  "$SHARED_DIR/react-dom.production.min.js"
dl "$PKG_BASE/excalidraw.production.min.js"                                     "$SHARED_DIR/excalidraw.production.min.js"

# 从包清单里解析 excalidraw-assets 下需要的文件（文件名带内容 hash，随版本变化）：
#   · 字体  *.woff2          —— 手写体/界面字/代码字
#   · vendor-<hash>.js(+LICENSE) —— 编辑器挂载时加载的公共依赖分包
#   · locales/zh-CN-*.js     —— 中文界面（英文是内置默认，无需单独下载）
echo "== 解析资源清单 =="
META="$(curl -fsSL "$PKG_BASE/?meta")"
WANT="$(printf '%s' "$META" \
  | grep -oE '/dist/excalidraw-assets/[^"]+' \
  | grep -E '\.woff2$|/vendor-[a-f0-9]+\.js(\.LICENSE\.txt)?$|/locales/zh-CN-json-[a-f0-9]+\.js$' \
  | sort -u)"

if [ -z "$WANT" ]; then
  echo "⚠️  未能从清单解析到字体/分包/语言包，疑似版本号有误或网络异常。" >&2
  exit 1
fi

echo "== 字体 / 分包 / 语言包 =="
while IFS= read -r p; do
  rel="${p#/dist/}"                       # excalidraw-assets/...
  dl "$PKG_BASE/$rel" "$SHARED_DIR/$rel"
done <<< "$WANT"

echo "== 校验 =="
sz() { wc -c < "$1" 2>/dev/null | tr -d ' '; }
need() { # path minbytes
  local s; s="$(sz "$1")"
  if [ "${s:-0}" -lt "$2" ]; then echo "⚠️  $1 仅 ${s:-0} 字节（疑似下载失败）" >&2; exit 1; fi
}
need "$SHARED_DIR/excalidraw.production.min.js" 1000000
VEND="$(ls "$SHARED_DIR"/excalidraw-assets/vendor-*.js 2>/dev/null | head -1 || true)"
[ -n "$VEND" ] && need "$VEND" 500000 || { echo "⚠️  缺少 vendor 分包" >&2; exit 1; }
ls "$SHARED_DIR"/excalidraw-assets/*.woff2 >/dev/null 2>&1 || { echo "⚠️  缺少字体" >&2; exit 1; }
ls "$SHARED_DIR"/excalidraw-assets/locales/zh-CN-*.js >/dev/null 2>&1 || { echo "⚠️  缺少 zh-CN 语言包" >&2; exit 1; }

# 同步到扩展端（Chrome 实际加载 extension/excalidraw/vendor/）
echo "== 同步到扩展端 =="
rm -rf "$EXT_DIR/excalidraw-assets"
mkdir -p "$EXT_DIR"
cp -f "$SHARED_DIR"/react.production.min.js "$SHARED_DIR"/react-dom.production.min.js \
      "$SHARED_DIR"/excalidraw.production.min.js "$EXT_DIR"/
cp -rf "$SHARED_DIR"/excalidraw-assets "$EXT_DIR"/

echo
echo "✓ 完成。已刷新两端资源："
echo "    桌面：$SHARED_DIR"
echo "    扩展：$EXT_DIR"
echo "  记得 git add 提交（资源随仓库分发，对外发布无需任何脚本）。"
