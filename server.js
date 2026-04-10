require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { version } = require('./package.json');
const db = require('./db');
const locales = require('./locales');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new FileStore({ path: './sessions', retries: 1 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

// Langue + locals globaux (session, défaut anglais)
app.use((req, res, next) => {
  const lang = req.session.lang || 'en';
  res.locals.t         = locales[lang] || locales.en;
  res.locals.lang      = lang;
  res.locals.character = req.session.character || null;
  res.locals.version   = version;
  next();
});

const baseAuthUrl = 'https://login.eveonline.com/v2/oauth/authorize/';
const tokenUrl    = 'https://login.eveonline.com/v2/oauth/token';
const scopes      = process.env.SCOPES || 'publicData';
const allianceId  = parseInt(process.env.ALLIANCE_ID);

// ── Configuration fret ────────────────────────────────────────────────────
const FREIGHT_CONFIG = {
  maxVolume:     200_000,
  maxCollateral: 10_000_000_000,
  tiers: [
    { maxCollateral: 1_000_000_000,  ratePerM3: 600  },
    { maxCollateral: 5_000_000_000,  ratePerM3: 950  },
    { maxCollateral: 10_000_000_000, ratePerM3: 1250 },
  ]
};

// ── Token du compte service (cache mémoire + rotation en DB) ─────────────
let _serviceToken = null;
let _serviceTokenExpiry = 0;

async function getServiceToken() {
  if (_serviceToken && Date.now() < _serviceTokenExpiry - 30000) return _serviceToken;

  const row = db.prepare('SELECT refresh_token FROM service_token WHERE id = 1').get();
  if (!row) throw new Error('SERVICE_REFRESH_TOKEN non configuré en DB');

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }).toString(),
    {
      auth:    { username: process.env.SERVICE_CLIENT_ID, password: process.env.SERVICE_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  _serviceToken       = response.data.access_token;
  _serviceTokenExpiry = Date.now() + response.data.expires_in * 1000;

  db.prepare('UPDATE service_token SET refresh_token = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(response.data.refresh_token);

  return _serviceToken;
}

// ── Middlewares ───────────────────────────────────────────────────────────
function requireMember(req, res, next) {
  if (!req.session.character) return res.redirect('/login');
  if (req.session.character.allianceId !== allianceId) {
    return res.status(403).render('403', { character: req.session.character, version });
  }
  next();
}

function requireHauler(req, res, next) {
  if (!req.session.character) return res.redirect('/login');
  if (req.session.character.allianceId !== allianceId) {
    return res.status(403).render('403', { character: req.session.character, version });
  }
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════════════

// HOME
app.get('/', (req, res) => {
  if (!req.session.character) return res.render('index');

  const char = req.session.character;

  const stats = {};
  ['pending', 'accepted', 'in_transit', 'delivered', 'cancelled'].forEach(s => {
    stats[s] = db.prepare('SELECT COUNT(*) as n FROM requests WHERE status = ?').get(s).n;
  });

  const myRequests = db.prepare(
    'SELECT * FROM requests WHERE char_id = ? ORDER BY created_at DESC LIMIT 5'
  ).all(char.id);

  const activeCount = db.prepare(
    "SELECT COUNT(*) as n FROM requests WHERE status NOT IN ('delivered','cancelled')"
  ).get().n;

  res.render('dashboard', { stats, myRequests, activeCount, allianceId });
});

// LOGIN
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  process.env.CALLBACK_URL,
    client_id:     process.env.CLIENT_ID,
    scope:         scopes,
    state
  });

  res.redirect(`${baseAuthUrl}?${params}`);
});

// SERVICE SETUP
app.get('/service-setup', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState     = state;
  req.session.isServiceSetup = true;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  process.env.CALLBACK_URL,
    client_id:     process.env.SERVICE_CLIENT_ID,
    scope:         process.env.SCOPES,
    state
  });

  res.redirect(`${baseAuthUrl}?${params}`);
});

// CALLBACK
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) return res.status(400).send('State invalide');

  // Callback service setup
  if (req.session.isServiceSetup) {
    req.session.isServiceSetup = false;
    try {
      const tokenResponse = await axios.post(
        tokenUrl,
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.CALLBACK_URL }).toString(),
        {
          auth:    { username: process.env.SERVICE_CLIENT_ID, password: process.env.SERVICE_CLIENT_SECRET },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );
      const verifyRes = await axios.get('https://login.eveonline.com/oauth/verify', {
        headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` }
      });
      return res.render('service-setup', {
        characterName: verifyRes.data.CharacterName,
        refreshToken:  tokenResponse.data.refresh_token,
        character:     null,
        version
      });
    } catch (err) {
      console.error(err.response?.data || err.message);
      return res.status(500).send('Erreur service setup');
    }
  }

  // Callback login normal
  try {
    const tokenResponse = await axios.post(
      tokenUrl,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.CALLBACK_URL }).toString(),
      {
        auth:    { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const authHeaders = { headers: { Authorization: `Bearer ${accessToken}` } };

    const verifyRes = await axios.get('https://login.eveonline.com/oauth/verify', authHeaders);
    const { CharacterID: characterId, CharacterName: characterName } = verifyRes.data;

    const [characterRes, portraitRes] = await Promise.all([
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/`, authHeaders),
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/portrait/`, authHeaders)
    ]);

    const corporationId = characterRes.data.corporation_id;
    const corpRes = await axios.get(`https://esi.evetech.net/latest/corporations/${corporationId}/`);

    req.session.character = {
      id:            characterId,
      name:          characterName,
      corporation:   corpRes.data.name,
      corporationId: corporationId,
      allianceId:    characterRes.data.alliance_id || null,
      portrait:      portraitRes.data.px64x64
    };

    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Erreur OAuth');
  }
});

// ── FRET ──────────────────────────────────────────────────────────────────

app.get('/freight', requireMember, (_req, res) => {
  const requests = db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all();
  res.render('freight', { requests });
});

app.get('/freight/new', requireMember, (_req, res) => {
  res.render('freight-new', { freightConfig: FREIGHT_CONFIG });
});

app.post('/freight/new', requireMember, (req, res) => {
  const { pickup, destination, volume, collateral, reward, notes } = req.body;

  const vol = parseFloat(volume) || 0;
  const col = parseFloat(collateral) || 0;
  if (vol > FREIGHT_CONFIG.maxVolume)     return res.status(400).send('Volume trop élevé (max 200 000 m³)');
  if (col > FREIGHT_CONFIG.maxCollateral) return res.status(400).send('Collateral trop élevé (max 10B ISK)');

  db.prepare(`
    INSERT INTO requests (char_name, char_id, pickup, destination, volume, collateral, reward, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.character.name,
    req.session.character.id,
    pickup.trim(),
    destination.trim(),
    vol,
    col,
    parseFloat(reward) || 0,
    (notes || '').trim()
  );

  res.redirect('/freight');
});

// ── RECHERCHE STATIONS ───────────────────────────────────────────────────

// Stations NPC principales (fallback instantané si ESI indisponible)
const COMMON_STATIONS = [
  'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
  'Amarr VIII (Oris) - Emperor Family Academy',
  'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
  'Rens VI - Moon 8 - Brutor Tribe Treasury',
  'Hek VIII - Moon 12 - Boundless Creation Factory',
  'Perimeter - Tranquility Trading Tower',
  'Niarja - TTT - Tranquility Trading Tower',
  'Oursulaert VIII - Moon 3 - Federation Navy Assembly Plant',
  'Tash-Murkon Prime II - Moon 1 - Kaalakiota Corporation Factory',
];

app.get('/api/stations', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (q.length < 3) return res.json([]);

  // Correspondances locales (toujours disponibles, réponse instantanée)
  const localMatches = COMMON_STATIONS.filter(s => s.toLowerCase().includes(q));

  try {
    const token   = await getServiceToken();
    // Décoder le JWT pour extraire l'ID du personnage service
    const b64     = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
    const charId  = payload.sub.split(':')[2]; // "CHARACTER:EVE:12345" → "12345"

    const searchRes = await axios.get(
      `https://esi.evetech.net/v3/characters/${charId}/search/`,
      {
        params:  { categories: 'station', search: q, language: 'en', strict: false },
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
      }
    );
    const ids = (searchRes.data.station || []).slice(0, 8);
    if (ids.length === 0) return res.json(localMatches.slice(0, 10));

    const namesRes = await axios.post(
      'https://esi.evetech.net/v3/universe/names/', ids,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const esiNames = namesRes.data.map(n => n.name);
    const combined = [...new Set([...localMatches, ...esiNames])].sort().slice(0, 10);
    res.json(combined);
  } catch (err) {
    console.error('[stations] error:', err.response?.status, err.response?.data || err.message);
    res.json(localMatches.slice(0, 10));
  }
});

// ── HAULER ────────────────────────────────────────────────────────────────

app.get('/hauler', requireHauler, (_req, res) => {
  const requests = db.prepare(
    "SELECT * FROM requests WHERE status NOT IN ('delivered','cancelled') ORDER BY created_at ASC"
  ).all();
  res.render('hauler', { requests });
});

app.post('/hauler/:id/status', requireHauler, (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'accepted', 'in_transit', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) return res.status(400).send('Statut invalide');

  db.prepare(
    'UPDATE requests SET status = ?, hauler_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(status, req.session.character.name, req.params.id);

  res.redirect('/hauler');
});

// LANGUE
app.get('/lang/:code', (req, res) => {
  if (['en', 'fr', 'es'].includes(req.params.code)) {
    req.session.lang = req.params.code;
  }
  res.redirect(req.headers.referer || '/');
});

// LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Serveur démarré sur ${port} - version ${version}`);
});
