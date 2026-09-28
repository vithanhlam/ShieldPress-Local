const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUI(document, extras = {}) {
  const context = { window: {}, document, ...extras };
  const source = fs.readFileSync(path.join(__dirname, "../app/renderer/js/ai-access.js"), "utf8");
  vm.runInNewContext(source, context);
  return context.window.AIAccess;
}

test("AI resources show VPS host and copy controls without adding host to policy", () => {
  const root = { innerHTML: "" };
  const ui = loadUI({ getElementById: (id) => id === "ai-resource-list" ? root : null });
  ui.policy = { resources: [{ type: "vps", id: "one", scope: "/", permissions: { read: true } }] };
  ui.resources = [{ type: "vps", id: "one", name: "SFTP — ShieldPress", host: "10.0.0.1", scope: "/" }];
  ui.sortCards = () => {};
  ui.updateTabCounts = () => {};
  ui.tab = () => {};

  ui.render();

  assert.match(root.innerHTML, /IP \/ Host: 10\.0\.0\.1/);
  assert.match(root.innerHTML, /data-host="10\.0\.0\.1"/);
  assert.match(root.innerHTML, /copyResource\(this, 'name'\)/);
  assert.match(root.innerHTML, /copyResource\(this, 'host'\)/);
  assert.equal(ui.policy.resources[0].host, undefined);
});

test("AI resource counts, ordering, and search follow current checkboxes", () => {
  const makeCard = (type, name, host, order, checked) => ({
    dataset: { type, name, host, order: String(order) },
    style: {},
    querySelector: (selector) => selector === ".ai-resource-enabled" ? { checked } : { value: "/" },
  });
  const cards = [
    makeCard("vps", "SFTP — First", "10.0.0.1", 0, false),
    makeCard("vps", "SFTP — Selected", "10.0.0.2", 1, true),
    makeCard("source", "Project", "", 2, true),
  ];
  const badges = ["vps", "source"].map((type) => ({
    dataset: { aiTab: type },
    badge: { textContent: "" },
    querySelector() { return this.badge; },
  }));
  const root = {
    querySelectorAll: () => cards,
    appendChild(card) { cards.splice(cards.indexOf(card), 1); cards.push(card); },
  };
  const search = { value: "10.0.0.2" };
  const ui = loadUI({
    getElementById: (id) => ({ "ai-resource-list": root, "ai-resource-search": search })[id] || null,
    querySelectorAll: (selector) => selector === "[data-ai-tab]" ? badges : cards,
  });
  ui.currentTab = "vps";

  ui.sortCards();
  ui.updateTabCounts();
  ui.filterCards();

  assert.equal(cards[0].dataset.name, "SFTP — Selected");
  assert.equal(badges[0].badge.textContent, "1");
  assert.equal(badges[1].badge.textContent, "1");
  assert.equal(cards[0].style.display, "grid");
  assert.equal(cards[1].style.display, "none");
  assert.equal(cards[2].style.display, "none");
});
