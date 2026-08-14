// renderer/js/email.js

window.EmailTest = {
  async init() {
    const r = await api.getEmailConfig();
    if (r.success && r.config) {
      document.getElementById("email-host").value = r.config.host || "";
      document.getElementById("email-port").value = r.config.port || 587;
      document.getElementById("email-user").value = r.config.username || "";
      document.getElementById("email-from").value = r.config.from || "";
      const sec = document.getElementById("email-security");
      if (sec) sec.value = r.config.security || "starttls";
    }
  },

  autoDetectSecurity() {
    const port = parseInt(document.getElementById("email-port").value) || 587;
    const sec = document.getElementById("email-security");
    if (!sec) return;
    if (port === 465) sec.value = "ssl";
    else if (port === 587 || port === 25) sec.value = "starttls";
    else if (port === 25 || port === 2525) sec.value = "none";
  },

  async saveConfig() {
    const btn = document.getElementById("email-save-btn");
    const origHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    const config = {
      host: document.getElementById("email-host").value.trim(),
      port: parseInt(document.getElementById("email-port").value) || 587,
      username: document.getElementById("email-user").value.trim(),
      password: document.getElementById("email-pass").value || "",
      from: document.getElementById("email-from").value.trim() || "test@localhost",
      security: document.getElementById("email-security")?.value || "starttls",
    };

    const r = await api.saveEmailConfig(config);

    btn.disabled = false;
    btn.innerHTML = origHTML;

    if (r.success) toast("Email config saved", "success");
    else toast("Failed: " + r.message, "error");
  },

  async send() {
    const to = document.getElementById("email-to").value.trim();
    if (!to) { toast("Recipient email is required", "warn"); return; }

    const config = {
      host: document.getElementById("email-host").value.trim(),
      port: parseInt(document.getElementById("email-port").value) || 587,
      username: document.getElementById("email-user").value.trim(),
      password: document.getElementById("email-pass").value || "",
      from: document.getElementById("email-from").value.trim() || "test@localhost",
      security: document.getElementById("email-security")?.value || "starttls",
    };

    const btn = document.getElementById("email-send-btn");
    const result = document.getElementById("email-result");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    result.style.display = "";

    const secLabel = { ssl: "SSL/TLS", starttls: "STARTTLS", none: "Plain" }[config.security] || config.security;
    result.textContent = `Connecting to ${config.host}:${config.port} [${secLabel}]...\n`;

    const r = await api.sendTestEmail({
      to,
      subject: document.getElementById("email-subject").value.trim(),
      body: document.getElementById("email-body").value.trim(),
      config,
    });

    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-paper-plane"></i> Send Test Email';

    if (r.success) {
      result.textContent += "SUCCESS: " + r.message + "\n";
      if (r.responses) result.textContent += "\nSMTP Log:\n" + r.responses.join("\n");
      toast("Email sent!", "success");
    } else {
      result.textContent += "FAILED: " + r.message + "\n";
      if (r.responses) result.textContent += "\nSMTP Log:\n" + r.responses.join("\n");
      toast("Send failed: " + r.message, "error");
    }
  },
};
