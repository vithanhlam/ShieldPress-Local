// src/main/email.js
const fs = require("fs-extra");
const path = require("path");
const net = require("net");
const tls = require("tls");
const log = require("./logger");

async function getEmailConfig() {
  const file = path.join(global.CONST.DATA_DIR, "email_config.json");
  if (!fs.existsSync(file)) {
    return {
      success: true,
      config: { host: "localhost", port: 587, username: "", password: "", from: "test@localhost", security: "starttls" },
    };
  }
  try {
    const cfg = JSON.parse(await fs.readFile(file, "utf8"));
    return { success: true, config: cfg };
  } catch {
    return { success: true, config: { host: "localhost", port: 587, username: "", password: "", from: "test@localhost", security: "starttls" } };
  }
}

async function saveEmailConfig(config) {
  const file = path.join(global.CONST.DATA_DIR, "email_config.json");
  await fs.writeFile(file, JSON.stringify(config, null, 2), "utf8");
  log.ok("Email config saved");

  // Apply sendmail_path to all PHP versions so PHP mail() works
  await applyPhpMailConfig(config);

  return { success: true };
}

async function applyPhpMailConfig(config) {
  const { PHP_BASE_DIR, getPhpDir, DATA_DIR } = global.CONST;
  if (!fs.existsSync(PHP_BASE_DIR)) return;

  const entries = await fs.readdir(PHP_BASE_DIR, { withFileTypes: true });
  const svc = require("./services");

  // Path to sendmail.js wrapper — works in both dev and packaged
  const sendmailScript = path.join(__dirname, "sendmail.js").replace(/\\/g, "/");
  // Find node executable
  const nodeExe = process.execPath.replace(/\\/g, "/");
  const dataDir = DATA_DIR.replace(/\\/g, "/");

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const phpIni = path.join(getPhpDir(entry.name), "php.ini");
    if (!fs.existsSync(phpIni)) continue;

    let ini = await fs.readFile(phpIni, "utf8");
    let changed = false;

    // Set sendmail_path: node sendmail.js -t
    // Also pass SHIELDPRESS_DATA_DIR env so sendmail.js can find the config
    const sendmailCmd = `"${nodeExe}" "${sendmailScript}" -t`;
    const sendmailRe = /^\s*;?\s*sendmail_path\s*=.*/m;
    if (sendmailRe.test(ini)) {
      ini = ini.replace(sendmailRe, `sendmail_path = "${sendmailCmd}"`);
    } else {
      ini += `\nsendmail_path = "${sendmailCmd}"\n`;
    }

    // Set SMTP and smtp_port as fallback (for PHP's built-in mail on Windows)
    const smtpRe = /^\s*;?\s*SMTP\s*=.*/m;
    const portRe = /^\s*;?\s*smtp_port\s*=.*/m;
    const fromRe = /^\s*;?\s*sendmail_from\s*=.*/m;

    if (smtpRe.test(ini)) ini = ini.replace(smtpRe, `SMTP = ${config.host || "localhost"}`);
    else ini += `\nSMTP = ${config.host || "localhost"}\n`;

    if (portRe.test(ini)) ini = ini.replace(portRe, `smtp_port = ${config.port || 587}`);
    else ini += `\nsmtp_port = ${config.port || 587}\n`;

    if (config.from) {
      if (fromRe.test(ini)) ini = ini.replace(fromRe, `sendmail_from = ${config.from}`);
      else ini += `\nsendmail_from = ${config.from}\n`;
    }

    await fs.writeFile(phpIni, ini, "utf8");
    log.ok(`PHP ${entry.name}: sendmail_path configured`);
  }

  // Set env var so sendmail.js can find config at runtime
  process.env.SHIELDPRESS_DATA_DIR = DATA_DIR;

  // Restart PHP to apply
  try {
    await svc.restartPhpCgi();
  } catch {}
}

async function sendTestEmail({ to, subject, body, config }) {
  if (!to) return { success: false, message: "Recipient email is required" };
  if (!config?.host) return { success: false, message: "SMTP host is required" };

  const host = config.host;
  const port = parseInt(config.port) || 587;
  const username = config.username || "";
  const password = config.password || "";
  const from = config.from || "test@localhost";
  const subj = subject || "ShieldPress Local — Test Email";
  const bodyText = body || `This is a test email sent from ShieldPress Local at ${new Date().toLocaleString()}.`;
  // security: 'ssl' = implicit TLS (port 465), 'starttls' = upgrade (port 587), 'none' = plain
  const security = config.security || (port === 465 ? "ssl" : port === 587 ? "starttls" : "none");

  // Build raw email
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subj}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `X-Mailer: ShieldPress Local`,
    ``,
    bodyText,
  ].join("\r\n");

  const responses = [];

  function smtpSession(socket) {
    return new Promise((resolve) => {
      let step = 0;
      let upgraded = false;

      socket.setTimeout(20000);
      socket.setEncoding("utf8");

      function send(line) {
        responses.push(`→ ${line.trim()}`);
        socket.write(line);
      }

      socket.on("data", (data) => {
        for (const line of data.split(/\r?\n/).filter(Boolean)) {
          responses.push(line);
          const code = parseInt(line.substring(0, 3));
          // Ignore multi-line continuation lines (e.g. 250-...)
          if (line[3] === "-") continue;

          if (step === 0 && code === 220) {
            send(`EHLO localhost\r\n`);
            step = 1;
          } else if (step === 1 && code === 250) {
            // Check if STARTTLS is available and we're in STARTTLS mode
            if (security === "starttls" && !upgraded && data.includes("STARTTLS")) {
              send(`STARTTLS\r\n`);
              step = 2; // waiting for STARTTLS ready
            } else if (username && password) {
              send(`AUTH LOGIN\r\n`);
              step = 10;
            } else {
              send(`MAIL FROM:<${from}>\r\n`);
              step = 3;
            }
          } else if (step === 2 && code === 220) {
            // Upgrade to TLS
            const plainSocket = socket;
            const tlsSocket = tls.connect({ socket: plainSocket, host, servername: host, rejectUnauthorized: false }, () => {
              upgraded = true;
              socket = tlsSocket;
              socket.setEncoding("utf8");
              socket.on("data", (d) => plainSocket.emit("data", d));
              send(`EHLO localhost\r\n`);
              step = 1;
            });
            tlsSocket.on("error", (err) => resolve({ success: false, message: "TLS upgrade failed: " + err.message, responses }));
          } else if (step === 10 && code === 334) {
            send(Buffer.from(username).toString("base64") + "\r\n");
            step = 11;
          } else if (step === 11 && code === 334) {
            send(Buffer.from(password).toString("base64") + "\r\n");
            step = 12;
          } else if (step === 12 && code === 235) {
            send(`MAIL FROM:<${from}>\r\n`);
            step = 3;
          } else if (step === 12) {
            send("QUIT\r\n");
            resolve({ success: false, message: "Authentication failed: " + line.trim(), responses });
          } else if (step === 3 && code === 250) {
            send(`RCPT TO:<${to}>\r\n`);
            step = 4;
          } else if (step === 4 && code === 250) {
            send(`DATA\r\n`);
            step = 5;
          } else if (step === 5 && code === 354) {
            send(message + "\r\n.\r\n");
            step = 6;
          } else if (step === 6 && code === 250) {
            send("QUIT\r\n");
            log.ok(`Test email sent to ${to}`);
            socket.destroy();
            resolve({ success: true, message: `Email sent to ${to}`, responses });
          } else if (code >= 400) {
            send("QUIT\r\n");
            socket.destroy();
            resolve({ success: false, message: "SMTP error: " + line.trim(), responses });
          }
        }
      });

      socket.on("error", (err) => {
        resolve({ success: false, message: "Connection failed: " + err.message, responses });
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve({ success: false, message: "Connection timed out (20s). Check host, port, and security settings.", responses });
      });

      socket.on("close", () => {
        if (step < 6) {
          resolve({ success: false, message: "Connection closed unexpectedly at step " + step, responses });
        }
      });
    });
  }

  if (security === "ssl") {
    // Implicit TLS (port 465): connect with TLS from the start
    log.info(`SMTP SSL connect to ${host}:${port}`);
    return new Promise((resolve) => {
      const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        log.info(`SMTP SSL connected to ${host}:${port}`);
      });
      socket.on("error", (err) => {
        resolve({ success: false, message: "SSL connection failed: " + err.message, responses });
      });
      smtpSession(socket).then(resolve);
    });
  } else {
    // Plain TCP with optional STARTTLS upgrade (port 587 or plain 25)
    log.info(`SMTP plain connect to ${host}:${port} (${security})`);
    return new Promise((resolve) => {
      const socket = net.createConnection(port, host, () => {
        log.info(`SMTP connected to ${host}:${port}`);
      });
      smtpSession(socket).then(resolve);
    });
  }
}

module.exports = { getEmailConfig, saveEmailConfig, sendTestEmail };
