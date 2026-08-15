const assert = require("node:assert/strict");
const test = require("node:test");
const { hostsContainsDomain } = require("../app/src/main/projects");

test("hosts matching ignores comments and substring domains", () => {
  const hosts = [
    "# 127.0.0.1 demo.local",
    "127.0.0.1\tmy-demo.local",
    "127.0.0.1 example.local",
  ].join("\n");
  assert.equal(hostsContainsDomain(hosts, "example.local"), true);
  assert.equal(hostsContainsDomain(hosts, "demo.local"), false);
  assert.equal(hostsContainsDomain(hosts, "my-demo.local"), true);
});
