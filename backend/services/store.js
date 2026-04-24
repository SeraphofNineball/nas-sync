const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function readJobs() {
  if (!fs.existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJobs(jobs) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

module.exports = { readJobs, writeJobs, DATA_DIR };
