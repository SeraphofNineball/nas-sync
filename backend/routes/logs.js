const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { LOGS_DIR, REPORTS_DIR, listReports } = require('../services/rclone');

router.get('/:jobId', (req, res) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) return res.json([]);
    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith(req.params.jobId) && f.endsWith('.log'))
      .sort().reverse().slice(0, 20);
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:jobId/reports', (req, res) => {
  try { res.json(listReports(req.params.jobId).slice(0, 20)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:jobId/reports/:filename', (req, res) => {
  const safe = path.resolve(REPORTS_DIR, req.params.filename);
  if (!safe.startsWith(path.resolve(REPORTS_DIR))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(safe)) return res.status(404).send('Not found');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.sendFile(safe);
});

router.delete('/:jobId/reports/:filename', (req, res) => {
  const safe = path.resolve(REPORTS_DIR, req.params.filename);
  if (!safe.startsWith(path.resolve(REPORTS_DIR))) return res.status(403).json({ error: 'Forbidden' });
  try {
    if (fs.existsSync(safe)) fs.unlinkSync(safe);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:jobId/:filename', (req, res) => {
  const safe = path.resolve(LOGS_DIR, req.params.filename);
  if (!safe.startsWith(path.resolve(LOGS_DIR))) return res.status(403).json({ error: 'Forbidden' });
  try {
    res.json({ content: fs.readFileSync(safe, 'utf8') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
