#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="${PROJECT_DIR}/.build-runtime/windows"
mkdir -p "${BUILD_ROOT}/bin"
bash "${PROJECT_DIR}/scripts/prepare-vc-redist.sh"

# Preserve the other bundled services, and stage PHP 8.4 from a fresh official
# archive so obsolete PHP DLLs cannot survive an in-place extraction.
rsync -a --delete --exclude='php/8.4' "${PROJECT_DIR}/bin/" "${BUILD_ROOT}/bin/"
PHP_STAGE="$(mktemp -d "${BUILD_ROOT}/php84-XXXXXX")"
trap 'rm -rf "${PHP_STAGE}"' EXIT
bash "${PROJECT_DIR}/scripts/prepare-windows-php.sh" "${PHP_STAGE}" "8.4"
if [[ -f "${PROJECT_DIR}/bin/php/8.4/php.ini" ]]; then
  cp "${PROJECT_DIR}/bin/php/8.4/php.ini" "${PHP_STAGE}/8.4/php.ini"
fi
node - "${PROJECT_DIR}" "${BUILD_ROOT}" "${PHP_STAGE}" <<'JS'
const fs = require('fs-extra');
const path = require('path');
const [project, buildRoot, phpStage] = process.argv.slice(2);
const destination = path.join(buildRoot, 'bin', 'php', '8.4');
fs.removeSync(destination);
fs.moveSync(path.join(phpStage, '8.4'), destination);
// Linux and Windows share the source ini template. Keep only load directives
// backed by DLLs in this clean Windows runtime; built-in modules need none.
const iniFile = path.join(destination, 'php.ini');
if (fs.existsSync(iniFile)) {
  const ini = fs.readFileSync(iniFile, 'utf8').split('\n').filter(line => {
    const match = line.match(/^\s*(?:zend_)?extension\s*=\s*["']?(?:php_)?([a-z0-9_]+)(?:\.dll)?["']?\s*(?:;.*)?$/i);
    if (!match) return true;
    return [`php_${match[1]}.dll`, `${match[1]}.dll`].some(file => fs.existsSync(path.join(destination, 'ext', file)));
  }).join('\n');
  fs.writeFileSync(iniFile, ini);
}
const config = fs.readJsonSync(path.join(project, 'package.json')).build;
config.extraResources = config.extraResources.map(item => item.from === 'bin'
  ? { ...item, from: path.join(buildRoot, 'bin') } : item);
fs.writeJsonSync(path.join(buildRoot, 'builder.json'), config, { spaces: 2 });
JS
cd "${PROJECT_DIR}"
npx --no-install electron-builder --win nsis --x64 --config "${BUILD_ROOT}/builder.json" --publish never
