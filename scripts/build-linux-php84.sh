#!/usr/bin/env bash
set -euo pipefail
# Build the security release against the host libraries (Ubuntu 26.04).
# Dependencies: build-essential pkg-config libxml2-dev libssl-dev libsqlite3-dev
# libcurl4-openssl-dev libpng-dev libjpeg-dev libfreetype-dev libonig-dev
# libicu-dev libzip-dev libxslt1-dev libbz2-dev libgmp-dev libldap2-dev
# libpq-dev libreadline-dev libtidy-dev libsodium-dev.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${PROJECT_DIR}/.build-runtime/linux/php/8.4}"
mkdir -p "${OUT_DIR}"
OUT_DIR="$(cd "${OUT_DIR}" && pwd)"
BUILD_DIR="$(mktemp -d /tmp/shieldpress-php84-build-XXXXXX)"
trap 'rm -rf "${BUILD_DIR}"' EXIT
curl --fail --location --retry 3 https://www.php.net/distributions/php-8.4.27.tar.xz -o "${BUILD_DIR}/php.tar.xz"
printf '%s  %s\n' dcf93923b0e38e0d5252b25b796520b5a47761a08b3488b6d0b5d1115764d3f0 "${BUILD_DIR}/php.tar.xz" | sha256sum --check --status
tar -xJf "${BUILD_DIR}/php.tar.xz" -C "${BUILD_DIR}"
cd "${BUILD_DIR}/php-8.4.27"
./configure --prefix="${BUILD_DIR}/install" --enable-cli --enable-cgi \
  --with-openssl --with-zlib --with-bz2 --with-curl --with-gmp --with-gettext \
  --with-iconv --with-ldap --with-pgsql --with-readline --with-tidy --with-sodium \
  --enable-bcmath=shared --enable-calendar=shared --enable-ctype=shared \
  --enable-dom=shared --enable-exif=shared --enable-fileinfo=shared --enable-ftp=shared \
  --enable-gd=shared --with-jpeg --with-freetype --enable-intl=shared \
  --enable-mbstring=shared --enable-mysqlnd=shared --with-mysqli=shared,mysqlnd \
  --enable-pdo=shared --with-pdo-mysql=shared,mysqlnd --with-pdo-pgsql=shared \
  --with-pdo-sqlite=shared --with-sqlite3=shared --enable-phar=shared \
  --enable-posix=shared --enable-simplexml=shared --enable-soap=shared \
  --enable-sockets=shared --enable-tokenizer=shared --enable-xml=shared \
  --enable-xmlreader=shared --enable-xmlwriter=shared --with-xsl=shared \
  --with-zip=shared --enable-opcache
make -s -j"${PHP_BUILD_JOBS:-$(nproc)}"
mkdir -p "${OUT_DIR}/ext"
install -m 0755 sapi/cli/php "${OUT_DIR}/php"
install -m 0755 sapi/cgi/php-cgi "${OUT_DIR}/php-cgi"
cp modules/*.so "${OUT_DIR}/ext/"
install -m 0644 "${PROJECT_DIR}/assets/php84.ini" "${OUT_DIR}/php.ini"
# These extensions are compiled into the runtime instead of shared modules.
sed -i -E '/^extension=(bz2|curl|gettext|gmp|iconv|ldap|pgsql|readline|tidy)$/d' "${OUT_DIR}/php.ini"
printf '%s\n' bz2 curl gettext gmp iconv ldap pgsql readline tidy > "${OUT_DIR}/.shieldpress-php-builtins"
install -m 0644 LICENSE "${OUT_DIR}/LICENSE.php8.4"
# Vendor non-glibc dependencies to keep the runtime usable on clean hosts.
mkdir -p "${OUT_DIR}/lib"
while IFS= read -r dependency; do
  case "$(basename "${dependency}")" in
    libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|ld-linux*) continue ;;
  esac
  cp -L "${dependency}" "${OUT_DIR}/lib/"
done < <(ldd "${OUT_DIR}/php" "${OUT_DIR}/php-cgi" "${OUT_DIR}"/ext/*.so | awk '/=> \// {print $3}' | sort -u)
for binary in php php-cgi; do
  mv "${OUT_DIR}/${binary}" "${OUT_DIR}/${binary}.bin"
  cat > "${OUT_DIR}/${binary}" <<'WRAPPER'
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
export LD_LIBRARY_PATH="$DIR/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$DIR/$(basename "$0").bin" -d "extension_dir=$DIR/ext" "$@"
WRAPPER
  chmod 0755 "${OUT_DIR}/${binary}"
done
printf '%s\n' 'php.net-8.4.27-sha256-dcf93923b0e38e0d5252b25b796520b5a47761a08b3488b6d0b5d1115764d3f0' > "${OUT_DIR}/.shieldpress-php-source"
