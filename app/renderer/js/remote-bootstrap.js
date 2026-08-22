// Minimal helpers for remote BrowserWindows (no main app shell).
window.App = { currentPage: "remote-session", projects: [] };

window.toast = function (msg, type = "info", duration = 3500) {
  const c = document.getElementById("toast-container");
  if (!c) return;
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  const icon = {
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

window.openModal = (id) => document.getElementById(id)?.classList.add("open");
window.closeModal = (id) => document.getElementById(id)?.classList.remove("open");
window.closeIfOverlay = (e, id) => {
  if (e.target.id === id) closeModal(id);
};

document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const remote = typeof SFTP !== "undefined" ? SFTP.getRemoteContext(e.target) : null;
  if (remote) {
    ContextMenu.showRemote(e.clientX, e.clientY, remote);
    return;
  }
  if (typeof SFTP !== "undefined" && SFTP.isTerminalClipboardTarget?.(e.target)) {
    SFTP.pasteIntoTerminal();
  }
});

document.addEventListener("click", () => ContextMenu.hide?.());
