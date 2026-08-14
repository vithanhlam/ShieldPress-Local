#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${PROJECT_DIR}/.build-runtime/linux"
PHP_DIR="${BUILD_ROOT}/php/8.4"
CACHE_DIR="${TMPDIR:-/tmp}/shieldpress-php84-8.4.11"
EXTRACT_DIR="${BUILD_ROOT}/extract"
PHP_VERSION="8.4.11-1ubuntu1.2"
MAIN_URL="https://archive.ubuntu.com/ubuntu/pool/main/p/php8.4"
UNIVERSE_URL="https://archive.ubuntu.com/ubuntu/pool/universe/p/php8.4"

MAIN_PACKAGES=(common opcache readline cli cgi mysql curl mbstring xml gd)
UNIVERSE_PACKAGES=(bcmath bz2 zip)

cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

rm -rf "${BUILD_ROOT}"
mkdir -p "${PHP_DIR}/ext" "${CACHE_DIR}" "${EXTRACT_DIR}"

download_package() {
  local repository="$1"
  local package="$2"
  local filename="php8.4-${package}_${PHP_VERSION}_amd64.deb"
  if [[ ! -s "${CACHE_DIR}/${filename}" ]]; then
    curl -fL "${repository}/${filename}" -o "${CACHE_DIR}/${filename}"
  fi
  dpkg-deb -x "${CACHE_DIR}/${filename}" "${EXTRACT_DIR}"
}

for package in "${MAIN_PACKAGES[@]}"; do
  download_package "${MAIN_URL}" "${package}"
done
for package in "${UNIVERSE_PACKAGES[@]}"; do
  download_package "${UNIVERSE_URL}" "${package}"
done

install -m 0755 "${EXTRACT_DIR}/usr/bin/php-cgi8.4" "${PHP_DIR}/php-cgi"
install -m 0755 "${EXTRACT_DIR}/usr/bin/php8.4" "${PHP_DIR}/php"
cp -a "${EXTRACT_DIR}/usr/lib/php/20240924/." "${PHP_DIR}/ext/"
install -m 0644 "${PROJECT_DIR}/assets/php84.ini" "${PHP_DIR}/php.ini"
install -m 0644 "${EXTRACT_DIR}/usr/share/doc/php8.4-common/copyright" "${PHP_DIR}/LICENSE.php8.4"

cd "${PROJECT_DIR}"
npx electron-builder --linux AppImage deb --x64 --config electron-builder.linux.yml
