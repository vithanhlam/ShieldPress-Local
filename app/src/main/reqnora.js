const fs = require("fs-extra");
const path = require("path");

function configFile() { return path.join(global.CONST.DATA_DIR, "reqnora.json"); }

async function readConfig() {
  try { return await fs.readJson(configFile()); } catch { return {}; }
}

async function getApiKey() {
  const config = await readConfig();
  if (!config.apiKey) return "";
  try { return require("./sftp").openCredential(config.apiKey); } catch { return ""; }
}

async function getWebhookSecret() {
  const config = await readConfig();
  if (!config.webhookSecret) return "";
  try { return require("./sftp").openCredential(config.webhookSecret); } catch { return ""; }
}

async function sendRequest({ title, message, severity = "warning", actions = [{ id: "approve", label: "Approve", style: "primary" }, { id: "reject", label: "Reject", style: "danger" }] }) {
  const key = await getApiKey();
  if (!key) return { success: false, skipped: true, message: "Reqnora API key is not configured or vault is locked" };
  const config = await readConfig();
  const base = String(config.apiUrl || "https://app.reqnora.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/v1/requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `shieldpress-${Date.now()}-${Math.random().toString(16).slice(2)}` },
    body: JSON.stringify({ title: String(title || "ShieldPress approval").slice(0, 200), message: String(message || "").slice(0, 2000), severity, allow_reply: true, actions, expires_in: 900 }),
  });
  if (!response.ok) throw new Error(`Reqnora HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { success: true, data: await response.json().catch(() => ({})) };
}

async function getRequest(id) {
  const key = await getApiKey();
  if (!key || !id) return { success: false, skipped: true };
  const config = await readConfig();
  const base = String(config.apiUrl || "https://app.reqnora.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/v1/requests/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`Reqnora HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { success: true, data: await response.json().catch(() => ({})) };
}

async function sendNotification({ title, message, severity = "info" }) {
  const key = await getApiKey();
  if (!key) return { success: false, skipped: true, message: "Reqnora API key is not configured or vault is locked" };
  const config = await readConfig();
  const base = String(config.apiUrl || "https://app.reqnora.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/api/v1/notifications`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: String(title || "ShieldPress notification").slice(0, 200), message: String(message || "").slice(0, 2000), severity: ["info", "success", "warning", "danger"].includes(severity) ? severity : "info" }),
  });
  if (!response.ok) throw new Error(`Reqnora HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return { success: true, data: await response.json().catch(() => ({})) };
}

module.exports = { sendNotification, sendRequest, getRequest, getWebhookSecret };
