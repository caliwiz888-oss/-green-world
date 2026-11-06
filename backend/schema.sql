CREATE TABLE IF NOT EXISTS players (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Remove legacy gameplay data structures; authentication and player identity remain.
ALTER TABLE players
  DROP COLUMN IF EXISTS coins,
  DROP COLUMN IF EXISTS apples,
  DROP COLUMN IF EXISTS fruit_inventory,
  DROP COLUMN IF EXISTS seeds,
  DROP COLUMN IF EXISTS orchard_level,
  DROP COLUMN IF EXISTS experience,
  DROP COLUMN IF EXISTS player_level,
  DROP COLUMN IF EXISTS has_warehouse,
  DROP COLUMN IF EXISTS warehouse_level,
  DROP COLUMN IF EXISTS has_market,
  DROP COLUMN IF EXISTS market_level,
  DROP COLUMN IF EXISTS has_greenhouse,
  DROP COLUMN IF EXISTS greenhouse_level,
  DROP COLUMN IF EXISTS last_daily_claim,
  DROP COLUMN IF EXISTS daily_streak,
  DROP COLUMN IF EXISTS plots,
  DROP COLUMN IF EXISTS land_level;

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
