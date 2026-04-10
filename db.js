const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'freight.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    char_name   TEXT NOT NULL,
    char_id     INTEGER NOT NULL,
    pickup      TEXT NOT NULL,
    destination TEXT NOT NULL,
    volume      REAL NOT NULL,
    collateral  REAL NOT NULL,
    reward      REAL DEFAULT 0,
    notes       TEXT DEFAULT '',
    status      TEXT DEFAULT 'pending',
    hauler_name TEXT DEFAULT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS service_token (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    refresh_token TEXT NOT NULL,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS routes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    point_a          TEXT NOT NULL,
    point_b          TEXT NOT NULL,
    max_volume       INTEGER DEFAULT 200000,
    expiration_weeks INTEGER DEFAULT 4,
    days_to_complete INTEGER DEFAULT 7,
    tiers            TEXT DEFAULT '[]',
    surcharge        REAL DEFAULT 0,
    surcharge_label  TEXT DEFAULT '',
    active           INTEGER DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jump_cache (
    origin_system      INTEGER NOT NULL,
    destination_system INTEGER NOT NULL,
    jumps              INTEGER NOT NULL,
    cached_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (origin_system, destination_system)
  );

  CREATE TABLE IF NOT EXISTS roles (
    char_id    INTEGER PRIMARY KEY,
    char_name  TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'member',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id     INTEGER NOT NULL,
    char_name   TEXT NOT NULL,
    target      TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contract_notes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    char_id     INTEGER NOT NULL,
    char_name   TEXT NOT NULL,
    note        TEXT NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS admin_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    char_id    INTEGER NOT NULL,
    char_name  TEXT NOT NULL,
    action     TEXT NOT NULL,
    details    TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed les settings par défaut
const DEFAULT_SETTINGS = {
  freight_standards: JSON.stringify({
    maxVolume: 200000,
    maxCollateral: 10000000000,
    expirationWeeks: 4,
    daysToComplete: 7,
    tiers: [
      { maxCollateral: 1000000000,  ratePerM3: 600  },
      { maxCollateral: 5000000000,  ratePerM3: 950  },
      { maxCollateral: 10000000000, ratePerM3: 1250 },
    ]
  }),
  discord_webhook_url: '',
  discord_notifications: 'true',
  common_stations: JSON.stringify([
    'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    'Amarr VIII (Oris) - Emperor Family Academy',
    'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
    'Rens VI - Moon 8 - Brutor Tribe Treasury',
    'Hek VIII - Moon 12 - Boundless Creation Factory',
    'Perimeter - Tranquility Trading Tower',
  ]),
  cache_duration: '5',
  admin_ids: JSON.stringify([2115309720]),
};

const seedStmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  seedStmt.run(key, value);
}

// Seed settings jumps
seedStmt.run('jump_calculation', 'false');
seedStmt.run('jump_price_per_m3', '0');
seedStmt.run('jump_cache_hours', '24');

// Seed route Jita <-> ZT-L3S si aucune route n'existe
const routeCount = db.prepare('SELECT COUNT(*) as c FROM routes').get().c;
if (routeCount === 0) {
  db.prepare(`INSERT INTO routes (point_a, point_b, max_volume, expiration_weeks, days_to_complete, tiers, surcharge, surcharge_label, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'Jita', 'ZT-L3S',
    200000, 4, 7,
    JSON.stringify([{ maxCollateral: 700000000, ratePerM3: 600 }]),
    10000000, '+10M ISK per contract',
    1
  );
}

// Seed settings extras
seedStmt.run('maintenance_mode', 'false');
seedStmt.run('maintenance_message', 'Site under maintenance. Please check back later.');
seedStmt.run('discord_event_new', 'true');
seedStmt.run('discord_event_accepted', 'true');
seedStmt.run('discord_event_delivered', 'true');
seedStmt.run('discord_event_failed', 'true');
seedStmt.run('theme', 'dark');

// Seed rôle admin
db.prepare('INSERT OR IGNORE INTO roles (char_id, char_name, role) VALUES (?, ?, ?)').run(2115309720, 'Yashiro Yamamoto', 'admin');

// Seed le service token depuis .env si la table est vide
if (process.env.SERVICE_REFRESH_TOKEN) {
  const existing = db.prepare('SELECT id FROM service_token WHERE id = 1').get();
  if (!existing) {
    db.prepare('INSERT INTO service_token (id, refresh_token) VALUES (1, ?)').run(process.env.SERVICE_REFRESH_TOKEN);
  }
}

module.exports = db;
