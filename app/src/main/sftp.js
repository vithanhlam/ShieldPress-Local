// src/main/sftp.js
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const log = require("./logger");
const platform = require("./platform");
const vaultCrypto = require("./credential-vault");

// Encryption key derived from machine ID
const ALGO = "aes-256-gcm";
const KEY_SOURCE = require("os").hostname() + "-shieldpress-sftp-key-v1";
const KEY = crypto.createHash("sha256").update(KEY_SOURCE).digest();

function encryptLegacy(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + ":" + tag + ":" + encrypted;
}

function decryptLegacy(data) {
  try {
    const [ivHex, tagHex, encrypted] = data.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return "";
  }
}

let vaultKey = null;

function getRemoteDataDir() {
  const dir = path.join(global.CONST.DATA_DIR, "remote-connections");
  fs.ensureDirSync(dir, { mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const legacyFiles = [
    [path.join(global.CONST.DATA_DIR, "sftp_connections.json"), path.join(dir, "connections.json")],
    [path.join(global.CONST.DATA_DIR, "sftp_vault.json"), path.join(dir, "vault.json")],
  ];
  for (const [legacy, destination] of legacyFiles) {
    if (fs.existsSync(legacy) && !fs.existsSync(destination)) {
      try { fs.moveSync(legacy, destination); } catch {}
    }
  }
  return dir;
}

function getVaultFile() {
  return path.join(getRemoteDataDir(), "vault.json");
}

async function readVaultMetadata() {
  try { return await fs.readJson(getVaultFile()); } catch { return null; }
}

async function getVaultStatus() {
  const configured = !!(await readVaultMetadata());
  return { success: true, configured, unlocked: configured && !!vaultKey };
}

async function setupVault(masterPassword) {
  if (String(masterPassword || "").length < 12) {
    return { success: false, message: "Master Password must contain at least 12 characters" };
  }
  if (await readVaultMetadata()) {
    return { success: false, message: "Credential vault is already configured" };
  }
  const created = vaultCrypto.createMetadata(masterPassword);
  await fs.ensureDir(global.CONST.DATA_DIR);
  await fs.writeJson(getVaultFile(), created.metadata, { spaces: 2, mode: 0o600 });
  await fs.chmod(getVaultFile(), 0o600).catch(() => {});
  vaultKey = created.key;
  await migrateLegacyPasswords();
  return { success: true, configured: true, unlocked: true };
}

async function unlockVault(masterPassword) {
  const metadata = await readVaultMetadata();
  if (!metadata) return { success: false, message: "Master Password has not been set" };
  try {
    vaultKey = vaultCrypto.unlock(masterPassword, metadata);
    await migrateLegacyPasswords();
    return { success: true, configured: true, unlocked: true };
  } catch {
    vaultKey = null;
    return { success: false, message: "Invalid Master Password" };
  }
}

async function lockVault() {
  vaultKey = null;
  for (const id of Object.keys(activeConnections)) await disconnect(id);
  return { success: true, configured: !!(await readVaultMetadata()), unlocked: false };
}

async function migrateLegacyPasswords() {
  if (!vaultKey) return;
  const file = getConnectionsFile();
  if (!(await fs.pathExists(file))) return;
  let changed = false;
  const conns = await fs.readJson(file);
  for (const conn of conns) {
    if (!conn.password || String(conn.password).startsWith("v2:")) continue;
    const plain = decryptLegacy(conn.password);
    if (plain) {
      conn.password = vaultCrypto.seal(plain, vaultKey);
      changed = true;
    }
  }
  if (changed) await writeConnections(conns);
}

async function writeConnections(conns) {
  const file = getConnectionsFile();
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, conns, { spaces: 2, mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

// ─── Connection Store ────────────────────────────────────────────────────────
function getConnectionsFile() {
  return path.join(getRemoteDataDir(), "connections.json");
}

async function getConnections() {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return { success: true, connections: [] };
  try {
    const raw = await fs.readFile(file, "utf8");
    const conns = JSON.parse(raw);
    await fs.chmod(file, 0o600).catch(() => {});
    // Decrypt passwords for display (masked)
    const safe = conns.map((c) => ({
      ...c,
      password: c.password ? "••••••••" : "",
      hasPassword: !!c.password,
      credentialState: !c.password
        ? "none"
        : String(c.password).startsWith("v2:")
          ? "vault"
          : decryptLegacy(c.password) ? "legacy-migratable" : "legacy-unavailable",
      hasKey: !!c.privateKey,
      lastBrowsedPath: c.lastBrowsedPath || "",
    }));
    return { success: true, connections: safe };
  } catch {
    return { success: true, connections: [] };
  }
}

async function saveConnection(data) {
  const file = getConnectionsFile();
  let conns = [];
  if (fs.existsSync(file)) {
    try {
      conns = JSON.parse(await fs.readFile(file, "utf8"));
    } catch { conns = []; }
  }

  const existing = conns.findIndex((c) => c.id === data.id);
  if (data.password && !vaultKey) {
    return { success: false, code: "VAULT_LOCKED", message: "Unlock the credential vault before saving a password" };
  }
  const conn = {
    id: data.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: data.name || "Unnamed",
    type: data.type || "sftp", // sftp | ftp
    host: data.host,
    port: parseInt(data.port) || (data.type === "ftp" ? 21 : 22),
    username: data.username,
    password: data.password ? vaultCrypto.seal(data.password, vaultKey) : (existing >= 0 ? conns[existing].password : ""),
    secure: data.type === "ftp" ? !!data.secure : false,
    privateKey: data.privateKey || "",
    remotePath: data.remotePath || "/",
    lastBrowsedPath: data.lastBrowsedPath || (existing >= 0 ? conns[existing].lastBrowsedPath : "") || "",
    projectId: data.projectId || "",
    localPath: data.localPath || "",
    excludePaths: data.excludePaths || ["node_modules", ".git", "vendor", ".DS_Store"],
    createdAt: existing >= 0 ? conns[existing].createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    conns[existing] = conn;
  } else {
    conns.push(conn);
  }

  await writeConnections(conns);
  log.ok(`SFTP connection saved: ${conn.name}`);
  return { success: true, connection: { ...conn, password: "••••••••" } };
}

async function deleteConnection(id) {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return { success: true };
  let conns = JSON.parse(await fs.readFile(file, "utf8"));
  conns = conns.filter((c) => c.id !== id);
  await writeConnections(conns);
  log.ok(`SFTP connection deleted: ${id}`);
  return { success: true };
}

// Get raw connection with decrypted password (internal use only)
async function getRawConnection(id) {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return null;
  const conns = JSON.parse(await fs.readFile(file, "utf8"));
  const conn = conns.find((c) => c.id === id);
  if (!conn) return null;
  if (!conn.password) return { ...conn, password: "" };
  if (String(conn.password).startsWith("v2:")) {
    if (!vaultKey) return { ...conn, password: "", credentialError: "VAULT_LOCKED" };
    try { return { ...conn, password: vaultCrypto.open(conn.password, vaultKey) }; }
    catch { return { ...conn, password: "", credentialError: "CREDENTIAL_INVALID" }; }
  }
  const password = decryptLegacy(conn.password);
  return { ...conn, password, credentialError: password ? "" : "LEGACY_CREDENTIAL_UNAVAILABLE" };
}

// ─── SFTP Operations ─────────────────────────────────────────────────────────
let activeConnections = {}; // { connId: { client, sftp } }

async function pingConnection(id) {
  const ac = activeConnections[id];
  if (!ac) return false;
  try {
    if (ac.type === "sftp") {
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 5000);
        ac.sftp.stat("/", (err) => { clearTimeout(t); resolve(!err); });
      });
    } else if (ac.type === "ftp") {
      await ac.client.pwd();
      return true;
    }
  } catch { return false; }
  return false;
}

async function connect(id, progressCb) {
  const conn = await getRawConnection(id);
  if (!conn) return { success: false, message: "Connection not found" };
  if (conn.credentialError === "VAULT_LOCKED") {
    return { success: false, code: "VAULT_LOCKED", message: "Credential vault is locked" };
  }
  if (conn.credentialError === "LEGACY_CREDENTIAL_UNAVAILABLE") {
    return { success: false, code: "CREDENTIAL_REENTRY_REQUIRED", message: "This password was encrypted on another machine. Unlock the vault, edit this connection, and enter the password again." };
  }
  if (conn.credentialError) return { success: false, code: conn.credentialError, message: "Stored credential cannot be decrypted" };

  if (activeConnections[id]) {
    const alive = await pingConnection(id);
    if (alive) return { success: true, message: "Already connected" };
    // Connection is dead — clean up and reconnect
    try {
      const ac = activeConnections[id];
      if (ac.type === "sftp") ac.client.end();
      else if (ac.type === "ftp") ac.client.close();
    } catch {}
    delete activeConnections[id];
    progressCb && progressCb(`Reconnecting to ${conn.host}:${conn.port}...`);
  } else {
    progressCb && progressCb(`Connecting to ${conn.host}:${conn.port}...`);
  }

  if (conn.type === "ftp") {
    return connectFtp(id, conn, progressCb);
  }
  return connectSftp(id, conn, progressCb);
}

async function ensureConnected(id) {
  if (!activeConnections[id]) return { success: false, message: "Not connected" };
  const alive = await pingConnection(id);
  if (alive) return { success: true };
  // Reconnect silently
  const conn = await getRawConnection(id);
  if (!conn) return { success: false, message: "Connection config not found" };
  try {
    const ac = activeConnections[id];
    if (ac.type === "sftp") ac.client.end();
    else if (ac.type === "ftp") ac.client.close();
  } catch {}
  delete activeConnections[id];
  delete remoteSystemCache[id];
  log.info(`Auto-reconnecting ${id}...`);
  const r = await connect(id);
  return r;
}

async function connectSftp(id, conn, progressCb) {
  const { Client } = require("ssh2");
  return new Promise((resolve) => {
    const client = new Client();
    const connectOpts = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: 15000,
    };

    if (conn.privateKey && fs.existsSync(conn.privateKey)) {
      connectOpts.privateKey = fs.readFileSync(conn.privateKey);
    } else if (conn.password) {
      connectOpts.password = conn.password;
    }

    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          log.err("SFTP session error: " + err.message);
          return resolve({ success: false, message: err.message });
        }
        activeConnections[id] = { client, sftp, type: "sftp" };
        progressCb && progressCb("Connected!");
        log.ok(`SFTP connected: ${conn.host}`);
        resolve({ success: true });
      });
    });

    client.on("error", (err) => {
      log.err("SSH error: " + err.message);
      resolve({ success: false, message: err.message });
    });

    client.connect(connectOpts);
  });
}

async function connectFtp(id, conn, progressCb) {
  const ftp = require("basic-ftp");
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: conn.host,
      port: conn.port,
      user: conn.username,
      password: conn.password,
      secure: !!conn.secure,
    });
    activeConnections[id] = { client, type: "ftp" };
    progressCb && progressCb("Connected!");
    log.ok(`FTP connected: ${conn.host}`);
    return { success: true };
  } catch (err) {
    log.err("FTP error: " + err.message);
    return { success: false, message: err.message };
  }
}

async function disconnect(id) {
  const ac = activeConnections[id];
  if (!ac) return { success: true };
  stopShell(id);
  try {
    if (ac.type === "sftp") {
      ac.client.end();
    } else if (ac.type === "ftp") {
      ac.client.close();
    }
  } catch {}
  delete activeConnections[id];
  log.info(`Disconnected: ${id}`);
  return { success: true };
}

async function listRemote(id, remotePath) {
  const ok = await ensureConnected(id);
  if (!ok.success) return { success: false, message: ok.message || "Not connected" };
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        ac.sftp.readdir(remotePath, (err, list) => {
          if (err) return resolve({ success: false, message: err.message });
          const items = list.map((item) => ({
            name: item.filename,
            type: item.longname.startsWith("d") ? "directory" : "file",
            size: item.attrs.size,
            modified: new Date(item.attrs.mtime * 1000).toISOString(),
            permissions: item.longname.substring(0, 10),
          }));
          items.sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          resolve({ success: true, items, path: remotePath });
        });
      });
    } else if (ac.type === "ftp") {
      // Use "-a" to show hidden files (dotfiles)
      let list;
      try {
        await ac.client.cd(remotePath);
        list = await ac.client.list("-a");
      } catch {
        list = await ac.client.list(remotePath);
      }
      const items = list
        .filter((item) => item.name !== "." && item.name !== "..")
        .map((item) => ({
          name: item.name,
          type: item.type === 2 ? "directory" : "file",
          size: item.size,
          modified: item.modifiedAt ? item.modifiedAt.toISOString() : "",
          permissions: item.rawModifiedAt || "",
        }));
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return { success: true, items, path: remotePath };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function downloadFile(id, remotePath, localPath, progressCb) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  await fs.ensureDir(path.dirname(localPath));
  progressCb && progressCb(`Downloading ${path.basename(remotePath)}...`);

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        ac.sftp.fastGet(remotePath, localPath, {}, (err) => {
          if (err) return resolve({ success: false, message: err.message });
          progressCb && progressCb(`Downloaded: ${path.basename(remotePath)}`);
          resolve({ success: true });
        });
      });
    } else if (ac.type === "ftp") {
      await ac.client.downloadTo(localPath, remotePath);
      progressCb && progressCb(`Downloaded: ${path.basename(remotePath)}`);
      return { success: true };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function uploadFile(id, localPath, remotePath, progressCb) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  progressCb && progressCb(`Uploading ${path.basename(localPath)}...`);

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        ac.sftp.fastPut(localPath, remotePath, {}, (err) => {
          if (err) return resolve({ success: false, message: err.message });
          progressCb && progressCb(`Uploaded: ${path.basename(localPath)}`);
          resolve({ success: true });
        });
      });
    } else if (ac.type === "ftp") {
      await ac.client.uploadFrom(localPath, remotePath);
      progressCb && progressCb(`Uploaded: ${path.basename(localPath)}`);
      return { success: true };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── Validate local path ─────────────────────────────────────────────────────
async function validateLocalPath(localPath) {
  if (!localPath) return { valid: false, message: "No path specified" };
  if (!fs.existsSync(localPath)) return { valid: false, message: "Folder not found: " + localPath };
  const stat = await fs.stat(localPath);
  if (!stat.isDirectory()) return { valid: false, message: "Not a directory: " + localPath };
  const files = await fs.readdir(localPath);
  return { valid: true, fileCount: files.length, message: `${files.length} item(s) in folder` };
}

// ─── Get remote file mtime (for changedOnly sync) ────────────────────────────
async function getRemoteMtime(id, remotePath) {
  const ac = activeConnections[id];
  if (!ac) return null;
  try {
    if (ac.type === "sftp") {
      return await new Promise((resolve) => {
        ac.sftp.stat(remotePath, (err, stats) => {
          if (err) return resolve(null);
          resolve(stats.mtime * 1000); // convert to ms
        });
      });
    } else if (ac.type === "ftp") {
      const list = await ac.client.list(path.dirname(remotePath).replace(/\\/g, "/"));
      const entry = list.find((f) => f.name === path.basename(remotePath));
      if (entry?.modifiedAt) return entry.modifiedAt.getTime();
      return null;
    }
  } catch { return null; }
}

// ─── Sync ────────────────────────────────────────────────────────────────────
async function syncUpload(id, progressCb, opts = {}) {
  const conn = await getRawConnection(id);
  if (!conn) return { success: false, message: "Connection not found" };

  let localDir = conn.localPath;
  if (!localDir && conn.projectId) {
    localDir = path.join(global.CONST.PROJECTS_DIR, conn.projectId, "www");
  }

  // Validate local path before starting
  const validation = await validateLocalPath(localDir);
  if (!validation.valid) {
    return { success: false, message: "Local path error: " + validation.message };
  }

  const ok = await ensureConnected(id);
  if (!ok.success) return { success: false, message: "Not connected: " + (ok.message || "") };
  const ac = activeConnections[id];

  const excludes = new Set(conn.excludePaths || []);
  const changedOnly = opts.changedOnly === true;
  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  async function syncDir(localBase, remoteBase) {
    const entries = await fs.readdir(localBase, { withFileTypes: true });
    for (const entry of entries) {
      if (excludes.has(entry.name)) continue;

      const localP = path.join(localBase, entry.name);
      const remoteP = remoteBase + "/" + entry.name;

      if (entry.isDirectory()) {
        try {
          if (ac.type === "sftp") {
            await new Promise((resolve) => { ac.sftp.mkdir(remoteP, () => resolve()); });
          } else {
            await ac.client.ensureDir(remoteP).catch(() => {});
          }
        } catch {}
        await syncDir(localP, remoteP);
      } else {
        try {
          if (changedOnly) {
            const localStat = await fs.stat(localP);
            const remoteMtime = await getRemoteMtime(id, remoteP);
            if (remoteMtime !== null && remoteMtime >= localStat.mtimeMs) {
              skipped++;
              continue; // remote is same age or newer → skip
            }
          }
          const r = await uploadFile(id, localP, remoteP, progressCb);
          if (r.success) uploaded++;
          else errors++;
        } catch {
          errors++;
        }
      }
    }
  }

  const modeLabel = changedOnly ? " (changed files only)" : "";
  progressCb && progressCb(`Syncing${modeLabel}: ${localDir} → ${conn.remotePath}...`);
  await syncDir(localDir, conn.remotePath);
  const msg = `Sync complete: ${uploaded} uploaded, ${skipped} skipped, ${errors} errors`;
  progressCb && progressCb(msg);
  log.ok(msg);
  return { success: true, uploaded, skipped, errors };
}

async function syncDownload(id, progressCb, opts = {}) {
  const conn = await getRawConnection(id);
  if (!conn) return { success: false, message: "Connection not found" };

  let localDir = conn.localPath;
  if (!localDir && conn.projectId) {
    localDir = path.join(global.CONST.PROJECTS_DIR, conn.projectId, "www");
  }
  if (!localDir) {
    return { success: false, message: "Local path not configured" };
  }
  await fs.ensureDir(localDir);

  const ok = await ensureConnected(id);
  if (!ok.success) return { success: false, message: "Not connected: " + (ok.message || "") };

  const excludes = new Set(conn.excludePaths || []);
  const changedOnly = opts.changedOnly === true;
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  async function syncDir(remoteBase, localBase) {
    const listResult = await listRemote(id, remoteBase);
    if (!listResult.success) return;

    for (const item of listResult.items) {
      if (excludes.has(item.name)) continue;

      const remoteP = remoteBase + "/" + item.name;
      const localP = path.join(localBase, item.name);

      if (item.type === "directory") {
        await fs.ensureDir(localP);
        await syncDir(remoteP, localP);
      } else {
        try {
          if (changedOnly && fs.existsSync(localP)) {
            const localStat = await fs.stat(localP);
            const remoteMtime = item.modified ? new Date(item.modified).getTime() : null;
            if (remoteMtime !== null && remoteMtime <= localStat.mtimeMs) {
              skipped++;
              continue; // local is same age or newer → skip
            }
          }
          const r = await downloadFile(id, remoteP, localP, progressCb);
          if (r.success) downloaded++;
          else errors++;
        } catch {
          errors++;
        }
      }
    }
  }

  const modeLabel = changedOnly ? " (changed files only)" : "";
  progressCb && progressCb(`Syncing${modeLabel}: ${conn.remotePath} → ${localDir}...`);
  await syncDir(conn.remotePath, localDir);
  const msg = `Sync complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`;
  progressCb && progressCb(msg);
  log.ok(msg);
  return { success: true, downloaded, skipped, errors };
}

// ─── Terminal (SSH exec) ─────────────────────────────────────────────────────
// Track current working directory per connection for cd support
const terminalCwd = {};
const remoteSystemCache = {};
const activeShells = {};

async function startShell(id, cols = 100, rows = 30) {
  const connected = await ensureConnected(id);
  if (!connected.success) return connected;
  const ac = activeConnections[id];
  if (!ac || ac.type !== "sftp") return { success: false, message: "Not connected via SSH" };
  if (activeShells[id] && !activeShells[id].destroyed) {
    activeShells[id].setWindow(rows, cols, 0, 0);
    return { success: true, reused: true };
  }
  return new Promise((resolve) => {
    ac.client.shell({ term: "xterm-256color", cols, rows }, (error, stream) => {
      if (error) return resolve({ success: false, message: error.message });
      activeShells[id] = stream;
      stream.on("data", (data) => global.STATE.mainWindow?.webContents?.send("sftp-shell-data", { id, data: data.toString("utf8") }));
      stream.stderr?.on("data", (data) => global.STATE.mainWindow?.webContents?.send("sftp-shell-data", { id, data: data.toString("utf8") }));
      stream.on("close", () => {
        delete activeShells[id];
        global.STATE.mainWindow?.webContents?.send("sftp-shell-exit", { id });
      });
      resolve({ success: true });
    });
  });
}

function writeShell(id, data) {
  const stream = activeShells[id];
  if (!stream || stream.destroyed) return { success: false, message: "SSH shell is not running" };
  stream.write(String(data || ""));
  return { success: true };
}

function resizeShell(id, cols, rows) {
  const stream = activeShells[id];
  if (!stream || stream.destroyed) return { success: false };
  stream.setWindow(Math.max(2, rows || 30), Math.max(2, cols || 100), 0, 0);
  return { success: true };
}

function stopShell(id) {
  const stream = activeShells[id];
  if (stream) {
    try { stream.end("exit\n"); } catch {}
    delete activeShells[id];
  }
  return { success: true };
}

async function getRemoteSystemInfo(id) {
  if (remoteSystemCache[id]) return { success: true, ...remoteSystemCache[id] };
  const ac = activeConnections[id];
  if (!ac || ac.type !== "sftp") return { success: false, message: "Not connected via SSH" };
  const command = "printf '__OS__\\n'; cat /etc/os-release 2>/dev/null; printf '__TOOLS__\\n'; for c in apt apt-get dnf yum apk pacman zypper systemctl service; do command -v $c >/dev/null 2>&1 && printf '%s\\n' $c; done; printf '__SHELL__\\n'; printf '%s\\n' \"$SHELL\"";
  return new Promise((resolve) => {
    ac.client.exec(command, (error, stream) => {
      if (error) return resolve({ success: false, message: error.message });
      let output = "";
      stream.on("data", (chunk) => { output += chunk.toString(); });
      stream.stderr.on("data", () => {});
      stream.on("close", () => {
        const osBlock = output.split("__OS__\n")[1]?.split("__TOOLS__\n")[0] || "";
        const toolsBlock = output.split("__TOOLS__\n")[1]?.split("__SHELL__\n")[0] || "";
        const shell = (output.split("__SHELL__\n")[1] || "").trim();
        const values = {};
        for (const line of osBlock.split(/\r?\n/)) {
          const match = line.match(/^([A-Z_]+)=(.*)$/);
          if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
        }
        const info = {
          id: (values.ID || "linux").toLowerCase(),
          idLike: (values.ID_LIKE || "").toLowerCase().split(/\s+/).filter(Boolean),
          name: values.PRETTY_NAME || values.NAME || "Linux",
          tools: toolsBlock.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
          shell,
        };
        remoteSystemCache[id] = info;
        resolve({ success: true, ...info });
      });
    });
  });
}

async function execCommand(id, command) {
  const ac = activeConnections[id];
  if (!ac || ac.type !== "sftp") {
    return { success: false, message: "Not connected via SSH" };
  }

  // Handle cd command locally to maintain cwd across commands
  const trimCmd = command.trim();
  if (trimCmd.startsWith("cd ")) {
    const dir = trimCmd.slice(3).trim();
    // Resolve relative to current cwd
    const cwd = terminalCwd[id] || "~";
    if (dir.startsWith("/")) {
      terminalCwd[id] = dir;
    } else if (dir === "~" || dir === "") {
      terminalCwd[id] = "~";
    } else if (dir === "..") {
      const parts = cwd.split("/").filter(Boolean);
      parts.pop();
      terminalCwd[id] = "/" + parts.join("/");
    } else {
      terminalCwd[id] = cwd === "~" ? `~/${dir}` : `${cwd}/${dir}`;
    }
    // Verify the directory exists
    const verifyCmd = `cd ${terminalCwd[id]} && pwd`;
    return new Promise((resolve) => {
      ac.client.exec(verifyCmd, { pty: true }, (err, stream) => {
        if (err) return resolve({ success: false, message: err.message });
        let out = "";
        stream.on("data", (data) => { out += data.toString(); });
        stream.on("close", (code) => {
          if (code === 0) {
            terminalCwd[id] = out.trim();
            resolve({ success: true, output: terminalCwd[id], cwd: terminalCwd[id] });
          } else {
            resolve({ success: false, message: "Directory not found", output: out });
          }
        });
      });
    });
  }

  // Wrap command with cd to cwd first, so user maintains directory context
  const cwd = terminalCwd[id];
  const fullCmd = cwd ? `cd ${cwd} && ${command}` : command;

  return new Promise((resolve) => {
    ac.client.exec(fullCmd, { pty: true }, (err, stream) => {
      if (err) return resolve({ success: false, message: err.message });

      let stdout = "";

      stream.on("data", (data) => { stdout += data.toString(); });
      stream.on("close", (code) => {
        resolve({
          success: code === 0,
          output: stdout,
          error: code !== 0 ? stdout : "",
          exitCode: code,
          cwd: cwd || "~",
        });
      });
    });
  });
}

// FTP exec - run commands via FTP SITE command (limited)
async function execFtpCommand(id, command) {
  const ac = activeConnections[id];
  if (!ac || ac.type !== "ftp") {
    return { success: false, message: "Not connected via FTP" };
  }
  try {
    const res = await ac.client.send(command);
    return { success: true, output: `${res.code} ${res.message}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── Delete remote file/directory ────────────────────────────────────────────
async function deleteRemote(id, remotePath, isDirectory) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  try {
    if (ac.type === "sftp") {
      if (isDirectory) {
        // Recursively delete directory
        await deleteDirRecursiveSftp(ac.sftp, remotePath);
      } else {
        await new Promise((resolve, reject) => {
          ac.sftp.unlink(remotePath, (err) => err ? reject(err) : resolve());
        });
      }
      return { success: true };
    } else if (ac.type === "ftp") {
      if (isDirectory) {
        await ac.client.removeDir(remotePath);
      } else {
        await ac.client.remove(remotePath);
      }
      return { success: true };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function deleteDirRecursiveSftp(sftp, dirPath) {
  const list = await new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, items) => err ? reject(err) : resolve(items || []));
  });
  for (const item of list) {
    const fullPath = dirPath + "/" + item.filename;
    if (item.longname.startsWith("d")) {
      await deleteDirRecursiveSftp(sftp, fullPath);
    } else {
      await new Promise((resolve, reject) => {
        sftp.unlink(fullPath, (err) => err ? reject(err) : resolve());
      });
    }
  }
  await new Promise((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => err ? reject(err) : resolve());
  });
}

// ─── Read remote file content (for editing) ──────────────────────────────────
async function readRemoteFile(id, remotePath) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        const chunks = [];
        const stream = ac.sftp.createReadStream(remotePath, { encoding: "utf8" });
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => resolve({ success: true, content: chunks.join("") }));
        stream.on("error", (err) => resolve({ success: false, message: err.message }));
      });
    } else if (ac.type === "ftp") {
      const tempFile = path.join(require("os").tmpdir(), "shieldpress_ftp_edit_" + Date.now());
      await ac.client.downloadTo(tempFile, remotePath);
      const content = await fs.readFile(tempFile, "utf8");
      await fs.remove(tempFile);
      return { success: true, content };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── Write remote file content (save edit) ───────────────────────────────────
async function writeRemoteFile(id, remotePath, content) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        const stream = ac.sftp.createWriteStream(remotePath);
        stream.on("close", () => resolve({ success: true }));
        stream.on("error", (err) => resolve({ success: false, message: err.message }));
        stream.end(content, "utf8");
      });
    } else if (ac.type === "ftp") {
      const tempFile = path.join(require("os").tmpdir(), "shieldpress_ftp_edit_" + Date.now());
      await fs.writeFile(tempFile, content, "utf8");
      await ac.client.uploadFrom(tempFile, remotePath);
      await fs.remove(tempFile);
      return { success: true };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ─── Upload ZIP and extract on remote ────────────────────────────────────────
async function uploadAndExtract(id, localZipPath, remotePath, progressCb) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  const zipName = path.basename(localZipPath);
  const remoteZip = remotePath.replace(/\/+$/, "") + "/" + zipName;

  progressCb && progressCb(`Uploading ${zipName}...`);
  const uploadResult = await uploadFile(id, localZipPath, remoteZip, progressCb);
  if (!uploadResult.success) return uploadResult;

  // Extract via SSH (only for SFTP)
  if (ac.type === "sftp") {
    progressCb && progressCb(`Extracting ${zipName} on remote server...`);
    const extractCmd = `cd "${remotePath}" && unzip -o "${remoteZip}" && rm -f "${remoteZip}"`;
    const r = await execCommand(id, extractCmd);
    if (r.success) {
      progressCb && progressCb("Extracted and cleaned up successfully");
    } else {
      progressCb && progressCb("Upload OK but extract may have failed: " + (r.error || r.output));
    }
    return { success: true, extracted: r.success };
  }

  // FTP: can't extract on server
  progressCb && progressCb("Uploaded ZIP. FTP cannot extract remotely — extract manually on server.");
  return { success: true, extracted: false };
}

// ─── Create remote directory ─────────────────────────────────────────────────
function normalizeRemoteMutationPath(remotePath) {
  const value = String(remotePath || "").trim();
  if (!value.startsWith("/")) throw new Error("Remote path must start with /");
  const normalized = path.posix.normalize(value);
  if (normalized === "/") throw new Error("Cannot create or replace the remote root directory");
  return normalized;
}

async function createRemoteDirOnConnection(ac, remotePath) {
  if (ac.type === "sftp") {
    await new Promise((resolve, reject) => {
      ac.sftp.mkdir(remotePath, { mode: 0o755 }, (error) => error ? reject(error) : resolve());
    });
  } else {
    const previousDir = await ac.client.pwd();
    try { await ac.client.ensureDir(remotePath); }
    finally { await ac.client.cd(previousDir).catch(() => {}); }
  }
}

async function createRemoteFileOnConnection(ac, remotePath) {
  if (ac.type === "sftp") {
    await new Promise((resolve, reject) => {
      ac.sftp.open(remotePath, "w", { mode: 0o644 }, (error, handle) => {
        if (error) return reject(error);
        ac.sftp.close(handle, (closeError) => closeError ? reject(closeError) : resolve());
      });
    });
  } else {
    const tempFile = path.join(require("os").tmpdir(), `shieldpress_ftp_empty_${process.pid}_${Date.now()}`);
    try {
      await fs.writeFile(tempFile, "", { mode: 0o600 });
      await ac.client.uploadFrom(tempFile, remotePath);
    } finally {
      await fs.remove(tempFile).catch(() => {});
    }
  }
}

async function createRemoteDir(id, remotePath) {
  try {
    remotePath = normalizeRemoteMutationPath(remotePath);
    const connected = await ensureConnected(id);
    if (!connected.success) return connected;
    await createRemoteDirOnConnection(activeConnections[id], remotePath);
    const verified = await checkRemoteExists(id, remotePath);
    if (!verified.exists || !verified.isDirectory) throw new Error("The server did not create the directory");
    return { success: true, path: remotePath };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function createRemoteFile(id, remotePath) {
  try {
    remotePath = normalizeRemoteMutationPath(remotePath);
    const connected = await ensureConnected(id);
    if (!connected.success) return connected;
    await createRemoteFileOnConnection(activeConnections[id], remotePath);
    const verified = await checkRemoteExists(id, remotePath);
    if (!verified.exists || verified.isDirectory) throw new Error("The server did not create the file");
    return { success: true, path: remotePath };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function copyRemoteFile(id, sourcePath, destinationPath) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };
  try {
    if (ac.type === "sftp") {
      await new Promise((resolve, reject) => {
        const source = ac.sftp.createReadStream(sourcePath);
        const destination = ac.sftp.createWriteStream(destinationPath);
        let settled = false;
        const done = (error) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve();
        };
        source.on("error", done);
        destination.on("error", done);
        destination.on("close", () => done());
        source.pipe(destination);
      });
    } else {
      const tempFile = path.join(require("os").tmpdir(), `shieldpress_ftp_copy_${process.pid}_${Date.now()}`);
      try {
        await ac.client.downloadTo(tempFile, sourcePath);
        await ac.client.uploadFrom(tempFile, destinationPath);
      } finally {
        await fs.remove(tempFile).catch(() => {});
      }
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function copyRemote(id, sourcePath, destinationPath, isDirectory) {
  if (sourcePath === destinationPath || destinationPath.startsWith(sourcePath.replace(/\/+$/, "") + "/")) {
    return { success: false, message: "Destination cannot be inside the source" };
  }
  if (!isDirectory) return copyRemoteFile(id, sourcePath, destinationPath);
  const created = await createRemoteDir(id, destinationPath);
  if (!created.success && !/exist/i.test(created.message || "")) return created;
  const listed = await listRemote(id, sourcePath);
  if (!listed.success) return listed;
  for (const item of listed.items) {
    const sourceChild = path.posix.join(sourcePath, item.name);
    const destinationChild = path.posix.join(destinationPath, item.name);
    const result = await copyRemote(id, sourceChild, destinationChild, item.type === "directory");
    if (!result.success) return result;
  }
  return { success: true };
}

async function moveRemote(id, sourcePath, destinationPath) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };
  try {
    if (ac.type === "sftp") {
      await new Promise((resolve, reject) => {
        ac.sftp.rename(sourcePath, destinationPath, (error) => error ? reject(error) : resolve());
      });
    } else {
      await ac.client.rename(sourcePath, destinationPath);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// ─── Open in external editor (VS Code, Notepad++, etc.) ──────────────────────
// Tracks active file watchers so we can clean up
const fileWatchers = {};

async function openInExternalEditor(id, remotePath, progressCb, editorPath) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  const fileName = path.basename(remotePath);
  const tempDir = path.join(require("os").tmpdir(), "shieldpress_remote_edit");
  await fs.ensureDir(tempDir);

  const connDir = path.join(tempDir, id);
  await fs.ensureDir(connDir);

  const remoteDir = path.dirname(remotePath).replace(/^\//, "").replace(/\//g, "_");
  const subDir = path.join(connDir, remoteDir || "root");
  await fs.ensureDir(subDir);
  const localFile = path.join(subDir, fileName);

  progressCb && progressCb(`Downloading ${fileName} to temp...`);
  const dlResult = await downloadFile(id, remotePath, localFile, progressCb);
  if (!dlResult.success) return dlResult;

  if (editorPath && !fs.existsSync(editorPath)) {
    return { success: false, message: "The selected application does not exist" };
  }
  const editor = detectEditor(editorPath);
  progressCb && progressCb(`Opening ${fileName} in ${editor.name}...`);

  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    const isBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(editor.cmd);
    const child = spawn(editor.cmd, [...editor.args, localFile], {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      shell: isBatch,
    });
    child.on("error", (error) => log.warn(`Editor launch: ${error.message}`));
    child.unref();

    // Set up file watcher regardless — editor is opening
    const watchKey = id + ":" + remotePath;
    if (fileWatchers[watchKey]) fileWatchers[watchKey].close();

    let lastMtime = Date.now();
    let uploading = false;

    // Small delay to get initial mtime after download
    setTimeout(async () => {
      try { lastMtime = (await fs.stat(localFile)).mtimeMs; } catch {}
    }, 500);

    const watcher = fs.watch(localFile, async () => {
      if (uploading) return;
      try {
        const stat = await fs.stat(localFile);
        if (stat.mtimeMs <= lastMtime) return;
        lastMtime = stat.mtimeMs;

        uploading = true;
        log.info(`[ExternalEdit] ${fileName} changed, uploading...`);

        const upResult = await uploadFile(id, localFile, remotePath);
        if (upResult.success) {
          log.ok(`[ExternalEdit] ${fileName} uploaded`);
          global.STATE.mainWindow?.webContents?.send("sftp-external-save", {
            file: fileName, remotePath, connId: id,
          });
        } else {
          log.err(`[ExternalEdit] Upload failed: ${upResult.message}`);
        }
        uploading = false;
      } catch { uploading = false; }
    });

    fileWatchers[watchKey] = watcher;

    // Auto-cleanup after 2 hours
    setTimeout(() => {
      if (fileWatchers[watchKey]) {
        fileWatchers[watchKey].close();
        delete fileWatchers[watchKey];
      }
    }, 2 * 60 * 60 * 1000);

    resolve({
      success: true,
      localFile,
      editor: editor.name,
      message: `Opened in ${editor.name}. Changes will auto-upload.`,
    });
  });
}

function detectEditor(customPath) {
  if (customPath) {
    if (!fs.existsSync(customPath)) return { name: path.basename(customPath), cmd: customPath, args: [] };
    return { name: path.basename(customPath, path.extname(customPath)), cmd: customPath, args: [] };
  }
  if (platform.isLinux) {
    for (const [name, command] of [["VS Code", "code"], ["VSCodium", "codium"], ["Sublime Text", "subl"], ["Kate", "kate"], ["Gedit", "gedit"]]) {
      const found = platform.findCommand(command);
      if (found) return { name, cmd: found, args: [] };
    }
    return { name: "System editor", cmd: platform.findCommand("xdg-open") || "xdg-open", args: [] };
  }
  // Check VS Code — use full path, "code" is a batch script that may fail with spawn
  const codePaths = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
  ];
  for (const p of codePaths) {
    if (fs.existsSync(p)) return { name: "VS Code", cmd: p, args: [] };
  }
  // Also check if "code" command is available (via PATH — use shell exec so batch scripts work)
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

  // Fallback: Notepad (always available on Windows)
  return { name: "Notepad", cmd: "notepad.exe", args: [] };
}

// ─── Save last browsed path ──────────────────────────────────────────────────
async function updateLastBrowsedPath(id, browsedPath) {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return;
  try {
    const conns = JSON.parse(await fs.readFile(file, "utf8"));
    const conn = conns.find((c) => c.id === id);
    if (conn) {
      conn.lastBrowsedPath = browsedPath;
      await fs.writeFile(file, JSON.stringify(conns, null, 2), "utf8");
    }
  } catch {}
}

// ─── Check if remote file exists ─────────────────────────────────────────────
async function checkRemoteExists(id, remotePath) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        ac.sftp.stat(remotePath, (err, stats) => {
          if (err) return resolve({ success: true, exists: false });
          resolve({ success: true, exists: true, isDirectory: stats.isDirectory(), size: stats.size });
        });
      });
    } else if (ac.type === "ftp") {
      try {
        const size = await ac.client.size(remotePath);
        return { success: true, exists: true, isDirectory: false, size };
      } catch {
        try {
          await ac.client.list(remotePath);
          return { success: true, exists: true, isDirectory: true, size: 0 };
        } catch {
          return { success: true, exists: false };
        }
      }
    }
  } catch {
    return { success: true, exists: false };
  }
}

function stopFileWatcher(id, remotePath) {
  const watchKey = id + ":" + remotePath;
  if (fileWatchers[watchKey]) {
    fileWatchers[watchKey].close();
    delete fileWatchers[watchKey];
    return { success: true };
  }
  return { success: true };
}

module.exports = {
  getVaultStatus,
  setupVault,
  unlockVault,
  lockVault,
  getConnections,
  saveConnection,
  deleteConnection,
  connect,
  disconnect,
  listRemote,
  downloadFile,
  uploadFile,
  syncUpload,
  syncDownload,
  execCommand,
  getRemoteSystemInfo,
  startShell,
  writeShell,
  resizeShell,
  stopShell,
  execFtpCommand,
  deleteRemote,
  readRemoteFile,
  writeRemoteFile,
  uploadAndExtract,
  createRemoteDir,
  createRemoteFile,
  copyRemote,
  moveRemote,
  openInExternalEditor,
  stopFileWatcher,
  updateLastBrowsedPath,
  checkRemoteExists,
  validateLocalPath,
  __test: { normalizeRemoteMutationPath, createRemoteDirOnConnection, createRemoteFileOnConnection },
};
