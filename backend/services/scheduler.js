const cron = require('node-cron');
const { readJobs, writeJobs } = require('./store');
const { runJob } = require('./rclone');

const active = {};

async function executeJob(jobId) {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.lastRun = new Date().toISOString();
  writeJobs(jobs);

  try {
    await runJob(job);
    job.status = 'success';
  } catch (err) {
    job.status = 'failed';
    job.lastError = err.message;
  }
  job.lastRun = new Date().toISOString();
  writeJobs(jobs);
}

function scheduleJob(job) {
  if (active[job.id]) { active[job.id].stop(); delete active[job.id]; }
  if (!job.schedule || !job.enabled) return;
  if (!cron.validate(job.schedule)) return;
  active[job.id] = cron.schedule(job.schedule, () => executeJob(job.id));
}

function unscheduleJob(jobId) {
  if (active[jobId]) { active[jobId].stop(); delete active[jobId]; }
}

function initScheduler() {
  const jobs = readJobs();
  let dirty = false;
  jobs.forEach(job => {
    if (job.status === 'running') {
      job.status = 'idle';
      job.lastError = 'Interrupted — server was restarted';
      dirty = true;
    }
  });
  if (dirty) writeJobs(jobs);
  jobs.forEach(scheduleJob);
}

module.exports = { scheduleJob, unscheduleJob, executeJob, initScheduler };
