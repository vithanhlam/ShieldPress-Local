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

**[Download Latest Version (v2.4.0)](https://github.com/vithanhlam/shieldpress-local/releases/latest)**

| File | Description |
| ---- | ----------- |
| `ShieldPress Local Setup 2.4.0.exe` | Installer (recommended) |

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
| **Cache Management** | OPcache status, WP cache flush, project cache cleanup, nginx log clear |
| **Git Push** | Push to GitHub, pull, custom git commands, clone repos |
| **System Monitor** | Real-time CPU, RAM, Disk usage in titlebar |

---

## Requirements

- **OS:** Windows 10 / 11 (64-bit)
- **RAM:** 2GB minimum, 4GB recommended
- **Disk:** 2GB for the app + space for your projects
- **Admin rights:** Required on first install only

---

## Installation

1. Download `ShieldPress Local Setup 2.3.0.exe` from [Releases](https://github.com/vithanhlam/shieldpress-local/releases)
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

**[View Full Changelog](https://github.com/vithanhlam/ShieldPress-Local/blob/main/Changelog.md)**

---

## Privacy & Terms

**[Privacy Policy & Terms of Use](https://github.com/vithanhlam/ShieldPress-Local/blob/main/PRIVACY_AND_TERMS.md)**

ShieldPress Local does not collect, store, or transmit any of your data. All data stays on your local machine. You have full ownership and control over your projects and files.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/vithanhlam/shieldpress-local/issues)
- **Email:** support@shieldpress.net

---

© 2026 vithanhlam. All rights reserved. Free to use, redistribution not permitted without permission.
