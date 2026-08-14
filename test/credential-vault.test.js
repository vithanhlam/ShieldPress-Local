const assert = require("node:assert/strict");
const test = require("node:test");
const vault = require("../app/src/main/credential-vault");

test("credential vault encrypts and decrypts with the Master Password", () => {
  const created = vault.createMetadata("correct horse battery staple");
  const key = vault.unlock("correct horse battery staple", created.metadata);
  const encrypted = vault.seal("vps-secret", key);

  assert.match(encrypted, /^v2:/);
  assert.equal(encrypted.includes("vps-secret"), false);
  assert.equal(vault.open(encrypted, key), "vps-secret");
});

test("credential vault rejects the wrong Master Password", () => {
  const created = vault.createMetadata("correct horse battery staple");
  assert.throws(() => vault.unlock("wrong password", created.metadata));
});

test("credential vault detects modified ciphertext", () => {
  const created = vault.createMetadata("correct horse battery staple");
  const encrypted = vault.seal("vps-secret", created.key);
  const parts = encrypted.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => vault.open(parts.join(":"), created.key));
});
