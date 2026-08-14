const assert = require("node:assert/strict");
const test = require("node:test");
const { connectionArgsFor } = require("../app/src/main/database");

test("Windows MariaDB commands include the configured root password", () => {
  assert.deepEqual(connectionArgsFor("win32", { port: 3310, root_password: "secret" }), [
    "-h", "127.0.0.1", "-P", "3310", "-u", "root", "--password=secret",
  ]);
});

test("Linux MariaDB commands use the isolated port without a password", () => {
  assert.deepEqual(connectionArgsFor("linux", { port: 3307, root_password: "ignored" }), [
    "-h", "127.0.0.1", "-P", "3307", "-u", "root",
  ]);
});
