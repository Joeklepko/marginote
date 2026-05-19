#!/usr/bin/env bash
# Marginote · Chrome 扩展构建脚本
# 把 ../shared/* 拷进当前目录，让 extension/ 成为自包含的 Chrome 扩展根。
# 拷入的副本被 .gitignore 忽略。
set -euo pipefail

cd "$(dirname "$0")"
SHARED="../shared"

if [ ! -d "$SHARED" ]; then
  echo "error: $SHARED not found (must run from extension/ directory)" >&2
  exit 1
fi

# 清理上次拷入的内容（保留 manifest.json / background.js / build.sh）
rm -rf icons images js vendor index.html app.js manual.md

# 拷贝 shared 全部内容到当前目录
cp -R "$SHARED"/. .

echo "✔ Extension built at: $(pwd)"
echo "  Load this directory as unpacked extension in Chrome (chrome://extensions → 加载已解压的扩展程序)."
