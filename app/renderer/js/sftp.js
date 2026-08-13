// renderer/js/sftp.js

window.SFTP = {
  _connections: [],
  _connStatus: {}, // { connId: "connected" | "disconnected" }
  _currentPath: "/",
  _listening: false,

  async init() {
    if (!this._listening) {
      api.onSftpProgress((msg) => {
        const syncOut = document.getElementById("sftp-sync-output");
        if (syncOut && document.getElementById("m-sftp-sync")?.classList.contains("open")) {
          syncOut.textContent += msg + "\n";
          syncOut.scrollTop = syncOut.scrollHeight;
        }
      });
      api.onSftpExternalSave((data) => {
        toast(`${data.file} saved to server!`, "success");
      });
      this._listening = true;
    }
    await this.load();
  },

  async load() {
    const r = await api.sftpGetConnections();
    this._connections = r.connections || [];
    this.filter();
  },

  filter() {
    const q = (document.getElementById("sftp-search-box")?.value || "").toLowerCase().trim();
    const type = document.getElementById("sftp-filter-type")?.value || "";
    const filtered = this._connections.filter((c) => {
      const matchQ = !q ||
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        (c.username || "").toLowerCase().includes(q);
      const matchType = !type || c.type === type;
      return matchQ && matchType;
    });
    this._render(filtered);
  },

  _render(list) {
    // If no list supplied, re-apply current filter so search is preserved
    if (!list) { this.filter(); return; }
    const el = document.getElementById("sftp-conn-list");
    if (!el) return;

    if (!this._connections.length) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-server"></i><p>No connections yet. Click "New Connection" to add one.</p></div>`;
      return;
    }

    if (!list.length) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No connections match your search.</p></div>`;
      return;
    }

    el.innerHTML = list.map((c) => {
      const isConn = this._connStatus[c.id] === "connected";
      const statusColor = isConn ? "var(--green)" : "var(--text3)";
      const statusText = isConn ? "Connected" : "Disconnected";
      const statusIcon = isConn ? "fa-circle" : "fa-circle";
      const protocolIcon = c.type === "ftp" ? "fa-exchange-alt" : "fa-lock";
      const protocolColor = c.type === "ftp" ? "var(--yellow)" : "var(--accent)";

      return `
<div class="proj-card ${isConn ? "running" : ""}" data-conn-id="${c.id}" style="margin-bottom:8px">
  <div class="proj-card-top">
    <div class="proj-icon" style="background:${isConn ? "rgba(34,197,94,0.12)" : "var(--bg3)"}">
      <i class="fas ${protocolIcon}" style="color:${isConn ? "var(--green)" : protocolColor}"></i>
    </div>
    <div class="proj-meta">
      <div class="proj-name">${this._esc(c.name)}</div>
      <div class="proj-domain" style="font-size:13px">${this._esc(c.username)}@${this._esc(c.host)}:${c.port}</div>
      <div class="proj-tags">
        <span class="tag" style="background:${c.type === "sftp" ? "rgba(61,138,255,0.15)" : "rgba(245,158,11,0.15)"};color:${c.type === "sftp" ? "var(--accent)" : "var(--yellow)"};border-color:transparent">${c.type.toUpperCase()}</span>
        ${c.projectId ? `<span class="tag" style="background:rgba(119,74,182,0.18);color:#a78bfa;border-color:transparent"><i class="fas fa-link" style="font-size:10px"></i> Linked</span>` : ""}
        ${c.hasKey ? `<span class="tag" style="background:rgba(34,197,94,0.12);color:var(--green);border-color:transparent"><i class="fas fa-key" style="font-size:10px"></i> Key Auth</span>` : ""}
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
      <i class="fas ${statusIcon}" style="font-size:8px;color:${statusColor}"></i>
      <span style="font-size:13px;font-weight:600;color:${statusColor}">${statusText}</span>
    </div>
  </div>
  <div class="proj-card-actions">
    ${isConn
      ? `<button class="btn btn-sm btn-danger" onclick="SFTP.disconnect('${c.id}')"><i class="fas fa-unlink"></i> Disconnect</button>`
      : `<button class="btn btn-sm btn-success" onclick="SFTP.connect('${c.id}')"><i class="fas fa-plug"></i> Connect</button>`
    }
    <button class="btn btn-sm btn-ghost" title="Browse Files" onclick="SFTP.openBrowser('${c.id}')"><i class="fas fa-folder-open"></i></button>
    ${c.type === "sftp" ? `<button class="btn btn-sm btn-ghost" title="Terminal" onclick="SFTP.openTerminal('${c.id}')"><i class="fas fa-terminal"></i></button>` : ""}
    <button class="btn btn-sm btn-ghost" data-sync-connection="${c.id}" title="Sync Upload" onclick="SFTP.openSyncConfig('${c.id}', 'upload')"><i class="fas fa-cloud-upload-alt"></i></button>
    <button class="btn btn-sm btn-ghost" data-sync-connection="${c.id}" title="Sync Download" onclick="SFTP.openSyncConfig('${c.id}', 'download')"><i class="fas fa-cloud-download-alt"></i></button>
    <button class="btn btn-sm btn-ghost btn-edit" title="Edit" onclick="SFTP.openEdit('${c.id}')"><i class="fas fa-cog"></i></button>
    <button class="btn btn-sm btn-danger-ghost" title="Delete" onclick="SFTP.del('${c.id}')"><i class="fas fa-trash"></i></button>
  </div>
</div>`;
    }).join("");
  },

  _esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  },

  // ── Add/Edit ──────────────────────────────────────────────────────────────
  async openAdd() {
    document.getElementById("sftp-modal-title").textContent = "New Connection";
    document.getElementById("sftp-edit-id").value = "";
    document.getElementById("sftp-name").value = "";
    document.getElementById("sftp-type").value = "sftp";
    document.getElementById("sftp-host").value = "";
    document.getElementById("sftp-port").value = "22";
    document.getElementById("sftp-user").value = "";
    document.getElementById("sftp-pass").value = "";
    document.getElementById("sftp-key").value = "";
    document.getElementById("sftp-remote-path").value = "/";
    document.getElementById("sftp-excludes").value = [
      "node_modules", ".git", "vendor", ".DS_Store", "Thumbs.db",
      ".env", ".env.local", ".env.production",
      "bootstrap/cache", "storage/logs", "storage/framework/cache",
      "storage/framework/sessions", "storage/framework/views",
      ".next", "dist", "build", "__pycache__",
      "wp-content/cache", "wp-content/upgrade",
    ].join("\n");
    await this._populateProjects("");
    openModal("m-sftp-edit");
  },

  async openEdit(id) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;
    document.getElementById("sftp-modal-title").textContent = "Edit Connection";
    document.getElementById("sftp-edit-id").value = conn.id;
    document.getElementById("sftp-name").value = conn.name;
    document.getElementById("sftp-type").value = conn.type;
    document.getElementById("sftp-host").value = conn.host;
    document.getElementById("sftp-port").value = conn.port;
    document.getElementById("sftp-user").value = conn.username;
    document.getElementById("sftp-pass").value = "";
    document.getElementById("sftp-key").value = conn.privateKey || "";
    document.getElementById("sftp-remote-path").value = conn.remotePath || "/";
    document.getElementById("sftp-excludes").value = (conn.excludePaths || []).join("\n");
    await this._populateProjects(conn.projectId || "");
    openModal("m-sftp-edit");
  },

  async _populateProjects(selectedId) {
    const sel = document.getElementById("sftp-project");
    if (!sel) return;
    sel.innerHTML = '<option value="">-- None --</option>';
    try {
      const projects = await api.getProjects();
      for (const p of projects) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        if (p.id === selectedId) opt.selected = true;
        sel.appendChild(opt);
      }
    } catch {}
  },

  async browseKey() {
    const p = await api.openFileDialog({ properties: ["openFile"] });
    if (p) document.getElementById("sftp-key").value = p;
  },

  async save() {
    const name = document.getElementById("sftp-name").value.trim();
    const host = document.getElementById("sftp-host").value.trim();
    const username = document.getElementById("sftp-user").value.trim();
    if (!name || !host || !username) {
      toast("Name, Host and Username are required", "warn");
      return;
    }

    const data = {
      id: document.getElementById("sftp-edit-id").value || undefined,
      name,
      type: document.getElementById("sftp-type").value,
      host,
      port: document.getElementById("sftp-port").value,
      username,
      password: document.getElementById("sftp-pass").value || undefined,
      privateKey: document.getElementById("sftp-key").value.trim(),
      remotePath: document.getElementById("sftp-remote-path").value.trim() || "/",
      projectId: document.getElementById("sftp-project").value,
      excludePaths: document.getElementById("sftp-excludes").value
        .split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    };

    const r = await api.sftpSaveConnection(data);
    if (r.success) {
      toast("Connection saved", "success");
      closeModal("m-sftp-edit");
      await this.load();
    } else {
      toast("Save failed: " + r.message, "error");
    }
  },

  async del(id) {
    if (!confirm("Delete this connection?")) return;
    await api.sftpDisconnect(id);
    this._connStatus[id] = "disconnected";
    const r = await api.sftpDeleteConnection(id);
    if (r.success) {
      toast("Connection deleted", "success");
      await this.load();
    }
  },

  // ── Connect/Disconnect ────────────────────────────────────────────────────
  async connect(id) {
    const btn = document.querySelector(`[data-conn-id="${id}"] .btn-success`);
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...'; }

    const r = await api.sftpConnect(id);

    if (r.success) {
      this._connStatus[id] = "connected";
      toast("Connected!", "success");
    } else {
      this._connStatus[id] = "disconnected";
      toast("Connection failed: " + r.message, "error");
    }
    this._render();
  },

  async disconnect(id) {
    await api.sftpDisconnect(id);
    this._connStatus[id] = "disconnected";
    toast("Disconnected", "info");
    this._render();
  },

  // ── File Browser ──────────────────────────────────────────────────────────
  _dropSetup: false,

  async openBrowser(id) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;

    const cr = await api.sftpConnect(id);
    if (!cr.success) {
      toast("Connect failed: " + cr.message, "error");
      return;
    }
    this._connStatus[id] = "connected";
    this._render();

    document.getElementById("sftp-browser-conn-id").value = id;
    document.getElementById("sftp-browser-title").textContent = `${conn.name} — Remote Files`;
    // Restore last browsed path, fallback to remotePath
    this._currentPath = conn.lastBrowsedPath || conn.remotePath || "/";
    openModal("m-sftp-browser");
    this._setupDragDrop();
    await this._loadDir();
  },

  _setupDragDrop() {
    if (this._dropSetup) return;
    const zone = document.getElementById("sftp-file-list");
    if (!zone) return;
    this._dropSetup = true;

    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.style.outline = "2px dashed var(--accent)";
      zone.style.outlineOffset = "-4px";
      zone.style.background = "rgba(61,138,255,0.05)";
    });

    zone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      zone.style.outline = "";
      zone.style.outlineOffset = "";
      zone.style.background = "";
    });

    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.style.outline = "";
      zone.style.outlineOffset = "";
      zone.style.background = "";

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const id = document.getElementById("sftp-browser-conn-id").value;
      let uploaded = 0;
      for (const file of files) {
        const localPath = file.path;
        const fileName = file.name;
        const remotePath = this._currentPath.replace(/\/+$/, "") + "/" + fileName;

        // Check if exists → ask overwrite
        const exists = await api.sftpCheckExists(id, remotePath);
        if (exists.exists) {
          const overwrite = confirm(`"${fileName}" already exists on server (${this._fmtSize(exists.size)}).\n\nOverwrite?`);
          if (!overwrite) continue;
        }

        toast("Uploading " + fileName + "...", "info");
        const r = await api.sftpUpload(id, localPath, remotePath);
        if (r.success) uploaded++;
        else toast("Upload failed: " + fileName + " — " + r.message, "error");
      }
      if (uploaded > 0) {
        toast(`Uploaded ${uploaded} file(s)`, "success");
        this._loadDir();
      }
    });
  },

  async _loadDir() {
    const id = document.getElementById("sftp-browser-conn-id").value;
    const pathEl = document.getElementById("sftp-current-path");
    const listEl = document.getElementById("sftp-file-list");
    pathEl.value = this._currentPath;
    listEl.innerHTML = '<div style="padding:16px;text-align:center"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    const r = await api.sftpList(id, this._currentPath);
    if (!r.success) {
      listEl.innerHTML = `<div style="padding:16px;color:var(--red)"><i class="fas fa-exclamation-triangle"></i> ${this._esc(r.message)}</div>`;
      return;
    }

    if (!r.items.length) {
      listEl.innerHTML = '<div style="padding:16px;color:var(--text3);text-align:center"><i class="fas fa-folder-open"></i> Empty directory</div>';
      return;
    }

    const curPath = this._currentPath;
    listEl.innerHTML = `<table style="width:100%;font-size:13px;border-collapse:collapse">
<thead><tr style="background:var(--bg3);text-align:left">
  <th style="padding:8px 10px">Name</th>
  <th style="padding:8px 10px;width:80px">Size</th>
  <th style="padding:8px 10px;width:140px">Modified</th>
  <th style="padding:8px 10px;width:120px;text-align:right">Actions</th>
</tr></thead>
<tbody>${r.items.map((item) => {
  const fullPath = curPath.replace(/\/+$/, "") + "/" + item.name;
  const isEditable = item.type === "file" && /\.(php|html|css|js|json|txt|xml|yml|yaml|conf|ini|env|htaccess|md|sh|py|rb|sql|log|csv|twig)$/i.test(item.name);
  return `
<tr style="border-top:1px solid var(--border)">
  <td style="padding:8px 10px;cursor:${item.type === "directory" ? "pointer" : "default"}"
      ${item.type === "directory" ? `onclick="SFTP.enterDir('${this._esc(item.name)}')"` : ""}>
    <i class="fas ${item.type === "directory" ? "fa-folder" : "fa-file"}" style="color:${item.type === "directory" ? "var(--yellow)" : "var(--text3)"};margin-right:8px"></i>
    ${this._esc(item.name)}
  </td>
  <td style="padding:8px 10px;color:var(--text3)">${item.type === "file" ? this._fmtSize(item.size) : ""}</td>
  <td style="padding:8px 10px;color:var(--text3);font-size:12px">${item.modified ? new Date(item.modified).toLocaleString("vi-VN") : ""}</td>
  <td style="padding:8px 10px;text-align:right;white-space:nowrap">
    ${item.type === "file" ? `<button class="btn btn-ghost btn-xs" title="Download" onclick="SFTP.downloadItem('${this._esc(fullPath)}')"><i class="fas fa-download"></i></button>` : ""}
    ${isEditable ? `<button class="btn btn-ghost btn-xs" title="Edit inline" onclick="SFTP.editFile('${this._esc(fullPath)}')"><i class="fas fa-edit"></i></button>` : ""}
    ${isEditable ? `<button class="btn btn-ghost btn-xs" title="Open in Editor (VS Code, Notepad++...)" onclick="SFTP.openExternal('${this._esc(fullPath)}')"><i class="fas fa-external-link-alt"></i></button>` : ""}
    <button class="btn btn-ghost btn-xs" title="Delete" style="color:var(--red)" onclick="SFTP.deleteItem('${this._esc(fullPath)}', ${item.type === 'directory'})"><i class="fas fa-trash"></i></button>
  </td>
</tr>`;
}).join("")}</tbody></table>`;
  },

  enterDir(name) {
    this._currentPath = this._currentPath.replace(/\/+$/, "") + "/" + name;
    this._saveCurrentPath();
    this._loadDir();
  },

  browseUp() {
    const parts = this._currentPath.split("/").filter(Boolean);
    parts.pop();
    this._currentPath = "/" + parts.join("/");
    this._saveCurrentPath();
    this._loadDir();
  },

  _saveCurrentPath() {
    const id = document.getElementById("sftp-browser-conn-id")?.value;
    if (id) api.sftpSaveLastPath(id, this._currentPath);
  },

  refreshBrowser() { this._loadDir(); },

  _fmtSize(bytes) {
    if (!bytes) return "0 B";
    if (bytes > 1073741824) return (bytes / 1073741824).toFixed(1) + " GB";
    if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + " MB";
    if (bytes > 1024) return (bytes / 1024).toFixed(1) + " KB";
    return bytes + " B";
  },

  async downloadItem(remotePath) {
    const localPath = await api.openFileDialog({ properties: ["openDirectory"] });
    if (!localPath) return;
    const fileName = remotePath.split("/").pop();
    const dest = localPath + "\\" + fileName;
    const id = document.getElementById("sftp-browser-conn-id").value;
    toast("Downloading " + fileName + "...", "info");
    const r = await api.sftpDownload(id, remotePath, dest);
    if (r.success) toast("Downloaded: " + fileName, "success");
    else toast("Download failed: " + r.message, "error");
  },

  async uploadFromDialog() {
    const localFile = await api.openFileDialog({ properties: ["openFile", "multiSelections"] });
    if (!localFile) return;
    // openFileDialog with multiSelections may return string or be single
    const files = Array.isArray(localFile) ? localFile : [localFile];
    const id = document.getElementById("sftp-browser-conn-id").value;
    let uploaded = 0;

    for (const filePath of files) {
      const fileName = filePath.split(/[/\\]/).pop();
      const remotePath = this._currentPath.replace(/\/+$/, "") + "/" + fileName;

      // Check overwrite
      const exists = await api.sftpCheckExists(id, remotePath);
      if (exists.exists) {
        const overwrite = confirm(`"${fileName}" already exists on server (${this._fmtSize(exists.size)}).\n\nOverwrite?`);
        if (!overwrite) continue;
      }

      toast("Uploading " + fileName + "...", "info");
      const r = await api.sftpUpload(id, filePath, remotePath);
      if (r.success) uploaded++;
      else toast("Upload failed: " + r.message, "error");
    }
    if (uploaded > 0) {
      toast(`Uploaded ${uploaded} file(s)`, "success");
      this._loadDir();
    }
  },

  async uploadZipDialog() {
    const localFile = await api.openFileDialog({
      properties: ["openFile"],
      filters: [{ name: "ZIP Archives", extensions: ["zip"] }],
    });
    if (!localFile) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    toast("Uploading & extracting ZIP...", "info");
    const r = await api.sftpUploadExtract(id, localFile, this._currentPath);
    if (r.success) {
      toast(r.extracted ? "ZIP uploaded & extracted!" : "ZIP uploaded (extract manually on server)", r.extracted ? "success" : "info");
      this._loadDir();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async createDirPrompt() {
    const name = prompt("New folder name:");
    if (!name) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    const remotePath = this._currentPath.replace(/\/+$/, "") + "/" + name;
    const r = await api.sftpMkdir(id, remotePath);
    if (r.success) { toast("Folder created", "success"); this._loadDir(); }
    else toast("Failed: " + r.message, "error");
  },

  async deleteItem(remotePath, isDirectory) {
    const name = remotePath.split("/").pop();
    if (!confirm(`Delete ${isDirectory ? "folder" : "file"} "${name}"?`)) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    const r = await api.sftpDelete(id, remotePath, isDirectory);
    if (r.success) { toast("Deleted: " + name, "success"); this._loadDir(); }
    else toast("Delete failed: " + r.message, "error");
  },

  // ── File Editor ───────────────────────────────────────────────────────────
  async editFile(remotePath) {
    const id = document.getElementById("sftp-browser-conn-id").value;
    const fileName = remotePath.split("/").pop();
    toast("Loading " + fileName + "...", "info");
    const r = await api.sftpReadFile(id, remotePath);
    if (!r.success) { toast("Cannot read file: " + r.message, "error"); return; }

    document.getElementById("sftp-editor-conn-id").value = id;
    document.getElementById("sftp-editor-path").value = remotePath;
    document.getElementById("sftp-editor-file").textContent = fileName;
    document.getElementById("sftp-editor-content").value = r.content;
    openModal("m-sftp-editor");
  },

  async openExternal(remotePath) {
    const id = document.getElementById("sftp-browser-conn-id").value;
    const fileName = remotePath.split("/").pop();
    toast(`Opening ${fileName} in external editor...`, "info");
    const r = await api.sftpOpenExternal(id, remotePath);
    if (r.success) {
      toast(r.message, "success");
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async saveFileEdit() {
    const id = document.getElementById("sftp-editor-conn-id").value;
    const remotePath = document.getElementById("sftp-editor-path").value;
    const content = document.getElementById("sftp-editor-content").value;
    const r = await api.sftpWriteFile(id, remotePath, content);
    if (r.success) {
      toast("File saved!", "success");
      closeModal("m-sftp-editor");
    } else {
      toast("Save failed: " + r.message, "error");
    }
  },

  // ── Terminal ──────────────────────────────────────────────────────────────
  _cmdHistory: [],
  _historyIdx: -1,

  async openTerminal(id) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;
    if (conn.type !== "sftp") {
      toast("Terminal only available for SFTP (SSH) connections", "warn");
      return;
    }

    const cr = await api.sftpConnect(id);
    if (!cr.success) { toast("Connect failed: " + cr.message, "error"); return; }
    this._connStatus[id] = "connected";
    this._render();

    document.getElementById("sftp-term-conn-id").value = id;
    document.getElementById("sftp-term-name").textContent = conn.name;
    document.getElementById("sftp-term-output").textContent = "";
    document.getElementById("sftp-term-cmd").value = "";
    document.getElementById("sftp-term-prompt").textContent = `${conn.username}@${conn.host} $`;
    this._cmdHistory = [];
    this._historyIdx = -1;
    openModal("m-sftp-terminal");

    // Focus input after modal opens
    setTimeout(() => document.getElementById("sftp-term-cmd")?.focus(), 100);
  },

  termKeyDown(event) {
    if (event.key === "Enter") {
      this.execCmd();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (this._cmdHistory.length === 0) return;
      if (this._historyIdx < this._cmdHistory.length - 1) this._historyIdx++;
      document.getElementById("sftp-term-cmd").value =
        this._cmdHistory[this._cmdHistory.length - 1 - this._historyIdx] || "";
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this._historyIdx > 0) {
        this._historyIdx--;
        document.getElementById("sftp-term-cmd").value =
          this._cmdHistory[this._cmdHistory.length - 1 - this._historyIdx] || "";
      } else {
        this._historyIdx = -1;
        document.getElementById("sftp-term-cmd").value = "";
      }
    }
  },

  quickCmd(cmd) {
    document.getElementById("sftp-term-cmd").value = cmd;
    this.execCmd();
  },

  execClear() {
    document.getElementById("sftp-term-output").textContent = "";
  },

  async execCmd() {
    const id = document.getElementById("sftp-term-conn-id").value;
    const cmdEl = document.getElementById("sftp-term-cmd");
    const cmd = cmdEl.value.trim();
    if (!cmd) return;

    // Save to history
    if (!this._cmdHistory.length || this._cmdHistory[this._cmdHistory.length - 1] !== cmd) {
      this._cmdHistory.push(cmd);
    }
    this._historyIdx = -1;
    cmdEl.value = "";

    // Handle local clear command
    if (cmd === "clear" || cmd === "cls") {
      this.execClear();
      return;
    }

    const out = document.getElementById("sftp-term-output");
    const prompt = document.getElementById("sftp-term-prompt").textContent;
    out.textContent += prompt + " " + cmd + "\n";

    const r = await api.sftpExec(id, cmd);
    if (r.output) out.textContent += r.output;
    if (r.error && r.error !== r.output) out.textContent += r.error;
    if (!r.success && !r.output && !r.error && r.message) out.textContent += "[ERROR] " + r.message;
    out.textContent += "\n";
    out.scrollTop = out.scrollHeight;

    // Update prompt with cwd
    if (r.cwd) {
      const conn = this._connections.find((c) => c.id === id);
      const user = conn ? conn.username : "";
      const host = conn ? conn.host : "";
      document.getElementById("sftp-term-prompt").textContent = `${user}@${host}:${r.cwd} $`;
    }

    cmdEl.focus();
  },

  // ── Sync with folder picker ───────────────────────────────────────────────
  async openSyncConfig(id, direction) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;

    document.getElementById("sftp-sync-conn-id").value = id;
    document.getElementById("sftp-sync-direction").value = direction;
    document.getElementById("sftp-sync-config-title").textContent =
      direction === "upload" ? `Sync Upload — ${conn.name}` : `Sync Download — ${conn.name}`;
    document.getElementById("sftp-sync-remote").value = conn.remotePath || "/";
    document.getElementById("sftp-sync-excludes").value = (conn.excludePaths || []).join("\n");

    // Default local path from project link
    let defaultLocal = conn.localPath || "";
    if (!defaultLocal && conn.projectId) {
      const projects = await api.getProjects();
      const proj = projects.find((p) => p.id === conn.projectId);
      if (proj) defaultLocal = proj.path.replace(/[\\/]+$/, "") + "/www";
    }
    document.getElementById("sftp-sync-local").value = defaultLocal;

    // Reset changed-only checkbox
    const chkEl = document.getElementById("sftp-sync-changed-only");
    if (chkEl) chkEl.checked = false;

    // Validate the pre-filled local path
    if (defaultLocal) await this._validateSyncLocal(defaultLocal);
    else {
      const infoEl = document.getElementById("sftp-sync-local-info");
      if (infoEl) infoEl.style.display = "none";
    }

    openModal("m-sftp-sync-config");
  },

  async browseSyncLocal() {
    const p = await api.openFileDialog({ properties: ["openDirectory"] });
    if (p) {
      document.getElementById("sftp-sync-local").value = p;
      await this._validateSyncLocal(p);
    }
  },

  async _validateSyncLocal(localPath) {
    const infoEl = document.getElementById("sftp-sync-local-info");
    if (!infoEl) return;
    if (!localPath) { infoEl.style.display = "none"; return; }
    infoEl.style.display = "";
    infoEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking folder...';
    infoEl.style.color = "var(--text3)";

    const r = await api.sftpValidatePath(localPath);
    if (r.valid) {
      infoEl.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> ${r.message}`;
      infoEl.style.color = "var(--green)";
    } else {
      infoEl.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:var(--red)"></i> ${r.message}`;
      infoEl.style.color = "var(--red)";
    }
  },

  async startSync() {
    const id = document.getElementById("sftp-sync-conn-id").value;
    const direction = document.getElementById("sftp-sync-direction").value;
    const localPath = document.getElementById("sftp-sync-local").value.trim();
    const remotePath = document.getElementById("sftp-sync-remote").value.trim() || "/";
    const excludes = document.getElementById("sftp-sync-excludes").value
      .split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    const changedOnly = document.getElementById("sftp-sync-changed-only")?.checked || false;
    const startButton = document.getElementById("sftp-sync-start-btn");

    if (!localPath) { toast("Select a local folder", "warn"); return; }

    // Validate local path before starting (upload direction)
    if (direction === "upload") {
      const validation = await api.sftpValidatePath(localPath);
      if (!validation.valid) {
        toast("Local folder error: " + validation.message, "error");
        return;
      }
    }

    if (startButton) {
      startButton.disabled = true;
      startButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...';
    }
    this._setSyncBusy(id, true);

    closeModal("m-sftp-sync-config");

    try {
      // Update connection with chosen paths
      const conn = this._connections.find((c) => c.id === id);
      if (conn) {
        await api.sftpSaveConnection({
          id: conn.id,
          name: conn.name,
          type: conn.type,
          host: conn.host,
          port: conn.port,
          username: conn.username,
          remotePath,
          localPath,
          excludePaths: excludes,
          projectId: conn.projectId,
        });
      }

      const cr = await api.sftpConnect(id);
      if (!cr.success) throw new Error("Connect failed: " + cr.message);
      this._connStatus[id] = "connected";

      document.getElementById("sftp-sync-title").textContent =
        direction === "upload" ? "Uploading to server..." : "Downloading from server...";
      document.getElementById("sftp-sync-output").textContent = "";
      document.getElementById("sftp-sync-footer").style.display = "none";
      document.getElementById("sftp-sync-icon")?.classList.add("fa-spin");
      openModal("m-sftp-sync");

      const r = direction === "upload"
        ? await api.sftpSyncUpload(id, { changedOnly })
        : await api.sftpSyncDownload(id, { changedOnly });

      document.getElementById("sftp-sync-footer").style.display = "flex";
      if (r.success) {
        const count = direction === "upload" ? r.uploaded : r.downloaded;
        const skipped = r.skipped || 0;
        document.getElementById("sftp-sync-title").textContent = "Sync Complete!";
        toast(`Synced ${count} files${skipped ? `, skipped ${skipped} unchanged` : ""}`, "success");
      } else {
        document.getElementById("sftp-sync-title").textContent = "Sync Failed";
        toast("Sync failed: " + r.message, "error");
      }
    } catch (error) {
      const title = document.getElementById("sftp-sync-title");
      if (title) title.textContent = "Sync Failed";
      toast(error.message || "Sync failed", "error");
    } finally {
      document.getElementById("sftp-sync-icon")?.classList.remove("fa-spin");
      this._setSyncBusy(id, false);
      if (startButton) {
        startButton.disabled = false;
        startButton.innerHTML = '<i class="fas fa-sync-alt"></i> Start Sync';
      }
      this._render();
    }
  },

  _setSyncBusy(id, busy) {
    document.querySelectorAll("[data-sync-connection]").forEach((button) => {
      if (button.dataset.syncConnection !== id) return;
      button.disabled = busy;
      button.style.opacity = busy ? "0.45" : "";
      if (busy) {
        button.dataset.syncOriginalHtml = button.innerHTML;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
      } else if (button.dataset.syncOriginalHtml) {
        button.innerHTML = button.dataset.syncOriginalHtml;
        delete button.dataset.syncOriginalHtml;
      }
    });
  },
};
