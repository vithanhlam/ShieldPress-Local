// src/main/plugin-manager.js
const fs   = require("fs-extra");
const path = require("path");
const log  = require("./logger");

const PLUGINS_DIR  = path.join(__dirname, "..", "..", "plugins");
const LICENSE_FILE = path.join(global.CONST?.DATA_DIR || path.join(__dirname, "..", "..", "data"), "license.json");

// ── License (backend-only, UI hidden for now) ────────────────────────────────
async function getLicense() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return { valid: false, key: null, plan: "free" };
    const lic = await fs.readJson(LICENSE_FILE);
    return lic;
  } catch (e) {
    return { valid: false, key: null, plan: "free" };
  }
}

async function activateLicense(key) {
  // TODO: gọi API server để verify key
  const valid = /^SHIELDPRESS-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
  if (!valid) return { success: false, message: "Invalid license key format" };

  const lic = { valid: true, key, plan: "pro", activatedAt: new Date().toISOString() };
  await fs.writeJson(LICENSE_FILE, lic, { spaces: 2 });
  log.ok("License activated: " + key);
  return { success: true, license: lic };
}

async function deactivateLicense() {
  await fs.writeJson(LICENSE_FILE, { valid: false, key: null, plan: "free" }, { spaces: 2 });
  log.info("License deactivated");
  return { success: true };
}

// ── Plugin loader ─────────────────────────────────────────────────────────────
async function getPlugins() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];

  const dirs = await fs.readdir(PLUGINS_DIR);
  const plugins = [];

  for (const d of dirs) {
    const manifestPath = path.join(PLUGINS_DIR, d, "manifest.json");
    if (!(await fs.pathExists(manifestPath))) continue;

    try {
      const manifest = await fs.readJson(manifestPath);
      plugins.push({
        ...manifest,
        id       : d,
        locked   : false,
        installed: true,
      });
    } catch (e) {
      log.warn(`Bad manifest in plugin: ${d}`);
    }
  }

  return plugins;
}

async function runPlugin(pluginId, action, data) {
  const manifestPath = path.join(PLUGINS_DIR, pluginId, "manifest.json");
  if (!(await fs.pathExists(manifestPath)))
    return { success: false, message: "Plugin not found" };

  const indexPath = path.join(PLUGINS_DIR, pluginId, "index.js");
  if (!(await fs.pathExists(indexPath)))
    return { success: false, message: "Plugin has no index.js" };

  try {
    const plugin = require(indexPath);
    if (typeof plugin[action] !== "function")
      return { success: false, message: `Action "${action}" not found in plugin` };
    return await plugin[action](data);
  } catch (e) {
    log.err(`Plugin ${pluginId} error: ${e.message}`);
    return { success: false, message: e.message };
  }
}

module.exports = { getLicense, activateLicense, deactivateLicense, getPlugins, runPlugin };
