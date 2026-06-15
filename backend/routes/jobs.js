const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { readJobs, writeJobs } = require('../services/store');
const { scheduleJob, unscheduleJob, executeJob, simulateJob } = require('../services/scheduler');
const { getProgress, stopJob, stopAllJobs } = require('../services/rclone');
const { cancelHashCapture } = require('../services/hasher');

// Extracts only the user-supplied fields so callers cannot override internal
// state (id, status, createdAt, lastRun, lastError, simulating, etc.).
function pickJobFields(body) {
  const { name, type, sourceRemote, sourcePath, sourcePaths, destRemote, destPath, schedule, enabled } = body;
  return {
    name, type, sourceRemote, sourcePath,
    sourcePaths: Array.isArray(sourcePaths) ? sourcePaths : [],
    destRemote, destPath, schedule, enabled,
  };
}

router.get('/', (req, res) => {
  const jobs = readJobs();
  res.json(jobs.map(j => ({
    ...j,
    progress: (j.status === 'running' || j.simulating) ? getProgress(j.id) : null,
  })));
});

router.post('/', (req, res) => {
  const fields = pickJobFields(req.body);
  if (!fields.name?.trim()) return res.status(400).json({ error: 'name is required' });
  const jobs = readJobs();
  const job = {
    id:        uuidv4(),
    status:    'idle',
    enabled:   fields.enabled !== false,
    createdAt: new Date().toISOString(),
    ...fields,
    name: fields.name.trim(),
  };
  jobs.push(job);
  writeJobs(jobs);
  scheduleJob(job);
  res.json(job);
});

router.put('/:id', (req, res) => {
  const jobs = readJobs();
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  jobs[idx] = { ...jobs[idx], ...pickJobFields(req.body) };
  writeJobs(jobs);
  unscheduleJob(jobs[idx].id);
  scheduleJob(jobs[idx]);
  res.json(jobs[idx]);
});

router.delete('/:id', (req, res) => {
  unscheduleJob(req.params.id);
  writeJobs(readJobs().filter(j => j.id !== req.params.id));
  res.json({ success: true });
});

router.post('/stop-all', (req, res) => {
  stopAllJobs();
  res.json({ success: true });
});

router.post('/:id/run', (req, res) => {
  executeJob(req.params.id);
  res.json({ success: true });
});

router.post('/:id/simulate', (req, res) => {
  simulateJob(req.params.id);
  res.json({ success: true });
});

router.post('/:id/stop', (req, res) => {
  const stopped = stopJob(req.params.id) || cancelHashCapture(req.params.id);
  res.json({ success: stopped });
});

module.exports = router;
