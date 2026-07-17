const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const KEY_FILE = path.join(DATA_DIR, '.key');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');
const ALGORITHM = 'aes-256-gcm';

// rclone's fixed AES-256 key, from rclone/fs/config/obscure/obscure.go (32 bytes).
const RCLONE_CRYPT_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd0, 0xcb, 0xd5, 0x0d, 0x27, 0xa2, 0x8e, 0x78,
  0xa3, 0x03, 0x6b, 0x8e, 0x11, 0x04, 0x79, 0xd9,
]);

// Matches rclone's Obscure() so rclone can Reveal() the value from a config
// `pass` field: AES-256-CTR with a random 16-byte IV prepended, then base64url
// (raw/unpadded). rclone reads the IV from the first 16 bytes, so the output
// MUST be iv || ciphertext — otherwise rclone rejects it with
// "input too short when revealing password - is it obscured?".
function obscurePassword(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-ctr', RCLONE_CRYPT_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, ciphertext]).toString('base64url');
}

function getOrCreateKey() {
  // Prefer an externally-injected key (e.g. Docker secret / env var) so the
  // key is never co-located with the encrypted data on the same volume.
  // Set CREDENTIALS_KEY to a 64-character hex string (32 bytes).
  if (process.env.CREDENTIALS_KEY) {
    const key = Buffer.from(process.env.CREDENTIALS_KEY, 'hex');
    if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 64 hex characters (32 bytes)');
    return key;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows: no-op */ }
  return key;
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('hex'),
  };
}

function decrypt(stored, key) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(stored.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(stored.data, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function readStore() {
  if (!fs.existsSync(CREDS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(store), { mode: 0o600 });
  try { fs.chmodSync(CREDS_FILE, 0o600); } catch { /* Windows: no-op */ }
}

function saveCredentials(name, config) {
  const key = getOrCreateKey();
  const store = readStore();
  store[name] = encrypt(JSON.stringify(config), key);
  writeStore(store);
}

function getCredentials(name) {
  const key = getOrCreateKey();
  const store = readStore();
  if (!store[name]) return {};
  try { return JSON.parse(decrypt(store[name], key)); }
  catch { return {}; }
}

function deleteCredentials(name) {
  const store = readStore();
  delete store[name];
  writeStore(store);
}

function getAllCredentials() {
  const key = getOrCreateKey();
  const store = readStore();
  const result = {};
  for (const [name, enc] of Object.entries(store)) {
    try { result[name] = JSON.parse(decrypt(enc, key)); }
    catch { result[name] = {}; }
  }
  return result;
}

module.exports = { saveCredentials, getCredentials, deleteCredentials, getAllCredentials, obscurePassword };
