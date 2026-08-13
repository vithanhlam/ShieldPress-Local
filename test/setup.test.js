const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const test = require("node:test");

test("setup merges defaults and builds a user-writable Linux Nginx layout", async (t) => {
  if (process.platform !== "linux") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-setup-"));
  t.after(() => fs.remove(root));
  const data = path.join(root, "data");
  const runtime = path.join(data, "runtime");
  global.CONST = {
    DATA_DIR: data,
    PROJECTS_DIR: root,
    BACKUPS_DIR: path.join(data, "backups"),
    LOGS_DIR: path.join(data, "logs"),
    MYSQL_DATA: path.join(data, "mysql", "data"),
    NGINX_DIR: path.join(runtime, "nginx"),
    MARIADB_DIR: path.join(runtime, "mariadb"),
    PHP_BASE_DIR: path.join(root, "missing-php"),
    PHP_DIR: path.join(root, "missing-php"),
    PMA_DIR: path.join(root, "missing-pma"),
    CONFIG_FILE: path.join(data, "config.json"),
    getPhpDir: (version) => path.join(root, "missing-php", version || "8.3"),
  };
  global.STATE = { runningProjects: {}, logBuffer: [], mainWindow: null };
  await fs.ensureDir(data);
  await fs.writeJson(global.CONST.CONFIG_FILE, { projects_dir: root });

  const setupPath = require.resolve("../app/src/main/setup");
  delete require.cache[setupPath];
  await require(setupPath).init();

  const config = await fs.readJson(global.CONST.CONFIG_FILE);
  assert.equal(config.mysql.port, 3307);
  assert.equal(config.nginx.base_port, 8000);
  assert.equal(config.projects_dir, root);
  const nginxConfig = await fs.readFile(path.join(global.CONST.NGINX_DIR, "conf", "nginx.conf"), "utf8");
  assert.match(nginxConfig, /include\s+".*servers\/\*\.conf";/);
  assert.equal(await fs.pathExists(path.join(global.CONST.NGINX_DIR, "fastcgi_params")), true);
});

test("Linux database migration updates local WordPress ports but preserves PostgreSQL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-port-migration-"));
  t.after(() => fs.remove(root));
  const wordpress = path.join(root, "wordpress");
  const laravel = path.join(root, "laravel");
  await fs.ensureDir(path.join(wordpress, "www"));
  await fs.ensureDir(path.join(laravel, "www"));
  await fs.writeJson(path.join(wordpress, "project.json"), {
    projectType: "wordpress", dbPort: 3306, dbUser: "root", dbPassword: "root",
  });
  await fs.writeFile(path.join(wordpress, "www", "wp-config.php"),
    "define('DB_HOST', '127.0.0.1:3306');\n" +
    "define('DB_USER', 'root');\n" +
    "define('DB_PASSWORD', 'root');\n");
  await fs.writeJson(path.join(laravel, "project.json"), { projectType: "laravel", dbPort: 3306 });
  await fs.writeFile(path.join(laravel, "www", ".env"), "DB_CONNECTION=pgsql\nDB_PORT=5432\nWP_DB_PORT=3306\n");

  const { migrateLinuxDatabasePort } = require("../app/src/main/setup");
  await migrateLinuxDatabasePort(root);

  const wordpressProject = await fs.readJson(path.join(wordpress, "project.json"));
  assert.equal(wordpressProject.dbPort, 3307);
  assert.equal(wordpressProject.dbPassword, "");
  const wpConfig = await fs.readFile(path.join(wordpress, "www", "wp-config.php"), "utf8");
  assert.match(wpConfig, /127\.0\.0\.1:3307/);
  assert.match(wpConfig, /DB_PASSWORD['"]\s*,\s*['"]['"]/);
  const env = await fs.readFile(path.join(laravel, "www", ".env"), "utf8");
  assert.match(env, /DB_PORT=5432/);
  assert.match(env, /WP_DB_PORT=3307/);
});

test("Linux PHP runtime is copied to the writable workspace and preserves php.ini", async (t) => {
  if (process.platform !== "linux") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-php-runtime-"));
  t.after(() => fs.remove(root));
  const bundled = path.join(root, "bundled", "8.4");
  const runtime = path.join(root, "runtime", "php");
  await fs.ensureDir(bundled);
  await fs.writeFile(path.join(bundled, "php-cgi"), "binary-v1");
  await fs.writeFile(path.join(bundled, "php.ini"), "memory_limit = 1G\n");

  global.CONST = {
    APP_VERSION: "2.5.9-test",
    BUNDLED_PHP_BASE_DIR: path.dirname(bundled),
    PHP_BASE_DIR: runtime,
  };
  const { ensureLinuxPhpRuntime } = require("../app/src/main/setup");
  await ensureLinuxPhpRuntime();
  assert.equal(await fs.readFile(path.join(runtime, "8.4", "php-cgi"), "utf8"), "binary-v1");

  await fs.writeFile(path.join(runtime, "8.4", "php.ini"), "memory_limit = 2G\n");
  await fs.writeFile(path.join(bundled, "php-cgi"), "binary-v2");
  global.CONST.APP_VERSION = "2.5.10-test";
  await ensureLinuxPhpRuntime();

  assert.equal(await fs.readFile(path.join(runtime, "8.4", "php-cgi"), "utf8"), "binary-v2");
  assert.equal(await fs.readFile(path.join(runtime, "8.4", "php.ini"), "utf8"), "memory_limit = 2G\n");
});
