// renderer/js/config.js

window.Config = {
  mode: 'php',       // 'php' | 'nginx' | 'mariadb'
  phpVersion: '8.3', // currently selected PHP version in editor

  async load() {
    await this._loadPhpVersions();
    this._fillProjects();
  },

  openHostsFile() {
    api.openHostsFile();
    toast("Opening Hosts file in Notepad. Make sure you have Administrator privileges to save it.", "info", 5000);
  },

  // ── Scan & render PHP version sub-tabs ──────────────────────────────────────
  async _loadPhpVersions() {
    let versions = ['8.3'];
    try {
      const v = await api.getAvailablePhp();
      if (Array.isArray(v) && v.length > 0) versions = v;
    } catch { }

    const container = document.getElementById('cfg-php-ver-tabs');
    if (!container) return;

    // Use first version by default
    this.phpVersion = versions[0];

    container.innerHTML = versions.map((v, i) => `
      <button
        class="tab ${i === 0 ? 'active' : ''} cfg-php-ver-btn"
        data-ver="${v}"
        onclick="Config._selectPhpVer('${v}')"
        style="font-size:12px;padding:4px 10px"
      >PHP ${v}</button>
    `).join('');

    // Load php.ini for first version
    await this.loadPhp(this.phpVersion);
  },

  async _selectPhpVer(version) {
    this.phpVersion = version;
    document.querySelectorAll('.cfg-php-ver-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.ver === version);
    });
    await this.loadPhp(version);
  },

  // ── Load php.ini ─────────────────────────────────────────────────────────────
  async loadPhp(version) {
    version = version || this.phpVersion || '8.3';
    this.phpVersion = version;
    this.mode = 'php';

    // Show reload button & status bar
    const reloadBtn = document.getElementById('cfg-reload-btn');
    const statusBar = document.getElementById('cfg-php-status');
    const verTabs   = document.getElementById('cfg-php-ver-tabs');
    if (reloadBtn) reloadBtn.style.display = 'flex';
    if (statusBar) statusBar.style.display = 'block';
    if (verTabs)   verTabs.style.display   = 'flex';

    // Load php.ini content
    const r = await api.getPhpConfig(version);
    const el = document.getElementById('cfg-editor');
    if (el) el.value = r.content || '';
    ConfigEditor.updateLines();

    // Update status
    this._updatePhpStatus(version);
  },

  // ── Status indicator ─────────────────────────────────────────────────────────
  async _updatePhpStatus(version) {
    const dot  = document.getElementById('cfg-php-status-dot');
    const text = document.getElementById('cfg-php-status-text');
    if (!dot || !text) return;
    try {
      const s = await api.getServiceStatus();
      // For multi-version we check generic php running state
      // (future: can check per-version port)
      const running = s.php;
      dot.style.color  = running ? 'var(--green)' : 'var(--text3)';
      text.textContent = running
        ? `PHP ${version} — CGI running on :${9080 + parseInt((version.split('.')[1] || '3'), 10)}`
        : `PHP ${version} — not running`;
    } catch { }
  },

  // ── Load MariaDB my.ini ───────────────────────────────────────────────────────
  async loadMariadb() {
    this.mode = 'mariadb';
    const r = await api.getMariaDBConfig();
    const el = document.getElementById('cfg-editor');
    if (el) el.value = r.content || (r.success === false ? `# ${r.message}` : '');
    ConfigEditor.updateLines();
  },

  // ── Load Nginx config ─────────────────────────────────────────────────────────
  async loadNginx() {
    const sel = document.getElementById('cfg-proj-sel');
    const id  = sel?.value;
    if (!id) {
      document.getElementById('cfg-editor').value = '# Select a project above';
      return;
    }
    const r = await api.getNginxConfig(id);
    const el = document.getElementById('cfg-editor');
    if (el) el.value = r.content || '';
    ConfigEditor.updateLines();
    this.mode = 'nginx';
  },

  // ── Save & Apply ─────────────────────────────────────────────────────────────
  async save() {
    const content = document.getElementById('cfg-editor')?.value || '';
    if (this.mode === 'php') {
      const r = await api.savePhpConfig(content, this.phpVersion);
      if (r.success) {
        toast(`PHP ${this.phpVersion} config saved & CGI restarted`, 'success');
        this._updatePhpStatus(this.phpVersion);
      } else {
        toast('Save failed: ' + (r.message || ''), 'error');
      }
    } else if (this.mode === 'mariadb') {
      const r = await api.saveMariaDBConfig(content);
      toast(r.success ? 'MariaDB config saved & restarted' : 'Save failed: ' + (r.message || ''),
            r.success ? 'success' : 'error');
    } else {
      const id = document.getElementById('cfg-proj-sel')?.value;
      if (!id) { toast('Select a project', 'warn'); return; }
      const r = await api.saveNginxConfig({ id, content });
      toast(r.success ? 'Nginx config saved & reloaded' : 'Save failed: ' + r.message,
            r.success ? 'success' : 'error');
    }
  },

  // ── Reload PHP-CGI (without saving) ─────────────────────────────────────────
  async reload() {
    const btn = document.getElementById('cfg-reload-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Reloading...'; }
    try {
      const r = await api.restartPhp(this.phpVersion);
      toast(r?.success !== false
        ? `PHP ${this.phpVersion} CGI restarted`
        : `Reload failed: ${r.message || ''}`,
        r?.success !== false ? 'success' : 'error');
      this._updatePhpStatus(this.phpVersion);
    } catch (e) {
      toast('Reload error: ' + e.message, 'error');
    }
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-sync"></i> Reload PHP'; }
  },

  // ── Tab switch ────────────────────────────────────────────────────────────────
  tab(mode) {
    document.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.cfg-tab[data-tab="${mode}"]`)?.classList.add('active');

    const reloadBtn = document.getElementById('cfg-reload-btn');
    const statusBar = document.getElementById('cfg-php-status');
    const verTabs   = document.getElementById('cfg-php-ver-tabs');
    const projSel   = document.getElementById('cfg-proj-sel');

    if (mode === 'php') {
      if (reloadBtn) reloadBtn.style.display = 'flex';
      if (statusBar) statusBar.style.display = 'block';
      if (verTabs)   verTabs.style.display   = 'flex';
      if (projSel)   projSel.style.display   = 'none';
      this.loadPhp(this.phpVersion);
    } else if (mode === 'mariadb') {
      if (reloadBtn) reloadBtn.style.display = 'none';
      if (statusBar) statusBar.style.display = 'none';
      if (verTabs)   verTabs.style.display   = 'none';
      if (projSel)   projSel.style.display   = 'none';
      this.loadMariadb();
    } else {
      if (reloadBtn) reloadBtn.style.display = 'none';
      if (statusBar) statusBar.style.display = 'none';
      if (verTabs)   verTabs.style.display   = 'none';
      if (projSel)   projSel.style.display   = 'block';
      this.loadNginx();
    }
    this.mode = mode;
  },

  // ── Fill project dropdown ─────────────────────────────────────────────────────
  _fillProjects() {
    const sel = document.getElementById('cfg-proj-sel');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Select project --</option>';
    App.projects.forEach(p => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.phpVersion ? ` (PHP ${p.phpVersion})` : '');
      if (p.id === cur) o.selected = true;
      sel.appendChild(o);
    });
  },
};

// ── Config Editor helpers (line numbers + search) ────────────────────────────
window.ConfigEditor = {
  _matches: [],
  _matchIdx: -1,

  updateLines() {
    const editor = document.getElementById('cfg-editor');
    const lineNums = document.getElementById('cfg-line-numbers');
    if (!editor || !lineNums) return;
    const lines = editor.value.split('\n').length;
    let nums = '';
    for (let i = 1; i <= lines; i++) nums += i + '\n';
    lineNums.textContent = nums;
    this.updateCursor();
  },

  syncScroll() {
    const editor = document.getElementById('cfg-editor');
    const lineNums = document.getElementById('cfg-line-numbers');
    if (editor && lineNums) lineNums.scrollTop = editor.scrollTop;
  },

  updateCursor() {
    const editor = document.getElementById('cfg-editor');
    const pos = document.getElementById('cfg-cursor-pos');
    if (!editor || !pos) return;
    const val = editor.value.substring(0, editor.selectionStart);
    const line = val.split('\n').length;
    const col = val.split('\n').pop().length + 1;
    pos.textContent = `Line ${line}, Col ${col}`;
  },

  search() {
    const query = document.getElementById('cfg-search')?.value || '';
    const countEl = document.getElementById('cfg-search-count');
    const editor = document.getElementById('cfg-editor');
    if (!editor) return;

    this._matches = [];
    this._matchIdx = -1;

    if (!query) {
      if (countEl) countEl.textContent = '';
      return;
    }

    const text = editor.value.toLowerCase();
    const q = query.toLowerCase();
    let idx = 0;
    while ((idx = text.indexOf(q, idx)) !== -1) {
      this._matches.push(idx);
      idx += q.length;
    }

    if (countEl) {
      countEl.textContent = this._matches.length
        ? `${this._matches.length} found`
        : 'No matches';
    }

    if (this._matches.length > 0) {
      this._matchIdx = 0;
      this._highlightMatch();
    }
  },

  searchNext() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx + 1) % this._matches.length;
    this._highlightMatch();
  },

  searchPrev() {
    if (!this._matches.length) return;
    this._matchIdx = (this._matchIdx - 1 + this._matches.length) % this._matches.length;
    this._highlightMatch();
  },

  _highlightMatch() {
    const editor = document.getElementById('cfg-editor');
    const query = document.getElementById('cfg-search')?.value || '';
    const countEl = document.getElementById('cfg-search-count');
    if (!editor || !query || !this._matches.length) return;

    const pos = this._matches[this._matchIdx];
    editor.focus();
    editor.setSelectionRange(pos, pos + query.length);

    // Scroll to selection
    const textBefore = editor.value.substring(0, pos);
    const lineNum = textBefore.split('\n').length;
    const lineHeight = 19.2; // ~12px font * 1.6 line-height
    editor.scrollTop = Math.max(0, (lineNum - 5) * lineHeight);

    if (countEl) {
      countEl.textContent = `${this._matchIdx + 1}/${this._matches.length}`;
    }
    this.updateCursor();
  },
};

