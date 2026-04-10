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
- Two EVE Online applications registered at https://developers.eveonline.com
- A valid **license key**

## Installation

1. Clone and install:
```bash
git clone <repo-url> /var/www/eve-app
cd /var/www/eve-app
npm install
```

2. Create `.env`:
```env
PORT=3000
LICENSE_KEY=your_license_key
SESSION_SECRET=your_secret
CLIENT_ID=your_eve_client_id
CLIENT_SECRET=your_eve_client_secret
CALLBACK_URL=https://your-domain.com/callback
SERVICE_CLIENT_ID=your_service_client_id
SERVICE_CLIENT_SECRET=your_service_client_secret
SCOPES=publicData esi-contracts.read_corporation_contracts.v1 esi-search.search_structures.v1
ALLIANCE_ID=your_alliance_id
ADMIN_IDS=your_character_id
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

3. Start:
```bash
pm2 start server.js --name eve-app
pm2 save
```

4. Visit `https://your-domain.com/service-setup` and log in with a CEO/director character to authorize ESI access.

## License

This software requires a valid license key. The panel verifies the license at startup against a remote server. If the server is temporarily unreachable, a 24-hour local cache is used.

Without a valid license, the panel will not start.

Contact **Yashiro Yamamoto** in-game or via Discord for pricing and licensing.
