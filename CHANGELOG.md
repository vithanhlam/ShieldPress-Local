# Changelog

## v2.5.10

**Ubuntu Installer Reliability**
- Installs the application in `/opt/ShieldPressLocal` so Electron can launch its Chromium sandbox from a path without spaces
- Keeps the desktop name as **ShieldPress Local** and updates the command-line launcher to the new installation path
- Restores the required root ownership and setuid permissions on `chrome-sandbox` after installation
- Removes the obsolete spaced installation directory automatically during package upgrades

**Writable PHP Runtime**
- Copies bundled PHP 8.4 into the workspace runtime before projects start on Ubuntu
- Stores the active `php.ini`, PHP executables, and extensions in a user-writable directory instead of modifying files below `/opt`
- Preserves customized `php.ini` settings while refreshing bundled PHP binaries during application updates
- Fixes Laravel and WordPress project startup failing with `EACCES` while applying upload and execution limits

**Release**
- Updates the Windows and Ubuntu installers to version 2.5.10

---

## v2.5.9

**Windows Workspace Startup Fix**
- Ignores malformed legacy workspace preferences containing only the Windows extended-path prefix
- Converts valid extended-length drive and UNC paths to stable standard Windows paths
- Prevents device paths, drive-relative paths, and incomplete root fragments from reaching workspace initialization
- Allows the app to recover automatically when an old installer restores an invalid `portable.txt`

---

## v2.5.8

**Ubuntu PHP Runtime**
- Adds simultaneous PHP 8.4 and PHP 8.5 support on Ubuntu
- Detects every installed versioned PHP-CGI binary instead of exposing only the system default
- Starts each project with the exact PHP version selected in its configuration
- Prevents a missing PHP version from silently falling back to a different system version

**Release**
- Updates the Windows and Ubuntu release packages to version 2.5.8

---

## v2.5.7

**Project Runtime Reliability**
- Prevents concurrent project and Nginx startup attempts from terminating each other
- Loads Ubuntu project server configurations and FastCGI parameters from explicit runtime paths
- Sends reload and stop signals to ShieldPress's Nginx configuration instead of the system Nginx service
- Reports the actual Nginx startup error when the process exits before binding its ports
- Waits longer for project ports and uses one PHP-CGI listener on Linux to avoid redundant worker failures

**Database Experience**
- Migrates Windows root credentials in WordPress and Laravel projects to Ubuntu's passwordless local MariaDB account
- Detects Ubuntu's system phpMyAdmin installation and activates its Nginx host on demand
- Keeps phpMyAdmin access and error logs inside ShieldPress's user-writable runtime
- Configures local phpMyAdmin authentication for the isolated port 3307 during DEB installation
- Removes stale Windows GSSAPI fallback metadata and limits phpMyAdmin to loopback-only access
- Adds live byte and percentage progress for database imports and exports
- Adds a Show in Folder action when an export completes
- Displays table count and database size in a flexible database list layout
- Identifies databases linked to WordPress projects

**Backup Experience**
- Adds live byte and percentage progress while creating project backups
- Adds real mysqldump progress to the Backup & Stop workflow and reports backup failures
- Disables backup controls while an archive is being created
- Adds Show in Folder actions after database/project backup completion and in the backup list

**Project and SFTP Improvements**
- Displays the total disk usage of every project
- Disables and dims SFTP/FTP sync buttons while synchronization is running
- Stops the sync loading animation and restores controls when synchronization completes
- Uses cross-platform project folder paths for Open Folder and SFTP/FTP sync

---

## v2.5.6

**Ubuntu Workspace Migration**
- Migrates Windows workspaces from the system MariaDB port 3306 to ShieldPress's isolated Linux port 3307
- Updates project metadata and local WordPress `DB_HOST` values during migration
- Updates Laravel MySQL ports without altering projects configured for PostgreSQL
- Preserves custom database hosts and non-default database ports
- Starts the isolated MariaDB instance without a workspace option file to remain compatible with Ubuntu security confinement
- Runs the system MariaDB binary from the workspace runtime so Ubuntu AppArmor permits user-owned database directories
- Migrates Windows-only MariaDB `gssapi` root authentication to the local Ubuntu authentication scheme on first start

---

## v2.5.5

**Windows Database Fix**
- Fixed MariaDB client commands connecting as `root` without the configured password
- Restored normal MariaDB grant checks when migrating configuration files created by older builds
- Added authenticated database shutdown for the bundled Windows runtime

**Project Website Fix**
- Open Website now starts a stopped project before launching the browser
- Project startup now reports Nginx launch failures instead of marking the project as running
- Project startup now fails with a clear error when the configured website port does not respond
- Browser launch errors are now returned to the interface instead of failing silently

---

## v2.5.4

**Ubuntu Support**
- Added native Ubuntu packaging with DEB and AppImage targets
- Added Linux service discovery for Nginx, PHP-CGI, MariaDB, Redis, and mkcert
- Added an isolated, user-owned MariaDB instance on port 3307 to avoid conflicts with the system database service
- Added standard Linux application icons from 16px through 1024px and corrected GNOME window matching
- Disabled GPU acceleration on Linux to avoid Vulkan startup failures on affected systems

**Workspace Reliability**
- Fixed the Windows startup failure that could occur after selecting a project directory
- Added workspace path validation, atomic preference updates, and recovery from invalid saved paths
- Added support for workspace paths containing spaces

**Cross-Platform Fixes**
- Updated database, backup, clone, project, and service commands for Windows and Linux
- Added automated tests for platform detection, workspace handling, and initial configuration
- Application version is now read directly from package metadata to prevent release version drift

---

## v2.5.3

**About Page**
- Redesigned About page: stack badges (Nginx, MariaDB, PHP, WordPress, Laravel, Node.js/Next.js) and feature highlights grid
- Shows current version with update badge and **Download Update** button when a newer GitHub release is detected

**SFTP & FTP**
- Search and filter controls aligned to the right side of the page header

---

## v2.5.2

**Check for Updates (New)**
- App checks GitHub Releases API 6 seconds after startup (non-blocking, works offline gracefully)
- If a newer version is available, a green **"vX.Y.Z available"** badge appears in the titlebar next to the CPU / RAM monitor
- Clicking the badge opens the GitHub Releases page in the default browser
- Version comparison is semver-aware (major → minor → patch)

---

## v2.5.1

**Fix: Data Directory lost after upgrade**
- Root cause: `customInstallMode` NSIS macro does not run for per-machine installers — `portable.txt` was backed up before uninstall but never restored, so the workspace path was lost on every upgrade
- NSIS fix: restore `portable.txt` inside `customInstall` (runs after file extraction) instead of `customInstallMode`
- App-side safety net: workspace path is now also saved to `%APPDATA%\ShieldPress Local\workspace_path.txt` on every launch and every Settings → Data Directory change
- On startup, if `portable.txt` is missing (e.g. reinstall wipe), the app reads from `%APPDATA%` backup, recreates `portable.txt`, and resumes normally — projects, databases, and config are preserved with zero manual intervention

---

## v2.5.0

**SFTP & FTP — Search & Filter (New)**
- Search bar in the SFTP & FTP page header — filter connections by name, host, or username in real time
- Protocol filter dropdown: show All / SFTP only / FTP only
- "No connections match your search" empty state when filter returns nothing
- Search is preserved when connecting, disconnecting, or deleting connections

**SFTP & FTP — Sync: Changed Files Only (New)**
- New "Sync changed files only" checkbox in the Sync Configuration modal
- Upload: compares local `mtime` against remote `mtime` — skips files where remote is same age or newer
- Download: compares remote `mtime` against local `mtime` — skips files already up to date
- Sync result toast shows skipped file count alongside uploaded/downloaded count

**SFTP & FTP — Local Folder Validation**
- When selecting or pre-filling a local folder for sync, the app validates the path exists and shows file count
- Upload sync validates the local path before connecting — shows an error instead of silently failing
- Inline validation indicator (green check / red warning) appears below the Local Folder field

**SFTP & FTP — Auto-Reconnect**
- Connections are now tested before each operation using a lightweight ping (SFTP: `stat /`, FTP: `pwd`)
- If the connection is found dead, the app reconnects transparently before retrying the operation
- Connect button: if an existing connection is stale, it reconnects instead of assuming "already connected"

**SFTP & FTP — Exclude Paths: Expanded Defaults**
- Default exclude list now covers WordPress, Laravel, and Node.js out of the box:
  `.env`, `.env.local`, `.env.production`, `bootstrap/cache`, `storage/logs`, `storage/framework/cache`,
  `storage/framework/sessions`, `storage/framework/views`, `.next`, `dist`, `build`, `__pycache__`,
  `wp-content/cache`, `wp-content/upgrade` (in addition to existing `node_modules`, `.git`, `vendor`, `.DS_Store`)

**Email Testing — SSL / TLS / STARTTLS Support**
- Added Security dropdown: `STARTTLS (587)`, `SSL/TLS (465)`, `None — plain`
- Port 465 now uses implicit TLS (`tls.connect`) — fixes Gmail and other SSL-only SMTP servers that previously hung indefinitely
- Port 587 uses STARTTLS upgrade: connects plain, sends `STARTTLS` after EHLO, then wraps the socket with TLS
- Security mode auto-detected when changing port (465 → SSL, 587 → STARTTLS)
- Connection timeout increased to 20s with a descriptive message (previously timed out silently)
- `security` field persisted in `email_config.json`

**Email Testing — Save Config UX**
- Save Config button shows spinner and is disabled while saving — prevents double-submit

**Cache Management — PHP 8.4 Fix**
- OPcache is enabled by default in PHP 8.0+ — detection logic updated to reflect this:
  treated as enabled unless `opcache.enable=0` is explicitly set (was previously requiring `opcache.enable=1`)
- Extension detection regex now matches both `zend_extension=opcache` and `extension=opcache` (PHP 8.4 accepts both forms)

---

## v2.4.0

**Cloud Backup — Local Folder Sync (New)**
- Replaced OAuth2 Google Drive integration with a simpler local-folder-based approach — no API keys or login required
- Auto-detects installed sync clients: Google Drive for Desktop (registry), OneDrive (registry), Dropbox (`info.json`)
- Detected folders shown as one-click quick-pick buttons in Settings → Cloud Backup Folder
- Per-project backup config: choose which folders to zip, toggle DB export, enable auto-backup on project stop
- "Backup Now" button zips configured folders + exports DB into `BackupFolder / ShieldPress Local / ProjectName / backup_TIMESTAMP`
- Auto-backup to cloud folder triggers when stopping a project with "Backup & Stop" (if auto-backup is enabled for that project)

**Redis Support (New)**
- Download Redis for Windows (tporadowski/redis v5.0.14) directly from the app — no manual install
- Start / Stop / Restart Redis from the Services sidebar (row appears automatically once Redis is installed)
- Flush all Redis keys with one click
- Configure Redis port (default 6379) with app restart
- Redis status card in Cache Management page: version, uptime, connected clients, memory usage
- Redis included in graceful app shutdown (stopAll)

**WordPress Reinstall Protection (New)**
- WordPress modal now shows a green "WordPress is installed" badge when `wp-config.php` is detected
- Install button is hidden when WordPress is already installed
- "Reinstall" button shown with a clear warning — requires explicit confirmation before overwriting

**Cache Management — Bug Fixes**
- OPcache status now reads `php.ini` directly (PHP CLI cannot access CGI process shared memory — previous approach was inaccurate)
- Status display shows each PHP version's OPcache config: enabled state, memory allocation, max files, revalidate interval
- "Reset OPcache" now restarts PHP-CGI processes to actually clear the cache (previously called `opcache_reset()` via CLI which had no effect on the web server)
- Fixed WordPress cache flush, transient delete, and rewrite flush — all were using wrong parameter name (`cmd` instead of `command`) causing silent failures

---

## v2.3.0

**Microsoft Store Compliance**
- Clean uninstall: installer now asks to remove `ShieldPress_Project` data folders on all drives (C/D/E/F) during uninstall — passes Microsoft Store policy 10.2.7
- Removed Google Drive Backup plugin (not yet ready)
- Removed license/activation UI — all plugins are free, license backend kept for future use

**Vietnamese Input Fix (Production Build)**
- Fixed IME (Unikey/Telex) not working in input fields when app is built as exe
- `before-input-event` now skips IME composition events (`isComposing` / `Process` key)

**Disk Monitor Fix**
- Disk usage in titlebar now shows the drive where projects are stored (`PROJECTS_DIR`) instead of always showing the app data drive

**UI Fix**
- Shutdown overlay: power-off icon no longer spins

---

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
