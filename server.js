require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const { version } = require('./package.json');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new FileStore({ path: './sessions', retries: 1 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false
}));

const baseAuthUrl = 'https://login.eveonline.com/v2/oauth/authorize/';
const tokenUrl    = 'https://login.eveonline.com/v2/oauth/token';
const scopes      = process.env.SCOPES || 'publicData';

// Retourne un access token valide, le renouvelle automatiquement si expiré
async function getValidToken(session) {
  if (Date.now() < session.tokenExpiresAt - 30000) {
    return session.accessToken;
  }

  const response = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: session.refreshToken
    }).toString(),
    {
      auth:    { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );

  session.accessToken    = response.data.access_token;
  session.refreshToken   = response.data.refresh_token;
  session.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;

  return session.accessToken;
}

// HOME
app.get('/', (req, res) => {
  if (req.session.character) {
    res.render('dashboard', {
      character: req.session.character,
      contracts: req.session.contracts || { outstanding: [], inProgress: [] },
      version
    });
  } else {
    res.render('index', { version });
  }
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

// SERVICE SETUP — connexion unique du personnage service pour obtenir son refresh_token
app.get('/service-setup', (req, res) => {
  if (process.env.SERVICE_REFRESH_TOKEN) {
    return res.send('Service token déjà configuré. Supprime SERVICE_REFRESH_TOKEN du .env pour reconfigurer.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState    = state;
  req.session.isServiceSetup = true;

  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri:  process.env.CALLBACK_URL,
    client_id:     process.env.SERVICE_CLIENT_ID,
    scope:         'esi-contracts.read_corporation_contracts.v1',
    state
  });

  res.redirect(`${baseAuthUrl}?${params}`);
});

// CALLBACK
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('State invalide');
  }

  // Callback du service setup
  if (req.session.isServiceSetup) {
    req.session.isServiceSetup = false;
    try {
      const tokenResponse = await axios.post(
        tokenUrl,
        new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: process.env.CALLBACK_URL
        }).toString(),
        {
          auth:    { username: process.env.SERVICE_CLIENT_ID, password: process.env.SERVICE_CLIENT_SECRET },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      const accessToken = tokenResponse.data.access_token;
      const verifyRes   = await axios.get('https://login.eveonline.com/oauth/verify', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      return res.render('service-setup', {
        characterName: verifyRes.data.CharacterName,
        refreshToken:  tokenResponse.data.refresh_token,
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
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: process.env.CALLBACK_URL
      }).toString(),
      {
        auth:    { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const authHeaders = { headers: { Authorization: `Bearer ${accessToken}` } };

    req.session.accessToken    = accessToken;
    req.session.refreshToken   = tokenResponse.data.refresh_token;
    req.session.tokenExpiresAt = Date.now() + tokenResponse.data.expires_in * 1000;

    const verifyRes = await axios.get('https://login.eveonline.com/oauth/verify', authHeaders);
    const { CharacterID: characterId, CharacterName: characterName } = verifyRes.data;

    const [characterRes, portraitRes] = await Promise.all([
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/`, authHeaders),
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/portrait/`, authHeaders)
    ]);

    const corporationId = characterRes.data.corporation_id;

    const [corpRes, contractsRes] = await Promise.all([
      axios.get(`https://esi.evetech.net/latest/corporations/${corporationId}/`),
      axios.get(`https://esi.evetech.net/latest/corporations/${corporationId}/contracts/`, authHeaders)
        .catch(() => null)
    ]);

    const allContracts = contractsRes?.data || [];

    req.session.character = {
      id:            characterId,
      name:          characterName,
      corporation:   corpRes.data.name,
      corporationId: corporationId,
      portrait:      portraitRes.data.px64x64
    };

    req.session.contracts = {
      outstanding: allContracts.filter(c => c.status === 'outstanding'),
      inProgress:  allContracts.filter(c => c.status === 'in_progress')
    };

    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Erreur OAuth');
  }
});

// REFRESH CONTRATS
app.get('/contracts/refresh', async (req, res) => {
  if (!req.session.character) return res.redirect('/');

  try {
    const token       = await getValidToken(req.session);
    const authHeaders = { headers: { Authorization: `Bearer ${token}` } };
    const corpId      = req.session.character.corporationId;

    const contractsRes = await axios.get(
      `https://esi.evetech.net/latest/corporations/${corpId}/contracts/`,
      authHeaders
    ).catch(() => null);

    const allContracts = contractsRes?.data || [];

    req.session.contracts = {
      outstanding: allContracts.filter(c => c.status === 'outstanding'),
      inProgress:  allContracts.filter(c => c.status === 'in_progress')
    };
  } catch (err) {
    console.error(err.response?.data || err.message);
  }

  res.redirect('/');
});

// LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Serveur démarré sur ${port} - version ${version}`);
});
