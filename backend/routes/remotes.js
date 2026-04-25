const router = require('express').Router();
const { listRemotes, addRemote, deleteRemote, browseRemote, checkRemote } = require('../services/rclone');

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

router.get('/status', async (req, res) => {
  try {
    const names = listRemotes();
    const results = await Promise.all(names.map(name => checkRemote(name)));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:name', (req, res) => {
  try { deleteRemote(req.params.name); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:name/browse', (req, res) => {
  try { res.json(browseRemote(req.params.name, req.query.path || '')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
