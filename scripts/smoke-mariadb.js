#!/usr/bin/env node
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-mariadb-"));
  const data = path.join(root, "data");
  const runtime = path.join(data, "runtime");
  global.CONST = {
    BIN_DIR: path.join(root, "bin"), DATA_DIR: data, PROJECTS_DIR: path.join(root, "projects"),
    BACKUPS_DIR: path.join(data, "backups"), LOGS_DIR: path.join(data, "logs"),
    MYSQL_DATA: path.join(data, "mysql", "data"), NGINX_DIR: path.join(runtime, "nginx"),
    MARIADB_DIR: path.join(runtime, "mariadb"), PHP_BASE_DIR: path.join(root, "php"),
    PHP_DIR: path.join(root, "php"), PMA_DIR: path.join(root, "pma"),
    CONFIG_FILE: path.join(data, "config.json"), getPhpDir: (v) => path.join(root, "php", v || "8.5"),
  };
  global.STATE = { isDBRunning: false, isNginxRunning: false, isPhpRunning: false, isRedisRunning: false, runningProjects: {}, logBuffer: [], mainWindow: null };
  await fs.ensureDir(global.CONST.PROJECTS_DIR);
  const setup = require("../app/src/main/setup");
  const services = require("../app/src/main/services");
  const database = require("../app/src/main/database");
  try {
    await setup.init();
    const started = await services.startMariaDB();
    if (!started.success) throw new Error(started.message);
    await database.mysqlExec("CREATE DATABASE shieldpress_smoke_test");
    const listed = await database.listDatabases();
    if (!listed.databases.includes("shieldpress_smoke_test")) throw new Error("Smoke database was not listed");
    await database.mysqlExec("DROP DATABASE shieldpress_smoke_test");
    console.log("MariaDB isolated-instance smoke test: OK");
  } finally {
    await services.stopMariaDB().catch(() => {});
    await fs.remove(root).catch(() => {});
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
