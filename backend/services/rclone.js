const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const path = require('path');
const { DATA_DIR } = require('./store');
const { saveCredentials, getCredentials, deleteCredentials, getAllCredentials, obscurePassword, revealPassword } = require('./credentials');

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

// App-only config keys: stored in the credentials store and consumed by
// resolveRemoteArg(), but never written to rclone.conf (they are not rclone
// backend options). `path` is the root directory of a `local` remote.
const APP_ONLY_KEYS = new Set(['path']);

// Rejects a `local` remote whose root path is missing or not absolute. rclone's
// local backend has no config option for the root, so we keep it in the
// credentials store and prepend it to every path — which only works sanely if
// it is an absolute path inside the container.
function assertValidLocalRoot(type, config) {
  if (type !== 'local') return;
  const p = String(config.path || '').trim();
  if (!p) throw new Error('Local / Mounted Path remotes need a Root Path (e.g. /mnt/@usb/sde2)');
  if (!p.startsWith('/')) throw new Error('Root Path must be absolute (start with /)');
  if (/[\r\n]/.test(p)) throw new Error('Root Path must not contain newlines');
}

// Builds a single rclone.conf section. Passwords are obscured with the pure-JS
// obscurePassword (rather than spawning `rclone obscure`) so the plaintext is
// never visible in the OS process list.
function buildConfigEntry(name, type, config) {
  if (!SAFE_IDENT.test(name)) throw new Error('Remote name may only contain letters, digits, hyphens and underscores');
  if (!SAFE_IDENT.test(type)) throw new Error('Remote type may only contain letters, digits, hyphens and underscores');
  let entry = `[${name}]\ntype = ${type}\n`;
  for (const [key, value] of Object.entries(config)) {
    if (!value) continue;
    if (APP_ONLY_KEYS.has(key)) continue;
    if (!SAFE_IDENT.test(key)) throw new Error(`Invalid config key: ${key}`);
    if (/[\r\n]/.test(String(value))) throw new Error(`Config value for '${key}' must not contain newlines`);
    entry += key === 'pass'
      ? `pass = ${obscurePassword(value)}\n`
      : `${key} = ${value}\n`;
  }
  return entry;
}

// Returns the stored root directory for a `local` remote, or '' for any other
// remote (whose paths are already relative to the backend's own root).
function remoteRoot(name) {
  try {
    const c = getCredentials(name);
    if (c && c.type === 'local' && c.path) return String(c.path).replace(/\/+$/, '');
  } catch { /* credentials unreadable — treat as no root */ }
  return '';
}

// Joins a remote's stored root with a user-facing sub-path into the full
// `name:path` argument for rclone. A sub-path that is already absolute is used
// as-is, so jobs created before a root was configured (and the "type the full
// path" workaround) keep working. Non-local remotes are an unchanged passthrough.
function resolveRemoteArg(name, subPath = '') {
  const root = remoteRoot(name);
  let p = subPath || '';
  if (root && !p.startsWith('/')) {
    p = p ? `${root}/${p.replace(/^\/+/, '')}` : root;
  }
  return `${name}:${p}`;
}

function addRemote(name, type, config) {
  ensureConf();
  assertValidLocalRoot(type, config);
  saveCredentials(name, { type, ...config });
  fs.appendFileSync(RCLONE_CONF, '\n' + buildConfigEntry(name, type, config));
}

// Fields that hold secrets. Never echoed back to the client — the edit form
// shows them blank and a blank value on save means "keep the current secret".
const SECRET_FIELDS = new Set(['pass', 'secret_access_key']);

// Returns a remote's type/config for prefilling the edit form. Secret fields
// are replaced with '' (the stored plaintext never leaves the server); hasSecret
// tells the client whether a value is actually set, so it can render a
// "leave blank to keep current" placeholder instead of an empty required field.
function getRemoteConfig(name) {
  const stored = getCredentials(name);
  const { type, ...config } = stored;
  const safeConfig = {};
  const hasSecret = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELDS.has(key)) {
      hasSecret[key] = !!value;
      safeConfig[key] = '';
    } else {
      safeConfig[key] = value;
    }
  }
  return { type, config: safeConfig, hasSecret };
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

// Edits an existing remote in place, optionally renaming it. Secret fields
// (see SECRET_FIELDS) that arrive blank keep their previously stored value
// rather than being wiped, since the client never receives the real secret
// back from getRemoteConfig(). Non-secret fields are taken as given, so
// clearing an optional field in the form actually clears it.
function updateRemote(oldName, newName, type, config) {
  ensureConf();
  if (!SAFE_IDENT.test(newName)) throw new Error('Remote name may only contain letters, digits, hyphens and underscores');

  const existing = getCredentials(oldName);
  const merged = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (SECRET_FIELDS.has(key) && !value) {
      if (existing[key]) merged[key] = existing[key];
      continue;
    }
    merged[key] = value;
  }

  assertValidLocalRoot(type, merged);
  saveCredentials(newName, { type, ...merged });
  if (newName !== oldName) deleteCredentials(oldName);

  const text = fs.existsSync(RCLONE_CONF) ? fs.readFileSync(RCLONE_CONF, 'utf8') : '';
  const { sections, order } = parseConfSections(text);
  const entry = buildConfigEntry(newName, type, merged).trim();

  const blocks = [];
  let replaced = false;
  for (const name of order) {
    if (name === oldName) { blocks.push(entry); replaced = true; }
    else if (name === newName) { /* old, stale duplicate of the renamed-to section; drop it */ }
    else blocks.push(`[${name}]\n${sections[name].join('\n')}`.trim());
  }
  if (!replaced) blocks.push(entry);

  fs.writeFileSync(RCLONE_CONF, blocks.join('\n\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(RCLONE_CONF, 0o600); } catch { /* Windows: no-op */ }
}

function browseRemote(name, remotePath = '') {
  try {
    return JSON.parse(rclone(['lsjson', resolveRemoteArg(name, remotePath)]));
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
    const proc = spawn('rclone', ['lsf', resolveRemoteArg(name), '--max-depth', '1'], { env: env() });
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
    renamed: [], renamedTotal: 0,
    errors: [], errorsTotal: 0,
  };
  if (!fs.existsSync(logFile)) return result;

  // Paths handled by the rename pre-pass. In a dry run the moves are not
  // applied, so the sync that follows still reports them as a copy + delete;
  // those lines are dropped so the simulation matches what a real run does.
  const renamedTo = new Set();
  const renamedFrom = new Set();

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(logFile, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', raw => {
      const line = raw.replace(/\x1b\[[0-9;]*[mGKHF]/g, '');
      let m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Renamed from|Skipped rename as --dry-run from) "(.*)"\s*$/);
      if (m) {
        result.renamedTotal++; result.renamed.push(`${m[2]} → ${m[1]}`);
        renamedTo.add(m[1]); renamedFrom.add(m[2]);
        return;
      }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Copied\b|Skipped copy as --dry-run)/);
      if (m) {
        if (renamedTo.has(m[1])) return;
        result.copiedTotal++; result.copied.push(m[1]); return;
      }
      m = line.match(/(?:INFO|NOTICE)\s*:\s+(.+?):\s+(?:Deleted\b|Skipped delete as --dry-run)/);
      if (m) {
        if (renamedFrom.has(m[1])) return;
        result.deletedTotal++; result.deleted.push(m[1]); return;
      }
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

function fmtBytes(n) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(2) : n} ${units[i]}`;
}

function joinRemote(base, rel) {
  return /[:/]$/.test(base) ? base + rel : `${base}/${rel}`;
}

// Runs an rclone command registered with the job's controller (so Stop can
// kill it) and resolves { code, stdout, stderr } with capped output.
function runTracked(ctl, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('rclone', args, { env: env() });
    ctl.procs.add(proc);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { if (stdout.length < 65536) stdout += d; });
    proc.stderr.on('data', d => { if (stderr.length < 4096) stderr += d; });
    proc.on('close', code => { ctl.procs.delete(proc); resolve({ code, stdout, stderr }); });
    proc.on('error', err => { ctl.procs.delete(proc); reject(err); });
  });
}

// Recursively lists the files under a remote as Map(path -> { size, mod, md5 }).
// lsjson emits one entry per line, so the output is parsed as a stream rather
// than buffered whole. With allowMissing, a directory that does not exist yet
// (rclone exit code 3) is an empty listing instead of an error.
function listFiles(ctl, remote, extraArgs = [], allowMissing = false) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    const proc = spawn('rclone', ['lsjson', '-R', '--files-only', '--no-mimetype', remote, ...extraArgs], { env: env() });
    ctl.procs.add(proc);
    let stderr = '';
    proc.stderr.on('data', d => { if (stderr.length < 4096) stderr += d; });

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', raw => {
      const line = raw.trim().replace(/,$/, '');
      if (!line.startsWith('{')) return;
      try {
        const e = JSON.parse(line);
        files.set(e.Path, { size: e.Size, mod: Date.parse(e.ModTime), md5: e.Hashes && e.Hashes.md5 });
      } catch { /* skip unparseable line */ }
    });
    const drained = new Promise(res => rl.on('close', res));

    proc.on('close', async code => {
      ctl.procs.delete(proc);
      await drained;
      if (code === 0 || (allowMissing && code === 3)) resolve(files);
      else reject(new Error(`Listing ${remote} failed (rclone exit ${code}): ${stderr.trim().split('\n').pop() || ''}`));
    });
    proc.on('error', err => { ctl.procs.delete(proc); reject(err); });
  });
}

// MD5s just the given paths (relative to the remote). Remotes with no MD5
// support return entries without a hash, which simply never match.
async function hashFiles(ctl, remote, paths) {
  const listFile = path.join(os.tmpdir(), `nas-sync-hash-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await fs.promises.writeFile(listFile, paths.join('\n') + '\n');
  try {
    return await listFiles(ctl, remote, ['--hash', '--hash-type', 'md5', '--files-from-raw', listFile]);
  } finally {
    fs.promises.unlink(listFile).catch(() => {});
  }
}

// Rename pre-pass for jobs with both "delete before copying" and "detect
// renames" on. rclone cannot combine --track-renames with --delete-before (it
// silently falls back to --delete-after, the worst order for a near-full
// destination), so renames are resolved here and the sync that follows runs
// with --delete-before alone:
//   1. list both sides and pair source-only with destination-only files of the
//      same size + MD5 (only size-matched candidates are hashed)
//   2. check the destination has room once the deletions have happened
//   3. move each paired file into place on the destination
// A failed move is logged and left for the sync to handle as copy + delete.
async function renamePrePass(ctl, { job, src, dst, filterArgs, dryRun, log, setPhase }) {
  const stopIfCancelled = () => { if (ctl.cancelled) throw new Error('Job stopped by user'); };

  setPhase('Scanning for renames…');
  const [srcFiles, dstFiles] = await Promise.all([
    listFiles(ctl, src, filterArgs),
    listFiles(ctl, dst, filterArgs, true),
  ]);
  stopIfCancelled();

  // Source-only / destination-only files, grouped by size. Empty files are
  // skipped: they all hash alike and cost nothing to re-create.
  const onlyBySize = (a, b) => {
    const out = new Map();
    for (const [p, f] of a) {
      if (b.has(p) || !(f.size > 0)) continue;
      if (!out.has(f.size)) out.set(f.size, []);
      out.get(f.size).push(p);
    }
    return out;
  };
  const srcOnly = onlyBySize(srcFiles, dstFiles);
  const dstOnly = onlyBySize(dstFiles, srcFiles);
  const srcCand = [], dstCand = [];
  for (const [size, paths] of srcOnly) {
    const others = dstOnly.get(size);
    if (!others) continue;
    for (const p of paths) srcCand.push(p);
    for (const p of others) dstCand.push(p);
  }

  const pairs = [];
  if (srcCand.length) {
    setPhase(`Hashing ${(srcCand.length + dstCand.length).toLocaleString()} rename candidates…`);
    const [srcHashes, dstHashes] = await Promise.all([
      hashFiles(ctl, src, srcCand),
      hashFiles(ctl, dst, dstCand),
    ]);
    stopIfCancelled();

    const byKey = new Map();
    for (const p of dstCand.sort()) {
      const h = dstHashes.get(p);
      if (!h || !h.md5) continue;
      const key = `${h.size}:${h.md5}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(p);
    }
    for (const p of srcCand.sort()) {
      const h = srcHashes.get(p);
      const list = h && h.md5 && byKey.get(`${h.size}:${h.md5}`);
      if (!list || !list.length) continue;
      // Among identical files prefer the one that kept its name (a move).
      const leaf = path.posix.basename(p);
      const i = Math.max(0, list.findIndex(d => path.posix.basename(d) === leaf));
      pairs.push({ from: list.splice(i, 1)[0], to: p });
    }
  }
  log('INFO', `Rename pre-pass: ${srcFiles.size.toLocaleString()} source / ${dstFiles.size.toLocaleString()} destination files, ${pairs.length.toLocaleString()} renames detected`);

  // Space check. `need` is a lower bound (new files plus growth of files whose
  // size changed), so a failure here means the run could not have fit. A mirror
  // gets back the space of everything it deletes up front; a backup moves those
  // files into the versions folder on the same drive and gets nothing back.
  const frees = job.type === 'mirror';
  const pairedTo = new Set(pairs.map(p => p.to));
  const pairedFrom = new Set(pairs.map(p => p.from));
  let need = 0, freed = 0;
  for (const [p, f] of srcFiles) {
    const d = dstFiles.get(p);
    const size = Math.max(0, f.size);
    if (!d) { if (!pairedTo.has(p)) need += size; }
    else if (d.size !== f.size) need += frees ? Math.max(0, size - Math.max(0, d.size)) : size;
  }
  if (frees) {
    for (const [p, f] of dstFiles) {
      if (!srcFiles.has(p) && !pairedFrom.has(p)) freed += Math.max(0, f.size);
    }
  }
  let free = null;
  try {
    const about = await runTracked(ctl, ['about', dst, '--json']);
    if (about.code === 0) free = JSON.parse(about.stdout).free;
  } catch { /* backend cannot report free space */ }
  stopIfCancelled();
  if (typeof free === 'number') {
    const available = free + freed;
    const detail = `${fmtBytes(need)} to transfer, ${fmtBytes(available)} available`
      + (frees ? ` (${fmtBytes(free)} free + ${fmtBytes(freed)} freed by deletions)` : '');
    if (need > available) {
      if (!dryRun) throw new Error(`Not enough space on destination: ${detail}`);
      log('NOTICE', `Space check: NOT ENOUGH SPACE — ${detail}`);
    } else {
      log('INFO', `Space check: ${detail}`);
    }
  } else {
    log('INFO', 'Space check skipped: destination does not report free space');
  }

  if (!pairs.length) return;
  setPhase(`Renaming ${pairs.length.toLocaleString()} files…`);
  let next = 0;
  const worker = async () => {
    while (next < pairs.length) {
      stopIfCancelled();
      const { from, to } = pairs[next++];
      if (dryRun) { log('NOTICE', `${to}: Skipped rename as --dry-run from "${from}"`); continue; }
      const r = await runTracked(ctl, ['moveto', joinRemote(dst, from), joinRemote(dst, to)]);
      stopIfCancelled();
      if (r.code === 0) log('INFO', `${to}: Renamed from "${from}"`);
      else log('ERROR', `${to}: Failed to rename from "${from}": ${r.stderr.trim().split('\n').pop() || `rclone exit ${r.code}`}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pairs.length) }, worker));
}

async function runJob(job, opts = {}) {
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

  const src = resolveRemoteArg(job.sourceRemote, srcPath);
  const dst = resolveRemoteArg(job.destRemote, job.destPath || '');

  // Display source in logs/reports — list all paths when multiple are selected
  const displaySrc = (selectedPaths && selectedPaths.length > 1)
    ? selectedPaths.map(p => resolveRemoteArg(job.sourceRemote, p)).join(', ')
    : src;

  let baseArgs;
  if (job.type === 'mirror') {
    baseArgs = ['sync', src, dst];
  } else if (job.type === 'sync') {
    baseArgs = ['copy', src, dst];
  } else {
    const versionsDir = resolveRemoteArg(job.destRemote, `${job.destPath || ''}-versions/${timestamp}`);
    baseArgs = ['sync', src, dst, '--backup-dir', versionsDir];
  }
  const args = [...baseArgs, ...filterArgs, '--log-level', 'INFO', '--stats', '2s', '--stats-one-line=false'];
  // Default rclone behaviour is --delete-during (deletes interleaved with the
  // copy). --delete-before clears extraneous destination files up front, which
  // frees space first on a near-full destination. Only meaningful for the
  // delete-capable types (mirror/backup); `sync` runs `rclone copy` and never
  // deletes, so the flag would be a no-op.
  if (job.deleteBefore && job.type !== 'sync') args.push('--delete-before');
  // --track-renames converts a source-side rename/move from delete+re-transfer
  // into a server-side move on the destination (matched by size+hash). Same
  // mirror/backup-only applicability as --delete-before. rclone cannot honour
  // both flags at once, so with both on the renames are done by renamePrePass()
  // and rclone only gets --delete-before.
  const prePass = job.deleteBefore && job.trackRenames && job.type !== 'sync';
  if (job.trackRenames && job.type !== 'sync' && !prePass) args.push('--track-renames');
  if (dryRun) args.push('--dry-run');

  const startTime = Date.now();
  jobProgress[job.id] = { percent: 0, transferred: '', total: '', speed: '', eta: '', startTime, simulation: dryRun };
  jobStats[job.id] = { logFile, src: displaySrc, dst, timestamp, startTime, simulation: dryRun };

  // Stop handle covering every rclone process the run spawns.
  const ctl = {
    cancelled: false,
    procs: new Set(),
    kill(sig) { this.cancelled = true; for (const p of this.procs) p.kill(sig); },
  };
  runningProcesses[job.id] = ctl;

  if (prePass) {
    const log = (level, msg) => {
      const d = new Date(), z = n => String(n).padStart(2, '0');
      const ts = `${d.getFullYear()}/${z(d.getMonth() + 1)}/${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
      logStream.write(`${ts} ${level.padEnd(6)}: ${msg}\n`);
    };
    const setPhase = phase => { if (jobProgress[job.id]) jobProgress[job.id].phase = phase; };
    try {
      await renamePrePass(ctl, { job, src, dst, filterArgs, dryRun, log, setPhase });
      setPhase('');
    } catch (err) {
      const stopped = ctl.cancelled;
      for (const p of ctl.procs) p.kill();
      if (!stopped) log('ERROR', `Rename pre-pass: ${err.message}`);
      await new Promise(res => logStream.end(res));
      delete runningProcesses[job.id];
      jobStats[job.id].endTime = Date.now();
      jobStats[job.id].finalProgress = { ...jobProgress[job.id] };
      jobStats[job.id].result = stopped ? 'stopped' : 'failed';
      if (stopped) throw new Error('Job stopped by user');
      jobStats[job.id].error = err.message;
      throw err;
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('rclone', args, { env: env() });
    ctl.procs.add(proc);

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
  const src = resolveRemoteArg(job.sourceRemote, job.sourcePath || '');
  const dst = resolveRemoteArg(job.destRemote, job.destPath || '');
  const args = ['check', src, dst, '--size-only'];
  if (job.type === 'sync') args.push('--one-way');

  return new Promise(resolve => {
    const chunks = [];
    let totalLen = 0;
    const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap — ample for any realistic check output

    // Keeps the newest output: the summary counts are printed last, so dropping
    // the tail (as a keep-the-first cap would) loses them on a noisy check.
    const collect = (d) => {
      chunks.push(d); totalLen += d.length;
      while (chunks.length > 1 && totalLen - chunks[0].length >= MAX_BYTES) totalLen -= chunks.shift().length;
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
        // Last lines of rclone's output, shown in the report when the check fails.
        output: code === 0 ? '' : clean.split('\n').filter(l => l.trim()).slice(-15).join('\n'),
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
//                  updated[], updatedTotal, renamed[], renamedTotal,
//                  errors[], errorsTotal }
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
  const renamedCount = summary.renamedTotal || 0;
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
  ${!integrity.ok && (integrity.output || integrity.error) ? `<tr><td class="rpt-lbl"><strong>Check output</strong></td><td class="rpt-errmsg"><pre style="margin:0;white-space:pre-wrap;font-size:12px">${esc(integrity.output || integrity.error)}</pre></td></tr>` : ''}
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
  <a href="#renamed">${verb}Renamed (${renamedCount.toLocaleString()})</a>
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
<tr><td class="rpt-lbl">Deletions</td><td colspan="3" class="rpt-val">${
  job.type === 'sync' ? 'n/a — copy only, never deletes'
  : job.deleteBefore ? 'Before transfer (--delete-before)'
  : 'During transfer (rclone default)'
}</td></tr>
<tr><td class="rpt-lbl">Rename tracking</td><td colspan="3" class="rpt-val">${
  job.type === 'sync' ? 'n/a — copy only'
  : job.trackRenames && job.deleteBefore ? 'On — renamed/moved files moved on the destination in a pre-pass, before deletions and transfers'
  : job.trackRenames ? 'On — renamed/moved files moved server-side (--track-renames)'
  : 'Off — renamed files re-transferred'
}</td></tr>
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
<tr><td class="rpt-lbl">${verb}Renamed on Destination</td>
    <td class="rpt-val">${renamedCount.toLocaleString()} files</td></tr>
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
<a id="renamed"></a>${fileList(`${verb}Renamed Files`, summary.renamed || [], renamedCount)}
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
  listRemotes, addRemote, updateRemote, getRemoteConfig, deleteRemote, browseRemote, resolveRemoteArg, reconcileConfigFromCredentials,
  runJob, stopJob, stopAllJobs, getProgress, getJobStats, cleanupJobState,
  checkRemote,
  summarizeLog, runIntegrityCheck, generateReport, listReports,
  pruneOldFiles,
  LOGS_DIR, REPORTS_DIR,
};
