const cron = require('node-cron');
const path = require('path');
const { readJobs, writeJobs } = require('./store');
const { runJob, summarizeLog, runIntegrityCheck, generateReport, getJobStats, cleanupJobState, pruneOldFiles } = require('./rclone');
const { runHashCapture, pruneOldHashFiles } = require('./hasher');

const active = {};

// Tracks job IDs that are currently executing (real run or simulation).
// Prevents the same job from running more than once simultaneously even if the
// cron interval is shorter than the job's runtime.
const executing = new Set();

async function executeJob(jobId) {
  if (executing.has(jobId)) return;
  executing.add(jobId);

  try {
    const jobs = readJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;

    job.status = 'running';
    job.lastRun = new Date().toISOString();
    job.lastError = '';
    writeJobs(jobs);

    if (job.type === 'hash-capture') {
      await executeHashJob(job, jobId);
      return;
    }

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

    try {
      const blob = getJobStats(jobId);
      if (blob && logFile) {
        const summary = await summarizeLog(logFile);
        let integrity = null;
        if (job.status === 'success') {
          try { integrity = await runIntegrityCheck(job); }
          catch (e) { integrity = { ok: false, error: e.message, matching: 0, differences: 0, missing: 0, errors: 0, exitCode: -1 }; }
        }
        const reportFile = await generateReport(job, logFile, summary, integrity, blob);
        job.lastReport = path.basename(reportFile);
        job.lastSummary = {
          copied:  summary.copiedTotal,
          deleted: summary.deletedTotal,
          updated: summary.updatedTotal,
          errors:  summary.errorsTotal,
          integrity: integrity
            ? { ok: integrity.ok, differences: integrity.differences, missing: integrity.missing }
            : null,
        };
        pruneOldFiles(jobId);
      }
    } catch (e) {
      job.lastError = (job.lastError ? job.lastError + ' · ' : '') + 'Report generation failed: ' + e.message;
    }

    // Re-read and merge to avoid overwriting edits that arrived during the run.
    const fresh = readJobs();
    const idx = fresh.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      fresh[idx] = {
        ...fresh[idx],
        status:      job.status,
        lastRun:     new Date().toISOString(),
        lastError:   job.lastError || '',
        lastReport:  job.lastReport,
        lastSummary: job.lastSummary,
      };
      writeJobs(fresh);
    }
  } finally {
    cleanupJobState(jobId);
    executing.delete(jobId);
  }
}

async function executeHashJob(job, jobId) {
  try {
    const result = await runHashCapture(job);
    const { diff, isFirstRun, snapshot } = result;

    const lastSummary = {
      jobKind:    'hash-capture',
      totalFiles: snapshot.totalFiles,
      isFirstRun,
      modified:   diff ? diff.modified.length : 0,
      added:      diff ? diff.added.length    : 0,
      deleted:    diff ? diff.deleted.length  : 0,
      unchanged:  diff ? diff.unchanged.length : snapshot.totalFiles,
      hasChanges: diff ? (diff.modified.length + diff.added.length + diff.deleted.length) > 0 : false,
    };

    pruneOldHashFiles(jobId);

    const fresh = readJobs();
    const idx = fresh.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      fresh[idx] = {
        ...fresh[idx],
        status:      'success',
        lastRun:     new Date().toISOString(),
        lastError:   '',
        lastReport:  path.basename(result.reportFile),
        lastSummary,
      };
      writeJobs(fresh);
    }
  } catch (err) {
    const fresh = readJobs();
    const idx = fresh.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      fresh[idx] = {
        ...fresh[idx],
        status:    'failed',
        lastRun:   new Date().toISOString(),
        lastError: err.message,
      };
      writeJobs(fresh);
    }
  }
  // executing.delete handled by executeJob's finally block
}

async function simulateJob(jobId) {
  if (executing.has(jobId)) return;

  const jobs = readJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job || job.status === 'running' || job.simulating) return;

  executing.add(jobId);
  job.simulating = true;
  writeJobs(jobs);

  let lastSimulation;
  let lastSimulationError;

  try {
    let logFile;
    try {
      const result = await runJob(job, { dryRun: true });
      logFile = result.logFile;
    } catch (err) {
      const blob = getJobStats(jobId);
      if (blob && blob.logFile) logFile = blob.logFile;
      lastSimulationError = err.message;
    }

    try {
      const blob = getJobStats(jobId);
      if (blob && logFile) {
        const summary = await summarizeLog(logFile);
        const reportFile = await generateReport(job, logFile, summary, null, blob);
        lastSimulation = {
          report:      path.basename(reportFile),
          ranAt:       new Date().toISOString(),
          wouldCopy:   summary.copiedTotal,
          wouldDelete: summary.deletedTotal,
          wouldUpdate: summary.updatedTotal,
          errors:      summary.errorsTotal,
        };
        pruneOldFiles(jobId);
      }
    } catch (e) {
      lastSimulationError = (lastSimulationError ? lastSimulationError + ' · ' : '')
        + 'Sim report failed: ' + e.message;
    }

    // Re-read and merge so a concurrent job edit is not lost.
    const fresh = readJobs();
    const idx = fresh.findIndex(j => j.id === jobId);
    if (idx !== -1) {
      fresh[idx] = {
        ...fresh[idx],
        simulating: false,
        lastSimulation,
        lastSimulationError,
      };
      writeJobs(fresh);
    }
  } finally {
    cleanupJobState(jobId);
    executing.delete(jobId);
  }
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
    if (job.simulating) {
      job.simulating = false;
      dirty = true;
    }
  });
  if (dirty) writeJobs(jobs);
  jobs.forEach(scheduleJob);
}

module.exports = { scheduleJob, unscheduleJob, executeJob, simulateJob, initScheduler };
