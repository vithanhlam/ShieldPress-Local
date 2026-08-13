const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const test = require("node:test");
const workspace = require("../app/src/main/workspace");

test("normalizeWorkspaceDir supports spaces and expands a filesystem root", () => {
  const withSpaces = path.join(os.tmpdir(), "ShieldPress Projects");
  assert.equal(workspace.normalizeWorkspaceDir(withSpaces), path.resolve(withSpaces));
  assert.equal(
    workspace.normalizeWorkspaceDir(path.parse(path.resolve(os.tmpdir())).root),
    path.join(path.parse(path.resolve(os.tmpdir())).root, "ShieldPress_Project"),
  );
});

test("Windows workspace normalization rejects broken device prefixes", () => {
  const normalize = (value) => workspace.normalizeWorkspaceDirForPlatform(value, "win32");
  assert.equal(normalize("\\\\?\\"), "");
  assert.equal(normalize("\\?"), "");
  assert.equal(normalize("\\\\.\\PhysicalDrive0"), "");
  assert.equal(normalize("C:"), "");
  assert.equal(normalize("projects"), "");
});

test("Windows workspace normalization preserves valid drive and UNC paths", () => {
  const normalize = (value) => workspace.normalizeWorkspaceDirForPlatform(value, "win32");
  assert.equal(normalize("D:\\"), "D:\\ShieldPress_Project");
  assert.equal(normalize("D:\\Projects With Spaces"), "D:\\Projects With Spaces");
  assert.equal(normalize("\\\\?\\D:\\Projects"), "D:\\Projects");
  assert.equal(normalize("\\\\?\\UNC\\server\\share\\Projects"), "\\\\server\\share\\Projects");
});

test("saveWorkspace validates before atomically replacing the preference", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-test-"));
  t.after(() => fs.remove(root));
  const userData = path.join(root, "user data");
  const selected = path.join(root, "projects with spaces");
  const app = { getPath: (name) => name === "userData" ? userData : root };

  const saved = await workspace.saveWorkspace(app, selected);
  assert.equal(saved, selected);
  assert.equal(await fs.readFile(workspace.preferenceFile(app), "utf8"), selected);
  assert.equal(await fs.pathExists(path.join(selected, "data")), true);
  assert.equal((await fs.readJson(path.join(selected, "data", "config.json"))).projects_dir, selected);
});

test("saveWorkspace does not commit a preference when target config is invalid", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-test-"));
  t.after(() => fs.remove(root));
  const app = { getPath: () => path.join(root, "userData") };
  const selected = path.join(root, "broken workspace");
  await fs.ensureDir(path.join(selected, "data"));
  await fs.writeFile(path.join(selected, "data", "config.json"), "{broken", "utf8");
  await assert.rejects(workspace.saveWorkspace(app, selected), /invalid data\/config\.json/);
  assert.equal(await fs.pathExists(workspace.preferenceFile(app)), false);
});

test("getWorkspaceDir ignores an inaccessible stale preference", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-test-"));
  t.after(() => fs.remove(root));
  const app = { getPath: () => root };
  const blocker = path.join(root, "not-a-directory");
  await fs.writeFile(blocker, "file", "utf8");
  await fs.writeFile(workspace.preferenceFile(app), path.join(blocker, "workspace"), "utf8");
  assert.equal(workspace.getWorkspaceDir(app), workspace.defaultWorkspaceDir());
});
