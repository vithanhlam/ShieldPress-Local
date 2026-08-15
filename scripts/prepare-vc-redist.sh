#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${PROJECT_DIR}/assets/vc_redist.x64.exe"
URL="https://aka.ms/vs/17/release/vc_redist.x64.exe"

if [[ -s "${DEST}" ]]; then
  echo "Using existing ${DEST}"
  exit 0
fi

echo "Downloading Visual C++ Redistributable x64..."
curl -fL "${URL}" -o "${DEST}"
echo "Saved ${DEST}"
