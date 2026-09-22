#!/usr/bin/env node
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");

function tokenCandidates() {
  if (process.env.SHIELDPRESS_DATA_DIR) return [path.join(process.env.SHIELDPRESS_DATA_DIR, "ai-access-gateway.json")];
  const candidates = [path.join(os.homedir(), "ShieldPress_Project", "data", "ai-access-gateway.json")];
  const preference = path.join(os.homedir(), ".config", "ShieldPress Local", "workspace_path.txt");
  try { candidates.unshift(path.join(fs.readFileSync(preference, "utf8").trim(), "data", "ai-access-gateway.json")); } catch {}
  return candidates;
}
function send(message) {
  let config;
  try {
    const tokenPath = tokenCandidates().find((file) => fs.existsSync(file));
    if (!tokenPath) throw new Error("missing token");
    config = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  } catch { return Promise.reject(new Error("ShieldPress is not running or AI Access is unavailable")); }
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: config.port, path: "/mcp", method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" } }, (response) => {
      let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    request.on("error", reject); request.end(JSON.stringify(message));
  });
}
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    send(message).then((result) => process.stdout.write(JSON.stringify(result) + "\n"), (error) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32000, message: error.message } }) + "\n"));
  }
});
