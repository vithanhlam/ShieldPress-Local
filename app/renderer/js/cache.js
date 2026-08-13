// renderer/js/cache.js

window.CacheManager = {
  async init() {
    await this._fillProjects();
    await this.loadOpcacheStatus();
    await RedisManager.init();
  },

  async _fillProjects() {
    const projects = await api.getProjects();
    ["cache-wp-project", "cache-clean-project"].forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.innerHTML = '<option value="">-- Select project --</option>';
      projects.forEach((p) => {
        // WP select: only wordpress/php types
        if (id === "cache-wp-project" && p.projectType !== "wordpress" && p.projectType !== "php") return;
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = `${p.name} (${p.projectType})`;
        sel.appendChild(o);
      });
    });
  },

  async refreshAll() {
    await this.loadOpcacheStatus();
    await RedisManager.init();
    toast("Cache status refreshed", "info");
  },

  // ── OPcache ──────────────────────────────────────────────────────────────────
  async loadOpcacheStatus() {
    const info = document.getElementById("opcache-info");
    const badge = document.getElementById("opcache-status-badge");
    if (!info) return;

    const r = await api.invoke("cache-opcache-status");
    if (r.enabled) {
      badge.textContent = "Enabled";
      badge.style.background = "rgba(34,197,94,0.12)";
      badge.style.color = "var(--green)";
      const rows = (r.versions || []).map(v => `
        <tr>
          <td style="color:var(--text3);padding-right:16px">PHP ${v.version}</td>
          <td style="${v.enabled ? "color:var(--green)" : "color:var(--red)"}">${v.enabled ? "✓ Enabled" : "✗ Disabled"}</td>
          <td style="color:var(--text2)">${v.memory} MB RAM</td>
          <td style="color:var(--text2)">max ${v.maxFiles} files</td>
          <td style="color:var(--text2)">revalidate ${v.revalidate}s</td>
        </tr>`).join("");
      info.innerHTML = `<table style="font-size:12px;border-collapse:collapse">${rows}</table>
        <div style="font-size:11px;color:var(--text3);margin-top:6px"><i class="fas fa-info-circle"></i> Runtime stats require a web request — config values shown.</div>`;
      document.getElementById("opcache-toggle-label").textContent = "Disable";
    } else {
      badge.textContent = "Disabled";
      badge.style.background = "rgba(239,68,68,0.08)";
      badge.style.color = "var(--red)";
      info.innerHTML = 'OPcache is not enabled. Enable it in php.ini for better performance.';
      document.getElementById("opcache-toggle-label").textContent = "Enable";
    }
  },

  async opcacheReset() {
    const r = await api.invoke("cache-opcache-reset");
    if (r.success) {
      toast("PHP-CGI restarted — OPcache cleared", "success");
      await this.loadOpcacheStatus();
    } else toast("Failed: " + r.message, "error");
  },

  async toggleOpcache() {
    const r = await api.invoke("cache-opcache-toggle");
    if (r.success) {
      toast(r.message, "success");
      await this.loadOpcacheStatus();
    } else toast("Failed: " + r.message, "error");
  },

  // ── WordPress Cache ──────────────────────────────────────────────────────────
  async loadWpCache() {
    const id = document.getElementById("cache-wp-project")?.value;
    const info = document.getElementById("cache-wp-info");
    if (!id) { info.innerHTML = ""; return; }

    info.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking...';
    const r = await api.invoke("cache-wp-status", id);
    if (r.isWordPress) {
      const cacheSize = r.cacheSize || "0 KB";
      info.innerHTML = `
        <div><i class="fas fa-check-circle" style="color:var(--green)"></i> WordPress detected</div>
        <div style="margin-top:4px">Cache directory size: <strong>${cacheSize}</strong></div>
        ${r.objectCache ? '<div style="margin-top:4px"><i class="fas fa-database" style="color:var(--accent)"></i> Object cache: <strong>' + r.objectCache + '</strong></div>' : ''}
      `;
    } else {
      info.innerHTML = '<i class="fas fa-times-circle" style="color:var(--red)"></i> Not a WordPress project (wp-config.php not found)';
    }
  },

  async wpCacheFlush() {
    const id = document.getElementById("cache-wp-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    const r = await api.invoke("cache-wp-flush", id);
    toast(r.success ? "WordPress cache flushed" : ("Failed: " + r.message), r.success ? "success" : "error");
  },

  async wpTransientFlush() {
    const id = document.getElementById("cache-wp-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    const r = await api.invoke("cache-wp-transients", id);
    toast(r.success ? `Deleted ${r.count || 0} transients` : ("Failed: " + r.message), r.success ? "success" : "error");
  },

  async wpRewriteFlush() {
    const id = document.getElementById("cache-wp-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    const r = await api.invoke("cache-wp-rewrite", id);
    toast(r.success ? "Rewrite rules flushed" : ("Failed: " + r.message), r.success ? "success" : "error");
  },

  // ── Project Cache Cleanup ────────────────────────────────────────────────────
  async cleanProjectCache() {
    const id = document.getElementById("cache-clean-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    const log = document.getElementById("cache-clean-log");
    log.style.display = "block";
    log.textContent = "Cleaning cache directories...\n";
    const r = await api.invoke("cache-clean-project", id);
    log.textContent += r.output || (r.success ? "Done!" : "Failed: " + r.message);
    toast(r.success ? `Cleaned ${r.freedMB || 0} MB` : "Failed: " + r.message, r.success ? "success" : "error");
  },

  async cleanNodeModules() {
    const id = document.getElementById("cache-clean-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    if (!confirm("Delete node_modules? You will need to run 'npm install' again.")) return;
    const log = document.getElementById("cache-clean-log");
    log.style.display = "block";
    log.textContent = "Deleting node_modules...\n";
    const r = await api.invoke("cache-clean-dir", { id, dir: "node_modules" });
    log.textContent += r.success ? `Deleted! Freed ${r.freedMB || 0} MB` : "Failed: " + r.message;
    toast(r.success ? `Freed ${r.freedMB || 0} MB` : "Failed", r.success ? "success" : "error");
  },

  async cleanVendor() {
    const id = document.getElementById("cache-clean-project")?.value;
    if (!id) { toast("Select a project", "warn"); return; }
    if (!confirm("Delete vendor? You will need to run 'composer install' again.")) return;
    const log = document.getElementById("cache-clean-log");
    log.style.display = "block";
    log.textContent = "Deleting vendor...\n";
    const r = await api.invoke("cache-clean-dir", { id, dir: "vendor" });
    log.textContent += r.success ? `Deleted! Freed ${r.freedMB || 0} MB` : "Failed: " + r.message;
    toast(r.success ? `Freed ${r.freedMB || 0} MB` : "Failed", r.success ? "success" : "error");
  },

  // ── Nginx & PHP ──────────────────────────────────────────────────────────────
  async restartNginx() {
    toast("Restarting Nginx...", "info");
    const r = await api.restartNginx();
    toast(r.success ? "Nginx restarted" : "Failed", r.success ? "success" : "error");
  },

  async restartPhp() {
    toast("Restarting PHP...", "info");
    const r = await api.restartPhp();
    toast(r.success !== false ? "PHP restarted" : "Failed", r.success !== false ? "success" : "error");
  },

  async clearNginxLogs() {
    const r = await api.invoke("cache-clear-nginx-logs");
    toast(r.success ? `Cleared ${r.count} log files` : "Failed", r.success ? "success" : "error");
  },
};

// ── Redis Manager ─────────────────────────────────────────────────────────────
window.RedisManager = {
  async init() {
    const info    = await api.getRedisInfo();
    const badge   = document.getElementById("redis-status-badge");
    const infoEl  = document.getElementById("redis-info");
    const notInst = document.getElementById("redis-not-installed");
    const controls= document.getElementById("redis-controls");
    const portIn  = document.getElementById("redis-port-input");

    if (!info.installed) {
      if (badge)   { badge.textContent = "Not installed"; badge.style.background = "var(--bg3)"; badge.style.color = "var(--text3)"; }
      if (infoEl)  infoEl.textContent = "";
      if (notInst) notInst.style.display = "";
      if (controls) controls.style.display = "none";
      return;
    }

    if (notInst) notInst.style.display = "none";
    if (controls) controls.style.display = "flex";

    // Show Redis row in sidebar
    const svcRow = document.getElementById("svc-row-redis");
    if (svcRow) svcRow.style.display = "";

    if (!info.running) {
      if (badge)  { badge.textContent = "Stopped"; badge.style.background = "rgba(234,67,53,0.12)"; badge.style.color = "var(--red)"; }
      if (infoEl) infoEl.innerHTML = `<i class="fas fa-circle" style="color:var(--red);font-size:8px"></i> Redis is installed but not running. Port: <strong>${info.port || 6379}</strong>`;
      if (portIn) portIn.value = info.port || 6379;
      return;
    }

    if (badge)  { badge.textContent = "Running"; badge.style.background = "rgba(34,197,94,0.12)"; badge.style.color = "var(--green)"; }
    if (portIn) portIn.value = info.port || 6379;
    if (infoEl) infoEl.innerHTML = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 16px;font-size:12px">
        <span style="color:var(--text3)">Version</span><span>${info.version || "—"}</span>
        <span style="color:var(--text3)">Port</span><span>:${info.port || 6379}</span>
        <span style="color:var(--text3)">Uptime</span><span>${info.uptime ? Math.floor(info.uptime / 60) + " min" : "—"}</span>
        <span style="color:var(--text3)">Clients</span><span>${info.connected_clients || "—"}</span>
        <span style="color:var(--text3)">Memory</span><span>${info.used_memory_human || "—"}</span>
      </div>`;
  },

  async download() {
    const btn = document.getElementById("redis-download-btn");
    const log = document.getElementById("redis-download-log");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Downloading...'; }
    if (log) { log.style.display = ""; log.textContent = ""; }

    api.onRedisDownloadProgress((msg) => {
      if (!log) return;
      log.textContent += msg + "\n";
      log.scrollTop = log.scrollHeight;
    });

    const r = await api.downloadRedis();

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-download"></i> Download Redis for Windows'; }

    if (r.success) {
      toast("Redis installed!", "success");
      await this.init();
    } else {
      toast("Download failed: " + r.message, "error");
    }
  },

  async flush() {
    if (!confirm("Flush ALL Redis keys? This will clear all cached data.")) return;
    const r = await api.flushRedis();
    toast(r.success ? r.message : "Failed: " + r.message, r.success ? "success" : "error");
  },

  async savePort() {
    const port = parseInt(document.getElementById("redis-port-input")?.value, 10);
    if (!port || port < 1024 || port > 65535) { toast("Invalid port (1024-65535)", "warn"); return; }
    const r = await api.setRedisPort(port);
    toast(r.success ? `Redis port set to ${port} (restart to apply)` : "Failed: " + r.message,
          r.success ? "success" : "error");
  },
};
