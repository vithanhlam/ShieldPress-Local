// renderer/js/view-controls.js — shared List/Grid toggle + sort menu for list pages
window.ViewControls = {
  _handlers: {},
  _options: {},

  _read(name) {
    try { return JSON.parse(localStorage.getItem(name)) || {}; } catch { return {}; }
  },
  _write(name, value) {
    try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },

  state(key) {
    const saved = this._read("vc:" + key);
    const options = this._options[key] || [];
    const sort = options.some((o) => o.value === saved.sort) ? saved.sort : options[0]?.value;
    return { view: saved.view === "grid" ? "grid" : "list", sort };
  },

  // Remember when an item was last opened (for the "Recently opened" sort).
  touch(key, id) {
    const map = this._read("vc-recent:" + key);
    map[id] = Date.now();
    this._write("vc-recent:" + key, map);
  },
  recent(key, id) { return this._read("vc-recent:" + key)[id] || 0; },

  // Render the toolbar into #vc-<key> and remember how to re-render the list.
  mount(key, options, rerender) {
    this._options[key] = options;
    this._handlers[key] = rerender;
    const host = document.getElementById("vc-" + key);
    if (!host) return;
    const st = this.state(key);
    host.className = "vc-bar";
    host.innerHTML = `
      <select class="fi vc-sort" aria-label="Sort" title="Sort" onchange="ViewControls.setSort('${key}', this.value)">
        ${options.map((o) => `<option value="${o.value}" ${o.value === st.sort ? "selected" : ""}>${o.label}</option>`).join("")}
      </select>
      <div class="vc-toggle" role="group" aria-label="View">
        <button type="button" class="${st.view === "list" ? "active" : ""}" title="List view" aria-pressed="${st.view === "list"}" onclick="ViewControls.setView('${key}','list')"><i class="fas fa-list"></i></button>
        <button type="button" class="${st.view === "grid" ? "active" : ""}" title="Grid view" aria-pressed="${st.view === "grid"}" onclick="ViewControls.setView('${key}','grid')"><i class="fas fa-th-large"></i></button>
      </div>`;
  },

  setSort(key, sort) {
    this._write("vc:" + key, { ...this.state(key), sort });
    this._handlers[key]?.();
  },
  setView(key, view) {
    this._write("vc:" + key, { ...this.state(key), view });
    const host = document.getElementById("vc-" + key);
    host?.querySelectorAll(".vc-toggle button").forEach((b, i) => {
      const on = (i === 0) === (view === "list");
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    this._handlers[key]?.();
  },

  // Set list/grid class on the list container.
  apply(el, key) {
    if (el) el.classList.toggle("vc-grid", this.state(key).view === "grid");
  },

  // Return a sorted copy. Starred items stay pinned on top when pinStarred is set.
  sort(key, list, { pinStarred = false } = {}) {
    const options = this._options[key] || [];
    const chosen = options.find((o) => o.value === this.state(key).sort);
    const copy = [...list];
    if (!chosen?.cmp) return pinStarred ? copy.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0)) : copy;
    return copy.sort((a, b) => {
      if (pinStarred) {
        const d = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
        if (d) return d;
      }
      return chosen.cmp(a, b);
    });
  },

  byName(get) {
    return (a, b) => String(get(a) || "").localeCompare(String(get(b) || ""), undefined, { sensitivity: "base", numeric: true });
  },
};
