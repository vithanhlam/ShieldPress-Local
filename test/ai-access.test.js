const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

test("AI Access discovers standalone databases and reports connection failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-db-resources-"));
  t.after(() => fs.remove(root));
  global.CONST = {
    DATA_DIR: root, PROJECTS_DIR: root, CONFIG_FILE: path.join(root, "config.json"),
    MARIADB_DIR: root, NGINX_DIR: root, PHP_BASE_DIR: root,
  };
  t.mock.method(require("../app/src/main/projects"), "getProjects", async () => [
    { id: "one", dbName: "shared" }, { id: "two", dbName: "shared" },
  ]);
  t.mock.method(require("../app/src/main/sftp"), "getConnections", async () => ({ connections: [] }));
  t.mock.method(require("../app/src/main/s3"), "getBuckets", async () => ({ buckets: [] }));
  const db = require("../app/src/main/database");
  const listing = t.mock.method(db, "listDatabases", async () => ({ success: true, databases: ["shared", "standalone"] }));
  const ai = require("../app/src/main/ai-access");
  const result = await ai.getResources();
  assert.deepEqual(result.resources.filter((r) => r.type === "database").map((r) => r.id), ["shared", "standalone"]);
  assert.equal(result.databaseError, null);
  listing.mock.mockImplementation(async () => ({ success: false, message: "Access denied" }));
  const failed = await ai.getResources();
  assert.equal(failed.databaseError, "Access denied");
  assert.equal(failed.resources.filter((r) => r.type === "database").length, 1);
});

test("AI Access policy defaults closed and enforces safety invariants", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shieldpress-ai-access-"));
  t.after(() => fs.remove(dataDir));
  global.CONST = { DATA_DIR: dataDir };
  const aiAccess = require("../app/src/main/ai-access");

  const initial = await aiAccess.getPolicy();
  assert.equal(initial.enabled, false);
  assert.equal(initial.requireApproval, true);
  assert.equal(initial.redactSecrets, true);
  assert.deepEqual(initial.resources, []);

  const result = await aiAccess.savePolicy({
    enabled: true,
    requireApproval: false,
    redactSecrets: false,
    sessionMinutes: 9999,
    resources: [{
      type: "source",
      id: "project-one",
      name: "Project One",
      scope: "/allowed/project",
      permissions: { read: true, edit: true, delete: false, backup: true, shell: true },
    }, {
      type: "unknown",
      id: "ignored",
      permissions: { read: true },
    }],
  });

  assert.equal(result.success, true);
  assert.equal(result.policy.requireApproval, false);
  assert.equal(result.policy.redactSecrets, true);
  assert.equal(result.policy.sessionMinutes, 480);
  assert.ok(Date.parse(result.policy.expiresAt) > Date.now());
  assert.equal(result.policy.resources.length, 1);
  assert.deepEqual(result.policy.resources[0].permissions, {
    read: true, create: false, edit: true, delete: false, execute: false, upload: false, download: false,
  });
  assert.ok(aiAccess.RESOURCE_TYPES.includes("config"));

  const stored = await fs.readJson(path.join(dataDir, "ai-access.json"));
  assert.equal(stored.resources[0].permissions.shell, undefined);
  const audit = await aiAccess.getAudit();
  assert.equal(audit.entries[0].event, "policy-updated");
});
