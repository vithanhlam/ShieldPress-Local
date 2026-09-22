const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

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
  assert.equal(result.policy.requireApproval, true);
  assert.equal(result.policy.redactSecrets, true);
  assert.equal(result.policy.sessionMinutes, 480);
  assert.ok(Date.parse(result.policy.expiresAt) > Date.now());
  assert.equal(result.policy.resources.length, 1);
  assert.deepEqual(result.policy.resources[0].permissions, {
    read: true, create: false, edit: true, delete: false, execute: false,
  });
  assert.ok(aiAccess.RESOURCE_TYPES.includes("config"));

  const stored = await fs.readJson(path.join(dataDir, "ai-access.json"));
  assert.equal(stored.resources[0].permissions.shell, undefined);
  const audit = await aiAccess.getAudit();
  assert.equal(audit.entries[0].event, "policy-updated");
});
