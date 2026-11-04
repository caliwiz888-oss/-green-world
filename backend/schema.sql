CREATE TABLE IF NOT EXISTS players (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 100 CHECK (coins >= 0),
  apples INTEGER NOT NULL DEFAULT 0 CHECK (apples >= 0),
  seeds INTEGER NOT NULL DEFAULT 5 CHECK (seeds >= 0),
  orchard_level INTEGER NOT NULL DEFAULT 1 CHECK (orchard_level >= 1),
  has_warehouse BOOLEAN NOT NULL DEFAULT FALSE,
  has_market BOOLEAN NOT NULL DEFAULT FALSE,
  has_greenhouse BOOLEAN NOT NULL DEFAULT FALSE,
  plots JSONB NOT NULL DEFAULT '[{"index":22,"grown":false},{"index":25,"grown":false},{"index":28,"grown":false},{"index":31,"grown":false},{"index":34,"grown":false}]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id UUID PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES players(telegram_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  family_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS refresh_sessions_player_idx ON refresh_sessions(telegram_id);
CREATE INDEX IF NOT EXISTS refresh_sessions_family_idx ON refresh_sessions(family_id);
