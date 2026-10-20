// The key that encrypts the learning corpus, kept in the operating system's
// keychain through Electron's safeStorage (passed in as `keychain`, so tests
// can use a stand-in). The key file in the data folder holds only the
// keychain-encrypted form.
"use strict";

const { generateKey } = require("../core/crypto-box.js");

const UNAVAILABLE = "Learning is paused: this system offers no secure keychain to protect learned text, so none is written. Shortcuts, keyword offers and statistics work as usual.";

function loadCorpusKey(options) {
  const { store, keychain } = options || {};
  if (!keychain || typeof keychain.isEncryptionAvailable !== "function" || !keychain.isEncryptionAvailable()) {
    return { key: null, status: "unavailable", message: UNAVAILABLE };
  }
  // On Linux without a secret service, Electron falls back to a fixed,
  // publicly known password ("basic_text"): that is not protection.
  const backend = typeof keychain.getSelectedStorageBackend === "function" ? keychain.getSelectedStorageBackend() : null;
  if (backend === "basic_text" || backend === "unknown") {
    return { key: null, status: "unavailable", message: UNAVAILABLE + " (Install and unlock GNOME Keyring or KWallet to enable learning.)" };
  }
  let status = "created";
  let aside = null;
  const blob = store.loadCorpusKeyBlob();
  if (blob) {
    let key = null;
    try {
      key = Buffer.from(keychain.decryptString(blob), "base64");
    } catch (error) {
      key = null;
    }
    if (key && key.length === 32) return { key, status: "ok" };
    // Without a box every sealed record reads as locked. Remembered template
    // answers count too: the key is never replaced while anything it protects exists.
    const sealed = store.corpusInfo().locked;
    const sealedThreads = typeof store.threadsInfo === "function" ? store.threadsInfo().locked : 0;
    if (sealed > 0 || sealedThreads > 0) {
      return {
        key: null,
        status: "unreadable",
        message: "Learning is paused: the keychain could not unlock the key that protects learned text. The " + sealed
          + " encrypted session(s)" + (sealedThreads ? " and " + sealedThreads + " remembered conversation(s)" : "")
          + " are kept untouched; they become usable again if the keychain is restored. Delete learned text on the Learning tab to start afresh.",
      };
    }
    aside = store.moveCorpusKeyAside();
    status = "replaced";
  }
  const key = generateKey();
  store.saveCorpusKeyBlob(keychain.encryptString(key.toString("base64")));
  return { key, status, aside };
}

module.exports = { loadCorpusKey, UNAVAILABLE };
