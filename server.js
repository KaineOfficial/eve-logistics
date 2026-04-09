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
const tokenUrl = 'https://login.eveonline.com/v2/oauth/token';
const scopes = process.env.SCOPES || 'publicData';

// HOME
app.get('/', (req, res) => {
  if (req.session.character) {
    res.render('dashboard', { character: req.session.character, version });
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
    redirect_uri: process.env.CALLBACK_URL,
    client_id: process.env.CLIENT_ID,
    scope: scopes,
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

  try {
    const tokenResponse = await axios.post(
      tokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.CALLBACK_URL
      }).toString(),
      {
        auth: { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET },
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

    const corpRes = await axios.get(
      `https://esi.evetech.net/latest/corporations/${characterRes.data.corporation_id}/`
    );

    req.session.character = {
      id: characterId,
      name: characterName,
      corporation: corpRes.data.name,
      portrait: portraitRes.data.px64x64
    };

    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('Erreur OAuth');
  }
});

// LOGOUT
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.listen(port, () => {
  console.log(`Serveur démarré sur ${port} - version ${version}`);
});
