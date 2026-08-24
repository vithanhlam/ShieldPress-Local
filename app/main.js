const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs-extra");
const workspace = require("./src/main/workspace");

// Electron's Vulkan probe is unreliable on some Ubuntu/NVIDIA hybrid setups.
// This dashboard does not need GPU acceleration, so prefer stable software rendering.
if (process.platform === "linux") app.disableHardwareAcceleration();

const APP_NAME = "ShieldPress Local";
const APP_VERSION = app.getVersion();
const APP_AUTHOR = "vithanhlam";
const isDev = !app.isPackaged;
const BASE_DIR = isDev
  ? path.join(__dirname, "..")
  : path.dirname(process.execPath);

const BIN_DIR = isDev
  ? path.join(__dirname, "..", "bin")
  : path.join(process.resourcesPath, "bin");

function getDataDir() {
  return path.join(WORKSPACE_DIR, "data");
}

const WORKSPACE_DIR = workspace.getWorkspaceDir(app);
const DATA_DIR = getDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

let config = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    config = fs.readJsonSync(CONFIG_FILE);
  }
} catch (e) {}

// Tự động suy ra ổ đĩa hiện hành và gán mặc định nếu cấu hình chưa có projects_dir
let projectsDir = config.projects_dir;
if (!projectsDir) {
  const currentDrive = path.parse(BASE_DIR).root; // "F:\" hoặc "C:\"
  projectsDir = WORKSPACE_DIR;
}

global.CONST = {
  APP_NAME,
  APP_VERSION,
  APP_AUTHOR,
  BASE_DIR,
  WORKSPACE_DIR,
  DATA_DIR,
  BIN_DIR,
  PROJECTS_DIR: projectsDir,
  BACKUPS_DIR: path.join(DATA_DIR, "backups"),
  CONFIG_FILE,
  LOGS_DIR: path.join(DATA_DIR, "logs"),
  MYSQL_DATA: path.join(DATA_DIR, "mysql", "data"),
  RUNTIME_DIR: process.platform === "win32" ? BIN_DIR : path.join(DATA_DIR, "runtime"),
};

// Linux packages live below /opt and must remain read-only. Keep the bundled
// PHP files as a source, then run/configure PHP from the writable workspace.
global.CONST.BUNDLED_PHP_BASE_DIR = path.join(BIN_DIR, "php");
global.CONST.PHP_BASE_DIR = process.platform === "win32"
  ? global.CONST.BUNDLED_PHP_BASE_DIR
  : path.join(global.CONST.RUNTIME_DIR, "php");
global.CONST.PHP_DIR = global.CONST.PHP_BASE_DIR;
global.CONST.getPhpDir = (version) =>
  path.join(global.CONST.PHP_BASE_DIR, version || "8.3");
global.CONST.MARIADB_DIR = process.platform === "win32"
  ? path.join(BIN_DIR, "mariadb")
  : path.join(global.CONST.RUNTIME_DIR, "mariadb");
global.CONST.NGINX_DIR = process.platform === "win32"
  ? path.join(BIN_DIR, "nginx")
  : path.join(global.CONST.RUNTIME_DIR, "nginx");
global.CONST.PMA_DIR = process.platform === "linux" && fs.existsSync("/usr/share/phpmyadmin/index.php")
  ? "/usr/share/phpmyadmin"
  : path.join(BIN_DIR, "phpmyadmin");
global.CONST.WP_CLI = process.platform === "win32"
  ? path.join(BIN_DIR, "wp-cli", "wp.phar")
  : path.join(DATA_DIR, "tools", "wp-cli.phar");

global.STATE = {
  isDBRunning: false,
  isNginxRunning: false,
  isPhpRunning: false,
  isRedisRunning: false,
  runningProjects: {},
  logBuffer: [],
  liveLogsEnabled: false,
  mainWindow: null,
};

const setup = require("./src/main/setup");
const services = require("./src/main/services");
const ipc = require("./src/main/ipc");

// ssh2 / child-process writes to a closed socket throw EPIPE as an uncaught
// exception. Without this handler Electron shows "A JavaScript error occurred
// in the main process" when connecting to a VPS that drops the handshake.
process.on("uncaughtException", (err) => {
  const code = err && err.code;
  if (code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || code === "ENOTCONN") {
    try { require("./src/main/logger").err("Ignored pipe error: " + (err.message || code)); } catch {}
    return;
  }
  console.error(err);
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ── Tray ──────────────────────────────────────────────────────────────────────
function getTrayIcon() {
  const candidates = [
    path.join(__dirname, "renderer", "images", "icon.png"),
    path.join(process.resourcesPath || "", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(__dirname, "assets", "icon.ico"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function updateTrayMenu() {
  if (!tray) return;
  const s = global.STATE;
  const fingerprint = [
    !!s.isNginxRunning, !!s.isPhpRunning, !!s.isDBRunning, !!s.isRedisRunning,
  ].join("|");
  if (fingerprint === tray._statusFingerprint) return;
  tray._statusFingerprint = fingerprint;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "ShieldPress Local v" + APP_VERSION, enabled: false },
      { type: "separator" },
      { label: "── Services ──", enabled: false },
      {
        label: s.isNginxRunning ? "⟳ Restart Nginx" : "▶ Start Nginx",
        click: () =>
          s.isNginxRunning ? services.restartNginx() : services.startNginx(),
      },
      {
        label: s.isPhpRunning ? "⟳ Restart PHP" : "▶ Start PHP",
        click: () =>
          s.isPhpRunning ? services.restartPhpCgi() : services.startPhpCgi(),
      },
      {
        label: s.isDBRunning ? "⟳ Restart MariaDB" : "▶ Start MariaDB",
        click: () =>
          s.isDBRunning ? services.restartMariaDB() : services.startMariaDB(),
      },
      { type: "separator" },
      { label: "── Quick Actions ──", enabled: false },
      {
        label: "＋ New Project",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send("quick-action", "new-project");
        },
      },
      {
        label: "🗄 phpMyAdmin",
        click: () => shell.openExternal("http://localhost:8080"),
      },
      {
        label: "💾 Backup",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
          mainWindow?.webContents.send("quick-action", "backup");
        },
      },
      { type: "separator" },
      {
        label: "Open App",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const iconPath = getTrayIcon();
  const icon = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("ShieldPress Local");

  // Double click → restore
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else createWindow();
  });

  updateTrayMenu();

  // Refresh menu mỗi 5s để cập nhật service status
  setInterval(updateTrayMenu, 5000);
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    frame: false,
    backgroundColor: "#080b11",
    icon: process.platform === "linux"
      ? path.join(__dirname, "renderer", "images", "icon.png")
      : undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  global.STATE.mainWindow = mainWindow;
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Minimize → ẩn xuống tray
  mainWindow.on("minimize", (e) => {
    e.preventDefault();
    mainWindow.hide();
    tray?.displayBalloon({
      title: "ShieldPress Local",
      content: "Running in background. Double-click tray icon to restore.",
      iconType: "info",
    });
  });

  // Close → hỏi
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      dialog
        .showMessageBox(mainWindow, {
          type: "question",
          buttons: ["Minimize to Tray", "Quit"],
          defaultId: 0,
          cancelId: 1,
          title: "ShieldPress Local",
          message: "What do you want to do?",
          detail: "Minimize keeps services running in background.",
        })
        .then(({ response }) => {
          if (response === 0) mainWindow.hide();
          else {
            app.quit();
          }
        });
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    global.STATE.mainWindow = null;
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    // Skip when IME is composing (Vietnamese, Chinese, Japanese, Korean input)
    if (input.isComposing || input.key === "Process") return;

    if (input.control && input.shift && input.key.toLowerCase() === "i")
      event.preventDefault();
    if (input.key === "F12") event.preventDefault();

    if (input.key === "F5") event.preventDefault();
    if (input.control && input.key === "F5") event.preventDefault();
    if (input.control && input.key.toLowerCase() === "r")
      event.preventDefault();
    if (input.control && input.shift && input.key.toLowerCase() === "r")
      event.preventDefault();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    await setup.init();
  } catch (error) {
    const crashLog = path.join(app.getPath("userData"), "startup-error.log");
    const details = `${new Date().toISOString()}\n${error.stack || error}\n`;
    try { fs.ensureDirSync(path.dirname(crashLog)); fs.writeFileSync(crashLog, details); } catch {}
    await workspace.clearWorkspacePreference(app).catch(() => {});
    dialog.showErrorBox(
      "ShieldPress Local could not initialize the workspace",
      `${error.message}\n\nThe invalid workspace preference was reset. Reopen the app.\nLog: ${crashLog}`,
    );
    app.exit(1);
    return;
  }
  ipc.register(ipcMain, shell, dialog);
  createWindow();
  createTray();
});

app.on("before-quit", async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();

  const runningIds = Object.keys(global.STATE.runningProjects);

  if (runningIds.length > 0) {
    const projects = require("./src/main/projects");
    const win = global.STATE.mainWindow;

    // Ensure window is visible so dialog appears in foreground
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }

    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Backup & Quit", "Quit Without Backup", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      title: "Backup Before Quit",
      message: `${runningIds.length} project(s) are currently running.`,
      detail:
        "Do you want to backup their databases before quitting?\n\n" +
        "⚠ Without a backup, database changes may be lost if something goes wrong.",
    });

    if (response === 2) {
      // Cancel
      isQuitting = false;
      return;
    }

    if (response === 0) {
      // Backup & Quit — show progress overlay in renderer
      if (win && !win.isDestroyed()) {
        win.show();
        win.webContents.send("quit-backup-start", runningIds.length);
      }
      for (let i = 0; i < runningIds.length; i++) {
        if (win && !win.isDestroyed()) {
          win.webContents.send("quit-backup-progress", {
            current: i + 1,
            total: runningIds.length,
          });
        }
        await projects.backupProjectDb(runningIds[i]);
      }
      if (win && !win.isDestroyed()) {
        win.webContents.send("quit-backup-done");
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  }

  // Notify renderer: stopping services phase
  const win2 = global.STATE.mainWindow;
  if (win2 && !win2.isDestroyed()) {
    win2.show();
    win2.webContents.send("quit-stopping");
  }
  await services.stopAll();
  try {
    const sftp = require("./src/main/sftp");
    await sftp.disconnectAll();
  } catch {}
  app.exit(0);
});

app.on("window-all-closed", () => {
  // Không quit khi đóng window - giữ chạy trong tray
  // Chỉ quit khi user chọn Quit từ tray menu
});
