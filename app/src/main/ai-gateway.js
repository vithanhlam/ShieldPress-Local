const http = require("http");
const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

let server = null;
let gatewayToken = null;
const pendingRequests = new Map();
const reqnoraWatchers = new Map();
let pendingWrites = Promise.resolve();
const MAX_PENDING_REQUESTS = 100;
async function notifyReqnora(payload) {
  try {
    const result = await require("./reqnora").sendNotification(payload);
    if (result.success) await require("./ai-access").appendAudit({ event: "reqnora-notification-sent", detail: payload.title });
    return result;
  } catch (error) {
    await require("./ai-access").appendAudit({ event: "reqnora-notification-failed", detail: error.message });
    return { success: false, message: error.message };
  }
}
async function requestReqnora(payload) {
  try {
    const result = await require("./reqnora").sendRequest(payload);
    if (result.success) await require("./ai-access").appendAudit({ event: "reqnora-request-sent", detail: `${payload.title} (${result.data?.id || "created"})` });
    return result;
  } catch (error) {
    await require("./ai-access").appendAudit({ event: "reqnora-request-failed", detail: error.message });
    return { success: false, message: error.message };
  }
}
function watchReqnora(request) {
  if (!request.reqnoraId || reqnoraWatchers.has(request.id)) return;
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 15 * 60 * 1000 || request.status !== "pending") { clearInterval(timer); reqnoraWatchers.delete(request.id); return; }
    try {
      const result = await require("./reqnora").getRequest(request.reqnoraId);
      const data = result.data || {};
      const action = data.action || data.answer?.action || (data.status === "approved" ? "approve" : data.status === "rejected" ? "reject" : "");
      if (!action) return;
      clearInterval(timer); reqnoraWatchers.delete(request.id);
      await resolveApproval(request.id, action === "approve");
      await require("./ai-access").appendAudit({ event: "reqnora-poll-answered", detail: `${request.reqnoraId}: ${action}` });
    } catch (error) {
      await require("./ai-access").appendAudit({ event: "reqnora-poll-failed", detail: error.message });
    }
  }, 5000);
  timer.unref?.();
  reqnoraWatchers.set(request.id, timer);
}

function tokenFile() { return path.join(global.CONST.DATA_DIR, "ai-access-gateway.json"); }
function pendingFile() { return path.join(global.CONST.DATA_DIR, "ai-access-pending.json"); }
function getConnectInfo() {
  const scriptPath = global.CONST.MCP_SCRIPT_PATH || path.join(global.CONST.BASE_DIR || process.cwd(), "scripts", "shieldpress-mcp.js");
  const running = !!server && !!server.address();
  return {
    running,
    dataDir: global.CONST.DATA_DIR,
    scriptPath,
    // This is deliberately token-free. The bridge reads the short-lived token
    // locally from DATA_DIR, so a copied client configuration never exposes it.
    mcpConfig: {
      mcpServers: {
        shieldpress: {
          command: "node",
          args: [scriptPath],
          env: { SHIELDPRESS_DATA_DIR: global.CONST.DATA_DIR },
        },
      },
    },
  };
}
async function loadPending() {
  try {
    const entries = await fs.readJson(pendingFile());
    if (Array.isArray(entries)) {
      pendingRequests.clear();
      entries.forEach(entry => {
        if (['approved', 'executing'].includes(entry.status) && !entry.result) {
          entry.status = 'unknown';
          entry.result = { success: false, status: 'unknown', message: 'Previous execution result was not saved. Inspect the target before retrying.' };
        }
        pendingRequests.set(entry.id, entry);
      });
    }
  } catch {}
}
async function savePending() {
  await fs.ensureDir(global.CONST.DATA_DIR);
  // Keep the in-memory registry bounded as well as the persisted history.
  // Previously only the JSON file was sliced, so every resolved request stayed
  // reachable from this Map for the lifetime of the main process.
  if (pendingRequests.size > MAX_PENDING_REQUESTS) {
    for (const [id, request] of pendingRequests) {
      if (pendingRequests.size <= MAX_PENDING_REQUESTS) break;
      if (request.status !== "pending") pendingRequests.delete(id);
    }
  }
  const snapshot = JSON.parse(JSON.stringify([...pendingRequests.values()].slice(-MAX_PENDING_REQUESTS)));
  pendingWrites = pendingWrites.catch(() => {}).then(() => fs.writeJson(pendingFile(), snapshot, { spaces: 2, mode: 0o600 }));
  await pendingWrites;
}
function approvalResponse(request) {
  return { status: 'approval_required', requestId: request.id, message: 'This exact request is already pending in AI Access.' };
}
function matchingPending(candidate) {
  return [...pendingRequests.values()].find(r => r.status === 'pending' &&
    r.resourceId === candidate.resourceId && r.operation === candidate.operation &&
    r.command === candidate.command && r.workingDirectory === candidate.workingDirectory &&
    r.sql === candidate.sql && JSON.stringify(r.args) === JSON.stringify(candidate.args) &&
    r.summary === candidate.summary);
}
async function getRequest(id) {
  const request = pendingRequests.get(String(id));
  if (!request) return { success: false, message: 'Request not found' };
  return { success: true, requestId: request.id, status: request.status, createdAt: request.createdAt,
    resolvedAt: request.resolvedAt, result: request.result || null };
}
function tools() {
  return [
    { name: "shieldpress.get_request", description: "Get the persisted approval and execution result by request ID. Checking status never executes the request again.", inputSchema: { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } } },
    { name: "shieldpress.file_operation", description: "Write or delete files, upload local files to VPS/S3, or download them. Transfers require an authorized local resource and remote resource. Full-access resources execute without an in-app approval; ask the user in chat when confirmation is needed. Use this tool for concrete changes instead of request_change.", inputSchema: { type: "object", required: ["resourceId", "operation", "path"], properties: { resourceId: { type: "string" }, operation: { type: "string", enum: ["write", "delete", "upload", "download"] }, path: { type: "string" }, content: { type: "string" }, localResourceId: { type: "string" }, localPath: { type: "string" }, isDirectory: { type: "boolean" } } } },
    { name: "shieldpress.list_resources", description: "List resources explicitly authorized in ShieldPress AI Access.", inputSchema: { type: "object", properties: {} } },
    { name: "shieldpress.read_file", description: "Read an approved local project or configuration file. Secrets are redacted.", inputSchema: { type: "object", required: ["resourceId", "path"], properties: { resourceId: { type: "string" }, path: { type: "string" } } } },
    { name: "shieldpress.read_remote_file", description: "Read an approved file through a saved SFTP/FTP connection.", inputSchema: { type: "object", required: ["resourceId", "path"], properties: { resourceId: { type: "string" }, path: { type: "string" } } } },
    { name: "shieldpress.inspect_remote", description: "Read safe VPS resource metrics such as disk, memory, CPU, OS and PHP information without opening an arbitrary shell.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: { type: "string" } } } },
    { name: "shieldpress.read_s3_object", description: "Read an approved S3 object under the configured prefix.", inputSchema: { type: "object", required: ["resourceId", "key"], properties: { resourceId: { type: "string" }, key: { type: "string" } } } },
    { name: "shieldpress.query_database", description: "Query an authorized local database. Full access supports database changes without in-app approval and with a backup when required.", inputSchema: { type: "object", required: ["resourceId", "query"], properties: { resourceId: { type: "string" }, query: { type: "string" } } } },
    { name: "shieldpress.run_remote_command", description: "Run a command on an authorized VPS. Full-access resources run commands without in-app approval. Ask the user in chat when confirmation is needed.", inputSchema: { type: "object", required: ["resourceId", "command"], properties: { resourceId: { type: "string" }, command: { type: "string" }, workingDirectory: { type: "string", description: "Optional remote working directory; no terminal is required" } } } },
    { name: "shieldpress.inspect_runtime", description: "Inspect local PHP, MariaDB, Nginx and project runtime status.", inputSchema: { type: "object", properties: {} } },
  ];
}

function redact(text) {
  return String(text).replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(define\s*\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY)['"]\s*,\s*['"])([^'"]*)/gi, "$1[REDACTED]");
}

function redactResult(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactResult(item)]));
  return value;
}
async function policy() { return require("./ai-access").getPolicy(); }
function findResource(p, id) { return (p.resources || []).find((r) => `${r.type}:${r.id}` === id || String(r.id) === String(id)); }
function underScope(target, scope) {
  const resolved = path.resolve(target); const root = path.resolve(scope);
  return resolved === root || resolved.startsWith(root + path.sep);
}
function underRemoteScope(target, scope) {
  const clean = String(target || "").replace(/\\/g, "/");
  const root = String(scope || "/").replace(/\\/g, "/").replace(/\/$/, "") || "/";
  return clean === root || clean.startsWith(root.endsWith("/") ? root : root + "/");
}

async function dispatch(name, args) {
  const ai = require("./ai-access");
  const p = await policy();
  if (!p.enabled) throw new Error("AI Access is disabled in ShieldPress");
  if (name === "shieldpress.list_resources") return { resources: (p.resources || []).filter((r) => r.permissions.read).map((r) => ({ id: `${r.type}:${r.id}`, type: r.type, name: r.name, scope: r.scope, permissions: r.permissions })) };
  if (name === "shieldpress.inspect_runtime") {
    const services = require("./services");
    const versions = await services.getAvailablePhpVersions().catch(() => []);
    return redact(JSON.stringify({ phpVersions: versions, serviceStatus: { nginx: !!global.STATE.isNginxRunning, php: !!global.STATE.isPhpRunning, mariadb: !!global.STATE.isDBRunning }, projects: Object.keys(global.STATE.runningProjects || {}) }, null, 2));
  }
  if (name === "shieldpress.get_request") return getRequest(args?.requestId);
  const resource = findResource(p, args?.resourceId);
  if (!resource) throw new Error("Resource is not authorized in AI Access");
  if (name === "shieldpress.file_operation") {
    const operations = require('./ai-operations');
    const risk = await operations.execute(p, args, true);
    const request = { id: crypto.randomBytes(12).toString('hex'), resourceId: args.resourceId, operation: args.operation, path: args.path, args, summary: `${args.operation}: ${args.path}${args.localPath ? ` ↔ ${args.localPath}` : ''}`, dangerous: risk.dangerous, createdAt: new Date().toISOString(), status: 'pending' };
    const existing = matchingPending(request);
    if (existing) return resource.fullAccess ? resolveApproval(existing.id, true) : approvalResponse(existing);
    pendingRequests.set(request.id, request);
    await savePending();
    await ai.appendAudit({ event: 'file-operation-requested', detail: `${args.resourceId}: ${request.summary}` });
    if (resource.fullAccess || (!request.dangerous && (!p.requireApproval || p.sessionApproval))) return resolveApproval(request.id, true);
    global.STATE.mainWindow?.webContents?.send('ai-access-approval-request', request);
    return { status: 'approval_required', requestId: request.id, message: request.dangerous ? 'Dangerous operation: fresh confirmation is required in AI Access.' : 'Approve the file operation in AI Access.' };
  }
  if (name === "shieldpress.read_file") {
    if (!resource.permissions.read) throw new Error("Read permission is not granted");
    const target = await require("./ai-operations").localPath(resource, args.path);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Target is not a file");
    if (stat.size > 2 * 1024 * 1024) throw new Error("File exceeds the 2 MB AI read limit");
    return { resourceId: args.resourceId, path: target, content: redact(await fs.readFile(target, "utf8")) };
  }
  if (name === "shieldpress.read_remote_file") {
    if (resource.type !== "vps" || !resource.permissions.read) throw new Error("Remote read permission is not granted");
    require("./ai-operations").remotePath(resource, args.path);
    const sftp = require("./sftp");
    const connection = await sftp.ensureAiConnection(resource.id, { requireSftp: true });
    if (!connection.success) throw new Error(connection.message);
    const activeId = connection.activeId;
    const result = await sftp.readRemoteFile(activeId, String(args.path));
    if (!result?.success && result?.content === undefined) throw new Error(result?.message || "Remote file could not be read");
    return { resourceId: args.resourceId, path: args.path, content: redact(String(result.content || "")).slice(0, 2 * 1024 * 1024) };
  }
  if (name === "shieldpress.inspect_remote") {
    if (resource.type !== "vps" || !resource.permissions.read) throw new Error("Remote read permission is not granted");
    const sftp = require("./sftp");
    const connection = await sftp.ensureAiConnection(resource.id, { requireSsh: true });
    if (!connection.success) throw new Error(connection.message);
    const [stats, system] = await Promise.all([
      sftp.getRemoteStats(connection.activeId),
      sftp.getRemoteSystemInfo(connection.activeId),
    ]);
    return { resourceId: args.resourceId, stats, system };
  }
  if (name === "shieldpress.read_s3_object") {
    if (resource.type !== "s3" || !resource.permissions.read) throw new Error("S3 read permission is not granted");
    const key = String(args.key || "");
    require("./ai-operations").remotePath(resource, key);
    const temp = path.join(os.tmpdir(), `shieldpress-ai-${crypto.randomBytes(8).toString("hex")}.object`);
    try {
      const result = await require("./s3").downloadObject(resource.id, key, temp);
      if (!result?.success) throw new Error(result?.message || "S3 object could not be read");
      const stat = await fs.stat(temp); if (stat.size > 2 * 1024 * 1024) throw new Error("Object exceeds the 2 MB AI read limit");
      return { resourceId: args.resourceId, key, content: redact(await fs.readFile(temp, "utf8")) };
    } finally { await fs.remove(temp).catch(() => {}); }
  }
  if (name === "shieldpress.query_database") {
    if (resource.type !== "database" || !resource.permissions.read) throw new Error("Database read permission is not granted");
    const query = String(args.query || "").trim().replace(/;\s*$/, "");
    if (!query || /[\u0000]/.test(query)) throw new Error("Invalid query");
    const readOnly = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(query) && !/[;!]|\b(?:INTO|OUTFILE|DUMPFILE|FOR\s+UPDATE)\b/i.test(query);
    if (!readOnly) {
      if (!resource.fullAccess) throw new Error("Full access is required for database changes");
      const request = { id: crypto.randomBytes(12).toString('hex'), resourceId: args.resourceId, operation: 'edit', sql: query, summary: `Database change: ${query}`, dangerous: true, createdAt: new Date().toISOString(), status: 'pending' };
      const existing = matchingPending(request);
      if (existing) return resource.fullAccess ? resolveApproval(existing.id, true) : approvalResponse(existing);
      pendingRequests.set(request.id, request);
      await savePending();
      await ai.appendAudit({ event: 'database-change-requested', detail: `${resource.name}: ${query}` });
      return resolveApproval(request.id, true);
    }
    const db = String(resource.id).replace(/`/g, '``');
    const result = await require("./database").execRawSql(`USE \`${db}\`; ${query}`);
    if (!result.success) throw new Error(result.message);
    return { resourceId: args.resourceId, output: redact(String(result.output || "")).slice(0, 2 * 1024 * 1024) };
  }
  if (name === "shieldpress.run_remote_command") {
    if (resource.type !== "vps" || !resource.permissions.execute) throw new Error("Execute command permission is not granted");
    const command = String(args.command || "").trim();
    if (!command || /[\u0000\r]/.test(command)) throw new Error("Invalid command");
    const workingDirectory = args.workingDirectory ? require("./ai-operations").remotePath(resource, args.workingDirectory) : null;
    const id = crypto.randomBytes(12).toString("hex");
    const request = { id, workingDirectory, path: workingDirectory || "", resourceId: args.resourceId, operation: "execute", summary: `Run command: ${command}`, dangerous: require("./ai-operations").dangerousCommand(command), command, createdAt: new Date().toISOString(), status: "pending" };
    const existing = matchingPending(request);
    if (existing) return resource.fullAccess ? resolveApproval(existing.id, true) : approvalResponse(existing);
    pendingRequests.set(id, request);
    await savePending();
    await ai.appendAudit({ event: "command-requested", detail: `${resource.name}: ${command}` });
    if (resource.fullAccess || (!request.dangerous && (!p.requireApproval || p.sessionApproval))) {
      await ai.appendAudit({ event: "policy-auto-approved", detail: `${resource.name}: ${command}` });
      return resolveApproval(id, true);
    }
    const remoteRequest = await requestReqnora({ title: `Approval needed: ${resource.name}`, message: `AI requests Execute permission for:\n${command}`, severity: "warning" });
    if (remoteRequest.success) { request.reqnoraId = remoteRequest.data?.id || null; await savePending(); watchReqnora(request); }
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-request", request);
    if (!request.dangerous && (await policy()).sessionApproval) {
      await ai.appendAudit({ event: "session-auto-approved", detail: `${resource.name}: ${command}` });
      return resolveApproval(id, true);
    }
    return { status: "approval_required", requestId: id, message: "Open AI Access and approve the exact command before execution." };
  }
  if (name === "shieldpress.request_change") {
    const operation = String(args.operation || "");
    if (!ai.CAPABILITIES.includes(operation) || !resource.permissions[operation]) throw new Error(`${operation} permission is not granted`);
    const id = crypto.randomBytes(12).toString("hex");
    const request = { id, resourceId: args.resourceId, operation, dangerous: true, summary: String(args.summary || "").slice(0, 500), path: String(args.path || ""), createdAt: new Date().toISOString(), status: "pending" };
    const existing = matchingPending(request);
    if (existing) return resource.fullAccess ? resolveApproval(existing.id, true) : approvalResponse(existing);
    pendingRequests.set(id, request);
    await ai.appendAudit({ event: "change-requested", detail: `${operation} requested for ${resource.name}: ${request.summary}` });
    await savePending();
    if (resource.fullAccess || (!request.dangerous && (!p.requireApproval || p.sessionApproval))) {
      await ai.appendAudit({ event: "policy-auto-approved", detail: `${operation} requested for ${resource.name}: ${request.summary}` });
      return resolveApproval(id, true);
    }
    const remoteRequest = await requestReqnora({ title: `Approval needed: ${resource.name}`, message: `${operation}: ${request.summary}`, severity: "warning" });
    if (remoteRequest.success) { request.reqnoraId = remoteRequest.data?.id || null; await savePending(); watchReqnora(request); }
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-request", request);
    if (!request.dangerous && (await policy()).sessionApproval) {
      await ai.appendAudit({ event: "session-auto-approved", detail: `${operation} requested for ${resource.name}: ${request.summary}` });
      return resolveApproval(id, true);
    }
    return { status: "approval_required", requestId: id, message: "ShieldPress has sent this request to the AI Access approval panel. No change was made until approved." };
  }
  throw new Error("Unknown tool");
}

async function listPending() { return { success: true, requests: [...pendingRequests.values()].filter((request) => request.status === "pending") }; }
async function resolveApproval(id, approved) {
  const request = pendingRequests.get(String(id));
  if (!request) return { success: false, message: "Approval request not found" };
  if (request.status !== 'pending') return getRequest(id);
  // Claim synchronously before awaiting persistence: UI and remote approval can race.
  request.status = approved ? 'executing' : 'denied';
  let result;
  try { result = await executeApproval(id, approved); }
  catch (error) { result = { success: false, status: 'failed', message: redact(error.message) }; }
  request.status = result.status || (result.success ? 'applied' : 'failed');
  request.result = redactResult(result);
  request.resolvedAt = new Date().toISOString();
  await savePending();
  global.STATE.mainWindow?.webContents?.send('ai-access-approval-result', { ...request, result: request.result });
  return { ...request.result, requestId: request.id };
}
async function executeApproval(id, approved) {
  const request = pendingRequests.get(String(id));
  if (!request) return { success: false, message: "Approval request not found" };
  request.status = approved ? "executing" : "denied";
  request.resolvedAt = new Date().toISOString();
  await savePending();
  if (!approved) {
    await require("./ai-access").appendAudit({ event: "change-denied", detail: `${request.operation} denied for ${request.resourceId}` });
    await notifyReqnora({ title: "ShieldPress request denied", message: `${request.operation} denied for ${request.resourceId}`, severity: "danger" });
    return { success: true, status: "denied" };
  }
  const currentPolicy = await policy();
  const currentResource = require('./ai-operations').resource(currentPolicy, request.resourceId.includes(':') ? request.resourceId : `vps:${request.resourceId}`);
  if (request.args) {
    let result;
    try { result = await require('./ai-operations').execute(currentPolicy, request.args); }
    catch (error) { result = { success: false, message: error.message }; }
    request.status = result.success ? 'applied' : 'failed';
    await savePending();
    await require('./ai-access').appendAudit({ event: `file-operation-${request.status}`, detail: `${request.resourceId}: ${request.summary}` });
    return { ...result, status: request.status };
  }
  require('./ai-operations').permission(currentResource, request.operation);
  if (request.sql) {
    const database = require('./database');
    let result;
    if (currentResource.type !== 'database' || !currentResource.fullAccess) throw new Error('Full database access is required');
    try {
      if (currentPolicy.backupBeforeWrite) {
        const backup = await database.exportDatabase({ dbName: currentResource.id });
        if (!backup.success) throw new Error(backup.message || 'Database backup failed');
      }
      const db = String(currentResource.id).replace(/`/g, '``');
      result = await database.execRawSql(`USE \`${db}\`; ${request.sql}`);
    } catch (error) { result = { success: false, message: error.message }; }
    request.status = result.success ? 'applied' : 'failed';
    await savePending();
    await require('./ai-access').appendAudit({ event: `database-change-${request.status}`, detail: request.resourceId });
    const safeResult = { ...result, output: redact(result.output || '') };
    return { ...safeResult, status: request.status };
  }
  // MCP commands run independently of the interactive terminal directory.
  if (request.operation === "execute") {
    const sftp = require("./sftp");
    const connection = await sftp.ensureAiConnection(currentResource.id, { requireSsh: true });
    if (!connection.success) return { success: false, status: "failed", message: connection.message };
    const activeId = connection.activeId;
    const result = await sftp.execCommand(activeId, request.command, { isolated: true, workingDirectory: request.workingDirectory ? require("./ai-operations").remotePath(currentResource, request.workingDirectory) : null });
    await require("./ai-access").appendAudit({ event: result.success ? "command-applied" : "command-failed", detail: `${request.resourceId}: ${request.command}` });
    await notifyReqnora({ title: result.success ? "ShieldPress command completed" : "ShieldPress command failed", message: `${request.resourceId}\n${result.success ? (result.output || "Completed") : (result.message || result.error || "Failed")}`, severity: result.success ? "success" : "danger" });
    return { success: !!result.success, status: result.success ? "applied" : "failed", output: redact(result.output || ""), stderr: redact(result.stderr || ""), exitCode: result.exitCode, message: redact(result.message || result.error || "") };
  }
  if (request.operation !== "edit" || !/\b(update|upgrade)\b.*\bshieldpress\b|\bshieldpress\b.*\b(update|upgrade)\b/i.test(request.summary)) {
    await require("./ai-access").appendAudit({ event: "change-approved", detail: `Approved but no fixed executor exists for ${request.operation} on ${request.resourceId}` });
    return { success: true, status: "approved", message: "Approved. This operation does not yet have an executable handler." };
  }
  const sftp = require("./sftp");
  const connection = await sftp.ensureAiConnection(currentResource.id, { requireSsh: true });
  if (!connection.success) return { success: false, status: "failed", message: connection.message };
  const activeId = connection.activeId;
  const result = await sftp.execCommand(activeId, "shieldpress update", { isolated: true });
  await require("./ai-access").appendAudit({ event: result.success ? "change-applied" : "change-failed", detail: `shieldpress update on ${request.resourceId}: ${result.success ? "success" : result.message || result.error || "failed"}` });
  await notifyReqnora({ title: result.success ? "ShieldPress change completed" : "ShieldPress change failed", message: `${request.resourceId}\n${result.success ? (result.output || "Completed") : (result.message || result.error || "Failed")}`, severity: result.success ? "success" : "danger" });
  return { success: !!result.success, status: result.success ? "applied" : "failed", output: redact(result.output || ""), stderr: redact(result.stderr || ""), exitCode: result.exitCode, message: redact(result.message || result.error || "") };
}

function json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
async function handleReqnoraWebhook(req, res) {
  let body = ""; req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    try {
      const secret = await require("./reqnora").getWebhookSecret();
      const signature = String(req.headers["x-reqnora-signature"] || "");
      const timestamp = String(req.headers["x-reqnora-timestamp"] || "");
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
      if (!Number.isFinite(age) || age > 300) return json(res, 401, { success: false, message: "Stale webhook timestamp" });
      if (!secret || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return json(res, 401, { success: false, message: "Invalid webhook signature" });
      const event = JSON.parse(body || "{}");
      const request = [...pendingRequests.values()].find((item) => item.reqnoraId === event.request_id && item.status === "pending");
      if (!request) return json(res, 404, { success: false, message: "Pending request not found" });
      const approved = event.action === "approve";
      const result = await resolveApproval(request.id, approved);
      await require("./ai-access").appendAudit({ event: "reqnora-request-answered", detail: `${event.request_id}: ${event.action}` });
      return json(res, 200, { success: !!result.success, result });
    } catch (error) { return json(res, 400, { success: false, message: error.message }); }
  });
}
async function handle(req, res) {
  if (req.method === "POST" && req.url === "/reqnora/webhook") return handleReqnoraWebhook(req, res);
  if (req.headers.authorization !== `Bearer ${gatewayToken}`) return json(res, 401, { error: "Unauthorized" });
  let body = ""; req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    try {
      const message = JSON.parse(body || "{}");
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "shieldpress", version: global.CONST.APP_VERSION || "1.0.0" } };
      else if (message.method === "notifications/initialized") return json(res, 200, {});
      else if (message.method === "tools/list") result = { tools: tools() };
      else if (message.method === "tools/call") {
        try { const value = await dispatch(message.params?.name, message.params?.arguments || {}); result = { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] }; }
        catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
      } else result = {};
      return json(res, 200, { jsonrpc: "2.0", id: message.id ?? null, result });
    } catch (error) { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: error.message } }); }
  });
}

async function start() {
  if (server) return { port: server.address().port, token: gatewayToken };
  gatewayToken = crypto.randomBytes(32).toString("hex");
  await fs.ensureDir(global.CONST.DATA_DIR);
  await loadPending();
  for (const request of pendingRequests.values()) if (request.status === "pending" && request.reqnoraId) watchReqnora(request);
  await fs.writeJson(tokenFile(), { port: 0, token: gatewayToken, createdAt: new Date().toISOString() }, { spaces: 2, mode: 0o600 });
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await fs.writeJson(tokenFile(), { port: server.address().port, token: gatewayToken, createdAt: new Date().toISOString() }, { spaces: 2, mode: 0o600 });
  return { port: server.address().port, token: gatewayToken };
}
async function stop() { if (!server) return; await new Promise((resolve) => server.close(resolve)); server = null; gatewayToken = null; try { await fs.remove(tokenFile()); } catch {} }
module.exports = { start, stop, getConnectInfo, listPending, resolveApproval, getRequest };
