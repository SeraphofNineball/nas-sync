const cron = require('node-cron');
const { readJobs, writeJobs } = require('./store');
const { runJob, summarizeLog, runIntegrityCheck, generateReport, getJobStats } = require('./rclone');

const active = {};

async function executeJob(jobId) {
  const jobs = readJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return;

  job.status = 'running';
  job.lastRun = new Date().toISOString();
  job.lastError = '';
  writeJobs(jobs);

  let logFile;
  try {
    const result = await runJob(job);
    logFile = result.logFile;
    job.status = 'success';
  } catch (err) {
    job.status = 'failed';
    job.lastError = err.message;
    const blob = getJobStats(jobId);
    if (blob && blob.logFile) logFile = blob.logFile;
  }

  // Generate completion report (success, stopped, or failed)
  try {
    const blob = getJobStats(jobId);
    if (blob && logFile) {
      const summary = summarizeLog(logFile);
      let integrity = null;
      // Only run integrity check if the job actually finished successfully
      if (job.status === 'success') {
        try { integrity = await runIntegrityCheck(job); }
        catch (e) { integrity = { ok: false, error: e.message, matching: 0, differences: 0, missing: 0, errors: 0, exitCode: -1 }; }
      }
      const reportFile = generateReport(job, logFile, summary, integrity, blob);
      job.lastReport = require('path').basename(reportFile);
      job.lastSummary = {
        copied: summary.copied.length,
        deleted: summary.deleted.length,
        updated: summary.updated.length,
        errors: summary.errors.length,
        integrity: integrity ? { ok: integrity.ok, differences: integrity.differences, missing: integrity.missing } : null,
      };
    }
  } catch (e) {
    // Report failure shouldn't take down the job
    job.lastError = (job.lastError ? job.lastError + ' · ' : '') + 'Report generation failed: ' + e.message;
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
