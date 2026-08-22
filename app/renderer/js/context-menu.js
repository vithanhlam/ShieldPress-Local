window.ContextMenu = {
  el: null,

  init() {
    const div = document.createElement("div");
    div.id = "ctx-menu";
    div.style.cssText = `
      display:none;position:fixed;z-index:9999;
      background:var(--bg2);border:1px solid var(--border2);
      border-radius:var(--r);padding:6px;min-width:200px;
      box-shadow:0 8px 32px rgba(0,0,0,.5);
    `;
    document.body.appendChild(div);
    this.el = div;
  },

  // Find project card from right-click target
  _findProjectCard(target) {
    const card = target.closest(".proj-card[data-id]");
    if (!card) return null;
    const id = card.dataset.id;
    return App.projects.find((p) => p.id === id) || null;
  },

  showProject(x, y, proj) {
    if (!this.el) this.init();
    const running = proj.isRunning || proj.status === "running";
    const scheme = proj.ssl?.enabled ? "https" : "http";
    const safeName = proj.name.replace(/'/g, "\\'");

    this.el.innerHTML = `
      <div class="ctx-section">${proj.name}</div>
      ${running
        ? `<div class="ctx-item" onclick="Projects.stop('${proj.id}');ContextMenu.hide()">
            <i class="fas fa-stop" style="color:var(--red)"></i> Stop Project
          </div>`
        : `<div class="ctx-item" onclick="Projects.start('${proj.id}');ContextMenu.hide()">
            <i class="fas fa-play" style="color:var(--green)"></i> Start Project
          </div>`
      }
      <div class="ctx-item" onclick="Projects.openBrowser('${proj.id}');ContextMenu.hide()">
        <i class="fas fa-external-link-alt"></i> Open Website
      </div>
      <div class="ctx-item" onclick="Projects.openFolder('${proj.id}');ContextMenu.hide()">
        <i class="fas fa-folder-open"></i> Open Folder
      </div>
      <div class="ctx-item" onclick="Projects.openInEditor('${proj.id}');ContextMenu.hide()">
        <i class="fas fa-code" style="color:var(--accent)"></i> Open in Editor
      </div>
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="Projects.openDebug('${proj.id}');ContextMenu.hide()">
        <i class="fas fa-bug"></i> Debug Logs
      </div>
      <div class="ctx-item" onclick="Projects.openEdit('${proj.id}');ContextMenu.hide()">
        <i class="fas fa-cog"></i> Settings
      </div>
      <div class="ctx-item" onclick="TaskList.open('${proj.id}', '${safeName}');ContextMenu.hide()">
        <i class="fas fa-tasks"></i> Task List
      </div>
      ${proj.projectType === "wordpress" || proj.projectType === "php"
        ? `<div class="ctx-item" onclick="Projects.openWordPress('${proj.id}');ContextMenu.hide()">
            <i class="fab fa-wordpress"></i> WordPress
          </div>
          <div class="ctx-item" onclick="QuickLogin.open('${proj.id}', '${safeName}');ContextMenu.hide()">
            <i class="fas fa-unlock-alt"></i> Quick Login
          </div>`
        : ""
      }
      ${proj.projectType === "laravel"
        ? `<div class="ctx-item" onclick="Projects.openLaravel('${proj.id}');ContextMenu.hide()">
            <i class="fab fa-laravel" style="color:#ff2d20"></i> Laravel
          </div>`
        : ""
      }
      ${proj.projectType === "node" || proj.projectType === "nextjs"
        ? `<div class="ctx-item" onclick="Projects.openNode('${proj.id}');ContextMenu.hide()">
            <i class="fab fa-node-js" style="color:#68a063"></i> Node.js
          </div>`
        : ""
      }
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="GitPush.open('${proj.id}', '${safeName}');ContextMenu.hide()">
        <i class="fab fa-github"></i> Git Push
      </div>
      <div class="ctx-item" onclick="SSL.open('${proj.id}', '${safeName}', '${proj.domain}', ${!!proj.ssl?.enabled});ContextMenu.hide()">
        <i class="fas fa-lock" ${proj.ssl?.enabled ? 'style="color:var(--green)"' : ''}></i> ${proj.ssl?.enabled ? 'SSL Active' : 'Install SSL'}
      </div>
      <div class="ctx-divider"></div>
      <div class="ctx-item ctx-danger" onclick="Projects.confirmDelete('${proj.id}', '${safeName}');ContextMenu.hide()">
        <i class="fas fa-trash"></i> Delete Project
      </div>
    `;

    this._position(x, y);
  },

  showRemote(x, y, target) {
    if (!this.el) this.init();
    const item = target.item;
    const heading = item ? item.name : target.currentPath;
    const encoded = item ? encodeURIComponent(item.path) : "";
    const directory = item?.type === "directory";
    const editable = item?.editable;
    const action = target.scope === "terminal" ? "termContext" : "context";
    const relativeHint = item
      ? (item.path.startsWith(target.currentPath) ? item.path.slice(target.currentPath.replace(/\/+$/, "").length).replace(/^\//, "") : item.name)
      : "";
    this.el.innerHTML = `
      <div class="ctx-section">${SFTP._esc(heading || "Remote Files")}</div>
      ${item && directory ? `<div class="ctx-item" onclick="SFTP.${action}OpenFolder('${encoded}');ContextMenu.hide()"><i class="fas fa-folder-open"></i> Open</div>` : ""}
      ${item && !directory && editable ? `<div class="ctx-item" onclick="SFTP.${action}Edit('${encoded}');ContextMenu.hide()"><i class="fas fa-edit"></i> Edit</div>` : ""}
      ${item && target.scope !== "terminal" && directory ? "" : ""}
      ${item && target.scope === "browser" && !directory ? "" : ""}
      ${item ? `<div class="ctx-item" onclick="SFTP.${action}Download('${encoded}',${directory});ContextMenu.hide()"><i class="fas fa-download"></i> Download${directory ? " Folder" : ""}</div>` : ""}
      <div class="ctx-item" onclick="SFTP.${action === "termContext" ? "termUploadFiles" : "uploadFromDialog"}();ContextMenu.hide()"><i class="fas fa-upload"></i> Upload Here</div>
      ${item && !directory && editable ? `<div class="ctx-item" onclick="SFTP.${action}OpenExternal('${encoded}');ContextMenu.hide()"><i class="fas fa-external-link-alt"></i> Open in Default Editor</div>
        <div class="ctx-item" onclick="SFTP.${action}OpenWith('${encoded}');ContextMenu.hide()"><i class="fas fa-code"></i> Open With...</div>` : ""}
      ${item ? `<div class="ctx-divider"></div>
        <div class="ctx-item" onclick="SFTP.${action}Rename('${encoded}',${directory});ContextMenu.hide()"><i class="fas fa-i-cursor"></i> Rename</div>
        <div class="ctx-item" onclick="SFTP.${action}Clone('${encoded}',${directory});ContextMenu.hide()"><i class="fas fa-clone"></i> Duplicate</div>
        <div class="ctx-item" onclick="SFTP.${action}Move('${encoded}');ContextMenu.hide()"><i class="fas fa-arrows-alt"></i> Move...</div>` : ""}
      <div class="ctx-divider"></div>
      <div class="ctx-item" onclick="SFTP.${action}NewFile();ContextMenu.hide()"><i class="fas fa-file-medical"></i> New File</div>
      <div class="ctx-item" onclick="SFTP.${action}NewFolder();ContextMenu.hide()"><i class="fas fa-folder-plus"></i> New Folder</div>
      <div class="ctx-item" onclick="SFTP.${action}Refresh();ContextMenu.hide()"><i class="fas fa-sync"></i> Refresh</div>
      ${item ? `<div class="ctx-divider"></div>
        <div class="ctx-item" onclick="SFTP.copyRemotePath(decodeURIComponent('${encoded}'));ContextMenu.hide()"><i class="fas fa-copy"></i> Copy Path</div>
        <div class="ctx-item" onclick="navigator.clipboard.writeText('${relativeHint.replace(/'/g, "\\'")}').then(()=>toast('Relative path copied','success'));ContextMenu.hide()"><i class="fas fa-copy"></i> Copy Relative Path</div>
        <div class="ctx-item" onclick="toast('Name: ${SFTP._esc(item.name)}\\nPath: ${SFTP._esc(item.path)}\\nType: ${directory ? "Folder" : "File"}','info');ContextMenu.hide()"><i class="fas fa-info-circle"></i> Properties</div>
        <div class="ctx-divider"></div>
        <div class="ctx-item ctx-danger" onclick="SFTP.${action}Delete('${encoded}',${directory});ContextMenu.hide()"><i class="fas fa-trash"></i> Delete</div>` : ""}
    `;
    this._position(x, y);
  },

  show(x, y) {
    if (!this.el) this.init();
    const s = App.serviceStatus;

    this.el.innerHTML = `
      <div class="ctx-section">Services</div>
      <div class="ctx-item" onclick="Services.${s.nginx ? "restartNginx" : "startNginx"}();ContextMenu.hide()">
        <i class="fas fa-server"></i> ${s.nginx ? "Restart Nginx" : "Start Nginx"}
      </div>
      <div class="ctx-item" onclick="Services.${s.php ? "restartPhp" : "startPhp"}();ContextMenu.hide()">
        <i class="fas fa-code"></i> ${s.php ? "Restart PHP" : "Start PHP"}
      </div>
      <div class="ctx-item" onclick="Services.${s.mariadb ? "restartMariaDB" : "startMariaDB"}();ContextMenu.hide()">
        <i class="fas fa-database"></i> ${s.mariadb ? "Restart MariaDB" : "Start MariaDB"}
      </div>
      <div class="ctx-divider"></div>
      <div class="ctx-section">Quick Actions</div>
      <div class="ctx-item" onclick="CreateProject.open();ContextMenu.hide()">
        <i class="fas fa-plus"></i> New Project
      </div>
      <div class="ctx-item" onclick="nav('backups');ContextMenu.hide()">
        <i class="fas fa-archive"></i> Backup
      </div>
      <div class="ctx-item" onclick="nav('plugins');ContextMenu.hide()">
        <i class="fas fa-puzzle-piece"></i> Plugins
      </div>
      <div class="ctx-item" onclick="api.openPhpMyAdmin();ContextMenu.hide()">
        <i class="fas fa-external-link-alt"></i> phpMyAdmin
      </div>
      <div class="ctx-divider"></div>
      <div class="ctx-item ctx-danger" onclick="api.close()">
        <i class="fas fa-times"></i> Quit
      </div>
    `;

    this._position(x, y);
  },

  _position(x, y) {
    this.el.style.display = "block";
    const rect = this.el.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    this.el.style.left = Math.min(x, maxX) + "px";
    this.el.style.top = Math.min(y, maxY) + "px";
  },

  hide() {
    if (this.el) this.el.style.display = "none";
  },
};
