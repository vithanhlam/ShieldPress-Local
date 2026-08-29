// Bootstrap a dedicated SFTP/FTP/Terminal BrowserWindow.
(async function bootRemoteSession() {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("sessionId");
  const kind = params.get("kind") || "sftp";
  const connectionId = params.get("connectionId");
  const title = params.get("title") || "Remote Session";

  document.title = title;
  document.getElementById("remote-title").textContent = title;
  const icon = document.getElementById("remote-kind-icon");
  if (kind === "terminal") icon.className = "fas fa-terminal";
  else if (kind === "ftp") icon.className = "fas fa-exchange-alt";
  else icon.className = "fas fa-folder-open";

  ContextMenu.init();

  const status = document.getElementById("remote-status");
  SFTP._sessionMode = true;
  SFTP._sessionId = sessionId;
  SFTP._sessionKind = kind;
  SFTP._sessionConnectionId = connectionId;

  // Ensure progress listeners exist without running full page init (which closes modals).
  if (!SFTP._listening) {
    SFTP._listening = true;
    api.onSftpUploadProgress((msg) => SFTP._onUploadProgress(msg));
    api.onSftpExternalSave((data) => toast(`${data.file} saved to server!`, "success"));
    api.onSftpShellData(({ id, data }) => {
      if (id === SFTP._activeShellId) SFTP._xterm?.write(data);
    });
    api.onSftpShellExit(({ id }) => {
      if (id === SFTP._activeShellId) {
        SFTP._xterm?.writeln("\r\n\x1b[33m[SSH session closed]\x1b[0m");
        SFTP._activeShellId = null;
        document.getElementById("remote-status")?.querySelector("span")?.style && (document.getElementById("remote-status").innerHTML = '<span style="color:var(--red)"><i class="fas fa-circle" style="font-size:7px"></i> Connection lost</span>');
        const termStatus = document.getElementById("sftp-term-os");
        if (termStatus) { termStatus.style.color = "var(--red)"; termStatus.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> Disconnected'; }
      }
    });
  }

  const conns = await api.sftpGetConnections();
  SFTP._connections = conns.connections || [];
  const conn = SFTP._connections.find((c) => c.id === connectionId);
  if (!conn) {
    status.innerHTML = '<span style="color:var(--red)">Connection not found</span>';
    return;
  }

  const setStatus = (state, transport) => {
    const connected = state === "connected";
    const color = connected ? "var(--green)" : state === "checking" ? "var(--yellow)" : "var(--red)";
    const label = connected
      ? (transport === "ssh" ? "SSH connected · SFTP unavailable" : `${kind === "ftp" ? "FTP" : kind === "terminal" ? "SSH" : "SFTP"} connected`)
      : state === "checking" ? "Checking connection…" : "Connection lost";
    status.innerHTML = `<span style="color:${color}"><i class="fas fa-circle" style="font-size:7px"></i> ${label}</span>`;
    const termStatus = document.getElementById("sftp-term-os");
    if (termStatus) {
      termStatus.style.color = color;
      termStatus.innerHTML = `<i class="fas fa-circle" style="font-size:7px"></i> ${connected ? "Connected" : state === "checking" ? "Checking…" : "Disconnected"}`;
    }
  };
  const pollStatus = async () => {
    const result = await api.sftpConnectionStatus(sessionId).catch(() => ({ connected: false }));
    setStatus(result.connected ? "connected" : "disconnected", result.transport || conn.transport);
  };
  setStatus("checking", conn.transport);
  pollStatus();
  const statusPoll = setInterval(pollStatus, 4000);

  // Main already connected the session when opening the window; verify list works.
  setStatus("connected", conn.transport);

  if (kind === "terminal") {
    document.getElementById("remote-terminal-pane").classList.add("active");
    document.getElementById("sftp-term-conn-id").value = sessionId;
    document.getElementById("sftp-term-name") && (document.getElementById("sftp-term-name").textContent = conn.name);
    SFTP._termPath = conn.lastBrowsedPath || conn.remotePath || "/";
    SFTP._bindTerminalSplitter();
    SFTP._setupTermDragDrop();
    SFTP._setupTerminalClipboard();
    SFTP._loadRemoteSystemSuggestions(sessionId);
    SFTP._startRemoteMetrics(sessionId);
    await SFTP.loadTermFiles();
    await SFTP._startInteractiveTerminal(sessionId, sessionId);
  } else {
    document.getElementById("remote-browser-pane").classList.add("active");
    document.getElementById("sftp-browser-conn-id").value = sessionId;
    SFTP._currentPath = conn.lastBrowsedPath || conn.remotePath || "/";
    SFTP._setupDragDrop();
    await SFTP._loadDir();
  }

  window.addEventListener("beforeunload", () => {
    clearInterval(statusPoll);
    try {
      if (SFTP._activeShellId) api.sftpShellStop(SFTP._activeShellId);
    } catch {}
  });
})();
