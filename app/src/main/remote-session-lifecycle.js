"use strict";

// Clean up on renderer failure as well as normal window close. A failed
// renderer cannot acknowledge terminal output or close its SSH connection.
function bindRemoteSessionLifecycle(win, cleanup) {
  let cleaned = false;
  const release = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  win.once("closed", release);
  win.webContents.once("destroyed", release);
  win.webContents.once("render-process-gone", release);
  return release;
}

module.exports = { bindRemoteSessionLifecycle };
