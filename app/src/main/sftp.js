// src/main/sftp.js
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const log = require("./logger");
const platform = require("./platform");
const vaultCrypto = require("./credential-vault");
const sessionManager = require("./session-manager");

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

function getVaultTransactionPaths() {
  const dir = getRemoteDataDir();
  return {
    vault: path.join(dir, "vault.json"),
    connections: path.join(dir, "connections.json"),
    vaultBackup: path.join(dir, "vault.json.rekey-backup"),
    connectionsBackup: path.join(dir, "connections.json.rekey-backup"),
    vaultNext: path.join(dir, "vault.json.rekey-next"),
    connectionsNext: path.join(dir, "connections.json.rekey-next"),
  };
}

async function recoverVaultTransaction() {
  const paths = getVaultTransactionPaths();
  const hasBackups = await fs.pathExists(paths.vaultBackup) || await fs.pathExists(paths.connectionsBackup);
  if (!hasBackups) return;

  // A process crash during commit can leave one or both live files missing.
  // Restore both originals before any further vault operation.
  const incomplete = !(await fs.pathExists(paths.vault)) || !(await fs.pathExists(paths.connections));
  if (incomplete) {
    await fs.remove(paths.vault);
    await fs.remove(paths.connections);
    if (await fs.pathExists(paths.vaultBackup)) await fs.rename(paths.vaultBackup, paths.vault);
    if (await fs.pathExists(paths.connectionsBackup)) await fs.rename(paths.connectionsBackup, paths.connections);
  } else {
    await fs.remove(paths.vaultBackup);
    await fs.remove(paths.connectionsBackup);
  }
  await fs.remove(paths.vaultNext);
  await fs.remove(paths.connectionsNext);
}

async function readVaultMetadata() {
  await recoverVaultTransaction();
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

async function changeVaultPassword(currentPassword, newPassword) {
  const nextPassword = String(newPassword || "");
  if (nextPassword.length < 12) {
    return { success: false, message: "Master Password must contain at least 12 characters" };
  }
  const metadata = await readVaultMetadata();
  if (!metadata) return { success: false, message: "Master Password has not been set" };
  const paths = getVaultTransactionPaths();

  let currentKey;
  try {
    currentKey = vaultCrypto.unlock(currentPassword, metadata);
  } catch {
    return { success: false, message: "Current Master Password is invalid" };
  }

  // Decrypt everything before writing anything, so a bad credential cannot
  // leave the vault half-rekeyed.
  const connectionsFile = getConnectionsFile();
  let connections = [];
  if (await fs.pathExists(connectionsFile)) {
    try {
      connections = await fs.readJson(connectionsFile);
    } catch {
      return { success: false, message: "Saved server credentials could not be read" };
    }
  }
  const plaintextPasswords = [];
  try {
    for (const connection of connections) {
      if (!connection.password || !String(connection.password).startsWith("v2:")) {
        const plaintext = connection.password ? decryptLegacy(connection.password) : "";
        if (connection.password && !plaintext) {
          throw new Error("Legacy credential could not be decrypted");
        }
        plaintextPasswords.push(plaintext);
        continue;
      }
      plaintextPasswords.push(vaultCrypto.open(connection.password, currentKey));
    }
  } catch {
    return { success: false, message: "A saved server credential could not be decrypted" };
  }

  const created = vaultCrypto.createMetadata(nextPassword);
  const rekeyedConnections = connections.map((connection, index) => ({
    ...connection,
    password: plaintextPasswords[index]
      ? vaultCrypto.seal(plaintextPasswords[index], created.key)
      : "",
  }));

  // Stage and verify the complete new vault before touching the live files.
  await fs.writeJson(paths.connectionsNext, rekeyedConnections, { spaces: 2, mode: 0o600 });
  await fs.writeJson(paths.vaultNext, created.metadata, { spaces: 2, mode: 0o600 });
  const stagedMetadata = await fs.readJson(paths.vaultNext);
  const stagedKey = vaultCrypto.unlock(nextPassword, stagedMetadata);
  const stagedConnections = await fs.readJson(paths.connectionsNext);
  for (const connection of stagedConnections) {
    if (connection.password && String(connection.password).startsWith("v2:")) {
      vaultCrypto.open(connection.password, stagedKey);
    }
  }

  // Keep the old pair until the new pair has been committed and verified.
  await fs.remove(paths.vaultBackup);
  await fs.remove(paths.connectionsBackup);
  await fs.copyFile(paths.vault, paths.vaultBackup);
  if (await fs.pathExists(paths.connections)) {
    await fs.copyFile(paths.connections, paths.connectionsBackup);
  }

  try {
    await disconnectAll();
    await fs.remove(paths.connections);
    await fs.rename(paths.connectionsNext, paths.connections);
    await fs.remove(paths.vault);
    await fs.rename(paths.vaultNext, paths.vault);

    // Verify the actual committed files, not only the staged copies.
    const committedMetadata = await fs.readJson(paths.vault);
    const committedKey = vaultCrypto.unlock(nextPassword, committedMetadata);
    const committedConnections = await fs.readJson(paths.connections);
    for (const connection of committedConnections) {
      if (connection.password && String(connection.password).startsWith("v2:")) {
        vaultCrypto.open(connection.password, committedKey);
      }
    }
  } catch (error) {
    // Roll back immediately. recoverVaultTransaction() also handles a later
    // restart if the process is interrupted during the commit sequence.
    await fs.remove(paths.vault);
    await fs.remove(paths.connections);
    if (await fs.pathExists(paths.vaultBackup)) await fs.rename(paths.vaultBackup, paths.vault);
    if (await fs.pathExists(paths.connectionsBackup)) await fs.rename(paths.connectionsBackup, paths.connections);
    await fs.remove(paths.vaultNext);
    await fs.remove(paths.connectionsNext);
    return { success: false, message: `Vault password was not changed: ${error.message}` };
  }

  await fs.remove(paths.vaultBackup);
  await fs.remove(paths.connectionsBackup);
  vaultKey = created.key;
  return { success: true, configured: true, unlocked: true };
}

async function lockVault() {
  vaultKey = null;
  await disconnectAll();
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
      lastConnectedAt: c.lastConnectedAt || "",
      starred: !!c.starred,
      isConnected: Object.entries(activeConnections).some(
        ([key, value]) => connectionIdOf(key, value) === c.id,
      ),
      transport: (() => {
        const active = Object.values(activeConnections).find((value) => connectionIdOf("", value) === c.id);
        return active ? active.type : "";
      })(),
      openSessions: sessionManager.listByConnection(c.id).map((s) => ({ id: s.id, kind: s.kind, title: s.title })),
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
    lastConnectedAt: existing >= 0 ? (conns[existing].lastConnectedAt || "") : (data.lastConnectedAt || ""),
    starred: existing >= 0 ? !!conns[existing].starred : !!data.starred,
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
// Keys are either connectionId (pool / list Connect) or sessionId (window sessions).
let activeConnections = {}; // { id: { client, sftp?, type, connectionId } }

function connectionIdOf(id, ac) {
  if (ac?.connectionId) return ac.connectionId;
  const parsed = sessionManager.parseSessionId(id);
  return parsed ? parsed.connectionId : id;
}

function getActive(id) {
  return activeConnections[id] || null;
}

function isPipeError(err) {
  const code = err && err.code;
  return code === "EPIPE" || code === "ECONNRESET" || code === "ERR_STREAM_DESTROYED" || code === "ENOTCONN";
}

function sinkStreamErrors(stream) {
  if (!stream || typeof stream.on !== "function") return;
  stream.on("error", (err) => {
    if (!isPipeError(err)) log.err("SSH stream: " + (err.message || err));
  });
}

function safeCloseSsh(client) {
  if (!client) return;
  try {
    client.removeAllListeners("error");
    client.on("error", () => {});
    if (typeof client.destroy === "function") client.destroy();
    else client.end();
  } catch {}
}

function dropActiveConnection(id) {
  const ac = activeConnections[id];
  stopShellsForKey(id);
  if (!ac) return;
  delete activeConnections[id];
  const connId = connectionIdOf(id, ac);
  // Only clear shared caches when no other live sessions remain for this connection.
  const stillLive = Object.entries(activeConnections).some(([key, value]) => connectionIdOf(key, value) === connId);
  if (!stillLive) {
    delete remoteSystemCache[connId];
    delete remoteStatsCache[connId];
    delete terminalCwd[connId];
  }
  try {
    if (ac.type === "sftp" || ac.type === "ssh") safeCloseSsh(ac.client);
    else if (ac.type === "ftp") {
      try { ac.client.close(); } catch {}
      try { ac.client.close?.(); } catch {}
    }
  } catch {}
}

async function pingConnection(id) {
  const ac = getActive(id);
  if (!ac) return false;
  try {
    if (ac.type === "sftp") {
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 5000);
        try {
          ac.sftp.stat("/", (err) => { clearTimeout(t); resolve(!err); });
        } catch {
          clearTimeout(t);
          resolve(false);
        }
      });
    } else if (ac.type === "ssh") {
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        try {
          ac.client.exec("true", (err, stream) => {
            if (err) { clearTimeout(timer); return resolve(false); }
            stream.on("close", () => { clearTimeout(timer); resolve(true); });
            stream.on("error", () => { clearTimeout(timer); resolve(false); });
          });
        } catch {
          clearTimeout(timer);
          resolve(false);
        }
      });
    } else if (ac.type === "ftp") {
      await ac.client.pwd();
      return true;
    }
  } catch { return false; }
  return false;
}

async function connect(id, progressCb) {
  if (sessionManager.isSessionId(id)) {
    return connectSession(id, progressCb);
  }
  return connectInternal(id, id, progressCb, { allowReuse: true });
}

async function connectSession(sessionId, progressCb) {
  const parsed = sessionManager.parseSessionId(sessionId);
  if (!parsed) return { success: false, message: "Invalid session id" };
  // Window sessions always get a brand-new transport — never reuse.
  if (activeConnections[sessionId]) dropActiveConnection(sessionId);
  return connectInternal(sessionId, parsed.connectionId, progressCb, { allowReuse: false });
}

async function connectInternal(storageKey, connectionId, progressCb, { allowReuse }) {
  const conn = await getRawConnection(connectionId);
  if (!conn) return { success: false, message: "Connection not found" };
  if (conn.credentialError === "VAULT_LOCKED") {
    return { success: false, code: "VAULT_LOCKED", message: "Credential vault is locked" };
  }
  if (conn.credentialError === "LEGACY_CREDENTIAL_UNAVAILABLE") {
    return { success: false, code: "CREDENTIAL_REENTRY_REQUIRED", message: "This password was encrypted on another machine. Unlock the vault, edit this connection, and enter the password again." };
  }
  if (conn.credentialError) return { success: false, code: conn.credentialError, message: "Stored credential cannot be decrypted" };

  if (activeConnections[storageKey]) {
    if (allowReuse) {
      const alive = await pingConnection(storageKey);
      if (alive) {
        await touchLastConnected(connectionId);
        return { success: true, message: "Already connected", sessionId: storageKey };
      }
    }
    dropActiveConnection(storageKey);
    progressCb && progressCb(`Reconnecting to ${conn.host}:${conn.port}...`);
  } else {
    progressCb && progressCb(`Connecting to ${conn.host}:${conn.port}...`);
  }

  const result = conn.type === "ftp"
    ? await connectFtp(storageKey, conn, progressCb, connectionId)
    : await connectSftp(storageKey, conn, progressCb, connectionId);
  if (result.success) {
    await touchLastConnected(connectionId);
    result.sessionId = storageKey;
  }
  return result;
}

async function ensureConnected(id) {
  if (!getActive(id)) return { success: false, message: "Not connected" };
  const alive = await pingConnection(id);
  if (alive) return { success: true };
  const connId = connectionIdOf(id, getActive(id));
  dropActiveConnection(id);
  log.info(`Auto-reconnecting ${id}...`);
  if (sessionManager.isSessionId(id)) return connectSession(id);
  return connect(connId);
}

async function connectSftp(storageKey, conn, progressCb, connectionId = storageKey) {
  const { Client } = require("ssh2");
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const connectOpts = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
    };

    if (conn.privateKey && fs.existsSync(conn.privateKey)) {
      connectOpts.privateKey = fs.readFileSync(conn.privateKey);
    } else if (conn.password) {
      connectOpts.password = conn.password;
    } else {
      return done({ success: false, message: "No password or private key configured" });
    }

    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err) {
          const detail = err.message || "SFTP subsystem could not be started";
          log.err("SFTP session error: " + detail);
          // SSH authentication succeeded, but the server may not expose the
          // SFTP subsystem. Keep the SSH transport alive so Terminal remains
          // usable and report the limitation to the UI.
          activeConnections[storageKey] = {
            client,
            type: "ssh",
            connectionId,
            sftpError: detail,
          };
          progressCb && progressCb("SSH connected; SFTP unavailable");
          return done({
            success: true,
            transport: "ssh",
            warning: `SSH login succeeded, but SFTP is unavailable: ${detail}`,
          });
        }
        sinkStreamErrors(sftp);
        activeConnections[storageKey] = { client, sftp, type: "sftp", connectionId };
        progressCb && progressCb("Connected!");
        log.ok(`SFTP connected: ${conn.host} [${storageKey}]`);
        done({ success: true });
      });
    });

    client.on("error", (err) => {
      if (isPipeError(err) && activeConnections[storageKey] && activeConnections[storageKey].client === client) {
        dropActiveConnection(storageKey);
        log.err("SSH connection dropped: " + err.message);
        return;
      }
      log.err("SSH error: " + err.message);
      if (activeConnections[storageKey] && activeConnections[storageKey].client === client) dropActiveConnection(storageKey);
      else safeCloseSsh(client);
      done({ success: false, message: err.message });
    });

    client.on("close", () => {
      if (activeConnections[storageKey] && activeConnections[storageKey].client === client) {
        dropActiveConnection(storageKey);
      }
      if (!settled) done({ success: false, message: "SSH connection closed" });
    });

    try {
      client.connect(connectOpts);
    } catch (err) {
      done({ success: false, message: err.message });
    }
  });
}

async function connectFtp(storageKey, conn, progressCb, connectionId = storageKey) {
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
    activeConnections[storageKey] = { client, type: "ftp", connectionId };
    progressCb && progressCb("Connected!");
    log.ok(`FTP connected: ${conn.host} [${storageKey}]`);
    return { success: true };
  } catch (err) {
    log.err("FTP error: " + err.message);
    try { client.close(); } catch {}
    return { success: false, message: err.message };
  }
}

async function disconnect(id) {
  if (sessionManager.isSessionId(id)) {
    dropActiveConnection(id);
    sessionManager.remove(id);
    try { require("./remote-windows").closeWindow(id); } catch {}
    log.info(`Disconnected session: ${id}`);
    return { success: true };
  }

  dropActiveConnection(id);
  for (const session of sessionManager.listByConnection(id)) {
    dropActiveConnection(session.id);
    sessionManager.remove(session.id);
    try { require("./remote-windows").closeWindow(session.id); } catch {}
  }
  log.info(`Disconnected: ${id}`);
  return { success: true };
}

async function disconnectAll() {
  for (const id of Object.keys(activeConnections)) {
    dropActiveConnection(id);
  }
  for (const sid of Object.keys(activeShells)) {
    hardStopShell(sid);
  }
  for (const session of sessionManager.listAll()) {
    sessionManager.remove(session.id);
  }
  try { require("./remote-windows").closeAllWindows(); } catch {}
  log.info("Disconnected all remote sessions");
  return { success: true };
}

async function closeSession(sessionId) {
  if (!sessionId) return { success: true };
  dropActiveConnection(sessionId);
  hardStopShell(sessionId);
  sessionManager.remove(sessionId);
  try { require("./remote-windows").closeWindow(sessionId); } catch {}
  return { success: true };
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function formatRemotePermissions(mode, permissions, longname = "") {
  let digits = null;
  if (permissions && ["user", "group", "world"].every((key) => Number.isInteger(permissions[key]))) {
    digits = [permissions.user, permissions.group, permissions.world].map((value) => value & 7);
  } else if (Number.isInteger(mode)) {
    digits = [(mode >> 6) & 7, (mode >> 3) & 7, mode & 7];
  }
  if (digits) {
    const symbolic = digits.map((value) =>
      `${value & 4 ? "r" : "-"}${value & 2 ? "w" : "-"}${value & 1 ? "x" : "-"}`,
    ).join("");
    return `${symbolic} (${digits.join("")})`;
  }
  const symbolic = String(longname || "").substring(1, 10);
  return symbolic.length === 9 ? symbolic : "";
}

function parseOwnerGroupFromLongname(longname = "") {
  const match = String(longname || "").match(
    /^[bcdelfmpSs-](?:[r-][w-][xsStTL-]){3}\+?\s+\d+\s+(\S+)\s+(\S+)\s+/,
  );
  if (!match) return { owner: "", group: "" };
  return { owner: match[1] || "", group: match[2] || "" };
}

function fileKindLabel(name, isDirectory, isLink) {
  if (isLink && isDirectory) return "link-dir";
  if (isLink) return "link";
  if (isDirectory) return "folder";
  const base = String(name || "");
  const idx = base.lastIndexOf(".");
  if (idx < 0) return "file";
  return base.slice(idx + 1).toLowerCase() || "file";
}

function mapSftpListItem(item) {
  const mode = Number.isInteger(item.attrs?.mode) ? item.attrs.mode : null;
  const longname = item.longname || "";
  const isLink = (mode & S_IFMT) === S_IFLNK || longname.startsWith("l");
  const isDir = (mode & S_IFMT) === S_IFDIR || longname.startsWith("d");
  const name = item.filename;
  const ownership = parseOwnerGroupFromLongname(longname);
  return {
    name,
    type: isDir ? "directory" : isLink ? "link" : "file",
    isDirectory: isDir,
    isLink,
    size: item.attrs?.size || 0,
    modified: item.attrs?.mtime ? new Date(item.attrs.mtime * 1000).toISOString() : "",
    permissions: formatRemotePermissions(mode, null, longname),
    owner: ownership.owner,
    group: ownership.group,
    kind: fileKindLabel(name, isDir, isLink),
  };
}

function mapFtpListItem(item) {
  const isLink = item.type === 3;
  const isDir = item.type === 2;
  const name = item.name;
  return {
    name,
    type: isDir ? "directory" : isLink ? "link" : "file",
    isDirectory: isDir,
    isLink,
    size: item.size || 0,
    modified: item.modifiedAt ? item.modifiedAt.toISOString() : "",
    permissions: formatRemotePermissions(null, item.permissions),
    owner: item.user || "",
    group: item.group || "",
    kind: fileKindLabel(name, isDir, isLink),
  };
}

function sortRemoteItems(items, sortKey = "name", sortDir = 1) {
  const dir = sortDir < 0 ? -1 : 1;
  return [...items].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (sortKey === "modified") {
      cmp = String(a.modified || "").localeCompare(String(b.modified || ""));
    } else if (sortKey === "size") {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (sortKey === "kind") {
      cmp = String(a.kind || "").localeCompare(String(b.kind || ""), undefined, { sensitivity: "base" });
    } else {
      cmp = String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
    }
    return cmp * dir;
  });
}

function sftpStatFollow(sftp, remotePath) {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => resolve(err ? null : stats));
  });
}

async function resolveLinkTargets(sftp, remotePath, items) {
  for (const item of items) {
    if (!item.isLink) continue;
    const stats = await sftpStatFollow(sftp, joinRemotePath(remotePath, item.name));
    if (!stats) continue;
    item.isDirectory = !!stats.isDirectory();
    item.type = item.isDirectory ? "directory" : "file";
    item.kind = fileKindLabel(item.name, item.isDirectory, true);
    if (stats.size) item.size = stats.size;
  }
  return items;
}

async function listRemote(id, remotePath) {
  const ok = await ensureConnected(id);
  if (!ok.success) return { success: false, message: ok.message || "Not connected" };
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };
  if (ac.type === "ssh") {
    return {
      success: false,
      code: "SFTP_UNAVAILABLE",
      message: `SSH terminal is connected, but SFTP is unavailable. The server rejected the SFTP subsystem${ac.sftpError ? `: ${ac.sftpError}` : "."}`,
    };
  }

  try {
    if (ac.type === "sftp") {
      const list = await new Promise((resolve, reject) => {
        ac.sftp.readdir(remotePath, (err, entries) => err ? reject(err) : resolve(entries || []));
      });
      let items = list
        .filter((item) => item.filename !== "." && item.filename !== "..")
        .map(mapSftpListItem);
      items = await resolveLinkTargets(ac.sftp, remotePath, items);
      return { success: true, items: sortRemoteItems(items), path: remotePath };
    }
    if (ac.type === "ftp") {
      await ac.client.cd(remotePath);
      let list;
      try {
        list = await ac.client.list("-a");
      } catch {
        list = await ac.client.list();
      }
      const items = (list || [])
        .filter((item) => item.name !== "." && item.name !== "..")
        .map(mapFtpListItem);
      for (const item of items) {
        if (!item.isLink) continue;
        try {
          await ac.client.list(joinRemotePath(remotePath, item.name));
          item.isDirectory = true;
          item.type = "directory";
          item.kind = fileKindLabel(item.name, true, true);
        } catch {}
      }
      return { success: true, items: sortRemoteItems(items), path: remotePath };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function joinLocalDownloadPath(localRoot, relativePath) {
  const parts = String(relativePath || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? path.join(localRoot, ...parts) : localRoot;
}

function isRemoteDirectory(item) {
  return !!(item && (item.isDirectory || item.type === "directory"));
}

async function collectRemoteFiles(id, remotePath) {
  const files = [];
  const dirs = [];
  async function walk(dir, relativePath) {
    const listed = await listRemote(id, dir);
    if (!listed.success) throw new Error(listed.message || "Could not list remote directory");
    dirs.push({ remotePath: dir, relativePath });
    for (const item of listed.items || []) {
      const childRemote = joinRemotePath(dir, item.name);
      const childRel = relativePath ? `${relativePath}/${item.name}` : item.name;
      if (isRemoteDirectory(item)) await walk(childRemote, childRel);
      else files.push({ remotePath: childRemote, relativePath: childRel, size: item.size || 0, name: childRel });
    }
  }
  await walk(remotePath, "");
  return { files, dirs };
}

async function downloadFile(id, remotePath, localPath, progressCb, opts = {}) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  await fs.ensureDir(path.dirname(localPath));
  const name = path.basename(remotePath);
  progressCb && progressCb(`Downloading ${name}...`);
  let lastStep = 0;
  const emitBytes = (transferred, total) => {
    if (typeof opts.onStep !== "function") return;
    const now = Date.now();
    if (transferred < total && now - lastStep < 120) return;
    lastStep = now;
    opts.onStep(transferred, total);
  };

  try {
    if (ac.type === "sftp") {
      return new Promise((resolve) => {
        ac.sftp.fastGet(remotePath, localPath, {
          step: (transferred, _chunk, total) => emitBytes(transferred, total),
        }, (err) => {
          if (err) return resolve({ success: false, message: err.message });
          progressCb && progressCb(`Downloaded: ${name}`);
          resolve({ success: true });
        });
      });
    }
    if (ac.type === "ftp") {
      try {
        ac.client.trackProgress((info) => emitBytes(info.bytes || info.bytesOverall || 0, opts.size || 0));
        await ac.client.downloadTo(localPath, remotePath);
      } finally {
        try { ac.client.trackProgress(); } catch {}
      }
      progressCb && progressCb(`Downloaded: ${name}`);
      return { success: true };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function joinRemotePath(base, name) {
  const root = String(base || "/").replace(/\/+$/, "") || "";
  return `${root}/${name}`.replace(/\/{2,}/g, "/");
}

async function ensureRemoteDir(id, remotePath) {
  if (!remotePath || remotePath === "/") return { success: true };
  const exists = await checkRemoteExists(id, remotePath);
  if (exists.exists) {
    if (exists.isDirectory) return { success: true };
    return { success: false, message: `A file already exists at ${remotePath}` };
  }
  const parent = path.posix.dirname(remotePath);
  if (parent && parent !== "." && parent !== remotePath) {
    const parentResult = await ensureRemoteDir(id, parent);
    if (!parentResult.success) return parentResult;
  }
  try {
    await createRemoteDirOnConnection(activeConnections[id], remotePath);
    return { success: true };
  } catch (error) {
    if (/exist/i.test(error.message || "")) {
      const again = await checkRemoteExists(id, remotePath);
      if (again.exists && again.isDirectory) return { success: true };
    }
    return { success: false, message: error.message };
  }
}

async function collectLocalFiles(localPath) {
  const items = [];
  async function walk(abs, rel) {
    let stat;
    try { stat = await fs.stat(abs); } catch { return; }
    if (stat.isDirectory()) {
      const names = await fs.readdir(abs);
      for (const name of names) {
        if (name === "." || name === "..") continue;
        await walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
      return;
    }
    if (stat.isFile()) items.push({ localPath: abs, relativePath: rel || path.basename(abs), size: stat.size });
  }
  const stat = await fs.stat(localPath);
  if (stat.isFile()) return [{ localPath, relativePath: path.basename(localPath), size: stat.size }];
  if (stat.isDirectory()) await walk(localPath, "");
  return items;
}

async function putLocalFile(id, localPath, remotePath, opts = {}) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };
  let lastStep = 0;
  const emitBytes = (transferred, total) => {
    if (typeof opts.onStep !== "function") return;
    const now = Date.now();
    if (transferred < total && now - lastStep < 120) return;
    lastStep = now;
    opts.onStep(transferred, total);
  };
  try {
    if (ac.type === "sftp") {
      return await new Promise((resolve) => {
        ac.sftp.fastPut(localPath, remotePath, {
          step: (transferred, _chunk, total) => emitBytes(transferred, total),
        }, (err) => {
          if (err) return resolve({ success: false, message: err.message });
          resolve({ success: true, uploaded: 1 });
        });
      });
    }
    if (ac.type === "ftp") {
      try {
        ac.client.trackProgress((info) => emitBytes(info.bytes || 0, opts.size || 0));
        await ac.client.uploadFrom(localPath, remotePath);
      } finally {
        try { ac.client.trackProgress(); } catch {}
      }
      return { success: true, uploaded: 1 };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
  return { success: false, message: "Unsupported connection type" };
}

function emitUploadProgress(progressCb, payload) {
  if (!progressCb) return;
  progressCb(payload);
  if (payload && payload.type && payload.name) {
    if (payload.type === "file-start") progressCb(`Uploading ${payload.name}...`);
    if (payload.type === "file-done" && payload.success) progressCb(`Uploaded: ${payload.name}`);
    if (payload.type === "file-done" && !payload.success) progressCb(`Failed: ${payload.name} — ${payload.message || ""}`);
  }
}

function isDisconnectError(message) {
  return /not connected|epipe|econnreset|enotconn|etimedout|timed out|connection (lost|closed|reset)|socket|ssh connection closed|no response/i.test(String(message || ""));
}

let uploadCancelled = false;
let syncCancelled = false;

function cancelUpload() {
  uploadCancelled = true;
  return { success: true };
}

function cancelSync() {
  syncCancelled = true;
  return { success: true };
}

async function runConcurrent(items, concurrency, worker) {
  const queue = [...items];
  const limit = Math.max(1, Math.min(8, Number(concurrency) || 1));
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, queue.length || 1) }, async () => {
    while (!syncCancelled) {
      const index = cursor++;
      if (index >= queue.length) return;
      await worker(queue[index], index);
    }
  });
  await Promise.all(runners);
  return syncCancelled;
}

function emitRemainingFailed(progressCb, files, startIndex, total, retry, message) {
  for (let j = startIndex; j < files.length; j++) {
    const left = files[j];
    emitUploadProgress(progressCb, {
      type: "file-done",
      index: retry && left.index ? left.index : j + 1,
      total,
      name: left.name,
      localPath: left.localPath,
      remotePath: left.remotePath,
      success: false,
      cancelled: message === "Stopped",
      message,
    });
  }
  return files.length - startIndex;
}

async function uploadBatch(id, items, progressCb, opts = {}) {
  uploadCancelled = false;
  const retry = !!opts.retry;
  const connected = await ensureConnected(id);
  if (!connected.success) return connected;
  const files = [];
  for (const item of items || []) {
    if (!item?.localPath || !fs.existsSync(item.localPath)) {
      emitUploadProgress(progressCb, {
        type: "file-done",
        name: path.basename(item?.localPath || "unknown"),
        localPath: item?.localPath,
        remotePath: item?.remotePath,
        success: false,
        message: "Local path not found",
        index: item?.index || 0,
        total: 0,
        retry,
      });
      continue;
    }
    const stat = await fs.stat(item.localPath);
    if (stat.isDirectory()) {
      const nested = await collectLocalFiles(item.localPath);
      const dirOk = await ensureRemoteDir(id, item.remotePath);
      if (!dirOk.success) return dirOk;
      for (const file of nested) {
        files.push({
          localPath: file.localPath,
          remotePath: joinRemotePath(item.remotePath, file.relativePath),
          name: `${path.basename(item.localPath)}/${file.relativePath}`.replace(/\\/g, "/"),
          size: file.size,
          index: item.index,
        });
      }
    } else if (stat.isFile()) {
      files.push({
        localPath: item.localPath,
        remotePath: item.remotePath,
        name: item.name || path.basename(item.localPath),
        size: stat.size,
        index: item.index,
      });
    }
  }

  if (!retry) emitUploadProgress(progressCb, { type: "batch-start", total: files.length });
  let uploaded = 0;
  let failed = 0;
  let stopped = false;
  let disconnect = false;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const index = retry && file.index ? file.index : i + 1;
    if (uploadCancelled) {
      stopped = true;
      failed += emitRemainingFailed(progressCb, files, i, files.length, retry, "Stopped");
      break;
    }
    emitUploadProgress(progressCb, {
      type: "file-start",
      index,
      total: files.length,
      name: file.name,
      path: file.remotePath,
      localPath: file.localPath,
      remotePath: file.remotePath,
      retry,
      direction: "upload",
    });
    const parent = path.posix.dirname(file.remotePath);
    if (parent && parent !== "." && parent !== file.remotePath) {
      const dirOk = await ensureRemoteDir(id, parent);
      if (!dirOk.success) {
        failed++;
        emitUploadProgress(progressCb, {
          type: "file-done",
          index,
          total: files.length,
          name: file.name,
          localPath: file.localPath,
          remotePath: file.remotePath,
          success: false,
          message: isDisconnectError(dirOk.message) ? "Connection lost" : dirOk.message,
        });
        if (isDisconnectError(dirOk.message)) {
          const recon = await ensureConnected(id);
          if (!recon.success) {
            disconnect = true;
            failed += emitRemainingFailed(progressCb, files, i + 1, files.length, retry, "Connection lost");
            break;
          }
        }
        continue;
      }
    }
    let result = await putLocalFile(id, file.localPath, file.remotePath, {
      size: file.size,
      onStep: (transferred, total) => {
        emitUploadProgress(progressCb, {
          type: "file-progress",
          index,
          total: files.length,
          name: file.name,
          transferred,
          bytesTotal: total || file.size || 0,
          direction: "upload",
        });
      },
    });
    if (!result.success && isDisconnectError(result.message) && !uploadCancelled) {
      const recon = await ensureConnected(id);
      if (recon.success) {
        result = await putLocalFile(id, file.localPath, file.remotePath, {
          size: file.size,
          onStep: (transferred, total) => {
            emitUploadProgress(progressCb, {
              type: "file-progress",
              index,
              total: files.length,
              name: file.name,
              transferred,
              bytesTotal: total || file.size || 0,
              direction: "upload",
            });
          },
        });
      }
      else {
        disconnect = true;
        result = { success: false, message: "Connection lost" };
      }
    }
    if (result.success) uploaded++;
    else failed++;
    emitUploadProgress(progressCb, {
      type: "file-done",
      index,
      total: files.length,
      name: file.name,
      localPath: file.localPath,
      remotePath: file.remotePath,
      success: !!result.success,
      message: result.message,
      retry,
      direction: "upload",
    });
    if (disconnect && !result.success) {
      failed += emitRemainingFailed(progressCb, files, i + 1, files.length, retry, "Connection lost");
      break;
    }
  }
  if (!retry) {
    emitUploadProgress(progressCb, {
      type: "batch-end",
      uploaded,
      failed,
      total: files.length,
      cancelled: stopped,
      disconnect,
      direction: "upload",
    });
  }
  return {
    success: failed === 0 && !stopped,
    uploaded,
    failed,
    total: files.length,
    cancelled: stopped,
    disconnect,
    message: disconnect ? "Connection lost" : (stopped ? "Upload stopped" : (failed ? `${failed} file(s) failed` : undefined)),
  };
}

async function downloadBatch(id, items, progressCb, opts = {}) {
  uploadCancelled = false;
  const retry = !!opts.retry;
  const connected = await ensureConnected(id);
  if (!connected.success) return connected;
  const files = [];
  try {
    for (const item of items || []) {
      if (!item?.remotePath || !item?.localPath) {
        emitUploadProgress(progressCb, {
          type: "file-done",
          name: path.basename(item?.remotePath || "unknown"),
          localPath: item?.localPath,
          remotePath: item?.remotePath,
          success: false,
          message: "Missing download path",
          index: item?.index || 0,
          total: 0,
          retry,
          direction: "download",
        });
        continue;
      }
      if (item.isDirectory) {
        const collected = await collectRemoteFiles(id, item.remotePath);
        for (const dir of collected.dirs) {
          await fs.ensureDir(joinLocalDownloadPath(item.localPath, dir.relativePath));
        }
        for (const file of collected.files) {
          files.push({
            remotePath: file.remotePath,
            localPath: joinLocalDownloadPath(item.localPath, file.relativePath),
            name: `${path.basename(item.localPath)}/${file.relativePath}`.replace(/\\/g, "/"),
            size: file.size,
            index: item.index,
          });
        }
      } else {
        files.push({
          remotePath: item.remotePath,
          localPath: item.localPath,
          name: item.name || path.basename(item.remotePath),
          size: item.size || 0,
          index: item.index,
        });
      }
    }
  } catch (err) {
    return { success: false, message: err.message };
  }

  if (!retry) emitUploadProgress(progressCb, { type: "batch-start", total: files.length, direction: "download" });
  let downloaded = 0;
  let failed = 0;
  let stopped = false;
  let disconnect = false;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const index = retry && file.index ? file.index : i + 1;
    if (uploadCancelled) {
      stopped = true;
      failed += emitRemainingFailed(progressCb, files, i, files.length, retry, "Stopped");
      break;
    }
    emitUploadProgress(progressCb, {
      type: "file-start",
      index,
      total: files.length,
      name: file.name,
      localPath: file.localPath,
      remotePath: file.remotePath,
      size: file.size,
      retry,
      direction: "download",
    });
    await fs.ensureDir(path.dirname(file.localPath));
    let result = await downloadFile(id, file.remotePath, file.localPath, null, {
      size: file.size,
      onStep: (transferred, total) => {
        emitUploadProgress(progressCb, {
          type: "file-progress",
          index,
          total: files.length,
          name: file.name,
          transferred,
          bytesTotal: total || file.size || 0,
          direction: "download",
        });
      },
    });
    if (!result.success && isDisconnectError(result.message) && !uploadCancelled) {
      const recon = await ensureConnected(id);
      if (recon.success) {
        result = await downloadFile(id, file.remotePath, file.localPath, null, { size: file.size });
      } else {
        disconnect = true;
        result = { success: false, message: "Connection lost" };
      }
    }
    if (result.success) downloaded++;
    else failed++;
    emitUploadProgress(progressCb, {
      type: "file-done",
      index,
      total: files.length,
      name: file.name,
      localPath: file.localPath,
      remotePath: file.remotePath,
      success: !!result.success,
      message: result.message,
      retry,
      direction: "download",
    });
    if (disconnect && !result.success) {
      failed += emitRemainingFailed(progressCb, files, i + 1, files.length, retry, "Connection lost");
      break;
    }
  }
  if (!retry) {
    emitUploadProgress(progressCb, {
      type: "batch-end",
      downloaded,
      uploaded: downloaded,
      failed,
      total: files.length,
      cancelled: stopped,
      disconnect,
      direction: "download",
    });
  }
  return {
    success: failed === 0 && !stopped,
    downloaded,
    failed,
    total: files.length,
    cancelled: stopped,
    disconnect,
    message: disconnect ? "Connection lost" : (stopped ? "Download stopped" : (failed ? `${failed} file(s) failed` : undefined)),
  };
}

async function uploadFile(id, localPath, remotePath, progressCb) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };
  if (!fs.existsSync(localPath)) return { success: false, message: "Local path not found" };
  return uploadBatch(id, [{ localPath, remotePath }], progressCb);
}

async function statLocalPath(localPath) {
  try {
    const stat = await fs.stat(localPath);
    return {
      success: true,
      exists: true,
      isDirectory: stat.isDirectory(),
      size: stat.size,
      name: path.basename(localPath),
    };
  } catch {
    return { success: true, exists: false };
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
  if (ac?.type === "ssh") return { success: false, message: "SFTP is unavailable; sync requires SFTP or FTP" };

  const excludes = new Set(conn.excludePaths || []);
  const changedOnly = opts.changedOnly === true;
  const concurrency = ac.type === "ftp" ? 1 : Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
  let uploaded = 0;
  let skipped = 0;
  let errors = 0;
  const files = [];

  async function syncDir(localBase, remoteBase) {
    const entries = await fs.readdir(localBase, { withFileTypes: true });
    for (const entry of entries) {
      if (syncCancelled) return;
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
      } else if (entry.isFile()) files.push({ localPath: localP, remotePath: remoteP, name: entry.name });
    }
  }

  const modeLabel = changedOnly ? " (changed files only)" : "";
  syncCancelled = false;
  progressCb && progressCb(`Syncing${modeLabel}: ${localDir} → ${conn.remotePath} (${concurrency} thread${concurrency === 1 ? "" : "s"})...`);
  await syncDir(localDir, conn.remotePath);
  const pending = [];
  for (const file of files) {
    if (syncCancelled) break;
    if (changedOnly) {
      const localStat = await fs.stat(file.localPath);
      const remoteMtime = await getRemoteMtime(id, file.remotePath);
      if (remoteMtime !== null && remoteMtime >= localStat.mtimeMs) { skipped++; continue; }
    }
    pending.push(file);
  }
  const cancelled = await runConcurrent(pending, concurrency, async (file) => {
    if (syncCancelled) return;
    progressCb && progressCb(`Uploading ${file.name}...`);
    const parent = path.posix.dirname(file.remotePath);
    const dirOk = await ensureRemoteDir(id, parent);
    if (!dirOk.success) { errors++; return; }
    const r = await putLocalFile(id, file.localPath, file.remotePath);
    if (r.success) uploaded++;
    else errors++;
  });
  const stopped = cancelled || syncCancelled;
  const msg = stopped
    ? `Sync stopped: ${uploaded} uploaded, ${skipped} skipped, ${errors} errors`
    : `Sync complete: ${uploaded} uploaded, ${skipped} skipped, ${errors} errors`;
  progressCb && progressCb(msg);
  log.ok(msg);
  return { success: !stopped, uploaded, skipped, errors, cancelled: stopped, message: stopped ? "Sync stopped" : undefined };
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
  const ac = activeConnections[id];
  if (ac?.type === "ssh") return { success: false, message: "SFTP is unavailable; sync requires SFTP or FTP" };

  const excludes = new Set(conn.excludePaths || []);
  const changedOnly = opts.changedOnly === true;
  const concurrency = ac.type === "ftp" ? 1 : Math.max(1, Math.min(8, Number(opts.concurrency) || 3));
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;
  const files = [];

  async function syncDir(remoteBase, localBase) {
    const listResult = await listRemote(id, remoteBase);
    if (!listResult.success) return;

    for (const item of listResult.items) {
      if (syncCancelled) return;
      if (excludes.has(item.name)) continue;

      const remoteP = remoteBase + "/" + item.name;
      const localP = path.join(localBase, item.name);

      if (item.type === "directory") {
        await fs.ensureDir(localP);
        await syncDir(remoteP, localP);
      } else {
        files.push({ remotePath: remoteP, localPath: localP, name: item.name, modified: item.modified });
      }
    }
  }

  const modeLabel = changedOnly ? " (changed files only)" : "";
  syncCancelled = false;
  progressCb && progressCb(`Syncing${modeLabel}: ${conn.remotePath} → ${localDir} (${concurrency} thread${concurrency === 1 ? "" : "s"})...`);
  await syncDir(conn.remotePath, localDir);
  const pending = [];
  for (const file of files) {
    if (syncCancelled) break;
    if (changedOnly && fs.existsSync(file.localPath)) {
      const localStat = await fs.stat(file.localPath);
      const remoteMtime = file.modified ? new Date(file.modified).getTime() : null;
      if (remoteMtime !== null && remoteMtime <= localStat.mtimeMs) { skipped++; continue; }
    }
    pending.push(file);
  }
  const cancelled = await runConcurrent(pending, concurrency, async (file) => {
    if (syncCancelled) return;
    try {
      progressCb && progressCb(`Downloading ${file.name}...`);
      const r = await downloadFile(id, file.remotePath, file.localPath, progressCb);
      if (r.success) downloaded++;
      else errors++;
    } catch { errors++; }
  });
  const stopped = cancelled || syncCancelled;
  const msg = stopped
    ? `Sync stopped: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`
    : `Sync complete: ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`;
  progressCb && progressCb(msg);
  log.ok(msg);
  return { success: !stopped, downloaded, skipped, errors, cancelled: stopped, message: stopped ? "Sync stopped" : undefined };
}

// ─── Terminal (SSH interactive shell) ────────────────────────────────────────
// Track current working directory per connection for cd support
const terminalCwd = {};
const remoteSystemCache = {};
const remoteStatsCache = {};
/** @type {Record<string, { stream: any, connectionId: string, webContentsId: number|null }>} */
const activeShells = {};

function emitShell(sessionId, webContentsId, channel, payload) {
  if (sessionManager.send(sessionId, channel, payload)) return;
  if (webContentsId != null) {
    try {
      const { webContents } = require("electron");
      const wc = webContents.fromId(Number(webContentsId));
      if (wc && !wc.isDestroyed()) {
        wc.send(channel, payload);
        return;
      }
    } catch {}
  }
  try { global.STATE.mainWindow?.webContents?.send(channel, payload); } catch {}
}

function hardStopShell(sessionId) {
  const entry = activeShells[sessionId];
  if (!entry) return { success: true };
  delete activeShells[sessionId];
  const stream = entry.stream;
  if (!stream) return { success: true };
  try {
    if (typeof stream.removeAllListeners === "function") {
      stream.removeAllListeners("data");
      stream.removeAllListeners("close");
      stream.stderr?.removeAllListeners?.("data");
    }
  } catch {}
  try { if (stream.writable !== false) stream.write("\x03"); } catch {}
  try { if (stream.writable !== false) stream.end("exit\n"); } catch {}
  try { if (typeof stream.destroy === "function") stream.destroy(); } catch {}
  setTimeout(() => {
    try { if (stream && !stream.destroyed && typeof stream.destroy === "function") stream.destroy(); } catch {}
  }, 400);
  return { success: true };
}

function stopShellsForKey(id) {
  for (const [sessionId, entry] of Object.entries(activeShells)) {
    if (sessionId === id || entry.connectionId === id || entry.storageKey === id) {
      hardStopShell(sessionId);
    }
  }
}

/**
 * Start an interactive SSH shell. Always creates a NEW session id — never reuses.
 * @returns {{ success: boolean, sessionId?: string, message?: string }}
 */
async function startShell(id, cols = 100, rows = 30, opts = {}) {
  const storageKey = id;
  const connected = await ensureConnected(storageKey);
  if (!connected.success) return connected;
  const ac = getActive(storageKey);
  if (!ac || (ac.type !== "sftp" && ac.type !== "ssh")) return { success: false, message: "Not connected via SSH" };

  const connectionId = connectionIdOf(storageKey, ac);
  const sessionId = opts.sessionId && String(opts.sessionId).startsWith("terminal:")
    ? String(opts.sessionId)
    : `terminal:${connectionId}:${crypto.randomUUID()}`;

  // Never reuse an existing PTY/stream — destroy any leftover for this session id.
  if (activeShells[sessionId]) hardStopShell(sessionId);

  const webContentsId = opts.webContentsId != null
    ? Number(opts.webContentsId)
    : (sessionManager.get(sessionId)?.webContentsId ?? null);

  return new Promise((resolve) => {
    ac.client.shell({ term: "xterm-256color", cols, rows }, (error, stream) => {
      if (error) return resolve({ success: false, message: error.message });
      activeShells[sessionId] = {
        stream,
        connectionId,
        storageKey,
        webContentsId,
      };
      sinkStreamErrors(stream);
      stream.on("data", (data) => {
        emitShell(sessionId, webContentsId, "sftp-shell-data", { id: sessionId, connectionId, data: data.toString("utf8") });
      });
      stream.stderr?.on("data", (data) => {
        emitShell(sessionId, webContentsId, "sftp-shell-data", { id: sessionId, connectionId, data: data.toString("utf8") });
      });
      stream.on("close", () => {
        if (activeShells[sessionId]?.stream === stream) delete activeShells[sessionId];
        emitShell(sessionId, webContentsId, "sftp-shell-exit", { id: sessionId, connectionId });
      });
      if (!sessionManager.get(sessionId)) {
        try {
          sessionManager.create({
            kind: "terminal",
            connectionId,
            webContentsId,
            title: opts.title || "",
            sessionId,
          });
        } catch {}
      } else {
        sessionManager.update(sessionId, { webContentsId });
      }
      resolve({ success: true, sessionId });
    });
  });
}

function writeShell(sessionId, data) {
  const entry = activeShells[sessionId];
  if (!entry || !entry.stream || entry.stream.destroyed || entry.stream.writable === false) {
    return { success: false, message: "SSH shell is not running" };
  }
  try {
    entry.stream.write(String(data || ""));
    return { success: true };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

function resizeShell(sessionId, cols, rows) {
  const entry = activeShells[sessionId];
  if (!entry || !entry.stream || entry.stream.destroyed) return { success: false };
  entry.stream.setWindow(Math.max(2, rows || 30), Math.max(2, cols || 100), 0, 0);
  return { success: true };
}

function stopShell(sessionId) {
  return hardStopShell(sessionId);
}

async function getRemoteSystemInfo(id) {
  if (remoteSystemCache[id]) return { success: true, ...remoteSystemCache[id] };
  const ac = activeConnections[id];
  if (!ac || ac.type !== "sftp") return { success: false, message: "Not connected via SSH" };
  const command = "printf '__OS__\\n'; cat /etc/os-release 2>/dev/null; printf '__TOOLS__\\n'; for c in apt apt-get dnf yum apk pacman zypper systemctl service; do command -v $c >/dev/null 2>&1 && printf '%s\\n' $c; done; printf '__SHELL__\\n'; printf '%s\\n' \"$SHELL\"";
  return new Promise((resolve) => {
    ac.client.exec(command, (error, stream) => {
      if (error) return resolve({ success: false, message: error.message });
      sinkStreamErrors(stream);
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

function sshExecText(ac, command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, message: "timeout" }), timeoutMs);
    ac.client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer);
        return resolve({ success: false, message: error.message });
      }
      sinkStreamErrors(stream);
      let output = "";
      stream.on("data", (chunk) => { output += chunk.toString(); });
      stream.stderr.on("data", () => {});
      stream.on("close", () => {
        clearTimeout(timer);
        resolve({ success: true, output });
      });
    });
  });
}

function parseCpuLine(line) {
  const parts = String(line || "").trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  const total = parts.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return { idle, total };
}

async function getRemoteStats(id) {
  const ac = activeConnections[id];
  if (!ac || ac.type !== "sftp") return { success: false, message: "Not connected via SSH" };
  const command = [
    "printf '__CPU__\\n'",
    "grep '^cpu ' /proc/stat",
    "printf '__CORES__\\n'",
    "nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo",
    "printf '__MEM__\\n'",
    "awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{print t+0,a+0}' /proc/meminfo",
    "printf '__DISK__\\n'",
    "df -P / | awk 'NR==2{gsub(/%/,\"\",$5); print $2+0,$3+0,$5+0}'",
    "printf '__NET__\\n'",
    "awk 'NR>2 && $1 !~ /lo:/ {rx+=$2; tx+=$10} END{print rx+0, tx+0}' /proc/net/dev",
  ].join("; ");
  const result = await sshExecText(ac, command);
  if (!result.success) return result;
  const output = result.output || "";
  const cpuLine = (output.split("__CPU__\n")[1] || "").split("__CORES__\n")[0].trim();
  const coresLine = (output.split("__CORES__\n")[1] || "").split("__MEM__\n")[0].trim();
  const memLine = (output.split("__MEM__\n")[1] || "").split("__DISK__\n")[0].trim();
  const diskLine = (output.split("__DISK__\n")[1] || "").split("__NET__\n")[0].trim();
  const netLine = (output.split("__NET__\n")[1] || "").trim();
  const cpuSample = parseCpuLine(cpuLine);
  const cpuCores = parseInt(coresLine, 10);
  const [memTotal, memAvail] = memLine.split(/\s+/).map(Number);
  const [diskTotal, diskUsed, diskPctRaw] = diskLine.split(/\s+/).map(Number);
  const [rx, tx] = netLine.split(/\s+/).map(Number);
  const now = Date.now();
  const prev = remoteStatsCache[id];
  let cpuPct = null;
  let netDown = null;
  let netUp = null;
  if (prev && cpuSample.total > prev.cpu.total) {
    const idleDelta = cpuSample.idle - prev.cpu.idle;
    const totalDelta = cpuSample.total - prev.cpu.total;
    cpuPct = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
  }
  if (prev && now > prev.at) {
    const elapsed = (now - prev.at) / 1000;
    netDown = Math.max(0, Math.round((rx - prev.net.rx) / elapsed));
    netUp = Math.max(0, Math.round((tx - prev.net.tx) / elapsed));
  }
  remoteStatsCache[id] = { cpu: cpuSample, net: { rx, tx }, at: now };
  const ramPct = memTotal > 0 ? Math.round(((memTotal - memAvail) / memTotal) * 100) : null;
  const diskPct = Number.isFinite(diskPctRaw) ? diskPctRaw : (diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : null);
  return {
    success: true,
    cpuPct,
    cpuCores: Number.isFinite(cpuCores) && cpuCores > 0 ? cpuCores : null,
    ramPct,
    diskPct,
    ramUsedKb: memTotal > 0 ? memTotal - memAvail : null,
    ramTotalKb: memTotal || null,
    diskUsedKb: diskUsed || null,
    diskTotalKb: diskTotal || null,
    netDown,
    netUp,
  };
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
        sinkStreamErrors(stream);
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
      sinkStreamErrors(stream);

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
function emitDeleteProgress(progressCb, payload) {
  progressCb && progressCb(payload);
}

async function deleteRemote(id, remotePath, isDirectory, progressCb) {
  const ac = activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  const rootName = path.posix.basename(remotePath) || remotePath;
  emitDeleteProgress(progressCb, { type: "delete-start", name: rootName, isDirectory: !!isDirectory });

  try {
    if (ac.type === "sftp") {
      if (isDirectory) {
        await deleteDirRecursiveSftp(ac.sftp, remotePath, progressCb);
      } else {
        await new Promise((resolve, reject) => {
          ac.sftp.unlink(remotePath, (err) => err ? reject(err) : resolve());
        });
      }
    } else if (ac.type === "ftp") {
      if (isDirectory) {
        await deleteDirRecursiveFtp(id, ac.client, remotePath, progressCb);
      } else {
        await ac.client.remove(remotePath);
      }
    }
    emitDeleteProgress(progressCb, { type: "delete-done", success: true, name: rootName });
    return { success: true };
  } catch (err) {
    emitDeleteProgress(progressCb, { type: "delete-done", success: false, name: rootName, message: err.message });
    return { success: false, message: err.message };
  }
}

async function deleteDirRecursiveSftp(sftp, dirPath, progressCb, state = { deleted: 0 }) {
  const list = await new Promise((resolve, reject) => {
    sftp.readdir(dirPath, (err, items) => err ? reject(err) : resolve(items || []));
  });
  for (const item of list) {
    if (item.filename === "." || item.filename === "..") continue;
    const fullPath = joinRemotePath(dirPath, item.filename);
    const followed = await sftpStatFollow(sftp, fullPath);
    const isDir = followed ? followed.isDirectory() : (item.longname || "").startsWith("d");
    if (isDir) {
      await deleteDirRecursiveSftp(sftp, fullPath, progressCb, state);
    } else {
      await new Promise((resolve, reject) => {
        sftp.unlink(fullPath, (err) => err ? reject(err) : resolve());
      });
      state.deleted++;
      emitDeleteProgress(progressCb, { type: "delete-progress", deleted: state.deleted, current: fullPath });
    }
  }
  await new Promise((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => {
      if (!err) return resolve();
      sftp.unlink(dirPath, (unlinkErr) => unlinkErr ? reject(err) : resolve());
    });
  });
  emitDeleteProgress(progressCb, { type: "delete-progress", deleted: state.deleted, current: dirPath });
}

async function deleteDirRecursiveFtp(id, client, dirPath, progressCb, state = { deleted: 0 }) {
  const listed = await listRemote(id, dirPath);
  if (!listed.success) throw new Error(listed.message || "Could not list remote directory");
  for (const item of listed.items) {
    const fullPath = joinRemotePath(dirPath, item.name);
    if (item.isDirectory || item.type === "directory") {
      await deleteDirRecursiveFtp(id, client, fullPath, progressCb, state);
    } else {
      await client.remove(fullPath);
      state.deleted++;
      emitDeleteProgress(progressCb, { type: "delete-progress", deleted: state.deleted, current: fullPath });
    }
  }
  await client.removeDir(dirPath);
  emitDeleteProgress(progressCb, { type: "delete-progress", deleted: state.deleted, current: dirPath });
}

async function renameRemote(id, remotePath, newName) {
  const name = String(newName || "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return { success: false, message: "Enter a valid name without path separators" };
  }
  const parent = path.posix.dirname(remotePath);
  const destinationPath = joinRemotePath(parent === "." ? "/" : parent, name);
  if (destinationPath === remotePath) return { success: true };
  const exists = await checkRemoteExists(id, destinationPath);
  if (exists.exists) return { success: false, message: "A file or folder with that name already exists" };
  return moveRemote(id, remotePath, destinationPath);
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
const SENSITIVE_FILE_RE = /(^|\/)(wp-config\.php|\.htaccess|nginx\.conf|php\.ini|my\.cnf|\.env)$/i;

function detectEditorLanguage(remotePath) {
  const name = path.basename(String(remotePath || "")).toLowerCase();
  if (name === ".htaccess") return "apache";
  if (name === ".env") return "dotenv";
  if (name.endsWith(".php")) return "php";
  if (name.endsWith(".ts") || name.endsWith(".tsx")) return "typescript";
  if (name.endsWith(".js") || name.endsWith(".jsx") || name.endsWith(".mjs") || name.endsWith(".cjs")) return "javascript";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".scss")) return "scss";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "yaml";
  if (name.endsWith(".conf") || name.endsWith(".nginx")) return "nginx";
  if (name.endsWith(".sh")) return "shell";
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".sql")) return "sql";
  if (name.endsWith(".md")) return "markdown";
  return "plaintext";
}

function isSensitiveRemotePath(remotePath) {
  return SENSITIVE_FILE_RE.test(String(remotePath || ""));
}

function runPhpLint(content) {
  return new Promise((resolve) => {
    const bundled = global.CONST?.getPhpDir?.("8.3");
    const bundledPhp = bundled
      ? path.join(bundled, process.platform === "win32" ? "php.exe" : "bin/php")
      : null;
    const bin = (bundledPhp && fs.existsSync(bundledPhp) ? bundledPhp : null)
      || platform.findCommand(["php"])
      || "php";
    const tmp = path.join(require("os").tmpdir(), `shieldpress-lint-${process.pid}-${Date.now()}.php`);
    fs.writeFile(tmp, content, "utf8").then(() => {
      const child = spawn(bin, ["-l", tmp], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => {
        fs.remove(tmp).catch(() => {});
        resolve({ ok: true, skipped: true, message: err.message });
      });
      child.on("close", (code) => {
        fs.remove(tmp).catch(() => {});
        if (code === 0) return resolve({ ok: true });
        const text = `${stdout}\n${stderr}`.trim();
        const lineMatch = text.match(/on line (\d+)/i);
        resolve({
          ok: false,
          language: "php",
          line: lineMatch ? Number(lineMatch[1]) : null,
          message: text || "PHP syntax error",
        });
      });
    }).catch((err) => resolve({ ok: false, message: err.message }));
  });
}

async function validateFileContent(remotePath, content) {
  const language = detectEditorLanguage(remotePath);
  if (language === "json") {
    try {
      JSON.parse(String(content || ""));
      return { ok: true, language };
    } catch (err) {
      const lineMatch = String(err.message || "").match(/position\s+(\d+)/i);
      let line = null;
      if (lineMatch) {
        const pos = Number(lineMatch[1]);
        line = String(content || "").slice(0, pos).split(/\r?\n/).length;
      }
      return { ok: false, language, line, message: err.message || "Invalid JSON" };
    }
  }
  if (language === "php") {
    return runPhpLint(content);
  }
  return { ok: true, language };
}

async function backupRemoteFile(id, remotePath) {
  const ac = getActive(id);
  if (!ac) return { success: false, message: "Not connected" };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19).replace("T", "-");
  const base = path.posix.basename(remotePath);
  const dir = path.posix.dirname(remotePath);
  const backupDir = path.posix.join(dir === "/" ? "/" : dir, ".shieldpress", "backups");
  const backupPath = `${backupDir}/${base}.${stamp}`;

  try {
    if (ac.type === "sftp") {
      const escapedSrc = remotePath.replace(/'/g, `'\\''`);
      const escapedDest = backupPath.replace(/'/g, `'\\''`);
      const escapedDir = backupDir.replace(/'/g, `'\\''`);
      const result = await execCommand(id, `mkdir -p '${escapedDir}' && cp -a '${escapedSrc}' '${escapedDest}'`);
      if (!result.success) return { success: false, message: result.error || result.output || "Backup failed" };
      return { success: true, backupPath };
    }

    const tmp = path.join(require("os").tmpdir(), `sp-bak-${Date.now()}-${base}`);
    await ac.client.downloadTo(tmp, remotePath);
    const parts = backupDir.split("/").filter(Boolean);
    let cursor = "";
    for (const part of parts) {
      cursor += "/" + part;
      try { await ac.client.ensureDir(cursor); } catch {}
    }
    await ac.client.uploadFrom(tmp, backupPath);
    await fs.remove(tmp).catch(() => {});
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function writeRemoteFile(id, remotePath, content, options = {}) {
  const ac = getActive(id) || activeConnections[id];
  if (!ac) return { success: false, message: "Not connected" };

  if (!options.skipValidation) {
    const validation = await validateFileContent(remotePath, content);
    if (!validation.ok) {
      return {
        success: false,
        code: "VALIDATION_ERROR",
        language: validation.language,
        line: validation.line || null,
        message: validation.message || "Validation failed",
      };
    }
  }

  let backupPath = null;
  if (!options.skipBackup && isSensitiveRemotePath(remotePath)) {
    const bak = await backupRemoteFile(id, remotePath);
    if (bak.success) backupPath = bak.backupPath;
    else log.err("Backup before save failed: " + bak.message);
  }

  try {
    if (ac.type === "sftp") {
      return await new Promise((resolve) => {
        const stream = ac.sftp.createWriteStream(remotePath);
        stream.on("close", () => resolve({ success: true, backupPath }));
        stream.on("error", (err) => resolve({ success: false, message: err.message }));
        stream.end(content, "utf8");
      });
    } else if (ac.type === "ftp") {
      const tempFile = path.join(require("os").tmpdir(), "shieldpress_ftp_edit_" + Date.now());
      await fs.writeFile(tempFile, content, "utf8");
      await ac.client.uploadFrom(tempFile, remotePath);
      await fs.remove(tempFile);
      return { success: true, backupPath };
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
  const uploadResult = await putLocalFile(id, localZipPath, remoteZip);
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
  const created = await ensureRemoteDir(id, destinationPath);
  if (!created.success) return created;
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

        const upResult = await putLocalFile(id, localFile, remotePath);
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
async function touchLastConnected(id) {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return;
  try {
    const conns = JSON.parse(await fs.readFile(file, "utf8"));
    const conn = conns.find((c) => c.id === id);
    if (!conn) return;
    conn.lastConnectedAt = new Date().toISOString();
    await writeConnections(conns);
  } catch {}
}

async function toggleStar(id) {
  const file = getConnectionsFile();
  if (!fs.existsSync(file)) return { success: false, message: "Connection not found" };
  try {
    const conns = JSON.parse(await fs.readFile(file, "utf8"));
    const conn = conns.find((c) => c.id === id);
    if (!conn) return { success: false, message: "Connection not found" };
    conn.starred = !conn.starred;
    await writeConnections(conns);
    return { success: true, starred: !!conn.starred };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

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
  changeVaultPassword,
  lockVault,
  getConnections,
  saveConnection,
  deleteConnection,
  connect,
  connectSession,
  disconnect,
  disconnectAll,
  closeSession,
  listRemote,
  downloadFile,
  downloadBatch,
  uploadFile,
  uploadBatch,
  cancelUpload,
  cancelSync,
  syncUpload,
  syncDownload,
  execCommand,
  getRemoteSystemInfo,
  getRemoteStats,
  startShell,
  writeShell,
  resizeShell,
  stopShell,
  execFtpCommand,
  deleteRemote,
  readRemoteFile,
  writeRemoteFile,
  validateFileContent,
  detectEditorLanguage,
  uploadAndExtract,
  createRemoteDir,
  createRemoteFile,
  copyRemote,
  moveRemote,
  renameRemote,
  openInExternalEditor,
  stopFileWatcher,
  toggleStar,
  updateLastBrowsedPath,
  checkRemoteExists,
  validateLocalPath,
  statLocalPath,
  __test: {
    normalizeRemoteMutationPath,
    createRemoteDirOnConnection,
    createRemoteFileOnConnection,
    joinRemotePath,
    joinLocalDownloadPath,
    collectLocalFiles,
    mapSftpListItem,
    mapFtpListItem,
    sortRemoteItems,
    fileKindLabel,
    detectEditorLanguage,
    isSensitiveRemotePath,
    validateFileContent,
  },
};
