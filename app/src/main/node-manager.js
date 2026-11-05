// src/main/node-manager.js
// Node.js process manager: list listening Node ports, stop/restart processes,
// start project dev servers from the app and keep their logs.
const { spawn, execFile } = require("child_process");
const fs = require("fs-extra");
const path = require("path");
const log = require("./logger");
const platform = require("./platform");

const NODE_NAMES = /^(node|nodejs|npm|npx|pnpm|yarn|bun|deno|next-server|next-router-worker|tsx|ts-node|nodemon|vite|esbuild)(\.exe)?$/i;
const LOG_LIMIT = 500;

/** projectId -> { child, pid, cmd, cwd, port, startedAt, logs: [], exited, exitCode } */
const managed = new Map();

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), message: err ? err.message : "" });
    });
  });
}

// ── Listening ports ─────────────────────────────────────────────────────────
async function listeningLinux() {
  const r = await run("ss", ["-H", "-ltnp"]);
  if (!r.ok && !r.stdout) return [];
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = cols[3];
    const port = parseInt(local.slice(local.lastIndexOf(":") + 1), 10);
    const address = local.slice(0, local.lastIndexOf(":"));
    const users = line.match(/users:\(\((.*)\)\)/);
    if (!users || !port) continue;
    for (const m of users[1].matchAll(/"([^"]+)",pid=(\d+)/g)) {
      out.push({ port, address, name: m[1], pid: parseInt(m[2], 10) });
    }
  }
  return out;
}

async function processDetailsLinux(pid) {
  let cmdline = "", cwd = "";
  try { cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean).join(" "); } catch {}
  try { cwd = await fs.readlink(`/proc/${pid}/cwd`); } catch {}
  return { cmdline, cwd };
}

async function listeningWindows() {
  // One process query for all pids (per-connection Get-CimInstance is far too slow to poll).
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$procs=@{}
Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId]=$_ }
Get-NetTCPConnection -State Listen | ForEach-Object {
  $p=$procs[[int]$_.OwningProcess]
  [pscustomobject]@{ port=$_.LocalPort; address=$_.LocalAddress; pid=$_.OwningProcess; name=$p.Name; cmdline=$p.CommandLine }
} | ConvertTo-Json -Compress`;
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 15000);
  if (!r.stdout.trim()) return [];
  try {
    const data = JSON.parse(r.stdout);
    return (Array.isArray(data) ? data : [data]).map((d) => ({
      port: d.port, address: d.address, pid: d.pid, name: d.name || "", cmdline: d.cmdline || "", cwd: "",
    }));
  } catch { return []; }
}

function projectPidSet() {
  const pids = new Set();
  for (const m of managed.values()) if (!m.exited && m.pid) pids.add(m.pid);
  return pids;
}

async function readProjects() {
  const { PROJECTS_DIR } = global.CONST;
  const list = [];
  if (!(await fs.pathExists(PROJECTS_DIR))) return list;
  for (const id of await fs.readdir(PROJECTS_DIR)) {
    try {
      const proj = await fs.readJson(path.join(PROJECTS_DIR, id, "project.json"));
      list.push({ ...proj, id: proj.id || id });
    } catch {}
  }
  return list;
}

/** Descendant pids of a managed root pid (Linux) so a port opened by a child counts as managed. */
async function descendantsLinux(rootPid) {
  const r = await run("ps", ["-e", "-o", "pid=,ppid="]);
  const children = new Map();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const all = new Set([rootPid]);
  const stack = [rootPid];
  while (stack.length) for (const c of children.get(stack.pop()) || []) if (!all.has(c)) { all.add(c); stack.push(c); }
  return all;
}

async function listProcesses() {
  const raw = platform.isWindows ? await listeningWindows() : await listeningLinux();
  const projects = await readProjects();
  const managedPids = new Map(); // pid -> projectId
  for (const [id, m] of managed) {
    if (m.exited || !m.pid) continue;
    if (platform.isWindows) managedPids.set(m.pid, id);
    else for (const p of await descendantsLinux(m.pid)) managedPids.set(p, id);
  }

  const seen = new Map();
  for (const row of raw) {
    const key = `${row.pid}:${row.port}`;
    if (seen.has(key)) continue;
    let { cmdline = "", cwd = "" } = row;
    if (!platform.isWindows) ({ cmdline, cwd } = await processDetailsLinux(row.pid));
    const isNode = NODE_NAMES.test(row.name) || /\b(node|nodejs|bun|deno)\b/.test(cmdline.split(" ")[0] || "");
    if (!isNode && !managedPids.has(row.pid)) continue;

    let projectId = managedPids.get(row.pid) || null;
    if (!projectId) {
      const byPort = projects.find((p) => (p.projectType === "node" || p.projectType === "nextjs") && Number(p.nodePort) === row.port);
      const byCwd = cwd && projects.find((p) => cwd.startsWith(path.join(global.CONST.PROJECTS_DIR, p.id)));
      projectId = (byCwd || byPort || {}).id || null;
    }
    const proj = projects.find((p) => p.id === projectId);
    seen.set(key, {
      pid: row.pid, port: row.port, address: row.address, name: row.name,
      cmdline, cwd,
      projectId, projectName: proj ? proj.name : null,
      managed: managedPids.has(row.pid),
    });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

// ── Kill helpers ────────────────────────────────────────────────────────────
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function killTree(pid, { force = false } = {}) {
  if (platform.isWindows) {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], 10000);
    return;
  }
  const sig = force ? "SIGKILL" : "SIGTERM";
  // Managed processes run in their own process group (detached) — kill the whole group.
  try { process.kill(-pid, sig); return; } catch {}
  try { process.kill(pid, sig); } catch {}
}

async function stopPid(pid) {
  await killTree(pid);
  for (let i = 0; i < 30; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  await killTree(pid, { force: true });
  await new Promise((r) => setTimeout(r, 300));
  return !alive(pid);
}

/** Only pids that are currently a Node-like listener (or one we started) may be killed. */
async function killProcess({ pid }) {
  pid = parseInt(pid, 10);
  if (!pid || pid === process.pid) return { success: false, message: "Invalid PID" };
  const procs = await listProcesses();
  const target = procs.find((p) => p.pid === pid);
  if (!target) return { success: false, message: "Process is no longer a listening Node process" };
  try {
    const ok = await stopPid(pid);
    for (const [id, m] of managed) if (m.pid === pid) { m.exited = true; managed.delete(id); }
    log.ok(`Node process stopped: PID ${pid} (:${target.port})`);
    return ok ? { success: true } : { success: false, message: "Process did not exit" };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ── Project dev servers ─────────────────────────────────────────────────────
async function loadProject(id) {
  const cfgPath = path.join(global.CONST.PROJECTS_DIR, id, "project.json");
  if (!(await fs.pathExists(cfgPath))) return null;
  return { cfgPath, proj: await fs.readJson(cfgPath), www: path.join(global.CONST.PROJECTS_DIR, id, "www") };
}

async function detectCommand(www) {
  try {
    const pkg = await fs.readJson(path.join(www, "package.json"));
    const s = pkg.scripts || {};
    for (const name of ["dev", "start", "serve"]) if (s[name]) return name === "start" ? "npm start" : `npm run ${name}`;
  } catch {}
  return "npm run dev";
}

async function listNodeProjects() {
  const projects = await readProjects();
  const out = [];
  for (const p of projects) {
    if (p.projectType !== "node" && p.projectType !== "nextjs") continue;
    const www = path.join(global.CONST.PROJECTS_DIR, p.id, "www");
    const m = managed.get(p.id);
    out.push({
      id: p.id, name: p.name, domain: p.domain, port: p.port, nodePort: p.nodePort || 3000,
      startCommand: p.startCommand || (await detectCommand(www)),
      customCommand: !!p.startCommand,
      hasPackageJson: await fs.pathExists(path.join(www, "package.json")),
      running: !!(m && !m.exited), pid: m && !m.exited ? m.pid : null,
      startedAt: m && !m.exited ? m.startedAt : null,
    });
  }
  return out;
}

async function setCommand({ id, command, nodePort }) {
  const p = await loadProject(id);
  if (!p) return { success: false, message: "Project not found" };
  if (command !== undefined) {
    const c = String(command || "").trim();
    if (c) p.proj.startCommand = c; else delete p.proj.startCommand;
  }
  await fs.writeJson(p.cfgPath, p.proj, { spaces: 2 });
  return { success: true };
}

function pushLog(entry, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    entry.logs.push(line);
  }
  if (entry.logs.length > LOG_LIMIT) entry.logs.splice(0, entry.logs.length - LOG_LIMIT);
}

async function isPortBusy(port) {
  const svc = require("./services");
  return svc.isPortOpen(port);
}

async function startProjectProcess({ id }) {
  const existing = managed.get(id);
  if (existing && !existing.exited) return { success: false, message: "Already running (PID " + existing.pid + ")" };
  const p = await loadProject(id);
  if (!p) return { success: false, message: "Project not found" };
  if (!(await fs.pathExists(p.www))) return { success: false, message: "Project folder not found" };

  const port = parseInt(p.proj.nodePort, 10) || 3000;
  const cmd = (p.proj.startCommand || (await detectCommand(p.www))).trim();
  if (!(await fs.pathExists(path.join(p.www, "package.json"))) && /^(npm|pnpm|yarn|bun)\b/.test(cmd))
    return { success: false, message: "No package.json in project folder. Install/setup the app first." };
  if (await isPortBusy(port))
    return { success: false, message: `Port ${port} is already in use. Stop the process using it or change the project's Node port.` };

  const env = { ...platform.envWithDeveloperPath(process.env), PORT: String(port), FORCE_COLOR: "0" };
  const child = spawn(cmd, {
    cwd: p.www, env, shell: true, detached: !platform.isWindows,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const entry = { child, pid: child.pid, cmd, cwd: p.www, port, startedAt: Date.now(), logs: [], exited: false, exitCode: null };
  managed.set(id, entry);
  pushLog(entry, `$ ${cmd}   (PORT=${port}, cwd=${p.www})`);
  child.stdout.on("data", (d) => pushLog(entry, d));
  child.stderr.on("data", (d) => pushLog(entry, d));
  child.on("error", (e) => { pushLog(entry, "spawn error: " + e.message); entry.exited = true; });
  child.on("close", (code, signal) => {
    entry.exited = true; entry.exitCode = code;
    pushLog(entry, `process exited (${signal || "code " + code})`);
  });
  log.ok(`Node process started for ${p.proj.name}: PID ${child.pid}, ${cmd}`);

  // Give it a moment: report immediate crashes instead of pretending success
  await new Promise((r) => setTimeout(r, 1200));
  if (entry.exited) return { success: false, message: "Process exited immediately: " + (entry.logs.slice(-3).join(" | ") || "no output") };
  return { success: true, pid: child.pid, port };
}

async function stopProjectProcess({ id }) {
  const m = managed.get(id);
  if (!m || m.exited) { managed.delete(id); return { success: true, message: "Not running" }; }
  const ok = await stopPid(m.pid);
  m.exited = true;
  return ok ? { success: true } : { success: false, message: "Process did not exit" };
}

async function restartProjectProcess({ id }) {
  await stopProjectProcess({ id });
  // wait for the port to be released
  const p = await loadProject(id);
  const port = p ? parseInt(p.proj.nodePort, 10) || 3000 : 0;
  for (let i = 0; port && i < 20 && (await isPortBusy(port)); i++) await new Promise((r) => setTimeout(r, 250));
  return startProjectProcess({ id });
}

/** Restart an unmanaged process is not possible (unknown env); only managed ones. */
function getLogs({ id }) {
  const m = managed.get(id);
  return { success: true, running: !!(m && !m.exited), lines: m ? m.logs.slice(-LOG_LIMIT) : [] };
}

async function checkPort({ port, excludeProjectId }) {
  port = parseInt(port, 10);
  if (!port) return { busy: false };
  if (!(await isPortBusy(port))) return { busy: false };
  const procs = await listProcesses();
  const owner = procs.find((p) => p.port === port);
  const own = owner && owner.projectId && owner.projectId === excludeProjectId;
  return { busy: !own, owner: owner || null };
}

async function stopAllManaged() {
  for (const [id, m] of managed) {
    if (!m.exited) { try { await stopPid(m.pid); } catch {} m.exited = true; }
  }
  managed.clear();
}

module.exports = {
  listProcesses, killProcess, listNodeProjects, setCommand,
  startProjectProcess, stopProjectProcess, restartProjectProcess,
  getLogs, checkPort, stopAllManaged,
};
