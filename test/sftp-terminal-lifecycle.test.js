const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

global.STATE ||= { logBuffer: [], mainWindow: null };
global.CONST ||= { DATA_DIR: "/tmp/shieldpress-test-data" };

const { __test } = require("../app/src/main/sftp");

function makeStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = () => { stream.destroyed = true; };
  return stream;
}

test("SSH probe timeout destroys its channel instead of retaining it", async () => {
  const stream = makeStream();
  const result = await __test.sshExecText({
    client: { exec(_command, callback) { callback(null, stream); } },
  }, "true", 5);

  assert.deepEqual(result, { success: false, message: "timeout" });
  assert.equal(stream.destroyed, true);
});

test("SSH probe resolves normally when its channel closes", async () => {
  const stream = makeStream();
  const request = __test.sshExecText({
    client: { exec(_command, callback) { callback(null, stream); } },
  }, "printf ok", 100);
  stream.emit("data", Buffer.from("ok"));
  stream.emit("close");

  assert.deepEqual(await request, { success: true, output: "ok" });
  assert.equal(stream.destroyed, false);
});
