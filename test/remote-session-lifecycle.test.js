const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { bindRemoteSessionLifecycle } = require("../app/src/main/remote-session-lifecycle");

for (const event of ["closed", "destroyed", "render-process-gone"]) {
  test(`remote session releases its connection once on ${event}`, () => {
    const win = new EventEmitter();
    win.webContents = new EventEmitter();
    let calls = 0;
    bindRemoteSessionLifecycle(win, () => calls++);
    (event === "closed" ? win : win.webContents).emit(event);
    win.webContents.emit("destroyed");
    win.emit("closed");
    assert.equal(calls, 1);
  });
}
