const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const vm = require('vm');

async function fixture(t, fullAccess = true, connection = { success: true, activeId: 'ssh' }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shieldpress-gateway-'));
  t.after(() => fs.remove(dir));
  const policy = { enabled: true, requireApproval: true, resources: [{
    type: 'vps', id: 'one', name: 'VPS', scope: '/', fullAccess, permissions: { read: true, execute: true },
  }] };
  let executions = 0;
  const events = [];
  const mocks = {
    './ai-access': { getPolicy: async () => policy, appendAudit: async () => {} },
    './reqnora': { sendRequest: async () => ({ success: false }), sendNotification: async () => ({ success: false }) },
    './sftp': { ensureAiConnection: async () => connection, execCommand: async () => { executions++; return { success: true, output: 'done', exitCode: 0 }; } },
    './ai-operations': require('../app/src/main/ai-operations'),
  };
  const mod = { exports: {} };
  const source = await fs.readFile(path.join(__dirname, '../app/src/main/ai-gateway.js'), 'utf8');
  const context = { module: mod, require: name => mocks[name] || require(name),
    global: { CONST: { DATA_DIR: dir }, STATE: { mainWindow: { webContents: { send: (...args) => events.push(args) } } } },
    process, __dirname, setInterval, clearInterval, Buffer };
  vm.runInNewContext(source + '\nmodule.exports.dispatch = dispatch; module.exports.loadPending = loadPending;', context);
  return { gateway: mod.exports, dir, policy, events, executions: () => executions };
}
const args = { resourceId: 'vps:one', command: 'uptime; free -m | head -2' };

test('full access executes compound commands without application approval and persists final result', async t => {
  const f = await fixture(t);
  const result = await f.gateway.dispatch('shieldpress.run_remote_command', args);
  assert.equal(result.status, 'applied');
  assert.equal(f.executions(), 1);
  const stored = await fs.readJson(path.join(f.dir, 'ai-access-pending.json'));
  assert.equal(stored[0].status, 'applied');
  assert.equal(stored[0].result.output, 'done');
  const status = await f.gateway.dispatch('shieldpress.get_request', { requestId: result.requestId });
  assert.equal(status.status, 'applied');
  await f.gateway.resolveApproval(result.requestId, true);
  assert.equal(f.executions(), 1);
  assert.equal(f.events.filter(e => e[0] === 'ai-access-approval-request').length, 0);
  assert.equal(f.events.filter(e => e[0] === 'ai-access-approval-result').length, 1);
});

test('retrying legacy pending request reuses its ID; concurrent approvals execute once', async t => {
  const f = await fixture(t, false);
  const first = await f.gateway.dispatch('shieldpress.run_remote_command', args);
  const second = await f.gateway.dispatch('shieldpress.run_remote_command', args);
  assert.equal(first.status, 'approval_required');
  assert.equal(second.requestId, first.requestId);
  await Promise.all([f.gateway.resolveApproval(first.requestId, true), f.gateway.resolveApproval(first.requestId, true)]);
  assert.equal(f.executions(), 1);
  assert.equal((await f.gateway.getRequest(first.requestId)).status, 'applied');
});

test('connection failures persist failed rather than approved', async t => {
  const f = await fixture(t, true, { success: false, message: 'Vault locked' });
  const result = await f.gateway.dispatch('shieldpress.run_remote_command', args);
  assert.equal(result.status, 'failed');
  const stored = await fs.readJson(path.join(f.dir, 'ai-access-pending.json'));
  assert.equal(stored[0].status, 'failed');
  assert.equal(stored[0].result.message, 'Vault locked');
});

test('full access still enforces resource selection, execute permission and working directory scope', async t => {
  const f = await fixture(t);
  await assert.rejects(f.gateway.dispatch('shieldpress.run_remote_command', { ...args, resourceId: 'vps:other' }), /not authorized/);
  f.policy.resources[0].scope = '/project';
  await assert.rejects(f.gateway.dispatch('shieldpress.run_remote_command', { ...args, workingDirectory: '/elsewhere' }), /outside/);
  f.policy.resources[0].permissions.execute = false;
  await assert.rejects(f.gateway.dispatch('shieldpress.run_remote_command', args), /not granted/);
  assert.equal(f.executions(), 0);
});

test('old approved records without saved results become unknown without replay', async t => {
  const f = await fixture(t);
  await fs.writeJson(path.join(f.dir, 'ai-access-pending.json'), [{ id: 'old', status: 'approved', operation: 'execute' }]);
  await f.gateway.loadPending();
  assert.equal((await f.gateway.getRequest('old')).status, 'unknown');
  assert.equal(f.executions(), 0);
});
