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
`);

// Seed le service token depuis .env si la table est vide
if (process.env.SERVICE_REFRESH_TOKEN) {
  const existing = db.prepare('SELECT id FROM service_token WHERE id = 1').get();
  if (!existing) {
    db.prepare('INSERT INTO service_token (id, refresh_token) VALUES (1, ?)').run(process.env.SERVICE_REFRESH_TOKEN);
  }
}

module.exports = db;
