const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const test = require("node:test");
const vaultCrypto = require("../app/src/main/credential-vault");

test("changing the vault password re-encrypts saved connection passwords", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-vault-"));
  const previousConst = global.CONST;
  const previousState = global.STATE;
  global.CONST = { DATA_DIR: root, PROJECTS_DIR: root };
  global.STATE = { logBuffer: [] };
  t.after(async () => {
    global.CONST = previousConst;
    global.STATE = previousState;
    await fs.remove(root);
  });

  const sftp = require("../app/src/main/sftp");
  await sftp.setupVault("old master password");
  await sftp.saveConnection({
    name: "Test server", host: "example.test", username: "deploy", password: "server-secret",
  });

  const result = await sftp.changeVaultPassword("old master password", "new master password");
  assert.equal(result.success, true);

  const metadata = await fs.readJson(path.join(root, "remote-connections", "vault.json"));
  const connections = await fs.readJson(path.join(root, "remote-connections", "connections.json"));
  const newKey = vaultCrypto.unlock("new master password", metadata);
  assert.equal(vaultCrypto.open(connections[0].password, newKey), "server-secret");
  assert.throws(() => vaultCrypto.unlock("old master password", metadata));
});
