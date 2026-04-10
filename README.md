# EVE Online Logistics Panel

A complete logistics management panel for EVE Online alliances.  
Track courier contracts in real-time, calculate pricing per route, manage haulers, and receive Discord notifications.

## Features

- Real-time corporation courier contracts from ESI
- Price calculator with route-specific pricing and surcharges
- Hauler leaderboard and personal delivery history
- Director dashboard with weekly performance charts
- Full admin panel (standards, routes, roles, Discord, cache, maintenance)
- Discord webhook notifications (new, accepted, delivered, failed)
- Role system (admin, director, hauler, member)
- Dark / Light theme toggle
- Multi-language (English, French, Spanish)
- Responsive design (mobile, tablet, desktop)
- CSV export, pagination, search, sort, conformity warnings

## Requirements

- Node.js 18+
- A VPS with Nginx + Certbot
- **Two EVE Online applications** registered at https://developers.eveonline.com
- A valid **license key**

### Why two EVE apps?

The panel needs two separate EVE applications for different purposes:

- **App 1** handles **user login** — when alliance members click "Login with EVE Online", this app authenticates them via SSO. It only needs basic permissions to identify the player, their corporation, and alliance.
- **App 2** handles **server-side ESI access** — this is the service account (authorized by the CEO or a director) that reads corporation contracts in the background. It needs elevated scopes to access contract data for the entire corporation.

Separating them is more secure: regular users never get access to the sensitive corporation scopes, and the service account token is managed independently.

### App 1 — User Login
- **Purpose**: authenticate alliance members on the website
- **Name**: anything (e.g. "My Alliance Panel")
- **Callback URL**: `https://your-domain.com/callback`
- **Scopes**: `publicData`
- This gives you `CLIENT_ID` and `CLIENT_SECRET`

### App 2 — Service Account (ESI access)
- **Purpose**: read corporation contracts and search stations/structures in the background
- **Name**: anything (e.g. "My Alliance Service")
- **Callback URL**: `https://your-domain.com/callback` (same URL)
- **Scopes**: `esi-contracts.read_corporation_contracts.v1 esi-search.search_structures.v1`
- This gives you `SERVICE_CLIENT_ID` and `SERVICE_CLIENT_SECRET`
- Must be authorized by a character with **CEO or Director** role in the corporation

## Installation

1. Clone and install:
```bash
git clone <repo-url> /var/www/eve-app
cd /var/www/eve-app
npm install
```

2. Generate a session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output for the next step.

3. Create `.env`:
```env
PORT=3000
LICENSE_KEY=your_license_key
SESSION_SECRET=paste_the_generated_secret_here
CLIENT_ID=your_eve_client_id
CLIENT_SECRET=your_eve_client_secret
CALLBACK_URL=https://your-domain.com/callback
SERVICE_CLIENT_ID=your_service_client_id
SERVICE_CLIENT_SECRET=your_service_client_secret
SCOPES=publicData esi-contracts.read_corporation_contracts.v1 esi-search.search_structures.v1
ALLIANCE_ID=your_alliance_id
ADMIN_IDS=your_character_id
DEPLOY_WEBHOOK_URL=https://discord.com/api/webhooks/your_deploy_webhook
```

Note: there are **two separate Discord webhooks**:
- **Contract notifications** (new, accepted, delivered, failed) — configured in the **Admin Panel** on the website, stored in the database
- **Deploy notifications** — `DEPLOY_WEBHOOK_URL` in the `.env`, used by `deploy.sh`

You do NOT need `DISCORD_WEBHOOK_URL` in the `.env` — contract notifications are managed entirely through the admin panel.

5. Start:
```bash
pm2 start server.js --name eve-app
pm2 save
```

6. Visit `https://your-domain.com/service-setup` and log in with a CEO/director character to authorize ESI access.

## Pricing

| Plan | Price | Details |
|---|---|---|
| **Monthly** | 500M ISK / month | Cancel anytime |
| **Yearly** | 4B ISK / year | Save 2B vs monthly |
| **Permanent** | 8B ISK | One-time payment, lifetime access |

All plans include:
- Full panel with all features
- License key locked to your alliance
- Access to updates
- Setup support

## License

This software requires a valid license key. The panel verifies the license against a remote server at startup and periodically during operation. If the server is temporarily unreachable, a 24-hour local cache is used.

Without a valid license, the panel will not start.

Modifying, reverse-engineering, or circumventing the license system is prohibited.

Contact **Yashiro Yamamoto** in-game or via Discord : "kaine_off" for pricing and licensing.
