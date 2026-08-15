const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ioncubeWindowsCompiler,
  ioncubeArchiveName,
  ioncubeLoaderFileName,
} = require("../app/src/main/extensions");

test("Windows PHP 8.3 ionCube uses the VC16 NTS package", () => {
  assert.equal(ioncubeWindowsCompiler("8.3"), "vc16");
  assert.equal(ioncubeArchiveName("8.3", "win32"), "ioncube_loaders_win_nonts_vc16_x86-64.zip");
  assert.equal(ioncubeLoaderFileName("8.3", "win32"), "ioncube_loader_win_8.3.dll");
});

test("Windows PHP 8.4 and 8.5 ionCube use the VC17 NTS package", () => {
  assert.equal(ioncubeWindowsCompiler("8.4"), "vc17");
  assert.equal(ioncubeWindowsCompiler("8.5"), "vc17");
  assert.equal(ioncubeArchiveName("8.4", "win32"), "ioncube_loaders_win_nonts_vc17_x86-64.zip");
  assert.equal(ioncubeArchiveName("8.5", "win32"), "ioncube_loaders_win_nonts_vc17_x86-64.zip");
  assert.equal(ioncubeLoaderFileName("8.5", "win32"), "ioncube_loader_win_8.5.dll");
});

test("Linux ionCube uses the x86-64 loader archive for 8.3-8.5", () => {
  assert.equal(ioncubeArchiveName("8.3", "linux"), "ioncube_loaders_lin_x86-64.zip");
  assert.equal(ioncubeLoaderFileName("8.4", "linux"), "ioncube_loader_lin_8.4.so");
  assert.equal(ioncubeLoaderFileName("8.5", "linux"), "ioncube_loader_lin_8.5.so");
});
