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

// ── Token du compte service (cache mémoire + rotation en DB) ─────────────
let _serviceToken = null;
let _serviceTokenExpiry = 0;

// ── Cache contrats alliance ───────────────────────────────────────────────
let _contractsCache = null;
let _contractsCacheExpiry = 0;
let _knownContractIds = new Set();

async function notifyDiscord(contract) {
  const webhookUrl = getDiscordWebhookUrl();
  if (!webhookUrl || getSetting('discord_notifications') !== 'true') return;
  try {
    const vol = contract.volume ? `\`${contract.volume.toLocaleString()} m³\`` : '—';
    const col = contract.collateral ? `\`${contract.collateral.toLocaleString()} ISK\`` : '—';
    const rew = contract.reward ? `\`${contract.reward.toLocaleString()} ISK\`` : '—';

    // Portrait de l'issuer via EVE image server
    const portraitUrl = `https://images.evetech.net/characters/${contract.issuer_id}/portrait?size=64`;

    const embed = {
      author: {
        name: contract.issuer_name,
        icon_url: portraitUrl,
      },
      title: '\u{1F4E6} New Courier Contract',
      color: 0xf59e0b,
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
      timestamp: contract.date_issued || new Date().toISOString(),
    };

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

  // 5. Détecter et notifier les nouveaux contrats
  const currentIds = new Set(enriched.map(c => c.contract_id));
  if (_knownContractIds.size > 0) {
    const newContracts = enriched.filter(c => !_knownContractIds.has(c.contract_id) && c.status === 'outstanding');
    for (const c of newContracts) {
      notifyDiscord(c);
    }
  }
  _knownContractIds = currentIds;

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
    res.render('logistics', { contracts, standards: getFreightStandards() });
  } catch (err) {
    console.error('[logistics] ESI error:', err.message);
    res.render('logistics', { contracts: [], standards: getFreightStandards() });
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
  res.render('calculator', { standards: getFreightStandards() });
});

// ── ADMIN ────────────────────────────────────────────────────────────────

app.use(express.json());

app.get('/admin', requireAdmin, (req, res) => {
  res.render('admin', {
    standards:      getFreightStandards(),
    webhookUrl:     getSetting('discord_webhook_url') || '',
    discordEnabled: getSetting('discord_notifications') === 'true',
    stations:       getCommonStations(),
    cacheDuration:  parseInt(getSetting('cache_duration')) || 5,
    adminIds:       getAdminIds(),
  });
});

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
  }

  if (section === 'discord') {
    setSetting('discord_webhook_url', (req.body.webhookUrl || '').trim());
    setSetting('discord_notifications', req.body.discordEnabled === 'on' ? 'true' : 'false');
  }

  if (section === 'stations') {
    const raw = (req.body.stations || '').trim();
    const list = raw.split('\n').map(s => s.trim()).filter(Boolean);
    setSetting('common_stations', list);
  }

  if (section === 'cache') {
    const dur = parseInt(req.body.cacheDuration) || 5;
    setSetting('cache_duration', String(dur));
    // Invalider le cache actuel
    _contractsCache = null;
    _contractsCacheExpiry = 0;
  }

  if (section === 'admins') {
    const raw = (req.body.adminIds || '').trim();
    const ids = raw.split('\n').map(s => parseInt(s.trim())).filter(Boolean);
    setSetting('admin_ids', ids);
  }

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
