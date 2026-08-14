const SSL = {
  open(id, name, domain, sslActive) {
    document.getElementById('ssl-proj-id').value         = id;
    document.getElementById('ssl-proj-name').textContent = name;
    document.getElementById('ssl-proj-domain').value     = domain;
    document.getElementById('ssl-domain').value          = domain;
    document.getElementById('ssl-progress').style.display = 'none';
    document.getElementById('ssl-output').textContent    = '';

    // Remove any leftover link from previous open
    const old = document.getElementById('ssl-https-link');
    if (old) old.remove();

    if (sslActive) {
      // Manage / Remove state
      document.getElementById('ssl-modal-icon').style.color = 'var(--green)';
      document.getElementById('ssl-modal-title').textContent = 'Manage SSL';
      document.getElementById('ssl-install-section').style.display = 'none';
      document.getElementById('ssl-active-section').style.display  = 'block';
      document.getElementById('ssl-footer').innerHTML = `
        <button class="btn btn-ghost" onclick="closeModal('m-ssl')">Close</button>
        <button class="btn btn-danger" id="ssl-remove-btn" onclick="SSL.remove()">
          <i class="fas fa-lock-open"></i> Remove SSL
        </button>`;
    } else {
      // Install state
      document.getElementById('ssl-modal-icon').style.color = 'var(--accent)';
      document.getElementById('ssl-modal-title').textContent = 'Install SSL';
      document.getElementById('ssl-install-section').style.display = 'block';
      document.getElementById('ssl-active-section').style.display  = 'none';
      document.getElementById('ssl-footer').innerHTML = `
        <button class="btn btn-ghost" onclick="closeModal('m-ssl')">Cancel</button>
        <button class="btn btn-primary" id="ssl-install-btn" onclick="SSL.install()">
          <i class="fas fa-lock"></i> Install SSL
        </button>`;
    }

    openModal('m-ssl');
  },

  async install() {
    const id     = document.getElementById('ssl-proj-id').value;
    const domain = document.getElementById('ssl-proj-domain').value;
    const btn    = document.getElementById('ssl-install-btn');
    const out    = document.getElementById('ssl-output');

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Installing...';
    document.getElementById('ssl-progress').style.display = 'block';
    out.textContent = '';

    try {
      const r = await api.installSSL({ id, domain });
      out.textContent = r.output || 'Done.';
      if (r.success) {
        btn.innerHTML = '<i class="fas fa-check"></i> Installed';
        toast('SSL installed! Use: ' + r.httpsUrl, 'success', 6000);
        // Show clickable link
        const link = document.createElement('a');
        link.id = 'ssl-https-link';
        link.href = '#';
        link.style.cssText = 'display:block;margin-top:8px;color:var(--accent);font-size:13px';
        link.innerHTML = '<i class="fas fa-external-link-alt"></i> Open ' + r.httpsUrl;
        link.onclick = (e) => { e.preventDefault(); api.openBrowser(r.httpsUrl); };
        out.after(link);
        // Refresh card so lock turns green
        Projects.load();
      } else {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-lock"></i> Install SSL';
        toast('SSL installation failed. See output above.', 'error');
      }
    } catch (e) {
      out.textContent = String(e);
      btn.disabled    = false;
      btn.innerHTML   = '<i class="fas fa-lock"></i> Install SSL';
      toast('SSL error: ' + e, 'error');
    }
  },

  async remove() {
    const id     = document.getElementById('ssl-proj-id').value;
    const domain = document.getElementById('ssl-proj-domain').value;
    const btn    = document.getElementById('ssl-remove-btn');
    const out    = document.getElementById('ssl-output');

    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Removing...';
    document.getElementById('ssl-progress').style.display = 'block';
    out.textContent = '';

    try {
      const r = await api.removeSSL({ id, domain });
      out.textContent = r.output || 'Done.';
      if (r.success) {
        toast('SSL removed. Project back to HTTP.', 'success');
        closeModal('m-ssl');
        Projects.load();
      } else {
        btn.disabled  = false;
        btn.innerHTML = '<i class="fas fa-lock-open"></i> Remove SSL';
        toast('Remove SSL failed. See output above.', 'error');
      }
    } catch (e) {
      out.textContent = String(e);
      btn.disabled    = false;
      btn.innerHTML   = '<i class="fas fa-lock-open"></i> Remove SSL';
      toast('Error: ' + e, 'error');
    }
  }
};
