# Privacy Policy & Terms of Use

**ShieldPress Local**
Last updated: August 17, 2026

---

## Privacy Policy

### 1. No Data Collection

ShieldPress Local is a **fully offline, local application**. We do **not** collect, store, transmit, or share any of your personal information, project data, database content, files, credentials, or usage analytics.

- No telemetry or tracking
- No crash reports sent to any server
- No usage statistics collected
- No cookies or browser fingerprinting
- No third-party analytics (Google Analytics, Mixpanel, etc.)

### 2. Data Storage

All data created and managed by ShieldPress Local is stored **exclusively on your local machine**, in the directory you choose during setup (e.g., `D:\ShieldPress`).

This includes:
- Project source files and databases
- Configuration files (php.ini, my.ini, nginx.conf)
- Backup archives (ZIP files)
- SFTP/FTP connection credentials
- GitHub credentials (Personal Access Token)
- Task lists and project settings

### 3. Credential Encryption

Sensitive credentials stored by the application are encrypted locally:

- **SFTP/FTP passwords**: Encrypted with AES-256-GCM using a machine-specific key
- **GitHub Personal Access Tokens**: Encrypted with AES-256-GCM using a machine-specific key
- **Database passwords**: Stored in local project configuration files only

These encrypted values never leave your machine. The encryption key is derived from your computer's hostname and cannot be used on another machine.

### 4. Network Connections

ShieldPress Local only makes network connections when **you explicitly initiate** them:

- **SFTP/FTP**: Connects to remote servers you configure, using credentials you provide
- **GitHub/Git**: Pushes to or pulls from repositories you specify
- **WordPress/Laravel download**: Downloads packages from official sources (wordpress.org, getcomposer.org) when you click "Install"
- **WP-CLI download**: Downloads from the official WP-CLI repository when requested

No background network activity occurs. The application does not "phone home" or check for updates automatically.

### 5. Third-Party Services

ShieldPress Local does not integrate with any third-party services for data processing. The bundled software components (Nginx, PHP, MariaDB, phpMyAdmin) run entirely on your local machine.

---

## Terms of Use

### 1. License

ShieldPress Local is free software licensed under the **GNU General Public License v3.0** (GPL-3.0). The full license text is in [`LICENSE`](LICENSE).

Under GPLv3 you may:

- Use the software for any purpose
- Study and modify the source code
- Share original or modified copies, including commercially, **if** you also provide the corresponding source code under GPLv3

You may not:

- Redistribute the software or a modified version as proprietary/closed-source software
- Remove or alter copyright notices or license notices required by GPLv3
- Impose additional restrictions that conflict with GPLv3

Community contributions are welcome through GitHub pull requests. By contributing, you agree that your contribution is licensed under GPLv3.

### 2. Your Data, Your Responsibility

You have **full ownership and control** over all data managed by ShieldPress Local. We do not access, monitor, or interfere with your projects, databases, or files in any way.

**Important:**
- You are solely responsible for backing up your data before uninstalling, updating, or making significant changes
- You are responsible for securing your machine and the data stored on it
- You are responsible for the security of credentials you store in the application (SFTP passwords, GitHub tokens, database passwords)
- You are responsible for ensuring your use of the software complies with applicable laws and regulations

### 3. Backup Recommendation

We strongly recommend that you:

- **Regularly back up** your projects and databases using the built-in Full Backup feature
- **Export databases** before performing major operations (upgrades, migrations, etc.)
- **Keep backup copies** on a separate drive or cloud storage
- **Back up before uninstalling** — removing the application or its data directory will permanently delete all projects and databases stored within it

### 4. Disclaimer of Warranty

ShieldPress Local is provided **"as is"** without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.

We do not guarantee that the software will be:
- Free of bugs or errors
- Compatible with all hardware or software configurations
- Suitable for production hosting (this is a **local development** tool)

### 5. Limitation of Liability

In no event shall the author (vithanhlam) be liable for any direct, indirect, incidental, special, or consequential damages arising out of or in connection with the use of ShieldPress Local, including but not limited to:

- Loss of data, databases, or project files
- Security breaches on your machine
- Downtime or service interruption
- Corruption of files or configurations
- Any damages resulting from third-party software bundled with the application (Nginx, PHP, MariaDB, phpMyAdmin)

### 6. Bundled Software

ShieldPress Local bundles the following open-source software, each governed by their own licenses:

| Software | License |
|----------|---------|
| Nginx | BSD 2-Clause |
| PHP | PHP License |
| MariaDB | GPL v2 |
| phpMyAdmin | GPL v2 |
| WP-CLI | MIT |

These components are included for convenience and run locally on your machine. We are not the authors of these projects and provide no warranty for their behavior.

### 7. Changes to This Policy

We may update this Privacy Policy and Terms of Use from time to time. Changes will be reflected in the "Last updated" date at the top of this document and included in the application release notes.

---

## Contact

- **Author**: vithanhlam
- **Website**: [shieldpress.net](https://shieldpress.net)
- **Facebook**: [fb.com/vithanhlam](https://fb.com/vithanhlam)
- **Email**: support@shieldpress.net
- **GitHub**: [github.com/vithanhlam/shieldpress-local](https://github.com/vithanhlam/shieldpress-local)
- **Issues**: [GitHub Issues](https://github.com/vithanhlam/shieldpress-local/issues)

---

Copyright (C) 2026 vithanhlam. Licensed under the GNU General Public License v3.0.
