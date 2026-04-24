const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { readJobs, writeJobs } = require('../services/store');
const { scheduleJob, unscheduleJob, executeJob } = require('../services/scheduler');

router.get('/', (req, res) => res.json(readJobs()));

router.post('/', (req, res) => {
  const jobs = readJobs();
  const job = { id: uuidv4(), enabled: true, status: 'idle', createdAt: new Date().toISOString(), ...req.body };
  jobs.push(job);
  writeJobs(jobs);
  scheduleJob(job);
  res.json(job);
});

router.put('/:id', (req, res) => {
  const jobs = readJobs();
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  jobs[idx] = { ...jobs[idx], ...req.body };
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

router.post('/:id/run', (req, res) => {
  executeJob(req.params.id);
  res.json({ success: true });
});

module.exports = router;
