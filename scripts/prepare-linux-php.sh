#!/usr/bin/env bash
set -euo pipefail

# Extract Ubuntu PHP debs into a versioned runtime tree:
#   <out>/8.3/{php,php-cgi,php.ini,ext/*.so}
#   <out>/8.5/{php,php-cgi,php.ini,ext/*.so}

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${PROJECT_DIR}/.build-runtime/linux/php}"
CACHE_ROOT="${TMPDIR:-/tmp}/shieldpress-php-debs"
MAIN_URL="https://archive.ubuntu.com/ubuntu/pool/main/p"
UNIVERSE_URL="https://archive.ubuntu.com/ubuntu/pool/universe/p"

MAIN_PACKAGES=(common opcache readline cli cgi mysql curl mbstring xml gd gmp ldap pgsql sqlite3 tidy)
UNIVERSE_PACKAGES=(bcmath bz2 zip intl soap)

download_and_extract() {
  local series="$1"
  local version="$2"
  local package="$3"
  local repository="$4"
  local extract_dir="$5"
  local filename="php${series}-${package}_${version}_amd64.deb"
  local cache_dir="${CACHE_ROOT}/php${series}"
  mkdir -p "${cache_dir}"
  if [[ ! -s "${cache_dir}/${filename}" ]]; then
    curl -fL "${repository}/php${series}/${filename}" -o "${cache_dir}/${filename}"
  fi
  dpkg-deb -x "${cache_dir}/${filename}" "${extract_dir}"
}

install_php_series() {
  local series="$1"
  local version="$2"
  local abi="$3"
  local ini_src="$4"
  local php_dir="${OUT_DIR}/${series}"
  local extract_dir
  extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/shieldpress-php${series}-XXXXXX")"

  mkdir -p "${php_dir}/ext"
  for package in "${MAIN_PACKAGES[@]}"; do
    download_and_extract "${series}" "${version}" "${package}" "${MAIN_URL}" "${extract_dir}"
  done
  for package in "${UNIVERSE_PACKAGES[@]}"; do
    download_and_extract "${series}" "${version}" "${package}" "${UNIVERSE_URL}" "${extract_dir}"
  done

  install -m 0755 "${extract_dir}/usr/bin/php-cgi${series}" "${php_dir}/php-cgi"
  install -m 0755 "${extract_dir}/usr/bin/php${series}" "${php_dir}/php"
  cp -a "${extract_dir}/usr/lib/php/${abi}/." "${php_dir}/ext/"
  install -m 0644 "${ini_src}" "${php_dir}/php.ini"
  if [[ -f "${extract_dir}/usr/share/doc/php${series}-common/copyright" ]]; then
    install -m 0644 "${extract_dir}/usr/share/doc/php${series}-common/copyright" "${php_dir}/LICENSE.php${series}"
  fi
  rm -rf "${extract_dir}"
}

# Noble PHP 8.3 needs a few libraries that Ubuntu 26.04 no longer ships.
# Keep them next to the binaries so 8.3 works without changing the OS.
vendor_compat_libs() {
  local php_dir="$1"
  local lib_dir="${php_dir}/lib"
  local extract_dir
  extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/shieldpress-phplibs-XXXXXX")"
  mkdir -p "${lib_dir}"
  local cache_dir="${CACHE_ROOT}/noble-libs"
  mkdir -p "${cache_dir}"
  local packages=(
    "pool/main/libx/libxml2/libxml2_2.9.14+dfsg-1.3ubuntu3_amd64.deb"
    "pool/main/i/icu/libicu74_74.2-1ubuntu3_amd64.deb"
    "pool/main/t/tidy-html5/libtidy5deb1_5.6.0-11ubuntu2_amd64.deb"
    "pool/universe/libz/libzip/libzip4t64_1.7.3-1.1ubuntu2_amd64.deb"
  )
  for rel in "${packages[@]}"; do
    local filename
    filename="$(basename "${rel}")"
    if [[ ! -s "${cache_dir}/${filename}" ]]; then
      curl -fL "https://archive.ubuntu.com/ubuntu/${rel}" -o "${cache_dir}/${filename}"
    fi
    dpkg-deb -x "${cache_dir}/${filename}" "${extract_dir}"
  done
  find "${extract_dir}" -type f \( -name "*.so*" \) -exec cp -a {} "${lib_dir}/" \;
  find "${extract_dir}" -type l \( -name "*.so*" \) -exec cp -a {} "${lib_dir}/" \;
  rm -rf "${extract_dir}"
}

wrap_php_binaries() {
  local php_dir="$1"
  for name in php php-cgi; do
    if file -b "${php_dir}/${name}" 2>/dev/null | grep -q ELF; then
      mv -f "${php_dir}/${name}" "${php_dir}/${name}.bin"
    fi
    cat > "${php_dir}/${name}" <<'EOF'
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export LD_LIBRARY_PATH="$DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$DIR/$(basename "$0").bin" -d "extension_dir=$DIR/ext" "$@"
EOF
    chmod 0755 "${php_dir}/${name}"
  done
}

mkdir -p "${OUT_DIR}"
install_php_series "8.3" "8.3.6-0ubuntu0.24.04.10" "20230831" "${PROJECT_DIR}/assets/php83.ini"
vendor_compat_libs "${OUT_DIR}/8.3"
wrap_php_binaries "${OUT_DIR}/8.3"
install_php_series "8.4" "8.4.11-1ubuntu1.2" "20240924" "${PROJECT_DIR}/assets/php84.ini"
install_php_series "8.5" "8.5.9-0ubuntu1" "20250925" "${PROJECT_DIR}/assets/php85.ini"
echo "Prepared PHP runtimes in ${OUT_DIR}"
