import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

test('loads the Telegram Mini App bridge before the game module', () => {
  assert.ok(html.indexOf('telegram-web-app.js') < html.indexOf('<script type="module">'));
});

test('frontend authenticates Telegram initData and keeps the access token in memory', () => {
  assert.match(html, /request\('\/api\/auth\/telegram',\{initData\},false\)/);
  assert.match(html, /token=data\.accessToken/);
  assert.match(html, /credentials:'include'/);
});

test('every frontend economy action has a matching API route', () => {
  const routes = [...html.matchAll(/action\('([^']+)'/g)].map(match => match[1]);
  assert.ok(routes.length > 0, 'No API-backed game actions found');
  for (const route of routes) {
    assert.ok(server.includes("'" + route + "'"), 'Backend route missing: ' + route);
  }
});

test('frontend does not persist game state in local storage', () => {
  assert.doesNotMatch(html, /localStorage/);
});

test('creates the manor once and registers it for dynamic scene cleanup', () => {
  assert.match(html, /buildingObjects\.push\(makeHouse\(\)\);makeWorldDecor\(\);makeWorldLandscape\(\);/);
  assert.doesNotMatch(html, /\n\s*makeHouse\(\);makeWorldDecor\(\);/);
});
