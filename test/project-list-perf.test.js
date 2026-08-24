const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const {
  measureDirectorySize,
  peekProjectSize,
  invalidateProjectSize,
  invalidateProjectListCache,
  getProjects,
  getProjectSize,
} = require("../app/src/main/projects");

async function withTempWorkspace(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-proj-perf-"));
  const projectsDir = path.join(root, "projects");
  await fs.ensureDir(projectsDir);
  const prevConst = global.CONST;
  const prevState = global.STATE;
  global.CONST = { PROJECTS_DIR: projectsDir };
  global.STATE = { runningProjects: {}, logBuffer: [] };
  invalidateProjectListCache();
  invalidateProjectSize();
  try {
    await fn({ root, projectsDir });
  } finally {
    global.CONST = prevConst;
    global.STATE = prevState;
    invalidateProjectListCache();
    invalidateProjectSize();
    await fs.remove(root).catch(() => {});
  }
}

test("measureDirectorySize counts nested files", async () => {
  await withTempWorkspace(async ({ root }) => {
    const dir = path.join(root, "sample");
    await fs.ensureDir(path.join(dir, "a"));
    await fs.writeFile(path.join(dir, "a", "one.txt"), "12345");
    await fs.writeFile(path.join(dir, "two.txt"), "abc");
    const size = await measureDirectorySize(dir);
    assert.equal(size, 8);
  });
});

test("getProjects stays fast and omits uncached sizeBytes", async () => {
  await withTempWorkspace(async ({ projectsDir }) => {
    const id = "demo_local";
    const dir = path.join(projectsDir, id);
    await fs.ensureDir(path.join(dir, "www"));
    await fs.writeJson(path.join(dir, "project.json"), {
      id,
      name: "Demo",
      domain: "demo.local",
      port: 8000,
      createdAt: new Date().toISOString(),
      starred: false,
    });
    await fs.writeFile(path.join(dir, "www", "big.bin"), Buffer.alloc(1024));

    const started = Date.now();
    const list = await getProjects();
    const elapsed = Date.now() - started;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    assert.equal(list[0].sizeBytes, null);
    assert.ok(elapsed < 500, `getProjects took ${elapsed}ms`);

    const sized = await getProjectSize(id);
    assert.equal(sized.success, true);
    assert.ok(sized.sizeBytes >= 1024);
    assert.equal(peekProjectSize(dir), sized.sizeBytes);

    const again = await getProjects();
    assert.equal(again[0].sizeBytes, sized.sizeBytes);
  });
});

test("project list cache returns quickly on repeat calls", async () => {
  await withTempWorkspace(async ({ projectsDir }) => {
    const id = "cached_local";
    const dir = path.join(projectsDir, id);
    await fs.ensureDir(path.join(dir, "www"));
    await fs.writeJson(path.join(dir, "project.json"), {
      id,
      name: "Cached",
      domain: "cached.local",
      port: 8001,
      createdAt: new Date().toISOString(),
    });

    await getProjects();
    const t0 = Date.now();
    const second = await getProjects();
    assert.equal(second.length, 1);
    assert.ok(Date.now() - t0 < 100);

    global.STATE.runningProjects[id] = { startedAt: Date.now() };
    const third = await getProjects();
    assert.equal(third[0].isRunning, true);
  });
});
