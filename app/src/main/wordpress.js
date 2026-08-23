// src/main/wordpress.js
const { exec, spawn } = require("child_process");
const https  = require("https");
const crypto = require("crypto");
const fs     = require("fs-extra");
const path   = require("path");
const os     = require("os");
const log    = require("./logger");
const db     = require("./database");
const platform = require("./platform");

function wpSalt() {
  return crypto.randomBytes(48).toString("base64").replace(/'/g, "\\'");
}

async function installWordPress(data) {
  const { id, siteTitle, adminUser, adminPassword, adminEmail, force } = data;
  const { PROJECTS_DIR, CONFIG_FILE, NGINX_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found" };
  // Guard: prevent accidental reinstall unless force=true
  const wpConfigCheck = path.join(PROJECTS_DIR, id, "www", "wp-config.php");
  if (!force && (await fs.pathExists(wpConfigCheck))) {
    return { success: false, message: "WordPress is already installed. Use force reinstall to overwrite.", alreadyInstalled: true };
  }
  const proj = await fs.readJson(cfgPath);
  const wwwDir = path.join(PROJECTS_DIR, id, "www");
  const cfg    = await fs.readJson(CONFIG_FILE);
  const dbPort = cfg.mysql?.port || proj.dbPort || (process.platform === "win32" ? 3306 : 3307);
  const dbPassword = platform.isWindows
    ? (cfg.mysql?.root_password !== undefined
      ? cfg.mysql.root_password
      : (proj.dbPassword === undefined ? "root" : proj.dbPassword))
    : (proj.dbUser && proj.dbUser !== "root" ? (proj.dbPassword || "") : "");
  const salts = {
    auth: wpSalt(),
    secureAuth: wpSalt(),
    loggedIn: wpSalt(),
    nonce: wpSalt(),
    authSalt: wpSalt(),
    secureAuthSalt: wpSalt(),
    loggedInSalt: wpSalt(),
    nonceSalt: wpSalt(),
  };

  log.info(`Installing WordPress for ${proj.name}...`);

  // Download
  const wpZip = path.join(os.tmpdir(), "wordpress.zip");
  log.info("Downloading WordPress...");
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(wpZip);
      https.get("https://wordpress.org/latest.zip", (res) => {
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    });
    log.ok("WordPress downloaded");
  } catch (e) { return { success: false, message: "Download failed: " + e.message }; }

  // Extract
  const extract    = require("extract-zip");
  const tmpExtract = path.join(os.tmpdir(), "wp-extract");
  await fs.ensureDir(tmpExtract);
  await extract(wpZip, { dir: tmpExtract });
  await fs.copy(path.join(tmpExtract, "wordpress"), wwwDir, { overwrite: true });
  await fs.remove(tmpExtract);
  await fs.remove(wpZip);
  log.ok("WordPress extracted");

  // wp-config.php
  const wpConfig = `<?php
define('DB_NAME',     '${proj.dbName}');
define('DB_USER',     'root');
define('DB_PASSWORD', '${dbPassword}');
define('DB_HOST',     '127.0.0.1:${dbPort}');
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  '');

define('AUTH_KEY',         '${salts.auth}');
define('SECURE_AUTH_KEY',  '${salts.secureAuth}');
define('LOGGED_IN_KEY',    '${salts.loggedIn}');
define('NONCE_KEY',        '${salts.nonce}');
define('AUTH_SALT',        '${salts.authSalt}');
define('SECURE_AUTH_SALT', '${salts.secureAuthSalt}');
define('LOGGED_IN_SALT',   '${salts.loggedInSalt}');
define('NONCE_SALT',       '${salts.nonceSalt}');

define('WP_DEBUG',     false);
define('WP_DEBUG_LOG', false);

$table_prefix = 'wp_';
define('WP_HOME',    'http://${proj.domain}:${proj.port}');
define('WP_SITEURL', 'http://${proj.domain}:${proj.port}');

if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`;
  await fs.writeFile(path.join(wwwDir, "wp-config.php"), wpConfig);
  log.ok("wp-config.php created");

  // Update project metadata
  proj.projectType       = "wordpress";
  proj.wordpressInstalled = true;
  proj.dbPort            = dbPort;
  proj.dbPassword        = dbPassword;
  await fs.writeJson(cfgPath, proj, { spaces: 2 });

  // Refresh nginx config
  const { buildNginxConf } = require("./projects");
  const nginxConfPath = path.join(NGINX_DIR, "conf", "servers", `${proj.domain}.conf`);
  await fs.writeFile(nginxConfPath, buildNginxConf(proj));

  return {
    success: true,
    message: `WordPress installed. Visit http://${proj.domain}:${proj.port}/wp-admin/install.php`,
    installUrl: `http://${proj.domain}:${proj.port}/wp-admin/install.php`,
  };
}

async function wpGetUsers({ id }) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found", users: [] };
  const proj = await fs.readJson(cfgPath);
  try {
    const out = await db.mysqlExec(
      `SELECT ID, user_login, display_name FROM \`${proj.dbName}\`.wp_users ORDER BY ID LIMIT 50`
    );
    const lines = out.trim().split("\n").slice(1).filter(Boolean);
    const users = lines.map((line) => {
      const [uid, login, name] = line.split("\t");
      return { id: uid?.trim(), login: login?.trim(), name: name?.trim() };
    }).filter((u) => u.id);
    return { success: true, users };
  } catch (e) {
    return { success: false, message: String(e), users: [] };
  }
}

async function wpAutoLogin({ id, userId }) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found" };
  const proj = await fs.readJson(cfgPath);
  const www = path.join(PROJECTS_DIR, id, "www");
  if (!fs.existsSync(path.join(www, "wp-load.php")))
    return { success: false, message: "WordPress not installed in this project" };
  const uid = parseInt(userId, 10) || 1;
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tmpFile = `__al_${token}.php`;
  const php = `<?php
require_once __DIR__ . '/wp-load.php';
$user = get_user_by('ID', ${uid});
if (!$user) { die('User not found'); }
wp_clear_auth_cookie();
wp_set_auth_cookie($user->ID, true);
@unlink(__FILE__);
wp_redirect(admin_url());
exit;
`;
  await fs.writeFile(path.join(www, tmpFile), php, "utf8");
  return { success: true, url: `http://${proj.domain}:${proj.port}/${tmpFile}` };
}

async function wpResetPassword({ id, userId, newPassword }) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found" };
  const proj = await fs.readJson(cfgPath);
  const uid = parseInt(userId, 10) || 1;
  try {
    await db.mysqlExec(
      `UPDATE \`${proj.dbName}\`.wp_users SET user_pass=MD5('${newPassword}') WHERE ID=${uid}`
    );
    log.ok(`WordPress password reset for user ID=${uid}`);
    return { success: true };
  } catch (e) { return { success: false, message: String(e) }; }
}

async function wpToggleDebug({ id, enable }) {
  const wpConfig = path.join(global.CONST.PROJECTS_DIR, id, "www", "wp-config.php");
  if (!fs.existsSync(wpConfig)) return { success: false, message: "wp-config.php not found" };
  let content = await fs.readFile(wpConfig, "utf8");
  content = content
    .replace(/define\('WP_DEBUG',\s*(true|false)\)/, `define('WP_DEBUG', ${enable})`)
    .replace(/define\('WP_DEBUG_LOG',\s*(true|false)\)/, `define('WP_DEBUG_LOG', ${enable})`);
  await fs.writeFile(wpConfig, content);
  log.ok(`WordPress debug ${enable ? "ON" : "OFF"}`);
  return { success: true };
}

async function getWpDebugState({ id }) {
  const wpConfig = path.join(global.CONST.PROJECTS_DIR, id, "www", "wp-config.php");
  if (!fs.existsSync(wpConfig)) return { success: false, enabled: false };
  const content = await fs.readFile(wpConfig, "utf8");
  const match = content.match(/define\('WP_DEBUG',\s*(true|false)\)/);
  return { success: true, enabled: match ? match[1] === "true" : false };
}

async function getWpDebugLog(id) {
  const logFile = path.join(global.CONST.PROJECTS_DIR, id, "www", "wp-content", "debug.log");
  if (!fs.existsSync(logFile)) return { success: false, filePath: logFile };
  return { success: true, filePath: logFile };
}

async function downloadWpCli() {
  const { WP_CLI } = global.CONST;
  await fs.ensureDir(path.dirname(WP_CLI));
  log.info("Downloading WP-CLI...");
  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(WP_CLI);
      https.get("https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar", (res) => {
        if (res.statusCode !== 200) { reject(new Error("HTTP " + res.statusCode)); return; }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    });
    log.ok("WP-CLI downloaded to " + WP_CLI);
    return { success: true };
  } catch (e) {
    return { success: false, message: "Download failed: " + e.message };
  }
}

// WP-CLI runner
function runWpCli({ id, command }) {
  const { WP_CLI, PROJECTS_DIR, getPhpDir } = global.CONST;
  const www = path.join(PROJECTS_DIR, id, "www");

  return new Promise(async (resolve) => {
    const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
    if (!(await fs.pathExists(cfgPath))) return resolve({ success: false, output: "Project not found" });
    const proj = await fs.readJson(cfgPath);
    const php = platform.executable("php", proj.phpVersion || "8.3");

    if (!fs.existsSync(WP_CLI)) return resolve({ success: false, output: "WP-CLI not found at " + WP_CLI });
    if (!php) return resolve({ success: false, output: "PHP CLI not found" });

    const args = command.trim().split(/\s+/);
    const proc = spawn(php, [WP_CLI, "--path=" + www, "--allow-root", ...args], {
      cwd: www, stdio: "pipe",
    });

    let out = "", err = "";
    proc.stdout.on("data", d => out += d.toString());
    proc.stderr.on("data", d => err += d.toString());
    proc.on("close", code => {
      resolve({ success: code === 0, output: out || err, exitCode: code });
    });
  });
}

module.exports = { installWordPress, wpGetUsers, wpAutoLogin, wpResetPassword, wpToggleDebug, getWpDebugState, getWpDebugLog, downloadWpCli, runWpCli };
