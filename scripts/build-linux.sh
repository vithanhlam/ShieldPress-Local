#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${PROJECT_DIR}/.build-runtime/linux"

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

rm -rf "${BUILD_ROOT}"
bash "${PROJECT_DIR}/scripts/prepare-linux-php.sh" "${BUILD_ROOT}/php"

cd "${PROJECT_DIR}"
npx electron-builder --linux AppImage deb --x64 --config electron-builder.linux.yml
