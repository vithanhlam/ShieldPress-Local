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
    if (bundled) return bundled;
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

module.exports = {
  isWindows, isLinux, findCommand, executable, hostsFile, commandLabel,
  linuxCommandNames, phpCgiExecutables,
};
