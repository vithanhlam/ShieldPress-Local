const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");
const platform = require("../app/src/main/platform");

test("Windows terminal launch sets title, /D cwd, and keeps shell with /k", () => {
  const cwd = "D:\\ShieldPress\\projects\\demo\\www";
  const launch = platform.windowsTerminalLaunch(cwd, "npm run dev");
  assert.equal(launch.bin, "cmd.exe");
  assert.equal(launch.args[0], "/c");
  assert.equal(launch.args[1], "start");
  assert.equal(launch.args[2], "ShieldPress Local");
  assert.equal(launch.args[3], "/D");
  assert.equal(launch.args[4], cwd);
  assert.equal(launch.args[5], "cmd.exe");
  assert.equal(launch.args[6], "/k");
  assert.match(launch.args[7], /npm run dev/);
});

test("Windows empty terminal still opens cmd in the project directory", () => {
  const cwd = "C:\\data\\www";
  const launch = platform.windowsTerminalLaunch(cwd, "");
  assert.equal(launch.args[3], "/D");
  assert.equal(launch.args[4], cwd);
  assert.equal(launch.args[6], "/k");
  assert.match(launch.args[7], /terminal ready/i);
});

test("Terminator-style terminals use interactive bash so nvm/npm resolve", () => {
  const cwd = "/home/user/project/www";
  const args = platform.linuxTerminalArgs("/usr/bin/terminator", cwd, "npm install");
  assert.equal(args[0], `--working-directory=${cwd}`);
  assert.equal(args[1], "-e");
  assert.equal(args[2], "bash");
  assert.equal(args[3], "-ic");
  assert.match(args[4], /nvm\.sh/);
  assert.match(args[4], /npm install;/);
  assert.ok(!args.includes("--") || args.indexOf("--") > args.indexOf("-e"));
});

test("x-terminal-emulator args stay Debian-compatible (no leading --)", () => {
  const cwd = "/tmp/www";
  const args = platform.linuxTerminalArgs("/usr/bin/x-terminal-emulator", cwd, "npm run dev");
  assert.equal(args[0], `--working-directory=${cwd}`);
  assert.equal(args[1], "-e");
  assert.notEqual(args[0], "--");
  assert.notEqual(args[1], "--");
  assert.equal(args[3], "-ic");
});

test("Ptyxis and gnome-terminal keep gnome-style -- command separator", () => {
  const cwd = "/srv/www";
  const ptyxis = platform.linuxTerminalArgs("/usr/bin/ptyxis", cwd, "npm run build");
  assert.ok(ptyxis.includes("--"));
  assert.ok(ptyxis.some((a) => a.startsWith("--working-directory=")));
  assert.equal(ptyxis[ptyxis.indexOf("--") + 2], "-ic");

  const gnome = platform.linuxTerminalArgs("/usr/bin/gnome-terminal", cwd, "npm test");
  assert.deepEqual(gnome.slice(0, 2), [`--working-directory=${cwd}`, "--"]);
  assert.equal(gnome[2], "bash");
  assert.equal(gnome[3], "-ic");
});

test("Konsole uses --workdir and -e", () => {
  const cwd = "/var/www";
  const args = platform.linuxTerminalArgs("/usr/bin/konsole", cwd, "npm start");
  assert.deepEqual(args.slice(0, 3), ["--workdir", cwd, "-e"]);
  assert.equal(args[3], "bash");
  assert.equal(args[4], "-ic");
});

test("linux keepalive bootstraps nvm before the user command", () => {
  const cmd = platform.linuxKeepaliveCommand("npm run dev");
  assert.match(cmd, /NVM_DIR/);
  assert.match(cmd, /nvm\.sh/);
  assert.match(cmd, /npm run dev;/);
});

test("envWithDeveloperPath prepends nvm bin when present", () => {
  if (process.platform === "win32") return;
  const home = process.env.HOME;
  const nvmRoot = path.join(home, ".nvm", "versions", "node");
  if (!require("fs").existsSync(nvmRoot)) return;
  const env = platform.envWithDeveloperPath({ PATH: "/usr/bin:/bin" });
  assert.match(env.PATH, /\.nvm\/versions\/node\/.+\/bin/);
  assert.ok(env.PATH.startsWith(path.join(home, ".nvm")) || env.PATH.includes(`${path.delimiter}${path.join(home, ".nvm")}`) || env.PATH.includes(".nvm/versions/node"));
});

test("buildExternalTerminalLaunch resolves a terminal on this host", () => {
  if (process.platform === "win32") {
    const launch = platform.buildExternalTerminalLaunch("C:\\www", "npm run dev");
    assert.equal(launch.bin, "cmd.exe");
    return;
  }
  const launch = platform.buildExternalTerminalLaunch("/tmp", "npm run dev");
  assert.ok(launch, "expected a terminal emulator on Linux CI/dev machines");
  assert.ok(launch.bin);
  assert.ok(Array.isArray(launch.args));
  assert.ok(launch.args.length >= 1);
  if (path.basename(launch.bin).includes("terminator")
    || path.basename(launch.bin) === "x-terminal-emulator") {
    assert.equal(launch.args[1], "-e");
  }
});
