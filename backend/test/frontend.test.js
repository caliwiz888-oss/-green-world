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

test('deferred economy actions are not exposed by the frontend', () => {
  // Реальные игровые награды и экономические endpoints отложены до отдельного этапа.
  // Пока интерфейс не должен отправлять вызовы несуществующих игровых API.
  const routes = [...html.matchAll(/action\('([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(routes, []);
  assert.match(server, /app\.post\('\/api\/auth\/telegram'/);
  assert.match(server, /app\.get\('\/api\/me'/);
});

test('frontend does not persist game state in local storage', () => {
  assert.doesNotMatch(html, /localStorage/);
});

test('creates the detailed manor once and keeps the fallback roof flush with its gable', () => {
  assert.match(html, /const manor=makeHouse\(\);\s*buildingObjects\.push\(manor\);/);
  assert.match(html, /catch\(houseError\)/);
  assert.match(html, /box\(fallback,3\.95,\.34,8\.08,-1\.93,5\.72,-\.02,fallbackRoof\)/);
  assert.match(html, /box\(fallback,3\.95,\.34,8\.08,1\.43,5\.72,-\.02,fallbackRoof\)/);
});
