#!/usr/bin/env bash
# Marginote · Chrome 扩展准备脚本
# 扩展仍可直接加载；本脚本负责刷新由 shared 生成的纯逻辑核心并执行资源回归。
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/sync-extension-cores.mjs
node test/static-assets.test.js
echo "Marginote 扩展核心已同步，可加载 extension/ 目录。"
