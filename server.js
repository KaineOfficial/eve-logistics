require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const crypto = require('crypto');
const querystring = require('querystring');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true
}));

const baseAuthUrl = 'https://login.eveonline.com/v2/oauth/authorize/';
const tokenUrl = 'https://login.eveonline.com/v2/oauth/token';
const scopes = process.env.SCOPES || 'publicData';

// SAFE CALL (évite crash si scope manquant)
async function safeCall(fn) {
  try {
    return await fn();
  } catch (e) {
    return null;
  }
}

// HOME
app.get('/', (req, res) => {
  if (req.session.character) {
    res.render('dashboard', { character: req.session.character });
  } else {
    res.render('index');
  }
});

// LOGIN
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = {
    response_type: 'code',
    redirect_uri: process.env.CALLBACK_URL,
    client_id: process.env.CLIENT_ID,
    scope: scopes,
    state: state
  };

  res.redirect(`${baseAuthUrl}?${querystring.stringify(params)}`);
});

// CALLBACK
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!state || state !== req.session.oauthState) {
    return res.status(400).send('State invalide');
  }

  try {
    const tokenResponse = await axios.post(tokenUrl,
      querystring.stringify({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.CALLBACK_URL
      }),
      {
        auth: {
          username: process.env.CLIENT_ID,
          password: process.env.CLIENT_SECRET
        },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // VERIFY
    const verifyRes = await axios.get(
      'https://login.eveonline.com/oauth/verify',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const characterId = verifyRes.data.CharacterID;
    const characterName = verifyRes.data.CharacterName;

    // INFOS DE BASE
    const characterRes = await axios.get(
      `https://esi.evetech.net/latest/characters/${characterId}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const portraitRes = await axios.get(
      `https://esi.evetech.net/latest/characters/${characterId}/portrait/`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const corpRes = await axios.get(
      `https://esi.evetech.net/latest/corporations/${characterRes.data.corporation_id}/`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // ALLIANCE
    let alliance = 'Aucune';
    if (characterRes.data.alliance_id) {
      const allianceRes = await axios.get(
        `https://esi.evetech.net/latest/alliances/${characterRes.data.alliance_id}/`
      );
      alliance = allianceRes.data.name;
    }

    // === DONNÉES AVANCÉES ===

    const wallet = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/wallet/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const skills = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/skills/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const location = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/location/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const assets = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/assets/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const contacts = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/contacts/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const notifications = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/notifications/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    const contracts = await safeCall(() =>
      axios.get(`https://esi.evetech.net/latest/characters/${characterId}/contracts/`,
        { headers: { Authorization: `Bearer ${accessToken}` } })
    );

    // SESSION COMPLETE
    req.session.character = {
      id: characterId,
      name: characterName,
      corporation: corpRes.data.name,
      alliance: alliance,
      portrait: portraitRes.data.px64x64,

      // données avancées
      wallet: wallet?.data || null,
      skills: skills?.data || null,
      location: location?.data || null,
      assets: assets?.data || null,
      contacts: contacts?.data || null,
      notifications: notifications?.data || null,
      contracts: contracts?.data || null
    };

    console.log('DATA:', req.session.character);

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
  console.log(`Serveur démarré sur ${port}`);
});