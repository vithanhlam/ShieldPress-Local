// plugins/clone-wp/index.js
const fs      = require("fs-extra");
const path    = require("path");
const os      = require("os");
const { exec, spawn } = require("child_process");
const log     = require("../../src/main/logger");
const platform = require("../../src/main/platform");
const database = require("../../src/main/database");

function sendProgress(step, percent, message) {
  const { mainWindow } = global.STATE;
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("clone-progress", { step, percent, message });
  log.info(`[clone-wp] [${percent}%] ${message}`);
}

async function clone({ sourceId, newName, newDomain, newDbName, autoStart }) {
  const { PROJECTS_DIR, MARIADB_DIR, NGINX_DIR, CONFIG_FILE } = global.CONST;

  const srcCfgPath = path.join(PROJECTS_DIR, sourceId, "project.json");
  if (!(await fs.pathExists(srcCfgPath)))
    return { success: false, message: "Source project not found" };
  const src = await fs.readJson(srcCfgPath);

  // Verify this is a WordPress project by checking wp-config.php
  const wpConfigPath = path.join(PROJECTS_DIR, sourceId, "www", "wp-config.php");
  if (!(await fs.pathExists(wpConfigPath))) {
    return { success: false, message: "This is not a WordPress project (wp-config.php not found). Clone WordPress only works with WordPress projects." };
  }

  sendProgress("init", 0, `Cloning: ${src.name} → ${newName}`);

  const dom    = newDomain || `${newName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.local`;
  const dbName = newDbName || `db_${newName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

  // Step 1: Create project
  sendProgress("create", 5, "Creating new project...");
  const projMod = require("../../src/main/projects");
  const result  = await projMod.createProject({
    name: newName, domain: dom, phpVersion: "8.3",
    dbName, projectType: src.projectType || "wordpress", tags: src.tags || [],
  });
  if (!result.success) return { success: false, message: "Create failed: " + (result.message || "") };
  const newProj = result.project;
  sendProgress("create", 10, `Project created: port ${newProj.port}`);

  // Step 2: Copy files (estimate progress)
  const srcWww  = path.join(PROJECTS_DIR, sourceId, "www");
  const destWww = path.join(PROJECTS_DIR, newProj.id, "www");
  sendProgress("copy", 12, "Copying files...");
  await fs.emptyDir(destWww);

  const copyInterval = setInterval(() => {
    sendProgress("copy", Math.min(sendProgress._pct = (sendProgress._pct || 12) + 3, 55), "Copying files...");
  }, 1000);
  sendProgress._pct = 12;

  await fs.copy(srcWww, destWww, {
    overwrite: true,
    filter: (s) => !['wp-content/cache', 'wp-content/upgrade', '.git', 'node_modules'].some(x => s.includes(x)),
  });
  clearInterval(copyInterval);
  sendProgress("copy", 58, "Files copied");

  // Step 3: Dump + import DB
  sendProgress("db", 60, `Cloning DB: ${src.dbName} → ${dbName}`);
  const mysql     = platform.executable("mysql");
  const mysqldump = platform.executable("mysqldump");
  if (!mysql || !mysqldump) return { success: false, message: "MariaDB client tools not found" };
  const tmpSql    = path.join(os.tmpdir(), `clone_${Date.now()}.sql`);

  const dumpOk = await new Promise((resolve) => {
    exec(
      `"${mysqldump}" ${database.connectionArgs().join(" ")} --single-transaction --routines --triggers ${src.dbName} > "${tmpSql}"`,
      { shell: true },
      (err, _, stderr) => { if (err) { log.err(stderr); resolve(false); } else resolve(true); }
    );
  });
  if (!dumpOk) { await fs.remove(tmpSql).catch(() => {}); return { success: false, message: "DB dump failed" }; }

  sendProgress("db", 72, "Importing DB...");
  await new Promise((resolve) => {
    const proc = spawn(mysql, [...database.connectionArgs(), dbName], { stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr.on("data", d => log.warn("[clone-wp] " + d.toString().trim()));
    proc.on("close", () => resolve());
    const stream = fs.createReadStream(tmpSql);
    stream.pipe(proc.stdin);
    stream.on("error", () => resolve());
  });
  await fs.remove(tmpSql).catch(() => {});
  sendProgress("db", 80, "Database cloned");

  // Step 4: Fix wp-config.php
  sendProgress("config", 82, "Updating wp-config.php...");
  const wpConfig = path.join(destWww, "wp-config.php");
  if (fs.existsSync(wpConfig)) {
    const cfg = await fs.readJson(CONFIG_FILE);
    let c = await fs.readFile(wpConfig, "utf8");
    c = c
      .replace(/define\('DB_NAME',\s*'[^']*'\)/,    `define('DB_NAME', '${dbName}')`)
      .replace(/define\('DB_PASSWORD',\s*'[^']*'\)/, `define('DB_PASSWORD', '${cfg.mysql.root_password}')`)
      .replace(/define\('WP_HOME',\s*'[^']*'\)/,    `define('WP_HOME', 'http://${dom}:${newProj.port}')`)
      .replace(/define\('WP_SITEURL',\s*'[^']*'\)/, `define('WP_SITEURL', 'http://${dom}:${newProj.port}')`);
    await fs.writeFile(wpConfig, c);
  }

  // Step 5: Fix URLs in DB
  sendProgress("config", 86, "Replacing URLs in database...");
  const sqlFixes = [
    `UPDATE wp_options SET option_value='http://${dom}:${newProj.port}' WHERE option_name IN ('siteurl','home');`,
    `UPDATE wp_posts SET guid=REPLACE(guid,'${src.domain}','${dom}');`,
    `UPDATE wp_posts SET post_content=REPLACE(post_content,'${src.domain}','${dom}');`,
    `UPDATE wp_postmeta SET meta_value=REPLACE(CAST(meta_value AS CHAR),'${src.domain}','${dom}');`,
  ].join(" ");
  await new Promise(r => exec(`"${mysql}" ${database.connectionArgs().join(" ")} ${dbName} -e "${sqlFixes.replace(/"/g, '\\"')}"`, () => r()));
  sendProgress("config", 90, "URLs updated");

  // Step 6: Nginx config
  sendProgress("nginx", 92, "Writing nginx config...");
  const { buildNginxConf } = require("../../src/main/projects");
  const nginxConf = path.join(NGINX_DIR, "conf", "servers", `${dom}.conf`);
  await fs.writeFile(nginxConf, buildNginxConf(newProj));

  // Step 7: Auto start
  if (autoStart !== false) {
    sendProgress("start", 95, "Starting project...");
    await projMod.startProject(newProj.id);
  }

  sendProgress("done", 100, `Done! → http://${dom}:${newProj.port}`);
  return { success: true, project: newProj, url: `http://${dom}:${newProj.port}` };
}

module.exports = { clone };
