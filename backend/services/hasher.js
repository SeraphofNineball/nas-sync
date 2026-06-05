const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const RCLONE_CONF = path.join(DATA_DIR, 'rclone.conf');
const HASHDB_DIR = path.join(DATA_DIR, 'hashdb');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

const hashRunningProcesses = {};

function env() {
  return { ...process.env, RCLONE_CONFIG: RCLONE_CONF };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

function captureRemoteHashes(jobId, remote, remotePath) {
  const target = remotePath ? `${remote}:${remotePath}` : `${remote}:`;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const errChunks = [];
    const proc = spawn('rclone', ['hashsum', 'SHA-256', target, '--download'], { env: env() });
    hashRunningProcesses[jobId] = proc;

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => errChunks.push(d));

    proc.on('close', (code, signal) => {
      delete hashRunningProcesses[jobId];
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        return reject(new Error('Job stopped by user'));
      }
      if (code !== 0 && chunks.length === 0) {
        const errMsg = Buffer.concat(errChunks).toString().trim();
        return reject(new Error(`rclone hashsum failed (exit ${code}): ${errMsg}`));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const files = {};
      for (const line of text.split('\n')) {
        const trimmed = line.trimEnd();
        if (!trimmed) continue;
        // rclone hashsum output: "hash  relative/path"  (two spaces)
        const spaceIdx = trimmed.indexOf('  ');
        if (spaceIdx === -1) continue;
        const hash = trimmed.slice(0, spaceIdx).trim();
        const relPath = trimmed.slice(spaceIdx + 2);
        if (hash && relPath) files[relPath] = hash;
      }
      resolve(files);
    });

    proc.on('error', err => {
      delete hashRunningProcesses[jobId];
      reject(err);
    });
  });
}

function cancelHashCapture(jobId) {
  const proc = hashRunningProcesses[jobId];
  if (proc) { proc.kill('SIGTERM'); return true; }
  return false;
}

function getLatestSnapshot(jobId) {
  if (!fs.existsSync(HASHDB_DIR)) return null;
  const files = fs.readdirSync(HASHDB_DIR)
    .filter(f => f.startsWith(`${jobId}-`) && f.endsWith('.json'))
    .sort().reverse();
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(HASHDB_DIR, files[0]), 'utf8'));
  } catch {
    return null;
  }
}

function saveSnapshot(jobId, snapshot) {
  fs.mkdirSync(HASHDB_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(HASHDB_DIR, `${jobId}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return file;
}

function diffSnapshots(baseline, current) {
  const added = [];
  const deleted = [];
  const modified = [];
  const unchanged = [];
  const allPaths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const p of allPaths) {
    if (!baseline[p]) {
      added.push(p);
    } else if (!current[p]) {
      deleted.push(p);
    } else if (baseline[p] !== current[p]) {
      modified.push({ path: p, oldHash: baseline[p], newHash: current[p] });
    } else {
      unchanged.push(p);
    }
  }
  return { added, deleted, modified, unchanged };
}

async function generateHashReport(job, snapshot, diff, isFirstRun, startTime, endTime) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date(startTime).toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(REPORTS_DIR, `hash-${job.id}-${ts}.html`);

  const dur = fmtDuration(endTime - startTime);
  const startISO = new Date(startTime).toLocaleString();
  const endISO = new Date(endTime).toLocaleString();
  const totalFiles = Object.keys(snapshot.files).length;
  const hasChanges = !isFirstRun && (diff.added.length + diff.deleted.length + diff.modified.length) > 0;

  const alertBanner = isFirstRun
    ? `<div style="margin-top:10px;padding:12px;border-radius:8px;background:#E3F2FD;border:2px solid #1565C0;color:#0D47A1;font-weight:bold;font-size:14px">&#9432; INITIAL BASELINE &mdash; First hash capture complete. ${totalFiles.toLocaleString()} files recorded. Future runs will compare against this snapshot.</div>`
    : hasChanges
      ? `<div style="margin-top:10px;padding:12px;border-radius:8px;background:#FFEBEE;border:2px solid #C62828;color:#B71C1C;font-weight:bold;font-size:14px">&#9888; CHANGES DETECTED &mdash; ${diff.modified.length.toLocaleString()} modified &bull; ${diff.added.length.toLocaleString()} added &bull; ${diff.deleted.length.toLocaleString()} deleted. Possible unauthorized file manipulation.</div>`
      : `<div style="margin-top:10px;padding:12px;border-radius:8px;background:#E8F5E9;border:2px solid #2E7D32;color:#1B5E20;font-weight:bold;font-size:14px">&#10003; CLEAN &mdash; No changes detected. All ${totalFiles.toLocaleString()} files match the baseline.</div>`;

  const MAX_ROWS = 500;

  const fileList = (title, borderColor, items, renderFn) => {
    if (!items || items.length === 0) return '';
    const rows = items.slice(0, MAX_ROWS).map(renderFn).join('');
    const more = items.length > MAX_ROWS
      ? `<tr><td colspan="2" bgcolor="#FFFFE0">&hellip; ${(items.length - MAX_ROWS).toLocaleString()} more</td></tr>`
      : '';
    return `<button class="collapsible">${title} (${items.length.toLocaleString()})</button><div class="content">
      <table width="100%" border="1" cellpadding="3" cellspacing="0" bordercolor="${borderColor}">${rows}${more}</table></div><br>`;
  };

  const modifiedSection = isFirstRun ? '' : fileList(
    'Modified Files (Hash Changed)', '#FFE0B2', diff.modified,
    m => `<tr>
      <td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px;width:45%">${esc(m.path)}</td>
      <td bgcolor="#FFF3E0" style="font-family:monospace;font-size:11px">
        <span style="color:#dc2626">was:&nbsp;${esc(m.oldHash)}</span><br>
        <span style="color:#16a34a">now:&nbsp;${esc(m.newHash)}</span>
      </td></tr>`
  );
  const addedSection = isFirstRun ? '' : fileList(
    'Added Files', '#C8E6C9', diff.added,
    f => `<tr><td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px">${esc(f)}</td></tr>`
  );
  const deletedSection = isFirstRun ? '' : fileList(
    'Deleted Files', '#FFCDD2', diff.deleted,
    f => `<tr><td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px">${esc(f)}</td></tr>`
  );
  const allFilesSection = fileList(
    isFirstRun ? 'Captured Files (Baseline)' : 'All Files (Current Snapshot)',
    '#E3F2FD',
    Object.keys(snapshot.files).map(f => ({ path: f, hash: snapshot.files[f] })),
    item => `<tr>
      <td bgcolor="#FFFFFF" style="font-family:monospace;font-size:12px">${esc(item.path)}</td>
      <td bgcolor="#F5F5F5" style="font-family:monospace;font-size:11px;color:#555">${esc(item.hash)}</td></tr>`
  );

  const navLinks = isFirstRun
    ? `<a href="#all">Captured (${totalFiles.toLocaleString()})</a>`
    : `<a href="#modified">Modified (${diff.modified.length.toLocaleString()})</a>
       <a href="#added">Added (${diff.added.length.toLocaleString()})</a>
       <a href="#deleted">Deleted (${diff.deleted.length.toLocaleString()})</a>
       <a href="#all">All Files (${totalFiles.toLocaleString()})</a>`;

  const summaryRows = isFirstRun ? '' : `
<tr><td bgcolor="#BBDEFB"><strong>Unchanged</strong></td>
    <td bgcolor="#FFFFFF"><font color="#16a34a">${diff.unchanged.length.toLocaleString()}</font></td>
    <td bgcolor="#BBDEFB"><strong>Modified</strong></td>
    <td bgcolor="#FFFFFF"><font color="${diff.modified.length > 0 ? '#dc2626' : '#16a34a'}">${diff.modified.length.toLocaleString()}</font></td></tr>
<tr><td bgcolor="#BBDEFB"><strong>Added</strong></td>
    <td bgcolor="#FFFFFF"><font color="${diff.added.length > 0 ? '#d97706' : '#16a34a'}">${diff.added.length.toLocaleString()}</font></td>
    <td bgcolor="#BBDEFB"><strong>Deleted</strong></td>
    <td bgcolor="#FFFFFF"><font color="${diff.deleted.length > 0 ? '#d97706' : '#16a34a'}">${diff.deleted.length.toLocaleString()}</font></td></tr>`;

  const html = `<!DOCTYPE HTML>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<title>Hash Integrity Report &mdash; ${esc(job.name)}</title>
<style>
  body { background-color: #F8F8F8; font-family: "Segoe UI Variable","Segoe UI",Verdana,sans-serif; margin: 16px; }
  #rcorners { -moz-border-radius: 10px; border-radius: 10px; border: 2px solid #DDDDDD; background-color: #EEEEEE; padding: 5px; width: 100%; }
  .topnav { overflow: hidden; background-color: #1565C0; border-radius: 10px; }
  .topnav a { float: left; color: #FFFFFF; padding: 10px; font-size: 15px; font-weight: bold; text-decoration: none; }
  .topnav a:hover { background-color: #BBDEFB; color: black; }
  .collapsible { background-color: #1565C0; color: #FFFFFF; cursor: pointer; padding: 10px; width: 100%; border: none; text-align: left; font-size: 16px; font-weight: bold; }
  .active, .collapsible:hover { background-color: #42A5F5; }
  .collapsible:after { content: "\\002B"; color: #FFFFFF; float: right; }
  .active:after { content: "\\2212"; }
  .content { padding: 0; max-height: 0; overflow: hidden; transition: max-height 0.2s ease-out; background-color: #f1f1f1; }
</style></head><body>
<table id="rcorners" border="0" cellspacing="0" cellpadding="0"><tbody><tr>
<td align="left" valign="middle" style="padding: 15px">
  <font color="#000000" size="5"><strong>Hash Integrity Report</strong><br><strong>${esc(job.name)}</strong></font>
</td>
<td align="right" valign="middle" style="padding: 15px">
  <font color="#555555" size="4"><small>${esc(startISO)}</small></font>
</td>
</tr></tbody></table>
${alertBanner}
<br>
<div class="topnav">${navLinks}</div>
<br>

<table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
<tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3">Overview</font></strong></td></tr>
<tr><td width="22%" bgcolor="#BBDEFB"><strong>Job Name</strong></td><td bgcolor="#FFFFFF">${esc(job.name)}</td>
    <td width="22%" bgcolor="#BBDEFB"><strong>Type</strong></td><td bgcolor="#FFFFFF">Hash Integrity Monitor</td></tr>
<tr><td bgcolor="#BBDEFB"><strong>Source</strong></td>
    <td colspan="3" bgcolor="#FFFFFF">${esc(job.sourceRemote)}:${esc(job.sourcePath || '')}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong>Algorithm</strong></td><td bgcolor="#FFFFFF">SHA-256</td>
    <td bgcolor="#BBDEFB"><strong>Mode</strong></td>
    <td bgcolor="#FFFFFF">${isFirstRun ? 'Initial Baseline Capture' : 'Comparison Run'}</td></tr>
<tr><td bgcolor="#BBDEFB"><strong>Start</strong></td><td bgcolor="#FFFFFF">${esc(startISO)}</td>
    <td bgcolor="#BBDEFB"><strong>End</strong></td><td bgcolor="#FFFFFF">${esc(endISO)} (${dur})</td></tr>
</table>
<br>

<table width="100%" border="1" cellpadding="5" cellspacing="0" bordercolor="#E3F2FD">
<tr bgcolor="#1565C0"><td colspan="4"><strong><font color="#FFFFFF" size="3">File Summary</font></strong></td></tr>
<tr><td width="22%" bgcolor="#BBDEFB"><strong>Total Files Scanned</strong></td>
    <td colspan="3" bgcolor="#FFFFFF">${totalFiles.toLocaleString()}</td></tr>
${summaryRows}
</table>
<br>

<a id="modified"></a>${modifiedSection}
<a id="added"></a>${addedSection}
<a id="deleted"></a>${deletedSection}
<a id="all"></a>${allFilesSection}

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

async function runHashCapture(job) {
  const startTime = Date.now();
  const files = await captureRemoteHashes(job.id, job.sourceRemote, job.sourcePath || '');

  const snapshot = {
    jobId: job.id,
    capturedAt: new Date().toISOString(),
    sourceRemote: job.sourceRemote,
    sourcePath: job.sourcePath || '',
    algorithm: 'SHA-256',
    files,
    totalFiles: Object.keys(files).length,
  };

  const baseline = getLatestSnapshot(job.id);
  const isFirstRun = !baseline;
  const diff = baseline ? diffSnapshots(baseline.files, files) : null;

  saveSnapshot(job.id, snapshot);
  const endTime = Date.now();

  const reportFile = await generateHashReport(job, snapshot, diff, isFirstRun, startTime, endTime);

  return { reportFile, snapshot, diff, isFirstRun, startTime, endTime };
}

function listHashSnapshots(jobId) {
  if (!fs.existsSync(HASHDB_DIR)) return [];
  return fs.readdirSync(HASHDB_DIR)
    .filter(f => f.startsWith(`${jobId}-`) && f.endsWith('.json'))
    .sort().reverse();
}

function pruneOldHashFiles(jobId, keepN = 20) {
  if (!fs.existsSync(HASHDB_DIR)) return;
  const files = fs.readdirSync(HASHDB_DIR)
    .filter(f => f.startsWith(`${jobId}-`) && f.endsWith('.json'))
    .sort().reverse();
  files.slice(keepN).forEach(f => {
    try { fs.unlinkSync(path.join(HASHDB_DIR, f)); } catch { /* ignore */ }
  });
}

module.exports = {
  runHashCapture,
  cancelHashCapture,
  listHashSnapshots,
  pruneOldHashFiles,
};
