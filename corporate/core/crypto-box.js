// Authenticated encryption for the learning corpus: AES-256-GCM with a random
// 96-bit nonce per record. The desktop shell keeps the key in the operating
// system's keychain (Electron safeStorage); this module only sees the 32 bytes.
//
// Threat: the corpus holds months of text typed in learned applications.
// Copies of the data folder leave the desk more often than the desk does:
// backups, roaming profiles, synced folders, a support technician copying a
// profile, a lost laptop without disk encryption. Encrypted records are
// useless without the keychain of the person's own login.
"use strict";

const crypto = require("node:crypto");

const PREFIX = "v1:";

function createBox(key) {
  const secret = Buffer.isBuffer(key) ? key : Buffer.from(key || []);
  if (secret.length !== 32) throw new Error("the corpus key must be 32 bytes");

  function seal(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
    const body = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }

  /** Returns the text, or null when the record is not ours or was altered. */
  function open(sealed) {
    if (typeof sealed !== "string" || !sealed.startsWith(PREFIX)) return null;
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    if (raw.length < 28) return null;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", secret, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch (error) {
      return null;
    }
  }

  return { seal, open };
}

function generateKey() {
  return crypto.randomBytes(32);
}

module.exports = { PREFIX, createBox, generateKey };
