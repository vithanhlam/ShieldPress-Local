const assert = require("node:assert/strict");
const test = require("node:test");

global.STATE ||= { logBuffer: [], mainWindow: null };
global.CONST ||= { DATA_DIR: "/tmp/shieldpress-test-data" };

const sessionManager = require("../app/src/main/session-manager");
const { __test } = require("../app/src/main/sftp");

test("session ids follow kind:connectionId:uuid", () => {
  sessionManager.clear();
  const session = sessionManager.create({ kind: "sftp", connectionId: "abc123", title: "SFTP — demo" });
  assert.match(session.id, /^sftp:abc123:[0-9a-f-]{36}$/i);
  assert.equal(session.kind, "sftp");
  assert.equal(session.connectionId, "abc123");
  assert.equal(sessionManager.listByConnection("abc123").length, 1);
  sessionManager.remove(session.id);
  assert.equal(sessionManager.listAll().length, 0);
});

test("parseSessionId rejects non-session connection ids", () => {
  assert.equal(sessionManager.parseSessionId("plain-id"), null);
  assert.equal(sessionManager.isSessionId("ftp:host1:11111111-1111-1111-1111-111111111111"), true);
});

test("remote session paths resolve back to their saved connection", async () => {
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const previousDataDir = global.CONST.DATA_DIR;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-last-path-"));
  global.CONST.DATA_DIR = dataDir;
  try {
    const remoteDir = path.join(dataDir, "remote-connections");
    await fs.ensureDir(remoteDir);
    await fs.writeJson(path.join(remoteDir, "connections.json"), [{ id: "server-one", lastBrowsedPath: "/old" }]);
    const saved = await require("../app/src/main/sftp").updateLastBrowsedPath("ftp:server-one:11111111-1111-1111-1111-111111111111", "/var/www/../app/");
    const connections = await fs.readJson(path.join(remoteDir, "connections.json"));
    assert.equal(saved.success, true);
    assert.equal(connections[0].lastBrowsedPath, "/var/app");
  } finally {
    global.CONST.DATA_DIR = previousDataDir;
    await fs.remove(dataDir);
  }
});

test("detectEditorLanguage maps common extensions", () => {
  assert.equal(__test.detectEditorLanguage("/var/www/wp-config.php"), "php");
  assert.equal(__test.detectEditorLanguage("/etc/nginx/nginx.conf"), "nginx");
  assert.equal(__test.detectEditorLanguage("/home/site/.env"), "dotenv");
  assert.equal(__test.detectEditorLanguage("/home/site/.htaccess"), "apache");
  assert.equal(__test.detectEditorLanguage("/app/main.ts"), "typescript");
});

test("sensitive path detection", () => {
  assert.equal(__test.isSensitiveRemotePath("/var/www/wp-config.php"), true);
  assert.equal(__test.isSensitiveRemotePath("/etc/nginx/nginx.conf"), true);
  assert.equal(__test.isSensitiveRemotePath("/var/www/index.php"), false);
});

test("JSON validation fails on broken content", async () => {
  const result = await __test.validateFileContent("/tmp/demo.json", "{ bad");
  assert.equal(result.ok, false);
  assert.equal(result.language, "json");
});

test("JSON validation passes on valid content", async () => {
  const result = await __test.validateFileContent("/tmp/demo.json", '{"ok":true}');
  assert.equal(result.ok, true);
});
