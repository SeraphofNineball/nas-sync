const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { LOGS_DIR, REPORTS_DIR, listReports } = require('../services/rclone');

// Read first 8KB of a report and derive its outcome status.
// Regular/sim reports embed the result as: <strong style="color:...">Success|Failed|Stopped</strong>
// Hash reports embed one of: INITIAL BASELINE | CHANGES DETECTED | CLEAN in the alert banner.
function extractStatus(filename) {
  const fullPath = path.resolve(REPORTS_DIR, filename);
  try {
    const fd = fs.openSync(fullPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const chunk = buf.slice(0, n).toString('utf8');

    if (filename.startsWith('hash-')) {
      if (chunk.includes('INITIAL BASELINE')) return 'baseline';
      if (chunk.includes('CHANGES DETECTED')) return 'changes';
      if (chunk.includes('CLEAN')) return 'clean';
      return null;
    }

    const m = chunk.match(/<strong style="color:[^"]+">(Success|Failed|Stopped)<\/strong>/);
    return m ? m[1].toLowerCase() : null;
  } catch { return null; }
}

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
  try {
    const files = listReports(req.params.jobId).slice(0, 20);
    res.json(files.map(filename => ({ filename, status: extractStatus(filename) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
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
