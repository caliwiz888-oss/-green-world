CREATE TABLE IF NOT EXISTS players (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 100 CHECK (coins >= 0),
  apples BIGINT NOT NULL DEFAULT 0 CHECK (apples >= 0),
  fruit_inventory JSONB NOT NULL DEFAULT '{}'::jsonb,
  seeds INTEGER NOT NULL DEFAULT 5 CHECK (seeds >= 0),
  orchard_level INTEGER NOT NULL DEFAULT 1 CHECK (orchard_level >= 1),
  experience INTEGER NOT NULL DEFAULT 0 CHECK (experience >= 0),
  player_level INTEGER NOT NULL DEFAULT 1 CHECK (player_level >= 1),
  has_warehouse BOOLEAN NOT NULL DEFAULT FALSE,
  warehouse_level INTEGER NOT NULL DEFAULT 0 CHECK (warehouse_level >= 0),
  has_market BOOLEAN NOT NULL DEFAULT FALSE,
  market_level INTEGER NOT NULL DEFAULT 0 CHECK (market_level >= 0),
  has_greenhouse BOOLEAN NOT NULL DEFAULT FALSE,
  greenhouse_level INTEGER NOT NULL DEFAULT 0 CHECK (greenhouse_level >= 0),
  last_daily_claim DATE,
  daily_streak INTEGER NOT NULL DEFAULT 0 CHECK (daily_streak >= 0),
  plots JSONB NOT NULL DEFAULT '[{"index":147,"type":"apple","grown":false},{"index":150,"type":"apple","grown":false},{"index":153,"type":"apple","grown":false},{"index":207,"type":"apple","grown":false},{"index":210,"type":"apple","grown":false}]'::jsonb,
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

ALTER TABLE players ADD COLUMN IF NOT EXISTS last_daily_claim DATE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS daily_streak INTEGER NOT NULL DEFAULT 0;

ALTER TABLE players ADD COLUMN IF NOT EXISTS experience INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS player_level INTEGER NOT NULL DEFAULT 1;

ALTER TABLE players ALTER COLUMN apples TYPE BIGINT;

ALTER TABLE players ADD COLUMN IF NOT EXISTS warehouse_level INTEGER NOT NULL DEFAULT 0;
UPDATE players SET warehouse_level=1 WHERE has_warehouse=TRUE AND warehouse_level=0;

ALTER TABLE players ADD COLUMN IF NOT EXISTS market_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN IF NOT EXISTS greenhouse_level INTEGER NOT NULL DEFAULT 0;
UPDATE players SET market_level=1 WHERE has_market=TRUE AND market_level=0;
UPDATE players SET greenhouse_level=1 WHERE has_greenhouse=TRUE AND greenhouse_level=0;

ALTER TABLE players ADD COLUMN IF NOT EXISTS fruit_inventory JSONB NOT NULL DEFAULT '{}'::jsonb;
