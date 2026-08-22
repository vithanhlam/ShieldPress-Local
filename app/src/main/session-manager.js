"use strict";

const { randomUUID } = require("crypto");
const { webContents } = require("electron");

/** @typedef {'terminal'|'sftp'|'ftp'} SessionKind */

/**
 * Runtime session registry. UI never owns SSH/PTY/FTP sockets —
 * main process creates, disconnects, and destroys sessions here.
 */
const sessions = new Map();

function makeSessionId(kind, connectionId) {
  return `${kind}:${connectionId}:${randomUUID()}`;
}

function parseSessionId(sessionId) {
  const value = String(sessionId || "");
  const parts = value.split(":");
  if (parts.length < 3) return null;
  const kind = parts[0];
  if (kind !== "terminal" && kind !== "sftp" && kind !== "ftp") return null;
  const connectionId = parts[1];
  if (!connectionId) return null;
  return { kind, connectionId, sessionId: value };
}

function isSessionId(id) {
  return !!parseSessionId(id);
}

function create({ kind, connectionId, webContentsId = null, windowId = null, title = "", sessionId = null }) {
  if (!kind || !connectionId) throw new Error("kind and connectionId are required");
  const id = sessionId || makeSessionId(kind, connectionId);
  if (sessionId) {
    const parsed = parseSessionId(sessionId);
    if (!parsed || parsed.kind !== kind || parsed.connectionId !== String(connectionId)) {
      throw new Error("sessionId does not match kind/connectionId");
    }
  }
  const session = {
    id,
    kind,
    connectionId: String(connectionId),
    webContentsId: webContentsId == null ? null : Number(webContentsId),
    windowId: windowId == null ? null : Number(windowId),
    title: String(title || ""),
    createdAt: Date.now(),
  };
  sessions.set(id, session);
  return { ...session };
}

function get(sessionId) {
  const session = sessions.get(sessionId);
  return session ? { ...session } : null;
}

function update(sessionId, patch = {}) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (patch.webContentsId !== undefined) session.webContentsId = patch.webContentsId == null ? null : Number(patch.webContentsId);
  if (patch.windowId !== undefined) session.windowId = patch.windowId == null ? null : Number(patch.windowId);
  if (patch.title !== undefined) session.title = String(patch.title || "");
  return { ...session };
}

function remove(sessionId) {
  return sessions.delete(sessionId);
}

function listAll() {
  return [...sessions.values()].map((session) => ({ ...session }));
}

function listByConnection(connectionId) {
  const id = String(connectionId || "");
  return listAll().filter((session) => session.connectionId === id);
}

function listByKind(kind) {
  return listAll().filter((session) => session.kind === kind);
}

function findByWindowId(windowId) {
  const id = Number(windowId);
  return listAll().find((session) => session.windowId === id) || null;
}

function findByWebContentsId(webContentsId) {
  const id = Number(webContentsId);
  return listAll().find((session) => session.webContentsId === id) || null;
}

function send(sessionId, channel, payload) {
  const session = sessions.get(sessionId);
  if (!session || session.webContentsId == null) return false;
  try {
    const wc = webContents.fromId(session.webContentsId);
    if (!wc || wc.isDestroyed()) return false;
    wc.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function broadcast(channel, payload) {
  let count = 0;
  for (const session of sessions.values()) {
    if (send(session.id, channel, payload)) count += 1;
  }
  try {
    const main = global.STATE?.mainWindow?.webContents;
    if (main && !main.isDestroyed()) {
      main.send(channel, payload);
      count += 1;
    }
  } catch {}
  return count;
}

function clear() {
  sessions.clear();
}

module.exports = {
  makeSessionId,
  parseSessionId,
  isSessionId,
  create,
  get,
  update,
  remove,
  listAll,
  listByConnection,
  listByKind,
  findByWindowId,
  findByWebContentsId,
  send,
  broadcast,
  clear,
  __test: { makeSessionId, parseSessionId, isSessionId },
};
