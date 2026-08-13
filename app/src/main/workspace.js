const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const DEFAULT_WORKSPACE_NAME = "ShieldPress_Project";

function normalizeWorkspaceDirForPlatform(inputPath, platformName = process.platform) {
  let trimmed = String(inputPath || "").replace(/^\uFEFF/, "").trim();
  if (!trimmed) return "";

  const pathApi = platformName === "win32" ? path.win32 : path.posix;
  if (platformName === "win32") {
    // Electron/Node can return an extended-length path from native dialogs.
    // Persist the regular Win32 form and reject incomplete device prefixes
    // such as "\\?\", which cannot be used as a workspace directory.
    if (/^\\\\\?\\UNC\\/i.test(trimmed)) {
      trimmed = `\\\\${trimmed.slice(8)}`;
    } else if (/^\\\\\?\\[A-Za-z]:\\/.test(trimmed)) {
      trimmed = trimmed.slice(4);
    } else if (/^\\\\[?.]\\/.test(trimmed) || /^\\\?/.test(trimmed)) {
      return "";
    }

    // Reject drive-relative paths ("C:") and root-relative fragments. They
    // depend on process state and may resolve somewhere the user did not pick.
    const isDriveAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed);
    const isUncAbsolute = /^\\\\[^\\]+\\[^\\]+/.test(trimmed);
    if (!isDriveAbsolute && !isUncAbsolute) return "";
  }

  const normalized = pathApi.resolve(pathApi.normalize(trimmed));
  return normalized === pathApi.parse(normalized).root
    ? pathApi.join(normalized, DEFAULT_WORKSPACE_NAME)
    : normalized;
}

function normalizeWorkspaceDir(inputPath) {
  return normalizeWorkspaceDirForPlatform(inputPath, process.platform);
}

function defaultWorkspaceDir() {
  if (process.platform === "win32") {
    return path.join(path.parse(process.execPath).root, DEFAULT_WORKSPACE_NAME);
  }
  return path.join(os.homedir(), DEFAULT_WORKSPACE_NAME);
}

function preferenceFile(app) {
  return path.join(app.getPath("userData"), "workspace_path.txt");
}

function legacyPreferenceFiles() {
  const files = [path.join(path.dirname(process.execPath), "portable.txt")];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    files.push(path.join(appData, "ShieldPress Local", "workspace_path.txt"));
  }
  return files;
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  } catch {
    return "";
  }
}

function getWorkspaceDir(app) {
  const candidates = [preferenceFile(app), ...legacyPreferenceFiles()];
  for (const file of candidates) {
    const value = normalizeWorkspaceDir(readText(file));
    if (!value) continue;
    try {
      fs.ensureDirSync(value);
      fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK);
      return value;
    } catch {
      // Ignore stale or inaccessible preferences and try the safe default.
    }
  }
  return defaultWorkspaceDir();
}

async function validateWorkspace(inputPath) {
  const workspaceDir = normalizeWorkspaceDir(inputPath);
  if (!workspaceDir) throw new Error("Please choose a workspace directory");

  await fs.ensureDir(workspaceDir);
  const stat = await fs.stat(workspaceDir);
  if (!stat.isDirectory()) throw new Error("Workspace path is not a directory");

  // Spaces are supported by the generated configs; test actual write access.
  const probe = path.join(workspaceDir, `.shieldpress-write-test-${process.pid}`);
  await fs.writeFile(probe, "ok", { flag: "wx" });
  await fs.remove(probe);
  await fs.ensureDir(path.join(workspaceDir, "data"));
  return workspaceDir;
}

async function saveWorkspace(app, inputPath) {
  const workspaceDir = await validateWorkspace(inputPath);
  const configFile = path.join(workspaceDir, "data", "config.json");
  let config = {};
  if (await fs.pathExists(configFile)) {
    try {
      config = await fs.readJson(configFile);
    } catch (error) {
      throw new Error(`The selected workspace has an invalid data/config.json: ${error.message}`);
    }
  }
  config.projects_dir = workspaceDir;
  const configTemp = `${configFile}.tmp-${process.pid}`;
  await fs.writeJson(configTemp, config, { spaces: 2 });
  await fs.move(configTemp, configFile, { overwrite: true });

  const target = preferenceFile(app);
  const temp = `${target}.tmp-${process.pid}`;
  await fs.ensureDir(path.dirname(target));
  await fs.writeFile(temp, workspaceDir, "utf8");
  await fs.move(temp, target, { overwrite: true });
  return workspaceDir;
}

async function clearWorkspacePreference(app) {
  const stamp = Date.now();
  for (const file of [preferenceFile(app), ...legacyPreferenceFiles()]) {
    if (!(await fs.pathExists(file))) continue;
    try {
      await fs.move(file, `${file}.invalid-${stamp}`, { overwrite: true });
    } catch {
      // Installed locations may be read-only; the per-user preference is still cleared.
      if (file === preferenceFile(app)) await fs.remove(file).catch(() => {});
    }
  }
}

module.exports = {
  DEFAULT_WORKSPACE_NAME,
  normalizeWorkspaceDir,
  normalizeWorkspaceDirForPlatform,
  defaultWorkspaceDir,
  preferenceFile,
  getWorkspaceDir,
  validateWorkspace,
  saveWorkspace,
  clearWorkspacePreference,
};
