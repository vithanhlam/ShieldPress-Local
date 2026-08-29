// src/main/ipc.js
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");
const svc = require("./services");
const proj = require("./projects");
const db = require("./database");
const wp = require("./wordpress");
const bk = require("./backup");
const laravel = require("./laravel");
const ssl     = require("./ssl");
const ext     = require("./extensions");
const email   = require("./email");
const sftp    = require("./sftp");
const s3      = require("./s3");
const git     = require("./git");
const gd      = require("./google-drive");
const platform = require("./platform");
const workspace = require("./workspace");

function register(ipcMain, shell, dialog) {
  global.__shieldpressCloseRemoteSession = (sessionId) => {
    try { sftp.closeSession(sessionId); } catch {}
  };

  async function directorySize(root) {
    let total = 0;
    const entries = await fs.readdir(root, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const item = path.join(root, entry.name);
      if (entry.isDirectory()) total += await directorySize(item);
      else if (entry.isFile()) total += (await fs.stat(item)).size;
    }));
    return total;
  }
  // ── Projects ──
  ipcMain.handle("get-projects", () => proj.getProjects());
  ipcMain.handle("get-project-size", (_e, id) => proj.getProjectSize(id));
  ipcMain.handle("get-project-sizes", (_e, ids) => proj.getProjectSizes(ids));
  ipcMain.handle("create-project", (e, d) => proj.createProject(d));
  ipcMain.handle("delete-project", (e, id) => proj.deleteProject(id));
  ipcMain.handle("start-project", (e, id) => proj.startProject(id));
  ipcMain.handle("open-project-website", async (_e, id) => {
    const projects = await proj.getProjects();
    const project = projects.find((item) => item.id === id);
    if (!project) return { success: false, message: "Project not found" };

    let result = { success: true };
    if (!global.STATE.runningProjects[id]) result = await proj.startProject(id);
    if (!result.success) return result;

    const refreshed = (await proj.getProjects()).find((item) => item.id === id) || project;
    const scheme = refreshed.ssl?.enabled ? "https" : "http";
    const url = `${scheme}://${refreshed.domain}:${refreshed.port}`;
    try {
      await shell.openExternal(url);
      return { success: true, url };
    } catch (error) {
      log.err(`Open website failed (${url}): ${error.message}`);
      return { success: false, message: `Could not open the default browser: ${error.message}` };
    }
  });
  ipcMain.handle("stop-project", (e, id) => proj.stopProject(id));
  ipcMain.handle("backup-project-db", (e, id) => proj.backupProjectDb(id, (progress) => {
    e.sender.send("project-db-backup-progress", progress);
  }));
  ipcMain.handle("update-project-settings", (e, d) =>
    proj.updateProjectSettings(d),
  );
  ipcMain.handle("toggle-star", (e, id) => proj.toggleStar(id));
  ipcMain.handle("get-nginx-config", (e, id) => proj.getNginxConfig(id));
  ipcMain.handle("save-nginx-config", (e, d) => proj.saveNginxConfig(d));
  ipcMain.handle("get-project-debug", (e, id) => proj.getProjectDebugInfo(id));

  // ── Services control ──
  ipcMain.handle("start-nginx", () => svc.startNginx());
  ipcMain.handle("stop-nginx", () => svc.stopNginx());
  ipcMain.handle("restart-nginx", () => svc.restartNginx());
  ipcMain.handle("start-php", async () => {
    const versions = await svc.getAvailablePhpVersions();
    for (const v of versions) await svc.startPhpCgi(v);
    return { success: true };
  });
  ipcMain.handle("stop-php", () => svc.stopPhpCgi());
  ipcMain.handle("restart-php", (e, version) => svc.restartPhpCgi(version));
  ipcMain.handle("get-available-php", () => svc.getAvailablePhpVersions());
  ipcMain.handle("start-mariadb", () => svc.startMariaDB());
  ipcMain.handle("stop-mariadb", () => svc.stopMariaDB());
  ipcMain.handle("restart-mariadb", () => svc.restartMariaDB());

  ipcMain.handle("get-service-status", () => {
    const redisExe = platform.executable("redisServer");
    return {
      nginx: global.STATE.isNginxRunning,
      php: global.STATE.isPhpRunning,
      mariadb: global.STATE.isDBRunning,
      redis: global.STATE.isRedisRunning,
      redisInstalled: Boolean(redisExe),
      projects: Object.keys(global.STATE.runningProjects).length,
    };
  });

  ipcMain.handle("read-page", async (e, name) => {
    const pagePath = path.join(
      __dirname,
      "..",
      "..",
      "renderer",
      "pages",
      name + ".html",
    );
    if (!fs.existsSync(pagePath)) {
      log.err("Page not found: " + pagePath);
      return {
        success: false,
        content: `<div class="empty-state"><p>Not found: ${pagePath}</p></div>`,
      };
    }
    const content = await fs.readFile(pagePath, "utf8");
    return { success: true, content };
  });

  ipcMain.handle("read-plugin-page", async (e, pluginId) => {
    const pluginDir = path.join(__dirname, "..", "..", "plugins", pluginId);
    const htmlPath = path.join(pluginDir, "ui.html");
    if (!fs.existsSync(htmlPath))
      return {
        success: false,
        content: `<div class="empty-state"><p>No UI for ${pluginId}</p></div>`,
      };
    const content = await fs.readFile(htmlPath, "utf8");
    return { success: true, content };
  });

  ipcMain.handle("open-file-dialog", async (e, opts) => {
    const { mainWindow } = global.STATE;
    const result = await dialog.showOpenDialog(
      mainWindow,
      opts || { properties: ["openFile"] },
    );
    if (result.canceled) return null;
    const multi = opts?.properties?.includes("multiSelections");
    return multi ? result.filePaths : result.filePaths[0];
  });

  ipcMain.handle("set-data-dir", async (e, newPath) => {
    try {
      const electronApp = require("electron").app;
      const workspaceDir = await workspace.saveWorkspace(electronApp, newPath);
      return { success: true, path: workspaceDir };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle("restart-app", () => {
    const electronApp = require("electron").app;
    electronApp.relaunch();
    electronApp.quit();
  });

  // ── Database ──
  ipcMain.handle("create-database", (e, name) => db.createDatabase(name));
  ipcMain.handle("list-databases", () => db.listDatabases());
  ipcMain.handle("export-database", (e, d) => db.exportDatabase(d, (progress) => {
    e.sender.send("database-progress", progress);
  }));
  ipcMain.handle("import-database", (e, d) => db.importDatabase(d, (progress) => {
    e.sender.send("database-progress", progress);
  }));
  ipcMain.handle("drop-database", (e, name) => db.dropDatabase(name));
  ipcMain.handle("exec-raw-sql", (_e, sql) => db.execRawSql(sql));
  ipcMain.handle("get-mariadb-port", async () => {
    const port = await svc.getMariaDBPort();
    return { success: true, port };
  });
  ipcMain.handle("set-mariadb-port", async (_e, port) => {
    try {
      const c = await fs.readJson(global.CONST.CONFIG_FILE);
      if (!c.mysql) c.mysql = {};
      c.mysql.port = parseInt(port, 10);
      await fs.writeJson(global.CONST.CONFIG_FILE, c, { spaces: 2 });
      // Regenerate phpMyAdmin config.inc.php with the new port
      const setup = require("./setup");
      if (typeof setup.setupPhpMyAdmin === "function") {
        await setup.setupPhpMyAdmin();
      }
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle("get-root-password-status", () => db.getRootPasswordStatus());
  ipcMain.handle("change-root-password", (_e, password) => db.changeRootPassword(password));

  // ── Laravel ──
  ipcMain.handle("install-laravel", (e, d) =>
    laravel.installLaravel(d, (msg) => {
      global.STATE.mainWindow?.webContents?.send("laravel-progress", msg);
    }),
  );
  ipcMain.handle("run-artisan", (_e, d) => laravel.runArtisan(d));

  // ── WordPress ──
  ipcMain.handle("install-wordpress", (e, d) => wp.installWordPress(d));
  ipcMain.handle("wp-get-users", (_e, id) => wp.wpGetUsers({ id }));
  ipcMain.handle("wp-auto-login", (_e, d) => wp.wpAutoLogin(d));
  ipcMain.handle("wp-reset-password", (e, d) => wp.wpResetPassword(d));
  ipcMain.handle("wp-toggle-debug", (e, d) => wp.wpToggleDebug(d));
  ipcMain.handle("get-wp-debug-state", (e, d) => wp.getWpDebugState(d));
  ipcMain.handle("get-wp-debug-log", (e, id) => wp.getWpDebugLog(id));
  ipcMain.handle("download-wp-cli", () => wp.downloadWpCli());
  ipcMain.handle("wp-cli", (e, d) => wp.runWpCli(d));

  // ── Backup ──
  ipcMain.handle("backup-project", (e, id) => bk.backupProject(id, (progress) => {
    e.sender.send("backup-progress", progress);
  }));
  ipcMain.handle("get-backups", () => bk.getBackups());

  // ── SSL ──
  ipcMain.handle("install-ssl", (_e, d) => ssl.installSSL(d));
  ipcMain.handle("remove-ssl",  (_e, d) => ssl.removeSSL(d));
  ipcMain.handle("check-mkcert", () => ({ exists: require("fs").existsSync(ssl.getMkcertPath()) }));

  // ── Node.js / NPM ──
  ipcMain.handle("run-node-tool", (_e, d) => proj.runNodeTool(d));

  // ── Open in Editor ──
  ipcMain.handle("open-in-editor", (_e, id) => proj.openProjectInEditor(id));
  ipcMain.handle("get-detected-editor", () => proj.getDetectedEditor());
  ipcMain.handle("set-php-path", async (_e, phpPath) => {
    try {
      const { exec } = require("child_process");
      let phpDir;
      if (phpPath && fs.existsSync(phpPath)) {
        phpDir = path.dirname(phpPath);
      } else {
        // Use bundled PHP
        const versions = await svc.getAvailablePhpVersions();
        const ver = versions.length > 0 ? versions[0] : "8.3";
        phpDir = global.CONST.getPhpDir(ver);
      }

      // Add to current process PATH
      process.env.PATH = phpDir + ";" + process.env.PATH;

      // Also add to user PATH permanently via setx
      return new Promise((resolve) => {
        exec(`setx PATH "%PATH%;${phpDir}"`, { shell: true }, (err) => {
          if (err) {
            log.warn("setx PATH failed: " + err.message);
            resolve({ success: true, message: `PHP added to session PATH: ${phpDir} (permanent PATH requires admin)` });
          } else {
            log.ok(`PHP added to user PATH: ${phpDir}`);
            resolve({ success: true, message: `PHP path added: ${phpDir}` });
          }
        });
      });
    } catch (e) {
      return { success: false, message: e.message };
    }
  });
  ipcMain.handle("set-editor-path", async (_e, editorPath) => {
    try {
      const c = await fs.readJson(global.CONST.CONFIG_FILE);
      c.editor_path = editorPath || "";
      await fs.writeJson(global.CONST.CONFIG_FILE, c, { spaces: 2 });
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  // ── Config ──
  ipcMain.handle("get-config", async () => {
    try { return await fs.readJson(global.CONST.CONFIG_FILE); }
    catch { return {}; }
  });
  ipcMain.handle("save-config", async (e, c) => {
    await fs.ensureDir(path.dirname(global.CONST.CONFIG_FILE));
    await fs.writeJson(global.CONST.CONFIG_FILE, c, { spaces: 2 });
    return { success: true };
  });
  ipcMain.handle("get-php-config", async (e, version) => {
    const { getPhpDir, PHP_BASE_DIR } = global.CONST;
    // If version specified, use that dir; fallback to first available version
    let phpDir;
    if (version) {
      phpDir = getPhpDir(version);
    } else {
      // Find first version with php.ini
      const versions = await svc.getAvailablePhpVersions();
      phpDir = versions.length > 0 ? getPhpDir(versions[0]) : path.join(PHP_BASE_DIR, "8.3");
    }
    const p = path.join(phpDir, "php.ini");
    return {
      success: true,
      content: fs.existsSync(p)
        ? await fs.readFile(p, "utf8")
        : "# php.ini not found",
    };
  });
  ipcMain.handle("save-php-config", async (e, content, version) => {
    const { getPhpDir } = global.CONST;
    const phpDir = version ? getPhpDir(version) : getPhpDir("8.3");
    const p = path.join(phpDir, "php.ini");
    await fs.writeFile(p, content);
    return svc.restartPhpCgi(version);
  });
  ipcMain.handle("get-mariadb-config", async () => {
    const myIni = require("path").join(global.CONST.MARIADB_DIR, "my.ini");
    if (await fs.pathExists(myIni)) {
      return { success: true, content: await fs.readFile(myIni, "utf8") };
    }
    return { success: false, message: "my.ini not found" };
  });
  ipcMain.handle("save-mariadb-config", async (e, content) => {
    const myIni = require("path").join(global.CONST.MARIADB_DIR, "my.ini");
    await fs.writeFile(myIni, content);
    return svc.restartMariaDB();
  });

  // ── Logs ──
  ipcMain.handle("get-logs", (e, id) => {
    if (id) {
      const lp = path.join(global.CONST.PROJECTS_DIR, id, "logs", "error.log");
      if (fs.existsSync(lp))
        return fs
          .readFile(lp, "utf8")
          .then((c) => c.split("\n").slice(-300).join("\n"));
    }
    return Promise.resolve(global.STATE.logBuffer.join("\n"));
  });
  ipcMain.handle("get-log-buffer", () => global.STATE.logBuffer.join("\n"));
  ipcMain.handle("set-live-logs", (_e, enabled) => {
    global.STATE.liveLogsEnabled = !!enabled;
    return { success: true };
  });

  // ── App info / shell ──
  ipcMain.handle("check-binaries", () => {
    const { PMA_DIR, BIN_DIR } = global.CONST;

    return {
      php: Boolean(platform.executable("phpCgi")),
      mariadb: Boolean(platform.executable("mysqld")),
      nginx: Boolean(platform.executable("nginx")),
      pma: fs.existsSync(path.join(PMA_DIR, "index.php")),
      wpcli: fs.existsSync(global.CONST.WP_CLI),
      binDir: BIN_DIR,
      platform: process.platform,
    };
  });
  // Disk cache (refreshed every 30s to avoid spawning wmic too often)
  let _diskCache = null;
  let _diskCacheTime = 0;
  const DISK_CACHE_TTL = 30000;

  ipcMain.handle("get-system-stats", async () => {
    const os = require("os");
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) totalTick += cpu.times[type];
      totalIdle += cpu.times.idle;
    }
    const cpuUsage = Math.round(((totalTick - totalIdle) / totalTick) * 100);

    // Disk: cache for 30s
    if (!_diskCache || Date.now() - _diskCacheTime > DISK_CACHE_TTL) {
      try {
        if (process.platform === "win32") {
          const { exec } = require("child_process");
          const drive = (global.CONST.PROJECTS_DIR || global.CONST.DATA_DIR).charAt(0);
          _diskCache = await new Promise((resolve) => {
            exec(`wmic logicaldisk where "DeviceID='${drive}:'" get Size,FreeSpace /format:value`, (err, stdout) => {
              if (err) { resolve(null); return; }
              const free = parseInt((stdout.match(/FreeSpace=(\d+)/) || [])[1]) || 0;
              const total = parseInt((stdout.match(/Size=(\d+)/) || [])[1]) || 0;
              resolve({ free, total, used: total - free, drive: drive + ":" });
            });
          });
        } else {
          const stats = await fs.statfs(global.CONST.PROJECTS_DIR);
          const total = stats.blocks * stats.bsize;
          const free = stats.bavail * stats.bsize;
          _diskCache = { free, total, used: total - free, drive: global.CONST.PROJECTS_DIR };
        }
        _diskCacheTime = Date.now();
      } catch { _diskCache = null; }
    }

    return {
      ram: { total: totalMem, free: freeMem, used: usedMem, percent: Math.round((usedMem / totalMem) * 100) },
      cpu: { percent: cpuUsage, cores: cpus.length },
      disk: _diskCache,
      process: { mem: process.memoryUsage().rss },
    };
  });
  ipcMain.handle("get-app-info", () => ({
    name: global.CONST.APP_NAME,
    version: global.CONST.APP_VERSION,
    author: global.CONST.APP_AUTHOR,
  }));

  // ── Check for updates (GitHub Releases API) ──
  ipcMain.handle("check-for-updates", () => {
    const https = require("https");
    return new Promise((resolve) => {
      const req = https.get(
        "https://api.github.com/repos/vithanhlam/shieldpress-local/releases/latest",
        { headers: { "User-Agent": "ShieldPress-Local" }, timeout: 10000 },
        (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            try {
              const json = JSON.parse(data);
              resolve({ success: true, version: json.tag_name || "", url: json.html_url || "" });
            } catch {
              resolve({ success: false, message: "Parse error" });
            }
          });
        }
      );
      req.on("error", (err) => resolve({ success: false, message: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ success: false, message: "Timeout" }); });
    });
  });
  ipcMain.handle("get-data-dir", () => global.CONST.DATA_DIR);
  ipcMain.handle("get-bin-dir", () => global.CONST.BIN_DIR);

  ipcMain.handle("open-folder", (e, p) => {
    shell.openPath(p);
    return { success: true };
  });
  ipcMain.handle("reveal-path", (_e, p) => {
    shell.showItemInFolder(p);
    return { success: true };
  });
  ipcMain.handle("open-browser", (e, u) => {
    shell.openExternal(u);
    return { success: true };
  });
  ipcMain.handle("open-phpmyadmin", async () => {
    const c = await fs.readJson(global.CONST.CONFIG_FILE);
    const pmaPort = c.phpmyadmin?.port || 8080;
    if (!fs.existsSync(path.join(global.CONST.PMA_DIR, "index.php"))) {
      return { success: false, message: "phpMyAdmin is not installed" };
    }

    // Ensure the virtual host exists even when phpMyAdmin was installed after
    // the application had already initialized its runtime.
    await require("./setup").setupPhpMyAdmin();

    // Auto-start MariaDB if not running
    if (!global.STATE.isDBRunning) {
      log.info("phpMyAdmin: MariaDB not running, starting...");
      await svc.startMariaDB();
    }

    // Auto-start PHP for phpMyAdmin (uses first available version)
    const versions = await svc.getAvailablePhpVersions();
    const pmaPhpVer = versions.length > 0 ? versions[0] : "8.3";
    const phpPort = svc.getPhpPort(pmaPhpVer);
    if (!(await svc.isPortOpen(phpPort))) {
      log.info(`phpMyAdmin: PHP ${pmaPhpVer} not running, starting...`);
      await svc.startPhpCgi(pmaPhpVer);
    }

    // Auto-start or reload Nginx so the phpMyAdmin server is active.
    if (!global.STATE.isNginxRunning) {
      log.info("phpMyAdmin: Nginx not running, starting...");
      const started = await svc.startNginx();
      if (!started.success) return started;
    } else {
      const reloaded = await svc.reloadNginx();
      if (!reloaded.success) return reloaded;
    }

    if (!(await svc.waitPort(pmaPort, 10))) {
      return { success: false, message: `phpMyAdmin did not start on port ${pmaPort}` };
    }
    shell.openExternal(`http://localhost:${pmaPort}`);
    return { success: true };
  });

  ipcMain.handle("open-import-dialog", async () => {
    const { mainWindow } = global.STATE;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "SQL/GZ", extensions: ["sql", "gz"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Window ──
  ipcMain.handle("open-hosts-file", () => {
    shell.openPath(platform.hostsFile());
  });
  ipcMain.handle("window-minimize", () => global.STATE.mainWindow?.minimize());
  ipcMain.handle("window-maximize", () => {
    const w = global.STATE.mainWindow;
    if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
  });

  const pm = require("./plugin-manager");
  ipcMain.handle("get-plugins", () => pm.getPlugins());
  ipcMain.handle("run-plugin", (e, d) =>
    pm.runPlugin(d.pluginId, d.action, d.data),
  );
  // License handlers (backend ready, UI hidden for now)
  ipcMain.handle("get-license", () => pm.getLicense());
  ipcMain.handle("activate-license", (e, key) => pm.activateLicense(key));
  ipcMain.handle("deactivate-license", () => pm.deactivateLicense());

  ipcMain.handle("window-close", () => require("electron").app.quit());

  // ── SFTP & FTP ──
  ipcMain.handle("sftp-vault-status", () => sftp.getVaultStatus());
  ipcMain.handle("sftp-vault-setup", (_e, password) => sftp.setupVault(password));
  ipcMain.handle("sftp-vault-unlock", (_e, password) => sftp.unlockVault(password));
  ipcMain.handle("sftp-vault-change-password", (_e, data) =>
    sftp.changeVaultPassword(data?.currentPassword, data?.newPassword),
  );
  ipcMain.handle("sftp-vault-lock", () => sftp.lockVault());
  ipcMain.handle("sftp-get-connections", () => sftp.getConnections());
  ipcMain.handle("sftp-save-connection", (_e, d) => sftp.saveConnection(d));
  ipcMain.handle("sftp-delete-connection", (_e, id) => sftp.deleteConnection(id));
  ipcMain.handle("sftp-connect", (e, id) =>
    sftp.connect(id, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }),
  );
  ipcMain.handle("sftp-connect-session", (e, sessionId) =>
    sftp.connectSession(sessionId, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
    }),
  );
  ipcMain.handle("sftp-connection-status", (_e, id) => sftp.getConnectionStatus(id));
  ipcMain.handle("sftp-disconnect", (_e, id) => sftp.disconnect(id));
  ipcMain.handle("sftp-disconnect-all", () => sftp.disconnectAll());
  ipcMain.handle("sftp-close-session", (_e, sessionId) => sftp.closeSession(sessionId));
  ipcMain.handle("sftp-open-window", async (_e, { kind, connectionId }) => {
    const remoteWindows = require("./remote-windows");
    const sessionManager = require("./session-manager");
    const conns = await sftp.getConnections();
    const conn = (conns.connections || []).find((c) => c.id === connectionId);
    if (!conn) return { success: false, message: "Connection not found" };
    const wanted = kind === "terminal" ? "terminal" : (conn.type === "ftp" ? "ftp" : "sftp");
    if (kind === "terminal" && conn.type !== "sftp") {
      return { success: false, message: "Terminal only available for SFTP (SSH) connections" };
    }
    const title = `${remoteWindows.kindLabel(wanted)} — ${conn.name || conn.host}`;
    const session = sessionManager.create({
      kind: wanted,
      connectionId,
      title,
    });
    const linked = await sftp.connectSession(session.id);
    if (!linked.success) {
      sessionManager.remove(session.id);
      return linked;
    }
    return remoteWindows.openRemoteWindow({
      kind: wanted,
      connectionId,
      connectionName: conn.name,
      host: conn.host,
      sessionId: session.id,
    });
  });
  ipcMain.handle("sftp-list", (_e, { id, remotePath }) => sftp.listRemote(id, remotePath));
  ipcMain.handle("sftp-download", (e, { id, remotePath, localPath }) =>
    sftp.downloadFile(id, remotePath, localPath, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }),
  );
  const sendSftpProgress = (e, msg) => {
    try {
      if (msg && typeof msg === "object") e.sender.send("sftp-upload-progress", msg);
      else e.sender.send("sftp-progress", msg);
    } catch {}
    const win = global.STATE.mainWindow?.webContents;
    if (!win || win.isDestroyed()) return;
    if (msg && typeof msg === "object") win.send("sftp-upload-progress", msg);
    else win.send("sftp-progress", msg);
  };
  ipcMain.handle("sftp-download-batch", (e, { id, items, retry }) =>
    sftp.downloadBatch(id, items, (msg) => sendSftpProgress(e, msg), { retry: !!retry }),
  );
  ipcMain.handle("sftp-upload", (e, { id, localPath, remotePath }) =>
    sftp.uploadFile(id, localPath, remotePath, (msg) => sendSftpProgress(e, msg)),
  );
  ipcMain.handle("sftp-upload-batch", (e, { id, items, retry }) =>
    sftp.uploadBatch(id, items, (msg) => sendSftpProgress(e, msg), { retry: !!retry }),
  );
  ipcMain.handle("sftp-upload-cancel", () => sftp.cancelUpload());
  ipcMain.handle("sftp-sync-upload", (e, { id, changedOnly, concurrency }) =>
    sftp.syncUpload(id, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }, { changedOnly: !!changedOnly, concurrency }),
  );
  ipcMain.handle("sftp-sync-download", (e, { id, changedOnly, concurrency }) =>
    sftp.syncDownload(id, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }, { changedOnly: !!changedOnly, concurrency }),
  );
  ipcMain.handle("sftp-sync-cancel", () => sftp.cancelSync());
  // ── S3-compatible object storage ──
  ipcMain.handle("s3-get-buckets", () => s3.getBuckets());
  ipcMain.handle("s3-open-window", async (_e, id) => { const result = await s3.getBuckets(); const bucket = (result.buckets || []).find((item) => item.id === id); if (!bucket) return { success: false, message: "S3 configuration not found" }; return require("./remote-windows").openS3Window({ bucketId: id, bucketName: bucket.name }); });
  ipcMain.handle("s3-save-bucket", (_e, d) => s3.saveBucket(d));
  ipcMain.handle("s3-delete-bucket", (_e, id) => s3.deleteBucket(id));
  ipcMain.handle("s3-test-bucket", (e, id) => s3.test(id, (progress) => { try { e.sender.send("s3-test-progress", progress); } catch {} }));
  ipcMain.handle("s3-list-objects", (_e, { id, prefix }) => s3.listObjects(id, prefix));
  ipcMain.handle("s3-delete-object", (_e, { id, key }) => s3.deleteObject(id, key));
  ipcMain.handle("s3-download-object", (_e, { id, key, localPath }) => s3.downloadObject(id, key, localPath));
  ipcMain.handle("s3-download-prefix", (e, { id, prefix, localPath, opts }) => s3.downloadPrefix(id, prefix, localPath, opts, (done, total, item) => { try { e.sender.send("s3-progress", { done, total, item: item.key, direction: "down" }); } catch {} }));
  ipcMain.handle("s3-upload-paths", (e, { id, items, opts }) => s3.uploadPaths(id, items, opts, (done, total, item) => { try { e.sender.send("s3-progress", { done, total, item: item.relative, direction: "up" }); } catch {} }));
  ipcMain.handle("s3-upload", (e, { id, opts }) => s3.upload(id, opts, (done, total, item) => { try { e.sender.send("s3-progress", { done, total, item: item.relative, direction: "up" }); } catch {} }));
  ipcMain.handle("s3-download", (e, { id, opts }) => s3.download(id, opts, (done, total, item) => { try { e.sender.send("s3-progress", { done, total, item: item.key, direction: "down" }); } catch {} }));
  ipcMain.handle("s3-cancel", () => s3.cancel());
  ipcMain.handle("sftp-validate-path", (_e, localPath) => sftp.validateLocalPath(localPath));
  ipcMain.handle("sftp-exec", (_e, { id, command }) => sftp.execCommand(id, command));
  ipcMain.handle("sftp-system-info", (_e, id) => sftp.getRemoteSystemInfo(id));
  ipcMain.handle("sftp-remote-stats", (_e, id) => sftp.getRemoteStats(id));
  ipcMain.handle("sftp-shell-start", (e, { id, cols, rows, sessionId }) =>
    sftp.startShell(id, cols, rows, { sessionId, webContentsId: e.sender.id }),
  );
  ipcMain.handle("sftp-shell-write", (_e, { id, data }) => sftp.writeShell(id, data));
  ipcMain.handle("sftp-shell-resize", (_e, { id, cols, rows }) => sftp.resizeShell(id, cols, rows));
  ipcMain.handle("sftp-shell-stop", (_e, id) => sftp.stopShell(id));
  ipcMain.handle("sftp-delete", (e, { id, remotePath, isDirectory }) =>
    sftp.deleteRemote(id, remotePath, isDirectory, (msg) => {
      try { e.sender.send("sftp-upload-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-upload-progress", msg);
    }),
  );
  ipcMain.handle("sftp-read-file", (_e, { id, remotePath }) => sftp.readRemoteFile(id, remotePath));
  ipcMain.handle("sftp-write-file", (_e, { id, remotePath, content, skipValidation, skipBackup }) =>
    sftp.writeRemoteFile(id, remotePath, content, { skipValidation: !!skipValidation, skipBackup: !!skipBackup }),
  );
  ipcMain.handle("sftp-detect-language", (_e, remotePath) => ({
    success: true,
    language: sftp.detectEditorLanguage(remotePath),
  }));
  ipcMain.handle("sftp-validate-content", (_e, { remotePath, content }) => sftp.validateFileContent(remotePath, content));
  ipcMain.handle("sftp-upload-extract", (e, { id, localZipPath, remotePath }) =>
    sftp.uploadAndExtract(id, localZipPath, remotePath, (msg) => {
      try { e.sender.send("sftp-progress", msg); } catch {}
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }),
  );
  ipcMain.handle("sftp-mkdir", (_e, { id, remotePath }) => sftp.createRemoteDir(id, remotePath));
  ipcMain.handle("sftp-create-file", (_e, { id, remotePath }) => sftp.createRemoteFile(id, remotePath));
  ipcMain.handle("sftp-copy", (_e, { id, sourcePath, destinationPath, isDirectory }) => sftp.copyRemote(id, sourcePath, destinationPath, isDirectory));
  ipcMain.handle("sftp-move", (_e, { id, sourcePath, destinationPath }) => sftp.moveRemote(id, sourcePath, destinationPath));
  ipcMain.handle("sftp-rename", (_e, { id, remotePath, newName }) => sftp.renameRemote(id, remotePath, newName));
  ipcMain.handle("sftp-toggle-star", (_e, id) => sftp.toggleStar(id));
  ipcMain.handle("sftp-save-last-path", (_e, { id, path: p }) => sftp.updateLastBrowsedPath(id, p));
  ipcMain.handle("sftp-check-exists", (_e, { id, remotePath }) => sftp.checkRemoteExists(id, remotePath));
  ipcMain.handle("sftp-stat-local", (_e, localPath) => sftp.statLocalPath(localPath));
  ipcMain.handle("sftp-open-external", (_e, { id, remotePath, editorPath }) =>
    sftp.openInExternalEditor(id, remotePath, (msg) => {
      global.STATE.mainWindow?.webContents?.send("sftp-progress", msg);
    }, editorPath),
  );

  // ── Extensions ──
  ipcMain.handle("get-extensions", (_e, phpVersion) => ext.getExtensions(phpVersion));
  ipcMain.handle("toggle-extension", (_e, d) => ext.toggleExtension(d));
  ipcMain.handle("install-ioncube", (_e, d) =>
    ext.installIoncube(d, (msg) => {
      global.STATE.mainWindow?.webContents?.send("ioncube-progress", msg);
    }),
  );
  ipcMain.handle("enable-essentials", (_e, phpVersion) => ext.enableEssentials(phpVersion));
  ipcMain.handle("fix-extension-dir", (_e, phpVersion) => ext.fixExtensionDir(phpVersion));
  ipcMain.handle("deduplicate-extensions", (_e, phpVersion) => ext.deduplicateExtensions(phpVersion));
  ipcMain.handle("get-duplicate-info", (_e, phpVersion) => ext.getDuplicateInfo(phpVersion));
  ipcMain.handle("add-php-version", (_e, d) => ext.addPhpVersion(d));
  ipcMain.handle("remove-php-version", (_e, version) => ext.removePhpVersion(version));

  // ── Email ──
  ipcMain.handle("get-email-config", () => email.getEmailConfig());
  ipcMain.handle("save-email-config", (_e, config) => email.saveEmailConfig(config));
  ipcMain.handle("send-test-email", (_e, d) => email.sendTestEmail(d));

  // ── GitHub Credentials ──
  const crypto = require("crypto");
  const GH_KEY = crypto.createHash("sha256").update(require("os").hostname() + "-shieldpress-github-v1").digest();
  function ghEncrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", GH_KEY, iv);
    let enc = cipher.update(text, "utf8", "hex");
    enc += cipher.final("hex");
    return iv.toString("hex") + ":" + cipher.getAuthTag().toString("hex") + ":" + enc;
  }
  function ghDecrypt(data) {
    try {
      const [ivH, tagH, enc] = data.split(":");
      const decipher = crypto.createDecipheriv("aes-256-gcm", GH_KEY, Buffer.from(ivH, "hex"));
      decipher.setAuthTag(Buffer.from(tagH, "hex"));
      let dec = decipher.update(enc, "hex", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch { return ""; }
  }

  function getGhConfigPath() { return path.join(global.CONST.DATA_DIR, "github.json"); }

  ipcMain.handle("github-get-config", async () => {
    const p = getGhConfigPath();
    if (!fs.existsSync(p)) return { configured: false };
    try {
      const cfg = await fs.readJson(p);
      return { configured: true, username: cfg.username, email: cfg.email };
    } catch { return { configured: false }; }
  });

  ipcMain.handle("github-save-config", async (_e, { username, email, token }) => {
    try {
      const p = getGhConfigPath();
      let existing = {};
      if (fs.existsSync(p)) existing = await fs.readJson(p);

      const cfg = {
        username,
        email: email || "",
        token: token ? ghEncrypt(token) : (existing.token || ""),
      };
      await fs.writeJson(p, cfg, { spaces: 2 });

      // Configure git globally
      const { exec } = require("child_process");
      const cmds = [
        `git config --global user.name "${username}"`,
        email ? `git config --global user.email "${email}"` : null,
        `git config --global credential.helper store`,
      ].filter(Boolean);

      for (const cmd of cmds) {
        await new Promise(r => exec(cmd, () => r()));
      }

      // Store credentials in git credential store
      const realToken = token || (existing.token ? ghDecrypt(existing.token) : "");
      if (realToken) {
        const credLine = `https://${username}:${realToken}@github.com\n`;
        const credFile = path.join(require("os").homedir(), ".git-credentials");
        let credContent = "";
        if (fs.existsSync(credFile)) credContent = await fs.readFile(credFile, "utf8");
        // Remove old github.com entry
        credContent = credContent.split("\n").filter(l => !l.includes("github.com")).join("\n");
        credContent = credContent.trim() + "\n" + credLine;
        await fs.writeFile(credFile, credContent, "utf8");

        // Test the token
        let verified = false;
        try {
          const fetch = require("node-fetch");
          const resp = await fetch("https://api.github.com/user", {
            headers: { "Authorization": `token ${realToken}`, "User-Agent": "ShieldPress-Local" }
          });
          verified = resp.status === 200;
        } catch {}

        log.ok(`[github] Credentials saved for ${username}`);
        return { success: true, verified };
      }

      return { success: true, verified: false };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle("github-clear-config", async () => {
    const p = getGhConfigPath();
    if (fs.existsSync(p)) await fs.remove(p);
    // Remove from git-credentials
    const credFile = path.join(require("os").homedir(), ".git-credentials");
    if (fs.existsSync(credFile)) {
      let content = await fs.readFile(credFile, "utf8");
      content = content.split("\n").filter(l => !l.includes("github.com")).join("\n");
      await fs.writeFile(credFile, content, "utf8");
    }
    return { success: true };
  });

  // ── Git / GitHub ──
  ipcMain.handle("git-status", (_e, id) => git.getGitStatus(id));
  ipcMain.handle("git-save-config", (_e, { id, config }) => git.saveGitConfig(id, config));
  ipcMain.handle("git-init", (_e, { id, data }) => git.gitInit(id, data));
  ipcMain.handle("git-push", (_e, { id, data }) =>
    git.gitPush(id, data, (msg) => {
      global.STATE.mainWindow?.webContents?.send("git-progress", msg);
    }),
  );
  ipcMain.handle("git-pull", (_e, { id, data }) =>
    git.gitPull(id, data, (msg) => {
      global.STATE.mainWindow?.webContents?.send("git-progress", msg);
    }),
  );
  ipcMain.handle("git-clone-repo", (_e, { id, data }) =>
    git.gitCloneRepo(id, data, (msg) => {
      global.STATE.mainWindow?.webContents?.send("git-progress", msg);
    }),
  );
  ipcMain.handle("git-exec", (_e, { id, cmd }) =>
    git.gitExecCmd(id, cmd, (msg) => {
      global.STATE.mainWindow?.webContents?.send("git-progress", msg);
    }),
  );

  // ── Cache Management ──
  ipcMain.handle("cache-opcache-status", async () => {
    // Read OPcache config from php.ini (CLI can't access CGI OPcache shared memory)
    const versions = await svc.getAvailablePhpVersions();
    const results = [];
    for (const ver of versions) {
      const phpDir = global.CONST.getPhpDir(ver);
      const iniPath = path.join(phpDir, "php.ini");
      if (!fs.existsSync(iniPath)) continue;
      try {
        const ini = await fs.readFile(iniPath, "utf8");
        const get = (k, def = null) => {
          const m = ini.match(new RegExp(`^\\s*;?\\s*${k}\\s*=\\s*(.+)`, "m"));
          return m ? m[1].trim() : def;
        };
        // PHP 8.1+ has OPcache enabled by default; treat as enabled unless explicitly set to 0
        const explicitlyDisabled = /^\s*opcache\.enable\s*=\s*0\b/m.test(ini);
        const explicitlyEnabled = /^\s*opcache\.enable\s*=\s*1\b/m.test(ini);
        const phpMajor = parseFloat(ver) || 0;
        const enabled = explicitlyEnabled || (!explicitlyDisabled && phpMajor >= 8.0);
        const memory = get("opcache.memory_consumption", "128");
        const maxFiles = get("opcache.max_accelerated_files", "10000");
        const revalidate = get("opcache.revalidate_freq", "2");
        // Match both zend_extension and extension (PHP 8.4 allows either)
        const extLine = ini.match(/^\s*(?:zend_extension|extension)\s*=\s*[^;]*opcache/mi);
        results.push({ version: ver, enabled, memory, maxFiles, revalidate, extLoaded: !!extLine });
      } catch {}
    }
    if (results.length === 0) return { enabled: false };
    // Return combined: enabled if any version has it on
    const any = results.find(r => r.enabled);
    return { enabled: !!any, versions: results };
  });

  ipcMain.handle("cache-opcache-reset", async () => {
    // Restart PHP-CGI processes to clear their OPcache shared memory
    try {
      await svc.restartPhpCgi();
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  });

  ipcMain.handle("cache-opcache-toggle", async () => {
    const versions = await svc.getAvailablePhpVersions();
    const ver = versions.length > 0 ? versions[0] : "8.3";
    const phpDir = global.CONST.getPhpDir(ver);
    const iniPath = path.join(phpDir, "php.ini");
    if (!fs.existsSync(iniPath)) return { success: false, message: "php.ini not found" };

    let ini = await fs.readFile(iniPath, "utf8");
    const enabled = /^\s*opcache\.enable\s*=\s*1/m.test(ini);
    if (enabled) {
      ini = ini.replace(/^\s*opcache\.enable\s*=\s*1/m, "opcache.enable=0");
    } else {
      if (/opcache\.enable/m.test(ini)) {
        ini = ini.replace(/^\s*;?\s*opcache\.enable\s*=.*/m, "opcache.enable=1");
      } else {
        ini += "\nopcache.enable=1\n";
      }
    }
    await fs.writeFile(iniPath, ini);
    await svc.restartPhpCgi(ver);
    return { success: true, message: enabled ? "OPcache disabled" : "OPcache enabled" };
  });

  ipcMain.handle("cache-wp-status", async (_e, projId) => {
    const wwwDir = path.join(global.CONST.PROJECTS_DIR, projId, "www");
    const wpConfig = path.join(wwwDir, "wp-config.php");
    if (!fs.existsSync(wpConfig)) return { isWordPress: false };

    let cacheSize = "0 KB";
    const cacheDir = path.join(wwwDir, "wp-content", "cache");
    if (fs.existsSync(cacheDir)) {
      try {
        const bytes = await directorySize(cacheDir);
        cacheSize = bytes > 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : (bytes / 1024).toFixed(0) + " KB";
      } catch { cacheSize = "Unknown"; }
    }

    // Check for object cache plugin
    let objectCache = null;
    const ocFile = path.join(wwwDir, "wp-content", "object-cache.php");
    if (fs.existsSync(ocFile)) {
      const content = await fs.readFile(ocFile, "utf8");
      if (content.includes("Redis")) objectCache = "Redis";
      else if (content.includes("Memcached")) objectCache = "Memcached";
      else objectCache = "Custom";
    }

    return { isWordPress: true, cacheSize, objectCache };
  });

  ipcMain.handle("cache-wp-flush", async (_e, projId) => {
    return wp.runWpCli({ id: projId, command: "cache flush" });
  });

  ipcMain.handle("cache-wp-transients", async (_e, projId) => {
    const r = await wp.runWpCli({ id: projId, command: "transient delete --all" });
    return { success: r.success, count: r.output?.match(/(\d+)/)?.[1] || 0, message: r.message };
  });

  ipcMain.handle("cache-wp-rewrite", async (_e, projId) => {
    return wp.runWpCli({ id: projId, command: "rewrite flush" });
  });

  ipcMain.handle("cache-clean-project", async (_e, projId) => {
    const wwwDir = path.join(global.CONST.PROJECTS_DIR, projId, "www");
    const cacheDirs = [
      "wp-content/cache", "wp-content/upgrade",
      "storage/framework/cache", "storage/framework/sessions", "storage/framework/views",
      ".next", "dist", "build", "__pycache__",
    ];
    let output = "";
    let totalFreed = 0;
    for (const d of cacheDirs) {
      const fullPath = path.join(wwwDir, d);
      if (fs.existsSync(fullPath)) {
        try {
          const stat = await fs.stat(fullPath);
          await fs.emptyDir(fullPath);
          output += `Cleaned: ${d}\n`;
          totalFreed += 1; // approximate
        } catch (e) { output += `Skip: ${d} (${e.message})\n`; }
      }
    }
    return { success: true, output: output || "No cache directories found", freedMB: totalFreed };
  });

  ipcMain.handle("cache-clean-dir", async (_e, { id, dir }) => {
    const fullPath = path.join(global.CONST.PROJECTS_DIR, id, "www", dir);
    if (!fs.existsSync(fullPath)) return { success: false, message: `${dir} not found` };
    try {
      // Get size before delete
      const sizeMB = Math.round((await directorySize(fullPath)) / 1048576);
      await fs.remove(fullPath);
      return { success: true, freedMB: sizeMB };
    } catch (e) { return { success: false, message: e.message }; }
  });

  ipcMain.handle("cache-clear-nginx-logs", async () => {
    const logsDir = path.join(global.CONST.NGINX_DIR, "logs");
    if (!fs.existsSync(logsDir)) return { success: false, message: "Logs dir not found" };
    const files = await fs.readdir(logsDir);
    let count = 0;
    for (const f of files) {
      if (f.endsWith(".log")) {
        await fs.writeFile(path.join(logsDir, f), "");
        count++;
      }
    }
    return { success: true, count };
  });

  // ── Tasks (task.json per project) ──
  ipcMain.handle("get-tasks", async (_e, id) => {
    const p = path.join(global.CONST.PROJECTS_DIR, id, "task.json");
    if (!fs.existsSync(p)) return { success: true, tasks: [] };
    try {
      const raw = await fs.readFile(p, "utf8");
      const tasks = JSON.parse(raw);
      return { success: true, tasks: Array.isArray(tasks) ? tasks : [] };
    } catch {
      return { success: true, tasks: [] };
    }
  });
  ipcMain.handle("save-tasks", async (_e, { id, tasks }) => {
    const p = path.join(global.CONST.PROJECTS_DIR, id, "task.json");
    await fs.writeFile(p, JSON.stringify(tasks, null, 2), "utf8");
    return { success: true };
  });

  // ── Google Drive Backup ──
  // ── Cloud Backup (local folder → Google Drive / OneDrive / Dropbox etc.) ──
  ipcMain.handle("gdrive-get-status",          ()          => gd.getStatus());
  ipcMain.handle("gdrive-detect-folders",      ()          => gd.detectCloudFolders());
  ipcMain.handle("gdrive-get-folder",          ()          => gd.getBackupFolder().then(f => ({ folder: f })));
  ipcMain.handle("gdrive-save-folder",         (_e, folder) => gd.saveBackupFolder(folder));
  ipcMain.handle("gdrive-get-project-config",  (_e, id)    => gd.getProjectBackupConfig(id));
  ipcMain.handle("gdrive-save-project-config", (_e, id, cfg) => gd.saveProjectBackupConfig(id, cfg));
  ipcMain.handle("gdrive-backup-project", async (_e, id)   => {
    return gd.backupProjectToDrive(id, (msg) => {
      global.STATE.mainWindow?.webContents?.send("gdrive-backup-progress", msg);
    });
  });
  ipcMain.handle("gdrive-backup-db", async (_e, id) => {
    return gd.backupDbToDrive(id, (msg) => {
      global.STATE.mainWindow?.webContents?.send("gdrive-backup-progress", msg);
    });
  });

  // ── Redis ──
  ipcMain.handle("start-redis",         () => svc.startRedis());
  ipcMain.handle("stop-redis",          () => svc.stopRedis());
  ipcMain.handle("restart-redis",       () => svc.restartRedis());
  ipcMain.handle("get-redis-info",      () => svc.getRedisInfo());
  ipcMain.handle("download-redis",      () => svc.downloadRedis((msg) => {
    global.STATE.mainWindow?.webContents?.send("redis-download-progress", msg);
  }));
  ipcMain.handle("flush-redis",         () => svc.flushRedis());
  ipcMain.handle("get-redis-port",      () => svc.getRedisPort().then(p => ({ port: p })));
  ipcMain.handle("set-redis-port",      async (_e, port) => {
    try {
      const c = await fs.readJson(global.CONST.CONFIG_FILE).catch(() => ({}));
      if (!c.redis) c.redis = {};
      c.redis.port = parseInt(port, 10) || 6379;
      await fs.writeJson(global.CONST.CONFIG_FILE, c, { spaces: 2 });
      return { success: true };
    } catch (e) { return { success: false, message: e.message }; }
  });
}

module.exports = { register };
