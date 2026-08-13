// src/main/setup.js
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");
const { CONST } = global;

const DEFAULT_CONFIG = {
  php: {
    memory_limit: "1G",
    max_execution_time: 10000,
    upload_max_filesize: "10G",
    post_max_size: "10G",
    display_errors: "On",
  },
  mysql: {
    port: process.platform === "win32" ? 3306 : 3307,
    root_password: process.platform === "win32" ? "root" : "",
    max_connections: 151,
    innodb_buffer_pool_size: "512M",
  },
  nginx: { base_port: 8000 },
  phpmyadmin: { port: 8080 },
  app: { start_on_boot: false, minimize_to_tray: true },
};

async function migrateLinuxDatabasePort(projectsDir, fromPort = 3306, toPort = 3307) {
  if (!(await fs.pathExists(projectsDir))) return;
  const entries = await fs.readdir(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, entry.name);
    const projectFile = path.join(projectDir, "project.json");
    if (!(await fs.pathExists(projectFile))) continue;

    try {
      const project = await fs.readJson(projectFile);
      if (!project.dbPort || Number(project.dbPort) === fromPort) {
        project.dbPort = toPort;
      }
      // Windows workspaces use root/root. ShieldPress's isolated Ubuntu
      // instance intentionally uses passwordless local root authentication.
      if ((project.dbUser || "root") === "root" && project.dbPassword === "root") {
        project.dbPassword = "";
      }
      await fs.writeJson(projectFile, project, { spaces: 2 });

      const wpConfig = path.join(projectDir, "www", "wp-config.php");
      if (await fs.pathExists(wpConfig)) {
        let content = await fs.readFile(wpConfig, "utf8");
        content = content.replace(
          /(define\(\s*['"]DB_HOST['"]\s*,\s*['"])(?:127\.0\.0\.1|localhost)(?::3306)?(['"]\s*\))/i,
          `$1127.0.0.1:${toPort}$2`,
        );
        if (/define\(\s*['"]DB_USER['"]\s*,\s*['"]root['"]\s*\)/i.test(content)) {
          content = content.replace(
            /(define\(\s*['"]DB_PASSWORD['"]\s*,\s*['"])root(['"]\s*\))/i,
            "$1$2",
          );
        }
        await fs.writeFile(wpConfig, content);
      }

      const envFile = path.join(projectDir, "www", ".env");
      if (await fs.pathExists(envFile)) {
        let content = await fs.readFile(envFile, "utf8");
        content = content.replace(/^WP_DB_PORT=3306\s*$/m, `WP_DB_PORT=${toPort}`);
        if (/^DB_CONNECTION=mysql\s*$/m.test(content)) {
          content = content.replace(/^DB_PORT=3306\s*$/m, `DB_PORT=${toPort}`);
          if (/^DB_USERNAME=root\s*$/m.test(content)) {
            content = content.replace(/^DB_PASSWORD=root\s*$/m, "DB_PASSWORD=");
          }
        }
        await fs.writeFile(envFile, content);
      }
    } catch (error) {
      log.warn(`Database port migration skipped for ${entry.name}: ${error.message}`);
    }
  }
}

async function ensureLinuxPhpRuntime() {
  if (process.platform !== "linux") return;
  const {
    APP_VERSION,
    BUNDLED_PHP_BASE_DIR,
    PHP_BASE_DIR,
  } = global.CONST;
  if (!BUNDLED_PHP_BASE_DIR || !PHP_BASE_DIR) return;
  if (path.resolve(BUNDLED_PHP_BASE_DIR) === path.resolve(PHP_BASE_DIR)) return;
  if (!(await fs.pathExists(BUNDLED_PHP_BASE_DIR))) return;

  await fs.ensureDir(PHP_BASE_DIR);
  const versions = await fs.readdir(BUNDLED_PHP_BASE_DIR, { withFileTypes: true });
  for (const version of versions) {
    if (!version.isDirectory()) continue;
    const sourceDir = path.join(BUNDLED_PHP_BASE_DIR, version.name);
    const targetDir = path.join(PHP_BASE_DIR, version.name);
    const marker = path.join(targetDir, ".shieldpress-bundle-version");
    const expectedMarker = String(APP_VERSION || "development");
    const currentMarker = await fs.readFile(marker, "utf8").catch(() => "");
    const executableName = process.platform === "win32" ? "php-cgi.exe" : "php-cgi";
    if (
      currentMarker.trim() === expectedMarker &&
      await fs.pathExists(path.join(targetDir, executableName))
    ) {
      continue;
    }

    await fs.ensureDir(targetDir);
    const files = await fs.readdir(sourceDir, { withFileTypes: true });
    for (const file of files) {
      const source = path.join(sourceDir, file.name);
      const target = path.join(targetDir, file.name);
      // Preserve settings edited through ShieldPress across application updates.
      if (file.name === "php.ini" && await fs.pathExists(target)) continue;
      await fs.copy(source, target, { overwrite: true });
    }
    await fs.writeFile(marker, expectedMarker + "\n", "utf8");
    log.ok(`PHP ${version.name} runtime synced to writable workspace`);
  }
}

async function init() {
  DEFAULT_CONFIG.projects_dir = global.CONST.PROJECTS_DIR;
  const {
    DATA_DIR,
    PROJECTS_DIR,
    BACKUPS_DIR,
    LOGS_DIR,
    MYSQL_DATA,
    NGINX_DIR,
    CONFIG_FILE,
  } = global.CONST;

  // 1. Tạo dirs trước tiên
  for (const d of [DATA_DIR, PROJECTS_DIR, BACKUPS_DIR, LOGS_DIR, MYSQL_DATA])
    await fs.ensureDir(d);
  await ensureLinuxPhpRuntime();
  if (process.platform !== "win32") await ensureLinuxNginxLayout();
  await fs.ensureDir(path.join(NGINX_DIR, "logs"));
  await fs.ensureDir(path.join(NGINX_DIR, "conf", "servers"));

  // Tạo nginx temp dirs
  const nginxTemp = path.join(global.CONST.NGINX_DIR, "temp");
  for (const d of [
    nginxTemp,
    path.join(nginxTemp, "client_body_temp"),
    path.join(nginxTemp, "proxy_temp"),
    path.join(nginxTemp, "fastcgi_temp"),
    path.join(nginxTemp, "uwsgi_temp"),
    path.join(nginxTemp, "scgi_temp"),
  ])
    await fs.ensureDir(d);

  // 2. Tạo config trước khi làm gì khác
  let currentConfig = {};
  if (await fs.pathExists(CONFIG_FILE)) currentConfig = await fs.readJson(CONFIG_FILE);
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...currentConfig,
    php: { ...DEFAULT_CONFIG.php, ...(currentConfig.php || {}) },
    mysql: { ...DEFAULT_CONFIG.mysql, ...(currentConfig.mysql || {}) },
    nginx: { ...DEFAULT_CONFIG.nginx, ...(currentConfig.nginx || {}) },
    phpmyadmin: { ...DEFAULT_CONFIG.phpmyadmin, ...(currentConfig.phpmyadmin || {}) },
    app: { ...DEFAULT_CONFIG.app, ...(currentConfig.app || {}) },
    projects_dir: PROJECTS_DIR,
  };
  // Ubuntu's packaged MariaDB commonly owns :3306 and root uses socket auth.
  // Always move Windows workspaces to ShieldPress's isolated Linux instance.
  const migrateLinuxPort = process.platform === "linux" && currentConfig.mysql?.port === 3306;
  if (migrateLinuxPort) {
    mergedConfig.mysql.port = 3307;
  }
  if (process.platform === "linux" && mergedConfig.mysql.root_password === "root") {
    mergedConfig.mysql.root_password = "";
  }
  await fs.writeJson(CONFIG_FILE, mergedConfig, { spaces: 2 });
  if (process.platform === "linux") {
    await migrateLinuxDatabasePort(PROJECTS_DIR, 3306, 3307);
  }
  if (migrateLinuxPort) {
    log.ok("Migrated project database connections from :3306 to :3307");
  }

  log.info(`BIN_DIR = ${global.CONST.BIN_DIR}`);
  log.info(`PHP     = ${global.CONST.PHP_DIR}`);
  log.info(`MariaDB = ${global.CONST.MARIADB_DIR}`);
  log.info(`Nginx   = ${global.CONST.NGINX_DIR}`);

  // 3. Migration: move bin/php/ flat structure -> bin/php/8.3/ versioned structure
  if (process.platform === "win32") {
    try {
      await migratePhpDir();
    } catch (e) {
      log.warn("PHP migration: " + e.message);
    }
  }

  // 4. Apply php.ini + phpMyAdmin sau khi đã có config
  if (process.platform === "win32") {
    try {
      await applyPhpIni();
    } catch (e) {
      log.warn("php.ini: " + e.message);
    }
  }
  try {
    await setupPhpMyAdmin();
  } catch (e) {
    log.warn("phpMyAdmin: " + e.message);
  }
  try {
    await syncProjectNginxConfigs();
  } catch (e) {
    log.warn("nginx project sync: " + e.message);
  }

  // 4. Reset project status
  if (fs.existsSync(PROJECTS_DIR)) {
    const dirs = await fs.readdir(PROJECTS_DIR);
    for (const d of dirs) {
      const cf = path.join(PROJECTS_DIR, d, "project.json");
      if (!(await fs.pathExists(cf))) continue;
      try {
        const c = await fs.readJson(cf);
        if (c.status === "running") {
          c.status = "stopped";
          await fs.writeJson(cf, c, { spaces: 2 });
        }
      } catch (error) {
        log.warn(`Skipping invalid project config ${cf}: ${error.message}`);
      }
    }
    log.info("Reset all project status to stopped");
  }
}

async function ensureLinuxNginxLayout() {
  const { NGINX_DIR } = global.CONST;
  const confDir = path.join(NGINX_DIR, "conf");
  const serversDir = path.join(confDir, "servers");
  await fs.ensureDir(serversDir);
  await fs.ensureDir(path.join(NGINX_DIR, "logs"));

  const mimeCandidates = ["/etc/nginx/mime.types", "/usr/local/etc/nginx/mime.types"];
  const mimeFile = mimeCandidates.find((file) => fs.existsSync(file));
  const master = path.join(confDir, "nginx.conf");
  const includeMime = mimeFile ? `include ${mimeFile};` : "default_type application/octet-stream;";
  // Nginx resolves include paths relative to the main configuration file,
  // not consistently from -p across Linux distributions. Use an absolute
  // quoted glob so every per-project server is actually loaded.
  const serverGlob = path.join(serversDir, "*.conf").replace(/\\/g, "/");
  const content = `worker_processes 1;\npid logs/nginx.pid;\nerror_log logs/error.log;\nevents { worker_connections 1024; }\nhttp {\n    ${includeMime}\n    sendfile on;\n    include "${serverGlob}";\n}\n`;
  await fs.writeFile(master, content, "utf8");
  await fs.writeFile(path.join(NGINX_DIR, "fastcgi_params"),
    "fastcgi_param QUERY_STRING $query_string;\n" +
    "fastcgi_param REQUEST_METHOD $request_method;\n" +
    "fastcgi_param CONTENT_TYPE $content_type;\n" +
    "fastcgi_param CONTENT_LENGTH $content_length;\n" +
    "fastcgi_param SCRIPT_NAME $fastcgi_script_name;\n" +
    "fastcgi_param REQUEST_URI $request_uri;\n" +
    "fastcgi_param DOCUMENT_URI $document_uri;\n" +
    "fastcgi_param DOCUMENT_ROOT $document_root;\n" +
    "fastcgi_param SERVER_PROTOCOL $server_protocol;\n" +
    "fastcgi_param REQUEST_SCHEME $scheme;\n" +
    "fastcgi_param HTTPS $https if_not_empty;\n" +
    "fastcgi_param GATEWAY_INTERFACE CGI/1.1;\n" +
    "fastcgi_param SERVER_SOFTWARE nginx/$nginx_version;\n" +
    "fastcgi_param REMOTE_ADDR $remote_addr;\n" +
    "fastcgi_param REMOTE_PORT $remote_port;\n" +
    "fastcgi_param SERVER_ADDR $server_addr;\n" +
    "fastcgi_param SERVER_PORT $server_port;\n" +
    "fastcgi_param SERVER_NAME $server_name;\n",
    "utf8");
}

async function syncProjectNginxConfigs() {
  const { PROJECTS_DIR, NGINX_DIR } = global.CONST;
  const { buildNginxConf, sanitizeProjectSsl } = require("./projects");
  const serversDir = path.join(NGINX_DIR, "conf", "servers");
  const keep = new Set(["_phpmyadmin.conf"]);

  if (!(await fs.pathExists(PROJECTS_DIR))) return;

  const dirs = await fs.readdir(PROJECTS_DIR);
  for (const d of dirs) {
    const cfgPath = path.join(PROJECTS_DIR, d, "project.json");
    if (!(await fs.pathExists(cfgPath))) continue;

    let proj = await fs.readJson(cfgPath);
    proj = await sanitizeProjectSsl(proj, cfgPath);
    if (!proj.domain) continue;

    const confName = `${proj.domain}.conf`;
    keep.add(confName);
    await fs.writeFile(
      path.join(serversDir, confName),
      buildNginxConf(proj),
    );
  }

  const existing = await fs.readdir(serversDir);
  for (const name of existing) {
    if (!name.endsWith(".conf")) continue;
    if (keep.has(name)) continue;
    await fs.remove(path.join(serversDir, name));
  }

  log.ok("Nginx project configs synced");
}

// Auto-migrate flat bin/php/ -> versioned bin/php/8.3/
async function migratePhpDir() {
  const { PHP_BASE_DIR } = global.CONST;
  if (!fs.existsSync(PHP_BASE_DIR)) return;

  const phpCgiFlat = path.join(PHP_BASE_DIR, "php-cgi.exe");
  if (!fs.existsSync(phpCgiFlat)) return; // Already migrated or empty

  const targetDir = path.join(PHP_BASE_DIR, "8.3");
  await fs.ensureDir(targetDir);

  // Move all files/folders from bin/php/ into bin/php/8.3/
  const entries = await fs.readdir(PHP_BASE_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "8.3" || entry.name === "8.4") continue; // skip version dirs
    const src = path.join(PHP_BASE_DIR, entry.name);
    const dst = path.join(targetDir, entry.name);
    try {
      await fs.move(src, dst, { overwrite: false });
    } catch (e) {
      // Skip if already exists in target
    }
  }
  log.ok("PHP directory migrated to versioned structure (bin/php/8.3/)");
}

async function applyPhpIni() {
  const { PHP_BASE_DIR, getPhpDir } = global.CONST;
  let versions = [];
  if (fs.existsSync(PHP_BASE_DIR)) {
    const entries = await fs.readdir(PHP_BASE_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const cgi = path.join(PHP_BASE_DIR, e.name, "php-cgi.exe");
        if (fs.existsSync(cgi)) versions.push(e.name);
      }
    }
  }
  if (versions.length === 0) return;

  for (const ver of versions) {
    const phpIni = path.join(getPhpDir(ver), "php.ini");
    if (!fs.existsSync(phpIni)) continue;
    let ini = await fs.readFile(phpIni, "utf8");
    let changed = false;

    // Strip UTF-8 BOM — PHP parser treats it as syntax error when it appears mid-file
    if (ini.charCodeAt(0) === 0xFEFF || ini.startsWith("\uFEFF")) {
      ini = ini.slice(1);
      changed = true;
      log.ok(`php.ini: stripped UTF-8 BOM for PHP ${ver}`);
    }
    // Also strip BOM that may appear before [PHP] section (pushed there by prior edits)
    ini = ini.replace(/\uFEFF/g, "");

    const extDir = path.join(getPhpDir(ver), "ext").replace(/\\/g, "/");
    if (fs.existsSync(path.join(getPhpDir(ver), "ext"))) {
      // Remove ALL extension_dir lines then add one correct one
      const cleaned = ini.replace(/^\s*;?\s*extension_dir\s*=.*/gm, "");
      ini = `extension_dir = "${extDir}"\n` + cleaned;
      changed = true;
      log.ok(`php.ini extension_dir fixed for PHP ${ver}`);
    }

    // Deduplicate: find extensions that appear more than once and keep only one
    const extLines = {};
    ini = ini.replace(/^(\s*;?\s*extension\s*=\s*(php_)?(\w+)(\.dll)?\s*)$/gm, (match, full, _php, name) => {
      const isCommented = /^\s*;/.test(full);
      if (!extLines[name]) {
        extLines[name] = { count: 0, enabled: false };
      }
      extLines[name].count++;
      if (!isCommented) extLines[name].enabled = true;
      // Keep the first uncommented occurrence, or first commented if none enabled
      if (extLines[name].count === 1) return match;
      if (!isCommented && extLines[name].count === 2 && !extLines[name].enabled) return match;
      return ""; // remove duplicate
    });
    if (Object.values(extLines).some((e) => e.count > 1)) {
      changed = true;
      log.ok(`php.ini: removed duplicate extension lines for PHP ${ver}`);
    }

    // Ensure essential extensions are enabled (fix mysqli missing error)
    const essentials = ["mysqli", "pdo_mysql", "curl", "openssl", "mbstring", "fileinfo", "gd", "zip"];
    for (const ext of essentials) {
      const dllPath = path.join(getPhpDir(ver), "ext", `php_${ext}.dll`);
      if (!fs.existsSync(dllPath)) continue;

      const enabledRe = new RegExp(`^\\s*extension\\s*=\\s*(php_)?${ext}(\\.dll)?\\s*$`, "m");
      if (enabledRe.test(ini)) continue; // already enabled

      // Check if there's a commented line to uncomment
      const commentedRe = new RegExp(`^\\s*;\\s*extension\\s*=\\s*(php_)?${ext}(\\.dll)?\\s*$`, "m");
      if (commentedRe.test(ini)) {
        ini = ini.replace(commentedRe, `extension=${ext}`);
      } else {
        ini += `\nextension=${ext}\n`;
      }
      changed = true;
      log.ok(`php.ini: enabled ${ext} for PHP ${ver}`);
    }

    // Clean up excessive blank lines
    ini = ini.replace(/\n{3,}/g, "\n\n");

    if (changed) {
      await fs.writeFile(phpIni, ini, "utf8");
    }
  }
}

async function patchNginxConf() {
  const { NGINX_DIR } = global.CONST;
  const confPath = path.join(NGINX_DIR, "conf", "nginx.conf");
  if (!fs.existsSync(confPath)) return;

  let content = await fs.readFile(confPath, "utf8");
  const tempPath = path.join(NGINX_DIR, "temp").replace(/\\/g, "/");

  // Thêm temp paths nếu chưa có
  if (!content.includes("client_body_temp_path")) {
    content = content.replace(
      /http\s*\{/,
      `http {\n    client_body_temp_path  ${tempPath}/client_body_temp;\n    proxy_temp_path        ${tempPath}/proxy_temp;\n    fastcgi_temp_path      ${tempPath}/fastcgi_temp;\n`,
    );
    await fs.writeFile(confPath, content);
    log.ok("nginx.conf patched with temp paths");
  }
}

async function setupPhpMyAdmin() {
  const { NGINX_DIR, PMA_DIR, CONFIG_FILE } = global.CONST;
  if (!fs.existsSync(PMA_DIR)) {
    log.warn("phpMyAdmin not found");
    return;
  }

  const svc = require("./services");
  const versions = await svc.getAvailablePhpVersions();
  const defVer = versions.length > 0 ? versions[0] : "8.3";
  const fastcgiPort = svc.getPhpPort(defVer);

  const cfg = await fs.readJson(CONFIG_FILE);
  const port = cfg.phpmyadmin?.port || 8080;
  const mysqlPort = cfg.mysql?.port || (process.platform === "win32" ? 3306 : 3307);
  const fastcgiParams = path.join(NGINX_DIR, "fastcgi_params").replace(/\\/g, "/");
  // Escape space bằng cách dùng forward slash và escape
  const pmaRoot = PMA_DIR.replace(/\\/g, "/");
  const pmaPath = pmaRoot.includes(" ") ? `"${pmaRoot}"` : pmaRoot;

  // Update phpMyAdmin config.inc.php with correct MySQL port
  const pmaConfigPath = path.join(PMA_DIR, "config.inc.php");
  if (fs.existsSync(pmaConfigPath)) {
    const pmaConf = `<?php
$cfg['blowfish_secret'] = 'BmVy5EgowWCp8tTcvNrSsqjJiXPlxLeZ';
$i = 0;
$i++;
$cfg['Servers'][$i]['auth_type']      = 'cookie';
$cfg['Servers'][$i]['host']           = '127.0.0.1';
$cfg['Servers'][$i]['port']           = ${mysqlPort};
$cfg['Servers'][$i]['compress']       = false;
$cfg['Servers'][$i]['AllowNoPassword'] = true;
$cfg['UploadDir'] = '';
$cfg['SaveDir']   = '';
`;
    try {
      await fs.writeFile(pmaConfigPath, pmaConf);
      log.ok(`phpMyAdmin config.inc.php → MySQL port ${mysqlPort}`);
    } catch (error) {
      log.warn(`phpMyAdmin config is read-only: ${error.message}`);
    }
  }

  const confPath = path.join(NGINX_DIR, "conf", "servers", "_phpmyadmin.conf");
  const conf = `server {
    listen 127.0.0.1:${port};
    server_name localhost;
    root ${pmaPath};
    index index.php;
    access_log logs/phpmyadmin.access.log;
    error_log logs/phpmyadmin.error.log warn;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        fastcgi_pass 127.0.0.1:${fastcgiPort};
        include "${fastcgiParams}";
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
`;
  await fs.writeFile(confPath, conf);
  log.ok(`phpMyAdmin config → port ${port}`);
}

module.exports = {
  init,
  setupPhpMyAdmin,
  migrateLinuxDatabasePort,
  ensureLinuxPhpRuntime,
};
