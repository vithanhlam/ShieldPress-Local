const crypto = require("crypto");

const VERSION = 2;
const ALGORITHM = "aes-256-gcm";
const KDF = Object.freeze({ name: "scrypt", N: 32768, r: 8, p: 1, keyLength: 32 });
const CHECK_TEXT = "shieldpress-credential-vault-v2";

function deriveKey(password, salt, params = KDF) {
  return crypto.scryptSync(String(password), salt, params.keyLength || 32, {
    N: params.N || KDF.N,
    r: params.r || KDF.r,
    p: params.p || KDF.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function seal(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `v${VERSION}:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

function open(value, key) {
  const parts = String(value || "").split(":");
  if (parts.length !== 4 || parts[0] !== `v${VERSION}`) throw new Error("Unsupported encrypted credential");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parts[1], "base64"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function createMetadata(password) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt);
  return {
    key,
    metadata: {
      version: VERSION,
      kdf: { ...KDF, salt: salt.toString("base64") },
      check: seal(CHECK_TEXT, key),
      createdAt: new Date().toISOString(),
    },
  };
}

function unlock(password, metadata) {
  if (!metadata || metadata.version !== VERSION || metadata.kdf?.name !== "scrypt") {
    throw new Error("Unsupported credential vault format");
  }
  const key = deriveKey(password, Buffer.from(metadata.kdf.salt, "base64"), metadata.kdf);
  if (open(metadata.check, key) !== CHECK_TEXT) throw new Error("Invalid Master Password");
  return key;
}

module.exports = { VERSION, createMetadata, unlock, seal, open };
