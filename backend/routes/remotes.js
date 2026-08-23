const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { listRemotes, addRemote, updateRemote, getRemoteConfig, deleteRemote, browseRemote, checkRemote } = require('../services/rclone');
const { readJobs, writeJobs } = require('../services/store');

// Each status check spawns one rclone subprocess per remote; cap at 6 calls
// per 30 s to prevent process exhaustion from rapid repeated polling.
const statusLimiter = rateLimit({
  windowMs: 30_000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

router.get('/', (req, res) => {
  try { res.json(listRemotes()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', (req, res) => {
  const { name, type, config } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type required' });
  try { addRemote(name, type, config || {}); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/status', statusLimiter, async (req, res) => {
  try {
    const names = listRemotes();
    const results = await Promise.all(names.map(name => checkRemote(name)));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:name', (req, res) => {
  const known = listRemotes();
  if (!known.includes(req.params.name)) return res.status(404).json({ error: 'Remote not found' });
  try { res.json(getRemoteConfig(req.params.name)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:name', (req, res) => {
  const oldName = req.params.name;
  const known = listRemotes();
  if (!known.includes(oldName)) return res.status(404).json({ error: 'Remote not found' });

  const { name, type, config } = req.body;
  const newName = (name || oldName).trim();
  if (!newName || !type) return res.status(400).json({ error: 'name and type required' });
  if (newName !== oldName && known.includes(newName)) {
    return res.status(409).json({ error: `A remote named '${newName}' already exists` });
  }

  try {
    updateRemote(oldName, newName, type, config || {});

    // Renaming a remote must not break jobs that reference it by name.
    let jobsUpdated = 0;
    if (newName !== oldName) {
      const jobs = readJobs();
      let changed = false;
      for (const job of jobs) {
        let touched = false;
        if (job.sourceRemote === oldName) { job.sourceRemote = newName; touched = true; }
        if (job.destRemote === oldName) { job.destRemote = newName; touched = true; }
        if (touched) { jobsUpdated++; changed = true; }
      }
      if (changed) writeJobs(jobs);
    }

    res.json({ success: true, name: newName, jobsUpdated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:name', (req, res) => {
  // Validate the name exists before acting to prevent operations on arbitrary identifiers.
  const known = listRemotes();
  if (!known.includes(req.params.name)) return res.status(404).json({ error: 'Remote not found' });
  try { deleteRemote(req.params.name); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/browse', (req, res) => {
  const known = listRemotes();
  if (!known.includes(req.params.name)) return res.status(404).json({ error: 'Remote not found' });
  try { res.json(browseRemote(req.params.name, req.query.path || '')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
