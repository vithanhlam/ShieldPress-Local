// renderer/js/wordpress.js

window.WordPress = {
  _debugEnabled: false,

  async init(id) {
    // Reset output
    const outEl = document.getElementById("wpcli-output");
    if (outEl) {
      outEl.textContent = "";
      outEl.style.display = "none";
    }

    // WordPress installed state
    const proj       = App.projects.find(x => x.id === id);
    const installed  = !!proj?.wordpressInstalled;
    const installBtn = document.getElementById("wp-install-btn");
    const alreadyEl  = document.getElementById("wp-already");
    if (installBtn) installBtn.style.display = installed ? "none" : "";
    if (alreadyEl)  alreadyEl.style.display  = installed ? ""     : "none";

    // Load WP users for dropdowns
    this._loadUsers(id);

    // Check WP-CLI binary
    const bins = await api.checkBinaries();
    const missingEl = document.getElementById("wpcli-missing");
    const readyEl = document.getElementById("wpcli-ready");
    if (bins.wpcli) {
      if (missingEl) missingEl.style.display = "none";
      if (readyEl) readyEl.style.display = "block";
    } else {
      if (missingEl) missingEl.style.display = "block";
      if (readyEl) readyEl.style.display = "none";
      // Reset download button
      const dlBtn = document.getElementById("wpcli-dl-btn");
      if (dlBtn) {
        dlBtn.disabled = false;
        dlBtn.innerHTML = '<i class="fas fa-download"></i> Download WP-CLI';
      }
    }

    // Read debug state from wp-config.php
    const dr = await api.getWpDebugState({ id });
    this._debugEnabled = dr.success ? dr.enabled : false;
    this._updateDebugBtn();

    // Show/hide "Open debug.log" button based on whether debug is on
    this._updateDebugLogBtn();
  },

  _updateDebugBtn() {
    const icon = document.getElementById("wp-debug-icon");
    const label = document.getElementById("wp-debug-label");
    if (this._debugEnabled) {
      if (icon) icon.className = "fas fa-toggle-on";
      if (label) label.textContent = "Debug ON — Off";
    } else {
      if (icon) icon.className = "fas fa-toggle-off";
      if (label) label.textContent = "Debug OFF — On";
    }
  },

  _updateDebugLogBtn() {
    const btn = document.getElementById("wp-debug-log-btn");
    if (btn) btn.style.display = this._debugEnabled ? "inline-flex" : "none";
  },

  async install() {
    const id  = document.getElementById("wp-proj-id")?.value;
    const btn = document.getElementById("wp-install-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...'; }
    toast("Installing WordPress... this may take a minute", "info", 8000);

    const r = await api.installWordPress({ id });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-wordpress"></i> Install WordPress (latest)'; }

    if (r.success) {
      toast("WordPress installed!", "success");
      // Show installed state
      if (btn) btn.style.display = "none";
      const alreadyEl = document.getElementById("wp-already");
      if (alreadyEl) alreadyEl.style.display = "";
      await Projects.load();
      closeModal("m-wordpress");
      api.openBrowser(r.installUrl);
    } else {
      toast("Install failed: " + r.message, "error");
    }
  },

  confirmReinstall() {
    if (!confirm(
      "WordPress is already installed.\n\n" +
      "Reinstalling will overwrite all WordPress core files and wp-config.php.\n" +
      "Your database and wp-content folder will NOT be deleted.\n\n" +
      "Continue with reinstall?"
    )) return;
    this._reinstall();
  },

  async _reinstall() {
    const id  = document.getElementById("wp-proj-id")?.value;
    const btn = document.getElementById("wp-reinstall-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reinstalling...'; }
    toast("Reinstalling WordPress... please wait", "info", 10000);

    const r = await api.installWordPress({ id, force: true });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-redo"></i> Reinstall'; }

    if (r.success) {
      toast("WordPress reinstalled successfully!", "success");
      await Projects.load();
      closeModal("m-wordpress");
      api.openBrowser(r.installUrl);
    } else {
      toast("Reinstall failed: " + r.message, "error");
    }
  },

  async _loadUsers(id) {
    const sel = document.getElementById("wp-reset-user");
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading...</option>';
    sel.disabled = true;
    const r = await api.wpGetUsers(id);
    if (r.success && r.users.length) {
      sel.innerHTML = r.users
        .map((u) => `<option value="${u.id}">${u.login} — ${u.name}</option>`)
        .join("");
      sel.disabled = false;
    } else {
      sel.innerHTML = '<option value="">No users found</option>';
    }
  },

  async resetPassword() {
    const id = document.getElementById("wp-proj-id")?.value;
    const userId = document.getElementById("wp-reset-user")?.value;
    const pwd = document.getElementById("wp-new-pass")?.value.trim();
    if (!pwd) { toast("Enter new password", "warn"); return; }
    if (!userId) { toast("Select a user first", "warn"); return; }
    const r = await api.wpResetPassword({ id, userId, newPassword: pwd });
    toast(
      r.success ? "Password reset OK" : "Failed: " + r.message,
      r.success ? "success" : "error",
    );
  },

  async toggleDebug() {
    const id = document.getElementById("wp-proj-id")?.value;
    const enable = !this._debugEnabled;
    const r = await api.wpToggleDebug({ id, enable });
    if (r.success) {
      this._debugEnabled = enable;
      this._updateDebugBtn();
      this._updateDebugLogBtn();
      toast(`Debug ${enable ? "enabled" : "disabled"}`, "success");
    } else {
      toast("Failed: " + (r.message || ""), "error");
    }
  },

  async openDebugLog() {
    const id = document.getElementById("wp-proj-id")?.value;
    const r = await api.getWpDebugLog(id);
    if (r.success) {
      api.openFolder(r.filePath);
    } else {
      toast("debug.log not found — enable debug and reload the site first", "warn", 5000);
    }
  },

  // WP-CLI
  async runCli() {
    const id = document.getElementById("wp-proj-id")?.value;
    const cmd = document.getElementById("wpcli-cmd")?.value.trim();
    if (!cmd) {
      toast("Enter WP-CLI command", "warn");
      return;
    }

    const outEl = document.getElementById("wpcli-output");
    if (outEl) {
      outEl.textContent = "⏳ Running...";
      outEl.style.display = "block";
    }

    const r = await api.wpCli({ id, command: cmd });

    if (outEl) {
      outEl.textContent = r.output || (r.success ? "(no output)" : "Error");
      outEl.className = "cli-output " + (r.success ? "" : "error");
    }
  },

  quickCmd(cmd) {
    const el = document.getElementById("wpcli-cmd");
    if (el) {
      el.value = cmd;
      this.runCli();
    }
  },

  async downloadCli() {
    const btn = document.getElementById("wpcli-dl-btn");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Downloading...';
    }
    toast("Downloading WP-CLI...", "info", 10000);

    const r = await api.downloadWpCli();

    if (r.success) {
      toast("WP-CLI downloaded!", "success");
      // Re-init to show WP-CLI UI
      const id = document.getElementById("wp-proj-id")?.value;
      await this.init(id);
    } else {
      toast("Download failed: " + (r.message || ""), "error");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-download"></i> Download WP-CLI';
      }
    }
  },
};
