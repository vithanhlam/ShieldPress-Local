// src/main/database.js
const { exec } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");
const platform = require("./platform");

function mysqlBin() {
  return platform.executable("mysql");
}
function dumpBin() {
  return platform.executable("mysqldump");
}

function connectionArgsFor(platformName, mysqlConfig = {}) {
  const port = mysqlConfig.port || (platformName === "win32" ? 3306 : 3307);
  const args = ["-h", "127.0.0.1", "-P", String(port), "-u", "root"];
  // The bundled Windows database is initialized with this root password.
  // Linux uses a separate passwordless, user-owned MariaDB instance.
  if (platformName === "win32") {
    args.push(`--password=${mysqlConfig.root_password || "root"}`);
  }
  return args;
}

function connectionArgs() {
  let mysqlConfig = {};
  try { mysqlConfig = fs.readJsonSync(global.CONST.CONFIG_FILE).mysql || {}; } catch {}
  return connectionArgsFor(process.platform, mysqlConfig);
}

function mysqlExec(sql) {
  return new Promise((resolve, reject) => {
    const binary = mysqlBin();
    if (!binary) return reject(new Error("MariaDB client not found"));
    const proc = require("child_process").spawn(binary, [...connectionArgs(), "-e", sql]);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve(stdout) : reject(stderr || `MariaDB client exited ${code}`));
  });
}

function mysqlExecFile(file, db = "") {
  return new Promise((resolve, reject) => {
    exec(
      `"${mysqlBin()}" ${connectionArgs().join(" ")}${db ? " " + db : ""} < "${file}"`,
      { shell: true },
      (err, stdout, stderr) => {
        if (err) reject(stderr || err.message);
        else resolve(stdout);
      },
    );
  });
}

async function createDatabase(dbName) {
  // Auto-start MariaDB if not running
  if (!global.STATE.isDBRunning) {
    const svc = require("./services");
    log.info("MariaDB not running, starting before creating DB...");
    const r = await svc.startMariaDB();
    if (!r.success) {
      return { success: false, message: "MariaDB is not running. Please start MariaDB first." };
    }
  }
  try {
    await mysqlExec(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    log.ok(`DB created: ${dbName}`);
    return { success: true };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

async function listDatabases() {
  try {
    const out = await mysqlExec("SHOW DATABASES");
    const skip = ["information_schema", "performance_schema", "mysql", "sys"];
    const dbs = out
      .split("\n")
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l && !skip.includes(l));
    const statsOutput = await mysqlExec(
      "SELECT TABLE_SCHEMA,COUNT(*),COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) " +
      "FROM information_schema.TABLES GROUP BY TABLE_SCHEMA",
    );
    const stats = new Map(
      statsOutput.split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
        const [name, tables, size] = line.split("\t");
        return [name, { tables: Number(tables) || 0, size: Number(size) || 0 }];
      }),
    );
    const projectTypes = new Map();
    const entries = await fs.readdir(global.CONST.PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        const project = await fs.readJson(path.join(global.CONST.PROJECTS_DIR, entry.name, "project.json"));
        if (project.dbName) projectTypes.set(project.dbName, project.projectType || "php");
      } catch {}
    }));
    return {
      success: true,
      databases: dbs,
      databaseDetails: dbs.map((name) => ({
        name,
        tables: stats.get(name)?.tables || 0,
        size: stats.get(name)?.size || 0,
        projectType: projectTypes.get(name) || null,
        isWordPress: projectTypes.get(name) === "wordpress",
      })),
    };
  } catch (e) {
    return { success: false, databases: [], message: String(e) };
  }
}

async function exportDatabase({ dbName }, onProgress = () => {}) {
  const { BACKUPS_DIR } = global.CONST;
  await fs.ensureDir(BACKUPS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(BACKUPS_DIR, `${dbName}_${ts}.sql`);
  const stats = await mysqlExec(
    `SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA='${dbName.replace(/'/g, "''")}'`,
  );
  const estimatedTotal = Number(stats.trim().split(/\r?\n/).pop()) || 0;
  return new Promise((resolve) => {
    const binary = dumpBin();
    if (!binary) return resolve({ success: false, message: "mysqldump not found" });
    onProgress({ operation: "export", dbName, status: "running", processed: 0, total: estimatedTotal, percent: 0 });
    const proc = require("child_process").spawn(binary, [
      ...connectionArgs(), dbName, `--result-file=${outFile}`,
    ]);
    let stderr = "";
    let lastPercent = -1;
    const timer = setInterval(async () => {
      const processed = (await fs.stat(outFile).catch(() => ({ size: 0 }))).size;
      const percent = estimatedTotal ? Math.min(99, Math.round((processed / estimatedTotal) * 100)) : null;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress({ operation: "export", dbName, status: "running", processed, total: estimatedTotal, percent });
      }
    }, 400);
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => {
      clearInterval(timer);
      resolve({ success: false, message: error.message });
    });
    proc.on("close", async (code) => {
      clearInterval(timer);
      if (code !== 0) {
        log.err("Export failed: " + stderr);
        return resolve({ success: false, message: stderr || `mysqldump exited ${code}` });
      }
      const size = (await fs.stat(outFile)).size;
      onProgress({ operation: "export", dbName, status: "done", processed: size, total: size, percent: 100 });
      log.ok(`Exported ${dbName} → ${outFile}`);
      resolve({ success: true, path: outFile, folder: path.dirname(outFile), size });
    });
  });
}

async function importDatabase({ dbName, filePath }, onProgress = () => {}) {
  try {
    await mysqlExec(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );

    const mysql = mysqlBin();
    if (!mysql) return { success: false, message: "MariaDB client not found" };
    const isGz = filePath.endsWith(".gz");
    const { spawn } = require("child_process");
    const zlib = require("zlib");
    const fs2 = require("fs");

    log.info(
      `Importing ${filePath} → ${dbName} ${isGz ? "(gzip)" : "(sql)"}...`,
    );

    const total = (await fs.stat(filePath)).size;
    return new Promise((resolve) => {
      const mysqlProc = spawn(mysql, [...connectionArgs(), dbName], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let err = "";
      mysqlProc.stderr.on("data", (d) => {
        err += d.toString();
        log.warn("mysql: " + d.toString().trim());
      });
      mysqlProc.stdout.on("data", (d) =>
        log.info("mysql: " + d.toString().trim()),
      );

      const interval = setInterval(
        () => log.info(`Still importing ${dbName}...`),
        5000,
      );

      mysqlProc.on("close", (code) => {
        clearInterval(interval);
        if (code === 0) {
          onProgress({ operation: "import", dbName, status: "done", processed: total, total, percent: 100 });
          log.ok(`Import OK: ${dbName}`);
          resolve({ success: true });
        } else {
          log.err(`Import failed code=${code}`);
          resolve({ success: false, message: err });
        }
      });

      let processed = 0;
      let lastPercent = -1;
      onProgress({ operation: "import", dbName, status: "running", processed, total, percent: 0 });
      // Pipe file into mysql and report source bytes consumed.
      const fileStream = fs2.createReadStream(filePath);
      fileStream.on("data", (chunk) => {
        processed += chunk.length;
        const percent = total ? Math.min(99, Math.round((processed / total) * 100)) : null;
        if (percent !== lastPercent) {
          lastPercent = percent;
          onProgress({ operation: "import", dbName, status: "running", processed, total, percent });
        }
      });
      if (isGz) {
        const gunzip = zlib.createGunzip();
        fileStream.pipe(gunzip).pipe(mysqlProc.stdin);
        gunzip.on("error", (e) => {
          log.err("Gunzip error: " + e.message);
          resolve({ success: false, message: e.message });
        });
      } else {
        fileStream.pipe(mysqlProc.stdin);
      }

      fileStream.on("error", (e) => {
        log.err("File read error: " + e.message);
        resolve({ success: false, message: e.message });
      });
    });
  } catch (e) {
    return { success: false, message: String(e) };
  }
}
// Drop without backup
async function dropDatabase(dbName) {
  try {
    await mysqlExec(`DROP DATABASE IF EXISTS \`${dbName}\``);
    log.ok(`DB dropped: ${dbName}`);
    return { success: true };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

// Execute raw SQL query and return formatted output
async function execRawSql(sql) {
  try {
    const output = await mysqlExec(sql);
    return { success: true, output };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

module.exports = {
  connectionArgsFor,
  connectionArgs,
  mysqlExec,
  createDatabase,
  listDatabases,
  exportDatabase,
  importDatabase,
  dropDatabase,
  execRawSql,
};
