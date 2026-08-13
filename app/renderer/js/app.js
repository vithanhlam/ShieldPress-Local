// renderer/js/app.js

window.App = {
  projects: [],
  currentPage: "projects",
  searchQuery: "",
  filterTag: "",
  serviceStatus: { nginx: false, php: false, mariadb: false },
  _pageCache: {},
};

// ── Page loader ───────────────────────────────────────────────────────────────
async function loadPage(name) {
  if (App._pageCache[name]) return App._pageCache[name];
  const r = await api.readPage(name);
  App._pageCache[name] = r.content;
  return r.content;
}

async function injectPage(name) {
  const container = document.getElementById("page-" + name);
  if (!container || container.dataset.loaded) return;
  const html = await loadPage(name);
  container.innerHTML = html;
  container.dataset.loaded = "1";

  const logo_version = document.getElementById("logo-version");
  if (logo_version) {
    const info = await api.getAppInfo();
    logo_version.textContent = `v${info.version}`;
  }

  // Post-inject init per page
  if (name === "settings") {
    const [dataDir, binDir] = await Promise.all([
      api.getDataDir(),
      api.getBinDir(),
    ]);
    const d = document.getElementById("data-dir-path");
    const b = document.getElementById("bin-dir-path");
    if (d) d.textContent = dataDir;
    if (b) b.textContent = binDir;
  }
  if (name === "about") {
    const info = await api.getAppInfo();
    const av = document.getElementById("about-version");
    if (av) av.textContent = `v${info.version} by ${info.author}`;
    AboutPage.init(info.version);
  }

  if (name === "config") {
    // Tab switching handled entirely by Config.tab() — nothing extra needed here
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
window.nav = async function (page) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));

  await injectPage(page);

  document.getElementById("page-" + page)?.classList.add("active");
  document
    .querySelector(`.nav-item[data-page="${page}"]`)
    ?.classList.add("active");

  const titleEl = document.getElementById("titlebar-page");
  if (titleEl)
    titleEl.textContent = page.charAt(0).toUpperCase() + page.slice(1);

  App.currentPage = page;

  if (page === "projects" && typeof Projects !== "undefined") Projects.load();
  if (page === "database" && typeof Database !== "undefined") Database.load();
  if (page === "backups" && typeof Backups !== "undefined") Backups.load();
  if (page === "config" && typeof Config !== "undefined") Config.load();
  if (page === "debug" && typeof Debug !== "undefined") Debug.loadGlobal();
  if (page === "sftp" && typeof SFTP !== "undefined") SFTP.init();
  if (page === "cache" && typeof CacheManager !== "undefined") CacheManager.init();
  if (page === "extensions" && typeof Extensions !== "undefined") Extensions.init();
  if (page === "email" && typeof EmailTest !== "undefined") EmailTest.init();
  if (page === "plugins" && typeof Plugins !== "undefined") Plugins.load();
  if (page === "settings") { StorageSettings.init(); EditorSettings.init(); PhpPathSettings.init(); GitHubSettings.init(); GDriveSettings.init(); }
};

// ── Toast ─────────────────────────────────────────────────────────────────────
window.toast = function (msg, type = "info", duration = 3500) {
  const c = document.getElementById("toast-container");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  const icon =
    {
      success: "fa-check-circle",
      error: "fa-times-circle",
      warn: "fa-exclamation-triangle",
      info: "fa-info-circle",
    }[type] || "fa-info-circle";
  t.innerHTML = `<i class="fas ${icon}"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.classList.add("fade-out");
    setTimeout(() => t.remove(), 400);
  }, duration);
};

// ── Modal helpers ─────────────────────────────────────────────────────────────
window.openModal = (id) => document.getElementById(id)?.classList.add("open");
window.closeModal = (id) =>
  document.getElementById(id)?.classList.remove("open");
window.closeIfOverlay = (e, id) => {
  if (e.target.id === id) closeModal(id);
};

// ── Format helpers ────────────────────────────────────────────────────────────
window.fmtBytes = (b) =>
  b > 1048576 ? (b / 1048576).toFixed(1) + "MB" : (b / 1024).toFixed(0) + "KB";
window.fmtDate = (d) => new Date(d).toLocaleDateString("vi-VN");

// ── Service status ────────────────────────────────────────────────────────────
async function refreshServiceStatus() {
  try {
    const s = await api.getServiceStatus();
    App.serviceStatus = s;

    const dot = (id, on) => {
      const el = document.getElementById(id);
      if (el) el.className = "svc-dot " + (on ? "on" : "off");
    };
    dot("svc-nginx", s.nginx);
    dot("svc-php", s.php);
    dot("svc-mariadb", s.mariadb);

    // Redis row: show only if installed (port known) or running
    const redisRow = document.getElementById("svc-row-redis");
    if (redisRow) {
      dot("svc-redis", s.redis);
      renderSvcBtns("redis", s.redis);
      if (s.redis || s.redisInstalled) redisRow.style.display = "";
    }

    // Update buttons
    renderSvcBtns("nginx", s.nginx);
    renderSvcBtns("php", s.php);
    renderSvcBtns("mariadb", s.mariadb);

    // Update port labels
    updateSvcPorts(s);
  } catch (e) {}
}

async function updateSvcPorts(s) {
  try {
    const cfg = await api.getConfig();

    // Nginx — base port from config
    const nginxEl = document.getElementById("svc-port-nginx");
    if (nginxEl) {
      const nginxPort = cfg.nginx?.base_port || 8000;
      nginxEl.textContent = s.nginx ? `:${nginxPort}` : "";
    }

    // PHP — one port per version (9080 + minor)
    const phpEl = document.getElementById("svc-port-php");
    if (phpEl && s.php) {
      const versions = await api.getAvailablePhp();
      if (versions && versions.length > 0) {
        const ports = versions.map((v) => {
          const minor = parseInt((v.split(".")[1] || "3"), 10);
          return `:${9080 + minor}`;
        });
        phpEl.textContent = ports.join(" ");
      }
    } else if (phpEl) {
      phpEl.textContent = "";
    }

    // MariaDB — from config
    const dbEl = document.getElementById("svc-port-mariadb");
    if (dbEl) {
      const dbPort = cfg.mysql?.port || 3306;
      dbEl.textContent = s.mariadb ? `:${dbPort}` : "";
    }

    // Redis — from config
    const redisEl = document.getElementById("svc-port-redis");
    if (redisEl) {
      const redisPort = cfg.redis?.port || 6379;
      redisEl.textContent = s.redis ? `:${redisPort}` : "";
    }
  } catch (e) {}
}

function renderSvcBtns(svc, running) {
  const el = document.getElementById("svc-btns-" + svc);
  if (!el) return;

  if (running) {
    el.innerHTML = `
    <button class="svc-btn svc-stop"    onclick="Services._run('${svc}','stop')"   ><i class="fas fa-stop"></i></button>
    <button class="svc-btn svc-restart" onclick="Services._run('${svc}','restart')"><i class="fas fa-redo"></i></button>`;
  } else {
    el.innerHTML = `
    <button class="svc-btn svc-start" onclick="Services._run('${svc}','start')"><i class="fas fa-play"></i></button>`;
  }
}

// ── Update Checker ────────────────────────────────────────────────────────────
window.UpdateChecker = {
  _releaseUrl: null,

  async check() {
    try {
      const [info, r] = await Promise.all([api.getAppInfo(), api.checkForUpdates()]);
      if (!r.success || !r.version) return;

      const latest = r.version.replace(/^v/, "");
      const current = info.version;

      if (this._isNewer(latest, current)) {
        this._releaseUrl = r.url;
        this._showBadge(latest);
      }
    } catch {}
  },

  _isNewer(latest, current) {
    const p = (v) => v.split(".").map(Number);
    const [la, lb, lc = 0] = p(latest);
    const [ca, cb, cc = 0] = p(current);
    if (la !== ca) return la > ca;
    if (lb !== cb) return lb > cb;
    return lc > cc;
  },

  _showBadge(version) {
    this._latestVersion = version;
    const badge = document.getElementById("update-badge");
    const verEl = document.getElementById("update-badge-ver");
    if (badge) badge.style.display = "flex";
    if (verEl) verEl.textContent = `v${version} available`;
  },

  openRelease() {
    if (this._releaseUrl) api.openBrowser(this._releaseUrl);
    else api.openBrowser("https://github.com/vithanhlam/shieldpress-local/releases/latest");
  },
};

// ── About Page ────────────────────────────────────────────────────────────────
window.AboutPage = {
  _releaseUrl: null,

  async init(currentVersion) {
    // Reuse cached result from UpdateChecker if already checked
    if (UpdateChecker._releaseUrl) {
      this._releaseUrl = UpdateChecker._releaseUrl;
      const verEl = document.getElementById("about-update-label");
      const wrap = document.getElementById("about-update-wrap");
      if (verEl && wrap) {
        verEl.textContent = `v${UpdateChecker._latestVersion} available`;
        wrap.style.display = "flex";
      }
      return;
    }
    // Otherwise fetch now
    try {
      const [info, r] = await Promise.all([api.getAppInfo(), api.checkForUpdates()]);
      if (!r.success || !r.version) return;
      const latest = r.version.replace(/^v/, "");
      if (UpdateChecker._isNewer(latest, info.version)) {
        this._releaseUrl = r.url;
        UpdateChecker._latestVersion = latest;
        const verEl = document.getElementById("about-update-label");
        const wrap = document.getElementById("about-update-wrap");
        if (verEl && wrap) {
          verEl.textContent = `v${latest} available`;
          wrap.style.display = "flex";
        }
      }
    } catch {}
  },

  downloadUpdate() {
    const url = this._releaseUrl || UpdateChecker._releaseUrl;
    if (url) api.openBrowser(url);
    else api.openBrowser("https://github.com/vithanhlam/shieldpress-local/releases/latest");
  },
};

// ── System Stats ─────────────────────────────────────────────────────────────
async function refreshSystemStats() {
  try {
    const s = await api.getSystemStats();
    const fmtGB = (b) => (b / 1073741824).toFixed(1) + "G";

    const cpuEl = document.getElementById("sys-cpu");
    const ramEl = document.getElementById("sys-ram");
    const diskEl = document.getElementById("sys-disk");
    const diskIconEl = document.getElementById("sys-disk-icon");
    const appMemEl = document.getElementById("sys-app-mem");

    if (cpuEl) {
      cpuEl.textContent = s.cpu.percent;
      cpuEl.parentElement.style.color = s.cpu.percent > 80 ? "var(--red)" : s.cpu.percent > 50 ? "var(--yellow)" : "var(--text2)";
    }
    if (ramEl) {
      ramEl.textContent = s.ram.percent;
      ramEl.parentElement.style.color = s.ram.percent > 85 ? "var(--red)" : s.ram.percent > 65 ? "var(--yellow)" : "var(--text2)";
    }
    if (diskEl && s.disk) {
      const diskPercent = Math.round((s.disk.used / s.disk.total) * 100);
      const diskFree = fmtGB(s.disk.free);
      diskEl.textContent = `${s.disk.drive} ${diskFree} free`;
      const diskColor = diskPercent > 90 ? "var(--red)" : diskPercent > 75 ? "var(--yellow)" : "var(--text2)";
      diskEl.parentElement.style.color = diskColor;
    }
    if (appMemEl) appMemEl.textContent = (s.process.mem / 1048576).toFixed(0) + "MB";
  } catch {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  // Nav bindings
  document.querySelectorAll(".nav-item[data-page]").forEach((el) => {
    el.addEventListener("click", () => nav(el.dataset.page));
  });

  // Window controls
  document
    .getElementById("btn-min")
    ?.addEventListener("click", () => api.minimize());
  document
    .getElementById("btn-max")
    ?.addEventListener("click", () => api.maximize());
  document
    .getElementById("btn-close")
    ?.addEventListener("click", () => api.close());

  // Live log
  api.onLogLine((line) => {
    const el = document.getElementById("debug-log");
    if (el) {
      el.textContent += line + "\n";
      el.scrollTop = el.scrollHeight;
    }
  });

  // App version
  const info = await api.getAppInfo();
  const verEl = document.getElementById("app-version");
  if (verEl) verEl.textContent = `v${info.version}`;

  // Service status polling
  await refreshServiceStatus();
  setInterval(refreshServiceStatus, 5000);

  // System stats polling (every 10s to minimize overhead)
  refreshSystemStats();
  setInterval(refreshSystemStats, 10000);

  // Check for updates after 6s — non-blocking, network optional
  setTimeout(() => UpdateChecker.check(), 6000);

  // Load first page
  await nav("projects");

  // right click menu
  ContextMenu.init();
});

// Chặn right click mặc định + hiện context menu tùy chỉnh
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  // Check if right-clicked on a project card
  const proj = ContextMenu._findProjectCard(e.target);
  if (proj) {
    ContextMenu.showProject(e.clientX, e.clientY, proj);
  } else {
    ContextMenu.show(e.clientX, e.clientY);
  }
});

// Đóng khi click ra ngoài
document.addEventListener("click", () => ContextMenu.hide());
