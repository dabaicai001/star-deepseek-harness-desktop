#!/usr/bin/env bash
set -ex

# Switch apt to Aliyun mirror over HTTP
sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list
sed -i 's|http://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev libxdo-dev libsqlite3-dev

# Node.js 22
NODE_VERSION=v22.16.0
wget -q --no-check-certificate "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" -O /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
rm /tmp/node.tar.xz

# Rust & Go mounted from host
export PATH="/root/.cargo/bin:/usr/local/go/bin:$PATH"

# npm config
npm config set strict-ssl false
npm config set registry http://registry.npmmirror.com

cd /workspace
export CARGO_TARGET_DIR=/workspace/src-tauri/target-jammy
npm install
npx tauri build

echo "=== Build complete ==="
ls -lh src-tauri/target-jammy/release/bundle/deb/ src-tauri/target-jammy/release/bundle/rpm/ src-tauri/target-jammy/release/bundle/appimage/ 2>/dev/null
