#!/usr/bin/env node
const fs = require("fs-extra");
const path = require("path");

const workspace = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(workspace, "data", "config.json"))) {
  console.error("Usage: node scripts/verify-workspace-mariadb.js <workspace-directory>");
  process.exit(1);
}

const data = path.join(workspace, "data");
const runtime = path.join(data, "runtime");
global.CONST = {
  BIN_DIR: path.join(__dirname, "..", "bin"),
  DATA_DIR: data,
  PROJECTS_DIR: workspace,
  BACKUPS_DIR: path.join(data, "backups"),
  LOGS_DIR: path.join(data, "logs"),
  MYSQL_DATA: path.join(data, "mysql", "data"),
  NGINX_DIR: path.join(runtime, "nginx"),
  MARIADB_DIR: path.join(runtime, "mariadb"),
  PHP_BASE_DIR: path.join(__dirname, "..", "bin", "php"),
  PHP_DIR: path.join(__dirname, "..", "bin", "php"),
  PMA_DIR: path.join(__dirname, "..", "bin", "phpmyadmin"),
  CONFIG_FILE: path.join(data, "config.json"),
  getPhpDir: (version) => path.join(__dirname, "..", "bin", "php", version || "8.3"),
};
global.STATE = {
  isDBRunning: false, isNginxRunning: false, isPhpRunning: false,
  isRedisRunning: false, runningProjects: {}, logBuffer: [], mainWindow: null,
};

(async () => {
  const services = require("../app/src/main/services");
  const database = require("../app/src/main/database");
  try {
    const started = await services.startMariaDB();
    if (!started.success) throw new Error(started.message);
    const version = (await database.mysqlExec("SELECT VERSION()"))
      .trim().split(/\r?\n/).pop();
    const databases = await database.listDatabases();
    if (!databases.success) throw new Error(databases.message);
    console.log(`Workspace MariaDB verification: OK (${version}, ${databases.databases.length} project databases)`);
  } finally {
    await services.stopMariaDB().catch(() => {});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
