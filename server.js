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

// ─────────────────────────────────────────────
// CORE MIDDLEWARE (ordre critique)
// ─────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

// SESSION DOIT ÊTRE AVANT TOUT CE QUI UTILISE req.session
app.use(session({
  store: new FileStore({
    path: './sessions',
    retries: 1
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

// ─────────────────────────────────────────────
// LANGUE (SAFE + SESSION GARANTIE)
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  const lang = req.session?.lang || 'en';

  res.locals.t = locales[lang] || locales.en;
  res.locals.lang = lang;

  next();
});

// ─────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────

const baseAuthUrl = 'https://login.eveonline.com/v2/oauth/authorize/';
const tokenUrl    = 'https://login.eveonline.com/v2/oauth/token';
const scopes      = process.env.SCOPES || 'publicData';
const allianceId  = parseInt(process.env.ALLIANCE_ID);

// ─────────────────────────────────────────────
// TOKEN SERVICE
// ─────────────────────────────────────────────

let _serviceToken = null;
let _serviceTokenExpiry = 0;

async function getServiceToken() {
  if (_serviceToken && Date.now() < _serviceTokenExpiry - 30000) {
    return _serviceToken;
  }

  const row = db.prepare('SELECT refresh_token FROM service_token WHERE id = 1').get();
  if (!row) throw new Error('SERVICE_REFRESH_TOKEN non configuré en DB');

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token
    }).toString(),
    {
      auth: {
        username: process.env.SERVICE_CLIENT_ID,
        password: process.env.SERVICE_CLIENT_SECRET
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    }
  );

  _serviceToken = response.data.access_token;
  _serviceTokenExpiry = Date.now() + response.data.expires_in * 1000;

  db.prepare(`
    UPDATE service_token
    SET refresh_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(response.data.refresh_token);

  return _serviceToken;
}

// ─────────────────────────────────────────────
// MIDDLEWARES
// ─────────────────────────────────────────────

function requireMember(req, res, next) {
  if (!req.session?.character) return res.redirect('/login');

  if (req.session.character.allianceId !== allianceId) {
    return res.status(403).render('403', {
      character: req.session.character,
      version
    });
  }

  next();
}

function requireHauler(req, res, next) {
  if (!req.session?.character) return res.redirect('/login');

  if (req.session.character.allianceId !== allianceId) {
    return res.status(403).render('403', {
      character: req.session.character,
      version
    });
  }

  next();
}

// ─────────────────────────────────────────────
// LABELS
// ─────────────────────────────────────────────

const STATUS_LABELS = {
  pending: "En attente d'acceptation",
  accepted: "En attente de transport",
  in_transit: "En cours de transport",
  delivered: "Livré",
  cancelled: "Annulé"
};

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  if (!req.session?.character) return res.render('index', { version });

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

  res.render('dashboard', {
    character: char,
    stats,
    myRequests,
    activeCount,
    statusLabels: STATUS_LABELS,
    allianceId,
    version
  });
});

// LOGIN
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: process.env.CALLBACK_URL,
    client_id: process.env.CLIENT_ID,
    scope: scopes,
    state
  });

  res.redirect(`${baseAuthUrl}?${params}`);
});

// SERVICE SETUP
app.get('/service-setup', (req, res) => {
  if (process.env.SERVICE_REFRESH_TOKEN) {
    return res.send('Service token déjà configuré.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.isServiceSetup = true;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: process.env.CALLBACK_URL,
    client_id: process.env.SERVICE_CLIENT_ID,
    scope: 'esi-contracts.read_corporation_contracts.v1',
    state
  });

  res.redirect(`${baseAuthUrl}?${params}`);
});

// CALLBACK (inchangé logique)
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session?.oauthState) {
    return res.status(400).send('State invalide');
  }

  if (req.session.isServiceSetup) {
    req.session.isServiceSetup = false;

    try {
      const tokenResponse = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: process.env.CALLBACK_URL
        }).toString(),
        {
          auth: {
            username: process.env.SERVICE_CLIENT_ID,
            password: process.env.SERVICE_CLIENT_SECRET
          },
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      const verifyRes = await axios.get(
        'https://login.eveonline.com/oauth/verify',
        { headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` } }
      );

      return res.render('service-setup', {
        characterName: verifyRes.data.CharacterName,
        refreshToken: tokenResponse.data.refresh_token,
        character: null,
        version
      });

    } catch (err) {
      console.error(err.response?.data || err.message);
      return res.status(500).send('Erreur service setup');
    }
  }

  try {
    const tokenResponse = await axios.post(
      tokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.CALLBACK_URL
      }).toString(),
      {
        auth: {
          username: process.env.CLIENT_ID,
          password: process.env.CLIENT_SECRET
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const verifyRes = await axios.get(
      'https://login.eveonline.com/oauth/verify',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const { CharacterID, CharacterName } = verifyRes.data;

    const [characterRes, portraitRes] = await Promise.all([
      axios.get(`https://esi.evetech.net/latest/characters/${CharacterID}/`),
      axios.get(`https://esi.evetech.net/latest/characters/${CharacterID}/portrait/`)
    ]);

    const corporationId = characterRes.data.corporation_id;

    const corpRes = await axios.get(
      `https://esi.evetech.net/latest/corporations/${corporationId}/`
    );

    req.session.character = {
      id: CharacterID,
      name: CharacterName,
      corporation: corpRes.data.name,
      corporationId,
      allianceId: characterRes.data.alliance_id || null,
      portrait: portraitRes.data.px64x64
    };

    res.redirect('/');

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Erreur OAuth');
  }
});

// ─────────────────────────────────────────────
// FREIGHT / HAULER / LANG / LOGOUT
// (inchangés fonctionnellement)
// ─────────────────────────────────────────────

app.listen(port, () => {
  console.log(`Serveur démarré sur ${port} - version ${version}`);
});