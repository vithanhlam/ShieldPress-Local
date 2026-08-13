// src/main/ssl.js
const fs        = require("fs-extra");
const path      = require("path");
const https     = require("https");
const { spawn } = require("child_process");
const log       = require("./logger");
const platform  = require("./platform");

const MKCERT_URL =
  "https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-windows-amd64.exe";

function getMkcertPath() {
  return platform.executable("mkcert") || (platform.isWindows
    ? path.join(global.CONST.BIN_DIR, "mkcert", "mkcert.exe")
    : null);
}

// Follow redirects and download a file
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) =>
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", reject);
    get(url);
  });
}

async function downloadMkcert() {
  if (platform.isLinux) return { success: false, message: "Install mkcert with your package manager." };
  const dest = getMkcertPath();
  await fs.ensureDir(path.dirname(dest));
  log.info("Downloading mkcert...");
  try {
    await downloadFile(MKCERT_URL, dest);
    log.ok("mkcert downloaded.");
    return { success: true };
  } catch (e) {
    await fs.remove(dest).catch(() => {});
    return { success: false, message: e.message };
  }
}

function runCmd(exe, args, cwd) {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { cwd, stdio: "pipe" });
    let out = "", err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("close", (code) => resolve({ code, out, err }));
  });
}

async function installSSL({ id, domain }) {
  const { PROJECTS_DIR, NGINX_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");

  if (!(await fs.pathExists(cfgPath))) {
    return { success: false, output: "Project not found." };
  }

  const proj     = await fs.readJson(cfgPath);
  const mkcert   = getMkcertPath();
  const sslDir   = path.join(PROJECTS_DIR, id, "ssl");
  const certFile = path.join(sslDir, "cert.pem");
  const keyFile  = path.join(sslDir, "key.pem");
  let output = "";

  // 1. Auto-download mkcert if missing
  if (!mkcert || !fs.existsSync(mkcert)) {
    output += "mkcert not found — downloading...\n";
    const dl = await downloadMkcert();
    if (!dl.success) {
      return { success: false, output: output + "Download failed: " + dl.message };
    }
    output += "mkcert.exe downloaded.\n";
  }

  await fs.ensureDir(sslDir);

  // 2. Install local CA (first-time; silent on re-run)
  const caResult = await runCmd(mkcert, ["-install"], sslDir);
  output += (caResult.out + caResult.err).trim() + "\n";

  // 3. Generate cert for domain
  const genResult = await runCmd(
    mkcert,
    ["-cert-file", certFile, "-key-file", keyFile, domain],
    sslDir
  );
  output += (genResult.out + genResult.err).trim() + "\n";

  if (genResult.code !== 0) {
    return { success: false, output: output + "mkcert exited with code " + genResult.code };
  }
  if (!(await fs.pathExists(certFile)) || !(await fs.pathExists(keyFile))) {
    return { success: false, output: output + "Cert files missing after generation." };
  }

  // 4. Save ssl info to project.json
  proj.ssl = { enabled: true, certFile, keyFile };
  await fs.writeJson(cfgPath, proj, { spaces: 2 });

  // 5. Overwrite nginx conf — same port, now SSL (buildNginxConf reads proj.ssl)
  const { buildNginxConf } = require("./projects");
  const nginxConf = path.join(NGINX_DIR, "conf", "servers", `${domain}.conf`);
  await fs.writeFile(nginxConf, buildNginxConf(proj));
  output += `Nginx conf updated — listening on port ${proj.port} (SSL).\n`;

  // 6. Reload nginx
  if (platform.executable("nginx")) {
    await require("./services").reloadNginx();
    output += "Nginx reloaded.\n";
  }

  const httpsUrl = `https://${domain}:${proj.port}`;
  output += `\nDone! Open: ${httpsUrl}`;
  log.ok(`SSL installed for ${domain} port ${proj.port}`);
  return { success: true, output, httpsUrl };
}

async function removeSSL({ id, domain }) {
  const { PROJECTS_DIR, NGINX_DIR } = global.CONST;
  const cfgPath = path.join(PROJECTS_DIR, id, "project.json");

  if (!(await fs.pathExists(cfgPath))) {
    return { success: false, output: "Project not found." };
  }

  const proj = await fs.readJson(cfgPath);
  let output = "";

  // 1. Remove ssl cert files
  const sslDir = path.join(PROJECTS_DIR, id, "ssl");
  if (await fs.pathExists(sslDir)) {
    await fs.remove(sslDir);
    output += "SSL certificates removed.\n";
  }

  // 2. Clear ssl from project.json
  delete proj.ssl;
  await fs.writeJson(cfgPath, proj, { spaces: 2 });

  // 3. Rebuild nginx conf as plain HTTP (reuse buildNginxConf from projects)
  const { buildNginxConf } = require("./projects");
  const nginxConf = path.join(NGINX_DIR, "conf", "servers", `${domain}.conf`);
  await fs.writeFile(nginxConf, buildNginxConf(proj));
  output += "Nginx conf reverted to HTTP.\n";

  // 4. Reload nginx
  if (platform.executable("nginx")) {
    await require("./services").reloadNginx();
    output += "Nginx reloaded.\n";
  }

  log.ok(`SSL removed for ${domain}`);
  return { success: true, output };
}

module.exports = { installSSL, removeSSL, downloadMkcert, getMkcertPath };
