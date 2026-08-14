// renderer/js/backups.js

window.Backups = {
  async load() {
    const el = document.getElementById('backup-list');
    if (!el) return;
    el.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>';
    const list = await api.getBackups();
    if (list.length === 0) {
      el.innerHTML = '<div class="empty-state"><i class="fas fa-archive"></i><p>No backups yet</p></div>';
      return;
    }
    el.innerHTML = list.map(b => `
<div class="backup-row">
  <div><i class="fas fa-${b.name.endsWith('.sql') ? 'database' : 'file-archive'}"></i> <span>${b.name}</span></div>
  <div class="backup-meta">
    <span>${fmtBytes(b.size)}</span>
    <span>${fmtDate(b.createdAt)}</span>
    <button class="btn btn-sm btn-ghost" onclick="api.openFolder('${b.path.replace(/\\/g,'/')}')"><i class="fas fa-folder-open"></i></button>
  </div>
</div>`).join('');
  },

  async backup() {
    const sel = document.getElementById('backup-proj-sel');
    const id  = sel?.value;
    if (!id) { toast('Select a project', 'warn'); return; }
    toast('Creating backup...', 'info');
    const r = await api.backupProject(id);
    if (r.success) { toast(`Backup created (${fmtBytes(r.size)})`, 'success'); this.load(); }
    else toast('Backup failed: ' + r.message, 'error');
  },

  fillProjects() {
    const sel = document.getElementById('backup-proj-sel');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select project --</option>';
    App.projects.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
  },
};
