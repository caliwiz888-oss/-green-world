import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const sslMode = process.env.PGSSLMODE || (process.env.NODE_ENV === 'production' ? 'require' : 'disable');
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslMode === 'disable' ? false : {
    rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false'
  }
});

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await db.query(`CREATE TABLE IF NOT EXISTS app_migrations (
    migration_key TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const schema = await (await import('node:fs/promises')).readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await db.query(schema);

  // One-time clean start for GREEN WORLD v2. The marker survives future deploys,
  // so normal schema migrations never erase player progress again.
  await db.query('BEGIN');
  const reset = await db.query(
    "INSERT INTO app_migrations(migration_key) VALUES('green-world-v2-clean-start') ON CONFLICT DO NOTHING RETURNING migration_key"
  );
  if (reset.rowCount) {
    await db.query('TRUNCATE TABLE refresh_sessions, players RESTART IDENTITY CASCADE');
    console.log('GREEN WORLD v2: old player/game data cleared once.');
  } else {
    console.log('GREEN WORLD database already initialized for v2; player data preserved.');
  }
  await db.query('COMMIT');
  console.log('GREEN WORLD database schema applied.');
} catch (error) {
  try { await db.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  await db.end();
}
