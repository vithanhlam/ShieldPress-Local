const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const test = require("node:test");

test("Linux PHP extensions are detected from .so files and php.ini", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-ext-"));
  t.after(() => fs.remove(root));
  const phpDir = path.join(root, "8.3");
  const extDir = path.join(phpDir, "ext");
  await fs.ensureDir(extDir);
  await fs.writeFile(path.join(extDir, "mysqli.so"), "");
  await fs.writeFile(path.join(extDir, "curl.so"), "");
  await fs.writeFile(path.join(extDir, "custommod.so"), "");
  await fs.writeFile(path.join(phpDir, "php.ini"), "extension=mysqli\n;extension=curl\nextension=custommod.so\n");
  global.CONST = { getPhpDir: () => phpDir };

  const extPath = require.resolve("../app/src/main/extensions");
  delete require.cache[extPath];
  const { getExtensions } = require("../app/src/main/extensions");
  const result = await getExtensions("8.3");
  assert.equal(result.success, true);
  const mysqli = result.extensions.find((item) => item.id === "mysqli");
  const curl = result.extensions.find((item) => item.id === "curl");
  const imagick = result.extensions.find((item) => item.id === "imagick");
  const custom = result.extensions.find((item) => item.id === "custommod");
  assert.equal(mysqli.installed, true);
  assert.equal(mysqli.enabled, true);
  assert.equal(curl.installed, true);
  assert.equal(curl.enabled, false);
  assert.equal(imagick.installed, false);
  assert.equal(custom.installed, true);
  assert.equal(custom.enabled, true);
  assert.equal(custom.custom, true);
});
