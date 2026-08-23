const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Projects
  getProjects: () => ipcRenderer.invoke("get-projects"),
  createProject: (d) => ipcRenderer.invoke("create-project", d),
  deleteProject: (id) => ipcRenderer.invoke("delete-project", id),
  startProject: (id) => ipcRenderer.invoke("start-project", id),
  openProjectWebsite: (id) => ipcRenderer.invoke("open-project-website", id),
  stopProject: (id) => ipcRenderer.invoke("stop-project", id),
  updateProjectSettings: (d) =>
    ipcRenderer.invoke("update-project-settings", d),
  toggleStar: (id) => ipcRenderer.invoke("toggle-star", id),
  getNginxConfig: (id) => ipcRenderer.invoke("get-nginx-config", id),
  saveNginxConfig: (d) => ipcRenderer.invoke("save-nginx-config", d),
  getProjectDebug: (id) => ipcRenderer.invoke("get-project-debug", id),

  // Services
  startNginx: () => ipcRenderer.invoke("start-nginx"),
  stopNginx: () => ipcRenderer.invoke("stop-nginx"),
  restartNginx: () => ipcRenderer.invoke("restart-nginx"),
  startPhp: () => ipcRenderer.invoke("start-php"),
  stopPhp: () => ipcRenderer.invoke("stop-php"),
  restartPhp: (version) => ipcRenderer.invoke("restart-php", version),
  startMariaDB: () => ipcRenderer.invoke("start-mariadb"),
  stopMariaDB: () => ipcRenderer.invoke("stop-mariadb"),
  restartMariaDB: () => ipcRenderer.invoke("restart-mariadb"),
  getServiceStatus: () => ipcRenderer.invoke("get-service-status"),
  getAvailablePhp: () => ipcRenderer.invoke("get-available-php"),

  // Generic invoke (for PhpVersions helper)
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  // Database
  createDatabase: (name) => ipcRenderer.invoke("create-database", name),
  listDatabases: () => ipcRenderer.invoke("list-databases"),
  exportDatabase: (d) => ipcRenderer.invoke("export-database", d),
  importDatabase: (d) => ipcRenderer.invoke("import-database", d),
  onDatabaseProgress: (cb) => ipcRenderer.on("database-progress", (_e, data) => cb(data)),
  dropDatabase: (name) => ipcRenderer.invoke("drop-database", name),
  execRawSql: (sql) => ipcRenderer.invoke("exec-raw-sql", sql),
  openImportDialog: () => ipcRenderer.invoke("open-import-dialog"),
  getMariaDBPort: () => ipcRenderer.invoke("get-mariadb-port"),
  setMariaDBPort: (port) => ipcRenderer.invoke("set-mariadb-port", port),
  getRootPasswordStatus: () => ipcRenderer.invoke("get-root-password-status"),
  changeRootPassword: (password) => ipcRenderer.invoke("change-root-password", password),

  // Laravel
  installLaravel: (d) => ipcRenderer.invoke("install-laravel", d),
  runArtisan: (d) => ipcRenderer.invoke("run-artisan", d),
  onLaravelProgress: (cb) =>
    ipcRenderer.on("laravel-progress", (_e, msg) => cb(msg)),

  // WordPress
  installWordPress: (d) => ipcRenderer.invoke("install-wordpress", d),
  wpGetUsers: (id) => ipcRenderer.invoke("wp-get-users", id),
  wpAutoLogin: (d) => ipcRenderer.invoke("wp-auto-login", d),
  wpResetPassword: (d) => ipcRenderer.invoke("wp-reset-password", d),
  wpToggleDebug: (d) => ipcRenderer.invoke("wp-toggle-debug", d),
  getWpDebugState: (d) => ipcRenderer.invoke("get-wp-debug-state", d),
  getWpDebugLog: (id) => ipcRenderer.invoke("get-wp-debug-log", id),
  downloadWpCli: () => ipcRenderer.invoke("download-wp-cli"),
  wpCli: (d) => ipcRenderer.invoke("wp-cli", d),

  // Backup
  backupProject: (id) => ipcRenderer.invoke("backup-project", id),
  onBackupProgress: (cb) => ipcRenderer.on("backup-progress", (_e, data) => cb(data)),
  getBackups: () => ipcRenderer.invoke("get-backups"),
  backupProjectDb: (id) => ipcRenderer.invoke("backup-project-db", id),
  onProjectDbBackupProgress: (cb) =>
    ipcRenderer.on("project-db-backup-progress", (_e, data) => cb(data)),

  // Quit backup events
  onQuitBackupStart: (cb) => ipcRenderer.on("quit-backup-start", (_e, total) => cb(total)),
  onQuitBackupProgress: (cb) => ipcRenderer.on("quit-backup-progress", (_e, data) => cb(data)),
  onQuitBackupDone: (cb) => ipcRenderer.on("quit-backup-done", () => cb()),
  onQuitStopping: (cb) => ipcRenderer.on("quit-stopping", () => cb()),

  // Config
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (c) => ipcRenderer.invoke("save-config", c),
  getPhpConfig: (version) => ipcRenderer.invoke("get-php-config", version),
  savePhpConfig: (content, version) =>
    ipcRenderer.invoke("save-php-config", content, version),
  getMariaDBConfig: () => ipcRenderer.invoke("get-mariadb-config"),
  saveMariaDBConfig: (content) => ipcRenderer.invoke("save-mariadb-config", content),
  getLogs: (id) => ipcRenderer.invoke("get-logs", id),
  getLogBuffer: () => ipcRenderer.invoke("get-log-buffer"),

  // App
  checkBinaries: () => ipcRenderer.invoke("check-binaries"),
  getSystemStats: () => ipcRenderer.invoke("get-system-stats"),
  getAppInfo: () => ipcRenderer.invoke("get-app-info"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  getDataDir: () => ipcRenderer.invoke("get-data-dir"),
  getBinDir: () => ipcRenderer.invoke("get-bin-dir"),
  openFolder: (p) => ipcRenderer.invoke("open-folder", p),
  revealPath: (p) => ipcRenderer.invoke("reveal-path", p),
  openBrowser: (u) => ipcRenderer.invoke("open-browser", u),
  openPhpMyAdmin: () => ipcRenderer.invoke("open-phpmyadmin"),
  openFileDialog: (opts) => ipcRenderer.invoke("open-file-dialog", opts),

  // Absolute path for File objects from drag-drop / <input type=file>
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return (file && file.path) || "";
    }
  },

  // Page
  readPage: (name) => ipcRenderer.invoke("read-page", name),

  // Window
  openHostsFile: () => ipcRenderer.invoke("open-hosts-file"),
  minimize: () => ipcRenderer.invoke("window-minimize"),
  maximize: () => ipcRenderer.invoke("window-maximize"),
  close: () => ipcRenderer.invoke("window-close"),

  // Events
  onLogLine: (cb) => ipcRenderer.on("log-line", (e, line) => cb(line)),

  // Plugins & License (license UI hidden, backend ready)
  getPlugins: () => ipcRenderer.invoke("get-plugins"),
  runPlugin: (d) => ipcRenderer.invoke("run-plugin", d),
  getLicense: () => ipcRenderer.invoke("get-license"),
  activateLicense: (key) => ipcRenderer.invoke("activate-license", key),
  deactivateLicense: () => ipcRenderer.invoke("deactivate-license"),
  readPluginPage: (id) => ipcRenderer.invoke("read-plugin-page", id),

  // Path
  setDataDir: (p) => ipcRenderer.invoke("set-data-dir", p),
  restartApp: () => ipcRenderer.invoke("restart-app"),

  // Clone progress event
  onCloneProgress: (cb) =>
    ipcRenderer.on("clone-progress", (e, data) => cb(data)),

  // SFTP & FTP
  sftpVaultStatus: () => ipcRenderer.invoke("sftp-vault-status"),
  sftpVaultSetup: (password) => ipcRenderer.invoke("sftp-vault-setup", password),
  sftpVaultUnlock: (password) => ipcRenderer.invoke("sftp-vault-unlock", password),
  sftpVaultChangePassword: (data) => ipcRenderer.invoke("sftp-vault-change-password", data),
  sftpVaultLock: () => ipcRenderer.invoke("sftp-vault-lock"),
  sftpGetConnections: () => ipcRenderer.invoke("sftp-get-connections"),
  sftpSaveConnection: (d) => ipcRenderer.invoke("sftp-save-connection", d),
  sftpDeleteConnection: (id) => ipcRenderer.invoke("sftp-delete-connection", id),
  sftpConnect: (id) => ipcRenderer.invoke("sftp-connect", id),
  sftpConnectSession: (sessionId) => ipcRenderer.invoke("sftp-connect-session", sessionId),
  sftpDisconnect: (id) => ipcRenderer.invoke("sftp-disconnect", id),
  sftpDisconnectAll: () => ipcRenderer.invoke("sftp-disconnect-all"),
  sftpCloseSession: (sessionId) => ipcRenderer.invoke("sftp-close-session", sessionId),
  sftpOpenWindow: (kind, connectionId) => ipcRenderer.invoke("sftp-open-window", { kind, connectionId }),
  sftpList: (id, remotePath) => ipcRenderer.invoke("sftp-list", { id, remotePath }),
  sftpDownload: (id, remotePath, localPath) => ipcRenderer.invoke("sftp-download", { id, remotePath, localPath }),
  sftpDownloadBatch: (id, items, opts) => ipcRenderer.invoke("sftp-download-batch", { id, items, ...(opts || {}) }),
  sftpUpload: (id, localPath, remotePath) => ipcRenderer.invoke("sftp-upload", { id, localPath, remotePath }),
  sftpUploadBatch: (id, items, opts) => ipcRenderer.invoke("sftp-upload-batch", { id, items, ...(opts || {}) }),
  sftpUploadCancel: () => ipcRenderer.invoke("sftp-upload-cancel"),
  sftpSyncUpload: (id, opts) => ipcRenderer.invoke("sftp-sync-upload", { id, ...(opts || {}) }),
  sftpSyncDownload: (id, opts) => ipcRenderer.invoke("sftp-sync-download", { id, ...(opts || {}) }),
  sftpValidatePath: (localPath) => ipcRenderer.invoke("sftp-validate-path", localPath),
  sftpExec: (id, command) => ipcRenderer.invoke("sftp-exec", { id, command }),
  sftpSystemInfo: (id) => ipcRenderer.invoke("sftp-system-info", id),
  sftpRemoteStats: (id) => ipcRenderer.invoke("sftp-remote-stats", id),
  sftpShellStart: (id, cols, rows, sessionId) => ipcRenderer.invoke("sftp-shell-start", { id, cols, rows, sessionId }),
  sftpShellWrite: (id, data) => ipcRenderer.invoke("sftp-shell-write", { id, data }),
  sftpShellResize: (id, cols, rows) => ipcRenderer.invoke("sftp-shell-resize", { id, cols, rows }),
  sftpShellStop: (id) => ipcRenderer.invoke("sftp-shell-stop", id),
  onSftpShellData: (cb) => ipcRenderer.on("sftp-shell-data", (_e, payload) => cb(payload)),
  onSftpShellExit: (cb) => ipcRenderer.on("sftp-shell-exit", (_e, payload) => cb(payload)),
  sftpDelete: (id, remotePath, isDirectory) => ipcRenderer.invoke("sftp-delete", { id, remotePath, isDirectory }),
  sftpReadFile: (id, remotePath) => ipcRenderer.invoke("sftp-read-file", { id, remotePath }),
  sftpWriteFile: (id, remotePath, content, opts) => ipcRenderer.invoke("sftp-write-file", { id, remotePath, content, ...(opts || {}) }),
  sftpDetectLanguage: (remotePath) => ipcRenderer.invoke("sftp-detect-language", remotePath),
  sftpValidateContent: (remotePath, content) => ipcRenderer.invoke("sftp-validate-content", { remotePath, content }),
  sftpUploadExtract: (id, localZipPath, remotePath) => ipcRenderer.invoke("sftp-upload-extract", { id, localZipPath, remotePath }),
  sftpMkdir: (id, remotePath) => ipcRenderer.invoke("sftp-mkdir", { id, remotePath }),
  sftpCreateFile: (id, remotePath) => ipcRenderer.invoke("sftp-create-file", { id, remotePath }),
  sftpCopy: (id, sourcePath, destinationPath, isDirectory) => ipcRenderer.invoke("sftp-copy", { id, sourcePath, destinationPath, isDirectory }),
  sftpMove: (id, sourcePath, destinationPath) => ipcRenderer.invoke("sftp-move", { id, sourcePath, destinationPath }),
  sftpRename: (id, remotePath, newName) => ipcRenderer.invoke("sftp-rename", { id, remotePath, newName }),
  sftpToggleStar: (id) => ipcRenderer.invoke("sftp-toggle-star", id),
  sftpSaveLastPath: (id, path) => ipcRenderer.invoke("sftp-save-last-path", { id, path }),
  sftpCheckExists: (id, remotePath) => ipcRenderer.invoke("sftp-check-exists", { id, remotePath }),
  sftpStatLocal: (localPath) => ipcRenderer.invoke("sftp-stat-local", localPath),
  sftpOpenExternal: (id, remotePath, editorPath) => ipcRenderer.invoke("sftp-open-external", { id, remotePath, editorPath }),
  onSftpProgress: (cb) => ipcRenderer.on("sftp-progress", (_e, msg) => cb(msg)),
  onSftpUploadProgress: (cb) => ipcRenderer.on("sftp-upload-progress", (_e, msg) => cb(msg)),
  onSftpExternalSave: (cb) => ipcRenderer.on("sftp-external-save", (_e, data) => cb(data)),

  // Email
  getEmailConfig: () => ipcRenderer.invoke("get-email-config"),
  saveEmailConfig: (config) => ipcRenderer.invoke("save-email-config", config),
  sendTestEmail: (d) => ipcRenderer.invoke("send-test-email", d),

  // Extensions
  getExtensions: (phpVersion) => ipcRenderer.invoke("get-extensions", phpVersion),
  toggleExtension: (d) => ipcRenderer.invoke("toggle-extension", d),
  installIoncube: (d) => ipcRenderer.invoke("install-ioncube", d),
  enableEssentials: (phpVersion) => ipcRenderer.invoke("enable-essentials", phpVersion),
  fixExtensionDir: (phpVersion) => ipcRenderer.invoke("fix-extension-dir", phpVersion),
  deduplicateExtensions: (phpVersion) => ipcRenderer.invoke("deduplicate-extensions", phpVersion),
  getDuplicateInfo: (phpVersion) => ipcRenderer.invoke("get-duplicate-info", phpVersion),
  addPhpVersion: (d) => ipcRenderer.invoke("add-php-version", d),
  removePhpVersion: (version) => ipcRenderer.invoke("remove-php-version", version),
  onIoncubeProgress: (cb) => ipcRenderer.on("ioncube-progress", (_e, msg) => cb(msg)),

  // Git / GitHub
  gitStatus: (id) => ipcRenderer.invoke("git-status", id),
  gitSaveConfig: (id, config) => ipcRenderer.invoke("git-save-config", { id, config }),
  gitInit: (id, data) => ipcRenderer.invoke("git-init", { id, data }),
  gitPush: (id, data) => ipcRenderer.invoke("git-push", { id, data }),
  gitPull: (id, data) => ipcRenderer.invoke("git-pull", { id, data }),
  gitCloneRepo: (id, data) => ipcRenderer.invoke("git-clone-repo", { id, data }),
  gitExec: (id, cmd) => ipcRenderer.invoke("git-exec", { id, cmd }),
  onGitProgress: (cb) => ipcRenderer.on("git-progress", (_e, msg) => cb(msg)),

  // Tasks
  getTasks: (id) => ipcRenderer.invoke("get-tasks", id),
  saveTasks: (id, tasks) => ipcRenderer.invoke("save-tasks", { id, tasks }),

  // Node tools
  runNodeTool: (d) => ipcRenderer.invoke("run-node-tool", d),

  // Editor
  setPhpPath: (p) => ipcRenderer.invoke("set-php-path", p),
  openInEditor: (id) => ipcRenderer.invoke("open-in-editor", id),
  getDetectedEditor: () => ipcRenderer.invoke("get-detected-editor"),
  setEditorPath: (p) => ipcRenderer.invoke("set-editor-path", p),

  // SSL
  installSSL: (d) => ipcRenderer.invoke("install-ssl", d),
  removeSSL:  (d) => ipcRenderer.invoke("remove-ssl", d),
  checkMkcert: () => ipcRenderer.invoke("check-mkcert"),

  // Cloud Backup (local folder sync)
  gdriveGetStatus:          ()       => ipcRenderer.invoke("gdrive-get-status"),
  gdriveDetectFolders:      ()       => ipcRenderer.invoke("gdrive-detect-folders"),
  gdriveGetFolder:          ()       => ipcRenderer.invoke("gdrive-get-folder"),
  gdriveSaveFolder:         (folder) => ipcRenderer.invoke("gdrive-save-folder", folder),
  gdriveGetProjectConfig:   (id)     => ipcRenderer.invoke("gdrive-get-project-config", id),
  gdriveSaveProjectConfig:  (id, cfg) => ipcRenderer.invoke("gdrive-save-project-config", id, cfg),
  gdriveBackupProject:      (id)     => ipcRenderer.invoke("gdrive-backup-project", id),
  gdriveBackupDb:           (id)     => ipcRenderer.invoke("gdrive-backup-db", id),
  onGdriveProgress: (cb) => ipcRenderer.on("gdrive-backup-progress", (_e, msg) => cb(msg)),

  // Redis
  startRedis:    () => ipcRenderer.invoke("start-redis"),
  stopRedis:     () => ipcRenderer.invoke("stop-redis"),
  restartRedis:  () => ipcRenderer.invoke("restart-redis"),
  getRedisInfo:  () => ipcRenderer.invoke("get-redis-info"),
  downloadRedis: () => ipcRenderer.invoke("download-redis"),
  flushRedis:    () => ipcRenderer.invoke("flush-redis"),
  getRedisPort:  () => ipcRenderer.invoke("get-redis-port"),
  setRedisPort:  (p) => ipcRenderer.invoke("set-redis-port", p),
  onRedisDownloadProgress: (cb) => ipcRenderer.on("redis-download-progress", (_e, msg) => cb(msg)),
});
