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

// ── Standards de hauling (affiché sur la page /freight) ──────────────────
const FREIGHT_STANDARDS = {
  maxVolume:     200_000,
  maxCollateral: 10_000_000_000,
  expirationWeeks: 4,
  daysToComplete:  7,
  tiers: [
    { maxCollateral: 1_000_000_000,  ratePerM3: 600  },
    { maxCollateral: 5_000_000_000,  ratePerM3: 950  },
    { maxCollateral: 10_000_000_000, ratePerM3: 1250 },
  ]
};

// ── Token du compte service (cache mémoire + rotation en DB) ─────────────
let _serviceToken = null;
let _serviceTokenExpiry = 0;

// ── Cache contrats alliance ───────────────────────────────────────────────
let _contractsCache = null;
let _contractsCacheExpiry = 0;

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

// ── Contrats alliance depuis ESI (cache 5 min) ───────────────────────────
async function fetchAllianceContracts() {
  if (_contractsCache && Date.now() < _contractsCacheExpiry) return _contractsCache;

  const token   = await getServiceToken();
  const authHdr = { Authorization: `Bearer ${token}` };

  // 1. Contrats courier de l'alliance
  const res      = await axios.get(
    `https://esi.evetech.net/v1/alliances/${allianceId}/contracts/`,
    { headers: authHdr }
  );
  const couriers = res.data.filter(c => c.type === 'courier');

  // 2. Batch-résolution noms (personnages + stations NPC)
  const charIds    = [...new Set(couriers.flatMap(c =>
    [c.issuer_id, c.acceptor_id].filter(Boolean)
  ))];
  const npcStatIds = [...new Set(couriers.flatMap(c =>
    [c.start_location_id, c.end_location_id].filter(id => id < 1_000_000_000_000)
  ))];
  const allIds = [...charIds, ...npcStatIds];

  let nameMap = {};
  if (allIds.length > 0) {
    const namesRes = await axios.post(
      'https://esi.evetech.net/v1/universe/names/', allIds,
      { headers: authHdr }
    );
    namesRes.data.forEach(n => { nameMap[n.id] = n.name; });
  }

  // 3. Structures joueur (IDs > 1e12)
  const structIds = [...new Set(couriers.flatMap(c =>
    [c.start_location_id, c.end_location_id].filter(id => id >= 1_000_000_000_000)
  ))];
  await Promise.all(structIds.map(async id => {
    try {
      const s = await axios.get(
        `https://esi.evetech.net/v2/universe/structures/${id}/`,
        { headers: authHdr }
      );
      nameMap[id] = s.data.name;
    } catch { nameMap[id] = `Structure #${id}`; }
  }));

  // 4. Enrichir et trier
  const enriched = couriers.map(c => ({
    ...c,
    issuer_name:   nameMap[c.issuer_id]         || `#${c.issuer_id}`,
    acceptor_name: c.acceptor_id ? (nameMap[c.acceptor_id] || `#${c.acceptor_id}`) : null,
    start_name:    nameMap[c.start_location_id] || `#${c.start_location_id}`,
    end_name:      nameMap[c.end_location_id]   || `#${c.end_location_id}`,
  })).sort((a, b) => new Date(b.date_issued) - new Date(a.date_issued));

  _contractsCache       = enriched;
  _contractsCacheExpiry = Date.now() + 5 * 60 * 1000;
  return enriched;
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
app.get('/', async (req, res) => {
  if (!req.session.character) return res.render('index');

  const char = req.session.character;
  let stats       = { outstanding: 0, in_progress: 0, finished: 0, cancelled: 0 };
  let myContracts = [];

  if (char.allianceId === allianceId) {
    try {
      const contracts = await fetchAllianceContracts();
      stats.outstanding = contracts.filter(c => c.status === 'outstanding').length;
      stats.in_progress = contracts.filter(c => c.status === 'in_progress').length;
      stats.finished    = contracts.filter(c => ['finished', 'finished_issuer', 'finished_contractor'].includes(c.status)).length;
      stats.cancelled   = contracts.filter(c => ['cancelled', 'rejected', 'failed'].includes(c.status)).length;
      myContracts       = contracts.filter(c => c.issuer_id === char.id).slice(0, 5);
    } catch (err) {
      console.error('[dashboard] ESI error:', err.message);
    }
  }

  res.render('dashboard', { stats, myContracts, allianceId });
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

      // Sauvegarder le nouveau token en DB et vider le cache mémoire
      const newRefreshToken = tokenResponse.data.refresh_token;
      db.prepare(`
        INSERT INTO service_token (id, refresh_token) VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, updated_at = CURRENT_TIMESTAMP
      `).run(newRefreshToken);
      _serviceToken       = null;
      _serviceTokenExpiry = 0;

      return res.render('service-setup', {
        characterName: verifyRes.data.CharacterName,
        refreshToken:  newRefreshToken,
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

// ── FRET (contrats ESI) ───────────────────────────────────────────────────

app.get('/freight', requireMember, async (_req, res) => {
  try {
    const contracts = await fetchAllianceContracts();
    res.render('freight', { contracts, standards: FREIGHT_STANDARDS });
  } catch (err) {
    console.error('[freight] ESI error:', err.message);
    res.render('freight', { contracts: [], standards: FREIGHT_STANDARDS });
  }
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

// ── HAULER (contrats ESI actifs) ─────────────────────────────────────────

app.get('/hauler', requireHauler, async (_req, res) => {
  try {
    const contracts = await fetchAllianceContracts();
    const active    = contracts.filter(c => ['outstanding', 'in_progress'].includes(c.status));
    res.render('hauler', { contracts: active });
  } catch (err) {
    console.error('[hauler] ESI error:', err.message);
    res.render('hauler', { contracts: [] });
  }
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
