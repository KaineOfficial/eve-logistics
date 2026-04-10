require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const port = process.env.LICENSE_PORT || 3001;
const db = new Database(path.join(__dirname, 'freight.db'));

app.use(express.json());

// Rate limit simple
const rateMap = {};
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  if (!rateMap[ip]) rateMap[ip] = [];
  rateMap[ip] = rateMap[ip].filter(t => now - t < 60000);
  if (rateMap[ip].length > 30) return res.status(429).json({ valid: false, error: 'rate limited' });
  rateMap[ip].push(now);
  next();
});

// POST /verify — verify a license key
app.post('/verify', (req, res) => {
  const { key, allianceId } = req.body;

  if (!key || !allianceId) {
    return res.json({ valid: false, error: 'missing key or allianceId' });
  }

  // Find license in DB
  const license = db.prepare('SELECT * FROM licenses WHERE license_key = ?').get(key);

  if (!license) {
    return res.json({ valid: false, error: 'license not found' });
  }

  if (!license.active) {
    return res.json({ valid: false, error: 'license revoked' });
  }

  if (license.alliance_id !== parseInt(allianceId)) {
    return res.json({ valid: false, error: 'license not valid for this alliance' });
  }

  if (license.expires_at && new Date(license.expires_at) < new Date()) {
    return res.json({ valid: false, error: 'license expired', expires: license.expires_at });
  }

  return res.json({
    valid: true,
    client: license.client_name,
    type: license.type,
    expires: license.expires_at || null,
  });
});

// GET /status — health check
app.get('/status', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`License server running on port ${port}`);
});
