const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { listRemotes, addRemote, deleteRemote, browseRemote, checkRemote } = require('../services/rclone');

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
