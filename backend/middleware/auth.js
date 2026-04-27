const crypto = require('crypto');

const TOKEN = process.env.API_TOKEN;

// When API_TOKEN is set, every /api/* request must supply the matching value
// in the X-Api-Token header (or ?_token= query param for iframe/link access).
// Timing-safe comparison prevents timing-oracle attacks.
// When API_TOKEN is not set the server is open — suitable for a fully-trusted
// private network or local-only deployment.
module.exports = function auth(req, res, next) {
  if (!TOKEN) return next();
  const provided = req.headers['x-api-token'] || req.query._token;
  if (!provided) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(TOKEN);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Unauthorized' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};
