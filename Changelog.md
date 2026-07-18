# Changelog

## v2.2.0

**GitHub Integration — First-Time Setup (New)**
- GitHub credentials configuration in Settings: username, email, Personal Access Token
- One-click link to create a GitHub PAT with correct scopes
- Token encrypted with AES-256-GCM, stored securely
- Auto-configures `git config --global` and `git credential.helper store`
- Token verification via GitHub API on save
- First-time prompt: clicking Git Push without credentials redirects to Settings

**Git Push — Full Sync Commands (New)**
- Pull from remote (git pull)
- Quick command buttons: status, log, diff, branches, remotes, stash, fetch
- Custom git command execution
- Clone repository into project

**Config Editor — Search & Line Numbers (New)**
- Search bar with Next/Previous match navigation
- Line numbers shown alongside the editor
- Cursor position display (Line X, Col Y)

**PHP Path — System PATH Integration**
- PHP path setting now adds PHP to Windows PATH environment variable
- Run `php` commands from any terminal without path issues

**System Monitor (New)**
- Real-time CPU, RAM, Disk usage displayed in titlebar
- Color-coded health indicators
- Disk stats cached every 30s to minimize overhead

**Cache Management (New Page)**
- PHP OPcache: view status (memory, hit rate, cached scripts), reset, enable/disable
- WordPress Cache: flush WP cache, delete transients, flush rewrite rules per project
- Project Cache Cleanup: clean cache dirs, delete node_modules, delete vendor
- Nginx & PHP: restart services, clear nginx logs

**Backup Full — Smart Excludes**
- Auto-excludes heavy directories per project type:
  - WordPress: node_modules, .git, wp-content/cache, wp-content/upgrade
  - Laravel: node_modules, vendor, .git, storage cache dirs
  - Node.js/Next.js: node_modules, .git, .next, dist, build

**Performance Optimizations**
- Log buffer capped at 500 lines
- Disk stats cached with 30s TTL
- System monitor polls every 10s

---

## v2.1.0

**Project Card UI**
- Project type icon moved to the right side of the card for cleaner layout

**Right-Click Context Menu on Projects (New)**
- Right-click any project card to access quick actions: Start/Stop, Open Website, Open Folder, Open in Editor, Debug Logs, Settings, Task List, Delete
- Right-click elsewhere shows the global Services & Quick Actions menu

**Open in Editor — Vietnamese Input Fix**
- Fixed VS Code and other editors not accepting Vietnamese (IME) input when opened from ShieldPress
- Changed from `exec()` to `spawn()` with proper process detach for better editor integration

**Git Push to GitHub (New)**
- Push project code to GitHub directly from the app
- Per-project git configuration: repository URL, branch, include/exclude paths
- Default exclude paths per project type:
  - WordPress: `wp-content/cache`, `wp-content/uploads`, `node_modules`, etc.
  - Laravel: `vendor`, `node_modules`, `storage/logs`, `.env`, etc.
  - Node.js/Next.js: `node_modules`, `.next`, `dist`, `.env`, etc.
- Default include paths for WordPress: only `wp-content/plugins` and `wp-content/themes` (customizable)
- Commit & push with custom message, view recent commits and git status
- `.gitignore` auto-generated from exclude paths

**PHP Path Setting (New)**
- Configure a custom PHP executable path in Settings for CLI commands
- Browse and select any `php.exe`, or leave empty to use bundled PHP

**Database Terminal (New)**
- Run SQL queries directly in the app with a built-in terminal
- Command history with Up/Down arrow keys
- Quick command buttons: SHOW DATABASES, SHOW TABLES, PROCESSLIST, VERSION, etc.
- Vietnamese (IME) input supported

**Database — Auto-Start MariaDB**
- Creating a new database now auto-starts MariaDB if it's not running

**Clone WordPress — WordPress-Only Filter**
- Source project selection now only shows WordPress/PHP projects
- Backend verifies `wp-config.php` exists before cloning (prevents cloning non-WP projects)

**SFTP & FTP — Improved Exclude Paths**
- Exclude paths changed from comma-separated input to multi-line textarea (one path per line)
- Easier to add, view, and manage multiple exclude directories
- Both connection settings and sync config use the new multi-line format
- Passwords remain encrypted with AES-256-GCM

---

## v2.0.0

**Star / Pin Projects (New)**
- Star icon on each project card — starred projects are pinned to the top of the list
- Click to toggle: starred (gold) = pinned to top, unstarred = normal sort by date
- Starred state is saved per project in project.json

**Bug Fixes**
- Fixed Vietnamese (IME) input in Task List — pressing Enter during IME composition no longer submits the form prematurely

---

## v1.1.9

**Open in Editor (New)**
- One-click open project folder in VS Code, Notepad++, Sublime Text directly from project card
- Auto-detects installed editor (VS Code -> Notepad++ -> Sublime Text -> Notepad)
- Configurable custom editor path in Settings -> Code Editor
- Browse and select any .exe editor of your choice

**UI Improvements**
- Window controls (minimize, maximize, close) moved to top-right titlebar
- New ShieldPress branding with updated icon and accent color

---

## v1.2.8

**Extension Manager — Duplicate Fix & New Features**
- Fixed duplicate extension lines in php.ini
- Fixed UTF-8 BOM causing PHP to silently ignore all extensions
- Automatic deduplication on startup
- New "Fix Duplicates" button and "Check Duplicates" diagnostic
- Toggle buttons now show spinner animation while processing

**Custom Extension Detection**
- Extension Manager auto-scans ext/ directory for DLLs not in the predefined list
- Custom extensions appear in a new "Custom" category with a CUSTOM badge

**PHP Version Management (New)**
- Add PHP versions from an existing installation folder
- Remove PHP versions with confirmation
- Auto-configures extension_dir and php.ini for newly added versions

---

## v1.2.7

**Extension Manager — Improved**
- 45+ extensions organized into 10 categories with clear ON/OFF/Not installed states
- "Enable Essentials" one-click button and "Fix extension_dir" tool

**Email Testing (New)**
- SMTP configuration with PHP mail() integration

**SFTP & FTP — Improved**
- Hidden files (dotfiles) now visible in FTP
- External editor support with auto-upload on save
- Drag & drop upload with overwrite confirmation
- Directory memory, SSH Terminal with command history

**Bug Fixes**
- Fixed mysqli PHP extension is not installed error
- Fixed spawn code ENOENT crash when opening external editor
- Data Directory preserved during upgrades

---

## v1.2.6
- Default upload limit increased to 10G
- Project directory named after domain
- phpMyAdmin auto-starts services
- Extension Manager with ionCube auto-installer
- SFTP & FTP Manager

## v1.2.2
- Fixed error when creating project

## v1.2.1
- SSL support via mkcert
- Shutdown progress overlay

## v1.2.0
- PHP 8.4 support, integrated Terminal
- One-click Laravel install, custom MariaDB port
- Auto database backup on stop

## v1.1.9
- WP-CLI, fast WordPress login, project task list

## v1.1.8
- System tray, full backup/restore, clone WordPress
- Tags, search, portable mode, debug log viewer

## v1.0.0
- Initial release
