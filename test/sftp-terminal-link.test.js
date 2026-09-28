const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("terminal file browser follows a directory link but keeps its own operation path", () => {
  const list = {
    dataset: {},
    innerHTML: "",
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const context = {
    window: {},
    document: {
      getElementById: (id) => id === "sftp-term-files" ? list : null,
      querySelectorAll: () => [],
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "../app/renderer/js/sftp.js"), "utf8");
  vm.runInNewContext(source, context);
  const sftp = context.window.SFTP;
  sftp._termPath = "/home/admin";
  sftp._termItems = [{
    name: "root-link",
    isDirectory: true,
    isLink: true,
    targetPath: "/",
    linkPath: "/home/admin/root-link",
  }];

  sftp._renderTermFiles();

  assert.match(list.innerHTML, /SFTP\.termEnterPath\('%2F'\)/);
  assert.match(list.innerHTML, /data-remote-operation-path="%2Fhome%2Fadmin%2Froot-link"/);
  assert.match(list.innerHTML, /SFTP\.termDeleteItem\('%2Fhome%2Fadmin%2Froot-link',false\)/);
});
