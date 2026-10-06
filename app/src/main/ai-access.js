const fs = require("fs-extra");
const path = require("path");

const CAPABILITIES = ["read", "create", "edit", "delete", "execute", "upload", "download"];
const RESOURCE_TYPES = ["source", "database", "config", "vps", "s3"];

function policyFile() {
  return path.join(global.CONST.DATA_DIR, "ai-access.json");
}

function auditFile() {
  return path.join(global.CONST.DATA_DIR, "logs", "ai-access.jsonl");
}

function skillFile() {
  return path.join(__dirname, "..", "..", "skills", "shieldpress-ai-access", "SKILL.md");
}

function reqnoraFile() { return path.join(global.CONST.DATA_DIR, "reqnora.json"); }

function defaults() {
  return {
    version: 1,
    enabled: false,
    requireApproval: true,
    backupBeforeWrite: true,
    redactSecrets: true,
    sessionMinutes: 60,
    sessionApproval: false,
    sessionApprovalUntil: null,
    resources: [],
    expiresAt: null,
    updatedAt: null,
  };
}

function normalizeResource(item) {
  if (!item || !RESOURCE_TYPES.includes(item.type) || !String(item.id || "").trim()) return null;
  const permissions = {};
  for (const capability of CAPABILITIES) permissions[capability] = item.fullAccess === true || item.permissions?.[capability] === true;
  return {
    fullAccess: item.fullAccess === true,
    type: item.type,
    id: String(item.id),
    name: String(item.name || item.id).slice(0, 200),
    scope: String(item.scope || "").slice(0, 1000),
    permissions,
  };
}

async function getPolicy() {
  try {
    const saved = await fs.readJson(policyFile());
    const expiresAt = saved.expiresAt || null;
    const expired = !!expiresAt && Date.parse(expiresAt) <= Date.now();
    return {
      ...defaults(),
      ...saved,
      enabled: saved.enabled === true && !expired,
      requireApproval: saved.requireApproval !== false,
      backupBeforeWrite: saved.backupBeforeWrite !== false,
      redactSecrets: true,
      sessionMinutes: saved.sessionMinutes === 0 ? 0 : Math.min(480, Math.max(5, Number(saved.sessionMinutes) || 60)),
      sessionApproval: saved.sessionApproval === true && (saved.sessionMinutes === 0 || (!!saved.sessionApprovalUntil && Date.parse(saved.sessionApprovalUntil) > Date.now())),
      sessionApprovalUntil: saved.sessionApprovalUntil || null,
      resources: Array.isArray(saved.resources) ? saved.resources.map(normalizeResource).filter(Boolean) : [],
      expiresAt,
    };
  } catch {
    return defaults();
  }
}

async function appendAudit(entry) {
  await fs.ensureDir(path.dirname(auditFile()));
  const safe = {
    at: new Date().toISOString(),
    event: String(entry.event || "policy-updated").slice(0, 80),
    detail: String(entry.detail || "").slice(0, 1000),
  };
  await fs.appendFile(auditFile(), JSON.stringify(safe) + "\n", { encoding: "utf8", mode: 0o600 });
}

async function savePolicy(input) {
  const current = await getPolicy();
  const sessionMinutes = input?.sessionMinutes === 0 ? 0 : Math.min(480, Math.max(5, Number(input?.sessionMinutes) || 60));
  const next = {
    version: 1,
    enabled: input?.enabled === true,
    requireApproval: input?.requireApproval !== false,
    backupBeforeWrite: input?.backupBeforeWrite !== false,
    redactSecrets: true,
    sessionMinutes,
    sessionApproval: input?.sessionApproval === true,
    sessionApprovalUntil: input?.sessionApproval === true && sessionMinutes > 0 ? new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString() : null,
    resources: Array.isArray(input?.resources) ? input.resources.map(normalizeResource).filter(Boolean) : [],
    expiresAt: input?.enabled === true && sessionMinutes > 0 ? new Date(Date.now() + sessionMinutes * 60 * 1000).toISOString() : null,
    updatedAt: new Date().toISOString(),
  };
  await fs.ensureDir(path.dirname(policyFile()));
  await fs.writeJson(policyFile(), next, { spaces: 2, mode: 0o600 });
  try { await fs.chmod(policyFile(), 0o600); } catch {}
  await appendAudit({
    event: "policy-updated",
    detail: `AI access ${next.enabled ? "enabled" : "disabled"}; ${next.resources.length} resource(s) authorized`,
  });
  return { success: true, policy: next, changed: JSON.stringify(current) !== JSON.stringify(next) };
}

async function getResources() {
  const [projects, connectionsResult, bucketsResult] = await Promise.all([
    require("./projects").getProjects().catch(() => []),
    require("./sftp").getConnections().catch(() => ({ connections: [] })),
    require("./s3").getBuckets().catch(() => ({ buckets: [] })),
  ]);
  const projectItems = Array.isArray(projects) ? projects : (projects.projects || []);
  const connections = connectionsResult.connections || connectionsResult || [];
  const buckets = bucketsResult.buckets || bucketsResult || [];
  const configResources = [
    { type: "config", id: "shieldpress", name: "ShieldPress settings", scope: global.CONST.CONFIG_FILE },
    { type: "config", id: "mariadb", name: "MariaDB configuration", scope: path.join(global.CONST.MARIADB_DIR, process.platform === "win32" ? "my.ini" : "my.cnf") },
    { type: "config", id: "nginx", name: "Nginx configuration", scope: path.join(global.CONST.NGINX_DIR, "conf", "nginx.conf") },
  ];
  try {
    const versions = await fs.readdir(global.CONST.PHP_BASE_DIR, { withFileTypes: true });
    for (const version of versions.filter((entry) => entry.isDirectory())) {
      configResources.push({
        type: "config", id: `php-${version.name}`, name: `PHP ${version.name} configuration`,
        scope: path.join(global.CONST.PHP_BASE_DIR, version.name, "php.ini"),
      });
    }
  } catch {}
  return {
    success: true,
    resources: [
      ...projectItems.map((project) => ({
        type: "source", id: String(project.id), name: project.name || project.id,
        scope: project.path || path.join(global.CONST.PROJECTS_DIR, String(project.id), "www"),
      })),
      ...projectItems.filter((project) => project.dbName).map((project) => ({
        type: "database", id: String(project.dbName), name: project.dbName, scope: project.dbName,
      })),
      ...configResources,
      ...connections.map((connection) => ({
        // Host is display metadata for the local settings UI. It is not part
        // of the saved authorization policy or the AI resource label.
        type: "vps", id: String(connection.id), name: `${String(connection.type || "sftp").toUpperCase()} — ${connection.name || "Saved connection"}`,
        host: String(connection.host || ""),
        scope: connection.remotePath || "/",
      })),
      ...buckets.map((bucket) => ({
        type: "s3", id: String(bucket.id), name: bucket.name || bucket.bucket || bucket.id,
        scope: bucket.prefix || bucket.remotePrefix || "",
      })),
    ],
  };
}

async function getSkill() {
  return { success: true, name: "shieldpress-ai-access", content: await fs.readFile(skillFile(), "utf8") };
}

async function getAudit(limit = 100) {
  try {
    const text = await fs.readFile(auditFile(), "utf8");
    const entries = text.trim().split(/\r?\n/).filter(Boolean).slice(-Math.min(500, Math.max(1, Number(limit) || 100)))
      .reverse().map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return { success: true, entries };
  } catch {
    return { success: true, entries: [] };
  }
}

async function getReqnora() {
  try {
    const saved = await fs.readJson(reqnoraFile());
    return { success: true, configured: !!saved.apiKey, apiKeyPresent: !!saved.apiKey };
  } catch { return { success: true, configured: false, apiKeyPresent: false }; }
}

async function saveReqnora(input) {
  const value = String(typeof input === "object" ? input.apiKey : input || "").trim();
  const webhookSecret = String(typeof input === "object" ? input.webhookSecret || "" : "").trim();
  const apiUrl = String(typeof input === "object" ? input.apiUrl || "https://app.reqnora.com" : "https://app.reqnora.com").trim().replace(/\/+$/, "");
  if (!value) return { success: false, message: "API key is required" };
  const sftp = require("./sftp");
  const status = await sftp.getVaultStatus();
  if (!status.unlocked) return { success: false, message: "Unlock the ShieldPress credential vault before saving the Reqnora API key" };
  const sealed = sftp.sealCredential(value);
  if (!sealed) return { success: false, message: "Could not encrypt the Reqnora API key" };
  const secret = webhookSecret ? sftp.sealCredential(webhookSecret) : "";
  await fs.writeJson(reqnoraFile(), { apiKey: sealed, webhookSecret: secret, apiUrl, updatedAt: new Date().toISOString() }, { spaces: 2, mode: 0o600 });
  try { await fs.chmod(reqnoraFile(), 0o600); } catch {}
  await appendAudit({ event: "reqnora-key-updated", detail: "Reqnora API key stored in the credential vault" });
  return { success: true, configured: true };
}

module.exports = { CAPABILITIES, RESOURCE_TYPES, getPolicy, savePolicy, getResources, getSkill, getAudit, getReqnora, saveReqnora, appendAudit };
