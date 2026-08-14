const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs-extra");

const APP_NAME = "CodeWP Local";
const APP_VERSION = "1.1.9";
const APP_AUTHOR = "vithanhlam";

const isDev = !app.isPackaged;
const BASE_DIR = isDev
  ? path.join(__dirname, "..")
  : path.dirname(process.execPath);
const DATA_DIR = path.join(BASE_DIR, "data");

// Export shared constants
global.CONST = {
  APP_NAME,
  APP_VERSION,
  APP_AUTHOR,
  BASE_DIR,
  DATA_DIR,
  PROJECTS_DIR: path.join(DATA_DIR, "projects"),
  BACKUPS_DIR: path.join(DATA_DIR, "backups"),
  CONFIG_FILE: path.join(DATA_DIR, "config.json"),
  LOGS_DIR: path.join(DATA_DIR, "logs"),
  MYSQL_DATA: path.join(DATA_DIR, "mysql", "data"),
  BIN_DIR: fs.existsSync(path.join(__dirname, "..", "bin"))
    ? path.join(__dirname, "..", "bin")
    : path.join(process.resourcesPath, "bin"),
};
global.CONST.PHP_DIR = path.join(global.CONST.BIN_DIR, "php");
global.CONST.MARIADB_DIR = path.join(global.CONST.BIN_DIR, "mariadb");
global.CONST.NGINX_DIR = path.join(global.CONST.BIN_DIR, "nginx");
global.CONST.PMA_DIR = path.join(global.CONST.BIN_DIR, "phpmyadmin");
global.CONST.WP_CLI = path.join(global.CONST.BIN_DIR, "wp-cli", "wp.phar");

// Shared state
global.STATE = {
  isDBRunning: false,
  isNginxRunning: false,
  isPhpRunning: false,
  runningProjects: {},
  logBuffer: [],
  mainWindow: null,
};

const logger = require("./src/main/logger");
const setup = require("./src/main/setup");
const services = require("./src/main/services");
const ipc = require("./src/main/ipc");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 980,
    minHeight: 660,
    frame: false,
    backgroundColor: "#080b11",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  global.STATE.mainWindow = mainWindow;
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
    global.STATE.mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await setup.init();
  ipc.register(ipcMain, shell, dialog);
  createWindow();
});

let isQuitting = false;
app.on("before-quit", async (e) => {
  if (isQuitting) return;
  isQuitting = true;
  e.preventDefault();
  await services.stopAll();
  app.exit(0);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
