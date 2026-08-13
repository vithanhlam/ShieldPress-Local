// renderer/js/database.js

window.Database = {
  async load() {
    const el = document.getElementById("db-list");
    if (!el) return;
    await this.loadPortSetting();
    if (!App.serviceStatus.mariadb) {
      el.innerHTML =
        '<div class="empty-state"><i class="fas fa-database"></i><p>MariaDB is not running</p></div>';
      return;
    }
    el.innerHTML =
      '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';
    const r = await api.listDatabases();
    if (!r.success) {
      el.innerHTML = `<div class="empty-state"><p>${r.message}</p></div>`;
      return;
    }
    if (r.databases.length === 0) {
      el.innerHTML =
        '<div class="empty-state"><i class="fas fa-database"></i><p>No databases</p></div>';
      return;
    }

    this._bindProgress();
    const details = r.databaseDetails || r.databases.map((name) => ({ name, tables: 0, size: 0 }));
    el.innerHTML = details
      .map(
        (db) => `
<div class="db-row">
  <i class="fas fa-database"></i>
  <span class="db-name" style="flex:1">${db.name}</span>
  <div style="display:flex;align-items:center;gap:8px;color:var(--text3);font-size:12px;flex:1 1 220px;flex-wrap:wrap;justify-content:flex-end">
    ${db.isWordPress ? '<span class="tag"><i class="fab fa-wordpress"></i> WordPress</span>' : ""}
    <span><i class="fas fa-table"></i> ${db.tables} tables</span>
    <span style="min-width:72px;text-align:right">${fmtBytes(db.size)}</span>
  </div>
  <div class="db-actions">
    <button class="btn btn-sm btn-ghost" data-db-export="${db.name}" onclick="Database.export('${db.name}')"><i class="fas fa-download"></i> Export</button>
    <button class="btn btn-sm btn-danger-ghost" onclick="Database.confirmDrop('${db.name}')"><i class="fas fa-trash"></i></button>
  </div>
</div>`,
      )
      .join("");
  },

  async create() {
    const name = document.getElementById("new-db-name")?.value.trim();
    if (!name) {
      toast("DB name required", "warn");
      return;
    }
    const r = await api.createDatabase(name);
    if (r.success) {
      toast(`Database "${name}" created`, "success");
      document.getElementById("new-db-name").value = "";
      this.load();
    } else toast("Create failed: " + r.message, "error");
  },

  async export(dbName) {
    this._bindProgress();
    const button = [...document.querySelectorAll("[data-db-export]")].find((el) => el.dataset.dbExport === dbName);
    if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Exporting...'; }
    this._showProgress(`Exporting ${dbName}...`, 0, 0, 0);
    const r = await api.exportDatabase({ dbName });
    if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-download"></i> Export'; }
    if (r.success) {
      toast(`Exported ${fmtBytes(r.size || 0)}`, "success");
      const folder = document.getElementById("db-operation-folder");
      folder.dataset.path = r.path;
      folder.style.display = "inline-flex";
    } else toast("Export failed: " + r.message, "error");
  },

  async importDialog() {
    openModal("m-import-db");
    await new Promise((r) => setTimeout(r, 50));

    const sel = document.getElementById("import-db-sel");
    if (!sel) return;

    sel.innerHTML = '<option value="">Loading...</option>';

    // Không check mariadb status, gọi thẳng
    try {
      const dbResult = await api.listDatabases();
      const dbs = dbResult.databases || [];
      sel.innerHTML = '<option value="">-- Select Database --</option>';
      dbs.forEach((d) => {
        const o = document.createElement("option");
        o.value = d;
        o.textContent = d;
        sel.appendChild(o);
      });
    } catch (e) {
      sel.innerHTML = '<option value="">-- MariaDB is not running --</option>';
    }
  },

  async doImport() {
    const sel = document.getElementById("import-db-sel");
    const newDb = document.getElementById("import-db-new")?.value.trim();
    const dbName = sel?.value || newDb;
    if (!dbName) {
      toast("Select a database", "warn");
      return;
    }

    const file = await api.openImportDialog();
    if (!file) return;

    closeModal("m-import-db");

    this._bindProgress();
    this._showProgress(`Importing ${dbName}...`, 0, 0, 0);
    toast(`Importing ${dbName}...`, "info", 120000);

    const r = await api.importDatabase({ dbName, filePath: file });
    if (r.success) {
      toast(`✅ Import successful: ${dbName}`, "success", 5000);
      this.load();
    } else {
      toast(`❌ Import failed: ${r.message}`, "error", 8000);
    }
  },

  _bindProgress() {
    if (this._progressBound) return;
    this._progressBound = true;
    api.onDatabaseProgress((data) => {
      const action = data.operation === "import" ? "Importing" : "Exporting";
      this._showProgress(`${action} ${data.dbName}${data.status === "done" ? " complete" : "..."}`, data.percent, data.processed, data.total);
    });
  },

  _showProgress(label, percent, processed, total) {
    const panel = document.getElementById("db-operation-progress");
    if (!panel) return;
    panel.style.display = "block";
    document.getElementById("db-operation-label").textContent = label;
    document.getElementById("db-operation-bar").style.width = `${percent ?? 15}%`;
    document.getElementById("db-operation-bytes").textContent = total
      ? `${fmtBytes(processed || 0)} / ${fmtBytes(total)} (${percent ?? 0}%)`
      : fmtBytes(processed || 0);
    if ((percent || 0) < 100) document.getElementById("db-operation-folder").style.display = "none";
  },

  async loadPortSetting() {
    const input = document.getElementById("db-port-input");
    if (!input) return;
    const r = await api.getMariaDBPort();
    if (r.success) input.value = r.port;
    const status = document.getElementById("db-port-status");
    if (status) status.textContent = `Current: :${r.port}`;
  },

  async savePort() {
    const input = document.getElementById("db-port-input");
    const port = parseInt(input?.value, 10);
    if (!port || port < 1024 || port > 65535) {
      toast("Invalid port (1024–65535)", "warn");
      return;
    }
    const r = await api.setMariaDBPort(port);
    if (r.success) {
      toast(`Port set to ${port}. Restart MariaDB to apply.`, "success");
      const status = document.getElementById("db-port-status");
      if (status) status.textContent = `Saved: :${port} (restart to apply)`;
    } else {
      toast("Save failed: " + r.message, "error");
    }
  },

  async reload() {
    const btn = document.getElementById("db-reload-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reloading...'; }
    toast("Restarting MariaDB...", "info");
    try {
      const r = await api.restartMariaDB();
      toast(r?.success !== false ? "MariaDB restarted" : "Restart failed: " + (r.message || ""), r?.success !== false ? "success" : "error");
      await this.load();
    } catch (e) {
      toast("Reload error: " + e.message, "error");
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Reload DB'; }
  },

  confirmDrop(dbName) {
    document.getElementById("drop-db-name").value = dbName;
    document.getElementById("drop-db-display").textContent = dbName;
    openModal("m-drop-db");
  },

  async doDrop() {
    const name = document.getElementById("drop-db-name").value;
    closeModal("m-drop-db");
    // Drop directly, NO auto-backup
    const r = await api.dropDatabase(name);
    if (r.success) {
      toast(`Database "${name}" dropped`, "info");
      this.load();
    } else toast("Drop failed: " + r.message, "error");
  },
};

// ── Database Terminal ─────────────────────────────────────────────────────────
window.DbTerminal = {
  _history: [],
  _historyIdx: -1,

  keyDown(event) {
    if (event.key === "Enter" && !event.isComposing) {
      this.exec();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (this._history.length && this._historyIdx < this._history.length - 1) {
        this._historyIdx++;
        document.getElementById("db-term-cmd").value =
          this._history[this._history.length - 1 - this._historyIdx] || "";
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (this._historyIdx > 0) {
        this._historyIdx--;
        document.getElementById("db-term-cmd").value =
          this._history[this._history.length - 1 - this._historyIdx] || "";
      } else {
        this._historyIdx = -1;
        document.getElementById("db-term-cmd").value = "";
      }
    }
  },

  quick(sql) {
    document.getElementById("db-term-cmd").value = sql;
    this.exec();
  },

  clear() {
    document.getElementById("db-term-output").textContent = "";
  },

  async exec() {
    const cmdEl = document.getElementById("db-term-cmd");
    const sql = cmdEl.value.trim();
    if (!sql) return;

    // Save history
    if (!this._history.length || this._history[this._history.length - 1] !== sql) {
      this._history.push(sql);
    }
    this._historyIdx = -1;
    cmdEl.value = "";

    const out = document.getElementById("db-term-output");
    out.textContent += "mysql> " + sql + "\n";

    if (!App.serviceStatus.mariadb) {
      out.textContent += "ERROR: MariaDB is not running. Start MariaDB first.\n\n";
      out.scrollTop = out.scrollHeight;
      return;
    }

    const r = await api.execRawSql(sql);
    if (r.success) {
      out.textContent += (r.output || "(OK)") + "\n\n";
    } else {
      out.textContent += "ERROR: " + r.message + "\n\n";
    }
    out.scrollTop = out.scrollHeight;
    cmdEl.focus();
  },
};
