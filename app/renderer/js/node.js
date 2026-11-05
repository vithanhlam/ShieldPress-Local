// renderer/js/node.js

window.NodeManager = {
  _timer: null,
  _logId: null,
  _busy: false,

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  async init() {
    await this.refresh();
    this.stop();
    this._timer = setInterval(() => this.refresh(), 4000);
  },

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  },

  async refresh(manual) {
    if (this._busy) return;
    this._busy = true;
    try {
      const [projects, procs] = await Promise.all([
        api.invoke("node-list-projects"),
        api.invoke("node-list-processes"),
      ]);
      // Don't clobber a command input the user is typing in
      if (!document.activeElement || !document.activeElement.classList.contains("node-cmd"))
        this._renderProjects(projects || []);
      this._renderProcesses(procs || []);
      if (this._logId) await this._refreshLogs();
      if (manual) toast("Refreshed", "info", 1500);
    } catch (e) {
      if (manual) toast("Refresh failed: " + (e.message || e), "error");
    } finally { this._busy = false; }
  },

  _renderProjects(list) {
    const el = document.getElementById("node-projects");
    if (!el) return;
    if (!list.length) {
      el.innerHTML = 'No Node.js / Next.js projects yet. Create one in <b>Projects</b> and pick the Node.js type.';
      return;
    }
    el.innerHTML = list.map((p) => {
      const id = this._esc(p.id);
      const status = p.running
        ? `<span class="tag" style="background:rgba(34,197,94,0.12);color:var(--green)">Running · PID ${p.pid}</span>`
        : `<span class="tag" style="background:var(--bg3);color:var(--text3)">Stopped</span>`;
      const btns = p.running
        ? `<button class="btn btn-ghost btn-sm" onclick="NodeManager.restart('${id}')"><i class="fas fa-redo"></i> Restart</button>
           <button class="btn btn-ghost btn-sm" onclick="NodeManager.stopProject('${id}')"><i class="fas fa-stop"></i> Stop</button>`
        : `<button class="btn btn-primary btn-sm" onclick="NodeManager.start('${id}')"><i class="fas fa-play"></i> Start</button>`;
      return `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <b style="color:var(--text1)">${this._esc(p.name)}</b>
          <span class="tag">:${p.nodePort}</span>
          ${status}
          <span style="flex:1"></span>
          ${btns}
          <button class="btn btn-ghost btn-sm" onclick="NodeManager.showLogs('${id}', '${this._esc(p.name).replace(/'/g, "")}')"><i class="fas fa-terminal"></i> Logs</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
          <span style="font-size:11px;color:var(--text3)">Start command</span>
          <input class="node-cmd" id="node-cmd-${id}" value="${this._esc(p.startCommand)}" spellcheck="false"
            style="flex:1;min-width:0;font-family:monospace;font-size:12px"
            onkeydown="if(event.key==='Enter')NodeManager.saveCommand('${id}')">
          <button class="btn btn-ghost btn-sm" onclick="NodeManager.saveCommand('${id}')"><i class="fas fa-save"></i> Save</button>
        </div>
        ${p.hasPackageJson ? "" : '<div style="font-size:11px;color:var(--yellow);margin-top:6px"><i class="fas fa-exclamation-triangle"></i> No package.json in this project folder yet.</div>'}
      </div>`;
    }).join("");
  },

  _renderProcesses(list) {
    const el = document.getElementById("node-processes");
    const count = document.getElementById("node-proc-count");
    if (count) count.textContent = String(list.length);
    if (!el) return;
    if (!list.length) { el.innerHTML = "No Node.js process is listening on a port."; return; }
    const rows = list.map((p) => {
      const owner = p.projectName
        ? `<span class="tag" style="background:rgba(119,74,182,0.18);color:#a78bfa">${this._esc(p.projectName)}</span>`
        : '<span style="color:var(--text3)">orphan</span>';
      const cmd = this._esc(p.cmdline || p.name);
      return `<tr>
        <td style="padding:6px 12px 6px 0"><b style="color:var(--text1)">:${p.port}</b></td>
        <td style="padding:6px 12px 6px 0">${p.pid}</td>
        <td style="padding:6px 12px 6px 0">${owner}${p.managed ? ' <span class="tag">by app</span>' : ""}</td>
        <td style="padding:6px 12px 6px 0;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px" title="${this._esc((p.cmdline || "") + (p.cwd ? "\n" + p.cwd : ""))}">${cmd}</td>
        <td style="padding:6px 0;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="NodeManager.kill(${p.pid}, ${p.port}, ${p.managed ? "true" : "false"})"><i class="fas fa-stop"></i> Stop</button>
        </td>
      </tr>`;
    }).join("");
    el.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="text-align:left;color:var(--text3);font-size:11px">
        <th>Port</th><th>PID</th><th>Project</th><th>Command</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  },

  async _act(label, fn) {
    toast(label + "...", "info", 1500);
    const r = await fn();
    if (r && r.success) toast("Done", "success", 1500);
    else toast((r && r.message) || "Failed", "error", 6000);
    await this.refresh();
    return r;
  },

  start(id) { return this._act("Starting", () => api.invoke("node-start", { id })); },
  stopProject(id) { return this._act("Stopping", () => api.invoke("node-stop", { id })); },
  restart(id) { return this._act("Restarting", () => api.invoke("node-restart", { id })); },

  async saveCommand(id) {
    const input = document.getElementById("node-cmd-" + id);
    if (!input) return;
    const r = await api.invoke("node-set-command", { id, command: input.value });
    toast(r.success ? "Command saved" : (r.message || "Failed"), r.success ? "success" : "error");
    input.blur();
    await this.refresh();
  },

  async kill(pid, port, managed) {
    if (!managed && !confirm(
      `Stop PID ${pid} listening on :${port}?\n\nThis process was not started by ShieldPress Local — it may be something you're using elsewhere.`
    )) return;
    await this._act("Stopping PID " + pid, () => api.invoke("node-kill", { pid }));
  },

  async showLogs(id, name) {
    this._logId = id;
    document.getElementById("node-log-card").style.display = "";
    document.getElementById("node-log-name").textContent = name;
    await this._refreshLogs();
  },

  closeLogs() {
    this._logId = null;
    document.getElementById("node-log-card").style.display = "none";
  },

  async _refreshLogs() {
    const out = document.getElementById("node-log-out");
    if (!out || !this._logId) return;
    const r = await api.invoke("node-logs", { id: this._logId });
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
    out.textContent = r.lines.length ? r.lines.join("\n") : "No output yet. Logs are only captured for processes started from this page.";
    if (atBottom) out.scrollTop = out.scrollHeight;
  },
};
