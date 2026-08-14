// src/main/laravel.js
const fs = require("fs-extra");
const path = require("path");
const { exec } = require("child_process");
const https = require("https");
const log = require("./logger");
const platform = require("./platform");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emit(msg, onProgress) {
  log.info("[Laravel] " + msg);
  if (onProgress) onProgress(msg);
}

/** Follow HTTP redirects and download to dest */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (e) => { fs.remove(dest).finally(() => reject(e)); });
    });
    req.on("error", (e) => { fs.remove(dest).catch(() => {}); reject(e); });
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

/** Run a shell command, stream stdout/stderr to onProgress.
 *  Pass env to override process.env (used to set PHPRC). */
function runCmd(cmd, cwd, onProgress, env) {
  return new Promise((resolve, reject) => {
    const opts = {
      cwd,
      maxBuffer: 100 * 1024 * 1024,
      env: env || process.env,
    };
    const proc = exec(cmd, opts, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message).trim().slice(-2000)));
      } else {
        resolve(stdout);
      }
    });
    if (onProgress) {
      proc.stdout?.on("data", (d) => onProgress(d.toString().trimEnd()));
      proc.stderr?.on("data", (d) => onProgress(d.toString().trimEnd()));
    }
  });
}

/** Return the php.exe path for a given version */
function phpExe(version) {
  return platform.executable("php", version);
}

/** Return a PHP command prefix that forces the correct bundled php.ini and
 *  extension_dir, regardless of what the system php.ini says.
 *
 *  Priority (highest to lowest):
 *    1. CLI -d flags  ← always wins
 *    2. CLI -c <ini>  ← loads bundled php.ini
 *    3. PHPRC env     ← fallback (kept for safety)
 */
function phpCmd(exePath) {
  const phpDir = path.dirname(exePath);
  const phpIni = path.join(phpDir, "php.ini");
  const extDir = path.join(phpDir, "ext");

  const iniFlag = fs.existsSync(phpIni) ? `-c "${phpIni}"` : "";
  const extFlag = fs.existsSync(extDir) ? `-d "extension_dir=${extDir}"` : "";

  return `"${exePath}" ${iniFlag} ${extFlag}`.replace(/\s+/g, " ").trim();
}

/** Env with PHPRC set as an extra safety net (PHPRC alone was not enough). */
function phpEnv(exePath) {
  return {
    ...process.env,
    PHPRC: path.dirname(exePath),
    PHP_INI_SCAN_DIR: "",
  };
}

/** Ensure composer.phar exists in BIN_DIR, download if missing */
async function ensureComposer(onProgress) {
  const { BIN_DIR, DATA_DIR } = global.CONST;
  const toolsDir = platform.isWindows ? BIN_DIR : path.join(DATA_DIR, "tools");
  const phar = path.join(toolsDir, "composer.phar");
  if (fs.existsSync(phar)) return phar;

  emit("Downloading Composer...", onProgress);
  await fs.ensureDir(toolsDir);
  await downloadFile("https://getcomposer.org/composer-stable.phar", phar);
  emit("Composer downloaded.", onProgress);
  return phar;
}

// ─── installLaravel ───────────────────────────────────────────────────────────

async function installLaravel({ id, phpVersion }, onProgress) {
  const { PROJECTS_DIR, CONFIG_FILE } = global.CONST;
  const projDir = path.join(PROJECTS_DIR, id);
  const wwwDir  = path.join(projDir, "www");
  const cfgPath = path.join(projDir, "project.json");

  if (!(await fs.pathExists(cfgPath))) {
    return { success: false, message: "Project not found" };
  }

  const proj = await fs.readJson(cfgPath);

  if (proj.laravelInstalled) {
    return { success: false, message: "Laravel already installed in this project." };
  }

  const php = phpExe(proj.phpVersion || phpVersion || "8.3");
  if (!php) {
    return { success: false, message: `PHP executable not found: ${php}` };
  }

  // Read app config for MariaDB port
  let dbPort = proj.dbPort || (process.platform === "win32" ? 3306 : 3307);
  let dbPassword = platform.isWindows ? (proj.dbPassword || "root") : "";
  try {
    const cfg = await fs.readJson(CONFIG_FILE);
    dbPort = cfg.mysql?.port || (process.platform === "win32" ? 3306 : 3307);
    dbPassword = platform.isWindows
      ? (cfg.mysql?.root_password || dbPassword)
      : (proj.dbUser && proj.dbUser !== "root" ? (proj.dbPassword || "") : "");
  } catch (_) {}

  emit("Starting Laravel installation...", onProgress);

  const tmpDir = path.join(projDir, "_laravel_tmp");

  try {
    // 1. Ensure composer
    const composerPhar = await ensureComposer(onProgress);

    // 2. Create project in tmpDir (must be empty/non-existing)
    await fs.remove(tmpDir);
    await fs.ensureDir(tmpDir);

    const env = phpEnv(php);

    emit("Running composer create-project (may take 1–3 minutes)...", onProgress);
    await runCmd(
      `${phpCmd(php)} "${composerPhar}" create-project laravel/laravel . --prefer-dist --no-interaction --no-ansi`,
      tmpDir,
      onProgress,
      env,
    );

    // 3. Move into www/, overwriting placeholder
    emit("Copying Laravel files to project...", onProgress);
    await fs.copy(tmpDir, wwwDir, { overwrite: true });
    await fs.remove(tmpDir);

    // 4. Configure .env
    emit("Configuring .env...", onProgress);
    const envExample = path.join(wwwDir, ".env.example");
    const envFile    = path.join(wwwDir, ".env");

    if (await fs.pathExists(envExample)) {
      let env = await fs.readFile(envExample, "utf8");
      env = env
        .replace(/APP_NAME=.*/,      `APP_NAME="${proj.name}"`)
        .replace(/APP_ENV=.*/,       `APP_ENV=local`)
        .replace(/APP_DEBUG=.*/,     `APP_DEBUG=true`)
        .replace(/APP_URL=.*/,       `APP_URL=http://${proj.domain}:${proj.port}`)
        .replace(/DB_CONNECTION=.*/, `DB_CONNECTION=mysql`)
        .replace(/DB_HOST=.*/,       `DB_HOST=127.0.0.1`)
        .replace(/DB_PORT=.*/,       `DB_PORT=${dbPort}`)
        .replace(/DB_DATABASE=.*/,   `DB_DATABASE=${proj.dbName}`)
        .replace(/DB_USERNAME=.*/,   `DB_USERNAME=${proj.dbUser || "root"}`)
        .replace(/DB_PASSWORD=.*/,   `DB_PASSWORD=${dbPassword}`);
      await fs.writeFile(envFile, env, "utf8");
    }

    // 5. Generate app key
    emit("Generating application key...", onProgress);
    await runCmd(`${phpCmd(php)} artisan key:generate --no-interaction --ansi`, wwwDir, onProgress, env);

    // 6. Run migrations
    emit("Running database migrations...", onProgress);
    await runCmd(`${phpCmd(php)} artisan migrate --force --no-interaction`, wwwDir, onProgress, env);

    // 7. Mark as installed
    proj.laravelInstalled = true;
    proj.dbPort = dbPort;
    proj.dbPassword = dbPassword;
    await fs.writeJson(cfgPath, proj, { spaces: 2 });

    emit("Laravel installed successfully!", onProgress);
    return { success: true };

  } catch (e) {
    // Cleanup partial tmp
    await fs.remove(tmpDir).catch(() => {});
    log.err("Laravel install failed: " + e.message);
    return { success: false, message: e.message };
  }
}

// ─── runArtisan ──────────────────────────────────────────────────────────────

async function runArtisan({ id, cmd }) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found" };

  const proj = await fs.readJson(cfgPath);
  const wwwDir = path.join(PROJECTS_DIR, id, "www");
  const php    = phpExe(proj.phpVersion || "8.3");

  if (!fs.existsSync(php)) return { success: false, message: `PHP not found: ${php}` };
  if (!fs.existsSync(path.join(wwwDir, "artisan"))) {
    return { success: false, message: "artisan not found — is Laravel installed?" };
  }

  try {
    const output = await runCmd(
      `${phpCmd(php)} artisan ${cmd} --no-interaction`,
      wwwDir,
      null,
      phpEnv(php),
    );
    return { success: true, output: output.trim() };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

module.exports = { installLaravel, runArtisan };
