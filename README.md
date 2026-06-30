# ShieldPress Local

<p align="center">
  <img src="https://github.com/vithanhlam/ShieldPress-Local/blob/main/logo-dark.png" width="500" alt="ShieldPress Local"/>
</p>

<p align="center">
  <strong>A fast, lightweight local development environment for WordPress, Laravel & PHP on Windows</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/vithanhlam/shieldpress-local?style=flat-square&color=e07b1a" alt="Release"/>
  <img src="https://img.shields.io/github/downloads/vithanhlam/shieldpress-local/total?style=flat-square&color=22c55e" alt="Downloads"/>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/license-Freeware-orange?style=flat-square" alt="License"/>
</p>

---

## Download

**[Download Latest Version (v1.2.9)](https://github.com/vithanhlam/shieldpress-local/releases/latest)**

| File | Description |
| ---- | ----------- |
| `ShieldPress Local Setup 1.2.9.exe` | Installer (recommended) |

---

## What is ShieldPress Local?

ShieldPress Local is a desktop application that lets you run WordPress, Laravel, and PHP-based websites locally on your Windows machine — no technical expertise required.

It comes bundled with everything you need: **Nginx**, **PHP 8.3/8.4**, **MariaDB**, and **phpMyAdmin** — all managed through a clean, modern interface.

---

## Screenshots

<p align="center">
  <img src="https://github.com/vithanhlam/ShieldPress-Local/blob/main/projects.png" width="800" alt="Projects"/>
</p>

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
| **Clone WordPress** | Clone any project with automatic URL replacement |
| **Database Manager** | Create, import, export, drop databases |
| **Config Editor** | Edit php.ini, my.ini, and per-project Nginx config |
| **SSL (HTTPS)** | One-click local HTTPS via mkcert |
| **Tags & Search** | Tag and search projects easily |
| **System Tray** | Minimize to background, always accessible |

### SFTP & FTP Manager

| Feature | Description |
| ------- | ----------- |
| **SFTP / FTP Client** | Connect to remote servers via SFTP (SSH) or FTP |
| **File Browser** | Browse, upload, download, delete, create folders |
| **Inline Editor** | Edit remote files directly in the app |
| **External Editor** | Open remote files in VS Code, Notepad++, Sublime Text — auto-uploads on save |
| **Drag & Drop** | Drag files from Explorer to upload |
| **ZIP Upload & Extract** | Upload ZIP files and extract on server (SFTP) |
| **Overwrite Protection** | Asks before overwriting existing files |
| **Hidden Files** | Shows dotfiles (.htaccess, .env, .git...) |
| **Directory Memory** | Remembers last browsed folder per connection |
| **SSH Terminal** | Full SSH terminal with command history (Up/Down arrows), 25+ quick commands |
| **Sync Upload/Download** | Push/pull files between local and remote with folder picker and exclude paths |
| **Encrypted Credentials** | Passwords stored with AES-256-GCM encryption |

### Extensions & Tools

| Feature | Description |
| ------- | ----------- |
| **Extension Manager** | Toggle 45+ PHP extensions on/off, organized by category |
| **ionCube Loader** | Auto-install ionCube for any PHP version |
| **Enable Essentials** | One-click enable mysqli, curl, gd, mbstring and more |
| **Email Testing** | Configure SMTP and send test emails — PHP `mail()` works after setup |

---

## Requirements

- **OS:** Windows 10 / 11 (64-bit)
- **RAM:** 2GB minimum, 4GB recommended
- **Disk:** 2GB for the app + space for your projects
- **Admin rights:** Required on first install only

---

## Installation

1. Download `ShieldPress Local Setup 1.2.9.exe` from [Releases](https://github.com/vithanhlam/shieldpress-local/releases)
2. Run the installer and follow the wizard
3. Choose where to store your project data when prompted
4. Launch **ShieldPress Local** from your desktop shortcut

---

## Quick Start

### 1. Choose Data Storage Location

When launching for the first time, you will be asked where to store your project data.

**Recommendations:**

- Use a drive other than `C:` (e.g., `D:\ShieldPress`, `E:\LocalDev`)
- No spaces in the path (`D:\ShieldPress` vs `D:\Shield Press`)
- No special characters
- Short path is better

| Good paths | Bad paths |
| ---------- | --------- |
| `D:\ShieldPress` | `C:\Users\John\My Projects` |
| `E:\LocalDev` | `D:\Shield Press Local` |
| `D:\Dev` | `E:\Dev&Test!` |

> **Why?** Nginx does not support paths with spaces or special characters.
> Storing on `D:` or another drive keeps your data safe if Windows needs to be reinstalled.

---

### 2. Create Your First Project

1. Open **ShieldPress Local**
2. Click **New Project** → enter a project name → click **Create**
3. Click **Start** on your project card
4. Visit `http://yourproject.local:8000` in your browser

### 3. Install WordPress _(optional)_

1. Click the **WordPress icon** on your project card
2. Click **Install WordPress**
3. Complete the setup wizard at `http://yourproject.local:8000/wp-admin/install.php`

> **Tip:** You can change the data storage location anytime in **Settings → Data Storage**.

---

## Changelog

### v1.2.9 — Latest

**Open in Editor (New)**
- One-click open project folder in VS Code, Notepad++, Sublime Text directly from project card
- Auto-detects installed editor (VS Code → Notepad++ → Sublime Text → Notepad)
- Configurable custom editor path in Settings → Code Editor
- Browse and select any .exe editor of your choice

**UI Improvements**
- Window controls (minimize, maximize, close) moved to top-right titlebar
- New ShieldPress branding with updated icon and accent color

### v1.2.8

**Extension Manager — Duplicate Fix & New Features**
- Fixed duplicate extension lines in php.ini — toggle now removes all existing lines before adding one clean line
- Fixed **UTF-8 BOM** causing PHP to silently ignore all extensions (root cause of persistent mysqli error)
- Automatic deduplication on startup — `applyPhpIni()` cleans duplicate extension lines
- New "Fix Duplicates" button — one-click removal of all duplicate lines
- New "Check Duplicates" diagnostic — modal shows exactly which extensions have duplicates and on which lines
- Toggle buttons now show spinner animation while processing

**Custom Extension Detection**
- Extension Manager auto-scans `ext/` directory for DLLs not in the predefined list
- Custom extensions appear in a new "Custom" category with a CUSTOM badge
- Custom extensions can be toggled on/off just like built-in ones

**PHP Version Management (New)**
- Add PHP versions from an existing installation folder (with php-cgi.exe)
- Remove PHP versions with confirmation
- Auto-configures `extension_dir` and `php.ini` for newly added versions

### v1.2.7

**Extension Manager — Improved**
- 45+ extensions organized into 10 categories with clear ON/OFF/Not installed states
- "Enable Essentials" one-click button and "Fix extension_dir" tool

**Email Testing (New)**
- SMTP configuration with PHP `mail()` integration — send emails from PHP after setup
- Bundled sendmail wrapper for authenticated SMTP (Gmail, Mailtrap, etc.)

**SFTP & FTP — Improved**
- Hidden files (dotfiles) now visible in FTP
- External editor support (VS Code, Notepad++, Sublime Text) with auto-upload on save
- Drag & drop upload with overwrite confirmation
- Directory memory — remembers last browsed folder
- SSH Terminal with command history and 25+ quick commands

**Bug Fixes**
- Fixed `mysqli PHP extension is not installed` error — auto-enables essential extensions and fixes duplicate extension_dir
- Fixed `spawn code ENOENT` crash when opening external editor
- Data Directory preserved during upgrades (NSIS installer backup)
- Poppins font and FontAwesome 6.5 bundled offline

### v1.2.6

- Default upload limit increased to 10G
- Project directory named after domain instead of timestamp
- Fixed Task List Unicode/Vietnamese text saving
- phpMyAdmin auto-starts PHP + MariaDB + Nginx
- Upload limit changes apply instantly without restart
- New: Extension Manager with ionCube auto-installer
- New: SFTP & FTP Manager with file browser, SSH terminal, sync, encrypted credentials

### v1.2.2

- Fixed error when creating project

### v1.2.1

- SSL support via mkcert with green lock indicator
- Shutdown progress overlay and tray quit backup fix

### v1.2.0

- PHP 8.4 support, integrated Terminal, npm commands
- One-click Laravel install, custom MariaDB port
- Auto database backup on project/app stop
- Live service port display

### v1.1.9

- WP-CLI, fast WordPress login, project task list

### v1.1.8

- System tray, full backup/restore, clone WordPress
- Tags, search, portable mode, debug log viewer

### v1.0.0

- Initial release

---

## Support

- **Issues:** [GitHub Issues](https://github.com/vithanhlam/shieldpress-local/issues)
- **Email:** vithanhlam@gmail.com

---

© 2026 vithanhlam. All rights reserved. Free to use, redistribution not permitted without permission.
