// renderer/js/plugins.js

window.PluginsPage = {
  async load() {
    await this._renderPlugins();
  },

  async _renderPlugins() {
    const grid = document.getElementById("plugin-grid");
    if (!grid) return;
    const plugins = await api.getPlugins();
    if (!plugins.length) {
      grid.innerHTML =
        '<div class="empty-state"><i class="fas fa-puzzle-piece"></i><p>No plugins found</p></div>';
      return;
    }
    grid.innerHTML = plugins
      .map(
        (p) => `
<div class="plugin-card" onclick="PluginsPage.open('${p.id}')">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <div class="plugin-icon"><i class="${p.icon || "fas fa-puzzle-piece"}"></i></div>
    <span class="badge" style="background:var(--green-bg);color:var(--green);border-color:var(--green)">Active</span>
  </div>
  <div class="plugin-name">${p.name}</div>
  <div class="plugin-version">v${p.version || "1.0"}</div>
  <div class="plugin-desc" style="margin-top:6px">${p.description || ""}</div>
  <button class="btn btn-sm btn-primary" style="margin-top:10px;width:100%" onclick="event.stopPropagation();PluginsPage.open('${p.id}')"><i class="fas fa-play"></i> Open</button>
</div>`,
      )
      .join("");
  },

  async open(id) {
    const plugins = await api.getPlugins();
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return;

    document.getElementById("plugin-panel").style.display = "block";
    document.getElementById("plugin-panel-title").textContent = plugin.name;

    const content = document.getElementById("plugin-panel-content");
    const r = await api.readPluginPage(id);

    // Tách script ra khỏi HTML
    const tmp = document.createElement("div");
    tmp.innerHTML = r.content;

    // Inject HTML (không có script)
    const scripts = tmp.querySelectorAll("script");
    scripts.forEach((s) => s.remove());
    content.innerHTML = tmp.innerHTML;

    // Chạy script sau khi HTML đã có trong DOM
    scripts.forEach((s) => {
      const newScript = document.createElement("script");
      newScript.textContent = s.textContent;
      document.body.appendChild(newScript);
    });
  },
};

// Alias for app.js nav()
window.Plugins = window.PluginsPage;
