#!/bin/sh
set -e

APP_DIR="/opt/ShieldPressLocal"
EXECUTABLE="$APP_DIR/shieldpresslocal"
SANDBOX="$APP_DIR/chrome-sandbox"
PMA_SOURCE="$APP_DIR/resources/phpmyadmin-shieldpress.php"

# A custom after-install script replaces electron-builder's default one, so
# keep its command-line launcher registration here as well.
if command -v update-alternatives >/dev/null 2>&1; then
  update-alternatives --install /usr/bin/shieldpresslocal shieldpresslocal "$EXECUTABLE" 100
else
  ln -sf "$EXECUTABLE" /usr/bin/shieldpresslocal
fi

if [ -f "$SANDBOX" ]; then
  chown root:root "$SANDBOX"
  chmod 4755 "$SANDBOX"
fi

if [ -d /etc/phpmyadmin/conf.d ] && [ -f "$PMA_SOURCE" ]; then
  install -o root -g root -m 0644 "$PMA_SOURCE" /etc/phpmyadmin/conf.d/shieldpress.php
fi
