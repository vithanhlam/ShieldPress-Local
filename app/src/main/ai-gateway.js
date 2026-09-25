const http = require("http");
const crypto = require("crypto");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");

let server = null;
let gatewayToken = null;
const pendingRequests = new Map();
const reqnoraWatchers = new Map();
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
    if (Array.isArray(entries)) { pendingRequests.clear(); entries.forEach((entry) => pendingRequests.set(entry.id, entry)); }
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
  await fs.writeJson(pendingFile(), [...pendingRequests.values()].slice(-MAX_PENDING_REQUESTS), { spaces: 2, mode: 0o600 });
}
function tools() {
  return [
    { name: "shieldpress.list_resources", description: "List resources explicitly authorized in ShieldPress AI Access.", inputSchema: { type: "object", properties: {} } },
    { name: "shieldpress.read_file", description: "Read an approved local project or configuration file. Secrets are redacted.", inputSchema: { type: "object", required: ["resourceId", "path"], properties: { resourceId: { type: "string" }, path: { type: "string" } } } },
    { name: "shieldpress.read_remote_file", description: "Read an approved file through a saved SFTP/FTP connection.", inputSchema: { type: "object", required: ["resourceId", "path"], properties: { resourceId: { type: "string" }, path: { type: "string" } } } },
    { name: "shieldpress.inspect_remote", description: "Read safe VPS resource metrics such as disk, memory, CPU, OS and PHP information without opening an arbitrary shell.", inputSchema: { type: "object", required: ["resourceId"], properties: { resourceId: { type: "string" } } } },
    { name: "shieldpress.read_s3_object", description: "Read an approved S3 object under the configured prefix.", inputSchema: { type: "object", required: ["resourceId", "key"], properties: { resourceId: { type: "string" }, key: { type: "string" } } } },
    { name: "shieldpress.query_database", description: "Run a read-only SELECT/SHOW/DESCRIBE/EXPLAIN query on an approved local database.", inputSchema: { type: "object", required: ["resourceId", "query"], properties: { resourceId: { type: "string" }, query: { type: "string" } } } },
    { name: "shieldpress.run_remote_command", description: "Request approval to run one exact command on an authorized VPS SSH session. This is disabled unless Execute command is granted.", inputSchema: { type: "object", required: ["resourceId", "command"], properties: { resourceId: { type: "string" }, command: { type: "string" } } } },
    { name: "shieldpress.inspect_runtime", description: "Inspect local PHP, MariaDB, Nginx and project runtime status.", inputSchema: { type: "object", properties: {} } },
    { name: "shieldpress.request_change", description: "Request a change. ShieldPress will not apply it without explicit user approval.", inputSchema: { type: "object", required: ["resourceId", "operation", "summary"], properties: { resourceId: { type: "string" }, operation: { type: "string", enum: ["create", "edit", "delete"] }, summary: { type: "string" }, path: { type: "string" } } } },
  ];
}

function redact(text) {
  return String(text).replace(/((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(define\s*\(\s*['"](?:DB_PASSWORD|AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY)['"]\s*,\s*['"])([^'"]*)/gi, "$1[REDACTED]");
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
  const resource = findResource(p, args?.resourceId);
  if (!resource) throw new Error("Resource is not authorized in AI Access");
  if (name === "shieldpress.read_file") {
    if (!resource.permissions.read) throw new Error("Read permission is not granted");
    const target = path.resolve(String(args.path || ""));
    if (!underScope(target, resource.scope)) throw new Error("Path is outside the approved scope");
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Target is not a file");
    if (stat.size > 2 * 1024 * 1024) throw new Error("File exceeds the 2 MB AI read limit");
    return { resourceId: args.resourceId, path: target, content: redact(await fs.readFile(target, "utf8")) };
  }
  if (name === "shieldpress.read_remote_file") {
    if (resource.type !== "vps" || !resource.permissions.read) throw new Error("Remote read permission is not granted");
    if (!underRemoteScope(args.path, resource.scope)) throw new Error("Remote path is outside the approved scope");
    const sftp = require("./sftp");
    const activeId = sftp.resolveActiveConnectionId(resource.id);
    if (!activeId) throw new Error("Not connected via SSH");
    const result = await sftp.readRemoteFile(activeId, String(args.path));
    if (!result?.success && result?.content === undefined) throw new Error(result?.message || "Remote file could not be read");
    return { resourceId: args.resourceId, path: args.path, content: redact(String(result.content || "")).slice(0, 2 * 1024 * 1024) };
  }
  if (name === "shieldpress.inspect_remote") {
    if (resource.type !== "vps" || !resource.permissions.read) throw new Error("Remote read permission is not granted");
    const sftp = require("./sftp");
    const [stats, system] = await Promise.all([
      sftp.getRemoteStats(resource.id),
      sftp.getRemoteSystemInfo(resource.id),
    ]);
    return { resourceId: args.resourceId, stats, system };
  }
  if (name === "shieldpress.read_s3_object") {
    if (resource.type !== "s3" || !resource.permissions.read) throw new Error("S3 read permission is not granted");
    const key = String(args.key || "");
    if (!underRemoteScope(key, resource.scope)) throw new Error("Object key is outside the approved prefix");
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
    if (!/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i.test(query) || /;/.test(query)) throw new Error("Only one read-only SELECT/SHOW/DESCRIBE/EXPLAIN query is allowed");
    const result = await require("./database").execRawSql(query);
    if (!result.success) throw new Error(result.message);
    return { resourceId: args.resourceId, output: redact(String(result.output || "")).slice(0, 2 * 1024 * 1024) };
  }
  if (name === "shieldpress.run_remote_command") {
    if (resource.type !== "vps" || !resource.permissions.execute) throw new Error("Execute command permission is not granted");
    const command = String(args.command || "").trim();
    if (!command || command.length > 2000 || /[\u0000\r]/.test(command)) throw new Error("Invalid command");
    const id = crypto.randomBytes(12).toString("hex");
    const request = { id, resourceId: args.resourceId, operation: "execute", summary: `Run command: ${command}`, command, createdAt: new Date().toISOString(), status: "pending" };
    pendingRequests.set(id, request);
    await savePending();
    await ai.appendAudit({ event: "command-requested", detail: `${resource.name}: ${command}` });
    const remoteRequest = await requestReqnora({ title: `Approval needed: ${resource.name}`, message: `AI requests Execute permission for:\n${command}`, severity: "warning" });
    if (remoteRequest.success) { request.reqnoraId = remoteRequest.data?.id || null; await savePending(); watchReqnora(request); }
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-request", request);
    if ((await policy()).sessionApproval) {
      await ai.appendAudit({ event: "session-auto-approved", detail: `${resource.name}: ${command}` });
      return resolveApproval(id, true);
    }
    return { status: "approval_required", requestId: id, message: "Open AI Access and approve the exact command before execution." };
  }
  if (name === "shieldpress.request_change") {
    const operation = String(args.operation || "");
    if (!ai.CAPABILITIES.includes(operation) || !resource.permissions[operation]) throw new Error(`${operation} permission is not granted`);
    const id = crypto.randomBytes(12).toString("hex");
    const request = { id, resourceId: args.resourceId, operation, summary: String(args.summary || "").slice(0, 500), path: String(args.path || ""), createdAt: new Date().toISOString(), status: "pending" };
    pendingRequests.set(id, request);
    await ai.appendAudit({ event: "change-requested", detail: `${operation} requested for ${resource.name}: ${request.summary}` });
    const remoteRequest = await requestReqnora({ title: `Approval needed: ${resource.name}`, message: `${operation}: ${request.summary}`, severity: "warning" });
    if (remoteRequest.success) { request.reqnoraId = remoteRequest.data?.id || null; await savePending(); watchReqnora(request); }
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-request", request);
    if ((await policy()).sessionApproval) {
      await ai.appendAudit({ event: "session-auto-approved", detail: `${operation} requested for ${resource.name}: ${request.summary}` });
      return resolveApproval(id, true);
    }
    return { status: "approval_required", requestId: id, message: "ShieldPress has sent this request to the AI Access approval panel. No change was made until approved." };
  }
  throw new Error("Unknown tool");
}

async function listPending() { await loadPending(); return { success: true, requests: [...pendingRequests.values()].filter((request) => request.status === "pending") }; }
async function resolveApproval(id, approved) {
  await loadPending();
  const request = pendingRequests.get(String(id));
  if (!request || request.status !== "pending") return { success: false, message: "Approval request not found or already resolved" };
  request.status = approved ? "approved" : "denied";
  request.resolvedAt = new Date().toISOString();
  await savePending();
  if (!approved) {
    await require("./ai-access").appendAudit({ event: "change-denied", detail: `${request.operation} denied for ${request.resourceId}` });
    await notifyReqnora({ title: "ShieldPress request denied", message: `${request.operation} denied for ${request.resourceId}`, severity: "danger" });
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-result", { ...request, result: { success: true, status: "denied", message: "Request denied" } });
    return { success: true, status: "denied" };
  }
  // Only a fixed, non-interactive update command is executable through the
  // approval panel for now. Arbitrary shell commands remain unavailable.
  if (request.operation === "execute") {
    const sftp = require("./sftp");
    const activeId = sftp.resolveActiveConnectionId(String(request.resourceId).replace(/^vps:/, ""));
    if (!activeId) return { success: false, status: "approved", message: "VPS is not connected via SSH" };
    const result = await sftp.execCommand(activeId, request.command);
    await require("./ai-access").appendAudit({ event: result.success ? "command-applied" : "command-failed", detail: `${request.resourceId}: ${request.command}` });
    await notifyReqnora({ title: result.success ? "ShieldPress command completed" : "ShieldPress command failed", message: `${request.resourceId}\n${result.success ? (result.output || "Completed") : (result.message || result.error || "Failed")}`, severity: result.success ? "success" : "danger" });
    global.STATE.mainWindow?.webContents?.send("ai-access-approval-result", { ...request, result });
    return { success: !!result.success, status: result.success ? "applied" : "failed", output: result.output, message: result.message || result.error };
  }
  if (request.operation !== "edit" || !/\b(update|upgrade)\b.*\bshieldpress\b|\bshieldpress\b.*\b(update|upgrade)\b/i.test(request.summary)) {
    await require("./ai-access").appendAudit({ event: "change-approved", detail: `Approved but no fixed executor exists for ${request.operation} on ${request.resourceId}` });
    return { success: true, status: "approved", message: "Approved. This operation does not yet have an executable handler." };
  }
  const sftp = require("./sftp");
  const activeId = sftp.resolveActiveConnectionId(String(request.resourceId).replace(/^vps:/, ""));
  if (!activeId) return { success: false, status: "approved", message: "VPS is not connected via SSH" };
  const result = await sftp.execCommand(activeId, "shieldpress update");
  await require("./ai-access").appendAudit({ event: result.success ? "change-applied" : "change-failed", detail: `shieldpress update on ${request.resourceId}: ${result.success ? "success" : result.message || result.error || "failed"}` });
  await notifyReqnora({ title: result.success ? "ShieldPress change completed" : "ShieldPress change failed", message: `${request.resourceId}\n${result.success ? (result.output || "Completed") : (result.message || result.error || "Failed")}`, severity: result.success ? "success" : "danger" });
  global.STATE.mainWindow?.webContents?.send("ai-access-approval-result", { ...request, result });
  return { success: !!result.success, status: result.success ? "applied" : "failed", output: result.output, message: result.message || result.error };
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
module.exports = { start, stop, getConnectInfo, listPending, resolveApproval };
