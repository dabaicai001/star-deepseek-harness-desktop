#!/usr/bin/env bash
set -ex

# 环境
export PATH="$HOME/.cargo/bin:/mnt/d/linux/golang/app/go/bin:$PATH"
cd /mnt/d/code/new_project/starhub
export CARGO_TARGET_DIR=/mnt/d/code/new_project/starhub/src-tauri/target-linux

# npm 依赖
npm install
echo "=== npm install done ==="

# 构建
npx tauri build
echo "=== tauri build done ==="

# 列出产物
ls -lh src-tauri/target-linux/release/bundle/deb/ 2>/dev/null || true
ls -lh src-tauri/target-linux/release/bundle/appimage/ 2>/dev/null || true
ls -lh src-tauri/target-linux/release/bundle/rpm/ 2>/dev/null || true
