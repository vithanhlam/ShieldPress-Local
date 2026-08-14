#!/usr/bin/env node
// sendmail.js — Standalone sendmail replacement for PHP mail() on Windows
// Reads email from stdin, sends via SMTP using config from email_config.json
// Usage: node sendmail.js -t

const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");

// Find config file: look relative to this script, then common locations
function findConfig() {
  // When called from PHP, cwd may be the project dir.
  // The config is at DATA_DIR/email_config.json.
  // We pass DATA_DIR via env var SHIELDPRESS_DATA_DIR set by the email module.
  const envDir = process.env.SHIELDPRESS_DATA_DIR;
  if (envDir) {
    const p = path.join(envDir, "email_config.json");
    if (fs.existsSync(p)) return p;
  }
  // Fallback: scan up from script location
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, "data", "email_config.json");
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  return null;
}

// Read all stdin
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    // Timeout after 10s if no input
    setTimeout(() => resolve(chunks.join("")), 10000);
  });
}

// Parse email headers from raw message
function parseEmail(raw) {
  const idx = raw.indexOf("\r\n\r\n");
  const idx2 = raw.indexOf("\n\n");
  const splitIdx = idx >= 0 ? idx : idx2;
  const headerPart = splitIdx >= 0 ? raw.substring(0, splitIdx) : raw;
  const bodyPart = splitIdx >= 0 ? raw.substring(splitIdx).replace(/^\r?\n\r?\n/, "") : "";

  const headers = {};
  const lines = headerPart.split(/\r?\n/);
  let lastKey = "";
  for (const line of lines) {
    if (/^\s/.test(line) && lastKey) {
      headers[lastKey] += " " + line.trim();
    } else {
      const m = line.match(/^([^:]+):\s*(.*)/);
      if (m) {
        lastKey = m[1].toLowerCase();
        headers[lastKey] = m[2];
      }
    }
  }
  return { headers, body: bodyPart, raw };
}

// Send via SMTP
async function sendSmtp(config, email) {
  const host = config.host || "localhost";
  const port = parseInt(config.port) || 587;
  const username = config.username || "";
  const password = config.password || "";
  const from = email.headers.from || config.from || "noreply@localhost";
  const to = email.headers.to || "";

  if (!to) {
    process.stderr.write("sendmail: no recipient\n");
    process.exit(1);
  }

  // Extract email addresses from header values like "Name <email@domain>"
  const extractAddr = (s) => {
    const m = s.match(/<([^>]+)>/);
    return m ? m[1] : s.trim();
  };

  const fromAddr = extractAddr(from);
  const toAddrs = to.split(/[,;]/).map((t) => extractAddr(t.trim())).filter(Boolean);

  return new Promise((resolve, reject) => {
    let step = 0;
    const socket = net.createConnection(port, host);
    socket.setTimeout(15000);
    socket.setEncoding("utf8");

    socket.on("data", (data) => {
      const code = parseInt(data.substring(0, 3));

      if (step === 0 && code === 220) {
        socket.write(`EHLO localhost\r\n`);
        step = 1;
      } else if (step === 1 && code === 250) {
        if (username && password) {
          socket.write(`AUTH LOGIN\r\n`);
          step = 10;
        } else {
          socket.write(`MAIL FROM:<${fromAddr}>\r\n`);
          step = 3;
        }
      } else if (step === 10 && code === 334) {
        socket.write(Buffer.from(username).toString("base64") + "\r\n");
        step = 11;
      } else if (step === 11 && code === 334) {
        socket.write(Buffer.from(password).toString("base64") + "\r\n");
        step = 12;
      } else if (step === 12 && code === 235) {
        socket.write(`MAIL FROM:<${fromAddr}>\r\n`);
        step = 3;
      } else if (step === 12) {
        socket.write("QUIT\r\n");
        reject(new Error("Auth failed: " + data.trim()));
      } else if (step === 3 && code === 250) {
        // Send RCPT TO for each recipient
        step = 4;
        sendNextRcpt();
      } else if (step === 4 && code === 250) {
        sendNextRcpt();
      } else if (step === 5 && code === 250) {
        socket.write(`DATA\r\n`);
        step = 6;
      } else if (step === 6 && code === 354) {
        socket.write(email.raw + "\r\n.\r\n");
        step = 7;
      } else if (step === 7 && code === 250) {
        socket.write("QUIT\r\n");
        resolve();
      } else if (code >= 400) {
        socket.write("QUIT\r\n");
        reject(new Error("SMTP error: " + data.trim()));
      }
    });

    let rcptIdx = 0;
    function sendNextRcpt() {
      if (rcptIdx < toAddrs.length) {
        socket.write(`RCPT TO:<${toAddrs[rcptIdx]}>\r\n`);
        rcptIdx++;
      } else {
        step = 5;
        // Trigger next step with fake 250
        socket.emit("data", "250 OK\r\n");
      }
    }

    socket.on("error", (err) => reject(err));
    socket.on("timeout", () => { socket.destroy(); reject(new Error("Timeout")); });
  });
}

// Main
(async () => {
  try {
    const configPath = findConfig();
    if (!configPath) {
      process.stderr.write("sendmail: email_config.json not found\n");
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stderr.write("sendmail: empty input\n");
      process.exit(1);
    }

    const email = parseEmail(raw);
    await sendSmtp(config, email);
    process.exit(0);
  } catch (err) {
    process.stderr.write("sendmail error: " + err.message + "\n");
    process.exit(1);
  }
})();
