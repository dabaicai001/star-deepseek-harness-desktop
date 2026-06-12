#!/usr/bin/env bash
# Build Go sidecar for current platform
# Usage: bash scripts/build-sidecar.sh [--release]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$SCRIPT_DIR/../sidecar"
BIN_DIR="$SIDECAR_DIR/bin"

mkdir -p "$BIN_DIR"

OUTPUT_NAME="starhub-sidecar"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
    OUTPUT_NAME="${OUTPUT_NAME}.exe"
fi

OUTPUT_PATH="$BIN_DIR/$OUTPUT_NAME"

LDFLAGS="-s -w"
if [[ "${1:-}" == "--release" ]]; then
    LDFLAGS="$LDFLAGS -H windowsgui"
fi

echo "Building sidecar..."
echo "  Source: $SIDECAR_DIR"
echo "  Output: $OUTPUT_PATH"

cd "$SIDECAR_DIR"
CGO_ENABLED=0 go build -ldflags "$LDFLAGS" -o "$OUTPUT_PATH" .
echo "Sidecar built successfully: $OUTPUT_PATH"

# 同步到 Tauri target 目录(dev 模式用)
TARGET_DEBUG="$SCRIPT_DIR/../src-tauri/target/debug"
if [ -d "$TARGET_DEBUG" ]; then
    cp "$OUTPUT_PATH" "$TARGET_DEBUG/$OUTPUT_NAME"
    echo "  Synced to $TARGET_DEBUG"
fi
