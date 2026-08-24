const fs = require("fs-extra");
const path = require("path");
const { spawnSync } = require("child_process");

const isWindows = process.platform === "win32";
const isLinux = process.platform === "linux";

function findCommand(names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const result = spawnSync(isWindows ? "where" : "which", [name], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) {
      const found = result.stdout.split(/\r?\n/).find(Boolean);
      if (found) return found.trim();
    }
  }
  return null;
}

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function linuxCommandNames(kind, version) {
  if (kind === "phpCgi" && version) {
    return [`php-cgi${version}`, `php${version}-cgi`];
  }
  if (kind === "php" && version) return [`php${version}`];

  const commands = {
    nginx: ["nginx"], phpCgi: ["php-cgi"], php: ["php"],
    mysqld: ["mariadbd", "mysqld"], mysql: ["mariadb", "mysql"],
    mysqldump: ["mariadb-dump", "mysqldump"],
    mysqladmin: ["mariadb-admin", "mysqladmin"],
    redisServer: ["redis-server"], redisCli: ["redis-cli"], mkcert: ["mkcert"],
  };
  return commands[kind] || [];
}

function phpCgiExecutables() {
  if (!isLinux) return [];
  const found = new Set();
  const generic = findCommand("php-cgi");
  if (generic) found.add(generic);

  const phpBaseDir = global.CONST?.PHP_BASE_DIR;
  if (phpBaseDir) {
    try {
      for (const version of fs.readdirSync(phpBaseDir)) {
        const bundled = path.join(phpBaseDir, version, "php-cgi");
        if (fs.existsSync(bundled)) found.add(bundled);
      }
    } catch {
      // A system-only Linux installation does not have a bundled PHP directory.
    }
  }

  const searchDirs = new Set((process.env.PATH || "").split(path.delimiter).filter(Boolean));
  searchDirs.add("/usr/bin");
  searchDirs.add("/usr/local/bin");
  for (const dir of searchDirs) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (/^php-cgi\d+\.\d+$/.test(name) || /^php\d+\.\d+-cgi$/.test(name)) {
          found.add(path.join(dir, name));
        }
      }
    } catch {
      // PATH can contain inaccessible or missing directories.
    }
  }
  return [...found];
}

function executable(kind, version) {
  const { BIN_DIR, MARIADB_DIR, NGINX_DIR, getPhpDir } = global.CONST;
  const win = {
    nginx: [path.join(NGINX_DIR, "nginx.exe")],
    phpCgi: [path.join(getPhpDir(version || "8.3"), "php-cgi.exe")],
    php: [path.join(getPhpDir(version || "8.3"), "php.exe")],
    mysqld: [path.join(MARIADB_DIR, "bin", "mysqld.exe")],
    mysql: [path.join(MARIADB_DIR, "bin", "mysql.exe")],
    mysqldump: [path.join(MARIADB_DIR, "bin", "mysqldump.exe")],
    mysqladmin: [path.join(MARIADB_DIR, "bin", "mysqladmin.exe")],
    redisServer: [path.join(BIN_DIR, "redis", "redis-server.exe")],
    redisCli: [path.join(BIN_DIR, "redis", "redis-cli.exe")],
    mkcert: [path.join(BIN_DIR, "mkcert", "mkcert.exe")],
  };
  if (isWindows) return firstExisting(win[kind] || []);
  if (version && (kind === "phpCgi" || kind === "php")) {
    const bundledName = kind === "phpCgi" ? "php-cgi" : "php";
    const bundled = firstExisting([path.join(getPhpDir(version), bundledName)]);
    if (bundled) {
      // Prefer a bundled binary only when it can actually start (stale 8.5
      // builds linked against missing libssl.so.4 must fall back to system PHP).
      const probeArgs = kind === "phpCgi" ? ["-v"] : ["-v"];
      const libDir = path.join(path.dirname(bundled), "lib");
      const env = { ...process.env };
      if (fs.existsSync(libDir)) {
        env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${libDir}:${env.LD_LIBRARY_PATH}` : libDir;
      }
      // Shell wrappers (php/php-cgi for 8.3) need to be executed as scripts.
      const probe = require("child_process").spawnSync(bundled, probeArgs, {
        encoding: "utf8",
        timeout: 5000,
        env,
        cwd: path.dirname(bundled),
      });
      const output = `${probe.stdout || ""}\n${probe.stderr || ""}`;
      if (!probe.error && probe.status === 0 && /PHP\s+\d+\.\d+/i.test(output)) return bundled;
    }
  }
  return findCommand(linuxCommandNames(kind, version));
}

function hostsFile() {
  return isWindows
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
}

function commandLabel(kind) {
  const labels = {
    nginx: "Nginx", phpCgi: "PHP-CGI", php: "PHP CLI", mysqld: "MariaDB server",
    mysql: "MariaDB client", mysqldump: "MariaDB dump", redisServer: "Redis", mkcert: "mkcert",
  };
  return labels[kind] || kind;
}

/** Keep an interactive shell open after a one-shot npm/composer command exits.
 *  GUI-launched Electron has a minimal PATH (no nvm). Source common Node managers
 *  and use an interactive bash so ~/.bashrc / nvm become available. */
function linuxNodeBootstrap() {
  return [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    'command -v fnm >/dev/null 2>&1 && eval "$(fnm env)"',
    '[ -s "$HOME/.local/share/fnm/fnm" ] && eval "$("$HOME/.local/share/fnm/fnm" env)"',
    '[ -s "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh"',
    '[ -d "$HOME/.local/share/mise/shims" ] && export PATH="$HOME/.local/share/mise/shims:$PATH"',
    '[ -d "$HOME/.local/bin" ] && export PATH="$HOME/.local/bin:$PATH"',
  ].join("; ");
}

function linuxKeepaliveCommand(cmd) {
  if (!cmd) return null;
  return `${linuxNodeBootstrap()}; ${cmd}; echo; echo "[Done — shell kept open]"; exec bash`;
}

function terminalBaseName(bin) {
  try {
    return path.basename(fs.realpathSync(bin)).toLowerCase();
  } catch {
    return path.basename(bin).toLowerCase();
  }
}

/**
 * Build argv for common Linux terminal emulators.
 * Ubuntu often maps x-terminal-emulator → Terminator/Ptyxis, which reject
 * gnome-terminal's bare `--` form used previously (buttons appeared to do nothing).
 */
function linuxTerminalArgs(bin, cwd, cmd) {
  const name = terminalBaseName(bin);
  const keep = linuxKeepaliveCommand(cmd);
  // -i loads ~/.bashrc (nvm); non-interactive -lc often cannot find npm.
  const bashIc = keep ? ["bash", "-ic", keep] : null;

  if (name.includes("ptyxis")) {
    const args = ["--new-window", `--working-directory=${cwd}`];
    if (bashIc) args.push("--", ...bashIc);
    return args;
  }

  if (name.includes("gnome-terminal") || name === "kgx" || name === "gnome-console") {
    const args = [`--working-directory=${cwd}`];
    if (bashIc) args.push("--", ...bashIc);
    return args;
  }

  if (name.includes("konsole")) {
    const args = ["--workdir", cwd];
    if (bashIc) args.push("-e", ...bashIc);
    return args;
  }

  if (name.includes("xfce4-terminal")) {
    const args = [`--working-directory=${cwd}`];
    if (bashIc) args.push("-e", bashIc.join(" "));
    return args;
  }

  if (name.includes("tilix")) {
    const args = ["-w", cwd];
    if (bashIc) args.push("-e", ...bashIc);
    return args;
  }

  if (name.includes("alacritty")) {
    const args = ["--working-directory", cwd];
    if (bashIc) args.push("-e", ...bashIc);
    return args;
  }

  if (name.includes("kitty")) {
    const args = ["--directory", cwd];
    if (bashIc) args.push(...bashIc);
    else args.push("bash", "-i");
    return args;
  }

  if (name.includes("xterm") && !name.includes("gnome")) {
    const wrapped = keep
      ? `cd ${JSON.stringify(cwd)} && ${keep}`
      : `cd ${JSON.stringify(cwd)}; exec bash -i`;
    return ["-e", "bash", "-ic", wrapped];
  }

  // Terminator, x-terminal-emulator, and other Debian-style terminals:
  // use -e / --working-directory (NOT gnome-style bare `--`).
  const args = [`--working-directory=${cwd}`];
  if (bashIc) args.push("-e", ...bashIc);
  return args;
}

function windowsNodePathPrefix() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs"),
    path.join(local, "Programs", "nodejs"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, ".nvm", "nodejs"),
  ];
  return candidates.filter((dir) => {
    try {
      return fs.existsSync(path.join(dir, "npm.cmd")) || fs.existsSync(path.join(dir, "npm.exe")) || fs.existsSync(path.join(dir, "node.exe"));
    } catch {
      return false;
    }
  });
}

function windowsTerminalLaunch(cwd, cmd) {
  // `start "title"` — the first quoted token is the window title (required).
  // `/D` sets the project www directory explicitly for the new console.
  const title = "ShieldPress Local";
  const pathBits = windowsNodePathPrefix();
  const pathBoot = pathBits.length
    ? `set "PATH=${pathBits.join(";")};%PATH%" & `
    : "";
  const shellCmd = cmd && String(cmd).trim()
    ? `${pathBoot}${String(cmd).trim()}`
    : `${pathBoot}echo ShieldPress Local terminal ready.`;
  return {
    bin: "cmd.exe",
    args: ["/c", "start", title, "/D", cwd, "cmd.exe", "/k", shellCmd],
  };
}

/** Extra Node bin dirs for GUI Electron (often missing nvm from PATH). */
function developerPathDirs() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const dirs = [];
  if (!home) return dirs;

  if (isWindows) return windowsNodePathPrefix();

  const nvmVersions = path.join(home, ".nvm", "versions", "node");
  try {
    if (fs.existsSync(nvmVersions)) {
      const versions = fs.readdirSync(nvmVersions).sort().reverse();
      for (const version of versions) {
        const bin = path.join(nvmVersions, version, "bin");
        if (fs.existsSync(path.join(bin, "npm"))) {
          dirs.push(bin);
          break;
        }
      }
    }
  } catch {}

  for (const candidate of [
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "mise", "shims"),
    path.join(home, ".asdf", "shims"),
    "/usr/local/bin",
  ]) {
    if (fs.existsSync(candidate)) dirs.push(candidate);
  }
  return dirs;
}

function envWithDeveloperPath(baseEnv = process.env) {
  const dirs = developerPathDirs();
  if (!dirs.length) return { ...baseEnv };
  const key = Object.keys(baseEnv).find((k) => k.toLowerCase() === "path") || "PATH";
  const current = baseEnv[key] || "";
  const merged = [...dirs, ...current.split(path.delimiter).filter(Boolean)];
  const unique = [...new Set(merged)];
  return { ...baseEnv, [key]: unique.join(path.delimiter) };
}

/** Resolve an external OS terminal launch for Node/NPM project tools. */
function buildExternalTerminalLaunch(cwd, cmd = "") {
  if (isWindows) return windowsTerminalLaunch(cwd, cmd);

  const candidates = [
    "ptyxis",
    "gnome-terminal",
    "kgx",
    "xfce4-terminal",
    "konsole",
    "tilix",
    "terminator",
    "x-terminal-emulator",
    "alacritty",
    "kitty",
    "xterm",
  ];
  const bin = findCommand(candidates);
  if (!bin) return null;
  return { bin, args: linuxTerminalArgs(bin, cwd, cmd) };
}

module.exports = {
  isWindows, isLinux, findCommand, executable, hostsFile, commandLabel,
  linuxCommandNames, phpCgiExecutables, buildExternalTerminalLaunch,
  linuxTerminalArgs, windowsTerminalLaunch, linuxKeepaliveCommand,
  linuxNodeBootstrap, envWithDeveloperPath, developerPathDirs,
};
