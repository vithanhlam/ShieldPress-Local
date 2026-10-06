window.AIAccess = {
  policy: null,
  resources: [],
  connectInfo: null,
  capabilities: ["read", "create", "edit", "delete", "execute", "upload", "download"],
  currentTab: "source",

  async init() {
    if (api.onAiApprovalRequest && !this._approvalListener) {
      this._approvalListener = true;
      api.onAiApprovalRequest((request) => this.showApproval(request));
      api.onAiApprovalResult?.((result) => this.showApprovalResult(result));
    }
    await this.reload();
    await this.loadConnectInfo();
    await this.loadAudit();
    await this.loadPending();
  },

  async loadConnectInfo() {
    const status = document.getElementById("ai-connect-status");
    const config = document.getElementById("ai-connect-config");
    if (!status || !config || !api.aiAccessGetConnectInfo) return;
    try {
      const info = await api.aiAccessGetConnectInfo();
      this.connectInfo = info;
      status.textContent = info.running ? "Gateway running" : "Gateway unavailable";
      status.classList.toggle("ok", !!info.running);
      status.classList.toggle("error", !info.running);
      config.textContent = JSON.stringify(info.mcpConfig || {}, null, 2);
    } catch (error) {
      status.textContent = "Gateway check failed";
      status.classList.remove("ok");
      status.classList.add("error");
      config.textContent = "Could not load MCP configuration.";
    }
  },

  async copyConnectConfig() {
    if (!this.connectInfo) await this.loadConnectInfo();
    const text = JSON.stringify(this.connectInfo?.mcpConfig || {}, null, 2);
    if (!text || text === "{}") return toast("MCP configuration is not available", "error");
    try {
      await navigator.clipboard.writeText(text);
      toast("MCP configuration copied", "success");
    } catch {
      toast("Could not copy MCP configuration", "error");
    }
  },

  async testConnect() {
    await this.loadConnectInfo();
    toast(this.connectInfo?.running ? "ShieldPress gateway is running" : "Open ShieldPress Local, then try again", this.connectInfo?.running ? "success" : "warn");
  },

  async reload() {
    try {
      const [policy, result] = await Promise.all([api.aiAccessGetPolicy(), api.aiAccessGetResources()]);
      this.policy = policy;
      this.resources = result.resources || [];
      document.getElementById("ai-enabled").checked = !!policy.enabled;
      document.getElementById("ai-require-approval").checked = policy.requireApproval !== false;
      document.getElementById("ai-session-approval").checked = !!policy.sessionApproval;
      document.getElementById("ai-backup-before-write").checked = policy.backupBeforeWrite !== false;
      document.getElementById("ai-redact-secrets").checked = true;
      document.getElementById("ai-session-minutes").value = String(policy.sessionMinutes ?? 60);
      this.render();
      const reqnora = await api.aiAccessGetReqnora?.();
      const keyInput = document.getElementById("reqnora-api-key");
      if (keyInput && reqnora?.apiKeyPresent) keyInput.placeholder = "API key saved in credential vault (enter to replace)";
    } catch (error) {
      toast("Could not load AI Access: " + error.message, "error");
    }
  },

  key(type, id) { return `${type}:${id}`; },

  savedFor(resource) {
    return (this.policy?.resources || []).find((item) => item.type === resource.type && String(item.id) === String(resource.id));
  },

  escape(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  },

  render() {
    const root = document.getElementById("ai-resource-list");
    if (!root) return;
    const labels = { source: "Project", database: "Database", config: "Config", vps: "VPS / SFTP / FTP", s3: "S3" };
    const icons = { source: "fa-code", database: "fa-database", config: "fa-cogs", vps: "fa-server", s3: "fa-cloud" };
    if (!this.resources.length) {
      root.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><p>No projects, databases, VPS connections, or S3 buckets found.</p></div>';
      this.updateTabCounts();
      return;
    }
    root.innerHTML = this.resources.map((resource, index) => {
      const saved = this.savedFor(resource);
      const enabled = !!saved;
      const host = resource.type === "vps" ? String(resource.host || "") : "";
      return `<div class="ai-resource-card" data-type="${this.escape(resource.type)}" data-id="${this.escape(resource.id)}" data-name="${this.escape(resource.name)}" data-host="${this.escape(host)}" data-order="${index}" data-scope="${this.escape(saved?.scope || resource.scope)}">
        <div class="ai-resource-main">
          <label class="ai-resource-check"><input type="checkbox" class="ai-resource-enabled" ${enabled ? "checked" : ""} onchange="AIAccess.toggleCard(this)"/><i class="fas ${icons[resource.type]}"></i></label>
          <div class="ai-resource-info">
            <div class="ai-resource-title"><span class="ai-type">${labels[resource.type]}</span><strong title="${this.escape(resource.name)}">${this.escape(resource.name)}</strong><button class="btn btn-ghost btn-xs ai-copy" type="button" title="Copy name" aria-label="Copy name" onclick="AIAccess.copyResource(this, 'name')"><i class="fas fa-copy"></i></button></div>
            ${host ? `<div class="ai-resource-host"><span>IP / Host: ${this.escape(host)}</span><button class="btn btn-ghost btn-xs ai-copy" type="button" title="Copy IP / Host" aria-label="Copy IP / Host" onclick="AIAccess.copyResource(this, 'host')"><i class="fas fa-copy"></i></button></div>` : ""}
            <input class="fi ai-scope" value="${this.escape(saved?.scope || resource.scope)}" placeholder="Allowed path, schema, or prefix" ${enabled ? "" : "disabled"}/>
          </div>
        </div>
      </div>`;
    }).join("");
    this.sortCards();
    this.updateTabCounts();
    this.tab(this.currentTab);
  },

  sortCards() {
    const root = document.getElementById("ai-resource-list");
    if (!root) return;
    const cards = [...root.querySelectorAll(".ai-resource-card")];
    cards.sort((a, b) => Number(b.querySelector(".ai-resource-enabled").checked) - Number(a.querySelector(".ai-resource-enabled").checked)
      || Number(a.dataset.order) - Number(b.dataset.order));
    cards.forEach((card) => root.appendChild(card));
  },

  updateTabCounts() {
    document.querySelectorAll("[data-ai-tab]").forEach((button) => {
      const count = [...document.querySelectorAll(".ai-resource-card")].filter((card) => card.dataset.type === button.dataset.aiTab && card.querySelector(".ai-resource-enabled").checked).length;
      const badge = button.querySelector("span");
      if (badge) badge.textContent = String(count);
    });
  },

  tab(type) {
    this.currentTab = type;
    const debug = type === "debug";
    document.querySelectorAll(".ai-resource-tabs ~ #ai-resource-list, .ai-resource-list, .ai-section-head").forEach((el) => { el.style.display = debug ? "none" : ""; });
    const search = document.getElementById("ai-resource-search-wrap");
    if (search) search.style.display = debug ? "none" : "";
    const debugPanel = document.getElementById("ai-debug-panel");
    if (debugPanel) debugPanel.style.display = debug ? "block" : "none";
    document.querySelectorAll("[data-ai-tab]").forEach((button) => button.classList.toggle("active", button.dataset.aiTab === type));
    if (debug) return;
    this.filterCards();
  },

  filterCards() {
    const query = document.getElementById("ai-resource-search")?.value.trim().toLocaleLowerCase() || "";
    let visible = 0;
    document.querySelectorAll(".ai-resource-card").forEach((card) => {
      const matches = card.dataset.type === this.currentTab && [card.dataset.name, card.dataset.host, card.querySelector(".ai-scope")?.value]
        .some((value) => String(value || "").toLocaleLowerCase().includes(query));
      card.style.display = matches ? "grid" : "none";
      if (matches) visible++;
    });
    let empty = document.getElementById("ai-tab-empty");
    if (!visible && !empty) {
      empty = document.createElement("div"); empty.id = "ai-tab-empty"; empty.className = "empty-state";
      document.getElementById("ai-resource-list")?.appendChild(empty);
    }
    if (empty) {
      empty.style.display = visible ? "none" : "block";
      empty.innerHTML = query
        ? '<i class="fas fa-search"></i><p>No matching resources.</p>'
        : '<i class="fas fa-folder-open"></i><p>No resources configured in this tab.</p>';
    }
  },

  toggleCard(input) {
    const card = input.closest(".ai-resource-card");
    card.querySelector(".ai-scope").disabled = !input.checked;
    this.sortCards();
    this.updateTabCounts();
    this.filterCards();
  },

  async copyResource(button, field) {
    const value = button.closest(".ai-resource-card")?.dataset[field];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast(field === "host" ? "IP / Host copied" : "Name copied", "success");
    } catch {
      toast("Could not copy to clipboard", "error");
    }
  },

  collect() {
    const resources = [...document.querySelectorAll(".ai-resource-card")].filter((card) => card.querySelector(".ai-resource-enabled").checked).map((card) => {
      const permissions = {};
      this.capabilities.forEach(cap => { permissions[cap] = true; });
      return { fullAccess: true, type: card.dataset.type, id: card.dataset.id, name: card.dataset.name, scope: card.querySelector(".ai-scope").value.trim(), permissions };
    });
    return {
      enabled: document.getElementById("ai-enabled").checked,
      requireApproval: false,
      sessionApproval: false,
      backupBeforeWrite: document.getElementById("ai-backup-before-write").checked,
      redactSecrets: true,
      sessionMinutes: Number(document.getElementById("ai-session-minutes").value),
      resources,
    };
  },

  async save() {
    const policy = this.collect();
    if (policy.enabled && !policy.resources.length) return toast("Select at least one resource before enabling AI Access", "warn");
    const result = await api.aiAccessSavePolicy(policy);
    if (!result.success) return toast(result.message || "Could not save AI Access policy", "error");
    this.policy = result.policy;
    const keyInput = document.getElementById("reqnora-api-key");
    const webhookInput = document.getElementById("reqnora-webhook-secret");
    const apiUrlInput = document.getElementById("reqnora-api-url");
    if (keyInput?.value.trim() || webhookInput?.value.trim()) {
      const reqnora = await api.aiAccessSaveReqnora?.({ apiKey: keyInput.value.trim(), webhookSecret: webhookInput?.value.trim(), apiUrl: apiUrlInput?.value.trim() });
      if (!reqnora?.success) return toast(reqnora?.message || "Could not save Reqnora API key", "error");
      keyInput.value = "";
      if (webhookInput) webhookInput.value = "";
    }
    toast("AI Access policy saved", "success");
    await this.loadAudit();
  },

  async copySkill() {
    const result = await api.aiAccessCopySkill();
    toast(result.success ? "Safety SKILL copied" : "Could not copy SKILL", result.success ? "success" : "error");
    await this.loadAudit();
  },

  async previewSkill() {
    const preview = document.getElementById("ai-skill-preview");
    if (preview.style.display !== "none") { preview.style.display = "none"; return; }
    const result = await api.aiAccessGetSkill();
    preview.textContent = result.content || "";
    preview.style.display = "block";
  },

  async loadAudit() {
    const result = await api.aiAccessGetAudit(20);
    const root = document.getElementById("ai-audit-list");
    if (!root) return;
    const entries = result.entries || [];
    root.innerHTML = entries.length ? entries.map((entry) => `<div class="ai-audit-item"><span>${this.escape(new Date(entry.at).toLocaleString())}</span><strong>${this.escape(entry.event)}</strong><small>${this.escape(entry.detail)}</small></div>`).join("") : '<span class="ai-muted">No AI Access activity yet.</span>';
  },

  async loadPending() {
    const result = await api.aiAccessListPending?.();
    (result?.requests || []).forEach((request) => this.showApproval(request));
  },

  showApproval(request) {
    const card = document.getElementById("ai-pending-requests");
    const list = document.getElementById("ai-pending-list");
    if (!card || !list) return toast(`AI asks to ${request.operation}: ${request.summary}`, "warn", 9000);
    if (request.id && list.querySelector(`[data-request-id="${this.escape(request.id)}"]`)) return;
    card.style.display = "block";
    const item = document.createElement("div");
    item.className = "ai-pending-item";
    item.dataset.requestId = request.id;
    item.innerHTML = `<strong>${this.escape(request.operation)}</strong><span>${this.escape(request.summary)}</span><small>${this.escape(request.resourceId)}${request.path ? ` — ${this.escape(request.path)}` : ""}</small><span class="ai-pending-actions"><button class="btn btn-primary btn-xs" onclick="AIAccess.resolve('${this.escape(request.id)}', true)">Approve</button><button class="btn btn-ghost btn-xs" onclick="AIAccess.resolve('${this.escape(request.id)}', false)">Deny</button></span>`;
    const details = request.command || request.sql || request.args?.content;
    if (details) {
      const preview = document.createElement("pre");
      preview.textContent = details;
      preview.style.cssText = "white-space:pre-wrap;overflow:auto;max-height:300px";
      item.appendChild(preview);
    }
    list.prepend(item);
  },

  async resolve(id, approved) {
    const result = await api.aiAccessResolvePending(id, approved);
    const item = document.querySelector(`[data-request-id="${this.escape(id)}"]`);
    if (item) item.remove();
    toast(result.message || (approved ? "Request approved" : "Request denied"), result.success ? "success" : "error");
    if (!result.success) await this.loadPending();
    await this.loadAudit();
  },

  showApprovalResult(result) {
    const item = result?.id ? document.querySelector(`[data-request-id="${this.escape(result.id)}"]`) : null;
    if (item) item.remove();
    const list = document.getElementById("ai-pending-list");
    const card = document.getElementById("ai-pending-requests");
    if (list && card && !list.children.length) card.style.display = "none";
    toast(result.result?.success ? "Approved VPS operation completed" : `Approved operation: ${result.result?.message || "failed"}`, result.result?.success ? "success" : "error", 8000);
    this.loadAudit();
  },
};
