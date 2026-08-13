// plugins/backup-full/index.js
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const { exec, spawn } = require("child_process");
const log = require("../../src/main/logger");
const platform = require("../../src/main/platform");
const database = require("../../src/main/database");

// ── Backup ────────────────────────────────────────────────────────────────────
async function backup({ projId }) {
  const { PROJECTS_DIR, BACKUPS_DIR, MARIADB_DIR, NGINX_DIR } = global.CONST;
  const archiver = require("archiver");

  const cfgPath = path.join(PROJECTS_DIR, projId, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Project not found" };

  const proj = await fs.readJson(cfgPath);
  await fs.ensureDir(BACKUPS_DIR);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sqlFile = path.join(os.tmpdir(), `dump_${projId}_${ts}.sql`);
  const dest = path.join(BACKUPS_DIR, `FULL_${proj.name}_${ts}.zip`);

  // 1. Dump DB
  log.info(`[backup-full] Dumping DB: ${proj.dbName}`);
  const dumpOk = await new Promise((resolve) => {
    const dump = platform.executable("mysqldump");
    if (!dump) return resolve(false);
    exec(
      `"${dump}" ${database.connectionArgs().join(" ")} --single-transaction --routines --triggers ${proj.dbName} > "${sqlFile}"`,
      { shell: true },
      (err, _, stderr) => {
        if (err) {
          log.err("[backup-full] Dump failed: " + stderr);
          resolve(false);
        } else {
          log.ok("[backup-full] DB dumped");
          resolve(true);
        }
      },
    );
  });
  if (!dumpOk) return { success: false, message: "DB dump failed" };

  // 2. Create ZIP
  log.info("[backup-full] Creating ZIP...");
  const meta = {
    version: "1.0",
    createdAt: new Date().toISOString(),
    project: {
      id: proj.id,
      name: proj.name,
      domain: proj.domain,
      dbName: proj.dbName,
      phpVersion: proj.phpVersion,
      projectType: proj.projectType,
      port: proj.port,
      uploadLimit: proj.uploadLimit,
      tags: proj.tags || [],
    },
  };

  return new Promise((resolve) => {
    const out = fs.createWriteStream(dest);
    const arc = archiver("zip", { zlib: { level: 6 } });

    out.on("close", async () => {
      const size = arc.pointer();
      await fs.remove(sqlFile).catch(() => {});
      log.ok(
        `[backup-full] Done: ${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`,
      );
      resolve({ success: true, path: dest, size, name: path.basename(dest) });
    });
    arc.on("error", async (e) => {
      await fs.remove(sqlFile).catch(() => {});
      resolve({ success: false, message: e.message });
    });

    arc.pipe(out);
    const wwwDir = path.join(PROJECTS_DIR, projId, "www");
    // Exclude heavy directories based on project type
    const excludeDirs = {
      wordpress: ["node_modules", ".git", "wp-content/cache", "wp-content/upgrade"],
      laravel: ["node_modules", "vendor", ".git", "storage/framework/cache", "storage/framework/sessions", "storage/framework/views"],
      node: ["node_modules", ".git", "dist", "build", ".next"],
      nextjs: ["node_modules", ".git", ".next", "out", "dist"],
      php: ["node_modules", "vendor", ".git"],
    };
    const type = proj.projectType || "php";
    const excludes = excludeDirs[type] || excludeDirs.php;
    if (fs.existsSync(wwwDir)) {
      arc.glob("**/*", {
        cwd: wwwDir,
        dot: true,
        ignore: excludes.map(d => d + "/**"),
      }, { prefix: "www" });
    }
    if (fs.existsSync(sqlFile)) arc.file(sqlFile, { name: "database.sql" });
    arc.file(cfgPath, { name: "project.json" });
    const nginxConf = path.join(
      NGINX_DIR,
      "conf",
      "servers",
      `${proj.domain}.conf`,
    );
    if (fs.existsSync(nginxConf)) arc.file(nginxConf, { name: "nginx.conf" });
    arc.append(JSON.stringify(meta, null, 2), { name: "meta.json" });
    arc.finalize();
    log.info("[backup-full] Archiving... please wait");
  });
}

// ── Restore ───────────────────────────────────────────────────────────────────
async function restore({ zipPath, projId, createNew }) {
  const extract = require("extract-zip");
  const { PROJECTS_DIR, MARIADB_DIR, CONFIG_FILE } = global.CONST;

  if (!fs.existsSync(zipPath))
    return { success: false, message: "ZIP not found: " + zipPath };

  const tmpDir = path.join(os.tmpdir(), `restore_${Date.now()}`);
  await fs.ensureDir(tmpDir);

  try {
    // 1. Extract
    log.info("[restore] Extracting ZIP...");
    await extract(zipPath, { dir: tmpDir });
    log.ok("[restore] Extracted");

    // 2. Read meta
    const metaPath = path.join(tmpDir, "meta.json");
    if (!fs.existsSync(metaPath))
      return { success: false, message: "Invalid backup: meta.json missing" };
    const meta = await fs.readJson(metaPath);
    const srcProj = meta.project;
    log.info(`[restore] Source: ${srcProj.name} (${srcProj.domain})`);

    // 3. Determine target project
    let targetProj;
    if (createNew) {
      log.info("[restore] Creating new project...");
      const projMod = require("../../src/main/projects");
      const result = await projMod.createProject({
        name: srcProj.name + "_restored",
        domain: srcProj.domain.replace(".local", "-restored.local"),
        phpVersion: "8.3",
        dbName: srcProj.dbName + "_restored",
        projectType: srcProj.projectType || "php",
        tags: srcProj.tags || [],
      });
      if (!result.success)
        return {
          success: false,
          message: "Create project failed: " + (result.message || ""),
        };
      targetProj = result.project;
    } else {
      if (!projId) return { success: false, message: "projId required" };
      const cfgPath = path.join(PROJECTS_DIR, projId, "project.json");
      if (!(await fs.pathExists(cfgPath)))
        return { success: false, message: "Target project not found" };
      targetProj = await fs.readJson(cfgPath);
    }

    // 4. Restore files
    const wwwSrc = path.join(tmpDir, "www");
    const wwwDst = path.join(PROJECTS_DIR, targetProj.id, "www");
    if (fs.existsSync(wwwSrc)) {
      log.info("[restore] Restoring files...");
      await fs.emptyDir(wwwDst);
      await fs.copy(wwwSrc, wwwDst, { overwrite: true });
      log.ok("[restore] Files restored");
    }

    // 5. Restore DB via spawn (large file safe)
    const sqlFile = path.join(tmpDir, "database.sql");
    if (fs.existsSync(sqlFile)) {
      log.info(`[restore] Restoring DB: ${targetProj.dbName}`);
      const mysql = platform.executable("mysql");
      if (!mysql) throw new Error("MariaDB client not found");
      await new Promise((r) =>
        exec(
          `"${mysql}" ${database.connectionArgs().join(" ")} -e "CREATE DATABASE IF NOT EXISTS \`${targetProj.dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"`,
          () => r(),
        ),
      );

      await new Promise((resolve) => {
        const mysqlProc = spawn(
          mysql,
          [...database.connectionArgs(), targetProj.dbName],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        mysqlProc.stderr.on("data", (d) =>
          log.warn("[restore] db: " + d.toString().trim()),
        );
        mysqlProc.on("close", (code) => {
          if (code === 0) log.ok("[restore] DB restored");
          else log.err("[restore] DB restore exit=" + code);
          resolve();
        });
        const stream = fs.createReadStream(sqlFile);
        stream.pipe(mysqlProc.stdin);
        stream.on("error", (e) => {
          log.err("[restore] " + e.message);
          resolve();
        });
      });
    }

    // 6. Fix wp-config.php nếu cần
    if (createNew) {
      const wpConfig = path.join(wwwDst, "wp-config.php");
      if (fs.existsSync(wpConfig)) {
        log.info("[restore] Fixing wp-config.php...");
        const cfg = await fs.readJson(CONFIG_FILE);
        let c = await fs.readFile(wpConfig, "utf8");
        c = c
          .replace(
            /define\('DB_NAME',\s*'[^']*'\)/,
            `define('DB_NAME', '${targetProj.dbName}')`,
          )
          .replace(
            /define\('DB_PASSWORD',\s*'[^']*'\)/,
            `define('DB_PASSWORD', '${cfg.mysql.root_password}')`,
          )
          .replace(
            /define\('WP_HOME',\s*'[^']*'\)/,
            `define('WP_HOME', 'http://${targetProj.domain}:${targetProj.port}')`,
          )
          .replace(
            /define\('WP_SITEURL',\s*'[^']*'\)/,
            `define('WP_SITEURL', 'http://${targetProj.domain}:${targetProj.port}')`,
          );
        await fs.writeFile(wpConfig, c);

        // Update siteurl/home in DB
        await new Promise((r) =>
          exec(
            `"${mysql}" ${database.connectionArgs().join(" ")} ${targetProj.dbName} -e "UPDATE wp_options SET option_value='http://${targetProj.domain}:${targetProj.port}' WHERE option_name IN ('siteurl','home');"`,
            () => r(),
          ),
        );
        log.ok("[restore] WordPress URLs updated");
      }
    }

    await fs.remove(tmpDir);
    const url = `http://${targetProj.domain}:${targetProj.port}`;
    log.ok(`[restore] Complete → ${url}`);
    return {
      success: true,
      project: targetProj,
      url,
      message: `Restored → ${url}`,
    };
  } catch (e) {
    await fs.remove(tmpDir).catch(() => {});
    log.err("[restore] Error: " + e.message);
    return { success: false, message: e.message };
  }
}

// ── List backups ──────────────────────────────────────────────────────────────
async function listBackups({ projId } = {}) {
  const { BACKUPS_DIR, PROJECTS_DIR } = global.CONST;
  await fs.ensureDir(BACKUPS_DIR);

  let filterName = "";
  if (projId) {
    const cfgPath = path.join(PROJECTS_DIR, projId, "project.json");
    if (await fs.pathExists(cfgPath)) {
      const p = await fs.readJson(cfgPath);
      filterName = p.name;
    }
  }

  const files = await fs.readdir(BACKUPS_DIR);
  const result = [];
  for (const f of files) {
    if (!f.startsWith("FULL_") || !f.endsWith(".zip")) continue;
    if (filterName && !f.includes(filterName)) continue;
    const fp = path.join(BACKUPS_DIR, f);
    const stat = await fs.stat(fp);
    result.push({
      name: f,
      path: fp,
      size: stat.size,
      createdAt: stat.birthtime,
    });
  }
  return {
    success: true,
    backups: result.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    ),
  };
}

async function validateBackup({ zipPath }) {
  const extract = require("extract-zip");
  const os = require("os");
  if (!fs.existsSync(zipPath))
    return { valid: false, message: "File not found" };

  if (!path.basename(zipPath).startsWith("FULL_") || !zipPath.endsWith(".zip"))
    return {
      valid: false,
      message:
        "File không đúng định dạng. Chỉ chấp nhận file FULL_*.zip tạo bởi Full Backup plugin",
    };

  const tmpDir = path.join(os.tmpdir(), `validate_${Date.now()}`);
  await fs.ensureDir(tmpDir);
  try {
    await extract(zipPath, { dir: tmpDir });
    const metaPath = path.join(tmpDir, "meta.json");
    if (!fs.existsSync(metaPath)) {
      await fs.remove(tmpDir);
      return {
        valid: false,
        message:
          "File ZIP không hợp lệ — thiếu meta.json. Đây không phải backup được tạo bởi Full Backup plugin",
      };
    }
    const meta = await fs.readJson(metaPath);
    if (!meta.version || !meta.project) {
      await fs.remove(tmpDir);
      return { valid: false, message: "meta.json không hợp lệ" };
    }
    await fs.remove(tmpDir);
    return { valid: true, meta };
  } catch (e) {
    await fs.remove(tmpDir).catch(() => {});
    return { valid: false, message: "Không thể đọc file ZIP: " + e.message };
  }
}

module.exports = { backup, restore, listBackups, validateBackup };
