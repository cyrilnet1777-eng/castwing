CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  email_restriction TEXT,
  credits_granted INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invite_redemptions (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL,
  email TEXT,
  credits_used INTEGER DEFAULT 0,
  redeemed_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  FOREIGN KEY (invite_id) REFERENCES invites(id)
);

CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  email TEXT,
  invite_id TEXT,
  event_type TEXT NOT NULL,
  meta_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
