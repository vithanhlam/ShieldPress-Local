const assert = require("node:assert/strict");
const test = require("node:test");

global.STATE ||= { logBuffer: [], mainWindow: null };
global.CONST ||= { DATA_DIR: "/tmp/shieldpress-test-data" };
const { __test } = require("../app/src/main/sftp");

test("normalizes and validates remote mutation paths", () => {
  assert.equal(__test.normalizeRemoteMutationPath(" /var/www//demo.txt "), "/var/www/demo.txt");
  assert.throws(() => __test.normalizeRemoteMutationPath("relative.txt"));
  assert.throws(() => __test.normalizeRemoteMutationPath("/"));
});

test("creates an SFTP directory and empty file with explicit modes", async () => {
  const calls = [];
  const connection = {
    type: "sftp",
    sftp: {
      mkdir(remotePath, attrs, callback) {
        calls.push(["mkdir", remotePath, attrs.mode]);
        callback(null);
      },
      open(remotePath, flags, attrs, callback) {
        calls.push(["open", remotePath, flags, attrs.mode]);
        callback(null, Buffer.from("handle"));
      },
      close(_handle, callback) {
        calls.push(["close"]);
        callback(null);
      },
    },
  };

  await __test.createRemoteDirOnConnection(connection, "/var/www/new-folder");
  await __test.createRemoteFileOnConnection(connection, "/var/www/new-file.txt");
  assert.deepEqual(calls, [
    ["mkdir", "/var/www/new-folder", 0o755],
    ["open", "/var/www/new-file.txt", "w", 0o644],
    ["close"],
  ]);
});

test("creates an FTP directory without changing the working directory", async () => {
  const calls = [];
  const connection = {
    type: "ftp",
    client: {
      async pwd() { return "/home/account"; },
      async ensureDir(remotePath) { calls.push(["ensureDir", remotePath]); },
      async cd(remotePath) { calls.push(["cd", remotePath]); },
    },
  };
  await __test.createRemoteDirOnConnection(connection, "/public_html/new-folder");
  assert.deepEqual(calls, [
    ["ensureDir", "/public_html/new-folder"],
    ["cd", "/home/account"],
  ]);
});
