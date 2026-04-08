# CodeWP Local

<p align="center">
  <img src="https://code-wp.com/wp-content/uploads/2026/04/logochuan-x.svg" width="400" alt="CodeWP Local"/>
</p>

<p align="center">
  <strong>A fast, lightweight local development environment for WordPress & PHP on Windows</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/github/v/release/vithanhlam/code-wp-local?style=flat-square&color=3d8aff" alt="Release"/>
  <img src="https://img.shields.io/github/downloads/vithanhlam/code-wp-local/total?style=flat-square&color=22c55e" alt="Downloads"/>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-blue?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/license-Freeware-orange?style=flat-square" alt="License"/>
</p>

---

## Download

**[⬇ Download Latest Version](https://github.com/vithanhlam/code-wp-local/releases/latest)**

| File                           | Description                  |
| ------------------------------ | ---------------------------- |
| `CodeWP Local Setup x.x.x.exe` | Installer (recommended)      |
| `CodeWP Local x.x.x.exe`       | Portable (no install needed) |

---

## What is CodeWP Local?

CodeWP Local is a desktop application that lets you run WordPress and PHP websites locally on your Windows machine — no technical knowledge required.

It bundles everything you need: **Nginx**, **PHP 8.3**, **MariaDB**, and **phpMyAdmin** — all managed through a clean, modern interface.

---

## Features

### Free

| Feature                  | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| 🌐 **Multi-site**        | Run unlimited projects on different ports (8000, 8001...) |
| ⚡ **One-click Start**   | Start/stop any project instantly                          |
| 🔧 **WordPress Install** | Auto-download and install WordPress                       |
| 🛠 **WP-CLI**            | Run WP-CLI commands from within the app                   |
| 🐛 **Debug Logs**        | View Nginx, PHP, MariaDB and WP debug logs                |
| 💾 **Full Backup**       | Backup source files + database into a single ZIP          |
| 🔁 **Clone WordPress**   | Clone any project with automatic URL replacement          |
| 🗄 **Database Manager**  | Create, import, export, drop databases                    |
| ⚙ **Config Editor**      | Edit php.ini and per-project Nginx config                 |
| 🏷 **Tags & Search**     | Tag and search projects easily                            |
| 🖥 **System Tray**       | Minimize to background, always accessible                 |

### Pro _(coming soon)_

| Feature                   | Description                    |
| ------------------------- | ------------------------------ |
| 🔄 **SFTP / FTP Sync**    | Push/pull files to remote host |
| ☁ **Google Drive Backup** | Auto backup to Google Drive    |

---

## Requirements

- **OS:** Windows 10 / 11 (64-bit)
- **RAM:** 2GB minimum, 4GB recommended
- **Disk:** 2G for the app + space for your projects
- **Admin rights:** Required on first install only

---

## Installation

1. Download `CodeWP Local Setup x.x.x.exe` from [Releases](https://github.com/vithanhlam/code-wp-local/releases)
2. Run the installer and follow the wizard
3. Choose where to store your project data when prompted
4. Launch **CodeWP Local** from your desktop shortcut

---

## Quick Start

### 1. Choose Data Storage Location

When launching for the first time, you will be asked where to store your project data.

**Recommendations:**

- ✅ Use a drive other than `C:` (e.g., `D:\CodeWP`, `E:\LocalDev`)
- ✅ No spaces in the path (`D:\CodeWP` ✅ vs `D:\Code WP` ❌)
- ✅ No special characters (`D:\CodeWP` ✅ vs `D:\Code&WP!` ❌)
- ✅ Short path is better (`D:\CodeWP` ✅ vs `D:\My Documents\Dev\Local\CodeWP` ❌)

| Good paths ✅ | Bad paths ❌                |
| ------------- | --------------------------- |
| `D:\CodeWP`   | `C:\Users\John\My Projects` |
| `E:\LocalDev` | `D:\Code WP Local`          |
| `D:\Dev`      | `E:\Dev&Test!`              |

> **Why?** Nginx does not support paths with spaces or special characters.  
> Storing on `D:` or another drive keeps your data safe if Windows needs to be reinstalled.

---

### 2. Create Your First Project

1. Open **CodeWP Local**
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

### v1.1.9 — Latest

- Added WP-CLI
- Added fast WordPress login
- Added project task list
- Fixed admin password reset
- Fixed WordPress debugging

### v1.1.8

- System tray — minimize to background, tray right-click menu
- Full Backup & Restore (free)
- Clone WordPress with auto URL replacement (free)
- Per-project debug log viewer (Nginx, PHP, MariaDB, WP)
- Tags and search for projects
- Portable mode — choose custom data directory
- Service controls with loading state

### v1.0.0

- Initial release

---

## Support

- **Issues:** [GitHub Issues](https://github.com/vithanhlam/code-wp-local/issues)
- **Email:** vithanhlam@gmail.com

---

© 2026 vithanhlam. All rights reserved. Free to use, redistribution not permitted without permission.
