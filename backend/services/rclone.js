const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const RCLONE_CONF = path.join(DATA_DIR, 'rclone.conf');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

function env() {
  return { ...process.env, RCLONE_CONFIG: RCLONE_CONF };
}

function rclone(args) {
  return execFileSync('rclone', args, { env: env() }).toString().trim();
}

function ensureConf() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RCLONE_CONF)) fs.writeFileSync(RCLONE_CONF, '');
}

function listRemotes() {
  ensureConf();
  try {
    const out = rclone(['listremotes']);
    return out ? out.split('\n').filter(Boolean).map(r => r.replace(/:$/, '')) : [];
  } catch {
    return [];
  }
}

function addRemote(name, type, config) {
  ensureConf();
  let entry = `\n[${name}]\ntype = ${type}\n`;
  for (const [key, value] of Object.entries(config)) {
    if (!value) continue;
    if (key === 'pass') {
      const obscured = execFileSync('rclone', ['obscure', value], { env: env() }).toString().trim();
      entry += `pass = ${obscured}\n`;
    } else {
      entry += `${key} = ${value}\n`;
    }
  }
  fs.appendFileSync(RCLONE_CONF, entry);
}

function deleteRemote(name) {
  rclone(['config', 'delete', name]);
}

function browseRemote(name, remotePath = '') {
  const target = remotePath ? `${name}:${remotePath}` : `${name}:`;
  try {
    return JSON.parse(rclone(['lsjson', target]));
  } catch {
    return [];
  }
}

function runJob(job) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOGS_DIR, `${job.id}-${timestamp}.log`);

  const src = `${job.sourceRemote}:${job.sourcePath || ''}`;
  const dst = `${job.destRemote}:${job.destPath || ''}`;

  let args;
  if (job.type === 'mirror') {
    args = ['sync', src, dst, '--log-file', logFile, '--log-level', 'INFO'];
  } else if (job.type === 'sync') {
    args = ['copy', src, dst, '--log-file', logFile, '--log-level', 'INFO'];
  } else {
    const versionsDir = `${job.destRemote}:${job.destPath || ''}-versions/${timestamp}`;
    args = ['sync', src, dst, '--backup-dir', versionsDir, '--log-file', logFile, '--log-level', 'INFO'];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('rclone', args, { env: env() });
    proc.on('close', code => code === 0 ? resolve(logFile) : reject(new Error(`rclone exited with code ${code}`)));
  });
}

module.exports = { listRemotes, addRemote, deleteRemote, browseRemote, runJob, LOGS_DIR };
