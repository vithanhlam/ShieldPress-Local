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

test("joins remote upload paths without duplicating slashes", () => {
  assert.equal(__test.joinRemotePath("/var/www/", "theme"), "/var/www/theme");
  assert.equal(__test.joinRemotePath("/", "home"), "/home");
  assert.equal(__test.joinRemotePath("/public_html", "index.php"), "/public_html/index.php");
});

test("collects nested local files for upload progress", async () => {
  const fs = require("fs-extra");
  const os = require("os");
  const path = require("path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-upload-"));
  await fs.ensureDir(path.join(root, "css"));
  await fs.writeFile(path.join(root, "index.html"), "ok");
  await fs.writeFile(path.join(root, "css", "app.css"), "body{}");
  const files = await __test.collectLocalFiles(root);
  const names = files.map((file) => file.relativePath).sort();
  assert.deepEqual(names, ["css/app.css", "index.html"]);
  await fs.remove(root);
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

test("maps SFTP symlink directories and hidden files", () => {
  const dir = __test.mapSftpListItem({
    filename: ".env",
    longname: "-rw-r--r-- 1 root root 12",
    attrs: { size: 12, mtime: 1700000000, mode: 0o100644 },
  });
  assert.equal(dir.name, ".env");
  assert.equal(dir.isDirectory, false);
  assert.equal(dir.kind, "env");
  assert.equal(dir.permissions, "rw-r--r-- (644)");
  assert.equal(dir.owner, "root");
  assert.equal(dir.group, "root");

  const link = __test.mapSftpListItem({
    filename: "html",
    longname: "lrwxrwxrwx 1 root root 10",
    attrs: { size: 10, mtime: 1700000000, mode: 0o120777 },
  });
  assert.equal(link.isLink, true);
  assert.equal(link.type, "link");

  const folder = __test.mapSftpListItem({
    filename: "data",
    longname: "drwxr-xr-x 2 www-data www-data 4096",
    attrs: { size: 4096, mtime: 1700000001, mode: 0o040755 },
  });
  assert.equal(folder.isDirectory, true);
  assert.equal(folder.type, "directory");
  assert.equal(folder.permissions, "rwxr-xr-x (755)");
  assert.equal(folder.owner, "www-data");
  assert.equal(folder.group, "www-data");
});

test("sorts remote items by name or modified time with folders first", () => {
  const items = [
    { name: "b.txt", isDirectory: false, size: 2, modified: "2024-02-01T00:00:00.000Z", kind: "txt" },
    { name: "a-dir", isDirectory: true, size: 0, modified: "2024-01-01T00:00:00.000Z", kind: "folder" },
    { name: "a.txt", isDirectory: false, size: 1, modified: "2024-03-01T00:00:00.000Z", kind: "txt" },
  ];
  const byName = __test.sortRemoteItems(items, "name", 1);
  assert.deepEqual(byName.map((item) => item.name), ["a-dir", "a.txt", "b.txt"]);
  const byTime = __test.sortRemoteItems(items, "modified", -1);
  assert.equal(byTime[0].name, "a-dir");
  assert.equal(byTime[1].name, "a.txt");
});

test("maps FTP directory, file, and symlink types", () => {
  assert.equal(__test.mapFtpListItem({ name: "public", type: 2, size: 0 }).type, "directory");
  const file = __test.mapFtpListItem({
    name: "index.php",
    type: 1,
    size: 10,
    permissions: { user: 6, group: 4, world: 4 },
    user: "www-data",
    group: "www-data",
  });
  assert.equal(file.kind, "php");
  assert.equal(file.permissions, "rw-r--r-- (644)");
  assert.equal(file.owner, "www-data");
  assert.equal(file.group, "www-data");
  assert.equal(__test.mapFtpListItem({ name: "www", type: 3, size: 4 }).isLink, true);
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

test("joins nested download paths under the chosen local folder", () => {
  const path = require("path");
  assert.equal(
    __test.joinLocalDownloadPath("/tmp/out/theme", "css/app.css"),
    path.join("/tmp/out/theme", "css", "app.css"),
  );
  assert.equal(__test.joinLocalDownloadPath("/tmp/out/theme", ""), "/tmp/out/theme");
});
