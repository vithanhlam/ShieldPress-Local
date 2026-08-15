// src/main/services.js
const { spawn, exec } = require("child_process");

const WIN_SPAWN = { windowsHide: true };

function windowsTaskkill(imageName) {
  return new Promise((resolve) => {
    exec(`taskkill /F /IM ${imageName} /T`, { windowsHide: true, timeout: 8000 }, () => resolve());
  });
}

function spawnResult(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { windowsHide: true, stdio: "pipe", ...(opts.spawn || {}) });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      try { kill(proc.pid, "SIGKILL", () => {}); } catch {}
      resolve({ ok: false, code: -1, stdout, stderr, message: (stderr || stdout || "timed out").trim() });
    }, timeoutMs);
    proc.stdout?.on("data", (data) => { stdout += data; });
    proc.stderr?.on("data", (data) => { stderr += data; });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, message: err.message, stdout, stderr });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        message: (stderr || stdout || `exited ${code}`).trim(),
      });
    });
  });
}
const net = require("net");
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");
const kill = require("tree-kill");
const platform = require("./platform");

let mariadbProc = null;
let phpProcs = {};    // { "8.3": [proc, proc, ...], "8.4": [...] }
let nginxProc = null;
let redisProc = null;
let nginxStartPromise = null;
const phpStartPromises = {};
const phpRestartAttempts = {};
const phpStartGeneration = {};
const PHP_MAX_RESTARTS = 3;

// Track intentional stops to suppress auto-restart
const phpStopping = new Set();
let phpWatchdog = null;

// ─── Port helpers ─────────────────────────────────────────────────────────────
function isPortOpen(port) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.createConnection({ port, host: "127.0.0.1" });
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(400);
    s.on("connect", () => finish(true));
    s.on("error", () => finish(false));
    s.on("timeout", () => finish(false));
  });
}

async function waitPort(port, secs = 25) {
  for (let i = 0; i < secs; i++) {
    if (await isPortOpen(port)) return true;
    await delay(1000);
    if (i === 0 || i === secs - 1 || (i + 1) % 3 === 0) {
      log.info(`Waiting port ${port}... (${i + 1}/${secs})`);
    }
  }
  return false;
}

// Find a port NOT already used AND not assigned to any existing project
async function getFreePort(start = 8000) {
  const fs2 = require("fs-extra");
  const { PROJECTS_DIR } = global.CONST;
  const usedPorts = new Set();

  // Collect ports from all project.json files
  if (fs2.existsSync(PROJECTS_DIR)) {
    const dirs = await fs2.readdir(PROJECTS_DIR);
    for (const d of dirs) {
      const cf = path.join(PROJECTS_DIR, d, "project.json");
      if (await fs2.pathExists(cf)) {
        const c = await fs2.readJson(cf);
        if (c.port) usedPorts.add(c.port);
      }
    }
  }

  let port = start;
  while (usedPorts.has(port) || (await isPortOpen(port))) port++;
  return port;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killProc(proc) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) return resolve();
    const timer = setTimeout(resolve, 8000);
    try {
      kill(proc.pid, "SIGKILL", () => {
        clearTimeout(timer);
        resolve();
      });
    } catch (e) {
      clearTimeout(timer);
      resolve();
    }
  });
}

// ─── Nginx ───────────────────────────────────────────────────────────────────
async function startNginxUnlocked() {
  const { NGINX_DIR } = global.CONST;
  const nginxExe = platform.executable("nginx");
  if (!nginxExe) {
    log.err("Nginx not found");
    return { success: false, message: "Nginx not found. Install the nginx package." };
  }

  if (platform.isWindows) {
    await windowsTaskkill("nginx.exe");
    await delay(800);
  }

  const masterConf = path.join(NGINX_DIR, "conf", "nginx.conf");
  const configTest = await spawnResult(nginxExe, ["-t", "-p", NGINX_DIR, "-c", masterConf], { timeoutMs: 10000 });
  if (!configTest.ok) {
    log.err("Nginx config test failed:\n" + configTest.message);
    global.STATE.isNginxRunning = false;
    return { success: false, message: configTest.message || "Nginx config test failed" };
  }

  nginxProc = spawn(nginxExe, ["-p", NGINX_DIR, "-c", masterConf, "-g", "daemon off;"], {
    cwd: NGINX_DIR,
    stdio: "pipe",
    detached: false,
    ...WIN_SPAWN,
  });
  const currentNginxProc = nginxProc;
  let startupError = "";
  nginxProc.stderr?.on("data", (d) => {
    const message = d.toString().trim();
    if (message) {
      startupError += message + "\n";
      log.info("nginx: " + message);
    }
  });
  nginxProc.on("close", (code) => {
    log.warn(`Nginx exited code=${code}`);
    if (nginxProc === currentNginxProc) {
      global.STATE.isNginxRunning = false;
      nginxProc = null;
    }
  });

  await delay(1200);
  if (currentNginxProc.exitCode !== null || nginxProc !== currentNginxProc) {
    global.STATE.isNginxRunning = false;
    return {
      success: false,
      message: startupError.trim() || `Nginx exited code=${currentNginxProc.exitCode}`,
    };
  }
  global.STATE.isNginxRunning = true;
  log.ok("Nginx started");
  return { success: true };
}

async function startNginx() {
  if (nginxStartPromise) return nginxStartPromise;
  nginxStartPromise = startNginxUnlocked();
  try {
    return await nginxStartPromise;
  } finally {
    nginxStartPromise = null;
  }
}

async function stopNginx() {
  const { NGINX_DIR } = global.CONST;
  const nginxExe = platform.executable("nginx");
  if (nginxExe && nginxProc) {
    const masterConf = path.join(NGINX_DIR, "conf", "nginx.conf");
    await new Promise((resolve) => {
      const proc = spawn(nginxExe, ["-s", "quit", "-p", NGINX_DIR, "-c", masterConf], { stdio: "ignore", ...WIN_SPAWN });
      proc.on("error", resolve);
      proc.on("close", resolve);
    });
  }
  await delay(600);
  await killProc(nginxProc);
  if (platform.isWindows) await windowsTaskkill("nginx.exe");
  nginxProc = null;
  global.STATE.isNginxRunning = false;
  log.info("Nginx stopped");
  return { success: true };
}

async function restartNginx() {
  await stopNginx();
  await delay(500);
  return startNginx();
}

async function reloadNginx() {
  const { NGINX_DIR } = global.CONST;
  const nginxExe = platform.executable("nginx");
  if (!nginxExe) return { success: false, message: "Nginx not found" };
  const run = (args) => spawnResult(nginxExe, args, { timeoutMs: 10000 });
  const test = await run(["-t", "-p", NGINX_DIR, "-c", "conf/nginx.conf"]);
  if (!test.ok) return { success: false, message: test.message };
  const masterConf = path.join(NGINX_DIR, "conf", "nginx.conf");
  const reload = await run(["-s", "reload", "-p", NGINX_DIR, "-c", masterConf]);
  if (!reload.ok) return restartNginx();
  log.ok("Nginx reloaded");
  return { success: true };
}

function quotePhpIniValue(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (/[\s;"]/.test(normalized)) return `"${normalized.replace(/"/g, '\\"')}"`;
  return normalized;
}

function phpDllNotFound(code) {
  return code === 3221225781 || code === 0xC0000135;
}

function buildPhpSpawnEnv(phpDir) {
  const env = { ...process.env };
  const libDir = path.join(phpDir, "lib");
  if (platform.isLinux && fs.existsSync(libDir)) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
  }
  return env;
}

function probePhpCgi(phpCgiExe, phpDir, extraArgs = []) {
  const result = require("child_process").spawnSync(phpCgiExe, extraArgs, {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    cwd: fs.existsSync(phpDir) ? phpDir : undefined,
    env: buildPhpSpawnEnv(phpDir),
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const ok = !result.error && result.status === 0 && /PHP\s+\d+\.\d+/i.test(output);
  let message = output;
  if (phpDllNotFound(result.status)) {
    message = "Missing Visual C++ Redistributable (2015-2022 x64). PHP 8.4/8.5 need VC++ 2022; PHP 8.3 needs VC++ 2019/2022.";
  } else if (result.error) {
    message = result.error.message;
  } else if (!ok && !message) {
    message = `php-cgi exited ${result.status}`;
  }
  return { ok, output, status: result.status, message };
}

async function ensurePhpIni(phpDir) {
  const phpIni = path.join(phpDir, "php.ini");
  if (await fs.pathExists(phpIni)) return phpIni;
  for (const name of ["php.ini-production", "php.ini-development"]) {
    const src = path.join(phpDir, name);
    if (await fs.pathExists(src)) {
      await fs.copy(src, phpIni);
      log.ok(`Created php.ini from ${name}`);
      return phpIni;
    }
  }
  return phpIni;
}

function getPhpPort(version) {
  // "8.3" => 9083, "8.4" => 9084, "8.5" => 9085
  const parts = String(version || "8.3").split(".");
  const minor = parseInt(parts[1] || "3", 10);
  return 9080 + minor;
}

async function getAvailablePhpVersions() {
  if (platform.isLinux) {
    const versions = new Set();
    for (const phpCgi of platform.phpCgiExecutables()) {
      const phpDir = path.dirname(phpCgi);
      const result = probePhpCgi(phpCgi, phpDir, ["-v"]);
      const match = result.output.match(/PHP\s+(\d+\.\d+)/i);
      if (result.ok && match) versions.add(match[1]);
      else if (!result.ok) log.warn(`PHP probe failed for ${phpCgi}: ${result.message}`);
    }
    return [...versions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  const { PHP_BASE_DIR } = global.CONST;
  if (!fs.existsSync(PHP_BASE_DIR)) return ["8.3"];
  try {
    const entries = await fs.readdir(PHP_BASE_DIR, { withFileTypes: true });
    const versions = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cgiExe = path.join(PHP_BASE_DIR, e.name, "php-cgi.exe");
      if (!fs.existsSync(cgiExe)) continue;
      const probe = probePhpCgi(cgiExe, path.join(PHP_BASE_DIR, e.name), ["-v"]);
      if (!probe.ok) {
        log.warn(`PHP ${e.name} binary is present but php-cgi -v failed: ${probe.message}`);
      }
      versions.push(e.name);
    }
    return versions.sort().length > 0 ? versions.sort() : ["8.3"];
  } catch {
    return ["8.3"];
  }
}

// ─── PHP-CGI (multi-version) ──────────────────────────────────────────────────
async function startPhpCgi(version) {
  version = version || "8.3";
  if (phpStartPromises[version]) return phpStartPromises[version];
  phpStartPromises[version] = startPhpCgiUnlocked(version);
  try {
    return await phpStartPromises[version];
  } finally {
    delete phpStartPromises[version];
  }
}

async function startPhpCgiUnlocked(version) {
  const { getPhpDir } = global.CONST;
  const phpDir = getPhpDir(version);
  const port = getPhpPort(version);

  if (phpProcs[version] && phpProcs[version].length > 0) return { success: true };

  const phpCgiExe = platform.executable("phpCgi", version);
  if (!phpCgiExe) {
    log.err(`PHP-CGI not found for PHP ${version}`);
    return { success: false, message: `PHP-CGI ${version} not found.` };
  }

  if (await isPortOpen(port)) {
    phpProcs[version] = [{ pid: null, port }];
    global.STATE.isPhpRunning = true;
    phpRestartAttempts[version] = 0;
    log.info(`PHP-CGI ${version} already on :${port}`);
    return { success: true };
  }

  const phpIni = await ensurePhpIni(phpDir);
  const binaryProbe = probePhpCgi(phpCgiExe, phpDir, ["-v", "-n"]);
  if (!binaryProbe.ok) {
    log.err(`PHP ${version} binary probe failed: ${binaryProbe.message}`);
    return { success: false, message: `PHP ${version} cannot start: ${binaryProbe.message}` };
  }
  log.ok(`PHP ${version} binary OK (${binaryProbe.output.split("\n")[0]})`);

  let skipIni = false;
  if (fs.existsSync(phpIni)) {
    const iniProbe = probePhpCgi(phpCgiExe, phpDir, ["-v", "-c", phpIni]);
    if (!iniProbe.ok) {
      skipIni = true;
      log.warn(`PHP ${version} php.ini probe failed, starting without it: ${iniProbe.message}`);
    }
  }

  log.info(`Starting PHP-CGI ${version} on :${port}...`);
  const args = ["-b", `127.0.0.1:${port}`];
  if (!skipIni && fs.existsSync(phpIni)) args.push("-c", phpIni);
  else args.push("-n");
  args.push("-d", "cgi.force_redirect=0", "-d", "cgi.fix_pathinfo=1");

  const extDir = path.join(phpDir, "ext");
  if (fs.existsSync(extDir)) {
    args.push("-d", `extension_dir=${quotePhpIniValue(extDir)}`);
  }

  phpStopping.delete(version);
  const generation = (phpStartGeneration[version] = (phpStartGeneration[version] || 0) + 1);
  let crashLog = "";
  let processExited = null;
  const env = buildPhpSpawnEnv(phpDir);

  const w = spawn(phpCgiExe, args, {
    cwd: fs.existsSync(phpDir) ? phpDir : undefined,
    stdio: ["ignore", "ignore", "pipe"],
    env,
    ...WIN_SPAWN,
  });
  const workers = [w];

  w.stderr?.on("data", (data) => {
    const text = data.toString().trim();
    if (!text) return;
    crashLog += text + "\n";
    log.warn(`PHP ${version}: ${text}`);
  });
  w.on("error", (err) => log.err(`PHP ${version} spawn error: ` + err.message));
  w.on("close", (code) => {
    processExited = code;
    if (phpStopping.has(version)) return;
    if (phpStartGeneration[version] !== generation) return;
    if (phpStartPromises[version]) return;
    log.warn(`PHP-CGI ${version} exited code=${code}`);
    delete phpProcs[version];
    global.STATE.isPhpRunning = Object.keys(phpProcs).length > 0;
    if (phpDllNotFound(code)) {
      log.err(`PHP-CGI ${version} missing Visual C++ runtime — not retrying`);
      phpRestartAttempts[version] = PHP_MAX_RESTARTS + 1;
      return;
    }
    const attempts = (phpRestartAttempts[version] || 0) + 1;
    phpRestartAttempts[version] = attempts;
    if (attempts > PHP_MAX_RESTARTS) {
      log.err(`PHP-CGI ${version} stopped auto-restart after ${PHP_MAX_RESTARTS} failures`);
      return;
    }
    const delayMs = 2000 * attempts;
    log.warn(`PHP-CGI ${version} will retry in ${delayMs}ms (${attempts}/${PHP_MAX_RESTARTS})`);
    setTimeout(() => {
      if (phpStopping.has(version) || phpStartGeneration[version] !== generation) return;
      startPhpCgi(version);
    }, delayMs);
  });

  let ready = false;
  for (let i = 0; i < 16; i++) {
    if (await isPortOpen(port)) {
      ready = true;
      break;
    }
    if (processExited !== null) break;
    await delay(500);
    if (i === 0 || i === 15 || (i + 1) % 4 === 0) {
      log.info(`Waiting PHP ${version} on :${port}... (${i + 1}/16)`);
    }
  }
  if (ready) {
    phpProcs[version] = workers;
    global.STATE.isPhpRunning = true;
    phpRestartAttempts[version] = 0;
    log.ok(`PHP-CGI ${version} running on :${port}`);
    startPhpWatchdog();
    return { success: true };
  }

  phpStopping.add(version);
  phpStartGeneration[version] += 1;
  for (const worker of workers) await killProc(worker);
  phpStopping.delete(version);
  const fatal = phpDllNotFound(processExited)
    ? "Missing Visual C++ Redistributable (2015-2022 x64). Install it, then retry PHP 8.3/8.4/8.5."
    : (crashLog.trim() || binaryProbe.message || `did not bind 127.0.0.1:${port}`);
  log.err(`PHP-CGI ${version} failed to start: ${fatal}`);
  return { success: false, message: `PHP-CGI ${version} failed: ${fatal}` };
}

function startPhpWatchdog() {
  if (phpWatchdog) return;
  phpWatchdog = setInterval(async () => {
    for (const version of Object.keys(phpProcs)) {
      if (phpStopping.has(version) || phpStartPromises[version]) continue;
      if ((phpRestartAttempts[version] || 0) > PHP_MAX_RESTARTS) continue;
      const port = getPhpPort(version);
      if (await isPortOpen(port)) continue;
      log.warn(`[Watchdog] PHP-CGI ${version} not responding — restarting...`);
      global.STATE.mainWindow?.webContents?.send(
        "log-line",
        `[Watchdog] PHP-CGI ${version} unresponsive, auto-restarting...`,
      );
      delete phpProcs[version];
      global.STATE.isPhpRunning = Object.keys(phpProcs).length > 0;
      await startPhpCgi(version);
    }
  }, 20000);
}

async function stopPhpCgi(version) {
  if (version) {
    phpStopping.add(version);
    phpStartGeneration[version] = (phpStartGeneration[version] || 0) + 1;
    phpRestartAttempts[version] = 0;
    const workers = phpProcs[version];
    if (Array.isArray(workers)) {
      for (const w of workers) {
        if (w && w.pid) await killProc(w);
      }
    } else if (workers && workers.pid) {
      await killProc(workers);
    }
    delete phpProcs[version];
    // Kill any stray php-cgi still on this version's port
    await delay(300);
    const port = getPhpPort(version);
    if (await isPortOpen(port)) {
      // Port still busy — force kill all php-cgi and retry
      if (platform.isWindows) await windowsTaskkill("php-cgi.exe");
      await delay(300);
    }
    phpStopping.delete(version);
  } else {
    // Mark all versions as intentionally stopping
    for (const v of Object.keys(phpProcs)) {
      phpStopping.add(v);
      phpStartGeneration[v] = (phpStartGeneration[v] || 0) + 1;
    }
    Object.keys(phpRestartAttempts).forEach((v) => { phpRestartAttempts[v] = 0; });
    for (const [, workers] of Object.entries(phpProcs)) {
      if (Array.isArray(workers)) {
        for (const w of workers) {
          if (w && w.pid) await killProc(w);
        }
      } else if (workers && workers.pid) {
        await killProc(workers);
      }
    }
    phpProcs = {};
    if (platform.isWindows) await windowsTaskkill("php-cgi.exe");
    phpStopping.clear();
    // Stop watchdog when all PHP is down
    if (phpWatchdog) { clearInterval(phpWatchdog); phpWatchdog = null; }
  }
  global.STATE.isPhpRunning = Object.keys(phpProcs).length > 0;
  log.info(version ? `PHP-CGI ${version} stopped` : "All PHP-CGI stopped");
  return { success: true };
}

async function restartPhpCgi(version) {
  if (version) {
    await stopPhpCgi(version);
    await delay(500);
    return startPhpCgi(version);
  }
  // Restart all running versions
  const versions = Object.keys(phpProcs);
  for (const v of versions) await stopPhpCgi(v);
  phpProcs = {};
  await delay(500);
  for (const v of versions) await startPhpCgi(v);
  return { success: true };
}

// ─── MariaDB ─────────────────────────────────────────────────────────────────
async function runnableMariaDbServer() {
  const systemServer = platform.executable("mysqld");
  if (!systemServer || !platform.isLinux) return systemServer;

  // AppArmor confines /usr/sbin/mariadbd and blocks user-owned datadirs.
  // A workspace-local copy uses the same system libraries without inheriting
  // that path-based profile.
  const runtimeServer = path.join(global.CONST.MARIADB_DIR, "mariadbd");
  await fs.ensureDir(global.CONST.MARIADB_DIR);
  let refresh = !(await fs.pathExists(runtimeServer));
  if (!refresh) {
    const [sourceStat, runtimeStat] = await Promise.all([fs.stat(systemServer), fs.stat(runtimeServer)]);
    refresh = sourceStat.size !== runtimeStat.size || sourceStat.mtimeMs > runtimeStat.mtimeMs;
  }
  if (refresh) await fs.copy(systemServer, runtimeServer, { overwrite: true });
  await fs.chmod(runtimeServer, 0o755);
  return runtimeServer;
}

function runMariaDbClient(port, sql) {
  const client = platform.executable("mysql");
  if (!client) return Promise.resolve({ ok: false, message: "MariaDB client not found" });
    return spawnResult(client, ["-h", "127.0.0.1", "-P", String(port), "-u", "root", "-e", sql], { timeoutMs: 15000 });
}

async function repairLinuxRootAuthentication(mysqld, serverArgs, port) {
  log.warn("Repairing Windows MariaDB root authentication for Ubuntu...");
  await killProc(mariadbProc);
  mariadbProc = null;
  global.STATE.isDBRunning = false;
  await delay(1000);

  const repairProc = spawn(mysqld, [...serverArgs, "--skip-grant-tables"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    ...WIN_SPAWN,
  });
  let repairError = "";
  repairProc.stderr.on("data", (data) => { repairError += data; });
  if (!(await waitPort(port, 20))) {
    await killProc(repairProc);
    return { success: false, message: repairError.trim() || "MariaDB repair mode did not start" };
  }

  const sql =
    "UPDATE mysql.global_priv " +
    "SET Priv=JSON_REMOVE(JSON_SET(Priv,'$.plugin','mysql_native_password','$.authentication_string',''),'$.auth_or') " +
    "WHERE User='root'; FLUSH PRIVILEGES;";
  const repaired = await runMariaDbClient(port, sql);
  await killProc(repairProc);
  await delay(1000);
  if (!repaired.ok) return { success: false, message: repaired.message };
  log.ok("MariaDB root authentication migrated for Ubuntu");
  return { success: true };
}

async function initMariaDB() {
  const { MARIADB_DIR, MYSQL_DATA } = global.CONST;
  const mysqld = await runnableMariaDbServer();
  const mysqlPriv = path.join(MYSQL_DATA, "mysql");
  if (fs.existsSync(mysqlPriv)) {
    log.info("MariaDB already initialized");
    return true;
  }

  log.info("Initializing MariaDB...");
  const installDb = platform.isWindows
    ? path.join(MARIADB_DIR, "bin", "mysql_install_db.exe")
    : platform.findCommand(["mariadb-install-db", "mysql_install_db"]);
  return new Promise((resolve) => {
    const args = installDb
      ? [installDb, `--datadir=${MYSQL_DATA}`, ...(platform.isWindows ? ["--password=root"] : ["--auth-root-authentication-method=normal"])]
      : [mysqld, "--initialize-insecure", `--datadir=${MYSQL_DATA}`];
    const proc = spawn(args[0], args.slice(1), {
      stdio: "pipe",
      windowsHide: true,
      env: platform.isLinux ? { ...process.env, MYSQLD_BOOTSTRAP: mysqld } : process.env,
    });
    const timer = setTimeout(() => {
      try { kill(proc.pid, "SIGKILL", () => {}); } catch {}
      log.err("MariaDB init timed out");
      resolve(fs.existsSync(mysqlPriv));
    }, 60000);
    proc.stderr.on("data", (d) => log.info("init: " + d.toString().trim()));
    proc.on("error", (error) => {
      clearTimeout(timer);
      log.err("MariaDB init error: " + error.message);
      resolve(false);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 || fs.existsSync(mysqlPriv);
      if (ok) log.ok("MariaDB initialized");
      else log.err(`MariaDB init failed code=${code}`);
      resolve(ok);
    });
  });
}

async function getMariaDBPort() {
  try {
    const c = await fs.readJson(global.CONST.CONFIG_FILE);
    return c.mysql?.port || (platform.isWindows ? 3306 : 3307);
  } catch {
    return platform.isWindows ? 3306 : 3307;
  }
}

async function startMariaDB() {
  const { MARIADB_DIR, MYSQL_DATA, LOGS_DIR } = global.CONST;
  if (global.STATE.isDBRunning)
    return { success: true, message: "Already running" };

  const mysqld = await runnableMariaDbServer();
  if (!mysqld) return { success: false, message: "MariaDB server not found. Install mariadb-server." };

  const port = await getMariaDBPort();
  if (await isPortOpen(port)) {
    global.STATE.isDBRunning = true;
    return { success: true, message: `Already on ${port}` };
  }

  // Kill any stray mysqld.exe that may have a port bound but not accepting connections
  if (platform.isWindows) {
    await windowsTaskkill("mysqld.exe");
    await delay(800);
  }

  // Ensure data dir exists before init (safety net in case setup.init() was skipped)
  await fs.ensureDir(MYSQL_DATA);

  if (!(await initMariaDB())) return { success: false, message: "Init failed" };

  await fs.ensureDir(MARIADB_DIR);
  const myIni = path.join(MARIADB_DIR, platform.isWindows ? "my.ini" : "my.cnf");
  const dataFwd = MYSQL_DATA.replace(/\\/g, "/");

  if (!(await fs.pathExists(myIni))) {
    // First run: create a default my.ini
    await fs.writeFile(
      myIni,
      `[mysqld]\n` +
        `port=${port}\n` +
        `bind-address=127.0.0.1\n` +
        `datadir=${dataFwd}\n` +
        (platform.isLinux ? `socket=${path.join(MARIADB_DIR, "mariadb.sock")}\npid-file=${path.join(MARIADB_DIR, "mariadb.pid")}\n` : "") +
        `character-set-server=utf8mb4\n` +
        `collation-server=utf8mb4_unicode_ci\n` +
        `max_connections=151\n` +
        `innodb_buffer_pool_size=256M\n` +
        `innodb_log_file_size=64M\n` +
        `innodb_flush_log_at_trx_commit=2\n` +
        (platform.isWindows ? `query_cache_type=1\nquery_cache_size=32M\n` : "") +
        `sql_mode=\n\n` +
        `[client]\n` +
        `port=${port}\n` +
        `default-character-set=utf8mb4\n`,
    );
    log.ok("my.ini created");
  } else {
    // Preserve user edits — only sync the two dynamic values: port and datadir
    let ini = await fs.readFile(myIni, "utf8");
    const setIni = (key, val) => {
      const re = new RegExp(`^(${key}\\s*=).*`, "m");
      return ini.match(re) ? ini.replace(re, `$1${val}`) : ini;
    };
    ini = setIni("port", port);
    ini = setIni("datadir", dataFwd);
    // Older builds could leave authentication disabled. The bundled Windows
    // database is initialized with root/root, so restore normal grant checks.
    ini = ini.replace(/^\s*skip-grant-tables\s*(?:\r?\n|$)/gim, "");
    // Also sync [client] port if present
    ini = ini.replace(/(\[client\][^\[]*port\s*=)\d+/, `$1${port}`);
    await fs.writeFile(myIni, ini);
    log.ok(`my.ini synced port=${port} datadir`);
  }

  log.info(`Starting MariaDB on :${port}...`);
  const errLog = path.join(LOGS_DIR, "mariadb.log");
  // Ubuntu's MariaDB confinement can reject option files stored below a user
  // workspace. Pass the isolated-instance options directly on Linux instead.
  const serverArgs = platform.isLinux
    ? [
        "--no-defaults",
        "--console",
        `--port=${port}`,
        "--bind-address=127.0.0.1",
        `--datadir=${MYSQL_DATA}`,
        `--socket=${path.join(MARIADB_DIR, "mariadb.sock")}`,
        `--pid-file=${path.join(MARIADB_DIR, "mariadb.pid")}`,
        "--character-set-server=utf8mb4",
        "--collation-server=utf8mb4_unicode_ci",
        "--max-connections=151",
        "--innodb-buffer-pool-size=256M",
        "--innodb-log-file-size=64M",
        "--innodb-flush-log-at-trx-commit=2",
        "--sql-mode=",
      ]
    : [`--defaults-file=${myIni}`, "--console"];
  mariadbProc = spawn(mysqld, serverArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    ...WIN_SPAWN,
  });
  const currentMariaDbProc = mariadbProc;
  mariadbProc.stdout.on("data", (d) => {
    const t = d.toString().trim();
    if (t) log.info("db: " + t);
  });
  mariadbProc.stderr.on("data", (d) => {
    const t = d.toString().trim();
    if (t) {
      log.info("db: " + t);
      fs.appendFile(errLog, t + "\n").catch(() => {});
    }
  });
  mariadbProc.on("close", (code) => {
    log.warn(`MariaDB exited code=${code}`);
    if (mariadbProc === currentMariaDbProc) {
      global.STATE.isDBRunning = false;
      mariadbProc = null;
    }
  });

  const ready = await waitPort(port, 30);
  if (ready) {
    if (platform.isLinux) {
      const connection = await runMariaDbClient(port, "SELECT 1");
      if (!connection.ok) {
        const repair = await repairLinuxRootAuthentication(mysqld, serverArgs, port);
        if (!repair.success) return repair;
        return startMariaDB();
      }
    }
    global.STATE.isDBRunning = true;
    log.ok(`MariaDB running on :${port}`);
    return { success: true, message: "MariaDB started" };
  }
  return { success: false, message: `Timeout. Check ${errLog}` };
}

async function stopMariaDB() {
  const { MARIADB_DIR } = global.CONST;
  if (mariadbProc) {
    const mysqladmin = platform.executable("mysqladmin");
    if (mysqladmin) {
      const port = await getMariaDBPort();
      let mysqlConfig = {};
      try { mysqlConfig = (await fs.readJson(global.CONST.CONFIG_FILE)).mysql || {}; } catch {}
      const auth = platform.isWindows ? [`--password=${mysqlConfig.root_password || "root"}`] : [];
      await new Promise((resolve) => {
        const proc = spawn(mysqladmin, ["-h", "127.0.0.1", "-P", String(port), "-u", "root", ...auth, "shutdown"], { stdio: "ignore", ...WIN_SPAWN });
        const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(); }, 8000);
        proc.on("error", () => { clearTimeout(timer); resolve(); });
        proc.on("close", () => { clearTimeout(timer); resolve(); });
      });
    }
    await delay(2000);
    await killProc(mariadbProc);
    mariadbProc = null;
  }
  if (platform.isWindows) await windowsTaskkill("mysqld.exe");
  global.STATE.isDBRunning = false;
  log.info("MariaDB stopped");
  return { success: true };
}

async function restartMariaDB() {
  await stopMariaDB();
  await delay(1000);
  return startMariaDB();
}

async function stopAll() {
  log.info("Stopping all services...");
  const { runningProjects } = global.STATE;
  const projects = require("./projects");
  for (const id of Object.keys(runningProjects)) {
    try {
      await projects.stopProject(id);
    } catch (e) {}
  }
  await stopPhpCgi();
  await stopMariaDB();
  await stopNginx();
  await stopRedis();
  if (platform.isWindows) {
    await windowsTaskkill("mysqld.exe");
    await windowsTaskkill("nginx.exe");
    await windowsTaskkill("php-cgi.exe");
    await windowsTaskkill("redis-server.exe");
  }
  log.info("All services stopped");
}

// ─── Redis ───────────────────────────────────────────────────────────────────

async function getRedisPort() {
  try {
    const c = await fs.readJson(global.CONST.CONFIG_FILE);
    return c.redis?.port || 6379;
  } catch { return 6379; }
}

async function startRedis() {
  const { BIN_DIR } = global.CONST;
  const redisExe = platform.executable("redisServer");

  if (!redisExe) {
    return { success: false, message: "Redis server not found." };
  }

  const port = await getRedisPort();
  if (await isPortOpen(port)) {
    global.STATE.isRedisRunning = true;
    return { success: true, message: "Already running" };
  }

  log.info(`Starting Redis on :${port}...`);
  redisProc = spawn(redisExe, ["--port", `${port}`], {
    cwd: platform.isWindows ? path.join(BIN_DIR, "redis") : undefined,
    stdio: "pipe",
    detached: false,
    ...WIN_SPAWN,
  });

  redisProc.stdout?.on("data", (d) => log.info("redis: " + d.toString().trim()));
  redisProc.stderr?.on("data", (d) => log.info("redis: " + d.toString().trim()));
  redisProc.on("close", (code) => {
    log.warn(`Redis exited code=${code}`);
    global.STATE.isRedisRunning = false;
    redisProc = null;
  });

  const ready = await waitPort(port, 10);
  if (ready) {
    global.STATE.isRedisRunning = true;
    log.ok(`Redis running on :${port}`);
    return { success: true };
  }
  return { success: false, message: "Redis failed to start — check logs" };
}

async function stopRedis() {
  if (redisProc) {
    await killProc(redisProc);
    redisProc = null;
  }
  if (platform.isWindows) await windowsTaskkill("redis-server.exe");
  global.STATE.isRedisRunning = false;
  log.info("Redis stopped");
  return { success: true };
}

async function restartRedis() {
  await stopRedis();
  await delay(500);
  return startRedis();
}

async function getRedisInfo() {
  const { BIN_DIR } = global.CONST;
  const redisCli = platform.executable("redisCli");
  const port = await getRedisPort();

  if (!redisCli) {
    return { success: false, installed: false, message: "Redis not installed" };
  }
  if (!global.STATE.isRedisRunning) {
    return { success: false, installed: true, running: false, port };
  }

  return new Promise((resolve) => {
    exec(`"${redisCli}" -p ${port} info server`, (err, stdout) => {
      if (err) return resolve({ success: false, installed: true, running: true, message: err.message });
      const lines = stdout.split("\n");
      const get = (k) => {
        const l = lines.find((x) => x.startsWith(k + ":"));
        return l ? l.split(":")[1].trim() : null;
      };
      resolve({
        success: true,
        installed: true,
        running: true,
        version: get("redis_version"),
        uptime: get("uptime_in_seconds"),
        connected_clients: get("connected_clients"),
        used_memory_human: get("used_memory_human"),
        port,
      });
    });
  });
}

async function flushRedis() {
  const { BIN_DIR } = global.CONST;
  const redisCli = platform.executable("redisCli");
  const port = await getRedisPort();

  if (!redisCli) {
    return { success: false, message: "redis-cli.exe not found" };
  }

  return new Promise((resolve) => {
    exec(`"${redisCli}" -p ${port} FLUSHALL`, (err) => {
      if (err) return resolve({ success: false, message: err.message });
      resolve({ success: true, message: "All Redis cache flushed" });
    });
  });
}

async function downloadRedis(sendProgress) {
  if (platform.isLinux) {
    return { success: false, message: "Install Redis with: sudo apt install redis-server" };
  }
  const { BIN_DIR } = global.CONST;
  const redisDir = path.join(BIN_DIR, "redis");
  const redisExe = path.join(redisDir, "redis-server.exe");

  if (fs.existsSync(redisExe)) {
    return { success: true, message: "Redis already installed" };
  }

  const url = "https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip";
  const tmpZip = path.join(require("os").tmpdir(), "redis-win.zip");

  sendProgress && sendProgress("Downloading Redis for Windows (tporadowski/redis v5.0.14)...");

  try {
    // Download with redirect support
    await new Promise((resolve, reject) => {
      const follow = (u) => {
        const mod = u.startsWith("https") ? require("https") : require("http");
        mod.get(u, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return follow(res.headers.location);
          }
          const file = require("fs").createWriteStream(tmpZip);
          res.pipe(file);
          file.on("finish", () => file.close(resolve));
          res.on("error", reject);
        }).on("error", reject);
      };
      follow(url);
    });

    sendProgress && sendProgress("Extracting Redis...");
    await fs.ensureDir(redisDir);

    // Use PowerShell Expand-Archive (built into Windows 10+)
    await new Promise((resolve, reject) => {
      exec(
        `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${redisDir}' -Force"`,
        (err) => { if (err) reject(err); else resolve(); }
      );
    });

    // Flatten if files landed in a sub-folder
    const entries = await fs.readdir(redisDir, { withFileTypes: true });
    if (!fs.existsSync(redisExe) && entries.length === 1 && entries[0].isDirectory()) {
      const sub = path.join(redisDir, entries[0].name);
      const subFiles = await fs.readdir(sub);
      for (const f of subFiles) await fs.move(path.join(sub, f), path.join(redisDir, f), { overwrite: true });
      await fs.remove(sub);
    }

    await fs.remove(tmpZip).catch(() => {});

    if (!fs.existsSync(redisExe)) {
      return { success: false, message: "Extract complete but redis-server.exe not found" };
    }

    sendProgress && sendProgress("✓ Redis installed successfully!");
    log.ok("Redis installed to " + redisDir);
    return { success: true, message: "Redis installed" };
  } catch (e) {
    log.err("Redis download failed: " + e.message);
    return { success: false, message: "Download failed: " + e.message };
  }
}

module.exports = {
  isPortOpen,
  waitPort,
  getFreePort,
  delay,
  getPhpPort,
  quotePhpIniValue,
  phpDllNotFound,
  getMariaDBPort,
  getAvailablePhpVersions,
  startNginx,
  stopNginx,
  restartNginx,
  reloadNginx,
  startPhpCgi,
  stopPhpCgi,
  restartPhpCgi,
  startMariaDB,
  stopMariaDB,
  restartMariaDB,
  stopAll,
  // Redis
  getRedisPort,
  startRedis,
  stopRedis,
  restartRedis,
  getRedisInfo,
  flushRedis,
  downloadRedis,
};
