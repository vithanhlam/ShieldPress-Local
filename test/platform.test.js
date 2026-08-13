const assert = require("node:assert/strict");
const test = require("node:test");
const platform = require("../app/src/main/platform");

test("platform identifies the current operating system", () => {
  assert.equal(platform.isLinux, process.platform === "linux");
  assert.equal(platform.isWindows, process.platform === "win32");
});

test("command lookup returns an absolute executable", () => {
  const node = platform.findCommand("node");
  assert.ok(node);
  assert.equal(node.startsWith("/"), process.platform !== "win32");
});

test("Linux PHP commands preserve the requested version", () => {
  assert.deepEqual(platform.linuxCommandNames("phpCgi", "8.4"), ["php-cgi8.4", "php8.4-cgi"]);
  assert.deepEqual(platform.linuxCommandNames("php", "8.5"), ["php8.5"]);
  assert.deepEqual(platform.linuxCommandNames("phpCgi"), ["php-cgi"]);
});
