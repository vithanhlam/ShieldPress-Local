// src/main/logger.js
function log(level, msg) {
  const line = `[${new Date().toTimeString().slice(0, 8)}] [${level}] ${msg}`;
  console.log(Buffer.from(line, "utf8").toString());
  const { logBuffer, mainWindow } = global.STATE;
  logBuffer.push(line);
  if (logBuffer.length > 500) logBuffer.splice(0, logBuffer.length - 500);
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
