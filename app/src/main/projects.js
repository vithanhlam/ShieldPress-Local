// src/main/projects.js
const fs = require("fs-extra");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const log = require("./logger");
const svc = require("./services");
const platform = require("./platform");
const database = require("./database");
const HOSTS_FILE = platform.hostsFile();
const projectStartPromises = new Map();
const projectSizeCache = new Map();
const projectSizeInflight = new Map();
const execFileAsync = promisify(execFile);
const SIZE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

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

/** Prefer OS `du` on Linux; fall back to recursive Node walk. */
async function measureDirectorySize(root) {
  if (!(await fs.pathExists(root))) return 0;
  if (platform.isLinux) {
    try {
      const { stdout } = await execFileAsync("du", ["-sb", root], {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
      });
      const bytes = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
      if (Number.isFinite(bytes) && bytes >= 0) return bytes;
    } catch {
      // Fall through to Node walk when du is missing or fails.
    }
  }
  return directorySize(root);
}

function peekProjectSize(projectDir) {
  const cached = projectSizeCache.get(projectDir);
  if (!cached) return null;
  return cached.size;
}

function invalidateProjectSize(projectDir) {
  if (!projectDir) {
    projectSizeCache.clear();
    projectSizeInflight.clear();
    return;
  }
  projectSizeCache.delete(projectDir);
  projectSizeInflight.delete(projectDir);
}

async function computeProjectSize(projectDir) {
  const cached = projectSizeCache.get(projectDir);
  if (cached && Date.now() - cached.time < SIZE_CACHE_TTL) return cached.size;
  if (projectSizeInflight.has(projectDir)) return projectSizeInflight.get(projectDir);

  const pending = measureDirectorySize(projectDir)
    .then((size) => {
      projectSizeCache.set(projectDir, { size, time: Date.now() });
      return size;
    })
    .finally(() => projectSizeInflight.delete(projectDir));
  projectSizeInflight.set(projectDir, pending);
  return pending;
}

async function getProjectSize(id) {
  const { PROJECTS_DIR } = global.CONST;
  const projectDir = path.join(PROJECTS_DIR, id);
  if (!(await fs.pathExists(path.join(projectDir, "project.json")))) {
    return { success: false, message: "Not found" };
  }
  const sizeBytes = await computeProjectSize(projectDir);
  return { success: true, id, sizeBytes };
}

async function getProjectSizes(ids = []) {
  const list = Array.isArray(ids) ? ids : [];
  const sizes = {};
  await Promise.all(list.map(async (id) => {
    const r = await getProjectSize(id);
    if (r.success) sizes[id] = r.sizeBytes;
  }));
  return { success: true, sizes };
}

// Sanitize project name to a safe directory name:
// "sonkimgroup.com" → "sonkimgroup_com", "Sơn Kim" → "son_kim"
function sanitizeDirName(name) {
  let s = name.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // remove diacritics
  s = s.replace(/đ/g, "d").replace(/Đ/g, "D"); // Vietnamese đ/Đ
  s = s.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "_"); // replace non-alphanumeric with _
  s = s.replace(/^_+|_+$/g, "");     // trim leading/trailing _
  return s || "project";
}

// Generate a unique project directory name from project name
async function getUniqueProjectDir(projectsDir, name) {
  const base = sanitizeDirName(name);
  let dirName = base;
  let counter = 1;
  while (await fs.pathExists(path.join(projectsDir, dirName))) {
    dirName = `${base}_${counter}`;
    counter++;
  }
  return dirName;
}

async function sanitizeProjectSsl(proj, cfgPath) {
  if (!proj?.ssl?.enabled) return proj;

  const certExists = proj.ssl.certFile && fs.existsSync(proj.ssl.certFile);
  const keyExists = proj.ssl.keyFile && fs.existsSync(proj.ssl.keyFile);
  if (certExists && keyExists) return proj;

  log.warn(
    `SSL disabled for ${proj.domain || proj.id}: certificate files not found`,
  );
  delete proj.ssl;
  delete proj.sslPort;

  if (cfgPath) {
    await fs.writeJson(cfgPath, proj, { spaces: 2 });
  }
  return proj;
}

function hostsContainsDomain(content, domain) {
  const needle = String(domain || "").trim().toLowerCase();
  if (!needle) return true;
  return String(content || "").split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return false;
    return trimmed.split(/\s+/).slice(1).some((host) => host.toLowerCase() === needle);
  });
}

function isAdmin() {
  try {
    fs.accessSync(HOSTS_FILE, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function runWithTimeout(start, timeoutMs, onTimeout) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      try { onTimeout(); } catch {}
      log.warn("Hosts update timed out");
      finish();
    }, timeoutMs);
    start((error) => {
      clearTimeout(timer);
      if (error) log.warn("Hosts update failed: " + (error.message || error));
      finish();
    });
  });
}

async function addHost(domain) {
  try {
    const content = await fs.readFile(HOSTS_FILE, "utf8");
    if (hostsContainsDomain(content, domain)) return;

    try {
      await fs.appendFile(HOSTS_FILE, `\r\n127.0.0.1\t${domain}\r\n`);
      log.ok(`Added ${domain} to hosts`);
      return;
    } catch (e) {
      log.warn("No write permission for hosts file: " + e.message);
    }

    // Do not block project start on UAC/pkexec. Elevation can hang forever
    // if the prompt is dismissed or PowerShell quoting waits for input.
    if (platform.isWindows) {
      const os = require("os");
      const script = path.join(os.tmpdir(), `shieldpress-hosts-${process.pid}-${Date.now()}.ps1`);
      const escapedHosts = HOSTS_FILE.replace(/'/g, "''");
      const escapedDomain = String(domain).replace(/'/g, "''");
      await fs.writeFile(
        script,
        `$hostsPath = '${escapedHosts}'\n` +
          `$line = "127.0.0.1` + "\t" + `'${escapedDomain}'\n` +
          `$text = Get-Content -LiteralPath $hostsPath -Raw\n` +
          `if ($text -notmatch [regex]::Escape('${escapedDomain}')) { Add-Content -LiteralPath $hostsPath -Value $line }\n`,
      );
      const { spawn } = require("child_process");
      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${script}"'`,
      ], { windowsHide: true, stdio: "ignore", detached: true });
      child.unref();
      log.warn("Hosts update requested in background; project start will continue");
      return;
    }

    await runWithTimeout((done) => {
      const child = require("child_process").spawn("pkexec", ["tee", "-a", HOSTS_FILE], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", done);
      child.on("close", (code) => done(code ? new Error(stderr.trim() || `pkexec exited ${code}`) : null));
      child.stdin.end(`\n127.0.0.1\t${domain}\n`);
    }, 8000, () => {});
  } catch (e) {
    log.warn("Cannot update hosts: " + e.message);
  }
}

async function removeHost(domain) {
  try {
    const content = await fs.readFile(HOSTS_FILE, "utf8");
    const filtered = content.split(/\r?\n/).filter((l) => !l.includes(domain));
    const updated = filtered.join(platform.isWindows ? "\r\n" : "\n");
    try {
      await fs.writeFile(HOSTS_FILE, updated, "utf8");
    } catch (error) {
      if (platform.isWindows) throw error;
      const temp = path.join(require("os").tmpdir(), `shieldpress-hosts-${process.pid}`);
      await fs.writeFile(temp, updated, "utf8");
      await new Promise((resolve, reject) => {
        const child = require("child_process").spawn("pkexec", ["cp", temp, HOSTS_FILE], { stdio: "ignore" });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pkexec exited ${code}`)));
      });
      await fs.remove(temp);
    }
    log.ok(`Removed ${domain} from hosts`);
  } catch (e) {
    log.warn("Cannot update hosts: " + e.message);
  }
}

function buildNginxConf(proj) {
  const { PROJECTS_DIR, NGINX_DIR } = global.CONST;
  const type = proj.projectType || "php";

  // Laravel uses public/ as web root
  const baseDir = type === "laravel"
    ? path.join(PROJECTS_DIR, proj.id, "www", "public")
    : path.join(PROJECTS_DIR, proj.id, "www");

  const wwwDir = baseDir.replace(/\\/g, "/").replace(/ /g, "\\ ");

  // Wrap trong quotes nếu có space
  const rootDir = wwwDir.includes(" ") ? `"${wwwDir}"` : wwwDir;

  // Get PHP-CGI port for this project's PHP version
  const phpPort = svc.getPhpPort(proj.phpVersion || "8.3");
  const fastcgiParams = path.join(NGINX_DIR, "fastcgi_params").replace(/\\/g, "/");

  let locationBlock;
  if (type === "nextjs" || type === "node") {
    locationBlock = `
    location / {
        proxy_pass http://127.0.0.1:${proj.nodePort || 3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_connect_timeout 10s;
        proxy_read_timeout 30s;
    }`;
  } else {
    locationBlock = `
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ \\.php$ {
        fastcgi_pass 127.0.0.1:${phpPort};
        include "${fastcgiParams}";
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_read_timeout ${proj.nginxTimeout || 300};
        fastcgi_buffers 16 16k;
        fastcgi_buffer_size 32k;
    }
    location ~ /\\.ht { deny all; }`;
  }

  const ssl =
    proj.ssl?.enabled &&
    proj.ssl?.certFile &&
    proj.ssl?.keyFile &&
    fs.existsSync(proj.ssl.certFile) &&
    fs.existsSync(proj.ssl.keyFile);
  const listenLine = ssl ? `listen ${proj.port} ssl;` : `listen ${proj.port};`;
  const sslBlock = ssl
    ? `\n    ssl_certificate     ${proj.ssl.certFile.replace(/\\/g, "/")};
    ssl_certificate_key ${proj.ssl.keyFile.replace(/\\/g, "/")};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 10m;`
    : "";

  return `# Project: ${proj.name} | ID: ${proj.id} | PHP: ${proj.phpVersion || "8.3"}${ssl ? " | SSL: enabled" : ""}
server {
    ${listenLine}
    server_name ${proj.domain};
${sslBlock}
    root ${rootDir};
    index index.php index.html index.htm;

    client_max_body_size ${proj.uploadLimit || "10G"};
    client_body_timeout ${proj.nginxTimeout || 300};

    access_log logs/${proj.id}.access.log;
    error_log  logs/${proj.id}.error.log warn;
${locationBlock}
}
`;
}

// ─── Project list (lazy read, fast for 100+ projects) ────────────────────────
let _projectCache = null;
let _cacheTime = 0;
const CACHE_TTL = 2000; // 2s

function invalidateProjectListCache() {
  _projectCache = null;
  _cacheTime = 0;
}

function attachListFields(list) {
  const { runningProjects } = global.STATE;
  return list.map((p) => ({
    ...p,
    isRunning: !!runningProjects[p.id],
    sizeBytes: peekProjectSize(p.path),
  }));
}

async function getProjects() {
  const { PROJECTS_DIR } = global.CONST;

  if (!fs.existsSync(PROJECTS_DIR)) return [];

  if (_projectCache && Date.now() - _cacheTime < CACHE_TTL) {
    return attachListFields(_projectCache);
  }

  const dirs = await fs.readdir(PROJECTS_DIR);
  const list = [];

  await Promise.all(
    dirs.map(async (d) => {
      const cf = path.join(PROJECTS_DIR, d, "project.json");
      if (!(await fs.pathExists(cf))) return;
      try {
        const c = await sanitizeProjectSsl(await fs.readJson(cf), cf);
        c.path = path.join(PROJECTS_DIR, d);
        // Detect WordPress installation by checking wp-config.php on disk
        const wpCfg = path.join(PROJECTS_DIR, d, "www", "wp-config.php");
        if (await fs.pathExists(wpCfg)) c.wordpressInstalled = true;
        list.push(c);
      } catch (e) {
        log.warn(`Bad project.json in ${d}`);
      }
    }),
  );

  list.sort((a, b) => {
    const sa = a.starred ? 1 : 0;
    const sb = b.starred ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  _projectCache = list;
  _cacheTime = Date.now();
  return attachListFields(list);
}

async function createProject(data) {
  const { name, domain, phpVersion, dbName, projectType, nodePort, tags } =
    data;
  const { PROJECTS_DIR, NGINX_DIR, CONFIG_FILE, MARIADB_DIR } = global.CONST;

  if (!global.STATE.isDBRunning) {
    const svc = require("./services");
    log.info("MariaDB not running, starting...");
    const r = await svc.startMariaDB();
    if (!r.success)
      return {
        success: false,
        message:
          "MariaDB not running, please start MariaDB first.",
      };
  }

  const cfg = await fs.readJson(CONFIG_FILE);
  const dom =
    domain || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.local`;
  const db = dbName || `db_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

  // Directory name derived from domain: "sonkimgroup.com" → "sonkimgroup_com"
  const dirName = await getUniqueProjectDir(PROJECTS_DIR, dom);
  const id = dirName;
  const dir = path.join(PROJECTS_DIR, id);

  await fs.ensureDir(path.join(dir, "www"));
  await fs.ensureDir(path.join(dir, "logs"));
  await fs.ensureDir(path.join(dir, "config"));
  const type = projectType || "php";
  const port = await svc.getFreePort(cfg.nginx.base_port || 8000);

  const projCfg = {
    id,
    name,
    domain: dom,
    phpVersion: phpVersion || "8.3",
    dbName: db,
    dbUser: "root",
    dbPassword: platform.isWindows
      ? (cfg.mysql.root_password === undefined ? "root" : cfg.mysql.root_password)
      : "",
    dbPort: cfg.mysql?.port || (process.platform === "win32" ? 3306 : 3307),
    projectType: type,
    nodePort: nodePort || 3000,
    port,
    uploadLimit: "10G",
    nginxTimeout: 300,
    tags: Array.isArray(tags) ? tags : [],
    createdAt: new Date().toISOString(),
    status: "stopped",
    ...(type === "laravel" ? { laravelInstalled: false } : {}),
  };

  // Create DB if MariaDB running
  if (global.STATE.isDBRunning) {
    try {
      await database.mysqlExec(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      log.ok(`DB created: ${db}`);
    } catch (error) { log.warn("Create DB: " + error); }
  }

  // Write per-project nginx conf
  const nginxConfPath = path.join(NGINX_DIR, "conf", "servers", `${dom}.conf`);
  await fs.writeFile(nginxConfPath, buildNginxConf(projCfg));
  log.ok(`Nginx conf: ${nginxConfPath}`);

  // Default index
  if (type === "laravel") {
    // Laravel serves from public/ — create that dir with a placeholder
    await fs.ensureDir(path.join(dir, "www", "public"));
    await fs.writeFile(
      path.join(dir, "www", "public", "index.php"),
      `<?php\n// Laravel placeholder — open the Laravel panel to install.\necho '<h2>Laravel project created.</h2><p>Click the <b>Laravel</b> button in the project card to install Laravel.</p>';\n`,
    );
  } else {
    const indexFile =
      type === "php" || type === "wordpress"
        ? { name: "index.php", content: `<?php\n// ${name}\nphpinfo();\n` }
        : {
          name: "index.html",
          content: `<!DOCTYPE html><html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>`,
        };
    await fs.writeFile(path.join(dir, "www", indexFile.name), indexFile.content);
  }

  await fs.writeJson(path.join(dir, "project.json"), projCfg, { spaces: 2 });
  invalidateProjectListCache();
  log.ok(`Project created: ${name} port=${port}`);
  return { success: true, project: projCfg };
}

async function deleteProject(id) {
  const { PROJECTS_DIR, NGINX_DIR, MARIADB_DIR } = global.CONST;

  // Stop project first (non-blocking on error)
  try {
    await stopProject(id);
  } catch (e) { }

  const projJsonPath = path.join(PROJECTS_DIR, id, "project.json");
  if (await fs.pathExists(projJsonPath)) {
    const proj = await fs.readJson(projJsonPath);

    // Drop DB (NO backup - just drop as requested)
    if (global.STATE.isDBRunning && proj.dbName) {
      await database.mysqlExec(`DROP DATABASE IF EXISTS \`${proj.dbName}\``).catch(() => {});
      log.ok(`DB dropped: ${proj.dbName}`);
    }

    // Remove nginx conf
    const nginxConf = path.join(
      NGINX_DIR,
      "conf",
      "servers",
      `${proj.domain}.conf`,
    );
    await fs.remove(nginxConf).catch(() => { });

    // Remove hosts
    if (proj.domain) await removeHost(proj.domain);
  }

  // Remove project dir with retries (Windows file lock)
  const projDir = path.join(PROJECTS_DIR, id);
  for (let i = 0; i < 5; i++) {
    try {
      await fs.remove(projDir);
      break;
    } catch (e) {
      if (i === 4) {
        log.err(`Cannot remove ${projDir}: ${e.message}`);
      }
      await svc.delay(700);
    }
  }

  // Reload nginx without restart (fast)
  if (global.STATE.isNginxRunning) await svc.reloadNginx();

  invalidateProjectListCache();
  invalidateProjectSize(projDir);
  return { success: true };
}

// ─── DB Backup ───────────────────────────────────────────────────────────────
async function backupProjectDb(id, onProgress = () => {}) {
  const { PROJECTS_DIR } = global.CONST;
  if (!global.STATE.isDBRunning) {
    return { success: false, message: "MariaDB is not running" };
  }

  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false, message: "Project not found" };

  const proj = await fs.readJson(cfgPath);
  if (!proj.dbName) return { success: false, message: "Project has no database" };

  const mysqldump = platform.executable("mysqldump");
  if (!mysqldump) {
    log.warn(`mysqldump not found: ${mysqldump}`);
    return { success: false, message: "mysqldump not found" };
  }

  const backupDir = path.join(PROJECTS_DIR, id, "backup");
  await fs.ensureDir(backupDir);
  const dumpFile = path.join(backupDir, "db_backup.sql");

  const stats = await database.mysqlExec(
    `SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA='${proj.dbName.replace(/'/g, "''")}'`,
  ).catch(() => "0");
  const total = Number(stats.trim().split(/\r?\n/).pop()) || 0;

  return new Promise((resolve) => {
    const proc = require("child_process").spawn(mysqldump, [
      ...database.connectionArgs(),
      proj.dbName,
      `--result-file=${dumpFile}`,
    ]);
    let stderr = "";
    let lastPercent = -1;
    onProgress({ projectId: id, dbName: proj.dbName, status: "running", processed: 0, total, percent: 0 });
    const timer = setInterval(async () => {
      const processed = (await fs.stat(dumpFile).catch(() => ({ size: 0 }))).size;
      const percent = total ? Math.min(99, Math.round((processed / total) * 100)) : null;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress({ projectId: id, dbName: proj.dbName, status: "running", processed, total, percent });
      }
    }, 400);
    proc.stderr.on("data", (data) => { stderr += data; });
    proc.on("error", (error) => {
      clearInterval(timer);
      onProgress({ projectId: id, dbName: proj.dbName, status: "failed", message: error.message });
      resolve({ success: false, message: error.message });
    });
    proc.on("close", async (code) => {
      clearInterval(timer);
      if (code !== 0) {
        const message = stderr.trim() || `mysqldump exited ${code}`;
        log.warn(`DB backup failed [${proj.dbName}]: ${message}`);
        onProgress({ projectId: id, dbName: proj.dbName, status: "failed", message });
        return resolve({ success: false, message });
      }
      const size = (await fs.stat(dumpFile)).size;
      onProgress({ projectId: id, dbName: proj.dbName, status: "done", processed: size, total: size, percent: 100 });
      log.ok(`DB backup saved: ${dumpFile}`);
      resolve({ success: true, path: dumpFile, folder: backupDir, size });
    });
  });
}

// ─── Start/Stop ───────────────────────────────────────────────────────────────
async function getProjectById(id) {
  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return null;
  return sanitizeProjectSsl(await fs.readJson(cfgPath), cfgPath);
}

async function startProjectUnlocked(id) {
  const { NGINX_DIR } = global.CONST;
  const proj = await getProjectById(id);
  if (!proj) return { success: false, message: "Project not found" };
  await sanitizeProjectSsl(proj, path.join(global.CONST.PROJECTS_DIR, id, "project.json"));

  log.info(
    `Starting project: ${proj.name} [${proj.projectType}] port=${proj.port}`,
  );

  // Ensure MariaDB
  if (!global.STATE.isDBRunning) {
    const r = await svc.startMariaDB();
    if (!r.success)
      return { success: false, message: "MariaDB failed: " + r.message };
  }

  // Ensure PHP-CGI for this project's PHP version
  const phpVersion = proj.phpVersion || "8.3";
  if (!global.STATE.isPhpRunning) {
    const r = await svc.startPhpCgi(phpVersion);
    if (!r.success)
      return { success: false, message: `PHP-CGI ${phpVersion} failed: ` + r.message };
  } else {
    // Start the specific version if not already running
    await svc.startPhpCgi(phpVersion);
  }

  await addHost(proj.domain);

  // Apply php.ini settings
  const phpIni = path.join(global.CONST.getPhpDir(phpVersion), "php.ini");
  if (fs.existsSync(phpIni)) {
    let ini = await fs.readFile(phpIni, "utf8");
    ini = ini
      .replace(
        /memory_limit\s*=.*/,
        `memory_limit = ${proj.uploadLimit ? "1G" : "1G"}`,
      )
      .replace(
        /upload_max_filesize\s*=.*/,
        `upload_max_filesize = ${proj.uploadLimit || "2G"}`,
      )
      .replace(
        /post_max_size\s*=.*/,
        `post_max_size = ${proj.uploadLimit || "2G"}`,
      )
      .replace(/max_execution_time\s*=.*/, `max_execution_time = 10000`);
    await fs.writeFile(phpIni, ini);
  }

  // Write/refresh nginx conf
  const nginxConfPath = path.join(
    NGINX_DIR,
    "conf",
    "servers",
    `${proj.domain}.conf`,
  );
  await fs.writeFile(nginxConfPath, buildNginxConf(proj));

  // Start or reload nginx
  if (!global.STATE.isNginxRunning) {
    const r = await svc.startNginx();
    if (!r.success) {
      return { success: false, message: "Nginx failed: " + r.message };
    }
  } else {
    const r = await svc.reloadNginx();
    if (!r.success) {
      // Config bad - report error
      return { success: false, message: "Nginx config error: " + r.message };
    }
  }

  // Verify port actually listens
  const portOpen = await svc.waitPort(proj.port, 10);
  if (!portOpen) {
    log.warn(`Port ${proj.port} not responding after start`);
    return {
      success: false,
      message: `Website did not respond on port ${proj.port}. Check the Nginx log.`,
    };
  }

  global.STATE.runningProjects[id] = { startedAt: Date.now() };

  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  const c = await fs.readJson(cfgPath);
  c.status = "running";
  await fs.writeJson(cfgPath, c, { spaces: 2 });
  invalidateProjectListCache();

  const url = `http://${proj.domain}:${proj.port}`;
  log.ok(`Project started: ${url}`);
  return { success: true, message: url, url, port: proj.port };
}

async function startProject(id) {
  if (projectStartPromises.has(id)) return projectStartPromises.get(id);
  const promise = startProjectUnlocked(id);
  projectStartPromises.set(id, promise);
  try {
    return await promise;
  } finally {
    projectStartPromises.delete(id);
  }
}

async function stopProject(id) {
  delete global.STATE.runningProjects[id];
  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  if (await fs.pathExists(cfgPath)) {
    const c = await fs.readJson(cfgPath);
    c.status = "stopped";
    await fs.writeJson(cfgPath, c, { spaces: 2 });
  }
  invalidateProjectListCache();
  log.info(`Project ${id} stopped`);
  return { success: true };
}

async function updateProjectSettings(data) {
  const { id, uploadLimit, nginxTimeout, nodePort, tags, name, phpVersion } = data;
  const { PROJECTS_DIR, NGINX_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Not found" };

  const proj = await fs.readJson(cfgPath);
  if (uploadLimit) proj.uploadLimit = uploadLimit;
  if (nginxTimeout) proj.nginxTimeout = parseInt(nginxTimeout);
  if (nodePort) proj.nodePort = parseInt(nodePort);
  if (tags !== undefined) proj.tags = tags;
  if (name) proj.name = name;
  if (phpVersion) proj.phpVersion = phpVersion;

  await fs.writeJson(cfgPath, proj, { spaces: 2 });

  const nginxConf = path.join(
    NGINX_DIR,
    "conf",
    "servers",
    `${proj.domain}.conf`,
  );
  await fs.writeFile(nginxConf, buildNginxConf(proj));
  if (global.STATE.isNginxRunning) await svc.reloadNginx();

  // Apply upload limit to php.ini
  if (uploadLimit) {
    const phpIni = path.join(global.CONST.getPhpDir(proj.phpVersion || "8.3"), "php.ini");
    if (fs.existsSync(phpIni)) {
      let ini = await fs.readFile(phpIni, "utf8");
      const set = (key, val) => {
        const re = new RegExp(`^\\s*;?\\s*${key}\\s*=.*`, "m");
        return ini.match(re)
          ? ini.replace(re, `${key} = ${val}`)
          : ini + `\n${key} = ${val}`;
      };
      ini = set("upload_max_filesize", uploadLimit);
      ini = set("post_max_size", uploadLimit);
      await fs.writeFile(phpIni, ini);
      // Restart PHP để apply
      const svc = require("./services");
      await svc.restartPhpCgi(proj.phpVersion || "8.3");
    }
  }

  invalidateProjectListCache();
  return { success: true };
}

async function getNginxConfig(id) {
  const { NGINX_DIR, PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, content: "# project not found" };
  const proj = await fs.readJson(cfgPath);
  const p = path.join(NGINX_DIR, "conf", "servers", `${proj.domain}.conf`);
  const content = fs.existsSync(p)
    ? await fs.readFile(p, "utf8")
    : buildNginxConf(proj);
  return { success: true, content, domain: proj.domain };
}

async function saveNginxConfig({ id, content }) {
  const { NGINX_DIR, PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false };
  const proj = await fs.readJson(cfgPath);
  const p = path.join(NGINX_DIR, "conf", "servers", `${proj.domain}.conf`);
  await fs.writeFile(p, content);
  invalidateProjectListCache();
  return svc.reloadNginx();
}

// Debug: get all relevant logs for a project
async function getProjectDebugInfo(id) {
  const { PROJECTS_DIR, NGINX_DIR, LOGS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return { success: false };
  const proj = await fs.readJson(cfgPath);

  const readTail = async (file, lines = 100) => {
    if (!fs.existsSync(file)) return `# File not found: ${file}`;
    const c = await fs.readFile(file, "utf8");
    return c.split("\n").slice(-lines).join("\n");
  };

  return {
    success: true,
    project: proj,
    logs: {
      nginx_error: await readTail(
        path.join(NGINX_DIR, "logs", `${id}.error.log`),
        100,
      ),
      nginx_access: await readTail(
        path.join(NGINX_DIR, "logs", `${id}.access.log`),
        50,
      ),
      wp_debug: await readTail(
        path.join(PROJECTS_DIR, id, "www", "wp-content", "debug.log"),
        100,
      ),
      mariadb: await readTail(path.join(LOGS_DIR, "mariadb.log"), 50),
      app: global.STATE.logBuffer.slice(-100).join("\n"),
    },
    nginxConf: (await getNginxConfig(id)).content,
  };
}

// ─── Node.js / NPM Tools ────────────────────────────────────────────────────────
async function runNodeTool({ id, cmd }) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Not found" };

  const proj = await fs.readJson(cfgPath);
  const wwwDir = path.join(PROJECTS_DIR, id, "www");

  try {
    const { spawn } = require("child_process");
    log.info(`Opening terminal for ${proj.name} with command: ${cmd || "Terminal"}`);

    const terminal = platform.buildExternalTerminalLaunch(wwwDir, cmd || "");
    if (!terminal) {
      throw new Error(
        "No terminal emulator found. Install gnome-terminal, ptyxis, or terminator."
      );
    }

    const p = spawn(terminal.bin, terminal.args, {
      cwd: wwwDir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: platform.envWithDeveloperPath(process.env),
    });
    p.on("error", (err) => log.err("Terminal spawn error: " + err.message));
    p.unref();

    return { success: true };
  } catch (err) {
    log.err("Failed to open terminal: " + err.message);
    return { success: false, message: err.message };
  }
}

// ─── Open project in external editor ────────────────────────────────────────
function detectEditor(customEditorPath) {
  // If user configured a custom editor path, use it
  if (customEditorPath && fs.existsSync(customEditorPath)) {
    const name = path.basename(customEditorPath, path.extname(customEditorPath));
    return { name, cmd: customEditorPath, args: [] };
  }

  if (platform.isLinux) {
    for (const [name, command] of [["VS Code", "code"], ["VSCodium", "codium"], ["Sublime Text", "subl"], ["Kate", "kate"], ["Gedit", "gedit"]]) {
      const found = platform.findCommand(command);
      if (found) return { name, cmd: found, args: [] };
    }
    return { name: "System file manager", cmd: platform.findCommand("xdg-open") || "xdg-open", args: [] };
  }

  // VS Code
  const codePaths = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
  ];
  for (const p of codePaths) {
    if (fs.existsSync(p)) return { name: "VS Code", cmd: p, args: [] };
  }
  try {
    require("child_process").execSync("where code.cmd", { stdio: "ignore" });
    return { name: "VS Code", cmd: "code.cmd", args: [] };
  } catch {}

  // Notepad++
  const nppPaths = [
    "C:\\Program Files\\Notepad++\\notepad++.exe",
    "C:\\Program Files (x86)\\Notepad++\\notepad++.exe",
  ];
  for (const p of nppPaths) {
    if (fs.existsSync(p)) return { name: "Notepad++", cmd: p, args: [] };
  }

  // Sublime Text
  const sublimePaths = [
    "C:\\Program Files\\Sublime Text\\subl.exe",
    "C:\\Program Files\\Sublime Text 3\\subl.exe",
  ];
  for (const p of sublimePaths) {
    if (fs.existsSync(p)) return { name: "Sublime Text", cmd: p, args: [] };
  }

  return { name: "Notepad", cmd: "notepad.exe", args: [] };
}

async function openProjectInEditor(id) {
  const { PROJECTS_DIR, CONFIG_FILE } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Project not found" };

  const proj = await fs.readJson(cfgPath);
  const wwwDir = path.join(PROJECTS_DIR, id, "www");

  // Read custom editor from config if set
  let customEditor = null;
  try {
    const cfg = await fs.readJson(CONFIG_FILE);
    customEditor = cfg.editor_path || null;
  } catch {}

  const editor = detectEditor(customEditor);
  log.info(`Opening ${proj.name} in ${editor.name}`);

  try {
    const { spawn } = require("child_process");
    const p = spawn(editor.cmd, [wwwDir], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    p.unref();
    return { success: true, editor: editor.name, message: `Opened in ${editor.name}` };
  } catch (err) {
    log.warn(`Editor spawn: ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function getDetectedEditor() {
  let customEditor = null;
  try {
    const cfg = await fs.readJson(global.CONST.CONFIG_FILE);
    customEditor = cfg.editor_path || null;
  } catch {}
  const editor = detectEditor(customEditor);
  return { name: editor.name, cmd: editor.cmd };
}

async function toggleStar(id) {
  const { PROJECTS_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath)))
    return { success: false, message: "Not found" };
  const cfg = await fs.readJson(cfgPath);
  cfg.starred = !cfg.starred;
  await fs.writeJson(cfgPath, cfg, { spaces: 2 });
  invalidateProjectListCache();
  return { success: true, starred: cfg.starred };
}

module.exports = {
  getProjects,
  getProjectSize,
  getProjectSizes,
  invalidateProjectListCache,
  invalidateProjectSize,
  measureDirectorySize,
  peekProjectSize,
  toggleStar,
  createProject,
  deleteProject,
  startProject,
  stopProject,
  backupProjectDb,
  updateProjectSettings,
  getNginxConfig,
  saveNginxConfig,
  getProjectDebugInfo,
  buildNginxConf,
  hostsContainsDomain,
  sanitizeProjectSsl,
  runNodeTool,
  openProjectInEditor,
  getDetectedEditor,
};
