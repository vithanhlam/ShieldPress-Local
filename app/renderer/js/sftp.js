// renderer/js/sftp.js

window.SFTP = {
  _connections: [],
  _connStatus: {}, // { connId: "connected" | "disconnected" }
  _currentPath: "/",
  _listening: false,
  _vault: { configured: false, unlocked: false },
  _showHidden: true,
  _sortKey: "name",
  _sortDir: 1,
  _browserItems: [],
  _deleteBusy: false,
  _remoteSelection: null,
  _sessionMode: false,
  _sessionId: null,
  _sessionKind: null,
  _sessionConnectionId: null,
  _termSortKey: "name",
  _termSortDir: 1,
  _monacoReady: false,

  async init() {
    // Page HTML is cached by the router. Ensure a previous terminal overlay can
    // never remain visible when the user returns to this page.
    if (!this._activeShellId) closeModal("m-sftp-terminal");
    if (!this._listening) {
      api.onSftpProgress((msg) => {
        const syncOut = document.getElementById("sftp-sync-output");
        if (syncOut && document.getElementById("m-sftp-sync")?.classList.contains("open") && typeof msg === "string") {
          syncOut.textContent += msg + "\n";
          syncOut.scrollTop = syncOut.scrollHeight;
        }
      });
      api.onSftpUploadProgress((msg) => this._onUploadProgress(msg));
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
    this._setupRemoteKeyboard();
    await this.refreshVaultStatus();
    this._bindTerminalSplitter();
    await this.load();
  },

  async refreshVaultStatus() {
    this._vault = await api.sftpVaultStatus();
    const btn = document.getElementById("sftp-vault-btn");
    const changeBtn = document.getElementById("sftp-vault-change-btn");
    if (!btn) return;
    btn.innerHTML = this._vault.unlocked
      ? '<i class="fas fa-lock-open"></i> Vault unlocked'
      : '<i class="fas fa-lock"></i> Vault locked';
    btn.style.color = this._vault.unlocked ? "var(--green)" : "var(--yellow)";
    if (changeBtn) changeBtn.style.display = this._vault.unlocked ? "inline-flex" : "none";
  },

  openChangeVault() {
    if (!this._vault.unlocked) return this.openVault();
    for (const id of ["sftp-vault-current-pass", "sftp-vault-new-pass", "sftp-vault-new-confirm"]) {
      document.getElementById(id).value = "";
    }
    openModal("m-sftp-vault-change");
    setTimeout(() => document.getElementById("sftp-vault-current-pass")?.focus(), 50);
  },

  changeVaultKeyDown(event, isConfirmation) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!isConfirmation) return this.submitChangeVault();
    this.submitChangeVault();
  },

  cancelChangeVault() {
    closeModal("m-sftp-vault-change");
  },

  async submitChangeVault() {
    const currentPassword = document.getElementById("sftp-vault-current-pass").value;
    const newPassword = document.getElementById("sftp-vault-new-pass").value;
    const confirmation = document.getElementById("sftp-vault-new-confirm").value;
    if (newPassword.length < 12) return toast("Master Password must contain at least 12 characters", "warn");
    if (newPassword !== confirmation) return toast("Master Password confirmation does not match", "warn");
    const result = await api.sftpVaultChangePassword({ currentPassword, newPassword });
    if (!result.success) return toast(result.message, "error");
    this.cancelChangeVault();
    await this.refreshVaultStatus();
    await this.load();
    toast("Credential vault password changed", "success");
  },

  async openVault(onUnlocked = null) {
    await this.refreshVaultStatus();
    if (typeof onUnlocked === "function") this._pendingVaultAction = onUnlocked;
    if (this._vault.unlocked) {
      if (typeof onUnlocked === "function") {
        this._pendingVaultAction = null;
        await onUnlocked();
        return;
      }
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

  vaultKeyDown(event, isConfirmation) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!this._vault.configured && !isConfirmation) {
      document.getElementById("sftp-master-confirm")?.focus();
      return;
    }
    this.submitVault();
  },

  cancelVault() {
    this._pendingVaultAction = null;
    closeModal("m-sftp-vault");
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
    const pendingAction = this._pendingVaultAction;
    this._pendingVaultAction = null;
    if (typeof pendingAction === "function") await pendingAction();
  },

  async _handleVaultLocked(result, retryAction) {
    if (result?.code !== "VAULT_LOCKED") return false;
    await this.openVault(retryAction);
    return true;
  },

  async load() {
    const r = await api.sftpGetConnections();
    this._connections = r.connections || [];
    for (const c of this._connections) {
      const live = !!c.isConnected || (Array.isArray(c.openSessions) && c.openSessions.length > 0);
      this._connStatus[c.id] = live ? "connected" : "disconnected";
    }
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
      const sa = a.starred ? 1 : 0;
      const sb = b.starred ? 1 : 0;
      if (sa !== sb) return sb - sa;
      return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
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
    <button class="btn btn-sm btn-ghost" title="Open ${c.type === "ftp" ? "FTP" : "SFTP"} files" onclick="SFTP.openBrowser('${c.id}')"><i class="fas fa-folder-open"></i> Files</button>
    ${c.type === "sftp" ? `<button class="btn btn-sm btn-ghost" title="Open Terminal window" onclick="SFTP.openTerminal('${c.id}')"><i class="fas fa-terminal"></i> Terminal</button>` : ""}
    <button class="btn btn-sm btn-ghost" data-sync-connection="${c.id}" title="Sync Upload" onclick="SFTP.openSyncConfig('${c.id}', 'upload')"><i class="fas fa-cloud-upload-alt"></i> Sync Up</button>
    <button class="btn btn-sm btn-ghost" data-sync-connection="${c.id}" title="Sync Download" onclick="SFTP.openSyncConfig('${c.id}', 'download')"><i class="fas fa-cloud-download-alt"></i> Sync Down</button>
    <button class="btn btn-sm btn-ghost btn-edit" title="Settings" onclick="SFTP.openEdit('${c.id}')"><i class="fas fa-cog"></i> Setting</button>
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
      if (!(await this._handleVaultLocked(r, () => this.connect(id)))) {
        toast("Connection failed: " + r.message, "error");
      }
    }
    this._render();
  },

  async disconnect(id) {
    await api.sftpDisconnect(id);
    this._connStatus[id] = "disconnected";
    toast("Disconnected", "info");
    await this.load();
  },

  // ── File Browser ──────────────────────────────────────────────────────────
  _dropSetup: false,

  async openBrowser(id) {
    const conn = this._connections.find((c) => c.id === id);
    if (!conn) return;
    toast(`Opening ${conn.type === "ftp" ? "FTP" : "SFTP"} window…`, "info");
    const r = await api.sftpOpenWindow(conn.type === "ftp" ? "ftp" : "sftp", id);
    if (!r.success) {
      if (!(await this._handleVaultLocked(r, () => this.openBrowser(id)))) {
        toast("Open failed: " + r.message, "error");
      }
      return;
    }
    this._connStatus[id] = "connected";
    await this.load();
  },

  _setupDragDrop() {
    const zone =
      document.querySelector('[data-drop-zone="browser"]')
      || document.getElementById("remote-browser-pane")
      || document.getElementById("sftp-file-list");
    if (!zone) return;
    this._bindFileDropZone(zone, async (paths) => {
      const id = document.getElementById("sftp-browser-conn-id")?.value;
      if (!id) return toast("Not connected", "warn");
      await this._uploadLocalPaths(id, paths, this._currentPath, () => this._loadDir());
    });
    const list = document.getElementById("sftp-file-list");
    if (list) this._bindRemoteListEvents(list, "browser");
  },

  _getLocalPathFromFile(file) {
    if (!file) return "";
    try {
      if (typeof api.getPathForFile === "function") {
        const fromUtils = api.getPathForFile(file);
        if (fromUtils) return fromUtils;
      }
    } catch (_) {}
    return file.path || "";
  },

  _extractDropPaths(event) {
    const paths = [];
    const seen = new Set();
    const add = (value) => {
      const path = String(value || "").trim();
      if (!path || seen.has(path)) return;
      seen.add(path);
      paths.push(path);
    };

    const dt = event?.dataTransfer;
    if (!dt) return paths;

    // items is more reliable than files for folders on Linux file managers
    if (dt.items && dt.items.length) {
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i];
        if (!item || item.kind !== "file") continue;
        add(this._getLocalPathFromFile(item.getAsFile()));
      }
    }

    if (!paths.length && dt.files && dt.files.length) {
      for (let i = 0; i < dt.files.length; i++) {
        add(this._getLocalPathFromFile(dt.files[i]));
      }
    }

    return paths;
  },

  _bindFileDropZone(zone, onPaths) {
    if (!zone || zone.dataset.fileDropBound === "1") return;
    zone.dataset.fileDropBound = "1";
    let depth = 0;

    // Needed so Chromium/Electron actually accepts the drop (otherwise drop is often ignored).
    if (!document.documentElement.dataset.dropGuardBound) {
      document.documentElement.dataset.dropGuardBound = "1";
      document.addEventListener("dragover", (e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      });
      document.addEventListener("drop", (e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      });
    }

    const paint = (active) => {
      zone.classList.toggle("is-drop-target", !!active);
    };
    const reset = () => {
      depth = 0;
      paint(false);
    };

    zone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth += 1;
      paint(true);
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });

    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      paint(true);
    });

    zone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Ignore leave events that stay inside this zone (child <-> child)
      const related = e.relatedTarget;
      if (related && zone.contains(related)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) paint(false);
    });

    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      reset();
      const paths = this._extractDropPaths(e);
      if (!paths.length) {
        toast("Could not read dropped files. Try again or use Upload.", "warn");
        return;
      }
      try {
        await onPaths(paths);
      } catch (err) {
        toast(err?.message || "Upload failed", "error");
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

    this._browserItems = r.items || [];
    this._renderBrowserList();
  },

  toggleHiddenFiles() {
    this._showHidden = !!document.getElementById("sftp-show-hidden")?.checked;
    this._renderBrowserList();
  },

  sortBrowser(key) {
    if (this._sortKey === key) this._sortDir *= -1;
    else {
      this._sortKey = key;
      this._sortDir = key === "modified" ? -1 : 1;
    }
    this._renderBrowserList();
  },

  _sortMarker(key) {
    if (this._sortKey !== key) return "";
    return this._sortDir > 0 ? " ▲" : " ▼";
  },

  _itemKind(item) {
    if (item.kind === "folder") return "Folder";
    if (item.kind === "link-dir") return "Link (folder)";
    if (item.kind === "link") return "Link";
    if (item.kind && item.kind !== "file") return item.kind.toUpperCase();
    const ext = (item.name || "").split(".").pop();
    if (ext && ext !== item.name) return ext.toUpperCase();
    return "File";
  },

  _isDir(item) {
    return item.isDirectory || item.type === "directory";
  },

  _renderBrowserList() {
    const listEl = document.getElementById("sftp-file-list");
    if (!listEl) return;
    let items = [...(this._browserItems || [])];
    if (!this._showHidden) items = items.filter((item) => !String(item.name || "").startsWith("."));
    items.sort((a, b) => {
      const aDir = this._isDir(a);
      const bDir = this._isDir(b);
      if (aDir !== bDir) return aDir ? -1 : 1;
      let cmp = 0;
      if (this._sortKey === "modified") cmp = String(a.modified || "").localeCompare(String(b.modified || ""));
      else if (this._sortKey === "size") cmp = (a.size || 0) - (b.size || 0);
      else if (this._sortKey === "kind") cmp = this._itemKind(a).localeCompare(this._itemKind(b));
      else if (this._sortKey === "permissions") cmp = String(a.permissions || "").localeCompare(String(b.permissions || ""));
      else cmp = String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
      return cmp * this._sortDir;
    });

    if (!items.length) {
      listEl.innerHTML = '<div style="padding:16px;color:var(--text3);text-align:center"><i class="fas fa-folder-open"></i> Empty directory</div>';
      return;
    }

    const curPath = this._currentPath;
    const th = (key, label, width) =>
      `<th style="padding:8px 10px;${width ? `width:${width};` : ""}cursor:pointer;user-select:none" onclick="SFTP.sortBrowser('${key}')">${label}${this._sortMarker(key)}</th>`;
    listEl.innerHTML = `<table style="width:100%;font-size:13px;border-collapse:collapse">
<thead><tr style="background:var(--bg3);text-align:left">
  ${th("name", "Name")}
  ${th("size", "Size", "80px")}
  ${th("modified", "Modified", "150px")}
  ${th("permissions", "Permissions", "145px")}
  <th style="padding:8px 10px;width:150px;text-align:right">Actions</th>
</tr></thead>
<tbody>${items.map((item) => {
  const fullPath = curPath.replace(/\/+$/, "") + "/" + item.name;
  const encodedPath = encodeURIComponent(fullPath);
  const encodedName = encodeURIComponent(item.name);
  const isDir = this._isDir(item);
  const isEditable = !isDir && /\.(php|html|css|js|json|txt|xml|yml|yaml|conf|ini|env|htaccess|md|sh|py|rb|sql|log|csv|twig)$/i.test(item.name);
  const icon = isDir ? (item.isLink ? "fa-link" : "fa-folder") : (item.isLink ? "fa-link" : "fa-file");
  const color = isDir ? "var(--yellow)" : "var(--text3)";
  return `
<tr style="border-top:1px solid var(--border)" data-remote-path="${encodedPath}" data-remote-name="${encodedName}" data-remote-type="${isDir ? "directory" : "file"}" data-remote-editable="${isEditable}">
  <td style="padding:8px 10px;cursor:${isDir ? "pointer" : "default"};color:${isDir ? "var(--accent)" : "inherit"}">
    <i class="fas ${icon}" style="color:${color};margin-right:8px"></i>
    ${this._esc(item.name)}${item.isLink ? ' <span style="font-size:10px;color:var(--text3)">link</span>' : ""}
  </td>
  <td style="padding:8px 10px;color:var(--text3)">${isDir ? "—" : this._fmtSize(item.size)}</td>
  <td style="padding:8px 10px;color:var(--text3);font-size:12px">${item.modified ? new Date(item.modified).toLocaleString("vi-VN") : ""}</td>
  <td style="padding:8px 10px;color:var(--text3);font-family:var(--mono);font-size:11px;white-space:nowrap">${this._esc(item.permissions || "—")}</td>
  <td style="padding:8px 10px;text-align:right;white-space:nowrap">
    ${`<button class="btn btn-ghost btn-xs" title="Download" onclick="SFTP.downloadItem(decodeURIComponent('${encodedPath}'), ${isDir})"><i class="fas fa-download"></i></button>`}
    ${isEditable ? `<button class="btn btn-ghost btn-xs" title="Edit inline" onclick="SFTP.editFile(decodeURIComponent('${encodedPath}'))"><i class="fas fa-edit"></i></button>` : ""}
    ${isEditable ? `<button class="btn btn-ghost btn-xs" title="Open in Editor (VS Code, Notepad++...)" onclick="SFTP.openExternal(decodeURIComponent('${encodedPath}'))"><i class="fas fa-external-link-alt"></i></button>` : ""}
    <button class="btn btn-ghost btn-xs" title="Rename (F2)" onclick="SFTP.renameItem(decodeURIComponent('${encodedPath}'), ${isDir})"><i class="fas fa-i-cursor"></i></button>
    <button class="btn btn-ghost btn-xs" title="Delete" style="color:var(--red)" onclick="SFTP.deleteItem(decodeURIComponent('${encodedPath}'), ${isDir})"><i class="fas fa-trash"></i></button>
  </td>
</tr>`;
}).join("")}</tbody></table>`;
    this._applyRemoteSelectionHighlight(listEl);
    this._bindHorizontalScroll(listEl);
  },

  enterEncodedDir(encodedName) {
    this.enterDir(decodeURIComponent(encodedName || ""));
  },

  enterDir(name) {
    this._clearRemoteSelection();
    this._currentPath = this._currentPath.replace(/\/+$/, "") + "/" + name;
    this._saveCurrentPath();
    this._loadDir();
  },

  browseUp() {
    this._clearRemoteSelection();
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

  async downloadItem(remotePath, isDirectory) {
    const id = document.getElementById("sftp-browser-conn-id")?.value;
    return this.downloadRemote(id, remotePath, !!isDirectory);
  },

  async downloadRemote(id, remotePath, isDirectory) {
    if (!id) return;
    if (this._xferBusy) return toast("A transfer is already in progress", "warn");
    const localDir = await api.openFileDialog({ properties: ["openDirectory"] });
    if (!localDir) return;
    const name = remotePath.split("/").pop();
    const dest = localDir.replace(/[\\/]+$/, "") + "/" + name;
    const localInfo = await api.sftpStatLocal(dest);
    if (localInfo.exists) {
      const message = isDirectory
        ? `"${name}" folder already exists locally.\n\nMerge contents? Existing files inside will be overwritten.`
        : `"${name}" already exists locally (${this._fmtSize(localInfo.size)}).\n\nOverwrite?`;
      if (!confirm(message)) return;
    }
    this._xferDirection = "download";
    this._xferReset();
    this._xferShow(true);
    this._xferBusy = true;
    this._xferConnId = id;
    this._xferSetBusy(true);
    this._xferSetMeta(isDirectory ? "Scanning folder..." : "Preparing download...", "0 / 0", 0);
    try {
      const result = await api.sftpDownloadBatch(id, [{ remotePath, localPath: dest, isDirectory: !!isDirectory, name }]);
      const downloaded = result.downloaded || 0;
      const failed = result.failed || 0;
      if (result.cancelled) toast("Download stopped", "warn");
      else if (result.disconnect) toast("Connection lost during download", "error");
      else if (downloaded && !failed) toast(`Downloaded ${downloaded} file(s)`, "success");
      else if (downloaded) toast(`Downloaded ${downloaded} file(s), ${failed} failed`, "warn");
      else toast(result.message || "Download failed", "error");
    } finally {
      this._xferBusy = false;
      this._xferSetBusy(false);
    }
  },

  async uploadFromDialog() {
    const localFile = await api.openFileDialog({ properties: ["openFile", "multiSelections"] });
    if (!localFile) return;
    const files = Array.isArray(localFile) ? localFile : [localFile];
    const id = document.getElementById("sftp-browser-conn-id").value;
    await this._uploadLocalPaths(id, files, this._currentPath, () => this._loadDir());
  },

  async uploadFolderDialog() {
    const localDir = await api.openFileDialog({ properties: ["openDirectory"] });
    if (!localDir) return;
    const id = document.getElementById("sftp-browser-conn-id").value;
    await this._uploadLocalPaths(id, [localDir], this._currentPath, () => this._loadDir());
  },

  async _uploadLocalPaths(id, localPaths, remoteDir, onDone) {
    if (this._xferBusy) return toast("A transfer is already in progress", "warn");
    this._xferDirection = "upload";
    const jobs = [];
    this._xferReset();
    this._xferShow(true);
    this._xferSetMeta("Checking files...", "0 / 0", 0);

    for (const localPath of localPaths) {
      const info = await api.sftpStatLocal(localPath);
      if (!info.exists) {
        this._xferAddRow("skip-" + localPath, localPath, "fail", "Not found");
        continue;
      }
      const name = info.name;
      const remotePath = (remoteDir.replace(/\/+$/, "") || "") + "/" + name;
      const exists = await api.sftpCheckExists(id, remotePath);
      if (exists.exists) {
        if (exists.isDirectory && !info.isDirectory) {
          this._xferAddRow("skip-" + name, name, "fail", "Cannot overwrite a folder with a file");
          continue;
        }
        if (!exists.isDirectory && info.isDirectory) {
          this._xferAddRow("skip-" + name, name, "fail", "Cannot overwrite a file with a folder");
          continue;
        }
        const message = info.isDirectory
          ? `"${name}" folder already exists on the server.\n\nMerge contents? Existing files inside will be overwritten.`
          : `"${name}" already exists on server (${this._fmtSize(exists.size)}).\n\nOverwrite?`;
        if (!confirm(message)) {
          this._xferAddRow("skip-" + name, name, "skip", "Skipped");
          continue;
        }
      }
      jobs.push({ localPath, remotePath });
    }

    if (!jobs.length) {
      this._xferSetMeta("Nothing to upload", "0 / 0", 0);
      return;
    }

    this._xferBusy = true;
    this._xferConnId = id;
    this._xferOnDone = onDone;
    this._xferSetBusy(true);
    this._xferSetMeta("Uploading...", "0 / ?", 0);
    try {
      const result = await api.sftpUploadBatch(id, jobs);
      const uploaded = result.uploaded || 0;
      const failed = result.failed || 0;
      if (result.cancelled) toast("Upload stopped", "warn");
      else if (result.disconnect) toast("Connection lost during upload", "error");
      else if (uploaded && !failed) toast(`Uploaded ${uploaded} file(s)`, "success");
      else if (uploaded) toast(`Uploaded ${uploaded} file(s), ${failed} failed`, "warn");
      else toast(result.message || "Upload failed", "error");
      if (uploaded > 0 && onDone) await onDone();
    } finally {
      this._xferBusy = false;
      this._xferSetBusy(false);
    }
  },

  async stopUpload() {
    if (this._xferDirection === "delete") return;
    await api.sftpUploadCancel();
    this._xferSetMeta("Stopping...", null, null);
  },

  toggleTransfer(collapse) {
    this._xferEls("root").forEach((el) => {
      el.classList.toggle("is-collapsed", collapse !== false);
    });
  },

  async retryUpload(index) {
    const job = this._xferFiles?.[index];
    if (!job || this._xferBusy) return;
    const id = this._xferConnId;
    if (!id) return;
    this._xferBusy = true;
    this._xferSetBusy(true);
    this._xferUpdateRow(index, job.name, "pending");
    try {
      const download = this._xferDirection === "download" || job.direction === "download";
      const result = download
        ? await api.sftpDownloadBatch(id, [{ ...job, index, isDirectory: false }], { retry: true })
        : await api.sftpUploadBatch(id, [{ ...job, index }], { retry: true });
      if (result.success && this._xfer) {
        this._xfer.ok++;
        this._xfer.fail = Math.max(0, (this._xfer.fail || 0) - 1);
      }
      if (result.success && this._xferOnDone) await this._xferOnDone();
      if (!result.success) toast(result.message || "Retry failed", "error");
    } finally {
      this._xferBusy = false;
      this._xferSetBusy(false);
    }
  },

  _xferPanels() {
    return [
      { root: "sftp-xfer", label: "sftp-xfer-label", count: "sftp-xfer-count", bar: "sftp-xfer-bar", current: "sftp-xfer-current", list: "sftp-xfer-list" },
      { root: "sftp-term-xfer", label: "sftp-term-xfer-label", count: "sftp-term-xfer-count", bar: "sftp-term-xfer-bar", current: "sftp-term-xfer-current", list: "sftp-term-xfer-list" },
    ];
  },

  _xferEls(key) {
    return this._xferPanels().map((panel) => document.getElementById(panel[key])).filter(Boolean);
  },

  _xferShow(visible) {
    this._xferEls("root").forEach((el) => { el.style.display = visible ? "" : "none"; });
  },

  _xferReset() {
    this._xfer = { total: 0, done: 0, ok: 0, fail: 0 };
    this._xferFiles = {};
    this._xferEls("root").forEach((el) => el.classList.remove("is-collapsed", "is-busy"));
    this._xferEls("list").forEach((el) => { el.innerHTML = ""; });
    this._xferEls("current").forEach((el) => { el.textContent = ""; });
    this._xferEls("bar").forEach((el) => { el.style.width = "0%"; });
  },

  _xferSetBusy(busy) {
    this._xferEls("root").forEach((el) => el.classList.toggle("is-busy", !!busy));
  },

  _xferSetMeta(label, count, pct) {
    this._xferEls("label").forEach((el) => { el.textContent = label; });
    if (count != null) this._xferEls("count").forEach((el) => { el.textContent = count; });
    if (pct != null) this._xferEls("bar").forEach((el) => { el.style.width = Math.max(0, Math.min(100, pct)) + "%"; });
  },

  _xferAddRow(id, name, status, detail) {
    const html = this._xferRowHtml(id, name, status, detail);
    this._xferEls("list").forEach((el) => { el.insertAdjacentHTML("afterbegin", html); });
  },

  _xferRowHtml(id, name, status, detail) {
    const downloading = this._xferDirection === "download";
    const map = {
      pending: { cls: "sftp-xfer-pending", icon: "fa-spinner fa-spin", text: downloading ? "Downloading" : "Uploading" },
      ok: { cls: "sftp-xfer-ok", icon: "fa-check", text: "Done" },
      fail: { cls: "sftp-xfer-fail", icon: "fa-times", text: detail || "Failed" },
      skip: { cls: "sftp-xfer-skip", icon: "fa-minus", text: detail || "Skipped" },
    };
    const meta = map[status] || map.pending;
    const retry = status === "fail" && this._xferFiles?.[id]
      ? `<button class="btn btn-ghost btn-xs sftp-xfer-retry" title="Retry" onclick="SFTP.retryUpload(${Number(id)})"><i class="fas fa-redo"></i></button>`
      : "";
    return `<div class="sftp-xfer-row" data-xfer-id="${this._esc(String(id))}">
      <span class="sftp-xfer-status ${meta.cls}"><i class="fas ${meta.icon}"></i> ${this._esc(meta.text)}</span>
      <span class="sftp-xfer-name" title="${this._esc(name)}">${this._esc(name)}</span>
      ${retry}
    </div>`;
  },

  _xferUpdateRow(id, name, status, detail) {
    const html = this._xferRowHtml(id, name, status, detail);
    this._xferEls("list").forEach((list) => {
      const row = list.querySelector(`[data-xfer-id="${CSS.escape(String(id))}"]`);
      if (row) row.outerHTML = html;
      else list.insertAdjacentHTML("afterbegin", html);
    });
  },

  _onUploadProgress(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type?.startsWith("delete-")) return this._onDeleteProgress(msg);
    if (msg.direction === "download") this._xferDirection = "download";
    else if (msg.direction === "upload") this._xferDirection = "upload";
    const downloading = this._xferDirection === "download";
    const verb = downloading ? "Downloading" : "Uploading";
    const doneVerb = downloading ? "Downloaded" : "Uploaded";
    this._xferShow(true);
    if (msg.localPath && msg.remotePath && msg.index) {
      this._xferFiles ||= {};
      this._xferFiles[msg.index] = {
        localPath: msg.localPath,
        remotePath: msg.remotePath,
        name: msg.name,
        direction: this._xferDirection,
      };
    }
    if (msg.type === "batch-start") {
      this._xfer = { total: msg.total || 0, done: 0, ok: 0, fail: 0 };
      this._xferSetBusy(true);
      this._xferSetMeta(msg.total ? `${verb} 0 / ${msg.total} files` : `No files to ${downloading ? "download" : "upload"}`, `0 / ${msg.total || 0}`, 0);
    }
    if (msg.type === "file-start") {
      this._xferUpdateRow(msg.index, msg.name, "pending");
      this._xferEls("current").forEach((el) => { el.textContent = msg.name || ""; });
      this._xferSetMeta(`${verb} ${msg.index} / ${msg.total} files`, `${this._xfer?.ok || 0} done · ${this._xfer?.fail || 0} failed`, msg.total ? ((msg.index - 1) / msg.total) * 100 : 0);
    }
    if (msg.type === "file-progress") {
      const total = msg.total || this._xfer?.total || 0;
      const bytesTotal = msg.bytesTotal || 0;
      const transferred = msg.transferred || 0;
      const fileFrac = bytesTotal ? Math.min(1, transferred / bytesTotal) : 0;
      const pct = total ? ((Math.max(0, (msg.index || 1) - 1) + fileFrac) / total) * 100 : fileFrac * 100;
      const sizeText = bytesTotal ? ` · ${this._fmtSize(transferred)} / ${this._fmtSize(bytesTotal)}` : "";
      this._xferEls("current").forEach((el) => { el.textContent = `${msg.name || ""}${sizeText}`; });
      this._xferSetMeta(`${verb} ${msg.index} / ${total} files`, `${this._xfer?.ok || 0} done · ${this._xfer?.fail || 0} failed`, pct);
    }
    if (msg.type === "file-done") {
      if (this._xfer && !msg.retry) {
        if (msg.success) this._xfer.ok++;
        else this._xfer.fail++;
        this._xfer.done = msg.index;
      }
      this._xferUpdateRow(msg.index, msg.name, msg.success ? "ok" : "fail", msg.message);
      const total = this._xfer?.total || msg.total || 0;
      const ok = this._xfer?.ok || 0;
      const fail = this._xfer?.fail || 0;
      this._xferSetMeta(`${verb} ${msg.index} / ${total} files`, `${ok} done · ${fail} failed`, total ? (Math.max(ok + fail, msg.index) / total) * 100 : 0);
    }
    if (msg.type === "batch-end") {
      const uploaded = msg.downloaded || msg.uploaded || 0;
      const failed = msg.failed || 0;
      const total = msg.total || 0;
      this._xferSetBusy(false);
      let label = `${doneVerb} ${uploaded} file(s)`;
      let current = downloading ? "All files downloaded" : "All files uploaded";
      if (msg.cancelled) {
        label = downloading ? "Download stopped" : "Upload stopped";
        current = downloading ? "Remaining files were not downloaded" : "Remaining files were not uploaded";
      } else if (msg.disconnect) {
        label = "Connection lost";
        current = "Reconnect, then retry failed files";
      } else if (failed) {
        label = `Finished with ${failed} failed file(s)`;
        current = "Retry failed files or hide this panel";
      }
      this._xferSetMeta(label, `${uploaded} / ${total}`, 100);
      this._xferEls("current").forEach((el) => { el.textContent = current; });
      if (!failed && !msg.cancelled && !msg.disconnect) this.toggleTransfer(true);
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

  _onDeleteProgress(msg) {
    this._xferShow(true);
    this._xferSetBusy(true);
    this._xferDirection = "delete";
    if (msg.type === "delete-start") {
      this._xferReset();
      this._xferDirection = "delete";
      const label = msg.isDirectory
        ? `Deleting folder "${msg.name}"...`
        : `Deleting "${msg.name}"...`;
      this._xferSetMeta(label, "", msg.isDirectory ? 0 : 50);
      this._xferEls("current").forEach((el) => {
        el.textContent = msg.isDirectory ? "Removing contents..." : "";
      });
    }
    if (msg.type === "delete-progress") {
      const count = msg.deleted || 0;
      const current = msg.current ? msg.current.split("/").pop() : "";
      this._xferSetMeta(`Deleting... ${count} item(s) removed`, `${count} deleted`, null);
      this._xferEls("current").forEach((el) => {
        el.textContent = current ? `Removing: ${current}` : "";
      });
    }
    if (msg.type === "delete-done") {
      this._xferSetBusy(false);
      if (msg.success) {
        this._xferSetMeta(`Deleted "${msg.name}"`, "Done", 100);
        this._xferEls("current").forEach((el) => { el.textContent = "Removed successfully"; });
        setTimeout(() => this.toggleTransfer(true), 1200);
      } else {
        this._xferSetMeta("Delete failed", msg.message || "Error", 0);
        this._xferEls("current").forEach((el) => { el.textContent = msg.message || ""; });
      }
    }
  },

  async _deleteRemote(id, remotePath, isDirectory, onDone) {
    if (this._deleteBusy) {
      toast("A delete operation is already in progress", "warn");
      return;
    }
    const name = remotePath.split("/").pop();
    if (!confirm(`Delete ${isDirectory ? "folder" : "file"} "${name}"?`)) return;
    this._deleteBusy = true;
    try {
      const r = await api.sftpDelete(id, remotePath, isDirectory);
      if (r.success) {
        toast("Deleted: " + name, "success");
        if (onDone) await onDone();
      } else {
        toast("Delete failed: " + r.message, "error");
      }
    } finally {
      this._deleteBusy = false;
    }
  },

  createDirPrompt() { this.openRemoteCreate("browser", "folder"); },

  async deleteItem(remotePath, isDirectory) {
    const id = document.getElementById("sftp-browser-conn-id").value;
    return this._deleteRemote(id, remotePath, isDirectory, () => this._loadDir());
  },

  renameItem(remotePath, isDirectory) {
    this.openRemoteRename("browser", remotePath, !!isDirectory);
  },

  _focusRenameInput(input, name, isDirectory) {
    if (!input) return;
    input.value = name;
    input.focus();
    const dot = isDirectory ? -1 : name.lastIndexOf(".");
    const end = dot > 0 ? dot : name.length;
    input.setSelectionRange(0, end);
  },

  _clearRemoteSelectionVisual() {
    document.querySelectorAll(".remote-row-selected").forEach((el) => el.classList.remove("remote-row-selected"));
  },

  _clearRemoteSelection() {
    this._clearRemoteSelectionVisual();
    this._remoteSelection = null;
  },

  _setRemoteSelection(row, scope) {
    if (!row) return;
    this._clearRemoteSelectionVisual();
    row.classList.add("remote-row-selected");
    this._remoteSelection = {
      scope,
      path: decodeURIComponent(row.dataset.remotePath),
      isDirectory: row.dataset.remoteType === "directory",
    };
  },

  _applyRemoteSelectionHighlight(container) {
    if (!this._remoteSelection || !container) return;
    const selectedPath = this._remoteSelection.path;
    const row = [...container.querySelectorAll("[data-remote-path]")].find(
      (el) => decodeURIComponent(el.dataset.remotePath) === selectedPath,
    );
    if (row) row.classList.add("remote-row-selected");
  },

  _bindRemoteListEvents(zone, scope) {
    if (zone.dataset.remoteListBound === scope) return;
    zone.dataset.remoteListBound = scope;

    zone.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      const row = e.target.closest("[data-remote-path]");
      if (!row || !zone.contains(row)) return;
      this._setRemoteSelection(row, scope);
    });

    zone.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      const row = e.target.closest("[data-remote-path]");
      if (!row || !zone.contains(row) || row.dataset.remoteType !== "directory") return;
      e.preventDefault();
      if (scope === "terminal") this.termEnterPath(row.dataset.remotePath);
      else this.enterDir(decodeURIComponent(row.dataset.remoteName));
    });
  },

  _setupRemoteKeyboard() {
    if (this._remoteKeyboardSetup) return;
    this._remoteKeyboardSetup = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "F2") return;
      if (document.getElementById("m-sftp-rename")?.classList.contains("open")) return;
      if (e.target.matches("input, textarea, select, [contenteditable=true]")) return;

      const inBrowser = document.getElementById("m-sftp-browser")?.classList.contains("open");
      const inTerminal = document.getElementById("m-sftp-terminal")?.classList.contains("open");
      if (!inBrowser && !inTerminal) return;

      e.preventDefault();
      const scope = inTerminal ? "terminal" : "browser";
      const sel = this._remoteSelection;
      if (!sel || sel.scope !== scope) {
        toast("Select a file or folder first", "warn");
        return;
      }
      this.openRemoteRename(sel.scope, sel.path, sel.isDirectory);
    });
  },

  openRemoteRename(scope, remotePath, isDirectory) {
    const name = remotePath.split("/").pop() || "";
    const parent = remotePath.slice(0, -(name.length + 1)) || "/";
    document.getElementById("sftp-rename-scope").value = scope;
    document.getElementById("sftp-rename-path").value = remotePath;
    document.getElementById("sftp-rename-title").textContent = `Rename "${name}"`;
    document.getElementById("sftp-rename-location").textContent = `Location: ${parent}`;
    document.getElementById("sftp-rename-name").value = name;
    document.getElementById("sftp-rename-error").style.display = "none";
    document.getElementById("sftp-rename-submit").disabled = false;
    openModal("m-sftp-rename");
    setTimeout(() => {
      this._focusRenameInput(
        document.getElementById("sftp-rename-name"),
        name,
        !!isDirectory,
      );
    }, 50);
  },

  async submitRemoteRename() {
    const scope = document.getElementById("sftp-rename-scope").value;
    const remotePath = document.getElementById("sftp-rename-path").value;
    const newName = document.getElementById("sftp-rename-name").value.trim();
    const errorEl = document.getElementById("sftp-rename-error");
    if (!this._validRemoteName(newName)) return;
    const oldName = remotePath.split("/").pop();
    if (newName === oldName) {
      closeModal("m-sftp-rename");
      return;
    }
    const id = document.getElementById(scope === "terminal" ? "sftp-term-conn-id" : "sftp-browser-conn-id").value;
    const button = document.getElementById("sftp-rename-submit");
    button.disabled = true;
    button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Renaming...';
    errorEl.style.display = "none";
    let result;
    try {
      result = await api.sftpRename(id, remotePath, newName);
    } catch (error) {
      result = { success: false, message: error.message || "The operation failed" };
    }
    button.disabled = false;
    button.innerHTML = '<i class="fas fa-check"></i> Rename';
    if (!result.success) {
      errorEl.textContent = result.message || "The server rejected the operation";
      errorEl.style.display = "block";
      return;
    }
    closeModal("m-sftp-rename");
    toast("Renamed to " + newName, "success");
    if (scope === "terminal") await this.loadTermFiles();
    else await this._loadDir();
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
    const errEl = document.getElementById("sftp-editor-error");
    if (errEl) { errEl.style.display = "none"; errEl.textContent = ""; }

    const langInfo = await api.sftpDetectLanguage(remotePath).catch(() => ({ language: "plaintext" }));
    const language = langInfo.language || "plaintext";
    const langEl = document.getElementById("sftp-editor-lang");
    if (langEl) langEl.textContent = language.toUpperCase();

    openModal("m-sftp-editor");
    const mount = document.getElementById("sftp-editor-monaco");
    if (mount && window.ShieldPressMonaco) {
      try {
        await ShieldPressMonaco.mount(mount, {
          value: r.content,
          language,
          onCursor: ({ line, column }) => {
            const cursor = document.getElementById("sftp-editor-cursor");
            if (cursor) cursor.textContent = `Ln ${line}, Col ${column}`;
          },
        });
        this._monacoReady = true;
      } catch (err) {
        this._monacoReady = false;
        mount.innerHTML = "";
        const ta = document.getElementById("sftp-editor-content");
        if (ta) ta.style.display = "block";
        toast("Monaco unavailable, using plain editor", "warn");
      }
    }
  },

  cancelFileEdit() {
    try { ShieldPressMonaco?.dispose(); } catch {}
    this._monacoReady = false;
    closeModal("m-sftp-editor");
  },

  async openExternal(remotePath) {
    const id = document.getElementById("sftp-browser-conn-id").value;
    const fileName = remotePath.split("/").pop();
    toast(`Opening ${fileName} in external editor...`, "info");
    const r = await api.sftpOpenExternal(id, remotePath);
    if (r.success) toast(r.message, "success");
    else toast("Failed: " + r.message, "error");
  },

  async saveFileEdit(closeAfterSave = false) {
    const id = document.getElementById("sftp-editor-conn-id").value;
    const remotePath = document.getElementById("sftp-editor-path").value;
    const content = this._monacoReady && window.ShieldPressMonaco
      ? ShieldPressMonaco.getValue()
      : document.getElementById("sftp-editor-content").value;
    document.getElementById("sftp-editor-content").value = content;

    const r = await api.sftpWriteFile(id, remotePath, content);
    const errEl = document.getElementById("sftp-editor-error");
    if (!r.success) {
      if (r.code === "VALIDATION_ERROR") {
        const msg = `Syntax Error\n\n${r.line ? `Line ${r.line}\n` : ""}${r.message || "Validation failed"}`;
        if (errEl) {
          errEl.style.display = "block";
          errEl.innerHTML = `<strong>⚠ Syntax Error</strong><div style="margin-top:6px;white-space:pre-wrap">${this._esc(r.message || "")}${r.line ? `\nLine ${r.line}` : ""}</div><button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="document.getElementById('sftp-editor-error').style.display='none'">Back to Editor</button>`;
        }
        if (this._monacoReady && r.line) {
          ShieldPressMonaco.setMarkers([{
            startLineNumber: r.line, startColumn: 1,
            endLineNumber: r.line, endColumn: 1e5,
            message: r.message || "Syntax error",
            severity: 8,
          }]);
          ShieldPressMonaco.revealLine(r.line);
        }
        toast("Fix syntax errors before saving", "error");
        return;
      }
      toast("Save failed: " + r.message, "error");
      return;
    }
    if (errEl) errEl.style.display = "none";
    toast(r.backupPath ? `File saved (backup: ${r.backupPath})` : "File saved!", "success");
    if (document.getElementById("sftp-browser-conn-id")?.value) await this._loadDir();
    if (document.getElementById("sftp-term-conn-id")?.value) await this.loadTermFiles();
    if (closeAfterSave) {
      try { ShieldPressMonaco?.dispose(); } catch {}
      this._monacoReady = false;
      closeModal("m-sftp-editor");
    }
  },

  getRemoteContext(target) {
    const terminalBrowser = target?.closest?.("[data-terminal-remote-browser]");
    const regularBrowser = target?.closest?.("[data-remote-browser]");
    const termModalOpen = document.getElementById("m-sftp-terminal")?.classList.contains("open");
    const browserModalOpen = document.getElementById("m-sftp-browser")?.classList.contains("open");
    const inTerminal = !!terminalBrowser && (this._sessionMode || termModalOpen);
    const inBrowser = !!regularBrowser && (this._sessionMode || browserModalOpen);
    if (!inTerminal && !inBrowser) return null;
    const row = target.closest("[data-remote-path]");
    const scope = inTerminal ? "terminal" : "browser";
    const currentPath = inTerminal ? this._termPath : this._currentPath;
    if (row) this._setRemoteSelection(row, scope);
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

  _bindHorizontalScroll(el) {
    if (!el || el.dataset.hscrollBound) return;
    el.dataset.hscrollBound = "1";
    el.addEventListener("wheel", (e) => {
      if (!e.shiftKey) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    }, { passive: false });
  },

  contextOpenFolder(encodedPath) {
    this._currentPath = decodeURIComponent(encodedPath);
    this._saveCurrentPath();
    this._loadDir();
  },

  contextDownload(encodedPath, isDirectory) { return this.downloadItem(decodeURIComponent(encodedPath), !!isDirectory); },
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

  contextProperties(encodedPath, isDirectory) {
    return this.showRemoteProperties(decodeURIComponent(encodedPath), "browser", !!isDirectory);
  },

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

  contextRename(encodedPath, isDirectory) {
    return this.openRemoteRename("browser", decodeURIComponent(encodedPath), !!isDirectory);
  },

  contextDelete(encodedPath, isDirectory) {
    return this.deleteItem(decodeURIComponent(encodedPath), isDirectory);
  },

  contextRefresh() { return this._loadDir(); },

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
    toast("Opening Terminal window…", "info");
    const r = await api.sftpOpenWindow("terminal", id);
    if (!r.success) {
      if (!(await this._handleVaultLocked(r, () => this.openTerminal(id)))) {
        toast("Open failed: " + r.message, "error");
      }
      return;
    }
    this._connStatus[id] = "connected";
    await this.load();
  },

  async _startInteractiveTerminal(connectionKey, preferredShellSessionId = null) {
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
      scrollback: 2000,
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

    let shellSessionId = preferredShellSessionId;
    this._xtermDataDisposable = this._xterm.onData((data) => {
      if (shellSessionId) api.sftpShellWrite(shellSessionId, data);
    });
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
      if (shellSessionId) api.sftpShellResize(shellSessionId, this._xterm.cols, this._xterm.rows);
    });
    this._resizeObserver.observe(container);

    const result = await api.sftpShellStart(
      connectionKey,
      this._xterm.cols,
      this._xterm.rows,
      preferredShellSessionId || undefined,
    );
    if (!result.success) {
      this._activeShellId = null;
      this._xterm.writeln(`\x1b[31mSSH shell failed: ${result.message}\x1b[0m`);
    } else {
      shellSessionId = result.sessionId;
      this._activeShellId = result.sessionId;
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
    this._termItems = r.items || [];
    this._renderTermFiles();
  },

  sortTermFiles(key) {
    if (this._termSortKey === key) this._termSortDir *= -1;
    else {
      this._termSortKey = key;
      this._termSortDir = key === "modified" ? -1 : 1;
    }
    this._renderTermFiles();
  },

  _termSortMarker(key) {
    if (this._termSortKey !== key) return "";
    return this._termSortDir > 0 ? " ▲" : " ▼";
  },

  _renderTermFiles() {
    const listEl = document.getElementById("sftp-term-files");
    if (!listEl) return;
    let items = [...(this._termItems || [])];
    if (!items.length) {
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text3);font-size:12px">Empty directory</div>';
      return;
    }
    items.sort((a, b) => {
      const aDir = this._isDir(a);
      const bDir = this._isDir(b);
      if (aDir !== bDir) return aDir ? -1 : 1;
      let cmp = 0;
      if (this._termSortKey === "modified") cmp = String(a.modified || "").localeCompare(String(b.modified || ""));
      else if (this._termSortKey === "size") cmp = (a.size || 0) - (b.size || 0);
      else if (this._termSortKey === "permissions") cmp = String(a.permissions || "").localeCompare(String(b.permissions || ""));
      else if (this._termSortKey === "owner") {
        cmp = `${a.owner || ""}/${a.group || ""}`.localeCompare(`${b.owner || ""}/${b.group || ""}`);
      }
      else cmp = String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
      return cmp * this._termSortDir;
    });

    const base = this._termPath;
    const th = (key, label, align = "left") =>
      `<th style="padding:7px 6px;text-align:${align};cursor:pointer;user-select:none" onclick="SFTP.sortTermFiles('${key}')">${label}${this._termSortMarker(key)}</th>`;
    const rows = items.map((item) => {
      const fullPath = base.replace(/\/+$/, "") + "/" + item.name;
      const encoded = encodeURIComponent(fullPath);
      const isDir = item.isDirectory || item.type === "directory";
      const editable = !isDir && /\.(php|html|css|js|json|txt|xml|yml|yaml|conf|ini|env|htaccess|md|sh|py|rb|sql|log|csv|twig)$/i.test(item.name);
      const icon = isDir ? (item.isLink ? "fa-link" : "fa-folder") : (item.isLink ? "fa-link" : "fa-file");
      const chmod = String(item.permissions || "").match(/\((\d{3,4})\)/)?.[1] || item.permissions || "—";
      const ownerGroup = (item.owner || item.group)
        ? `${item.owner || "—"}/${item.group || "—"}`
        : "—";
      const action = isDir
        ? `SFTP.termEnterPath('${encoded}')`
        : editable ? `SFTP.termEditFile('${encoded}')` : `SFTP.copyRemotePath(decodeURIComponent('${encoded}'))`;
      return `<tr style="border-bottom:1px solid var(--border)" title="${this._esc(fullPath)}" data-remote-path="${encoded}" data-remote-name="${encodeURIComponent(item.name)}" data-remote-type="${isDir ? "directory" : "file"}" data-remote-editable="${editable}">
        <td style="padding:6px 8px;overflow:hidden">
          <button class="btn btn-ghost btn-xs" style="width:100%;min-width:0;justify-content:flex-start;overflow:hidden" onclick="${action}">
            <i class="fas ${icon}" style="color:${isDir ? "var(--yellow)" : "var(--text3)"};flex-shrink:0"></i>
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(item.name)}</span>
          </button>
        </td>
        <td style="padding:6px;color:var(--text3);text-align:right;white-space:nowrap">${isDir ? "—" : this._fmtSize(item.size)}</td>
        <td style="padding:6px;color:var(--text3);white-space:nowrap;font-size:11px">${item.modified ? new Date(item.modified).toLocaleString("vi-VN") : "—"}</td>
        <td style="padding:6px;color:var(--accent);font-family:var(--mono);text-align:center" title="${this._esc(item.permissions || "")}">${this._esc(chmod)}</td>
        <td style="padding:6px;color:var(--text2);font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(ownerGroup)}">${this._esc(ownerGroup)}</td>
        <td style="padding:5px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-xs" onclick="SFTP.copyRemotePath(decodeURIComponent('${encoded}'))" title="Copy path"><i class="fas fa-copy"></i></button>
          <button class="btn btn-ghost btn-xs" onclick="SFTP.termContextDownload('${encoded}',${isDir})" title="Download"><i class="fas fa-download"></i></button>
          ${editable ? `<button class="btn btn-ghost btn-xs" onclick="SFTP.termEditFile('${encoded}')" title="Edit"><i class="fas fa-edit"></i></button>` : ""}
          <button class="btn btn-ghost btn-xs" onclick="SFTP.termRenameItem('${encoded}',${isDir})" title="Rename (F2)"><i class="fas fa-i-cursor"></i></button>
          <button class="btn btn-ghost btn-xs" style="color:var(--red)" onclick="SFTP.termDeleteItem('${encoded}',${isDir})" title="Delete"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
    }).join("");
    listEl.innerHTML = `<table style="width:100%;min-width:860px;border-collapse:collapse;table-layout:fixed;font-size:11px">
      <colgroup>
        <col style="width:200px"><col style="width:70px"><col style="width:120px">
        <col style="width:65px"><col style="width:120px"><col style="width:140px">
      </colgroup>
      <thead style="position:sticky;top:0;z-index:1;background:var(--bg2)">
        <tr style="color:var(--text3);border-bottom:1px solid var(--border)">
          ${th("name", "Name")}
          ${th("size", "Size", "right")}
          ${th("modified", "Modified")}
          ${th("permissions", "Perm", "center")}
          ${th("owner", "User/Group")}
          <th style="padding:7px 6px;text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
    this._applyRemoteSelectionHighlight(listEl);
    this._bindHorizontalScroll(listEl);
  },

  termEnterPath(encodedPath) {
    this._clearRemoteSelection();
    this._termPath = decodeURIComponent(encodedPath);
    api.sftpSaveLastPath(document.getElementById("sftp-term-conn-id").value, this._termPath);
    this.loadTermFiles();
  },

  termBrowseUp() {
    this._clearRemoteSelection();
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
    const id = document.getElementById("sftp-term-conn-id").value;
    return this._deleteRemote(id, remotePath, isDirectory, () => this.loadTermFiles());
  },

  termRenameItem(encodedPath, isDirectory) {
    return this.openRemoteRename("terminal", decodeURIComponent(encodedPath), !!isDirectory);
  },

  termContextOpenFolder(encodedPath) { return this.termEnterPath(encodedPath); },
  termContextEdit(encodedPath) { return this.termEditFile(encodedPath); },
  termContextDelete(encodedPath, isDirectory) { return this.termDeleteItem(encodedPath, isDirectory); },
  termContextRefresh() { return this.loadTermFiles(); },

  termContextProperties(encodedPath, isDirectory) {
    return this.showRemoteProperties(decodeURIComponent(encodedPath), "terminal", !!isDirectory);
  },

  showRemoteProperties(remotePath, scope, isDirectory) {
    const items = scope === "terminal" ? (this._termItems || []) : (this._browserItems || []);
    const currentPath = scope === "terminal" ? this._termPath : this._currentPath;
    const name = remotePath.split("/").pop() || remotePath;
    const item = items.find((entry) => entry.name === name);
    const type = isDirectory || this._isDir(item) ? "Folder" : "File";
    const details = [
      `Name: ${name}`,
      `Path: ${remotePath}`,
      `Type: ${type}`,
    ];
    if (item) {
      if (!isDirectory && item.size != null) details.push(`Size: ${this._fmtSize(item.size)}`);
      if (item.modified) details.push(`Modified: ${new Date(item.modified).toLocaleString("vi-VN")}`);
      if (item.permissions) details.push(`Permissions: ${item.permissions}`);
      if (item.owner || item.group) details.push(`User/Group: ${item.owner || "—"}/${item.group || "—"}`);
    } else if (currentPath) {
      details.push(`Location: ${currentPath}`);
    }
    toast(details.join("\n"), "info", 7000);
  },

  async termContextDownload(encodedPath, isDirectory) {
    const id = document.getElementById("sftp-term-conn-id").value;
    return this.downloadRemote(id, decodeURIComponent(encodedPath), !!isDirectory);
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

  termContextRename(encodedPath, isDirectory) {
    return this.openRemoteRename("terminal", decodeURIComponent(encodedPath), !!isDirectory);
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

  _formatSizeKb(kb) {
    if (kb == null || Number.isNaN(kb) || kb <= 0) return "";
    const units = [
      { size: 1073741824, suffix: "T" },
      { size: 1048576, suffix: "G" },
      { size: 1024, suffix: "M" },
      { size: 1, suffix: "K" },
    ];
    for (const unit of units) {
      if (kb >= unit.size) {
        const value = kb / unit.size;
        const text = value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
        return text + unit.suffix;
      }
    }
    return "0K";
  },

  _metricExtra(text) {
    return text ? ` · ${text}` : "";
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
    const cores = stats?.cpuCores > 0 ? `${stats.cpuCores} core` : "";
    const ramSize = this._formatSizeKb(stats?.ramTotalKb);
    const diskSize = this._formatSizeKb(stats?.diskTotalKb);
    const ramTitle = stats?.ramTotalKb
      ? `RAM ${this._formatSizeKb(stats.ramUsedKb)} / ${ramSize}`
      : "RAM usage";
    const diskTitle = stats?.diskTotalKb
      ? `Disk ${this._formatSizeKb(stats.diskUsedKb)} / ${diskSize}`
      : "Disk usage (/)";
    el.innerHTML = `
      <span class="sftp-term-metric" style="color:${cpuColor}" title="CPU usage${cores ? ` · ${cores}` : ""}"><i class="fas fa-microchip"></i> CPU ${this._formatPct(cpu)}${this._metricExtra(cores)}</span>
      <span class="sftp-term-metric" style="color:${ramColor}" title="${ramTitle}"><i class="fas fa-memory"></i> RAM ${this._formatPct(ram)}${this._metricExtra(ramSize)}</span>
      <span class="sftp-term-metric" style="color:${diskColor}" title="${diskTitle}"><i class="fas fa-hdd"></i> Disk ${this._formatPct(disk)}${this._metricExtra(diskSize)}</span>
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
    this._metricsTimer = setInterval(() => this._refreshRemoteMetrics(id), 5000);
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

  async termUploadFolder() {
    const selected = await api.openFileDialog({ properties: ["openDirectory"] });
    if (!selected) return;
    await this._termUploadPaths([selected]);
  },

  async _termUploadPaths(paths) {
    const id = document.getElementById("sftp-term-conn-id").value;
    await this._uploadLocalPaths(id, paths, this._termPath, () => this.loadTermFiles());
  },

  termCreateDir() { this.openRemoteCreate("terminal", "folder"); },

  _setupTermDragDrop() {
    const zone =
      document.querySelector('[data-drop-zone="terminal"]')
      || document.getElementById("sftp-term-files")?.closest("aside")
      || document.getElementById("sftp-term-files");
    if (!zone) return;
    this._bindFileDropZone(zone, async (paths) => {
      await this._termUploadPaths(paths);
    });
    const list = document.getElementById("sftp-term-files");
    if (list) this._bindRemoteListEvents(list, "terminal");
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
        const isDir = item.isDirectory || item.type === "directory";
        const completedToken = typedDir + item.name + (isDir ? "/" : "");
        return {
          value: before + completedToken,
          label: completedToken,
          kind: isDir ? "folder" : "file",
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
