# ShieldPress Local — Version History

---

## v2.3.0 — July 21, 2026

### Microsoft Store Compliance
- **Clean uninstall** — NSIS installer now prompts to remove `ShieldPress_Project` workspace folders on all drives (C/D/E/F) during uninstall, satisfying Microsoft Store policy 10.2.7 (Product Removal)
- Removed **Google Drive Backup** plugin (not production-ready)
- Removed **license/activation UI** — all plugins are now free; license system kept in backend for future premium features

### Vietnamese Input Fix (Production Build)
- Fixed **IME input (Unikey/Telex) not working** in input fields when app is packaged as .exe
- Root cause: `before-input-event` handler was intercepting keyboard events during IME composition
- Fix: added `input.isComposing` and `input.key === "Process"` checks to skip IME events

### Disk Monitor Fix
- Disk usage in titlebar now reflects the drive where **projects are stored** (`PROJECTS_DIR`) instead of the app data drive (`DATA_DIR`)
- If user sets workspace to D: or F:, the disk info correctly shows that drive's free space

### UI Fix
- Shutdown overlay: **power-off icon** no longer spins — only the "Stopping services" spinner animates

---

## v2.0.0 — July 1, 2026

### Star / Pin Projects (NEW)
- New **star icon** on every project card — click to pin a project to the top of the list
- Starred projects (gold star) always appear first, unstarred projects sorted by creation date
- Starred state persisted in `project.json` per project
- Toggle on/off instantly with a single click

### Bug Fixes
- Fixed **Vietnamese (IME) input** in Task List — `onkeydown` Enter handler now checks `event.isComposing` to avoid submitting during IME composition (Telex/VNI)

---

## v1.1.9 — June 30, 2026

### Open in Editor (NEW)
- One-click **Open in Editor** button on every project card
- Auto-detects installed editor: VS Code → Notepad++ → Sublime Text → Notepad (fallback)
- Configurable custom editor path in **Settings → Code Editor**
- Browse and select any `.exe` editor of your choice

### UI Improvements
- Window controls (minimize, maximize, close) moved from sidebar to **top-right titlebar**
- New **ShieldPress** branding with updated icon and accent color `#e07b1a`

---

## v1.2.8 — June 24, 2026

### Extension Manager — Duplicate Fix & New Features
- Fixed **duplicate extension lines** in php.ini — `toggleExtension()` now removes ALL existing lines for an extension before adding one clean line, preventing duplicates from accumulating
- Added **automatic deduplication on startup** — `applyPhpIni()` scans for duplicate extension lines and keeps only one per extension
- Added **"Fix Duplicates"** button — one-click removal of all duplicate extension lines in php.ini
- Added **"Check Duplicates"** diagnostic — modal shows exactly which extensions have duplicate lines and on which line numbers
- Toggle buttons now show **spinner animation** while processing

### Custom Extension Detection
- Extension Manager now **auto-scans the ext/ directory** for DLLs not in the predefined list
- Custom extensions appear in a new **"Custom"** category with a CUSTOM badge
- Custom extensions can be toggled on/off just like built-in ones

### PHP Version Management (NEW)
- New **"PHP Version Management"** card in Extensions page
- **Add PHP version** — select a folder containing a PHP installation (with php-cgi.exe) and specify version number (e.g. 8.1, 8.2)
- **Remove PHP version** — delete a PHP version with confirmation
- Auto-configures `extension_dir` and `php.ini` for newly added versions

---

## v1.2.7 — June 21, 2026

### Extension Manager — Improved
- Expanded to **45+ extensions** organized into 10 categories: Database, Core, Image, Archive, Network, i18n, Performance, Debug, Security, Misc
- Toggle buttons now clearly show **ON** (green) / **OFF** (red) / **Not installed** (gray) — no more ambiguous states
- Added **"Enable Essentials"** one-click button — enables mysqli, pdo_mysql, curl, openssl, mbstring, fileinfo, gd, zip, intl, exif
- Added **"Fix extension_dir"** button — resolves duplicate extension_dir issues in php.ini
- Each extension shows description and ZEND badge where applicable

### Email Testing (NEW)
- New **Email Testing** page in sidebar under Tools
- Configure SMTP server: host, port, username, password, from address
- Send test emails directly from the app with full SMTP log output
- **PHP `mail()` integration** — saving SMTP config automatically updates `sendmail_path` in php.ini for all PHP versions
- Bundled `sendmail.js` wrapper handles authenticated SMTP (Gmail, Mailtrap, custom servers)
- PHP `mail()` function works out of the box after configuration

### SFTP & FTP — Improved
- FTP now shows **hidden files** (dotfiles like .htaccess, .env, .git) using LIST -a flag
- **Open in External Editor** — auto-detects VS Code (by full path), Notepad++, Sublime Text; uses `exec()` instead of `spawn()` to avoid ENOENT errors with batch scripts
- **Drag & drop upload** — drag files from Windows Explorer into the file browser to upload
- **Overwrite confirmation** — asks before overwriting existing files on upload (shows current file size)
- **Remember last directory** — reopening file browser restores your previous location per connection
- SSH Terminal: improved UI with embedded terminal look, **command history** (Up/Down arrows), **25+ quick commands** organized by category, `clear`/`cls` support

### Data Persistence
- NSIS installer now **preserves Data Directory** setting (`portable.txt`) during upgrades — no more losing your workspace path after reinstall

### Bug Fixes — mysqli
- Fixed **"mysqli PHP extension is not installed"** error in phpMyAdmin
- Root cause: duplicate `extension_dir` lines in php.ini (second line overriding with relative path) and `extension=mysqli` commented out in PHP 8.4
- Fix: `applyPhpIni()` now removes all `extension_dir` duplicates and auto-enables 8 essential extensions (mysqli, pdo_mysql, curl, openssl, mbstring, fileinfo, gd, zip) on startup

### Bug Fixes — General
- Fixed `spawn code ENOENT` crash when opening files in external editor — VS Code's `code` command is a `.cmd` batch script, switched from `spawn()` to `exec()`
- Removed unsafe `for /f` shell command in stopPhpCgi
- Font **Poppins** and **FontAwesome 6.5** bundled offline — `@import` moved to top of CSS to fix icons not loading

---

## v1.2.6 — June 21, 2026

### Upload & Performance
- Default upload limit increased to **10G** (was 64M per project, 2G global)
- Fixed upload limit changes **requiring app restart** to take effect — now applies instantly

### Project Management
- Project directory now named after **domain** instead of `proj_timestamp` — e.g. `shieldpress.net` → folder `shieldpress_net`
- Special characters and diacritics stripped from directory names
- Auto-appends suffix to avoid name conflicts

### Localization
- Fixed **Task List unable to save Vietnamese (Unicode) text** — switched to explicit UTF-8 file read/write

### phpMyAdmin
- Auto-starts **PHP + MariaDB + Nginx** when opening phpMyAdmin if services are not running — no more 502 errors

### Extension Manager (NEW)
- New **Extensions** page in sidebar
- Toggle PHP extensions on/off
- Install ionCube Loader automatically per PHP version

### SFTP & FTP Manager (NEW)
- Full SFTP (SSH) and FTP client with file browser, upload/download, delete, inline editor
- SSH Terminal with full command support
- Sync upload/download with folder picker and exclude paths
- Passwords encrypted with AES-256-GCM
- Connection linked to projects

### Fonts & Offline Support
- Poppins font and FontAwesome 6.5 bundled offline

---

## v1.2.5

- Initial public release
- Multi-site support, WordPress/Laravel install
- WP-CLI, Debug Logs, Backup/Restore
- SSL via mkcert, Plugin system
- Task List per project
