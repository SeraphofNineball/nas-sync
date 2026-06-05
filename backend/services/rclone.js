const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { DATA_DIR } = require('./store');
const { saveCredentials, deleteCredentials, obscurePassword } = require('./credentials');

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

function addRemote(name, type, config) {
  if (!SAFE_IDENT.test(name)) throw new Error('Remote name may only contain letters, digits, hyphens and underscores');
  if (!SAFE_IDENT.test(type)) throw new Error('Remote type may only contain letters, digits, hyphens and underscores');
  ensureConf();
  saveCredentials(name, { type, ...config });
  let entry = `\n[${name}]\ntype = ${type}\n`;
  for (const [key, value] of Object.entries(config)) {
    if (!value) continue;
    if (!SAFE_IDENT.test(key)) throw new Error(`Invalid config key: ${key}`);
    if (/[\r\n]/.test(String(value))) throw new Error(`Config value for '${key}' must not contain newlines`);
    // Use pure-JS obscurePassword instead of spawning a subprocess so the
    // plaintext password is never visible in the OS process list.
    entry += key === 'pass'
      ? `pass = ${obscurePassword(value)}\n`
      : `${key} = ${value}\n`;
  }
  fs.appendFileSync(RCLONE_CONF, entry);
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

// Streams the log file line-by-line to avoid loading it entirely into memory.
// Arrays are capped at 1000 entries for report rendering; *Total fields hold
// the actual counts.
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
      if (m) { result.copiedTotal++; if (result.copied.length < 1000) result.copied.push(m[1]); return; }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Deleted\b|Skipped delete as --dry-run)/);
      if (m) { result.deletedTotal++; if (result.deleted.length < 1000) result.deleted.push(m[1]); return; }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Updated\b|Skipped update as --dry-run)/);
      if (m) { result.updatedTotal++; if (result.updated.length < 1000) result.updated.push(m[1]); return; }
      m = line.match(/ERROR\s*:\s+(.+?):\s+(.+)/);
      if (m) { result.errorsTotal++; if (result.errors.length < 1000) result.errors.push({ file: m[1], message: m[2] }); }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });

  return result;
}

function runJob(job, opts = {}) {
  const { dryRun = false } = opts;
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = dryRun ? 'sim-' : '';
  const logFile = path.join(LOGS_DIR, `${prefix}${job.id}-${timestamp}.log`);
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
  const args = [...baseArgs, '--log-level', 'INFO', '--stats', '2s', '--stats-one-line=false'];
  if (dryRun) args.push('--dry-run');

  const startTime = Date.now();
  jobProgress[job.id] = { percent: 0, transferred: '', total: '', speed: '', eta: '', startTime, simulation: dryRun };
  jobStats[job.id] = { logFile, src, dst, timestamp, startTime, simulation: dryRun };

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
  <table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
  <tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3" face="Segoe UI Variable, Segoe UI, Verdana, sans-serif">Log Report: Integrity Check</font></strong></td></tr>
  <tr><td width="22%" bgcolor="#BBDEFB"><strong><font color="#000077">Result</font></strong></td>
      <td bgcolor="#FFFFFF"><font color="${integrity.ok ? '#16a34a' : '#dc2626'}"><strong>${integrity.ok ? 'PASS — destination matches source' : 'FAIL — differences detected'}</strong></font></td></tr>
  <tr><td bgcolor="#BBDEFB"><strong>Matching files</strong></td><td bgcolor="#FFFFFF">${integrity.matching.toLocaleString()}</td></tr>
  <tr><td bgcolor="#BBDEFB"><strong>Differences</strong></td><td bgcolor="#FFFFFF">${integrity.differences.toLocaleString()}</td></tr>
  <tr><td bgcolor="#BBDEFB"><strong>Missing</strong></td><td bgcolor="#FFFFFF">${integrity.missing.toLocaleString()}</td></tr>
  <tr><td bgcolor="#BBDEFB"><strong>Errors during check</strong></td><td bgcolor="#FFFFFF">${integrity.errors.toLocaleString()}</td></tr>
  <tr><td bgcolor="#BBDEFB"><strong>Mode</strong></td><td bgcolor="#FFFFFF">--size-only${job.type === 'sync' ? ' --one-way' : ''}</td></tr>
  </table><br>` : '';

  // items is already capped at 1000; total is the real count.
  const fileList = (title, color, items, total) => {
    if (!total) return '';
    const rows = items.map(f => `<tr><td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px">${esc(f)}</td></tr>`).join('');
    const more = total > items.length ? `<tr><td bgcolor="#FFFFE0">… ${(total - items.length).toLocaleString()} more (see log file)</td></tr>` : '';
    return `<button class="collapsible">${title} (${total.toLocaleString()})</button><div class="content">
      <table width="100%" border="1" cellpadding="3" cellspacing="0" bordercolor="${color}">${rows}${more}</table></div><br>`;
  };

  const html = `<!DOCTYPE HTML>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>NAS Sync Report — ${esc(job.name)}</title>
<style>
  body { background-color: #F8F8F8; font-family: "Segoe UI Variable","Segoe UI",Verdana,sans-serif; margin: 16px; }
  #rcorners { -moz-border-radius: 10px; border-radius: 10px; border: 2px solid #DDDDDD; background-color: #EEEEEE; padding: 5px; width: 100%; }
  .topnav { overflow: hidden; background-color: #1565C0; border-radius: 10px; }
  .topnav a, .topnav div { float: left; color: #FFFFFF; padding: 10px; font-size: 15px; font-weight: bold; text-decoration: none; }
  .topnav div { color: #BBDEFB; }
  .topnav a:hover { background-color: #BBDEFB; color: black; }
  .collapsible { background-color: #1565C0; color: #FFFFFF; cursor: pointer; padding: 10px; width: 100%; border: none; text-align: left; font-size: 16px; font-weight: bold; }
  .active, .collapsible:hover { background-color: #42A5F5; }
  .collapsible:after { content: "\\002B"; color: #FFFFFF; float: right; }
  .active:after { content: "\\2212"; }
  .content { padding: 0; max-height: 0; overflow: hidden; transition: max-height 0.2s ease-out; background-color: #f1f1f1; }
  meter { width: 100%; height: 20px; }
</style></head><body>
<table id="rcorners" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td align="left" valign="middle" style="padding: 15px"><font color="#000000" size="5"><strong>NAS Sync ${isSim ? 'Simulation' : 'Report'}</strong><br><strong>${esc(job.name)}</strong></font></td>
<td align="right" valign="middle" style="padding: 15px"><font color="#555555" size="4"><small>${esc(startISO)}<br>v1.0</small></font></td>
</tr></tbody></table>
${isSim ? `<div style="margin-top:10px;padding:12px;border-radius:8px;background:#FFF3CD;border:2px solid #F0AD4E;color:#664500;font-weight:bold;font-size:14px">&#9888; DRY-RUN SIMULATION &mdash; no files were actually modified. The lists below show what <em>would</em> happen if this job ran.</div>` : ''}
<br>
<div class="topnav">
  <a href="#copied">${verb}Copied (${copiedCount.toLocaleString()})</a>
  <a href="#deleted">${verb}Deleted (${deletedCount.toLocaleString()})</a>
  <a href="#updated">${verb}Updated (${updatedCount.toLocaleString()})</a>
  <a href="#errors">Errors (${errCount.toLocaleString()})</a>
</div>
<br>

<table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
<tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3">Log Report: Overview</font></strong></td></tr>
<tr><td width="22%" bgcolor="#BBDEFB"><strong><font color="#000077">Profile Name</font></strong></td><td width="28%" bgcolor="#FFFFFF">${esc(job.name)}</td>
    <td width="22%" bgcolor="#BBDEFB"><strong><font color="#000077">Type</font></strong></td><td bgcolor="#FFFFFF">${esc(job.type)}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Result</font></strong></td>
    <td colspan="3" bgcolor="#FFFFFF"><font color="${resultColor}"><strong>${result}</strong></font>${statsBlob.error ? ' &mdash; ' + esc(statsBlob.error) : ''}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Source</font></strong></td><td colspan="3" bgcolor="#FFFFFF">${esc(statsBlob.src)}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Destination</font></strong></td><td colspan="3" bgcolor="#FFFFFF">${esc(statsBlob.dst)}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Start Time</font></strong></td><td bgcolor="#FFFFFF">${esc(startISO)}</td>
    <td bgcolor="#BBDEFB"><strong><font color="#000077">End Time</font></strong></td><td bgcolor="#FFFFFF">${esc(endISO)} (${dur})</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Trigger</font></strong></td><td colspan="3" bgcolor="#FFFFFF">Manual / Scheduled</td></tr>
</table>
<br>

<table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
<tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3">${isSim ? 'Simulation Totals' : 'Log Report: Run Totals'}</font></strong></td></tr>
<tr><td width="22%" bgcolor="#BBDEFB"><strong><font color="#000077">${verb}Copied to Destination</font></strong></td>
    <td bgcolor="#FFFFFF">${copiedCount.toLocaleString()} files</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Bytes ${isSim ? 'to Transfer' : 'Transferred'}</font></strong></td>
    <td bgcolor="#FFFFFF">${esc(fp.transferred || '0')} / ${esc(fp.total || '0')}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">${verb}Deleted from Destination</font></strong></td>
    <td bgcolor="#FFFFFF">${deletedCount.toLocaleString()} files</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">${verb}Updated</font></strong></td>
    <td bgcolor="#FFFFFF">${updatedCount.toLocaleString()} files</td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Errors</font></strong></td>
    <td bgcolor="#FFFFFF"><font color="${errCount > 0 ? '#dc2626' : '#16a34a'}">${errCount.toLocaleString()}</font></td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Average Speed</font></strong></td>
    <td bgcolor="#FFFFFF">${esc(fp.speed || '&mdash;')}</td></tr>
</table>
<br>

<table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
<tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3">Log Report: Scan &amp; Compare Totals</font></strong></td></tr>
<tr><td width="22%" bgcolor="#BBDEFB"><strong><font color="#000077">Files Scanned</font></strong></td>
    <td width="10%" bgcolor="#FFFFFF">${totalScanned.toLocaleString()}</td>
    <td width="68%" bgcolor="#FFFFFF"><meter value="${totalScanned}" min="0" max="${Math.max(totalScanned, 1)}">${totalScanned}</meter></td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Files Copied</font></strong></td>
    <td bgcolor="#FFFFFF">${copiedCount.toLocaleString()}</td>
    <td bgcolor="#FFFFFF"><meter value="${copiedCount}" min="0" max="${Math.max(totalScanned, copiedCount, 1)}">${copiedCount}</meter></td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Files Deleted</font></strong></td>
    <td bgcolor="#FFFFFF">${deletedCount.toLocaleString()}</td>
    <td bgcolor="#FFFFFF"><meter value="${deletedCount}" min="0" max="${Math.max(totalScanned, deletedCount, 1)}">${deletedCount}</meter></td></tr>
<tr><td bgcolor="#BBDEFB"><strong><font color="#000077">Files Updated</font></strong></td>
    <td bgcolor="#FFFFFF">${updatedCount.toLocaleString()}</td>
    <td bgcolor="#FFFFFF"><meter value="${updatedCount}" min="0" max="${Math.max(totalScanned, updatedCount, 1)}">${updatedCount}</meter></td></tr>
</table>
<br>

${integSection}

<a id="copied"></a>${fileList(`${verb}Copied Files`, '#C8E6C9', summary.copied, summary.copiedTotal)}
<a id="updated"></a>${fileList(`${verb}Updated Files`, '#FFE0B2', summary.updated, summary.updatedTotal)}
<a id="deleted"></a>${fileList(`${verb}Deleted Files`, '#FFCDD2', summary.deleted, summary.deletedTotal)}
<a id="errors"></a>${errCount ? `<button class="collapsible">Errors (${errCount.toLocaleString()})</button><div class="content">
  <table width="100%" border="1" cellpadding="3" cellspacing="0" bordercolor="#FFCDD2">
    ${summary.errors.map(e => `<tr><td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px">${esc(e.file)}</td><td bgcolor="#FFEBEE">${esc(e.message)}</td></tr>`).join('')}
    ${errCount > summary.errors.length ? `<tr><td colspan="2" bgcolor="#FFFFE0">&hellip; ${(errCount - summary.errors.length).toLocaleString()} more (see log file)</td></tr>` : ''}
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
  listRemotes, addRemote, deleteRemote, browseRemote,
  runJob, stopJob, stopAllJobs, getProgress, getJobStats, cleanupJobState,
  checkRemote,
  summarizeLog, runIntegrityCheck, generateReport, listReports,
  pruneOldFiles,
  LOGS_DIR, REPORTS_DIR,
};
