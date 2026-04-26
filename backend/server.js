const express = require('express');
const path = require('path');
const { initScheduler } = require('./services/scheduler');

const app = express();
app.use(express.json());

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
  initScheduler();
});
