require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { version } = require('./package.json');
const db = require('./db');
const locales = require('./locales');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// Rate limiting (après static pour ne pas compter CSS/JS/images)
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use('/admin', rateLimit({ windowMs: 60 * 1000, max: 30 }));

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

// ── Settings depuis la DB ────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function getSettingJSON(key) {
  const val = getSetting(key);
  try { return val ? JSON.parse(val) : null; } catch { return null; }
}

function setSetting(key, value) {
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP').run(key, val);
}

function getFreightStandards() {
  return getSettingJSON('freight_standards') || {
    maxVolume: 200000, maxCollateral: 10000000000,
    expirationWeeks: 4, daysToComplete: 7,
    tiers: [
      { maxCollateral: 1000000000, ratePerM3: 600 },
      { maxCollateral: 5000000000, ratePerM3: 950 },
      { maxCollateral: 10000000000, ratePerM3: 1250 },
    ]
  };
}

function getAdminIds() {
  const ids = getSettingJSON('admin_ids');
  const envIds = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
  return [...new Set([...(ids || []), ...envIds])];
}

function getCommonStations() {
  return getSettingJSON('common_stations') || [];
}

function getDiscordWebhookUrl() {
  return getSetting('discord_webhook_url') || process.env.DISCORD_WEBHOOK_URL || '';
}

function getCacheDuration() {
  return (parseInt(getSetting('cache_duration')) || 5) * 60 * 1000;
}

// ── Routes spéciales ─────────────────────────────────────────────────────
function getRoutes(activeOnly = true) {
  const rows = activeOnly
    ? db.prepare('SELECT * FROM routes WHERE active = 1 ORDER BY point_a, point_b').all()
    : db.prepare('SELECT * FROM routes ORDER BY active DESC, point_a, point_b').all();
  return rows.map(r => ({ ...r, tiers: JSON.parse(r.tiers || '[]') }));
}

// ── Jump calculation (ESI + cache DB) ────────────────────────────────────
async function getJumpCount(systemA, systemB) {
  if (systemA === systemB) return 0;

  // Check cache
  const cacheHours = parseInt(getSetting('jump_cache_hours')) || 24;
  const cached = db.prepare(
    'SELECT jumps, cached_at FROM jump_cache WHERE origin_system = ? AND destination_system = ?'
  ).get(systemA, systemB);

  if (cached) {
    const age = (Date.now() - new Date(cached.cached_at).getTime()) / 3600000;
    if (age < cacheHours) return cached.jumps;
  }

  // Call ESI
  const res = await axios.get(`https://esi.evetech.net/v1/route/${systemA}/${systemB}/`);
  const jumps = res.data.length - 1; // le tableau inclut origin + destination

  // Save cache
  db.prepare(
    'INSERT INTO jump_cache (origin_system, destination_system, jumps, cached_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(origin_system, destination_system) DO UPDATE SET jumps = excluded.jumps, cached_at = CURRENT_TIMESTAMP'
  ).run(systemA, systemB, jumps);

  return jumps;
}

async function getSystemIdFromStation(stationName) {
  const token = await getServiceToken();
  const b64     = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
  const charId  = payload.sub.split(':')[2];

  // Search station
  const searchRes = await axios.get(
    `https://esi.evetech.net/v3/characters/${charId}/search/`,
    {
      params: { categories: 'solar_system', search: stationName, language: 'en', strict: true },
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  const ids = searchRes.data.solar_system || [];
  return ids.length > 0 ? ids[0] : null;
}

// ── Token du compte service (cache mémoire + rotation en DB) ─────────────
let _serviceToken = null;
let _serviceTokenExpiry = 0;

// ── Cache contrats alliance ───────────────────────────────────────────────
let _contractsCache = null;
let _contractsCacheExpiry = 0;
let _knownContractIds = new Set();

const DISCORD_EVENTS = {
  new:       { title: '\u{1F4E6} New Courier Contract',    color: 0xf59e0b },
  accepted:  { title: '\u{1F6A2} Contract Accepted',       color: 0x3b82f6 },
  delivered: { title: '\u{2705} Contract Delivered',        color: 0x22c55e },
  failed:    { title: '\u{274C} Contract Failed/Cancelled', color: 0xef4444 },
};

async function notifyDiscord(contract, type = 'new') {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl || getSetting('discord_notifications') !== 'true') return;
  try {
    const vol = contract.volume ? `\`${contract.volume.toLocaleString()} m³\`` : '—';
    const col = contract.collateral ? `\`${contract.collateral.toLocaleString()} ISK\`` : '—';
    const rew = contract.reward ? `\`${contract.reward.toLocaleString()} ISK\`` : '—';
    const evt = DISCORD_EVENTS[type] || DISCORD_EVENTS.new;

    const portraitId = (type === 'accepted' || type === 'delivered') && contract.acceptor_id
      ? contract.acceptor_id : contract.issuer_id;
    const authorName = (type === 'accepted' || type === 'delivered') && contract.acceptor_name
      ? contract.acceptor_name : contract.issuer_name;

    const embed = {
      author: {
        name: authorName,
        icon_url: `https://images.evetech.net/characters/${portraitId}/portrait?size=64`,
      },
      title: evt.title,
      color: evt.color,
      description: [
        `**\u{1F6EB} Departure**\n${contract.start_name}`,
        `**\u{1F6EC} Arrival**\n${contract.end_name}`,
      ].join('\n\n'),
      fields: [
        { name: '\u{1F4E6} Volume',     value: vol, inline: true },
        { name: '\u{1F512} Collateral', value: col, inline: true },
        { name: '\u{1F4B0} Reward',     value: rew, inline: true },
      ],
      footer: {
        text: `TSLC Logistics \u2022 Contract #${contract.contract_id}`,
      },
      timestamp: new Date().toISOString(),
    };

    // Ajouter le hauler si accepté/livré
    if ((type === 'accepted' || type === 'delivered') && contract.acceptor_name) {
      embed.fields.push({ name: '\u{1F464} Hauler', value: contract.acceptor_name, inline: true });
    }
    // Ajouter l'issuer si ce n'est pas un nouveau contrat
    if (type !== 'new') {
      embed.fields.push({ name: '\u{1F4DD} Issuer', value: contract.issuer_name, inline: true });
    }

    await axios.post(webhookUrl, {
      username: 'TSLC Logistics',
      avatar_url: 'https://images.evetech.net/alliances/99014321/logo?size=128',
      embeds: [embed],
    });
  } catch (err) {
    console.error('[discord] webhook error:', err.message);
  }
}

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

// ── Contrats corporation depuis ESI ──────────────────────────────────────
let _serviceCorpId = null;

async function getServiceCorpId(token) {
  if (_serviceCorpId) return _serviceCorpId;
  const b64     = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
  const charId  = payload.sub.split(':')[2];
  const charRes = await axios.get(`https://esi.evetech.net/latest/characters/${charId}/`);
  _serviceCorpId = charRes.data.corporation_id;
  return _serviceCorpId;
}

async function fetchAllianceContracts() {
  if (_contractsCache && Date.now() < _contractsCacheExpiry) return _contractsCache;

  const token   = await getServiceToken();
  const authHdr = { Authorization: `Bearer ${token}` };
  const corpId  = await getServiceCorpId(token);

  // 1. Contrats courier de la corporation
  const res      = await axios.get(
    `https://esi.evetech.net/v1/corporations/${corpId}/contracts/`,
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

  // 5. Détecter et notifier les changements
  if (_knownContractIds.size > 0) {
    for (const c of enriched) {
      // Nouveau contrat
      if (!_knownContractIds.has(c.contract_id) && c.status === 'outstanding') {
        notifyDiscord(c, 'new');
      }
      // Changement de statut
      const prev = _contractsCache?.find(p => p.contract_id === c.contract_id);
      if (prev && prev.status !== c.status) {
        if (c.status === 'in_progress') notifyDiscord(c, 'accepted');
        if (['finished', 'finished_issuer', 'finished_contractor'].includes(c.status)) notifyDiscord(c, 'delivered');
        if (['failed', 'cancelled', 'rejected'].includes(c.status)) notifyDiscord(c, 'failed');
      }
    }
  }
  _knownContractIds = new Set(enriched.map(c => c.contract_id));

  _contractsCache       = enriched;
  _contractsCacheExpiry = Date.now() + getCacheDuration();
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


function requireAdmin(req, res, next) {
  if (!req.session.character) return res.redirect('/login');
  const adminIds = getAdminIds();
  if (!adminIds.includes(req.session.character.id)) {
    return res.status(403).render('403', { character: req.session.character, version });
  }
  next();
}

// Rendre isAdmin dispo dans toutes les vues
app.use((req, res, next) => {
  if (req.session.character) {
    res.locals.isAdmin = getAdminIds().includes(req.session.character.id);
  } else {
    res.locals.isAdmin = false;
  }
  next();
});

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
      stats.cancelled   = contracts.filter(c => ['cancelled', 'rejected', 'failed', 'deleted', 'reversed'].includes(c.status)).length;
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
      _serviceCorpId      = null;

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

// ── LOGISTICS (regroupe Freight + Hauler) ────────────────────────────────

app.get('/logistics', requireMember, async (_req, res) => {
  try {
    const contracts = await fetchAllianceContracts();
    res.render('logistics', { contracts, standards: getFreightStandards(), routes: getRoutes(true) });
  } catch (err) {
    console.error('[logistics] ESI error:', err.message);
    res.render('logistics', { contracts: [], standards: getFreightStandards(), routes: getRoutes(true) });
  }
});

// ── MES CONTRATS (suivi client) ──────────────────────────────────────────

app.get('/my-contracts', requireMember, async (req, res) => {
  const char = req.session.character;
  try {
    const all       = await fetchAllianceContracts();
    const contracts = all.filter(c => c.issuer_id === char.id);
    const stats = {
      outstanding: contracts.filter(c => c.status === 'outstanding').length,
      in_progress: contracts.filter(c => c.status === 'in_progress').length,
      finished:    contracts.filter(c => ['finished','finished_issuer','finished_contractor'].includes(c.status)).length,
      cancelled:   contracts.filter(c => ['cancelled','rejected','failed','deleted','reversed'].includes(c.status)).length,
    };
    res.render('my-contracts', { contracts, stats });
  } catch (err) {
    console.error('[my-contracts] ESI error:', err.message);
    res.render('my-contracts', { contracts: [], stats: { outstanding: 0, in_progress: 0, finished: 0, cancelled: 0 } });
  }
});

// ── LEADERBOARD ──────────────────────────────────────────────────────────

app.get('/leaderboard', requireMember, async (_req, res) => {
  try {
    const contracts = await fetchAllianceContracts();
    const finished = contracts.filter(c => ['finished','finished_issuer','finished_contractor'].includes(c.status));

    // Stats globales
    const globalStats = {
      totalContracts: contracts.length,
      delivered:      finished.length,
      totalVolume:    Math.round(finished.reduce((s, c) => s + (c.volume || 0), 0)).toLocaleString(),
      totalReward:    Math.round(finished.reduce((s, c) => s + (c.reward || 0), 0)).toLocaleString(),
    };

    // Classement haulers (par contrats livrés)
    const haulerMap = {};
    finished.forEach(c => {
      if (!c.acceptor_id) return;
      if (!haulerMap[c.acceptor_id]) {
        haulerMap[c.acceptor_id] = { id: c.acceptor_id, name: c.acceptor_name || `#${c.acceptor_id}`, delivered: 0, volume: 0, reward: 0 };
      }
      haulerMap[c.acceptor_id].delivered++;
      haulerMap[c.acceptor_id].volume += c.volume || 0;
      haulerMap[c.acceptor_id].reward += c.reward || 0;
    });
    const haulers = Object.values(haulerMap)
      .sort((a, b) => b.delivered - a.delivered)
      .map(h => ({ ...h, volume: Math.round(h.volume).toLocaleString(), reward: Math.round(h.reward).toLocaleString() }));

    // Top issuers
    const issuerMap = {};
    contracts.forEach(c => {
      if (!issuerMap[c.issuer_id]) {
        issuerMap[c.issuer_id] = { id: c.issuer_id, name: c.issuer_name, count: 0, volume: 0 };
      }
      issuerMap[c.issuer_id].count++;
      issuerMap[c.issuer_id].volume += c.volume || 0;
    });
    const issuers = Object.values(issuerMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(s => ({ ...s, volume: Math.round(s.volume).toLocaleString() }));

    res.render('leaderboard', { globalStats, haulers, issuers });
  } catch (err) {
    console.error('[leaderboard] ESI error:', err.message);
    res.render('leaderboard', {
      globalStats: { totalContracts: 0, delivered: 0, totalVolume: '0', totalReward: '0' },
      haulers: [], issuers: []
    });
  }
});

// Redirects anciennes URLs
app.get('/freight', requireMember, (_req, res) => res.redirect('/logistics'));
app.get('/hauler', requireMember, (_req, res) => res.redirect('/logistics'));

// ── RECHERCHE STATIONS ───────────────────────────────────────────────────


app.get('/api/stations', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (q.length < 3) return res.json([]);

  // Correspondances locales (toujours disponibles, réponse instantanée)
  const localMatches = getCommonStations().filter(s => s.toLowerCase().includes(q));

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


// CALCULATEUR
app.get('/calculator', (req, res) => {
  res.render('calculator', {
    standards: getFreightStandards(),
    routes: getRoutes(true),
    jumpEnabled: getSetting('jump_calculation') === 'true',
    jumpPricePerM3: parseFloat(getSetting('jump_price_per_m3')) || 0,
  });
});

// API: calcul de jumps
app.get('/api/jumps', async (req, res) => {
  if (getSetting('jump_calculation') !== 'true') return res.json({ error: 'disabled' });
  const { from, to } = req.query;
  if (!from || !to) return res.json({ error: 'missing params' });
  try {
    const sysA = await getSystemIdFromStation(from);
    const sysB = await getSystemIdFromStation(to);
    if (!sysA || !sysB) return res.json({ error: 'system not found' });
    const jumps = await getJumpCount(sysA, sysB);
    return res.json({ jumps, from, to });
  } catch (err) {
    console.error('[jumps] error:', err.message);
    return res.json({ error: err.message });
  }
});

// ── ADMIN ────────────────────────────────────────────────────────────────

app.use(express.json());

app.get('/admin', requireAdmin, (req, res) => {
  const logs = db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 20').all();
  res.render('admin', {
    standards:      getFreightStandards(),
    webhookUrl:     getSetting('discord_webhook_url') || '',
    discordEnabled: getSetting('discord_notifications') === 'true',
    stations:       getCommonStations(),
    cacheDuration:  parseInt(getSetting('cache_duration')) || 5,
    adminIds:       getAdminIds(),
    routes:         getRoutes(false),
    jumpEnabled:    getSetting('jump_calculation') === 'true',
    jumpPrice:      getSetting('jump_price_per_m3') || '0',
    jumpCacheHours: getSetting('jump_cache_hours') || '24',
    logs,
    cacheStatus: {
      active: !!_contractsCache,
      expiry: _contractsCacheExpiry ? new Date(_contractsCacheExpiry).toISOString() : null,
      count:  _contractsCache ? _contractsCache.length : 0,
    },
  });
});

function logAdmin(req, action, details = '') {
  const char = req.session.character;
  db.prepare('INSERT INTO admin_logs (char_id, char_name, action, details) VALUES (?, ?, ?, ?)').run(
    char.id, char.name, action, details
  );
}

app.post('/admin/settings', requireAdmin, (req, res) => {
  const { section } = req.body;

  if (section === 'standards') {
    const standards = {
      maxVolume:       parseInt(req.body.maxVolume) || 200000,
      maxCollateral:   parseFloat(req.body.maxCollateral) || 10000000000,
      expirationWeeks: parseInt(req.body.expirationWeeks) || 4,
      daysToComplete:  parseInt(req.body.daysToComplete) || 7,
      tiers: [],
    };
    // Tiers dynamiques
    const tierCollaterals = [].concat(req.body.tierCollateral || []);
    const tierRates       = [].concat(req.body.tierRate || []);
    for (let i = 0; i < tierCollaterals.length; i++) {
      const mc = parseFloat(tierCollaterals[i]);
      const rp = parseFloat(tierRates[i]);
      if (mc > 0 && rp > 0) standards.tiers.push({ maxCollateral: mc, ratePerM3: rp });
    }
    standards.tiers.sort((a, b) => a.maxCollateral - b.maxCollateral);
    setSetting('freight_standards', standards);
    logAdmin(req, 'update_standards', JSON.stringify(standards));
  }

  if (section === 'discord') {
    setSetting('discord_webhook_url', (req.body.webhookUrl || '').trim());
    setSetting('discord_notifications', req.body.discordEnabled === 'on' ? 'true' : 'false');
    logAdmin(req, 'update_discord');
  }

  if (section === 'stations') {
    const raw = (req.body.stations || '').trim();
    const list = raw.split('\n').map(s => s.trim()).filter(Boolean);
    setSetting('common_stations', list);
    logAdmin(req, 'update_stations', `${list.length} stations`);
  }

  if (section === 'cache') {
    const dur = parseInt(req.body.cacheDuration) || 5;
    setSetting('cache_duration', String(dur));
    _contractsCache = null;
    _contractsCacheExpiry = 0;
    logAdmin(req, 'update_cache', `${dur} min`);
  }

  if (section === 'admins') {
    const raw = (req.body.adminIds || '').trim();
    const ids = raw.split('\n').map(s => parseInt(s.trim())).filter(Boolean);
    setSetting('admin_ids', ids);
    logAdmin(req, 'update_admins', ids.join(', '));
  }

  if (section === 'jumps') {
    setSetting('jump_calculation', req.body.jumpEnabled === 'on' ? 'true' : 'false');
    setSetting('jump_price_per_m3', req.body.jumpPrice || '0');
    setSetting('jump_cache_hours', req.body.jumpCacheHours || '24');
    logAdmin(req, 'update_jumps', `enabled=${req.body.jumpEnabled === 'on'}, price=${req.body.jumpPrice}/m³/jump`);
  }

  res.redirect('/admin');
});

// ── Routes spéciales CRUD ────────────────────────────────────────────────

app.post('/admin/routes', requireAdmin, (req, res) => {
  const tiers = [];
  const tierCollaterals = [].concat(req.body.tierCollateral || []);
  const tierRates       = [].concat(req.body.tierRate || []);
  for (let i = 0; i < tierCollaterals.length; i++) {
    const mc = parseFloat(tierCollaterals[i]);
    const rp = parseFloat(tierRates[i]);
    if (mc > 0 && rp > 0) tiers.push({ maxCollateral: mc, ratePerM3: rp });
  }
  tiers.sort((a, b) => a.maxCollateral - b.maxCollateral);

  db.prepare(`INSERT INTO routes (point_a, point_b, max_volume, expiration_weeks, days_to_complete, tiers, surcharge, surcharge_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    (req.body.point_a || '').trim(),
    (req.body.point_b || '').trim(),
    parseInt(req.body.max_volume) || 200000,
    parseInt(req.body.expiration_weeks) || 4,
    parseInt(req.body.days_to_complete) || 7,
    JSON.stringify(tiers),
    parseFloat(req.body.surcharge) || 0,
    (req.body.surcharge_label || '').trim()
  );
  logAdmin(req, 'add_route', `${req.body.point_a} ↔ ${req.body.point_b}`);
  res.redirect('/admin');
});

app.post('/admin/routes/:id/update', requireAdmin, (req, res) => {
  const tiers = [];
  const tierCollaterals = [].concat(req.body.tierCollateral || []);
  const tierRates       = [].concat(req.body.tierRate || []);
  for (let i = 0; i < tierCollaterals.length; i++) {
    const mc = parseFloat(tierCollaterals[i]);
    const rp = parseFloat(tierRates[i]);
    if (mc > 0 && rp > 0) tiers.push({ maxCollateral: mc, ratePerM3: rp });
  }
  tiers.sort((a, b) => a.maxCollateral - b.maxCollateral);

  db.prepare(`UPDATE routes SET point_a = ?, point_b = ?, max_volume = ?, expiration_weeks = ?, days_to_complete = ?,
    tiers = ?, surcharge = ?, surcharge_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    (req.body.point_a || '').trim(),
    (req.body.point_b || '').trim(),
    parseInt(req.body.max_volume) || 200000,
    parseInt(req.body.expiration_weeks) || 4,
    parseInt(req.body.days_to_complete) || 7,
    JSON.stringify(tiers),
    parseFloat(req.body.surcharge) || 0,
    (req.body.surcharge_label || '').trim(),
    req.params.id
  );
  logAdmin(req, 'update_route', `#${req.params.id} ${req.body.point_a} ↔ ${req.body.point_b}`);
  res.redirect('/admin');
});

app.post('/admin/routes/:id/toggle', requireAdmin, (req, res) => {
  db.prepare('UPDATE routes SET active = NOT active, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  logAdmin(req, 'toggle_route', `#${req.params.id}`);
  res.redirect('/admin');
});

app.post('/admin/routes/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM routes WHERE id = ?').run(req.params.id);
  logAdmin(req, 'delete_route', `#${req.params.id}`);
  res.redirect('/admin');
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
