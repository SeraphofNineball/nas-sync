const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

let _cache = null;
let _tail = Promise.resolve();

function readJobs() {
  if (_cache !== null) return _cache;
  if (!fs.existsSync(JOBS_FILE)) return (_cache = []);
  try {
    _cache = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    return _cache;
  } catch {
    return (_cache = []);
  }
}

function writeJobs(jobs) {
  _cache = jobs;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// Serialise concurrent async mutations that span an await boundary.
// Usage: await withJobLock(async () => { const jobs = readJobs(); ...; writeJobs(jobs); });
// HTTP route handlers that do synchronous read-modify-write don't need this
// because Node.js won't preempt them mid-execution.
function withJobLock(fn) {
  const next = _tail.then(() => fn(), () => fn());
  _tail = next.then(() => {}, () => {});
  return next;
}

module.exports = { readJobs, writeJobs, withJobLock, DATA_DIR };
