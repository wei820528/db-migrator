const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.LICENSE_DB || path.join(__dirname, 'license.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Base schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'trial',
  max_devices INTEGER NOT NULL DEFAULT 1,
  trial_started_at DATETIME,
  expires_at DATETIME,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  ip TEXT,
  user_agent TEXT,
  event TEXT NOT NULL,
  details TEXT,
  at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issued_licenses (
  id TEXT PRIMARY KEY,               -- UUID from license-tools (the 'lid' inside the signed payload)
  customer TEXT,
  plan TEXT,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  revoked_at DATETIME,
  revoke_reason TEXT,
  source TEXT DEFAULT 'manual',      -- manual | import | cli
  notes TEXT
);

-- v2 Theme C Phase 2: long-running API tokens for cron / CI / scripts.
-- Token format: 'dbmt_<32-byte url-safe random>'. Only the SHA-256 of the token
-- is stored (random + high-entropy, no bcrypt needed). Prefix is kept visible
-- so the user can recognise the token in their secret store.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,               -- UUID
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                -- human label e.g. 'github-actions-prod'
  token_prefix TEXT NOT NULL,        -- first 12 chars of token (display only — not secret)
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256 hex of the full token
  scopes TEXT NOT NULL,              -- JSON array, e.g. ["user:read","user:write"]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,               -- NULL = never expires
  revoked_at DATETIME,
  last_used_at DATETIME,
  last_used_ip TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON event_log(user_id, at);
CREATE INDEX IF NOT EXISTS idx_licenses_revoked ON issued_licenses(revoked_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
`);

// Idempotent column additions (better-sqlite3 throws if column exists; catch and ignore)
function addColumnIfMissing(table, column, ddl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
  catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
addColumnIfMissing('users', 'email_verified',     'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('users', 'email_verify_token', 'TEXT');
addColumnIfMissing('users', 'ip_whitelist',       'TEXT');           // JSON array of CIDRs/IPs
addColumnIfMissing('users', 'free_until',         'DATETIME');       // override: act as 'team' until this date
addColumnIfMissing('users', 'stripe_customer_id', 'TEXT');
addColumnIfMissing('users', 'notes',              'TEXT');           // admin internal notes
addColumnIfMissing('users', 'totp_secret_enc',    'TEXT');           // encrypted base32 TOTP secret
addColumnIfMissing('users', 'totp_enabled',       'INTEGER NOT NULL DEFAULT 0');

// Bootstrap admin from env vars on first start.
// Re-runs are safe — only creates if email doesn't exist; promotes if exists but not admin.
const envEmail = process.env.ADMIN_EMAIL;
const envPass = process.env.ADMIN_PASSWORD;
if (envEmail && envPass) {
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(envEmail.toLowerCase());
  if (!existing) {
    if (envPass.length < 8) {
      console.error(`[bootstrap] ADMIN_PASSWORD must be ≥ 8 chars; skipping admin bootstrap`);
    } else {
      const id = crypto.randomUUID();
      const hash = bcrypt.hashSync(envPass, 10);
      db.prepare(`INSERT INTO users (id, email, password_hash, plan, max_devices, is_admin, email_verified)
                  VALUES (?, ?, ?, 'enterprise', 999, 1, 1)`)
        .run(id, envEmail.toLowerCase(), hash);
      console.log(`[bootstrap] Created admin user: ${envEmail}`);
    }
  } else if (!existing.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1, email_verified = 1 WHERE id = ?').run(existing.id);
    console.log(`[bootstrap] Promoted ${envEmail} to admin`);
  }
}

module.exports = db;
