import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('loads the Telegram Mini App bridge before the game module', () => {
  assert.ok(html.indexOf('telegram-web-app.js') < html.indexOf('<script type="module">'));
});

test('frontend authenticates Telegram initData and stores the access token in memory', () => {
  assert.match(html, /apiRequest\('\/api\/auth\/telegram'/);
  assert.match(html, /accessToken=data\.accessToken/);
  assert.match(html, /credentials:'include'/);
});

test('server mode routes every economy action to the API', () => {
  for (const route of [
    '/api/game/plant', '/api/game/water', '/api/game/harvest',
    '/api/game/sell', '/api/game/buy-seeds', '/api/game/build',
    '/api/game/upgrade-orchard'
  ]) assert.ok(html.includes(route), 'Missing route: ' + route);
});

test('local storage writes are disabled after server login', () => {
  assert.match(html, /if\(serverMode\) return;[\s\S]*localStorage\.setItem\('coins'/);
  assert.match(html, /serverRequired&&!serverMode/);
});

test('creates the manor once and registers it for dynamic scene cleanup', () => {
  assert.match(html, /buildingObjects\.push\(makeHouse\(\)\);makeWorldDecor\(\);makeWorldLandscape\(\);/);
  assert.doesNotMatch(html, /\n\s*makeHouse\(\);makeWorldDecor\(\);/);
});
