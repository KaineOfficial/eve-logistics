# TSLC Logistics Panel

Logistics management panel for the **Tilean Dominion** alliance in EVE Online.  
Track courier contracts, calculate pricing, view hauler leaderboards, and manage alliance freight operations.

Live: https://panel.tslc.ovh

## Features

### Public
- **Price Calculator** — select a route (standard or special), enter volume + collateral, get the reward to set in-game
- Multi-language support (English, French, Spanish)

### Alliance Members
- **Logistics** — real-time corporation courier contracts from ESI with filters (outstanding, in progress, delivered, cancelled), search, column sorting, and time remaining
- **My Contracts** — personal contract tracking with stats and status updates
- **Leaderboard** — top haulers and issuers ranked by deliveries, volume, and ISK earned
- **Dashboard** — overview with stat cards, recent contracts, and quick links

### Admin Panel
- **Hauling Standards** — configure max volume, collateral tiers, pricing, expiration, days to complete
- **Special Routes** — CRUD for route-specific pricing (e.g. Jita ↔ ZT-L3S with surcharge), toggle active/inactive
- **Jump Calculation** — enable/disable ESI jump counting with configurable price per m³ per jump and DB cache
- **Discord Notifications** — webhook for new contracts, acceptances, deliveries, and failures
- **ESI Cache** — configurable duration with manual clear
- **Common Stations** — fallback station list for autocomplete
- **Admin Management** — character ID whitelist
- **Activity Logs** — who changed what and when
- **System Status** — cache state, contract count, app version

### Technical
- EVE Online SSO (OAuth2) authentication
- ESI API integration (contracts, names, structures, stations, routes)
- Service account token with automatic refresh rotation (stored in SQLite)
- In-memory contract cache with configurable TTL
- Jump route cache in SQLite (24h default)
- Rate limiting (60/min global, 20/min API, 30/min admin)
- Responsive design (mobile, tablet, desktop)

## Stack

- **Runtime**: Node.js + Express 5
- **Templates**: EJS
- **Database**: SQLite (better-sqlite3)
- **Auth**: EVE Online SSO OAuth2
- **API**: EVE ESI
- **Process Manager**: PM2

## Installation

1. Clone the repository:
```bash
git clone https://github.com/KaineOfficial/eve-app /var/www/eve-app
cd /var/www/eve-app
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file:
```env
PORT=3000
SESSION_SECRET=your_secret
CLIENT_ID=your_eve_client_id
CLIENT_SECRET=your_eve_client_secret
CALLBACK_URL=https://your-domain.com/callback
SERVICE_CLIENT_ID=your_service_client_id
SERVICE_CLIENT_SECRET=your_service_client_secret
SERVICE_REFRESH_TOKEN=your_service_refresh_token
SCOPES=publicData esi-contracts.read_corporation_contracts.v1 esi-search.search_structures.v1
ALLIANCE_ID=99014321
ADMIN_IDS=2115309720
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

4. Start with PM2:
```bash
pm2 start server.js --name eve-app
pm2 save
```

5. Deploy updates (on VPS):
```bash
git pull origin main
npm install
pm2 restart eve-app --update-env
```

## Project Structure

```
eve-app/
├── server.js          # Express app, routes, ESI logic, admin API
├── db.js              # SQLite schema + seeds (settings, routes, jump_cache, admin_logs)
├── package.json
├── locales/
│   └── index.js       # EN / FR / ES translations
├── views/
│   ├── index.ejs      # Login page
│   ├── dashboard.ejs  # User dashboard
│   ├── logistics.ejs  # Contract list + filters + standards
│   ├── my-contracts.ejs
│   ├── calculator.ejs # Price calculator with route selector
│   ├── leaderboard.ejs
│   ├── admin.ejs      # Admin panel
│   ├── 403.ejs
│   ├── service-setup.ejs
│   └── partials/
│       ├── navbar.ejs
│       └── footer.ejs
└── public/
    ├── style.css      # Full CSS including responsive
    └── lang.js        # Language switcher
```
