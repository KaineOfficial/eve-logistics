# Tilean Dominion Logistics Panel

Logistics management panel for the **Tilean Dominion** alliance in EVE Online.  
Track courier contracts in real-time, calculate pricing per route, view hauler leaderboards, manage alliance freight operations, and receive Discord notifications.

Live: https://logistics.tslc.ovh

## Features

### Public
- **Price Calculator** — select a route (standard or special), enter volume + collateral, get the reward to set in-game with one-click copy
- **Dark / Light theme** — toggle in the navbar, persisted in localStorage
- **Multi-language** — English, French, Spanish

### Alliance Members
- **Dashboard** — stat cards (outstanding, in transit, delivered, cancelled), weekly activity chart (Chart.js), recent contracts
- **Logistics** — real-time corporation courier contracts from ESI with status filters, full-text search, column sorting, pagination (25/page), conformity warnings (reward below standard), expiry alerts (<48h blinking), and time remaining
- **My Contracts** — personal contract tracking with stats and filters
- **Leaderboard** — top haulers and issuers ranked by deliveries, volume hauled, and ISK earned with portrait avatars and medal rankings
- **Responsive** — fully usable on mobile, tablet, and desktop

### Haulers
- **My Deliveries** — personal delivery history with stats (delivered, in progress, volume hauled, ISK earned)

### Directors
- **Director Dashboard** — weekly performance (deliveries, volume, ISK revenue, active haulers), urgent contracts (<48h), active haulers list, price change history, weekly charts (deliveries bar + ISK revenue line)
- **Admin Panel (partial)** — can modify hauling standards, special routes, and jump settings
- **CSV Export** — download all contracts as CSV from the logistics page

### Admins
- **Hauling Standards** — configure max volume, collateral tiers, pricing per m³, expiration, days to complete
- **Special Routes** — CRUD with per-route pricing tiers, surcharge (e.g. +10M ISK per contract for Jita), toggle active/inactive
- **Jump Calculation** — enable/disable ESI jump counting with configurable price per m³ per jump and DB cache (24h default)
- **Discord Notifications** — webhook with granular event control (new contract, accepted, delivered, failed/cancelled)
- **Role Management** — 4 roles (admin, director, hauler, member) assigned by character ID with ESI character search autocomplete
- **Maintenance Mode** — toggle to show a maintenance page to all non-admin users with custom message
- **ESI Cache** — configurable cache duration with manual clear
- **Common Stations** — fallback station list for autocomplete search
- **Price History** — automatic logging of all standard/route pricing changes (old vs new, who, when)
- **Activity Logs** — full audit trail of all admin actions
- **System Status** — cache state, contract count, cache expiry, app version
- **Toast Notifications** — "Saved!" confirmation after every admin action

### Discord Integration
- Automatic notifications via webhook when contracts are:
  - Created (yellow embed with issuer portrait)
  - Accepted (blue embed with hauler portrait)
  - Delivered (green embed)
  - Failed/Cancelled (red embed)
- Alliance logo as bot avatar
- Per-event toggle in admin panel
- Automatic polling (even without site visits)

### Security & Access Control
| Role | Dashboard | Logistics | Calculator | Leaderboard | My Contracts | My Deliveries | Director | Admin |
|---|---|---|---|---|---|---|---|---|
| Guest | Login page | - | Yes | - | - | - | - | - |
| Member | Yes | Yes | Yes | Yes | Yes | - | - | - |
| Hauler | Yes | Yes | Yes | Yes | Yes | Yes | - | - |
| Director | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Partial |
| Admin | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Full |

## Stack

- **Runtime**: Node.js + Express 5
- **Templates**: EJS
- **Database**: SQLite (better-sqlite3)
- **Auth**: EVE Online SSO (OAuth2)
- **API**: EVE ESI (contracts, names, structures, stations, routes, search)
- **Charts**: Chart.js 4 (CDN)
- **Process Manager**: PM2
- **Rate Limiting**: express-rate-limit

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

## Database

SQLite with the following tables:
- `settings` — key/value store for all configurable settings (standards, discord, cache, etc.)
- `routes` — special routes with per-route pricing, surcharge, and active/inactive toggle
- `roles` — character roles (admin, director, hauler, member)
- `jump_cache` — ESI jump route cache (origin, destination, jumps, cached_at)
- `price_history` — automatic log of pricing changes (old/new values, who, when)
- `contract_notes` — director notes on contracts
- `admin_logs` — full audit trail of admin actions
- `service_token` — EVE SSO service account refresh token (auto-rotated)
- `requests` — legacy table (unused, kept for reference)

## Project Structure

```
eve-app/
├── server.js            # Express app, routes, ESI logic, admin API, Discord webhooks
├── db.js                # SQLite schema, seeds, defaults
├── package.json
├── locales/
│   └── index.js         # EN / FR / ES translations (all pages including admin)
├── views/
│   ├── index.ejs        # Login page with alliance logo
│   ├── dashboard.ejs    # User dashboard with weekly chart
│   ├── logistics.ejs    # Contracts: filters, search, sort, pagination, conformity
│   ├── my-contracts.ejs # Personal contract tracking
│   ├── my-deliveries.ejs# Hauler delivery history
│   ├── calculator.ejs   # Price calculator with route selector + copy button
│   ├── leaderboard.ejs  # Top haulers + top issuers
│   ├── director.ejs     # Director dashboard with charts
│   ├── admin.ejs        # Full admin panel
│   ├── maintenance.ejs  # Maintenance mode page
│   ├── 403.ejs          # Access denied
│   ├── service-setup.ejs
│   └── partials/
│       ├── head.ejs     # Favicon, viewport, theme anti-flash
│       ├── navbar.ejs   # Navigation, role badges, theme toggle, lang switcher
│       └── footer.ejs
└── public/
    ├── style.css        # Full CSS with variables, dark/light themes, responsive
    ├── logo.png         # Alliance logo (Tilean Dominion)
    └── lang.js          # Language switcher dropdown
```
