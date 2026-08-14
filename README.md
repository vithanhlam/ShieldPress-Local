# ShieldPress Local

<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/logo.png" width="480" alt="ShieldPress Local"/>
</p>

<p align="center">
  <strong>A fast, lightweight local development environment for WordPress, Laravel & PHP on Windows and Ubuntu</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/vithanhlam/shieldpress-local?style=flat-square&color=e07b1a" alt="Release"/>
  <img src="https://img.shields.io/github/downloads/vithanhlam/shieldpress-local/total?style=flat-square&color=22c55e" alt="Downloads"/>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20%7C%20Ubuntu-blue?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/license-Freeware-orange?style=flat-square" alt="License"/>
</p>

---

## Download

**[⬇ Download Latest Version (v2.5.20)](https://github.com/vithanhlam/shieldpress-local/releases/latest)**

| File | Description |
| ---- | ----------- |
| `ShieldPress.Local.Setup.2.5.20.exe` | Windows NSIS installer |
| `shieldpresslocal_2.5.20_amd64.deb` | Ubuntu/Debian installer |

---

## Screenshots

<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/projects.png" width="800" alt="Projects"/>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/1.png" width="390" alt="Screenshot 1"/>
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/2.png" width="390" alt="Screenshot 2"/>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/3.png" width="390" alt="Screenshot 3"/>
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/4.png" width="390" alt="Screenshot 4"/>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/5.png" width="390" alt="Screenshot 5"/>
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/6.png" width="390" alt="Screenshot 6"/>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/7.png" width="390" alt="Screenshot 7"/>
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/8.png" width="390" alt="Screenshot 8"/>
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/9.png" width="390" alt="Screenshot 9"/>
  <img src="https://raw.githubusercontent.com/vithanhlam/ShieldPress-Local/main/screenshots/10.png" width="390" alt="Screenshot 10"/>
</p>

---

## What is ShieldPress Local?

ShieldPress Local is a desktop application that lets you run WordPress, Laravel, and PHP-based websites locally on Windows or Ubuntu — no technical expertise required.

It provides everything you need: **Nginx**, **MariaDB**, **phpMyAdmin**, and multi-version PHP — **PHP 8.3/8.4 on Windows** and **PHP 8.4/8.5 on Ubuntu** — all managed through a clean, modern interface.

---

## Features

### Core

| Feature | Description |
| ------- | ----------- |
| **Multi-site** | Run unlimited projects on different ports (8000, 8001...) |
| **One-click Start** | Start/stop any project instantly |
| **Open in Editor** | Open project in VS Code, Notepad++, Sublime Text — auto-detects or configurable |
| **WordPress Install** | Auto-download and install WordPress |
| **Laravel Install** | Auto-download and install Laravel |
| **Terminal** | Terminal for npm run, start, build |
| **WP-CLI** | Run WP-CLI commands from within the app |
| **Debug Logs** | View Nginx, PHP, MariaDB and WP debug logs |
| **Full Backup** | Backup source files + database into a single ZIP |
| **Cloud Backup** | Backup to Google Drive, OneDrive, or Dropbox — no login required |
| **Clone WordPress** | Clone any project with automatic URL replacement |
| **Database Manager** | Create, import, export, and drop databases with progress, table count, and size |
| **Project Disk Usage** | View total source and metadata size directly on every project card |
| **Config Editor** | Edit php.ini, my.ini, and per-project Nginx config |
| **SSL (HTTPS)** | One-click local HTTPS via mkcert |
| **Git Push** | Push to GitHub, pull, custom git commands, clone repos |
| **Tags & Search** | Tag and search projects easily |
| **System Tray** | Minimize to background, always accessible |

### SFTP & FTP Manager

| Feature | Description |
| ------- | ----------- |
| **SFTP / FTP / FTPS Client** | Connect to remote servers via SFTP (SSH), FTP, or FTP secured with explicit TLS |
| **Search & Filter** | Search connections by name, host, or username; filter by protocol type |
| **File Browser** | Browse, upload, download, delete, create folders |
| **File Context Menu** | Right-click to create, refresh, download, edit, delete, duplicate, move, or copy a remote path |
| **Inline Editor** | Edit remote files directly in the app |
| **External Editor** | Open remote files in VS Code — auto-uploads on save |
| **Open With** | Choose any installed local editor for a remote file while retaining automatic upload on save |
| **Drag & Drop** | Drag files from Explorer to upload |
| **ZIP Upload & Extract** | Upload ZIP and extract on server |
| **Interactive SSH Terminal** | Persistent SSH PTY powered by Xterm.js with ANSI colors, native Tab completion, interactive programs, selection, paste, and quick commands |
| **Terminal File Manager** | Full right-click file management beside the SSH terminal: create, refresh, download, edit, duplicate, move, delete, upload, and copy paths |
| **Terminal Autocomplete** | Complete live remote paths with Tab and choose context-aware Linux, npm, Git, Composer, Artisan, and WP-CLI commands with the keyboard |
| **Linux-Aware Commands** | Detect Ubuntu/Debian, RHEL/Fedora, Alpine, Arch, or SUSE and suggest matching package and service commands |
| **ShieldPress VPS Command** | Suggest the `shieldpress` command for opening the ShieldPress VPS management menu |
| **Multiline Commands** | Auto-growing command editor with multiline paste, Shift+Enter line breaks, and Ctrl+Enter execution |
| **Terminal Clipboard** | Auto-copy selected output, right-click to paste, Ctrl+Shift+C/V shortcuts, and persistent font-size controls |
| **Sync Upload/Download** | Push/pull files with optional "changed files only" mode and clear busy state |
| **Auto-Reconnect** | Detects dead connections and reconnects transparently before each operation |
| **Local Path Validation** | Validates local folder exists before sync starts |
| **Master Password Vault** | Portable credential vault using scrypt key derivation and authenticated AES-256-GCM encryption; the Master Password is never stored |

### Extensions & Tools

| Feature | Description |
| ------- | ----------- |
| **Extension Manager** | Toggle 45+ PHP extensions on/off by category |
| **ionCube Loader** | Auto-install ionCube for any PHP version |
| **Redis** | Download, start/stop/restart Redis, flush cache, port config |
| **Email Testing** | Configure SMTP with SSL/TLS/STARTTLS — PHP `mail()` works out of the box |
| **Cache Management** | OPcache config, WP cache flush, project cleanup, Nginx log clear |
| **System Monitor** | Real-time CPU, RAM, Disk usage in titlebar |

---

## Requirements

- **OS:** Windows 10 / 11 (64-bit), or Ubuntu 22.04 and newer (64-bit)
- **RAM:** 2GB minimum, 4GB recommended
- **Disk:** 2GB for the app + space for your projects
- **Admin rights:** Required for installation and local hosts-file changes

---

## Installation

### Windows

1. Download `ShieldPress.Local.Setup.2.5.20.exe` from [Releases](https://github.com/vithanhlam/shieldpress-local/releases)
2. Run the installer and follow the wizard
3. Choose where to store your project data when prompted
4. Launch **ShieldPress Local** from the desktop shortcut

### Ubuntu

1. Download `shieldpresslocal_2.5.20_amd64.deb`
2. Install it with `sudo apt install ./shieldpresslocal_2.5.20_amd64.deb`
3. Launch **ShieldPress Local** from the application menu
4. Select a writable workspace when prompted; Windows workspaces are migrated to the isolated MariaDB port automatically

The Ubuntu package includes an isolated PHP 8.4 runtime and uses the distribution's PHP 8.5 runtime alongside it. Projects always start with the exact PHP version selected in their configuration.

When using SFTP or FTP for the first time, create a Master Password from the **Credential Vault** button. Workspaces copied from another computer may require you to edit legacy connections and enter their passwords once so they can be re-encrypted in the portable vault. Prefer SFTP or FTPS over unencrypted FTP.

Remote connection settings are portable. Copy the workspace `data/remote-connections/` directory to the same location on another computer, then unlock it with the same Master Password. This directory contains connection metadata and encrypted passwords; private key files referenced from another location must be copied separately and selected again on the new computer.

---

## Quick Start

### 1. Choose Data Storage Location

When launching for the first time, you will be asked where to store your project data.

**Recommendations:**

- Keep the workspace on a writable local disk
- Windows examples: `D:\ShieldPress` or `E:\LocalDev`
- Ubuntu example: `/home/you/Developer/ShieldPress_Projects`
- Paths containing spaces are supported, although short paths remain easier to use in terminal commands

Avoid read-only mounts and removable disks that may disappear while services are running. Keeping project data outside the application installation directory also protects it during upgrades.

### 2. Create Your First Project

1. Open **ShieldPress Local**
2. Click **New Project** → enter a project name → click **Create**
3. Click **Start** on your project card
4. Visit `http://yourproject.local:8000` in your browser

### 3. Install WordPress _(optional)_

1. Click the **WordPress icon** on your project card
2. Click **Install WordPress**
3. Complete the setup wizard at `http://yourproject.local:8000/wp-admin/install.php`

> **Tip:** You can change the data storage location anytime in **Settings → Data Directory**.

---

## Changelog

**[View Full Changelog →](https://github.com/vithanhlam/ShieldPress-Local/blob/main/CHANGELOG.md)**

---

## Privacy & Terms

**[Privacy Policy & Terms of Use →](https://github.com/vithanhlam/ShieldPress-Local/blob/main/PRIVACY_AND_TERMS.md)**

ShieldPress Local does not collect, store, or transmit any of your data. All data stays on your local machine.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/vithanhlam/shieldpress-local/issues)
- **Email:** support@shieldpress.net

---

© 2026 vithanhlam. All rights reserved. Free to use, redistribution not permitted without permission.
