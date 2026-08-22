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

  // Main already connected the session when opening the window; verify list works.
  status.innerHTML = '<i class="fas fa-circle" style="font-size:7px"></i> Connected';

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
    try {
      if (SFTP._activeShellId) api.sftpShellStop(SFTP._activeShellId);
    } catch {}
  });
})();
