#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a normal user; it will request sudo when needed." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y \
  nginx mariadb-server mariadb-client redis-server \
  php-cgi php-cli php-mysql php-curl php-mbstring php-xml php-gd php-zip \
  libnss3-tools policykit-1

echo "Ubuntu runtime dependencies installed."
echo "Optional HTTPS support: install mkcert, then run: mkcert -install"

