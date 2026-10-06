const fs = require('fs-extra');
const path = require('path');

function resource(policy, id) {
  const found = policy.resources.find(r => `${r.type}:${r.id}` === id);
  if (!policy.enabled || !found) throw new Error('Resource is not authorized');
  return found;
}
function permission(r, cap) {
  if (!r.permissions[cap]) throw new Error(`${cap} permission is not granted`);
}
function remotePath(r, target) {
  const value = String(target || '').replace(/\\/g, '/');
  if (!value || value.includes('\0') || value.split('/').includes('..')) throw new Error('Invalid remote path');
  const root = String(r.scope || (r.type === 's3' ? '' : '/')).replace(/\/+$/, '');
  if (root && value !== root && !value.startsWith(root + '/')) throw new Error('Path is outside the approved scope');
  return value;
}
async function localPath(r, target) {
  if (!['source', 'config'].includes(r.type)) throw new Error('A local source or config resource is required');
  const root = await fs.realpath(path.resolve(r.scope));
  const value = path.resolve(String(target || ''));
  let ancestor = value;
  while (!(await fs.pathExists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Invalid path');
    ancestor = parent;
  }
  const real = path.resolve(await fs.realpath(ancestor), path.relative(ancestor, value));
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Path is outside the approved scope');
  return real;
}
function sensitivePath(target) {
  return /(?:^|\/)(?:etc|boot|\.ssh)(?:\/|$)|(?:^|\/)(?:\.env|wp-config\.php|nginx\.conf|my\.cnf|php\.ini)$/.test(target);
}
function dangerousCommand(command) {
  // Shell text cannot be fully classified without executing it. Unknown or
  // indirect commands require review; ordinary direct development commands do not.
  if (/[\n\r`$<>|;&]/.test(command)) return true;
  const words = command.trim().split(/\s+/);
  const executable = words[0];
  if (executable.includes('/') || /\b(?:delete|destroy|drop|truncate|reset|clean|prune|force|reboot|shutdown|restore)\b/i.test(command)) return true;
  if (/^(?:echo|pwd|ls|cat|head|tail|rg|grep|stat|df|free|uptime|whoami|mkdir|touch)$/.test(executable)) return false;
  if (/^(npm|pnpm|yarn)$/.test(executable)) return !/^(ci|install|build|test|run)$/.test(words[1] || '');
  if (['mysql', 'mariadb', 'psql'].includes(executable)) {
    const query = command.match(/(?:^|\s)(?:-e|--execute=|-c)\s*(["'])(.*?)\1$/);
    if (query && /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(query[2]) && !/\b(?:INTO|OUTFILE|DUMPFILE|LOAD_FILE|SLEEP|BENCHMARK|FOR\s+UPDATE)\b/i.test(query[2])) return false;
  }
  if (executable === 'git') return !/^(status|diff|log|show|fetch|pull|add|commit)$/.test(words[1] || '');
  return true;
}
async function execute(policy, args, validateOnly = false) {
  const r = resource(policy, args.resourceId);
  const operation = args.operation;
  if (!['write', 'delete', 'upload', 'download'].includes(operation)) throw new Error('Unknown file operation');
  permission(r, operation === 'write' ? 'edit' : operation);
  const remote = ['vps', 's3'].includes(r.type);
  const target = remote ? remotePath(r, args.path) : await localPath(r, args.path);
  let local;
  let localResource;
  if (operation === 'upload' || operation === 'download') {
    if (!remote) throw new Error('Transfers require a VPS or S3 resource');
    localResource = resource(policy, args.localResourceId);
    permission(localResource, operation === 'upload' ? 'read' : 'edit');
    local = await localPath(localResource, args.localPath);
    if (!validateOnly && operation === 'download') {
      if (policy.backupBeforeWrite && await fs.pathExists(local)) await fs.copy(local, `${local}.ai-backup-${Date.now()}`, { errorOnExist: true });
      await fs.ensureDir(path.dirname(local));
    }
  }
  if (validateOnly) return { dangerous: operation === 'delete' || (operation === 'download' ? localResource.type === 'config' || sensitivePath(local) : r.type === 'config' || sensitivePath(target)) };
  if (r.type === 'vps') {
    const sftp = require('./sftp');
    const connection = await sftp.ensureAiConnection(r.id, { requireSftp: true });
    if (!connection.success) throw new Error(connection.message);
    const id = connection.activeId;
    if (policy.backupBeforeWrite && operation !== 'download') {
      const listing = await sftp.listRemote(id, path.posix.dirname(target));
      if (!listing.success) throw new Error(listing.message || 'Could not check backup target');
      if (listing.items.some(item => item.name === path.posix.basename(target))) {
        const backup = await sftp.backupRemoteFile(id, target);
        if (!backup.success) throw new Error(backup.message || 'Backup failed');
      }
    }
    if (operation === 'write') return sftp.writeRemoteFile(id, target, String(args.content ?? ''), { skipBackup: true });
    if (operation === 'delete') return sftp.deleteRemote(id, target, args.isDirectory === true);
    if (operation === 'upload') return sftp.uploadFile(id, local, target);
    return sftp.downloadFile(id, target, local);
  }
  if (r.type === 's3') {
    const s3 = require('./s3');
    if (policy.backupBeforeWrite && ['upload', 'delete'].includes(operation)) {
      const listing = await s3.listObjects(r.id, target);
      if (!listing.success) throw new Error(listing.message || 'Could not check backup target');
      if (listing.items.some(item => item.key === target)) {
        const temporary = path.join(require('os').tmpdir(), `shieldpress-ai-backup-${require('crypto').randomBytes(12).toString('hex')}`);
        try {
          const download = await s3.downloadObject(r.id, target, temporary);
          if (!download.success) throw new Error(download.message || 'Backup download failed');
          const backup = await s3.uploadObject(r.id, `${target}.ai-backup-${Date.now()}`, temporary);
          if (!backup.success) throw new Error(backup.message || 'Backup upload failed');
        } finally { await fs.remove(temporary); }
      }
    }
    if (operation === 'delete') return s3.deleteObject(r.id, target);
    if (operation === 'upload') return s3.uploadObject(r.id, target, local);
    if (operation === 'download') return s3.downloadObject(r.id, target, local);
    throw new Error('Use upload to write S3 objects');
  }
  if (operation === 'delete') {
    if (policy.backupBeforeWrite) await fs.copy(target, `${target}.ai-backup-${Date.now()}`, { errorOnExist: true });
    await fs.remove(target);
  } else {
    if (policy.backupBeforeWrite && await fs.pathExists(target)) await fs.copy(target, `${target}.ai-backup-${Date.now()}`, { errorOnExist: true });
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, String(args.content ?? ''), 'utf8');
  }
  return { success: true, path: target };
}
module.exports = { execute, resource, permission, remotePath, localPath, dangerousCommand };
