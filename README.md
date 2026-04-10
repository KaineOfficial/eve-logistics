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

## Pricing

| Plan | Price | Details |
|---|---|---|
| **Monthly** | 1B ISK / month | Cancel anytime |
| **Yearly** | 8B ISK / year | Save 4B vs monthly |
| **Permanent** | 20B ISK | One-time payment, lifetime access |

Optional add-ons:

| Service | Price |
|---|---|
| **Installation by us** | +3B ISK (one-time) |
| **Hosting included** | +500M ISK / month |

All plans include:
- Full panel with all features
- License key locked to your alliance
- Access to updates
- Setup support

Contact **Yashiro Yamamoto** in-game or via Discord to purchase.

## Full Installation Guide (Ubuntu VPS from scratch)

This guide assumes a fresh Ubuntu 22.04/24.04 VPS with root access and a domain name pointing to the server.

---

### Step 1 — Update the system

```bash
apt update && apt upgrade -y
Step 2 — Install Node.js 20 + npm
Do NOT use apt install nodejs — it installs an outdated version. Use NodeSource instead:


curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
Verify installation:


node -v
npm -v
You should see Node.js 20.x and npm 10.x.

Step 3 — Install PM2 (process manager)

npm install -g pm2
Step 4 — Install Nginx + Certbot (SSL)

apt install -y nginx certbot python3-certbot-nginx
Step 5 — Install SQLite3 (optional, useful for debugging)

apt install -y sqlite3
Step 6 — Clone the repository

git clone https://github.com/KaineOfficial/eve-logistics /var/www/eve-app
cd /var/www/eve-app
Step 7 — Install dependencies

npm install
Step 8 — Create two EVE Online applications
Go to https://developers.eveonline.com and create two applications:

App 1 — User Login
This app authenticates alliance members when they click "Login with EVE Online". It only needs basic permissions.

Click Create New Application
Name: anything (e.g. "My Alliance Panel")
Description: anything
Connection Type: Authentication & API Access
Permissions/Scopes: select only publicData
Callback URL: https://your-domain.com/callback
Click Create Application
Note down the Client ID and Client Secret — these are your CLIENT_ID and CLIENT_SECRET
App 2 — Service Account (ESI access)
This app reads corporation contracts in the background. It needs elevated permissions and must be authorized by a CEO or Director.

Click Create New Application
Name: anything (e.g. "My Alliance Service")
Description: anything
Connection Type: Authentication & API Access
Permissions/Scopes: select:
esi-contracts.read_corporation_contracts.v1
esi-search.search_structures.v1
Add any other scopes you need
Callback URL: https://your-domain.com/callback (same URL as App 1)
Click Create Application
Note down the Client ID and Client Secret — these are your SERVICE_CLIENT_ID and SERVICE_CLIENT_SECRET
Why two apps? Separating them is more secure: regular users never get access to the sensitive corporation scopes, and the service account token is managed independently.

Step 9 — Generate a session secret

node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Copy the output — you'll need it in the next step.

Step 10 — Create the .env file

nano /var/www/eve-app/.env
Paste the following and fill in your values:


PORT=3000
LICENSE_KEY=your_license_key_from_yashiro
SESSION_SECRET=paste_the_generated_secret_from_step_9
CLIENT_ID=client_id_from_app_1
CLIENT_SECRET=client_secret_from_app_1
CALLBACK_URL=https://your-domain.com/callback
SERVICE_CLIENT_ID=client_id_from_app_2
SERVICE_CLIENT_SECRET=client_secret_from_app_2
SCOPES=publicData esi-contracts.read_corporation_contracts.v1 esi-search.search_structures.v1
ALLIANCE_ID=your_alliance_id
ADMIN_IDS=your_character_id
DEPLOY_WEBHOOK_URL=https://discord.com/api/webhooks/your_deploy_webhook
Variable reference:

Variable	Description
LICENSE_KEY	License key provided by Yashiro Yamamoto after purchase
SESSION_SECRET	Random string for session encryption (generated in Step 9)
CLIENT_ID	Client ID from App 1 (user login)
CLIENT_SECRET	Client Secret from App 1
CALLBACK_URL	Must match exactly what you set in both EVE apps
SERVICE_CLIENT_ID	Client ID from App 2 (service account)
SERVICE_CLIENT_SECRET	Client Secret from App 2
SCOPES	EVE SSO scopes — do not modify unless you know what you're doing
ALLIANCE_ID	Your alliance ID (find it on https://evewho.com)
ADMIN_IDS	Your character ID (find it on https://evewho.com) — this is the first admin
DEPLOY_WEBHOOK_URL	Discord webhook URL for deploy notifications (optional)
Note: Contract notifications (new, accepted, delivered, failed) are configured in the Admin Panel on the website, not in the .env file.

Save and exit (Ctrl+X, then Y, then Enter).

Step 11 — Configure Nginx
Create the Nginx config:


nano /etc/nginx/sites-available/eve-app
Paste:


server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
Enable the site:


ln -sf /etc/nginx/sites-available/eve-app /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
Step 12 — Enable SSL (HTTPS)

certbot --nginx -d your-domain.com
Follow the prompts. Certbot will automatically configure HTTPS and redirect HTTP to HTTPS.

Step 13 — Start the panel

cd /var/www/eve-app
pm2 start server.js --name eve-app
pm2 save
pm2 startup
The last command (pm2 startup) ensures PM2 restarts automatically after a server reboot.

Step 14 — Authorize the service account
Open https://your-domain.com/service-setup in your browser
This redirects to EVE SSO — log in with the CEO or Director character that has access to corporation contracts
After authorization, the refresh token is automatically saved to the database
The panel will now be able to fetch corporation contracts via ESI
If you need to change the service account later, just visit /service-setup again
Step 15 — Verify everything works
Open https://your-domain.com — you should see the login page
Click "Login with EVE Online" and log in with an alliance member
You should see the dashboard with contract stats
Go to Admin panel and configure Discord webhooks, routes, standards, etc.
Updating
When a new version is available:


cd /var/www/eve-app
git pull origin main
npm install
pm2 restart eve-app --update-env
Troubleshooting
Problem	Solution
Error: secret option required for sessions	Your .env file is missing or SESSION_SECRET is empty
State invalide on login	Clear your cookies and try again from the home page
The redirect URL does not match	Your CALLBACK_URL in .env doesn't match the Callback URL in your EVE app settings — they must be identical
LICENSE errors at startup	Your license key is invalid, expired, or not valid for your alliance ID
420 errors in logs	ESI rate limit — increase cache duration in Admin Panel
Panel won't start after reboot	Run pm2 startup then pm2 save
SERVICE_REFRESH_TOKEN non configuré en DB	Go to https://your-domain.com/service-setup and authorize a CEO/Director character
License
This software requires a valid license key. The panel verifies the license against a remote server at startup and periodically during operation. If the server is temporarily unreachable, a 24-hour local cache is used.

Without a valid license, the panel will display a license error page on all routes.

Modifying, reverse-engineering, or circumventing the license system is prohibited.

Contact Yashiro Yamamoto in-game or via Discord for pricing and licensing.
