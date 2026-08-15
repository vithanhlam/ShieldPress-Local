#!/usr/bin/env bash
set -euo pipefail

# Download official Windows NTS x64 PHP builds into bin/php/<version>/
# 8.3 = VS16, 8.4/8.5 = VS17 (matches ionCube VC16 / VC17 loaders)

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${PROJECT_DIR}/bin/php}"
CACHE_DIR="${TMPDIR:-/tmp}/shieldpress-php-win"

mkdir -p "${OUT_DIR}" "${CACHE_DIR}"

fetch_zip() {
  local version="$1"
  local filename="$2"
  local url="https://windows.php.net/downloads/releases/${filename}"
  local zip_path="${CACHE_DIR}/${filename}"
  if [[ ! -s "${zip_path}" ]]; then
    curl -fL "${url}" -o "${zip_path}"
  fi
  local dest="${OUT_DIR}/${version}"
  mkdir -p "${dest}"
  python3 - <<PY
import zipfile
from pathlib import Path
zip_path = Path("${zip_path}")
dest = Path("${dest}")
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall(dest)
PY
  if [[ ! -f "${dest}/php.ini" && -f "${dest}/php.ini-production" ]]; then
    cp "${dest}/php.ini-production" "${dest}/php.ini"
  fi
}

fetch_zip "8.3" "php-8.3.33-nts-Win32-vs16-x64.zip"
fetch_zip "8.4" "php-8.4.24-nts-Win32-vs17-x64.zip"
fetch_zip "8.5" "php-8.5.9-nts-Win32-vs17-x64.zip"
echo "Prepared Windows PHP runtimes in ${OUT_DIR}"
