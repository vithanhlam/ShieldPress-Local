// renderer/js/sftp.js

window.SFTP = {
  _connections: [],
  _connStatus: {}, // { connId: "connected" | "disconnected" }
  _currentPath: "/",
  _listening: false,
  _vault: { configured: false, unlocked: false },

  async init() {
    // Page HTML is cached by the router. Ensure a previous terminal overlay can
    // never remain visible when the user returns to this page.
    if (!this._activeShellId) closeModal("m-sftp-terminal");
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
      api.onSftpShellData(({ id, data }) => {
        if (id === this._activeShellId) this._xterm?.write(data);
      });
      api.onSftpShellExit(({ id }) => {
        if (id === this._activeShellId) {
          this._xterm?.writeln("\r\n\x1b[33m[SSH session closed]\x1b[0m");
          this._activeShellId = null;
        }
      });
      this._listening = true;
    }
    await this.refreshVaultStatus();
    this._bindTerminalSplitter();
    await this.load();
  },

  async refreshVaultStatus() {
    this._vault = await api.sftpVaultStatus();
    const btn = document.getElementById("sftp-vault-btn");
    if (!btn) return;
    btn.innerHTML = this._vault.unlocked
      ? '<i class="fas fa-lock-open"></i> Vault unlocked'
      : '<i class="fas fa-lock"></i> Vault locked';
    btn.style.color = this._vault.unlocked ? "var(--green)" : "var(--yellow)";
  },

  async openVault() {
    await this.refreshVaultStatus();
    if (this._vault.unlocked) {
      if (confirm("Lock the credential vault and disconnect all remote sessions?")) {
        await api.sftpVaultLock();
        await this.refreshVaultStatus();
        toast("Credential vault locked", "info");
      }
      return;
    }
    const setup = !this._vault.configured;
    document.getElementById("sftp-master-pass").value = "";
    document.getElementById("sftp-master-confirm").value = "";
    document.getElementById("sftp-master-confirm-wrap").style.display = setup ? "block" : "none";
    document.getElementById("sftp-vault-help").textContent = setup
      ? "Create a Master Password (minimum 12 characters). It is never stored and cannot be recovered. Saved server passwords will be encrypted with AES-256-GCM."
      : "Enter your Master Password to decrypt saved server credentials for this app session.";
    document.getElementById("sftp-vault-submit").innerHTML = setup
      ? '<i class="fas fa-shield-alt"></i> Create vault'
      : '<i class="fas fa-unlock"></i> Unlock';
    openModal("m-sftp-vault");
    setTimeout(() => document.getElementById("sftp-master-pass")?.focus(), 50);
  },

  async submitVault() {
    const password = document.getElementById("sftp-master-pass").value;
    if (!this._vault.configured) {
      const confirmation = document.getElementById("sftp-master-confirm").value;
      if (password.length < 12) return toast("Master Password must contain at least 12 characters", "warn");
      if (password !== confirmation) return toast("Master Password confirmation does not match", "warn");
    }
    const result = this._vault.configured
      ? await api.sftpVaultUnlock(password)
      : await api.sftpVaultSetup(password);
    if (!result.success) return toast(result.message, "error");
    document.getElementById("sftp-master-pass").value = "";
    document.getElementById("sftp-master-confirm").value = "";
    closeModal("m-sftp-vault");
    await this.refreshVaultStatus();
    await this.load();
    toast("Credential vault unlocked", "success");
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
    filtered.sort((a, b) => {
      const ta = Date.parse(a.lastConnectedAt || "") || 0;
      const tb = Date.parse(b.lastConnectedAt || "") || 0;
      if (ta !== tb) return tb - ta;
      const sa = a.starred ? 1 : 0;
      const sb = b.starred ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(a.name || "").localeCompare(String(b.name || ""));
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
        ${c.credentialState === "legacy-unavailable" ? `<span class="tag" style="background:rgba(239,68,68,0.12);color:var(--red);border-color:transparent"><i class="fas fa-exclamation-triangle" style="font-size:10px"></i> Re-enter password</span>` : ""}
        ${c.credentialState === "legacy-migratable" ? `<span class="tag" style="background:rgba(245,158,11,0.12);color:var(--yellow);border-color:transparent"><i class="fas fa-shield-alt" style="font-size:10px"></i> Create vault to migrate</span>` : ""}
      </div>
    </div>
    <div class="proj-right">
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <i class="fas ${statusIcon}" style="font-size:8px;color:${statusColor}"></i>
        <span style="font-size:13px;font-weight:600;color:${statusColor}">${statusText}</span>
      </div>
      <button class="proj-star ${c.starred ? "starred" : ""}" onclick="SFTP.toggleStar('${c.id}')" title="${c.starred ? "Unpin from top" : "Pin to top"}">
        <i class="fas fa-star"></i>
      </button>
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

  async toggleStar(id) {
    const r = await api.sftpToggleStar(id);
    if (!r.success) return toast(r.message || "Could not update favorite", "error");
    await this.load();
  },

  _bindTerminalSplitter() {
    const splitter = document.getElementById("sftp-term-splitter");
    const layout = document.querySelector(".sftp-terminal-layout");
    if (!splitter || !layout || splitter.dataset.bound) return;
    splitter.dataset.bound = "1";
    splitter.addEventListener("mousedown", (event) => {
      event.preventDefault();
      splitter.classList.add("is-dragging");
      const startX = event.clientX;
      const startWidth = layout.querySelector("aside")?.getBoundingClientRect().width || 330;
      const onMove = (moveEvent) => {
        const next = Math.max(240, Math.min(560, startWidth + (moveEvent.clientX - startX)));
        layout.style.setProperty("--sftp-files-col", `${next}px`);
      };
      const onUp = () => {
        splitter.classList.remove("is-dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
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
    document.getElementById("sftp-secure").checked = false;
    this.updateProtocolFields();
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
    document.getElementById("sftp-secure").checked = !!conn.secure;
    this.updateProtocolFields();
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

  updateProtocolFields() {
    const isFtp = document.getElementById("sftp-type")?.value === "ftp";
    const row = document.getElementById("sftp-ftps-row");
    if (row) row.style.display = isFtp ? "flex" : "none";
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
      secure: document.getElementById("sftp-secure").checked,
      privateKey: document.getElementById("sftp-key").value.trim(),
      remotePath: document.getElementById("sftp-remote-path").value.trim() || "/",
      projectId: document.getElementById("sftp-project").value,
      excludePaths: document.getElementById("sftp-excludes").value
        .split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    };

    if (data.password && !this._vault.unlocked) {
      toast("Unlock or create the credential vault before saving a password", "warn");
      await this.openVault();
      return;
    }
    const r = await api.sftpSaveConnection(data);
    if (r.success) {
      toast("Connection saved", "success");
      closeModal("m-sftp-edit");
      await this.load();
    } else {
      if (r.code === "VAULT_LOCKED") await this.openVault();
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
      await this.load();
      return;
    } else {
      this._connStatus[id] = "disconnected";
      if (r.code === "VAULT_LOCKED") await this.openVault();
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
    await this.load();

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
  const encodedPath = encodeURIComponent(fullPath);
  const isEditable = item.type === "file" && /\.(php|html|css|js|json|txt|xml|yml|yaml|conf|ini|env|htaccess|md|sh|py|rb|sql|log|csv|twig)$/i.test(item.name);
  return `
<tr style="border-top:1px solid var(--border)" data-remote-path="${encodedPath}" data-remote-name="${encodeURIComponent(item.name)}" data-remote-type="${item.type}" data-remote-editable="${isEditable}">
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
    const dest = localPath.replace(/[\\/]+$/, "") + "/" + fileName;
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

  createDirPrompt() { this.openRemoteCreate("browser", "folder"); },

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
    return this.editFileFor(id, remotePath);
  },

  async editFileFor(id, remotePath) {
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

  getRemoteContext(target) {
    const terminalBrowser = target?.closest?.("[data-terminal-remote-browser]");
    const regularBrowser = target?.closest?.("[data-remote-browser]");
    const inTerminal = !!terminalBrowser && document.getElementById("m-sftp-terminal")?.classList.contains("open");
    const inBrowser = !!regularBrowser && document.getElementById("m-sftp-browser")?.classList.contains("open");
    if (!inTerminal && !inBrowser) return null;
    const row = target.closest("[data-remote-path]");
    const scope = inTerminal ? "terminal" : "browser";
    const currentPath = inTerminal ? this._termPath : this._currentPath;
    if (!row) return { scope, currentPath, item: null };
    return {
      scope,
      currentPath,
      item: {
        path: decodeURIComponent(row.dataset.remotePath),
        name: decodeURIComponent(row.dataset.remoteName),
        type: row.dataset.remoteType,
        editable: row.dataset.remoteEditable === "true",
      },
    };
  },

  contextOpenFolder(encodedPath) {
    this._currentPath = decodeURIComponent(encodedPath);
    this._saveCurrentPath();
    this._loadDir();
  },

  contextDownload(encodedPath) { return this.downloadItem(decodeURIComponent(encodedPath)); },
  contextEdit(encodedPath) { return this.editFile(decodeURIComponent(encodedPath)); },
  contextOpenExternal(encodedPath) { return this.openExternal(decodeURIComponent(encodedPath)); },

  async contextOpenWith(encodedPath) {
    const remotePath = decodeURIComponent(encodedPath);
    const editorPath = await api.openFileDialog({
      properties: ["openFile"],
      title: "Choose an application to edit this file",
    });
    if (!editorPath) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    const result = await api.sftpOpenExternal(id, remotePath, editorPath);
    if (result.success) toast(result.message, "success");
    else toast("Open failed: " + result.message, "error");
  },

  contextNewFile() { this.openRemoteCreate("browser", "file"); },

  contextNewFolder() { return this.createDirPrompt(); },

  _validRemoteName(name) {
    if (!name) return false;
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
      toast("Enter a valid name without path separators", "warn");
      return false;
    }
    return true;
  },

  openRemoteCreate(scope, kind) {
    const currentPath = scope === "terminal" ? this._termPath : this._currentPath;
    document.getElementById("sftp-create-scope").value = scope;
    document.getElementById("sftp-create-kind").value = kind;
    document.getElementById("sftp-create-title").textContent = kind === "file" ? "New File" : "New Folder";
    document.getElementById("sftp-create-icon").className = kind === "file" ? "fas fa-file-medical" : "fas fa-folder-plus";
    document.getElementById("sftp-create-location").textContent = `Location: ${currentPath}`;
    document.getElementById("sftp-create-name").value = "";
    document.getElementById("sftp-create-error").style.display = "none";
    document.getElementById("sftp-create-submit").disabled = false;
    openModal("m-sftp-create");
    setTimeout(() => document.getElementById("sftp-create-name")?.focus(), 50);
  },

  async submitRemoteCreate() {
    const scope = document.getElementById("sftp-create-scope").value;
    const kind = document.getElementById("sftp-create-kind").value;
    const name = document.getElementById("sftp-create-name").value.trim();
    const errorEl = document.getElementById("sftp-create-error");
    if (!this._validRemoteName(name)) return;
    const id = document.getElementById(scope === "terminal" ? "sftp-term-conn-id" : "sftp-browser-conn-id").value;
    const currentPath = scope === "terminal" ? this._termPath : this._currentPath;
    const remotePath = (currentPath.replace(/\/+$/, "") + "/" + name).replace(/\/{2,}/g, "/");
    const button = document.getElementById("sftp-create-submit");
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    errorEl.style.display = "none";
    let result;
    try {
      const exists = await api.sftpCheckExists(id, remotePath);
      result = exists.exists
        ? { success: false, message: "A file or folder with that name already exists" }
        : kind === "file" ? await api.sftpCreateFile(id, remotePath) : await api.sftpMkdir(id, remotePath);
    } catch (error) {
      result = { success: false, message: error.message || "The operation failed" };
    }
    button.disabled = false;
    button.innerHTML = '<i class="fas fa-plus"></i> Create';
    if (!result.success) {
      errorEl.textContent = result.message || "The server rejected the operation";
      errorEl.style.display = "block";
      return;
    }
    closeModal("m-sftp-create");
    toast(kind === "file" ? "File created" : "Folder created", "success");
    if (scope === "terminal") await this.loadTermFiles();
    else await this._loadDir();
  },

  async contextClone(encodedPath, isDirectory) {
    const sourcePath = decodeURIComponent(encodedPath);
    const name = sourcePath.split("/").pop();
    const parent = sourcePath.slice(0, -(name.length + 1)) || "/";
    const dot = !isDirectory ? name.lastIndexOf(".") : -1;
    const copyName = dot > 0 ? `${name.slice(0, dot)}-copy${name.slice(dot)}` : `${name}-copy`;
    const suggested = parent.replace(/\/+$/, "") + "/" + copyName;
    const destinationPath = prompt("Duplicate to remote path:", suggested)?.trim();
    if (!destinationPath || !destinationPath.startsWith("/")) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    const exists = await api.sftpCheckExists(id, destinationPath);
    if (exists.exists) return toast("The destination already exists", "warn");
    toast("Duplicating " + name + "...", "info");
    const result = await api.sftpCopy(id, sourcePath, destinationPath, isDirectory);
    if (result.success) { toast("Duplicated successfully", "success"); await this._loadDir(); }
    else toast("Duplicate failed: " + result.message, "error");
  },

  async contextMove(encodedPath) {
    const sourcePath = decodeURIComponent(encodedPath);
    const destinationPath = prompt("Move to remote path:", sourcePath)?.trim();
    if (!destinationPath || destinationPath === sourcePath || !destinationPath.startsWith("/")) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    const exists = await api.sftpCheckExists(id, destinationPath);
    if (exists.exists) return toast("The destination already exists", "warn");
    const result = await api.sftpMove(id, sourcePath, destinationPath);
    if (result.success) { toast("Moved successfully", "success"); await this._loadDir(); }
    else toast("Move failed: " + result.message, "error");
  },

  contextDelete(encodedPath, isDirectory) {
    return this.deleteItem(decodeURIComponent(encodedPath), isDirectory);
  },

  contextRefresh() { return this._loadDir(); },

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
  _termPath: "/",
  _termDropSetup: false,
  _termSuggestionItems: [],
  _termSuggestionIndex: -1,
  _termSuggestTimer: null,
  _remoteSystemInfo: null,
  _linuxSuggestions: [
    "shieldpress", "cd /home/", "cd /var/www/", "cd ..", "pwd", "ls -la", "ls -lah", "mkdir ", "touch ",
    "cp -r ", "mv ", "rm -i ", "find . -name ", "grep -R ", "tail -f ", "nano ", "vim ",
    "npm install", "npm run build", "npm run dev", "npm run start", "npm test", "npm audit",
    "npx ", "node -v", "php -v", "php artisan ", "php artisan migrate", "php artisan cache:clear",
    "composer install", "composer update", "composer dump-autoload", "wp plugin list", "wp cache flush",
    "git status", "git pull", "git add .", "git commit -m ", "git push", "git log --oneline -10",
    "systemctl status nginx", "systemctl restart nginx", "systemctl status mariadb", "systemctl restart php-fpm",
    "journalctl -xe", "journalctl -u nginx -f", "dmesg --level=err,warn", "df -h", "df -i", "du -sh *",
    "free -h", "ps aux", "ps aux --sort=-%mem | head", "top", "htop", "ss -tlnp", "lsof -i ",
    "curl -I ", "curl -fsSL ", "wget ", "tar -czf archive.tar.gz ", "tar -xzf ", "unzip ", "zip -r ",
    "chmod 755 ", "chmod -R 775 ", "chown -R www-data:www-data ", "ln -s ", "readlink -f ",
    "grep -Rni ", "sed -n '1,120p' ", "awk ", "sort ", "uniq -c", "wc -l", "history", "env", "printenv",
    "crontab -l", "crontab -e", "hostnamectl", "timedatectl", "ip addr", "ip route", "ping -c 4 ",
    "openssl s_client -connect ", "nginx -t", "apachectl configtest", "mysql -u root -p", "redis-cli ping", "clear",
  ],

  async openTerminal(id) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;
    if (conn.type !== "sftp") {
      toast("Terminal only available for SFTP (SSH) connections", "warn");
      return;
    }

    await this.cleanupTerminal();

    const cr = await api.sftpConnect(id);
    if (!cr.success) { toast("Connect failed: " + cr.message, "error"); return; }
    this._connStatus[id] = "connected";
    await this.load();

    document.getElementById("sftp-term-conn-id").value = id;
    document.getElementById("sftp-term-name").textContent = conn.name;
    const osEl = document.getElementById("sftp-term-os");
    if (osEl) osEl.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> Connected';
    this._cmdHistory = [];
    this._historyIdx = -1;
    this.hideTermSuggestions();
    this._termPath = conn.lastBrowsedPath || conn.remotePath || "/";
    openModal("m-sftp-terminal");
    this._setupTermDragDrop();
    this._setupTerminalClipboard();
    this._loadRemoteSystemSuggestions(id);
    this._startRemoteMetrics(id);
    await this.loadTermFiles();
    await this._startInteractiveTerminal(id);
  },

  async _startInteractiveTerminal(id) {
    this._resizeObserver?.disconnect();
    this._xtermDataDisposable?.dispose();
    this._xterm?.dispose();
    const container = document.getElementById("sftp-xterm");
    container.innerHTML = "";
    const fontSize = Math.max(10, Math.min(20, Number(localStorage.getItem("sftpTerminalFontSize")) || 13));
    this._xterm = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "'DejaVu Sans Mono', 'Liberation Mono', monospace",
      fontSize,
      lineHeight: 1.15,
      scrollback: 10000,
      allowProposedApi: false,
      theme: {
        background: "#080b11", foreground: "#d8dee9", cursor: "#5ee787",
        selectionBackground: "#365a7a", black: "#1b1f27", red: "#ff6b6b",
        green: "#5ee787", yellow: "#f6c177", blue: "#61afef", magenta: "#c678dd",
        cyan: "#56b6c2", white: "#d8dee9", brightBlack: "#5c6370",
      },
    });
    this._fitAddon = new FitAddon.FitAddon();
    this._xterm.loadAddon(this._fitAddon);
    this._xterm.open(container);
    this._fitAddon.fit();
    this._xtermDataDisposable = this._xterm.onData((data) => api.sftpShellWrite(id, data));
    this._xterm.onSelectionChange(() => this.autoCopyTerminalSelection());
    this._xterm.attachCustomKeyEventHandler((event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        this.copyTerminalSelection(); return false;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v") {
        this.pasteIntoTerminal(); return false;
      }
      return true;
    });
    this._resizeObserver = new ResizeObserver(() => {
      this._fitAddon?.fit();
      api.sftpShellResize(id, this._xterm.cols, this._xterm.rows);
    });
    this._resizeObserver.observe(container);
    this._activeShellId = id;
    const result = await api.sftpShellStart(id, this._xterm.cols, this._xterm.rows);
    if (!result.success) {
      this._activeShellId = null;
      this._xterm.writeln(`\x1b[31mSSH shell failed: ${result.message}\x1b[0m`);
    }
    this._xterm.focus();
  },

  async closeTerminal() {
    await this.cleanupTerminal();
  },

  async cleanupTerminal() {
    const id = this._activeShellId || document.getElementById("sftp-term-conn-id")?.value;
    this._activeShellId = null;
    this._stopRemoteMetrics();
    if (id) {
      try { await api.sftpShellStop(id); } catch (_) {}
    }
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._xtermDataDisposable?.dispose();
    this._xtermDataDisposable = null;
    this._xterm?.dispose();
    this._xterm = null;
    this._fitAddon = null;
    const container = document.getElementById("sftp-xterm");
    if (container) container.innerHTML = "";
    const connInput = document.getElementById("sftp-term-conn-id");
    if (connInput) connInput.value = "";
    closeModal("m-sftp-terminal");
  },

  async loadTermFiles() {
    const id = document.getElementById("sftp-term-conn-id")?.value;
    const pathEl = document.getElementById("sftp-term-path");
    const listEl = document.getElementById("sftp-term-files");
    if (!id || !pathEl || !listEl) return;
    pathEl.value = this._termPath;
    listEl.innerHTML = '<div style="padding:18px;text-align:center"><i class="fas fa-spinner fa-spin"></i></div>';
    const r = await api.sftpList(id, this._termPath);
    if (!r.success) {
      listEl.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px">${this._esc(r.message)}</div>`;
      return;
    }
    if (!r.items.length) {
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text3);font-size:12px">Empty directory</div>';
      return;
    }
    const base = this._termPath;
    listEl.innerHTML = r.items.map((item) => {
      const fullPath = base.replace(/\/+$/, "") + "/" + item.name;
      const encoded = encodeURIComponent(fullPath);
      const editable = item.type === "file" && /\.(php|html|css|js|json|txt|xml|yml|yaml|conf|ini|env|htaccess|md|sh|py|rb|sql|log|csv|twig)$/i.test(item.name);
      return `<div style="display:flex;align-items:center;gap:7px;padding:7px 8px;border-bottom:1px solid var(--border);font-size:12px" title="${this._esc(fullPath)}" data-remote-path="${encoded}" data-remote-name="${encodeURIComponent(item.name)}" data-remote-type="${item.type}" data-remote-editable="${editable}">
        <button class="btn btn-ghost btn-xs" style="min-width:0;flex:1;justify-content:flex-start;overflow:hidden" onclick="${item.type === "directory" ? `SFTP.termEnterPath('${encoded}')` : editable ? `SFTP.termEditFile('${encoded}')` : `SFTP.copyRemotePath(decodeURIComponent('${encoded}'))`}">
          <i class="fas ${item.type === "directory" ? "fa-folder" : "fa-file"}" style="color:${item.type === "directory" ? "var(--yellow)" : "var(--text3)"};flex-shrink:0"></i>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(item.name)}</span>
        </button>
        ${item.type === "file" ? `<span style="color:var(--text3);font-size:10px;flex-shrink:0">${this._fmtSize(item.size)}</span>` : ""}
        <button class="btn btn-ghost btn-xs" onclick="SFTP.copyRemotePath(decodeURIComponent('${encoded}'))" title="Copy path"><i class="fas fa-copy"></i></button>
        ${editable ? `<button class="btn btn-ghost btn-xs" onclick="SFTP.termEditFile('${encoded}')" title="Edit"><i class="fas fa-edit"></i></button>` : ""}
        <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="SFTP.termDeleteItem('${encoded}',${item.type === "directory"})" title="Delete"><i class="fas fa-trash"></i></button>
      </div>`;
    }).join("");
  },

  termEnterPath(encodedPath) {
    this._termPath = decodeURIComponent(encodedPath);
    api.sftpSaveLastPath(document.getElementById("sftp-term-conn-id").value, this._termPath);
    this.loadTermFiles();
  },

  termBrowseUp() {
    const parts = this._termPath.split("/").filter(Boolean);
    parts.pop();
    this._termPath = "/" + parts.join("/");
    this.loadTermFiles();
  },

  termGoPath() {
    const value = document.getElementById("sftp-term-path").value.trim();
    if (!value.startsWith("/")) return toast("Remote path must start with /", "warn");
    this._termPath = value.replace(/\/{2,}/g, "/") || "/";
    this.loadTermFiles();
  },

  async copyRemotePath(remotePath) {
    try {
      await navigator.clipboard.writeText(remotePath);
      toast("Path copied", "success");
    } catch {
      toast("Could not copy path", "error");
    }
  },

  async termEditFile(encodedPath) {
    const id = document.getElementById("sftp-term-conn-id").value;
    await this.editFileFor(id, decodeURIComponent(encodedPath));
  },

  async termDeleteItem(encodedPath, isDirectory) {
    const remotePath = decodeURIComponent(encodedPath);
    const name = remotePath.split("/").pop();
    if (!confirm(`Delete ${isDirectory ? "folder" : "file"} "${name}"?`)) return;
    const id = document.getElementById("sftp-term-conn-id").value;
    const r = await api.sftpDelete(id, remotePath, isDirectory);
    if (r.success) { toast("Deleted: " + name, "success"); await this.loadTermFiles(); }
    else toast("Delete failed: " + r.message, "error");
  },

  termContextOpenFolder(encodedPath) { return this.termEnterPath(encodedPath); },
  termContextEdit(encodedPath) { return this.termEditFile(encodedPath); },
  termContextDelete(encodedPath, isDirectory) { return this.termDeleteItem(encodedPath, isDirectory); },
  termContextRefresh() { return this.loadTermFiles(); },

  async termContextDownload(encodedPath) {
    const remotePath = decodeURIComponent(encodedPath);
    const localDir = await api.openFileDialog({ properties: ["openDirectory"] });
    if (!localDir) return;
    const destination = localDir.replace(/[\\/]+$/, "") + "/" + remotePath.split("/").pop();
    const id = document.getElementById("sftp-term-conn-id").value;
    const result = await api.sftpDownload(id, remotePath, destination);
    if (result.success) toast("Downloaded successfully", "success");
    else toast("Download failed: " + result.message, "error");
  },

  async termContextOpenExternal(encodedPath) {
    const id = document.getElementById("sftp-term-conn-id").value;
    const result = await api.sftpOpenExternal(id, decodeURIComponent(encodedPath));
    if (result.success) toast(result.message, "success");
    else toast("Open failed: " + result.message, "error");
  },

  async termContextOpenWith(encodedPath) {
    const editorPath = await api.openFileDialog({ properties: ["openFile"], title: "Choose an application to edit this file" });
    if (!editorPath) return;
    const id = document.getElementById("sftp-term-conn-id").value;
    const result = await api.sftpOpenExternal(id, decodeURIComponent(encodedPath), editorPath);
    if (result.success) toast(result.message, "success");
    else toast("Open failed: " + result.message, "error");
  },

  termContextNewFile() { this.openRemoteCreate("terminal", "file"); },

  termContextNewFolder() { return this.termCreateDir(); },

  async termContextClone(encodedPath, isDirectory) {
    const sourcePath = decodeURIComponent(encodedPath);
    const name = sourcePath.split("/").pop();
    const parent = sourcePath.slice(0, -(name.length + 1)) || "/";
    const dot = !isDirectory ? name.lastIndexOf(".") : -1;
    const copyName = dot > 0 ? `${name.slice(0, dot)}-copy${name.slice(dot)}` : `${name}-copy`;
    const destinationPath = prompt("Duplicate to remote path:", parent.replace(/\/+$/, "") + "/" + copyName)?.trim();
    if (!destinationPath || !destinationPath.startsWith("/")) return;
    const id = document.getElementById("sftp-term-conn-id").value;
    const exists = await api.sftpCheckExists(id, destinationPath);
    if (exists.exists) return toast("The destination already exists", "warn");
    const result = await api.sftpCopy(id, sourcePath, destinationPath, isDirectory);
    if (result.success) { toast("Duplicated successfully", "success"); await this.loadTermFiles(); }
    else toast("Duplicate failed: " + result.message, "error");
  },

  async termContextMove(encodedPath) {
    const sourcePath = decodeURIComponent(encodedPath);
    const destinationPath = prompt("Move to remote path:", sourcePath)?.trim();
    if (!destinationPath || destinationPath === sourcePath || !destinationPath.startsWith("/")) return;
    const id = document.getElementById("sftp-term-conn-id").value;
    const exists = await api.sftpCheckExists(id, destinationPath);
    if (exists.exists) return toast("The destination already exists", "warn");
    const result = await api.sftpMove(id, sourcePath, destinationPath);
    if (result.success) { toast("Moved successfully", "success"); await this.loadTermFiles(); }
    else toast("Move failed: " + result.message, "error");
  },

  isTerminalClipboardTarget(target) {
    return !!target?.closest?.("#sftp-xterm");
  },

  _setupTerminalClipboard() {
    this._terminalClipboardSetup = true;
  },

  async autoCopyTerminalSelection() {
    const text = this._xterm?.getSelection() || "";
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { return; }
  },

  async copyTerminalSelection() {
    const text = this._xterm?.getSelection() || "";
    if (!text) return toast("Select terminal output to copy", "info");
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success", 1200);
  },

  async pasteIntoTerminal() {
    let text;
    try { text = await navigator.clipboard.readText(); }
    catch { return toast("Clipboard access failed", "error"); }
    if (!text) return;
    this._xterm?.paste(text);
    this._xterm?.focus();
  },

  resizeTermInput() {
    const input = document.getElementById("sftp-term-cmd");
    if (!input) return;
    input.style.height = "24px";
    input.style.height = Math.min(140, Math.max(24, input.scrollHeight)) + "px";
  },

  async _loadRemoteSystemSuggestions(id) {
    const info = await api.sftpSystemInfo(id);
    if (!info.success) return;
    this._remoteSystemInfo = info;
    const families = new Set([info.id, ...(info.idLike || [])]);
    const extra = [];
    if ([...families].some((value) => ["ubuntu", "debian", "linuxmint", "pop"].includes(value)) || info.tools.includes("apt")) {
      extra.push("sudo apt update", "sudo apt upgrade", "sudo apt install ", "sudo apt remove ", "apt search ", "dpkg -l", "ufw status", "ufw allow ");
    }
    if ([...families].some((value) => ["rhel", "fedora", "centos", "rocky", "almalinux"].includes(value)) || info.tools.includes("dnf") || info.tools.includes("yum")) {
      const manager = info.tools.includes("dnf") ? "dnf" : "yum";
      extra.push(`sudo ${manager} check-update`, `sudo ${manager} upgrade`, `sudo ${manager} install `, `sudo ${manager} remove `, "firewall-cmd --list-all");
    }
    if (families.has("alpine") || info.tools.includes("apk")) extra.push("sudo apk update", "sudo apk upgrade", "sudo apk add ", "sudo apk del ", "rc-service ");
    if (families.has("arch") || info.tools.includes("pacman")) extra.push("sudo pacman -Syu", "sudo pacman -S ", "sudo pacman -R ", "pacman -Qs ");
    if ([...families].some((value) => ["suse", "opensuse"].includes(value)) || info.tools.includes("zypper")) extra.push("sudo zypper refresh", "sudo zypper update", "sudo zypper install ", "sudo zypper remove ");
    this._linuxSuggestions = [...new Set([...this._linuxSuggestions, ...extra])];
    const osEl = document.getElementById("sftp-term-os");
    if (osEl) osEl.innerHTML = `<i class="fas fa-circle" style="font-size:7px"></i> ${this._esc(info.name)}`;
  },

  _metricColor(pct) {
    if (pct == null || Number.isNaN(pct)) return "var(--text3)";
    if (pct >= 90) return "var(--red)";
    if (pct >= 70) return "var(--yellow)";
    return "var(--green)";
  },

  _formatRate(bytesPerSec) {
    if (bytesPerSec == null || Number.isNaN(bytesPerSec)) return "--";
    if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${bytesPerSec} B/s`;
  },

  _formatPct(pct) {
    return pct == null || Number.isNaN(pct) ? "--" : `${pct}%`;
  },

  _renderRemoteMetrics(stats) {
    const el = document.getElementById("sftp-term-metrics");
    if (!el) return;
    const cpu = stats?.cpuPct;
    const ram = stats?.ramPct;
    const disk = stats?.diskPct;
    const cpuColor = this._metricColor(cpu);
    const ramColor = this._metricColor(ram);
    const diskColor = this._metricColor(disk);
    el.innerHTML = `
      <span class="sftp-term-metric" style="color:${cpuColor}" title="CPU usage"><i class="fas fa-microchip"></i> CPU ${this._formatPct(cpu)}</span>
      <span class="sftp-term-metric" style="color:${ramColor}" title="RAM usage"><i class="fas fa-memory"></i> RAM ${this._formatPct(ram)}</span>
      <span class="sftp-term-metric" style="color:${diskColor}" title="Disk usage (/)"><i class="fas fa-hdd"></i> Disk ${this._formatPct(disk)}</span>
      <span class="sftp-term-metric" style="color:var(--accent)" title="Network upload / download">
        <i class="fas fa-arrow-up"></i> ${this._formatRate(stats?.netUp)}
        <i class="fas fa-arrow-down" style="margin-left:6px"></i> ${this._formatRate(stats?.netDown)}
      </span>`;
  },

  _stopRemoteMetrics() {
    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }
    this._metricsConnId = null;
  },

  async _refreshRemoteMetrics(id) {
    if (id !== this._metricsConnId) return;
    const stats = await api.sftpRemoteStats(id);
    if (id !== this._metricsConnId) return;
    if (stats?.success) this._renderRemoteMetrics(stats);
  },

  _startRemoteMetrics(id) {
    this._stopRemoteMetrics();
    this._metricsConnId = id;
    this._renderRemoteMetrics(null);
    this._refreshRemoteMetrics(id);
    setTimeout(() => this._refreshRemoteMetrics(id), 800);
    this._metricsTimer = setInterval(() => this._refreshRemoteMetrics(id), 2000);
  },

  adjustTerminalFont(delta) {
    if (!this._xterm) return;
    const size = Math.max(10, Math.min(20, (this._xterm.options.fontSize || 13) + delta));
    this._xterm.options.fontSize = size;
    this._fitAddon?.fit();
    localStorage.setItem("sftpTerminalFontSize", String(size));
  },

  async termUploadFiles() {
    const selected = await api.openFileDialog({ properties: ["openFile", "multiSelections"] });
    if (!selected) return;
    await this._termUploadPaths(Array.isArray(selected) ? selected : [selected]);
  },

  async _termUploadPaths(paths) {
    const id = document.getElementById("sftp-term-conn-id").value;
    let uploaded = 0;
    for (const localPath of paths) {
      const fileName = localPath.split(/[/\\]/).pop();
      const remotePath = this._termPath.replace(/\/+$/, "") + "/" + fileName;
      const exists = await api.sftpCheckExists(id, remotePath);
      if (exists.exists && !confirm(`"${fileName}" already exists. Overwrite?`)) continue;
      const r = await api.sftpUpload(id, localPath, remotePath);
      if (r.success) uploaded++;
      else toast("Upload failed: " + fileName + " — " + r.message, "error");
    }
    if (uploaded) { toast(`Uploaded ${uploaded} file(s)`, "success"); await this.loadTermFiles(); }
  },

  termCreateDir() { this.openRemoteCreate("terminal", "folder"); },

  _setupTermDragDrop() {
    if (this._termDropSetup) return;
    const zone = document.getElementById("sftp-term-files");
    if (!zone) return;
    this._termDropSetup = true;
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.style.outline = "2px dashed var(--accent)";
      zone.style.outlineOffset = "-4px";
    });
    zone.addEventListener("dragleave", () => { zone.style.outline = ""; });
    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.style.outline = "";
      const paths = [...(event.dataTransfer?.files || [])].map((file) => file.path).filter(Boolean);
      if (paths.length) await this._termUploadPaths(paths);
    });
  },

  async termKeyDown(event) {
    if (event.key === "Enter" && event.shiftKey) {
      setTimeout(() => this.resizeTermInput(), 0);
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.execCmd();
      return;
    }
    const suggestionsOpen = this._termSuggestionItems.length > 0;
    if ((event.key === "Tab" || event.key === "Enter") && suggestionsOpen) {
      event.preventDefault();
      this.applyTermSuggestion(this._termSuggestionIndex >= 0 ? this._termSuggestionIndex : 0);
    } else if (event.key === "Tab") {
      event.preventDefault();
      await this._buildTermSuggestions();
      if (this._termSuggestionItems.length) this.applyTermSuggestion(0);
    } else if (event.key === "Escape" && suggestionsOpen) {
      event.preventDefault();
      this.hideTermSuggestions();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.execCmd();
    } else if (event.key === "ArrowUp") {
      if (!suggestionsOpen && document.getElementById("sftp-term-cmd").value.includes("\n")) return;
      event.preventDefault();
      if (suggestionsOpen) {
        this._termSuggestionIndex = this._termSuggestionIndex <= 0
          ? this._termSuggestionItems.length - 1 : this._termSuggestionIndex - 1;
        this.renderTermSuggestions();
        return;
      }
      if (this._cmdHistory.length === 0) return;
      if (this._historyIdx < this._cmdHistory.length - 1) this._historyIdx++;
      document.getElementById("sftp-term-cmd").value =
        this._cmdHistory[this._cmdHistory.length - 1 - this._historyIdx] || "";
    } else if (event.key === "ArrowDown") {
      if (!suggestionsOpen && document.getElementById("sftp-term-cmd").value.includes("\n")) return;
      event.preventDefault();
      if (suggestionsOpen) {
        this._termSuggestionIndex = (this._termSuggestionIndex + 1) % this._termSuggestionItems.length;
        this.renderTermSuggestions();
        return;
      }
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

  termSuggest(immediate = false) {
    clearTimeout(this._termSuggestTimer);
    const run = () => this._buildTermSuggestions();
    if (immediate) run();
    else this._termSuggestTimer = setTimeout(run, 120);
  },

  async _buildTermSuggestions() {
    const input = document.getElementById("sftp-term-cmd");
    const query = input?.value || "";
    if (!query.trim() || query.includes("\n")) return this.hideTermSuggestions();

    const normalized = query.trim().toLowerCase();
    const exactCommands = new Set(["shieldpress", "ls", "cd", "pwd", "cat", "cp", "mv", "rm", "mkdir", "touch", "find", "grep", "tail", "head", "nano", "vim", "clear", "top", "htop", "history", "env", "npm", "node", "php", "composer", "git", "wp"]);
    const staticItems = this._linuxSuggestions
      .filter((command) => !exactCommands.has(normalized) && command.toLowerCase().startsWith(normalized) && command.toLowerCase() !== normalized)
      .slice(0, 8)
      .map((value) => ({ value, label: value, kind: "command" }));
    const pathItems = await this._getPathSuggestions(query);
    // Ignore a stale asynchronous result after the user has typed again.
    if ((document.getElementById("sftp-term-cmd")?.value || "") !== query) return;
    const unique = new Map();
    [...pathItems, ...staticItems].forEach((item) => unique.set(item.value, item));
    this._termSuggestionItems = [...unique.values()].slice(0, 10);
    this._termSuggestionIndex = this._termSuggestionItems.length ? 0 : -1;
    this.renderTermSuggestions();
  },

  async _getPathSuggestions(commandLine) {
    const match = commandLine.match(/^(.*?)([^\s"']+)$/);
    if (!match) return [];
    const before = match[1];
    const token = match[2];
    // Complete paths only when a path-like argument is being entered.
    const verb = commandLine.trimStart().split(/\s+/)[0]?.toLowerCase();
    const pathCommands = new Set(["cd", "ls", "cat", "nano", "vim", "less", "more", "rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "du", "tail", "head", "grep", "find"]);
    if (!/\s/.test(commandLine) && !token.includes("/")) return [];
    if (!token.includes("/") && !pathCommands.has(verb)) return [];
    const slash = token.lastIndexOf("/");
    let typedDir = slash >= 0 ? token.slice(0, slash + 1) : "";
    const partial = slash >= 0 ? token.slice(slash + 1) : token;
    let listPath;
    if (typedDir.startsWith("/")) listPath = typedDir || "/";
    else if (typedDir.startsWith("~/")) listPath = this._termPath.replace(/\/+$/, "") + "/" + typedDir.slice(2);
    else listPath = this._termPath.replace(/\/+$/, "") + "/" + typedDir;
    listPath = listPath.replace(/\/{2,}/g, "/") || "/";

    const id = document.getElementById("sftp-term-conn-id")?.value;
    if (!id) return [];
    const result = await api.sftpList(id, listPath);
    if (!result.success) return [];
    return result.items
      .filter((item) => item.name.toLowerCase().startsWith(partial.toLowerCase()))
      .slice(0, 10)
      .map((item) => {
        const completedToken = typedDir + item.name + (item.type === "directory" ? "/" : "");
        return {
          value: before + completedToken,
          label: completedToken,
          kind: item.type === "directory" ? "folder" : "file",
        };
      });
  },

  renderTermSuggestions() {
    const box = document.getElementById("sftp-term-suggestions");
    if (!box) return;
    if (!this._termSuggestionItems.length) {
      box.style.display = "none";
      box.innerHTML = "";
      return;
    }
    box.style.display = "block";
    box.innerHTML = this._termSuggestionItems.map((item, index) => `
      <button type="button" onmousedown="event.preventDefault();SFTP.applyTermSuggestion(${index})"
        style="display:flex;width:100%;align-items:center;gap:8px;padding:7px 10px;border:0;border-bottom:1px solid var(--border);background:${index === this._termSuggestionIndex ? "var(--bg4)" : "transparent"};color:var(--text1);font-family:var(--mono);font-size:11px;text-align:left;cursor:pointer">
        <i class="fas ${item.kind === "folder" ? "fa-folder" : item.kind === "file" ? "fa-file" : "fa-terminal"}" style="color:${item.kind === "folder" ? "var(--yellow)" : "var(--accent)"};width:13px"></i>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(item.label)}</span>
        ${index === this._termSuggestionIndex ? '<span style="margin-left:auto;color:var(--text3)">Tab / Enter</span>' : ""}
      </button>`).join("");
  },

  applyTermSuggestion(index) {
    const item = this._termSuggestionItems[index];
    if (!item) return;
    const input = document.getElementById("sftp-term-cmd");
    input.value = item.value;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    this.hideTermSuggestions();
  },

  hideTermSuggestions() {
    this._termSuggestionItems = [];
    this._termSuggestionIndex = -1;
    const box = document.getElementById("sftp-term-suggestions");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
  },

  quickCmd(cmd) {
    const id = document.getElementById("sftp-term-conn-id").value;
    api.sftpShellWrite(id, cmd + "\r");
    this._xterm?.focus();
  },

  execClear() {
    this._xterm?.clear();
  },

  async execCmd() {
    const id = document.getElementById("sftp-term-conn-id").value;
    const cmdEl = document.getElementById("sftp-term-cmd");
    const cmd = cmdEl.value.trim();
    if (!cmd) return;
    this.hideTermSuggestions();

    // Save to history
    if (!this._cmdHistory.length || this._cmdHistory[this._cmdHistory.length - 1] !== cmd) {
      this._cmdHistory.push(cmd);
    }
    this._historyIdx = -1;
    cmdEl.value = "";
    this.resizeTermInput();

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
      if (r.cwd !== this._termPath) {
        this._termPath = r.cwd;
        this.loadTermFiles();
      }
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
