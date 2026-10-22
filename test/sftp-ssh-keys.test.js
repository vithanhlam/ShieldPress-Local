const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { Server, utils } = require('ssh2');

// Exercise actual SSH authentication and authorized_keys writes in an isolated
// local account directory; no user's VPS or existing keys are touched.
test('managed encrypted keys upload safely and authenticate without password fallback', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shieldpress-ssh-keys-'));
  const home = path.join(root, 'server-home');
  await fs.ensureDir(home);
  const previousConst = global.CONST;
  const previousState = global.STATE;
  global.CONST = { DATA_DIR: path.join(root, 'data'), PROJECTS_DIR: root };
  global.STATE = { logBuffer: [] };
  const sftp = require('../app/src/main/sftp');
  const clients = new Set();
  let passwordLogins = 0;
  let publicKeyLogins = 0;
  const server = new Server({ hostKeys: [utils.generateKeyPairSync('ed25519').private] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', ctx => {
      if (ctx.username !== 'deploy') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'initial-password') {
        passwordLogins++;
        return ctx.accept();
      }
      if (ctx.method === 'publickey') {
        const authorized = fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8');
        const matching = authorized.split('\n').map(line => utils.parseKey(line)).find(key => !(key instanceof Error) && key && key.getPublicSSH().equals(ctx.key.data));
        if (matching && (!ctx.signature || matching.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
          if (ctx.signature) publicKeyLogins++;
          return ctx.accept();
        }
      }
      ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', (_accept, reject) => reject());
      session.on('exec', (accept, _reject, info) => {
        const channel = accept();
        const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, HOME: home } });
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        child.on('close', code => { channel.exit(code); channel.end(); });
      });
    }));
  });
  t.after(async () => {
    await sftp.disconnectAll();
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
    global.CONST = previousConst;
    global.STATE = previousState;
    await fs.remove(root);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  await sftp.setupVault("temporary master password");
  assert.equal((await sftp.createSshKey({ passphrase: 'short' })).success, false);
  const passphrase = 'a private key test passphrase';
  const created = await sftp.createSshKey({ name: 'Local test', passphrase });
  assert.equal(created.success, true);
  const privateKey = await fs.readFile(created.key.privateKey);
  assert.ok(utils.parseKey(privateKey) instanceof Error, 'private key must require a passphrase');
  assert.ok(!(utils.parseKey(privateKey, passphrase) instanceof Error));
  assert.equal((await fs.stat(created.key.privateKey)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(created.key.privateKey))).mode & 0o777, 0o700);
  const listedKey = (await sftp.listSshKeys()).keys[0];
  assert.equal(listedKey.id, created.key.id);
  assert.equal(listedKey.hasSavedPassphrase, true);
  const vaultFile = path.join(global.CONST.DATA_DIR, 'remote-connections', 'vault.json');
  assert.ok(!(await fs.readFile(vaultFile, 'utf8')).includes(passphrase));
  assert.equal((await sftp.revealSshKeyPassphrase({ id: created.key.id, masterPassword: 'wrong-password' })).success, false);
  assert.equal((await sftp.revealSshKeyPassphrase({ id: created.key.id, masterPassword: 'temporary master password' })).passphrase, passphrase);
  await assert.rejects(() => sftp.testSshKey({ id: '../outside' }), /Invalid SSH key ID/);

  const saved = await sftp.saveConnection({ name: 'Isolated SSH server', type: 'sftp', host: '127.0.0.1', port: server.address().port, username: 'deploy', password: 'initial-password' });
  const connectionId = saved.connection.id;
  await fs.ensureDir(path.join(home, '.ssh'));
  const authorizedFile = path.join(home, '.ssh', 'authorized_keys');
  const existingKey = utils.generateKeyPairSync('ed25519').public.trim();
  await fs.writeFile(authorizedFile, existingKey + '\n');

  const args = { id: created.key.id, connectionId, passphrase };
  assert.equal((await sftp.uploadSshKey(args)).success, true, 'upload connects using the saved initial login');
  assert.equal((await sftp.uploadSshKey(args)).success, true);
  const authorized = await fs.readFile(authorizedFile, 'utf8');
  assert.ok(authorized.includes(existingKey), 'existing keys must be retained');
  assert.equal(authorized.split(created.key.publicKey).length - 1, 1, 'repeated upload must not duplicate the key');
  assert.equal((await fs.stat(authorizedFile)).mode & 0o777, 0o600);
  const Module = require('node:module');
  const originalLoad = Module._load;
  const backupFile = path.join(root, 'encrypted-key-backup.json');
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { dialog: { showSaveDialog: async () => ({ canceled: false, filePath: backupFile }) } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { assert.equal((await sftp.exportSshKey({ id: args.id })).success, true); }
  finally { Module._load = originalLoad; }
  const backupText = await fs.readFile(backupFile, 'utf8');
  assert.ok(!backupText.includes(passphrase), 'backup must never contain a plaintext passphrase');
  const backup = JSON.parse(backupText);
  const vaultCrypto = require('../app/src/main/credential-vault');
  const backupVaultKey = vaultCrypto.unlock('temporary master password', backup.vault);
  assert.equal(vaultCrypto.open(backup.passphrase, backupVaultKey), passphrase);
  assert.ok(utils.parseKey(backup.privateKey) instanceof Error);
  const initialLogins = passwordLogins;
  assert.equal((await sftp.testSshKey({ id: args.id, connectionId })).success, true, 'saved passphrase is used automatically');
  assert.ok(publicKeyLogins > 0);
  assert.equal(passwordLogins, initialLogins, 'key test must never fall back to password');
  assert.equal((await sftp.testSshKey({ ...args, passphrase: 'incorrect passphrase' })).success, false);

  assert.equal((await sftp.bindSshKey({ id: args.id, connectionId })).success, true);
  assert.equal((await sftp.changeVaultPassword('temporary master password', 'updated master password')).success, true);
  assert.equal((await sftp.revealSshKeyPassphrase({ id: args.id, masterPassword: 'temporary master password' })).success, false);
  assert.equal((await sftp.revealSshKeyPassphrase({ id: args.id, masterPassword: 'updated master password' })).passphrase, passphrase);
  await sftp.lockVault();
  await assert.rejects(() => sftp.testSshKey({ id: args.id, connectionId }), /Unlock Vault/);
  await sftp.unlockVault('updated master password');
  assert.equal((await sftp.connect(connectionId)).success, true, 'bound key works after vault password change');
  await fs.remove(authorizedFile);
  const outside = path.join(home, 'untouched');
  await fs.writeFile(outside, 'untouched');
  await fs.symlink(outside, authorizedFile);
  assert.equal((await sftp.uploadSshKey(args)).success, false, 'a refused remote command must report failure');
  assert.equal(await fs.readFile(outside, 'utf8'), 'untouched');
});
