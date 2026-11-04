# GREEN WORLD API

Node.js API for Telegram Mini App authentication and the server-authoritative game economy.

## Requirements

- Node.js 20+
- PostgreSQL
- A Telegram bot created with BotFather
- HTTPS public URLs for the Mini App and API in production

## Local setup

1. From this directory, install dependencies:

   `npm install`

2. Copy `.env.example` to `.env` and set the required values.
3. Apply the database schema to your PostgreSQL database:

   `psql "$DATABASE_URL" -f schema.sql`

4. Run checks and start the API:

   `npm test`

   `npm start`

The health endpoint is `GET /health`.

## Environment variables

- `DATABASE_URL`: PostgreSQL connection string.
- `TELEGRAM_BOT_TOKEN`: bot token from BotFather. Keep it only in the host's secret environment settings.
- `JWT_ACCESS_SECRET`: random secret of at least 32 characters.
- `JWT_ISSUER`: optional JWT issuer; defaults to `green-world-api`.
- `WEB_ORIGINS`: comma-separated exact HTTPS origins allowed to call the API.
- `COOKIE_SECURE=true` and `COOKIE_SAME_SITE=none`: required for a cross-site production Mini App/API setup over HTTPS.
- `PGSSLMODE=require`: enables TLS to PostgreSQL. Keep `PGSSL_REJECT_UNAUTHORIZED=true` unless the database provider explicitly documents a different certificate setup.
- `PORT`: hosting platform port; defaults to 3000.

## Deploying the API

Create a Node web service from this repository. Set its root directory to `backend`, build command to `npm install`, and start command to `npm start`. Provision PostgreSQL and run `schema.sql` once against that database. Add all production environment variables in the hosting provider's secret settings; do not commit `.env` or paste the Telegram bot token into chats.

Set `WEB_ORIGINS` to the exact public origin of the deployed Mini App (scheme and host, without a path). Use the API's HTTPS URL when the frontend is connected.

## API routes

- `POST /api/auth/telegram` — verify Telegram WebApp initData and create a player session.
- `POST /api/auth/refresh` — rotate the HttpOnly refresh session.
- `POST /api/auth/logout` — revoke the current refresh session.
- `GET /api/me` — return the authenticated player's state.
- `POST /api/game/plant`, `water`, `harvest`, `sell`, `buy-seeds`, `build`, `upgrade-orchard` — authenticated economy actions.

The API is not considered live until it is deployed, connected to PostgreSQL, and the Mini App frontend has been configured to authenticate and use these routes.
