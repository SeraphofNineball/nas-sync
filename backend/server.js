const express = require('express');
const path = require('path');
const helmet = require('helmet');
const auth = require('./middleware/auth');
const { initScheduler } = require('./services/scheduler');
const { reconcileConfigFromCredentials } = require('./services/rclone');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

app.use('/api', auth);
app.use('/api/remotes', require('./routes/remotes'));
app.use('/api/jobs', require('./routes/jobs'));
app.use('/api/logs', require('./routes/logs'));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`nas-sync running on port ${PORT}`);
  try {
    const fixed = reconcileConfigFromCredentials();
    if (fixed.length) console.log(`Re-obscured rclone.conf passwords for: ${fixed.join(', ')}`);
  } catch (err) {
    console.error('Config reconciliation failed:', err.message);
  }
  initScheduler();
});
