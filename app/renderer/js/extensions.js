// renderer/js/extensions.js

window.Extensions = {
  _data: [],
  _listening: false,

  async init() {
    await PhpVersions.populateSelect("ext-php-ver", "8.3");
    if (!this._listening) {
      api.onIoncubeProgress((msg) => {
        const pre = document.getElementById("ext-ioncube-progress");
        if (!pre) return;
        pre.style.display = "";
        pre.textContent += msg + "\n";
        pre.scrollTop = pre.scrollHeight;
      });
      this._listening = true;
    }
    await this.loadPhpVersionsList();
    await this.load();
  },

  async load() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    const list = document.getElementById("ext-list");
    if (list) list.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>';

    const r = await api.getExtensions(ver);
    if (!r.success) {
      if (list) list.innerHTML = '<p style="color:var(--red)">Failed to load extensions</p>';
      return;
    }

    this._data = r.extensions;
    const ioncube = this._data.find((e) => e.id === "ioncube");
    const others = this._data.filter((e) => e.id !== "ioncube");

    // Update ionCube card
    this._renderIoncube(ioncube);

    // Group by category
    const groups = {};
    for (const e of others) {
      const cat = e.cat || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(e);
    }

    const catIcons = {
      Database: "fa-database", Core: "fa-microchip", Image: "fa-image",
      Archive: "fa-file-archive", Network: "fa-globe", i18n: "fa-language",
      Performance: "fa-tachometer-alt", Debug: "fa-bug", Security: "fa-lock",
      Misc: "fa-puzzle-piece", Custom: "fa-cube",
    };

    const catOrder = ["Database", "Core", "Image", "Archive", "Network", "i18n", "Performance", "Debug", "Security", "Misc", "Custom"];
    let html = "";

    for (const cat of catOrder) {
      const exts = groups[cat];
      if (!exts || !exts.length) continue;

      const installedCount = exts.filter((e) => e.installed).length;
      const enabledCount = exts.filter((e) => e.enabled).length;
      const icon = catIcons[cat] || "fa-cube";
      const isCustom = cat === "Custom";

      html += `
<div class="card" style="margin-bottom:12px">
  <div class="card-hdr" style="cursor:pointer" onclick="this.parentElement.querySelector('.card-body').classList.toggle('collapsed')">
    <span class="card-title"><i class="fas ${icon}" style="color:${isCustom ? '#e07b1a' : 'var(--accent)'};width:18px"></i> ${cat}${isCustom ? ' Extensions' : ''}</span>
    <span style="font-size:12px;color:var(--text3)">${enabledCount}/${installedCount} enabled</span>
  </div>
  <div class="card-body${isCustom ? '' : ''}" style="padding:0">`;

      for (const e of exts) {
        const statusText = !e.installed ? "Not installed" : e.enabled ? "ON" : "OFF";
        const btnStyle = !e.installed
          ? 'opacity:0.4;cursor:not-allowed'
          : e.enabled
            ? 'background:rgba(34,197,94,0.15);color:var(--green);border-color:rgba(34,197,94,0.3)'
            : 'background:rgba(239,68,68,0.08);color:var(--red);border-color:rgba(239,68,68,0.2)';

        html += `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-weight:600;font-size:13px;color:var(--text1)">${e.name}</span>
          ${e.zend ? '<span style="font-size:9px;background:var(--bg4);color:var(--text3);padding:1px 5px;border-radius:3px">ZEND</span>' : ""}
          ${e.custom ? '<span style="font-size:9px;background:rgba(224,123,26,0.15);color:#e07b1a;padding:1px 5px;border-radius:3px">CUSTOM</span>' : ""}
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">${e.description || e.id}</div>
      </div>
      <button class="btn btn-sm" style="min-width:85px;font-weight:600;${btnStyle};border:1px solid"
        ${!e.installed ? "disabled" : ""}
        onclick="Extensions.toggle('${e.id}', ${!e.enabled})">
        <i class="fas ${!e.installed ? "fa-times-circle" : e.enabled ? "fa-toggle-on" : "fa-toggle-off"}" style="font-size:14px"></i>
        ${statusText}
      </button>
    </div>`;
      }

      html += `</div></div>`;
    }

    list.innerHTML = html || '<p style="color:var(--text3)">No extensions found</p>';
  },

  _renderIoncube(ioncube) {
    const badge = document.getElementById("ext-ioncube-badge");
    const installBtn = document.getElementById("ext-ioncube-install-btn");
    const toggleBtn = document.getElementById("ext-ioncube-toggle-btn");
    const toggleLabel = document.getElementById("ext-ioncube-toggle-label");
    const toggleIcon = toggleBtn?.querySelector("i");

    if (ioncube?.installed) {
      badge.style.display = "";
      badge.textContent = ioncube.enabled ? "Enabled" : "Disabled";
      badge.style.background = ioncube.enabled ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.08)";
      badge.style.color = ioncube.enabled ? "var(--green)" : "var(--red)";
      installBtn.style.display = "none";
      toggleBtn.style.display = "";
      toggleBtn.style.background = ioncube.enabled ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.08)";
      toggleBtn.style.color = ioncube.enabled ? "var(--green)" : "var(--red)";
      toggleBtn.style.borderColor = ioncube.enabled ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.2)";
      toggleLabel.textContent = ioncube.enabled ? "ON — Disable" : "OFF — Enable";
      if (toggleIcon) toggleIcon.className = ioncube.enabled ? "fas fa-toggle-on" : "fas fa-toggle-off";
    } else {
      badge.style.display = "none";
      installBtn.style.display = "";
      toggleBtn.style.display = "none";
    }
  },

  async toggle(extId, enable) {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    const btn = event?.target?.closest?.("button");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:14px"></i> ...';
    }
    const r = await api.toggleExtension({ phpVersion: ver, extId, enable });
    if (r.success) {
      toast(`${extId} ${enable ? "enabled" : "disabled"} — PHP restarted`, "success");
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
      if (btn) {
        btn.disabled = false;
      }
    }
  },

  async toggleIoncube() {
    const ioncube = this._data.find((e) => e.id === "ioncube");
    if (!ioncube) return;
    await this.toggle("ioncube", !ioncube.enabled);
  },

  async enableEssentials() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    toast("Enabling essential extensions...", "info");
    const r = await api.enableEssentials(ver);
    if (r.success) {
      toast(`${r.enabled} essential extensions enabled — PHP restarted`, "success");
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async fixExtDir() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    toast("Fixing extension_dir...", "info");
    const r = await api.fixExtensionDir(ver);
    if (r.success) {
      toast("extension_dir fixed — PHP restarted", "success");
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async deduplicate() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    toast("Removing duplicate extensions...", "info");
    const r = await api.deduplicateExtensions(ver);
    if (r.success) {
      if (r.removed > 0) {
        toast(`Removed ${r.removed} duplicate lines — PHP restarted`, "success");
      } else {
        toast("No duplicates found", "success");
      }
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async showDuplicateInfo() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    const r = await api.getDuplicateInfo(ver);
    const modal = document.getElementById("ext-dup-modal");
    const content = document.getElementById("ext-dup-content");

    if (!r.success) {
      content.innerHTML = `<p style="color:var(--red)">${r.message}</p>`;
      modal.style.display = "flex";
      return;
    }

    if (r.totalDuplicates === 0) {
      content.innerHTML = `<div style="text-align:center;padding:20px">
        <i class="fas fa-check-circle" style="font-size:32px;color:var(--green);margin-bottom:8px"></i>
        <p style="color:var(--text1);font-weight:600">No duplicates found</p>
        <p style="color:var(--text3);font-size:13px">PHP ${ver} php.ini is clean.</p>
      </div>`;
      modal.style.display = "flex";
      return;
    }

    let html = `<p style="color:var(--red);font-weight:600;margin-bottom:12px">
      <i class="fas fa-exclamation-triangle"></i> Found ${r.totalDuplicates} extensions with duplicate lines:
    </p>`;

    for (const [key, entries] of Object.entries(r.duplicates)) {
      const [type, name] = key.split(":");
      html += `<div style="margin-bottom:12px;padding:10px;background:var(--bg3);border-radius:6px">
        <div style="font-weight:600;color:var(--text1);margin-bottom:6px">${name} <span style="font-size:11px;color:var(--text3)">(${type === 'zend' ? 'zend_extension' : 'extension'})</span></div>`;
      for (const e of entries) {
        const color = e.commented ? "var(--text3)" : "var(--green)";
        html += `<div style="font-size:12px;font-family:monospace;color:${color};padding:2px 0">
          Line ${e.line}: <code>${e.text}</code>
        </div>`;
      }
      html += `</div>`;
    }

    html += `<div style="margin-top:12px;text-align:center">
      <button class="btn btn-primary btn-sm" onclick="Extensions.deduplicate();document.getElementById('ext-dup-modal').style.display='none'">
        <i class="fas fa-broom"></i> Fix All Duplicates
      </button>
    </div>`;

    content.innerHTML = html;
    modal.style.display = "flex";
  },

  async loadPhpVersionsList() {
    const versions = await api.getAvailablePhp();
    const countEl = document.getElementById("ext-php-versions-count");
    const listEl = document.getElementById("ext-php-versions-list");
    if (countEl) countEl.textContent = `${versions.length} version${versions.length !== 1 ? 's' : ''}`;
    if (listEl) {
      listEl.innerHTML = versions.map((v) =>
        `<span style="display:inline-block;background:var(--bg3);padding:3px 10px;border-radius:4px;margin:2px 4px 2px 0;font-weight:600">PHP ${v}</span>`
      ).join("");
    }
  },

  async addPhpVersion() {
    const verInput = document.getElementById("ext-new-php-ver");
    const version = verInput?.value?.trim();
    if (!version) {
      toast("Please enter a PHP version number (e.g. 8.2)", "error");
      return;
    }
    if (!/^\d+\.\d+$/.test(version)) {
      toast("Version format should be X.Y (e.g. 8.2, 8.1)", "error");
      return;
    }

    // Open folder dialog
    const sourcePath = await api.openFileDialog({ properties: ["openDirectory"], title: "Select PHP installation folder" });
    if (!sourcePath) return;

    toast(`Adding PHP ${version}...`, "info");
    const r = await api.addPhpVersion({ version, sourcePath });
    if (r.success) {
      toast(`PHP ${version} added successfully!`, "success");
      verInput.value = "";
      await PhpVersions.populateSelect("ext-php-ver", version);
      await this.loadPhpVersionsList();
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async removePhpVersion() {
    const ver = document.getElementById("ext-php-ver")?.value;
    if (!ver) return;
    if (!confirm(`Are you sure you want to remove PHP ${ver}? This will delete the entire PHP ${ver} folder.`)) return;

    toast(`Removing PHP ${ver}...`, "info");
    const r = await api.removePhpVersion(ver);
    if (r.success) {
      toast(`PHP ${ver} removed`, "success");
      await PhpVersions.populateSelect("ext-php-ver", "8.3");
      await this.loadPhpVersionsList();
      await this.load();
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  async installIoncube() {
    const ver = document.getElementById("ext-php-ver")?.value || "8.3";
    const btn = document.getElementById("ext-ioncube-install-btn");
    const pre = document.getElementById("ext-ioncube-progress");

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
    pre.style.display = "";
    pre.textContent = "";

    const r = await api.installIoncube({ phpVersion: ver });

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-download"></i> Install ionCube';

    if (r.success) {
      toast("ionCube installed successfully!", "success");
      await this.load();
    } else {
      toast("Install failed: " + r.message, "error");
      pre.textContent += "\n[ERROR] " + r.message;
    }
  },
};
