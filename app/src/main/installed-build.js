"use strict";

// Electron's patched fs treats app.asar as a virtual directory and returns
// synthetic stat metadata. Inspect the archive on disk instead.
const fs = require("original-fs");
const path = require("path");
const { app } = require("electron");

// A running Electron process can keep old code in memory after a .deb upgrade,
// while a newly opened window reads files from the replacement app.asar.
const archive = app.isPackaged ? path.join(process.resourcesPath, "app.asar") : null;

function identity() {
  if (!archive) return null;
  const stat = fs.statSync(archive);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

let launchedFrom;
try { launchedFrom = identity(); } catch { launchedFrom = null; }

function wasReplaced() {
  if (!archive || !launchedFrom) return false;
  try { return identity() !== launchedFrom; } catch { return true; }
}

module.exports = { wasReplaced };
