const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const KEY_FILE = path.join(DATA_DIR, '.key');
const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');
const ALGORITHM = 'aes-256-gcm';

// rclone's fixed XOR key, from rclone/fs/config/obscure/obscure.go
const RCLONE_CRYPT_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd0, 0xcb, 0xd5, 0x0d, 0x27, 0xa2, 0x8e, 0x78,
  0xa3, 0x03, 0x6b, 0x8e, 0x11, 0x04, 0x79, 0xd9,
  0x7e, 0x93, 0x7f, 0xae, 0xe6, 0xa1, 0x4c, 0x50,
  0x65, 0x53, 0x04, 0x62, 0xe5, 0xb7, 0x7c, 0x87,
]);

// Matches rclone's Obscure() — produces a value rclone can consume as a password field.
function obscurePassword(plaintext) {
  const plain = Buffer.from(plaintext, 'utf8');
  const buf = Buffer.alloc(plain.length + 1);
  buf[0] = crypto.randomBytes(1)[0];
  const offset = buf[0] % RCLONE_CRYPT_KEY.length;
  const key = RCLONE_CRYPT_KEY.slice(offset);
  for (let i = 0; i < plain.length; i++) {
    buf[i + 1] = plain[i] ^ key[i % key.length];
  }
  return buf.toString('base64url');
}

function getOrCreateKey() {
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
