// src/main/backup.js
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");

async function directorySize(root) {
  let total = 0;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(async (entry) => {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(item);
    else if (entry.isFile()) total += (await fs.stat(item)).size;
  }));
  return total;
}

async function backupProject(id, onProgress = () => {}) {
  const archiver = require("archiver");
  const { PROJECTS_DIR, BACKUPS_DIR, NGINX_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Not found" };
  const proj = await fs.readJson(cfgPath);

  await fs.ensureDir(BACKUPS_DIR);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUPS_DIR, `${proj.name}_${ts}.zip`);
  const sourceDir = path.join(PROJECTS_DIR, id, "www");
  const total = await directorySize(sourceDir);

  return new Promise((resolve) => {
    const out = fs.createWriteStream(dest);
    const arc = archiver("zip", { zlib: { level: 6 } });
    out.on("close", () => {
      onProgress({ status: "done", projectId: id, processed: total, total, percent: 100 });
      log.ok(`Backup: ${dest}`);
      resolve({ success: true, path: dest, folder: path.dirname(dest), size: arc.pointer() });
    });
    arc.on("error", (e) => resolve({ success: false, message: e.message }));
    arc.pipe(out);
    onProgress({ status: "running", projectId: id, processed: 0, total, percent: 0 });
    arc.on("progress", (progress) => {
      const processed = progress.fs?.processedBytes || 0;
      const percent = total ? Math.min(99, Math.round((processed / total) * 100)) : null;
      onProgress({ status: "running", projectId: id, processed, total, percent });
    });
    arc.directory(sourceDir, "www");
    arc.file(cfgPath, { name: "project.json" });
    const nginxConf = path.join(
      NGINX_DIR,
      "conf",
      "servers",
      `${proj.domain}.conf`,
    );
    if (fs.existsSync(nginxConf)) arc.file(nginxConf, { name: "nginx.conf" });
    arc.finalize();
  });
}

async function getBackups() {
  const { BACKUPS_DIR } = global.CONST;
  await fs.ensureDir(BACKUPS_DIR);
  const files = await fs.readdir(BACKUPS_DIR);
  const result = [];
  for (const f of files) {
    if (!f.endsWith(".zip") && !f.endsWith(".sql")) continue;
    const fp = path.join(BACKUPS_DIR, f);
    const stat = await fs.stat(fp);
    result.push({
      name: f,
      path: fp,
      size: stat.size,
      createdAt: stat.birthtime,
    });
  }
  return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { backupProject, getBackups };
