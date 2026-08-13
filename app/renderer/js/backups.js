// renderer/js/backups.js
window.Backups = {
  async load() {
    const el = document.getElementById("backup-list");
    if (!el) return;
    el.innerHTML =
      '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    this._bindProgress();
    const list = await api.getBackups();
    if (!list || list.length === 0) {
      el.innerHTML =
        '<div class="empty-state"><i class="fas fa-archive"></i><p>No backups yet</p></div>';
      return;
    }
    el.innerHTML = list
      .map(
        (b) => `
<div class="backup-row">
  <div><i class="fas fa-${b.name.endsWith(".sql") ? "database" : "file-archive"}"></i> <span>${b.name}</span></div>
  <div class="backup-meta">
    <span>${fmtBytes(b.size)}</span>
    <span>${fmtDate(b.createdAt)}</span>
    <button class="btn btn-sm btn-ghost" title="Show in Folder" onclick="api.revealPath('${b.path.replace(/\\/g, "/")}')">
      <i class="fas fa-folder-open"></i>
    </button>
  </div>
</div>`,
      )
      .join("");
  },

  async backup() {
    const sel = document.getElementById("backup-proj-sel");
    const id = sel?.value;
    if (!id) {
      toast("Select a project", "warn");
      return;
    }
    this._bindProgress();
    const button = document.getElementById("backup-start-btn");
    const cancel = document.getElementById("backup-cancel-btn");
    const progress = document.getElementById("backup-progress");
    progress.style.display = "block";
    document.getElementById("backup-open-folder").style.display = "none";
    if (button) { button.disabled = true; button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Backing up...'; }
    if (cancel) cancel.disabled = true;
    toast("Creating backup...", "info");
    const r = await api.backupProject(id);
    if (button) { button.disabled = false; button.innerHTML = '<i class="fas fa-archive"></i> Create Backup'; }
    if (cancel) { cancel.disabled = false; cancel.textContent = "Close"; }
    if (r.success) {
      toast(`Backup created (${fmtBytes(r.size)})`, "success");
      const open = document.getElementById("backup-open-folder");
      open.dataset.path = r.path;
      open.style.display = "inline-flex";
      this.load();
    } else toast("Backup failed: " + r.message, "error");
  },

  _bindProgress() {
    if (this._progressBound) return;
    this._progressBound = true;
    api.onBackupProgress((data) => {
      const panel = document.getElementById("backup-progress");
      if (!panel) return;
      panel.style.display = "block";
      const percent = data.percent ?? 10;
      document.getElementById("backup-progress-bar").style.width = `${percent}%`;
      document.getElementById("backup-progress-label").textContent =
        data.status === "done" ? "Backup complete" : `Creating backup... ${percent}%`;
      document.getElementById("backup-progress-bytes").textContent = data.total
        ? `${fmtBytes(data.processed || 0)} / ${fmtBytes(data.total)}` : fmtBytes(data.processed || 0);
    });
  },

  async fillProjects() {
    const sel = document.getElementById("backup-proj-sel");
    if (!sel) return;
    // Chỉ fill lại nếu chưa có hoặc chỉ có option mặc định
    if (sel.options.length > 1) return;
    const list = await api.getProjects();
    sel.innerHTML = '<option value="">-- Select project --</option>';
    list.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });
  },
};
