const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { DATA_DIR } = require('./store');
const { saveCredentials, deleteCredentials, getAllCredentials, obscurePassword, revealPassword } = require('./credentials');

const RCLONE_CONF = path.join(DATA_DIR, 'rclone.conf');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const runningProcesses = {};
const jobProgress = {};
const jobStats = {};

function env() {
  return { ...process.env, RCLONE_CONFIG: RCLONE_CONF };
}

function rclone(args) {
  return execFileSync('rclone', args, { env: env() }).toString().trim();
}

function ensureConf() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RCLONE_CONF)) {
    fs.writeFileSync(RCLONE_CONF, '', { mode: 0o600 });
    try { fs.chmodSync(RCLONE_CONF, 0o600); } catch { /* Windows: no-op */ }
  }
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

const SAFE_IDENT = /^[A-Za-z0-9_-]+$/;

// Builds a single rclone.conf section. Passwords are obscured with the pure-JS
// obscurePassword (rather than spawning `rclone obscure`) so the plaintext is
// never visible in the OS process list.
function buildConfigEntry(name, type, config) {
  if (!SAFE_IDENT.test(name)) throw new Error('Remote name may only contain letters, digits, hyphens and underscores');
  if (!SAFE_IDENT.test(type)) throw new Error('Remote type may only contain letters, digits, hyphens and underscores');
  let entry = `[${name}]\ntype = ${type}\n`;
  for (const [key, value] of Object.entries(config)) {
    if (!value) continue;
    if (!SAFE_IDENT.test(key)) throw new Error(`Invalid config key: ${key}`);
    if (/[\r\n]/.test(String(value))) throw new Error(`Config value for '${key}' must not contain newlines`);
    entry += key === 'pass'
      ? `pass = ${obscurePassword(value)}\n`
      : `${key} = ${value}\n`;
  }
  return entry;
}

function addRemote(name, type, config) {
  ensureConf();
  saveCredentials(name, { type, ...config });
  fs.appendFileSync(RCLONE_CONF, '\n' + buildConfigEntry(name, type, config));
}

// Splits an rclone.conf into named sections, preserving order and the raw lines
// of each section body.
function parseConfSections(text) {
  const sections = {};
  const order = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (m) {
      current = m[1];
      if (!(current in sections)) { sections[current] = []; order.push(current); }
      continue;
    }
    if (current) sections[current].push(line);
  }
  return { sections, order };
}

// Self-heals rclone.conf on startup from the encrypted credentials store (the
// source of truth, which holds plaintext passwords). Any remote whose config
// `pass` cannot be revealed back to the stored plaintext — e.g. entries written
// by the old broken obscure implementation, or after a redeploy — is rewritten
// with a correctly-obscured value. Sections not present in the credentials
// store (if any) are preserved verbatim. Returns the names that were fixed.
function reconcileConfigFromCredentials() {
  let creds;
  try { creds = getAllCredentials(); } catch { return []; }
  const names = Object.keys(creds);
  if (names.length === 0) return [];

  ensureConf();
  const text = fs.existsSync(RCLONE_CONF) ? fs.readFileSync(RCLONE_CONF, 'utf8') : '';
  const { sections, order } = parseConfSections(text);

  const needsFix = new Set();
  for (const name of names) {
    const stored = creds[name] || {};
    if (!stored.pass) continue; // nothing secret to verify
    const lines = sections[name];
    if (!lines) { needsFix.add(name); continue; } // known credential missing from conf
    const passLine = lines.find(l => /^\s*pass\s*=/.test(l));
    const current = passLine ? passLine.replace(/^\s*pass\s*=\s*/, '').trim() : '';
    let ok = false;
    try { ok = revealPassword(current) === stored.pass; } catch { ok = false; }
    if (!ok) needsFix.add(name);
  }
  if (needsFix.size === 0) return [];

  const blocks = [];
  const emitted = new Set();
  for (const name of order) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    if (needsFix.has(name)) {
      const { type, ...cfg } = creds[name];
      blocks.push(buildConfigEntry(name, type, cfg).trim());
    } else {
      blocks.push(`[${name}]\n${sections[name].join('\n')}`.trim());
    }
  }
  for (const name of needsFix) {
    if (emitted.has(name)) continue; // in creds but never in the conf file
    emitted.add(name);
    const { type, ...cfg } = creds[name];
    blocks.push(buildConfigEntry(name, type, cfg).trim());
  }

  fs.writeFileSync(RCLONE_CONF, blocks.join('\n\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(RCLONE_CONF, 0o600); } catch { /* Windows: no-op */ }
  return [...needsFix];
}

function deleteRemote(name) {
  rclone(['config', 'delete', name]);
  deleteCredentials(name);
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

// Parses an rclone --stats block emitted to stderr.
function parseStats(text) {
  const clean = text.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
  const out = {};
  for (const line of clean.split('\n')) {
    let m = line.match(/Transferred:\s+([\d.]+\s*[KMGTP]?i?B)\s*\/\s*([\d.]+\s*[KMGTP]?i?B)(?:,\s*(\d+)%)?(?:,\s*([\d.]+\s*\S+\/s))?(?:,\s*ETA\s+(\S+))?/);
    if (m) {
      out.transferred = m[1].trim();
      out.total       = m[2].trim();
      if (m[3]) out.percent = parseInt(m[3]);
      if (m[4]) out.speed   = m[4].trim();
      if (m[5]) out.eta     = m[5].trim();
      continue;
    }
    m = line.match(/Transferred:\s+([\d,]+)\s*\/\s*([\d,]+)(?:,\s*(\d+)%)?/);
    if (m) {
      out.files      = parseInt(m[1].replace(/,/g, ''));
      out.totalFiles = parseInt(m[2].replace(/,/g, ''));
      if (out.percent == null && m[3]) out.percent = parseInt(m[3]);
      continue;
    }
    m = line.match(/Errors:\s+(\d+)/);
    if (m) { out.errors = parseInt(m[1]); continue; }
    m = line.match(/Checks:\s+([\d,]+)\s*\/\s*([\d,]+)/);
    if (m) {
      out.checks      = parseInt(m[1].replace(/,/g, ''));
      out.totalChecks = parseInt(m[2].replace(/,/g, ''));
      continue;
    }
    m = line.match(/Elapsed time:\s+(\S+)/);
    if (m) out.elapsed = m[1];
  }
  return Object.keys(out).length ? out : null;
}

async function summarizeLog(logFile) {
  const result = {
    copied: [], copiedTotal: 0,
    deleted: [], deletedTotal: 0,
    updated: [], updatedTotal: 0,
    errors: [], errorsTotal: 0,
  };
  if (!fs.existsSync(logFile)) return result;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(logFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', raw => {
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
      let m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Copied\b|Skipped copy as --dry-run)/);
      if (m) { result.copiedTotal++; result.copied.push(m[1]); return; }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Deleted\b|Skipped delete as --dry-run)/);
      if (m) { result.deletedTotal++; result.deleted.push(m[1]); return; }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Updated\b|Skipped update as --dry-run)/);
      if (m) { result.updatedTotal++; result.updated.push(m[1]); return; }
      m = line.match(/ERROR\s*:\s+(.+?):\s+(.+)/);
      if (m) { result.errorsTotal++; result.errors.push({ file: m[1], message: m[2] }); }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  return result;
}

function getCommonParent(paths) {
  if (!paths || paths.length === 0) return '';
  const parts = paths.map(p => p.split('/').filter(Boolean));
  const maxDepth = Math.min(...parts.map(p => p.length)) - 1;
  const common = [];
  for (let i = 0; i < maxDepth; i++) {
    if (parts.every(p => p[i] === parts[0][i])) common.push(parts[0][i]);
    else break;
  }
  return common.join('/');
}

function runJob(job, opts = {}) {
  const { dryRun = false } = opts;
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = dryRun ? 'sim-' : '';
  const logFile = path.join(LOGS_DIR, `${prefix}${job.id}-${timestamp}.log`);
  const logStream = fs.createWriteStream(logFile);

  // Determine source: multiple selected paths vs single path
  let srcPath, filterArgs = [];
  const selectedPaths = Array.isArray(job.sourcePaths) && job.sourcePaths.length > 0 ? job.sourcePaths : null;
  if (selectedPaths && selectedPaths.length > 1) {
    const parent = getCommonParent(selectedPaths);
    srcPath = parent;
    const base = parent ? parent + '/' : '';
    for (const p of selectedPaths) {
      const rel = p.startsWith(base) ? p.slice(base.length) : p;
      filterArgs.push('--include', `/${rel}/**`);
    }
    filterArgs.push('--exclude', '/**');
  } else {
    srcPath = (selectedPaths && selectedPaths[0]) || job.sourcePath || '';
  }

  const src = `${job.sourceRemote}:${srcPath}`;
  const dst = `${job.destRemote}:${job.destPath || ''}`;

  // Display source in logs/reports — list all paths when multiple are selected
  const displaySrc = (selectedPaths && selectedPaths.length > 1)
    ? selectedPaths.map(p => `${job.sourceRemote}:${p}`).join(', ')
    : src;

  let baseArgs;
  if (job.type === 'mirror') {
    baseArgs = ['sync', src, dst];
  } else if (job.type === 'sync') {
    baseArgs = ['copy', src, dst];
  } else {
    const versionsDir = `${job.destRemote}:${job.destPath || ''}-versions/${timestamp}`;
    baseArgs = ['sync', src, dst, '--backup-dir', versionsDir];
  }
  const args = [...baseArgs, ...filterArgs, '--log-level', 'INFO', '--stats', '2s', '--stats-one-line=false'];
  if (dryRun) args.push('--dry-run');

  const startTime = Date.now();
  jobProgress[job.id] = { percent: 0, transferred: '', total: '', speed: '', eta: '', startTime, simulation: dryRun };
  jobStats[job.id] = { logFile, src: displaySrc, dst, timestamp, startTime, simulation: dryRun };

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
      const endTime = Date.now();
      jobStats[job.id].endTime = endTime;
      jobStats[job.id].finalProgress = { ...jobProgress[job.id] };
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        jobStats[job.id].result = 'stopped';
        reject(new Error('Job stopped by user'));
      } else if (code === 0) {
        if (jobProgress[job.id]) jobProgress[job.id].percent = 100;
        jobStats[job.id].result = 'success';
        resolve({ logFile, stats: jobStats[job.id] });
      } else {
        jobStats[job.id].result = 'failed';
        jobStats[job.id].exitCode = code;
        reject(new Error(`rclone exited with code ${code}`));
      }
    });
    proc.on('error', err => {
      logStream.end();
      delete runningProcesses[job.id];
      jobStats[job.id].result = 'failed';
      jobStats[job.id].error = err.message;
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

function getJobStats(jobId) {
  return jobStats[jobId] || null;
}

// Called by the scheduler after it has finished reading jobProgress/jobStats
// so those maps don't accumulate indefinitely across many scheduled runs.
function cleanupJobState(jobId) {
  delete jobProgress[jobId];
  delete jobStats[jobId];
}

// Collects stderr/stdout into capped Buffer arrays to avoid unbounded string
// concatenation and potential OOM for very large rclone check output.
function runIntegrityCheck(job) {
  const src = `${job.sourceRemote}:${job.sourcePath || ''}`;
  const dst = `${job.destRemote}:${job.destPath || ''}`;
  const args = ['check', src, dst, '--size-only'];
  if (job.type === 'sync') args.push('--one-way');

  return new Promise(resolve => {
    const chunks = [];
    let totalLen = 0;
    const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap — ample for any realistic check output

    const collect = (d) => {
      if (totalLen < MAX_BYTES) { chunks.push(d); totalLen += d.length; }
    };

    const proc = spawn('rclone', args, { env: env() });
    proc.stderr.on('data', collect);
    proc.stdout.on('data', collect);
    proc.on('close', code => {
      const clean = Buffer.concat(chunks).toString('utf8').replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
      const num = (re) => { const m = clean.match(re); return m ? parseInt(m[1].replace(/,/g, '')) : 0; };
      resolve({
        ok: code === 0,
        matching:    num(/(\d[\d,]*)\s+matching files/i),
        differences: num(/(\d[\d,]*)\s+differences found/i),
        missing:     num(/(\d[\d,]*)\s+files? missing/i) + num(/(\d[\d,]*)\s+missing on/i),
        errors:      num(/(\d[\d,]*)\s+errors? while checking/i),
        exitCode: code,
      });
    });
    proc.on('error', err => {
      resolve({ ok: false, error: err.message, exitCode: -1 });
    });
  });
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Async so fs.promises.writeFile doesn't block the event loop for large reports.
// summary shape: { copied[], copiedTotal, deleted[], deletedTotal,
//                  updated[], updatedTotal, errors[], errorsTotal }
async function generateReport(job, logFile, summary, integrity, statsBlob) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date(statsBlob.startTime).toISOString().replace(/[:.]/g, '-');
  const isSim = !!statsBlob.simulation;
  const prefix = isSim ? 'sim-' : '';
  const reportFile = path.join(REPORTS_DIR, `${prefix}${job.id}-${ts}.html`);
  const verb = isSim ? 'Would ' : '';

  const fp = statsBlob.finalProgress || {};
  const startISO = new Date(statsBlob.startTime).toLocaleString();
  const endISO   = new Date(statsBlob.endTime || Date.now()).toLocaleString();
  const dur      = fmtDuration((statsBlob.endTime || Date.now()) - statsBlob.startTime);
  const result   = statsBlob.result === 'success' ? 'Success'
                 : statsBlob.result === 'stopped' ? 'Stopped'
                 : 'Failed';
  const resultColor = statsBlob.result === 'success' ? '#16a34a'
                    : statsBlob.result === 'stopped' ? '#d97706' : '#dc2626';
  const totalScanned = fp.totalFiles || 0;
  const copiedCount  = summary.copiedTotal;
  const deletedCount = summary.deletedTotal;
  const updatedCount = summary.updatedTotal;
  const errCount     = summary.errorsTotal;

  const integSection = integrity ? `
  <table class="rpt-t" cellpadding="5">
  <tr class="rpt-hdr"><td colspan="4">Log Report: Integrity Check</td></tr>
  <tr><td class="rpt-lbl"><strong>Result</strong></td>
      <td class="rpt-val"><strong style="color:${integrity.ok ? '#16a34a' : '#dc2626'}">${integrity.ok ? 'PASS — destination matches source' : 'FAIL — differences detected'}</strong></td></tr>
  <tr><td class="rpt-lbl"><strong>Matching files</strong></td><td class="rpt-val">${integrity.matching.toLocaleString()}</td></tr>
  <tr><td class="rpt-lbl"><strong>Differences</strong></td><td class="rpt-val">${integrity.differences.toLocaleString()}</td></tr>
  <tr><td class="rpt-lbl"><strong>Missing</strong></td><td class="rpt-val">${integrity.missing.toLocaleString()}</td></tr>
  <tr><td class="rpt-lbl"><strong>Errors during check</strong></td><td class="rpt-val">${integrity.errors.toLocaleString()}</td></tr>
  <tr><td class="rpt-lbl"><strong>Mode</strong></td><td class="rpt-val">--size-only${job.type === 'sync' ? ' --one-way' : ''}</td></tr>
  </table><br>` : '';

  const fileList = (title, items, total) => {
    if (!total) return '';
    const rows = items.map(f => `<tr><td class="rpt-file">${esc(f)}</td></tr>`).join('');
    return `<button class="collapsible">${title} (${total.toLocaleString()})</button><div class="content">
      <table class="rpt-t" cellpadding="3">${rows}</table></div><br>`;
  };

  const html = `<!DOCTYPE HTML>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>NAS Sync Report — ${esc(job.name)}</title>
<script>(function(){var t=localStorage.getItem('nas-sync-theme')||'dark';document.documentElement.setAttribute('data-theme',t);})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet">
<style>
:root{--rpt-bg:#0d0d1a;--rpt-text:#e0e0f0;--rpt-rc-bg:#161625;--rpt-rc-bd:#2a2a45;--rpt-hdr-bg:#1a3a6e;--rpt-hdr-tx:#c8deff;--rpt-lbl-bg:#1e1e32;--rpt-lbl-tx:#7aaaff;--rpt-val-bg:#161625;--rpt-border:#2a2a45;--rpt-nav-bg:#1a3a6e;--rpt-nav-tx:#fff;--rpt-nav-sub:#7aaaff;--rpt-btn-hov:#2a5ab0;--rpt-cnt-bg:#0d0d1a;--rpt-file-bg:#1e1e32;--rpt-err-bg:#2e0d0d;--rpt-warn-bg:#3a2800;--rpt-warn-bd:#f0a030;--rpt-warn-tx:#f0d080}
[data-theme="light"]{--rpt-bg:#f0f2f5;--rpt-text:#111827;--rpt-rc-bg:#eeeeee;--rpt-rc-bd:#dddddd;--rpt-hdr-bg:#1565C0;--rpt-hdr-tx:#fff;--rpt-lbl-bg:#BBDEFB;--rpt-lbl-tx:#000077;--rpt-val-bg:#fff;--rpt-border:#E3F2FD;--rpt-nav-bg:#1565C0;--rpt-nav-tx:#fff;--rpt-nav-sub:#BBDEFB;--rpt-btn-hov:#42A5F5;--rpt-cnt-bg:#f1f1f1;--rpt-file-bg:#fff;--rpt-err-bg:#FFEBEE;--rpt-warn-bg:#FFF3CD;--rpt-warn-bd:#F0AD4E;--rpt-warn-tx:#664500}
[data-theme="high-contrast"]{--rpt-bg:#000;--rpt-text:#fff;--rpt-rc-bg:#0a0a0a;--rpt-rc-bd:#fff;--rpt-hdr-bg:#000;--rpt-hdr-tx:#ffff00;--rpt-lbl-bg:#111;--rpt-lbl-tx:#ffff00;--rpt-val-bg:#000;--rpt-border:#fff;--rpt-nav-bg:#111;--rpt-nav-tx:#ffff00;--rpt-nav-sub:#aaa;--rpt-btn-hov:#333;--rpt-cnt-bg:#000;--rpt-file-bg:#0a0a0a;--rpt-err-bg:#330000;--rpt-warn-bg:#332200;--rpt-warn-bd:#ffaa00;--rpt-warn-tx:#ffdd88}
[data-theme="vscode"]{--rpt-bg:#1e1e1e;--rpt-text:#d4d4d4;--rpt-rc-bg:#252526;--rpt-rc-bd:#3c3c3c;--rpt-hdr-bg:#0e2d4a;--rpt-hdr-tx:#d4d4d4;--rpt-lbl-bg:#2d2d30;--rpt-lbl-tx:#0098f0;--rpt-val-bg:#252526;--rpt-border:#3c3c3c;--rpt-nav-bg:#007acc;--rpt-nav-tx:#fff;--rpt-nav-sub:#cce8ff;--rpt-btn-hov:#0098f0;--rpt-cnt-bg:#1e1e1e;--rpt-file-bg:#2d2d30;--rpt-err-bg:#2e0d0d;--rpt-warn-bg:#2a2200;--rpt-warn-bd:#dcdcaa;--rpt-warn-tx:#dcdcaa}
[data-theme="monokai"]{--rpt-bg:#272822;--rpt-text:#f8f8f2;--rpt-rc-bg:#2d2e27;--rpt-rc-bd:#49483e;--rpt-hdr-bg:#1a3035;--rpt-hdr-tx:#66d9e8;--rpt-lbl-bg:#3e3d32;--rpt-lbl-tx:#a6e22e;--rpt-val-bg:#2d2e27;--rpt-border:#49483e;--rpt-nav-bg:#1a3035;--rpt-nav-tx:#f8f8f2;--rpt-nav-sub:#66d9e8;--rpt-btn-hov:#2a4a55;--rpt-cnt-bg:#272822;--rpt-file-bg:#3e3d32;--rpt-err-bg:#3a0d1e;--rpt-warn-bg:#2a2000;--rpt-warn-bd:#e6db74;--rpt-warn-tx:#e6db74}
[data-theme="solarized"]{--rpt-bg:#002b36;--rpt-text:#839496;--rpt-rc-bg:#073642;--rpt-rc-bd:#586e75;--rpt-hdr-bg:#073642;--rpt-hdr-tx:#eee8d5;--rpt-lbl-bg:#0a4555;--rpt-lbl-tx:#268bd2;--rpt-val-bg:#073642;--rpt-border:#586e75;--rpt-nav-bg:#268bd2;--rpt-nav-tx:#fdf6e3;--rpt-nav-sub:#93a1a1;--rpt-btn-hov:#2aa8f2;--rpt-cnt-bg:#002b36;--rpt-file-bg:#0a4555;--rpt-err-bg:#2a0a0a;--rpt-warn-bg:#1a1500;--rpt-warn-bd:#b58900;--rpt-warn-tx:#b58900}
*,*::before,*::after{box-sizing:border-box}
body{font-family:'JetBrains Mono',monospace;background:var(--rpt-bg);color:var(--rpt-text);margin:16px;font-size:14px;line-height:1.5}
#rcorners{border-radius:10px;border:2px solid var(--rpt-rc-bd);background:var(--rpt-rc-bg);padding:5px;width:100%;border-spacing:0}
.topnav{overflow:hidden;background:var(--rpt-nav-bg);border-radius:10px}
.topnav a,.topnav span{float:left;color:var(--rpt-nav-tx);padding:10px;font-size:15px;font-weight:bold;text-decoration:none}
.topnav span{color:var(--rpt-nav-sub)}
.topnav a:hover{background:var(--rpt-btn-hov)}
.collapsible{background:var(--rpt-nav-bg);color:var(--rpt-nav-tx);cursor:pointer;padding:10px;width:100%;border:none;text-align:left;font-size:16px;font-weight:bold;font-family:'JetBrains Mono',monospace}
.active,.collapsible:hover{background:var(--rpt-btn-hov)}
.collapsible:after{content:"\\002B";color:var(--rpt-nav-tx);float:right}
.active:after{content:"\\2212"}
.content{padding:0;max-height:0;overflow:hidden;transition:max-height 0.2s ease-out;background:var(--rpt-cnt-bg)}
.rpt-warn{margin-top:10px;padding:12px;border-radius:8px;background:var(--rpt-warn-bg);border:2px solid var(--rpt-warn-bd);color:var(--rpt-warn-tx);font-weight:bold;font-size:14px}
meter{width:100%;height:20px}
table.rpt-t{border-collapse:collapse;width:100%}
table.rpt-t td,table.rpt-t th{border:1px solid var(--rpt-border);padding:5px}
tr.rpt-hdr td{background:var(--rpt-hdr-bg);color:var(--rpt-hdr-tx);font-size:14px;font-weight:bold}
td.rpt-lbl{background:var(--rpt-lbl-bg);color:var(--rpt-lbl-tx);width:22%;font-weight:bold}
td.rpt-val{background:var(--rpt-val-bg);color:var(--rpt-text)}
td.rpt-file{background:var(--rpt-file-bg);color:var(--rpt-text);font-family:'JetBrains Mono',monospace;font-size:12px}
td.rpt-errmsg{background:var(--rpt-err-bg);color:var(--rpt-text)}
.rpt-sub{color:var(--rpt-lbl-tx)}
</style></head><body>
<table id="rcorners" cellspacing="0" cellpadding="0"><tbody><tr>
<td align="left" valign="middle" style="padding:15px"><strong style="font-size:20px">NAS Sync ${isSim ? 'Simulation' : 'Report'}</strong><br><strong style="font-size:18px">${esc(job.name)}</strong></td>
<td align="right" valign="middle" style="padding:15px"><span class="rpt-sub">${esc(startISO)}<br>v1.0</span></td>
</tr></tbody></table>
${isSim ? `<div class="rpt-warn">&#9888; DRY-RUN SIMULATION &mdash; no files were actually modified. The lists below show what <em>would</em> happen if this job ran.</div>` : ''}
<br>
<div class="topnav">
  <a href="#copied">${verb}Copied (${copiedCount.toLocaleString()})</a>
  <a href="#deleted">${verb}Deleted (${deletedCount.toLocaleString()})</a>
  <a href="#updated">${verb}Updated (${updatedCount.toLocaleString()})</a>
  <a href="#errors">Errors (${errCount.toLocaleString()})</a>
</div>
<br>

<table class="rpt-t" cellpadding="5">
<tr class="rpt-hdr"><td colspan="4">Log Report: Overview</td></tr>
<tr><td class="rpt-lbl">Profile Name</td><td class="rpt-val">${esc(job.name)}</td>
    <td class="rpt-lbl">Type</td><td class="rpt-val">${esc(job.type)}</td></tr>
<tr><td class="rpt-lbl">Result</td>
    <td colspan="3" class="rpt-val"><strong style="color:${resultColor}">${result}</strong>${statsBlob.error ? ' &mdash; ' + esc(statsBlob.error) : ''}</td></tr>
<tr><td class="rpt-lbl">Source</td><td colspan="3" class="rpt-val">${esc(statsBlob.src)}</td></tr>
<tr><td class="rpt-lbl">Destination</td><td colspan="3" class="rpt-val">${esc(statsBlob.dst)}</td></tr>
<tr><td class="rpt-lbl">Start Time</td><td class="rpt-val">${esc(startISO)}</td>
    <td class="rpt-lbl">End Time</td><td class="rpt-val">${esc(endISO)} (${dur})</td></tr>
<tr><td class="rpt-lbl">Trigger</td><td colspan="3" class="rpt-val">Manual / Scheduled</td></tr>
</table>
<br>

<table class="rpt-t" cellpadding="5">
<tr class="rpt-hdr"><td colspan="4">${isSim ? 'Simulation Totals' : 'Log Report: Run Totals'}</td></tr>
<tr><td class="rpt-lbl">${verb}Copied to Destination</td>
    <td class="rpt-val">${copiedCount.toLocaleString()} files</td></tr>
<tr><td class="rpt-lbl">Bytes ${isSim ? 'to Transfer' : 'Transferred'}</td>
    <td class="rpt-val">${esc(fp.transferred || '0')} / ${esc(fp.total || '0')}</td></tr>
<tr><td class="rpt-lbl">${verb}Deleted from Destination</td>
    <td class="rpt-val">${deletedCount.toLocaleString()} files</td></tr>
<tr><td class="rpt-lbl">${verb}Updated</td>
    <td class="rpt-val">${updatedCount.toLocaleString()} files</td></tr>
<tr><td class="rpt-lbl">Errors</td>
    <td class="rpt-val"><span style="color:${errCount > 0 ? '#dc2626' : '#16a34a'}">${errCount.toLocaleString()}</span></td></tr>
<tr><td class="rpt-lbl">Average Speed</td>
    <td class="rpt-val">${esc(fp.speed || '&mdash;')}</td></tr>
</table>
<br>

<table class="rpt-t" cellpadding="5">
<tr class="rpt-hdr"><td colspan="4">Log Report: Scan &amp; Compare Totals</td></tr>
<tr><td class="rpt-lbl">Files Scanned</td>
    <td class="rpt-val" style="width:10%">${totalScanned.toLocaleString()}</td>
    <td class="rpt-val" style="width:68%"><meter value="${totalScanned}" min="0" max="${Math.max(totalScanned, 1)}">${totalScanned}</meter></td></tr>
<tr><td class="rpt-lbl">Files Copied</td>
    <td class="rpt-val">${copiedCount.toLocaleString()}</td>
    <td class="rpt-val"><meter value="${copiedCount}" min="0" max="${Math.max(totalScanned, copiedCount, 1)}">${copiedCount}</meter></td></tr>
<tr><td class="rpt-lbl">Files Deleted</td>
    <td class="rpt-val">${deletedCount.toLocaleString()}</td>
    <td class="rpt-val"><meter value="${deletedCount}" min="0" max="${Math.max(totalScanned, deletedCount, 1)}">${deletedCount}</meter></td></tr>
<tr><td class="rpt-lbl">Files Updated</td>
    <td class="rpt-val">${updatedCount.toLocaleString()}</td>
    <td class="rpt-val"><meter value="${updatedCount}" min="0" max="${Math.max(totalScanned, updatedCount, 1)}">${updatedCount}</meter></td></tr>
</table>
<br>

${integSection}

<a id="copied"></a>${fileList(`${verb}Copied Files`, summary.copied, summary.copiedTotal)}
<a id="updated"></a>${fileList(`${verb}Updated Files`, summary.updated, summary.updatedTotal)}
<a id="deleted"></a>${fileList(`${verb}Deleted Files`, summary.deleted, summary.deletedTotal)}
<a id="errors"></a>${errCount ? `<button class="collapsible">Errors (${errCount.toLocaleString()})</button><div class="content">
  <table class="rpt-t" cellpadding="3">
    ${summary.errors.map(e => `<tr><td class="rpt-file">${esc(e.file)}</td><td class="rpt-errmsg">${esc(e.message)}</td></tr>`).join('')}
  </table></div><br>` : ''}

<script>
  document.querySelectorAll('.collapsible').forEach(btn => {
    btn.addEventListener('click', function () {
      this.classList.toggle('active');
      const c = this.nextElementSibling;
      c.style.maxHeight = c.style.maxHeight ? null : c.scrollHeight + 'px';
    });
  });
</script>
</body></html>`;

  await fs.promises.writeFile(reportFile, html);
  return reportFile;
}

function listReports(jobId) {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs.readdirSync(REPORTS_DIR)
    .filter(f => (
      f.startsWith(`${jobId}-`) ||
      f.startsWith(`sim-${jobId}-`) ||
      f.startsWith(`hash-${jobId}-`)
    ) && f.endsWith('.html'))
    .sort().reverse();
}

// Deletes log and report files beyond the most recent keepN for a given job,
// keeping disk usage bounded for long-running scheduled jobs.
function pruneOldFiles(jobId, keepN = 20) {
  for (const dir of [LOGS_DIR, REPORTS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const prefix of [`${jobId}-`, `sim-${jobId}-`]) {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix))
        .sort().reverse();
      files.slice(keepN).forEach(f => {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      });
    }
  }
}

module.exports = {
  listRemotes, addRemote, deleteRemote, browseRemote, reconcileConfigFromCredentials,
  runJob, stopJob, stopAllJobs, getProgress, getJobStats, cleanupJobState,
  checkRemote,
  summarizeLog, runIntegrityCheck, generateReport, listReports,
  pruneOldFiles,
  LOGS_DIR, REPORTS_DIR,
};
