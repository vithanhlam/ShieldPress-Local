const assert = require("node:assert/strict");
const test = require("node:test");
const { connectionArgsFor } = require("../app/src/main/database");

test("password changes sync Next.js local root URLs while preserving external databases", async (t) => {
  const fs = require("fs-extra");
  const path = require("path");
  const root = await fs.mkdtemp(path.join(require("os").tmpdir(), "shieldpress-password-"));
  t.after(() => fs.remove(root));
  global.CONST = { PROJECTS_DIR: root };
  const project = path.join(root, "nextjs");
  await fs.ensureDir(path.join(project, "www"));
  await fs.writeJson(path.join(project, "project.json"), { dbUser: "root", dbPort: 3307 });
  const envFile = path.join(project, "www", ".env.local");
  await fs.writeFile(envFile, 'DATABASE_URL="mysql://root:root@127.0.0.1:3307/app?charset=utf8mb4"\nOTHER=keep\n');
  const remote = path.join(project, "www", ".env");
  const remoteValue = 'DATABASE_URL=mysql://root:remote@db.example.com:3307/app\n';
  await fs.writeFile(remote, remoteValue);
  const password = 'new@:#$/ pass';
  await require("../app/src/main/database").syncProjectDatabasePasswords(password);
  const value = await fs.readFile(envFile, "utf8");
  const url = new URL(value.split('"')[1]);
  assert.equal(decodeURIComponent(url.password), password);
  assert.equal(url.pathname, "/app");
  assert.equal(url.search, "?charset=utf8mb4");
  assert.match(value, /OTHER=keep/);
  assert.equal(await fs.readFile(remote, "utf8"), remoteValue);
});

test("Windows MariaDB commands include the configured root password", () => {
  assert.deepEqual(connectionArgsFor("win32", { port: 3310, root_password: "secret" }), [
    "-h", "127.0.0.1", "-P", "3310", "-u", "root", "--password=secret",
  ]);
});

test("Windows MariaDB commands preserve an intentionally empty root password", () => {
  assert.deepEqual(connectionArgsFor("win32", { port: 3310, root_password: "" }), [
    "-h", "127.0.0.1", "-P", "3310", "-u", "root", "--password=",
  ]);
});

test("Linux MariaDB commands honor a changed root password", () => {
  assert.deepEqual(connectionArgsFor("linux", { port: 3307, root_password: "changed" }), [
    "-h", "127.0.0.1", "-P", "3307", "-u", "root", "--password=changed",
  ]);
});

test("Linux preserves the passwordless default and explicit empty passwords", () => {
  assert.equal(connectionArgsFor("linux", {}).some((arg) => arg.startsWith("--password=")), false);
  assert.ok(connectionArgsFor("linux", { root_password: "" }).includes("--password="));
});
