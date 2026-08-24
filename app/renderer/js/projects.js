// renderer/js/projects.js

window.Projects = {
  async load() {
    this._bindDbBackupProgress();
    const list = await api.getProjects();
    App.projects = list;
    this.render(list);
    this._populateTags(list);
    this._fillSizes(list);
  },

  async _fillSizes(list) {
    const missing = (list || []).filter((p) => p.sizeBytes == null).map((p) => p.id);
    if (!missing.length || !api.getProjectSizes) return;
    try {
      const r = await api.getProjectSizes(missing);
      if (!r?.success || !r.sizes) return;
      App.projects = (App.projects || []).map((p) =>
        r.sizes[p.id] != null ? { ...p, sizeBytes: r.sizes[p.id] } : p
      );
      for (const [id, sizeBytes] of Object.entries(r.sizes)) {
        const safeId = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const badge = document.querySelector(`.proj-card[data-id="${safeId}"] .proj-size-badge`);
        if (badge) badge.innerHTML = `<i class="fas fa-hdd" style="margin-right:4px"></i>${fmtBytes(sizeBytes)}`;
      }
    } catch {}
  },

  _populateTags(list) {
    const allTags = new Set();
    list.forEach((p) => (p.tags || []).forEach((t) => allTags.add(t)));
    const sel = document.getElementById("filter-tag");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All tags</option>';
    allTags.forEach((t) => {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      if (t === cur) o.selected = true;
      sel.appendChild(o);
    });
  },

  filter() {
    const q = (
      document.getElementById("search-box")?.value || ""
    ).toLowerCase();
    const tag = document.getElementById("filter-tag")?.value || "";
    App.searchQuery = q;
    App.filterTag = tag;
    const filtered = App.projects.filter((p) => {
      const matchQ =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.domain.toLowerCase().includes(q);
      const matchTag = !tag || (p.tags || []).includes(tag);
      return matchQ && matchTag;
    });
    this.render(filtered);
  },

  render(list) {
    const el = document.getElementById("project-list");
    if (!el) return;

    if (list.length === 0) {
      el.innerHTML = `<div class="empty-state"><i class="fas fa-folder-open"></i><p>No projects found</p></div>`;
      return;
    }

    el.innerHTML = list.map((p) => this._card(p)).join("");
  },

  async toggleStar(id) {
    const r = await api.toggleStar(id);
    if (r.success) {
      await this.load();
    }
  },

  _card(p) {
    const running = p.isRunning || p.status === "running";
    const starred = !!p.starred;
    const tags = (p.tags || [])
      .map((t) => `<span class="tag">${t}</span>`)
      .join("");
    const typeIcon =
      {
        wordpress: "fab fa-wordpress",
        laravel: "fab fa-laravel",
        node: "fab fa-node-js",
        nextjs: "fas fa-code",
      }[p.projectType] || "fa-brands fa-php";
    const phpBadge = p.phpVersion
      ? `<span class="tag" style="background:rgba(119,74,182,0.18);color:#a78bfa;border-color:rgba(119,74,182,0.3)">PHP ${p.phpVersion}</span>`
      : "";
    const sizeLabel = p.sizeBytes == null ? "…" : fmtBytes(p.sizeBytes);
    const sizeBadge = `<span class="tag proj-size-badge"><i class="fas fa-hdd" style="margin-right:4px"></i>${sizeLabel}</span>`;
    return `
<div class="proj-card ${running ? "running" : ""}" data-id="${p.id}">
  <div class="proj-card-top">
    <div class="proj-meta">
      <div class="proj-name">${p.name}</div>
      <div class="proj-domain">${p.domain}:<span class="proj-port">${p.port}</span></div>
      <div class="proj-tags">${phpBadge}${sizeBadge}${tags}</div>
    </div>
    <div class="proj-right">
      <div class="proj-status ${running ? "status-on" : "status-off"}">
        <i class="fas fa-circle"></i> ${running ? "Running" : "Stopped"}
      </div>
      <div class="proj-icon"><i class="${typeIcon}"></i></div>
      <button class="proj-star ${starred ? "starred" : ""}" onclick="Projects.toggleStar('${p.id}')" title="${starred ? "Unstar" : "Star"}">
        <i class="fas fa-star"></i>
      </button>
    </div>
  </div>
  <div class="proj-card-actions">
    ${
      running
        ? `<button class="btn btn-sm btn-danger"  onclick="Projects.stop('${p.id}')"><i class="fas fa-stop"></i> Stop</button>`
        : `<button class="btn btn-sm btn-success" onclick="Projects.start('${p.id}')"><i class="fas fa-play"></i> Start</button>`
    }
    <button class="btn btn-sm btn-ghost" onclick="Projects.openBrowser('${p.id}')"><i class="fas fa-external-link-alt"></i></button>
    <button class="btn btn-sm btn-ghost" onclick="Projects.openFolder('${p.id}')"><i class="fas fa-folder-open"></i></button>
    <button class="btn btn-sm btn-ghost" title="Open in Editor" onclick="Projects.openInEditor('${p.id}')"><i class="fas fa-code" style="color:var(--accent)"></i></button>
    <button class="btn btn-sm btn-ghost" onclick="Projects.openDebug('${p.id}')"><i class="fas fa-bug"></i></button>
    ${p.projectType === "laravel"
      ? `<button class="btn btn-sm btn-ghost" title="Laravel/NPM" onclick="Projects.openLaravel('${p.id}')"><i class="fab fa-laravel" style="color:#ff2d20"></i></button>`
      : (p.projectType === "node" || p.projectType === "nextjs")
      ? `<button class="btn btn-sm btn-ghost" title="Node.js/Next.js" onclick="Projects.openNode('${p.id}')"><i class="fab fa-node-js" style="color:#68a063"></i></button>`
      : `<button class="btn btn-sm btn-ghost" title="WordPress" onclick="Projects.openWordPress('${p.id}')"><i class="fab fa-wordpress"></i></button>`
    }
    <button class="btn btn-sm btn-ghost btn-edit" onclick="Projects.openEdit('${p.id}')"><i class="fas fa-cog"></i></button>
    ${p.projectType === "wordpress" || p.projectType === "php" ? `<button class="btn btn-sm btn-ghost" title="Quick Login (WordPress)" onclick="QuickLogin.open('${p.id}', '${p.name.replace(/'/g, "\\'")}')"><i class="fas fa-unlock-alt"></i></button>` : ""}
    <button class="btn btn-sm btn-ghost btn-checklist" title="Task List" onclick="TaskList.open('${p.id}', '${p.name.replace(/'/g, "\\'")}')"><i class="fas fa-tasks"></i></button>
    <button class="btn btn-sm btn-ghost" title="Git Push" onclick="GitPush.open('${p.id}', '${p.name.replace(/'/g, "\\'")}')"><i class="fab fa-github"></i></button>
    <button class="btn btn-sm btn-ghost" title="${p.ssl?.enabled ? 'SSL Active — Manage' : 'Install SSL'}" onclick="SSL.open('${p.id}', '${p.name.replace(/'/g, "\\'")}', '${p.domain}', ${!!p.ssl?.enabled})"><i class="fas fa-lock" style="${p.ssl?.enabled ? 'color:var(--green)' : ''}"></i></button>
    <button class="btn btn-sm btn-ghost" title="Google Drive Backup" onclick="GDriveBackup.open('${p.id}', '${p.name.replace(/'/g, "\\'")}')"><i class="fab fa-google-drive" style="color:#4285F4"></i></button>
    <button class="btn btn-sm btn-danger-ghost" onclick="Projects.confirmDelete('${p.id}', '${p.name}')"><i class="fas fa-trash"></i></button>
  </div>
</div>`;
  },

  async start(id) {
    const btn = document.querySelector(`[data-id="${id}"] .btn-success`);
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
    }
    try {
      const r = await api.startProject(id);
      if (r.success) {
        toast(`Started: ${r.url}`, "success");
      } else {
        toast("Start failed: " + r.message, "error");
      }
    } catch (error) {
      toast("Start failed: " + (error.message || error), "error");
    }
    await this.load();
  },

  async stop(id) {
    const p = App.projects.find(x => x.id === id);
    document.getElementById('stop-backup-proj-id').value = id;
    document.getElementById('stop-backup-proj-name').textContent = p?.name || id;
    document.getElementById('stop-backup-progress').style.display = 'none';
    document.getElementById('stop-backup-bar').style.width = '0%';
    document.getElementById('stop-backup-bytes').textContent = '';
    document.getElementById('stop-backup-complete-actions').style.display = 'none';
    document.getElementById('stop-backup-footer').style.display = 'flex';
    openModal('m-stop-backup');
  },

  async stopWithBackup() {
    const id   = document.getElementById('stop-backup-proj-id').value;
    const proj = App.projects.find(x => x.id === id);
    const statusEl = document.getElementById('stop-backup-status');

    document.getElementById('stop-backup-footer').style.display  = 'none';
    document.getElementById('stop-backup-progress').style.display = 'block';

    // Step 1: local DB backup (0% → 50%)
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Backing up database...';
    const backup = await api.backupProjectDb(id);
    if (!backup?.success) {
      if (statusEl) statusEl.innerHTML = '<i class="fas fa-exclamation-circle" style="color:var(--red)"></i> Database backup failed';
      document.getElementById('stop-backup-footer').style.display = 'flex';
      toast('Database backup failed: ' + (backup?.message || 'Unknown error'), 'error');
      return;
    }

    // Step 2: cloud folder backup if enabled
    const gdConfig = proj?.googleDriveBackup;
    if (gdConfig?.autoBackup) {
      try {
        const status = await api.gdriveGetStatus();
        if (status.configured && status.exists) {
          if (statusEl) statusEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Backing up to cloud folder...';
          await api.gdriveBackupDb(id);
        }
      } catch { /* silent — cloud backup is optional */ }
    }

    document.getElementById('stop-backup-bar').style.width = '100%';
    await api.stopProject(id);
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-check-circle" style="color:var(--green)"></i> Database backed up and project stopped';
    const openFolder = document.getElementById('stop-backup-open-folder');
    openFolder.dataset.path = backup.path;
    document.getElementById('stop-backup-complete-actions').style.display = 'flex';
    toast('Database backed up & project stopped', 'success');
    await this.load();
  },

  _bindDbBackupProgress() {
    if (this._dbBackupProgressBound) return;
    this._dbBackupProgressBound = true;
    api.onProjectDbBackupProgress((data) => {
      const panel = document.getElementById('stop-backup-progress');
      if (!panel || panel.style.display === 'none') return;
      const percent = data.percent ?? 10;
      document.getElementById('stop-backup-bar').style.width = `${percent}%`;
      const statusEl = document.getElementById('stop-backup-status');
      if (data.status === 'running' && statusEl) {
        statusEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Backing up ${data.dbName}... ${percent}%`;
      }
      const bytes = document.getElementById('stop-backup-bytes');
      if (bytes) bytes.textContent = data.total
        ? `${fmtBytes(data.processed || 0)} / ${fmtBytes(data.total)}`
        : fmtBytes(data.processed || 0);
    });
  },

  async stopWithoutBackup() {
    const id = document.getElementById('stop-backup-proj-id').value;
    closeModal('m-stop-backup');
    await api.stopProject(id);
    toast('Project stopped', 'info');
    await this.load();
  },

  async openBrowser(id) {
    const r = await api.openProjectWebsite(id);
    if (r.success) {
      await this.load();
    } else {
      toast("Open website failed: " + r.message, "error");
    }
  },

  async openFolder(id) {
    const p = App.projects.find((x) => x.id === id);
    if (p) api.openFolder(p.path.replace(/[\\/]+$/, "") + "/www");
  },

  async openInEditor(id) {
    const r = await api.openInEditor(id);
    if (r.success) {
      toast(`Opened in ${r.editor}`, "success");
    } else {
      toast("Failed: " + r.message, "error");
    }
  },

  openDebug(id) {
    Debug.loadProject(id);
    nav("debug");
  },

  openWordPress(id) {
    const p = App.projects.find((x) => x.id === id);
    if (!p) return;
    document.getElementById("wp-proj-id").value = id;
    document.getElementById("wp-proj-name").textContent = p.name;
    openModal("m-wordpress");
    WordPress.init(id);
  },

  openLaravel(id) {
    const p = App.projects.find((x) => x.id === id);
    if (!p) return;
    document.getElementById("lv-proj-id").value = id;
    document.getElementById("lv-proj-name").textContent = p.name;
    openModal("m-laravel");
    Laravel.init(p);
  },

  openNode(id) {
    const p = App.projects.find((x) => x.id === id);
    if (!p) return;
    document.getElementById("node-proj-id").value = id;
    document.getElementById("node-proj-name").textContent = p.name;
    openModal("m-node");
  },

  openEdit(id) {
    const p = App.projects.find((x) => x.id === id);
    if (!p) return;
    document.getElementById("edit-proj-id").value = id;
    document.getElementById("edit-proj-name").value = p.name;
    document.getElementById("edit-upload-limit").value = p.uploadLimit || "64M";
    document.getElementById("edit-nginx-timeout").value = p.nginxTimeout || 300;
    document.getElementById("edit-tags").value = (p.tags || []).join(", ");
    // Populate and set PHP version select
    PhpVersions.populateSelect("edit-phpver", p.phpVersion || "8.3");
    openModal("m-edit");
  },

  async saveEdit() {
    const id = document.getElementById("edit-proj-id").value;
    const name = document.getElementById("edit-proj-name").value.trim();
    const uploadLimit = document
      .getElementById("edit-upload-limit")
      .value.trim();
    const nginxTimeout = document.getElementById("edit-nginx-timeout").value;
    const tagsRaw = document.getElementById("edit-tags").value;
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const phpVersion = document.getElementById("edit-phpver")?.value || "8.3";

    const r = await api.updateProjectSettings({
      id,
      name,
      uploadLimit,
      nginxTimeout,
      tags,
      phpVersion,
    });
    if (r.success) {
      toast("Settings saved", "success");
      closeModal("m-edit");
      await this.load();
    } else toast("Save failed: " + r.message, "error");
  },

  confirmDelete(id, name) {
    document.getElementById("del-proj-id").value = id;
    document.getElementById("del-proj-name").textContent = name;
    openModal("m-delete");
  },

  async doDelete() {
    const id      = document.getElementById("del-proj-id").value;
    const btn     = document.getElementById("del-confirm-btn");
    const cancel  = document.getElementById("del-cancel-btn");
    if (btn) {
      btn.disabled    = true;
      btn.innerHTML   = '<i class="fas fa-spinner fa-spin"></i> Deleting...';
    }
    if (cancel) cancel.disabled = true;

    const r = await api.deleteProject(id);
    closeModal("m-delete");

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-trash"></i> Delete'; }
    if (cancel) cancel.disabled = false;

    if (r.success) {
      toast("Project deleted", "success");
      await this.load();
    } else {
      toast("Delete failed: " + r.message, "error");
    }
  },
};

// ── Quick Login ───────────────────────────────────────────────────────────────
window.QuickLogin = {
  async open(id, name) {
    const p = App.projects.find((x) => x.id === id);
    if (p && !p.isRunning) {
      toast("Start the project first", "warn");
      return;
    }
    document.getElementById("ql-proj-id").value = id;
    document.getElementById("ql-proj-name").textContent = name;
    const sel = document.getElementById("ql-user-sel");
    sel.innerHTML = '<option value="">Loading...</option>';
    sel.disabled = true;
    openModal("m-quicklogin");
    const r = await api.wpGetUsers(id);
    if (r.success && r.users.length) {
      sel.innerHTML = r.users
        .map((u) => `<option value="${u.id}">${u.login} — ${u.name}</option>`)
        .join("");
      sel.disabled = false;
    } else {
      sel.innerHTML = '<option value="">No WP users found</option>';
    }
  },

  async login() {
    const id = document.getElementById("ql-proj-id").value;
    const userId = document.getElementById("ql-user-sel").value;
    if (!userId) { toast("No user selected", "warn"); return; }
    const btn = document.querySelector("#m-quicklogin .btn-primary");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
    const r = await api.wpAutoLogin({ id, userId });
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login'; }
    if (r.success) {
      closeModal("m-quicklogin");
      api.openBrowser(r.url);
    } else {
      toast("Login failed: " + r.message, "error");
    }
  },
};

// ── Task List ─────────────────────────────────────────────────────────────────
window.TaskList = {
  _projId: null,
  _tasks: [],

  async open(id, name) {
    this._projId = id;
    document.getElementById("tl-proj-name").textContent = name;
    document.getElementById("tl-new-content").value = "";
    document.getElementById("tl-new-deadline").value = "";
    const r = await api.getTasks(id);
    this._tasks = r.tasks || [];
    this._render();
    openModal("m-tasklist");
  },

  async _save() {
    await api.saveTasks(this._projId, this._tasks);
  },

  _progress() {
    if (!this._tasks.length) return 0;
    return Math.round((this._tasks.filter((t) => t.done).length / this._tasks.length) * 100);
  },

  _render() {
    const pct = this._progress();
    const done = this._tasks.filter((t) => t.done).length;
    const total = this._tasks.length;

    document.getElementById("tl-progress-bar").style.width = pct + "%";
    document.getElementById("tl-progress-label").textContent =
      total ? `${pct}% — ${done}/${total} completed` : "No tasks yet";

    const list = document.getElementById("tl-task-list");
    if (!total) {
      list.innerHTML = `<div class="tl-empty"><i class="fas fa-clipboard-list"></i><p>No tasks yet</p></div>`;
      return;
    }

    list.innerHTML = this._tasks.map((t, i) => {
      const deadlineFmt = t.deadline
        ? `<span class="tl-deadline ${this._isOverdue(t) ? "overdue" : ""}"><i class="fas fa-calendar-alt"></i> ${t.deadline}</span>`
        : "";
      const addedFmt = `<span class="tl-added"><i class="fas fa-clock"></i> ${new Date(t.createdAt).toLocaleDateString("en-GB")}</span>`;
      return `
<div class="tl-item ${t.done ? "done" : ""}" data-idx="${i}">
  <button class="tl-check" onclick="TaskList.toggle(${i})" title="${t.done ? "Mark incomplete" : "Mark complete"}">
    <i class="fas ${t.done ? "fa-check-circle" : "fa-circle"}"></i>
  </button>
  <div class="tl-body">
    <div class="tl-content">${this._esc(t.content)}</div>
    <div class="tl-meta">${addedFmt}${deadlineFmt}</div>
  </div>
  <button class="tl-del" onclick="TaskList.remove(${i})" title="Remove task"><i class="fas fa-times"></i></button>
</div>`;
    }).join("");
  },

  _isOverdue(t) {
    if (!t.deadline || t.done) return false;
    return new Date(t.deadline) < new Date(new Date().toDateString());
  },

  _esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  async toggle(i) {
    this._tasks[i].done = !this._tasks[i].done;
    await this._save();
    this._render();
  },

  async remove(i) {
    this._tasks.splice(i, 1);
    await this._save();
    this._render();
  },

  async addTask() {
    const contentEl = document.getElementById("tl-new-content");
    const deadlineEl = document.getElementById("tl-new-deadline");
    const content = contentEl.value.trim();
    if (!content) { toast("Task content is required", "warn"); return; }
    this._tasks.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      content,
      createdAt: new Date().toISOString(),
      deadline: deadlineEl.value || null,
      done: false,
    });
    contentEl.value = "";
    deadlineEl.value = "";
    await this._save();
    this._render();
  },
};


// ── Laravel ───────────────────────────────────────────────────────────────────
window.Laravel = {
  _id: null,
  _listening: false,

  init(proj) {
    this._id = proj.id;
    const installed = !!proj.laravelInstalled;

    const btn      = document.getElementById("lv-install-btn");
    const already  = document.getElementById("lv-already");
    const progress = document.getElementById("lv-progress");

    btn.style.display    = installed ? "none" : "";
    already.style.display = installed ? "" : "none";
    progress.style.display = "none";
    progress.textContent   = "";

    document.getElementById("lv-artisan-cmd").value    = "";
    document.getElementById("lv-artisan-output").style.display = "none";
    document.getElementById("lv-artisan-output").textContent   = "";

    // Register progress listener only once
    if (!this._listening) {
      api.onLaravelProgress((msg) => {
        const pre = document.getElementById("lv-progress");
        if (!pre) return;
        pre.style.display = "";
        pre.textContent += msg + "\n";
        pre.scrollTop = pre.scrollHeight;
      });
      this._listening = true;
    }
  },

  async install() {
    const id  = this._id;
    const btn = document.getElementById("lv-install-btn");
    const pre = document.getElementById("lv-progress");

    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
    pre.textContent = "";
    pre.style.display = "";

    const r = await api.installLaravel({ id });

    btn.disabled = false;
    btn.innerHTML = '<i class="fab fa-laravel"></i> Install Laravel (latest)';

    if (r.success) {
      toast("Laravel installed successfully!", "success");
      btn.style.display = "none";
      document.getElementById("lv-already").style.display = "";
      await Projects.load();
    } else {
      toast("Install failed: " + r.message, "error");
      pre.textContent += "\n[ERROR] " + r.message;
    }
  },

  quickCmd(cmd) {
    document.getElementById("lv-artisan-cmd").value = cmd;
    this.runArtisan();
  },

  async runArtisan() {
    const id  = this._id;
    const cmd = document.getElementById("lv-artisan-cmd").value.trim();
    if (!cmd) { toast("Enter an artisan command", "warn"); return; }

    const btn = document.querySelector("#m-laravel .btn-primary:last-of-type");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    const out = document.getElementById("lv-artisan-output");
    out.textContent = "";
    out.style.display = "";

    const r = await api.runArtisan({ id, cmd });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-play"></i>'; }

    if (r.success) {
      out.textContent = r.output || "(no output)";
    } else {
      out.textContent = "[ERROR] " + r.message;
      toast("Artisan failed: " + r.message, "error");
    }
  },
};

// ── Node/NPM Tools ────────────────────────────────────────────────────────────
window.NodeTools = {
  async runCmd(inputId, cmd) {
    const id = document.getElementById(inputId).value;
    if (!id) return;
    toast(`Launching: ${cmd || "Terminal"}`, "info");
    const r = await api.runNodeTool({ id, cmd });
    if (!r.success) {
      toast("Error: " + r.message, "error");
    }
  }
};

// ── Git Push ─────────────────────────────────────────────────────────────────
window.GitPush = {
  _projId: null,
  _listening: false,

  async open(id, name) {
    // Check if GitHub credentials are configured
    const ghConfig = await api.invoke("github-get-config");
    if (!ghConfig.configured) {
      const goToSettings = confirm(
        "GitHub credentials not configured yet.\n\n" +
        "You need to set up your GitHub Username and Personal Access Token (PAT) in Settings before pushing.\n\n" +
        "Go to Settings now?"
      );
      if (goToSettings) nav("settings");
      return;
    }

    this._projId = id;
    document.getElementById("git-proj-id").value = id;
    document.getElementById("git-proj-name").textContent = name;
    document.getElementById("git-push-log").style.display = "none";
    document.getElementById("git-push-log").textContent = "";
    document.getElementById("git-commit-msg").value = "";

    if (!this._listening) {
      api.onGitProgress((msg) => {
        const log = document.getElementById("git-push-log");
        if (log) {
          log.style.display = "block";
          log.textContent += msg + "\n";
          log.scrollTop = log.scrollHeight;
        }
      });
      this._listening = true;
    }

    openModal("m-git");
    await this.refreshStatus();
  },

  async refreshStatus() {
    const id = this._projId;
    const r = await api.gitStatus(id);
    if (!r.success) { toast("Git status error: " + r.message, "error"); return; }

    if (r.initialized) {
      document.getElementById("git-setup-section").style.display = "none";
      document.getElementById("git-push-section").style.display = "block";

      // Show status
      const info = document.getElementById("git-status-info");
      const lines = r.status.trim().split("\n").filter(Boolean);
      const changed = lines.length;
      info.innerHTML = `Branch: <strong>${r.branch}</strong> | Changes: <strong>${changed}</strong> file(s)`;
      if (r.config?.repoUrl) {
        info.innerHTML += `<br>Remote: <span style="color:var(--accent)">${r.config.repoUrl}</span>`;
      }

      // Recent commits
      const commitsEl = document.getElementById("git-recent-commits");
      commitsEl.textContent = r.recentCommits || "No commits yet";

      // Populate settings if config exists
      if (r.config) {
        document.getElementById("git-repo-url").value = r.config.repoUrl || "";
        document.getElementById("git-branch").value = r.branch || "main";
        document.getElementById("git-includes").value = (r.config.includePaths || []).join("\n");
        document.getElementById("git-excludes").value = (r.config.excludePaths || []).join("\n");
      }
    } else {
      document.getElementById("git-setup-section").style.display = "block";
      document.getElementById("git-push-section").style.display = "none";

      // Fill defaults
      if (r.config) {
        document.getElementById("git-repo-url").value = r.config.repoUrl || "";
        document.getElementById("git-includes").value = (r.config.includePaths || []).join("\n");
        document.getElementById("git-excludes").value = (r.config.excludePaths || []).join("\n");
      } else {
        document.getElementById("git-repo-url").value = "";
        document.getElementById("git-includes").value = (r.defaults.includes || []).join("\n");
        document.getElementById("git-excludes").value = (r.defaults.excludes || []).join("\n");
      }
    }
  },

  showSetup() {
    document.getElementById("git-setup-section").style.display = "block";
    document.getElementById("git-push-section").style.display = "none";
  },

  async saveConfig() {
    const id = this._projId;
    const repoUrl = document.getElementById("git-repo-url").value.trim();
    if (!repoUrl) { toast("Repository URL required", "warn"); return; }

    const excludePaths = document.getElementById("git-excludes").value
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const includePaths = document.getElementById("git-includes").value
      .split("\n").map((s) => s.trim()).filter(Boolean);

    const btn = document.getElementById("git-save-btn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    const r = await api.gitInit(id, { repoUrl, excludePaths, includePaths });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save & Initialize';

    if (r.success) {
      toast("Git initialized!", "success");
      await this.refreshStatus();
    } else {
      toast("Init failed: " + r.message, "error");
    }
  },

  async push() {
    const id = this._projId;
    const message = document.getElementById("git-commit-msg").value.trim();
    const branch = document.getElementById("git-branch")?.value.trim() || "main";

    const btn = document.getElementById("git-push-btn");
    const log = document.getElementById("git-push-log");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pushing...';
    log.style.display = "block";
    log.textContent = "";

    const r = await api.gitPush(id, { message, branch });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Commit & Push';

    if (r.success) {
      toast(r.message || "Push complete!", "success");
      log.textContent += "\n" + (r.message || "Done!");
      document.getElementById("git-commit-msg").value = "";
      await this.refreshStatus();
    } else {
      toast("Push failed: " + r.message, "error");
      log.textContent += "\nERROR: " + r.message;
    }
  },

  async pull() {
    const id = this._projId;
    const branch = document.getElementById("git-branch")?.value.trim() || "main";

    const btn = document.getElementById("git-pull-btn");
    const log = document.getElementById("git-push-log");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Pulling...';
    log.style.display = "block";
    log.textContent = "";

    const r = await api.gitPull(id, { branch });
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-cloud-download-alt"></i> Pull';

    if (r.success) {
      toast(r.message || "Pull complete!", "success");
      log.textContent += r.output || r.message || "Done!";
      await this.refreshStatus();
    } else {
      toast("Pull failed: " + r.message, "error");
      log.textContent += "ERROR: " + r.message;
    }
  },

  async cmd(gitCmd) {
    const id = this._projId;
    const log = document.getElementById("git-push-log");
    log.style.display = "block";
    log.textContent += `\n> git ${gitCmd}\n`;

    const r = await api.gitExec(id, gitCmd);
    if (r.output) log.textContent += r.output;
    if (r.error && r.error !== r.output) log.textContent += r.error;
    if (!r.success && !r.output && !r.error) log.textContent += "ERROR: " + (r.message || "Command failed");
    log.textContent += "\n";
    log.scrollTop = log.scrollHeight;
  },
};

// ── PHP Versions Helper ───────────────────────────────────────────────────────
window.PhpVersions = {
  _cache: null,

  async load() {
    if (this._cache) return this._cache;
    try {
      const versions = await api.getAvailablePhp();
      this._cache = Array.isArray(versions) && versions.length > 0 ? versions : ["8.3"];
    } catch {
      this._cache = ["8.3"];
    }
    return this._cache;
  },

  async populateSelect(selectId, selectedVersion) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const versions = await this.load();
    sel.innerHTML = versions
      .map((v) => `<option value="${v}" ${v === (selectedVersion || "8.3") ? "selected" : ""}>PHP ${v}</option>`)
      .join("");
  },
};

// ── Create project form ───────────────────────────────────────────────────────
window.CreateProject = {
  async open() {
    // Reset form completely before opening
    const form = document.getElementById("create-form");
    if (form) form.reset();
    // Re-enable all fields
    form
      ?.querySelectorAll("input,select,button")
      .forEach((el) => (el.disabled = false));
    // Load available PHP versions
    await PhpVersions.populateSelect("cp-phpver", "8.3");
    openModal("m-create");
  },

  async submit() {
    const name = document.getElementById("cp-name")?.value.trim();
    if (!name) {
      toast("Project name required", "warn");
      return;
    }

    const btn = document.getElementById("cp-submit");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';
    }

    const domain = document.getElementById("cp-domain")?.value.trim() || "";
    const phpVersion = document.getElementById("cp-phpver")?.value || "8.3";
    const projectType = document.getElementById("cp-type")?.value || "php";
    const dbName = document.getElementById("cp-db")?.value.trim() || "";
    const tags = (document.getElementById("cp-tags")?.value || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const r = await api.createProject({
      name,
      domain,
      phpVersion,
      dbName,
      projectType,
      tags,
    });

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-plus"></i> Create';
    }

    if (r.success) {
      toast(`Created: ${r.project.name} (port ${r.project.port})`, "success");
      closeModal("m-create");
      await Projects.load();
    } else {
      toast("Create failed: " + (r.message || "Unknown error"), "error");
    }
  },
};

// ── Google Drive Backup ───────────────────────────────────────────────────────
window.GDriveBackup = {
  _projId: null,
  _listeningProgress: false,

  async open(id, name) {
    this._projId = id;
    document.getElementById("gd-proj-id").value    = id;
    document.getElementById("gd-proj-name").textContent = name;
    document.getElementById("gd-sync-progress").style.display = "none";
    document.getElementById("gd-sync-log").textContent = "";

    // Attach progress listener once
    if (!this._listeningProgress) {
      api.onGdriveProgress((msg) => {
        const log = document.getElementById("gd-sync-log");
        if (!log) return;
        log.textContent += msg + "\n";
        log.scrollTop = log.scrollHeight;
        document.getElementById("gd-sync-progress").style.display = "";
      });
      this._listeningProgress = true;
    }

    openModal("m-gdrive");

    // Load backup folder status
    const status  = await api.gdriveGetStatus();
    const banner  = document.getElementById("gd-folder-banner");
    const syncBtn = document.getElementById("gd-sync-btn");
    const saveBtn = document.getElementById("gd-save-btn");

    if (banner) {
      if (!status.configured) {
        banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(234,179,8,0.1);color:#eab308;margin-bottom:12px";
        banner.innerHTML = '<i class="fas fa-exclamation-triangle"></i> No backup folder configured. <a href="#" onclick="nav(\'settings\');closeModal(\'m-gdrive\');return false" style="color:var(--accent);margin-left:4px">Set it in Settings →</a>';
      } else if (!status.exists) {
        banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(234,179,8,0.1);color:#eab308;margin-bottom:12px";
        banner.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Backup folder not found: <code style="font-size:11px">${status.backupFolder}</code>`;
      } else {
        banner.style.cssText = "padding:8px 12px;border-radius:6px;font-size:13px;background:rgba(52,168,83,0.1);color:var(--green);margin-bottom:12px";
        banner.innerHTML = `<i class="fas fa-check-circle"></i> Backup to: <code style="font-size:11px;color:var(--green)">${status.backupFolder}</code>`;
      }
    }

    const folderReady = status.configured && status.exists;
    if (syncBtn) syncBtn.disabled = !folderReady;
    if (saveBtn) saveBtn.disabled = false;

    // Load project backup config
    const cfgRes = await api.gdriveGetProjectConfig(id);
    if (cfgRes.success) {
      const cfg = cfgRes.config;
      const dbEl       = document.getElementById("gd-include-db");
      const autoEl     = document.getElementById("gd-auto-backup");
      const foldersEl  = document.getElementById("gd-folders");
      if (dbEl)      dbEl.checked       = !!cfg.includeDatabase;
      if (autoEl)    autoEl.checked     = !!cfg.autoBackup;
      if (foldersEl) foldersEl.value    = (cfg.folders || []).join("\n");
    }
  },

  async saveConfig() {
    const id = this._projId;
    const includeDatabase = document.getElementById("gd-include-db")?.checked ?? true;
    const autoBackup      = document.getElementById("gd-auto-backup")?.checked ?? false;
    const folders = (document.getElementById("gd-folders")?.value || "")
      .split("\n").map(s => s.trim()).filter(Boolean);

    const btn = document.getElementById("gd-save-btn");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }

    const r = await api.gdriveSaveProjectConfig(id, { includeDatabase, autoBackup, folders });

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-save"></i> Save Config'; }

    if (r.success) toast("Backup config saved", "success");
    else           toast("Save failed: " + r.message, "error");
  },

  async syncNow() {
    const id  = this._projId;
    const btn = document.getElementById("gd-sync-btn");
    const log = document.getElementById("gd-sync-log");

    // Save config first
    await this.saveConfig();

    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Syncing...'; }
    if (log) { log.textContent = ""; }
    document.getElementById("gd-sync-progress").style.display = "";

    const r = await api.gdriveBackupProject(id);

    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> Sync Now'; }

    if (r.success) {
      toast("Backup uploaded to Google Drive!", "success");
      if (r.results) log.textContent += "\n" + r.results.join("\n");
    } else {
      toast("Backup failed: " + (r.message || "Unknown error"), "error");
    }
  },
};
