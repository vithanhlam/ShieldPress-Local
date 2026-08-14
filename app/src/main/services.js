// src/main/services.js
const { spawn, exec } = require("child_process");
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

// Track intentional stops to suppress auto-restart
const phpStopping = new Set();
let phpWatchdog = null;

// ─── Port helpers ─────────────────────────────────────────────────────────────
function isPortOpen(port) {
  return new Promise((resolve) => {
    const s = net.createConnection(port, "127.0.0.1");
    s.setTimeout(600);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function waitPort(port, secs = 25) {
  for (let i = 0; i < secs; i++) {
    if (await isPortOpen(port)) return true;
    await delay(1000);
    log.info(`Waiting port ${port}... (${i + 1}/${secs})`);
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
    try {
      kill(proc.pid, "SIGKILL", () => resolve());
    } catch (e) {
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
    await new Promise((r) => exec("taskkill /F /IM nginx.exe /T 2>nul", () => r()));
    await delay(800);
  }

  const masterConf = path.join(NGINX_DIR, "conf", "nginx.conf");
  const configTest = await new Promise((resolve) => {
    const test = spawn(nginxExe, ["-t", "-p", NGINX_DIR, "-c", masterConf]);
    let stdout = "", stderr = "";
    test.stdout?.on("data", (data) => { stdout += data; });
    test.stderr?.on("data", (data) => { stderr += data; });
    test.on("error", (err) => resolve({ ok: false, message: err.message }));
    test.on("close", (code) => {
        resolve({
          ok: code === 0,
          message: (stderr || stdout || `Nginx exited ${code}`).trim(),
        });
    });
  });
  if (!configTest.ok) {
    log.err("Nginx config test failed:\n" + configTest.message);
    global.STATE.isNginxRunning = false;
    return { success: false, message: configTest.message || "Nginx config test failed" };
  }

  nginxProc = spawn(nginxExe, ["-p", NGINX_DIR, "-c", masterConf, "-g", "daemon off;"], {
    cwd: NGINX_DIR,
    stdio: "pipe",
    detached: false,
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
      const proc = spawn(nginxExe, ["-s", "quit", "-p", NGINX_DIR, "-c", masterConf], { stdio: "ignore" });
      proc.on("error", resolve);
      proc.on("close", resolve);
    });
  }
  await delay(600);
  await killProc(nginxProc);
  if (platform.isWindows) {
    await new Promise((r) => exec("taskkill /F /IM nginx.exe /T 2>nul", () => r()));
  }
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
  const run = (args) => new Promise((resolve) => {
    const proc = spawn(nginxExe, args);
    let stderr = "";
    proc.stderr?.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => resolve({ ok: false, message: error.message }));
    proc.on("close", (code) => resolve({ ok: code === 0, message: stderr.trim() }));
  });
  const test = await run(["-t", "-p", NGINX_DIR, "-c", "conf/nginx.conf"]);
  if (!test.ok) return { success: false, message: test.message };
  const masterConf = path.join(NGINX_DIR, "conf", "nginx.conf");
  const reload = await run(["-s", "reload", "-p", NGINX_DIR, "-c", masterConf]);
  if (!reload.ok) return restartNginx();
  log.ok("Nginx reloaded");
  return { success: true };
}

// ─── PHP version helpers ──────────────────────────────────────────────────────
function getPhpPort(version) {
  // "8.3" => 9083, "8.4" => 9084, "8.2" => 9082
  const parts = String(version || "8.3").split(".");
  const minor = parseInt(parts[1] || "3", 10);
  return 9080 + minor;
}

async function getAvailablePhpVersions() {
  if (platform.isLinux) {
    const versions = new Set();
    for (const phpCgi of platform.phpCgiExecutables()) {
      const result = require("child_process").spawnSync(phpCgi, ["-v"], { encoding: "utf8" });
      const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/PHP\s+(\d+\.\d+)/i);
      if (result.status === 0 && match) versions.add(match[1]);
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
      if (fs.existsSync(cgiExe)) versions.push(e.name);
    }
    return versions.sort().length > 0 ? versions.sort() : ["8.3"];
  } catch {
    return ["8.3"];
  }
}

// ─── PHP-CGI (multi-version) ──────────────────────────────────────────────────
async function startPhpCgi(version) {
  version = version || "8.3";
  const { getPhpDir } = global.CONST;
  const phpDir = getPhpDir(version);
  const port = getPhpPort(version);

  // Already running this version
  if (phpProcs[version] && phpProcs[version].length > 0) return { success: true };

  const phpCgiExe = platform.executable("phpCgi", version);
  const phpIni = path.join(phpDir, "php.ini");

  if (!phpCgiExe) {
    log.err(`PHP-CGI not found for PHP ${version}`);
    return { success: false, message: "PHP-CGI not found. Install php-cgi and required PHP extensions." };
  }

  // Check if already alive on that port
  if (await isPortOpen(port)) {
    phpProcs[version] = [{ pid: null, port }];
    global.STATE.isPhpRunning = true;
    log.info(`PHP-CGI ${version} already on :${port}`);
    return { success: true };
  }

  log.info(`Starting PHP-CGI ${version} on :${port}...`);
  const args = ["-b", `127.0.0.1:${port}`];
  if (fs.existsSync(phpIni)) args.push("-c", phpIni);
  args.push(
    "-d",
    "cgi.force_redirect=0",
    "-d",
    "cgi.fix_pathinfo=1",
  );

  // Override extension_dir so PHP loads extensions from the bundled dir,
  // not from a stale path that may be hardcoded in php.ini (e.g. C:\php\ext)
  const extDir = path.join(phpDir, "ext");
  if (fs.existsSync(extDir)) {
    args.push("-d", `extension_dir=${extDir.replace(/\\/g, "/")}`);
  }

  // Windows PHP-CGI supports multiple listeners; Linux uses one listener and
  // manages children internally, so extra processes only exit with code 255.
  const workers = [];
  const workerCount = platform.isWindows ? 4 : 1;
  for (let i = 0; i < workerCount; i++) {
    const w = spawn(phpCgiExe, args, { cwd: fs.existsSync(phpDir) ? phpDir : undefined, stdio: "ignore" });
    workers.push(w);

    w.on("error", (err) => log.err(`PHP ${version} spawn error: ` + err.message));
    w.on("close", (code) => {
      if (phpStopping.has(version)) return; // intentional stop, skip restart
      log.warn(`PHP-CGI ${version} worker exited code=${code}, checking port...`);
      // Wait briefly — other workers may still serve requests
      setTimeout(async () => {
        if (phpStopping.has(version)) return;
        const alive = await isPortOpen(port);
        if (!alive) {
          log.warn(`PHP-CGI ${version} port :${port} dead — auto-restarting...`);
          global.STATE.mainWindow?.webContents?.send(
            "log-line",
            `[Auto-restart] PHP-CGI ${version} crashed, restarting...`,
          );
          delete phpProcs[version];
          global.STATE.isPhpRunning = Object.keys(phpProcs).length > 0;
          await startPhpCgi(version);
        }
      }, 2000);
    });
  }

  const ready = await waitPort(port, 12);
  if (ready) {
    phpProcs[version] = workers;
    global.STATE.isPhpRunning = true;
    log.ok(`PHP-CGI ${version} running on :${port}`);
    startPhpWatchdog(); // ensure watchdog is running
    return { success: true };
  }
  log.err(`PHP-CGI ${version} failed to start`);
  return { success: false, message: `PHP-CGI ${version} timeout` };
}

function startPhpWatchdog() {
  if (phpWatchdog) return; // already running
  phpWatchdog = setInterval(async () => {
    for (const version of Object.keys(phpProcs)) {
      if (phpStopping.has(version)) continue;
      const port = getPhpPort(version);
      const alive = await isPortOpen(port);
      if (!alive) {
        log.warn(`[Watchdog] PHP-CGI ${version} not responding — restarting...`);
        global.STATE.mainWindow?.webContents?.send(
          "log-line",
          `[Watchdog] PHP-CGI ${version} unresponsive, auto-restarting...`,
        );
        delete phpProcs[version];
        global.STATE.isPhpRunning = Object.keys(phpProcs).length > 0;
        await startPhpCgi(version);
      }
    }
  }, 20000); // check every 20s
}

async function stopPhpCgi(version) {
  if (version) {
    phpStopping.add(version);
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
      if (platform.isWindows) await new Promise((r) => exec("taskkill /F /IM php-cgi.exe /T 2>nul", () => r()));
      await delay(300);
    }
    phpStopping.delete(version);
  } else {
    // Mark all versions as intentionally stopping
    for (const v of Object.keys(phpProcs)) phpStopping.add(v);
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
    if (platform.isWindows) await new Promise((r) => exec("taskkill /F /IM php-cgi.exe /T 2>nul", () => r()));
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
  return new Promise((resolve) => {
    const proc = spawn(client, ["-h", "127.0.0.1", "-P", String(port), "-u", "root", "-e", sql]);
    let stderr = "";
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => resolve({ ok: false, message: error.message }));
    proc.on("close", (code) => resolve({ ok: code === 0, message: stderr.trim() }));
  });
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
      env: platform.isLinux ? { ...process.env, MYSQLD_BOOTSTRAP: mysqld } : process.env,
    });
    proc.stderr.on("data", (d) => log.info("init: " + d.toString().trim()));
    proc.on("close", (code) => {
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
    await new Promise((r) => exec("taskkill /F /IM mysqld.exe /T 2>nul", () => r()));
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
        const proc = spawn(mysqladmin, ["-h", "127.0.0.1", "-P", String(port), "-u", "root", ...auth, "shutdown"], { stdio: "ignore" });
        proc.on("error", resolve);
        proc.on("close", resolve);
      });
    }
    await delay(2000);
    await killProc(mariadbProc);
    mariadbProc = null;
  }
  if (platform.isWindows) await new Promise((r) => exec("taskkill /F /IM mysqld.exe /T 2>nul", () => r()));
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
  if (platform.isWindows) await new Promise((r) => exec("taskkill /F /IM mysqld.exe /T 2>nul & taskkill /F /IM nginx.exe /T 2>nul & taskkill /F /IM php-cgi.exe /T 2>nul & taskkill /F /IM redis-server.exe /T 2>nul", () => r()));
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
  if (platform.isWindows) await new Promise((r) => exec("taskkill /F /IM redis-server.exe /T 2>nul", () => r()));
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
