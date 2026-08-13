// renderer/js/debug.js

window.Debug = {
  currentId: null,

  async loadGlobal() {
    this.currentId = null;
    document.getElementById('debug-proj-label')?.innerText && (document.getElementById('debug-proj-label').textContent = 'Global');
    const logs = await api.getLogBuffer();
    const el   = document.getElementById('debug-log');
    if (el) { el.textContent = logs; el.scrollTop = el.scrollHeight; }
    this._hideProjectTabs();
  },

  async loadProject(id) {
    this.currentId = id;
    const p = App.projects.find(x => x.id === id);
    const lbl = document.getElementById('debug-proj-label');
    if (lbl) lbl.textContent = p ? p.name : id;
    this._showProjectTabs();
    await this.showTab('app');
  },

  async showTab(tab) {
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.debug-tab[data-tab="${tab}"]`)?.classList.add('active');

    const el = document.getElementById('debug-log');
    if (!el) return;

    if (!this.currentId) {
      const logs = await api.getLogBuffer();
      el.textContent = logs;
      el.scrollTop = el.scrollHeight;
      return;
    }

    el.textContent = '⏳ Loading...';

    const r = await api.getProjectDebug(this.currentId);
    if (!r.success) { el.textContent = '# Error loading debug info'; return; }

    const content = {
      app        : r.logs.app,
      nginx_error: r.logs.nginx_error,
      nginx_access: r.logs.nginx_access,
      wp_debug   : r.logs.wp_debug,
      mariadb    : r.logs.mariadb,
      nginx_conf : r.nginxConf,
      proj_info  : JSON.stringify(r.project, null, 2),
    }[tab] || '# No data';

    el.textContent = content;
    el.scrollTop = el.scrollHeight;
  },

  async refresh() {
    const activeTab = document.querySelector('.debug-tab.active')?.dataset.tab || 'app';
    if (this.currentId) await this.showTab(activeTab);
    else await this.loadGlobal();
    toast('Refreshed', 'info', 1000);
  },

  async clearLog() {
    const el = document.getElementById('debug-log');
    if (el) el.textContent = '';
  },

  async copyLog() {
    const el = document.getElementById('debug-log');
    if (el) {
      await navigator.clipboard.writeText(el.textContent);
      toast('Copied to clipboard', 'success', 1500);
    }
  },

  _showProjectTabs() {
    document.getElementById('debug-proj-tabs')?.style.setProperty('display', 'flex');
  },
  _hideProjectTabs() {
    document.getElementById('debug-proj-tabs')?.style.setProperty('display', 'none');
  },
};
