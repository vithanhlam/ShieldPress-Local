// src/main/extensions.js
const fs = require("fs-extra");
const path = require("path");
const https = require("https");
const http = require("http");
const { spawnSync } = require("child_process");
const log = require("./logger");
const platform = require("./platform");
const svc = require("./services");

// Strip UTF-8 BOM — PHP parser treats it as syntax error when it appears mid-file
function stripBom(str) {
  return str.replace(/\uFEFF/g, "");
}

// ionCube loader download URLs by PHP version
const IONCUBE_BASE = "https://downloads.ioncube.com/loader_downloads";
const IONCUBE_ZIP = "ioncube_loaders_win_nonts_vc16_x86-64.zip";

// All known PHP extensions with descriptions and categories
const ALL_EXTENSIONS = [
  // Database
  { id: "mysqli", name: "MySQLi", dll: "php_mysqli.dll", cat: "Database", desc: "MySQL Improved — required by WordPress & phpMyAdmin" },
  { id: "pdo_mysql", name: "PDO MySQL", dll: "php_pdo_mysql.dll", cat: "Database", desc: "PDO driver for MySQL/MariaDB" },
  { id: "pdo_sqlite", name: "PDO SQLite", dll: "php_pdo_sqlite.dll", cat: "Database", desc: "PDO driver for SQLite" },
  { id: "sqlite3", name: "SQLite3", dll: "php_sqlite3.dll", cat: "Database", desc: "SQLite3 database engine" },
  { id: "pdo_pgsql", name: "PDO PostgreSQL", dll: "php_pdo_pgsql.dll", cat: "Database", desc: "PDO driver for PostgreSQL" },
  { id: "pgsql", name: "PostgreSQL", dll: "php_pgsql.dll", cat: "Database", desc: "PostgreSQL client" },

  // Core / Essential
  { id: "curl", name: "cURL", dll: "php_curl.dll", cat: "Core", desc: "HTTP client for API calls" },
  { id: "openssl", name: "OpenSSL", dll: "php_openssl.dll", cat: "Core", desc: "SSL/TLS encryption" },
  { id: "mbstring", name: "Multibyte String", dll: "php_mbstring.dll", cat: "Core", desc: "UTF-8 and multibyte text handling" },
  { id: "fileinfo", name: "Fileinfo", dll: "php_fileinfo.dll", cat: "Core", desc: "File type detection (MIME)" },
  { id: "tokenizer", name: "Tokenizer", dll: "php_tokenizer.dll", cat: "Core", desc: "PHP token parsing" },
  { id: "xml", name: "XML", dll: "php_xml.dll", cat: "Core", desc: "XML parser" },
  { id: "xmlreader", name: "XMLReader", dll: "php_xmlreader.dll", cat: "Core", desc: "XML pull parser" },
  { id: "xmlwriter", name: "XMLWriter", dll: "php_xmlwriter.dll", cat: "Core", desc: "XML stream writer" },
  { id: "dom", name: "DOM", dll: "php_dom.dll", cat: "Core", desc: "DOM XML manipulation" },
  { id: "simplexml", name: "SimpleXML", dll: "php_simplexml.dll", cat: "Core", desc: "Simple XML access" },
  { id: "ctype", name: "Ctype", dll: "php_ctype.dll", cat: "Core", desc: "Character type checking" },
  { id: "iconv", name: "Iconv", dll: "php_iconv.dll", cat: "Core", desc: "Character set conversion" },
  { id: "filter", name: "Filter", dll: "php_filter.dll", cat: "Core", desc: "Data filtering & validation" },
  { id: "json", name: "JSON", dll: "php_json.dll", cat: "Core", desc: "JSON encode/decode" },
  { id: "phar", name: "Phar", dll: "php_phar.dll", cat: "Core", desc: "PHP Archive support" },

  // Image & Media
  { id: "gd", name: "GD (Image)", dll: "php_gd.dll", cat: "Image", desc: "Image creation & manipulation" },
  { id: "exif", name: "EXIF", dll: "php_exif.dll", cat: "Image", desc: "Read EXIF metadata from images" },
  { id: "imagick", name: "ImageMagick", dll: "php_imagick.dll", cat: "Image", desc: "Advanced image processing" },

  // Compression & Archive
  { id: "zip", name: "ZIP", dll: "php_zip.dll", cat: "Archive", desc: "ZIP archive read/write" },
  { id: "zlib", name: "Zlib", dll: "php_zlib.dll", cat: "Archive", desc: "Gzip compression" },
  { id: "bz2", name: "Bzip2", dll: "php_bz2.dll", cat: "Archive", desc: "Bzip2 compression" },

  // Networking & Email
  { id: "sockets", name: "Sockets", dll: "php_sockets.dll", cat: "Network", desc: "Low-level socket interface" },
  { id: "soap", name: "SOAP", dll: "php_soap.dll", cat: "Network", desc: "SOAP web services client/server" },
  { id: "ftp", name: "FTP", dll: "php_ftp.dll", cat: "Network", desc: "FTP client functions" },
  { id: "ldap", name: "LDAP", dll: "php_ldap.dll", cat: "Network", desc: "LDAP directory access" },

  // Internationalization
  { id: "intl", name: "Intl", dll: "php_intl.dll", cat: "i18n", desc: "Internationalization (ICU)" },
  { id: "gettext", name: "Gettext", dll: "php_gettext.dll", cat: "i18n", desc: "Localization translation" },

  // Cache & Performance
  { id: "opcache", name: "OPcache", dll: "php_opcache.dll", cat: "Performance", desc: "Bytecode cache — speeds up PHP", zend: true },
  { id: "apcu", name: "APCu", dll: "php_apcu.dll", cat: "Performance", desc: "User data cache" },
  { id: "redis", name: "Redis", dll: "php_redis.dll", cat: "Performance", desc: "Redis client extension" },
  { id: "memcached", name: "Memcached", dll: "php_memcached.dll", cat: "Performance", desc: "Memcached client" },

  // Debug & Dev
  { id: "xdebug", name: "Xdebug", dll: "php_xdebug.dll", cat: "Debug", desc: "Debugging and profiling", zend: true },

  // Crypto & Security
  { id: "sodium", name: "Sodium", dll: "php_sodium.dll", cat: "Security", desc: "Modern cryptography (libsodium)" },
  { id: "bcmath", name: "BCMath", dll: "php_bcmath.dll", cat: "Security", desc: "Arbitrary precision math" },
  { id: "gmp", name: "GMP", dll: "php_gmp.dll", cat: "Security", desc: "GNU Multiple Precision math" },

  // Misc
  { id: "calendar", name: "Calendar", dll: "php_calendar.dll", cat: "Misc", desc: "Calendar conversion" },
  { id: "shmop", name: "Shmop", dll: "php_shmop.dll", cat: "Misc", desc: "Shared memory" },
  { id: "tidy", name: "Tidy", dll: "php_tidy.dll", cat: "Misc", desc: "HTML cleanup & repair" },
  { id: "xsl", name: "XSL", dll: "php_xsl.dll", cat: "Misc", desc: "XSLT transformations" },
];

async function getExtensions(phpVersion) {
  const { getPhpDir } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const phpIni = path.join(phpDir, "php.ini");
  const extDir = path.join(phpDir, "ext");

  const extensions = [];
  const knownDlls = new Set();

  // Check ionCube
  const ioncubeDll = findIoncubeDll(phpDir, phpVersion);
  const ioncubeEnabled = await isExtensionEnabled(phpIni, "ioncube");
  extensions.push({
    id: "ioncube",
    name: "ionCube Loader",
    description: "Decode and run ionCube-encoded PHP files",
    cat: "Security",
    installed: !!ioncubeDll,
    enabled: ioncubeEnabled,
    dllPath: ioncubeDll,
    phpVersion,
  });

  const loadedModules = listLoadedPhpModules(phpDir, phpIni);
  const knownIds = new Set(ALL_EXTENSIONS.map((ext) => ext.id));

  // Check all known extensions
  for (const ext of ALL_EXTENSIONS) {
    const modulePath = findExtensionFile(extDir, ext);
    const installed = !!modulePath || loadedModules.has(ext.id);
    const enabled = await isExtensionEnabled(phpIni, ext.id, ext.zend)
      || (!modulePath && loadedModules.has(ext.id));
    knownDlls.add(ext.dll.toLowerCase());
    knownIds.add(ext.id);
    extensions.push({
      id: ext.id,
      name: ext.name,
      description: ext.desc,
      cat: ext.cat,
      installed,
      enabled,
      zend: !!ext.zend,
      dllPath: modulePath,
      phpVersion,
    });
  }

  // Scan for unknown/custom extensions not in the predefined list
  if (fs.existsSync(extDir)) {
    const files = await fs.readdir(extDir);
    for (const file of files) {
      const extId = parseExtensionFileName(file);
      if (!extId || knownIds.has(extId) || knownDlls.has(file.toLowerCase())) continue;
      const enabled = await isExtensionEnabled(phpIni, extId, false);
      knownIds.add(extId);
      extensions.push({
        id: extId,
        name: extId,
        description: `Custom extension (${file})`,
        cat: "Custom",
        installed: true,
        enabled,
        zend: false,
        custom: true,
        dllPath: path.join(extDir, file),
        phpVersion,
      });
    }
  }

  return { success: true, extensions };
}

function findExtensionFile(extDir, ext) {
  const candidates = [
    path.join(extDir, ext.dll),
    path.join(extDir, `${ext.id}.so`),
    path.join(extDir, `php_${ext.id}.dll`),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function parseExtensionFileName(file) {
  if (file.startsWith("php_") && file.endsWith(".dll")) {
    return file.replace(/^php_/, "").replace(/\.dll$/, "");
  }
  if (file.endsWith(".so") && !file.includes(".debug")) {
    return file.replace(/\.so$/, "");
  }
  return null;
}

function listLoadedPhpModules(phpDir, phpIni) {
  const phpBin = path.join(phpDir, platform.isWindows ? "php.exe" : "php");
  if (!fs.existsSync(phpBin)) return new Set();
  const args = ["-m"];
  if (phpIni && fs.existsSync(phpIni)) args.unshift("-c", phpIni);
  const result = spawnSync(phpBin, args, { encoding: "utf8", timeout: 8000, windowsHide: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const loaded = new Set();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("[")) continue;
    if (line === "zend opcache") loaded.add("opcache");
    else if (!line.includes(" ")) loaded.add(line);
  }
  return loaded;
}

function findIoncubeDll(phpDir, phpVersion) {
  const possiblePaths = [
    path.join(phpDir, "ext", `ioncube_loader_win_${phpVersion}.dll`),
    path.join(phpDir, "ioncube", `ioncube_loader_win_${phpVersion}.dll`),
    path.join(phpDir, `ioncube_loader_win_${phpVersion}.dll`),
    path.join(phpDir, "ext", `ioncube_loader_lin_${phpVersion}.so`),
    path.join(phpDir, "ioncube", `ioncube_loader_lin_${phpVersion}.so`),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function isExtensionEnabled(phpIni, extId, isZend) {
  if (!fs.existsSync(phpIni)) return false;
  const ini = stripBom(await fs.readFile(phpIni, "utf8"));

  if (extId === "ioncube") {
    return /^\s*zend_extension\s*=.*ioncube/m.test(ini);
  }
  if (isZend || extId === "opcache" || extId === "xdebug") {
    return new RegExp(`^\\s*zend_extension\\s*=.*${extId}`, "m").test(ini);
  }
  // Regular extension: look for uncommented extension=ext_id, .dll, or .so
  const re = new RegExp(`^\\s*extension\\s*=\\s*(php_)?${extId}(\\.dll|\\.so)?\\s*$`, "m");
  return re.test(ini);
}

async function toggleExtension({ phpVersion, extId, enable }) {
  const { getPhpDir } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const phpIni = path.join(phpDir, "php.ini");

  if (!fs.existsSync(phpIni)) {
    return { success: false, message: "php.ini not found" };
  }

  let ini = stripBom(await fs.readFile(phpIni, "utf8"));
  const extDef = ALL_EXTENSIONS.find((e) => e.id === extId);
  const isZend = extId === "ioncube" || extDef?.zend;

  if (extId === "ioncube") {
    const dllPath = findIoncubeDll(phpDir, phpVersion);
    if (!dllPath && enable) {
      return { success: false, message: "ionCube loader not installed. Install it first." };
    }
    const dllFwd = dllPath ? dllPath.replace(/\\/g, "/") : "";
    // Remove ALL ioncube lines first (fix duplicates)
    ini = ini.replace(/^\s*;?\s*zend_extension\s*=.*ioncube.*\r?\n?/gm, "");
    if (enable) {
      ini = `zend_extension = "${dllFwd}"\n` + ini;
    }
  } else if (isZend) {
    // Remove ALL lines for this zend extension first (fix duplicates)
    const removeRe = new RegExp(`^\\s*;?\\s*zend_extension\\s*=.*${extId}.*\\r?\\n?`, "gm");
    ini = ini.replace(removeRe, "");
    if (enable) {
      ini += platform.isWindows
        ? `\nzend_extension = php_${extId}.dll\n`
        : `\nzend_extension = ${extId}\n`;
    }
  } else {
    // Remove ALL lines for this extension first (fix duplicates)
    const removeRe = new RegExp(`^\\s*;?\\s*extension\\s*=\\s*(php_)?${extId}(\\.dll|\\.so)?\\s*\\r?\\n?`, "gm");
    ini = ini.replace(removeRe, "");
    if (enable) {
      ini += `\nextension=${extId}\n`;
    }
  }

  // Clean up excessive blank lines
  ini = ini.replace(/\n{3,}/g, "\n\n");

  await fs.writeFile(phpIni, ini, "utf8");
  await svc.restartPhpCgi(phpVersion);

  log.ok(`Extension ${extId} ${enable ? "enabled" : "disabled"} for PHP ${phpVersion}`);
  return { success: true };
}

// ─── Batch enable essential extensions (fix common issues) ───────────────────
async function enableEssentials(phpVersion) {
  const essentials = ["mysqli", "pdo_mysql", "curl", "openssl", "mbstring", "fileinfo", "gd", "zip", "intl", "exif"];
  let count = 0;
  for (const extId of essentials) {
    const r = await toggleExtension({ phpVersion, extId, enable: true });
    if (r.success) count++;
  }
  return { success: true, enabled: count };
}

// ─── Fix extension_dir duplicates in php.ini ─────────────────────────────────
async function fixExtensionDir(phpVersion) {
  const { getPhpDir } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const phpIni = path.join(phpDir, "php.ini");
  const extDir = path.join(phpDir, "ext").replace(/\\/g, "/");

  if (!fs.existsSync(phpIni)) return { success: false, message: "php.ini not found" };

  let ini = stripBom(await fs.readFile(phpIni, "utf8"));

  // Remove all extension_dir lines and add one correct one
  ini = ini.replace(/^\s*;?\s*extension_dir\s*=.*/gm, "");
  // Add at the beginning of [PHP] section or top
  const phpSection = ini.match(/\[PHP\]/);
  if (phpSection) {
    ini = ini.replace(/\[PHP\]/, `[PHP]\nextension_dir = "${extDir}"`);
  } else {
    ini = `extension_dir = "${extDir}"\n` + ini;
  }

  await fs.writeFile(phpIni, ini, "utf8");
  await svc.restartPhpCgi(phpVersion);
  log.ok(`extension_dir fixed for PHP ${phpVersion}: ${extDir}`);
  return { success: true };
}

async function installIoncube({ phpVersion }, progressCb) {
  const { getPhpDir, BIN_DIR } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const extDir = path.join(phpDir, "ext");
  await fs.ensureDir(extDir);

  const targetDll = path.join(extDir, `ioncube_loader_win_${phpVersion}.dll`);
  if (fs.existsSync(targetDll)) {
    return { success: true, message: "ionCube already installed" };
  }

  progressCb && progressCb("Downloading ionCube loader...");

  const tempDir = path.join(BIN_DIR, "temp_ioncube");
  await fs.ensureDir(tempDir);
  const zipPath = path.join(tempDir, "ioncube.zip");

  try {
    const url = `${IONCUBE_BASE}/${IONCUBE_ZIP}`;
    progressCb && progressCb(`Downloading from ${url}`);
    await dlFile(url, zipPath);
    progressCb && progressCb("Download complete. Extracting...");

    const { exec } = require("child_process");
    await new Promise((resolve, reject) => {
      exec(
        `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`,
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        },
      );
    });

    progressCb && progressCb("Looking for the correct loader DLL...");

    const ioncubeDir = path.join(tempDir, "ioncube");
    const dllName = `ioncube_loader_win_${phpVersion}.dll`;
    let sourceDll = path.join(ioncubeDir, dllName);

    if (!fs.existsSync(sourceDll)) {
      sourceDll = path.join(ioncubeDir, `ioncube_loader_win_${phpVersion}_nonts.dll`);
    }
    if (!fs.existsSync(sourceDll)) {
      const files = await fs.readdir(ioncubeDir).catch(() => []);
      const match = files.find((f) => f.includes(`win_${phpVersion}`) && f.endsWith(".dll"));
      if (match) sourceDll = path.join(ioncubeDir, match);
      else throw new Error(`ionCube DLL for PHP ${phpVersion} not found. Available: ${files.filter((f) => f.endsWith(".dll")).join(", ")}`);
    }

    await fs.copy(sourceDll, targetDll);
    progressCb && progressCb(`Installed: ${targetDll}`);

    const phpIni = path.join(phpDir, "php.ini");
    if (fs.existsSync(phpIni)) {
      let ini = stripBom(await fs.readFile(phpIni, "utf8"));
      const dllFwd = targetDll.replace(/\\/g, "/");
      if (!/zend_extension\s*=.*ioncube/m.test(ini)) {
        ini = `zend_extension = "${dllFwd}"\n` + ini;
        await fs.writeFile(phpIni, ini, "utf8");
        progressCb && progressCb("ionCube enabled in php.ini");
      }
    }

    await svc.restartPhpCgi(phpVersion);
    progressCb && progressCb("PHP restarted. ionCube is ready!");

    log.ok(`ionCube loader installed for PHP ${phpVersion}`);
    return { success: true };
  } catch (err) {
    log.err("ionCube install failed: " + err.message);
    return { success: false, message: err.message };
  } finally {
    await fs.remove(tempDir).catch(() => {});
  }
}

function dlFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith("https") ? https.get : http.get;
    get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return dlFile(response.headers.location, dest).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode}`));
      }
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// ─── Deduplicate all extension lines in php.ini ─────────────────────────────
async function deduplicateExtensions(phpVersion) {
  const { getPhpDir } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const phpIni = path.join(phpDir, "php.ini");

  if (!fs.existsSync(phpIni)) return { success: false, message: "php.ini not found" };

  let ini = stripBom(await fs.readFile(phpIni, "utf8"));
  const seen = {};
  let dupsRemoved = 0;

  // Deduplicate regular extensions
  ini = ini.replace(/^(\s*;?\s*extension\s*=\s*(php_)?(\w+)(\.dll)?\s*)$/gm, (match, _full, _php, name) => {
    const isCommented = /^\s*;/.test(match);
    const key = `ext_${name}`;
    if (!seen[key]) {
      seen[key] = { kept: true, enabled: !isCommented };
      return match;
    }
    // If we already have an enabled line, remove this one
    if (seen[key].enabled) {
      dupsRemoved++;
      return "";
    }
    // If current is enabled but previous was commented, keep current and we'll have one active
    if (!isCommented) {
      seen[key].enabled = true;
      dupsRemoved++;
      return match;
    }
    dupsRemoved++;
    return "";
  });

  // Deduplicate zend extensions
  const zendSeen = {};
  ini = ini.replace(/^(\s*;?\s*zend_extension\s*=.*)$/gm, (match) => {
    const isCommented = /^\s*;/.test(match);
    // Extract extension name from the line
    const nameMatch = match.match(/(?:php_)?(\w+)(?:\.dll)?/i);
    if (!nameMatch) return match;
    const name = nameMatch[1].toLowerCase();
    const key = `zend_${name}`;
    if (!zendSeen[key]) {
      zendSeen[key] = { kept: true, enabled: !isCommented };
      return match;
    }
    dupsRemoved++;
    return "";
  });

  ini = ini.replace(/\n{3,}/g, "\n\n");

  if (dupsRemoved > 0) {
    await fs.writeFile(phpIni, ini, "utf8");
    await svc.restartPhpCgi(phpVersion);
    log.ok(`Removed ${dupsRemoved} duplicate extension lines for PHP ${phpVersion}`);
  }

  return { success: true, removed: dupsRemoved };
}

// ─── Get duplicate extension diagnostic info ────────────────────────────────
async function getDuplicateInfo(phpVersion) {
  const { getPhpDir } = global.CONST;
  phpVersion = phpVersion || "8.3";
  const phpDir = getPhpDir(phpVersion);
  const phpIni = path.join(phpDir, "php.ini");

  if (!fs.existsSync(phpIni)) return { success: false, message: "php.ini not found" };

  const ini = stripBom(await fs.readFile(phpIni, "utf8"));
  const lines = ini.split(/\r?\n/);
  const extCount = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match extension= or zend_extension= (including commented)
    const m = line.match(/^\s*;?\s*(zend_)?extension\s*=\s*(php_)?(\w+)/);
    if (!m) continue;
    const type = m[1] ? "zend" : "ext";
    const name = m[3];
    const key = `${type}:${name}`;
    const isCommented = /^\s*;/.test(line);
    if (!extCount[key]) extCount[key] = [];
    extCount[key].push({ line: i + 1, text: line.trim(), commented: isCommented });
  }

  const duplicates = {};
  for (const [key, entries] of Object.entries(extCount)) {
    if (entries.length > 1) duplicates[key] = entries;
  }

  return { success: true, duplicates, totalDuplicates: Object.keys(duplicates).length };
}

// ─── Add a PHP version (copy from external path or download) ────────────────
async function addPhpVersion({ version, sourcePath }) {
  const { PHP_BASE_DIR } = global.CONST;
  const targetDir = path.join(PHP_BASE_DIR, version);

  if (fs.existsSync(path.join(targetDir, "php-cgi.exe"))) {
    return { success: false, message: `PHP ${version} already exists` };
  }

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { success: false, message: "Source path not found. Please provide a valid path to a PHP installation folder." };
  }

  // Verify source has php-cgi.exe
  const srcCgi = path.join(sourcePath, "php-cgi.exe");
  if (!fs.existsSync(srcCgi)) {
    return { success: false, message: "php-cgi.exe not found in source folder. Please provide a valid PHP installation." };
  }

  try {
    await fs.ensureDir(targetDir);
    await fs.copy(sourcePath, targetDir, { overwrite: true });

    // Set up php.ini if not present
    const phpIni = path.join(targetDir, "php.ini");
    const phpIniDev = path.join(targetDir, "php.ini-development");
    if (!fs.existsSync(phpIni) && fs.existsSync(phpIniDev)) {
      await fs.copy(phpIniDev, phpIni);
    }

    // Fix extension_dir
    if (fs.existsSync(phpIni)) {
      let ini = stripBom(await fs.readFile(phpIni, "utf8"));
      const extDir = path.join(targetDir, "ext").replace(/\\/g, "/");
      ini = ini.replace(/^\s*;?\s*extension_dir\s*=.*/gm, "");
      ini = `extension_dir = "${extDir}"\n` + ini;
      await fs.writeFile(phpIni, ini, "utf8");
    }

    log.ok(`PHP ${version} added from ${sourcePath}`);
    return { success: true };
  } catch (err) {
    log.err(`Failed to add PHP ${version}: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ─── Remove a PHP version ───────────────────────────────────────────────────
async function removePhpVersion(version) {
  const { PHP_BASE_DIR } = global.CONST;
  const targetDir = path.join(PHP_BASE_DIR, version);

  if (!fs.existsSync(targetDir)) {
    return { success: false, message: `PHP ${version} not found` };
  }

  // Stop PHP if running this version
  try { await svc.stopPhpCgi(version); } catch (e) {}

  try {
    await fs.remove(targetDir);
    log.ok(`PHP ${version} removed`);
    return { success: true };
  } catch (err) {
    log.err(`Failed to remove PHP ${version}: ${err.message}`);
    return { success: false, message: err.message };
  }
}

module.exports = {
  getExtensions,
  toggleExtension,
  installIoncube,
  enableEssentials,
  fixExtensionDir,
  deduplicateExtensions,
  getDuplicateInfo,
  addPhpVersion,
  removePhpVersion,
};
