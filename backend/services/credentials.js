const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const KEY_FILE = path.join(DATA_DIR, '.key');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');
const ALGORITHM = 'aes-256-gcm';

// rclone's fixed AES-256 key, verbatim from rclone/fs/config/obscure/obscure.go
// (32 bytes). Must match exactly — rclone reveals config `pass` fields with this
// key, so any deviation makes it decode passwords to garbage and every SMB/etc.
// login fails with "logon invalid". Verified against `rclone obscure` output.
const RCLONE_CRYPT_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
  0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
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

// Inverse of obscurePassword, matching rclone's Reveal(). Throws on a value that
// isn't a valid obscured password (e.g. shorter than the 16-byte IV). Used to
// detect config entries written by the old, broken obscure implementation.
function revealPassword(obscured) {
  const buf = Buffer.from(obscured, 'base64url');
  if (buf.length < 16) throw new Error('input too short when revealing password');
  const iv = buf.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-ctr', RCLONE_CRYPT_KEY, iv);
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
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

module.exports = { saveCredentials, getCredentials, deleteCredentials, getAllCredentials, obscurePassword, revealPassword };
