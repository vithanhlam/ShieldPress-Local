// src/main/logger.js
function log(level, msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] [${level}] ${msg}`;
  console.log(Buffer.from(line, "utf8").toString());
  const state = global.STATE || {};
  const logBuffer = state.logBuffer || (state.logBuffer = []);
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);

  // Only push live lines while the Debug page has subscribed — avoids IPC spam.
  if (!state.liveLogsEnabled) return;
  const { mainWindow } = state;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log-line", line);
  }
}

module.exports = {
  info : (m) => log("INFO ", m),
  ok   : (m) => log("OK   ", m),
  err  : (m) => log("ERROR", m),
  warn : (m) => log("WARN ", m),
};
