const assert = require("node:assert/strict");
const test = require("node:test");
const { quotePhpIniValue, phpDllNotFound, getPhpPort } = require("../app/src/main/services");

test("PHP 8.3, 8.4, and 8.5 use distinct CGI ports", () => {
  assert.equal(getPhpPort("8.3"), 9083);
  assert.equal(getPhpPort("8.4"), 9084);
  assert.equal(getPhpPort("8.5"), 9085);
});

test("quotes PHP extension_dir values that contain spaces", () => {
  assert.equal(
    quotePhpIniValue("C:\\Program Files\\ShieldPress Local\\bin\\php\\8.4\\ext"),
    '"C:/Program Files/ShieldPress Local/bin/php/8.4/ext"',
  );
  assert.equal(quotePhpIniValue("/opt/shieldpress/php/8.3/ext"), "/opt/shieldpress/php/8.3/ext");
});

test("detects Windows missing Visual C++ exit status for PHP 8.4", () => {
  assert.equal(phpDllNotFound(3221225781), true);
  assert.equal(phpDllNotFound(0), false);
});
