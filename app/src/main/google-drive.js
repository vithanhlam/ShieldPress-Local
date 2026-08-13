// src/main/google-drive.js
// Cloud backup via local sync folder (Google Drive for Desktop, OneDrive, Dropbox, etc.)
// No OAuth2 / API key required — just point to any local folder that syncs to cloud.
const fs     = require("fs-extra");
const path   = require("path");
const { exec } = require("child_process");
const log    = require("./logger");
const platform = require("./platform");
const database = require("./database");

// ── Auto-detect common cloud-sync folders on Windows ─────────────────────────

async function detectCloudFolders() {
  const os   = require("os");
  const home = os.homedir();
  const found = [];

  // Google Drive for Desktop
  const gdriveCandidates = [
    path.join(home, "My Drive"),
    path.join(home, "Google Drive"),
    path.join(home, "Google Drive (My Drive)"),
  ];

  // Try registry for Google DriveFS root path
  try {
    const regOut = await new Promise((r) =>
      exec('reg query "HKCU\\Software\\Google\\DriveFS" /v "RootPath" 2>nul', (_, o) => r(o || ""))
    );
    const m = regOut.match(/RootPath\s+REG_SZ\s+(.+)/);
    if (m) {
      const rp = m[1].trim();
      if (await fs.pathExists(rp)) found.push({ label: "Google Drive for Desktop", path: rp });
    }
  } catch {}

  for (const c of gdriveCandidates) {
    if (await fs.pathExists(c) && !found.some((f) => f.path === c)) {
      found.push({ label: "Google Drive", path: c });
    }
  }

  // OneDrive
  try {
    const regOut = await new Promise((r) =>
      exec('reg query "HKCU\\Software\\Microsoft\\OneDrive" /v "UserFolder" 2>nul', (_, o) => r(o || ""))
    );
    const m = regOut.match(/UserFolder\s+REG_SZ\s+(.+)/);
    if (m) {
      const rp = m[1].trim();
      if (await fs.pathExists(rp)) found.push({ label: "OneDrive", path: rp });
    }
  } catch {}

  // Dropbox
  try {
    const dbxConfig = path.join(process.env.APPDATA || "", "Dropbox", "info.json");
    if (await fs.pathExists(dbxConfig)) {
      const info = await fs.readJson(dbxConfig);
      const rp = info?.personal?.path || info?.business?.path;
      if (rp && await fs.pathExists(rp)) found.push({ label: "Dropbox", path: rp });
    }
  } catch {}

  return found;
}

// ── Config helpers ────────────────────────────────────────────────────────────

async function getBackupFolder() {
  try {
    const cfg = await fs.readJson(global.CONST.CONFIG_FILE).catch(() => ({}));
    return (cfg.cloudBackup?.backupFolder || "").trim();
  } catch { return ""; }
}

async function saveBackupFolder(folder) {
  const cfg = await fs.readJson(global.CONST.CONFIG_FILE).catch(() => ({}));
  if (!cfg.cloudBackup) cfg.cloudBackup = {};
  cfg.cloudBackup.backupFolder = (folder || "").trim();
  await fs.writeJson(global.CONST.CONFIG_FILE, cfg, { spaces: 2 });
  return { success: true };
}

async function getStatus() {
  const folder   = await getBackupFolder();
  const detected = await detectCloudFolders();
  if (!folder) return { configured: false, detected };
  const exists = await fs.pathExists(folder);
  return { configured: true, backupFolder: folder, exists, detected };
}

// ── Per-project backup config ─────────────────────────────────────────────────

function defaultBackupConfig(projectType) {
  const map = {
    wordpress: {
      enabled: false, autoBackup: false, includeDatabase: true,
      folders: ["wp-content/plugins", "wp-content/themes", "wp-content/uploads"],
    },
    laravel: {
      enabled: false, autoBackup: false, includeDatabase: true,
      folders: ["app", "config", "database", "resources", "routes"],
    },
  };
  return map[projectType] || { enabled: false, autoBackup: false, includeDatabase: true, folders: [] };
}

async function getProjectBackupConfig(id) {
  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  if (!await fs.pathExists(cfgPath)) return { success: false, message: "Project not found" };
  const proj   = await fs.readJson(cfgPath);
  const def    = defaultBackupConfig(proj.projectType);
  const config = Object.assign({}, def, proj.googleDriveBackup || {});
  return { success: true, config, projectType: proj.projectType, defaults: def };
}

async function saveProjectBackupConfig(id, config) {
  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  if (!await fs.pathExists(cfgPath)) return { success: false, message: "Project not found" };
  const proj = await fs.readJson(cfgPath);
  proj.googleDriveBackup = config;
  await fs.writeJson(cfgPath, proj, { spaces: 2 });
  return { success: true };
}

// ── Backup helpers ────────────────────────────────────────────────────────────

async function exportDbToFile(proj, outPath) {
  const { MARIADB_DIR } = global.CONST;
  const dump = platform.executable("mysqldump");
  if (!dump) throw new Error("mysqldump not found");
  return new Promise((resolve, reject) => {
    exec(
      `"${dump}" ${database.connectionArgs().join(" ")} "${proj.dbName}" > "${outPath}"`,
      { shell: true },
      (err, _, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(); },
    );
  });
}

async function zipFolder(srcPath, destZip, folderAlias) {
  const archiver = require("archiver");
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destZip);
    const arc = archiver("zip", { zlib: { level: 6 } });
    out.on("close", resolve);
    arc.on("error", reject);
    arc.pipe(out);
    arc.directory(srcPath, folderAlias || path.basename(srcPath));
    arc.finalize();
  });
}

// ── Full project backup → local cloud folder ──────────────────────────────────

async function backupProjectToDrive(id, sendProgress) {
  const os               = require("os");
  const { PROJECTS_DIR } = global.CONST;

  const backupFolder = await getBackupFolder();
  if (!backupFolder) return { success: false, message: "No backup folder configured. Set it in Settings → Cloud Backup." };
  if (!await fs.pathExists(backupFolder)) return { success: false, message: `Backup folder not found: ${backupFolder}` };

  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!await fs.pathExists(cfgPath)) return { success: false, message: "Project not found" };
  const proj   = await fs.readJson(cfgPath);
  const def    = defaultBackupConfig(proj.projectType);
  const config = Object.assign({}, def, proj.googleDriveBackup || {});

  const progress = (msg) => { log.info("[Backup] " + msg); sendProgress && sendProgress(msg); };

  // Create: BackupFolder / ShieldPress Local / ProjectName / backup_TIMESTAMP
  const ts         = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destDir    = path.join(backupFolder, "ShieldPress Local", proj.name, `backup_${ts}`);
  await fs.ensureDir(destDir);
  progress(`Backup folder created: .../${proj.name}/backup_${ts}`);

  const tmpDir = path.join(os.tmpdir(), `spl-backup-${Date.now()}`);
  await fs.ensureDir(tmpDir);
  const results = [];

  try {
    // 1. Database export
    if (config.includeDatabase && proj.dbName) {
      if (!global.STATE.isDBRunning) {
        results.push("⚠ Database skipped (MariaDB not running)");
      } else {
        progress(`Exporting database: ${proj.dbName}...`);
        const sqlPath = path.join(destDir, `${proj.dbName}.sql`);
        try {
          await exportDbToFile(proj, sqlPath);
          results.push(`✓ ${proj.dbName}.sql`);
        } catch (e) {
          results.push(`✗ Database: ${e.message}`);
          log.err("Backup DB error: " + e.message);
        }
      }
    }

    // 2. Zip each configured folder and copy to dest
    const wwwDir  = path.join(PROJECTS_DIR, id, "www");
    const folders = config.folders || [];

    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      const src    = path.join(wwwDir, folder.replace(/\//g, path.sep));
      if (!await fs.pathExists(src)) {
        results.push(`⚠ ${folder} — not found, skipped`);
        continue;
      }

      const label   = folder.replace(/[\\/]/g, "-");
      const zipPath = path.join(tmpDir, `${label}.zip`);
      progress(`Zipping ${folder}... (${i + 1}/${folders.length})`);
      try {
        await zipFolder(src, zipPath, folder);
        await fs.copy(zipPath, path.join(destDir, `${label}.zip`));
        results.push(`✓ ${folder}`);
      } catch (e) {
        results.push(`✗ ${folder}: ${e.message}`);
        log.err(`Backup folder error (${folder}): ` + e.message);
      }
    }

    progress("✓ Backup complete! Sync tool will upload it automatically.");
    log.ok(`Local backup done: ${proj.name} → ${destDir}`);
    return { success: true, results, destDir };

  } catch (e) {
    log.err("Backup error: " + e.message);
    return { success: false, message: e.message, results };
  } finally {
    await fs.remove(tmpDir).catch(() => {});
  }
}

// DB-only backup (used on auto-stop)
async function backupDbToDrive(id, sendProgress) {
  const { PROJECTS_DIR } = global.CONST;

  const backupFolder = await getBackupFolder();
  if (!backupFolder || !await fs.pathExists(backupFolder)) return { success: false, message: "Backup folder not configured" };

  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!await fs.pathExists(cfgPath)) return { success: false, message: "Project not found" };
  const proj = await fs.readJson(cfgPath);
  if (!proj.dbName) return { success: false, message: "No database configured" };
  if (!global.STATE.isDBRunning) return { success: false, message: "MariaDB not running" };

  sendProgress && sendProgress(`Exporting database: ${proj.dbName}...`);

  const ts      = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const destDir = path.join(backupFolder, "ShieldPress Local", proj.name, `backup_${ts}`);
  await fs.ensureDir(destDir);

  try {
    const sqlPath = path.join(destDir, `${proj.dbName}.sql`);
    await exportDbToFile(proj, sqlPath);
    sendProgress && sendProgress(`✓ Database saved to backup folder`);
    log.ok(`DB backup: ${proj.dbName} → ${destDir}`);
    return { success: true };
  } catch (e) {
    log.err("DB backup error: " + e.message);
    return { success: false, message: e.message };
  }
}

module.exports = {
  getStatus,
  detectCloudFolders,
  getBackupFolder,
  saveBackupFolder,
  getProjectBackupConfig,
  saveProjectBackupConfig,
  backupProjectToDrive,
  backupDbToDrive,
  defaultBackupConfig,
};
