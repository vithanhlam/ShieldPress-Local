window.StorageSettings = {
  async init() {
    const dataDir = await api.getDataDir();
    const el = document.getElementById("current-data-dir");
    if (el) el.textContent = dataDir || "C:/ShieldPress_Project/data";
  },

  async browseDataDir() {
    const dir = await api.openFileDialog({ properties: ["openDirectory"] });
    if (dir) {
      document.getElementById("data-dir-input").value = dir;
    }
  },

  async saveDataDir() {
    const newPath = document.getElementById("data-dir-input")?.value.trim();
    if (!newPath) return toast("Enter a path", "warn");
    if (!confirm(`Change Data folder to:\n${newPath}\n\nApp will restart. Continue?`)) return;

    // The main process validates and commits this atomically.
    const r = await api.setDataDir(newPath);
    if (!r.success) return toast("Failed: " + r.message, "error");

    toast("Data folder updated. Restarting...", "success");
    setTimeout(() => api.restartApp(), 1500);
  }
};

window.PhpPathSettings = {
  async init() {
    const el = document.getElementById("php-path-detected");
    if (!el) return;
    try {
      const config = await api.getConfig();
      const customPath = config.php_cli_path || "";
      const binDir = await api.getBinDir();
      const bundledPath = `${binDir}\\php\\...\\php.exe`;
      if (customPath) {
        el.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> Custom: <strong>${customPath}</strong>`;
        document.getElementById("php-path-input").value = customPath;
      } else {
        el.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> Using bundled PHP <span style="color:var(--text2);font-size:11px">(${bundledPath})</span>`;
      }
    } catch {
      el.innerHTML = '<i class="fas fa-info-circle" style="color:var(--text3)"></i> Using bundled PHP';
    }
  },

  async browse() {
    const file = await api.openFileDialog({
      properties: ["openFile"],
      filters: [{ name: "PHP Executable", extensions: ["exe"] }],
    });
    if (file) document.getElementById("php-path-input").value = file;
  },

  async save() {
    const phpPath = document.getElementById("php-path-input")?.value.trim() || "";
    try {
      const config = await api.getConfig();
      config.php_cli_path = phpPath;
      await api.saveConfig(config);

      // Add PHP dir to Windows PATH via IPC
      const r = await api.setPhpPath(phpPath);
      if (r.success) {
        toast(r.message || "PHP path applied to system PATH", "success");
      } else {
        toast(phpPath ? "Config saved. Note: " + r.message : "PHP path reset to bundled", "info");
      }
      await this.init();
    } catch (e) {
      toast("Failed: " + e.message, "error");
    }
  },
};

window.EditorSettings = {
  async init() {
    const el = document.getElementById("editor-detected");
    if (!el) return;
    try {
      const editor = await api.getDetectedEditor();
      const config = await api.getConfig();
      const customPath = config.editor_path || "";
      el.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> Current: <strong>${editor.name}</strong> <span style="color:var(--text2);font-size:11px">(${editor.cmd})</span>`;
      const input = document.getElementById("editor-path-input");
      if (input && customPath) input.value = customPath;
    } catch {
      el.innerHTML = '<i class="fas fa-times-circle" style="color:var(--red)"></i> Could not detect editor';
    }
  },

  async browse() {
    const file = await api.openFileDialog({
      properties: ["openFile"],
      filters: [{ name: "Executable", extensions: ["exe"] }],
    });
    if (file) document.getElementById("editor-path-input").value = file;
  },

  async save() {
    const editorPath = document.getElementById("editor-path-input")?.value.trim() || "";
    const r = await api.setEditorPath(editorPath);
    if (r.success) {
      toast(editorPath ? "Custom editor saved" : "Editor reset to auto-detect", "success");
      await this.init();
    } else {
      toast("Failed: " + r.message, "error");
    }
  }
};

// ── GitHub Settings ──────────────────────────────────────────────────────────
window.GitHubSettings = {
  async init() {
    const badge = document.getElementById("gh-status-badge");
    const status = document.getElementById("gh-config-status");
    if (!badge) return;

    const r = await api.invoke("github-get-config");
    if (r.configured) {
      badge.textContent = "Connected";
      badge.style.background = "rgba(34,197,94,0.12)";
      badge.style.color = "var(--green)";
      document.getElementById("gh-username").value = r.username || "";
      document.getElementById("gh-email").value = r.email || "";
      document.getElementById("gh-token").value = "";
      document.getElementById("gh-token").placeholder = "Token saved (leave empty to keep)";
      if (status) {
        status.style.display = "block";
        status.innerHTML = `<i class="fas fa-check-circle" style="color:var(--green)"></i> Connected as <strong>${r.username}</strong>`;
      }
    } else {
      badge.textContent = "Not configured";
      badge.style.background = "var(--bg3)";
      badge.style.color = "var(--text3)";
      if (status) status.style.display = "none";
    }
  },

  toggleToken() {
    const input = document.getElementById("gh-token");
    const eye = document.getElementById("gh-token-eye");
    if (input.type === "password") {
      input.type = "text";
      eye.className = "fas fa-eye-slash";
    } else {
      input.type = "password";
      eye.className = "fas fa-eye";
    }
  },

  async save() {
    const username = document.getElementById("gh-username")?.value.trim();
    const email = document.getElementById("gh-email")?.value.trim();
    const token = document.getElementById("gh-token")?.value.trim();
    const result = document.getElementById("gh-test-result");

    if (!username) { toast("GitHub username required", "warn"); return; }

    result.innerHTML = '<i class="fas fa-spinner fa-spin" style="color:var(--accent)"></i> Testing...';

    const r = await api.invoke("github-save-config", { username, email, token });
    if (r.success) {
      if (r.verified) {
        result.innerHTML = '<i class="fas fa-check-circle" style="color:var(--green)"></i> Connected!';
        toast("GitHub configured successfully!", "success");
      } else {
        result.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:var(--yellow)"></i> Saved (token not verified)';
        toast("Config saved. Token could not be verified — check it if push fails.", "info");
      }
      await this.init();
    } else {
      result.innerHTML = '<i class="fas fa-times-circle" style="color:var(--red)"></i> ' + r.message;
      toast("Failed: " + r.message, "error");
    }
  },

  async clear() {
    if (!confirm("Remove GitHub credentials?")) return;
    await api.invoke("github-clear-config");
    document.getElementById("gh-username").value = "";
    document.getElementById("gh-email").value = "";
    document.getElementById("gh-token").value = "";
    document.getElementById("gh-token").placeholder = "ghp_xxxxxxxxxxxxxxxxxxxx";
    document.getElementById("gh-test-result").innerHTML = "";
    toast("GitHub credentials cleared", "info");
    await this.init();
  },
};

// ── Cloud Backup Folder Settings ──────────────────────────────────────────────
window.GDriveSettings = {
  async init() {
    const banner = document.getElementById("gdrive-status-banner");
    if (!banner) return;

    try {
      // Load status + detected folders
      const [status, detected] = await Promise.all([
        api.gdriveGetStatus(),
        api.gdriveDetectFolders(),
      ]);

      // Show detected cloud folders as quick-pick buttons
      const detWrap = document.getElementById("gdrive-detected-wrap");
      const detList = document.getElementById("gdrive-detected-list");
      if (detList && detected?.length) {
        detList.innerHTML = detected.map(d =>
          `<button class="btn btn-ghost btn-sm" style="justify-content:flex-start;font-family:var(--mono);font-size:11px"
            onclick="GDriveSettings.useDetected('${d.path.replace(/\\/g, "\\\\")}')">
            <i class="fas fa-cloud" style="color:#4285F4;margin-right:6px"></i> ${d.label}: <span style="color:var(--text3);margin-left:4px">${d.path}</span>
          </button>`
        ).join("");
        if (detWrap) detWrap.style.display = "";
      }

      // Populate folder input with saved value
      const input = document.getElementById("gdrive-folder-input");
      if (input && status.backupFolder) input.value = status.backupFolder;

      this._updateBanner(status);
    } catch (e) {
      if (banner) banner.innerHTML = '<i class="fas fa-exclamation-circle" style="color:var(--red)"></i> Error loading backup settings';
    }
  },

  _updateBanner(status) {
    const banner = document.getElementById("gdrive-status-banner");
    if (!banner) return;
    if (!status.configured) {
      banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:var(--bg3);color:var(--text2)";
      banner.innerHTML = '<i class="fas fa-info-circle"></i> No backup folder set yet. Select or enter a folder below.';
    } else if (!status.exists) {
      banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(234,179,8,0.1);color:#eab308";
      banner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Folder not found: <code style="font-size:11px">${status.backupFolder}</code>`;
    } else {
      banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(52,168,83,0.1);color:var(--green)";
      banner.innerHTML = `<i class="fas fa-check-circle"></i> Backup folder: <code style="font-size:11px;color:var(--green)">${status.backupFolder}</code>`;
    }
  },

  useDetected(folderPath) {
    const input = document.getElementById("gdrive-folder-input");
    if (input) input.value = folderPath;
  },

  async browseFolder() {
    const dir = await api.openFileDialog({ properties: ["openDirectory"] });
    if (dir) {
      document.getElementById("gdrive-folder-input").value = dir;
    }
  },

  async saveFolder() {
    const folder = document.getElementById("gdrive-folder-input")?.value.trim();
    if (!folder) { toast("Enter a folder path", "warn"); return; }
    const r = await api.gdriveSaveFolder(folder);
    if (r.success) {
      toast("Backup folder saved", "success");
      const status = await api.gdriveGetStatus();
      this._updateBanner(status);
    } else {
      toast("Failed: " + (r.message || "Unknown"), "error");
    }
  },
};

// ── Paths Card ────────────────────────────────────────────────────────────────
window.PathsCard = {
  copy(elId) {
    const text = document.getElementById(elId)?.textContent?.trim();
    if (!text || text === "Loading...") return toast("Path not loaded yet", "warn");
    navigator.clipboard.writeText(text).then(() => toast("Copied!", "success", 1500));
  },
  open(elId) {
    const text = document.getElementById(elId)?.textContent?.trim();
    if (!text || text === "Loading...") return toast("Path not loaded yet", "warn");
    api.openFolder(text);
  },
};
