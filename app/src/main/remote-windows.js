"use strict";

const path = require("path");
const { BrowserWindow } = require("electron");
const sessionManager = require("./session-manager");

const openWindows = new Map(); // sessionId -> BrowserWindow

function preloadPath() {
  return path.join(__dirname, "..", "..", "preload.js");
}

function iconPath() {
  if (process.platform === "linux") {
    return path.join(__dirname, "..", "..", "renderer", "images", "icon.png");
  }
  return undefined;
}

function kindLabel(kind) {
  if (kind === "terminal") return "Terminal";
  if (kind === "ftp") return "FTP";
  return "SFTP";
}

/**
 * Open a dedicated BrowserWindow bound to an existing session id.
 * Caller must create + connect the session before calling this.
 */
function openRemoteWindow({ kind, connectionId, connectionName, host, sessionId }) {
  const label = kindLabel(kind);
  const display = connectionName || host || connectionId;
  const title = `${label} — ${display}`;

  let session = sessionId ? sessionManager.get(sessionId) : null;
  if (!session) {
    session = sessionManager.create({
      kind,
      connectionId,
      title,
      sessionId: sessionId || undefined,
    });
  } else {
    sessionManager.update(session.id, { title });
  }

  const win = new BrowserWindow({
    width: kind === "terminal" ? 1280 : 1180,
    height: kind === "terminal" ? 860 : 780,
    minWidth: 820,
    minHeight: 560,
    title,
    backgroundColor: "#080b11",
    autoHideMenuBar: true,
    show: false,
    icon: iconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath(),
    },
  });

  sessionManager.update(session.id, {
    windowId: win.id,
    webContentsId: win.webContents.id,
    title,
  });
  openWindows.set(session.id, win);

  const query = new URLSearchParams({
    sessionId: session.id,
    kind,
    connectionId: String(connectionId),
    title,
  });
  win.loadFile(path.join(__dirname, "..", "..", "renderer", "remote-session.html"), {
    search: query.toString(),
  });
  win.once("ready-to-show", () => win.show());

  win.on("closed", () => {
    openWindows.delete(session.id);
    if (typeof global.__shieldpressCloseRemoteSession === "function") {
      try { global.__shieldpressCloseRemoteSession(session.id); } catch {}
    } else {
      sessionManager.remove(session.id);
    }
  });

  return { success: true, sessionId: session.id, windowId: win.id, title };
}

function openS3Window({ bucketId, bucketName }) {
  const title = `S3 Objects — ${bucketName || bucketId}`;
  const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 900, minHeight: 620, title, backgroundColor: "#080b11", autoHideMenuBar: true, show: false, icon: iconPath(), webPreferences: { nodeIntegration: false, contextIsolation: true, preload: preloadPath() } });
  win.loadFile(path.join(__dirname, "..", "..", "renderer", "s3-session.html"), { search: new URLSearchParams({ bucketId: String(bucketId), title }).toString() });
  win.once("ready-to-show", () => win.show());
  return { success: true, windowId: win.id, title };
}

function getWindow(sessionId) {
  return openWindows.get(sessionId) || null;
}

function closeWindow(sessionId) {
  const win = openWindows.get(sessionId);
  if (!win || win.isDestroyed()) {
    openWindows.delete(sessionId);
    return { success: true };
  }
  // Prevent recursive closeSession from destroy → closed → closeSession → closeWindow
  openWindows.delete(sessionId);
  win.destroy();
  return { success: true };
}

function closeWindowsForConnection(connectionId) {
  const id = String(connectionId || "");
  for (const session of sessionManager.listByConnection(id)) {
    closeWindow(session.id);
  }
  return { success: true };
}

function closeAllWindows() {
  for (const sessionId of [...openWindows.keys()]) {
    closeWindow(sessionId);
  }
  return { success: true };
}

module.exports = {
  openRemoteWindow,
  openS3Window,
  getWindow,
  closeWindow,
  closeWindowsForConnection,
  closeAllWindows,
  kindLabel,
};
