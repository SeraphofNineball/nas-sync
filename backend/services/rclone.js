const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const RCLONE_CONF = path.join(DATA_DIR, 'rclone.conf');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

const runningProcesses = {};
const jobProgress = {};

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

function checkRemote(name) {
  return new Promise(resolve => {
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      resolve({ name, status });
    };
    const timer = setTimeout(() => { proc.kill(); done('offline'); }, 10000);
    const proc = spawn('rclone', ['lsf', `${name}:`, '--max-depth', '1'], { env: env() });
    proc.on('close', code => { clearTimeout(timer); done(code === 0 ? 'online' : 'offline'); });
    proc.on('error', () => { clearTimeout(timer); done('offline'); });
  });
}

function parseStats(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
  // Match file-count line: "Transferred: N / M, P%, SPEED, ETA X"
  const m = clean.match(/Transferred:\s+[\d,]+\s*\/\s*[\d,]+,\s*(\d+)%,\s*([\d.]+\s*\S+\/s),\s*ETA\s+(\S+)/);
  if (!m) return null;
  const percent = parseInt(m[1]);
  const speed = m[2].trim();
  const eta = m[3].trim();
  // Match data-size line: "Transferred: X.XX GiB / Y.YY GiB"
  const dm = clean.match(/Transferred:\s+([\d.]+\s+[A-Za-z]+)\s*\/\s*([\d.]+\s+[A-Za-z]+)/);
  return {
    percent,
    speed,
    eta,
    transferred: dm ? dm[1].trim() : '',
    total: dm ? dm[2].trim() : '',
  };
}

function runJob(job) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOGS_DIR, `${job.id}-${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile);

  const src = `${job.sourceRemote}:${job.sourcePath || ''}`;
  const dst = `${job.destRemote}:${job.destPath || ''}`;

  let baseArgs;
  if (job.type === 'mirror') {
    baseArgs = ['sync', src, dst];
  } else if (job.type === 'sync') {
    baseArgs = ['copy', src, dst];
  } else {
    const versionsDir = `${job.destRemote}:${job.destPath || ''}-versions/${timestamp}`;
    baseArgs = ['sync', src, dst, '--backup-dir', versionsDir];
  }
  // No --log-file: we capture output ourselves so we can also parse stats
  const args = [...baseArgs, '--log-level', 'INFO', '--stats', '2s'];

  const startTime = Date.now();
  jobProgress[job.id] = { percent: 0, transferred: '', total: '', speed: '', eta: '', startTime };

  return new Promise((resolve, reject) => {
    const proc = spawn('rclone', args, { env: env() });
    runningProcesses[job.id] = proc;

    proc.stderr.on('data', data => {
      const text = data.toString();
      logStream.write(text);
      const stats = parseStats(text);
      if (stats) jobProgress[job.id] = { ...jobProgress[job.id], ...stats };
    });
    proc.stdout.on('data', data => logStream.write(data));

    proc.on('close', (code, signal) => {
      logStream.end();
      delete runningProcesses[job.id];
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('Job stopped by user'));
      } else if (code === 0) {
        if (jobProgress[job.id]) jobProgress[job.id].percent = 100;
        resolve(logFile);
      } else {
        reject(new Error(`rclone exited with code ${code}`));
      }
    });
    proc.on('error', err => {
      logStream.end();
      delete runningProcesses[job.id];
      reject(err);
    });
  });
}

function stopJob(jobId) {
  const proc = runningProcesses[jobId];
  if (proc) { proc.kill('SIGTERM'); return true; }
  return false;
}

function stopAllJobs() {
  Object.keys(runningProcesses).forEach(stopJob);
}

function getProgress(jobId) {
  return jobProgress[jobId] || null;
}

module.exports = { listRemotes, addRemote, deleteRemote, browseRemote, runJob, stopJob, stopAllJobs, getProgress, checkRemote, LOGS_DIR };
